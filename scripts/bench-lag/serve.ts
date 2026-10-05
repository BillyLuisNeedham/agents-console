/**
 * The lag bench's server process: the pool server of the checkout under test,
 * built the way the engine's suites build it (createPoolServer with a stub
 * harness, a fake herdr socket and a scratch registry) and run alone in its
 * own process, so its event loop and memory are the ones measured.
 *
 *   bun run scripts/bench-lag/serve.ts --repo <checkout> --pool <dir>
 *     --herdr <socket> --script <harness.sh> --release <file> --home <dir>
 *     --modes <json: ticket id -> harness mode>
 *
 * It instruments itself without touching the server: every Bun.spawnSync is
 * timed (the engine's git runs through it, and a sync spawn blocks the loop
 * for its whole run), and a 10 ms interval records how late the loop wakes.
 * The parent asks for both over IPC at the end of the window, and for the
 * window's timeline (issue #161): every late wake, long timer callback,
 * spawn, socket frame in and answer out, on the wall clock, to set beside
 * an answer the proxy timed as slow (timeline.ts).
 */

import { join } from "node:path";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Mark } from "./timeline.ts";
import { answerOf, askOf } from "./wsframes.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`serve.ts: --${name} is required`);
  return value;
}

const repo = arg("repo");
const poolDir = arg("pool");
const herdrSocket = arg("herdr");
const script = arg("script");
const release = arg("release");
const modes = JSON.parse(arg("modes")) as Record<string, string>;

// --- instrumentation -------------------------------------------------------

interface SpawnStat {
  calls: number;
  totalMs: number;
  maxMs: number;
}
const syncSpawns = new Map<string, SpawnStat>();
let asyncSpawns = 0;
let measuring = false;

// The timeline (issue #161): what the server did, on the wall clock the
// proxy and the fake herdr share, so an answer the proxy timed as slow can
// be laid beside it: each socket frame in (and how long its handler ran) and
// each answer out, every late wake of the loop, every timer callback that
// ran long, and every spawn. The parent asks for it over IPC once the window
// is over.

/** A late wake or a long callback worth a mark, in ms. */
const LAG_MARK_MS = 3;
const LONG_CALLBACK_MS = 2;
const marks: Mark[] = [];
function wall(): number {
  return performance.timeOrigin + performance.now();
}
function mark(what: string, at: number, ms: number, detail = ""): void {
  if (measuring) marks.push({ at: Math.round(at * 10) / 10, what, ms: Math.round(ms * 100) / 100, detail });
}

/** "git status", "git diff", ...: the command and, for git, its subcommand. */
function spawnKey(cmd: unknown): string {
  const argv = Array.isArray(cmd)
    ? (cmd as string[])
    : Array.isArray((cmd as { cmd?: unknown })?.cmd)
      ? ((cmd as { cmd: string[] }).cmd)
      : [];
  const bin = argv[0]?.split("/").pop() ?? "?";
  if (bin !== "git") return bin;
  // Skip git's global flags (-C <dir>, -c k=v) to name the subcommand.
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-C" || a === "-c") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) return `git ${a}`;
  }
  return "git";
}

const realSpawnSync = Bun.spawnSync.bind(Bun);
(Bun as unknown as { spawnSync: unknown }).spawnSync = (...args: unknown[]) => {
  const startedAt = wall();
  const t0 = performance.now();
  const out = (realSpawnSync as (...a: unknown[]) => unknown)(...args);
  if (measuring) {
    const ms = performance.now() - t0;
    const key = spawnKey(args[0]);
    mark("spawnSync", startedAt, ms, key);
    const stat = syncSpawns.get(key) ?? { calls: 0, totalMs: 0, maxMs: 0 };
    stat.calls++;
    stat.totalMs += ms;
    stat.maxMs = Math.max(stat.maxMs, ms);
    syncSpawns.set(key, stat);
  }
  return out;
};
const realSpawn = Bun.spawn.bind(Bun);
(Bun as unknown as { spawn: unknown }).spawn = (...args: unknown[]) => {
  if (measuring) asyncSpawns++;
  const startedAt = wall();
  const t0 = performance.now();
  const proc = (realSpawn as (...a: unknown[]) => { exited?: Promise<unknown> })(...args);
  void proc.exited?.then(
    () => mark("spawn", startedAt, performance.now() - t0, spawnKey(args[0])),
    () => {},
  );
  return proc;
};

const LAG_TICK_MS = 10;
const lags: number[] = [];
let lastTick = performance.now();
let lastHeap = process.memoryUsage().heapUsed;
setInterval(() => {
  const now = performance.now();
  const lag = Math.max(0, now - lastTick - LAG_TICK_MS);
  if (measuring) lags.push(lag);
  // A late wake is a stretch the loop was held; the heap shrinking across it
  // says a collection ran in it.
  const heap = process.memoryUsage().heapUsed;
  if (lag >= LAG_MARK_MS) mark("lag", wall() - lag, lag, `heap ${((heap - lastHeap) / 1_048_576).toFixed(1)} MB`);
  lastHeap = heap;
  lastTick = now;
}, LAG_TICK_MS);

/** A callback that marks itself when it runs long, named by its function. */
function timed(kind: string, fn: unknown): unknown {
  if (typeof fn !== "function") return fn;
  const name = fn.name || String(fn).replace(/\s+/g, " ").slice(0, 60);
  return function (this: unknown, ...args: unknown[]) {
    const startedAt = wall();
    const t0 = performance.now();
    try {
      return (fn as (...a: unknown[]) => unknown).apply(this, args);
    } finally {
      const ms = performance.now() - t0;
      if (ms >= LONG_CALLBACK_MS) mark(kind, startedAt, ms, name);
    }
  };
}
// The server's timers, set from here on (the lag tick above keeps the real ones).
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
(globalThis as { setTimeout: unknown }).setTimeout = (fn: unknown, ms?: number, ...rest: unknown[]) =>
  (realSetTimeout as (...a: unknown[]) => unknown)(timed("timer", fn), ms, ...rest);
(globalThis as { setInterval: unknown }).setInterval = (fn: unknown, ms?: number, ...rest: unknown[]) =>
  (realSetInterval as (...a: unknown[]) => unknown)(timed("interval", fn), ms, ...rest);

// The server's socket: every handler bound to its own object, each frame in
// marked with its handler's run, and each answer out marked as it is sent.
const realServe = Bun.serve.bind(Bun);
(Bun as unknown as { serve: unknown }).serve = (options: { websocket?: Record<string, unknown> }) => {
  const handlers = options.websocket;
  if (!handlers) return (realServe as (o: unknown) => unknown)(options);
  const bound: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(handlers)) {
    bound[key] = typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(handlers) : value;
  }
  const open = bound.open as ((ws: unknown) => unknown) | undefined;
  const message = bound.message as (ws: unknown, data: unknown) => unknown;
  bound.open = (ws: { sendText?: (text: string, compress?: boolean) => unknown }) => {
    const sendText = ws.sendText?.bind(ws);
    if (sendText) {
      try {
        ws.sendText = (text: string, compress?: boolean) => {
          const answer = answerOf(text);
          if (answer) mark(`sent ${answer.kind}`, wall(), 0, String(answer.id));
          return sendText(text, compress);
        };
      } catch {
        // A socket that cannot be wrapped: its answers go unmarked.
      }
    }
    return open?.(ws);
  };
  bound.message = (ws: unknown, data: unknown) => {
    const startedAt = wall();
    const t0 = performance.now();
    try {
      return message(ws, data);
    } finally {
      const ask = typeof data === "string" ? askOf(data) : null;
      if (ask) mark(`got ${ask.kind}`, startedAt, performance.now() - t0, String(ask.id));
    }
  };
  return (realServe as (o: unknown) => unknown)({ ...options, websocket: bound });
};

let cpuAtStart = process.cpuUsage();
let wallAtStart = performance.now();

// --- the server ------------------------------------------------------------

type ServerModule = typeof import("../../engine/server.ts");
type HarnessCommand = import("../../engine/engine.ts").HarnessCommand;

const { createPoolServer } = (await import(join(repo, "engine/server.ts"))) as ServerModule;

const bench: HarnessCommand = (ctx) => [
  "bash",
  script,
  modes[ctx.id] ?? "quick",
  ctx.id,
  ctx.outcomePath,
  release,
];
// A Conversation's harness: something that holds its pane open, with no
// harness descriptor so the engine skips the readiness wait (the trick the
// server suite's Conversation routes use). Its Turn state comes from what
// the fake herdr renders in the pane, which the herdr process keeps moving.
const convo: HarnessCommand = () => [
  "bash",
  "-c",
  `while [ ! -e "${release}" ]; do sleep 1; done`,
];

const home = arg("home");
// The built UI's directory: the end-to-end run builds the checkout's UI into
// it first, and the server half copies the checkout's own build in, so the
// responsiveness probe reads the page's stylesheet, the same file the Rust
// server serves (bench-lag.ts startPool): a static read the server answers
// without touching the pool, so its latency is the server's and nothing
// else's. ping.txt is the probe's target when the checkout has no build.
const distDir = join(home, "dist");
mkdirSync(distDir, { recursive: true });
const checkoutDist = join(repo, "ui", "dist");
if (!existsSync(join(distDir, "index.html")) && existsSync(join(checkoutDist, "index.html"))) {
  cpSync(checkoutDist, distDir, { recursive: true });
}
writeFileSync(join(distDir, "ping.txt"), "pong");
const server = createPoolServer({
  poolDir,
  port: 0,
  harnesses: { bench, convo },
  distDir,
  registryPath: join(home, "pools.json"),
  herdrSocket,
  machineDefaultsPaths: {
    file: join(home, "defaults.json"),
    issueRunner: join(home, ".issue-runner"),
    consoleRunner: join(home, ".console-runner"),
  },
});
await server.start();
process.stdout.write(`READY ${server.url}\n`);

const round = (x: number) => Math.round(x * 10) / 10;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

process.on("message", (msg: unknown) => {
  if (msg === "timeline") {
    process.send?.({ kind: "timeline", marks });
    return;
  }
  if (msg === "begin") {
    measuring = true;
    lags.length = 0;
    marks.length = 0;
    syncSpawns.clear();
    asyncSpawns = 0;
    cpuAtStart = process.cpuUsage();
    wallAtStart = performance.now();
    process.send?.({ kind: "begun", rssBytes: process.memoryUsage().rss });
    return;
  }
  if (msg === "report") {
    measuring = false;
    const wallMs = performance.now() - wallAtStart;
    const cpu = process.cpuUsage(cpuAtStart);
    const sorted = [...lags].sort((a, b) => a - b);
    const spawns = [...syncSpawns.entries()]
      .map(([cmd, s]) => ({ cmd, ...s }))
      .sort((a, b) => b.totalMs - a.totalMs);
    process.send?.({
      kind: "report",
      rssBytes: process.memoryUsage().rss,
      cpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
      loopLagMs: {
        samples: sorted.length,
        p50: round(pct(sorted, 50)),
        p95: round(pct(sorted, 95)),
        p99: round(pct(sorted, 99)),
        max: round(sorted.at(-1) ?? 0),
        over50ms: sorted.filter((l) => l > 50).length,
      },
      syncSpawn: {
        calls: spawns.reduce((n, s) => n + s.calls, 0),
        totalMs: spawns.reduce((n, s) => n + s.totalMs, 0),
        blockedPercent: (spawns.reduce((n, s) => n + s.totalMs, 0) / wallMs) * 100,
        byCommand: spawns,
      },
      asyncSpawns,
    });
  }
});
