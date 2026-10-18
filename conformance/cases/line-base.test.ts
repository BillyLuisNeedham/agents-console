/**
 * The Line base on a running Line (issue #193), seen from outside the server: POST /api/line copies
 * console.json's `lineBase` into line.json's places, which a restarted server keeps; Review diffs
 * from the cut commit; a `pr` or `draft-pr` Finish Ticket opens the PR against the base's name on
 * origin, and its body says whether the brief grants `pushBase` and what to do for each state
 * origin may be in. A brief with `pushBase` parses; one with an unknown field is refused.
 *
 * Boot writes `lineBase` (line-base-cli.test.ts); here the pool's console.json carries it as Boot
 * would have written it.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LineBase, LineFile, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { answer, settle } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import {
  BRIEF,
  CONFIG,
  SPEC,
  atCheckpoint,
  beginLine,
  begun,
  issue,
  lineOf,
  lineWorld,
  passPath,
  reason,
  verdict,
} from "./line-support.ts";

const placesOf = (world: World): LineFile["places"] =>
  (JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8")) as LineFile).places;

/**
 * A pool on its Line branch `line/x`, its console.json carrying the Line base `ref` at main's commit
 * as Boot writes it, with its Ticket nodes and its Finish Ticket scripted through to the end.
 */
function withBase(t: Case, ref: string, brief: Record<string, unknown>): { world: World; base: LineBase } {
  const world = lineWorld(t, brief);
  const base = { ref, commit: world.git(["rev-parse", "main"]).trim() };
  const config = { ...CONFIG, lineBase: base } satisfies PoolConfig;
  writeFileSync(join(world.pool, "console.json"), `${JSON.stringify(config, null, 2)}\n`);
  world.git(["checkout", "-q", "-b", "line/x"]);
  passPath(world);
  world.stubs.script("finish-1-act", verdict({ url: "https://github.com/o/r/pull/7" }));
  return { world, base };
}

/** Approve the Finish hold and read the Finish Ticket it writes, once the Line is done. */
async function act(server: CaseServer, world: World): Promise<string> {
  await atCheckpoint(server, "finish-1");
  await answer(server, { ticketId: "finish-1", note: "approved" });
  await settle(server, (s) => s.phase === "done", { what: "the run to be done" });
  return issue(world, "finish-1-act");
}

conformance("line", "POST /api/line copies lineBase into line.json, Review diffs from the cut commit, a draft-pr Finish Ticket targets the base without the pushBase grant, and a restart keeps the base", async (t) => {
  const { world, base } = withBase(t, "experiment/x", { spec: SPEC, finish: "draft-pr" });
  const first = await t.start(world);
  await begun(first);
  expect(placesOf(world)).toEqual({ branch: "line/x", base, spec: SPEC });

  await atCheckpoint(first, "finish-1");
  expect(issue(world, "review-1")).toContain(
    `## What to do\n\nReview the work on the Line's branch (the changes since it left \`experiment/x\` at \`${base.commit}\`: \`git diff ${base.commit}..HEAD\`) against the spec`,
  );
  const before = await lineOf(first);
  await first.stop();
  const second = await t.start(world);
  await atCheckpoint(second, "finish-1");
  expect(await lineOf(second)).toEqual(before);
  expect(placesOf(world).base).toEqual(base);

  const body = await act(second, world);
  expect(body).toContain("`draft-pr`: open a draft PR for the Line.");
  expect(body).toContain(
    "Then open the PR from `line/x` against `experiment/x` with `gh pr create --draft --base experiment/x --head line/x`",
  );
  expect(body).not.toContain("--base main");
  expect(body).toContain(
    "The PR's url is the Finish's result. Before you push anything, check the Line base on origin as the section below says.\n\n### The Line base on origin\n\n",
  );
  expect(body).toContain(
    "The Line brief does not grant `pushBase`: never push the Line base `experiment/x` to origin. Before you push anything, check the Line base on origin with `git ls-remote --heads origin experiment/x` (origin only, never another remote), compare it with the local branch `experiment/x` the Line was cut from, and act on what you find:",
  );
  expect(body).toContain(
    "- origin has no `experiment/x`: push nothing and open no PR, and record a checkpoint Outcome whose brief says the Finish was not carried out, and why.",
  );
  expect(body).toContain(
    "- the local `experiment/x` is ahead of origin's: open the PR, and note in your summary that it carries the base's unpushed commits.",
  );
  expect(body).toContain(
    "- they have diverged, so it would take a force-push: push nothing and open no PR, and record a checkpoint Outcome whose brief says the Finish was not carried out, and why.",
  );
  expect(body).not.toContain("git push origin refs/heads/experiment/x");
});

conformance("line", "a brief with pushBase parses and a pr Finish Ticket may create or fast-forward the base, never force-push it; a brief with an unknown field is refused", async (t) => {
  const { world, base } = withBase(t, "experiment/x", { spec: SPEC, finish: "pr", pushBase: true });
  const server = await t.start(world);

  const brief = join(world.repo, BRIEF);
  const valid = readFileSync(brief, "utf8");
  writeFileSync(brief, JSON.stringify({ spec: SPEC, finish: "pr", pushbase: true }));
  const unknown = await beginLine(server);
  expect(unknown.status).toBe(409);
  expect(reason(unknown)).toContain("Line brief docs/specs/line.brief.json:");
  expect(reason(unknown)).toContain("unknown field `pushbase`");
  expect(await lineOf(server)).toBeNull();

  writeFileSync(brief, valid);
  await begun(server);
  expect(placesOf(world)).toEqual({ branch: "line/x", base, spec: SPEC, pushBase: true });

  const body = await act(server, world);
  expect(body).toContain("`pr`: open a PR for the Line.");
  expect(body).toContain("`gh pr create --base experiment/x --head line/x`");
  expect(body).not.toContain("--draft");
  expect(body).toContain(
    "The Line brief grants `pushBase`: you may push the Line base `experiment/x` to origin, but only to create it or to fast-forward it. Never force-push it.",
  );
  expect(body).toContain(
    "- origin has no `experiment/x`: push the local base to create it (`git push origin refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
  );
  expect(body).toContain("- origin's `experiment/x` is the local `experiment/x`: open the PR.");
  expect(body).toContain(
    "- the local `experiment/x` is ahead of origin's (a fast-forward): push it (`git push origin refs/heads/experiment/x:refs/heads/experiment/x`), then open the PR.",
  );
  expect(body).toContain(
    "- they have diverged, so it would take a force-push: push nothing and open no PR, and record a checkpoint Outcome whose brief says the Finish was not carried out, and why.",
  );
});

conformance("line", "a draft-pr Finish Ticket on a Line cut from origin's branch targets its name on origin and never pushes the base", async (t) => {
  const { world } = withBase(t, "origin/experiment/x", { spec: SPEC, finish: "draft-pr", pushBase: true });
  const server = await t.start(world);
  await begun(server);

  const body = await act(server, world);
  expect(body).toContain("`gh pr create --draft --base experiment/x --head line/x`");
  expect(body).not.toContain("--base origin/");
  expect(body).toContain(
    "The Line was cut from `origin/experiment/x`, so origin already had its Line base and there is no local base to push: never push `experiment/x`. Before you push anything, check the Line base on origin with `git ls-remote --heads origin experiment/x` (origin only, never another remote). If origin still has `experiment/x`, open the PR. If it no longer does, push nothing and open no PR",
  );
  expect(body).not.toContain("The Line brief grants `pushBase`");
  expect(body).not.toContain("git push origin refs/heads/");
});

conformance("line", "a malformed lineBase in console.json refuses POST /api/line, writing nothing, rather than read as a Line cut from main", async (t) => {
  const malformed: [unknown, string][] = [
    ["experiment/x", "invalid type: string"],
    [{ ref: "experiment/x" }, "missing field `commit`"],
    [{ ref: "origin/", commit: "0123456789abcdef0123456789abcdef01234567" }, 'its ref "origin/" names no branch'],
  ];
  for (const [lineBase, why] of malformed) {
    const world = lineWorld(t, { spec: SPEC, finish: "draft-pr" });
    writeFileSync(join(world.pool, "console.json"), `${JSON.stringify({ ...CONFIG, lineBase }, null, 2)}\n`);
    world.git(["checkout", "-q", "-b", "line/x"]);
    const server = await t.start(world);

    const refused = await beginLine(server);
    expect(refused.status).toBe(409);
    expect(reason(refused)).toStartWith("the Line cannot begin: console.json's lineBase is malformed (");
    expect(reason(refused)).toEndWith(
      "), and a Line read as cut from main would open its PR against main. Fix it to the { ref, commit } Boot wrote, or remove it for a Line cut from main",
    );
    expect(reason(refused)).toContain(why);
    expect(await lineOf(server)).toBeNull();
    expect(existsSync(join(world.pool, "line.json"))).toBe(false);
    expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);
    await server.stop();
  }
});
