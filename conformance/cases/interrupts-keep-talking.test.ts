/**
 * Keep talking and Continued attempts (issue #139, ADR-0027), seen from
 * outside the server (ADR-0036): a checkpointed terminal-backed Attempt's
 * pane is held while its Interrupt waits, POST /api/keep-talking continues it
 * in that pane as a Continued attempt at once, and the Continued attempt ends
 * on its Outcome, its pane going or its TUI exiting. Also the refusals, each
 * a 409 `reason` in the engine's own words, and the teaching Turn typed into
 * the pane, pinned byte for byte (inventory Decided 4).
 *
 * The pools are terminal-backed on the fake herdr. The stub claude reads the
 * prompt typed into its pane, writes the checkpoint Outcome it is scripted
 * with, and stays up the way an interactive harness does; the case then plays
 * the agent in the pane and writes each later Outcome itself. A lone Ticket
 * runs in the pool checkout. The server's own timings are its real ones: the
 * Continued attempt's ending is read every 2 s and the pane survey runs every
 * 15 s, so a case that answers "before the next survey" acts at once.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, PoolConfig, TicketLogResponse } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { callsOf, CLAUDE_READY, type HerdrCall, type HerdrProcess } from "../harness/herdr.ts";
import type { HttpAnswer } from "../harness/http.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { ConformanceStubBehaviour } from "../harness/stubs.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const TERMINAL: PoolConfig = { defaults: { harness: "claude", model: "m" }, terminal: "herdr" };

const marker = (id: string, status = "ready") => `<!-- state: id=${id} blocked-by=none status=${status} -->`;

/** Ticket 01, the one each case talks to. */
const TALK_01: TicketSeed = { file: "01.md", marker: marker("01"), body: "# Talk it through\n\nbody" };

/** A second Ticket, working beside 01. */
const BUSY_02: TicketSeed = { file: "02.md", marker: marker("02"), body: "# Busy\n\nbody" };

/** What an idle opencode pane shows: its idle footer (engine/spawn.ts's opencode descriptor). */
const OPENCODE_IDLE = "opencode\nctrl+p commands";

/** The checkpoint 01's first Attempt writes before it waits in its pane. */
const PAUSE: ConformanceStubBehaviour = { status: "checkpoint", brief: "ask me" };

async function snapshot(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  const snap = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snap === null) throw new Error("the pool has not started");
  return snap;
}

function ticketOf(snap: EnrichedSnapshot, id: string): EnrichedTicketState {
  const ticket = snap.state.tickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`the snapshot has no Ticket ${id}`);
  return ticket;
}

function untilSnapshot(
  server: CaseServer,
  done: (snap: EnrichedSnapshot) => boolean,
  what: string,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshot(server), done, { what, ms });
}

/** Wait for a Ticket's Held pane on the snapshot, at `attempt` when given. */
async function untilHeld(server: CaseServer, id: string, attempt?: number): Promise<{ attempt: number; paneId: string }> {
  const snap = await untilSnapshot(
    server,
    (s) => {
      const held = ticketOf(s, id).heldPane;
      return held != null && (attempt === undefined || held.attempt === attempt);
    },
    `${id}'s Held pane${attempt === undefined ? "" : ` of attempt ${attempt}`}`,
  );
  return ticketOf(snap, id).heldPane!;
}

/** Wait for an Interrupt of `kind` on a Ticket, and hand it back. */
async function untilInterrupt(server: CaseServer, id: string, kind: string, ms = 30_000) {
  const snap = await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === id && i.kind === kind),
    `a ${kind} Interrupt on ${id}`,
    ms,
  );
  return snap.state.interrupts.find((i) => i.ticketId === id && i.kind === kind)!;
}

function keepTalking(server: CaseServer, ticketId: string): Promise<HttpAnswer> {
  return server.http.post("/api/keep-talking", { ticketId });
}

/** A Keep talking the engine refuses: 409 with its reason, word for word. */
async function expectRefused(server: CaseServer, ticketId: string, reason: string): Promise<void> {
  const answer = await keepTalking(server, ticketId);
  expectParsedEqual({ status: answer.status, body: answer.json() }, { status: 409, body: { reason } }, `keep talking on ${ticketId}`);
}

/** A Keep talking the engine takes: 202 naming the Continued attempt. */
async function expectContinued(server: CaseServer, ticketId: string, attempt: number): Promise<void> {
  const answer = await keepTalking(server, ticketId);
  expectParsedEqual(
    { status: answer.status, body: answer.json() },
    { status: 202, body: { ticketId, attempt } },
    `keep talking on ${ticketId}`,
  );
}

/** Everything submitted with Enter into one pane from call `from` on, each Turn whole. */
function turnsInto(herdr: HerdrProcess, paneId: string, from = 0): string[] {
  const turns: string[] = [];
  let input = "";
  for (const call of herdr.calls.slice(from)) {
    if (call.method !== "pane.send_input" || call.params.pane_id !== paneId) continue;
    if (typeof call.params.text === "string") input += call.params.text;
    const keys = Array.isArray(call.params.keys) ? (call.params.keys as string[]) : [];
    if (keys.includes("enter")) {
      turns.push(input);
      input = "";
    } else if (keys.length > 0) {
      input = "";
    }
  }
  return turns;
}

/** Write a Ticket's Outcome where its prompt and its teaching said, as the agent in the pane would. */
function writeOutcome(world: World, id: string, outcome: Record<string, unknown>): void {
  writeFileSync(join(world.pool, "runs", `${id}.outcome.json`), JSON.stringify(outcome));
}

interface Talking {
  world: World;
  herdr: HerdrProcess;
  server: CaseServer;
  /** The Held pane 01 checkpointed in. */
  paneId: string;
  /** Written, the stub TUI in 01's pane quits. */
  quit: string;
}

/**
 * A terminal-backed pool whose Ticket 01 checkpointed and waits with its pane
 * held. Its stub TUI stays up two minutes, or, with `quit`, until the case
 * writes the quit file. With `holdPane` the fake herdr keeps a pane open
 * after the TUI in it exits, as a real pane keeps its shell.
 */
async function checkpointed(t: Case, options: { holdPane?: boolean; quit?: boolean } = {}): Promise<Talking> {
  const world = t.world({ tickets: [TALK_01], config: TERMINAL });
  const quit = join(world.root, "quit");
  world.stubs.script("01", { ...PAUSE, hold: options.quit ? quit : 120 });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, ...(options.holdPane ? { holdPane: true } : {}) });
  const server = await t.start(world, { herdr });
  const held = await untilHeld(server, "01", 1);
  return { world, herdr, server, paneId: held.paneId, quit };
}

/** The teaching Turn a Continued attempt of 01 is typed, as the operator chose it. */
function teaching(world: World, attempt: number): string {
  const pool = world.pool;
  const outcome = `${pool}/runs/01.outcome.json`;
  return (
    "---\n\n" +
    "The operator chose to keep talking with you here about Ticket 01, " +
    `instead of starting a fresh attempt. You are now its attempt ${attempt}: carry on from where you checkpointed, ` +
    "with the operator, in this same terminal and checkout.\n\n" +
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
    '["id", ...] naming what it overlaps: it is then held for the operator to decide instead of landing.'
  );
}

/**
 * A crash Interrupt's body for a Continued attempt of 01 that wrote no
 * Outcome: the reason, the attempt's log path, then the outcome file. The
 * log's tail lines between are not pinned: util-linux `script` writes its own
 * start and done lines into the Stream file when the TUI exits, BSD
 * `script -q` writes none.
 */
function expectCrashBody(body: string, world: World, reason: string): void {
  expect(body).toStartWith(`crash: ${reason}\n${join(world.pool, "runs", "01.log")}\n\n`);
  expect(body).toEndWith(`outcome file: ${join(world.pool, "runs", "01.outcome.json")} (missing)\n`);
}

// ---------------------------------------------------------------------------
// Continuing in the Held pane
// ---------------------------------------------------------------------------

// engine/keep-talking.test.ts:131
conformance(
  "interrupts",
  "a checkpointed Attempt's pane is held, and Keep talking continues it in place to done",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    const before = await snapshot(server);
    const first = readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 1)!;
    expect(first.payload.pane_id).toBe(paneId);
    expect(ticketOf(before, "01").liveAttempt).toBeNull();
    expect(before.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    const from = herdr.calls.length;

    await expectContinued(server, "01", 2);
    // At once: the Interrupt is answered, the Ticket runs, and its Live
    // attempt is the Continued one, on the very same pane.
    const talking = await snapshot(server);
    expect(talking.state.interrupts).toEqual([]);
    expect(ticketOf(talking, "01").status).toBe("in-progress");
    expect(ticketOf(talking, "01").heldPane).toBeNull();
    expect(ticketOf(talking, "01").liveAttempt).toMatchObject({ attempt: 2, paneId });
    expect(readStateLine(world.pool, "01.md").status).toBe("in-progress");
    // The Outcome the checkpoint was read from is spent.
    const outcome = join(world.pool, "runs", "01.outcome.json");
    expect(existsSync(outcome)).toBe(false);
    const events = readEvents(world.pool, "01");
    expectParsedEqual(
      events.find((e) => e.kind === "answered"),
      { at: anyIsoTime(), attempt: 1, kind: "answered", payload: { kind: "checkpoint", action: "keep-talking" } },
      "01's answered event",
    );
    expectParsedEqual(
      events.find((e) => e.kind === "spawned" && e.attempt === 2)?.payload,
      {
        argv: [],
        cwd: world.repo,
        branch: null,
        commitSha: first.payload.commitSha,
        env: first.payload.env,
        harness: "claude",
        model: "m",
        pane_id: paneId,
        tab_id: first.payload.tab_id,
        terminal_id: first.payload.terminal_id,
        continued: true,
        continues: 1,
        work_attempt: 1,
        numbered: false,
        stream: join(world.pool, "runs", "01.attempt-1.stream.jsonl"),
        stream_offset: expect.any(Number),
        wrapped: true,
      },
      "attempt 2's spawned event",
    );
    expect((await snapshot(server)).state.log).toContain(
      `ticket 01: keep talking; attempt 2 continues attempt 1 in pane ${paneId}`,
    );

    // The pane came forward and was taught once, with the exact Outcome path.
    await until(() => turnsInto(herdr, paneId, from), (turns) => turns.length === 1, {
      what: "the teaching Turn",
      ms: 30_000,
    });
    await herdr.settle();
    expect(callsOf(herdr, "pane.focus", from).map((call) => call.params)).toEqual([{ pane_id: paneId }]);
    expect(callsOf(herdr, "tab.create")).toHaveLength(1);
    const pastes = callsOf(herdr, "pane.send_input", from).filter((call) => typeof call.params.text === "string");
    expect(pastes).toHaveLength(1);
    expect(String(pastes[0]!.params.text)).toContain(outcome);

    writeOutcome(world, "01", { status: "done", summary: "talked it through", commitSha: null });
    const done = await untilSnapshot(server, (s) => ticketOf(s, "01").status === "done", "01 done");
    expect(ticketOf(done, "01").liveAttempt).toBeNull();
    expect(done.state.outcomes["01"]).toEqual({ status: "done", summary: "talked it through", commitSha: null });
    expect(done.state.log).toContain("ticket 01: continued attempt 2 exited 0, marker done");
    expectParsedEqual(
      readEvents(world.pool, "01").filter((e) => e.kind === "exited"),
      [
        { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "checkpoint", logTail: [], outcomeExists: true } },
        { at: anyIsoTime(), attempt: 2, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
      ],
      "01's exited events",
    );
    expect(readStateLine(world.pool, "01.md").status).toBe("done");
    await untilInterrupt(server, "REVIEW", "review");
  },
  { timeoutMs: 120_000 },
);

// engine/prompt.test.ts:349, engine/prompt.test.ts:357, engine/prompt.test.ts:361
conformance(
  "interrupts",
  "the teaching Turn tells the agent the operator carries on, the Outcome contract whole and the Spawn ledger",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    const from = herdr.calls.length;
    await expectContinued(server, "01", 2);
    const turns = await until(() => turnsInto(herdr, paneId, from), (typed) => typed.length >= 1, {
      what: "the teaching Turn",
      ms: 30_000,
    });
    expect(turns).toHaveLength(1);
    expectSameBytes(turns[0]!, teaching(world, 2), "the keep-talking teaching Turn");
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:183
conformance(
  "interrupts",
  "a Continued attempt's checkpoint raises a fresh Interrupt over the same pane, which can be continued again",
  async (t) => {
    const { world, server, paneId } = await checkpointed(t);
    await expectContinued(server, "01", 2);
    writeOutcome(world, "01", { status: "checkpoint", summary: "again", commitSha: null, brief: "one more thing" });

    const held = await untilHeld(server, "01", 2);
    expect(held.paneId).toBe(paneId);
    const interrupt = await untilInterrupt(server, "01", "checkpoint");
    expect(interrupt.body).toBe("one more thing");
    expect(readStateLine(world.pool, "01.md").status).toBe("checkpoint");
    expectParsedEqual(
      readEvents(world.pool, "01").filter((e) => e.attempt === 2).map((e) => [e.kind, e.payload]),
      [
        ["spawned", expect.objectContaining({ continued: true, continues: 1, pane_id: paneId })],
        ["exited", { code: 0, status: "checkpoint", logTail: [], outcomeExists: true }],
        ["checkpoint", {}],
      ],
      "attempt 2's events",
    );

    await expectContinued(server, "01", 3);
    const continued = readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 3)!;
    expect(continued.payload).toMatchObject({ pane_id: paneId, continued: true, continues: 2, work_attempt: 1 });
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// How a Continued attempt ends without an Outcome
// ---------------------------------------------------------------------------

// engine/keep-talking.test.ts:198
conformance(
  "interrupts",
  "a Continued attempt whose pane goes before an Outcome crashes, and the Ticket stays in progress",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    await expectContinued(server, "01", 2);
    await herdr.control("endPane", paneId);

    const interrupt = await untilInterrupt(server, "01", "crash");
    expectCrashBody(interrupt.body, world, `pane ${paneId} went before continued attempt 2 wrote an Outcome`);
    expect(ticketOf(await snapshot(server), "01").status).toBe("in-progress");
    expect(readStateLine(world.pool, "01.md").status).toBe("in-progress");
    expectParsedEqual(
      readEvents(world.pool, "01").filter((e) => e.attempt === 2 && e.kind !== "spawned").map((e) => [e.kind, e.payload]),
      [
        ["exited", { code: -2, status: "in-progress", logTail: expect.any(Array), outcomeExists: false }],
        [
          "crash",
          {
            code: -2,
            reason: `pane ${paneId} went before continued attempt 2 wrote an Outcome`,
            logTail: expect.any(Array),
            outcomeExists: false,
          },
        ],
      ],
      "attempt 2's ending",
    );
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:208
conformance(
  "interrupts",
  "a Continued attempt whose TUI exits while its pane stays open crashes",
  async (t) => {
    const { world, server, paneId, quit } = await checkpointed(t, { holdPane: true, quit: true });
    await expectContinued(server, "01", 2);
    writeFileSync(quit, "");

    const interrupt = await untilInterrupt(server, "01", "crash");
    expectCrashBody(interrupt.body, world, `the TUI in pane ${paneId} exited before continued attempt 2 wrote an Outcome`);
    expect(readStateLine(world.pool, "01.md").status).toBe("in-progress");
    // The exit code the TUI's wrapper wrote is the attempt's.
    const crash = readEvents(world.pool, "01").find((e) => e.kind === "crash" && e.attempt === 2);
    expect(crash?.payload).toMatchObject({
      code: 0,
      reason: `the TUI in pane ${paneId} exited before continued attempt 2 wrote an Outcome`,
      outcomeExists: false,
    });
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:226
conformance(
  "interrupts",
  "Keep talking clears an exit-code file from before the Attempt, and the TUI's fresh exit crashes it",
  async (t) => {
    const { world, server, paneId, quit } = await checkpointed(t, { holdPane: true, quit: true });
    const exitCode = join(world.pool, "runs", "01.exitcode");
    writeFileSync(exitCode, "0\n");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(exitCode, past, past);

    await expectContinued(server, "01", 2);
    expect(existsSync(exitCode)).toBe(false);
    writeFileSync(quit, "");
    const interrupt = await untilInterrupt(server, "01", "crash");
    expectCrashBody(interrupt.body, world, `the TUI in pane ${paneId} exited before continued attempt 2 wrote an Outcome`);
    // The file there now is the fresh one the TUI's wrapper wrote.
    expect(statSync(exitCode).mtimeMs).toBeGreaterThan(past.getTime() + 60_000);
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:238
conformance(
  "interrupts",
  "a Continued attempt ends on its valid Outcome even when its pane goes with it",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    await expectContinued(server, "01", 2);
    writeOutcome(world, "01", { status: "done", summary: "said and gone", commitSha: null });
    await herdr.control("endPane", paneId);

    const done = await untilSnapshot(server, (s) => ticketOf(s, "01").status === "done", "01 done");
    expect(done.state.interrupts.filter((i) => i.kind === "crash")).toEqual([]);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "crash")).toEqual([]);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "exited").at(-1)?.payload).toEqual({
      code: 0,
      status: "done",
      logTail: [],
      outcomeExists: true,
    });
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// What Keep talking refuses
// ---------------------------------------------------------------------------

// engine/keep-talking.test.ts:259
conformance(
  "interrupts",
  "Keep talking refuses a Ticket not waiting at a checkpoint, and one whose checkpoint already has an answer queued",
  async (t) => {
    // 01 and 02 run as one super-step, each in its own worktree; 02 stays
    // at work, so an answer to 01 queues for the boundary.
    const world = t.world({ tickets: [TALK_01, BUSY_02], config: TERMINAL });
    world.stubs.script("01", { ...PAUSE, hold: 120 });
    const busy = world.stubs.hold("02");
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    await untilHeld(server, "01", 1);
    expect(ticketOf(await snapshot(server), "02").status).toBe("in-progress");

    await expectRefused(server, "02", "keep talking: ticket 02 is not waiting at a checkpoint");
    const resumed = await server.http.post("/api/resume", { ticketId: "01" });
    expect(resumed.status).toBe(202);
    expect((await snapshot(server)).state.queuedAnswers.map((a) => [a.ticketId, a.kind])).toEqual([["01", "checkpoint"]]);
    await expectRefused(server, "01", "keep talking: ticket 01 already has an answer to its checkpoint queued");
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "spawned")).toHaveLength(1);

    // The queued Resume is still the answer: at the boundary 01 launches
    // afresh, in a tab of its own.
    await busy.release();
    await until(
      () => readEvents(world.pool, "01").filter((e) => e.kind === "spawned"),
      (spawned) => spawned.length === 2,
      { what: "01's fresh attempt", ms: 30_000 },
    );
    expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 2)?.payload.continued).toBeUndefined();
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:334
conformance(
  "interrupts",
  "Keep talking refuses while an enlisted Conversation works in a subdirectory of the pool checkout",
  async (t) => {
    const { world, herdr, server } = await checkpointed(t);
    expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned")?.payload.cwd).toBe(world.repo);
    const sub = join(world.repo, "sub");
    mkdirSync(sub, { recursive: true });
    await herdr.control("seedAgent", {
      paneId: "pane-op",
      agent: "opencode",
      cwd: sub,
      title: "OC",
      status: "idle",
      rendered: OPENCODE_IDLE,
      tabId: "tab-op",
    });
    const enlisted = await server.http.post("/api/enlist", { becomes: "conversation", paneId: "pane-op", title: "Beside" });
    expect(enlisted.status).toBe(201);
    const { conversationId } = enlisted.json<{ conversationId: string }>();

    await expectRefused(
      server,
      "01",
      `keep talking: ticket 01 worked in the pool checkout, where ${conversationId} is working now; ` +
        "keep talking once it is done",
    );
    const after = await snapshot(server);
    expect(after.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    expect(ticketOf(after, "01").heldPane).not.toBeNull();
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:353
conformance(
  "interrupts",
  "Keep talking refuses in a pool without git while another Ticket works in the pool checkout",
  async (t) => {
    const world = t.world({ tickets: [TALK_01, BUSY_02], config: TERMINAL, git: false });
    world.stubs.script("01", { ...PAUSE, hold: 120 });
    const busy = world.stubs.hold("02");
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    await untilHeld(server, "01", 1);
    expect(ticketOf(await snapshot(server), "02").liveAttempt).not.toBeNull();

    await expectRefused(
      server,
      "01",
      "keep talking: ticket 01 worked in the pool checkout, where 02 is working now; keep talking once it is done",
    );
    expect((await snapshot(server)).state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "answered")).toEqual([]);
    await busy.release();
  },
  { timeoutMs: 120_000 },
);

// Uncovered behaviour: engine/engine.ts:4674.
conformance(
  "interrupts",
  "Keep talking refuses when herdr will not list its panes, and leaves the checkpoint and its Held pane as they were",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    const from = herdr.calls.length;
    await herdr.control("fail", "pane.list");

    await expectRefused(server, "01", "keep talking: ticket 01 cannot be checked: the herdr daemon did not list its panes");
    await herdr.settle();
    expect(callsOf(herdr, "pane.list", from).length).toBeGreaterThan(0);
    expect(callsOf(herdr, "pane.focus", from)).toEqual([]);
    expect(callsOf(herdr, "pane.send_input", from)).toEqual([]);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "answered" || e.attempt === 2)).toEqual([]);
    const after = await snapshot(server);
    expect(after.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    expect(ticketOf(after, "01").heldPane).toEqual({ attempt: 1, paneId });

    // Once herdr answers again, the same Keep talking goes through.
    await herdr.control("fail", "pane.list", false);
    await expectContinued(server, "01", 2);
  },
  { timeoutMs: 120_000 },
);

// Uncovered behaviour: engine/engine.ts:4396 and 4663. The reason
// engine/engine.ts:4682 names ("lost its terminal") is never given: see
// NOT-PORTED.md.
conformance(
  "interrupts",
  "Keep talking over a pane that has gone refuses with no terminal left, and the Held pane goes",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    expect(ticketOf(await snapshot(server), "01").heldPane).toEqual({ attempt: 1, paneId });
    await herdr.control("endPane", paneId);

    await expectRefused(server, "01", "keep talking: ticket 01 has no terminal left to continue in");
    const after = await snapshot(server);
    expect(ticketOf(after, "01").heldPane).toBeNull();
    expect(after.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    // Asked again, the answer is the same.
    await expectRefused(server, "01", "keep talking: ticket 01 has no terminal left to continue in");
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "answered" || e.attempt === 2)).toEqual([]);
  },
  { timeoutMs: 120_000 },
);

// Uncovered behaviour: engine/engine.ts:4685, with 4396 and 4663. The
// reason engine/engine.ts:4685 names ("lost its agent") is never given: see
// NOT-PORTED.md.
conformance(
  "interrupts",
  "Keep talking over a pane whose TUI has exited refuses with no terminal left: a bare shell is nothing to talk to",
  async (t) => {
    const { world, server, quit } = await checkpointed(t, { holdPane: true, quit: true });
    writeFileSync(quit, "");
    // The pane stays open at its shell; the TUI's wrapper writes its exit
    // code as the TUI exits.
    await until(() => existsSync(join(world.pool, "runs", "01.exitcode")), (yes) => yes, {
      what: "the TUI's exit code",
      ms: 20_000,
    });
    await expectRefused(server, "01", "keep talking: ticket 01 has no terminal left to continue in");
    const after = await snapshot(server);
    expect(ticketOf(after, "01").heldPane).toBeNull();
    expect(after.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "checkpoint"]]);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "answered" || e.attempt === 2)).toEqual([]);
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// A teaching Turn that cannot land, and the Continued attempt's own log
// ---------------------------------------------------------------------------

// Uncovered behaviour: engine/engine.ts:4902 and 4972, engine/continued.ts:262.
conformance(
  "interrupts",
  "a Continued attempt whose teaching Turn cannot be typed ends at a checkpoint of the engine's own over the same pane",
  async (t) => {
    const { world, herdr, server, paneId } = await checkpointed(t);
    // The next paste into the pane is lost, as a paste sent before a TUI is
    // truly ready can be: the teaching never echoes.
    await herdr.control("dropPaneInput", paneId, 1);
    await expectContinued(server, "01", 2);

    const held = await untilHeld(server, "01", 2);
    expect(held.paneId).toBe(paneId);
    const untaught =
      `Keep talking could not teach the agent in pane ${paneId}: the Turn could not be delivered. ` +
      "Continued attempt 2 is over without an Outcome, and the pane was left as it was. Keep talking " +
      "again once the agent is waiting on you, or answer resume to start a fresh attempt.";
    const snap = await snapshot(server);
    expect(snap.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: untaught }]);
    expect(snap.state.log).toContain(
      "ticket 01: continued attempt 2 could not be taught (the Turn could not be delivered); checkpoint raised",
    );
    expectParsedEqual(
      readEvents(world.pool, "01").filter((e) => e.attempt === 2 && e.kind !== "spawned"),
      [
        { at: anyIsoTime(), attempt: 2, kind: "exited", payload: { code: -4, status: "checkpoint", logTail: [], outcomeExists: false } },
        { at: anyIsoTime(), attempt: 2, kind: "checkpoint", payload: {} },
      ],
      "attempt 2's ending",
    );
    expectSameBytes(
      readFileSync(join(world.pool, "issues", "01.md"), "utf8"),
      `${marker("01", "checkpoint")}\n\n# Talk it through\n\nbody\n\n---\n\n## Brief\n\n${untaught}\n`,
      "issues/01.md",
    );
  },
  { timeoutMs: 120_000 },
);

// Uncovered behaviour: engine/engine.ts:4710 and 4714, engine/continued.ts:107.
conformance(
  "interrupts",
  "a Continued attempt's log holds only what its pane printed after Keep talking began, and the earlier attempt's stays readable",
  async (t) => {
    const world = t.world({ tickets: [TALK_01], config: TERMINAL });
    const later = join(world.root, "say-more");
    // The TUI prints a line before it checkpoints, and another once the case
    // asks it to, after Keep talking began.
    world.stubs.script("01", {
      ...PAUSE,
      hold: 120,
      stdout: "said before keep talking\n",
      run:
        `( for _ in $(seq 1 1200); do if [ -e ${JSON.stringify(later)} ]; then echo said after keep talking; break; fi; ` +
        '[ -d "$CONFORMANCE_STUBS" ] || break; sleep 0.05; done ) &',
    });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    await untilHeld(server, "01", 1);
    await expectContinued(server, "01", 2);
    writeFileSync(later, "");

    const log = (attempt: number) =>
      server.http.get(`/api/log?ticket=01&attempt=${attempt}`).then((answer) => answer.json<TicketLogResponse>());
    const second = await until(() => log(2), (read) => read.content.includes("said after keep talking"), {
      what: "attempt 2's log",
      ms: 30_000,
    });
    const first = await log(1);
    expect(second.content.split("\n").filter((line) => line !== "")).toEqual(["said after keep talking"]);
    expect(first.content).toContain("said before keep talking");
    expect(first.content).not.toContain("said after keep talking");
    expect(second.attempts).toEqual([
      {
        attempt: 1,
        kind: "implement",
        current: false,
        logFile: "01.attempt-1.log",
        streamFile: "01.attempt-1.stream.jsonl",
      },
      { attempt: 2, kind: "implement", current: true, logFile: "01.log", streamFile: null },
    ]);
    const spawned = readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 2);
    expect(spawned?.payload.stream_offset).toBeGreaterThan(0);
  },
  { timeoutMs: 120_000 },
);
