/**
 * How a Notice reaches its parent Conversation (ADR-0018, ADR-0030), seen
 * from outside the server (ADR-0036): queued while the parent's Turn reads
 * working, typed as its own Turn once it reads waiting, kept and retried
 * when herdr refuses or the pane swallows it, and dropped, logged on the
 * child's own file, when the parent is not live or ends first. Rows of the
 * `conversations` area, ticket C17, in the Rust port inventory
 * (docs/research/rust-port/test-inventory.md), and the area's gap on a
 * Notice dropped for a parent that ended before delivery.
 *
 * Each Notice typed or dropped is pinned byte for byte (the inventory's
 * Decided 4). A lone spawned Ticket runs in the pool checkout, on no branch
 * of its own, yet its Notice names the branch a worktree of it would have
 * had, as the Bun server writes it.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { poolLog, ticketWorktree } from "../harness/git-pool.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { answerPrompt, doneOutcome } from "../harness/herdr-tui.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  BODY,
  IDLE,
  LAUNCH_TURNS,
  checkpointOutcome,
  ms,
  noticesIn,
  proposeSpawns,
  pushedViews,
  show,
  startConversation,
  startTalk,
  ticketClosedText,
  ticketEndedText,
  turnsInto,
  untilEvent,
  untilNoticesInto,
  untilPushedTurn,
  untilReads,
  viewportReads,
} from "./conversations-support.ts";
import {
  checkpoint,
  driveOutcomes,
  enlistSteward,
  STEWARD_PANE,
  stewardWorld,
  untilInterrupt,
  untilSnapshot,
} from "./steward/pool.ts";

/** The checkpoint Notice of the lone spawned Ticket these cases run. */
function childCheckpointText(world: World, brief: string): string {
  return ticketEndedText({
    id: "conv-1-spawn-1",
    title: "conv-1-spawn-1: Checkpointing child",
    outcome: "checkpoint",
    brief,
    branch: ticketWorktree(world.repo, "conv-1-spawn-1").branch,
    diff: "(no changes)",
  });
}

/** conv-1 spawns one Ticket, which pauses at once with `brief`; resolves once its checkpoint is logged. */
async function childCheckpoints(world: World, herdr: HerdrProcess, brief: string): Promise<void> {
  proposeSpawns(world, "conv-1", [{ title: "Checkpointing child", body: BODY }]);
  await answerPrompt(herdr, "conv-1-spawn-1", checkpointOutcome(brief), { ms: 30_000 });
  await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "checkpoint", "conv-1-spawn-1's checkpoint");
}

/** The Steward Notices typed into its pane so far, each whole. */
function stewardNotices(herdr: HerdrProcess): string[] {
  return turnsInto(herdr, STEWARD_PANE).filter((turn) => turn.startsWith("Pool news for the Steward"));
}

/** Wait for `count` Steward Notices; hand them all back. */
function untilStewardNotices(herdr: HerdrProcess, count: number, ms = 30_000): Promise<string[]> {
  return until(() => stewardNotices(herdr), (turns) => turns.length >= count, { ms, what: `${count} Steward Notices` });
}

/** The pane.send_input call that typed `text`, at or after call `from`. */
function typedAt(herdr: HerdrProcess, paneId: string, text: string, from = 0): number {
  return herdr.calls.findIndex(
    (call, i) => i >= from && call.method === "pane.send_input" && call.params.pane_id === paneId && call.params.text === text,
  );
}

// notices.test.ts:668
conformance(
  "conversations",
  "a Notice waits while its parent reads working and is typed whole the read it reads waiting, logged on both sides",
  async (t) => {
    const { world, herdr, server, socket } = await startTalk(t);
    const parent = await startConversation(server, { title: "Talk" });
    const paneId = parent.paneId!;
    await childCheckpoints(world, herdr, "Needs your input.");

    // Three more reads of the busy pane: the Notice stays queued.
    await untilReads(herdr, paneId, herdr.calls.length, 3);
    expect(turnsInto(herdr, paneId)).toHaveLength(LAUNCH_TURNS);
    expect(noticesIn(world, "conv-1-spawn-1")).toEqual([]);

    const fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, IDLE);
    const typed = await untilNoticesInto(herdr, paneId, 1);
    const text = childCheckpointText(world, "Needs your input.");
    expectSameBytes(typed[0]!, text, "the Notice");

    // Typed only after the read that flipped the Turn to waiting: the third
    // of the idle frame, the first being the change and the second the
    // first stable read.
    const reads = viewportReads(herdr, paneId, from);
    const at = typedAt(herdr, paneId, text, from);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(at).toBeGreaterThan(herdr.calls.indexOf(reads[2]!));
    // The flip's own snapshot can reach the socket after the Notice reaches herdr.
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting", { from: fromFrame });
    expect(ms(waiting.turn.idleSince)).toBeGreaterThanOrEqual(reads[2]!.at);
    expect(ms(waiting.turn.idleSince)).toBeLessThanOrEqual(herdr.calls[at]!.at);

    await untilEvent(world, "conv-1", (e) => e.kind === "notice", "the parent's notice event");
    const child = noticesIn(world, "conv-1-spawn-1");
    expect(child.map((e) => [e.attempt, e.payload])).toEqual([
      [1, { kind: "ticket-ended", delivered: true, to: "conv-1" }],
    ]);
    expect(noticesIn(world, "conv-1").map((e) => [e.attempt, e.payload])).toEqual([
      [1, { kind: "ticket-ended", delivered: true, from: "conv-1-spawn-1" }],
    ]);
    expect(readEvents(world.pool, "conv-1-spawn-1").some((e) => e.kind === "notice-dropped")).toBe(false);
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:744
conformance(
  "conversations",
  "a Notice herdr refuses to take stays queued, shows on the view and is typed on a later read, never dropped",
  async (t) => {
    const { world, herdr, server, socket } = await startTalk(t);
    const parent = await startConversation(server, { title: "Talk" });
    const paneId = parent.paneId!;
    await childCheckpoints(world, herdr, "Needs your input.");

    await herdr.control("failNextCall", "pane.send_input");
    await show(herdr, paneId, IDLE);

    const failed = await untilEvent(
      world,
      "conv-1-spawn-1",
      (e) => e.kind === "notice" && e.payload.delivered === false,
      "the failed delivery",
    );
    const error = failed.payload.error as string;
    expect(typeof error).toBe("string");
    expect(error).toStartWith("pane.send_input failed: ");
    expect(error).toContain("pane.send_input blipped");
    expect(failed.payload).toEqual({ kind: "ticket-ended", delivered: false, error, to: "conv-1" });
    expect(readEvents(world.pool, "conv-1-spawn-1").some((e) => e.kind === "notice-dropped")).toBe(false);

    await untilEvent(
      world,
      "conv-1-spawn-1",
      (e) => e.kind === "notice" && e.payload.delivered === true,
      "the retried delivery",
    );
    const typed = await untilNoticesInto(herdr, paneId, 1);
    expect(typed).toHaveLength(1);
    expectSameBytes(typed[0]!, childCheckpointText(world, "Needs your input."), "the Notice");
    expect(noticesIn(world, "conv-1-spawn-1").map((e) => e.payload)).toEqual([
      { kind: "ticket-ended", delivered: false, error, to: "conv-1" },
      { kind: "ticket-ended", delivered: true, to: "conv-1" },
    ]);
    await untilEvent(world, "conv-1", (e) => e.kind === "notice" && e.payload.delivered === true, "the parent's delivery");
    expect(noticesIn(world, "conv-1").map((e) => e.payload)).toEqual([
      { kind: "ticket-ended", delivered: false, error, from: "conv-1-spawn-1" },
      { kind: "ticket-ended", delivered: true, from: "conv-1-spawn-1" },
    ]);

    // The failure showed on the parent's view until the Notice landed.
    await until(() => pushedViews(socket, "conv-1").at(-1)?.view.delivery, (delivery) => delivery === undefined, {
      what: "the delivery failure cleared",
    });
    const shown = pushedViews(socket, "conv-1").find((p) => p.view.delivery !== undefined)?.view.delivery;
    expect(shown).toEqual({ failingSince: expect.any(String), lastError: error });
    const log = await poolLog(server);
    expect(
      log.filter(
        (line) => line === `conversation conv-1: Notices are not reaching its pane (${error}); retrying while it reads as waiting`,
      ),
    ).toHaveLength(1);
    expect(
      log.filter((line) => line === `conversation conv-1: Notices reach its pane again (failing since ${shown!.failingSince})`),
    ).toHaveLength(1);
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:813
conformance(
  "conversations",
  "a spawned Ticket under verify 1 that passes its grade and merges is told done",
  async (t) => {
    const { world, herdr, server } = await startTalk(t, { config: { assign: { "conv-1-spawn-1": { verify: 1 } } } });
    const parent = await startConversation(server, { title: "Talk" });
    const paneId = parent.paneId!;

    proposeSpawns(world, "conv-1", [{ title: "Verified child", body: BODY }]);
    await answerPrompt(herdr, "conv-1-spawn-1.attempt-1", doneOutcome(), { ms: 30_000 });
    await answerPrompt(
      herdr,
      "conv-1-spawn-1-grader-1",
      { ...doneOutcome("graded"), grade: { score: 8, verdict: "pass", reasons: "it holds up" } },
      { ms: 60_000 },
    );
    await until(() => readMarkers(world.pool)["conv-1-spawn-1"]?.status, (status) => status === "done", {
      ms: 60_000,
      what: "conv-1-spawn-1 done",
    });
    await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "merged", "conv-1-spawn-1 merged");
    await show(herdr, paneId, IDLE);

    const delivered = await untilEvent(
      world,
      "conv-1-spawn-1",
      (e) => e.kind === "notice" && e.payload.delivered === true,
      "the delivered Notice",
    );
    expect(delivered.payload).toEqual({ kind: "ticket-ended", delivered: true, to: "conv-1" });
    const typed = await untilNoticesInto(herdr, paneId, 1);
    // The branch is the verify Attempt's own, which is what merged.
    expect(typed).toHaveLength(1);
    expectSameBytes(
      typed[0]!,
      ticketEndedText({
        id: "conv-1-spawn-1",
        title: "conv-1-spawn-1: Verified child",
        outcome: "done",
        branch: ticketWorktree(world.repo, "conv-1-spawn-1.attempt-1").branch,
        diff: "(no changes)",
      }),
      "the Notice",
    );
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:921
conformance(
  "conversations",
  "a Notice for a parent that is not live is dropped, logged on the child's own file with its text, the parent's never written",
  async (t) => {
    const world = t.world({
      tickets: [
        {
          file: "conv-1-spawn-1.md",
          marker: "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->",
          body: "# Child of an ended talk\n\nbody",
        },
      ],
      config: { defaults: { harness: "claude", model: "m" } },
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n# Talk\n\n\n",
      },
    });
    world.stubs.script("conv-1-spawn-1", { status: "checkpoint", brief: "b" });
    const server = await t.start(world);

    const dropped = await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "notice-dropped", "the dropped Notice");
    expect(dropped.payload).toEqual({
      to: "conv-1",
      kind: "ticket-ended",
      reason: "parent conversation is not live",
      text: ticketEndedText({
        id: "conv-1-spawn-1",
        title: "Child of an ended talk",
        outcome: "checkpoint",
        brief: "b",
        branch: ticketWorktree(world.repo, "conv-1-spawn-1").branch,
        diff: "(no changes)",
      }),
    });

    // Closing the paused child tells the parent too: dropped the same way.
    const closed = await server.http.post("/api/resume", {
      ticketId: "conv-1-spawn-1",
      action: "close",
      note: "the parent changed course",
    });
    expect(closed.status, closed.text).toBe(202);
    await until(
      () => readEvents(world.pool, "conv-1-spawn-1").filter((e) => e.kind === "notice-dropped"),
      (events) => events.length >= 2,
      { what: "the second dropped Notice" },
    );
    const drops = readEvents(world.pool, "conv-1-spawn-1").filter((e) => e.kind === "notice-dropped");
    expect(drops).toHaveLength(2);
    expect(drops[1]!.payload).toEqual({
      to: "conv-1",
      kind: "ticket-ended",
      reason: "parent conversation is not live",
      text: ticketClosedText("conv-1-spawn-1", "Child of an ended talk", "the parent changed course"),
    });
    expect(drops.map((e) => e.attempt)).toEqual([1, 1]);
    expect(noticesIn(world, "conv-1-spawn-1")).toEqual([]);
    expect(existsSync(join(world.pool, "runs", "conv-1.events.jsonl"))).toBe(false);
  },
);

// The checkpoint Notice's no-git placeholders (engine/conversations.ts,
// ticketCheckpointed), reached the same way as the row above.
conformance(
  "conversations",
  "a Notice from a pool with no git checkout names neither a branch nor a diff",
  async (t) => {
    const world = t.world({
      git: false,
      tickets: [
        {
          file: "conv-1-spawn-1.md",
          marker: "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->",
          body: "# Child of an ended talk\n\nbody",
        },
      ],
      config: { defaults: { harness: "claude", model: "m" } },
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n# Talk\n\n\n",
      },
    });
    world.stubs.script("conv-1-spawn-1", { status: "checkpoint", brief: "b" });
    await t.start(world);

    const dropped = await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "notice-dropped", "the dropped Notice");
    expect(dropped.payload.text).toBe(
      'Ticket conv-1-spawn-1 ("Child of an ended talk") ended: checkpoint.\n' +
        "Brief: b\n" +
        "Branch: (no git checkout)\n" +
        "Diff:\n" +
        "(no git checkout)",
    );
  },
);

// Gap: conversations, engine/conversations.ts:2386-2390.
conformance(
  "conversations",
  "a Notice still queued when its parent ends is dropped, logged on the child's file with its text, and never typed",
  async (t) => {
    const { world, herdr, server } = await startTalk(t);
    const parent = await startConversation(server, { title: "Talk" });
    const paneId = parent.paneId!;
    await childCheckpoints(world, herdr, "Needs your input.");
    await untilReads(herdr, paneId, herdr.calls.length, 2);

    const ended = await server.http.post("/api/conversations/end", { id: "conv-1" });
    expect(ended.status, ended.text).toBe(202);

    const dropped = await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "notice-dropped", "the dropped Notice");
    expect(dropped.attempt).toBe(1);
    expect(dropped.payload).toEqual({
      to: "conv-1",
      kind: "ticket-ended",
      reason: "parent conversation ended before delivery",
      text: childCheckpointText(world, "Needs your input."),
    });
    await untilEvent(world, "conv-1", (e) => e.kind === "ended", "conv-1 ended");
    expect(turnsInto(herdr, paneId)).toHaveLength(LAUNCH_TURNS);
    expect(noticesIn(world, "conv-1-spawn-1")).toEqual([]);
    expect(noticesIn(world, "conv-1")).toEqual([]);
  },
  { timeoutMs: 120_000 },
);

// steward.test.ts:671
conformance(
  "conversations",
  "a pane that swallows every Notice shows on the view, is logged once, retried while it waits, and clears when one lands",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("one"), checkpoint("two")] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    const id = await enlistSteward(server);
    await untilStewardNotices(sw.herdr, 1);

    // Something in the pane eats every Turn from here (a Blocking dialog,
    // live), while it still reads as waiting.
    await sw.herdr.control("dropPaneInput", STEWARD_PANE, 1_000_000);
    const resumed = await server.http.post("/api/resume", { ticketId: "01", action: "resume" });
    expect(resumed.status, resumed.text).toBe(202);
    const failing = await untilSnapshot(
      server,
      (snap) => snap.state.conversations.some((c) => c.id === id && c.delivery !== undefined),
      "the delivery failure on the view",
      60_000,
    );
    const delivery = failing.state.conversations.find((c) => c.id === id)!.delivery!;
    expect(delivery).toEqual({
      failingSince: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      lastError: "the Turn never showed in the pane, so it was not sent",
    });

    // Retries go on, but the logs carry the episode's first failure only.
    const sends = () =>
      sw.herdr.calls.filter((c) => c.method === "pane.send_input" && c.params.pane_id === STEWARD_PANE).length;
    const before = sends();
    await until(sends, (n) => n > before + 4, { ms: 60_000, what: "more delivery tries" });
    const failed = (owner: string) =>
      readEvents(sw.world.pool, owner).filter((e) => e.kind === "notice" && e.payload.delivered === false);
    expect(failed("01").map((e) => e.payload)).toEqual([
      { kind: "steward-interrupt", delivered: false, to: id },
    ]);
    expect(failed(id).map((e) => e.payload)).toEqual([{ kind: "steward-interrupt", delivered: false, from: "01" }]);
    const notReaching =
      `conversation ${id}: Notices are not reaching its pane ` +
      "(the Turn never showed in the pane, so it was not sent); retrying while it reads as waiting";
    expect((await poolLog(server)).filter((line) => line === notReaching)).toHaveLength(1);

    await sw.herdr.control("dropPaneInput", STEWARD_PANE, -2_000_000);
    const told = await untilStewardNotices(sw.herdr, 2, 60_000);
    expectSameBytes(
      told[1]!,
      "Pool news for the Steward:\n\n" +
        'Ticket 01 ("Talk it through") is waiting at a checkpoint Interrupt.\n' +
        "Brief:\n" +
        "two\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.",
      "the Notice that landed",
    );
    await untilSnapshot(
      server,
      (snap) => snap.state.conversations.some((c) => c.id === id && c.delivery === undefined),
      "the delivery failure cleared",
    );
    await until(
      () => readEvents(sw.world.pool, "01").filter((e) => e.kind === "notice" && e.payload.delivered === true),
      (events) => events.length >= 2,
      { what: "the second delivered Notice on 01's log" },
    );
    expect(failed("01")).toHaveLength(1);
    expect(stewardNotices(sw.herdr)).toHaveLength(2);
    const log = await poolLog(server);
    expect(log.filter((line) => line === notReaching)).toHaveLength(1);
    expect(
      log.filter((line) => line === `conversation ${id}: Notices reach its pane again (failing since ${delivery.failingSince})`),
    ).toHaveLength(1);
  },
  { timeoutMs: 150_000 },
);
