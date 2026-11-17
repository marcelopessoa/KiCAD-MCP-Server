/**
 * Runtime control of the long-command watchdog (policy in ../command-timeout.ts).
 *
 * The KICAD_MCP_* environment variables set the startup values; changing them
 * requires re-registering and restarting the server. This tool changes them for
 * the running session instead — e.g. shorter intervals while testing, or a
 * longer prompt delay before a known-slow batch of exports.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatElapsed, loadWatchdogPolicy, WatchdogPolicy } from "../command-timeout.js";
import { logger } from "../logger.js";

export interface WatchdogPolicyAccess {
  get(): WatchdogPolicy;
  set(policy: WatchdogPolicy): void;
}

const MAX_SECONDS = 86_400; // one day

const secondsField = (description: string, min = 0) =>
  z.number().min(min).max(MAX_SECONDS).optional().describe(description);

/** Current settings in seconds, plus a one-line human summary. */
export function describeWatchdogPolicy(policy: WatchdogPolicy) {
  const alerts =
    policy.alertIntervalMs > 0
      ? `alerta a cada ${formatElapsed(policy.alertIntervalMs)}`
      : "sem alertas periódicos";
  const prompt =
    policy.interruptPromptMs > 0
      ? `pergunta se deve interromper aos ${formatElapsed(policy.interruptPromptMs)} ` +
        `(e de novo a cada ${formatElapsed(policy.interruptPromptMs)})`
      : "nunca pergunta (Esc ainda cancela)";
  const ceiling =
    policy.hardTimeoutMs > 0
      ? `interrompe sozinho aos ${formatElapsed(policy.hardTimeoutMs)}`
      : "sem limite de tempo";
  return {
    alertIntervalSec: policy.alertIntervalMs / 1000,
    interruptPromptSec: policy.interruptPromptMs / 1000,
    interruptGraceSec: policy.interruptGraceMs / 1000,
    commandTimeoutSec: policy.hardTimeoutMs / 1000,
    summary:
      `${alerts}; ${prompt}; ${ceiling}; worker interrompido tem ` +
      `${formatElapsed(policy.interruptGraceMs)} para responder antes de ser reiniciado`,
  };
}

export function registerWatchdogTools(
  server: McpServer,
  access: WatchdogPolicyAccess,
  env: NodeJS.ProcessEnv = process.env,
): void {
  server.tool(
    "command_watchdog_settings",
    "Show or change how long-running KiCAD commands are supervised in this server session. " +
      "There is no fixed timeout: the server alerts the client every alertIntervalSec, asks " +
      "the user whether to interrupt after interruptPromptSec (and again at that interval), " +
      "gives an interrupted worker interruptGraceSec to answer before restarting it, and can " +
      "enforce an optional hard ceiling (commandTimeoutSec). Values are seconds; 0 disables " +
      "alerts, the question, or the ceiling. Call with no arguments to read the settings; " +
      "reset=true restores the startup values (KICAD_MCP_* environment variables). Changes " +
      "apply to commands started afterwards and last until the server restarts.",
    {
      alertIntervalSec: secondsField(
        "Seconds between 'still running' alerts (0 = no periodic alerts). Default 30.",
      ),
      interruptPromptSec: secondsField(
        "Seconds before asking whether to interrupt, and between repeated questions " +
          "(0 = never ask; the client can still cancel). Default 300.",
      ),
      interruptGraceSec: secondsField(
        "Seconds an interrupted worker gets to answer before it is restarted " +
          "(restarting discards the project/board loaded in memory). Default 10.",
        1,
      ),
      commandTimeoutSec: secondsField(
        "Optional hard ceiling: interrupt automatically after this many seconds " +
          "(0 = no ceiling, the default).",
      ),
      reset: z
        .boolean()
        .optional()
        .describe("Restore the startup values before applying any other argument."),
    },
    async (args: {
      alertIntervalSec?: number;
      interruptPromptSec?: number;
      interruptGraceSec?: number;
      commandTimeoutSec?: number;
      reset?: boolean;
    }) => {
      const policy: WatchdogPolicy = args.reset ? loadWatchdogPolicy(env) : { ...access.get() };
      const changed: string[] = [];
      const apply = (value: number | undefined, key: keyof WatchdogPolicy, name: string) => {
        if (value === undefined) return;
        policy[key] = Math.round(value * 1000);
        changed.push(name);
      };
      apply(args.alertIntervalSec, "alertIntervalMs", "alertIntervalSec");
      apply(args.interruptPromptSec, "interruptPromptMs", "interruptPromptSec");
      apply(args.interruptGraceSec, "interruptGraceMs", "interruptGraceSec");
      apply(args.commandTimeoutSec, "hardTimeoutMs", "commandTimeoutSec");

      const updated = Boolean(args.reset) || changed.length > 0;
      if (updated) {
        access.set(policy);
        logger.info(
          `Watchdog settings ${args.reset ? "reset" : "changed"}` +
            (changed.length ? ` (${changed.join(", ")})` : "") +
            `: ${describeWatchdogPolicy(policy).summary}`,
        );
      }

      const result = {
        success: true,
        updated,
        reset: Boolean(args.reset),
        changed,
        settings: describeWatchdogPolicy(policy),
        note: updated
          ? "Vale para os próximos comandos e dura até o servidor reiniciar; para mudar " +
            "permanentemente, use as variáveis KICAD_MCP_* na configuração do servidor MCP."
          : "Configuração atual (nada alterado).",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
