import { execInContainer } from "./docker";
import type { TorrentClient } from "./torrent-client";

const UNRAID_IP = process.env.UNRAID_IP ?? "192.168.1.100";
const TRANSMISSION_PORT = process.env.TRANSMISSION_PORT ?? "9091";
const RPC_URL = `http://${UNRAID_IP}:${TRANSMISSION_PORT}/transmission/rpc`;
const RPC_TIMEOUT_MS = 10_000;

export const TRANSMISSION_CONTAINER_NAME =
  process.env.CONTAINER_NAME ?? "transmission-vpn";

// The VPN container whose network namespace Transmission shares (for exec-based checks).
const VPN_CONTAINER_NAME = process.env.VPN_CONTAINER_NAME ?? "wireguard-pia";

// Transmission requires a session ID sent back via X-Transmission-Session-Id.
// We obtain it by making a request and reading the header from the 409 response.
let sessionId: string | null = null;

async function fetchRpc(body: object, retrying = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(sessionId ? { "X-Transmission-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }

  // 409 means we need to (re)fetch the session ID
  if (res.status === 409) {
    if (retrying)
      throw new Error("Transmission RPC: failed to obtain session ID");
    sessionId = res.headers.get("X-Transmission-Session-Id");
    if (!sessionId)
      throw new Error("Transmission RPC: 409 but no session header");
    return fetchRpc(body, true);
  }

  if (!res.ok) {
    throw new Error(`Transmission RPC: HTTP ${res.status}`);
  }

  const json = (await res.json()) as { result: string; arguments?: unknown };
  if (json.result !== "success") {
    throw new Error(`Transmission RPC: result="${json.result}"`);
  }

  return json.arguments;
}

/** Returns true if Transmission is up and responding to RPC calls. */
export async function checkHealth(): Promise<boolean> {
  try {
    await fetchRpc({ method: "session-get", arguments: {} });
    return true;
  } catch {
    return false;
  }
}

/** Returns the IDs of all torrents currently known to Transmission. */
export async function getAllTorrentIds(): Promise<number[]> {
  const args = (await fetchRpc({
    method: "torrent-get",
    arguments: { fields: ["id"] },
  })) as { torrents: Array<{ id: number }> };

  return args.torrents.map((t) => t.id);
}

/** Stops (pauses) all torrents. */
export async function stopAllTorrents(ids: (number | string)[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc({ method: "torrent-stop", arguments: { ids } });
}

/** Starts (resumes) all torrents. */
export async function startAllTorrents(
  ids: (number | string)[],
): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc({ method: "torrent-start", arguments: { ids } });
}

/** Re-announces all torrents to their trackers. */
export async function reannounceAllTorrents(): Promise<void> {
  await fetchRpc({ method: "torrent-reannounce", arguments: {} });
}

/** Returns the current peer-port configured in the Transmission session. */
export async function getSessionPeerPort(): Promise<number | null> {
  try {
    const args = (await fetchRpc({
      method: "session-get",
      arguments: { fields: ["peer-port"] },
    })) as { "peer-port"?: number };
    return args["peer-port"] ?? null;
  } catch {
    return null;
  }
}

/** Updates the Transmission peer-port via session-set. */
export async function setSessionPeerPort(port: number): Promise<void> {
  await fetchRpc({
    method: "session-set",
    arguments: { "peer-port": port },
  });
}

/**
 * Checks whether Transmission is successfully announcing to trackers.
 *
 * Queries `trackerStats` for all torrents and inspects the last announce
 * result for each tracker:
 *   - Returns `true`  if at least one tracker has announced successfully.
 *   - Returns `false` if every tracker with announce history shows failures
 *                    (indicates network is up but tracker connectivity is broken).
 *   - Returns `null`  if there are no torrents or no announce history yet
 *                    (e.g. all torrents newly added — not enough data to judge).
 */
/**
 * Checks if Transmission's RPC endpoint is reachable from *inside* the VPN
 * container (which shares the network namespace with the transmission container).
 * Exit codes 0 and 8 (HTTP 409 from Transmission) both mean the process is alive.
 */
export async function checkInternalHealth(): Promise<boolean> {
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=5",
      `http://localhost:${TRANSMISSION_PORT}/transmission/rpc`,
    ]);
    return result.exitCode === 0 || result.exitCode === 8;
  } catch {
    return false;
  }
}

export async function checkTrackerConnectivity(): Promise<boolean | null> {
  try {
    const args = (await fetchRpc({
      method: "torrent-get",
      arguments: { fields: ["trackerStats"] },
    })) as {
      torrents: Array<{
        trackerStats: Array<{
          lastAnnounceSucceeded: boolean;
          lastAnnounceTime: number;
        }>;
      }>;
    };

    if (args.torrents.length === 0) return null;

    let hasHistory = false;
    let anySuccess = false;
    for (const torrent of args.torrents) {
      for (const t of torrent.trackerStats) {
        if (t.lastAnnounceTime > 0) {
          hasHistory = true;
          if (t.lastAnnounceSucceeded) anySuccess = true;
        }
      }
    }

    if (!hasHistory) return null;
    return anySuccess;
  } catch {
    return null;
  }
}

// ─── Client object ───────────────────────────────────────────────────────────

export const transmissionClient: TorrentClient = {
  clientName: "Transmission",
  containerName: TRANSMISSION_CONTAINER_NAME,
  checkHealth,
  getAllTorrentIds,
  stopAllTorrents,
  startAllTorrents,
  reannounceAllTorrents,
  checkTrackerConnectivity,
  getSessionPeerPort,
  setSessionPeerPort,
  checkInternalHealth,
};
