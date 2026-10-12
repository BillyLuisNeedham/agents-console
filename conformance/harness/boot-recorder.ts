/**
 * A stand-in for Boot, for the cases that make a server restart itself. A
 * Restart stops the server and runs the shim of the checkout the server's
 * binary sits in, `<checkout>/bin/agent-console`, from that checkout; a real
 * Boot would start a server the case does not own. So the recorder lays out
 * a checkout of its own in the world: a copy of the binary under test at
 * `target/release/agent-console`, for the case to start the server from, and
 * the recorder as its `bin/agent-console`, writing down its argv and working
 * directory and printing one line, which lands in the pool's runs/boot.log.
 * With `boot`, it then runs the copy's `boot` with the same arguments, as the
 * real shim does once nothing is stale, so a case can watch the Boot it hands
 * the pool to; without, it only records. It never builds anything. A decoy
 * `agent-console` first on the server's PATH records too, so a hand-off that
 * went by PATH shows as one. Every other server runs from the runner's guard
 * checkout, laid out the same way, whose shim refuses (`guardCheckout`).
 * The Boot and every server it starts run the checkout's copy, detached, so
 * they outlive the server the case started; `stopStarted` ends them.
 *
 *   const recorder = bootRecorder(world, { boot: true });
 *   const server = await t.start(world, recorder.start);
 *   t.defer(() => recorder.stopStarted(server.pid));
 *   ...
 *   const [call] = await recorder.handOffs(1);
 */

import { chmodSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./pool-files.ts";
import { serverChoice } from "./server.ts";
import type { World } from "./world.ts";

/** One hand-off to Boot. */
export interface BootHandOff {
  /** Which stand-in ran: the checkout's shim, or the decoy found on PATH. */
  ran: "shim" | "path";
  /** The argv after the program's name. */
  argv: string[];
  /** The directory it ran in, symlinks resolved. */
  cwd: string;
}

export interface BootRecorder {
  /** The stand-in checkout, symlinks resolved. */
  checkout: string;
  /** For `t.start`: the server run from the checkout's copy of the binary, the decoy first on its PATH. */
  start: { binary: string; env: Record<string, string> };
  /** Every hand-off so far. */
  calls(): BootHandOff[];
  /** Wait for `n` hand-offs, then half a second more for a stray one, and hand back all of them. */
  handOffs(n: number): Promise<BootHandOff[]>;
  /**
   * Stop every process running from the checkout but `except`, and wait for
   * each to go: the shim and the Boot it execs are killed first, so none
   * starts a server after the sweep, then each server gets SIGTERM, and
   * SIGKILL if it is still up 15 seconds on. The sweep repeats until nothing
   * is left, so a server a killed Boot was starting, before it claimed
   * runs/server.pid, is stopped too.
   */
  stopStarted(except?: number): Promise<void>;
}

/**
 * A stand-in that writes down how it was run, as `ran`, under `record`, then
 * runs `after`, a line of bash.
 */
function standIn(record: string, ran: BootHandOff["ran"], after = ""): string {
  return (
    "#!/usr/bin/env bash\n" +
    `d=${JSON.stringify(record)}\n` +
    'f="$d/$$"\n' +
    `printf '%s' ${ran} > "$f.ran"\n` +
    'pwd -P > "$f.cwd"\n' +
    'printf \'%s\\0\' "$@" > "$f.tmp"\n' +
    'mv "$f.tmp" "$f.argv"\n' +
    'echo "boot recorder: $*"\n' +
    after
  );
}

function writeScript(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** Every call a stand-in wrote down under `record`. */
function recordedCalls(record: string): BootHandOff[] {
  return readdirSync(record)
    .filter((name) => name.endsWith(".argv"))
    .map((name) => {
      const stem = name.slice(0, -".argv".length);
      return {
        ran: readFileSync(join(record, `${stem}.ran`), "utf8") as BootHandOff["ran"],
        argv: readFileSync(join(record, name), "utf8").split("\0").slice(0, -1),
        cwd: readFileSync(join(record, `${stem}.cwd`), "utf8").trimEnd(),
      };
    });
}

/**
 * Lay out a checkout at `dir` as a Restart finds one: a copy of `binary` at
 * `target/release/agent-console`, and as `bin/agent-console` the stand-in
 * `shim` writes for that copy. Answers the copy's path.
 */
function standInCheckout(dir: string, binary: string, shim: (copy: string) => string): string {
  const release = join(dir, "target", "release");
  for (const sub of [join(dir, "bin"), release]) mkdirSync(sub, { recursive: true });
  const copy = join(release, "agent-console");
  copyFileSync(binary, copy, constants.COPYFILE_FICLONE);
  chmodSync(copy, 0o755);
  writeScript(join(dir, "bin", "agent-console"), shim(copy));
  return copy;
}

/** The checkout the runner hands every case its binary from; see `guardCheckout`. */
export interface GuardCheckout {
  /** The copy of the binary, for CONFORMANCE_RUST_BIN. */
  binary: string;
  /** Every Restart that reached the guard: each one a case that started its server from the wrong checkout. */
  calls(): BootHandOff[];
}

/**
 * The checkout every process the suite starts runs its binary from, laid out
 * by the runner (run.ts) under the run's own directory: a Restart runs the
 * shim beside the binary, and this repository's shim rebuilds whatever is
 * stale here with cargo and bun, under a world's HOME and mid-suite. The
 * guard's shim builds and boots nothing: it writes the call down, says why on
 * stderr, which lands in the pool's runs/boot.log, and fails. A case that
 * restarts a server starts it from a `bootRecorder` instead, so a call here
 * is a case to fix, and the runner fails the run on one.
 */
export function guardCheckout(dir: string, binary: string): GuardCheckout {
  const record = join(dir, "boot-calls");
  mkdirSync(record, { recursive: true });
  const refusal =
    "conformance: a Restart reached the suite's guard checkout, which builds and boots nothing; " +
    "start a server a case restarts from bootRecorder(world).start";
  const copy = standInCheckout(dir, binary, () => standIn(record, "shim", `echo ${JSON.stringify(refusal)} >&2\nexit 1\n`));
  return { binary: copy, calls: () => recordedCalls(record) };
}

export interface BootRecorderOptions {
  /** Run the copy's `boot` after recording, so the hand-off starts a real Boot. Default false. */
  boot?: boolean;
}

/** A process running from a stand-in checkout, and whether it is a server rather than its shim or a Boot. */
interface CheckoutProcess {
  pid: number;
  server: boolean;
}

/**
 * Every live process whose argv names a file in `checkout`, by its path or
 * its real path: the shim, run as `bash <checkout>/bin/agent-console`, the
 * Boot it execs as the copy, and each server a Boot starts as its own
 * executable. A zombie's argv is gone, so it does not count.
 */
function runningFrom(checkout: string): CheckoutProcess[] {
  const roots = [...new Set([checkout, realpathSync(checkout)])].map((dir) => `${dir}/`);
  const ps = Bun.spawnSync(["ps", "-axww", "-o", "pid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) throw new Error(`ps failed: ${ps.stderr.toString()}`);
  const found: CheckoutProcess[] = [];
  for (const line of ps.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2]!;
    const root = roots.find((dir) => args.includes(dir));
    if (!root) continue;
    const copy = `${root}target/release/agent-console`;
    found.push({ pid: Number(match[1]), server: args.startsWith(`${copy} server `) });
  }
  return found;
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
}

async function stopRunningFrom(checkout: string, except?: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const left = runningFrom(checkout).filter((proc) => proc.pid !== except);
    if (left.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`processes from ${checkout} outlived their cleanup: ${left.map((proc) => proc.pid).join(", ")}`);
    }
    for (const proc of left) if (!proc.server) signal(proc.pid, "SIGKILL");
    const servers = left.filter((proc) => proc.server).map((proc) => proc.pid);
    for (const pid of servers) signal(pid, "SIGTERM");
    const termDeadline = Date.now() + 15_000;
    const up = () => runningFrom(checkout).filter((proc) => servers.includes(proc.pid));
    while (up().length > 0 && Date.now() < termDeadline) await Bun.sleep(25);
    for (const proc of up()) signal(proc.pid, "SIGKILL");
    await Bun.sleep(100);
  }
}

export function bootRecorder(world: World, options: BootRecorderOptions = {}): BootRecorder {
  const checkout = join(world.root, "boot-checkout");
  const decoy = join(world.root, "boot-bin");
  const record = join(world.root, "boot-calls");
  for (const dir of [decoy, record]) mkdirSync(dir, { recursive: true });
  const binary = standInCheckout(checkout, serverChoice().rustBin, (copy) =>
    standIn(record, "shim", options.boot ? `exec ${JSON.stringify(copy)} boot "$@"\n` : ""),
  );
  writeScript(join(decoy, "agent-console"), standIn(record, "path"));
  const calls = (): BootHandOff[] => recordedCalls(record);
  return {
    checkout: realpathSync(checkout),
    start: { binary, env: { PATH: `${decoy}:${world.env("").PATH}` } },
    calls,
    async handOffs(n) {
      await until(() => calls().length, (got) => got >= n, { what: `${n} Boot hand-off(s)`, ms: 20_000 });
      await Bun.sleep(500);
      return calls();
    },
    stopStarted: (except) => stopRunningFrom(checkout, except),
  };
}
