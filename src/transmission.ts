const UNRAID_IP = process.env.UNRAID_IP ?? "192.168.1.100";
const TRANSMISSION_PORT = process.env.TRANSMISSION_PORT ?? "9091";
const RPC_URL = `http://${UNRAID_IP}:${TRANSMISSION_PORT}/transmission/rpc`;
const RPC_TIMEOUT_MS = 10_000;

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
export async function stopAllTorrents(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc({ method: "torrent-stop", arguments: { ids } });
}

/** Starts (resumes) all torrents. */
export async function startAllTorrents(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await fetchRpc({ method: "torrent-start", arguments: { ids } });
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
