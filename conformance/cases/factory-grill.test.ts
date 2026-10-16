/**
 * The Grill and Start the Line on it (issue #187, ADR-0037), seen from
 * outside the server: a Conversation started with role "grill" launches on
 * the Grill Station's skills and Assignment with its first Turn and the Grill
 * teaching typed, one to a pool; POST /api/line/start with `grill` reads the
 * Line brief on the Grill's committed branch, refuses with the reason and
 * changes nothing when it is not there, and otherwise merges that branch
 * into the pool checkout, writes line.json and r1-implement and ends the
 * Grill. Only the operator's routes reach it: the Steward's have no such
 * verb. A spawn the Grill proposes is inside the Line, so it is held for the
 * operator.
 *
 * The Grill runs in a pane of the fake herdr, on a stub that holds the pane
 * the way a TUI does; a case plays the Grill by committing files on its
 * branch.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, LineStartResponse, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { snapshot } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { BODY, proposeSpawns } from "./conversations-support.ts";
import { lineOf, startLine } from "./factory-line-support.ts";

/** Every known harness's ready pattern and claude's idle prompt. */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

const CONFIG = {
  defaults: { harness: "claude", model: "m" },
  terminal: "herdr",
} satisfies PoolConfig;

const ISSUE = "The piece of work for this Line is issue #186. Read it and grill me on it.";

/** A terminal-backed pool with no Ticket yet, as Boot's Factory mode makes one. */
function grillWorld(t: Case, config: PoolConfig = CONFIG): World {
  const world = t.world({ config });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  for (const key of ["_claude", "_opencode"]) world.stubs.script(key, { hold: 150 });
  return world;
}

async function serve(t: Case, world: World): Promise<{ herdr: HerdrProcess; server: CaseServer }> {
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  return { herdr, server };
}

async function startGrill(server: CaseServer, body: Record<string, unknown> = {}): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE, ...body });
  expect(answer.status, answer.text).toBe(201);
  return answer.json<{ conversation: ConversationView }>().conversation;
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

const reason = (answer: { json<T>(): T }): string => answer.json<{ reason: string }>().reason;

conformance("factory", "the Grill launches on the Grill Station's skills and Assignment, its first Turn the work and the Grill teaching", async (t) => {
  const world = grillWorld(t);
  const { herdr, server } = await serve(t, world);

  const grill = await startGrill(server);
  expect(grill).toMatchObject({ id: "conv-1", title: "Grill", role: "grill", status: "live" });
  expect(grill.assignment).toMatchObject({
    harness: "claude",
    model: "opus",
    effort: "high",
    drivers: "my-grill-with-docs show-me",
  });
  expect(recordLine(world, "conv-1")).toContain(" role=grill ");
  const launch = world.stubs.calls().find((call) => call.harness === "claude");
  expect(launch?.argv).toEqual(expect.arrayContaining(["opus"]));

  const typed = (await submitted(herdr))[0]!;
  expect(typed.startsWith(`${ISSUE}\n\n---\n`)).toBe(true);
  expect(typed).toContain("You are the Grill of this pool's Line");
  expect(typed).toContain("Use these skills, in this order: my-grill-with-docs, show-me.");
  // The pool checkout is on main here, so the Line is named main.
  expect(typed).toContain("the spec at `docs/specs/main.md` and the Line brief at `docs/specs/main.brief.json`");
  // The brief may grant pushBase; the Grill asks about it only for a PR Finish (issue #193).
  expect(typed).toContain(
    'The brief may add "pushBase": true, which lets the Finish push the Line base (the branch this Line was cut from) to origin, only to create it or fast-forward it, never forcing',
  );
  expect(typed).toContain("Ask the operator about pushBase only when the finish is pr or draft-pr");
  expect(typed).toContain("The operator then presses Start the Line");

  const second = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE });
  expect(second.status).toBe(409);
  expect(reason(second)).toBe("grill start: conv-1 is already this pool's Grill");
});

conformance("factory", "the Grill takes the pool's Factory settings for its Station over the built-in ones", async (t) => {
  const world = grillWorld(t, {
    ...CONFIG,
    factory: { stations: { grill: { drivers: "my-grill-me", assign: { harness: "opencode", model: "g1" } } } },
  });
  const { server } = await serve(t, world);

  const grill = await startGrill(server, { title: "Grill: issue 186" });
  expect(grill.title).toBe("Grill: issue 186");
  expect(grill.assignment).toMatchObject({ harness: "opencode", model: "g1", effort: "high", drivers: "my-grill-me" });
});

conformance("factory", "Start the Line on the Grill refuses without a committed brief and from anything but the live Grill, and changes nothing", async (t) => {
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
  expect(reason(none)).toBe(`no Line brief: docs/specs/ in ${place} holds no *.brief.json`);

  // Written but not committed: it would never merge, so it does not count.
  const brief = JSON.stringify({ spec: "docs/specs/186.md", finish: "draft-pr" });
  grillWrites(world, grill, { "docs/specs/186.brief.json": brief }, false);
  expect(reason(await startLine(server, { grill: grill.id }))).toBe(
    `no Line brief: docs/specs/ in ${place} holds no *.brief.json`,
  );

  grillWrites(world, grill, { "docs/specs/186.brief.json": brief });
  expect(reason(await startLine(server, { grill: grill.id }))).toBe(
    `Line brief docs/specs/186.brief.json: its spec docs/specs/186.md is not in ${place}`,
  );
  grillWrites(world, grill, { "docs/specs/186.brief.json": "{" });
  expect(reason(await startLine(server, { grill: grill.id }))).toStartWith(
    "Line brief docs/specs/186.brief.json: not valid JSON",
  );

  const both = await startLine(server, { grill: grill.id, brief: "docs/specs/186.brief.json" });
  expect(both.status).toBe(400);
  expect(reason(both)).toBe("give brief or grill, not both: the Grill's brief is the one on its branch");
  const badGrill = await startLine(server, { grill: 7 });
  expect(badGrill.status).toBe(400);
  expect(reason(badGrill)).toBe("grill must be a Conversation id");

  // Operator-only: the Steward's routes have no Start the Line.
  const steward = await server.http.post("/api/steward/line/start", { conversation: talk.id, grill: grill.id });
  expect(steward.status).toBe(404);
  expect(reason(steward)).toBe("no steward route /api/steward/line/start");

  expect(await lineOf(server)).toBeNull();
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "r1-implement.md"))).toBe(false);
  expect(existsSync(join(world.repo, "docs", "specs", "186.brief.json"))).toBe(false);
  expect(recordLine(world, grill.id)).toContain("status=live");
});

conformance("factory", "Start the Line on the Grill refuses before merging when its first Ticket is already in the pool", async (t) => {
  const world = t.world({
    config: CONFIG,
    tickets: [{ file: "r1-implement.md", marker: "<!-- state: id=r1-implement blocked-by=none status=done -->" }],
  });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  for (const key of ["_claude", "_opencode"]) world.stubs.script(key, { hold: 150 });
  const { server } = await serve(t, world);
  const grill = await startGrill(server);
  grillWrites(world, grill, {
    "docs/specs/186.md": "# Fix it\n\nThe spec.\n",
    "docs/specs/186.brief.json": JSON.stringify({ spec: "docs/specs/186.md", finish: "draft-pr" }),
  });
  const before = world.git(["rev-parse", "main"]);

  const taken = await startLine(server, { grill: grill.id });
  expect(taken.status).toBe(409);
  expect(reason(taken)).toBe("ticket r1-implement is already in the pool: a Factory pool runs one Line");

  // Refused before the merge: the Line's branch is as it was and the Grill goes on.
  expect(world.git(["rev-parse", "main"])).toBe(before);
  expect(existsSync(join(world.repo, "docs", "specs", "186.brief.json"))).toBe(false);
  expect(existsSync(join(world.pool, "line.json"))).toBe(false);
  expect(recordLine(world, grill.id)).toContain("status=live");
});

conformance("factory", "Start the Line on the Grill merges its branch, writes line.json and r1-implement, and ends the Grill", async (t) => {
  const world = grillWorld(t);
  const { server } = await serve(t, world);
  const grill = await startGrill(server);
  grillWrites(world, grill, {
    "docs/specs/186.md": "# Fix it\n\nThe spec.\n",
    "docs/specs/186.brief.json": JSON.stringify({ spec: "docs/specs/186.md", finish: "draft-pr" }),
  });

  const started = await startLine(server, { grill: grill.id });
  expect(started.status, started.text).toBe(202);
  expect(started.json<LineStartResponse>()).toEqual({ ticketId: "r1-implement" });

  // The Grill's branch is merged into the pool checkout's branch.
  expect(world.git(["show", "main:docs/specs/186.brief.json"])).toContain('"finish":"draft-pr"');
  expect(readFileSync(join(world.repo, "docs", "specs", "186.md"), "utf8")).toBe("# Fix it\n\nThe spec.\n");
  expect(await lineOf(server)).toMatchObject({
    brief: { spec: "docs/specs/186.md", finish: "draft-pr" },
    briefPath: "docs/specs/186.brief.json",
    round: 1,
    station: "implement",
    ticket: "r1-implement",
  });
  expect(readStateLine(world.pool, "r1-implement.md").line).toContain("station=implement");
  await until(
    () => recordLine(world, grill.id),
    (line) => line.includes("status=ended"),
    { what: "the Grill to end" },
  );

  const again = await startLine(server, { grill: grill.id });
  expect(again.status).toBe(409);
  expect(reason(again)).toStartWith("the Line has already started: Round 1, r1-implement");
  const late = await server.http.post("/api/conversations", { role: "grill", opening: ISSUE });
  expect(late.status).toBe(409);
  expect(reason(late)).toBe("grill start: the Line has already started (Round 1, r1-implement)");
});

conformance("factory", "a spawn the Grill proposes is held for the operator, as anything proposed inside the Line is", async (t) => {
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
