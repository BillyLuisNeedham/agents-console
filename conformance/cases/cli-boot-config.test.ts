/**
 * What Boot reads and writes in a pool (the inventory's `cli` rows from
 * boot-cli.test.ts's "detection", "prefill", "console.json", "AGENT.md",
 * "AGENT.md refresh" and "Setups"), run as a process: the detected lines it
 * prints, the console.json it merges, the AGENT.md and verify.md it writes
 * or refreshes, and the Setup and Machine defaults it saves.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld, DONE_TICKET, MACHINE, readJson } from "../harness/cli.ts";
import { CHECKOUT } from "../harness/server.ts";

const BOOT = ["--yes", "--no-open", "--port", "0"];
const ASK = ["--no-open", "--port", "0"];

/** The marker between the engine's half of AGENT.md and the pool's. */
const CONFIG_MARKER = "<!-- ============================================================ CONFIG -->";
const TEMPLATES = join(CHECKOUT, "skills", "my-console-runner");
const AGENT_TEMPLATE = readFileSync(join(TEMPLATES, "AGENT.template.md"), "utf8");
const VERIFY_TEMPLATE = readFileSync(join(TEMPLATES, "verify.template.md"));
/** The template through its CONFIG marker: the engine's half, as Boot writes it. */
const TEMPLATE_HEAD = AGENT_TEMPLATE.slice(0, AGENT_TEMPLATE.indexOf(CONFIG_MARKER) + CONFIG_MARKER.length);
const DEFAULT_CHECKPOINT = "a device, an external write, an undecided decision, or a material guess";

/** The whole AGENT.md Boot writes for a new pool. */
function agentMd(fill: { contextFiles: string[]; prefix: string | null; constraints: string[] }): string {
  const context =
    fill.contextFiles.length > 0
      ? fill.contextFiles.map((name) => `- \`${name}\`: (what it is for)`).join("\n")
      : "- (none found beside `issues/`; name them here as they arrive)";
  const constraints =
    fill.constraints.length > 0
      ? fill.constraints.join("\n")
      : "- (secrets files, external systems, environment quirks, known-red tests)";
  return `${TEMPLATE_HEAD}

Boot filled this in from detection and its interview. The \`my-console-runner\` skill
improves the prose; the engine's half above the marker stays as it is.

## Read before you touch anything

In this order: your ticket, then the files this pool's context lives in.

${context}

## Commit message format

\`\`\`
${fill.prefix ?? "<prefix>"}: <what changed, in the imperative>
\`\`\`

## This pool's constraints

${constraints}

## Which tickets are expected to stop

- (name them, so a checkpoint on those reads as correct rather than as a failure)
`;
}

// An engine half from before issue #155, and a pool half whose odd bytes
// (trailing spaces, CRLF, a non-ASCII character, no final newline) must all
// come back exactly.
const OLD_HEAD = "# Runner agent instructions\n\n## Your role\n\nYou are an **orchestrator**. Delegate to the subagents in your roster.\n\n";
const POOL_HALF = "\n\n## Read before you touch anything  \r\n- `SPEC.md`: the spec, café\n\n## Notes";

// detection

conformance("cli", "Boot reads the commit prefix the repository actually writes", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["no prefix here", "feat: three", "fix: two", "feat: one"] });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(", commit prefix feat\n");
  expect(readFileSync(join(top, ".scratch", "main", "AGENT.md"), "utf8")).toContain(
    "\n```\nfeat: <what changed, in the imperative>\n```\n",
  );
});

conformance("cli", "Boot detects no commit prefix when the repository writes none", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["one", "two"] });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(", commit prefix none\n");
});

conformance("cli", "Boot counts a scoped commit prefix as its type", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["feat(ui): one", "feat(ui)!: two"] });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(", commit prefix feat\n");
});

conformance("cli", "Boot lists the pool's context files and leaves the template's own out", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const pool = w.dir("pool");
  w.write("pool/issues/01.md", DONE_TICKET);
  for (const name of ["SPEC.md", "AGENT.md", "verify.md", "NOTES.md"]) w.write(`pool/${name}`, "x");
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(", context files NOTES.md, SPEC.md, commit prefix");
});

// prefill

conformance("cli", "Boot takes the pool config over the Setup, and the Setup over machine defaults", async (t) => {
  const w = cliWorld(t, {
    machineDefaults: { harness: "opencode", model: "machine-model", drivers: "implement" },
    setups: { s: { defaults: { harness: "cursor", model: "setup-model" }, resolver: "cursor" } },
  });
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: { harness: "claude" } }));
  const run = await w.run("boot", [pool, "--setup", "s", ...BOOT]);
  expect(run.code).toBe(0);
  const config = readJson(join(pool, "console.json"));
  expect(config.defaults).toEqual({ harness: "claude", model: "setup-model", drivers: "implement" });
  expect(config.resolver).toBe("cursor");
});

conformance("cli", "Boot carries effort field by field from the pool, the Setup and the machine", async (t) => {
  const w = cliWorld(t, { machineDefaults: { effort: "low" }, setups: { s: { defaults: { effort: "high" } } } });
  const pools = {
    setup: { harness: "claude", model: "m" },
    pool: { harness: "claude", model: "m", effort: "max" },
    machine: { harness: "claude", model: "m" },
  };
  for (const [name, defaults] of Object.entries(pools)) {
    w.write(`${name}/console.json`, JSON.stringify({ defaults }));
  }
  expect((await w.run("boot", [w.path("setup"), "--setup", "s", ...BOOT])).code).toBe(0);
  expect((await w.run("boot", [w.path("pool"), ...BOOT])).code).toBe(0);
  expect((await w.run("boot", [w.path("machine"), ...BOOT])).code).toBe(0);
  const effort = (name: string) => (readJson(w.path(name, "console.json")).defaults as Record<string, unknown>).effort;
  expect([effort("setup"), effort("pool"), effort("machine")]).toEqual(["high", "max", "low"]);
});

conformance("cli", "Boot never lets a Setup carry a port into the next pool", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE, setups: { s: { port: 9000, defaults: { harness: "claude" } } } });
  const fresh = w.dir("fresh");
  w.write("fresh/issues/01.md", DONE_TICKET);
  const pinned = w.dir("pinned");
  w.write("pinned/console.json", JSON.stringify({ port: 9000 }));
  expect((await w.run("boot", [fresh, "--setup", "s", ...BOOT])).code).toBe(0);
  expect((await w.run("boot", [pinned, ...BOOT])).code).toBe(0);
  expect("port" in readJson(join(fresh, "console.json"))).toBe(false);
  expect(readJson(join(pinned, "console.json")).port).toBe(9000);
});

// console.json

conformance("cli", "Boot merges its answers over console.json and keeps assign and unknown keys", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  const assign = { "04": { harness: "claude", verify: 2 } };
  w.write(
    "pool/console.json",
    JSON.stringify({
      defaults: { harness: "opencode", effort: "high", drivers: "implement" },
      assign,
      selection: "human",
      port: 9001,
    }),
  );
  w.write("pool/issues/01.md", DONE_TICKET);
  const run = await w.run("boot", [pool, ...ASK], { answers: [["default model", "new-model"]] });
  expect(run.code).toBe(0);
  expect(run.prompts).toContain("default model");
  const config = readJson(join(pool, "console.json"));
  expect(config.defaults).toEqual({ harness: "opencode", effort: "high", drivers: "implement", model: "new-model" });
  expect(config.assign).toEqual(assign);
  expect(config.selection).toBe("human");
  expect(config.port).toBe(9001);
});

conformance("cli", "Boot drops a retired roster and agents on write, and never offers them", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write(
    "pool/console.json",
    JSON.stringify({
      defaults: { harness: "claude", model: "m" },
      roster: "- deepseek",
      agents: '{"deepseek":{}}',
      reviewer: "r",
    }),
  );
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  const config = readJson(join(pool, "console.json"));
  expect("roster" in config).toBe(false);
  expect("agents" in config).toBe(false);
  expect(config.reviewer).toBe("r");
  expect(run.stdout).not.toMatch(/roster|agents/);
});

conformance("cli", "Boot refuses a console.json that is there but does not parse", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const pool = w.dir("pool");
  const file = w.write("pool/console.json", "{ not json");
  const run = await w.run("boot", [pool, "--yes"]);
  expect(run.code).toBe(1);
  // The parser's own words in the brackets are the build's, not the contract.
  expect(run.stderr).toMatch(
    new RegExp(`^${escape(file)} does not parse as JSON \\(.+\\); fix it or move it aside, then boot again\\n$`),
  );
  expect(readFileSync(file, "utf8")).toBe("{ not json");
});

// AGENT.md

conformance("cli", "Boot writes AGENT.md as the template above the marker and its answers below it", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["feat: one", "feat: two"] });
  w.write("repo/.scratch/p/issues/01.md", DONE_TICKET);
  w.write("repo/.scratch/p/SPEC.md", "# Spec\n");
  const run = await w.run("boot", ASK, {
    cwd: top,
    answers: [
      ["reviewer and its authority", "acceptance criteria only"],
      ["what counts as a checkpoint here", "a device or an external write"],
    ],
  });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("wrote AGENT.md from the template\n");
  const written = readFileSync(join(top, ".scratch", "p", "AGENT.md"), "utf8");
  expect(written.startsWith(TEMPLATE_HEAD)).toBe(true);
  expect(written).toBe(
    agentMd({
      contextFiles: ["SPEC.md"],
      prefix: "feat",
      constraints: ["- reviewer: acceptance criteria only", "- checkpoint: a device or an external write"],
    }),
  );
});

conformance("cli", "Boot keeps AGENT.md's placeholder prefix when the repository writes none", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["one", "two"] });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  const written = readFileSync(join(top, ".scratch", "main", "AGENT.md"), "utf8");
  expect(written).toContain("<prefix>: <what changed, in the imperative>");
  expect(written).toContain("- (none found beside `issues/`; name them here as they arrive)");
});

// AGENT.md refresh

conformance("cli", "Boot replaces AGENT.md's old engine half and keeps the pool's half byte for byte", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: MACHINE }));
  const file = w.write("pool/AGENT.md", `${OLD_HEAD}${CONFIG_MARKER}${POOL_HALF}`);
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  expect(readFileSync(file).equals(Buffer.from(`${TEMPLATE_HEAD}${POOL_HALF}`, "utf8"))).toBe(true);
});

conformance("cli", "Boot leaves a configured pool's AGENT.md with no marker unwritten", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: MACHINE }));
  const file = w.write("pool/AGENT.md", "# Hand written\n\nNo marker here.\n");
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(file, past, past);
  const mtime = statSync(file).mtimeMs;
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("# Hand written\n\nNo marker here.\n");
  expect(statSync(file).mtimeMs).toBe(mtime);
});

conformance("cli", "Boot refreshes an outdated AGENT.md and says so, then finds it current", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: MACHINE }));
  const file = w.write("pool/AGENT.md", `${OLD_HEAD}${CONFIG_MARKER}${POOL_HALF}`);
  const first = await w.run("boot", [pool, ...BOOT]);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("refreshed AGENT.md above the CONFIG marker from the template\n");
  expect(readFileSync(file, "utf8")).toBe(`${TEMPLATE_HEAD}${POOL_HALF}`);
  await w.stopServers();

  const second = await w.run("boot", [pool, ...BOOT]);
  expect(second.code).toBe(0);
  expect(second.stdout).not.toContain("AGENT.md");
});

conformance("cli", "Boot leaves an AGENT.md with no marker exactly as it was, and says so", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: MACHINE }));
  const handWritten = "# Our own instructions\n\nYou are an orchestrator.\n";
  const file = w.write("pool/AGENT.md", handWritten);
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("AGENT.md has no CONFIG marker; left as it is\n");
  expect(readFileSync(file, "utf8")).toBe(handWritten);
});

conformance("cli", "Boot writes an AGENT.md whose engine half prescribes no method", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  const written = readFileSync(join(top, ".scratch", "main", "AGENT.md"), "utf8");
  const marker = written.indexOf(CONFIG_MARKER);
  expect(marker).toBeGreaterThan(0);
  expect(written.slice(0, marker)).not.toMatch(/orchestrat|subagent|delegat|roster|dispatch/i);
});

conformance("cli", "Boot creates no AGENT.md for a configured pool that has none", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/console.json", JSON.stringify({ defaults: MACHINE }));
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(0);
  expect(existsSync(join(pool, "AGENT.md"))).toBe(false);
});

// Setups

conformance("cli", "Boot saves a Setup of the behavioural keys only", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  w.write("pool/issues/01.md", DONE_TICKET);
  w.write(
    "pool/console.json",
    JSON.stringify({
      defaults: { harness: "claude", model: "m" },
      assign: { "01": { harness: "cursor" } },
      roster: "- one",
      agents: "{}",
      resolver: "claude",
      terminal: "herdr",
      reviewer: "r",
      checkpoint: "c",
      port: 9001,
    }),
  );
  const run = await w.run("boot", [pool, ...ASK], { answers: [["save this Setup as", "My Build  Setup"]] });
  expect(run.code).toBe(0);
  const file = join(w.home, ".agent-graphs", "setups", "my-build-setup.json");
  expect(run.stdout).toContain(`saved Setup my-build-setup to ${file}\n`);
  expect(Object.keys(readJson(file)).sort()).toEqual(["checkpoint", "defaults", "resolver", "reviewer", "terminal"]);
});

// Gaps the inventory lists for `cli` (Visible behaviour no test covers yet).

conformance("cli", "Boot refuses a console.json that is not JSON, or not an object, and starts no server", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const broken = w.write("broken/console.json", "{ not json");
  const array = w.write("array/console.json", "[]");
  const first = await w.run("boot", [w.path("broken"), "--yes", "--no-open"]);
  const second = await w.run("boot", [w.path("array"), "--yes", "--no-open"]);
  expect(first.code).toBe(1);
  expect(first.stderr).toMatch(new RegExp(`^${escape(broken)} does not parse as JSON \\(.+\\); fix it or move it aside`));
  expect(second.code).toBe(1);
  expect(second.stderr).toBe(`${array} must be a JSON object\n`);
  expect(readFileSync(broken, "utf8")).toBe("{ not json");
  expect(readFileSync(array, "utf8")).toBe("[]");
  expect(existsSync(w.path("broken", "runs"))).toBe(false);
  expect(existsSync(w.path("array", "runs"))).toBe(false);
});

conformance("cli", "Boot on a hand-made pool reports what it detected and writes AGENT.md and verify.md from the templates", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["feat: one", "feat: two", "fix: three"] });
  w.write("repo/.scratch/p/issues/01.md", DONE_TICKET);
  w.write("repo/.scratch/p/SPEC.md", "# Spec\n");
  w.write("repo/.scratch/p/NOTES.md", "# Notes\n");
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(
    "detected: 1 ticket(s), conversations/ absent, context files NOTES.md, SPEC.md, commit prefix feat\n",
  );
  const pool = join(top, ".scratch", "p");
  expect(readFileSync(join(pool, "AGENT.md"), "utf8")).toBe(
    agentMd({ contextFiles: ["NOTES.md", "SPEC.md"], prefix: "feat", constraints: [`- checkpoint: ${DEFAULT_CHECKPOINT}`] }),
  );
  expect(readFileSync(join(pool, "verify.md")).equals(VERIFY_TEMPLATE)).toBe(true);
});

conformance("cli", "Boot writes Machine defaults once, from the first pool, and never again", async (t) => {
  const w = cliWorld(t, { setups: { s: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" } } });
  const file = join(w.home, ".agent-graphs", "defaults.json");
  const first = w.dir("first");
  w.write("first/issues/01.md", DONE_TICKET);
  const run = await w.run("boot", [first, "--setup", "s", ...BOOT]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`wrote machine defaults to ${file}; the Console's Settings own it from now on\n`);
  const written = readJson(file);
  expect(written).toMatchObject({ harness: "claude", model: "m", drivers: "implement", terminal: "herdr" });
  expect(Object.keys(written).sort()).toEqual(["drivers", "engine", "harness", "model", "terminal"]);
  expect(typeof written.engine).toBe("string");

  const bytes = readFileSync(file);
  const second = w.dir("second");
  w.write("second/console.json", JSON.stringify({ defaults: { harness: "opencode", model: "other", effort: "max" } }));
  const again = await w.run("boot", [second, ...BOOT]);
  expect(again.code).toBe(0);
  expect(again.stdout).not.toContain("machine defaults");
  expect(readFileSync(file).equals(bytes)).toBe(true);
});

conformance("cli", "Boot copies verify.md from the template for a new pool, and keeps one already there", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const bare = w.dir("bare");
  w.write("bare/issues/01.md", DONE_TICKET);
  const kept = w.dir("kept");
  w.write("kept/issues/01.md", DONE_TICKET);
  const ours = w.write("kept/verify.md", "# our own verify\n");

  const first = await w.run("boot", [bare, ...BOOT]);
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("wrote verify.md from the template\n");
  expect(readFileSync(join(bare, "verify.md")).equals(VERIFY_TEMPLATE)).toBe(true);

  const second = await w.run("boot", [kept, ...BOOT]);
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("verify.md is already there; left as it is\n");
  expect(readFileSync(ours, "utf8")).toBe("# our own verify\n");
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
