import { useState, useEffect, useRef } from "react";

// --- Types ---
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
  disks: { name: string; mountpoint: string; total: number; used: number; percent: number }[];
  network: { rx: number; tx: number; rxTotal: number; txTotal: number };
  docker: {
    running: number;
    stopped: number;
    total: number;
    containers: { name: string; image: string; status: "running" | "stopped" | "paused"; cpu: number; mem: number }[];
  };
}

const INITIAL_DATA: ServerData = {
  os: "Loading...",
  hostname: "localhost",
  processor: "Detecting CPU...",
  processorCores: 0,
  ramTotal: 0,
  uptime: 0,
  cpu: 0,
  ram: 0,
  ramUsed: 0,
  disks: [],
  network: { rx: 0, tx: 0, rxTotal: 0, txTotal: 0 },
  docker: { running: 0, stopped: 0, total: 0, containers: [] },
};

function formatUptime(seconds: number) {
  if (!seconds || seconds <= 0) return "0m";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(gb: number) {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb} GB`;
}

// --- Sparkline chart ---
function Sparkline({ values, color, height = 40 }: { values: number[]; color: string; height?: number }) {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const width = 120;
  const pts = values
    .map((v, i) => {
      const x = values.length > 1 ? (i / (values.length - 1)) * width : 0;
      const y = height - (Math.max(0, v) / max) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.8"
      />
      <polyline
        points={`0,${height} ${pts} ${width},${height}`}
        fill={color}
        opacity="0.06"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Usage bar ---
function UsageBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="w-full h-[3px] bg-[#1e1e1e] rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

// --- Status badge ---
function StatusBadge({ isConnected, healthy }: { isConnected: boolean; healthy: boolean }) {
  if (!isConnected) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-2 h-2 rounded-full animate-pulse"
          style={{ backgroundColor: "#eab308", boxShadow: "0 0 6px #eab30880" }}
        />
        <span className="font-mono text-xs font-medium tracking-widest uppercase" style={{ color: "#eab308" }}>
          CONNECTING
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{
          backgroundColor: healthy ? "#22c55e" : "#ef4444",
          boxShadow: healthy ? "0 0 6px #22c55e80" : "0 0 6px #ef444480",
        }}
      />
      <span
        className="font-mono text-xs font-medium tracking-widest uppercase"
        style={{ color: healthy ? "#22c55e" : "#ef4444" }}
      >
        {healthy ? "HEALTHY • LIVE" : "WARNING"}
      </span>
    </div>
  );
}

// --- Section label ---
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] tracking-widest uppercase" style={{ color: "#555555" }}>
      {children}
    </span>
  );
}

// --- Card ---
function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`border rounded-sm p-4 ${className}`}
      style={{ backgroundColor: "#111111", borderColor: "#1e1e1e" }}
    >
      {children}
    </div>
  );
}

// --- Metric card with sparkline ---
function MetricCard({
  label,
  value,
  unit,
  subValue,
  percent,
  history,
  color,
  className = "",
}: {
  label: string;
  value: string | number;
  unit: string;
  subValue?: string;
  percent: number;
  history: number[];
  color: string;
  className?: string;
}) {
  const pct = Math.min(Math.max(percent, 0), 100);
  const warningColor = percent >= 85 ? "#ef4444" : percent >= 70 ? "#eab308" : color;

  return (
    <Card className={`flex flex-col gap-3 ${className}`}>
      <div className="flex items-start justify-between">
        <Label>{label}</Label>
        <Sparkline values={history} color={warningColor} />
      </div>
      <div>
        <div className="flex items-baseline gap-1">
          <span className="font-mono text-3xl font-medium" style={{ color: warningColor }}>
            {value}
          </span>
          <span className="font-mono text-sm" style={{ color: "#555555" }}>
            {unit}
          </span>
        </div>
        {subValue && (
          <div className="font-mono text-xs mt-0.5" style={{ color: "#444444" }}>
            {subValue}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <UsageBar percent={pct} color={warningColor} />
        <div className="flex justify-between">
          <Label>{pct.toFixed(1)}% used</Label>
        </div>
      </div>
    </Card>
  );
}

// --- Main App ---
export default function App() {
  const [data, setData] = useState<ServerData>(INITIAL_DATA);
  const [cpuHistory, setCpuHistory] = useState<number[]>(() => Array.from({ length: 20 }, () => 0));
  const [ramHistory, setRamHistory] = useState<number[]>(() => Array.from({ length: 20 }, () => 0));
  const [rxHistory, setRxHistory] = useState<number[]>(() => Array.from({ length: 20 }, () => 0));
  const [txHistory, setTxHistory] = useState<number[]>(() => Array.from({ length: 20 }, () => 0));
  const [now, setNow] = useState(() => new Date());
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let isUnmounted = false;

    // Clock update
    const clockInterval = setInterval(() => setNow(new Date()), 1000);

    // Initial fetch via HTTP API
    fetch("/api/stats")
      .then(res => res.json())
      .then((resData: ServerData) => {
        if (!isUnmounted && resData && resData.hostname) {
          setData(resData);
          setIsConnected(true);
          setCpuHistory(h => [...h.slice(1), resData.cpu]);
          setRamHistory(h => [...h.slice(1), resData.ram]);
          setRxHistory(h => [...h.slice(1), resData.network.rx]);
          setTxHistory(h => [...h.slice(1), resData.network.tx]);
        }
      })
      .catch(() => {
        // Will rely on WebSocket or retry
      });

    function connectWebSocket() {
      if (isUnmounted) return;
      
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          if (!isUnmounted) {
            setIsConnected(true);
          }
        };

        ws.onmessage = (event) => {
          if (isUnmounted) return;
          try {
            const next: ServerData = JSON.parse(event.data);
            if (next && next.hostname) {
              setData(next);
              setIsConnected(true);
              setCpuHistory(h => [...h.slice(-19), next.cpu]);
              setRamHistory(h => [...h.slice(-19), next.ram]);
              setRxHistory(h => [...h.slice(-19), next.network.rx]);
              setTxHistory(h => [...h.slice(-19), next.network.tx]);
            }
          } catch (err) {
            console.error("Failed to parse WebSocket message:", err);
          }
        };

        ws.onerror = () => {
          if (!isUnmounted) setIsConnected(false);
        };

        ws.onclose = () => {
          if (!isUnmounted) {
            setIsConnected(false);
            reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
          }
        };
      } catch (err) {
        if (!isUnmounted) {
          setIsConnected(false);
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
        }
      }
    }

    connectWebSocket();

    return () => {
      isUnmounted = true;
      clearInterval(clockInterval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (ws) ws.close();
    };
  }, []);

  const isHealthy = data.cpu < 85 && data.ram < 85 && data.disks.every(d => d.percent < 85);
  const totalDockerMem = data.docker.containers.reduce((s, c) => s + c.mem, 0);
  const dockerCpuTotal = data.docker.containers.reduce((s, c) => s + c.cpu, 0);

  return (
    <div className="min-h-screen w-full" style={{ backgroundColor: "#0b0b0b" }}>
      {/* Top Bar */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b"
        style={{ backgroundColor: "#0b0b0b", borderColor: "#1a1a1a" }}
      >
        <div className="flex items-center gap-6">
          <span className="font-mono text-sm font-medium tracking-tight" style={{ color: "#e2e2e2" }}>
            Dashimple
          </span>
          <span className="hidden sm:block font-mono text-xs" style={{ color: "#333333" }}>|</span>
          <span className="hidden sm:block font-mono text-xs" style={{ color: "#444444" }}>
            {data.hostname}
          </span>
        </div>
        <div className="flex items-center gap-6">
          <StatusBadge isConnected={isConnected} healthy={isHealthy} />
          <span className="hidden sm:block font-mono text-xs" style={{ color: "#333333" }}>
            {now.toLocaleTimeString("en-US", { hour12: false })}
          </span>
        </div>
      </header>

      <main className="px-4 sm:px-6 py-5 space-y-5 max-w-[1600px] mx-auto">
        {/* Hardware Info */}
        <div
          className="border rounded-sm px-4 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3"
          style={{ backgroundColor: "#0f0f0f", borderColor: "#1a1a1a" }}
        >
          {[
            { key: "OS", val: data.os },
            { key: "HOSTNAME", val: data.hostname },
            { key: "PROCESSOR", val: data.processor },
            { key: "CPU CORES", val: data.processorCores ? `${data.processorCores} cores` : "—" },
            { key: "RAM", val: data.ramTotal ? `${data.ramTotal} GB` : "—" },
            { key: "UPTIME", val: formatUptime(data.uptime) },
          ].map(item => (
            <div key={item.key} className="flex flex-col gap-0.5">
              <Label>{item.key}</Label>
              <span className="font-mono text-xs font-medium truncate" style={{ color: "#c0c0c0" }} title={item.val}>
                {item.val}
              </span>
            </div>
          ))}
        </div>

        {/* Primary Metrics: CPU + RAM */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MetricCard
            label="CPU Usage"
            value={data.cpu.toFixed(1)}
            unit="%"
            subValue={data.processorCores ? `${data.processorCores} logical cores — ${data.processor}` : "—"}
            percent={data.cpu}
            history={cpuHistory}
            color="#3b82f6"
          />
          <MetricCard
            label="RAM Usage"
            value={data.ram.toFixed(1)}
            unit="%"
            subValue={data.ramTotal ? `${data.ramUsed.toFixed(2)} GB used of ${data.ramTotal} GB` : "—"}
            percent={data.ram}
            history={ramHistory}
            color="#06b6d4"
          />
        </div>

        {/* Network */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-8">
            <div className="flex-1">
              <Label>Network — Inbound</Label>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-mono text-2xl font-medium" style={{ color: "#22c55e" }}>
                  {data.network.rx.toFixed(2)}
                </span>
                <span className="font-mono text-sm" style={{ color: "#555555" }}>MB/s</span>
              </div>
              <div className="mt-1 font-mono text-xs" style={{ color: "#444444" }}>
                Total received: {data.network.rxTotal.toFixed(3)} GB
              </div>
              <div className="mt-2">
                <Sparkline values={rxHistory} color="#22c55e" height={36} />
              </div>
            </div>
            <div className="hidden sm:block w-px self-stretch" style={{ backgroundColor: "#1e1e1e" }} />
            <div className="flex-1">
              <Label>Network — Outbound</Label>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="font-mono text-2xl font-medium" style={{ color: "#a855f7" }}>
                  {data.network.tx.toFixed(2)}
                </span>
                <span className="font-mono text-sm" style={{ color: "#555555" }}>MB/s</span>
              </div>
              <div className="mt-1 font-mono text-xs" style={{ color: "#444444" }}>
                Total sent: {data.network.txTotal.toFixed(3)} GB
              </div>
              <div className="mt-2">
                <Sparkline values={txHistory} color="#a855f7" height={36} />
              </div>
            </div>
          </div>
        </Card>

        {/* Disks */}
        <div>
          <div className="mb-2 flex items-center gap-3">
            <Label>Disk Usage</Label>
            <span className="font-mono text-[10px]" style={{ color: "#444444" }}>
              — {data.disks.length} {data.disks.length === 1 ? "volume" : "volumes"}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.disks.map(disk => {
              const diskColor = disk.percent >= 85 ? "#ef4444" : disk.percent >= 70 ? "#eab308" : "#f97316";
              return (
                <Card key={disk.mountpoint} className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <Label>{disk.mountpoint}</Label>
                    <span className="font-mono text-[10px]" style={{ color: "#444444" }}>
                      {disk.name}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-mono text-2xl font-medium" style={{ color: diskColor }}>
                      {disk.percent.toFixed(1)}
                    </span>
                    <span className="font-mono text-sm" style={{ color: "#555555" }}>%</span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <UsageBar percent={disk.percent} color={diskColor} />
                    <div className="flex justify-between">
                      <Label>{formatBytes(disk.used)} used</Label>
                      <Label>{formatBytes(disk.total)} total</Label>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Docker */}
        <div>
          <div className="mb-2 flex items-center gap-4">
            <Label>Docker Containers</Label>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px]" style={{ color: data.docker.running > 0 ? "#22c55e" : "#555555" }}>
                {data.docker.running} running
              </span>
              {data.docker.stopped > 0 && (
                <span className="font-mono text-[10px]" style={{ color: "#ef4444" }}>
                  {data.docker.stopped} stopped
                </span>
              )}
            </div>
          </div>
          <div className="border rounded-sm overflow-hidden" style={{ borderColor: "#1e1e1e" }}>
            {/* Table header */}
            <div
              className="grid gap-0 border-b"
              style={{
                gridTemplateColumns: "1fr 1.4fr 80px 60px 80px",
                backgroundColor: "#0f0f0f",
                borderColor: "#1a1a1a",
              }}
            >
              {["CONTAINER", "IMAGE", "STATUS", "CPU", "MEM"].map(h => (
                <div key={h} className="px-4 py-2">
                  <Label>{h}</Label>
                </div>
              ))}
            </div>

            {/* Rows or Empty State */}
            {data.docker.containers.length === 0 ? (
              <div className="px-4 py-6 text-center" style={{ backgroundColor: "#111111" }}>
                <span className="font-mono text-xs" style={{ color: "#444444" }}>
                  No active containers detected on this host
                </span>
              </div>
            ) : (
              data.docker.containers.map((c, i) => {
                const isRunning = c.status === "running";
                const statusColor = isRunning ? "#22c55e" : "#ef4444";
                return (
                  <div
                    key={c.name}
                    className="grid items-center border-b transition-colors"
                    style={{
                      gridTemplateColumns: "1fr 1.4fr 80px 60px 80px",
                      backgroundColor: i % 2 === 0 ? "#111111" : "#0f0f0f",
                      borderColor: "#191919",
                    }}
                  >
                    <div className="px-4 py-2.5">
                      <span className="font-mono text-xs font-medium" style={{ color: "#d0d0d0" }}>
                        {c.name}
                      </span>
                    </div>
                    <div className="px-4 py-2.5 truncate">
                      <span className="font-mono text-xs" style={{ color: "#555555" }}>
                        {c.image}
                      </span>
                    </div>
                    <div className="px-4 py-2.5">
                      <span
                        className="font-mono text-[10px] uppercase tracking-widest"
                        style={{ color: statusColor }}
                      >
                        {c.status}
                      </span>
                    </div>
                    <div className="px-4 py-2.5">
                      <span className="font-mono text-xs" style={{ color: isRunning ? "#c0c0c0" : "#333333" }}>
                        {isRunning ? `${c.cpu}%` : "—"}
                      </span>
                    </div>
                    <div className="px-4 py-2.5">
                      <span className="font-mono text-xs" style={{ color: isRunning ? "#c0c0c0" : "#333333" }}>
                        {isRunning ? `${c.mem} MB` : "—"}
                      </span>
                    </div>
                  </div>
                );
              })
            )}

            {/* Footer summary */}
            {data.docker.containers.length > 0 && (
              <div
                className="grid items-center px-0"
                style={{
                  gridTemplateColumns: "1fr 1.4fr 80px 60px 80px",
                  backgroundColor: "#0d0d0d",
                }}
              >
                <div className="px-4 py-2">
                  <Label>Total ({data.docker.total})</Label>
                </div>
                <div className="px-4 py-2" />
                <div className="px-4 py-2" />
                <div className="px-4 py-2">
                  <span className="font-mono text-[10px]" style={{ color: "#444444" }}>
                    {dockerCpuTotal.toFixed(1)}%
                  </span>
                </div>
                <div className="px-4 py-2">
                  <span className="font-mono text-[10px]" style={{ color: "#444444" }}>
                    {(totalDockerMem / 1024).toFixed(2)} GB
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1 pb-4">
          <span className="font-mono text-[10px]" style={{ color: "#2a2a2a" }}>
            Dashimple Realtime Monitoring
          </span>
          <span className="font-mono text-[10px]" style={{ color: isConnected ? "#22c55e" : "#eab308" }}>
            {isConnected ? "Connected • WebSocket Stream 2s" : "Reconnecting to host..."}
          </span>
        </div>
      </main>
    </div>
  );
}
