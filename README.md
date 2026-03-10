# transmission-watchdog

Bun/TypeScript daemon that monitors a Transmission BitTorrent container running behind a WireGuard VPN on Unraid. Detects VPN and TX failures, orchestrates clean recovery via the Docker TCP API, auto-syncs the forwarded peer-port after reconnects, and avoids destructive restarts when TX is busy moving files.

---

## How it works

```
MONITORING
  │
  ├─ Phase 1 (instant): Docker inspect both containers → print status
  │
  ├─ Phase 2 (parallel): VPN internet · forwarded port · external IP · TX RPC
  │
  ├─(VPN down / no internet)──────────────────────► VPN_RESTARTING
  │                                                       │
  │                                               stop transmission-vpn
  │                                               restart wireguard-pia
  │                                               wait: internet + port.dat
  │                                               start transmission-vpn
  │                                               poll TX RPC · sync peer-port
  │                                                       │
  ├─(TX container not running)────────────────────► TX_RESTARTING
  │                                                       │
  ├─(TX RPC failing, retries left)────────────────► retry every 2 min        restart transmission-vpn
  │                                                                           poll TX RPC
  ├─(TX RPC failing, retries exhausted)                                               │
  │   └─ exec internal check inside VPN container                                     │
  │       ├─(responds internally) → TX busy with file move, stand down          ◄─────┘
  │       └─(dead internally) ──────────────────────────────────────────► TX_RESTARTING
  │
  └─(all healthy)──────────────────────────────────► sleep CHECK_INTERVAL_MS

RECOVERY (after any restart)
  stop all torrents → wait 10 min → start all torrents → MONITORING
```

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (or Docker, see below)
- Unraid with Docker TCP API enabled (`Settings → Docker → Enable TCP`)
- A VPN container (`wireguard-pia`, `gluetun`, or any Alpine-based image) with `wget` available
- `transmission-vpn` using `--network container:<vpn-container>`
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

| Variable                       | Default                | Description                                                                                                  |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `UNRAID_IP`                    | `192.168.1.100`        | IP address of the Unraid server                                                                              |
| `DOCKER_PORT`                  | `2375`                 | Docker TCP API port on Unraid                                                                                |
| `CONTAINER_NAME`               | `transmission-vpn`     | Transmission container name                                                                                  |
| `VPN_CONTAINER_NAME`           | `wireguard-pia`        | VPN container name                                                                                           |
| `TRANSMISSION_PORT`            | `9091`                 | Transmission RPC port                                                                                        |
| `VPN_PORT_FILE_PATH`           | `/pia-shared/port.dat` | Forwarded port file path **inside** the VPN container                                                        |
| `VPN_CONNECT_TIMEOUT_ATTEMPTS` | `60`                   | Max polls for VPN to reconnect (× `RESTART_POLL_INTERVAL_MS`)                                                |
| `CHECK_INTERVAL_MS`            | `300000`               | Health check frequency — 5 min                                                                               |
| `RECOVERY_WAIT_MS`             | `600000`               | Wait after restart before resuming torrents — 10 min                                                         |
| `RESTART_POLL_INTERVAL_MS`     | `10000`                | Poll interval while waiting for containers — 10 s                                                            |
| `RESTART_MAX_ATTEMPTS`         | `30`                   | Max polls for TX RPC to come back (~5 min)                                                                   |
| `TX_HEALTH_RETRIES`            | `3`                    | Consecutive external RPC failures before escalating                                                          |
| `TX_HEALTH_RETRY_INTERVAL_MS`  | `120000`               | Wait between TX health retries — 2 min                                                                       |
| `EXEC_TIMEOUT_MS`              | `30000`                | Timeout for Docker exec operations — 30 s                                                                    |
| `NETWORK_CHECK_URL`            | `http://1.1.1.1`       | URL used to verify local internet connectivity                                                               |
| `VPN_PORT_FORWARDING_ENABLED`  | `true`                 | Set to `false` to skip port forwarding entirely — use with gluetun or any VPN that doesn't write a port file |
| `VPN_PORT_FILE_PATH`           | `/pia-shared/port.dat` | Path to the forwarded port file **inside** the VPN container (only read when port forwarding is enabled)     |

> **Using gluetun or another VPN without port forwarding?** Set `VPN_PORT_FORWARDING_ENABLED=false`. The watchdog will monitor VPN internet connectivity and restart containers on failure, without reading any port file or syncing the peer-port.

---

## Log output

The watchdog streams colour-coded status lines to stdout as each check resolves:

```
────────────────────────────────────────────────────────────────────
  ▶  transmission-watchdog started
  VPN: wireguard-pia  ·  TX: transmission-vpn  ·  interval: 300s  ·  port forwarding: enabled
────────────────────────────────────────────────────────────────────
[Mar 10 11:51:13]    OK  ✓  VPN  wireguard-pia: running
[Mar 10 11:51:13]    OK  ✓  TX   transmission-vpn: running
[Mar 10 11:51:13]  INFO     Checking VPN tunnel and Transmission RPC...
[Mar 10 11:51:13]    OK  ✓  TX   RPC: responding
[Mar 10 11:51:14]    OK  ✓  VPN  forwarded port: 52013
[Mar 10 11:51:15]    OK  ✓  VPN  internet: connected
[Mar 10 11:51:15]    OK  ✓  VPN  external IP: 185.234.67.12
[Mar 10 11:51:15]  INFO     Peer-port 52013 already set — no change needed
[Mar 10 11:51:15]    OK  ✓  All services healthy — next check in 300s
```

ANSI colours are only emitted when stdout is a TTY; piping to a file produces clean plain text.

---

## Project structure

```
src/
  index.ts        State machine: MONITORING → VPN_RESTARTING / TX_RESTARTING → RECOVERY
  docker.ts       Docker TCP API client (inspect, exec, start, stop, restart)
  vpn.ts          VPN health checks (internet, IP, forwarded port, internal TX probe)
  transmission.ts Transmission RPC client (health, torrents, peer-port sync)
  network.ts      Local network connectivity probe
  logger.ts       Coloured, human-readable terminal output
```
