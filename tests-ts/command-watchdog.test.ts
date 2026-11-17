import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { KiCADMcpServer } from "../src/server.js";
import { toolCallContext, type ToolCallContext } from "../src/tool-context.js";

const pythonBridge = fileURLToPath(new URL("../python/kicad_interface.py", import.meta.url));

afterEach(() => {
  vi.useRealTimers();
});

/** A server wired to a fake worker (no pid, so no real processes are touched). */
function makeServer(opts: { elicitation?: boolean } = {}) {
  const server = new KiCADMcpServer(pythonBridge, "error") as any;
  const stdin = { write: vi.fn() };
  server.pythonProcess = { stdin };
  server.readyDetected = true;
  server.watchdogPolicy = {
    hardTimeoutMs: 0,
    alertIntervalMs: 30_000,
    interruptPromptMs: 300_000,
    interruptGraceMs: 10_000,
  };
  server.server.server.getClientCapabilities = () => (opts.elicitation ? { elicitation: {} } : {});
  return { server, stdin };
}

function call(server: any, ctx: ToolCallContext, command = "run_erc"): Promise<any> {
  const promise = toolCallContext.run(ctx, () => server.callKicadScript(command, {}));
  promise.catch(() => undefined); // asserted explicitly in each test
  return promise;
}

function respond(server: any, stdin: { write: any }, body: object, call = 0): void {
  const sent = JSON.parse(stdin.write.mock.calls[call][0]);
  server.handlePythonResponse(
    Buffer.from(`${JSON.stringify({ ...body, _requestId: sent.requestId })}\n`),
  );
}

const progressMessages = (sendNotification: any): string[] =>
  sendNotification.mock.calls
    .map(([n]: any[]) => n)
    .filter((n: any) => n.method === "notifications/progress")
    .map((n: any) => n.params.message);

describe("long-command watchdog", () => {
  it("has no fixed timeout and alerts every interval while the command runs", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const result = call(server, { toolName: "run_erc", progressToken: "tok", sendNotification });
    expect(stdin.write).toHaveBeenCalledOnce();

    // Well past the old 30 s ceiling: still pending, alerted on every interval.
    await vi.advanceTimersByTimeAsync(90_000);
    const messages = progressMessages(sendNotification);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('"run_erc" em execução há 30s');
    expect(messages[2]).toContain("há 1min30s");
    expect(messages[2]).toContain("opção de interromper em 3min30s");

    // Progress values increase monotonically.
    const values = sendNotification.mock.calls.map(([n]: any[]) => n.params.progress);
    expect(values).toEqual([...values].sort((a: number, b: number) => a - b));

    respond(server, stdin, { success: true, value: 1 });
    await expect(result).resolves.toEqual({ success: true, value: 1 });

    // Settled: the watchdog stops.
    sendNotification.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("asks after 5 min and interrupts when the user chooses to", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer({ elicitation: true });
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ action: "accept", content: { acao: "interromper" } });
    const result = call(server, { toolName: "run_erc", sendRequest });

    await vi.advanceTimersByTimeAsync(299_000);
    expect(sendRequest).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendRequest).toHaveBeenCalledOnce();
    const [request] = sendRequest.mock.calls[0];
    expect(request.method).toBe("elicitation/create");
    expect(request.params.message).toContain('"run_erc" está rodando há 5min');
    expect(request.params.requestedSchema.properties.acao.enum).toEqual([
      "continuar",
      "interromper",
    ]);

    // The killed subprocess makes the Python handler return a failure.
    respond(server, stdin, { success: false, message: "kicad-cli terminated" });
    await expect(result).rejects.toThrow(/interrompido após 5min \(interrompido pelo usuário\)/);
    await expect(result).rejects.toThrow(/preservados/);
    expect(server.currentRequestHandler).toBeNull();
  });

  it("keeps waiting and asks again when the user chooses to continue", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer({ elicitation: true });
    const sendRequest = vi
      .fn()
      .mockResolvedValue({ action: "accept", content: { acao: "continuar" } });
    const result = call(server, { toolName: "run_erc", sendRequest });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sendRequest).toHaveBeenCalledTimes(2);

    respond(server, stdin, { success: true });
    await expect(result).resolves.toEqual({ success: true });
  });

  it("tells clients without elicitation how to cancel, and keeps waiting", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer({ elicitation: false });
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const result = call(server, { toolName: "run_erc", progressToken: 1, sendNotification });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(progressMessages(sendNotification).some((m) => m.includes("não permite"))).toBe(true);

    respond(server, stdin, { success: true });
    await expect(result).resolves.toEqual({ success: true });
  });

  it("interrupts a running command when the client cancels the tool call", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer();
    const controller = new AbortController();
    const result = call(server, { toolName: "run_erc", signal: controller.signal });

    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    respond(server, stdin, { success: false, message: "killed" });
    await expect(result).rejects.toThrow(/cancelado pelo cliente/);
  });

  it("drops a queued command the client cancels before it starts", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer();
    const first = call(server, { toolName: "a" }, "get_board_info");
    const controller = new AbortController();
    const second = call(server, { toolName: "b", signal: controller.signal }, "run_drc");
    expect(server.requestQueue).toHaveLength(1);

    controller.abort();
    await expect(second).rejects.toThrow(/cancelado pelo cliente antes de iniciar/);
    expect(server.requestQueue).toHaveLength(0);

    respond(server, stdin, { success: true });
    await expect(first).resolves.toEqual({ success: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(stdin.write).toHaveBeenCalledOnce(); // run_drc never reached the worker
  });

  it("delivers a result that still succeeded while being interrupted", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer();
    const controller = new AbortController();
    const result = call(server, { toolName: "run_erc", signal: controller.signal });

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    respond(server, stdin, { success: true, done: true });
    await expect(result).resolves.toEqual({ success: true, done: true });
  });

  it("restarts a worker that does not answer after the interrupt", async () => {
    vi.useFakeTimers();
    const { server } = makeServer();
    server.pythonExe = "python";
    server.restartPythonWorker = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const result = call(server, { toolName: "run_erc", signal: controller.signal });

    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).rejects.toThrow(/foi reiniciado/);
    expect(server.restartPythonWorker).toHaveBeenCalledOnce();
    expect(server.currentRequestHandler).toBeNull();
    expect(server.processingRequest).toBe(false);
  });

  it("interrupts at an explicitly configured hard ceiling", async () => {
    vi.useFakeTimers();
    const { server, stdin } = makeServer();
    server.watchdogPolicy.hardTimeoutMs = 60_000;
    const result = call(server, { toolName: "export_gerber" }, "export_gerber");

    await vi.advanceTimersByTimeAsync(60_000);
    respond(server, stdin, { success: false });
    await expect(result).rejects.toThrow(/limite de 1min atingido/);
  });

  it("fails the pending and queued calls when the worker dies", async () => {
    vi.useFakeTimers();
    const { server } = makeServer();
    const running = call(server, { toolName: "a" }, "run_erc");
    const queued = call(server, { toolName: "b" }, "run_drc");

    server.failAllPending("O worker Python terminou inesperadamente (code 1, signal null)");
    await expect(running).rejects.toThrow(/terminou inesperadamente.*"run_erc"/);
    await expect(queued).rejects.toThrow(/"run_drc" não foi executado/);
  });
});
