import { execInContainer } from "./docker";
import type { TorrentClient } from "./torrent-client";

// ─── Config ──────────────────────────────────────────────────────────────────

const UNRAID_IP = process.env.UNRAID_IP ?? "192.168.1.100";
const RT_PORT = process.env.RTORRENT_PORT ?? "8080";
const RT_RPC_PATH = process.env.RTORRENT_RPC_PATH ?? "/RPC2";
const RT_BASE_URL = `http://${UNRAID_IP}:${RT_PORT}${RT_RPC_PATH}`;

export const RTORRENT_CONTAINER_NAME =
  process.env.RTORRENT_CONTAINER_NAME ?? "rtorrent";

// The VPN container whose network namespace rTorrent shares (for exec-based checks).
const VPN_CONTAINER_NAME = process.env.VPN_CONTAINER_NAME ?? "wireguard-pia";

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

/** Sends a single XML-RPC call and returns the raw response text. */
async function rpc(
  method: string,
  params: Array<
    string | number | boolean | Array<Record<string, unknown>>
  > = [],
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(RT_BASE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "text/xml" },
      body: buildCall(method, params),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`rTorrent RPC HTTP ${res.status}`);
    return res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
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
 * Verifies that the rTorrent process is alive by executing wget from inside
 * the VPN container (which shares the network namespace with rTorrent).
 * Exit code 0 or 8 (any HTTP response) both indicate a live process.
 */
async function checkInternalHealth(): Promise<boolean> {
  try {
    const url = `http://localhost:${RT_PORT}${RT_RPC_PATH}`;
    const { exitCode } = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=10",
      url,
    ]);
    return exitCode === 0 || exitCode === 8;
  } catch {
    return false;
  }
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
