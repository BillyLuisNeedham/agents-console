/**
 * Conversations, their lifecycle (ADR-0018, the inventory's ticket C16):
 * storage, start and launch, ending, spawn.json adoption, the teaching Turn
 * and Seeded Pools, seen from outside the server (ADR-0036). Every
 * Conversation here runs in a pane of the fake herdr, on a stub harness
 * that holds the pane the way a TUI does.
 *
 * The teaching Turn is pinned byte for byte (the inventory's Decided 4): the
 * template below is the TypeScript server's, copied, and a case compares
 * what was typed into the pane against it whole.
 *
 * Each case names the inventory rows it covers (docs/research/rust-port/
 * test-inventory.md, area `conversations`) as `file:line` of the engine test
 * it came from.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, EnrichedSnapshot, PoolConfig, TicketEvent } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectSameBytes, expectSameFile } from "../harness/equal.ts";
import type { HerdrCall, HerdrOptions, HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import { freePort, serverArgv, serverChoice } from "../harness/server.ts";
import type { TicketSeed, World, WorldSpec } from "../harness/world.ts";

// ---------------------------------------------------------------------------
// The world a Conversation runs in.
// ---------------------------------------------------------------------------

/**
 * What every pane the fake opens shows once its wrapper runs: each known
 * harness's ready pattern (claude's "Claude Code v", opencode's "Ask
 * anything") and claude's idle prompt glyph, so a launch on either passes
 * its readiness wait and a claude Turn settles to waiting.
 */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

/** Long enough for any case; the stub ends early once its world is gone. */
const HOLD_SECONDS = 150;

const DONE_01: TicketSeed = { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" };

interface PoolSpec {
  /** console.json on top of claude/m defaults and terminal herdr. */
  config?: PoolConfig;
  tickets?: TicketSeed[];
  repoFiles?: Record<string, string>;
}

/** A terminal-backed git pool whose stub TUIs hold their panes. */
function terminalWorld(t: Case, spec: PoolSpec = {}): World {
  const world = t.world({
    tickets: spec.tickets ?? [DONE_01],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr", ...spec.config },
    ...(spec.repoFiles ? { repoFiles: spec.repoFiles } : {}),
  } satisfies WorldSpec);
  // A terminal-backed launch names no outcome file in its argv, so each is
  // keyed by its binary's name.
  for (const key of ["_claude", "_opencode", "_agent"]) world.stubs.script(key, { hold: HOLD_SECONDS });
  return world;
}

interface Running {
  world: World;
  herdr: HerdrProcess;
  server: CaseServer;
}

async function startTerminal(t: Case, world: World, herdrOptions: HerdrOptions = {}): Promise<Running> {
  const herdr = await t.herdr(world, { rendered: READY_FRAME, ...herdrOptions });
  const server = await t.start(world, { herdr });
  return { world, herdr, server };
}

interface StartBody {
  title?: string;
  opening?: string;
  role?: string;
  assign?: { harness?: string; model?: string; effort?: string; drivers?: string };
}

/** POST /api/conversations, expecting the 201 and handing back its view. */
async function startConversation(server: CaseServer, body: StartBody): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", body);
  expect(answer.status, answer.text).toBe(201);
  return answer.json<{ conversation: ConversationView }>().conversation;
}

async function state(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  expect(answer.status).toBe(200);
  const snapshot = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snapshot === null) throw new Error("GET /api/state served no snapshot");
  return snapshot;
}

function conversationFile(world: World, id: string): string {
  return join(world.pool, "conversations", `${id}.md`);
}

function readConversationFile(world: World, id: string): string {
  return readFileSync(conversationFile(world, id), "utf8");
}

/** The status on a Conversation record's marker line. */
function recordStatus(world: World, id: string): string {
  const path = conversationFile(world, id);
  if (!existsSync(path)) return "";
  return /status=([a-z]+)/.exec(readFileSync(path, "utf8").split("\n", 1)[0]!)?.[1] ?? "";
}

/** A Conversation record as the server writes one, byte for byte. */
function recordBytes(rec: {
  id: string;
  status: string;
  spawnedBy?: string;
  harness: string;
  model: string;
  effort?: string;
  drivers: string;
  title: string;
  opening?: string;
}): string {
  const fields = [
    `id=${rec.id}`,
    `status=${rec.status}`,
    `spawned-by=${rec.spawnedBy ?? "none"}`,
    `harness=${rec.harness}`,
    `model=${rec.model}`,
    ...(rec.effort ? [`effort=${rec.effort}`] : []),
    `drivers=${rec.drivers}`,
  ];
  return `<!-- conversation: ${fields.join(" ")} -->\n\n# ${rec.title}\n\n${rec.opening ?? ""}\n`;
}

function kinds(events: TicketEvent[]): string[] {
  return events.map((event) => event.kind);
}

function eventOf(events: TicketEvent[], kind: string): TicketEvent {
  const found = events.find((event) => event.kind === kind);
  if (!found) throw new Error(`no ${kind} event in ${JSON.stringify(kinds(events))}`);
  return found;
}

function callsOf(herdr: HerdrProcess, method: string): HerdrCall[] {
  return herdr.calls.filter((call) => call.method === method);
}

function branches(world: World): string[] {
  return world
    .git(["branch", "--list", "--format=%(refname:short)"])
    .split("\n")
    .filter((line) => line !== "");
}

/** A pool branch as the server names one: `pool/<8 hex of the checkout>/<id>`. */
function expectPoolBranch(branch: string | null, id: string): string {
  expect(branch).toMatch(new RegExp(`^pool/[0-9a-f]{8}/${id}$`));
  return branch!;
}

/** Where the server keeps a pool branch's worktree. */
function worktreeOf(world: World, branch: string): string {
  return join(world.repo, ".git", "pool-worktrees", branch.split("/")[1]!, branch.split("/")[2]!);
}

/** What the fake's panes have had submitted (each Enter after the wrapper), in order. */
function submitted(herdr: HerdrProcess): Promise<string[]> {
  return herdr.control<string[]>("submitted");
}

/** Wait for `count` submits, then hand them all back. */
async function submittedAtLeast(herdr: HerdrProcess, count: number): Promise<string[]> {
  return until(() => submitted(herdr), (texts) => texts.length >= count, { what: `${count} submitted Turns` });
}

function spawnJson(world: World, id: string): string {
  return join(world.pool, "runs", `${id}.spawn.json`);
}

function writeSpawnJson(world: World, id: string, spawn: unknown): void {
  writeFileSync(spawnJson(world, id), JSON.stringify({ spawn }));
}

const BODY = "A follow-up with well over twenty characters of intent to work from.";

// ---------------------------------------------------------------------------
// The teaching Turn, as engine/prompt.ts builds it (buildConversationTeaching).
// ---------------------------------------------------------------------------

interface TeachingAssignment {
  harness?: string;
  model?: string;
  effort?: string;
  drivers?: string;
}

function describeAssignment(a: TeachingAssignment | undefined): string {
  const field = (value: string | undefined) => (value ? value : "(none)");
  const effort = a?.effort ? `, effort ${a.effort}` : "";
  return `harness ${field(a?.harness)}, model ${field(a?.model)}${effort}, drivers ${field(a?.drivers)}`;
}

function conversationTeaching(parts: {
  pool: string;
  id: string;
  own: TeachingAssignment;
  defaults: TeachingAssignment | undefined;
  perFile: number;
}): string {
  const spawnPath = join(parts.pool, "runs", `${parts.id}.spawn.json`);
  const ledgerPath = join(parts.pool, "runs", "spawn-ledger.md");
  const perFile = parts.perFile;
  return [
    "---",
    "",
    "Load the my-console-citizen skill: it is how to work inside this pool.",
    "",
    "You can start follow-up work without leaving this conversation. Write " +
      `JSON to ${spawnPath}: {"spawn": [...]}, one entry per follow-up, each ` +
      'shaped {"title": "...", "body": "...", "blockedBy": ["id", ...], ' +
      '"kind": "ticket" or "conversation", "assign": {"harness": "...", ' +
      '"model": "...", "effort": "...", "drivers": "..."}}.',
    "",
    "The body needs at least 20 characters of intent for a fresh agent to " +
      'work from. "blockedBy" is optional and may only name Tickets, never ' +
      "another Conversation (an entry naming one is dropped and logged). " +
      '"kind" defaults to "ticket"; "conversation" starts a new open-ended ' +
      'talk instead of a Ticket. "assign" is optional; when absent the ' +
      "follow-up inherits this Conversation's own Assignment, and any field " +
      "that leaves empty falls through to the pool defaults. " +
      '"assign" takes harness, model, effort and drivers only; a verify in it ' +
      "is ignored, since grading is the operator's call." +
      " " +
      'A follow-up that must run before other work may add "blocks": ["id", ' +
      '...] to make those tickets wait for it, or "blocks": "all" to make ' +
      "every ticket that has not started yet wait for it; a ticket already " +
      "running is never interrupted, and blocks is only for a ticket.",
    "",
    `This Conversation's Assignment: ${describeAssignment(parts.own)}. ` +
      `The pool defaults: ${describeAssignment(parts.defaults)}. Set "assign" only ` +
      "for a field the follow-up needs different; when no model would " +
      "resolve, ask the operator here before you write the file.",
    "",
    "The engine polls for this file, reads it, and deletes it once read: " +
      "write it whenever you like, mid-conversation, not only once. Caps: " +
      (perFile === 0
        ? "0 entries honored per file written: the pool's cap is 0, so every " +
          "entry is held for the operator to adopt or discard and none " +
          "starts on its own; "
        : `${perFile} ${perFile === 1 ? "entry" : "entries"} honored per file written, ` +
          "and entries beyond it are held for the operator to adopt or discard; ") +
      "unlike a Ticket's own spawns there is no run-wide cap on what a " +
      "Conversation spawns.",
    "",
    `Before you propose anything, read the Spawn ledger at ${ledgerPath}: ` +
      "every Ticket and Conversation in the pool, and every proposal still " +
      "waiting to land or held for the operator. Do not propose work it " +
      "already lists. If a proposal still overlaps something there, add " +
      '"overlaps": ["id", ...] naming what it overlaps: it is then held for ' +
      "the operator to decide instead of landing.",
    "",
    "A spawned Ticket reports back here as a Turn typed into this " +
      "conversation once it ends (done, or checkpoint with its Brief) and " +
      "you are next idle: its id, title, outcome, branch, and a diff " +
      "summary. A spawned Conversation reports back the same way once the " +
      "operator ends it: its branch and the operator's closing note, if " +
      "any. Both inform only; you cannot answer either one's own Interrupt.",
    "",
    "You never write pool state yourself: no ticket files, no ids, no " +
      "statuses, no status markers. You propose; the engine writes.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Storage and Seeded Pools.
// ---------------------------------------------------------------------------

// conversations.test.ts:376
conformance("conversations", "a pool with no conversations/ directory boots and serves no Conversations", async (t) => {
  const world = t.world({ tickets: [DONE_01], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);

  expect((await state(server)).state.conversations).toEqual([]);
  expect(existsSync(join(world.pool, "conversations"))).toBe(false);
});

// conversations.test.ts:703
conformance("conversations", "a Seeded Pool with an empty issues/ beside conversations/ boots and serves its Conversation", async (t) => {
  const world = t.world({
    poolFiles: {
      "conversations/conv-1.md":
        "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n# Talk\n\n\n",
    },
  });
  const server = await t.start(world);

  const snapshot = await until(
    () => state(server),
    (got) => got.phase !== "running",
    { what: "the pool to settle" },
  );
  expect(snapshot.state.tickets).toEqual([]);
  expect(snapshot.state.conversations.map((c) => [c.id, c.title, c.status])).toEqual([["conv-1", "Talk", "ended"]]);
});

// pool.test.ts:201
conformance("conversations", "a Seeded Pool with an empty issues/ and an empty conversations/ directory boots", async (t) => {
  const world = t.world({});
  mkdirSync(join(world.pool, "conversations"));
  const server = await t.start(world);

  const snapshot = await state(server);
  expect(snapshot.state.tickets).toEqual([]);
  expect(snapshot.state.conversations).toEqual([]);
});

// conversations.test.ts:727, pool.test.ts:206
conformance("conversations", "a pool with an empty issues/ and no conversations/ directory is refused at start", async (t) => {
  const world = t.world({});
  const proc = Bun.spawn(serverArgv(serverChoice(), world.pool, await freePort()), {
    env: world.env(join(world.root, "no-herdr.sock")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => null)]);
  if (exited === null) proc.kill("SIGKILL");
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());

  expect(exited).not.toBeNull();
  expect(exited).not.toBe(0);
  expect(output).toContain(`pool load: no Issue files in ${join(world.pool, "issues")}`);
  expect(output).toContain("conversations/");
});

// ---------------------------------------------------------------------------
// Starting one.
// ---------------------------------------------------------------------------

// conversations.test.ts:384
conformance("conversations", "a start on a headless pool is refused with a 409 and writes no record", async (t) => {
  const world = t.world({ tickets: [DONE_01], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);

  const answer = await server.http.post("/api/conversations", { title: "A talk" });

  expect(answer.status).toBe(409);
  expect(answer.json<{ reason: string }>().reason).toBe(
    'conversation start: the pool is not terminal-backed (set console.json terminal: "herdr")',
  );
  expect(existsSync(join(world.pool, "conversations"))).toBe(false);
  expect(world.stubs.calls()).toEqual([]);
});

// Gaps: conversations, the route's own refusals (engine/server.ts:1962-1970).
conformance("conversations", "a start with an unknown role or a blank title is refused with a 400", async (t) => {
  const { server } = await startTerminal(t, terminalWorld(t));

  const admin = await server.http.post("/api/conversations", { title: "Talk", role: "admin" });
  expect(admin.status).toBe(400);
  expect(admin.json<object>()).toEqual({ reason: 'role must be "steward" when given' });

  const blank = await server.http.post("/api/conversations", { title: "   " });
  expect(blank.status).toBe(400);
  expect(blank.json<object>()).toEqual({ reason: "title is required" });

  expect((await state(server)).state.conversations).toEqual([]);
});

// Gaps: conversations, a Steward's default title and an explicit
// Assignment (engine/server.ts:1963).
conformance("conversations", "a Steward start takes the title Steward, and a start on an explicit Assignment launches on it", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);

  const steward = await startConversation(server, { role: "steward" });
  expect(steward).toMatchObject({ id: "conv-1", title: "Steward", role: "steward", status: "live" });

  const talk = await startConversation(server, { title: "Talk", assign: { harness: "opencode", model: "m2" } });
  expect(talk.assignment).toMatchObject({ harness: "opencode", model: "m2" });
  const launch = world.stubs.calls().find((call) => call.harness === "opencode");
  expect(launch?.argv).toEqual(expect.arrayContaining(["m2"]));
  expect(launch?.cwd).toBe(worktreeOf(world, expectPoolBranch(talk.branch, "conv-2")));
});

// conversations.test.ts:396
conformance("conversations", "a start opens a named herdr tab, types the opening Turn and records the Conversation live", async (t) => {
  const world = terminalWorld(t, { config: { defaults: { harness: "opencode", model: "m" } } });
  const { herdr, server } = await startTerminal(t, world);
  const opening = "hello agent, let's plan the rollout";

  const view = await startConversation(server, { title: "Plan the rollout", opening, assign: { effort: "high" } });

  expect(view.id).toBe("conv-1");
  expect(view.status).toBe("live");
  expect(view.paneId).toBe("w1:p1");
  expect(view.assignment).toMatchObject({ harness: "opencode", model: "m", effort: "high", effortApplied: false });
  const branch = expectPoolBranch(view.branch, "conv-1");
  expect(branches(world)).toContain(branch);
  expect(existsSync(worktreeOf(world, branch))).toBe(true);

  const tab = callsOf(herdr, "tab.create")[0]!;
  expect(tab.params.cwd).toBe(worktreeOf(world, branch));
  expect(await herdr.control("tabLabel", "w1:t1")).toEqual(expect.stringContaining("conv-1"));
  const typed = (await submittedAtLeast(herdr, 1))[0]!;
  expect(typed.startsWith(`${opening}\n\n---\n`)).toBe(true);

  expectSameFile(
    conversationFile(world, "conv-1"),
    recordBytes({
      id: "conv-1",
      status: "live",
      harness: "opencode",
      model: "m",
      effort: "high",
      drivers: "implement",
      title: "Plan the rollout",
      opening,
    }),
  );
  const spawned = eventOf(readEvents(world.pool, "conv-1"), "spawned");
  expect(spawned.payload).toMatchObject({
    effort: "high",
    harness: "opencode",
    model: "m",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    branch,
    cwd: worktreeOf(world, branch),
  });
});

// attempt-run.test.ts:1355, and the teaching rows prompt.test.ts:181, :203,
// :215, :221, :228, :234, :240, :252, :263, :271 (the whole text).
conformance("conversations", "the opening and the teaching are typed as one plain prompt, then one Enter", async (t) => {
  const world = terminalWorld(t, {
    config: { defaults: { harness: "opencode", model: "deepseek", drivers: "implement" } },
  });
  const { herdr, server } = await startTerminal(t, world);
  const opening = "hello agent, let's plan the rollout";

  const view = await startConversation(server, {
    title: "Plan",
    opening,
    assign: { harness: "claude", model: "opus", drivers: "implement" },
  });

  const teaching = conversationTeaching({
    pool: world.pool,
    id: "conv-1",
    own: { harness: "claude", model: "opus", drivers: "implement" },
    defaults: { harness: "opencode", model: "deepseek", drivers: "implement" },
    perFile: 5,
  });
  const body = `${opening}\n\n${teaching}`;
  const sends = callsOf(herdr, "pane.send_input").filter((call) => call.params.pane_id === view.paneId);
  // The wrapper, the prompt, Enter: no driver line before it, no Ticket
  // path after it.
  expect(sends).toHaveLength(3);
  expect(String(sends[0]!.params.text)).toContain("script ");
  expectSameBytes(String(sends[1]!.params.text), body, "the typed prompt");
  expect(sends[2]!.params.keys).toEqual(["enter"]);
  expectSameBytes((await submitted(herdr))[0]!, body, "the submitted Turn");
  // The readiness wait read the pane before anything was pasted.
  const pasteAt = herdr.calls.indexOf(sends[1]!);
  const wrapperAt = herdr.calls.indexOf(sends[0]!);
  expect(herdr.calls.slice(wrapperAt, pasteAt).some((call) => call.method === "pane.read")).toBe(true);
  expect(existsSync(join(world.pool, "runs", "conv-1.outcome.prompt.txt"))).toBe(false);

  // The facts each teaching row names, which the whole text above carries.
  for (const fact of [
    "Load the my-console-citizen skill",
    `Write JSON to ${join(world.pool, "runs", "conv-1.spawn.json")}`,
    "This Conversation's Assignment: harness claude, model opus, drivers implement.",
    "The pool defaults: harness opencode, model deepseek, drivers implement.",
    "ask the operator here before you write the file",
    "at least 20 characters of intent",
    "may only name Tickets, never another Conversation (an entry naming one is dropped and logged)",
    '"assign" takes harness, model, effort and drivers only',
    '"blocks": "all"',
    "5 entries honored per file written, and entries beyond it are held for the operator to adopt or discard",
    "there is no run-wide cap on what a Conversation spawns",
    `read the Spawn ledger at ${join(world.pool, "runs", "spawn-ledger.md")}`,
    '"overlaps": ["id", ...]',
    "its id, title, outcome, branch, and a diff summary",
    "you cannot answer either one's own Interrupt",
    "You propose; the engine writes.",
  ]) {
    expect(body).toContain(fact);
  }
});

// prompt.test.ts:190
conformance("conversations", "the teaching names the Conversation's own effort and no effort for defaults without one", async (t) => {
  const world = terminalWorld(t, {
    config: { defaults: { harness: "opencode", model: "deepseek", drivers: "implement" } },
  });
  const { herdr, server } = await startTerminal(t, world);

  await startConversation(server, { title: "Effortful", assign: { harness: "claude", model: "opus", effort: "high" } });

  const typed = (await submittedAtLeast(herdr, 1))[0]!;
  expectSameBytes(
    typed,
    conversationTeaching({
      pool: world.pool,
      id: "conv-1",
      own: { harness: "claude", model: "opus", effort: "high", drivers: "implement" },
      defaults: { harness: "opencode", model: "deepseek", drivers: "implement" },
      perFile: 5,
    }),
    "the teaching typed alone",
  );
  expect(typed).toContain("This Conversation's Assignment: harness claude, model opus, effort high, drivers implement.");
  expect(typed).toContain("The pool defaults: harness opencode, model deepseek, drivers implement.");
  expect(typed).toContain('"effort": "..."');
});

// prompt.test.ts:197
conformance("conversations", "an enlisted pane's teaching spells out the empty model and the missing pool defaults", async (t) => {
  const world = t.world({ tickets: [DONE_01], config: { terminal: "herdr" } });
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  await herdr.control("seedAgent", {
    paneId: "op-1",
    agent: "claude",
    status: "idle",
    title: "operator",
    cwd: world.repo,
    rendered: READY_FRAME,
  });
  const server = await t.start(world, { herdr });

  const answer = await server.http.post("/api/enlist", { paneId: "op-1", title: "Mine", becomes: "conversation" });
  expect(answer.status, answer.text).toBe(201);

  const typed = (await submittedAtLeast(herdr, 1))[0]!;
  expectSameBytes(
    typed,
    conversationTeaching({
      pool: world.pool,
      id: "conv-1",
      own: { harness: "claude", model: "", drivers: "implement" },
      defaults: undefined,
      perFile: 5,
    }),
    "the enlist teaching",
  );
  expect(typed).toContain("This Conversation's Assignment: harness claude, model (none), drivers implement.");
  expect(typed).toContain("The pool defaults: harness (none), model (none), drivers (none).");
});

// prompt.test.ts:246
conformance("conversations", "a per-file Spawn cap of 0 teaches that every entry is held", async (t) => {
  const world = terminalWorld(t, { config: { spawnCaps: { perAttempt: 0 } } });
  const { herdr, server } = await startTerminal(t, world);

  await startConversation(server, { title: "Capped" });

  const typed = (await submittedAtLeast(herdr, 1))[0]!;
  expectSameBytes(
    typed,
    conversationTeaching({
      pool: world.pool,
      id: "conv-1",
      own: { harness: "claude", model: "m", drivers: "implement" },
      defaults: { harness: "claude", model: "m" },
      perFile: 0,
    }),
    "the teaching under a cap of 0",
  );
  expect(typed).toContain("every entry is held for the operator to adopt or discard and none starts on its own");
  expect(typed).not.toContain("entries beyond it");
});

// prompt.test.ts:258
conformance("conversations", "the teaching names the pool's own per-file Spawn cap", async (t) => {
  for (const perFile of [8, 1]) {
    const world = terminalWorld(t, { config: { spawnCaps: { perAttempt: perFile } } });
    const { herdr, server } = await startTerminal(t, world);

    await startConversation(server, { title: `Cap ${perFile}` });

    const typed = (await submittedAtLeast(herdr, 1))[0]!;
    expectSameBytes(
      typed,
      conversationTeaching({
        pool: world.pool,
        id: "conv-1",
        own: { harness: "claude", model: "m", drivers: "implement" },
        defaults: { harness: "claude", model: "m" },
        perFile,
      }),
      `the teaching under a cap of ${perFile}`,
    );
    expect(typed).toContain(perFile === 1 ? "1 entry honored per file" : "8 entries honored per file");
  }
});

// conversations.test.ts:436
conformance("conversations", "a start reaches the socket at once, with no other pool activity to carry it", async (t) => {
  const { server } = await startTerminal(t, terminalWorld(t));
  const socket = await t.socket(server, { visible: true });
  await socket.sync();
  const from = socket.frames.length;

  await startConversation(server, { title: "Plan" });

  await socket.waitFor(
    () => socket.pushed?.snapshot.state.conversations.some((c) => c.id === "conv-1" && c.status === "live") === true,
    { from, ms: 2_000, what: "a frame carrying conv-1 live" },
  );
});

// conversations.test.ts:466
conformance("conversations", "the tick reads the viewport only, the Peek serves its read, and End forgets it", async (t) => {
  const { herdr, server } = await startTerminal(t, terminalWorld(t));
  const view = await startConversation(server, { title: "Peek me" });
  const paneId = view.paneId!;

  // A frame only the tick can have read: set after the launch is over.
  await herdr.control("setPaneContent", paneId, "tick frame ❯ ");
  const setAt = herdr.calls.length;
  await herdr.waitForCall(
    (call) => call.method === "pane.read" && call.params.pane_id === paneId && call.params.source === "visible",
    { from: setAt, ms: 8_000 },
  );
  // The read's answer lands just after the call does.
  await Bun.sleep(200);
  // A frame no read has seen yet: the Peek answers the tick's last read.
  await herdr.control("setPaneContent", paneId, "unread frame ❯ ");
  const peekFrom = herdr.calls.length;
  const peek = await server.http.get(`/api/terminal/peek?ticket=${view.id}`);
  const readsDuringPeek = herdr.calls
    .slice(peekFrom)
    .filter((call) => call.method === "pane.read" && call.params.pane_id === paneId).length;
  expect(peek.status).toBe(200);
  // A tick landing inside the Peek reads the new frame too; only then may
  // the Peek's text be it.
  if (readsDuringPeek === 0) {
    expect(peek.json<object>()).toEqual({ ticket: view.id, paneId, text: "tick frame ❯ " });
  } else {
    expect(peek.json<{ text: string }>().text).toMatch(/^(tick|unread) frame ❯ $/);
  }

  const reads = callsOf(herdr, "pane.read").filter((call) => call.params.pane_id === paneId);
  const visible = reads.filter((call) => call.params.source === "visible");
  expect(visible.length).toBeGreaterThan(0);
  for (const read of visible) {
    expect(read.params).toEqual({ pane_id: paneId, source: "visible", format: "text", strip_ansi: true });
  }
  const recent = reads.filter((call) => call.params.source === "recent");
  expect(recent.length).toBeGreaterThan(0);
  for (const read of recent) expect(read.params.lines).toBe(200);

  const end = await server.http.post("/api/conversations/end", { id: view.id });
  expect(end.status).toBe(202);
  const after = await server.http.get(`/api/terminal/peek?ticket=${view.id}`);
  expect(after.status).toBe(404);
});

// attempt-run.test.ts:622, and the gap at engine/conversations.ts:1492
conformance("conversations", "a start whose tab or launch command herdr refuses answers 409 and leaves nothing", async (t) => {
  // tab.create refused while the Pool workspace still answers.
  {
    const world = terminalWorld(t);
    const { herdr, server } = await startTerminal(t, world, { fail: ["tab.create"] });
    const answer = await server.http.post("/api/conversations", { title: "Talk" });

    expect(answer.status).toBe(409);
    expect(answer.json<{ reason: string }>().reason).toStartWith(
      "conversation start: could not open a herdr tab: tab.create failed",
    );
    const after = herdr.calls.slice(herdr.calls.findIndex((call) => call.method === "tab.create"));
    expect(after.filter((call) => call.method === "tab.create")).toHaveLength(2);
    const second = after.findIndex((call, i) => i > 0 && call.method === "tab.create");
    expect(after.slice(1, second).some((call) => call.method === "workspace.get")).toBe(true);
    expect(after.some((call) => call.method === "workspace.create")).toBe(false);
    expect(existsSync(conversationFile(world, "conv-1"))).toBe(false);
    expect(readEvents(world.pool, "conv-1")).toEqual([]);
    expect(branches(world)).toEqual(["main"]);
  }
  // pane.send_input refused: the launch command never reaches the pane.
  {
    const world = terminalWorld(t);
    const { server } = await startTerminal(t, world, { fail: ["pane.send_input"] });
    const answer = await server.http.post("/api/conversations", { title: "Talk" });

    expect(answer.status).toBe(409);
    expect(answer.json<{ reason: string }>().reason).toStartWith(
      "conversation start: could not deliver the launch command: pane.send_input failed",
    );
    expect(existsSync(conversationFile(world, "conv-1"))).toBe(false);
    expect(readEvents(world.pool, "conv-1")).toEqual([]);
    expect(branches(world)).toEqual(["main"]);
  }
});

// conversations.test.ts:736
conformance("conversations", "a harness that dies before its TUI crashes the Conversation with its own code", async (t) => {
  const world = terminalWorld(t);
  world.stubs.script("_claude", { exitCodes: [1] });
  // No ready frame: the readiness wait sees the exit code first.
  const { herdr, server } = await startTerminal(t, world, { rendered: "" });

  const view = await startConversation(server, { title: "Doomed" });

  expect(view.status).toBe("crashed");
  expect(recordStatus(world, "conv-1")).toBe("crashed");
  // The tab's close races this read: its `tab-closed` event lands once herdr answers the close, so the
  // log is read once that has happened.
  await herdr.waitForCall((call) => call.method === "tab.close", { ms: 3_000 });
  const events = await until(
    () => readEvents(world.pool, "conv-1"),
    (read) => kinds(read).length >= 3,
    { what: "conv-1's tab-closed event" },
  );
  expect(kinds(events)).toEqual(["spawned", "crash", "tab-closed"]);
  expect(typeof events[0]!.payload.pane_id).toBe("string");
  expect(events[0]!.payload.commitSha).toMatch(/^[0-9a-f]{40}$/);
  expect(events[1]!.payload).toEqual({ code: 1, reason: "harness exited 1" });
  expect(branches(world)).toEqual(["main"]);
  expect(existsSync(worktreeOf(world, events[0]!.payload.branch as string))).toBe(false);

  await Bun.sleep(300);
  expect(callsOf(herdr, "pane.send_input")).toHaveLength(1);
  expect(callsOf(herdr, "pane.close")).toEqual([]);
  expect(callsOf(herdr, "tab.close").map((call) => call.params.tab_id)).toEqual(["w1:t1"]);
});

// attempt-run.test.ts:1426
conformance("conversations", "an opening Turn that never lands crashes the Conversation and closes its pane", async (t) => {
  const world = terminalWorld(t);
  // claude has no verified clear keys, so one lost paste is the failure.
  const { herdr, server } = await startTerminal(t, world, { dropInputs: 1 });

  const view = await startConversation(server, { title: "Lost", opening: "hello agent" });

  expect(view.status).toBe("crashed");
  expect(recordStatus(world, "conv-1")).toBe("crashed");
  expect(eventOf(readEvents(world.pool, "conv-1"), "crash").payload.reason).toBe("prompt never landed");
  await herdr.waitForCall((call) => call.method === "pane.close", { ms: 3_000 });
  expect(await submitted(herdr)).toEqual([]);
});

// conversations.test.ts:802
conformance(
  "conversations",
  "a launch whose command never ran is retried in a fresh tab and goes live there",
  async (t) => {
    const world = terminalWorld(t);
    const { herdr, server } = await startTerminal(t, world, { swallowWrapper: 1 });

    const view = await startConversation(server, { title: "Second time lucky", opening: "hello" });

    expect(view.status).toBe("live");
    expect(view.paneId).toBe("w1:p2");
    const events = readEvents(world.pool, "conv-1");
    expect(kinds(events)).toEqual(["launch-retried", "spawned"]);
    expect(events[0]!.payload).toMatchObject({
      try: 1,
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      reason: "launch command never ran",
    });
    expect(events[1]!.payload.tab_id).toBe("w1:t2");
    expect(callsOf(herdr, "tab.create")).toHaveLength(2);
    expect(callsOf(herdr, "tab.close").map((call) => call.params.tab_id)).toEqual(["w1:t1"]);
  },
  { slow: true },
);

// conversations.test.ts:840
conformance(
  "conversations",
  "a launch botched on every try crashes and leaves no worktree or branch",
  async (t) => {
    const world = terminalWorld(t);
    const { herdr, server } = await startTerminal(t, world, { swallowWrapper: 3 });

    const view = await startConversation(server, { title: "Never ran" });

    expect(view.status).toBe("crashed");
    expect(recordStatus(world, "conv-1")).toBe("crashed");
    const events = readEvents(world.pool, "conv-1");
    expect(kinds(events)).toEqual(["launch-retried", "launch-retried", "spawned", "crash"]);
    expect(events[3]!.payload).toEqual({ code: -5, reason: "launch command never ran" });
    expect(branches(world)).toEqual(["main"]);
    expect(callsOf(herdr, "tab.create")).toHaveLength(3);
    expect(callsOf(herdr, "pane.send_input")).toHaveLength(3);
    await until(
      () => callsOf(herdr, "tab.close").length,
      (n) => n >= 3,
      { ms: 3_000, what: "three tab closes" },
    );
    expect(callsOf(herdr, "tab.close").map((call) => call.params.tab_id)).toEqual(["w1:t1", "w1:t2", "w1:t3"]);

    // The crashed record keeps its id.
    const next = await startConversation(server, { title: "After it" });
    expect(next.id).toBe("conv-2");
  },
  { slow: true },
);

// ---------------------------------------------------------------------------
// Ending one.
// ---------------------------------------------------------------------------

// conversations.test.ts:515, conversations.test.ts:1009, and the gaps at
// engine/conversations.ts:1952, :1875 and engine/server.ts:2015, :2185.
conformance("conversations", "End with no commits removes the worktree and branch and records the ending", async (t) => {
  const world = terminalWorld(t);
  const { herdr, server } = await startTerminal(t, world);
  const view = await startConversation(server, { title: "Idle chat" });
  const branch = expectPoolBranch(view.branch, "conv-1");

  const log = await server.http.get("/api/log?ticket=conv-1");
  expect(log.status).toBe(200);
  expect(log.json<{ attempts: { attempt: number }[] }>().attempts.map((a) => a.attempt)).toEqual([1]);
  const unknownLog = await server.http.get("/api/log?ticket=nope");
  expect(unknownLog.status).toBe(404);
  expect(unknownLog.text).toContain("unknown ticket nope");

  const noId = await server.http.post("/api/conversations/end", {});
  expect(noId.status).toBe(400);
  expect(noId.json<object>()).toEqual({ reason: "id is required" });
  const unknown = await server.http.post("/api/conversations/end", { id: "conv-99" });
  expect(unknown.status).toBe(404);
  expect(unknown.json<{ reason: string }>().reason).toContain("no live conversation conv-99");

  const end = await server.http.post("/api/conversations/end", { id: "conv-1", closing: "all done here" });
  expect(end.status).toBe(202);
  await until(() => recordStatus(world, "conv-1"), (status) => status === "ended", { what: "conv-1 ended" });

  expectSameFile(
    conversationFile(world, "conv-1"),
    recordBytes({ id: "conv-1", status: "ended", harness: "claude", model: "m", drivers: "implement", title: "Idle chat" }),
  );
  expect(existsSync(worktreeOf(world, branch))).toBe(false);
  expect(branches(world)).toEqual(["main"]);

  // Let any second close land before counting them.
  await Bun.sleep(500);
  const events = readEvents(world.pool, "conv-1");
  expect(kinds(events)).toEqual(["spawned", "end-requested", "tab-closed", "ended"]);
  expect(events[1]!.payload).toEqual({ closing: "all done here" });
  expect(events[2]!.payload).toMatchObject({ tab_id: "w1:t1", reason: "end" });
  expect(events[3]!.payload).toEqual({ closing: "all done here", by: "operator", merged: false });
  expect(callsOf(herdr, "tab.close").map((call) => call.params.tab_id)).toEqual(["w1:t1"]);

  const again = await server.http.post("/api/conversations/end", { id: "conv-1" });
  expect(again.status).toBe(404);
  expect(again.json<{ reason: string }>().reason).toContain("no live conversation");
});

// conversations.test.ts:541
conformance("conversations", "End's answer and the socket both show the ending at once", async (t) => {
  const { server } = await startTerminal(t, terminalWorld(t));
  await startConversation(server, { title: "Idle chat" });
  const socket = await t.socket(server, { visible: true });
  await socket.sync();
  const from = socket.frames.length;

  const end = await server.http.post("/api/conversations/end", { id: "conv-1", closing: "all done here" });

  expect(end.status).toBe(202);
  const answered = end.json<{ snapshot: EnrichedSnapshot }>().snapshot;
  expect(answered.state.conversations.find((c) => c.id === "conv-1")?.status).toBe("ended");
  await socket.waitFor(
    () => socket.pushed?.snapshot.state.conversations.find((c) => c.id === "conv-1")?.status === "ended",
    { from, ms: 2_000, what: "a frame carrying conv-1 ended" },
  );
});

// conversations.test.ts:563
conformance("conversations", "End with commits merges the branch onto main and removes the worktree", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);
  const view = await startConversation(server, { title: "Ship a fix" });
  const worktree = worktreeOf(world, expectPoolBranch(view.branch, "conv-1"));
  writeFileSync(join(worktree, "new-file.txt"), "written during the conversation\n");
  world.git(["-C", worktree, "add", "-A"]);
  world.git(["-C", worktree, "commit", "-qm", "conversation commit"]);

  const end = await server.http.post("/api/conversations/end", { id: "conv-1" });
  expect(end.status).toBe(202);
  await until(() => recordStatus(world, "conv-1"), (status) => status === "ended", { what: "conv-1 ended" });

  expect(existsSync(worktree)).toBe(false);
  expect(readFileSync(join(world.repo, "new-file.txt"), "utf8")).toBe("written during the conversation\n");
  const events = readEvents(world.pool, "conv-1");
  expect(kinds(events)).toContain("merged");
  expect(eventOf(events, "ended").payload).toMatchObject({ by: "operator", merged: true });
});

// conversations.test.ts:602
conformance("conversations", "a conflicted End waits on a merge-approval under the Conversation's id", async (t) => {
  const world = terminalWorld(t, { config: { resolver: "claude" }, repoFiles: { "shared.txt": "base\n" } });
  const resolverOutcome = join(world.pool, "runs", "conv-1.resolver.outcome.json");
  // Launch 1 is the Conversation's TUI; launch 2 the resolver, run in the
  // Conversation's worktree: it merges main, keeps its own text, and
  // reports the conflict resolved; launch 3 is a TUI again.
  world.stubs.script("_claude", {
    hold: HOLD_SECONDS,
    run: [
      "",
      [
        "git merge main >/dev/null 2>&1 || true",
        "printf 'resolved-by-resolver\\n' > shared.txt",
        "git add shared.txt",
        `printf '{"resolved": true, "note": "resolved the conflict"}' > ${JSON.stringify(resolverOutcome)}`,
        "",
      ].join("\n"),
      "",
    ],
  });
  const { herdr, server } = await startTerminal(t, world);
  const view = await startConversation(server, { title: "Conflicting talk" });
  const worktree = worktreeOf(world, expectPoolBranch(view.branch, "conv-1"));
  writeFileSync(join(worktree, "shared.txt"), "worktree-change\n");
  world.git(["-C", worktree, "commit", "-qam", "worktree change"]);
  writeFileSync(join(world.repo, "shared.txt"), "main-change\n");
  world.git(["commit", "-qam", "main change"]);

  const end = await server.http.post("/api/conversations/end", { id: "conv-1" });
  expect(end.status).toBe(202);
  // The resolver's Attempt is over once its pane's agent is released.
  await herdr.waitForCall(
    (call) => call.method === "pane.release_agent" && call.params.pane_id !== view.paneId,
    { ms: 30_000 },
  );
  // The Bun server raises the Interrupt without publishing it
  // (conformance/NOT-PORTED.md): another Conversation's start carries it.
  await Bun.sleep(500);
  await startConversation(server, { title: "Carrier" });
  const waiting = await until(
    () => state(server),
    (snapshot) => snapshot.state.interrupts.some((i) => i.ticketId === "conv-1"),
    { what: "an Interrupt under conv-1" },
  );
  expect(waiting.state.interrupts.find((i) => i.ticketId === "conv-1")?.kind).toBe("merge-approval");
  expect(recordStatus(world, "conv-1")).toBe("live");
  expect(kinds(readEvents(world.pool, "conv-1"))).toEqual([
    "spawned",
    "end-requested",
    "tab-closed",
    "merge-conflict",
    "resolver",
    "spawned",
  ]);

  const approve = await server.http.post("/api/resume", { ticketId: "conv-1", action: "approve" });
  expect(approve.status, approve.text).toBe(202);
  await until(() => recordStatus(world, "conv-1"), (status) => status === "ended", { what: "conv-1 ended" });

  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved-by-resolver\n");
  expect(eventOf(readEvents(world.pool, "conv-1"), "ended").payload).toMatchObject({ merged: true });
  await until(
    () => state(server),
    (snapshot) => !snapshot.state.interrupts.some((i) => i.ticketId === "conv-1"),
    { what: "conv-1's Interrupt to go" },
  );
});

// conversations.test.ts:677
conformance("conversations", "a pane closed without End crashes the Conversation and keeps its branch", async (t) => {
  const world = terminalWorld(t);
  const { herdr, server } = await startTerminal(t, world);
  const view = await startConversation(server, { title: "Cut short" });
  const branch = expectPoolBranch(view.branch, "conv-1");

  await herdr.control("endPane", view.paneId);

  await until(() => recordStatus(world, "conv-1"), (status) => status === "crashed", { what: "conv-1 crashed" });
  // The record turns crashed a moment before the crash event is appended, so the event is waited for too.
  const events = await until(
    () => readEvents(world.pool, "conv-1"),
    (read) => read.some((event) => event.kind === "crash"),
    { what: "conv-1's crash event" },
  );
  expect(eventOf(events, "crash").payload).toEqual({
    reason: "pane lost without End (pane-end)",
  });
  expect(branches(world)).toContain(branch);
  expect(existsSync(worktreeOf(world, branch))).toBe(true);
});

// ---------------------------------------------------------------------------
// spawn.json adoption.
// ---------------------------------------------------------------------------

// notices.test.ts:402
conformance("conversations", "a Conversation's spawn.json lands up to the per-file cap and holds the rest, past the run cap", async (t) => {
  const world = terminalWorld(t, { config: { spawnCaps: { perRun: 1 } } });
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Planner" });

  writeSpawnJson(
    world,
    "conv-1",
    Array.from({ length: 7 }, (_, i) => ({ title: `Follow-up ${i + 1}`, body: BODY })),
  );

  await until(() => Object.keys(readMarkers(world.pool)).length, (n) => n >= 6, { ms: 15_000, what: "5 spawned Tickets" });
  await until(() => existsSync(spawnJson(world, "conv-1")), (exists) => !exists, { what: "the spawn.json consumed" });
  expect(Object.keys(readMarkers(world.pool)).sort()).toEqual([
    "01",
    "conv-1-spawn-1",
    "conv-1-spawn-2",
    "conv-1-spawn-3",
    "conv-1-spawn-4",
    "conv-1-spawn-5",
  ]);
  expect(eventOf(readEvents(world.pool, "conv-1"), "spawn-held").payload).toEqual({
    held: [
      { id: "proposal-6", reason: "per-attempt", title: "Follow-up 6" },
      { id: "proposal-7", reason: "per-attempt", title: "Follow-up 7" },
    ],
  });
  const snapshot = await state(server);
  expect(snapshot.heldSpawns.map((h) => [h.id, h.reason])).toEqual([
    ["proposal-6", "per-attempt"],
    ["proposal-7", "per-attempt"],
  ]);
});

// notices.test.ts:467
conformance("conversations", "a spawn.json entry naming what it overlaps is held while the rest land at once", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Planner" });

  writeSpawnJson(world, "conv-1", [
    { title: "Overlapping", body: BODY, overlaps: ["01"] },
    { title: "Plain", body: BODY },
  ]);

  await until(() => readMarkers(world.pool)["conv-1-spawn-1"], (marker) => marker !== undefined, {
    ms: 15_000,
    what: "conv-1-spawn-1",
  });
  const snapshot = await until(
    () => state(server),
    (got) => got.heldSpawns.length === 1,
    { what: "one Held spawn" },
  );
  expect(snapshot.pendingSpawns).toEqual([]);
  expect(snapshot.heldSpawns[0]).toMatchObject({
    id: "proposal-1",
    origin: "conversation",
    reason: "overlaps",
    overlaps: ["01"],
  });
  expect(readMarkers(world.pool)["conv-1-spawn-2"]).toBeUndefined();
});

// notices.test.ts:507
conformance("conversations", "a spawn.json entry blocked by a Conversation is dropped and logged", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "One" });
  await startConversation(server, { title: "Two" });

  writeSpawnJson(world, "conv-1", [{ title: "Blocked", body: BODY, blockedBy: ["conv-2"] }]);

  const rejected = await until(
    () => readEvents(world.pool, "conv-1").find((event) => event.kind === "spawn-rejected"),
    (event) => event !== undefined,
    { ms: 15_000, what: "a spawn-rejected event" },
  );
  expect(JSON.stringify(rejected!.payload)).toContain(
    "blockedBy names Conversations, which cannot block a ticket: conv-2",
  );
  expect(existsSync(spawnJson(world, "conv-1"))).toBe(false);
  expect(Object.keys(readMarkers(world.pool))).toEqual(["01"]);
});

// notices.test.ts:547
conformance("conversations", "a spawn.json entry naming an unknown harness is dropped and logged", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Planner" });

  writeSpawnJson(world, "conv-1", [{ title: "Elsewhere", body: BODY, assign: { harness: "nonexistent" } }]);

  const rejected = await until(
    () => readEvents(world.pool, "conv-1").find((event) => event.kind === "spawn-rejected"),
    (event) => event !== undefined,
    { ms: 15_000, what: "a spawn-rejected event" },
  );
  expect(JSON.stringify(rejected!.payload)).toContain("assign.harness names unknown harness 'nonexistent'");
  expect(existsSync(spawnJson(world, "conv-1"))).toBe(false);
  expect(Object.keys(readMarkers(world.pool))).toEqual(["01"]);
});

// Gap: engine/conversations.ts:2408-2427.
conformance("conversations", "a spawn.json that is not JSON is removed and nothing follows", async (t) => {
  const world = terminalWorld(t);
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Planner" });

  writeFileSync(spawnJson(world, "conv-1"), "{ not json");

  await until(() => existsSync(spawnJson(world, "conv-1")), (exists) => !exists, {
    ms: 8_000,
    what: "the spawn.json removed",
  });
  // One more tick: nothing lands behind the removal.
  await Bun.sleep(2_500);
  expect(Object.keys(readMarkers(world.pool))).toEqual(["01"]);
  const snapshot = await state(server);
  expect(snapshot.heldSpawns).toEqual([]);
  expect(snapshot.pendingSpawns).toEqual([]);
  expect(kinds(readEvents(world.pool, "conv-1")).filter((kind) => kind.startsWith("spawn-"))).toEqual([]);
});

// notices.test.ts:584
conformance("conversations", "a spawn.json entry of kind conversation starts a child on the parent's Assignment", async (t) => {
  const world = terminalWorld(t, { config: { defaults: { harness: "opencode", model: "m" } } });
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Parent" });

  writeSpawnJson(world, "conv-1", [{ title: "Child talk", body: BODY, kind: "conversation" }]);

  await until(() => recordStatus(world, "conv-1-spawn-1"), (status) => status === "live", {
    ms: 20_000,
    what: "conv-1-spawn-1 live",
  });
  expectSameBytes(
    readConversationFile(world, "conv-1-spawn-1").split("\n", 1)[0]!,
    "<!-- conversation: id=conv-1-spawn-1 status=live spawned-by=conv-1 harness=opencode model=m drivers=implement -->",
    "the child's marker line",
  );
  expect(readConversationFile(world, "conv-1-spawn-1")).toContain("# Child talk\n");
  expect(existsSync(join(world.pool, "issues", "conv-1-spawn-1.md"))).toBe(false);
});

// notices.test.ts:619 (its seam, a fake herdr slow to open a tab, is the
// fake's `delays`).
conformance("conversations", "a kind conversation start in flight reserves its spawn id", async (t) => {
  const world = terminalWorld(t);
  const { herdr, server } = await startTerminal(t, world);
  await startConversation(server, { title: "Parent" });
  await herdr.control("delay", "tab.create", 3_000);
  const from = herdr.calls.length;

  writeSpawnJson(world, "conv-1", [{ title: "First child", body: BODY, kind: "conversation" }]);
  // The first child's tab is asked for, and not yet answered.
  await herdr.waitForCall((call) => call.method === "tab.create", { from, ms: 8_000 });
  expect(existsSync(conversationFile(world, "conv-1-spawn-1"))).toBe(false);
  writeSpawnJson(world, "conv-1", [{ title: "Second child", body: BODY, kind: "conversation" }]);

  await until(
    () => [recordStatus(world, "conv-1-spawn-1"), recordStatus(world, "conv-1-spawn-2")],
    (statuses) => statuses.every((status) => status === "live"),
    { ms: 30_000, what: "both children live" },
  );
  expect(readConversationFile(world, "conv-1-spawn-1")).toContain("# First child\n");
  expect(readConversationFile(world, "conv-1-spawn-2")).toContain("# Second child\n");
});

// notices.test.ts:865
conformance("conversations", "a Ticket a Conversation proposes launches on the proposal's assign, kept on its marker", async (t) => {
  const world = terminalWorld(t, { config: { defaults: { harness: "opencode", model: "m", effort: "high" } } });
  const { server } = await startTerminal(t, world);
  await startConversation(server, { title: "Planner" });

  writeSpawnJson(world, "conv-1", [{ title: "On claude", body: BODY, assign: { harness: "claude", effort: "max" } }]);

  const marker = await until(
    () => readMarkers(world.pool)["conv-1-spawn-1"],
    (found) => found !== undefined,
    { ms: 15_000, what: "conv-1-spawn-1" },
  );
  const assign = encodeURIComponent(JSON.stringify({ harness: "claude", effort: "max" }));
  expect(marker!.line.endsWith(` spawned-by=conv-1 spawn-assign=${assign} -->`)).toBe(true);
  const launch = await until(
    () => world.stubs.calls().find((call) => call.harness === "claude"),
    (call) => call !== undefined,
    { ms: 15_000, what: "the claude launch for conv-1-spawn-1" },
  );
  expect(launch!.argv.join(" ")).toContain("--model m");
  expect(launch!.argv.join(" ")).toContain("--effort max");
});
