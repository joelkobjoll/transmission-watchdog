# Copilot Instructions — transmission-watchdog

## Project purpose
A Bun/TypeScript daemon that monitors a Transmission BitTorrent container running on an Unraid server, auto-restarts it via the Docker TCP API when unhealthy, and manages torrent state during recovery.

## Stack & runtime
- **Runtime**: [Bun](https://bun.sh) (not Node.js — use Bun-native APIs where appropriate)
- **Language**: TypeScript, strict mode
- **No external dependencies** — only Bun built-ins and native `fetch`
- Entry point: `src/index.ts` — run with `bun start`

## Architecture
```
src/
  index.ts         State machine: MONITORING → RESTARTING → RECOVERY
  transmission.ts  Transmission RPC client (session-ID challenge, health, stop/start)
  docker.ts        Docker TCP API client (restart container, inspect state)
  network.ts       Network availability check (HTTP ping to 1.1.1.1)
```

## Key conventions
- All config comes from `.env` (never hardcode IPs, ports, or container names)
- Use `process.env.KEY ?? "default"` for config access — no config library needed
- Structured log format: `[ISO_TIMESTAMP] [LEVEL] message` — use the `log()` helper in `index.ts`
- All external I/O (fetch calls) must have timeouts via `AbortController`
- Prefer `async/await` over `.then()` chains
- No classes — plain functions and exported async functions per module
- Keep modules focused: each file owns exactly one concern

## External APIs
| Endpoint | Purpose |
|---|---|
| `http://<UNRAID_IP>:2375` | Docker TCP API (restart, inspect) |
| `http://<UNRAID_IP>:9091/transmission/rpc` | Transmission JSON-RPC |
| `http://1.1.1.1` | Network connectivity probe |

## Transmission RPC notes
- Requires `X-Transmission-Session-Id` header — obtain by inspecting the 409 response header
- No authentication configured on this instance
- `torrent-get` fields: always specify only `["id"]` unless more fields are needed
- `torrent-stop` / `torrent-start` accept `{ ids: number[] }`

## State machine behaviour
1. **MONITORING** — health-check every 5 min; on failure → RESTARTING
2. **RESTARTING** — verify network first; if OK restart container; poll every 10s (max 30 attempts); on success → RECOVERY; on failure → back to MONITORING after one cycle
3. **RECOVERY** — stop all torrents → wait 10 min → start all torrents → MONITORING

## Do NOT
- Add external npm packages without a strong reason
- Add a web UI or HTTP server — this is a headless daemon
- Persist state to disk — the state machine resets cleanly on restart
- Catch errors silently — always log them at WARN or ERROR level
