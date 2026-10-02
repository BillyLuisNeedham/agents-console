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
 * The parent asks for both over IPC at the end of the window.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

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
  const t0 = performance.now();
  const out = (realSpawnSync as (...a: unknown[]) => unknown)(...args);
  if (measuring) {
    const ms = performance.now() - t0;
    const key = spawnKey(args[0]);
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
  return (realSpawn as (...a: unknown[]) => unknown)(...args);
};

const LAG_TICK_MS = 10;
const lags: number[] = [];
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  if (measuring) lags.push(Math.max(0, now - lastTick - LAG_TICK_MS));
  lastTick = now;
}, LAG_TICK_MS);

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
// The built UI's directory holds one file, the responsiveness probe's
// target: a static read the server answers without touching the pool, so its
// latency is the event loop's and nothing else's.
const distDir = join(home, "dist");
mkdirSync(distDir, { recursive: true });
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
  if (msg === "begin") {
    measuring = true;
    lags.length = 0;
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
