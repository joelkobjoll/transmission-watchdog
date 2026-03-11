import { checkNetwork } from "./network";
import {
  restartContainer,
  startContainer,
  stopContainer,
  waitForContainerStopped,
  getContainerState,
} from "./docker";
import {
  VPN_CONTAINER_NAME,
  checkVpnRunning,
  checkVpnInternet,
  getVpnExternalIp,
  getForwardedPort,
  waitForVpnConnected,
  waitForVpnInternet,
} from "./vpn";
import { log, logBanner } from "./logger";
import type { TorrentClient } from "./torrent-client";
import {
  transmissionClient,
  TRANSMISSION_CONTAINER_NAME,
} from "./transmission";
import { qbittorrentClient, QBITTORRENT_CONTAINER_NAME } from "./qbittorrent";

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Comma-separated list of clients to monitor.
 * Valid values: "transmission", "qbittorrent"
 * Leave empty (or omit) to monitor no torrent client (VPN-only mode).
 * Examples: "transmission"  |  "qbittorrent"  |  "transmission,qbittorrent"  |  ""
 */
const TORRENT_CLIENTS_ENV = process.env.TORRENT_CLIENTS ?? "transmission";

const activeClients: TorrentClient[] = TORRENT_CLIENTS_ENV.split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((name) => {
    if (name === "transmission") return transmissionClient;
    if (name === "qbittorrent") return qbittorrentClient;
    throw new Error(
      `Unknown TORRENT_CLIENTS entry: "${name}". Valid values: transmission, qbittorrent`,
    );
  });

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? 300_000);
const RESTART_POLL_INTERVAL_MS = Number(
  process.env.RESTART_POLL_INTERVAL_MS ?? 10_000,
);
const RESTART_MAX_ATTEMPTS = Number(process.env.RESTART_MAX_ATTEMPTS ?? 30);
// How many consecutive external API failures before we investigate further
const CLIENT_HEALTH_RETRIES = Number(process.env.TX_HEALTH_RETRIES ?? 3);
// How long to wait between those quick-retry checks (default 2 min)
const CLIENT_HEALTH_RETRY_INTERVAL_MS = Number(
  process.env.TX_HEALTH_RETRY_INTERVAL_MS ?? 120_000,
);
// How long to wait for a client container to stop before proceeding anyway
const CLIENT_STOP_MAX_ATTEMPTS = 12;
const VPN_PORT_FORWARDING_ENABLED =
  (process.env.VPN_PORT_FORWARDING_ENABLED ?? "true").toLowerCase() === "true";

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── State machine ───────────────────────────────────────────────────────────

type State =
  | { tag: "MONITORING" }
  | { tag: "CLIENT_RESTARTING"; client: TorrentClient }
  | { tag: "VPN_RESTARTING" }
  | { tag: "RECOVERY"; clients: TorrentClient[] };

// ─── VPN recovery ─────────────────────────────────────────────────────────────

/**
 * Full VPN recovery sequence:
 *  1. Stop all torrent client containers (they share the VPN network namespace)
 *  2. Restart VPN container
 *  3. Wait for VPN internet + forwarded port
 *  4. Start all client containers
 *  5. Wait for all clients' APIs to respond
 *  6. Update peer-port in each client to match the new forwarded port
 *
 * Returns true on success → RECOVERY state; false → back to MONITORING.
 */
async function handleVpnRestart(clients: TorrentClient[]): Promise<boolean> {
  logBanner(
    "⟳  VPN_RESTARTING",
    clients.length > 0
      ? `Stopping ${clients.map((c) => c.containerName).join(", ")} before restarting VPN`
      : "Restarting VPN container",
  );

  // 1. Stop all client containers gracefully
  for (const client of clients) {
    log("INFO", `Stopping ${client.containerName}...`);
    try {
      await stopContainer(client.containerName);
    } catch (err) {
      log(
        "WARN",
        `Could not stop ${client.containerName}: ${err} — proceeding anyway`,
      );
    }
    const stopped = await waitForContainerStopped(
      client.containerName,
      CLIENT_STOP_MAX_ATTEMPTS,
      RESTART_POLL_INTERVAL_MS,
    );
    if (stopped) log("OK", `${client.containerName} stopped cleanly`);
    else
      log(
        "WARN",
        `${client.containerName} did not stop within timeout — proceeding anyway`,
      );
  }

  // 2. Restart VPN container
  log("INFO", `Restarting VPN container "${VPN_CONTAINER_NAME}"...`);
  try {
    await restartContainer(VPN_CONTAINER_NAME);
  } catch (err) {
    log("ERROR", `Failed to restart VPN container: ${err}`);
    return false;
  }

  // 3. Wait for VPN tunnel (+ forwarded port if enabled)
  const maxWaitSec =
    (Number(process.env.VPN_CONNECT_TIMEOUT_ATTEMPTS ?? 60) *
      RESTART_POLL_INTERVAL_MS) /
    1000;

  let forwardedPort: number | null = null;
  if (VPN_PORT_FORWARDING_ENABLED) {
    log(
      "INFO",
      `Waiting up to ${maxWaitSec}s for VPN tunnel and forwarded port...`,
    );
    forwardedPort = await waitForVpnConnected();
    if (forwardedPort === null) {
      log(
        "ERROR",
        "VPN did not establish connectivity and forwarded port within timeout",
      );
      return false;
    }
    const externalIp = await getVpnExternalIp();
    log(
      "OK",
      `VPN connected — external IP: ${externalIp ?? "unknown"} · forwarded port: ${forwardedPort}`,
    );
  } else {
    log("INFO", `Waiting up to ${maxWaitSec}s for VPN tunnel...`);
    const vpnOk = await waitForVpnInternet();
    if (!vpnOk) {
      log(
        "ERROR",
        "VPN did not establish internet connectivity within timeout",
      );
      return false;
    }
    const externalIp = await getVpnExternalIp();
    log("OK", `VPN connected — external IP: ${externalIp ?? "unknown"}`);
  }

  if (clients.length === 0) return true;

  // 4. Start all client containers
  for (const client of clients) {
    log("INFO", `Starting ${client.containerName}...`);
    try {
      await startContainer(client.containerName);
    } catch (err) {
      log(
        "ERROR",
        `Failed to start ${client.containerName}: ${err} — continuing with other clients`,
      );
    }
  }

  // 5. Poll until all clients are healthy
  log(
    "INFO",
    `Polling ${clients.map((c) => c.clientName).join(", ")} (up to ${RESTART_MAX_ATTEMPTS} attempts)...`,
  );
  const clientsUp = new Set<string>();
  for (let attempt = 1; attempt <= RESTART_MAX_ATTEMPTS; attempt++) {
    await sleep(RESTART_POLL_INTERVAL_MS);
    await Promise.all(
      clients
        .filter((c) => !clientsUp.has(c.containerName))
        .map(async (client) => {
          const [containerState, healthy] = await Promise.all([
            getContainerState(client.containerName),
            client.checkHealth(),
          ]);
          log(
            healthy ? "OK" : "INFO",
            `[${attempt}/${RESTART_MAX_ATTEMPTS}] ${client.clientName}: container=${containerState ?? "unknown"} · API=${healthy ? "UP" : "DOWN"}`,
          );
          if (healthy) {
            clientsUp.add(client.containerName);
            log("OK", `${client.clientName} is back online`);
          }
        }),
    );
    if (clientsUp.size === clients.length) {
      // 6. Sync peer-ports for all clients that support it
      if (VPN_PORT_FORWARDING_ENABLED && forwardedPort !== null) {
        for (const client of clients) {
          await syncPeerPort(client, forwardedPort);
        }
      }
      return true;
    }
  }

  const stillDown = clients.filter((c) => !clientsUp.has(c.containerName));
  log(
    "ERROR",
    `These clients did not come back after ${RESTART_MAX_ATTEMPTS} attempts: ${stillDown.map((c) => c.clientName).join(", ")}`,
  );
  return false;
}

// ─── Per-client restart ───────────────────────────────────────────────────────

/**
 * Restarts one specific client container (VPN is healthy; the client process died).
 * Returns true on success → RECOVERY; false → back to MONITORING after cooldown.
 */
async function handleClientRestart(client: TorrentClient): Promise<boolean> {
  logBanner(
    `⟳  CLIENT_RESTARTING`,
    `${client.clientName} (${client.containerName}) is unresponsive`,
  );

  log("INFO", "Checking local network connectivity...");
  const hasNetwork = await checkNetwork();
  if (!hasNetwork) {
    log(
      "WARN",
      "Local network appears to be down — skipping restart. Will retry next cycle.",
    );
    return false;
  }

  // Wait for VPN connectivity before restarting the client
  const maxWaitSec =
    (Number(process.env.VPN_CONNECT_TIMEOUT_ATTEMPTS ?? 60) *
      RESTART_POLL_INTERVAL_MS) /
    1000;
  let forwardedPort: number | null = null;
  if (VPN_PORT_FORWARDING_ENABLED) {
    log(
      "INFO",
      `Waiting up to ${maxWaitSec}s for VPN tunnel and forwarded port...`,
    );
    forwardedPort = await waitForVpnConnected();
    if (forwardedPort === null) {
      log(
        "ERROR",
        "VPN did not establish connectivity and forwarded port within timeout",
      );
      return false;
    }
    const externalIp = await getVpnExternalIp();
    log(
      "OK",
      `VPN connected — external IP: ${externalIp ?? "unknown"} · forwarded port: ${forwardedPort}`,
    );
  } else {
    log("INFO", `Waiting up to ${maxWaitSec}s for VPN tunnel...`);
    const vpnOk = await waitForVpnInternet();
    if (!vpnOk) {
      log(
        "ERROR",
        "VPN did not establish internet connectivity within timeout",
      );
      return false;
    }
    const externalIp = await getVpnExternalIp();
    log("OK", `VPN connected — external IP: ${externalIp ?? "unknown"}`);
  }

  log("INFO", `Network OK — restarting container "${client.containerName}"...`);
  try {
    await restartContainer(client.containerName);
  } catch (err) {
    log("ERROR", `Failed to restart container: ${err}`);
    return false;
  }

  log(
    "INFO",
    `Polling ${client.clientName} API (up to ${RESTART_MAX_ATTEMPTS} attempts)...`,
  );
  for (let attempt = 1; attempt <= RESTART_MAX_ATTEMPTS; attempt++) {
    await sleep(RESTART_POLL_INTERVAL_MS);
    const containerState = await getContainerState(client.containerName);
    const healthy = await client.checkHealth();
    log(
      healthy ? "OK" : "INFO",
      `[${attempt}/${RESTART_MAX_ATTEMPTS}] container: ${containerState ?? "unknown"} · API: ${healthy ? "UP" : "DOWN"}`,
    );
    if (healthy) {
      log("OK", `${client.clientName} is back online`);
      if (VPN_PORT_FORWARDING_ENABLED && forwardedPort !== null) {
        await syncPeerPort(client, forwardedPort);
      }
      return true;
    }
  }

  log(
    "ERROR",
    `${client.clientName} did not come back after ${RESTART_MAX_ATTEMPTS} attempts. Will retry next cycle.`,
  );
  return false;
}

// ─── Peer-port sync helper ────────────────────────────────────────────────────

async function syncPeerPort(
  client: TorrentClient,
  forwardedPort: number,
): Promise<void> {
  try {
    const currentPort = await client.getSessionPeerPort();
    if (currentPort === null) return; // client does not support port management
    if (currentPort === forwardedPort) {
      log(
        "INFO",
        `${client.clientName} peer-port ${forwardedPort} already set — no change needed`,
      );
      return;
    }
    log(
      "INFO",
      `${client.clientName}: syncing peer-port ${currentPort} → ${forwardedPort}`,
    );
    await client.setSessionPeerPort(forwardedPort);
    log("OK", `${client.clientName}: peer-port updated to ${forwardedPort}`);
  } catch (err) {
    log("WARN", `${client.clientName}: failed to sync peer-port: ${err}`);
  }
}

// ─── Recovery ─────────────────────────────────────────────────────────────────

async function handleRecovery(clients: TorrentClient[]): Promise<void> {
  logBanner(
    "↺  RECOVERY",
    `Re-announcing all torrents for ${clients.map((c) => c.clientName).join(", ")}`,
  );

  for (const client of clients) {
    try {
      await client.reannounceAllTorrents();
      log("OK", `${client.clientName}: re-announced all torrents to trackers`);
    } catch (err) {
      log(
        "ERROR",
        `${client.clientName}: failed to re-announce torrents: ${err}`,
      );
    }
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const clientSummary =
    activeClients.length === 0
      ? "no torrent clients (VPN-only mode)"
      : activeClients
          .map((c) => `${c.clientName} (${c.containerName})`)
          .join(", ");

  logBanner(
    "▶  transmission-watchdog started",
    `VPN: ${VPN_CONTAINER_NAME}  ·  Clients: ${clientSummary}  ·  interval: ${CHECK_INTERVAL_MS / 1000}s  ·  port forwarding: ${VPN_PORT_FORWARDING_ENABLED ? "enabled" : "disabled"}`,
  );

  let state: State = { tag: "MONITORING" };
  // Per-client consecutive external API failure counts; keyed by containerName
  const failureCounts = new Map<string, number>();

  outer: while (true) {
    // ── MONITORING ────────────────────────────────────────────────────────────
    if (state.tag === "MONITORING") {
      // Phase 1: Docker inspect — instant (~50 ms), print immediately
      const [vpnRunning, ...clientContainerStates] = await Promise.all([
        checkVpnRunning(),
        ...activeClients.map((c) => getContainerState(c.containerName)),
      ]);

      log(
        vpnRunning ? "OK" : "WARN",
        `VPN  ${VPN_CONTAINER_NAME}: ${vpnRunning ? "running" : "NOT running"}`,
      );

      const clientRunning = new Map<string, boolean>();
      for (const [i, client] of activeClients.entries()) {
        const cs = clientContainerStates[i];
        const running = cs === "running";
        clientRunning.set(client.containerName, running);
        log(
          running ? "OK" : "WARN",
          `${client.clientName.padEnd(4)} ${client.containerName}: ${cs ?? "not found"}`,
        );
      }

      // If VPN container is outright down, no point probing the network
      if (!vpnRunning) {
        log("WARN", "VPN container is not running — initiating VPN restart");
        failureCounts.clear();
        state = { tag: "VPN_RESTARTING" };
        continue outer;
      }

      // Phase 2: VPN network checks
      log(
        "INFO",
        "Checking VPN tunnel" +
          (activeClients.length > 0 ? " and client APIs..." : "..."),
      );
      const [vpnInternet, forwardedPort, vpnExternalIp] = await Promise.all([
        checkVpnInternet().then((ok) => {
          log(
            ok ? "OK" : "WARN",
            `VPN  internet: ${ok ? "connected" : "no connectivity"}`,
          );
          return ok;
        }),
        VPN_PORT_FORWARDING_ENABLED
          ? getForwardedPort().then((port) => {
              if (port !== null) log("OK", `VPN  forwarded port: ${port}`);
              else log("WARN", `VPN  forwarded port: unavailable`);
              return port;
            })
          : Promise.resolve(null),
        getVpnExternalIp().then((ip) => {
          if (ip !== null) log("OK", `VPN  external IP: ${ip}`);
          else log("WARN", `VPN  external IP: unavailable`);
          return ip;
        }),
      ]);
      void vpnExternalIp; // logged above

      // ── VPN no internet
      if (!vpnInternet) {
        failureCounts.clear();
        state = { tag: "VPN_RESTARTING" };
        continue outer;
      }

      // ── Phase 3: Per-client API health + tracker check + peer port
      if (activeClients.length > 0) {
        const clientResults = await Promise.all(
          activeClients.map(async (client) => {
            const failureCount = failureCounts.get(client.containerName) ?? 0;
            const retriesLeft = CLIENT_HEALTH_RETRIES - failureCount - 1;
            const [healthy, trackerOk, peerPort] = await Promise.all([
              client.checkHealth().then((ok) => {
                const retryHint =
                  !ok && failureCount > 0
                    ? ` — ${retriesLeft > 0 ? `${retriesLeft} retry attempt(s) left` : "no retries left, will check internally"}`
                    : "";
                log(
                  ok ? "OK" : "WARN",
                  `${client.clientName.padEnd(4)} API: ${ok ? "responding" : `not responding${retryHint}`}`,
                );
                return ok;
              }),
              client.checkTrackerConnectivity().then((ok) => {
                if (ok === true)
                  log(
                    "OK",
                    `${client.clientName.padEnd(4)} trackers: announcing successfully`,
                  );
                if (ok === false)
                  log(
                    "WARN",
                    `${client.clientName.padEnd(4)} trackers: all announces failing — network may be broken`,
                  );
                return ok;
              }),
              VPN_PORT_FORWARDING_ENABLED
                ? client.getSessionPeerPort()
                : Promise.resolve(null),
            ]);
            void peerPort; // used only by syncPeerPort below
            return { client, healthy, trackerOk };
          }),
        );

        // ── Port sync (non-disruptive, every cycle)
        if (VPN_PORT_FORWARDING_ENABLED) {
          if (forwardedPort !== null) {
            for (const { client } of clientResults) {
              await syncPeerPort(client, forwardedPort);
            }
          } else {
            log(
              "WARN",
              "Forwarded port unavailable — VPN may still be establishing tunnel",
            );
          }
        }

        // ── Evaluate each client's health
        for (const { client, healthy, trackerOk } of clientResults) {
          if (healthy) {
            // Tracker check: if all trackers are failing despite API being alive,
            // the VPN tunnel is broken for real traffic even though ping passes.
            if (trackerOk === false) {
              log(
                "WARN",
                `${client.clientName} API is up but all trackers are failing — VPN tunnel likely broken, initiating VPN restart`,
              );
              failureCounts.clear();
              state = { tag: "VPN_RESTARTING" };
              continue outer;
            }
            failureCounts.set(client.containerName, 0);
            continue; // this client is healthy
          }

          // ── Client container not running — no point retrying
          if (!clientRunning.get(client.containerName)) {
            log(
              "WARN",
              `${client.clientName} container "${client.containerName}" is not running — skipping retries, restarting now`,
            );
            failureCounts.set(client.containerName, 0);
            state = { tag: "CLIENT_RESTARTING", client };
            continue outer;
          }

          // ── Client unhealthy — retry before escalating
          const prevCount = failureCounts.get(client.containerName) ?? 0;
          const newCount = prevCount + 1;
          failureCounts.set(client.containerName, newCount);

          if (newCount < CLIENT_HEALTH_RETRIES) {
            const retriesLeft = CLIENT_HEALTH_RETRIES - newCount;
            log(
              "INFO",
              `${client.clientName}: will retry in ${CLIENT_HEALTH_RETRY_INTERVAL_MS / 1000}s · ${retriesLeft} attempt(s) remaining before internal check`,
            );
            await sleep(CLIENT_HEALTH_RETRY_INTERVAL_MS);
            continue outer;
          }

          // ── Retry limit reached — exec internal check
          log(
            "INFO",
            `${client.clientName}: checking internally from inside the VPN container...`,
          );
          const internallyHealthy = await client.checkInternalHealth();
          if (internallyHealthy) {
            log(
              "WARN",
              `${client.clientName} responds internally but not externally — busy (e.g. file move), standing down restart`,
            );
            failureCounts.set(client.containerName, 0);
            await sleep(CHECK_INTERVAL_MS);
            continue outer;
          }

          log(
            "WARN",
            `${client.clientName} unresponsive both externally and internally — process is dead`,
          );
          failureCounts.set(client.containerName, 0);
          state = { tag: "CLIENT_RESTARTING", client };
          continue outer;
        }
      }

      log(
        "OK",
        `All services healthy — next check in ${CHECK_INTERVAL_MS / 1000}s`,
      );
      await sleep(CHECK_INTERVAL_MS);

      // ── CLIENT_RESTARTING ─────────────────────────────────────────────────────
    } else if (state.tag === "CLIENT_RESTARTING") {
      const client: TorrentClient = state.client;
      const recovered = await handleClientRestart(client);
      if (recovered) {
        state = { tag: "RECOVERY", clients: [client] };
      } else {
        log(
          "INFO",
          `Waiting ${CHECK_INTERVAL_MS / 1000}s before next restart attempt...`,
        );
        await sleep(CHECK_INTERVAL_MS);
        state = { tag: "MONITORING" };
      }

      // ── VPN_RESTARTING ────────────────────────────────────────────────────────
    } else if (state.tag === "VPN_RESTARTING") {
      const recovered = await handleVpnRestart(activeClients);
      if (recovered) {
        state = { tag: "RECOVERY", clients: activeClients };
      } else {
        log(
          "INFO",
          `VPN restart failed or timed out — waiting ${CHECK_INTERVAL_MS / 1000}s before retrying`,
        );
        await sleep(CHECK_INTERVAL_MS);
        state = { tag: "MONITORING" };
      }

      // ── RECOVERY ──────────────────────────────────────────────────────────────
    } else if (state.tag === "RECOVERY") {
      await handleRecovery(state.clients);
      state = { tag: "MONITORING" };
      // No extra sleep — recovery itself took ~10 min
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
