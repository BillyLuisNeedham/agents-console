/**
 * The Line base at Boot (issue #193), run as a process: Boot's Line mode
 * cuts `line/<slug>` from the branch the checkout has out, or from the
 * branch `--from` names (a local branch, else origin's as written, else
 * origin's by its name there), never from another remote's branch, a
 * symbolic HEAD, a tag or a commit, and never from a detached HEAD. The Line's branch never tracks its base. Boot says what it
 * cut from and at which commit, writes both into console.json as
 * `lineBase`, the Line copies them into line.json as it begins, and the
 * Grill's first Turn names them.
 *
 * The remote-tracking cases push to a throwaway bare `origin` beside the
 * checkout (harness/cli.ts); nothing here reaches a real remote.
 */

import { expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld, type CliWorld } from "../harness/cli.ts";
import { startHerdr } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";

const MACHINE = { harness: "claude", model: "m", drivers: "implement" };
const SPEC = "# Start a Line anywhere (issue #193)\n\nThe spec.\n";
const BRIEF = { spec: "pilots/193.md", finish: "draft-pr" };
const BOOT = ["--no-steward", "--no-open", "--port", "0"];

function git(w: CliWorld, dir: string, args: string[]): { code: number; out: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd: dir, env: w.env(), stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode ?? -1, out: run.stdout.toString().trim() };
}

function gitIn(w: CliWorld, dir: string, args: string[]): string {
  const run = git(w, dir, args);
  if (run.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}`);
  return run.out;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Where Boot puts a Line's worktree and the pool inside it. */
const treeOf = (repo: string, slug: string): string => join(repo, ".scratch", "lines", slug);
const poolOf = (repo: string, slug: string): string => join(treeOf(repo, slug), ".scratch", slug);

/** The pilot's brief and spec beside the checkout, uncommitted, for --brief. */
function pilot(w: CliWorld, dir: string): void {
  w.write(`${dir}/pilots/193.md`, SPEC);
  w.write(`${dir}/pilots/193.brief.json`, JSON.stringify(BRIEF));
}

/** The Line's branch tracks nothing: no `branch.<line>.remote` at all. */
function expectNoTracking(w: CliWorld, repo: string, branch: string): void {
  expect(git(w, repo, ["config", `branch.${branch}.remote`])).toEqual({ code: 1, out: "" });
  expect(git(w, repo, ["config", `branch.${branch}.merge`])).toEqual({ code: 1, out: "" });
}

conformance("cli", "Boot --plan --from cuts the Line from a local branch checked out in another worktree, writes lineBase, tracks nothing and tells the Grill", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  // A repository with no main: the operator is on develop, and experiment/x is out in a worktree of its own.
  const repo = w.repo("repo", { branch: "develop" });
  gitIn(w, repo, ["branch", "experiment/x"]);
  gitIn(w, repo, ["worktree", "add", "-q", w.path("experiment"), "experiment/x"]);
  gitIn(w, w.path("experiment"), ["commit", "-q", "--allow-empty", "-m", "the experiment"]);
  const base = gitIn(w, repo, ["rev-parse", "experiment/x"]);
  expect(base).not.toBe(gitIn(w, repo, ["rev-parse", "develop"]));

  writeFileSync(join(w.bin, "claude"), "#!/bin/sh\nexec sleep 150\n");
  chmodSync(join(w.bin, "claude"), 0o755);
  const herdr = await startHerdr(w.env(), { rendered: "Claude Code v · Ask anything\n❯ " });
  t.defer(() => herdr.stop());
  symlinkSync(herdr.socketPath, w.path("no-herdr.sock"));

  const run = await w.run("boot", ["--plan", "factory-today", "--from", "experiment/x", "--work", "#193", "--yes", ...BOOT], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const tree = treeOf(repo, "193");
  expect(run.stdout).toContain(`line: cut line/193 from experiment/x (${base.slice(0, 7)}) at ${tree}\n`);
  expect(run.stdout).toContain("grill: conv-1 opened with the work as its first Turn");

  // Cut at the base's commit, from a branch another worktree has out; neither checkout moved.
  expect(gitIn(w, repo, ["rev-parse", "line/193"])).toBe(base);
  expect(gitIn(w, tree, ["branch", "--show-current"])).toBe("line/193");
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("develop");
  expect(gitIn(w, w.path("experiment"), ["branch", "--show-current"])).toBe("experiment/x");
  expectNoTracking(w, repo, "line/193");

  const pool = poolOf(repo, "193");
  const lineBase = { ref: "experiment/x", commit: base };
  expect(readJson(join(pool, "console.json"))).toMatchObject({ lineBase });
  expect(readJson(join(pool, "console.json"))).not.toHaveProperty("factoryPool");
  expect(run.stdout).toContain('line: begun on the Plan factory-today ("Factory today")\n');
  expect(readJson(join(pool, "line.json"))).toMatchObject({ places: { branch: "line/193", base: lineBase } });

  const typed = await until(
    () => herdr.control<string[]>("submitted"),
    (texts) => texts.length >= 1,
    { what: "the Grill's first Turn" },
  );
  expect(typed[0]).toStartWith(
    `The piece of work for this Line is issue #193. Read it (gh issue view 193) and grill me on it. This Line was cut from \`experiment/x\` at \`${base.slice(0, 7)}\`.`,
  );
  // The Grill is taught the brief's pushBase grant.
  expect(typed[0]).toContain('"pushBase": true');
});

conformance("cli", "Boot --from takes a remote-tracking branch as written, or by its name on origin when there is no local one, and the Line tracks neither", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = w.repo("repo", { branch: "develop", origin: true });
  // experiment/x lives only on origin: pushed, fetched, then the local branch deleted.
  gitIn(w, repo, ["checkout", "-q", "-b", "experiment/x"]);
  gitIn(w, repo, ["commit", "-q", "--allow-empty", "-m", "the experiment"]);
  gitIn(w, repo, ["push", "-q", "origin", "experiment/x"]);
  gitIn(w, repo, ["checkout", "-q", "develop"]);
  gitIn(w, repo, ["branch", "-q", "-D", "experiment/x"]);
  gitIn(w, repo, ["fetch", "-q", "origin"]);
  const base = gitIn(w, repo, ["rev-parse", "refs/remotes/origin/experiment/x"]);
  expect(git(w, repo, ["show-ref", "--verify", "--quiet", "refs/heads/experiment/x"]).code).toBe(1);
  pilot(w, "repo");

  const written = await w.run(
    "boot",
    ["--brief", "pilots/193.brief.json", "--from", "origin/experiment/x", "--line", "as-written", ...BOOT],
    { cwd: repo },
  );
  expect(written.code, written.stderr).toBe(0);
  expect(written.stdout).toContain(
    `line: cut line/as-written from origin/experiment/x (${base.slice(0, 7)}) at ${treeOf(repo, "as-written")}\n`,
  );

  const byName = await w.run(
    "boot",
    ["--brief", "pilots/193.brief.json", "--from", "experiment/x", "--line", "by-name", ...BOOT],
    { cwd: repo },
  );
  expect(byName.code, byName.stderr).toBe(0);
  expect(byName.stdout).toContain(
    `line: cut line/by-name from origin/experiment/x (${base.slice(0, 7)}) at ${treeOf(repo, "by-name")}\n`,
  );

  for (const slug of ["as-written", "by-name"]) {
    expect(gitIn(w, repo, ["rev-parse", `line/${slug}~1`])).toBe(base);
    expectNoTracking(w, repo, `line/${slug}`);
    const pool = poolOf(repo, slug);
    const lineBase = { ref: "origin/experiment/x", commit: base };
    expect(readJson(join(pool, "console.json"))).toMatchObject({ lineBase });
    expect(readJson(join(pool, "line.json"))).toMatchObject({ places: { branch: `line/${slug}`, base: lineBase } });
  }
  // Boot made no local branch of the base.
  expect(git(w, repo, ["show-ref", "--verify", "--quiet", "refs/heads/experiment/x"]).code).toBe(1);
  expect(gitIn(w, repo, ["branch", "--show-current"])).toBe("develop");
});

conformance("cli", "Boot --from refuses a tag, a commit and a missing branch, and --from without --plan, before cutting anything", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = w.repo("repo", { branch: "develop" });
  gitIn(w, repo, ["tag", "v1.0"]);
  const sha = gitIn(w, repo, ["rev-parse", "HEAD"]);
  const refusal = (name: string): string =>
    `--from ${name}: no branch refs/heads/${name}, refs/remotes/${name} or refs/remotes/origin/${name}; ` +
    "--from takes a branch (local or origin's), never a tag or a commit\n";

  for (const name of ["v1.0", sha, "nope"]) {
    const run = await w.run("boot", ["--plan", "factory-today", "--from", name, "--work", "tidy the header", "--yes", "--no-open"], {
      cwd: repo,
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe(refusal(name));
  }

  const plain = await w.run("boot", ["--from", "develop", "--yes", "--no-open"], { cwd: repo });
  expect(plain.code).toBe(1);
  expect(plain.stderr.split("\n", 1)[0]).toBe("--from is for Line mode: add --plan <slug>");

  expect(existsSync(join(repo, ".scratch"))).toBe(false);
  expect(gitIn(w, repo, ["branch", "--list", "line/*"])).toBe("");
  expect(gitIn(w, repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toEqual([
    `worktree ${repo}`,
  ]);
});

conformance("cli", "Boot --from refuses another remote's branch, origin's HEAD, an empty name and a local branch named like origin's, before cutting anything", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const repo = w.repo("repo", { branch: "develop", origin: true });
  // origin/HEAD, as a clone has it: a symbolic ref that show-ref still verifies.
  gitIn(w, repo, ["remote", "set-head", "origin", "develop"]);
  expect(git(w, repo, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/HEAD"]).code).toBe(0);
  // A second throwaway bare remote, upstream, with a branch y fetched from it.
  const upstream = w.dir("upstream.git");
  gitIn(w, upstream, ["init", "-q", "--bare", "-b", "develop"]);
  gitIn(w, repo, ["remote", "add", "upstream", upstream]);
  gitIn(w, repo, ["push", "-q", "upstream", "develop:y"]);
  gitIn(w, repo, ["fetch", "-q", "upstream"]);
  expect(git(w, repo, ["show-ref", "--verify", "--quiet", "refs/remotes/upstream/y"]).code).toBe(0);
  // A local branch whose name lineBase would read back as origin's.
  gitIn(w, repo, ["branch", "origin/mistake"]);

  const refusals: [string, string][] = [
    [
      "upstream/y",
      "--from upstream/y: refs/remotes/upstream/y is another remote's branch; a Line base is a local branch or origin's, since the Finish opens its PR on origin",
    ],
    ["origin/HEAD", "--from origin/HEAD: HEAD is a symbolic ref, not a branch; name the branch it points at"],
    ["HEAD", "--from HEAD: HEAD is a symbolic ref, not a branch; name the branch it points at"],
    ["", "--from needs a branch name"],
    [
      "origin/mistake",
      "refs/heads/origin/mistake is a local branch named like origin's, which the Line base would read as origin's mistake: rename it, or cut from another branch",
    ],
  ];
  for (const [name, message] of refusals) {
    const run = await w.run("boot", ["--plan", "factory-today", "--from", name, "--work", "tidy the header", "--yes", "--no-open"], {
      cwd: repo,
    });
    expect(run.code, `--from ${name}: ${run.stdout}`).toBe(1);
    expect(run.stderr).toBe(`${message}\n`);
  }

  expect(existsSync(join(repo, ".scratch"))).toBe(false);
  expect(gitIn(w, repo, ["branch", "--list", "line/*"])).toBe("");
  expect(gitIn(w, repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toEqual([
    `worktree ${repo}`,
  ]);
});

conformance("cli", "Boot cuts the Line from the current branch in a repository with no main, and refuses a detached HEAD unless --from names a branch", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: MACHINE });
  const trunk = w.repo("trunk", { branch: "trunk", subjects: ["init", "trunk work"] });
  const base = gitIn(w, trunk, ["rev-parse", "trunk"]);
  pilot(w, "trunk");

  const run = await w.run("boot", ["--brief", "pilots/193.brief.json", ...BOOT], { cwd: trunk });
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain(`line: cut line/193 from trunk (${base.slice(0, 7)}) at ${treeOf(trunk, "193")}\n`);
  expect(gitIn(w, trunk, ["rev-parse", "line/193~1"])).toBe(base);
  expectNoTracking(w, trunk, "line/193");
  expect(readJson(join(poolOf(trunk, "193"), "console.json"))).toMatchObject({ lineBase: { ref: "trunk", commit: base } });

  // A detached HEAD has no current branch to cut from.
  gitIn(w, trunk, ["checkout", "-q", "--detach", "trunk~1"]);
  const detached = await w.run("boot", ["--plan", "factory-today", "--work", "tidy the header", "--yes", "--no-open"], { cwd: trunk });
  expect(detached.code).toBe(1);
  expect(detached.stderr).toBe(
    `${trunk} has a detached HEAD, so there is no current branch to cut the Line from: check out a branch, or pass --from <branch>\n`,
  );
  expect(gitIn(w, trunk, ["for-each-ref", "--format=%(refname:short)", "refs/heads/line/"])).toBe("line/193");
  expect(existsSync(treeOf(trunk, "193-2"))).toBe(false);

  // --from names the branch, so a detached HEAD does not matter.
  const named = await w.run("boot", ["--brief", "pilots/193.brief.json", "--from", "trunk", ...BOOT], { cwd: trunk });
  expect(named.code, named.stderr).toBe(0);
  expect(named.stdout).toContain(`line: cut line/193-2 from trunk (${base.slice(0, 7)}) at ${treeOf(trunk, "193-2")}\n`);
  expect(git(w, trunk, ["symbolic-ref", "--quiet", "HEAD"]).code).toBe(1);
});
