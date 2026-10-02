#!/usr/bin/env bun
/**
 * The lag bench's UI half (issue #157): build the bench page against a
 * checkout's real ConsoleView and ConsoleSession, open it in headless
 * Chromium at real speed (no virtual time, which would hide exactly the
 * main-thread cost being measured), and collect the report it POSTs back.
 *
 *   bun run scripts/bench-lag/ui-bench.ts                     # this checkout, a table
 *   bun run scripts/bench-lag/ui-bench.ts --repo ../other     # another checkout
 *   bun run scripts/bench-lag/ui-bench.ts --json              # the raw report
 *   bun run scripts/bench-lag/ui-bench.ts --duration 30000 --sps 1
 *
 * The page lives here, not in the checkout under test; only its `@console`
 * imports reach the checkout (ui/vite.config.ts), and the build runs that
 * checkout's own Vite so its dependencies resolve from its own ui/. Env:
 * CHROMIUM (default: the Chromium or Chrome chromium.ts finds).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireChromium } from "./chromium.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const pageDir = join(here, "ui");

interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface UiBenchResult {
  durationMs: number;
  snapshotsPerSec: number;
  cards: number;
  domNodes: number;
  renders: number;
  rendersPerSec: number;
  /** One `session.model()` plus `consoleView.render()`, the morph and the
   *  canvas edge routing included, as the app runs it per store change. */
  renderMs: { mean: number; p50: number; p95: number; max: number };
  /** `session.model()` alone, the projection share of renderMs. */
  modelMs: Stats;
  /** The same plus the style and layout the browser owes for it, forced at
   *  once rather than left to the next frame. */
  renderLayoutMs: Stats;
  /** Share of wall time spent in renderLayoutMs. */
  renderBusyPct: number;
  longestTaskMs: number;
  longTasksOver50ms: number;
  frameGapMs: { p50: number; p95: number; max: number };
  framesOver50ms: number;
  clickToDetailMs: { n: number; p50: number; p95: number; max: number };
  clickSyncMs: Stats;
  rendersDuringClicks: number;
  dragMoveMs: { n: number; mean: number; p95: number; max: number };
  dragMoveToFrameMs: Stats;
  rendersDuringDrags: number;
  sanity: {
    detailOpened: boolean;
    clicksMissed: number;
    dragMoved: boolean;
    longTaskApi: boolean;
    snapshotsPushed: number;
    focusCalls: number;
  };
  error?: string;
}

export interface UiBenchOptions {
  /** The checkout whose ui/src is measured; its ui/node_modules must be installed. */
  repo: string;
  /** How long the measured churn runs, after a 2.5 s warm-up. Default 30 s. */
  durationMs?: number;
  /** Snapshots pushed down the fake stream per second. Default 1. */
  snapshotsPerSec?: number;
  chromium?: string;
}

async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

export async function runUiBench(opts: UiBenchOptions): Promise<UiBenchResult> {
  const repo = resolve(opts.repo);
  const durationMs = opts.durationMs ?? 30_000;
  const sps = opts.snapshotsPerSec ?? 1;
  const chromium = opts.chromium ?? requireChromium();
  const work = mkdtempSync(join(tmpdir(), "bench-lag-ui-"));
  const dist = join(work, "dist");
  try {
    // 1. Build the page against the checkout under test.
    const build = await run(
      [join(repo, "ui/node_modules/.bin/vite"), "build", "--config", join(pageDir, "vite.config.ts")],
      join(repo, "ui"),
      { BENCH_REPO: repo, BENCH_OUT: dist },
      120_000,
    );
    if (build.code !== 0) throw new Error(`vite build failed:\n${build.out}\n${build.err}`);

    // 2. Serve it, and take the page's report on the same origin.
    let deliver: (body: string) => void = () => {};
    const delivered = new Promise<string>((res) => (deliver = res));
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "POST" && path === "/report") {
          deliver(await req.text());
          return new Response("ok");
        }
        const file = Bun.file(join(dist, path === "/" ? "index.html" : path));
        return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
      },
    });
    const url = `http://127.0.0.1:${server.port}/?dur=${durationMs}&sps=${sps}`;

    // 3. Real-time headless Chromium. The throttling flags keep timers and
    // frames at full rate in a window nobody is looking at.
    const chrome = Bun.spawn(
      [
        chromium,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        `--user-data-dir=${join(work, "profile")}`,
        "--window-size=1600,1000",
        url,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const limit = durationMs + 60_000;
    const timeout = new Promise<string>((_, rej) =>
      setTimeout(() => rej(new Error(`no report from the page within ${limit} ms`)), limit),
    );
    const exited = chrome.exited.then(async (code) => {
      throw new Error(`chromium exited (${code}) before the page reported:\n${await new Response(chrome.stderr).text()}`);
    });
    try {
      const body = await Promise.race([delivered, timeout, exited]);
      return JSON.parse(body) as UiBenchResult;
    } finally {
      chrome.kill();
      await chrome.exited;
      server.stop(true);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The compact table the standalone run prints. */
export function formatUiBench(r: UiBenchResult): string {
  if (r.error) return `UI bench error: ${r.error}`;
  const row = (label: string, value: string) => `  ${label.padEnd(28)} ${value}`;
  return [
    `UI (headless Chromium, ${r.cards} cards, ${r.domNodes} DOM nodes, ${r.snapshotsPerSec} snapshot/s, ${Math.round(r.durationMs / 1000)} s)`,
    row("renders/s", `${r.rendersPerSec} (${r.renders} renders)`),
    row("render ms mean/p50/p95/max", `${r.renderMs.mean} / ${r.renderMs.p50} / ${r.renderMs.p95} / ${r.renderMs.max}`),
    row("  of which model() mean/p95", `${r.modelMs.mean} / ${r.modelMs.p95}`),
    row("render+layout ms mean/p95/max", `${r.renderLayoutMs.mean} / ${r.renderLayoutMs.p95} / ${r.renderLayoutMs.max}`),
    row("main thread busy rendering", `${r.renderBusyPct}%`),
    row("longest task ms", `${r.longestTaskMs} (${r.longTasksOver50ms} long tasks)`),
    row("frame gap ms p50/p95/max", `${r.frameGapMs.p50} / ${r.frameGapMs.p95} / ${r.frameGapMs.max} (${r.framesOver50ms} > 50 ms)`),
    row("click->Detail ms p50/p95/max", `${r.clickToDetailMs.p50} / ${r.clickToDetailMs.p95} / ${r.clickToDetailMs.max} (n=${r.clickToDetailMs.n}, sync p50 ${r.clickSyncMs.p50})`),
    row("drag move ms mean/p95/max", `${r.dragMoveMs.mean} / ${r.dragMoveMs.p95} / ${r.dragMoveMs.max} (n=${r.dragMoveMs.n})`),
    row("drag move->frame ms p50/p95", `${r.dragMoveToFrameMs.p50} / ${r.dragMoveToFrameMs.p95}`),
    row("sanity", `detail ${r.sanity.detailOpened ? "opened" : "MISSED"}, drag ${r.sanity.dragMoved ? "moved" : "DID NOT MOVE"}, ${r.sanity.snapshotsPushed} snapshots`),
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const result = await runUiBench({
    repo: flag("--repo") ?? join(here, "../.."),
    ...(flag("--duration") ? { durationMs: Number(flag("--duration")) } : {}),
    ...(flag("--sps") ? { snapshotsPerSec: Number(flag("--sps")) } : {}),
  });
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : formatUiBench(result));
  process.exit(result.error ? 1 : 0);
}
