const NETWORK_CHECK_URL = process.env.NETWORK_CHECK_URL ?? "http://1.1.1.1";
const NETWORK_TIMEOUT_MS = 5_000;

/**
 * Returns true if the network is reachable by performing a simple HTTP GET
 * to a known stable endpoint (1.1.1.1 by default). Uses an AbortController
 * to enforce a short timeout so we don't block the main loop.
 */
export async function checkNetwork(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(NETWORK_CHECK_URL, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
