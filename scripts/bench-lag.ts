#!/usr/bin/env bun
/**
 * The lag bench (issues #157, #161): a repeatable yardstick for how sluggish
 * the Console feels, so a fix can be measured against the code it replaced,
 * and, end to end, a set of gates the Console must pass.
 *
 *   bun run scripts/bench-lag.ts [--repo <checkout>] [--out <file.json>]
 *       [--duration <s>] [--tabs <n>] [--rtt <ms>] [--ui-duration <s>] [--skip-ui] [--skip-server]
 *   bun run scripts/bench-lag.ts --e2e [--repo <checkout>] [--rtt <ms>] [--tabs <n>] [--duration <s>]
 *       [--idle <s>] [--out <file.json>]
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
 * operator's card clicks and Open in herdr (over the push protocol's socket,
 * or through a tab's six connections on a checkout that predates it), the
 * snapshot rate and size, the server's RSS, CPU, event-loop lag and time
 * blocked in synchronous spawns. Which protocol a checkout speaks is asked
 * of its running server (load.ts detectProtocol), so the same bench runs on
 * both sides of issue #161.
 *
 * The UI half (scripts/bench-lag/ui-bench.ts) mounts the checkout's real
 * Console in headless Chromium over a fake socket that plays the server's
 * frames (or, on a checkout from before the push protocol, over its old
 * fetch and stream seams) and measures render cost, long tasks,
 * click-to-Detail and drag under the same churn, at the snapshot rate the
 * server half measured.
 *
 * `--rtt` adds a simulated round trip to every tab request (not the
 * responsiveness probe), for a browser on another machine; the default is
 * loopback.
 *
 * Both halves model the client: the server half replays a fixed request
 * pattern, and the UI half fakes the network. `--e2e` models nothing and runs
 * instead of both: it builds the checkout's own UI, serves it from the same
 * pool and server, and opens it in N real headless Chromium windows
 * (scripts/bench-lag/e2e.ts) through a TCP proxy that holds every chunk for
 * half the `--rtt` each way (scripts/bench-lag/proxy.ts), so the browser's
 * own connection limit, keep-alive and polling apply. On the first window it
 * makes the server half's clicks and Open in herdrs as real mouse input,
 * every other click after resting the pointer on the card (a hover that
 * lets the Console prefetch it), and parks the pointer on bare canvas after
 * each press, so no other click is ever hovered. Then it stops all input
 * for an idle window (`--idle`, at least 10 s). A probe injected into the
 * page (scripts/bench-lag/ui/probe.ts) times the presses, the page's start
 * and its frames, and counts renders, long tasks, requests and socket
 * frames, through web APIs alone, so it measures any checkout's Console.
 *
 * The end-to-end run ends in the gate table (scripts/bench-lag/gates.ts):
 * press feedback, click to Detail, click to data cold and hovered, Open in
 * herdr answered, frames over budget, background polling and start to
 * usable, each judged over every sample, and exits 1 when any gate fails.
 *
 * Bun must be on PATH for the child processes (`PATH=$HOME/.bun/bin:$PATH`),
 * and Chromium or Chrome must be installed (scripts/bench-lag/chromium.ts
 * finds it on Linux and macOS; CHROMIUM overrides). Not a test itself: its
 * pure parts are, in scripts/bench-lag/*.test.ts.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeServerMessage, encodeMessage, HOVER_DWELL_MS, PROTOCOL_VERSION } from "../engine/protocol.ts";
import { buildPool, modeFor, type BenchPool } from "./bench-lag/pool.ts";
import {
  CONNECTIONS_PER_HOST,
  ConnectionPool,
  detectProtocol,
  setSimulatedRtt,
  socketUrl,
  Tab,
  timedFetch,
  type Protocol,
  type Timing,
} from "./bench-lag/load.ts";
import type { UiBenchResult } from "./bench-lag/ui-bench.ts";
import {
  ConsoleBrowser,
  summarizeE2e,
  type BrowserTab,
  type E2eResult,
  type ProbeReport,
  type SocketTrip,
} from "./bench-lag/e2e.ts";
import { evaluateGates, formatGates, IDLE_MIN_MS, type GateResult } from "./bench-lag/gates.ts";

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
const e2e = argv.includes("--e2e");
const skipUi = e2e || argv.includes("--skip-ui");
const skipServer = e2e || argv.includes("--skip-server");
const rttMs = Number(flag("rtt") ?? 0);
setSimulatedRtt(rttMs);
/** The end-to-end run's idle window, no input at all; the polling gate needs at least 10 s. */
const idleS = Number(flag("idle") ?? 15);

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
  /** What the server spoke to the tabs. */
  protocol: Protocol;
  pool: { tickets: number; done: number; inProgress: number; ready: number; conversations: number; mergeHold: number; interrupts: number };
  pingMs: Summary;
  pingFailures: number;
  clickMs: Summary & { queuedMean: number };
  focusMs: Summary & { queuedMean: number; serverP50: number };
  requestsByKind: Record<string, Summary & { queuedMean: number; perSec: number; meanBytes: number }>;
  /** Over the socket: every frame the tabs took, by type; and clicks or focuses never answered. */
  frames: Record<string, { perSec: number; meanBytes: number }>;
  unanswered: number;
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

type Snap = {
  phase: string;
  state: {
    mergeQueue?: unknown[];
    tickets: { id: string; status: string; liveAttempt?: { paneId: string | null } | null }[];
    conversations?: { id: string; paneId: string | null }[];
    interrupts?: unknown[];
  };
};

/** The checkout's pool server and fake herdr, the pool worked into its realistic state. */
interface RunningPool {
  base: string;
  serve: Awaited<ReturnType<typeof child>>;
  herdr: Awaited<ReturnType<typeof child>>;
  state: () => Promise<Snap>;
  kill: () => Promise<void>;
}

async function startPool(pool: BenchPool): Promise<RunningPool> {
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
  const killNow = () => {
    writeFileSync(pool.releaseFile, "");
    serve.proc.kill("SIGKILL");
    herdr.proc.kill("SIGKILL");
  };
  process.on("exit", killNow);
  const kill = async () => {
    killNow();
    process.off("exit", killNow);
    await Promise.allSettled([serve.proc.exited, herdr.proc.exited]);
  };
  const state = async (): Promise<Snap> => ((await (await fetch(`${base}/api/state`)).json()) as { snapshot: Snap }).snapshot;

  try {
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
    return { base, serve, herdr, state, kill };
  } catch (err) {
    await kill();
    throw err;
  }
}

/**
 * The responsiveness probe: a trivial GET every 25 ms straight to the
 * server (never through a tab's connections or the proxy), whose latency is
 * the server's event loop and nothing else.
 */
async function pingUntil(base: string, end: number): Promise<{ pings: number[]; failures: number }> {
  const pings: number[] = [];
  let failures = 0;
  while (performance.now() < end) {
    const t = await timedFetch(null, `${base}/ping.txt`);
    if (t.status === 200) pings.push(t.totalMs);
    else failures++;
    await Bun.sleep(25);
  }
  return { pings, failures };
}

async function runServerHalf(pool: BenchPool): Promise<ServerResult> {
  const { base, serve, herdr, state, kill } = await startPool(pool);
  try {
    // 3. The tabs: the first has a live Ticket open in the Detail, the
    //    second a done one, as an operator's two windows would, sharing
    //    the browser's connections to the server (or each on its socket).
    const protocol = await detectProtocol(base);
    const browser = new ConnectionPool(CONNECTIONS_PER_HOST);
    const tabs = Array.from(
      { length: tabCount },
      (_, i) => new Tab(base, browser, i === 0 ? pool.live[0]! : pool.quick[0]!, protocol),
    );
    for (const tab of tabs) await tab.open();
    console.error(`settling with ${tabCount} tabs open over ${protocol === "ws" ? "the socket" : "SSE"}…`);
    await Bun.sleep(5_000);

    // 4. The window.
    console.error(`measuring for ${durationS}s…`);
    const begun = (await serve.ask("begin", "begun")) as { rssBytes: number };
    const rssStart = begun.rssBytes;
    for (const tab of tabs) tab.record(true);
    const t0 = performance.now();
    const end = t0 + durationS * 1000;

    const pinger = pingUntil(base, end);

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

    const [{ pings, failures: pingFailures }] = await Promise.all([pinger, clicker, focuser]);
    const elapsedS = (performance.now() - t0) / 1000;
    for (const tab of tabs) tab.record(false);
    const report = (await serve.ask("report", "report")) as ServerResult["server"] & { rssBytes: number };
    const rssEnd = report.rssBytes;
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
    const frames: ServerResult["frames"] = {};
    const frameTotals: Record<string, { count: number; bytes: number }> = {};
    for (const tab of tabs) {
      for (const [type, t] of Object.entries(tab.stats.frames)) {
        const sum = (frameTotals[type] ??= { count: 0, bytes: 0 });
        sum.count += t.count;
        sum.bytes += t.bytes;
      }
    }
    for (const [type, t] of Object.entries(frameTotals)) {
      frames[type] = { perSec: Math.round((t.count / elapsedS) * 100) / 100, meanBytes: Math.round(t.bytes / (t.count || 1)) };
    }
    const first = tabs[0]!.stats;
    const gaps = first.snapshotArrivals.slice(1).map((t, i) => t - first.snapshotArrivals[i]!);
    const mb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
    const statuses = final.state.tickets.map((t) => t.status);
    return {
      durationS: Math.round(elapsedS),
      tabs: tabCount,
      rttMs,
      protocol,
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
      frames,
      unanswered: tabs.reduce((n, tab) => n + tab.stats.unanswered, 0),
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
    await kill();
  }
}

// --- the end-to-end half ---------------------------------------------------------

interface E2eHalfResult extends E2eResult {
  /** What the pool server spoke; `protocol` is what the page did. */
  serverProtocol: Protocol;
  snapshots: { perSec: number; meanBytes: number };
  server: {
    pingMs: Summary;
    pingFailures: number;
    cpuPercent: number;
    loopLagMs: { p50: number; p95: number; p99: number; max: number; over50ms: number };
    syncSpawnBlockedPercent: number;
  };
  herdrRequests: Record<string, number>;
  gates: GateResult[];
}

/**
 * The snapshot pushes' rate, read on a connection of the bench's own
 * straight to the server, so the numbers say how often the engine pushed
 * (its rate decides how much rendering the page has to do). Over the
 * socket, each `snapshot` and `delta` frame, on a socket that says it is
 * hidden so the server does no live work for it; over SSE, each snapshot
 * event. Either way the one the connection opens with is the server
 * catching it up, not a push, and is left out.
 */
function countSnapshots(base: string, protocol: Protocol): { stop: () => { count: number; bytes: number } } {
  let opening = true;
  let count = 0;
  let bytes = 0;
  const take = (size: number) => {
    if (opening) {
      opening = false;
      return;
    }
    count++;
    bytes += size;
  };
  if (protocol === "ws") {
    const socket = new WebSocket(socketUrl(base));
    socket.onopen = () =>
      socket.send(encodeMessage({ type: "hello", protocol: PROTOCOL_VERSION, visible: false, cards: [] }));
    socket.onmessage = (event) => {
      const text = String(event.data);
      const type = decodeServerMessage(text).type;
      if (type === "snapshot" || type === "delta") take(Buffer.byteLength(text));
    };
    return {
      stop: () => {
        socket.close();
        return { count, bytes };
      },
    };
  }
  const abort = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/api/stream`, { signal: abort.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (frame.startsWith("event: snapshot")) take(frame.length);
      }
    }
  })().catch(() => {});
  return {
    stop: () => {
      abort.abort();
      return { count, bytes };
    },
  };
}

/** A press's target as the probe armed it, and where the pointer goes after. */
type Armed = { x: number; y: number; park: { x: number; y: number } | null } | null;

async function runE2eHalf(pool: BenchPool): Promise<E2eHalfResult> {
  // 1. The checkout's own UI, built by its own build script into the
  //    directory the server serves (serve.ts adds the ping file after).
  console.error("building the checkout's UI…");
  const build = Bun.spawnSync(["bun", "run", "build", "--outDir", join(root, "home", "dist"), "--emptyOutDir"], {
    cwd: join(repo, "ui"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`building ${repo}/ui failed:\n${build.stdout}\n${build.stderr}`);

  const { base, serve, herdr, kill } = await startPool(pool);
  const proxy = await child([join(here, "proxy.ts"), "--target", base, "--rtt", String(rttMs)], "proxy");
  const browser = await ConsoleBrowser.launch({ profileDir: join(root, "chromium") });
  try {
    const serverProtocol = await detectProtocol(base);

    // 2. The tabs: real windows on the real page, through the proxy. The
    //    first has a live Ticket open in the Detail, the second a done one,
    //    as in the server half.
    const tabs: BrowserTab[] = [];
    for (let i = 0; i < tabCount; i++) tabs.push(await browser.open(`${proxy.ready}/`));
    const ticketCount = pool.quick.length + pool.conflicting.length + pool.live.length + pool.blocked.length;
    for (const tab of tabs) {
      await waitFor("the Console's first render", 30_000, async () =>
        (await browser.evaluate<number>(tab, "window.__lagProbe ? window.__lagProbe.cards() : 0")) >= ticketCount ? true : null,
      );
    }
    // The cards the first tab presses. Cold clicks go round the server
    // half's targets: a live Ticket, a done one, a held one, a blocked one.
    // Hovered clicks go round other live and blocked Tickets, whose Detail
    // tabs (Progress, Spec) have content to bring, and never a card a cold
    // click presses, so no cold click lands on a card a hover subscribed.
    // Open in herdr goes round the live ones.
    const coldTargets = [pool.live[1]!, pool.quick[2]!, pool.conflicting[2]!, pool.blocked[0]!, pool.live[0]!];
    const hoverTargets = [pool.live[2]!, pool.blocked[1]!, pool.live[3]!, pool.blocked[2]!];
    const framed = [[...new Set([...coldTargets, ...hoverTargets, ...pool.live])], [pool.quick[0]!]];
    for (const [i, tab] of tabs.entries()) {
      if (!(await browser.frame(tab, framed[Math.min(i, 1)]!))) console.error(`tab ${i + 1}: not every card it presses fits in view`);
    }
    // A hovered click rests the pointer on the card for long enough that a
    // prefetch which works has landed: the Console's dwell before it
    // subscribes, the round trip, and 200 ms for the server's reads and the
    // page's apply. What is judged is that the click then draws the data in
    // its own frame, not whether a hand is slower than the network.
    const hoverMs = HOVER_DWELL_MS + rttMs + 200;
    // One press at a time: the probe times the next press it was armed for.
    // After each, the pointer goes straight to bare canvas, so it rests on
    // no card a click is about to press cold.
    let pressing: Promise<unknown> = Promise.resolve();
    const press = (tab: BrowserTab, how: "cold" | "hover" | "focus", id: string): Promise<boolean> => {
      const run = pressing.then(async () => {
        const at = await browser.evaluate<Armed>(
          tab,
          how === "focus"
            ? `window.__lagProbe.armFocus(${JSON.stringify(id)})`
            : `window.__lagProbe.armClick(${JSON.stringify(id)}, ${JSON.stringify(how)})`,
        );
        if (!at) return false;
        if (how === "hover") {
          await browser.move(tab, at);
          await Bun.sleep(hoverMs);
        }
        await browser.click(tab, at);
        if (at.park) await browser.move(tab, at.park);
        return true;
      });
      pressing = run.catch(() => {});
      return run;
    };
    for (const [i, tab] of tabs.entries()) await press(tab, "cold", i === 0 ? pool.live[0]! : pool.quick[0]!);
    // Where the pointer parks, found now the Detail is open, outside the window.
    for (const tab of tabs) await browser.evaluate(tab, "window.__lagProbe.parkPoint()");
    console.error(`settling with ${tabCount} browser tabs open, RTT ${rttMs} ms, the server on ${serverProtocol}…`);
    await Bun.sleep(5_000);

    // 3. The window: the server half's schedule, made by hand on the first
    //    tab, every other click a hovered one.
    console.error(`measuring for ${durationS}s…`);
    await serve.ask("begin", "begun");
    const before = await browser.metrics(tabs[0]!);
    for (const tab of tabs) await browser.evaluate(tab, "window.__lagProbe.begin()");
    const stream = countSnapshots(base, serverProtocol);
    const t0 = performance.now();
    const end = t0 + durationS * 1000;
    const pinger = pingUntil(base, end);
    const unreachable = { cold: 0, hover: 0, focus: 0 };
    const clicker = (async () => {
      let k = 0;
      while (performance.now() < end - 3_000) {
        const how = k % 2 === 0 ? "cold" : "hover";
        const targets = how === "cold" ? coldTargets : hoverTargets;
        if (!(await press(tabs[0]!, how, targets[Math.floor(k / 2) % targets.length]!))) unreachable[how]++;
        k++;
        await Bun.sleep(3_000);
      }
    })();
    const focuser = (async () => {
      await Bun.sleep(1_500);
      let k = 0;
      while (performance.now() < end - 3_000) {
        if (!(await press(tabs[0]!, "focus", pool.live[k++ % pool.live.length]!))) unreachable.focus++;
        await Bun.sleep(3_000);
      }
    })();
    const [{ pings, failures }] = await Promise.all([pinger, clicker, focuser]);
    // The last press's answers land before the window shuts.
    await Bun.sleep(2_000);
    for (const tab of tabs) await browser.evaluate(tab, "window.__lagProbe.end()");
    const elapsedS = (performance.now() - t0) / 1000;
    const streamed = stream.stop();
    const after = await browser.metrics(tabs[0]!);
    const report = (await serve.ask("report", "report")) as ServerResult["server"];
    const herdrCounts = ((await herdr.ask({ requests: true }, "requests")) as { counts: Record<string, number> }).counts;
    const socketTrips = ((await proxy.ask({ trips: true }, "trips")) as { trips: SocketTrip[] }).trips;

    // 4. The idle window: no input at all, the pointer parked on bare canvas,
    //    every tab open and visible. Whatever the pages send now, they send
    //    on their own.
    console.error(`idle for ${idleS}s, no input…`);
    for (const tab of tabs) await browser.evaluate(tab, "window.__lagProbe.idle()");
    await Bun.sleep(idleS * 1000);
    for (const tab of tabs) await browser.evaluate(tab, "window.__lagProbe.idleEnd()");
    // A request the idle window started has its timing entry once it ends.
    await Bun.sleep(1_000);
    const reports: ProbeReport[] = [];
    for (const tab of tabs) reports.push(await browser.evaluate<ProbeReport>(tab, "window.__lagProbe.report()"));

    const measured = summarizeE2e(reports, { before, after }, { rttMs, socketTrips, unreachable, tickets: ticketCount, hoverMs });
    return {
      ...measured,
      serverProtocol,
      snapshots: {
        perSec: Math.round((streamed.count / elapsedS) * 100) / 100,
        meanBytes: Math.round(streamed.bytes / (streamed.count || 1)),
      },
      server: {
        pingMs: summarize(pings),
        pingFailures: failures,
        cpuPercent: Math.round(report.cpuPercent * 10) / 10,
        loopLagMs: report.loopLagMs,
        syncSpawnBlockedPercent: Math.round(report.syncSpawn.blockedPercent * 10) / 10,
      },
      herdrRequests: herdrCounts,
      gates: evaluateGates(measured.gateInputs),
    };
  } finally {
    await browser.close();
    proxy.proc.kill("SIGKILL");
    await kill();
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
let e2eResult: E2eHalfResult | null = null;
try {
  if (e2e) e2eResult = await runE2eHalf(buildPool(root));
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
  // Anything the fake herdr's panes started outlives the herdr process, so
  // reap whatever still runs from inside the root before removing it.
  Bun.spawnSync(["pkill", "-f", root]);
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
  e2e: e2eResult,
};

// --- the table -------------------------------------------------------------------

const rows: [string, string][] = [];
const ms = (s: { p50: number; p95: number; max: number }) => `p50 ${s.p50}  p95 ${s.p95}  max ${s.max} ms`;
if (serverResult) {
  const s = serverResult;
  const socket = s.protocol === "ws";
  rows.push(
    ["load", `${s.tabs} tabs ${socket ? "on a socket each" : `sharing ${CONNECTIONS_PER_HOST} connections over SSE`}, simulated RTT ${s.rttMs} ms, ${s.durationS} s`],
    ["pool", `${s.pool.tickets} tickets (${s.pool.done} done, ${s.pool.inProgress} in progress, ${s.pool.ready} waiting), ${s.pool.conversations} conversations, merge queue ${s.pool.mergeHold}, interrupts ${s.pool.interrupts}`],
    ["ping (GET, every 25 ms)", `${ms(s.pingMs)}  p99 ${s.pingMs.p99}  n=${s.pingMs.n}${s.pingFailures ? `  failed ${s.pingFailures}` : ""}`],
    [socket ? "card click (subscribe -> card)" : "card click (events+log+body)", `${ms(s.clickMs)}  queued mean ${s.clickMs.queuedMean} ms  n=${s.clickMs.n}`],
    [socket ? "Open in herdr (request -> reply)" : "Open in herdr (focus)", `${ms(s.focusMs)}  queued mean ${s.focusMs.queuedMean} ms  server p50 ${s.focusMs.serverP50} ms  n=${s.focusMs.n}${s.unanswered ? `  UNANSWERED ${s.unanswered}` : ""}`],
    [socket ? "snapshots (snapshot+delta)" : "snapshots", `${s.snapshots.perSec}/s  mean ${Math.round(s.snapshots.meanBytes / 1024)} KiB  max ${Math.round(s.snapshots.maxBytes / 1024)} KiB  gap p50 ${s.snapshots.gapP50Ms} ms`],
    ["server", `RSS ${s.server.rssStartMb} -> ${s.server.rssEndMb} MB  CPU ${s.server.cpuPercent}%`],
    ["server loop lag", `p50 ${s.server.loopLagMs.p50}  p95 ${s.server.loopLagMs.p95}  p99 ${s.server.loopLagMs.p99}  max ${Math.round(s.server.loopLagMs.max)} ms  >50ms ${s.server.loopLagMs.over50ms}x`],
    ["server sync spawns", `${s.server.syncSpawn.calls} calls, ${s.server.syncSpawn.totalMs} ms blocked (${s.server.syncSpawn.blockedPercent}% of the window); top: ${s.server.syncSpawn.byCommand.slice(0, 4).map((c) => `${c.cmd} ${c.calls}x/${c.totalMs}ms`).join(", ")}`],
  );
  for (const [kind, r] of Object.entries(s.requestsByKind).sort()) {
    rows.push([`  ${kind}`, `${r.perSec}/s  ${ms(r)}  queued mean ${r.queuedMean} ms  ${Math.round(r.meanBytes / 1024)} KiB`]);
  }
  for (const [type, r] of Object.entries(s.frames).sort()) {
    rows.push([`  frames in: ${type}`, `${r.perSec}/s  mean ${r.meanBytes} B`]);
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
if (e2eResult) {
  const e = e2eResult;
  const kinds = Object.entries(e.click.tabs).map(([tab, n]) => `${n} ${tab}`).join(", ");
  const frames = (s: { p50: number; p95: number; max: number }) => `p50 ${s.p50}  p95 ${s.p95}  max ${s.max} frames`;
  const na = "n/a (no socket)";
  const tally = (counts: Record<string, { count: number; bytes: number }>) =>
    Object.entries(counts)
      .sort()
      .map(([type, t]) => `${type} ${t.count}x/${Math.round(t.bytes / 1024)} KiB`)
      .join(", ") || "none";
  const protocols = e.serverProtocol === e.protocol ? e.protocol : `server ${e.serverProtocol}, page ${e.protocol}`;
  rows.push(
    ["e2e load", `${e.tabs} Chromium tabs on the built Console through a ${e.rttMs} ms RTT proxy, ${e.durationS} s, ${e.cards} cards, ${e.domNodes} DOM nodes, protocol ${protocols}`],
    ["e2e start -> usable", `${ms(e.start.usableMs)}  each ${e.start.each.map((v) => v ?? "never").join(", ")}`],
    ["e2e snapshots", `${e.snapshots.perSec}/s  mean ${Math.round(e.snapshots.meanBytes / 1024)} KiB`],
    ["e2e card click -> shell", `${ms(e.click.shellMs)}; ${frames(e.click.shellFrames)}  n=${e.click.n} (${kinds})  input delay p95 ${e.click.inputDelayMs.p95} ms`],
    ["e2e cold click -> data", `${ms(e.click.cold.dataMs)}  n=${e.click.cold.n}  not cold ${e.click.notCold}  unreachable ${e.click.unreachable.cold}`],
    ["e2e cold click -> card frame", e.click.cold.cardFrameMs ? `${ms(e.click.cold.cardFrameMs)}  n=${e.click.cold.cardFrameMs.n}` : na],
    ["e2e   of which -> subscribe sent", e.click.cold.toSubscribeMs ? ms(e.click.cold.toSubscribeMs) : na],
    ["e2e hovered click -> data", `${frames(e.click.hover.dataFrames)}; ${ms(e.click.hover.dataMs)}  n=${e.click.hover.n}  hover ${e.click.hoverMs} ms  prefetched ${e.click.hover.prefetched ?? na}  unreachable ${e.click.unreachable.hover}`],
    ["e2e   clicks unfilled, missed", `${e.click.unfilled} never showed their data, ${e.click.missed} landed elsewhere`],
    ["e2e   of which Progress", `${ms(e.click.progressDataMs)}  n=${e.click.progressDataMs.n} (timeline and log tail)`],
    ["e2e Open in herdr -> feedback", `${frames(e.focus.feedbackFrames)}  n=${e.focus.feedbackFrames.n}`],
    ["e2e Open in herdr -> answered", `${ms(e.focus.answeredMs)}  n=${e.focus.answeredMs.n} (socket ${e.focus.answeredVia.socket}, http ${e.focus.answeredVia.http})  unanswered ${e.focus.unanswered}`],
    ["e2e   of which -> request sent", e.focus.toRequestFrameMs ? ms(e.focus.toRequestFrameMs) : na],
    ["e2e   page handled the reply", e.focus.handledMs ? `${ms(e.focus.handledMs)} (held behind the press's frame)` : na],
    ["e2e Open in herdr -> fetch", e.focus.toFetchMs.n ? ms(e.focus.toFetchMs) : "none (no HTTP)"],
    ["e2e Open in herdr -> confirmed", `${ms(e.focus.confirmedMs)}  unconfirmed ${e.focus.unconfirmed}  missed ${e.focus.missed}  unreachable ${e.focus.unreachable}`],
    ["e2e renders (mutation batches)", `${e.renders.batchesPerSec}/s  frames with mutations ${e.renders.framesWithMutationsPerSec}/s  records ${e.renders.recordsPerSec}/s`],
    ["e2e main thread", `busy ${e.mainThread.busyPct}%  script ${e.mainThread.scriptMs} ms  layout ${e.mainThread.layoutMs} ms (${e.mainThread.layouts}x)  style ${e.mainThread.styleMs} ms (${e.mainThread.styleRecalcs}x)`],
    ["e2e long tasks", `${e.longTasks.count} (longest ${e.longTasks.longestMs} ms, total ${e.longTasks.totalMs} ms, >100ms ${e.longTasks.over100ms}x); long frames ${e.longFrames.count}, longest ${e.longFrames.longestMs} ms`],
    ["e2e frames", `${e.frames.perSec}/s  gap p50 ${e.frames.gapMs.p50}  p95 ${e.frames.gapMs.p95}  max ${e.frames.gapMs.max} ms, ${e.frames.over50ms} over 50 ms`],
    [
      "e2e frames over budget",
      e.frames.tabs
        .map((f, i) => {
          const at = f.overAt.slice(0, 5).map((t) => `+${Math.round(t / 100) / 10}s`).join(" ");
          return `tab ${i + 1}: ${f.over} of ${f.frames}${at ? ` at ${at}${f.over > 5 ? " ..." : ""}` : ""} (interval ${f.intervalMs} ms, longest gap ${f.longestGapMs} ms, idle from +${Math.round(e.idle.fromMs[i]! / 100) / 10}s)`;
        })
        .join("; "),
    ],
    ["e2e requests in flight", `max ${e.requests.inFlight.max}  mean ${e.requests.inFlight.mean}; on the wire max ${e.requests.onWire.max}  mean ${e.requests.onWire.mean}${e.protocol === "sse" ? " (+1 stream per tab)" : ""}`],
    ["e2e wait for a connection", `${ms(e.requests.waitForConnectionMs)}  ${e.requests.perSec} requests/s`],
    ["e2e socket frames sent", e.ws ? tally(e.ws.sent) : na],
    ["e2e socket frames received", e.ws ? tally(e.ws.received) : na],
    ["e2e idle window", e.idle.tabs.map((t, i) => `tab ${i + 1}: ${Math.round(t.ms / 100) / 10} s, ${t.resources} resources, ${t.fetches} fetches, ${t.socketFramesSent} frames sent`).join("; ")],
    ["e2e   idle frames received", e.ws ? tally(e.idle.received) : na],
    ["e2e server", `ping ${ms(e.server.pingMs)}  CPU ${e.server.cpuPercent}%  loop lag p95 ${e.server.loopLagMs.p95} ms  sync spawns ${e.server.syncSpawnBlockedPercent}% of the window`],
  );
  for (const [kind, r] of Object.entries(e.requests.byKind)) {
    rows.push([`  ${kind}`, `${r.perSec}/s  ${ms(r.totalMs)}  wait mean ${r.waitMeanMs} ms`]);
  }
}
const width = Math.max(...rows.map(([k]) => k.length));
console.log(`\nlag bench: ${result.revision} (${repo}), load average at start ${loadavgAtStart.join(" ")}`);
for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);

// The gates: an end-to-end run fails when any one is missed.
const gates = e2eResult?.gates ?? null;
if (gates) {
  if (idleS * 1000 < IDLE_MIN_MS) console.log(`\n--idle ${idleS} is under the polling gate's ${IDLE_MIN_MS / 1000} s`);
  console.log(`\ngates (RTT ${rttMs} ms):`);
  for (const line of formatGates(gates)) console.log(`  ${line}`);
}

if (outPath) {
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${outPath}`);
}
process.exit(gates && gates.some((gate) => !gate.pass) ? 1 : 0);
