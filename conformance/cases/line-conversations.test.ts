/**
 * A Line's Conversation nodes (ADR-0040), seen from outside the server: once the Line has begun on a
 * Plan whose entry is a Conversation node, the engine opens that node's first pass, `grill-1`, as a
 * Conversation of its own on the node's skill and Assignment, its record naming the node and its
 * first Turn the Line's work and the pass's teaching. Ending it reads the Line brief at the pass's
 * path on its committed branch: a missing or invalid one, or one whose spec is not beside it,
 * refuses the End with the reason and changes nothing. A valid one ends it and merges its branch
 * into the Line's, and only then does the next node's Ticket get written, carrying the brief's spec
 * and items. Ended as closed, it merges nothing and hands on `closed`, which with no edge of its own
 * reaches the Finish. A spawn it proposes is inside the Line, so it is held for the operator.
 *
 * The pass runs in a pane of the fake herdr, on a stub that holds the pane the way a TUI does; a
 * case plays the agent by committing files on its branch.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, EnrichedSnapshot, PlanFile, PlanResponse, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import { snapshot } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { BODY, proposeSpawns, startConversation } from "./conversations-support.ts";
import { atCheckpoint, begun, interruptOn, lineOf, reason } from "./line-support.ts";
import { edge, node, plan as planOf } from "./plans-support.ts";

/** Every known harness's ready pattern and claude's idle prompt. */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

const CONFIG = {
  defaults: { harness: "claude", model: "m" },
  terminal: "herdr",
} satisfies PoolConfig;

/** The Line brief's path for the Grill's first pass on a pool checkout on main. */
const BRIEF = "docs/specs/main.grill-1.brief.json";

const SPEC = "docs/specs/186.md";

/** A terminal-backed pool with no Ticket yet, as Boot's Line mode makes one. */
function grillWorld(t: Case): World {
  const world = t.world({ config: CONFIG });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  for (const key of ["_claude", "_opencode"]) world.stubs.script(key, { hold: 150 });
  return world;
}

/** Serve the pool and begin its Line on the work, as Boot does. */
async function serve(
  t: Case,
  world: World,
  plan: string | PlanFile = "factory-today",
): Promise<{ herdr: HerdrProcess; server: CaseServer }> {
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  await begun(server, { plan, work: "#186" });
  return { herdr, server };
}

function viewOf(snap: EnrichedSnapshot, id: string): ConversationView | undefined {
  return snap.state.conversations.find((c) => c.id === id);
}

/** The engine opened grill-1 and it is live in its pane. */
async function opened(server: CaseServer): Promise<ConversationView> {
  const snap = await until(
    () => snapshot(server),
    (s) => viewOf(s, "grill-1")?.paneId != null,
    { what: "grill-1 to open" },
  );
  return viewOf(snap, "grill-1")!;
}

/** POST /api/conversations/end. */
function end(server: CaseServer, body: Record<string, unknown>) {
  return server.http.post("/api/conversations/end", body);
}

/** Where the server keeps a pool branch's worktree. */
function worktreeOf(world: World, branch: string): string {
  return join(world.repo, ".git", "pool-worktrees", branch.split("/")[1]!, branch.split("/")[2]!);
}

/** Play the pass: write files in its worktree and, unless told not to, commit them on its branch. */
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

function kinds(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => event.kind);
}

/** Factory today with its Grill node on another Assignment and skill. */
async function grillOn(server: CaseServer, grill: Record<string, unknown>): Promise<PlanFile> {
  const { plan } = (await server.http.get("/api/plans/factory-today")).json<PlanResponse>();
  return { ...plan, nodes: plan.nodes.map((n) => (n.id === "grill" ? { ...n, ...grill } : n)) } as PlanFile;
}

conformance("line", "the engine opens grill-1 on the Conversation node's skill and Assignment, its first Turn the work and the pass's teaching", async (t) => {
  const world = grillWorld(t);
  const { herdr, server } = await serve(t, world);

  const grill = await opened(server);
  expect(grill).toMatchObject({ id: "grill-1", title: "Grill, pass 1", node: "grill", status: "live" });
  expect(grill.role).toBeUndefined();
  expect(grill.assignment).toMatchObject({
    harness: "claude",
    model: "opus",
    effort: "high",
    drivers: "my-grill-with-docs",
  });
  expect(recordLine(world, "grill-1")).toStartWith("<!-- conversation: id=grill-1 status=live ");
  expect(recordLine(world, "grill-1")).toEndWith(" node=grill -->");
  const launch = world.stubs.calls().find((call) => call.harness === "claude");
  expect(launch?.argv).toEqual(expect.arrayContaining(["opus"]));

  const typed = (await submitted(herdr))[0]!;
  expect(typed).toStartWith("You are the Grill Conversation (`grill-1`) of this pool's Line (ADR-0040)");
  expect(typed).toContain(`write the spec at \`docs/specs/main.md\` and the Line brief at \`${BRIEF}\``);
  expect(typed).toContain(
    '"pushBase": true (the Finish may push the Line base to origin, only to create it or fast-forward it, never forcing)',
  );
  expect(typed).toContain(
    "## The Line's work\n\nThe piece of work for this Line is issue #186. Read it (gh issue view 186).",
  );
  expect((await lineOf(server))?.nodes.find((n) => n.id === "grill")).toMatchObject({ pass: 1, tickets: ["grill-1"] });

  // Operator-started Conversations keep the engine's own counter.
  const talk = await server.http.post("/api/conversations", { title: "Talk" });
  expect(talk.status, talk.text).toBe(201);
  expect(talk.json<{ conversation: ConversationView }>().conversation.id).toBe("conv-1");
});

conformance("line", "a Conversation pass takes its Assignment and skill from the Plan's Conversation node", async (t) => {
  const world = grillWorld(t);
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  const plan = await grillOn(server, { skill: "my-grill-me", assign: { harness: "opencode", model: "g1", effort: "high" } });
  await begun(server, { plan, work: "#186" });

  const grill = await opened(server);
  expect(grill.assignment).toMatchObject({ harness: "opencode", model: "g1", effort: "high", drivers: "my-grill-me" });
});

conformance("line", "a Line Conversation's End refuses without a committed, valid brief whose spec is beside it, and changes nothing", async (t) => {
  const world = grillWorld(t);
  const { herdr, server } = await serve(t, world);
  const grill = await opened(server);
  const before = world.git(["rev-parse", "main"]);
  const closes = herdr.calls.length;

  const place = `grill-1's committed branch ${grill.branch}`;
  const none = await end(server, { id: "grill-1" });
  expect(none.status).toBe(409);
  expect(reason(none)).toBe(`${place} has no Line brief at ${BRIEF}`);

  // Written but not committed: it would never merge, so it does not count.
  const brief = JSON.stringify({ spec: SPEC, finish: "draft-pr" });
  grillWrites(world, grill, { [BRIEF]: brief }, false);
  expect(reason(await end(server, { id: "grill-1" }))).toBe(`${place} has no Line brief at ${BRIEF}`);

  grillWrites(world, grill, { [BRIEF]: brief });
  expect(reason(await end(server, { id: "grill-1" }))).toBe(`Line brief ${BRIEF}: its spec ${SPEC} is not on ${place}`);
  grillWrites(world, grill, { [BRIEF]: "{" });
  expect(reason(await end(server, { id: "grill-1" }))).toStartWith(`Line brief ${BRIEF}: not valid JSON`);
  grillWrites(world, grill, {
    [SPEC]: "# Fix it\n\nThe spec.\n",
    [BRIEF]: JSON.stringify({ spec: SPEC, nodes: { nope: { note: "n" } } }),
  });
  expect(reason(await end(server, { id: "grill-1" }))).toBe(`Line brief ${BRIEF}: nodes: the Plan has no node nope`);
  grillWrites(world, grill, {
    [BRIEF]: JSON.stringify({ spec: SPEC, nodes: { implement: { assign: { harness: "nonesuch" } } } }),
  });
  expect(reason(await end(server, { id: "grill-1" }))).toStartWith(
    `Line brief ${BRIEF}: node implement names unknown harness 'nonesuch'. Known: `,
  );

  // Refused before anything moved: the talk goes on, its tab open, and nothing merged or was written.
  expect(world.git(["rev-parse", "main"])).toBe(before);
  expect(existsSync(join(world.repo, BRIEF))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);
  expect(recordLine(world, "grill-1")).toContain("status=live");
  expect(kinds(world, "grill-1")).not.toContain("end-requested");
  expect(viewOf(await snapshot(server), "grill-1")).toMatchObject({ status: "live", ending: false, paneId: grill.paneId });
  await herdr.settle();
  expect(herdr.calls.slice(closes).filter((call) => call.method === "tab.close")).toEqual([]);
  expect((await lineOf(server))?.nodes.find((n) => n.id === "grill")).toMatchObject({ pass: 1, tickets: ["grill-1"] });
});

conformance("line", "a valid brief's End merges the Conversation's branch, and only then is implement-1 written on the brief's spec and items", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await opened(server);
  grillWrites(world, grill, {
    [SPEC]: "# Fix it\n\nThe spec.\n",
    [BRIEF]: JSON.stringify({
      spec: SPEC,
      finish: "draft-pr",
      items: [
        { title: "Parse the flag", body: "Read --work as an issue number." },
        { title: "Print the base", body: "" },
      ],
    }),
  });

  const ended = await end(server, { id: "grill-1" });
  expect(ended.status, ended.text).toBe(202);
  await until(
    () => readStateLine(world.pool, "implement-1.md").line,
    (state) => state.includes("node=implement"),
    { what: "implement-1 to be written" },
  );
  // The branch merged into the Line's before the pass handed on.
  expect(world.git(["show", `main:${BRIEF}`])).toContain('"finish":"draft-pr"');
  expect(readFileSync(join(world.repo, SPEC), "utf8")).toBe("# Fix it\n\nThe spec.\n");
  expect(recordLine(world, "grill-1")).toContain("status=ended");
  const endedEvent = readEvents(world.pool, "grill-1").find((event) => event.kind === "ended");
  expect(endedEvent?.payload).toEqual({ closing: null, by: "operator", merged: true });

  const implement = readFileSync(join(world.pool, "issues", "implement-1.md"), "utf8");
  expect(implement).toContain(`## The spec\n\n\`${SPEC}\` in the pool checkout.`);
  for (const part of ["Parse the flag", "Read --work as an issue number.", "Print the base"]) {
    expect(implement).toContain(part);
  }
  const lineFile = readFileSync(join(world.pool, "line.json"), "utf8");
  expect(lineFile).toContain("Parse the flag");
  const line = (await lineOf(server))!;
  expect(line.nodes.find((n) => n.id === "grill")).toMatchObject({ passes: 1, tickets: [] });
  expect(line.plan.nodes.find((n) => n.id === "finish")).toMatchObject({ act: "draft-pr" });
  const snap = await snapshot(server);
  expect(snap.state.log).toContain("line: grill-1 hands on its brief");
  expect(snap.state.log.filter((l) => l === "line: grill-1 hands on its brief")).toHaveLength(1);

  const again = await end(server, { id: "grill-1" });
  expect(again.status).toBe(404);
});

conformance("line", "a brief's items reach a per-item node, which writes a copy per item up to its cap once the pass merges", async (t) => {
  const world = grillWorld(t);
  const talk = planOf(
    [node.conversation("grill"), node.agent("build", { copies: { perItem: 2 } }), node.merger("build-merge", "build"), node.finish()],
    [edge("grill", "done", "build"), edge("build", "done", "build-merge"), edge("build-merge", "done", "finish")],
    "Grill then build",
  );
  const { server } = await serve(t, world, talk);
  const grill = await opened(server);
  const items = [
    { title: "Parse the flag", body: "Read --work as an issue number." },
    { title: "Print the base", body: "Name the base the Line was cut from." },
    { title: "Log the cut", body: "" },
  ];
  grillWrites(world, grill, { [SPEC]: "# Fix it\n\nThe spec.\n", [BRIEF]: JSON.stringify({ spec: SPEC, finish: "none", items }) });

  expect((await end(server, { id: "grill-1" })).status).toBe(202);
  for (const id of ["build-1.1", "build-1.2"]) {
    await until(() => readStateLine(world.pool, `${id}.md`).line, (state) => state.includes(`id=${id} `), { what: `${id} to be written` });
  }
  // The panes of the first two copies stay open, so the cap of 2 holds the third Item in the queue.
  expect(existsSync(join(world.pool, "issues", "build-1.md"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "build-1.3.md"))).toBe(false);
  expect((await lineOf(server))?.nodes.find((n) => n.id === "build")).toMatchObject({ tickets: ["build-1.1", "build-1.2"], queued: 1 });
  items.slice(0, 2).forEach((item, i) => {
    const copy = readFileSync(join(world.pool, "issues", `build-1.${i + 1}.md`), "utf8");
    expect(copy).toContain(`## Your item\n\n### ${item.title}\n\n${item.body}`);
    expect(copy).toContain("node=build");
  });
  expect(readStateLine(world.pool, "build-1.1.md").blockedBy).toEqual([]);
  expect(world.git(["show", `main:${BRIEF}`])).toContain("Parse the flag");
  expect((await snapshot(server)).state.log.filter((l) => l === "line: grill-1 hands on its brief")).toHaveLength(1);
});

conformance("line", "End as closed merges nothing, keeps the branch, and hands on closed, which reaches the Finish", async (t) => {
  const world = grillWorld(t);
  const { herdr, server } = await serve(t, world);
  const grill = await opened(server);
  grillWrites(world, grill, { "notes.md": "half a plan\n" });
  const before = world.git(["rev-parse", "main"]);
  const from = herdr.calls.length;

  const closed = await end(server, { id: "grill-1", close: true });
  expect(closed.status, closed.text).toBe(202);
  const atFinish = await atCheckpoint(server, "finish-1");
  expect(readStateLine(world.pool, "finish-1.md").line).toContain("id=finish-1 blocked-by=none status=checkpoint node=finish hold");
  expect(interruptOn(atFinish, "finish-1")).toContain("Work upstream halted: ended as closed.");
  expect(atFinish.state.log).toContain("line: grill-1 hands on closed");
  expect(existsSync(join(world.pool, "issues", "implement-1.md"))).toBe(false);

  // Nothing merged; the worktree went and the branch with its work stayed.
  expect(world.git(["rev-parse", "main"])).toBe(before);
  expect(existsSync(join(world.repo, "notes.md"))).toBe(false);
  expect(world.git(["branch", "--list", grill.branch!])).toContain(grill.branch!);
  expect(existsSync(worktreeOf(world, grill.branch!))).toBe(false);
  expect(recordLine(world, "grill-1")).toContain("status=ended");
  const events = readEvents(world.pool, "grill-1");
  expect(events.find((event) => event.kind === "end-requested")?.payload).toEqual({ closing: null, close: true });
  expect(events.find((event) => event.kind === "ended")?.payload).toEqual({
    closing: null,
    by: "operator",
    merged: false,
    close: true,
  });
  expect(events.map((event) => event.kind)).not.toContain("merged");
  await herdr.waitForCall((call) => call.method === "tab.close", { from, ms: 30_000 });
});

conformance("line", "a spawn a Line Conversation proposes is held for the operator, as anything proposed inside the Line is", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await opened(server);

  proposeSpawns(world, grill.id, [{ title: "Tidy the brief", body: BODY }]);
  const held = await until(
    () => snapshot(server),
    (snap) => snap.heldSpawns.length > 0,
    { what: "the Conversation's proposal to be held" },
  );
  expect(held.heldSpawns.map((h) => [h.id, h.parentId, h.reason, h.title])).toEqual([
    ["proposal-1", "grill-1", "line", "Tidy the brief"],
  ]);
  expect(held.pendingSpawns).toEqual([]);
  expect(held.state.tickets.map((ticket) => ticket.id)).toEqual([]);
  expect(held.state.conversations.map((c) => c.id)).toEqual(["grill-1"]);
  expect(held.state.log).toContain(
    "ticket grill-1: 1 proposal held for the operator: proposed inside the Line (ADR-0037): proposal-1",
  );
  expect(existsSync(join(world.pool, "runs", "grill-1.spawn.json"))).toBe(false);
});

conformance("line", "a spawn a Conversation holds once the Finish hold is written is what the Finish waits for, on GET /api/line and the snapshot, until it is discarded", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  await opened(server);
  expect((await end(server, { id: "grill-1", close: true })).status).toBe(202);
  const atFinish = await atCheckpoint(server, "finish-1");
  expect(atFinish.line).toMatchObject({ status: "finishing", waitingFor: [] });

  const talk = await startConversation(server, { title: "Planner" });
  await until(() => snapshot(server), (s) => viewOf(s, talk.id)?.paneId != null, { what: `${talk.id} to open` });
  proposeSpawns(world, talk.id, [{ title: "Probe", body: BODY, overlaps: ["grill-1"] }]);
  const held = await until(() => snapshot(server), (s) => s.heldSpawns.length > 0, { what: "the proposal to be held" });
  expect(held.heldSpawns.map((h) => [h.id, h.parentId, h.reason])).toEqual([["proposal-1", talk.id, "overlaps"]]);
  const waiting = await until(() => lineOf(server), (line) => (line?.waitingFor.length ?? 0) > 0, {
    what: "GET /api/line to name the Held spawn",
  });
  expect(waiting).toMatchObject({ status: "finishing", waitingFor: ["the Held spawn proposal-1"] });
  expect((await snapshot(server)).line?.waitingFor).toEqual(["the Held spawn proposal-1"]);
  const refused = await server.http.post("/api/resume", { ticketId: "finish-1", note: "approved" });
  expect(refused.status).toBe(409);
  expect(refused.json<{ error: string }>().error).toBe("answer: the Finish is waiting for: the Held spawn proposal-1");

  expect((await server.http.post("/api/spawns/held/discard", { id: "proposal-1" })).status).toBeLessThan(300);
  const cleared = await until(() => lineOf(server), (line) => line?.waitingFor.length === 0, {
    what: "GET /api/line to wait for nothing",
  });
  expect(cleared).toMatchObject({ status: "finishing", waitingFor: [] });
  expect((await snapshot(server)).line?.waitingFor).toEqual([]);
});
