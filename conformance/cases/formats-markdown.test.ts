/**
 * The markdown the engine reads and writes (the inventory's ticket C01, area
 * `formats`): the Ticket file's line-1 state line, its title heading and
 * spec, the spawn-assign token, the Conversation record's marker, and the
 * bytes an engine write leaves. Ticket and Conversation markdown are pinned
 * byte for byte (ADR-0036).
 *
 * Each case names the inventory rows it covers (docs/research/rust-port/
 * test-inventory.md, area `formats`) as `file:line` of the engine test it
 * came from, or `gap` with the source line for behaviour no test covered.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, EnrichedSnapshot } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectSameBytes, expectSameFile } from "../harness/equal.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { events, refusedStart, snapshot, ticket, ticketView, untilReview, untilStatus } from "./formats-helpers.ts";

const DEFAULTS = { defaults: { harness: "claude", model: "m" } };

/** The provenance paragraph the engine writes under a spawned Ticket's heading. */
function provenance(parent: string): string {
  return (
    `**Spawned by** ticket ${parent} (ADR-0010): the engine wrote this ticket at the super-step boundary ` +
    "from the attempt's Outcome proposal, engine-assigned id included. It is ordinary from here on: it " +
    "schedules, verifies, and may itself spawn, and the operator can edit or kill it before it schedules."
  );
}

// ---------------------------------------------------------------------------
// Pool load: the state line and the heading.
// ---------------------------------------------------------------------------

// engine.test.ts:382 pool loading › rejects a pool with a missing line-1 marker
conformance("formats", "a Ticket file with no line-1 state line stops the server at load, naming the file", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-no-marker.md", content: "# no marker here\n\nbody\n" }],
    config: DEFAULTS,
  });
  const refused = await refusedStart(world);
  expect(refused.code, refused.output).not.toBeNull();
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain(
    `pool load: ${join(world.pool, "issues", "01-no-marker.md")} has no line-1 state marker`,
  );
});

// gap: engine/pool.ts:88-111 (parseMarkerLine)
conformance("formats", "a state line missing id= or with an unknown status stops the server at load", async (t) => {
  const cases = [
    {
      content: "<!-- state: blocked-by=none status=ready -->\n\n# A\n",
      says: ": marker is missing id=",
    },
    {
      content: "<!-- state: id=01 blocked-by=none status=blocked -->\n\n# A\n",
      says: ": marker status must be one of ready|in-progress|done|checkpoint|closed, got 'blocked'",
    },
  ];
  for (const each of cases) {
    const world = t.world({ tickets: [{ file: "01-a.md", content: each.content }], config: DEFAULTS });
    const refused = await refusedStart(world);
    expect(refused.code, refused.output).not.toBeNull();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain(`pool load: ${join(world.pool, "issues", "01-a.md")}${each.says}`);
  }
});

// pool.test.ts:28 issue file metadata › reads the title heading and the spec body after it
conformance("formats", "the first heading is the Ticket's title and what follows it its spec", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-a.md",
        content: "<!-- state: id=01 blocked-by=none status=done -->\n\n# Ticket title\n\nSpec: what to build\n",
      },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  const view = await ticketView(server.http, "01");
  expect(view).toMatchObject({ id: "01", title: "Ticket title", status: "done", blockedBy: [] });
  expect((await events(server.http, "01")).spec).toBe("Spec: what to build");
});

// pool.test.ts:39 issue file metadata › titles a file with no heading as (untitled)
conformance("formats", "a Ticket file with no heading is (untitled) and its whole text is its spec", async (t) => {
  const content = "<!-- state: id=01 blocked-by=none status=done -->\nno heading here\n";
  const world = t.world({ tickets: [{ file: "01-a.md", content }], config: DEFAULTS });
  const server = await t.start(world);
  expect((await ticketView(server.http, "01"))?.title).toBe("(untitled)");
  expect((await events(server.http, "01")).spec).toBe(content.trim());
});

// pool.test.ts:47 issue file metadata › loadPoolMarkers exposes the metadata for every issue file
conformance("formats", "every Ticket file's title, blockers and spec are read, in file order", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-a.md", content: "<!-- state: id=01 blocked-by=none status=done -->\n\n# First\n\nbody one\n" },
      { file: "02-b.md", content: "<!-- state: id=02 blocked-by=01 status=done -->\n\n# Second\n\nbody two\n" },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  const tickets = (await snapshot(server.http)).state.tickets;
  expect(tickets.map((v) => [v.id, v.title, v.blockedBy])).toEqual([
    ["01", "First", []],
    ["02", "Second", ["01"]],
  ]);
  expect((await events(server.http, "01")).spec).toBe("body one");
  expect((await events(server.http, "02")).spec).toBe("body two");
});

// ---------------------------------------------------------------------------
// Spawned Tickets: spawned-by and spawn-assign.
// ---------------------------------------------------------------------------

// pool.test.ts:74 spawn namespace reservation › parses spawned-by on an engine-written spawn ticket
conformance("formats", "a spawned Ticket's spawned-by is read, so it inherits its parent's model", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01", { status: "done" }),
      {
        file: "01-spawn-1.md",
        marker: "<!-- state: id=01-spawn-1 blocked-by=none status=done spawned-by=01 -->",
        body: "# 01-spawn-1: Child",
      },
    ],
    config: { ...DEFAULTS, assign: { "01": { model: "parent-model" } } },
  });
  const server = await t.start(world);
  const child = await ticketView(server.http, "01-spawn-1");
  expect(child?.assignment.model).toBe("parent-model");
  expect(child?.reassign.sources.model).toBe("inherited");
});

// pool.test.ts:95 spawn namespace reservation › round-trips a spawn proposal's assign
// gap: engine/engine.ts:9753 (the spawned Ticket file, byte for byte)
conformance("formats", "a spawn proposal lands as a Ticket file whose bytes and spawn-assign token survive a restart", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS });
  const assign = { model: "child-model", effort: "max", drivers: "implement code-review" };
  world.stubs.script("01", {
    spawn: [{ title: "  Tidy up  ", body: "\n  Make it tidy, every file of it.\n\n", assign }],
  });
  const first = await t.start(world);
  await untilReview(first.http);
  await first.stop();

  const token = encodeURIComponent(JSON.stringify(assign));
  expect(token).not.toMatch(/\s/);
  expectSameFile(
    join(world.pool, "issues", "01-spawn-1.md"),
    `<!-- state: id=01-spawn-1 blocked-by=none status=done spawned-by=01 spawn-assign=${token} -->\n\n` +
      `# 01-spawn-1: Tidy up\n\n${provenance("01")}\n\nMake it tidy, every file of it.\n`,
  );

  const second = await t.start(world);
  const child = await ticketView(second.http, "01-spawn-1");
  expect(child?.assignment).toMatchObject({ harness: "claude", model: "child-model", effort: "max", drivers: "implement code-review" });
  expect(child?.reassign.sources).toMatchObject({ model: "requested", effort: "requested", drivers: "requested" });
});

// pool.test.ts:112 spawn namespace reservation › keeps only the four Assignment fields off a spawn-assign, never a verify
conformance("formats", "a spawn-assign token's verify is ignored: the child runs one plain Attempt", async (t) => {
  const token = encodeURIComponent(JSON.stringify({ effort: "max", verify: 3 }));
  const world = t.world({
    tickets: [
      ticket("01", { status: "done" }),
      {
        file: "01-spawn-1.md",
        marker: `<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=${token} -->`,
        body: "# 01-spawn-1: Child",
      },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  const child = await ticketView(server.http, "01-spawn-1");
  expect(child?.assignment.effort).toBe("max");
  expect(child?.reassign.verify).toBeNull();
  await untilStatus(world, "01-spawn-1.md", "done");
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01-spawn-1"]);
  const spawned = readEvents(world.pool, "01-spawn-1").filter((e) => e.kind === "spawned");
  expect(spawned.map((e) => [e.attempt, (e.payload as { branch: string | null }).branch])).toEqual([[1, null]]);
});

// pool.test.ts:120 spawn namespace reservation › fails pool load on a malformed spawn-assign, naming the file
// pool.test.ts:131 spawn namespace reservation › fails pool load on a spawn-assign field that is not a string
conformance("formats", "a spawn-assign that is not encoded JSON, or holds a field that is not a string, stops the server", async (t) => {
  const cases = [
    { token: "not-json", says: "spawn-assign is not valid encoded JSON" },
    { token: encodeURIComponent(JSON.stringify({ effort: 5 })), says: "spawn-assign.effort is not a string" },
  ];
  for (const each of cases) {
    const world = t.world({
      tickets: [
        ticket("01", { status: "done" }),
        {
          file: "01-spawn-1.md",
          marker: `<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 spawn-assign=${each.token} -->`,
          body: "# 01-spawn-1: Child",
        },
      ],
      config: DEFAULTS,
    });
    const refused = await refusedStart(world);
    expect(refused.code, refused.output).not.toBeNull();
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain(`pool load: ${join(world.pool, "issues", "01-spawn-1.md")}: ${each.says}`);
  }
});

// ---------------------------------------------------------------------------
// Engine writes into a Ticket file.
// ---------------------------------------------------------------------------

// engine.test.ts:9759 adding a blocker to a ticket marker › leaves every other byte of the file unchanged
conformance("formats", "a spawn's blocks adds to the blocked Ticket's blocked-by and changes no other byte", async (t) => {
  const original =
    "<!-- state: id=01 blocked-by=00 status=ready -->\n\n# One\n\nKeep   these  bytes.\n\n- a list\n\ttabbed\n";
  const world = t.world({
    tickets: [ticket("00"), { file: "01-t.md", content: original }],
    config: DEFAULTS,
  });
  // 00 waits until its proposal's blocks would still find 01 ready.
  world.stubs.script("00", { spawn: [{ title: "Before one", body: "Has to land before 01.", blocks: ["01"] }] });
  // 00-spawn-1 never finishes, so 01 stays blocked and its file stays as the edit left it.
  world.stubs.script("00-spawn-1", { status: "checkpoint", brief: "hold" });
  const server = await t.start(world);
  await until(
    () => readStateLine(world.pool, "01-t.md"),
    (line) => line.blockedBy.includes("00-spawn-1"),
    { ms: 30_000, what: "01's blocked-by to name 00-spawn-1" },
  );
  expectSameFile(join(world.pool, "issues", "01-t.md"), original.replace("blocked-by=00 ", "blocked-by=00,00-spawn-1 "));
  void server;
});

// gap: engine/engine.ts:9211 (landCheckpointBrief)
conformance("formats", "a checkpoint's Brief replaces a stale one at the file's end, after a rule", async (t) => {
  const body = "# A\n\nThe spec.\n\n---\n\n## Brief\n\nan old brief\n";
  const world = t.world({
    tickets: [{ file: "01-a.md", content: `<!-- state: id=01 blocked-by=none status=ready -->\n\n${body}` }],
    config: DEFAULTS,
  });
  world.stubs.script("01", { status: "checkpoint", brief: "pick a name" });
  await t.start(world);
  await untilStatus(world, "01-a.md", "checkpoint");
  expectSameFile(
    join(world.pool, "issues", "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=checkpoint -->\n\n# A\n\nThe spec.\n\n---\n\n## Brief\n\npick a name\n",
  );
});

// gap: engine/pool.ts:156-165 (writeMarkerStatus)
conformance("formats", "a status write into a CRLF Ticket file changes only status= and keeps every CRLF", async (t) => {
  const original = "<!-- state: id=01 blocked-by=none status=ready -->\r\n\r\n# A\r\n\r\nWork.\r\n";
  const world = t.world({ tickets: [{ file: "01-a.md", content: original }], config: DEFAULTS });
  await t.start(world);
  const path = join(world.pool, "issues", "01-a.md");
  await until(
    () => readFileSync(path, "utf8"),
    (text) => text.startsWith("<!-- state: id=01 blocked-by=none status=done -->\r\n"),
    { ms: 30_000, what: "01's CRLF state line to say status=done" },
  );
  expectSameFile(path, original.replace("status=ready", "status=done"));
});

// ---------------------------------------------------------------------------
// Conversation records.
// ---------------------------------------------------------------------------

/** What every pane the fake opens shows: claude's ready pattern and idle prompt. */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

async function terminalServer(t: Case, world: World): Promise<CaseServer> {
  world.stubs.script("_claude", { hold: 150 });
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  return t.start(world, { herdr });
}

function terminalWorld(t: Case, poolFiles: Record<string, string> = {}): World {
  return t.world({
    tickets: [ticket("01", { status: "done" })],
    config: { ...DEFAULTS, terminal: "herdr" },
    poolFiles,
  });
}

async function startConversation(server: CaseServer, body: unknown): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", body);
  expect(answer.status, answer.text).toBe(201);
  return answer.json<{ conversation: ConversationView }>().conversation;
}

async function endConversation(server: CaseServer, world: World, id: string): Promise<void> {
  const answer = await server.http.post("/api/conversations/end", { id });
  expect(answer.status, answer.text).toBeLessThan(300);
  await until(
    () => readFileSync(join(world.pool, "conversations", `${id}.md`), "utf8").split("\n", 1)[0]!,
    (line) => line.includes("status=ended"),
    { ms: 30_000, what: `${id}'s record to say status=ended` },
  );
}

function conversations(snap: EnrichedSnapshot): ConversationView[] {
  return snap.state.conversations;
}

// conversations.test.ts:322 Conversation storage › round-trips a marker, a spawned-by id and a multi-word drivers chain
conformance("formats", "a Conversation record's marker round-trips spawned-by and a percent-encoded drivers chain", async (t) => {
  const handWritten =
    "<!-- conversation: id=conv-1 status=ended spawned-by=conv-0 harness=claude model=m " +
    "drivers=implement%20resolving-merge-conflicts -->\n\n# Old talk\n\nhello\n";
  const world = terminalWorld(t, { "conversations/conv-1.md": handWritten });
  const server = await terminalServer(t, world);

  const old = conversations(await snapshot(server.http)).find((c) => c.id === "conv-1");
  expect(old).toMatchObject({ id: "conv-1", spawnedBy: "conv-0" });
  expect(old?.assignment.drivers).toBe("implement resolving-merge-conflicts");

  const view = await startConversation(server, {
    title: "New talk",
    assign: { drivers: "implement resolving-merge-conflicts" },
  });
  expect(view.id).toBe("conv-2");
  const path = join(world.pool, "conversations", "conv-2.md");
  const live = readFileSync(path, "utf8");
  expect(live.split("\n", 1)[0]).toBe(
    "<!-- conversation: id=conv-2 status=live spawned-by=none harness=claude model=m " +
      "drivers=implement%20resolving-merge-conflicts -->",
  );
  await endConversation(server, world, "conv-2");
  expectSameFile(path, live.replace("status=live", "status=ended"));
  expectSameFile(join(world.pool, "conversations", "conv-1.md"), handWritten);
});

// conversations.test.ts:351 Conversation storage › round-trips an effort, and writes no effort field for a record with none
conformance("formats", "a Conversation record carries effort= only when it has one, through its End", async (t) => {
  const world = terminalWorld(t);
  const server = await terminalServer(t, world);
  const withEffort = await startConversation(server, { title: "Effortful", assign: { effort: "xhigh" } });
  const without = await startConversation(server, { title: "Plain" });
  const path = (id: string) => join(world.pool, "conversations", `${id}.md`);
  const line = (id: string) => readFileSync(path(id), "utf8").split("\n", 1)[0]!;

  expectSameBytes(
    line(withEffort.id),
    `<!-- conversation: id=${withEffort.id} status=live spawned-by=none harness=claude model=m effort=xhigh drivers=implement -->`,
    "the effortful record's marker",
  );
  expectSameBytes(
    line(without.id),
    `<!-- conversation: id=${without.id} status=live spawned-by=none harness=claude model=m drivers=implement -->`,
    "the plain record's marker",
  );
  const before = readFileSync(path(withEffort.id), "utf8");
  await endConversation(server, world, withEffort.id);
  expectSameFile(path(withEffort.id), before.replace("status=live", "status=ended"));

  const views = conversations(await snapshot(server.http));
  expect(views.find((c) => c.id === withEffort.id)?.assignment.effort).toBe("xhigh");
  expect(views.find((c) => c.id === without.id)?.assignment.effort).toBeUndefined();
});
