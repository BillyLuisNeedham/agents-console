/**
 * The conformance suite's runner (ADR-0036):
 *
 *   bun run conformance --server bun|rust [--rust-bin <path>] [--fast] [<bun test arguments>]
 *
 * Runs every test under conformance/ against the chosen server, Bun's
 * (`bun run engine/server.ts`) or Rust's (`<binary> server`, by default
 * target/release/agent-console), and prints the pass share per contract
 * area. `--fast` skips the slow cases, those that wait out a real timer of
 * ten seconds or more, and counts them as not run. Anything after the
 * options goes to `bun test` as it is: a file filter, or `-t <pattern>` for
 * a name.
 *
 * Exit codes: 0 when every case that ran passed; 1 when one failed or
 * `bun test` itself did; 2 when the chosen server cannot run at all (the
 * Rust binary not built yet), which is reported as such and never counted
 * as failures.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countByArea, formatReport, parseJunit } from "./report.ts";
import { serverChoice, serverMissing } from "./harness/server.ts";

const USAGE = "usage: bun run conformance --server bun|rust [--rust-bin <path>] [--fast] [<bun test arguments>]";

const args = process.argv.slice(2);
const passthrough: string[] = [];
let server: string | undefined;
let rustBin: string | undefined;
let fast = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--server") server = args[++i];
  else if (arg.startsWith("--server=")) server = arg.slice("--server=".length);
  else if (arg === "--rust-bin") rustBin = args[++i];
  else if (arg.startsWith("--rust-bin=")) rustBin = arg.slice("--rust-bin=".length);
  else if (arg === "--fast") fast = true;
  else if (arg === "--help" || arg === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else passthrough.push(arg);
}
if (server !== "bun" && server !== "rust") {
  console.error(USAGE);
  process.exit(1);
}

const env: Record<string, string | undefined> = { ...process.env, CONFORMANCE_SERVER: server };
if (rustBin !== undefined) env.CONFORMANCE_RUST_BIN = rustBin;
else delete env.CONFORMANCE_RUST_BIN;
if (fast) env.CONFORMANCE_FAST = "1";
else delete env.CONFORMANCE_FAST;
const choice = serverChoice(env);
const missing = serverMissing(choice);
const title =
  choice.kind === "bun"
    ? "conformance against the Bun server (engine/server.ts)"
    : `conformance against the Rust server (${choice.rustBin})`;
if (missing) {
  console.log(`${missing}.\nEvery case that needs a server is listed below as not run; none has failed.\n`);
}

// Every temporary file of the run, worlds included, goes under one
// directory deleted at the end: a case that times out is abandoned before
// its teardown, so this is what keeps it from leaving its world behind.
// Short-named, since a fake herdr's socket path under it must stay inside
// the 104 bytes macOS allows.
const runTmp = realpathSync(mkdtempSync(join(tmpdir(), "cf-")));
env.TMPDIR = runTmp;
const junit = join(runTmp, "report.xml");

// From the suite's own directory, so its bunfig.toml (not the root's, with
// the engine's test preload) is the one in force.
const run = Bun.spawn(
  [process.execPath, "test", "--reporter=junit", `--reporter-outfile=${junit}`, ...passthrough],
  { cwd: import.meta.dir, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
const code = await run.exited;
const report = existsSync(junit) ? readFileSync(junit, "utf8") : null;
if (process.env.CONFORMANCE_KEEP === "1") console.error(`kept the run's temporary files at ${runTmp}`);
else rmSync(runTmp, { recursive: true, force: true });

if (report === null) {
  console.error(`\nbun test exited ${code} without writing its report`);
  process.exit(code === 0 ? 1 : code);
}
const results = parseJunit(report);
const counts = countByArea(results);
console.log(`\n${formatReport(title, counts, results)}`);

const failed = counts.some((count) => count.fail > 0);
if (failed || code !== 0) process.exit(1);
if (missing) process.exit(2);
process.exit(0);
