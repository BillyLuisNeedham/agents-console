/**
 * Boot's Line mode on a Plan (ADR-0037, ADR-0038, ADR-0040), run as a process: `--plan <slug>` loads
 * a Preset or a library Plan, Boot cuts `line/<slug>` from its Line base (issue #193: the branch
 * the operator's checkout has out, unless --from names another) into a worktree of its own under
 * `.scratch/lines/`, leaving that checkout's branch alone, makes the pool inside that worktree and
 * begins the Line on the Plan through POST /api/line. Given a ready brief it commits the brief and
 * its spec onto the Line branch first and asks nothing; asked for the work, it hands the work over
 * and the engine opens the entry Conversation node's first pass on it. `--brief` alone runs the
 * factory-today Preset.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineFile } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { cliWorld, type CliWorld } from "../harness/cli.ts";
import { startHerdr } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";
import { smallPlan } from "./plans-support.ts";

const MACHINE = { harness: "claude", model: "m", drivers: "implement" };
const SPEC = "# A Continued attempt's checkpoint drops its spawns (issue #186)\n\nThe spec.\n";
const BRIEF = { spec: "pilots/186.md", finish: "draft-pr" };

/**
 * A checkout with a feature branch out, one commit ahead of main, and the pilot's brief and spec beside
 * it, uncommitted.
 */
function checkout(w: CliWorld): string {
  const repo = w.repo("repo");
  const git = (args: string[]): string =>
    Bun.spawnSync(["git", ...args], { cwd: repo, env: w.env(), stdout: "pipe" }).stdout.toString().trim();
  git(["checkout", "-q", "-b", "feature/x"]);
  git(["commit", "-q", "--allow-empty", "-m", "feature work"]);
  w.write("repo/pilots/186.md", SPEC);
  w.write("repo/pilots/186.brief.json", JSON.stringify(BRIEF));
  return repo;
}

function gitIn(w: CliWorld, dir: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: dir, env: w.env(), stdout: "pipe", stderr: "pipe" });
  return run.stdout.toString().trim();
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

conformance("cli", "Boot --plan --brief cuts the Line from the current branch into its own worktree, commits the spec and brief there and begins the Line on the Plan, asking nothing", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);
  w.write("repo/steward.json", JSON.stringify({ steward: { budget: 10, mayAdoptLineSpawns: true } }));

  const run = await w.run(
    "boot",
    [
      "--plan", "factory-today", "--brief", "pilots/186.brief.json", "--title", "Pilot 186",
      "--config", "steward.json", "--no-open", "--port", "0",
    ],
    { cwd: repo },
  );
  expect(run.code, run.stderr).toBe(0);
  expect(run.prompts).toEqual([]);
  const tree = join(repo, ".scratch", "lines", "186");
  const base = gitIn(w, repo, ["rev-parse", "feature/x"]);
  expect(run.stdout).toContain(`line: cut line/186 from feature/x (${base.slice(0, 7)}) at ${tree}\n`);
  expect(run.stdout).toContain("line: committed docs/specs/186.brief.json and its spec onto line/186\n");
  expect(run.stdout).toContain('line: begun on the Plan factory-today ("Factory today")\n');
  expect(run.stdout).not.toContain("no --plan");

  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");
  expect(gitIn(w, tree, ["branch", "--show-current"])).toBe("line/186");
  expect(gitIn(w, tree, ["log", "-1", "--format=%s"])).toBe("Write down the spec and the Line brief for line/186");
  expect(gitIn(w, repo, ["rev-parse", "line/186~1"])).toBe(base);
  expect(JSON.parse(gitIn(w, repo, ["show", "line/186:docs/specs/186.brief.json"]))).toEqual({
    ...BRIEF,
    spec: "docs/specs/186.md",
  });
  expect(gitIn(w, repo, ["show", "line/186:docs/specs/186.md"])).toBe(SPEC.trimEnd());

  const pool = join(tree, ".scratch", "186");
  const config = readJson(join(pool, "console.json"));
  expect(config).toMatchObject({
    title: "Pilot 186",
    terminal: "herdr",
    steward: { budget: 10, mayAdoptLineSpawns: true },
    lineBase: { ref: "feature/x", commit: base },
  });
  expect(config).not.toHaveProperty("factoryPool");
  const line = readJson(join(pool, "line.json")) as LineFile;
  expect(line).toMatchObject({
    horde: 1,
    places: { branch: "line/186", base: { ref: "feature/x", commit: base }, spec: "docs/specs/186.md" },
  });
  expect(line.plan.name).toBe("Factory today");
  expect(line.plan.nodes.find((n) => n.id === "finish")).toMatchObject({ act: "draft-pr" });
  const implement = await until(
    () => readFileSync(join(pool, "issues", "implement-1.md"), "utf8"),
    (text) => text.length > 0,
    { what: "implement-1 to be written" },
  );
  expect(implement.split("\n", 1)[0]).toContain("id=implement-1 blocked-by=none");
  expect(implement.split("\n", 1)[0]).toContain(" node=implement ");

  // A Line branch is never reused: the same brief again is a Line of its own, on the default Plan.
  const again = await w.run("boot", ["--brief", "pilots/186.brief.json", "--no-steward", "--no-open", "--port", "0"], {
    cwd: repo,
  });
  expect(again.code, again.stderr).toBe(0);
  expect(`${again.stdout}${again.stderr}`).not.toContain("steward");
  expect(again.stdout).toContain("no --plan: the Line runs the factory-today Preset\n");
  expect(again.stdout).toContain(`line: cut line/186-2 from feature/x (${base.slice(0, 7)}) at `);
  expect(readJson(join(repo, ".scratch", "lines", "186-2", ".scratch", "186-2", "console.json"))).toMatchObject({
    title: "A Continued attempt's checkpoint drops its spawns (issue #186)",
  });
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");
});

conformance("cli", "Boot --plan asks for the work, cuts the Line and begins it on the work, and the engine opens grill-1 with the issue in its first Turn", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);
  writeFileSync(join(w.bin, "claude"), "#!/bin/sh\nexec sleep 150\n");
  chmodSync(join(w.bin, "claude"), 0o755);
  const herdr = await startHerdr(w.env(), { rendered: "Claude Code v · Ask anything\n❯ " });
  t.defer(() => herdr.stop());
  symlinkSync(herdr.socketPath, w.path("no-herdr.sock"));

  const run = await w.run("boot", ["--plan", "factory-today", "--no-open", "--port", "0"], {
    cwd: repo,
    answers: [["the piece of work", "#186"]],
    timeoutMs: 60_000,
  });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.prompts[0]).toBe("the piece of work (an issue number or free text)");
  expect(run.prompts[1]).toBe("title for the Line's pool [Issue #186]");
  const base = gitIn(w, repo, ["rev-parse", "feature/x"]);
  expect(run.stdout).toContain(`line: cut line/186 from feature/x (${base.slice(0, 7)}) at `);
  expect(run.stdout).toContain('line: begun on the Plan factory-today ("Factory today")\n');
  expect(run.stdout).toContain("line: grill-1 opens on the work\n");
  expect(run.stdout).not.toContain("grill: ");
  expect(run.stdout).toContain("steward: conv-1 on duty; it never answers the Finish\n");
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");

  const pool = join(repo, ".scratch", "lines", "186", ".scratch", "186");
  expect(readJson(join(pool, "console.json"))).toMatchObject({
    title: "Issue #186",
    terminal: "herdr",
    lineBase: { ref: "feature/x", commit: base },
  });
  expect(readJson(join(pool, "line.json"))).toMatchObject({ places: { branch: "line/186", work: "#186" } });
  expect(existsSync(join(pool, "issues", "implement-1.md"))).toBe(false);
  const steward = readFileSync(join(pool, "conversations", "conv-1.md"), "utf8");
  expect(steward.split("\n", 1)[0]).toContain(" role=steward ");
  expect(steward).toContain("Steward this pool's Line while the operator is away");
  const grillFile = join(pool, "conversations", "grill-1.md");
  const record = await until(
    () => (existsSync(grillFile) ? readFileSync(grillFile, "utf8") : ""),
    (text) => text.length > 0,
    { what: "grill-1's record" },
  );
  expect(record.split("\n", 1)[0]).toContain(" node=grill ");
  expect(record).toContain("# Grill, pass 1\n");
  const typed = await until(
    () => herdr.control<string[]>("submitted"),
    (texts) => texts.some((text) => text.includes("(`grill-1`)")),
    { what: "grill-1's first Turn" },
  );
  const first = typed.find((text) => text.includes("(`grill-1`)"))!;
  expect(first).toStartWith("You are the Grill Conversation (`grill-1`) of this pool's Line (ADR-0040)");
  expect(first).toContain(
    "## The Line's work\n\nThe piece of work for this Line is issue #186. Read it (gh issue view 186) and grill me on " +
      `it.\n\nThis Line was cut from \`feature/x\` at \`${base.slice(0, 7)}\`.`,
  );
  expect(first).toContain("write the spec at `docs/specs/186.md` and the Line brief at `docs/specs/186.grill-1.brief.json`");
});

conformance("cli", "Boot's Line mode refuses --factory, an unknown Plan, no work unattended and a brief whose spec is nowhere, before cutting anything", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);

  const factory = await w.run("boot", ["--factory", "--yes", "--no-open"], { cwd: repo });
  expect(factory.code).toBe(1);
  expect(factory.stderr.split("\n", 1)[0]).toBe("unknown flag --factory");

  const unknown = await w.run("boot", ["--plan", "nope", "--work", "#1", "--yes", "--no-open"], { cwd: repo });
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toStartWith("--plan nope: ");

  const noWork = await w.run("boot", ["--plan", "factory-today", "--yes", "--no-open"], { cwd: repo });
  expect(noWork.code).toBe(1);
  expect(noWork.stderr).toBe("Line mode needs the work: --work <issue number or text>, or --brief <path>\n");

  w.write("repo/pilots/lost.brief.json", JSON.stringify({ spec: "nowhere.md" }));
  const lost = await w.run("boot", ["--brief", "pilots/lost.brief.json", "--no-open"], { cwd: repo });
  expect(lost.code).toBe(1);
  expect(lost.stderr).toBe(
    `--brief pilots/lost.brief.json: its spec nowhere.md is neither under ${repo} nor beside the brief\n`,
  );

  expect(existsSync(join(repo, ".scratch", "lines"))).toBe(false);
  expect(gitIn(w, repo, ["branch", "--list", "line/*"])).toBe("");
});

const PRESET_SLUGS =
  "factory-today, matt-pocock-main, matt-pocock-quick, matt-pocock-bug, matt-pocock-foggy, pstack-feature, pstack-bug-fix, pclaude-feature, pclaude-bug-fix, addy-commands, addy-bug-fix";

function libraryWorld(t: Parameters<typeof cliWorld>[0]): { w: CliWorld; repo: string } {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);
  w.write("home/.agent-graphs/plans/zz-mine.json", JSON.stringify(smallPlan("Mine")));
  w.write("home/.agent-graphs/plans/aa-broken.json", JSON.stringify({ horde: 1, name: "Broken", nodes: [], edges: [] }));
  return { w, repo };
}

const STOP_AFTER_PLAN_LOAD = ["--from", "no-such-branch", "--title", "T", "--no-open"];

conformance("cli", "Boot --work alone asks which Plan, listing the Presets in order then the library, and runs the one picked", async (t) => {
  const { w, repo } = libraryWorld(t);
  const run = await w.run("boot", ["--work", "186", ...STOP_AFTER_PLAN_LOAD], { cwd: repo, answers: [["start from which plan", "zz-mine"]] });
  expect(run.code).toBe(1);
  expect(run.prompts).toEqual(["start from which plan [factory-today]"]);
  expect(run.stdout).toContain(`Plans: ${PRESET_SLUGS}, zz-mine\n`);
  expect(run.stderr).toContain("not offering aa-broken: ");
  expect(run.stdout).toContain('plan: zz-mine ("Mine")\n');
  expect(run.stdout).not.toContain("no --plan");
  expect(run.stdout.indexOf("Plans:")).toBeLessThan(run.stdout.indexOf("plan: zz-mine"));
  expect(run.stderr).toContain("--from no-such-branch");
  expect(existsSync(join(repo, ".scratch", "lines"))).toBe(false);
});

conformance("cli", "Boot asks again for a Plan it does not offer, and Enter takes factory-today", async (t) => {
  const { w, repo } = libraryWorld(t);
  const run = await w.run("boot", ["--work", "186", ...STOP_AFTER_PLAN_LOAD], {
    cwd: repo,
    answers: [
      ["start from which plan", "nope"],
      ["start from which plan", "aa-broken"],
      ["start from which plan", ""],
    ],
  });
  expect(run.code).toBe(1);
  expect(run.prompts).toEqual(Array(3).fill("start from which plan [factory-today]"));
  expect(run.stderr).toContain("no Plan named nope\n");
  expect(run.stderr).toContain("no Plan named aa-broken\n");
  expect(run.stdout).toContain('plan: factory-today ("Factory today")\n');
});

conformance("cli", "Boot takes factory-today when the answer is end of input", async (t) => {
  const { w, repo } = libraryWorld(t);
  const run = await w.run("boot", ["--work", "186", ...STOP_AFTER_PLAN_LOAD], { cwd: repo, stdin: "" });
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("start from which plan [factory-today]: ");
  expect(run.stdout).toContain('plan: factory-today ("Factory today")\n');
});

conformance("cli", "Boot --plan asks nothing about the Plan, and --yes takes factory-today without asking", async (t) => {
  const { w, repo } = libraryWorld(t);
  const named = await w.run("boot", ["--plan", "zz-mine", "--work", "186", ...STOP_AFTER_PLAN_LOAD], { cwd: repo });
  expect(named.code).toBe(1);
  expect(named.prompts.some((prompt) => prompt.startsWith("start from which plan"))).toBe(false);
  expect(named.stdout).not.toContain("Plans:");
  expect(named.stdout).toContain('plan: zz-mine ("Mine")\n');

  const yes = await w.run("boot", ["--work", "186", "--yes", ...STOP_AFTER_PLAN_LOAD], { cwd: repo });
  expect(yes.code).toBe(1);
  expect(yes.prompts).toEqual([]);
  expect(yes.stdout).not.toContain("Plans:");
  expect(yes.stdout).toContain(
    'no --plan: the Line runs the factory-today Preset\nplan: factory-today ("Factory today")\n',
  );
});
