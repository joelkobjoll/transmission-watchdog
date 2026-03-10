import { execInContainer, getContainerState } from "./docker";

const VPN_CONTAINER_NAME = process.env.VPN_CONTAINER_NAME ?? "wireguard-pia";
const VPN_PORT_FILE_PATH =
  process.env.VPN_PORT_FILE_PATH ?? "/pia-shared/port.dat";
const VPN_CONNECT_TIMEOUT_ATTEMPTS = Number(
  process.env.VPN_CONNECT_TIMEOUT_ATTEMPTS ?? 60,
);
const VPN_PORT_FORWARDING_ENABLED =
  (process.env.VPN_PORT_FORWARDING_ENABLED ?? "true").toLowerCase() === "true";

export { VPN_CONTAINER_NAME };

/** Returns true if the VPN container is in the "running" state. */
export async function checkVpnRunning(): Promise<boolean> {
  const state = await getContainerState(VPN_CONTAINER_NAME);
  return state === "running";
}

/**
 * Execs a simple HTTP GET inside the VPN container to verify the VPN
 * tunnel has internet connectivity.  Uses wget because it is available
 * in Alpine-based wireguard images.
 */
export async function checkVpnInternet(): Promise<boolean> {
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=10",
      "http://1.1.1.1",
    ]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the VPN container's external (public) IP address by querying
 * a plain-text IP reflection service from inside the container.
 * Returns null on any failure.
 */
export async function getVpnExternalIp(): Promise<string | null> {
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=10",
      "https://api.ipify.org",
    ]);
    if (result.exitCode !== 0) return null;
    const ip = result.stdout.trim();
    return ip.length > 0 ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Reads the port-forwarding file written by wireguard-pia inside the
 * VPN container (default: /pia/port.dat).
 * Returns the forwarded port number, or null if unavailable/unreadable.
 * If VPN_PORT_FORWARDING_ENABLED is false, always returns null.
 */
export async function getForwardedPort(): Promise<number | null> {
  if (!VPN_PORT_FORWARDING_ENABLED) return null;
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "cat",
      VPN_PORT_FILE_PATH,
    ]);
    if (result.exitCode !== 0) return null;
    const port = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Polls until the VPN container has internet connectivity.
 * Returns true on success, false on timeout.
 */
export async function waitForVpnInternet(
  maxAttempts: number = VPN_CONNECT_TIMEOUT_ATTEMPTS,
  intervalMs: number = 10_000,
): Promise<boolean> {
  for (let i = 1; i <= maxAttempts; i++) {
    await sleep(intervalMs);
    if (await checkVpnInternet()) return true;
  }
  return false;
}

/**
 * Polls until the VPN container has both internet connectivity AND a valid
 * forwarded port.  Returns the forwarded port on success, or null on timeout.
 */
export async function waitForVpnConnected(
  maxAttempts: number = VPN_CONNECT_TIMEOUT_ATTEMPTS,
  intervalMs: number = 10_000,
): Promise<number | null> {
  for (let i = 1; i <= maxAttempts; i++) {
    await sleep(intervalMs);
    const [hasInternet, port] = await Promise.all([
      checkVpnInternet(),
      getForwardedPort(),
    ]);
    if (hasInternet && port !== null) return port;
  }
  return null;
}

/**
 * Checks if Transmission's RPC endpoint is reachable from *inside* the VPN
 * container (which shares the network namespace with the transmission-vpn
 * container).  A response on port 9091 — even a 409 — means the process is
 * alive; only a connection-refused / timeout indicates it is dead.
 *
 * This distinguishes "TX is busy doing a file move" (external timeout but
 * internal success) from "TX process has crashed" (internal failure too).
 */
export async function checkTransmissionInternalHealth(): Promise<boolean> {
  const txPort = process.env.TRANSMISSION_PORT ?? "9091";
  try {
    const result = await execInContainer(VPN_CONTAINER_NAME, [
      "wget",
      "-qO-",
      "--timeout=5",
      `http://localhost:${txPort}/transmission/rpc`,
    ]);
    // wget exits 0 (success) or 8 (server error, e.g. 409 from Transmission).
    // Both mean the process is alive and responding.
    // Exit code 1 = generic error, 4 = network failure, 5 = SSL error.
    // We treat exit codes 0 and 8 as "alive".
    return result.exitCode === 0 || result.exitCode === 8;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
