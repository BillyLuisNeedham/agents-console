#!/usr/bin/env bun
/**
 * Build the render-survival page, serve it, open it in headless Chromium,
 * and print what survived the Console's re-renders. Manual, not part of
 * `bun test`: it needs a real layout engine.
 *
 *   cd ui && bun harness/run.ts            # prints the table, exits 1 on any failure
 *   cd ui && bun harness/run.ts --json     # the raw report
 *
 * Env: CHROMIUM (default /usr/bin/chromium).
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const ui = join(here, "..");
const dist = join(here, "dist");
const chromium = process.env.CHROMIUM ?? "/usr/bin/chromium";
const wantJson = process.argv.includes("--json");

interface Check {
  scenario: string;
  assertion: string;
  pass: boolean | null;
  detail: string;
}

async function run(
  cmd: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

// 1. Build
const build = await run(
  [join(ui, "node_modules/.bin/vite"), "build", "--config", join(here, "vite.config.ts")],
  ui,
  120_000,
);
if (build.code !== 0) {
  console.error(build.out, build.err);
  process.exit(build.code);
}

// 2. Serve dist on a free port (module scripts do not load over file://)
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const url = `http://127.0.0.1:${server.port}/`;

// 3. Drive Chromium and take the DOM once the page has written its report:
// the full run at a wide window, then the layout checks alone at a narrow
// one, where the canvas header and the Conversations tray are tightest.
type Report = { renders?: number; error?: string; checks: Check[] };
async function drive(size: string, query: string, dump: string): Promise<Report> {
  const chrome = await run(
    [
      chromium,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--window-size=${size}`,
      "--virtual-time-budget=15000",
      "--dump-dom",
      url + query,
    ],
    ui,
    90_000,
  );
  // The dumped page, for a look at what rendered when a check surprises you.
  await Bun.write(join(dist, dump), chrome.out);
  if (chrome.code !== 0) {
    console.error(chrome.err);
    process.exit(chrome.code);
  }
  const match = chrome.out.match(/<pre id="report" hidden(?:="")?>([^<]*)<\/pre>/);
  if (!match || !match[1]) {
    console.error(`no report in the ${size} page; Chromium stderr follows\n` + chrome.err);
    process.exit(2);
  }
  const json = new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
  return JSON.parse(json) as Report;
}
const wide = await drive("1600,1000", "", "page.html");
const narrow = await drive("1024,800", "?layout", "page-narrow.html");
server.stop(true);
const report: Report = {
  renders: wide.renders,
  error: [wide.error, narrow.error && `narrow: ${narrow.error}`].filter(Boolean).join("; ") || undefined,
  checks: [...wide.checks, ...narrow.checks],
};

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  if (report.error) console.error("page error: " + report.error);
  const width = Math.max(...report.checks.map((c) => c.assertion.length));
  let scenario = "";
  for (const c of report.checks) {
    if (c.scenario !== scenario) {
      scenario = c.scenario;
      console.log(`\n${scenario === "-" ? "not rendered anywhere" : scenario}`);
    }
    const mark = c.pass === null ? "skip" : c.pass ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${c.assertion.padEnd(width)}  ${c.detail}`);
  }
  const failed = report.checks.filter((c) => c.pass === false).length;
  const passed = report.checks.filter((c) => c.pass === true).length;
  const skipped = report.checks.filter((c) => c.pass === null).length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${report.renders ?? "?"} renders`);
}
process.exit(report.error || report.checks.some((c) => c.pass === false) ? 1 : 0);
