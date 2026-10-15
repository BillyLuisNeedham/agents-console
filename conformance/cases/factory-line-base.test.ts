/**
 * The Line base on a running Line (issue #193), seen from outside the
 * server: Start the Line copies console.json's `lineBase` into line.json's
 * `base`, which a restarted server keeps; Review diffs from the cut commit;
 * a `pr` or `draft-pr` Finish opens the PR against the base's name on
 * origin, and Decide's body says whether the brief grants `pushBase` and
 * what to do for each state origin may be in. A brief with `pushBase`
 * parses; one with an unknown field is still refused.
 *
 * Boot writes `lineBase` (factory-line-base-cli.test.ts); here the pool's
 * console.json carries it as Boot would have written it.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineBase, LineBrief, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case } from "../harness/case.ts";
import type { World } from "../harness/world.ts";
import {
  BRIEF,
  CONFIG,
  FINISH,
  NO_FINDINGS,
  PASS,
  SPEC,
  atCheckpoint,
  lineOf,
  lineWorld,
  startLine,
  started,
} from "./factory-line-support.ts";

const issue = (pool: string, id: string): string => readFileSync(join(pool, "issues", `${id}.md`), "utf8");
const reason = (answer: { json<T>(): T }): string => answer.json<{ reason: string }>().reason;

/**
 * A Factory pool on its Line branch `line/x`, its console.json carrying the Line base `ref` at main's
 * commit as Boot writes it, with its Stations scripted through to the Finish.
 */
function withBase(t: Case, ref: string, brief: LineBrief): { world: World; base: LineBase } {
  const world = lineWorld(t, brief);
  const base = { ref, commit: world.git(["rev-parse", "main"]).trim() };
  const config = { ...CONFIG, factoryPool: true, lineBase: base } satisfies PoolConfig;
  writeFileSync(join(world.pool, "console.json"), `${JSON.stringify(config, null, 2)}\n`);
  world.git(["checkout", "-q", "-b", "line/x"]);
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  return { world, base };
}

conformance("factory", "Start the Line copies lineBase into line.json's base, Review diffs from the cut commit, a draft-pr Finish targets the base without the pushBase grant, and a restart keeps the base", async (t) => {
  const { world, base } = withBase(t, "experiment/x", { spec: SPEC, finish: "draft-pr" });
  const first = await t.start(world);
  await started(first);

  const line = await lineOf(first);
  expect(line).toMatchObject({ branch: "line/x", base });
  expect(JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8")).base).toEqual(base);
  // The brief never carries the base.
  expect(line?.brief).toEqual({ spec: SPEC, finish: "draft-pr" });

  await atCheckpoint(first, "r1-finish");
  expect(issue(world.pool, "r1-review")).toContain(
    `## What to do\n\nReview the work on the Line's branch (the changes since it left \`experiment/x\` at \`${base.commit}\`: \`git diff ${base.commit}..HEAD\`) against the spec`,
  );
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain("1. Carry out the Finish. `draft-pr`: open a draft PR for the Line.");
  expect(decide).toContain(
    "open the PR from `line/x` against `experiment/x` with `gh pr create --draft --base experiment/x --head line/x`",
  );
  expect(decide).not.toContain("--base main");
  expect(decide).toContain(
    "The Line brief does not grant `pushBase`: never push the Line base `experiment/x` to origin. Before you push anything, check the Line base on origin with `git ls-remote --heads origin experiment/x` (origin only, never another remote), compare it with the local branch `experiment/x` the Line was cut from, and act on what you find:",
  );
  expect(decide).toContain(
    "- origin has no `experiment/x`: push nothing and open no PR, and say in the report and your Outcome's summary that the Finish was not carried out, and why.",
  );
  expect(decide).toContain(
    "- the local `experiment/x` is ahead of origin's: open the PR, and note in the report that it carries the base's unpushed commits.",
  );
  expect(decide).not.toContain("git push origin refs/heads/experiment/x");
  // The base's checks stand in a section after the Finish's numbered list, which item 1 points at.
  expect(decide).toContain(
    "The PR's link is the Finish's result. Before you push anything, check the Line base on origin as the section below says.\n2. Write the report with /html to ",
  );
  expect(decide).toContain(
    "\n\n### The Line base on origin\n\nThe Line brief does not grant `pushBase`: never push the Line base `experiment/x` to origin.",
  );
  expect(decide).toContain(
    "- they have diverged, so it would take a force-push: push nothing and open no PR, and say in the report and your Outcome's summary that the Finish was not carried out, and why.\n\nThe operator approves the Line",
  );
  expect(decide.indexOf("### The Line base on origin")).toBeGreaterThan(decide.indexOf("\n2. Write the report"));

  // The next server re-reads console.json and line.json: the base is where it was.
  const before = await lineOf(first);
  await first.stop();
  const second = await t.start(world);
  await atCheckpoint(second, "r1-finish");
  expect(await lineOf(second)).toEqual(before);
  expect((await lineOf(second))?.base).toEqual(base);
  expect(JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8")).base).toEqual(base);
});

conformance("factory", "a brief with pushBase parses and a pr Finish grants creating or fast-forwarding the base, never a force-push; a brief with an unknown field is refused", async (t) => {
  const { world, base } = withBase(t, "experiment/x", { spec: SPEC, finish: "pr", pushBase: true });
  const server = await t.start(world);

  const brief = join(world.repo, BRIEF);
  const valid = readFileSync(brief, "utf8");
  writeFileSync(brief, JSON.stringify({ spec: SPEC, finish: "pr", pushbase: true }));
  const unknown = await startLine(server);
  expect(unknown.status).toBe(409);
  expect(reason(unknown)).toContain("Line brief docs/specs/line.brief.json:");
  expect(reason(unknown)).toContain("unknown field `pushbase`");
  expect(await lineOf(server)).toBeNull();

  writeFileSync(brief, valid);
  await started(server);
  expect(await lineOf(server)).toMatchObject({ brief: { spec: SPEC, finish: "pr", pushBase: true }, base });

  await atCheckpoint(server, "r1-finish");
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain("1. Carry out the Finish. `pr`: open a PR for the Line.");
  expect(decide).toContain("`gh pr create --base experiment/x --head line/x`");
  expect(decide).not.toContain("--draft");
  expect(decide).toContain(
    "The Line brief grants `pushBase`: you may push the Line base `experiment/x` to origin, but only to create it or to fast-forward it. Never force-push it.",
  );
  expect(decide).toContain(
    "- origin has no `experiment/x`: push the local base to create it (`git push origin refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
  );
  expect(decide).toContain("- origin's `experiment/x` is the local `experiment/x`: open the PR.");
  expect(decide).toContain(
    "- the local `experiment/x` is ahead of origin's (a fast-forward): push it (`git push origin refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
  );
  expect(decide).toContain(
    "- they have diverged, so it would take a force-push: push nothing and open no PR, and say in the report and your Outcome's summary that the Finish was not carried out, and why.",
  );
});

conformance("factory", "a draft-pr Finish on a Line cut from origin's branch targets its name on origin and never pushes the base", async (t) => {
  const { world } = withBase(t, "origin/experiment/x", { spec: SPEC, finish: "draft-pr", pushBase: true });
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  const decide = issue(world.pool, "r1-decide");
  expect(decide).toContain("`gh pr create --draft --base experiment/x --head line/x`");
  expect(decide).not.toContain("--base origin/");
  expect(decide).toContain(
    "The Line was cut from `origin/experiment/x`, so origin already had its Line base and there is no local base to push: never push `experiment/x`. Before you push anything, check the Line base on origin with `git ls-remote --heads origin experiment/x` (origin only, never another remote). If origin still has `experiment/x`, open the PR. If it no longer does, push nothing and open no PR",
  );
  // A grant means nothing with no local base to push.
  expect(decide).not.toContain("The Line brief grants `pushBase`");
  expect(decide).not.toContain("git push origin refs/heads/");
});

conformance("factory", "a malformed lineBase in console.json refuses Start the Line, writing nothing, rather than read as a Line cut from main", async (t) => {
  const malformed: [unknown, string][] = [
    ["experiment/x", "invalid type: string"],
    [{ ref: "experiment/x" }, "missing field `commit`"],
    [{ ref: "origin/", commit: "0123456789abcdef0123456789abcdef01234567" }, 'its ref "origin/" names no branch'],
  ];
  for (const [lineBase, why] of malformed) {
    const world = lineWorld(t, { spec: SPEC, finish: "draft-pr" });
    writeFileSync(join(world.pool, "console.json"), `${JSON.stringify({ ...CONFIG, factoryPool: true, lineBase }, null, 2)}\n`);
    world.git(["checkout", "-q", "-b", "line/x"]);
    const server = await t.start(world);

    const refused = await startLine(server);
    expect(refused.status).toBe(409);
    expect(reason(refused)).toStartWith("the Line cannot start: console.json's lineBase is malformed (");
    expect(reason(refused)).toEndWith(
      "), and a Line read as cut from main would open its PR against main. Fix it to the { ref, commit } Boot wrote, or remove it for a Line cut from main",
    );
    expect(reason(refused)).toContain(why);
    expect(await lineOf(server)).toBeNull();
    expect(existsSync(join(world.pool, "line.json"))).toBe(false);
    expect(existsSync(join(world.pool, "issues", "r1-implement.md"))).toBe(false);
    await server.stop();
  }
});
