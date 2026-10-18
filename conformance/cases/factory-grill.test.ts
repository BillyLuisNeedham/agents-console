/**
 * The Grill and Start the Line on it (ADR-0037, ADR-0039; the bridge until Conversation nodes run
 * as Conversations of their own), seen from outside the server: once the Line has begun on a Plan
 * whose entry is a Conversation node, a Conversation started with role "grill" launches on that
 * node's skill and Assignment with its first Turn and the pass's teaching typed, one to a pool;
 * POST /api/line/start with `grill` reads the Line brief at the pass's path on the Grill's
 * committed branch, refuses with the reason and changes nothing when it is not there or not
 * valid, and otherwise merges that branch into the pool checkout, ends the entry pass so the first
 * tick writes implement-1, and ends the Grill. Only the operator's routes reach it: the Steward's
 * have no such verb. A spawn the Grill proposes is inside the Line, so it is held for the operator.
 *
 * The Grill runs in a pane of the fake herdr, on a stub that holds the pane the way a TUI does; a
 * case plays the Grill by committing files on its branch.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, LineResponse, PlanFile, PlanResponse, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { snapshot } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { BODY, proposeSpawns } from "./conversations-support.ts";
import { begun, lineOf, reason } from "./line-support.ts";

/** Every known harness's ready pattern and claude's idle prompt. */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

const CONFIG = {
  defaults: { harness: "claude", model: "m" },
  terminal: "herdr",
} satisfies PoolConfig;

const ISSUE = "The piece of work for this Line is issue #186. Read it and grill me on it.";

/** The Line brief's path for the Grill's pass on a pool checkout on main. */
const BRIEF = "docs/specs/main.grill-1.brief.json";

/** A terminal-backed pool with no Ticket yet, as Boot's Line mode makes one. */
function grillWorld(t: Case, config: PoolConfig = CONFIG): World {
  const world = t.world({ config });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  for (const key of ["_claude", "_opencode"]) world.stubs.script(key, { hold: 150 });
  return world;
}

/** Serve the pool and begin its Line on the work, as Boot does before it opens the Grill. */
async function serve(t: Case, world: World): Promise<{ herdr: HerdrProcess; server: CaseServer }> {
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  await begun(server, { plan: "factory-today", work: "#186" });
  return { herdr, server };
}

async function startGrill(server: CaseServer, body: Record<string, unknown> = {}): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE, ...body });
  expect(answer.status, answer.text).toBe(201);
  return answer.json<{ conversation: ConversationView }>().conversation;
}

/** POST /api/line/start. */
function startLine(server: CaseServer, body: Record<string, unknown>) {
  return server.http.post("/api/line/start", body);
}

/** Where the server keeps a pool branch's worktree. */
function worktreeOf(world: World, branch: string): string {
  return join(world.repo, ".git", "pool-worktrees", branch.split("/")[1]!, branch.split("/")[2]!);
}

/** Play the Grill: write files in its worktree and, unless told not to, commit them on its branch. */
function grillWrites(world: World, grill: ConversationView, files: Record<string, string>, commit = true): void {
  const tree = worktreeOf(world, grill.branch!);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(tree, path, ".."), { recursive: true });
    writeFileSync(join(tree, path), text);
  }
  if (!commit) return;
  world.git(["-C", tree, "add", "-A"]);
  world.git(["-C", tree, "commit", "-q", "-m", "the Grill's spec and brief"]);
}

function submitted(herdr: HerdrProcess): Promise<string[]> {
  return until(() => herdr.control<string[]>("submitted"), (texts) => texts.length >= 1, { what: "the first Turn" });
}

function recordLine(world: World, id: string): string {
  return readFileSync(join(world.pool, "conversations", `${id}.md`), "utf8").split("\n", 1)[0]!;
}

/** Factory today with its Grill node on another Assignment and skill. */
async function grillOn(server: CaseServer, grill: Record<string, unknown>): Promise<PlanFile> {
  const { plan } = (await server.http.get("/api/plans/factory-today")).json<PlanResponse>();
  return { ...plan, nodes: plan.nodes.map((n) => (n.id === "grill" ? { ...n, ...grill } : n)) } as PlanFile;
}

conformance("line", "the Grill launches on the entry Conversation node's skill and Assignment, its first Turn the work and the pass's teaching", async (t) => {
  const world = grillWorld(t);
  const { herdr, server } = await serve(t, world);

  const grill = await startGrill(server);
  expect(grill).toMatchObject({ id: "conv-1", title: "Grill", role: "grill", status: "live" });
  expect(grill.assignment).toMatchObject({
    harness: "claude",
    model: "opus",
    effort: "high",
    drivers: "my-grill-with-docs",
  });
  expect(recordLine(world, "conv-1")).toContain(" role=grill ");
  const launch = world.stubs.calls().find((call) => call.harness === "claude");
  expect(launch?.argv).toEqual(expect.arrayContaining(["opus"]));

  const typed = (await submitted(herdr))[0]!;
  expect(typed.startsWith(`${ISSUE}\n\n---\n`)).toBe(true);
  expect(typed).toContain("You are the Grill Conversation (`grill-1`) of this pool's Line (ADR-0039)");
  expect(typed).toContain(`write the spec at \`docs/specs/main.md\` and the Line brief at \`${BRIEF}\``);
  expect(typed).toContain(
    '"pushBase": true (the Finish may push the Line base to origin, only to create it or fast-forward it, never forcing)',
  );
  expect(typed).toContain("## The Line's work\n\n#186");

  const second = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE });
  expect(second.status).toBe(409);
  expect(reason(second)).toBe("grill start: conv-1 is already this pool's Grill");
});

conformance("line", "the Grill takes its Assignment and skill from the Plan's Conversation node", async (t) => {
  const world = grillWorld(t);
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  const plan = await grillOn(server, { skill: "my-grill-me", assign: { harness: "opencode", model: "g1", effort: "high" } });
  await begun(server, { plan, work: "#186" });

  const grill = await startGrill(server, { title: "Grill: issue 186" });
  expect(grill.title).toBe("Grill: issue 186");
  expect(grill.assignment).toMatchObject({ harness: "opencode", model: "g1", effort: "high", drivers: "my-grill-me" });
});

conformance("line", "Start the Line on the Grill refuses without a committed brief and from anything but the live Grill, and changes nothing", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const talk = (await server.http.post("/api/conversations", { title: "Talk" })).json<{ conversation: ConversationView }>()
    .conversation;
  const grill = await startGrill(server);

  expect(reason(await startLine(server, { grill: talk.id }))).toBe(
    `${talk.id} is not the Grill: the Line starts only from its Grill`,
  );
  expect(reason(await startLine(server, { grill: "conv-9" }))).toBe("no Conversation conv-9");

  const place = `the Grill's committed branch ${grill.branch}`;
  const none = await startLine(server, { grill: grill.id });
  expect(none.status).toBe(409);
  expect(reason(none)).toBe(`${place} has no Line brief at ${BRIEF}`);

  // Written but not committed: it would never merge, so it does not count.
  const brief = JSON.stringify({ spec: "docs/specs/186.md", finish: "draft-pr" });
  grillWrites(world, grill, { [BRIEF]: brief }, false);
  expect(reason(await startLine(server, { grill: grill.id }))).toBe(`${place} has no Line brief at ${BRIEF}`);

  grillWrites(world, grill, { [BRIEF]: brief });
  expect(reason(await startLine(server, { grill: grill.id }))).toBe(
    `Line brief ${BRIEF}: its spec docs/specs/186.md is not on ${place}`,
  );
  grillWrites(world, grill, { [BRIEF]: "{" });
  expect(reason(await startLine(server, { grill: grill.id }))).toStartWith(`Line brief ${BRIEF}: not valid JSON`);

  for (const body of [{ grill: 7 }, { brief: BRIEF }]) {
    const bad = await startLine(server, body);
    expect(bad.status).toBe(400);
    expect(reason(bad)).toBe("grill must be a Conversation id");
  }

  // Operator-only: the Steward's routes have no Start the Line.
  const steward = await server.http.post("/api/steward/line/start", { conversation: talk.id, grill: grill.id });
  expect(steward.status).toBe(404);
  expect(reason(steward)).toBe("no steward route /api/steward/line/start");

  expect((await lineOf(server))?.nodes.find((n) => n.id === "grill")).toMatchObject({ pass: 1, tickets: ["grill-1"] });
  expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);
  expect(existsSync(join(world.repo, BRIEF))).toBe(false);
  expect(recordLine(world, grill.id)).toContain("status=live");
});

conformance("line", "Start the Line on the Grill refuses before merging a brief that names a node the Plan lacks", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await startGrill(server);
  grillWrites(world, grill, {
    "docs/specs/186.md": "# Fix it\n\nThe spec.\n",
    [BRIEF]: JSON.stringify({ spec: "docs/specs/186.md", nodes: { nope: { note: "n" } } }),
  });
  const before = world.git(["rev-parse", "main"]);

  const refused = await startLine(server, { grill: grill.id });
  expect(refused.status).toBe(409);
  expect(reason(refused)).toBe(`Line brief ${BRIEF}: nodes: the Plan has no node nope`);

  // Refused before the merge: the Line's branch is as it was and the Grill goes on.
  expect(world.git(["rev-parse", "main"])).toBe(before);
  expect(existsSync(join(world.repo, BRIEF))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);
  expect(recordLine(world, grill.id)).toContain("status=live");
});

conformance("line", "Start the Line on the Grill merges its branch, ends the entry pass so implement-1 is written, and ends the Grill", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await startGrill(server);
  grillWrites(world, grill, {
    "docs/specs/186.md": "# Fix it\n\nThe spec.\n",
    [BRIEF]: JSON.stringify({ spec: "docs/specs/186.md", finish: "draft-pr" }),
  });

  const started = await startLine(server, { grill: grill.id });
  expect(started.status, started.text).toBe(202);
  const line = started.json<LineResponse>().line!;
  expect(line.nodes.find((n) => n.id === "grill")).toMatchObject({ passes: 1, tickets: [] });
  expect(line.plan.nodes.find((n) => n.id === "finish")).toMatchObject({ act: "draft-pr" });

  // The Grill's branch is merged into the pool checkout's branch.
  expect(world.git(["show", `main:${BRIEF}`])).toContain('"finish":"draft-pr"');
  expect(readFileSync(join(world.repo, "docs", "specs", "186.md"), "utf8")).toBe("# Fix it\n\nThe spec.\n");
  await until(
    () => readStateLine(world.pool, "implement-1.md").line,
    (state) => state.includes("node=implement"),
    { what: "implement-1 to be written" },
  );
  expect(readFileSync(join(world.pool, "issues", "implement-1.md"), "utf8")).toContain(
    "## The spec\n\n`docs/specs/186.md` in the pool checkout.",
  );
  await until(
    () => recordLine(world, grill.id),
    (state) => state.includes("status=ended"),
    { what: "the Grill to end" },
  );

  const again = await startLine(server, { grill: grill.id });
  expect(again.status).toBe(409);
  expect(reason(again)).toBe("the Line has no Conversation pass waiting for its Grill");
  const late = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE });
  expect(late.status).toBe(409);
  expect(reason(late)).toBe("grill start: the pool's Line has no Conversation pass waiting for a Grill");
});

conformance("line", "a spawn the Grill proposes is held for the operator, as anything proposed inside the Line is", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await startGrill(server);

  proposeSpawns(world, grill.id, [{ title: "Tidy the brief", body: BODY }]);
  const held = await until(
    () => snapshot(server),
    (snap) => snap.heldSpawns.length > 0,
    { what: "the Grill's proposal to be held" },
  );
  expect(held.heldSpawns.map((h) => [h.id, h.parentId, h.reason, h.title])).toEqual([
    ["proposal-1", grill.id, "line", "Tidy the brief"],
  ]);
  expect(held.pendingSpawns).toEqual([]);
  expect(held.state.tickets.map((ticket) => ticket.id)).toEqual([]);
  expect(held.state.conversations.map((c) => c.id)).toEqual([grill.id]);
  expect(held.state.log).toContain(
    `ticket ${grill.id}: 1 proposal held for the operator: proposed inside the Line (ADR-0037): proposal-1`,
  );
  expect(existsSync(join(world.pool, "runs", `${grill.id}.spawn.json`))).toBe(false);
});
