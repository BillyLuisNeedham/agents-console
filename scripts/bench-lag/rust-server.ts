/**
 * The Rust half of the lag bench's server choice (issue #162, ADR-0036 M5):
 * everything `--server rust` does differently from the Bun pool server that
 * serve.ts builds.
 *
 * The Bun server is built in-process by serve.ts with stub harness commands,
 * a scratch registry and a ping file in its dist directory, and answers the
 * parent's IPC for its event-loop lag and sync spawns. The Rust server is the
 * shipped binary, `<bin> server --pool <dir> --port <n>`, so the bench meets
 * it the way an operator or the conformance suite does:
 *
 * - its harnesses are real binary names. The bench pool's `bench` harness
 *   becomes `claude`, `opencode` and `agent` wrappers first on PATH (of the
 *   server and of the fake herdr, whose panes inherit its environment), each
 *   running one adapter that finds the outcome file the prompt names, as
 *   conformance/fixtures/stub-harness.sh does, and hands it to the pool's own
 *   harness script in the mode the Ticket plays (pool.ts). A launch whose
 *   prompt names no outcome file is a Conversation's: it holds its pane open
 *   until the release file appears;
 * - its herdr is the HERDR_SOCKET_PATH of the environment, its machine files
 *   come from HOME, and its UI is the binary's own (embedded in a release
 *   build, read from ui/dist in a debug one), so the static ping probe is
 *   whichever stylesheet or script the served page names, not a ping.txt;
 * - it has no IPC. The parent's "begin", "report" and "timeline" asks are
 *   answered from the process table: RSS and CPU of the server's pid. What
 *   reads Bun internals (event-loop lag, sync spawns, the server timeline)
 *   has no Rust counterpart, and is reported as null, printed "n/a (rust)".
 *   No gate reads either (gates.ts).
 */

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export type ServerKind = "bun" | "rust";

/** `bun` or `rust`, or null for anything else. */
export function parseServerKind(value: string): ServerKind | null {
  return value === "bun" || value === "rust" ? value : null;
}

/** Where the Rust binary is when `--rust-bin` is not given: the checkout's release build. */
export function defaultRustBin(repo: string): string {
  return join(repo, "target", "release", "agent-console");
}

/** What `--server rust` prints in place of a measure that only Bun has. */
export const NOT_RUST = "n/a (rust)";

// --- the harness the pool's Tickets run -----------------------------------------

/** The binaries a pool's default harnesses launch; each is wrapped. */
const WRAPPED = ["claude", "opencode", "agent"] as const;

/**
 * The adapter every wrapped binary runs, `adapter.sh <the argv the server
 * passed>`. The prompt rides one argument of a batch launch, or arrives typed
 * into the pane of a terminal-backed one (FAKE_HERDR_PANE_INPUT, which the
 * fake herdr sets), and names the outcome file; the file's stem is the Ticket
 * id, whose mode (quick, conflict, live) the modes file lists.
 */
export const ADAPTER = `#!/usr/bin/env bash
set -uo pipefail
outcome=""
read_prompt() {
  case "$1" in
    *"outcome as JSON at "*)
      rest="\${1#*outcome as JSON at }"
      outcome="\${rest%%:*}"
      return 0
      ;;
  esac
  return 1
}
for arg in "$@"; do
  read_prompt "$arg" && break
done
input="\${FAKE_HERDR_PANE_INPUT:-}"
if [ -z "$outcome" ] && [ -n "$input" ]; then
  give_up=$(( SECONDS + 15 ))
  while [ "$SECONDS" -lt "$give_up" ] && [ -d "$BENCH_ROOT" ]; do
    if [ -f "$input" ] && read_prompt "$(cat "$input")"; then
      break
    fi
    sleep 0.1
  done
fi
if [ -z "$outcome" ]; then
  # A Conversation's launch: hold the pane until the bench ends, which
  # removes its root and so releases it too.
  while [ ! -e "$BENCH_RELEASE" ] && [ -d "$BENCH_ROOT" ]; do
    sleep 1
  done
  exit 0
fi
id="$(basename "$outcome" .outcome.json)"
mode="$(awk -v id="$id" '$1 == id { print $2 }' "$BENCH_MODES")"
exec bash "$BENCH_HARNESS" "\${mode:-quick}" "$id" "$outcome" "$BENCH_RELEASE"
`;

/** The modes file's content: one `<ticket id> <mode>` line per Ticket. */
export function modesFile(modes: Record<string, string>): string {
  return Object.entries(modes)
    .map(([id, mode]) => `${id} ${mode}\n`)
    .join("");
}

/** One wrapper: the adapter under the bench's own variables. */
export function wrapperScript(root: string, adapterPath: string, harnessScript: string, release: string): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/usr/bin/env bash",
    `export BENCH_ROOT=${quote(root)}`,
    `export BENCH_MODES=${quote(join(root, "bench-modes.txt"))}`,
    `export BENCH_HARNESS=${quote(harnessScript)}`,
    `export BENCH_RELEASE=${quote(release)}`,
    `exec bash ${quote(adapterPath)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Write the wrappers, the adapter and the modes file under `<root>/bin` and
 * `<root>`, and return the directory to put first on PATH.
 */
export function installHarnesses(
  root: string,
  harnessScript: string,
  release: string,
  modes: Record<string, string>,
): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const adapterPath = join(bin, "adapter.sh");
  writeFileSync(adapterPath, ADAPTER, { mode: 0o755 });
  writeFileSync(join(root, "bench-modes.txt"), modesFile(modes));
  for (const name of WRAPPED) {
    const path = join(bin, name);
    writeFileSync(path, wrapperScript(root, adapterPath, harnessScript, release));
    chmodSync(path, 0o755);
  }
  return bin;
}

// --- the process table ---------------------------------------------------------

export interface ProcessSample {
  rssBytes: number;
  /** CPU seconds the process has used, user and system. */
  cpuSeconds: number;
}

/** `utime + stime` in ticks from a /proc/<pid>/stat line, or null when it does not parse. */
export function cpuTicksFromStat(stat: string): number | null {
  // The command name is parenthesised and may hold spaces and parentheses;
  // the fields that matter follow its last one, from the state (field 3) on.
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
}

/** Seconds from `ps -o cputime=`: `[[dd-]hh:]mm:ss[.cc]`. Null when it does not parse. */
export function cpuSecondsFromPs(text: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

let clockTicks: number | null = null;
function ticksPerSecond(): number {
  if (clockTicks === null) {
    const run = Bun.spawnSync(["getconf", "CLK_TCK"], { stdout: "pipe", stderr: "pipe" });
    const value = Number(run.stdout.toString().trim());
    clockTicks = run.exitCode === 0 && value > 0 ? value : 100;
  }
  return clockTicks;
}

/** RSS and CPU of a process: /proc where there is one, `ps` elsewhere. Null when it is gone. */
export function sampleProcess(pid: number): ProcessSample | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = cpuTicksFromStat(stat);
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (ticks !== null && rss) return { rssBytes: Number(rss[1]) * 1024, cpuSeconds: ticks / ticksPerSecond() };
  } catch {
    // No /proc (macOS), or the process is gone: ask ps.
  }
  const run = Bun.spawnSync(["ps", "-o", "rss=,cputime=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) return null;
  const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(run.stdout.toString());
  const cpu = match ? cpuSecondsFromPs(match[2]!) : null;
  return match && cpu !== null ? { rssBytes: Number(match[1]) * 1024, cpuSeconds: cpu } : null;
}

// --- the server ----------------------------------------------------------------

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

/** The port in a boot line, `pool server on http://localhost:<port> (<pool>)`. */
export function bootLinePort(log: string): number | null {
  const last = [...log.matchAll(/pool server on http:\/\/localhost:(\d+)/g)].at(-1);
  return last ? Number(last[1]) : null;
}

/**
 * A static asset of the served page to time the server with: the first
 * stylesheet it links, else the first script. The Bun server answers its own
 * ping.txt; the Rust server's UI is the binary's, so the probe reads one of
 * the files that UI is made of. Null when the page names neither.
 */
export function pingPathOf(html: string): string | null {
  const css = /<link[^>]*\bhref="([^"]+\.css)"/.exec(html) ?? /<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/.exec(html);
  const script = /<script[^>]*\bsrc="([^"]+)"/.exec(html);
  const found = css?.[1] ?? script?.[1];
  if (!found) return null;
  return new URL(found, "http://localhost/").pathname;
}

/** The handle bench-lag.ts drives a server through, Bun's (IPC) or Rust's (the process table). */
export interface ServerHandle {
  proc: Bun.Subprocess;
  ready: string;
  ask: (msg: unknown, kind: string) => Promise<any>;
  /** The path of a static file to ping; Bun's is /ping.txt. */
  pingPath: string;
}

function tailOf(text: string, lines = 20): string {
  return text.split("\n").filter((line) => line !== "").slice(-lines).join("\n");
}

export interface RustServerOptions {
  bin: string;
  cwd: string;
  poolDir: string;
  logPath: string;
  env: Record<string, string>;
  readyMs?: number;
}

/**
 * Start `<bin> server --pool <dir> --port <n>` with both streams in a log,
 * ready once the log carries its boot line and `/api/state` answers.
 */
export async function startRustServer(options: RustServerOptions): Promise<ServerHandle> {
  const port = await freePort();
  const out = openSync(options.logPath, "a");
  const proc = Bun.spawn([options.bin, "server", "--pool", options.poolDir, "--port", String(port)], {
    cwd: options.cwd,
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
  const log = () => (existsSync(options.logPath) ? readFileSync(options.logPath, "utf8") : "");
  const fail = (what: string): never => {
    proc.kill("SIGKILL");
    throw new Error(`the Rust server ${what}:\n${tailOf(log())}`);
  };
  const deadline = Date.now() + (options.readyMs ?? 30_000);
  for (;;) {
    if (bootLinePort(log()) === port) break;
    if (exitCode !== null) fail(`exited ${exitCode} before its boot line`);
    if (Date.now() > deadline) fail("printed no boot line in time");
    await Bun.sleep(50);
  }
  const base = `http://localhost:${port}`;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/state`);
      await res.arrayBuffer();
      if (res.ok) break;
    } catch {
      // Not accepting yet: the boot line goes out as the server starts.
    }
    if (exitCode !== null) fail(`exited ${exitCode} before /api/state answered`);
    if (Date.now() > deadline) fail("never answered /api/state");
    await Bun.sleep(50);
  }

  let pingPath = "/ping.txt";
  try {
    pingPath = pingPathOf(await (await fetch(`${base}/`)).text()) ?? pingPath;
  } catch {
    // The page is not served: the probe keeps its default and reports its failures.
  }

  const sampleOrZero = () => sampleProcess(proc.pid) ?? { rssBytes: 0, cpuSeconds: 0 };
  let cpuAtStart = sampleOrZero().cpuSeconds;
  let wallAtStart = performance.now();
  const ask = async (msg: unknown, kind: string): Promise<any> => {
    if (msg === "begin") {
      const now = sampleOrZero();
      cpuAtStart = now.cpuSeconds;
      wallAtStart = performance.now();
      return { kind, rssBytes: now.rssBytes };
    }
    if (msg === "report") {
      const now = sampleOrZero();
      const wallS = (performance.now() - wallAtStart) / 1000;
      return {
        kind,
        rssBytes: now.rssBytes,
        cpuPercent: wallS > 0 ? ((now.cpuSeconds - cpuAtStart) / wallS) * 100 : 0,
        loopLagMs: null,
        syncSpawn: null,
        asyncSpawns: null,
      };
    }
    if (msg === "timeline") return { kind, marks: [] };
    throw new Error(`the Rust server takes no ${JSON.stringify(msg)} ask`);
  };
  return { proc, ready: base, ask, pingPath };
}
