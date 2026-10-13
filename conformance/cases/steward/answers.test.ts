/**
 * The Steward's answers, notes, routes and its End (ADR-0030), seen from
 * outside the server (ADR-0036): what each /api/steward/* route answers,
 * what an answer writes into the Ticket's log and file, what the pool log
 * and the snapshot say of it, where its budget and its Close setting stop
 * it, and what a Steward note does across a restart.
 *
 * Every refusal is the 409 `reason` envelope with the engine's own words,
 * prefixed `steward: `; a request the route cannot read is a 400. Texts the
 * engine hands an agent (the keep-talking teaching Turn and the Steward's
 * message, the notes written into 01.md) are pinned byte for byte, written
 * out here as the Bun server types them, with only the run's own paths and
 * ids substituted.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Case, type CaseServer, conformance } from "../../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes, expectSameFile } from "../../harness/equal.ts";
import { readEvents, readStateLine, until } from "../../harness/pool-files.ts";
import {
  checkpoint,
  done,
  driveOutcomes,
  enlistSteward,
  OPENCODE_IDLE,
  READY_01,
  type ScriptedOutcome,
  snapshot,
  STEWARD_PANE,
  stewardNotices,
  stewardWorld,
  type StewardWorld,
  type StewardWorldSpec,
  turnsInto,
  untilInterrupt,
  untilNotices,
  untilSnapshot,
} from "./pool.ts";

const READY_02_AFTER_01 = "<!-- state: id=02 blocked-by=01 status=ready -->";

/** One answer from a route: its status and its body parsed. */
interface Answer {
  status: number;
  body: unknown;
}

async function post(server: CaseServer, path: string, body: unknown): Promise<Answer> {
  const answer = await server.http.post(path, body);
  return { status: answer.status, body: answer.json() };
}

async function get(server: CaseServer, path: string): Promise<Answer> {
  const answer = await server.http.get(path);
  return { status: answer.status, body: answer.json() };
}

/** A route's answer, status and body, against what it must be. */
function expectAnswer(actual: Answer, status: number, body: unknown, what: string): void {
  expectParsedEqual({ status: actual.status, body: actual.body }, { status, body }, what);
}

/** The 409 a refusal of the Steward's answers, in the engine's own words. */
function expectRefused(actual: Answer, why: string, what: string): void {
  expectAnswer(actual, 409, { reason: `steward: ${why}` }, what);
}

/** The budget refusal, word for word. */
const spent = (ticketId: string, used: number, budget: number): string =>
  `the Steward budget on ticket ${ticketId} is spent (${used} of ${budget} answers since ` +
  "the operator last answered it): leave it to the operator with a note";

interface OnDuty {
  sw: StewardWorld;
  server: CaseServer;
  /** The Steward's Conversation id. */
  id: string;
}

/**
 * The common start: a Steward world whose agents play `scripts`, the server
 * up, 01 waiting at its first checkpoint, and STEWARD_PANE enlisted as the
 * Steward and told of it (its first Notice typed and logged).
 */
async function stewardAtCheckpoint(
  t: Case,
  scripts: Record<string, ScriptedOutcome[]>,
  spec: StewardWorldSpec = {},
): Promise<OnDuty> {
  const sw = await stewardWorld(t, spec);
  driveOutcomes(sw.herdr, scripts);
  const server = await sw.start();
  await untilInterrupt(server, "01", "checkpoint");
  const id = await enlistSteward(server);
  await untilNotices(sw.herdr, 1);
  // The telling is logged on 01 just after the Turn is submitted.
  await until(
    () => readEvents(sw.world.pool, "01"),
    (events) =>
      events.some(
        (e) => e.kind === "notice" && e.payload.kind === "steward-interrupt" && e.payload.delivered === true,
      ),
    { what: "the Notice logged on 01" },
  );
  return { sw, server, id };
}

/** The pool log as /api/state serves it. */
async function poolLog(server: CaseServer): Promise<string[]> {
  return (await snapshot(server)).state.log;
}

/** The checkpoint Interrupt on 01 whose brief is `brief`, waited for. */
function untilBrief(server: CaseServer, brief: string) {
  return untilSnapshot(
    server,
    (snap) =>
      snap.state.interrupts.some((i) => i.ticketId === "01" && i.kind === "checkpoint" && i.body.includes(brief)),
    `01's checkpoint with the brief "${brief}"`,
  );
}

/** Every events file in the pool's runs/, by name, as its text. */
function eventsFiles(pool: string): Record<string, string> {
  const runs = join(pool, "runs");
  const out: Record<string, string> = {};
  for (const name of readdirSync(runs).filter((n) => n.endsWith(".events.jsonl")).sort()) {
    out[name] = readFileSync(join(runs, name), "utf8");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Answers on the operator's path
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "an answer is checked against the Steward on duty and the Interrupt's kind, " +
    "then lands as the Steward's with its note",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me"), done()] });
    const pool = sw.world.pool;

    expectRefused(
      await post(server, "/api/steward/answer", { conversation: "conv-99", ticketId: "01", action: "resume" }),
      `conv-99 is not the Steward on duty (${id} is)`,
      "an answer as conv-99",
    );
    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "approve" }),
      "ticket 01's checkpoint Interrupt takes resume",
      "approve on a checkpoint",
    );
    expect(readEvents(pool, "01").some((e) => e.kind === "answered")).toBe(false);

    expectAnswer(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "01",
        action: "resume",
        note: "Take the smaller fix first.",
      }),
      202,
      { ok: true, message: "answered 01: resume" },
      "the Steward's resume",
    );
    const answered = await until(
      () => readEvents(pool, "01").filter((e) => e.kind === "answered"),
      (events) => events.length === 1,
      { what: "01's answered event" },
    );
    expectParsedEqual(
      answered[0],
      {
        at: anyIsoTime(),
        attempt: 1,
        kind: "answered",
        payload: { kind: "checkpoint", by: "steward", conversation: id, note: "Take the smaller fix first." },
      },
      "01's answered event",
    );

    await until(() => readStateLine(pool, "01.md"), (line) => line.status === "done", { what: "01 done", ms: 30_000 });
    expectSameFile(
      join(pool, "issues", "01.md"),
      "<!-- state: id=01 blocked-by=none status=done -->\n\n# Talk it through\n\nbody\n\n" +
        "---\n\n## Brief\n\nask me\n\n" +
        "## Resume note, from the Steward\n\nTake the smaller fix first.\n",
    );
    expect(await poolLog(server)).toContain("interrupt answered for 01 (checkpoint): resumed by the Steward");
    expectParsedEqual((await snapshot(server)).stewardBudget, { budget: 5, used: { "01": 1 } }, "the Steward budget");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the budget refuses answers and keep-talking once spent, the Notice says so, and the operator's answer resets it",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(
      t,
      { "01": [checkpoint("one"), checkpoint("two"), checkpoint("three"), checkpoint("four")] },
      { config: { steward: { budget: 1 } } },
    );

    expectAnswer(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" }),
      202,
      { ok: true, message: "answered 01: resume" },
      "the first resume",
    );
    await untilBrief(server, "two");
    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" }),
      spent("01", 1, 1),
      "a resume past the budget",
    );
    expectRefused(
      await post(server, "/api/steward/keep-talking", { conversation: id, ticketId: "01", message: "go on" }),
      spent("01", 1, 1),
      "a keep-talking past the budget",
    );
    await until(
      () => stewardNotices(sw.herdr),
      (turns) => turns.some((turn) => turn.includes("Steward budget on 01 is spent (1 of 1)")),
      { what: "the spent budget on a Notice", ms: 30_000 },
    );

    const operator = await server.http.post("/api/resume", { ticketId: "01" });
    expect(operator.status).toBe(202);
    await untilSnapshot(
      server,
      (snap) => JSON.stringify(snap.stewardBudget?.used) === "{}",
      "the operator's answer to empty the budget used",
    );
    await untilBrief(server, "three");
    expectAnswer(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" }),
      202,
      { ok: true, message: "answered 01: resume" },
      "a resume after the operator's",
    );
    await untilBrief(server, "four");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "adopting a candidate is refused as the operator's and records nothing",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me")] });
    expectAnswer(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "adopt", note: "take 2" }),
      400,
      { reason: "adopting a candidate is the operator's: leave 01 with a note naming the one you recommend" },
      "the Steward's adopt",
    );
    expect(readEvents(sw.world.pool, "01").some((e) => e.kind === "answered")).toBe(false);
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.status).toBe(200);
    const interrupts = state.json<{ interrupts: { ticketId: string; used: number }[] }>().interrupts;
    expect(interrupts.find((i) => i.ticketId === "01")?.used).toBe(0);
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "a close is refused while Steward may Close is off, and closes 01 with a note once the setting is saved",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me")] });
    const pool = sw.world.pool;
    const mayClose = async () =>
      (await server.http.get(`/api/steward/state?conversation=${id}`)).json<{ mayClose: boolean }>().mayClose;
    expect(await mayClose()).toBe(false);

    expectRefused(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "01",
        action: "close",
        note: "superseded",
      }),
      "Close is off for this pool; the operator turns on Steward may Close checkpoints in Settings",
      "a close while it is off",
    );
    expect(readEvents(pool, "01").some((e) => e.kind === "answered")).toBe(false);

    const saved = await server.http.put("/api/settings/pool", { config: { steward: { mayClose: true } } });
    expect(saved.status).toBe(200);
    await until(() => poolLog(server), (log) => log.includes("config reloaded: steward"), {
      what: "the reload of the steward setting",
    });
    expect(await mayClose()).toBe(true);

    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "close", note: "  " }),
      "a close needs a note saying why the ticket is dropped",
      "a close with a blank note",
    );
    expectAnswer(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "01",
        action: "close",
        note: "The plan moved on; 02 covers it.",
      }),
      202,
      { ok: true, message: "answered 01: close" },
      "the Steward's close",
    );
    await until(() => readStateLine(pool, "01.md"), (line) => line.status === "closed", {
      what: "01 closed",
      ms: 30_000,
    });
    expectSameFile(
      join(pool, "issues", "01.md"),
      "<!-- state: id=01 blocked-by=none status=closed -->\n\n# Talk it through\n\nbody\n\n" +
        "---\n\n## Brief\n\nask me\n\n" +
        "## Close note, from the Steward\n\nThe plan moved on; 02 covers it.\n",
    );
    expectParsedEqual(
      readEvents(pool, "01").find((e) => e.kind === "answered"),
      {
        at: anyIsoTime(),
        attempt: 1,
        kind: "answered",
        payload: {
          kind: "checkpoint",
          by: "steward",
          conversation: id,
          action: "close",
          note: "The plan moved on; 02 covers it.",
        },
      },
      "01's answered event",
    );
    expect(
      (await poolLog(server)).some((line) =>
        line.startsWith("interrupt answered for 01 (checkpoint): closed by the Steward"),
      ),
    ).toBe(true);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the Steward never closes a deadlocked dependent, even with Steward may Close on",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(
      t,
      { "01": [checkpoint("ask me")] },
      {
        config: { steward: { mayClose: true } },
        tickets: [
          { file: "01.md", marker: READY_01, body: "# First\n\nbody" },
          { file: "02.md", marker: READY_02_AFTER_01, body: "# Second\n\nbody" },
        ],
      },
    );
    expectAnswer(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "01",
        action: "close",
        note: "Not wanted any more.",
      }),
      202,
      { ok: true, message: "answered 01: close" },
      "the close of 01",
    );
    await untilInterrupt(server, "02", "deadlock");
    expectRefused(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "02",
        action: "close",
        note: "its blocker is gone",
      }),
      "closing a deadlocked ticket is the operator's: leave 02 with a note",
      "a close of the deadlocked 02",
    );
    expect(readStateLine(sw.world.pool, "02.md").status).toBe("ready");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a close is refused once the Steward budget on the Ticket is spent",
  async (t) => {
    const { server, id } = await stewardAtCheckpoint(
      t,
      { "01": [checkpoint("one"), checkpoint("two")] },
      { config: { steward: { budget: 1, mayClose: true } } },
    );
    const resumed = await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" });
    expect(resumed.status).toBe(202);
    await untilBrief(server, "two");
    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "close", note: "give up" }),
      spent("01", 1, 1),
      "a close past the budget",
    );
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// Keep talking
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "keep-talking continues 01 in its Held pane: the teaching Turn, then the Steward's message, counted on the budget",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me")] });
    const pool = sw.world.pool;
    const held = await untilSnapshot(
      server,
      (snap) => snap.state.tickets.some((ticket) => ticket.id === "01" && ticket.heldPane !== null),
      "01's Held pane",
    );
    const paneId = held.state.tickets.find((ticket) => ticket.id === "01")!.heldPane!.paneId;
    const before = turnsInto(sw.herdr, paneId).length;

    expectAnswer(
      await post(server, "/api/steward/keep-talking", {
        conversation: id,
        ticketId: "01",
        message: "Try the parser fix first.",
      }),
      202,
      { ok: true, message: "keep talking on 01: attempt 2 continues in its pane" },
      "the Steward's keep-talking",
    );
    const turns = await until(
      () => turnsInto(sw.herdr, paneId).slice(before),
      (typed) => typed.length >= 2,
      { what: "the teaching Turn and the message in 01's pane" },
    );
    const outcome = `${pool}/runs/01.outcome.json`;
    expectSameBytes(
      turns[0]!,
      "---\n\n" +
        "The pool's Steward, standing in for the operator, chose to keep talking with you here about Ticket 01, " +
        "instead of starting a fresh attempt. You are now its attempt 2: carry on from where you checkpointed, " +
        "with the Steward, in this same terminal and checkout.\n\n" +
        `The Ticket file of record is ${pool}/issues/01.md; ` +
        "its line-1 status marker is the engine's, never edit it.\n\n" +
        "The Outcome you wrote before is spent. When you and the operator decide the work is done, or that it has " +
        `to pause again, record a fresh outcome as JSON at ${outcome}: {"status": "done" or "checkpoint", ` +
        '"summary": "what you did, in a sentence or two", "commitSha": "the sha of your commit, or null"}. ' +
        'On a checkpoint, add "brief": "what the human has to do next". Write it only once it is decided: ' +
        "the engine reads the file the moment it appears.\n\n" +
        'You may propose follow-up tickets in that same outcome JSON by adding a "spawn" array, one entry per ' +
        'follow-up, each shaped {"title": "...", "body": "...", "blockedBy": ["id", ...]}, the body carrying at ' +
        "least 20 characters of intent for a fresh agent to work from. A follow-up that must run before other " +
        'work may add "blocks": ["id", ...] to make those tickets wait for it, or "blocks": "all" to make every ' +
        "ticket that has not started yet wait for it; a ticket already running is never interrupted, and blocks " +
        "is only for a ticket. You never write pool state yourself: no ticket files, no ids, no statuses. " +
        "You propose; the engine writes.\n\n" +
        `Before you propose anything, read the Spawn ledger at ${pool}/runs/spawn-ledger.md: every Ticket and ` +
        "Conversation in the pool, and every proposal still waiting to land or held for the operator. Do not " +
        "propose work it already lists. If a proposal still overlaps something there, add \"overlaps\": " +
        '["id", ...] naming what it overlaps: it is then held for the operator to decide instead of landing.',
      "the keep-talking teaching Turn",
    );
    expectSameBytes(turns[1]!, "From the pool's Steward:\n\nTry the parser fix first.", "the Steward's message");

    expectParsedEqual(
      readEvents(pool, "01").find((e) => e.kind === "answered"),
      {
        at: anyIsoTime(),
        attempt: 1,
        kind: "answered",
        payload: {
          kind: "checkpoint",
          action: "keep-talking",
          by: "steward",
          conversation: id,
          message: "Try the parser fix first.",
        },
      },
      "01's answered event",
    );
    expectParsedEqual((await snapshot(server)).stewardBudget, { budget: 5, used: { "01": 1 } }, "the Steward budget");
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// Steward notes
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "a Steward note on 01 survives a restart, is not told again, costs no budget, and goes with the operator's answer",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me")] });
    const pool = sw.world.pool;
    const note = "Product call: I'd resume with option B.";
    const notesFile = join(pool, "runs", "steward-notes.json");

    expectAnswer(
      await post(server, "/api/steward/leave", { conversation: id, ticketId: "01", note }),
      200,
      { ok: true, message: "left 01 to the operator with your note" },
      "the Steward's leave",
    );
    const shown = (await snapshot(server)).state.interrupts.find((i) => i.ticketId === "01");
    expectParsedEqual(shown?.stewardNote, { text: note, at: anyIsoTime(), conversation: id }, "01's stewardNote");
    expectParsedEqual(
      readFileSync(notesFile, "utf8"),
      { notes: [{ ticketId: "01", kind: "checkpoint", text: note, at: anyIsoTime(), conversation: id }] },
      "runs/steward-notes.json",
    );
    expectParsedEqual(
      readEvents(pool, "01").find((e) => e.kind === "steward-note"),
      {
        at: anyIsoTime(),
        attempt: 1,
        kind: "steward-note",
        payload: { kind: "checkpoint", note, by: "steward", conversation: id },
      },
      "01's steward-note event",
    );
    expect(await poolLog(server)).toContain("ticket 01: the Steward left its checkpoint Interrupt to the operator");
    // A leave never counts.
    expectParsedEqual((await snapshot(server)).stewardBudget, { budget: 5, used: {} }, "the Steward budget");

    await server.stop();
    const again = await sw.start();
    await untilSnapshot(
      again,
      (snap) => snap.state.interrupts.some((i) => i.ticketId === "01" && i.stewardNote?.text === note),
      "the note on 01's Interrupt after the restart",
    );
    // Re-adopted: its Turn state is read from the pane again.
    await untilSnapshot(
      again,
      (snap) =>
        snap.state.conversations.some((c) => c.id === id && c.paneId === STEWARD_PANE && c.turn.lastLine !== ""),
      "the Steward re-adopted",
    );
    // Asserting a Notice that must not come: three Conversation polls (2 s
    // each) after the re-adoption, still only the one from before.
    await Bun.sleep(6_000);
    expect(stewardNotices(sw.herdr)).toHaveLength(1);
    expectParsedEqual((await snapshot(again)).stewardBudget, { budget: 5, used: {} }, "the budget after the restart");

    expect((await again.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
    await until(
      () => (existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "{}"),
      (text) => !text.includes(note),
      { what: "the note gone from runs/steward-notes.json" },
    );
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// One Steward at a time, and its End
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "a second Steward is refused while one is on duty, and starts once the first has ended",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me")] });
    const server = await sw.start();
    const id = await enlistSteward(server);
    const busy = `a Steward is already on duty (${id}); end it before starting another`;

    expectAnswer(
      await post(server, "/api/conversations", { title: "Another", role: "steward" }),
      409,
      { reason: `steward start: ${busy}` },
      "a second Steward started",
    );
    await sw.herdr.control("seedAgent", {
      paneId: "pane-other",
      agent: "opencode",
      cwd: sw.world.pool,
      status: "idle",
      rendered: OPENCODE_IDLE,
    });
    expectAnswer(
      await post(server, "/api/enlist", { becomes: "steward", paneId: "pane-other" }),
      409,
      { reason: `enlist: ${busy}` },
      "a second Steward enlisted",
    );

    expectAnswer(
      await post(server, "/api/steward/end", { conversation: id, closing: "handing back" }),
      202,
      { ok: true, message: "ending: your tab closes now" },
      "the Steward's End",
    );
    await untilSnapshot(
      server,
      (snap) => snap.state.conversations.find((c) => c.id === id)?.status === "ended",
      "the first Steward ended",
    );
    const night = await server.http.post("/api/conversations", { title: "Night shift", role: "steward" });
    expect(night.status).toBe(201);
    expect(night.json<{ conversation: { role?: string } }>().conversation.role).toBe("steward");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the Steward ends itself with a closing line, recorded as its own, and is then no Steward on duty",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me")] });
    const server = await sw.start();
    const id = await enlistSteward(server);
    const closing = "Super-step done; 01 waits for you.";

    expectAnswer(
      await post(server, "/api/steward/end", { conversation: id, closing }),
      202,
      { ok: true, message: "ending: your tab closes now" },
      "the Steward's End",
    );
    await untilSnapshot(
      server,
      (snap) => snap.state.conversations.find((c) => c.id === id)?.status === "ended",
      "the Steward ended",
    );
    expectSameFile(
      join(sw.world.pool, "conversations", `${id}.md`),
      `<!-- conversation: id=${id} status=ended spawned-by=none harness=opencode model= drivers=implement ` +
        `pane=${STEWARD_PANE} tab=tab-steward directory=${encodeURIComponent(sw.stewardDir)} ` +
        "branch=steward-desk session=none role=steward -->\n\n# Steward\n\n\n",
    );
    const events = readEvents(sw.world.pool, id);
    expectParsedEqual(
      events.filter((e) => e.kind === "end-requested" || e.kind === "ended"),
      [
        { at: anyIsoTime(), attempt: 1, kind: "end-requested", payload: { closing, by: "steward" } },
        { at: anyIsoTime(), attempt: 1, kind: "ended", payload: { closing, by: "steward", merged: false } },
      ],
      "the End on the Steward's log",
    );

    expectAnswer(
      await get(server, `/api/steward/state?conversation=${id}`),
      409,
      { reason: "steward: no Steward is on duty" },
      "the state of an ended Steward",
    );
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// Held spawns
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "the Steward adopts and discards Held spawns, each recorded as its own on the parent's log",
  async (t) => {
    const proposal = (title: string) => ({ title, body: `${title}: a follow-up worth doing later` });
    const sw = await stewardWorld(t, { config: { spawnCaps: { perAttempt: 0 } } });
    driveOutcomes(sw.herdr, {
      "01": [
        {
          status: "done",
          summary: "done, two follow-ups",
          commitSha: null,
          spawn: [proposal("Keep"), proposal("Drop")],
        },
      ],
    });
    const server = await sw.start();
    const both = await untilSnapshot(server, (snap) => snap.heldSpawns.length === 2, "both proposals held");
    const id = await enlistSteward(server);
    const [keep, drop] = both.heldSpawns;
    expect([keep!.title, drop!.title]).toEqual(["Keep", "Drop"]);

    expectAnswer(
      await post(server, "/api/steward/held", { conversation: id, action: "adopt", id: keep!.id }),
      200,
      { ok: true, message: `adopted held spawn ${keep!.id}` },
      "the Steward's adopt",
    );
    expectAnswer(
      await post(server, "/api/steward/held", { conversation: id, action: "discard", id: drop!.id }),
      200,
      { ok: true, message: `discarded held spawn ${drop!.id}` },
      "the Steward's discard",
    );
    await untilSnapshot(server, (snap) => snap.heldSpawns.length === 0, "no Held spawns left");
    const events = await until(
      () => readEvents(sw.world.pool, "01"),
      (all) => all.some((e) => e.kind === "spawn-adopted") && all.some((e) => e.kind === "spawn-discarded"),
      { what: "the adoption and the discard on 01's log" },
    );
    expectParsedEqual(
      events.find((e) => e.kind === "spawn-adopted")?.payload,
      { adopted: ["01-spawn-1"], fromHeld: keep!.id, by: "steward", conversation: id },
      "the spawn-adopted payload",
    );
    expectParsedEqual(
      events.find((e) => e.kind === "spawn-discarded")?.payload,
      { id: drop!.id, title: "Drop", by: "steward", conversation: id },
      "the spawn-discarded payload",
    );
    expectRefused(
      await post(server, "/api/steward/held", { conversation: "conv-99", action: "adopt", id: keep!.id }),
      `conv-99 is not the Steward on duty (${id} is)`,
      "an adopt as conv-99",
    );
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// The routes' own refusals
// ---------------------------------------------------------------------------

conformance(
  "steward",
  "the Steward routes refuse a body they cannot read, a missing field and an unknown route, and record nothing",
  async (t) => {
    const { sw, server, id } = await stewardAtCheckpoint(t, { "01": [checkpoint("ask me")] });
    const before = eventsFiles(sw.world.pool);

    const raw = await fetch(`${server.url}/api/steward/answer`, {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expectAnswer(
      { status: raw.status, body: await raw.json() },
      400,
      { reason: "invalid JSON body" },
      "a body that is not JSON",
    );
    expectAnswer(
      await post(server, "/api/steward/answer", { ticketId: "01", action: "resume" }),
      400,
      { reason: "conversation is required" },
      "an answer naming no conversation",
    );
    expectAnswer(
      await post(server, "/api/steward/dance", { conversation: id }),
      404,
      { reason: "no steward route /api/steward/dance" },
      "an unknown steward route",
    );
    expectAnswer(
      await get(server, "/api/steward/answer"),
      404,
      { reason: "no steward route /api/steward/answer" },
      "a GET on the answer route",
    );
    expectAnswer(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01" }),
      400,
      { reason: "ticketId and an action of resume, approve, reject or close are required" },
      "an answer with no action",
    );
    expectAnswer(
      await post(server, "/api/steward/keep-talking", { conversation: id, ticketId: "01", message: "  " }),
      400,
      { reason: "ticketId and message are required" },
      "a keep-talking with a blank message",
    );
    expectAnswer(
      await post(server, "/api/steward/leave", { conversation: id, ticketId: "01" }),
      400,
      { reason: "ticketId and note are required" },
      "a leave with no note",
    );
    expectAnswer(
      await post(server, "/api/steward/held", { conversation: id, action: "keep", id: "held-1" }),
      400,
      { reason: "id and an action of adopt or discard are required" },
      "a held decision with an unknown action",
    );
    expectParsedEqual(eventsFiles(sw.world.pool), before, "the pool's events files");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "an answer is refused for a Ticket with no pending Interrupt and for one whose answer is already queued",
  async (t) => {
    const { server, id } = await stewardAtCheckpoint(
      t,
      // 02 gets no Outcome, so its Attempt stays at work and the pool never
      // reaches the boundary where a queued answer is taken.
      { "01": [checkpoint("ask me")] },
      {
        tickets: [
          { file: "01.md", marker: READY_01, body: "# Talk it through\n\nbody" },
          { file: "02.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->", body: "# At work\n\nbody" },
        ],
      },
    );
    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "02", action: "resume" }),
      "ticket 02 has no pending Interrupt",
      "an answer on 02, at work",
    );
    expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
    await untilSnapshot(
      server,
      (snap) => snap.state.queuedAnswers.some((answer) => answer.ticketId === "01"),
      "the operator's answer to 01 queued",
    );
    expectRefused(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" }),
      "ticket 01 already has an answer queued",
      "an answer on 01 with one queued",
    );
  },
  { timeoutMs: 120_000 },
);
