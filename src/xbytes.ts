import { log } from "./logger";

export interface XBytesStatus {
  seeding: number;
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
    return data.seeding ?? null;
  } catch (err) {
    log("WARN", `[xbytes] Failed to fetch status: ${err}`);
    return null;
  }
}
