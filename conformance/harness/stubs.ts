/**
 * The stub harnesses a server under test launches as `claude`, `opencode`
 * and `agent` (Cursor's binary): wrappers first on the world's PATH, each
 * running conformance/fixtures/stub-harness.sh under its own name. A case
 * scripts what a launch does before the server starts it, and reads back
 * every launch the server made, argv, working directory and environment
 * included: "the harness processes started" is one of the things a
 * conformance case may observe (ADR-0036).
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stubStep, type StubBehaviour } from "../fixtures/pool-fixture.ts";

/** The binaries a pool's default harnesses run, each stubbed. */
export const STUBBED_BINARIES = ["claude", "opencode", "agent"] as const;

const SCRIPT = join(import.meta.dir, "..", "fixtures", "stub-harness.sh");

/** A launch's behaviour: the in-process stub's (pool-fixture.ts), plus what
 *  it prints and the Ticket file it misbehaves on. */
export interface ConformanceStubBehaviour extends StubBehaviour {
  /** Standard output, per launch when an array (the last repeats). */
  stdout?: string | string[];
  /**
   * Bash the launch runs in its working directory, its own process, before
   * its stdout, marker and outcome steps, per launch when an array (the last
   * repeats): the work an agent does, a commit in its worktree or the
   * commits a resolver makes, say. It sees STUB_KEY, STUB_N, STUB_ISSUE and
   * STUB_OUTCOME, and may write the outcome itself; a script that fails
   * ends the launch with exit 97 and no outcome.
   */
  run?: string | string[];
  /**
   * Seconds each launch keeps running before it exits, as a TUI holds its
   * pane: a terminal-backed launch whose stub exits at once ends its pane.
   */
  hold?: number;
}

/** One launch the server made, as the stub recorded it. */
export interface StubCall {
  /** Its key: the outcome file's stem, or `_<harness>` when it named none. */
  key: string;
  /** Which launch of that key, from 1. */
  n: number;
  /** Its place among every launch in the world, from 1. */
  seq: number;
  /** The binary name it was launched as. */
  harness: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The Ticket file its prompt names, or "" when it names none. */
  issue: string;
  /** The outcome file its prompt names, or "" when it names none. */
  outcome: string;
}

export interface Stubs {
  /** The wrappers' directory, first on the world's PATH. */
  bin: string;
  /** CONFORMANCE_STUBS: the scripts and the record of launches. */
  dir: string;
  /** Script every launch of `key` (a Ticket id, `01.attempt-2`, `01-grader-1`, `02.resolver`), replacing any script it had. */
  script(key: string, behaviour: ConformanceStubBehaviour): void;
  /**
   * Script `key` as `behaviour`, but hold each launch open, before it does
   * anything but record itself, until the case releases it. Unlike
   * `waitFor`, which gives up after ten seconds, a held launch outlives any
   * number of server restarts, and a server that stops meanwhile finds it
   * has written nothing. A release lets every launch held at that moment go on.
   */
  hold(key: string, behaviour?: ConformanceStubBehaviour): StubHold;
  /** Every launch so far, in launch order. */
  calls(): StubCall[];
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readCall(dir: string, name: string): StubCall | null {
  const match = /^(.+)\.(\d+)$/.exec(name);
  if (!match) return null;
  const path = join(dir, name);
  // A launch still writing its record has no env file yet.
  if (!existsSync(join(path, "env"))) return null;
  const [harness = "", ...argv] = readText(join(path, "argv")).split("\0").slice(0, -1);
  const env: Record<string, string> = {};
  for (const entry of readText(join(path, "env")).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return {
    key: match[1]!,
    n: Number(match[2]),
    seq: Number(readText(join(path, "seq"))),
    harness,
    argv,
    cwd: readText(join(path, "cwd")),
    env,
    issue: readText(join(path, "issue")),
    outcome: readText(join(path, "outcome")),
  };
}

/** A held stub launch (Stubs.hold). */
export interface StubHold {
  /** Let the held launches go on; waits up to `ms` for one to be held. */
  release(ms?: number): Promise<void>;
}

/** Write the wrappers into `<root>/bin` and make `<root>/stubs`. */
export function installStubs(root: string): Stubs {
  const bin = join(root, "bin");
  const dir = join(root, "stubs");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "calls"), { recursive: true });
  for (const name of STUBBED_BINARIES) {
    const wrapper = join(bin, name);
    writeFileSync(wrapper, `#!/usr/bin/env bash\nexec bash ${JSON.stringify(SCRIPT)} ${name} "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
  return {
    bin,
    dir,
    script(key, behaviour) {
      const steps = Math.max(
        behaviour.statuses?.length ?? 1,
        behaviour.exitCodes?.length ?? 1,
        Array.isArray(behaviour.stdout) ? behaviour.stdout.length : 1,
        Array.isArray(behaviour.run) ? behaviour.run.length : 1,
      );
      const scriptDir = join(dir, "scripts", key);
      // A key scripted again is scripted afresh: no step of the old script stays.
      rmSync(scriptDir, { recursive: true, force: true });
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(join(scriptDir, "steps"), `${steps}\n`);
      if (behaviour.waitFor) writeFileSync(join(scriptDir, "wait"), behaviour.waitFor);
      for (let k = 1; k <= steps; k++) {
        const step = stubStep(key, behaviour, k - 1, null);
        writeFileSync(join(scriptDir, `${k}.exit`), `${step.exitCode}\n`);
        if (step.outcome !== "") writeFileSync(join(scriptDir, `${k}.outcome`), step.outcome);
        if (step.status === "ready" || step.status === "marker-done") {
          writeFileSync(join(scriptDir, `${k}.marker`), step.status.replace(/^marker-/, ""));
        }
        const stdout = Array.isArray(behaviour.stdout)
          ? behaviour.stdout[Math.min(k - 1, behaviour.stdout.length - 1)]
          : behaviour.stdout;
        if (stdout !== undefined) writeFileSync(join(scriptDir, `${k}.stdout`), stdout);
        const run = Array.isArray(behaviour.run)
          ? behaviour.run[Math.min(k - 1, behaviour.run.length - 1)]
          : behaviour.run;
        if (run !== undefined) writeFileSync(join(scriptDir, `${k}.sh`), `set -euo pipefail\n${run}\n`);
        if (behaviour.hold !== undefined) writeFileSync(join(scriptDir, `${k}.hold`), `${behaviour.hold}\n`);
      }
    },
    hold(key, behaviour = {}) {
      this.script(key, behaviour);
      const fifo = join(dir, "scripts", key, "hold");
      const made = Bun.spawnSync(["mkfifo", fifo], { stderr: "pipe" });
      if (made.exitCode !== 0) throw new Error(`mkfifo ${fifo} failed: ${made.stderr.toString()}`);
      return {
        async release(ms = 10_000) {
          // Opening a FIFO to write blocks until a reader opens it, so the
          // write runs in a process of its own, bounded.
          const writer = Bun.spawn(["sh", "-c", 'echo release > "$0"', fifo]);
          const written = await Promise.race([writer.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
          if (!written) {
            writer.kill();
            throw new Error(`no launch of ${key} was waiting to be released within ${ms} ms`);
          }
        },
      };
    },
    calls() {
      const callsDir = join(dir, "calls");
      return readdirSync(callsDir)
        .map((name) => readCall(callsDir, name))
        .filter((call): call is StubCall => call !== null)
        .sort((a, b) => a.seq - b.seq);
    },
  };
}
