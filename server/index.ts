import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import si from 'systeminformation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../dist');

export interface DiskData {
  name: string;
  model: string;
  mountpoint: string;
  total: number;
  used: number;
  percent: number;
}

export interface ServerData {
  os: string;
  hostname: string;
  processor: string;
  processorCores: number;
  ramTotal: number;
  uptime: number;
  cpu: number;
  ram: number;
  ramUsed: number;
  disks: DiskData[];
  network: { rx: number; tx: number; rxTotal: number; txTotal: number };
  docker: {
    running: number;
    stopped: number;
    total: number;
    containers: { name: string; image: string; status: 'running' | 'stopped' | 'paused'; cpu: number; mem: number }[];
  };
}

let latestData: ServerData | null = null;
let staticInfo: { os: string; hostname: string; processor: string; processorCores: number; ramTotal: number } | null = null;

// Read Host OS information even inside Docker container
function getHostOS(): string | null {
  try {
    const paths = ['/host/etc/os-release', '/etc/os-release'];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8');
        const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
    }
  } catch {}
  return null;
}

// Read Host Hostname even inside Docker container
function getHostHostname(): string | null {
  try {
    const paths = ['/host/etc/hostname', '/etc/host_hostname'];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8').trim();
        if (content && !content.startsWith('58b5') && content.length < 64) {
          return content;
        }
      }
    }
  } catch {}
  return null;
}

async function getStaticInfo() {
  if (staticInfo) return staticInfo;
  try {
    const [osInfo, cpu, mem] = await Promise.all([
      si.osInfo(),
      si.cpu(),
      si.mem(),
    ]);

    const hostOS = getHostOS();
    const hostHostname = getHostHostname();

    let osString = hostOS;
    if (!osString) {
      const distro = osInfo.distro && osInfo.distro !== 'unknown' ? osInfo.distro : osInfo.platform;
      const release = osInfo.release || '';
      osString = `${distro} ${release}`.trim() || 'Linux';
    }

    const hostname = hostHostname || osInfo.hostname || 'localhost';
    const processor = [cpu.manufacturer, cpu.brand].filter(Boolean).join(' ') || 'Standard CPU';
    const processorCores = cpu.cores || cpu.physicalCores || 1;
    const ramTotal = Math.round((mem.total / (1024 * 1024 * 1024)) * 10) / 10;

    staticInfo = {
      os: osString,
      hostname,
      processor,
      processorCores,
      ramTotal,
    };
  } catch (err) {
    console.error('Error fetching static system info:', err);
    staticInfo = {
      os: 'Linux',
      hostname: 'localhost',
      processor: 'Generic CPU',
      processorCores: 4,
      ramTotal: 16,
    };
  }
  return staticInfo;
}

async function getPhysicalDisks(fsSize: any[], diskLayout: any[]): Promise<DiskData[]> {
  const diskResults: DiskData[] = [];

  // Filter out container internal file mounts and virtual filesystems
  const IGNORED_PATH_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/etc', '/var/lib/docker', '/containerd', '/mnt/wslg', '/host/etc', '/host/proc', '/host/sys'];
  const validFs = (fsSize || []).filter(f => {
    if (!f.size || f.size <= 0) return false;
    const m = (f.mount || '').toLowerCase();
    if (IGNORED_PATH_PREFIXES.some(p => m.startsWith(p))) return false;
    if (['tmpfs', 'devtmpfs', 'squashfs', 'ramfs', 'overlay'].includes(f.type) && m !== '/') return false;
    if (m.endsWith('.conf') || m.endsWith('.txt') || m.endsWith('.json') || m.endsWith('.doc')) return false;
    return true;
  });

  // Method 1: Try lsblk (native Linux block devices and partitions)
  try {
    const lsblkRaw = execSync('lsblk -J -b -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL,VENDOR,LABEL 2>/dev/null', { timeout: 3000 }).toString();
    const lsblkData = JSON.parse(lsblkRaw);

    if (lsblkData && Array.isArray(lsblkData.blockdevices)) {
      const disks = lsblkData.blockdevices.filter((b: any) => {
        const type = (b.type || '').toLowerCase();
        const name = (b.name || '').toLowerCase();
        if (type !== 'disk') return false;
        if (name.startsWith('ram') || name.startsWith('loop') || name.startsWith('zram')) return false;
        return (b.size || 0) > 10 * 1024 * 1024;
      });

      for (const disk of disks) {
        const diskName = disk.name; // e.g. 'sda', 'sdb'
        const layout = (diskLayout || []).find((l: any) => {
          const dev = (l.device || '').replace('/dev/', '');
          return dev === diskName || (l.name && l.name === disk.model);
        });

        const vendor = (disk.vendor || layout?.vendor || '').trim();
        const model = (disk.model || layout?.name || '').trim();
        const modelName = [vendor, model].filter(Boolean).join(' ').trim() || (disk.label || `Disk /dev/${diskName}`);

        const totalBytes = disk.size || layout?.size || 0;
        const totalGB = Math.round((totalBytes / (1024 * 1024 * 1024)) * 10) / 10;

        let usedBytes = 0;
        const mounts: string[] = [];

        function processDevice(dev: any) {
          const m = dev.mountpoint || dev.mount;
          if (m && !mounts.includes(m) && !m.startsWith('[SWAP]') && !IGNORED_PATH_PREFIXES.some(p => m.startsWith(p))) {
            mounts.push(m);
          }

          // Match used bytes from validFs
          const devName = dev.name;
          const matchFs = validFs.find(f => {
            const rawFs = (f.fs || '').replace('/dev/', '');
            return rawFs === devName || f.mount === m;
          });

          if (matchFs && matchFs.used) {
            usedBytes += matchFs.used;
          } else if (m && fs.existsSync(m)) {
            try {
              const stat = fs.statfsSync(m);
              const u = (stat.blocks - stat.bfree) * stat.bsize;
              if (u > 0) usedBytes += u;
            } catch {}
          }

          if (Array.isArray(dev.children)) {
            for (const child of dev.children) {
              processDevice(child);
            }
          }
        }

        processDevice(disk);

        const usedGB = Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
        const percent = totalGB > 0 ? Math.min(100, Math.round((usedGB / totalGB) * 1000) / 10) : 0;

        diskResults.push({
          name: `/dev/${diskName}`,
          model: modelName,
          mountpoint: mounts.length > 0 ? mounts.join(', ') : 'Storage Pool / Unmounted',
          total: totalGB,
          used: usedGB,
          percent,
        });
      }
    }
  } catch {}

  // Method 2: Fallback to systeminformation blockDevices if lsblk failed
  if (diskResults.length === 0) {
    try {
      const blockDevices = await si.blockDevices().catch(() => []);
      const physicalDisks = (blockDevices || []).filter(b => {
        if (b.type !== 'disk') return false;
        const name = b.name.toLowerCase();
        if (name.startsWith('ram') || name.startsWith('loop') || name.startsWith('zram') || name.startsWith('dm-')) return false;
        return (b.size || 0) > 10 * 1024 * 1024;
      });

      for (const disk of physicalDisks) {
        const diskName = disk.name;
        const layout = (diskLayout || []).find((l: any) => (l.device || '').replace('/dev/', '') === diskName || l.name === disk.model);
        const modelName = [layout?.vendor || disk.vendor, layout?.name || disk.model].filter(Boolean).join(' ').trim() || (disk.label || `Disk /dev/${diskName}`);
        const totalGB = Math.round(((disk.size || layout?.size || 0) / (1024 * 1024 * 1024)) * 10) / 10;

        let usedBytes = 0;
        const mounts: string[] = [];

        for (const f of validFs) {
          const rawFs = (f.fs || '').replace('/dev/', '');
          if (rawFs === diskName || rawFs.startsWith(diskName)) {
            usedBytes += f.used || 0;
            if (f.mount && !mounts.includes(f.mount)) mounts.push(f.mount);
          }
        }

        const parts = (blockDevices || []).filter(b => b.name.startsWith(diskName) && b.name !== diskName);
        for (const p of parts) {
          if (p.mount && !mounts.includes(p.mount) && !p.mount.startsWith('[SWAP]')) {
            mounts.push(p.mount);
          }
        }

        const usedGB = Math.round((usedBytes / (1024 * 1024 * 1024)) * 10) / 10;
        const percent = totalGB > 0 ? Math.min(100, Math.round((usedGB / totalGB) * 1000) / 10) : 0;

        diskResults.push({
          name: `/dev/${diskName}`,
          model: modelName,
          mountpoint: mounts.length > 0 ? mounts.join(', ') : (disk.mount || 'Storage Pool / Unmounted'),
          total: totalGB,
          used: usedGB,
          percent,
        });
      }
    } catch {}
  }

  // Method 3: Fallback if physical disks still empty: use filtered validFs deduplicated
  if (diskResults.length === 0) {
    const seenDevs = new Set<string>();
    for (const f of validFs) {
      if (seenDevs.has(f.fs) && seenDevs.has(f.mount)) continue;
      seenDevs.add(f.fs);
      const rawName = f.fs.replace('/dev/', '');
      const totalGB = Math.round((f.size / (1024 * 1024 * 1024)) * 10) / 10;
      const usedGB = Math.round((f.used / (1024 * 1024 * 1024)) * 10) / 10;
      const percent = Math.round((f.use || (totalGB > 0 ? (usedGB / totalGB) * 100 : 0)) * 10) / 10;

      diskResults.push({
        name: f.fs,
        model: `Disk Volume (${rawName || f.mount})`,
        mountpoint: f.mount,
        total: totalGB,
        used: usedGB,
        percent,
      });
    }
  }

  return diskResults;
}

async function collectMetrics(): Promise<ServerData> {
  const info = await getStaticInfo();

  const [currentLoad, mem, diskLayout, fsSize, netStats, timeInfo] = await Promise.all([
    si.currentLoad().catch(() => ({ currentLoad: 0 })),
    si.mem().catch(() => ({ total: 1, active: 0, used: 0, buffcache: 0 })),
    si.diskLayout().catch(() => []),
    si.fsSize().catch(() => []),
    si.networkStats().catch(() => []),
    si.time(),
  ]);

  // CPU
  const cpu = Math.max(0, Math.min(100, Math.round((currentLoad.currentLoad || 0) * 10) / 10));

  // RAM
  const ramTotal = info.ramTotal;
  const activeMem = mem.active || (mem.used - (mem.buffcache || 0)) || mem.used || 0;
  const ramUsed = Math.round((activeMem / (1024 * 1024 * 1024)) * 100) / 100;
  const ram = Math.max(0, Math.min(100, Math.round((activeMem / (mem.total || 1)) * 1000) / 10));

  // Disks
  const diskResults = await getPhysicalDisks(fsSize, diskLayout);

  // Network
  let rxSecTotal = 0;
  let txSecTotal = 0;
  let rxBytesTotal = 0;
  let txBytesTotal = 0;

  if (Array.isArray(netStats) && netStats.length > 0) {
    for (const iface of netStats) {
      if (iface.operstate === 'up' || (iface.rx_sec || 0) > 0 || (iface.tx_sec || 0) > 0 || (iface.rx_bytes || 0) > 0) {
        rxSecTotal += Math.max(0, iface.rx_sec || 0);
        txSecTotal += Math.max(0, iface.tx_sec || 0);
        rxBytesTotal += Math.max(0, iface.rx_bytes || 0);
        txBytesTotal += Math.max(0, iface.tx_bytes || 0);
      }
    }
  }

  const rx = Math.round((rxSecTotal / (1024 * 1024)) * 100) / 100;
  const tx = Math.round((txSecTotal / (1024 * 1024)) * 100) / 100;
  const rxTotal = Math.round((rxBytesTotal / (1024 * 1024 * 1024)) * 1000) / 1000;
  const txTotal = Math.round((txBytesTotal / (1024 * 1024 * 1024)) * 1000) / 1000;

  // Docker
  let dockerData = {
    running: 0,
    stopped: 0,
    total: 0,
    containers: [] as { name: string; image: string; status: 'running' | 'stopped' | 'paused'; cpu: number; mem: number }[],
  };

  try {
    const [containers, stats] = await Promise.all([
      si.dockerContainers(true).catch(() => []),
      si.dockerContainerStats('*').catch(() => []),
    ]);

    if (Array.isArray(containers) && containers.length > 0) {
      const statsMap = new Map<string, any>();
      if (Array.isArray(stats)) {
        for (const s of stats) {
          statsMap.set(s.id, s);
          statsMap.set(s.name, s);
        }
      }

      let running = 0;
      let stopped = 0;
      const mappedContainers = containers.map(c => {
        const isRunning = c.state === 'running' || c.state === 'restarting';
        if (isRunning) running++;
        else stopped++;

        const stat = statsMap.get(c.id) || statsMap.get(c.name);
        const cpuPercent = stat ? Math.round((stat.cpuPercent || 0) * 10) / 10 : 0;
        const memMB = stat ? Math.round((stat.memUsage || 0) / (1024 * 1024)) : 0;

        return {
          name: c.name.replace(/^\//, ''),
          image: c.image,
          status: (c.state === 'running' ? 'running' : c.state === 'paused' ? 'paused' : 'stopped') as 'running' | 'stopped' | 'paused',
          cpu: cpuPercent,
          mem: memMB,
        };
      });

      dockerData = {
        running,
        stopped,
        total: containers.length,
        containers: mappedContainers,
      };
    }
  } catch {
    // Docker daemon not active
  }

  const result: ServerData = {
    os: info.os,
    hostname: info.hostname,
    processor: info.processor,
    processorCores: info.processorCores,
    ramTotal,
    uptime: Math.floor(timeInfo.uptime || process.uptime()),
    cpu,
    ram,
    ramUsed,
    disks: diskResults.length > 0 ? diskResults : [{ name: '/dev/sda', model: 'Storage Disk', mountpoint: '/', total: 100, used: 20, percent: 20 }],
    network: {
      rx,
      tx,
      rxTotal,
      txTotal,
    },
    docker: dockerData,
  };

  latestData = result;
  return result;
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PORT = parseInt(process.env.PORT || '1945', 10);
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || '/', `http://${hostHeader}`);

  if (url.pathname === '/api/stats') {
    try {
      const data = latestData || (await collectMetrics());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Failed to collect metrics' }));
    }
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (fs.existsSync(DIST_DIR)) {
    let filePath = path.join(DIST_DIR, url.pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const indexPath = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Dashimple API Server - Not Found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws: WebSocket) => {
  try {
    const initial = latestData || (await collectMetrics());
    ws.send(JSON.stringify(initial));
  } catch (err) {
    console.error('Failed to send initial metrics to WS client:', err);
  }

  ws.on('error', (err) => {
    console.error('WebSocket client error:', err);
  });
});

function broadcast(data: ServerData) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

const POLL_INTERVAL_MS = 2000;
async function loop() {
  try {
    const data = await collectMetrics();
    broadcast(data);
  } catch (err) {
    console.error('Error in metrics collection cycle:', err);
  } finally {
    setTimeout(loop, POLL_INTERVAL_MS);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dashimple Server] Running on http://0.0.0.0:${PORT}`);
  console.log(`[Dashimple Server] WebSocket endpoint ws://0.0.0.0:${PORT}/ws`);
  loop();
});
