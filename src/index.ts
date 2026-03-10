import { checkNetwork } from "./network";
import {
  restartContainer,
  startContainer,
  stopContainer,
  waitForContainerStopped,
  getContainerState,
} from "./docker";
import {
  checkHealth,
  getAllTorrentIds,
  stopAllTorrents,
  startAllTorrents,
  getSessionPeerPort,
  setSessionPeerPort,
} from "./transmission";
import {
  VPN_CONTAINER_NAME,
  checkVpnRunning,
  checkVpnInternet,
  getVpnExternalIp,
  getForwardedPort,
  waitForVpnConnected,
  checkTransmissionInternalHealth,
} from "./vpn";
import { log, logBanner } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONTAINER_NAME = process.env.CONTAINER_NAME ?? "transmission-vpn";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? 300_000);
const RECOVERY_WAIT_MS = Number(process.env.RECOVERY_WAIT_MS ?? 600_000);
const RESTART_POLL_INTERVAL_MS = Number(
  process.env.RESTART_POLL_INTERVAL_MS ?? 10_000,
);
const RESTART_MAX_ATTEMPTS = Number(process.env.RESTART_MAX_ATTEMPTS ?? 30);
// How many consecutive external RPC failures before we investigate further
const TX_HEALTH_RETRIES = Number(process.env.TX_HEALTH_RETRIES ?? 3);
// How long to wait between those quick-retry checks (default 2 min)
const TX_HEALTH_RETRY_INTERVAL_MS = Number(
  process.env.TX_HEALTH_RETRY_INTERVAL_MS ?? 120_000,
);
// How long to wait for TX container to stop before proceeding anyway
const TX_STOP_MAX_ATTEMPTS = 12;

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── State machine ───────────────────────────────────────────────────────────

type State = "MONITORING" | "TX_RESTARTING" | "VPN_RESTARTING" | "RECOVERY";

// ─── VPN recovery ─────────────────────────────────────────────────────────────

/**
 * Full VPN recovery sequence:
 *  1. Stop TX container gracefully (it shares VPN network namespace)
 *  2. Restart VPN container
 *  3. Wait for VPN internet + forwarded port
 *  4. Start TX container
 *  5. Wait for TX RPC to respond
 *  6. Update peer-port in Transmission to match new forwarded port
 *
 * Returns true on success → RECOVERY state; false → back to MONITORING after cooldown.
 */
async function handleVpnRestart(): Promise<boolean> {
  logBanner(
    "⟳  VPN_RESTARTING",
    `Stopping ${CONTAINER_NAME} before restarting VPN`,
  );

  // 1. Stop TX so it doesn't corrupt in-progress writes when VPN restarts
  log("INFO", `Stopping ${CONTAINER_NAME}...`);
  try {
    await stopContainer(CONTAINER_NAME);
  } catch (err) {
    log("WARN", `Could not stop ${CONTAINER_NAME}: ${err} — proceeding anyway`);
  }

  const stopped = await waitForContainerStopped(
    CONTAINER_NAME,
    TX_STOP_MAX_ATTEMPTS,
    RESTART_POLL_INTERVAL_MS,
  );
  if (!stopped) {
    log(
      "WARN",
      `${CONTAINER_NAME} did not stop within timeout — proceeding with VPN restart anyway`,
    );
  } else {
    log("OK", `${CONTAINER_NAME} stopped cleanly`);
  }

  // 2. Restart VPN container
  log("INFO", `Restarting VPN container "${VPN_CONTAINER_NAME}"...`);
  try {
    await restartContainer(VPN_CONTAINER_NAME);
  } catch (err) {
    log("ERROR", `Failed to restart VPN container: ${err}`);
    return false;
  }

  // 3. Wait for VPN tunnel + forwarded port
  const maxWaitSec =
    (Number(process.env.VPN_CONNECT_TIMEOUT_ATTEMPTS ?? 60) *
      RESTART_POLL_INTERVAL_MS) /
    1000;
  log(
    "INFO",
    `Waiting up to ${maxWaitSec}s for VPN tunnel and forwarded port...`,
  );
  const forwardedPort = await waitForVpnConnected();
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

  // 4. Start TX container
  log("INFO", `Starting ${CONTAINER_NAME}...`);
  try {
    await startContainer(CONTAINER_NAME);
  } catch (err) {
    log("ERROR", `Failed to start ${CONTAINER_NAME}: ${err}`);
    return false;
  }

  // 5. Poll for TX RPC
  log(
    "INFO",
    `Polling Transmission RPC (up to ${RESTART_MAX_ATTEMPTS} attempts)...`,
  );
  for (let attempt = 1; attempt <= RESTART_MAX_ATTEMPTS; attempt++) {
    await sleep(RESTART_POLL_INTERVAL_MS);
    const containerState = await getContainerState(CONTAINER_NAME);
    const healthy = await checkHealth();
    log(
      healthy ? "OK" : "INFO",
      `[${attempt}/${RESTART_MAX_ATTEMPTS}] container: ${containerState ?? "unknown"} · RPC: ${healthy ? "UP" : "DOWN"}`,
    );
    if (healthy) {
      log("OK", "Transmission RPC is back online");
      // 6. Sync peer-port
      await syncPeerPort(forwardedPort);
      return true;
    }
  }

  log(
    "ERROR",
    `Transmission did not come back after ${RESTART_MAX_ATTEMPTS} attempts`,
  );
  return false;
}

// ─── TX-only restart (VPN healthy, TX process dead) ──────────────────────────

async function handleTxRestart(): Promise<boolean> {
  logBanner("⟳  TX_RESTARTING", "Transmission process is unresponsive");

  log("INFO", "Checking local network connectivity...");
  const hasNetwork = await checkNetwork();
  if (!hasNetwork) {
    log(
      "WARN",
      "Local network appears to be down — skipping restart. Will retry next cycle.",
    );
    return false;
  }

  log("INFO", `Network OK — restarting container "${CONTAINER_NAME}"...`);
  try {
    await restartContainer(CONTAINER_NAME);
  } catch (err) {
    log("ERROR", `Failed to restart container: ${err}`);
    return false;
  }

  log(
    "INFO",
    `Polling Transmission RPC (up to ${RESTART_MAX_ATTEMPTS} attempts)...`,
  );
  for (let attempt = 1; attempt <= RESTART_MAX_ATTEMPTS; attempt++) {
    await sleep(RESTART_POLL_INTERVAL_MS);
    const containerState = await getContainerState(CONTAINER_NAME);
    const healthy = await checkHealth();
    log(
      healthy ? "OK" : "INFO",
      `[${attempt}/${RESTART_MAX_ATTEMPTS}] container: ${containerState ?? "unknown"} · RPC: ${healthy ? "UP" : "DOWN"}`,
    );
    if (healthy) {
      log("OK", "Transmission is back online");
      return true;
    }
  }

  log(
    "ERROR",
    `Transmission did not come back after ${RESTART_MAX_ATTEMPTS} attempts. Will retry next cycle.`,
  );
  return false;
}

// ─── Peer-port sync helper ────────────────────────────────────────────────────

async function syncPeerPort(forwardedPort: number): Promise<void> {
  try {
    const currentPort = await getSessionPeerPort();
    if (currentPort === forwardedPort) {
      log("INFO", `Peer-port ${forwardedPort} already set — no change needed`);
      return;
    }
    log(
      "INFO",
      `Syncing peer-port: ${currentPort ?? "unknown"} → ${forwardedPort}`,
    );
    await setSessionPeerPort(forwardedPort);
    log("OK", `Peer-port updated to ${forwardedPort}`);
  } catch (err) {
    log("WARN", `Failed to sync peer-port: ${err}`);
  }
}

// ─── Recovery ─────────────────────────────────────────────────────────────────

async function handleRecovery(): Promise<void> {
  logBanner(
    "↺  RECOVERY",
    `Stopping all torrents, waiting ${RECOVERY_WAIT_MS / 1000}s, then resuming`,
  );

  let ids: number[] = [];
  try {
    ids = await getAllTorrentIds();
    log("INFO", `Found ${ids.length} torrent(s) — stopping all`);
    await stopAllTorrents(ids);
    log("OK", "All torrents stopped");
  } catch (err) {
    log("ERROR", `Failed to stop torrents: ${err} — skipping recovery wait`);
    return;
  }

  log(
    "INFO",
    `Waiting ${RECOVERY_WAIT_MS / 1000}s before re-enabling torrents...`,
  );
  await sleep(RECOVERY_WAIT_MS);

  try {
    log("INFO", "Resuming all torrents...");
    await startAllTorrents(ids);
    log("OK", `${ids.length} torrent(s) resumed — returning to monitoring`);
  } catch (err) {
    log("ERROR", `Failed to resume torrents: ${err}`);
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logBanner(
    "▶  transmission-watchdog started",
    `VPN: ${VPN_CONTAINER_NAME}  ·  TX: ${CONTAINER_NAME}  ·  interval: ${CHECK_INTERVAL_MS / 1000}s  ·  recovery wait: ${RECOVERY_WAIT_MS / 1000}s`,
  );

  let state: State = "MONITORING";
  // Counts consecutive external TX RPC failures; resets on any success or state transition
  let txFailureCount = 0;

  while (true) {
    // ── MONITORING ────────────────────────────────────────────────────────────
    if (state === "MONITORING") {
      // Phase 1: Docker inspect — instant (~50 ms), print immediately
      const [vpnRunning, txContainerState] = await Promise.all([
        checkVpnRunning(),
        getContainerState(CONTAINER_NAME),
      ]);
      const txContainerRunning = txContainerState === "running";
      log(
        vpnRunning ? "OK" : "WARN",
        `VPN  ${VPN_CONTAINER_NAME}: ${vpnRunning ? "running" : "NOT running"}`,
      );
      log(
        txContainerRunning ? "OK" : "WARN",
        `TX   ${CONTAINER_NAME}: ${txContainerState ?? "not found"}`,
      );

      // If VPN container is outright down, no point probing the network
      if (!vpnRunning) {
        log("WARN", `VPN container is not running — initiating VPN restart`);
        txFailureCount = 0;
        state = "VPN_RESTARTING";
        continue;
      }

      // Phase 2: slower checks — fire in parallel, print EACH result the moment it resolves
      log("INFO", "Checking VPN tunnel and Transmission RPC...");
      const [vpnInternet, forwardedPort, vpnExternalIp, txHealthy, txPeerPort] =
        await Promise.all([
          checkVpnInternet().then((ok) => {
            log(
              ok ? "OK" : "WARN",
              `VPN  internet: ${ok ? "connected" : "no connectivity"}`,
            );
            return ok;
          }),
          getForwardedPort().then((port) => {
            if (port !== null) log("OK", `VPN  forwarded port: ${port}`);
            else log("WARN", `VPN  forwarded port: unavailable`);
            return port;
          }),
          getVpnExternalIp().then((ip) => {
            if (ip !== null) log("OK", `VPN  external IP: ${ip}`);
            else log("WARN", `VPN  external IP: unavailable`);
            return ip;
          }),
          checkHealth().then((ok) => {
            const retriesLeft = TX_HEALTH_RETRIES - txFailureCount - 1;
            const retryHint =
              !ok && txFailureCount > 0
                ? ` — ${retriesLeft > 0 ? `${retriesLeft} retry attempt(s) left` : "no retries left, will check internally"}`
                : "";
            log(
              ok ? "OK" : "WARN",
              `TX   RPC: ${ok ? "responding" : `not responding${retryHint}`}`,
            );
            return ok;
          }),
          getSessionPeerPort(),
        ]);
      void vpnExternalIp; // used for display only above

      // ── VPN no internet
      if (!vpnInternet) {
        txFailureCount = 0;
        state = "VPN_RESTARTING";
        continue;
      }

      // ── Port sync (non-disruptive, every cycle)
      if (forwardedPort !== null) {
        await syncPeerPort(forwardedPort);
      } else {
        log(
          "WARN",
          "Forwarded port unavailable — VPN may still be establishing tunnel",
        );
      }

      // ── TX healthy
      if (txHealthy) {
        txFailureCount = 0;
        log(
          "OK",
          `All services healthy — next check in ${CHECK_INTERVAL_MS / 1000}s`,
        );
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      // ── TX container not running — no point retrying, restart immediately
      if (!txContainerRunning) {
        log(
          "WARN",
          `TX container "${CONTAINER_NAME}" is not running (state: ${txContainerState ?? "not found"}) — skipping retries, restarting now`,
        );
        txFailureCount = 0;
        state = "TX_RESTARTING";
        continue;
      }

      // ── TX unhealthy — retry before escalating
      txFailureCount++;
      if (txFailureCount < TX_HEALTH_RETRIES) {
        const retriesLeft = TX_HEALTH_RETRIES - txFailureCount;
        log(
          "INFO",
          `Will retry in ${TX_HEALTH_RETRY_INTERVAL_MS / 1000}s · ${retriesLeft} attempt(s) remaining before internal check`,
        );
        await sleep(TX_HEALTH_RETRY_INTERVAL_MS);
        continue;
      }

      // ── Retry limit reached — exec internal check to rule out file-move busy state
      log(
        "INFO",
        "Checking Transmission internally from inside the VPN container...",
      );
      const internallyHealthy = await checkTransmissionInternalHealth();
      if (internallyHealthy) {
        log(
          "WARN",
          "TX responds internally but not externally — busy with a file move, standing down restart",
        );
        txFailureCount = 0;
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      log(
        "WARN",
        "TX unresponsive both externally and internally — process is dead",
      );
      txFailureCount = 0;
      state = "TX_RESTARTING";

      // ── TX_RESTARTING ─────────────────────────────────────────────────────────
    } else if (state === "TX_RESTARTING") {
      const recovered = await handleTxRestart();
      if (recovered) {
        state = "RECOVERY";
      } else {
        log(
          "INFO",
          `Waiting ${CHECK_INTERVAL_MS / 1000}s before next restart attempt...`,
        );
        await sleep(CHECK_INTERVAL_MS);
        state = "MONITORING";
      }

      // ── VPN_RESTARTING ────────────────────────────────────────────────────────
    } else if (state === "VPN_RESTARTING") {
      const recovered = await handleVpnRestart();
      if (recovered) {
        state = "RECOVERY";
      } else {
        log(
          "INFO",
          `VPN restart failed or timed out — waiting ${CHECK_INTERVAL_MS / 1000}s before retrying`,
        );
        await sleep(CHECK_INTERVAL_MS);
        state = "MONITORING";
      }

      // ── RECOVERY ──────────────────────────────────────────────────────────────
    } else if (state === "RECOVERY") {
      await handleRecovery();
      state = "MONITORING";
      // No extra sleep — recovery itself took ~10 min
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
