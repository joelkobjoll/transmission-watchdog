# transmission-watchdog

Bun/TypeScript daemon that monitors one or more BitTorrent containers running behind a WireGuard VPN on Unraid. Supports **Transmission**, **qBittorrent**, and **rTorrent** (individually or together). Detects VPN and client failures, orchestrates clean recovery via the Docker TCP API, auto-syncs the forwarded peer-port after reconnects, and avoids destructive restarts when a client is busy moving files.

---

## How it works

```
MONITORING
  │
  ├─ Phase 1 (instant): Docker inspect VPN + all client containers → print status
  │
  ├─ Phase 2 (parallel): VPN internet · forwarded port · external IP
  │
  ├─(VPN down / no internet)──────────────────────► VPN_RESTARTING
  │                                                       │
  │                                               stop all client containers
  │                                               restart VPN container
  │                                               wait: internet + port.dat
  │                                               start all client containers
  │                                               poll each client API · sync peer-port
  │                                                       │
  ├─ Phase 3 (per client): client API health · tracker connectivity · peer port
  │
  ├─(client container not running)────────────────► CLIENT_RESTARTING
  │                                                       │
  ├─(client API failing, retries left)────────────► retry every 2 min        restart container
  │                                                                           poll client API
  ├─(client API failing, retries exhausted)                                          │
  │   └─ exec internal check inside VPN container                                    │
  │       ├─(responds internally) → client busy with file move, stand down      ◄────┘
  │       └─(dead internally) ──────────────────────────────────────────► CLIENT_RESTARTING
  │
  └─(all healthy)──────────────────────────────────► sleep CHECK_INTERVAL_MS

RECOVERY (after any restart)
  stop all torrents → wait 10 min → start all torrents → MONITORING
```

---

## Supported clients

| Client           | API                                | Auth                                          |
| ---------------- | ---------------------------------- | --------------------------------------------- |
| **Transmission** | JSON-RPC on port 9091              | Session-ID header (no password)               |
| **qBittorrent**  | REST Web API v2 on port 8080       | Optional cookie-based (`username`/`password`) |
| **rTorrent**     | XML-RPC via HTTP proxy (port 8080) | None (configure in container if needed)       |

All clients implement the same `TorrentClient` interface — the state machine is client-agnostic. You can monitor any client independently, or multiple simultaneously.

> **qBittorrent API version note**: The watchdog uses the v5.0+ endpoints (`/torrents/stop`, `/torrents/start`). If you run qBittorrent v4.x, update those two calls in `src/qbittorrent.ts` to `/torrents/pause` and `/torrents/resume`.

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (or Docker, see below)
- Unraid with Docker TCP API enabled (`Settings → Docker → Enable TCP`)
- A VPN container (`wireguard-pia`, `gluetun`, or any Alpine-based image) with `wget` available
- Your torrent client container(s) using `--network container:<vpn-container>`
- _(Optional)_ Port forwarding support if `VPN_PORT_FORWARDING_ENABLED=true` (requires a `port.dat`-style file written by the VPN container)

---

## Running locally

```bash
# 1. Clone and install
git clone <repo>
cd transmission-watchdog
bun install

# 2. Configure
cp .env.example .env
$EDITOR .env

# 3. Start
bun start

# Development (auto-restart on file changes)
bun dev
```

---

## Running with Docker / Dokploy

### Option A — docker compose

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
```

### Option B — Dokploy

1. Create a new **Compose** application in Dokploy and point it at this repository.
2. Set environment variables in the Dokploy UI (or mount a `.env` file) — see the table below.
3. Deploy. Dokploy will build the image via the `Dockerfile` and start the service with `restart: unless-stopped`.

> **Note**: The watchdog connects _outbound_ to your Unraid Docker TCP API (`UNRAID_IP:DOCKER_PORT`). No inbound ports are needed.

---

## Configuration

All settings are environment variables. Defaults are shown.

### Client selection

| Variable          | Default        | Description                                                                                                                                       |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TORRENT_CLIENTS` | `transmission` | Comma-separated list of clients to monitor. Valid values: `transmission`, `qbittorrent`, `rtorrent`. Set to empty string for VPN-only monitoring. |

Examples:

```env
TORRENT_CLIENTS=transmission              # Transmission only
TORRENT_CLIENTS=qbittorrent              # qBittorrent only
TORRENT_CLIENTS=rtorrent                 # rTorrent only
TORRENT_CLIENTS=transmission,qbittorrent # Transmission + qBittorrent
TORRENT_CLIENTS=                         # VPN-only, no torrent client
```

### VPN

| Variable                       | Default                | Description                                                                                         |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `UNRAID_IP`                    | `192.168.1.100`        | IP address of the Unraid server                                                                     |
| `DOCKER_PORT`                  | `2375`                 | Docker TCP API port on Unraid                                                                       |
| `VPN_CONTAINER_NAME`           | `wireguard-pia`        | VPN container name                                                                                  |
| `VPN_PORT_FORWARDING_ENABLED`  | `true`                 | Set to `false` to skip port forwarding — use with gluetun or any VPN that doesn't write a port file |
| `VPN_PORT_FILE_PATH`           | `/pia-shared/port.dat` | Path to the forwarded port file **inside** the VPN container                                        |
| `VPN_CONNECT_TIMEOUT_ATTEMPTS` | `60`                   | Max polls for VPN to reconnect (× `RESTART_POLL_INTERVAL_MS`)                                       |

### Transmission

| Variable            | Default            | Description                 |
| ------------------- | ------------------ | --------------------------- |
| `CONTAINER_NAME`    | `transmission-vpn` | Transmission container name |
| `TRANSMISSION_PORT` | `9091`             | Transmission RPC port       |

### qBittorrent

| Variable                     | Default       | Description                                       |
| ---------------------------- | ------------- | ------------------------------------------------- |
| `QBITTORRENT_CONTAINER_NAME` | `qbittorrent` | qBittorrent container name                        |
| `QBITTORRENT_PORT`           | `8080`        | qBittorrent Web UI port                           |
| `QBITTORRENT_USERNAME`       | _(empty)_     | Web UI username (leave blank if auth is disabled) |
| `QBITTORRENT_PASSWORD`       | _(empty)_     | Web UI password (leave blank if auth is disabled) |

### rTorrent

| Variable                  | Default    | Description                                                                                                      |
| ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `RTORRENT_CONTAINER_NAME` | `rtorrent` | rTorrent container name                                                                                          |
| `RTORRENT_PORT`           | `8080`     | HTTP port for the XML-RPC proxy (nginx inside `crazy-max/rtorrent-rutorrent`)                                    |
| `RTORRENT_RPC_PATH`       | `/RPC2`    | XML-RPC endpoint path — use `/rutorrent/plugins/httprpc/action.php` for the ruTorrent httprpc plugin alternative |

### Timing & polling

| Variable                      | Default          | Description                                          |
| ----------------------------- | ---------------- | ---------------------------------------------------- |
| `CHECK_INTERVAL_MS`           | `300000`         | Health check frequency — 5 min                       |
| `RECOVERY_WAIT_MS`            | `600000`         | Wait after restart before resuming torrents — 10 min |
| `RESTART_POLL_INTERVAL_MS`    | `10000`          | Poll interval while waiting for containers — 10 s    |
| `RESTART_MAX_ATTEMPTS`        | `30`             | Max polls for client API to come back (~5 min)       |
| `TX_HEALTH_RETRIES`           | `3`              | Consecutive external API failures before escalating  |
| `TX_HEALTH_RETRY_INTERVAL_MS` | `120000`         | Wait between health retries — 2 min                  |
| `EXEC_TIMEOUT_MS`             | `30000`          | Timeout for Docker exec operations — 30 s            |
| `NETWORK_CHECK_URL`           | `http://1.1.1.1` | URL used to verify local internet connectivity       |

---

## Log output

The watchdog streams colour-coded status lines to stdout as each check resolves:

```
────────────────────────────────────────────────────────────────────
  ▶  transmission-watchdog started
  VPN: wireguard-pia  ·  Clients: Transmission (transmission-vpn)  ·  interval: 300s  ·  port forwarding: enabled
────────────────────────────────────────────────────────────────────
[Mar 10 11:51:13]    OK  ✓  VPN  wireguard-pia: running
[Mar 10 11:51:13]    OK  ✓  Tran transmission-vpn: running
[Mar 10 11:51:13]  INFO     Checking VPN tunnel and client APIs...
[Mar 10 11:51:13]    OK  ✓  Tran API: responding
[Mar 10 11:51:14]    OK  ✓  VPN  forwarded port: 52013
[Mar 10 11:51:15]    OK  ✓  VPN  internet: connected
[Mar 10 11:51:15]    OK  ✓  VPN  external IP: 185.234.67.12
[Mar 10 11:51:15]  INFO     Transmission: peer-port 52013 already set — no change needed
[Mar 10 11:51:15]    OK  ✓  All services healthy — next check in 300s
```

ANSI colours are only emitted when stdout is a TTY; piping to a file produces clean plain text.

---

## Project structure

```
src/
  index.ts          State machine: MONITORING → VPN_RESTARTING / CLIENT_RESTARTING → RECOVERY
  torrent-client.ts TorrentClient interface (implemented by all clients)
  transmission.ts   Transmission RPC client (health, torrents, peer-port sync)
  qbittorrent.ts    qBittorrent Web API client (health, torrents, peer-port sync)
  rtorrent.ts       rTorrent XML-RPC client (health, torrents, peer-port sync)
  docker.ts         Docker TCP API client (inspect, exec, start, stop, restart)
  vpn.ts            VPN health checks (internet, IP, forwarded port)
  network.ts        Local network connectivity probe
  logger.ts         Coloured, human-readable terminal output
```
