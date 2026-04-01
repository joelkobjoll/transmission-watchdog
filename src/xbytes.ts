import { log } from "./logger";

export interface XBytesStatus {
  ok: boolean;
  ts: string;
  services: Record<string, unknown>;
  features: Record<string, unknown>;
  xbytes: {
    seeding: number;
    cachedAt: string;
  } | null;
}

export async function getXBytesSeeding(
  url: string,
  apiKey: string,
): Promise<number | null> {
  try {
    const res = await fetch(`${url}?apiKey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      log("WARN", `[xbytes] Status endpoint returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as XBytesStatus;
    if (data.xbytes === null || data.xbytes === undefined) {
      return null;
    }
    return data.xbytes.seeding ?? null;
  } catch (err) {
    log("WARN", `[xbytes] Failed to fetch status: ${err}`);
    return null;
  }
}
