#!/usr/bin/env bun
/**
 * The lag bench (issue #157): a repeatable yardstick for how sluggish the
 * Console feels, so a fix can be measured against the code it replaced.
 *
 *   bun run scripts/bench-lag.ts [--repo <checkout>] [--out <file.json>]
 *       [--duration <s>] [--tabs <n>] [--rtt <ms>] [--ui-duration <s>] [--skip-ui] [--skip-server]
 *
 * `--repo` points it at any checkout of this repository (default: the one
 * this script lives in) whose root and ui/ have had `bun install`: the
 * server, the fake herdr and the UI modules measured are that checkout's,
 * while the pool, the load and the measuring stay this script's, so two
 * checkouts are compared on the same yardstick.
 *
 * The server half builds a throwaway pool (scripts/bench-lag/pool.ts), runs
 * the checkout's pool server in a process of its own against the checkout's
 * executing fake herdr in another, lets the engine work the pool into a
 * realistic state (a merge queue standing, four Tickets in progress, some
 * blocked, three Conversations whose panes keep moving), then opens N
 * simulated Console tabs (scripts/bench-lag/load.ts) and measures for the
 * window: the server's responsiveness to a trivial GET every 25 ms, the
 * operator's card clicks and Open in herdr through a tab's six connections,
 * the snapshot rate and size, the server's RSS, CPU, event-loop lag and time
 * blocked in synchronous spawns.
 *
 * The UI half (scripts/bench-lag/ui-bench.ts) mounts the checkout's real
 * Console in headless Chromium over fake seams and measures render cost,
 * long tasks, click-to-Detail and drag under the same churn, at the snapshot
 * rate the server half measured.
 *
 * `--rtt` adds a simulated round trip to every tab request (not the
 * responsiveness probe), for a browser on another machine; the default is
 * loopback.
 *
 * Bun must be on PATH for the child processes (`PATH=$HOME/.bun/bin:$PATH`).
 * Not a test: nothing here is named *.test.ts, and `bun test` never runs it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPool, modeFor, type BenchPool } from "./bench-lag/pool.ts";
import {
  CONNECTIONS_PER_HOST,
  ConnectionPool,
  setSimulatedRtt,
  Tab,
  timedFetch,
  type Timing,
} from "./bench-lag/load.ts";
import type { UiBenchResult } from "./bench-lag/ui-bench.ts";

// --- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const repo = resolve(flag("repo") ?? join(import.meta.dir, ".."));
const outPath = flag("out");
const durationS = Number(flag("duration") ?? 60);
const tabCount = Number(flag("tabs") ?? 2);
const uiDurationS = Number(flag("ui-duration") ?? 30);
const skipUi = argv.includes("--skip-ui");
const skipServer = argv.includes("--skip-server");
const rttMs = Number(flag("rtt") ?? 0);
setSimulatedRtt(rttMs);

for (const dir of [join(repo, "node_modules"), join(repo, "ui", "node_modules")]) {
  if (!existsSync(dir)) {
    console.error(
      `${dir} is missing: run \`bun install --frozen-lockfile\` in ${repo} and \`bun install --cwd ui\` first`,
    );
    process.exit(2);
  }
}

// --- small helpers -------------------------------------------------------------

interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function summarize(values: number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    n: s.length,
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(s.at(-1) ?? 0),
  };
}

function rssOf(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return kb * 1024;
  } catch {
    return 0;
  }
}

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

/** A child process with IPC, resolved once it prints its `READY <value>` line. */
async function child(
  args: string[],
  label: string,
): Promise<{ proc: Bun.Subprocess; ready: string; ask: (msg: unknown, kind: string) => Promise<any> }> {
  const pending = new Map<string, (value: unknown) => void>();
  const proc = Bun.spawn(["bun", "run", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Nothing the operator's own shell carries reaches the pool: no Jev,
      // no herdr workspace, and claude's per-machine file in a scratch dir.
      TYPESAFE_API_KEY: "",
      HERDR_WORKSPACE_ID: "",
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    },
    ipc(message) {
      const kind = (message as { kind?: string }).kind ?? "";
      pending.get(kind)?.(message);
      pending.delete(kind);
    },
  });
  const ready = await new Promise<string>((resolveReady, reject) => {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = proc.stdout.getReader();
    let found = false;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const m = /READY (\S+)\n/.exec(buffer);
        if (m && !found) {
          found = true;
          resolveReady(m[1]!);
        }
        if (buffer.length > 1e6) buffer = buffer.slice(-1e5);
      }
      if (!found) {
        const err = await new Response(proc.stderr).text();
        reject(new Error(`${label} exited before it was ready:\n${err}`));
      }
    })();
  });
  // Keep draining stderr so a chatty child never blocks on a full pipe.
  void new Response(proc.stderr).text().catch(() => {});
  const ask = (msg: unknown, kind: string) =>
    new Promise<any>((resolveAsk) => {
      pending.set(kind, resolveAsk);
      proc.send(msg);
    });
  return { proc, ready, ask };
}

// --- the server half -----------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "bench-lag-"));
const loadavgAtStart = loadavg().map((l) => Math.round(l * 100) / 100);
const here = join(import.meta.dir, "bench-lag");

interface ServerResult {
  durationS: number;
  tabs: number;
  rttMs: number;
  pool: { tickets: number; done: number; inProgress: number; ready: number; conversations: number; mergeHold: number; interrupts: number };
  pingMs: Summary;
  pingFailures: number;
  clickMs: Summary & { queuedMean: number };
  focusMs: Summary & { queuedMean: number; serverP50: number };
  requestsByKind: Record<string, Summary & { queuedMean: number; perSec: number; meanBytes: number }>;
  snapshots: { perSec: number; meanBytes: number; maxBytes: number; gapP50Ms: number };
  server: {
    rssStartMb: number;
    rssEndMb: number;
    cpuPercent: number;
    loopLagMs: { p50: number; p95: number; p99: number; max: number; over50ms: number };
    syncSpawn: { calls: number; totalMs: number; blockedPercent: number; byCommand: { cmd: string; calls: number; totalMs: number; maxMs: number }[] };
    asyncSpawns: number;
  };
  herdrRequests: Record<string, number>;
}

async function runServerHalf(pool: BenchPool): Promise<ServerResult> {
  const herdr = await child([join(here, "herdr.ts"), "--repo", repo], "fake herdr");
  const modes = Object.fromEntries(
    [...pool.quick, ...pool.conflicting, ...pool.live, ...pool.blocked].map((id) => [id, modeFor(pool, id)]),
  );
  const serve = await child(
    [
      join(here, "serve.ts"),
      "--repo", repo,
      "--pool", pool.poolDir,
      "--herdr", herdr.ready,
      "--script", pool.harnessScript,
      "--release", pool.releaseFile,
      "--home", join(root, "home"),
      "--modes", JSON.stringify(modes),
    ],
    "pool server",
  );
  const base = serve.ready;
  const kill = () => {
    writeFileSync(pool.releaseFile, "");
    serve.proc.kill("SIGKILL");
    herdr.proc.kill("SIGKILL");
  };
  process.on("exit", kill);

  try {
    type Snap = {
      phase: string;
      state: {
        mergeQueue?: unknown[];
        tickets: { id: string; status: string; liveAttempt?: { paneId: string | null } | null }[];
        conversations?: { id: string; paneId: string | null }[];
        interrupts?: unknown[];
      };
    };
    const state = async (): Promise<Snap> => ((await (await fetch(`${base}/api/state`)).json()) as { snapshot: Snap }).snapshot;

    // 1. Let the engine work the pool: every fast Ticket done (three of them
    //    held on conflicts), the live four running in panes.
    console.error("warming up: letting the engine run the fast Tickets and merge them…");
    await waitFor("the pool to reach its working state", 120_000, async () => {
      const s = await state();
      const by = new Map(s.state.tickets.map((t) => [t.id, t]));
      const fastDone = [...pool.quick, ...pool.conflicting].every((id) => by.get(id)?.status === "done");
      const liveUp = pool.live.every((id) => typeof by.get(id)?.liveAttempt?.paneId === "string");
      return fastDone && liveUp ? s : null;
    });

    // 2. Three Conversations, the way the Console starts one.
    for (const title of ["Plan the next milestone", "Review the merge queue", "Triage the flaky suite"]) {
      const res = await fetch(`${base}/api/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, assign: { harness: "convo", model: "m" } }),
      });
      if (res.status !== 201) throw new Error(`starting a Conversation: ${res.status} ${await res.text()}`);
    }
    const ready = await waitFor("the Conversations' panes", 30_000, async () => {
      const s = await state();
      const convs = s.state.conversations ?? [];
      return convs.length >= 3 && convs.every((c) => typeof c.paneId === "string") ? s : null;
    });
    herdr.proc.send({
      panes: [
        ...ready.state.tickets
          .filter((t) => t.liveAttempt?.paneId)
          .map((t) => ({ paneId: t.liveAttempt!.paneId!, kind: "ticket" })),
        ...(ready.state.conversations ?? []).map((c) => ({ paneId: c.paneId!, kind: "conversation" })),
      ],
    });

    // 3. The tabs: the first has a live Ticket open in the Detail, the
    //    second a done one, as an operator's two windows would, sharing
    //    the browser's connections to the server.
    const browser = new ConnectionPool(CONNECTIONS_PER_HOST);
    const tabs = Array.from(
      { length: tabCount },
      (_, i) => new Tab(base, browser, i === 0 ? pool.live[0]! : pool.quick[0]!),
    );
    for (const tab of tabs) await tab.open();
    console.error(`settling with ${tabCount} tabs open…`);
    await Bun.sleep(5_000);

    // 4. The window.
    console.error(`measuring for ${durationS}s…`);
    const begun = (await serve.ask("begin", "begun")) as { rssBytes: number };
    const rssStart = rssOf(serve.proc.pid) || begun.rssBytes;
    for (const tab of tabs) tab.record(true);
    const t0 = performance.now();
    const end = t0 + durationS * 1000;

    const pings: number[] = [];
    let pingFailures = 0;
    const pinger = (async () => {
      while (performance.now() < end) {
        const t = await timedFetch(null, `${base}/ping.txt`);
        if (t.status === 200) pings.push(t.totalMs);
        else pingFailures++;
        await Bun.sleep(25);
      }
    })();

    // A click every 3 s on the first tab, round the cards an operator moves
    // between: a live Ticket, a done one, a held one, a blocked one.
    const clickTargets = [pool.live[1]!, pool.quick[2]!, pool.conflicting[2]!, pool.blocked[0]!, pool.live[0]!];
    const clicks: { totalMs: number; queuedMs: number }[] = [];
    const clicker = (async () => {
      let k = 0;
      while (performance.now() < end - 3_000) {
        clicks.push(await tabs[0]!.click(clickTargets[k++ % clickTargets.length]!));
        await Bun.sleep(3_000);
      }
    })();

    // Open in herdr every 3 s, offset from the clicks, round the live panes.
    const focuses: Timing[] = [];
    const focuser = (async () => {
      await Bun.sleep(1_500);
      let k = 0;
      while (performance.now() < end - 3_000) {
        focuses.push(await tabs[0]!.focus(pool.live[k++ % pool.live.length]!));
        await Bun.sleep(3_000);
      }
    })();

    await Promise.all([pinger, clicker, focuser]);
    const elapsedS = (performance.now() - t0) / 1000;
    for (const tab of tabs) tab.record(false);
    const report = (await serve.ask("report", "report")) as ServerResult["server"] & { rssBytes: number };
    const rssEnd = rssOf(serve.proc.pid) || report.rssBytes;
    const herdrCounts = ((await herdr.ask({ requests: true }, "requests")) as { counts: Record<string, number> }).counts;
    const final = await state();
    for (const tab of tabs) tab.close();

    // 5. Tally.
    const all: Record<string, Timing[]> = {};
    for (const tab of tabs) {
      for (const [kind, list] of Object.entries(tab.stats.requests)) (all[kind] ??= []).push(...list);
    }
    const requestsByKind: ServerResult["requestsByKind"] = {};
    for (const [kind, list] of Object.entries(all)) {
      requestsByKind[kind] = {
        ...summarize(list.map((t) => t.totalMs)),
        queuedMean: summarize(list.map((t) => t.queuedMs)).mean,
        perSec: Math.round((list.length / elapsedS) * 10) / 10,
        meanBytes: Math.round(list.reduce((n, t) => n + t.bytes, 0) / (list.length || 1)),
      };
    }
    const first = tabs[0]!.stats;
    const gaps = first.snapshotArrivals.slice(1).map((t, i) => t - first.snapshotArrivals[i]!);
    const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
    const statuses = final.state.tickets.map((t) => t.status);
    return {
      durationS: Math.round(elapsedS),
      tabs: tabCount,
      rttMs,
      pool: {
        tickets: statuses.length,
        done: statuses.filter((s) => s === "done").length,
        inProgress: statuses.filter((s) => s === "in-progress").length,
        ready: statuses.filter((s) => s === "ready").length,
        conversations: final.state.conversations?.length ?? 0,
        mergeHold: final.state.mergeQueue?.length ?? 0,
        interrupts: final.state.interrupts?.length ?? 0,
      },
      pingMs: summarize(pings),
      pingFailures,
      clickMs: { ...summarize(clicks.map((c) => c.totalMs)), queuedMean: summarize(clicks.map((c) => c.queuedMs)).mean },
      focusMs: {
        ...summarize(focuses.map((f) => f.totalMs)),
        queuedMean: summarize(focuses.map((f) => f.queuedMs)).mean,
        serverP50: summarize(focuses.map((f) => f.serverMs)).p50,
      },
      requestsByKind,
      snapshots: {
        perSec: Math.round((first.snapshots / elapsedS) * 100) / 100,
        meanBytes: Math.round(first.snapshotBytes.reduce((a, b) => a + b, 0) / (first.snapshots || 1)),
        maxBytes: Math.max(0, ...first.snapshotBytes),
        gapP50Ms: summarize(gaps).p50,
      },
      server: {
        rssStartMb: mb(rssStart),
        rssEndMb: mb(rssEnd),
        cpuPercent: Math.round(report.cpuPercent * 10) / 10,
        loopLagMs: report.loopLagMs,
        syncSpawn: {
          calls: report.syncSpawn.calls,
          totalMs: Math.round(report.syncSpawn.totalMs),
          blockedPercent: Math.round(report.syncSpawn.blockedPercent * 10) / 10,
          byCommand: report.syncSpawn.byCommand.map((s) => ({
            cmd: s.cmd,
            calls: s.calls,
            totalMs: Math.round(s.totalMs),
            maxMs: Math.round(s.maxMs * 10) / 10,
          })),
        },
        asyncSpawns: report.asyncSpawns,
      },
      herdrRequests: herdrCounts,
    };
  } finally {
    kill();
    process.off("exit", kill);
    await Promise.allSettled([serve.proc.exited, herdr.proc.exited]);
  }
}

// --- the run -------------------------------------------------------------------

function gitHead(dir: string): string {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  const branch = Bun.spawnSync(["git", "-C", dir, "branch", "--show-current"], { stdout: "pipe", stderr: "pipe" });
  return `${branch.stdout.toString().trim() || "detached"}@${r.stdout.toString().trim()}`;
}

let serverResult: ServerResult | null = null;
let uiResult: UiBenchResult | null = null;
try {
  if (!skipServer) {
    const pool = buildPool(root);
    serverResult = await runServerHalf(pool);
  }
  if (!skipUi) {
    console.error(`UI half: headless Chromium for ${uiDurationS}s…`);
    const { runUiBench } = await import("./bench-lag/ui-bench.ts");
    uiResult = await runUiBench({
      repo,
      durationMs: uiDurationS * 1000,
      snapshotsPerSec: serverResult?.snapshots.perSec || 1,
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const result = {
  at: new Date().toISOString(),
  repo,
  revision: gitHead(repo),
  // The box's load when the run began: other work on the machine (another
  // agent's suite, say) moves every number here, so a comparison should
  // check the two runs started on similarly quiet machines.
  machine: { bun: Bun.version, platform: process.platform, cpus: navigator.hardwareConcurrency, loadavgAtStart },
  server: serverResult,
  ui: uiResult,
};

// --- the table -------------------------------------------------------------------

const rows: [string, string][] = [];
const ms = (s: { p50: number; p95: number; max: number }) => `p50 ${s.p50}  p95 ${s.p95}  max ${s.max} ms`;
if (serverResult) {
  const s = serverResult;
  rows.push(
    ["load", `${s.tabs} tabs sharing ${CONNECTIONS_PER_HOST} connections, simulated RTT ${s.rttMs} ms, ${s.durationS} s`],
    ["pool", `${s.pool.tickets} tickets (${s.pool.done} done, ${s.pool.inProgress} in progress, ${s.pool.ready} waiting), ${s.pool.conversations} conversations, merge queue ${s.pool.mergeHold}, interrupts ${s.pool.interrupts}`],
    ["ping (GET, every 25 ms)", `${ms(s.pingMs)}  p99 ${s.pingMs.p99}  n=${s.pingMs.n}${s.pingFailures ? `  failed ${s.pingFailures}` : ""}`],
    ["card click (events+log+body)", `${ms(s.clickMs)}  queued mean ${s.clickMs.queuedMean} ms  n=${s.clickMs.n}`],
    ["Open in herdr (focus)", `${ms(s.focusMs)}  queued mean ${s.focusMs.queuedMean} ms  server p50 ${s.focusMs.serverP50} ms  n=${s.focusMs.n}`],
    ["snapshots", `${s.snapshots.perSec}/s  mean ${Math.round(s.snapshots.meanBytes / 1024)} KiB  max ${Math.round(s.snapshots.maxBytes / 1024)} KiB  gap p50 ${s.snapshots.gapP50Ms} ms`],
    ["server", `RSS ${s.server.rssStartMb} -> ${s.server.rssEndMb} MB  CPU ${s.server.cpuPercent}%`],
    ["server loop lag", `p50 ${s.server.loopLagMs.p50}  p95 ${s.server.loopLagMs.p95}  p99 ${s.server.loopLagMs.p99}  max ${Math.round(s.server.loopLagMs.max)} ms  >50ms ${s.server.loopLagMs.over50ms}x`],
    ["server sync spawns", `${s.server.syncSpawn.calls} calls, ${s.server.syncSpawn.totalMs} ms blocked (${s.server.syncSpawn.blockedPercent}% of the window); top: ${s.server.syncSpawn.byCommand.slice(0, 4).map((c) => `${c.cmd} ${c.calls}x/${c.totalMs}ms`).join(", ")}`],
  );
  for (const [kind, r] of Object.entries(s.requestsByKind).sort()) {
    rows.push([`  ${kind}`, `${r.perSec}/s  ${ms(r)}  queued mean ${r.queuedMean} ms  ${Math.round(r.meanBytes / 1024)} KiB`]);
  }
}
if (uiResult) {
  const u = uiResult;
  if (u.error) rows.push(["ui error", u.error]);
  rows.push(
    ["ui renders", `${u.rendersPerSec}/s over ${u.cards} cards; per render mean ${u.renderMs.mean}  p95 ${u.renderMs.p95}  max ${u.renderMs.max} ms`],
    ["ui render share", `model() mean ${u.modelMs.mean} ms; render+layout mean ${u.renderLayoutMs.mean} ms; ${u.renderBusyPct}% of the main thread`],
    ["ui long tasks", `longest ${u.longestTaskMs} ms, ${u.longTasksOver50ms} over 50 ms`],
    ["ui frame gaps", `p50 ${u.frameGapMs.p50}  p95 ${u.frameGapMs.p95}  max ${u.frameGapMs.max} ms, ${u.framesOver50ms} over 50 ms`],
    ["ui click -> Detail painted", `${ms(u.clickToDetailMs)}  (handler alone p50 ${u.clickSyncMs.p50} ms, ${u.rendersDuringClicks} renders during clicks)`],
    ["ui drag (per pointermove)", `mean ${u.dragMoveMs.mean}  p95 ${u.dragMoveMs.p95}  max ${u.dragMoveMs.max} ms`],
    ["ui sanity", `Detail ${u.sanity.detailOpened ? "opened" : "MISSED"}, drag ${u.sanity.dragMoved ? "moved" : "DID NOT MOVE"}, ${u.sanity.snapshotsPushed} snapshots pushed`],
  );
}
const width = Math.max(...rows.map(([k]) => k.length));
console.log(`\nlag bench: ${result.revision} (${repo}), load average at start ${loadavgAtStart.join(" ")}`);
for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${outPath}`);
}
process.exit(0);
