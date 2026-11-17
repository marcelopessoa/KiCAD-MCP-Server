import { describe, it, expect } from "vitest";
import {
  DEFAULT_ALERT_INTERVAL_MS,
  DEFAULT_INTERRUPT_GRACE_MS,
  DEFAULT_INTERRUPT_PROMPT_MS,
  formatElapsed,
  loadWatchdogPolicy,
} from "../src/command-timeout.js";

describe("loadWatchdogPolicy", () => {
  it("has no fixed timeout by default", () => {
    // The old 30 s ceiling failed commands that were still progressing on a
    // slow machine while the worker kept running them anyway.
    const policy = loadWatchdogPolicy({});
    expect(policy.hardTimeoutMs).toBe(0);
  });

  it("alerts every 30 s and offers to interrupt after 5 min by default", () => {
    expect(DEFAULT_ALERT_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_INTERRUPT_PROMPT_MS).toBe(300_000);
    expect(loadWatchdogPolicy({})).toEqual({
      hardTimeoutMs: 0,
      alertIntervalMs: DEFAULT_ALERT_INTERVAL_MS,
      interruptPromptMs: DEFAULT_INTERRUPT_PROMPT_MS,
      interruptGraceMs: DEFAULT_INTERRUPT_GRACE_MS,
    });
  });

  it("reads every knob from the environment in seconds", () => {
    expect(
      loadWatchdogPolicy({
        KICAD_MCP_COMMAND_TIMEOUT_SEC: "900",
        KICAD_MCP_ALERT_INTERVAL_SEC: "10",
        KICAD_MCP_INTERRUPT_PROMPT_SEC: "120",
        KICAD_MCP_INTERRUPT_GRACE_SEC: "2.5",
      }),
    ).toEqual({
      hardTimeoutMs: 900_000,
      alertIntervalMs: 10_000,
      interruptPromptMs: 120_000,
      interruptGraceMs: 2_500,
    });
  });

  it("treats 0 as disabled", () => {
    const policy = loadWatchdogPolicy({
      KICAD_MCP_ALERT_INTERVAL_SEC: "0",
      KICAD_MCP_INTERRUPT_PROMPT_SEC: "0",
    });
    expect(policy.alertIntervalMs).toBe(0);
    expect(policy.interruptPromptMs).toBe(0);
  });

  it("falls back to the defaults for empty, negative or nonsense values", () => {
    for (const bad of ["", "  ", "-5", "abc", "NaN", "Infinity"]) {
      expect(
        loadWatchdogPolicy({
          KICAD_MCP_COMMAND_TIMEOUT_SEC: bad,
          KICAD_MCP_INTERRUPT_PROMPT_SEC: bad,
        }),
      ).toMatchObject({ hardTimeoutMs: 0, interruptPromptMs: DEFAULT_INTERRUPT_PROMPT_MS });
    }
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(125_000)).toBe("2min05s");
    expect(formatElapsed(300_000)).toBe("5min");
    expect(formatElapsed(3_780_000)).toBe("1h03min");
  });

  it("never goes negative", () => {
    expect(formatElapsed(-1_000)).toBe("0s");
  });
});
