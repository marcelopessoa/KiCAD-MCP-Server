import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { WatchdogPolicy } from "../src/command-timeout.js";
import { KiCADMcpServer } from "../src/server.js";
import { registerWatchdogTools } from "../src/tools/watchdog.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

const DEFAULTS: WatchdogPolicy = {
  hardTimeoutMs: 0,
  alertIntervalMs: 30_000,
  interruptPromptMs: 300_000,
  interruptGraceMs: 10_000,
};

function setup(env: NodeJS.ProcessEnv = {}) {
  let handler: any;
  const fakeServer = {
    tool: (...args: any[]) => {
      handler = args[args.length - 1];
    },
  } as any;
  let policy: WatchdogPolicy = { ...DEFAULTS };
  registerWatchdogTools(
    fakeServer,
    {
      get: () => policy,
      set: (next) => {
        policy = next;
      },
    },
    env,
  );
  const call = async (args: object) => JSON.parse((await handler(args)).content[0].text);
  return { call, current: () => policy };
}

describe("command_watchdog_settings", () => {
  it("reads the current settings without changing them", async () => {
    const { call, current } = setup();
    const result = await call({});
    expect(result.updated).toBe(false);
    expect(result.settings).toMatchObject({
      alertIntervalSec: 30,
      interruptPromptSec: 300,
      interruptGraceSec: 10,
      commandTimeoutSec: 0,
    });
    expect(result.settings.summary).toContain("alerta a cada 30s");
    expect(result.settings.summary).toContain("aos 5min");
    expect(result.settings.summary).toContain("sem limite de tempo");
    expect(current()).toEqual(DEFAULTS);
  });

  it("changes only the given timings", async () => {
    const { call, current } = setup();
    const result = await call({ alertIntervalSec: 10, interruptPromptSec: 30 });
    expect(result.updated).toBe(true);
    expect(result.changed).toEqual(["alertIntervalSec", "interruptPromptSec"]);
    expect(current()).toEqual({ ...DEFAULTS, alertIntervalMs: 10_000, interruptPromptMs: 30_000 });
  });

  it("can set and clear an optional hard ceiling", async () => {
    const { call, current } = setup();
    await call({ commandTimeoutSec: 900 });
    expect(current().hardTimeoutMs).toBe(900_000);
    expect((await call({})).settings.summary).toContain("interrompe sozinho aos 15min");
    await call({ commandTimeoutSec: 0 });
    expect(current().hardTimeoutMs).toBe(0);
  });

  it("reset restores the startup values from the environment", async () => {
    const { call, current } = setup({ KICAD_MCP_INTERRUPT_PROMPT_SEC: "120" });
    await call({ alertIntervalSec: 5, interruptPromptSec: 15 });
    const result = await call({ reset: true });
    expect(result.reset).toBe(true);
    expect(current()).toEqual({ ...DEFAULTS, interruptPromptMs: 120_000 });
  });

  it("applies other arguments on top of a reset", async () => {
    const { call, current } = setup();
    await call({ alertIntervalSec: 5 });
    await call({ reset: true, interruptGraceSec: 3 });
    expect(current()).toEqual({ ...DEFAULTS, interruptGraceMs: 3_000 });
  });

  it("is wired to the server's live policy", async () => {
    const server = new KiCADMcpServer(pythonBridge, "error") as any;
    const tool = server.server._registeredTools["command_watchdog_settings"];
    expect(tool).toBeDefined();
    await tool.handler({ alertIntervalSec: 5, interruptPromptSec: 20 }, {});
    expect(server.watchdogPolicy).toMatchObject({
      alertIntervalMs: 5_000,
      interruptPromptMs: 20_000,
    });
  });
});
