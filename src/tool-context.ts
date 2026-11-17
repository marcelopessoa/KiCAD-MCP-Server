/**
 * Per-tool-call context, carried to the Python bridge without touching the
 * ~230 tool handlers.
 *
 * Handlers only receive `callKicadScript(command, params)`, so the request's
 * cancellation signal and progress token would otherwise never reach the code
 * that waits on the Python worker. `instrumentToolRegistration` wraps
 * `McpServer.tool` once, before registration, so every handler runs inside
 * `toolCallContext.run(...)`; `callKicadScript` reads it back with `getStore()`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolCallContext {
  toolName: string;
  /** Aborted when the client cancels the tool call (notifications/cancelled). */
  signal?: AbortSignal;
  /** Present only when the client asked for progress (`_meta.progressToken`). */
  progressToken?: string | number;
  sendNotification?: (notification: any) => Promise<void>;
  sendRequest?: (request: any, resultSchema: any, options?: any) => Promise<any>;
  /** Last progress value sent; progress must keep increasing within one call. */
  lastProgress?: number;
}

export const toolCallContext = new AsyncLocalStorage<ToolCallContext>();

/** Build the context from the SDK's RequestHandlerExtra (the handler's last argument). */
export function contextFromExtra(toolName: string, extra: any): ToolCallContext {
  return {
    toolName,
    signal: extra?.signal,
    progressToken: extra?._meta?.progressToken,
    sendNotification:
      typeof extra?.sendNotification === "function" ? extra.sendNotification : undefined,
    sendRequest: typeof extra?.sendRequest === "function" ? extra.sendRequest : undefined,
  };
}

export function instrumentToolRegistration(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as any).tool = (...args: unknown[]) => {
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === "function") {
      const toolName = String(args[0]);
      // The SDK calls handler(args, extra), or handler(extra) for tools
      // without an input schema: the extra is always the last argument.
      args[last] = (...handlerArgs: unknown[]) =>
        toolCallContext.run(contextFromExtra(toolName, handlerArgs[handlerArgs.length - 1]), () =>
          (callback as (...a: unknown[]) => unknown)(...handlerArgs),
        );
    }
    return original(...args);
  };
}
