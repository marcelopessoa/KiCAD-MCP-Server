/**
 * Kill the descendants of a process (POSIX), leaving the process itself alive.
 *
 * Used to interrupt a long command: killing kicad-cli / Freerouting / the
 * zone-fill subprocess makes the Python handler that spawned it return, so the
 * worker — and the board it holds in memory — survives.
 */

import { execFile } from "node:child_process";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every descendant PID of `rootPid` (children first). Empty on Windows or if `ps` fails. */
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") return [];

  const stdout = await new Promise<string>((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 5_000 }, (error, out) =>
      resolve(error ? "" : out),
    );
  });

  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }

  const result: number[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const child of children.get(parent) ?? []) {
      result.push(child);
      pending.push(child);
    }
  }
  return result;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM every descendant of `rootPid`, then SIGKILL whatever is still alive
 * after `termGraceMs`. Returns the PIDs that were signalled.
 */
export async function killDescendants(rootPid: number, termGraceMs = 3_000): Promise<number[]> {
  const pids = await listDescendantPids(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (pids.length > 0) {
    const deadline = Date.now() + termGraceMs;
    while (Date.now() < deadline && pids.some(isAlive)) await sleep(200);
    for (const pid of pids.filter(isAlive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  return pids;
}
