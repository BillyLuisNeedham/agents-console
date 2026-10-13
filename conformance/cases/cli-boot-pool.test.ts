/**
 * Boot finding or creating its pool (the inventory's `cli` rows from
 * boot-cli.test.ts's "pool resolution" and "Pool titles in Boot"), run as a
 * process: which pool it says it took and why, what it creates, what it
 * asks, and what it refuses.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld, consoleUrl, DONE_TICKET, MACHINE, readJson, snapshotTree } from "../harness/cli.ts";

const BOOT = ["--yes", "--no-open", "--port", "0"];

conformance("cli", "Boot takes an explicit pool directory as given, creating it", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const cwd = w.dir("outside");
  const run = await w.run("boot", ["named-pool", ...BOOT], { cwd });
  expect(run.code).toBe(0);
  const pool = join(cwd, "named-pool");
  expect(run.stdout).toContain(`pool: ${pool} (named on the command line)\n`);
  expect(existsSync(join(pool, "console.json"))).toBe(true);
});

conformance("cli", "Boot uses the working directory when it is itself a pool", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const pool = w.dir("here");
  w.write("here/issues/01-first.md", DONE_TICKET);
  const run = await w.run("boot", BOOT, { cwd: pool });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`pool: ${pool} (the working directory is a pool)\n`);
  expect(existsSync(join(pool, ".scratch"))).toBe(false);
});

conformance("cli", "Boot counts an empty conversations directory as a pool", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const pool = w.dir("seeded");
  w.dir("seeded/conversations");
  const run = await w.run("boot", BOOT, { cwd: pool });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`pool: ${pool} (the working directory is a pool)\n`);
});

conformance("cli", "Boot picks the only pool under .scratch, from a subdirectory of the checkout", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { files: { "src/main.txt": "x\n" } });
  w.write("repo/.scratch/only/issues/01-first.md", DONE_TICKET);
  const run = await w.run("boot", BOOT, { cwd: join(top, "src") });
  expect(run.code).toBe(0);
  const pool = join(top, ".scratch", "only");
  expect(run.stdout).toContain(`pool: ${pool} (the only pool under ${top}/.scratch)\n`);
  // The server it started serves that pool.
  const log = readFileSync(join(pool, "runs", "server.log"), "utf8");
  expect(log).toContain(`pool server on ${consoleUrl(run)} (${pool})`);
  const state = await fetch(`${consoleUrl(run)}/api/state`);
  expect(state.status).toBe(200);
});

conformance("cli", "Boot offers a choice when .scratch holds several pools, and refuses one unattended", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/alpha/issues/01-first.md", DONE_TICKET);
  w.write("repo/.scratch/beta/issues/01-first.md", DONE_TICKET);
  const scratch = join(top, ".scratch");

  const asked = await w.run("boot", ["--no-open", "--port", "0"], { cwd: top, answers: [["which pool", "9"]] });
  expect(asked.stdout).toContain(`pools under ${scratch}:\n  1. alpha\n  2. beta\n`);
  expect(asked.prompts).toEqual(["which pool [1]"]);
  expect(asked.code).toBe(1);
  expect(asked.stderr).toBe("no pool numbered 9\n");

  const refused = await w.run("boot", BOOT, { cwd: top });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(
    `several pools under ${scratch}; name the one you want:\n  ${scratch}/alpha\n  ${scratch}/beta\n`,
  );
  expect(refused.prompts).toEqual([]);
});

conformance("cli", "Boot names a new pool after the branch when there is none", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { branch: "feature/Add-Boot_Script" });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  const pool = join(top, ".scratch", "feature-add-boot-script");
  expect(run.stdout).toContain(`pool: ${pool} (created, no pool under ${top}/.scratch)\n`);
  expect(existsSync(join(pool, "console.json"))).toBe(true);
});

conformance("cli", "Boot refuses a working directory that is neither a pool nor in a checkout", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const cwd = w.dir("nowhere");
  const run = await w.run("boot", ["--yes"], { cwd });
  expect(run.code).toBe(1);
  expect(run.stderr).toBe(
    `${cwd} is not a pool and not inside a git checkout. A pool lives beside the checkout its attempts ` +
      "branch from, so run this from a project or name the pool directory.\n",
  );
  expect(readdirSync(cwd)).toEqual([]);
});

conformance("cli", "Boot creates the pool and excludes .scratch once, never touching .gitignore", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  const exclude = join(top, ".git", "info", "exclude");
  const first = await w.run("boot", BOOT, { cwd: top });
  expect(first.code).toBe(0);
  expect(existsSync(join(top, ".scratch", "main"))).toBe(true);
  expect(first.stdout).toContain(`added .scratch/ to ${top}/.git/info/exclude\n`);
  await w.stopServers();

  const second = await w.run("boot", BOOT, { cwd: top });
  expect(second.code).toBe(0);
  expect(second.stdout).not.toContain("exclude");
  const lines = readFileSync(exclude, "utf8").split("\n").filter((line) => line.trim() === ".scratch/");
  expect(lines).toHaveLength(1);
  expect(existsSync(join(top, ".gitignore"))).toBe(false);
});

conformance("cli", "Boot asks git about a pool not there yet from its nearest existing ancestor", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { subjects: ["feat: one", "feat: two"] });
  const cwd = w.dir("elsewhere");
  const pool = join(top, ".scratch", "a", "b", "new");
  const run = await w.run("boot", [pool, ...BOOT], { cwd });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain("commit prefix feat\n");
  expect(readFileSync(join(pool, "AGENT.md"), "utf8")).toContain("feat: <what changed, in the imperative>");
});

conformance("cli", "Boot slugifies a typed directory, a branch and a Setup name", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });

  const typed = w.repo("typed");
  const asked = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: typed,
    answers: [
      ["directory for the new pool", "My Pool_Name!"],
      ["save this Setup as", "!!!"],
    ],
  });
  expect(asked.code).toBe(0);
  expect(existsSync(join(typed, ".scratch", "my-pool-name", "console.json"))).toBe(true);
  // A Setup name that slugifies to nothing is refused.
  expect(asked.stderr).toContain("that name slugifies to nothing; saved no Setup\n");
  expect(existsSync(join(w.home, ".agent-graphs", "setups"))).toBe(false);

  const branch = w.repo("branch", { branch: "feature/try-boot" });
  const unattended = await w.run("boot", BOOT, { cwd: branch });
  expect(unattended.code).toBe(0);
  expect(existsSync(join(branch, ".scratch", "feature-try-boot"))).toBe(true);
});

conformance("cli", "Boot lists a titled pool by its title with the directory beside it", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/jev-integration/issues/01-first.md", DONE_TICKET);
  w.write("repo/.scratch/jev-integration/console.json", JSON.stringify({ title: "Jev as the grader" }));
  w.write("repo/.scratch/other/issues/01-first.md", DONE_TICKET);
  const run = await w.run("boot", ["--no-open"], { cwd: top, answers: [["which pool", "9"]] });
  expect(run.stdout).toContain("  1. Jev as the grader (jev-integration)\n  2. other\n");
});

conformance("cli", "Boot lists a pool whose config does not parse by its directory", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/broken/console.json", "{ not json");
  w.write("repo/.scratch/fine/issues/01-first.md", DONE_TICKET);
  const run = await w.run("boot", ["--no-open"], { cwd: top, answers: [["which pool", "9"]] });
  expect(run.stdout).toContain("  1. broken\n  2. fine\n");
  expect(run.stderr).toBe("no pool numbered 9\n");
});

conformance("cli", "Boot asks a new pool's title first and derives the directory from it", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { branch: "feature-x" });
  const run = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: top,
    answers: [["title for the new pool", "  Jev as the grader "]],
  });
  expect(run.code).toBe(0);
  expect(run.prompts.slice(0, 2)).toEqual([
    "title for the new pool (blank for none)",
    "directory for the new pool [jev-as-the-grader]",
  ]);
  const config = readJson(join(top, ".scratch", "jev-as-the-grader", "console.json"));
  expect(config.title).toBe("Jev as the grader");
});

conformance("cli", "Boot keeps the branch's directory and no title when the title is left blank", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { branch: "feature-x" });
  const run = await w.run("boot", ["--no-open", "--port", "0"], { cwd: top });
  expect(run.code).toBe(0);
  expect(run.prompts).toContain("directory for the new pool [feature-x]");
  const config = readJson(join(top, ".scratch", "feature-x", "console.json"));
  expect("title" in config).toBe(false);
});

conformance("cli", "Boot takes a directory the operator types over the derived one", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { branch: "feature-x" });
  const run = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: top,
    answers: [
      ["title for the new pool", "Jev as the grader"],
      ["directory for the new pool", "Jev Pool"],
    ],
  });
  expect(run.code).toBe(0);
  const config = readJson(join(top, ".scratch", "jev-pool", "console.json"));
  expect(config.title).toBe("Jev as the grader");
});

conformance("cli", "Boot never lands a new pool in a directory that is already there", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const derived = w.repo("derived");
  w.dir("derived/.scratch/jev-as-the-grader");
  const first = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: derived,
    answers: [["title for the new pool", "Jev as the grader"]],
  });
  expect(first.code).toBe(0);
  expect(existsSync(join(derived, ".scratch", "jev-as-the-grader-2", "console.json"))).toBe(true);
  expect(readdirSync(join(derived, ".scratch", "jev-as-the-grader"))).toEqual([]);

  const typed = w.repo("typed");
  w.dir("typed/.scratch/taken");
  const second = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: typed,
    answers: [["directory for the new pool", "taken"]],
  });
  expect(second.code).toBe(0);
  expect(existsSync(join(typed, ".scratch", "taken-2", "console.json"))).toBe(true);
  expect(second.stderr).toContain(`taken is already under ${typed}/.scratch; using taken-2\n`);
});

conformance("cli", "Boot asks nothing unattended: no title, and the branch's directory", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo", { branch: "feature-x" });
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.prompts).toEqual([]);
  expect(run.stdout).not.toContain("title for the new pool");
  expect(run.stdout).not.toContain("directory for the new pool");
  const config = readJson(join(top, ".scratch", "feature-x", "console.json"));
  expect("title" in config).toBe(false);
});

conformance("cli", "Boot writes a new pool's title into console.json beside the rest, and gives an existing pool none", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  const created = await w.run("boot", ["--no-open", "--port", "0"], {
    cwd: top,
    answers: [["title for the new pool", "Jev as the grader"]],
  });
  expect(created.code).toBe(0);
  const config = readJson(join(top, ".scratch", "jev-as-the-grader", "console.json"));
  expect(config).toMatchObject({ title: "Jev as the grader", defaults: { harness: "claude", model: "m" } });

  const existing = w.dir("existing");
  w.write("existing/console.json", JSON.stringify({ port: 9001 }));
  const booted = await w.run("boot", [existing, ...BOOT]);
  expect(booted.code).toBe(0);
  const after = readJson(join(existing, "console.json"));
  expect(after.port).toBe(9001);
  expect("title" in after).toBe(false);
});

// Gaps the inventory lists for `cli` (Visible behaviour no test covers yet).

conformance("cli", "Boot on a new branch pool writes the defaults it was given and the exclude line", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: { harness: "claude", model: "m" } });
  const top = w.repo("repo", { branch: "feature/try-boot" });
  const defaultsPath = join(w.home, ".agent-graphs", "defaults.json");
  const defaultsBefore = readFileSync(defaultsPath);
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  const pool = join(top, ".scratch", "feature-try-boot");
  expect(readdirSync(pool)).toEqual(expect.arrayContaining(["issues", "conversations"]));
  expect(readJson(join(pool, "console.json"))).toEqual({
    defaults: { harness: "claude", model: "m", drivers: "implement" },
    resolver: "claude",
    checkpoint: "a device, an external write, an undecided decision, or a material guess",
  });
  expect(readFileSync(join(top, ".git", "info", "exclude"), "utf8").split("\n")).toContain(".scratch/");
  expect(readFileSync(defaultsPath).equals(defaultsBefore)).toBe(true);
});

conformance("cli", "Boot unattended refuses several pools and, asked, a pool number it does not list", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/alpha/console.json", JSON.stringify({ title: "Alpha work" }));
  w.write("repo/.scratch/beta/issues/01.md", DONE_TICKET);
  const scratch = join(top, ".scratch");
  const before = snapshotTree(scratch);

  const refused = await w.run("boot", ["--yes", "--no-open"], { cwd: top });
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(
    `several pools under ${scratch}; name the one you want:\n  ${scratch}/alpha\n  ${scratch}/beta\n`,
  );

  const asked = await w.run("boot", ["--no-open"], { cwd: top, stdin: "9\n" });
  expect(asked.code).toBe(1);
  expect(asked.stdout).toContain("  1. Alpha work (alpha)\n  2. beta\nwhich pool [1]: ");
  expect(asked.stderr).toBe("no pool numbered 9\n");
  expect(snapshotTree(scratch)).toEqual(before);
});

conformance("cli", "Boot adds the exclude line for a pool made by hand under .scratch", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/p/issues/01.md", DONE_TICKET);
  const run = await w.run("boot", BOOT, { cwd: top });
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`added .scratch/ to ${top}'s git exclude file\n`);
  expect(readFileSync(join(top, ".git", "info", "exclude"), "utf8").split("\n")).toContain(".scratch/");
});
