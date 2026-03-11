import net from "node:net";
import type { TorrentClient } from "./torrent-client";

// ─── Config ──────────────────────────────────────────────────────────────────

// Full path to the socket file inside this container (the volume is mounted at /run/rtorrent).
const RT_SOCKET_PATH =
  process.env.RTORRENT_SCGI_SOCKET ?? "/run/rtorrent/rpc.socket";

export const RTORRENT_CONTAINER_NAME =
  process.env.RTORRENT_CONTAINER_NAME ?? "rtorrent";

const API_TIMEOUT_MS = 10_000;

// ─── XML-RPC helpers ─────────────────────────────────────────────────────────

/** Wraps a single value as an XML-RPC <value> element. */
function xmlValue(v: string | number | boolean): string {
  if (typeof v === "number" && Number.isInteger(v)) {
    return `<value><int>${v}</int></value>`;
  }
  if (typeof v === "boolean") {
    return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  }
  // Escape XML special chars in strings
  const escaped = String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<value><string>${escaped}</string></value>`;
}

/** Builds an XML-RPC method call body. */
function buildCall(
  method: string,
  params: Array<string | number | boolean | Array<Record<string, unknown>>>,
): string {
  const paramXml = params
    .map((p) => {
      if (Array.isArray(p)) {
        // Array of structs — used for system.multicall
        const dataItems = p.map((struct) => {
          const members = Object.entries(struct)
            .map(
              ([k, v]) =>
                `<member><name>${k}</name>${xmlValue(v as string | number | boolean)}</member>`,
            )
            .join("");
          return `<value><struct>${members}</struct></value>`;
        });
        return `<param><value><array><data>${dataItems.join("")}</data></array></value></param>`;
      }
      return `<param>${xmlValue(p)}</param>`;
    })
    .join("");

  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;
}

/** Extracts all <string> values from an XML-RPC response. */
function parseStrings(xml: string): string[] {
  const results: string[] = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(
      m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    );
  }
  return results;
}

/** Extracts the first integer value from an XML-RPC response. */
function parseIntValue(xml: string): number | null {
  const m = xml.match(/<(?:int|i4|i8)>(\d+)<\/(?:int|i4|i8)>/);
  return m ? parseInt(m[1]!, 10) : null;
}

/** Returns true if the response contains a <fault> element. */
function isFault(xml: string): boolean {
  return xml.includes("<fault>");
}

/**
 * Sends raw bytes over the rTorrent SCGI Unix socket and resolves with the
 * response body (everything after the HTTP-like \r\n\r\n header separator).
 */
function scgiSend(requestBuf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ path: RT_SOCKET_PATH });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("rTorrent SCGI timeout"));
    }, API_TIMEOUT_MS);

    socket.on("connect", () => socket.write(requestBuf));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const sep = raw.indexOf("\r\n\r\n");
      if (sep === -1) {
        reject(new Error("rTorrent SCGI: malformed response"));
        return;
      }
      resolve(raw.slice(sep + 4));
    });
    socket.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Sends a single XML-RPC call over SCGI and returns the raw response text. */
async function rpc(
  method: string,
  params: Array<
    string | number | boolean | Array<Record<string, unknown>>
  > = [],
): Promise<string> {
  const body = buildCall(method, params);
  const bodyBuf = Buffer.from(body, "utf8");
  // Build SCGI netstring header: "<len>:<NV pairs>,"
  const nvPairs =
    `CONTENT_LENGTH\0${bodyBuf.length}\0` +
    `SCGI\x001\0` +
    `REQUEST_METHOD\0POST\0` +
    `CONTENT_TYPE\0text/xml\0`;
  const nvBuf = Buffer.from(nvPairs, "utf8");
  const requestBuf = Buffer.concat([
    Buffer.from(`${nvBuf.length}:`),
    nvBuf,
    Buffer.from(","),
    bodyBuf,
  ]);
  return scgiSend(requestBuf);
}

// ─── Client operations ───────────────────────────────────────────────────────

/** Returns true if the rTorrent XML-RPC endpoint is up and responding. */
async function checkHealth(): Promise<boolean> {
  try {
    const xml = await rpc("system.listMethods");
    return !isFault(xml);
  } catch {
    return false;
  }
}

/** Returns the info-hashes of all torrents in rTorrent. */
async function getAllTorrentIds(): Promise<string[]> {
  // download_list returns a list of info-hashes (strings)
  const xml = await rpc("download_list", [""]);
  if (isFault(xml)) throw new Error("rTorrent getAllTorrentIds: RPC fault");
  return parseStrings(xml);
}

/** Stops (closes) the given torrents. */
async function stopAllTorrents(ids: (number | string)[]): Promise<void> {
  if (ids.length === 0) return;
  const calls = ids.map((id) => ({
    methodName: "d.stop",
    params: String(id),
  }));
  const xml = await rpc("system.multicall", [calls]);
  if (isFault(xml)) throw new Error("rTorrent stopAllTorrents: RPC fault");
}

/** Starts (resumes) the given torrents. */
async function startAllTorrents(ids: (number | string)[]): Promise<void> {
  if (ids.length === 0) return;
  const calls = ids.map((id) => ({
    methodName: "d.start",
    params: String(id),
  }));
  const xml = await rpc("system.multicall", [calls]);
  if (isFault(xml)) throw new Error("rTorrent startAllTorrents: RPC fault");
}

/**
 * Checks tracker/VPN connectivity by inspecting connected peer counts.
 *
 * rTorrent does not expose per-tracker status codes in a unified format,
 * so we use d.peers.connected as a reliable proxy for VPN tunnel health.
 *
 * Returns true if any torrent has at least one connected peer,
 * false if all have been active but show zero peers, null if no torrents.
 */
async function checkTrackerConnectivity(): Promise<boolean | null> {
  try {
    // d.multicall2 with view "" fetches all torrents; request hash + peers.connected
    const xml = await rpc("d.multicall2", [
      "",
      "",
      "d.hash=",
      "d.peers.connected=",
    ]);
    if (isFault(xml)) return null;

    // Response is an array of arrays: [[hash, peerCount], ...]
    // Parse all integers — even-indexed strings are hashes (skip), odd are peer counts
    const strings = parseStrings(xml);
    if (strings.length === 0) return null;

    // Peer counts appear as <i8> or <int> values in the multicall response
    const intRe = /<(?:int|i4|i8)>(\d+)<\/(?:int|i4|i8)>/g;
    const peerCounts: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = intRe.exec(xml)) !== null) {
      peerCounts.push(parseInt(m[1]!, 10));
    }

    if (peerCounts.length === 0) return null;
    return peerCounts.some((n) => n > 0);
  } catch {
    return null;
  }
}

/**
 * Returns the current peer-listen port from rTorrent's network settings.
 * Uses network.listen.port (the actual bound port, not the configured range).
 */
async function getSessionPeerPort(): Promise<number | null> {
  try {
    const xml = await rpc("network.listen.port");
    if (isFault(xml)) return null;
    return parseIntValue(xml);
  } catch {
    return null;
  }
}

/**
 * Updates the peer-listen port at runtime. rTorrent requires closing the
 * listen socket, updating the port range, then reopening it.
 */
async function setSessionPeerPort(port: number): Promise<void> {
  // Close current socket
  await rpc("network.listen.close");
  // Set new port range (rTorrent accepts "port-port" or "port")
  await rpc("network.port_range.set", [`${port}-${port}`]);
  // Reopen socket on the new port
  const xml = await rpc("network.listen.open");
  if (isFault(xml)) throw new Error("rTorrent setSessionPeerPort: RPC fault");
}

/**
 * Verifies the rTorrent process is alive by attempting to connect to the SCGI
 * socket. If the socket file exists and accepts connections, rTorrent is running.
 * The socket is mounted directly into the watchdog container — no exec needed.
 */
async function checkInternalHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: RT_SOCKET_PATH });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 3_000);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ─── Exported client ─────────────────────────────────────────────────────────

export const rtorrentClient: TorrentClient = {
  clientName: "rTorrent",
  containerName: RTORRENT_CONTAINER_NAME,
  checkHealth,
  getAllTorrentIds,
  stopAllTorrents,
  startAllTorrents,
  checkTrackerConnectivity,
  getSessionPeerPort,
  setSessionPeerPort,
  checkInternalHealth,
};
