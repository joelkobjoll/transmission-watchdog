# Project Context — transmission-watchdog

## What this does

A lightweight background daemon that keeps a Transmission BitTorrent container healthy on an Unraid home server. It:

1. Continuously monitors the VPN container (`wireguard-pia`) and Transmission container (`transmission-vpn`)
2. Detects VPN failures (no internet, lost forwarded port) and restarts the full VPN → TX stack cleanly
3. Detects TX process failures while distinguishing them from temporary I/O busy states (file moves)
4. Automatically syncs the VPN forwarded port to Transmission's peer-port after every reconnect
5. Once any container stack recovers, stops all active torrents, waits 10 minutes, then resumes them

## Why it exists

The `transmission-vpn` container (which runs inside the `wireguard-pia` network namespace) occasionally becomes unreachable after a VPN reconnect or crash. Manual intervention is tedious. This daemon automates detection and recovery without touching Unraid's web UI.

## Infrastructure

| Component        | Detail                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Unraid server    | Home NAS running Unraid OS                                                  |
| VPN container    | `wireguard-pia` — WireGuard + PIA port forwarding                           |
| TX container     | `transmission-vpn` — Transmission; uses `--network container:wireguard-pia` |
| Docker API       | TCP on port `2375` (enabled in Unraid Settings → Docker)                    |
| Transmission RPC | `http://<UNRAID_IP>:9091/transmission/rpc` — no auth                        |
| Watchdog runs on | Developer's local Mac (remote polling)                                      |

## Configuration (`.env`)

| Variable                       | Default            | Purpose                                                        |
| ------------------------------ | ------------------ | -------------------------------------------------------------- |
| `UNRAID_IP`                    | `192.168.1.100`    | Unraid server IP                                               |
| `TRANSMISSION_PORT`            | `9091`             | Transmission RPC port                                          |
| `DOCKER_PORT`                  | `2375`             | Docker TCP API port                                            |
| `CONTAINER_NAME`               | `transmission-vpn` | Transmission Docker container name                             |
| `VPN_CONTAINER_NAME`           | `wireguard-pia`    | VPN Docker container name                                      |
| `VPN_PORT_FILE_PATH`           | `/pia/port.dat`    | Path to port file **inside** the VPN container                 |
| `CHECK_INTERVAL_MS`            | `300000`           | Health check frequency (5 min)                                 |
| `RECOVERY_WAIT_MS`             | `600000`           | Wait after restart before resuming torrents (10 min)           |
| `RESTART_POLL_INTERVAL_MS`     | `10000`            | Polling interval while waiting for container to come back      |
| `RESTART_MAX_ATTEMPTS`         | `30`               | Max poll attempts (~5 min window)                              |
| `VPN_CONNECT_TIMEOUT_ATTEMPTS` | `60`               | Max polls for VPN tunnel to establish (~10 min)                |
| `TX_HEALTH_RETRIES`            | `3`                | Consecutive external RPC failures before investigating further |
| `TX_HEALTH_RETRY_INTERVAL_MS`  | `120000`           | Wait between TX health retries (2 min)                         |
| `EXEC_TIMEOUT_MS`              | `30000`            | Timeout for Docker exec operations (30 s)                      |
| `NETWORK_CHECK_URL`            | `http://1.1.1.1`   | URL used to verify local internet connectivity                 |

## Running

```bash
# Install dependencies (first time only)
bun install

# Start the watchdog
bun start

# Development (auto-restart on file changes)
bun dev
```

## Recovery flows

### VPN failure detected

```
MONITORING ──(VPN down/no internet)──► VPN_RESTARTING
                                              │
                                     stop transmission-vpn
                                              │
                                     restart wireguard-pia
                                              │
                                    poll: internet + port.dat ready
                                              │
                                     start transmission-vpn
                                              │
                                     poll until RPC up
                                              │
                                    set peer-port = forwarded port
                                              │
                                          RECOVERY
                                              │
                                     stop all torrents
                                              │
                                      wait 10 minutes
                                              │
                                     start all torrents
                                              │
                                          MONITORING
```

### TX failure detected (VPN healthy)

```
MONITORING ──(external RPC fail × N)──► check internal RPC (exec inside VPN container)
                                              │
                                  internal OK ─────────────────► MONITORING
                              (TX busy with I/O — stand down)     (reset counter)
                                              │
                                  internal FAIL
                                              │
                                       TX_RESTARTING
                                              │
                                    restart transmission-vpn
                                              │
                                     poll until RPC up
                                              │
                                          RECOVERY
```

### Port drift (MONITORING, no restart needed)

```
MONITORING cycle:
  read port.dat → compare to Transmission session peer-port
  if different → session-set peer-port automatically
```

## Known limitations

- If the watchdog process itself crashes, it needs to be restarted manually (or via a cron/launchd job)
- No notification system — recovery events are only visible in stdout logs
- State is not persisted: if the watchdog restarts mid-recovery, torrent restart won't be retried
- Assumes Docker TCP port 2375 is open on the Unraid server (no TLS)
- `wget` must be available inside the `wireguard-pia` container for exec-based health checks; if absent, update the command arrays in `src/vpn.ts`
