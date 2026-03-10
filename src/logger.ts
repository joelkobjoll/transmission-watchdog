// src/logger.ts — coloured, human-readable terminal output

/** Only apply ANSI codes when stdout is a real TTY (not piped to a file). */
const IS_TTY = process.stdout.isTTY === true;

/** Wrap text in ANSI SGR escape codes, or return plain text when not in a TTY. */
function sgr(codes: string, text: string): string {
  return IS_TTY ? `\x1b[${codes}m${text}\x1b[0m` : text;
}

/** Human-readable timestamp: "Mar 10 11:51:13" */
function humanTs(): string {
  const n = new Date();
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const d = String(n.getDate()).padStart(2, "0");
  const hh = String(n.getHours()).padStart(2, "0");
  const mm = String(n.getMinutes()).padStart(2, "0");
  const ss = String(n.getSeconds()).padStart(2, "0");
  return sgr("90", `[${MONTHS[n.getMonth()]} ${d} ${hh}:${mm}:${ss}]`);
}

export type LogLevel = "INFO" | "OK" | "WARN" | "ERROR";

function badge(level: LogLevel): string {
  switch (level) {
    case "INFO":
      return sgr("36", " INFO"); // cyan
    case "OK":
      return sgr("1;32", "   OK"); // bold green
    case "WARN":
      return sgr("1;33", " WARN"); // bold yellow
    case "ERROR":
      return sgr("1;31", " ERR "); // bold red
  }
}

function levelIcon(level: LogLevel): string {
  if (!IS_TTY) return "";
  switch (level) {
    case "INFO":
      return "   ";
    case "OK":
      return sgr("32", "✓") + "  ";
    case "WARN":
      return sgr("33", "⚠") + "  ";
    case "ERROR":
      return sgr("31", "✗") + "  ";
  }
}

export function log(level: LogLevel, message: string): void {
  console.log(`${humanTs()} ${badge(level)}  ${levelIcon(level)}${message}`);
}

/**
 * Print a prominent divider banner — used for state transitions such as
 * entering RESTARTING or RECOVERY so they stand out in the log stream.
 */
export function logBanner(title: string, detail?: string): void {
  const bar = sgr("90", "─".repeat(56));
  console.log(bar);
  console.log(`  ${sgr("1", title)}`);
  if (detail) console.log(`  ${sgr("90", detail)}`);
  console.log(bar);
}

export interface HealthRow {
  label: string;
  /** true = healthy  |  false = unhealthy  |  null = not checked / n/a */
  ok: boolean | null;
  detail?: string;
}

/**
 * Print a grouped health-check block with coloured ✓ / ✗ / ? icons.
 * Each row still starts with a timestamp so log files stay grep-friendly.
 *
 * Example output:
 *   [Mar 10 11:51:13]  INFO  ───────────────────────────────────────────
 *   [Mar 10 11:51:13]  INFO   ✓  VPN           internet OK · port 52013
 *   [Mar 10 11:51:13]  INFO   ✗  Transmission  RPC not responding
 *   [Mar 10 11:51:13]  INFO  ───────────────────────────────────────────
 */
export function logHealthSummary(rows: HealthRow[]): void {
  const divider = sgr("90", "─".repeat(54));
  const infoBadge = badge("INFO");
  console.log(`${humanTs()} ${infoBadge}  ${divider}`);
  for (const { label, ok, detail } of rows) {
    const statusIcon =
      ok === null
        ? sgr("90", " ? ")
        : ok
          ? sgr("1;32", " ✓ ")
          : sgr("1;31", " ✗ ");
    const labelStr =
      ok === false ? sgr("1;33", label.padEnd(14)) : sgr("1", label.padEnd(14));
    const detailStr = detail
      ? "  " + (ok === false ? sgr("33", detail) : sgr("90", detail))
      : "";
    console.log(
      `${humanTs()} ${infoBadge}  ${statusIcon}  ${labelStr}${detailStr}`,
    );
  }
  console.log(`${humanTs()} ${infoBadge}  ${divider}`);
}
