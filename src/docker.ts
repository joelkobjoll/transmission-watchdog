const UNRAID_IP = process.env.UNRAID_IP ?? "192.168.1.100";
const DOCKER_PORT = process.env.DOCKER_PORT ?? "2375";
const BASE_URL = `http://${UNRAID_IP}:${DOCKER_PORT}`;
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS ?? 30_000);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Sends a POST to the Docker TCP API to restart the given container.
 * Resolves when Docker has accepted the request (202) or the container
 * was already being restarted (304/404 treated as notable, not fatal).
 * Throws if the request fails at the network level.
 */
export async function restartContainer(containerName: string): Promise<void> {
  const url = `${BASE_URL}/containers/${encodeURIComponent(containerName)}/restart`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok && res.status !== 304) {
    throw new Error(
      `Docker restart failed: HTTP ${res.status} for container "${containerName}"`,
    );
  }
}

/** Stops a container (SIGTERM, then SIGKILL after Docker's default 10 s). */
export async function stopContainer(containerName: string): Promise<void> {
  const url = `${BASE_URL}/containers/${encodeURIComponent(containerName)}/stop`;
  const res = await fetch(url, { method: "POST" });
  // 304 = already stopped; both are fine
  if (!res.ok && res.status !== 304) {
    throw new Error(
      `Docker stop failed: HTTP ${res.status} for container "${containerName}"`,
    );
  }
}

/** Starts a stopped container. */
export async function startContainer(containerName: string): Promise<void> {
  const url = `${BASE_URL}/containers/${encodeURIComponent(containerName)}/start`;
  const res = await fetch(url, { method: "POST" });
  // 304 = already started
  if (!res.ok && res.status !== 304) {
    throw new Error(
      `Docker start failed: HTTP ${res.status} for container "${containerName}"`,
    );
  }
}

/**
 * Returns the running state of a container via Docker inspect.
 * Returns "running", "exited", "restarting", etc., or null if the
 * container could not be inspected (network error / not found).
 */
export async function getContainerState(
  containerName: string,
): Promise<string | null> {
  const url = `${BASE_URL}/containers/${encodeURIComponent(containerName)}/json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { State?: { Status?: string } };
    return data?.State?.Status ?? null;
  } catch {
    return null;
  }
}

/**
 * Polls getContainerState until the container reaches "exited" or "dead".
 * Returns true when stopped, false on timeout.
 */
export async function waitForContainerStopped(
  containerName: string,
  maxAttempts: number,
  intervalMs: number,
): Promise<boolean> {
  for (let i = 1; i <= maxAttempts; i++) {
    await sleep(intervalMs);
    const state = await getContainerState(containerName);
    if (state === "exited" || state === "dead") return true;
  }
  return false;
}

/**
 * Executes a command inside a running container via the Docker exec API.
 *
 * Docker exec uses a multiplexed stream format when Tty=false:
 *   [type(1B), padding(3B), size(4B big-endian)] then <size> bytes of payload
 *   type 1 = stdout, type 2 = stderr
 *
 * Returns stdout, stderr, and the exit code of the command.
 */
export async function execInContainer(
  containerName: string,
  cmd: string[],
): Promise<ExecResult> {
  // 1. Create exec instance
  const createController = new AbortController();
  const createTimer = setTimeout(
    () => createController.abort(),
    EXEC_TIMEOUT_MS,
  );
  let execId: string;
  try {
    const createRes = await fetch(
      `${BASE_URL}/containers/${encodeURIComponent(containerName)}/exec`,
      {
        method: "POST",
        signal: createController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: cmd,
        }),
      },
    );
    if (!createRes.ok) {
      throw new Error(`Docker exec create failed: HTTP ${createRes.status}`);
    }
    const createData = (await createRes.json()) as { Id: string };
    execId = createData.Id;
  } finally {
    clearTimeout(createTimer);
  }

  // 2. Start exec and collect multiplexed output
  const startController = new AbortController();
  const startTimer = setTimeout(() => startController.abort(), EXEC_TIMEOUT_MS);
  let stdout = "";
  let stderr = "";
  try {
    const startRes = await fetch(`${BASE_URL}/exec/${execId}/start`, {
      method: "POST",
      signal: startController.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Detach: false, Tty: false }),
    });
    if (!startRes.ok) {
      throw new Error(`Docker exec start failed: HTTP ${startRes.status}`);
    }

    // Parse Docker multiplexed stream
    const raw = await startRes.arrayBuffer();
    const buf = new Uint8Array(raw);
    const dec = new TextDecoder();
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const streamType = buf[offset];
      const payloadSize =
        (buf[offset + 4] << 24) |
        (buf[offset + 5] << 16) |
        (buf[offset + 6] << 8) |
        buf[offset + 7];
      offset += 8;
      if (offset + payloadSize > buf.length) break;
      const payload = dec.decode(buf.slice(offset, offset + payloadSize));
      if (streamType === 1) stdout += payload;
      else if (streamType === 2) stderr += payload;
      offset += payloadSize;
    }
  } finally {
    clearTimeout(startTimer);
  }

  // 3. Retrieve exit code
  let exitCode = 0;
  try {
    const inspectRes = await fetch(`${BASE_URL}/exec/${execId}/json`);
    if (inspectRes.ok) {
      const inspectData = (await inspectRes.json()) as { ExitCode?: number };
      exitCode = inspectData.ExitCode ?? 0;
    }
  } catch {
    // best-effort; exit code defaults to 0
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
