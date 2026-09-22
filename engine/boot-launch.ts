/**
 * Boot's launch half (issue #121): the build staleness decision, the wait a
 * Restart handoff needs, starting the server so it outlives this script, and
 * reading its boot verdict back out of the log.
 *
 * The skill did all of this as a shell fragment. The parts worth testing are
 * the decisions rather than the spawns, so they are separate functions here:
 * whether the build is stale is two timestamps, and what port the server
 * came up on is one line of a log file.
 */

import { openSync, existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Rebuild when there is no build, or when the last commit touching the UI
 * source is newer than the built page. The server serves `ui/dist` from
 * disk, so a fetch that brought new UI work leaves the Console silently
 * running the old surface, which is how the assignment badges and the herdr
 * pane both went missing before.
 */
export function needsRebuild(
  distMtimeMs: number | null,
  srcCommitMs: number | null,
): boolean {
  if (distMtimeMs === null) return true;
  if (srcCommitMs === null) return false;
  return srcCommitMs > distMtimeMs;
}

/** The built page's mtime in milliseconds, or null when there is no build. */
export function distMtime(engineDir: string): number | null {
  const file = join(engineDir, "ui", "dist", "index.html");
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** The last commit touching `ui/src`, in milliseconds, or null when unknown. */
export function uiSourceCommitMs(engineDir: string): number | null {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", engineDir, "log", "-1", "--format=%ct", "--", "ui/src"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return null;
  const seconds = Number(probe.stdout.toString().trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * The port from the server's boot line, `pool server on
 * http://localhost:<port> (<pool>)`. The last line wins, because a relaunch
 * appends to a log the caller has truncated and only this boot's line is of
 * interest.
 */
export function parseBootLine(log: string): number | null {
  const matches = [...log.matchAll(/pool server on http:\/\/localhost:(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  const port = Number(last[1]);
  return Number.isInteger(port) ? port : null;
}

export interface PidRelease {
  released: boolean;
  /** The pid still holding the lock, when one is. */
  pid?: number;
}

export interface PidWaitDeps {
  /** Whether the lock file is still there, and the pid it names. */
  readPid(): number | null;
  /** Whether that process is still alive. */
  isAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
  now(): number;
}

/**
 * The Restart handoff's wait (ADR-0026). The Console stops its own server
 * and starts this script, and the old server releases its pool lock last of
 * all, after stopping its attempts. So Boot waits for `runs/server.pid` to
 * go rather than racing it into the engine's own refusal. A lock file left
 * behind by a server that is already gone counts as released: the engine
 * treats a stale lock the same way, and stopping for it would strand the
 * pool on a file no process owns.
 */
export async function waitForPidRelease(
  deps: PidWaitDeps,
  timeoutMs = 15_000,
): Promise<PidRelease> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    const pid = deps.readPid();
    if (pid === null) return { released: true };
    if (!deps.isAlive(pid)) return { released: true };
    if (deps.now() >= deadline) return { released: false, pid };
    await deps.wait(250);
  }
}

/** The real deps for the wait above, reading the pool's own lock file. */
export function pidWaitDeps(poolDir: string): PidWaitDeps {
  const file = join(poolDir, "runs", "server.pid");
  return {
    readPid: () => {
      if (!existsSync(file)) return null;
      try {
        const pid = Number(readFileSync(file, "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export interface StartedServer {
  pid: number;
  /** Whether the child has exited, which the log poll checks between reads. */
  exited(): boolean;
}

/**
 * Start the pool server detached, with both its streams appended to the
 * pool's log. Detached and unreferenced on purpose: the Console outlives the
 * terminal Boot ran in, which is what makes `agent-console` a launcher
 * rather than a foreground process the operator has to keep a window open
 * for. The pid file is never written here; that file is the engine's pool
 * lock and it claims it itself.
 */
export function startServer(options: {
  engineDir: string;
  poolDir: string;
  port?: number | undefined;
  logPath: string;
}): StartedServer {
  const out = openSync(options.logPath, "a");
  const args = ["run", "engine/server.ts", "--pool", options.poolDir];
  if (options.port !== undefined) args.push("--port", String(options.port));
  const child = spawn("bun", args, {
    cwd: options.engineDir,
    detached: true,
    stdio: ["ignore", out, out],
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  return { pid: child.pid ?? -1, exited: () => exited };
}

export type BootVerdict =
  | { kind: "up"; port: number }
  | { kind: "exited"; tail: string }
  | { kind: "timeout"; tail: string };

/**
 * Poll the log for the boot line. An exit before the line means the engine
 * refused, most often because the pool is already locked or a pinned port is
 * busy, and its own message is the useful thing to show.
 */
export async function waitForBoot(
  logPath: string,
  server: StartedServer,
  timeoutMs = 10_000,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<BootVerdict> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = readIfPresent(logPath);
    const port = parseBootLine(log);
    if (port !== null) return { kind: "up", port };
    if (server.exited()) return { kind: "exited", tail: tailOf(log) };
    if (Date.now() >= deadline) return { kind: "timeout", tail: tailOf(log) };
    await wait(250);
  }
}

/** Poll `/api/state` until the pool answers with a snapshot. */
export async function waitForState(url: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/api/state`);
      if (response.ok) {
        await response.text();
        return true;
      }
    } catch {
      // Not listening yet. The boot line is printed as the server starts, so
      // a short gap before the socket accepts is ordinary rather than a fault.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Open the Console with the platform's opener, and say nothing if it fails. */
export function openBrowser(url: string): boolean {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The last few lines of a log, which is what a failed boot has to say. */
export function tailOf(log: string, lines = 8): string {
  return log.split("\n").filter((line) => line !== "").slice(-lines).join("\n");
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
