# Dashimple (Dashboard Simple)

**Dashimple** adalah aplikasi web monitoring server & perangkat yang ringan, modern, dan real-time.

---

## Fitur Utama

- **Hardware Specs**: Deteksi otomatis nama OS, Hostname, model Prosessor, jumlah Core CPU, total RAM, dan Uptime.
- **Realtime CPU & RAM**: Grafik sparkline dinamis dan indikator persentase beban CPU & memori aktual.
- **Network Throughput**: Pantau transfer rate Inbound (RX) & Outbound (TX) dalam MB/s serta akumulasi total bandwidth (GB).
- **Disk Volumes**: Menampilkan kapasitas terpakai, total storage, dan persentase penggunaan untuk setiap mount point/drive.
- **Docker Container Monitoring**: Memantau status container aktif/berhenti, penggunaan CPU, dan memory per container (dengan auto-fallback jika Docker tidak aktif).
- **WebSocket Stream**: Pembaruan telemetri otomatis setiap 2 detik tanpa perlu me-refresh halaman.
- **Docker Ready**: Multi-stage build image yang efisien dan siap jalan di **Port 1945**.

---

## Menjalankan dengan Docker (Port 1945)

### 1. Menggunakan Docker Compose (Direkomendasikan)

Cukup jalankan perintah berikut di root folder:

```bash
docker compose up -d --build
```

Buka di browser:
**[http://localhost:1945](http://localhost:1945)**

Untuk menghentikan container:
```bash
docker compose down
```

---

### 2. Menggunakan Docker CLI Standalone

**Build image:**
```bash
docker build -t dashimple:latest .
```

**Jalankan container:**
```bash
docker run -d \
  --name dashimple \
  -p 1945:1945 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  dashimple:latest
```

---

## Menjalankan Secara Lokal (Non-Docker)

### Prasyarat:
- Node.js (v20 atau lebih baru)
- npm / pnpm

### 1. Instalasi Dependensi
```bash
npm install
```

### 2. Mode Development (Vite Dev Server + Backend)
Menjalankan frontend dev server (port 5173) dan backend telemetry server secara bersamaan:
```bash
npm run dev
```
Buka: **[http://localhost:5173](http://localhost:5173)**

### 3. Mode Production Standalone (Port 1945)
Membangun frontend dan menyajikannya langsung dari server Node.js:
```bash
npm run build
npm start
```
Buka: **[http://localhost:1945](http://localhost:1945)**

---

## API & WebSocket Endpoints

| Endpoint | Tipe | Deskripsi |
| :--- | :--- | :--- |
| `GET /` | HTTP | Antarmuka web dashboard Dashimple |
| `GET /api/stats` | JSON | Mengambil snapshot data metrik sistem saat ini |
| `GET /api/health` | JSON | Healthcheck server status |
| `ws://localhost:1945/ws` | WebSocket | Stream telemetri real-time (update setiap 2 detik) |

---

## Konfigurasi Environment Variable

| Variabel | Default | Deskripsi |
| :--- | :--- | :--- |
| `PORT` | `1945` | Port yang digunakan oleh server Dashimple |
| `NODE_ENV` | `production` | Mode environment (development / production) |

