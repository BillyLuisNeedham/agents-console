/**
 * Boot's Factory mode (issue #187, ADR-0037, ADR-0038), run as a process:
 * it cuts `line/<slug>` from main into a worktree of its own under
 * `.scratch/lines/`, leaving the branch the operator's checkout has out
 * alone, and makes the Factory pool inside that worktree, so the pool's
 * target branch is the Line's. Given a ready brief it commits the brief and
 * its spec onto the Line branch and starts Round 1 at once, asking nothing;
 * asked for the work, it opens the Grill with the work as its first Turn.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld, type CliWorld } from "../harness/cli.ts";
import { startHerdr } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";

const MACHINE = { harness: "claude", model: "m", drivers: "implement" };
const SPEC = "# A Continued attempt's checkpoint drops its spawns (issue #186)\n\nThe spec.\n";
const BRIEF = { spec: "pilots/186.md", finish: "draft-pr", factory: {} };

/** A checkout on main with a feature branch out, and the pilot's brief and spec beside it, uncommitted. */
function checkout(w: CliWorld): string {
  const repo = w.repo("repo");
  const git = (args: string[]): string =>
    Bun.spawnSync(["git", ...args], { cwd: repo, env: w.env(), stdout: "pipe" }).stdout.toString().trim();
  git(["checkout", "-q", "-b", "feature/x"]);
  w.write("repo/pilots/186.md", SPEC);
  w.write("repo/pilots/186.brief.json", JSON.stringify(BRIEF));
  return repo;
}

function gitIn(w: CliWorld, dir: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: dir, env: w.env(), stdout: "pipe", stderr: "pipe" });
  return run.stdout.toString().trim();
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

conformance("cli", "Boot --brief cuts the Line from main into its own worktree, commits the spec and brief there and starts Round 1, asking nothing", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);
  w.write("repo/steward.json", JSON.stringify({ steward: { budget: 10, mayAdoptLineSpawns: true } }));

  const run = await w.run(
    "boot",
    ["--brief", "pilots/186.brief.json", "--title", "Pilot 186", "--config", "steward.json", "--no-open", "--port", "0"],
    { cwd: repo },
  );
  expect(run.code, run.stderr).toBe(0);
  expect(run.prompts).toEqual([]);
  const tree = join(repo, ".scratch", "lines", "186");
  expect(run.stdout).toContain(`line: cut line/186 from main at ${tree}\n`);
  expect(run.stdout).toContain("line: committed docs/specs/186.brief.json and its spec onto line/186\n");
  expect(run.stdout).toContain("line: started; Round 1's r1-implement is written\n");

  // The checkout Boot ran from keeps its branch; the Line has a worktree of its own.
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");
  expect(gitIn(w, tree, ["branch", "--show-current"])).toBe("line/186");
  expect(gitIn(w, tree, ["log", "-1", "--format=%s"])).toBe("Write down the spec and the Line brief for line/186");
  expect(gitIn(w, repo, ["rev-parse", "line/186~1"])).toBe(gitIn(w, repo, ["rev-parse", "main"]));
  expect(JSON.parse(gitIn(w, repo, ["show", "line/186:docs/specs/186.brief.json"]))).toEqual({
    ...BRIEF,
    spec: "docs/specs/186.md",
  });
  expect(gitIn(w, repo, ["show", "line/186:docs/specs/186.md"])).toBe(SPEC.trimEnd());

  // The pool lives inside the Line's worktree, so its target branch is the Line's.
  const pool = join(tree, ".scratch", "186");
  expect(readJson(join(pool, "console.json"))).toMatchObject({
    title: "Pilot 186",
    terminal: "herdr",
    steward: { budget: 10, mayAdoptLineSpawns: true },
  });
  expect(readJson(join(pool, "line.json"))).toMatchObject({
    briefPath: "docs/specs/186.brief.json",
    brief: { spec: "docs/specs/186.md", finish: "draft-pr" },
    round: 1,
    station: "implement",
    ticket: "r1-implement",
  });
  expect(readFileSync(join(pool, "issues", "r1-implement.md"), "utf8").split("\n", 1)[0]).toContain(
    "id=r1-implement blocked-by=none",
  );
  expect(readFileSync(join(pool, "issues", "r1-implement.md"), "utf8")).toContain(" station=implement ");

  // A Line branch is never reused: the same brief again is a Line of its own.
  const again = await w.run("boot", ["--brief", "pilots/186.brief.json", "--no-open", "--port", "0"], { cwd: repo });
  expect(again.code, again.stderr).toBe(0);
  expect(again.stdout).toContain("line: cut line/186-2 from main");
  expect(readJson(join(repo, ".scratch", "lines", "186-2", ".scratch", "186-2", "console.json"))).toMatchObject({
    title: "A Continued attempt's checkpoint drops its spawns (issue #186)",
  });
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");
});

conformance("cli", "Boot --factory asks for the work, cuts the Line and opens the Grill with the issue as its first Turn", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);
  // A claude that holds its pane as a TUI would, and a herdr where the server looks for one.
  writeFileSync(join(w.bin, "claude"), "#!/bin/sh\nexec sleep 150\n");
  chmodSync(join(w.bin, "claude"), 0o755);
  const herdr = await startHerdr(w.env(), { rendered: "Claude Code v · Ask anything\n❯ " });
  t.defer(() => herdr.stop());
  symlinkSync(herdr.socketPath, w.path("no-herdr.sock"));

  const run = await w.run("boot", ["--factory", "--no-open", "--port", "0"], {
    cwd: repo,
    answers: [["the piece of work", "#186"]],
    timeoutMs: 60_000,
  });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.prompts[0]).toBe("the piece of work (an issue number or free text)");
  expect(run.prompts[1]).toBe("title for the Line's pool [Issue #186]");
  expect(run.stdout).toContain("line: cut line/186 from main");
  expect(run.stdout).toContain("grill: conv-1 opened with the work as its first Turn");
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("feature/x");

  const pool = join(repo, ".scratch", "lines", "186", ".scratch", "186");
  expect(readJson(join(pool, "console.json"))).toMatchObject({ title: "Issue #186", terminal: "herdr" });
  expect(existsSync(join(pool, "line.json"))).toBe(false);
  const record = readFileSync(join(pool, "conversations", "conv-1.md"), "utf8");
  expect(record.split("\n", 1)[0]).toContain(" role=grill ");
  expect(record).toContain("# Grill: Issue #186\n");
  const typed = await until(
    () => herdr.control<string[]>("submitted"),
    (texts) => texts.length >= 1,
    { what: "the Grill's first Turn" },
  );
  expect(typed[0]!.startsWith("The piece of work for this Line is issue #186.")).toBe(true);
  expect(typed[0]).toContain("the spec at `docs/specs/186.md` and the Line brief at `docs/specs/186.brief.json`");
});

conformance("cli", "Boot's Factory mode refuses no work unattended, a checkout with no main, and a brief whose spec is nowhere, before cutting anything", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = checkout(w);

  const noWork = await w.run("boot", ["--factory", "--yes", "--no-open"], { cwd: repo });
  expect(noWork.code).toBe(1);
  expect(noWork.stderr).toBe("Factory mode needs the work: --work <issue number or text>, or --brief <path>\n");

  w.write("repo/pilots/lost.brief.json", JSON.stringify({ spec: "nowhere.md" }));
  const lost = await w.run("boot", ["--brief", "pilots/lost.brief.json", "--no-open"], { cwd: repo });
  expect(lost.code).toBe(1);
  expect(lost.stderr).toBe(
    `--brief pilots/lost.brief.json: its spec nowhere.md is neither under ${repo} nor beside the brief\n`,
  );

  const trunk = w.repo("trunk", { branch: "trunk" });
  const noMain = await w.run("boot", ["--factory", "--work", "tidy the header", "--yes", "--no-open"], { cwd: trunk });
  expect(noMain.code).toBe(1);
  expect(noMain.stderr).toBe(`${trunk} has no main branch (local or origin/main) to cut the Line's branch from\n`);

  expect(existsSync(join(repo, ".scratch", "lines"))).toBe(false);
  expect(gitIn(w, repo, ["branch", "--list", "line/*"])).toBe("");
});
