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
let rpcRequestId = 0;

// JSON-RPC 2.0 (Transmission >= 4.1.0 / rpc_version_semver 6.0.0)
// Request:  { jsonrpc: "2.0", method: "snake_case_method", params: {...}, id: N }
// Response: { jsonrpc: "2.0", result: {...}, id: N }
//        or { jsonrpc: "2.0", error: { code, message }, id: N }
async function fetchRpc(
  method: string,
  params: object = {},
  retrying = false,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  const id = ++rpcRequestId;

  let res: Response;
  try {
    res = await fetch(RPC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(sessionId ? { "X-Transmission-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
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
    return fetchRpc(method, params, true);
  }

  if (!res.ok) {
    throw new Error(`Transmission RPC: HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    jsonrpc: string;
    result?: unknown;
    error?: { code: number; message: string };
    id: number;
  };

  if (json.error) {
    throw new Error(
      `Transmission RPC: ${json.error.message} (code ${json.error.code})`,
    );
  }

  return json.result;
}

/** Returns true if Transmission is up and responding to RPC calls. */
export async function checkHealth(): Promise<boolean> {
  try {
    await fetchRpc("session_get");
    return true;
  } catch {
    return false;
  }
}

/** Returns the IDs of all torrents currently known to Transmission. */
export async function getAllTorrentIds(): Promise<number[]> {
  const result = (await fetchRpc("torrent_get", {
    fields: ["id"],
  })) as { torrents: Array<{ id: number }> };

  return result.torrents.map((t) => t.id);
}

/** Stops (pauses) all torrents. */
export async function stopAllTorrents(ids: (number | string)[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc("torrent_stop", { ids });
}

/** Starts (resumes) all torrents. */
export async function startAllTorrents(
  ids: (number | string)[],
): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc("torrent_start", { ids });
}

/** Re-announces all torrents to their trackers. */
export async function reannounceAllTorrents(): Promise<void> {
  await fetchRpc("torrent_reannounce");
}

/** Returns the current peer-port configured in the Transmission session. */
export async function getSessionPeerPort(): Promise<number | null> {
  try {
    const result = (await fetchRpc("session_get", {
      fields: ["peer_port"],
    })) as { peer_port?: number };
    return result.peer_port ?? null;
  } catch {
    return null;
  }
}

/** Updates the Transmission peer-port via session-set. */
export async function setSessionPeerPort(port: number): Promise<void> {
  await fetchRpc("session_set", { peer_port: port });
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
    const result = (await fetchRpc("torrent_get", {
      fields: ["tracker_stats"],
    })) as {
      torrents: Array<{
        tracker_stats: Array<{
          last_announce_succeeded: boolean;
          last_announce_time: number;
        }>;
      }>;
    };

    if (result.torrents.length === 0) return null;

    let hasHistory = false;
    let anySuccess = false;
    for (const torrent of result.torrents) {
      for (const t of torrent.tracker_stats) {
        if (t.last_announce_time > 0) {
          hasHistory = true;
          if (t.last_announce_succeeded) anySuccess = true;
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
