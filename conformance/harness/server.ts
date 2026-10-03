/**
 * The server under test as a separate process, Bun's or Rust's (ADR-0036),
 * started and stopped the way Boot does it: both streams appended to the
 * pool's `runs/server.log`, ready once that log carries this start's boot
 * line and `/api/state` answers, stopped with SIGTERM.
 *
 * Which server runs is the runner's choice (conformance/run.ts), passed in
 * the environment so every case reads it the same way:
 *
 *   CONFORMANCE_SERVER     bun (the default) or rust
 *   CONFORMANCE_RUST_BIN   the Rust binary; default target/release/agent-console
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

/** This checkout, where `engine/server.ts` and `target/` live. */
export const CHECKOUT = resolve(import.meta.dir, "..", "..");

export type ServerKind = "bun" | "rust";

export interface ServerChoice {
  kind: ServerKind;
  /** The Rust binary, whether or not it exists; null for Bun. */
  rustBin: string | null;
}

/** The server the runner chose, from the environment. */
export function serverChoice(env: Record<string, string | undefined> = process.env): ServerChoice {
  const kind = env.CONFORMANCE_SERVER ?? "bun";
  if (kind !== "bun" && kind !== "rust") {
    throw new Error(`CONFORMANCE_SERVER must be bun or rust, not ${kind}`);
  }
  if (kind === "bun") return { kind, rustBin: null };
  return {
    kind,
    rustBin: resolve(CHECKOUT, env.CONFORMANCE_RUST_BIN ?? join("target", "release", "agent-console")),
  };
}

/** Why the chosen server cannot run at all, or null when it can. */
export function serverMissing(choice: ServerChoice): string | null {
  if (choice.kind === "rust" && !existsSync(choice.rustBin!)) {
    return `the Rust server binary is not built: no file at ${choice.rustBin}`;
  }
  return null;
}

/** The argv that starts the chosen server on a pool and a port. */
export function serverArgv(choice: ServerChoice, pool: string, port: number): string[] {
  const where = ["--pool", pool, "--port", String(port)];
  if (choice.kind === "bun") return [process.execPath, "run", join(CHECKOUT, "engine", "server.ts"), ...where];
  return [choice.rustBin!, "server", ...where];
}

/** The port in a boot line, `pool server on http://localhost:<port> (<pool>)`. */
export function bootLinePort(log: string): number | null {
  const matches = [...log.matchAll(/pool server on http:\/\/localhost:(\d+)/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

/** A port nothing is listening on right now, from the system's own pick. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function portTaken(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(true));
    probe.listen(port, () => probe.close(() => done(false)));
  });
}

export interface StartOptions {
  pool: string;
  env: Record<string, string>;
  choice?: ServerChoice;
  /** How long the boot line and the first `/api/state` may take. */
  readyMs?: number;
}

export interface RunningServer {
  kind: ServerKind;
  port: number;
  /** `http://localhost:<port>`. */
  url: string;
  pid: number;
  logPath: string;
  /** Whether the process has exited. */
  exited(): boolean;
  /** The server log from this start on. */
  log(): string;
  /**
   * SIGTERM, then wait for the exit. Throws unless the process exits 0
   * within `ms` and releases the pool lock (`runs/server.pid`): an orderly
   * stop is part of the contract. A server still alive at the bound is
   * killed before the throw.
   */
  stop(ms?: number): Promise<void>;
  /** SIGKILL with no checks, for a case that means to kill it. */
  kill(): Promise<void>;
}

const POLL_MS = 25;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function tail(text: string, lines = 20): string {
  return text.split("\n").filter((line) => line !== "").slice(-lines).join("\n");
}

async function stateAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/state`);
    await response.arrayBuffer();
    return response.ok;
  } catch {
    // Not listening yet: the boot line goes out as the server starts, so a
    // short gap before the socket accepts is ordinary.
    return false;
  }
}

async function startOnce(options: StartOptions, choice: ServerChoice, port: number): Promise<RunningServer | { busy: true }> {
  const runs = join(options.pool, "runs");
  mkdirSync(runs, { recursive: true });
  const logPath = join(runs, "server.log");
  const from = sizeOf(logPath);
  const out = openSync(logPath, "a");
  const proc = Bun.spawn(serverArgv(choice, options.pool, port), {
    cwd: CHECKOUT,
    env: options.env,
    stdin: "ignore",
    stdout: out,
    stderr: out,
  });
  closeSync(out);
  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
  });
  const log = (): string => {
    try {
      return readFileSync(logPath).subarray(from).toString("utf8");
    } catch {
      return "";
    }
  };
  const exited = (): boolean => exitCode !== null;
  const deadline = Date.now() + (options.readyMs ?? 15_000);
  let booted: number | null = null;
  while (booted === null) {
    booted = bootLinePort(log());
    if (booted !== null) break;
    if (exited()) {
      if (await portTaken(port)) return { busy: true };
      throw new Error(`the ${choice.kind} server exited ${exitCode} before its boot line:\n${tail(log())}`);
    }
    if (Date.now() >= deadline) {
      proc.kill("SIGKILL");
      await proc.exited;
      throw new Error(`the ${choice.kind} server printed no boot line in time:\n${tail(log())}`);
    }
    await Bun.sleep(POLL_MS);
  }
  if (booted !== port) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error(`the ${choice.kind} server was pinned to port ${port} but booted on ${booted}`);
  }
  const url = `http://localhost:${port}`;
  while (!(await stateAnswers(url))) {
    if (exited() || Date.now() >= deadline) {
      proc.kill("SIGKILL");
      await proc.exited;
      throw new Error(`the ${choice.kind} server never answered /api/state:\n${tail(log())}`);
    }
    await Bun.sleep(POLL_MS);
  }
  const lockPath = join(runs, "server.pid");
  return {
    kind: choice.kind,
    port,
    url,
    pid: proc.pid,
    logPath,
    exited,
    log,
    async stop(ms = 15_000) {
      if (!exited()) proc.kill("SIGTERM");
      const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
      if (!stopped) {
        proc.kill("SIGKILL");
        await proc.exited;
        throw new Error(`the ${choice.kind} server was still running ${ms} ms after SIGTERM:\n${tail(log())}`);
      }
      if (exitCode !== 0) {
        throw new Error(`the ${choice.kind} server exited ${exitCode} after SIGTERM, not 0:\n${tail(log())}`);
      }
      if (existsSync(lockPath)) {
        throw new Error(`the ${choice.kind} server stopped without releasing ${lockPath}`);
      }
    },
    async kill() {
      if (!exited()) proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

/**
 * Start the chosen server on a pool and wait until it is ready. The port is
 * a free one, pinned with `--port`; one taken in the gap between the probe
 * and the bind is tried again on another.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const choice = options.choice ?? serverChoice();
  const missing = serverMissing(choice);
  if (missing) throw new Error(missing);
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = await startOnce(options, choice, await freePort());
    if (!("busy" in started)) return started;
  }
  throw new Error("three free ports in a row were taken before the server could bind one");
}
