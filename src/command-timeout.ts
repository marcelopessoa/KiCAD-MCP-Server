/**
 * Long-command policy for the Python worker bridge.
 *
 * There is no fixed per-command timeout. The old 30 s ceiling failed commands
 * that were still making progress on a slow machine (e.g. WSL under load, where
 * kicad-cli alone needs minutes to parse the symbol libraries), and it never
 * stopped the work anyway: the Python worker kept running the abandoned command
 * and the next request simply queued behind it.
 *
 * Instead the bridge watches every command it dispatches:
 *  - every `alertIntervalMs` it alerts the client (progress notification for the
 *    tool call plus an MCP log message);
 *  - after `interruptPromptMs` it asks the user (MCP elicitation) whether to keep
 *    waiting or interrupt, and asks again after each further `interruptPromptMs`;
 *  - the client may cancel the tool call at any time (notifications/cancelled,
 *    e.g. Esc in Claude Code), which interrupts as well.
 *
 * Interrupting kills the worker's child processes (kicad-cli, Freerouting, the
 * zone-fill subprocess, ...) so the Python handler returns and the board loaded
 * in memory survives; if the worker still has not answered after
 * `interruptGraceMs`, the worker itself is restarted.
 *
 * Every knob is an environment variable in seconds; 0 disables it.
 */

/** Periodic "still running" alert. */
export const DEFAULT_ALERT_INTERVAL_MS = 30_000;

/** When the user is first offered to interrupt (and the re-ask interval). */
export const DEFAULT_INTERRUPT_PROMPT_MS = 300_000;

/** How long an interrupted worker gets to answer before it is restarted. */
export const DEFAULT_INTERRUPT_GRACE_MS = 10_000;

export interface WatchdogPolicy {
  /** Optional hard ceiling; reaching it interrupts the command. 0 = none (default). */
  hardTimeoutMs: number;
  /** 0 = no periodic alerts. */
  alertIntervalMs: number;
  /** 0 = never ask (the client can still cancel). */
  interruptPromptMs: number;
  interruptGraceMs: number;
}

export function loadWatchdogPolicy(env: NodeJS.ProcessEnv = process.env): WatchdogPolicy {
  return {
    hardTimeoutMs: secondsFromEnv(env.KICAD_MCP_COMMAND_TIMEOUT_SEC, 0),
    alertIntervalMs: secondsFromEnv(env.KICAD_MCP_ALERT_INTERVAL_SEC, DEFAULT_ALERT_INTERVAL_MS),
    interruptPromptMs: secondsFromEnv(
      env.KICAD_MCP_INTERRUPT_PROMPT_SEC,
      DEFAULT_INTERRUPT_PROMPT_MS,
    ),
    interruptGraceMs: secondsFromEnv(env.KICAD_MCP_INTERRUPT_GRACE_SEC, DEFAULT_INTERRUPT_GRACE_MS),
  };
}

/** Seconds (fractions allowed) → ms; unset, empty, negative or nonsense → fallback. */
function secondsFromEnv(raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.round(seconds * 1000);
}

/** Human-readable duration for alerts: "45s", "2min05s", "5min", "1h03min". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}min`;
  if (m > 0) return s > 0 ? `${m}min${String(s).padStart(2, "0")}s` : `${m}min`;
  return `${s}s`;
}
