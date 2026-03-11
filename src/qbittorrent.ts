import { execInContainer } from "./docker";
import type { TorrentClient } from "./torrent-client";

// ─── Config ──────────────────────────────────────────────────────────────────

const UNRAID_IP = process.env.UNRAID_IP ?? "192.168.1.100";
const QB_PORT = process.env.QBITTORRENT_PORT ?? "8080";
const QB_BASE_URL = `http://${UNRAID_IP}:${QB_PORT}/api/v2`;
const QB_USERNAME = process.env.QBITTORRENT_USERNAME ?? "";
const QB_PASSWORD = process.env.QBITTORRENT_PASSWORD ?? "";
const QB_AUTH_ENABLED = Boolean(QB_USERNAME || QB_PASSWORD);

export const QBITTORRENT_CONTAINER_NAME =
  process.env.QBITTORRENT_CONTAINER_NAME ?? "qbittorrent";

// The VPN container whose network namespace qBittorrent shares (for exec-based checks).
const VPN_CONTAINER_NAME = process.env.VPN_CONTAINER_NAME ?? "wireguard-pia";

const API_TIMEOUT_MS = 10_000;

// ─── Session cookie management ───────────────────────────────────────────────

let cookie: string | null = null;

async function authenticate(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      username: QB_USERNAME,
      password: QB_PASSWORD,
    });
    const res = await fetch(`${QB_BASE_URL}/auth/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const text = await res.text();
    if (!text.includes("Ok")) return false;
    // Parse SID cookie
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/SID=([^;]+)/);
      if (match) cookie = `SID=${match[1]}`;
    }
    return true;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

// ─── Base API fetch with session renewal ─────────────────────────────────────

async function apiFetch(
  path: string,
  options: RequestInit = {},
  retrying = false,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${QB_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers as Record<string, string> | undefined),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    clearTimeout(timer);
    // 403 = session expired or auth required — re-authenticate once and retry
    if (res.status === 403 && !retrying && QB_AUTH_ENABLED) {
      const ok = await authenticate();
      if (!ok) throw new Error("qBittorrent: authentication failed");
      return apiFetch(path, options, true);
    }
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Client operations ───────────────────────────────────────────────────────

/** Returns true if the qBittorrent Web API is up and responding. */
export async function checkHealth(): Promise<boolean> {
  try {
    // Ensure we have a session before the first real check
    if (QB_AUTH_ENABLED && !cookie) {
      const ok = await authenticate();
      if (!ok) return false;
    }
    const res = await apiFetch("/app/version");
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns the info-hashes of all torrents. */
export async function getAllTorrentIds(): Promise<string[]> {
  const res = await apiFetch("/torrents/info");
  if (!res.ok)
    throw new Error(`qBittorrent getAllTorrentIds: HTTP ${res.status}`);
  const torrents = (await res.json()) as Array<{ hash: string }>;
  return torrents.map((t) => t.hash);
}

/**
 * Stops (pauses) the given torrents.
 * Requires qBittorrent v5.0+; for v4.x rename the endpoint to /torrents/pause.
 */
export async function stopAllTorrents(ids: (number | string)[]): Promise<void> {
  if (ids.length === 0) return;
  const hashes = ids.map(String).join("|");
  const res = await apiFetch("/torrents/stop", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `hashes=${hashes}`,
  });
  if (!res.ok)
    throw new Error(`qBittorrent stopAllTorrents: HTTP ${res.status}`);
}

/**
 * Resumes (starts) the given torrents.
 * Requires qBittorrent v5.0+; for v4.x rename the endpoint to /torrents/resume.
 */
export async function startAllTorrents(
  ids: (number | string)[],
): Promise<void> {
  if (ids.length === 0) return;
  const hashes = ids.map(String).join("|");
  const res = await apiFetch("/torrents/start", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `hashes=${hashes}`,
  });
  if (!res.ok)
    throw new Error(`qBittorrent startAllTorrents: HTTP ${res.status}`);
}

/** Re-announces all torrents to their trackers. */
export async function reannounceAllTorrents(): Promise<void> {
  const res = await apiFetch("/torrents/reannounce", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "hashes=all",
  });
  if (!res.ok)
    throw new Error(`qBittorrent reannounceAllTorrents: HTTP ${res.status}`);
}

/** Returns the current peer-listen port from qBittorrent preferences. */
export async function getSessionPeerPort(): Promise<number | null> {
  try {
    const res = await apiFetch("/app/preferences");
    if (!res.ok) return null;
    const prefs = (await res.json()) as { listen_port?: number };
    return prefs.listen_port ?? null;
  } catch {
    return null;
  }
}

/** Updates the peer-listen port via qBittorrent preferences. */
export async function setSessionPeerPort(port: number): Promise<void> {
  const res = await apiFetch("/app/setPreferences", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `json=${encodeURIComponent(JSON.stringify({ listen_port: port }))}`,
  });
  if (!res.ok)
    throw new Error(`qBittorrent setSessionPeerPort: HTTP ${res.status}`);
}

/**
 * Checks tracker connectivity by sampling up to 5 active torrents.
 *
 * qBittorrent tracker status codes:
 *   0 = disabled / DHT / PeX (skip)
 *   1 = not yet contacted (skip)
 *   2 = working
 *   3 = updating
 *   4 = not working
 *
 * Returns true if any sampled tracker is in working/updating state,
 * false if all have been contacted and are failing, null if no data.
 */
export async function checkTrackerConnectivity(): Promise<boolean | null> {
  try {
    const listRes = await apiFetch("/torrents/info");
    if (!listRes.ok) return null;
    const torrents = (await listRes.json()) as Array<{
      hash: string;
      state: string;
    }>;
    if (torrents.length === 0) return null;

    // Sample up to 5 non-completed torrents for the tracker check
    const active = torrents.filter(
      (t) =>
        !["uploading", "stalledUP", "pausedUP", "stoppedUP"].includes(t.state),
    );
    const sample = (active.length > 0 ? active : torrents).slice(0, 5);

    let hasHistory = false;
    let anySuccess = false;

    for (const torrent of sample) {
      const trackerRes = await apiFetch(
        `/torrents/trackers?hash=${torrent.hash}`,
      );
      if (!trackerRes.ok) continue;
      const trackers = (await trackerRes.json()) as Array<{
        status: number;
      }>;
      for (const tracker of trackers) {
        if (tracker.status <= 1) continue; // not yet contacted or disabled
        hasHistory = true;
        if (tracker.status === 2 || tracker.status === 3) anySuccess = true;
      }
    }

    if (!hasHistory) return null;
    return anySuccess;
  } catch {
    return null;
  }
}

/**
 * Checks if qBittorrent is reachable from *inside* the VPN container's
 * network namespace (which qBittorrent shares when using --network container).
 * Any HTTP response (including 403 auth errors) means the process is alive.
 */
export async function checkInternalHealth(): Promise<boolean> {
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=5",
      `http://localhost:${QB_PORT}/api/v2/app/version`,
    ]);
    // wget exits 0 (success) or 8 (server error, e.g. 403 = auth required).
    // Both indicate the process is alive. Other codes = connection failure.
    return result.exitCode === 0 || result.exitCode === 8;
  } catch {
    return false;
  }
}

// ─── Client object ───────────────────────────────────────────────────────────

export const qbittorrentClient: TorrentClient = {
  clientName: "qBittorrent",
  containerName: QBITTORRENT_CONTAINER_NAME,
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
