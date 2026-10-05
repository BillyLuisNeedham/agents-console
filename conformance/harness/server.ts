/**
 * The server under test as a separate process (ADR-0036), started and
 * stopped the way Boot does it: both streams appended to the pool's
 * `runs/server.log`, ready once that log carries this start's boot line and
 * `/api/state` answers, stopped with SIGTERM.
 *
 * The server is the Rust binary. The Bun server was removed at the flip, so
 * `bun` is refused wherever a server is named. The runner
 * (conformance/run.ts) passes its choice in the environment so every case
 * reads it the same way:
 *
 *   CONFORMANCE_SERVER     rust (the default)
 *   CONFORMANCE_RUST_BIN   the Rust binary; default target/release/agent-console
 *   CONFORMANCE_LEGS       the servers a takeover case's legs run, in order,
 *                          comma-separated (rust,rust,rust); default three legs
 *                          of CONFORMANCE_SERVER's
 */

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

/** This checkout, where `target/` lives. */
export const CHECKOUT = resolve(import.meta.dir, "..", "..");

export type ServerKind = "rust";

export interface ServerChoice {
  kind: ServerKind;
  /** The Rust binary, whether or not it exists. */
  rustBin: string;
}

/** What naming the Bun server answers now. */
export const BUN_REMOVED = "the Bun server was removed at the flip (ADR-0036): only rust runs";

function choiceOf(kind: string, variable: string, env: Record<string, string | undefined>): ServerChoice {
  if (kind === "bun") throw new Error(`${variable}: ${BUN_REMOVED}`);
  if (kind !== "rust") throw new Error(`${variable} must name rust, not ${kind}`);
  return {
    kind,
    rustBin: resolve(CHECKOUT, env.CONFORMANCE_RUST_BIN ?? join("target", "release", "agent-console")),
  };
}

/** The server the runner chose, from the environment. */
export function serverChoice(env: Record<string, string | undefined> = process.env): ServerChoice {
  return choiceOf(env.CONFORMANCE_SERVER ?? "rust", "CONFORMANCE_SERVER", env);
}

/** How many legs a takeover case runs when CONFORMANCE_LEGS is not set:
 *  a pool handed over twice. */
export const DEFAULT_LEG_COUNT = 3;

/**
 * The servers a takeover case's legs run, in order: CONFORMANCE_LEGS when
 * it is set, else DEFAULT_LEG_COUNT legs of the run's own server. A
 * takeover needs a server to hand over to, so fewer than two legs is an
 * error.
 */
export function serverLegs(env: Record<string, string | undefined> = process.env): ServerChoice[] {
  const named = env.CONFORMANCE_LEGS?.trim();
  const legs = named
    ? named.split(",").map((kind) => choiceOf(kind.trim(), "CONFORMANCE_LEGS", env))
    : Array.from({ length: DEFAULT_LEG_COUNT }, () => serverChoice(env));
  if (legs.length < 2) {
    throw new Error(`CONFORMANCE_LEGS must name at least two legs, not ${legs.length}: ${named}`);
  }
  return legs;
}

/** Why the chosen server cannot run at all, or null when it can. */
export function serverMissing(choice: ServerChoice): string | null {
  if (!existsSync(choice.rustBin)) {
    return `the Rust server binary is not built: no file at ${choice.rustBin}`;
  }
  return null;
}

/** Why one of a takeover case's legs cannot run at all, or null when all can. */
export function legsMissing(legs: ServerChoice[]): string | null {
  for (const [i, leg] of legs.entries()) {
    const missing = serverMissing(leg);
    if (missing) return `leg ${i + 1} of ${legs.map((choice) => choice.kind).join(",")} cannot run: ${missing}`;
  }
  return null;
}

/** The subcommands of the one binary (ADR-0036). */
export type Command = "server" | "steward" | "boot" | "fleet";

/** The argv that runs one of the binary's commands with the given arguments: `<binary> <command>`. */
export function commandArgv(choice: ServerChoice, command: Command, args: string[] = []): string[] {
  return [choice.rustBin, command, ...args];
}

/**
 * The argv that starts the chosen server on a pool with exactly the given
 * further arguments: no `--port` is added, so a case can leave the port to
 * console.json or the default hunt, or pass its own.
 */
export function serverArgvAsGiven(choice: ServerChoice, pool: string, args: string[] = []): string[] {
  return commandArgv(choice, "server", ["--pool", pool, ...args]);
}

/** The argv that starts the chosen server on a pool and a port. */
export function serverArgv(choice: ServerChoice, pool: string, port: number): string[] {
  return serverArgvAsGiven(choice, pool, ["--port", String(port)]);
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

/** Whether something on this machine listens on `port` now. */
export async function portTaken(port: number): Promise<boolean> {
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
  /** The exit code once the process has exited on its own; null while it runs. */
  exitCode(): number | null;
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

/**
 * The orderly stop both kinds of server process share: SIGTERM unless it
 * has exited already, then exit 0 within `ms` and the pool lock released.
 * One still alive at the bound is killed before the throw; `context` is what
 * a failure shows of its output.
 */
async function stopInOrder(
  proc: { kill(signal: NodeJS.Signals): void; readonly exitCode: number | null },
  exited: Promise<number>,
  stop: { kind: ServerKind; ms: number; lockPath: string; context: () => string },
): Promise<void> {
  if (proc.exitCode === null) proc.kill("SIGTERM");
  const code = await Promise.race([exited, Bun.sleep(stop.ms).then(() => null)]);
  if (code === null) {
    proc.kill("SIGKILL");
    await exited;
    throw new Error(`the ${stop.kind} server was still running ${stop.ms} ms after SIGTERM:\n${stop.context()}`);
  }
  if (code !== 0) throw new Error(`the ${stop.kind} server exited ${code} after SIGTERM, not 0:\n${stop.context()}`);
  if (existsSync(stop.lockPath)) throw new Error(`the ${stop.kind} server stopped without releasing ${stop.lockPath}`);
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
    exitCode: () => exitCode,
    log,
    stop: (ms = 15_000) =>
      stopInOrder(proc, proc.exited, { kind: choice.kind, ms, lockPath, context: () => tail(log()) }),
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

export interface LaunchOptions {
  pool: string;
  env: Record<string, string>;
  choice?: ServerChoice;
  /** Everything after `--pool <dir>`, `--port` included when the case wants one. */
  args?: string[];
}

/**
 * A server process a case launches by hand, for the server's own lifecycle:
 * a launch that must fail (a held lock, a busy pin), one on a port it picks
 * itself, two at once. Its streams are kept apart in memory, since the
 * contract says which one a refusal or a farewell line goes to; nothing is
 * waited for until the case asks.
 */
export interface LaunchedServer {
  kind: ServerKind;
  pid: number;
  /** Standard output so far. */
  stdout(): string;
  /** Standard error so far. */
  stderr(): string;
  /** The exit code once the process has exited; null while it runs. */
  exitCode(): number | null;
  /** Resolves with the exit code. */
  exited: Promise<number>;
  /**
   * Wait for the boot line on stdout and for `/api/state` to answer on the
   * port it names, and hand back that port. Throws when the process exits
   * first or `ms` passes.
   */
  booted(ms?: number): Promise<number>;
  /** SIGTERM, then require exit 0 within `ms` and `runs/server.pid` gone. */
  stop(ms?: number): Promise<void>;
  /**
   * Wait for a launch that must fail to exit, and hand back its exit code
   * and both streams; one still running after `ms` is killed and throws.
   */
  refused(ms?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /** SIGKILL with no checks. */
  kill(): Promise<void>;
}

export function launchServer(options: LaunchOptions): LaunchedServer {
  const choice = options.choice ?? serverChoice();
  const missing = serverMissing(choice);
  if (missing) throw new Error(missing);
  const proc = Bun.spawn(serverArgvAsGiven(choice, options.pool, options.args), {
    cwd: CHECKOUT,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  const drain = async (stream: ReadableStream<Uint8Array>, add: (text: string) => void): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) add(decoder.decode(chunk, { stream: true }));
  };
  const drained = Promise.all([
    drain(proc.stdout, (text) => (out += text)),
    drain(proc.stderr, (text) => (err += text)),
  ]);
  let code: number | null = null;
  // The streams are read to their end before the exit counts, so a case that
  // saw the exit also sees the last line the process wrote.
  const exited = proc.exited.then(async (exit) => {
    await drained;
    code = exit;
    return exit;
  });
  const both = (): string => tail(`${out}\n${err}`);
  const lockPath = join(options.pool, "runs", "server.pid");
  return {
    kind: choice.kind,
    pid: proc.pid,
    stdout: () => out,
    stderr: () => err,
    exitCode: () => code,
    exited,
    async booted(ms = 15_000) {
      const deadline = Date.now() + ms;
      let port: number | null = null;
      while (port === null) {
        port = bootLinePort(out);
        if (port !== null) break;
        if (code !== null) throw new Error(`the ${choice.kind} server exited ${code} before its boot line:\n${both()}`);
        if (Date.now() >= deadline) throw new Error(`the ${choice.kind} server printed no boot line in time:\n${both()}`);
        await Bun.sleep(POLL_MS);
      }
      const url = `http://localhost:${port}`;
      while (!(await stateAnswers(url))) {
        if (code !== null || Date.now() >= deadline) {
          throw new Error(`the ${choice.kind} server never answered /api/state on ${port}:\n${both()}`);
        }
        await Bun.sleep(POLL_MS);
      }
      return port;
    },
    stop: (ms = 15_000) => stopInOrder(proc, exited, { kind: choice.kind, ms, lockPath, context: both }),
    async refused(ms = 20_000) {
      const exit = await Promise.race([exited, Bun.sleep(ms).then(() => null)]);
      if (exit === null) {
        proc.kill("SIGKILL");
        await exited;
        throw new Error(`the ${choice.kind} server was still running ${ms} ms after a launch it should have refused:\n${both()}`);
      }
      return { code: exit, stdout: out, stderr: err };
    },
    async kill() {
      if (code === null) proc.kill("SIGKILL");
      await exited;
    },
  };
}
