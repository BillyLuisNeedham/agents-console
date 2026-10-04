/**
 * Continued attempts and re-adopted terminal Attempts across a stop and
 * start (issue #139, ADR-0027, ADR-0014), seen from outside the server
 * (ADR-0036). A stop leaves a Continued attempt talking in its Held pane, so
 * the next server re-adopts it, untaught again, and records its Outcome when
 * it comes; one that ended while no server ran is graded, never re-run; a
 * merge held at the pool checkout's gate, behind a Continued attempt working
 * there, is recorded at once and redone after the restart once that attempt
 * ends; and an Attempt re-adopted in its worktree merges when it ends done.
 * Ticket C06 of the inventory's split (docs/research/rust-port/
 * test-inventory.md): each case names the engine test it carries over.
 *
 * The pools are terminal-backed on one fake herdr, alive across both servers
 * of a case. Ticket 01's stub claude reads the prompt typed into its pane,
 * writes the checkpoint it is scripted with, and stays up the way an
 * interactive harness does; the case then plays the agent in the pane and
 * writes each later Outcome itself. A lone Ticket runs in the pool checkout.
 */

import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, PoolConfig } from "../../engine/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { gitIn, ticketWorktree } from "../harness/git-pool.ts";
import { CLAUDE_READY, type HerdrCall, type HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readTicketFile, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  TERMINAL,
  poolLog,
  quiescentWith,
  restartCase,
  settle,
  snapshotOf,
  startLeg,
  stateLine,
  ticket,
  untilLogged,
  untilState,
} from "./restart-support.ts";

/** Ticket 01's body: its title is its id. */
const BODY = "# 01\n\nWork on 01.";

/** The Brief 01's checkpoint writes under its body. */
const BRIEF = "\n\n---\n\n## Brief\n\nask me";

/** The checkpoint 01's first Attempt writes before it waits in its pane, up 150 seconds. */
function pause() {
  return { status: "checkpoint", brief: "ask me", hold: 150 } as const;
}

/** A frame both claude's and opencode's readiness patterns match, with claude's idle prompt. */
const BOTH_READY = "Claude Code v · Ask anything\n❯ ";

function cardOf(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const card = snapshot.state.tickets.find((each) => each.id === id);
  if (!card) throw new Error(`no Ticket ${id} in the snapshot`);
  return card;
}

/** The calls of one method from index `from` on. */
function callsOf(herdr: HerdrProcess, method: string, from = 0): HerdrCall[] {
  return herdr.calls.slice(from).filter((call) => call.method === method);
}

/** Wait for Ticket `id`'s Held pane of `attempt`. */
async function untilHeld(server: CaseServer, id: string, attempt = 1): Promise<string> {
  const snapshot = await untilState(
    server,
    `${id}'s Held pane of attempt ${attempt}`,
    (s) => cardOf(s, id).heldPane?.attempt === attempt,
    60_000,
  );
  return cardOf(snapshot, id).heldPane!.paneId;
}

/** Wait for Ticket `id`'s Live attempt to be `attempt`, in a pane; the snapshot. */
function untilLive(server: CaseServer, id: string, attempt: number): Promise<EnrichedSnapshot> {
  return untilState(
    server,
    `${id}'s Live attempt ${attempt}`,
    (s) => cardOf(s, id).liveAttempt?.attempt === attempt,
    60_000,
  );
}

/**
 * Keep talking on 01's Held pane, which must take it as Continued attempt 2,
 * and wait for the teaching Turn naming `outcome` to be typed there and
 * submitted.
 */
async function keepTalking(server: CaseServer, herdr: HerdrProcess, paneId: string, outcome: string): Promise<void> {
  const from = herdr.calls.length;
  const answer = await server.http.post("/api/keep-talking", { ticketId: "01" });
  expect(answer.status, answer.text).toBe(202);
  expect(answer.json<object>()).toEqual({ ticketId: "01", attempt: 2 });
  const typed = await herdr.waitForCall(
    (call) =>
      call.method === "pane.send_input" &&
      call.params.pane_id === paneId &&
      typeof call.params.text === "string" &&
      call.params.text.includes("You are now its attempt 2") &&
      call.params.text.includes(outcome),
    { from, ms: 30_000 },
  );
  await herdr.waitForCall(
    (call) =>
      call.method === "pane.send_input" &&
      call.params.pane_id === paneId &&
      Array.isArray(call.params.keys) &&
      call.params.keys.includes("enter"),
    { from: herdr.calls.indexOf(typed) + 1, ms: 30_000 },
  );
}

/** Write an Outcome file under runs/, as the agent in the pane would. */
function writeOutcome(world: World, name: string, outcome: Record<string, unknown>): void {
  writeFileSync(join(world.pool, "runs", name), JSON.stringify(outcome));
}

/** A Ticket's events of one kind. */
function eventsOf(world: World, id: string, kind: string) {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** A Ticket's events as `<attempt> <kind>`, in order. */
function eventLines(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => `${event.attempt} ${event.kind}`);
}

/** The events of a done Ticket whose merge a stop dropped at the gate, once redone and landed. */
const DEFERRED_TWICE = ["1 scheduled", "1 spawned", "1 exited", "1 merge-deferred", "1 merge-deferred", "1 merged", "1 tab-closed"];

/** A Ticket's event lines once its merged attempt's tab-closed has landed: on Bun it follows the merge by 200 to
 * 400 ms, so a read straight after `merged` races it (NOT-PORTED.md, restart). */
async function eventLinesAfterTabClose(world: World, id: string): Promise<string[]> {
  return until(() => eventLines(world, id), (lines) => lines.includes("1 tab-closed"), { what: `${id}'s tab-closed` });
}

/** Commit one file in a worktree. */
function commitIn(worktree: string, file: string): void {
  writeFileSync(join(worktree, file), "work\n");
  gitIn(worktree, ["add", file]);
  gitIn(worktree, ["commit", "-qm", `add ${file}`]);
}

/** The adoption checkpoint's body for attempt `attempt` of a Ticket in `paneId`, word for word. */
function adoptionBody(attempt: number, paneId: string): string {
  return (
    `The engine restarted while this ticket's terminal-backed attempt ${attempt} was still running in herdr pane ` +
    `${paneId}. The pane proved live at boot, so the engine re-adopted the attempt and is waiting on the ` +
    "pane's exit; the attempt's real outcome will be recorded then. Answering this interrupt abandons the " +
    "attempt (the pane is closed) and re-runs the ticket."
  );
}

/** Write a Ticket's events file whole, one JSON line per event, as the engine appends them. */
function writeEvents(
  world: World,
  id: string,
  events: { attempt: number; kind: string; payload: Record<string, unknown> }[],
): void {
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(
    join(world.pool, "runs", `${id}.events.jsonl`),
    events.map((each) => `${JSON.stringify({ at, ...each })}\n`).join(""),
  );
}

/** A terminal-backed claude spawn's payload in a worktree, as the engine records one. */
function spawnedIn(world: World, worktree: string, branch: string, paneId: string, tabId: string): Record<string, unknown> {
  return {
    argv: ["claude", "--model", "m", "--permission-mode", "auto"],
    cwd: worktree,
    branch,
    commitSha: world.git(["rev-parse", "HEAD"]).trim(),
    env: { PWD: worktree },
    harness: "claude",
    model: "m",
    pane_id: paneId,
    tab_id: tabId,
  };
}

/** Make Ticket `id`'s pool worktree and branch, as the engine makes them for an Attempt. */
function makeWorktree(world: World, id: string): { path: string; branch: string } {
  const { path, branch } = ticketWorktree(world.repo, id);
  world.git(["worktree", "add", "-q", "-b", branch, path]);
  return { path, branch };
}

// engine/keep-talking.test.ts:539
restartCase("a Continued attempt live at the stop is re-adopted at boot, never taught again, and its Outcome ends the Ticket", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a", { body: BODY })], config: TERMINAL });
  world.stubs.script("01", pause());
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const first = await startLeg(t, world, 0, { herdr });
  const paneId = await untilHeld(first, "01");
  await keepTalking(first, herdr, paneId, join(world.pool, "runs", "01.outcome.json"));
  await first.stop();
  await herdr.settle();

  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });
  const adopted = await untilLive(second, "01", 2);
  expect(cardOf(adopted, "01").liveAttempt).toMatchObject({ attempt: 2, paneId });
  await untilLogged(second, `ticket 01: continued attempt 2 re-adopted from live pane ${paneId}; waiting on its Outcome`);
  const waiting = await settle(second, "the adoption checkpoint", quiescentWith("01:checkpoint"));
  expect(waiting.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: adoptionBody(2, paneId) }]);
  // The boot's reset note is taken back off: the file is as the stop left it.
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "in-progress")}\n\n${BODY}${BRIEF}\n`);

  writeOutcome(world, "01.outcome.json", { status: "done", summary: "after the restart", commitSha: null });
  const review = await settle(second, "01 done and the Review raised", quiescentWith("REVIEW:review"));
  expect(cardOf(review, "01")).toMatchObject({ status: "done", liveAttempt: null });
  expect(review.state.outcomes["01"]).toEqual({ status: "done", summary: "after the restart", commitSha: null });
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${BODY}${BRIEF}\n`);
  // Taught before the stop: nothing was typed into the pane since, and no tab opened.
  await herdr.settle();
  expect(callsOf(herdr, "pane.send_input", from)).toEqual([]);
  expect(callsOf(herdr, "tab.create", from)).toEqual([]);
  expect(eventsOf(world, "01", "exited").map((event) => [event.attempt, event.payload.status])).toEqual([
    [1, "checkpoint"],
    [2, "done"],
  ]);
}, { timeoutMs: 120_000 });

// engine/keep-talking.test.ts:768
restartCase("a verify Ticket's Continued attempt that ended done while no server ran is graded at boot and never re-run", async (t) => {
  const config: PoolConfig = { ...TERMINAL, assign: { "01": { verify: 1 } } };
  const world = t.world({ tickets: [ticket("01", "a", { body: BODY })], config });
  world.stubs.script("01.attempt-1", pause());
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const first = await startLeg(t, world, 0, { herdr });
  // The candidate is graded (the stub grader passes it) before its checkpoint is raised.
  const paneId = await untilHeld(first, "01");
  await keepTalking(first, herdr, paneId, join(world.pool, "runs", "01.attempt-2.outcome.json"));
  await first.stop();

  // While no server runs the Continued attempt ends done and its exit is
  // recorded, but no grade is: the state a stop between the two leaves.
  writeOutcome(world, "01.attempt-2.outcome.json", { status: "done", summary: "done before the stop", commitSha: null });
  appendFileSync(
    join(world.pool, "runs", "01.events.jsonl"),
    `${JSON.stringify({
      at: new Date().toISOString(),
      attempt: 2,
      kind: "exited",
      payload: { code: 0, status: "done", logTail: [], outcomeExists: true },
    })}\n`,
  );
  // And the TUI goes with its pane.
  await herdr.control("endPane", paneId);
  expect(await herdr.control<string[]>("listedPanes")).not.toContain(paneId);
  const spawnedBefore = eventsOf(world, "01", "spawned").map((event) => event.attempt);
  expect(spawnedBefore).toEqual([1, 2]);
  const second = await startLeg(t, world, 1, { herdr });

  const review = await settle(second, "01 graded, merged and done", quiescentWith("REVIEW:review"), 60_000);
  expect(cardOf(review, "01").status).toBe("done");
  expect(eventsOf(world, "01", "graded").map((event) => event.attempt)).toEqual([1, 2]);
  expect(eventsOf(world, "01", "merged").map((event) => event.attempt)).toEqual([2]);
  // No fresh fan-out: 01 never ran again.
  expect(eventsOf(world, "01", "spawned").map((event) => event.attempt)).toEqual(spawnedBefore);
}, { timeoutMs: 120_000 });

// engine/keep-talking.test.ts:832
restartCase(
  "a merge held at the pool checkout's gate is recorded at once, kept out across a restart, and redone once the Continued attempt ends",
  async (t) => {
    // What the first server boots on: 02's Attempt was launched into its
    // worktree by a server before, and its pane still runs there; 01 is
    // ready, so it runs alone, in the pool checkout.
    const world = t.world({
      tickets: [
        ticket("01", "a", { body: BODY }),
        ticket("02", "b", { status: "in-progress", body: "# 02\n\nWork on 02." }),
      ],
      config: TERMINAL,
    });
    const worktree = makeWorktree(world, "02");
    writeEvents(world, "02", [
      { attempt: 1, kind: "scheduled", payload: {} },
      { attempt: 1, kind: "spawned", payload: spawnedIn(world, worktree.path, worktree.branch, "p-02", "t-02") },
    ]);
    world.stubs.script("01", pause());
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    // In the Pool workspace the first boot will create (the fake's first, w1).
    await herdr.control("injectPane", "p-02", { tabId: "t-02", cwd: worktree.path, workspaceId: "w1" });
    const first = await startLeg(t, world, 0, { herdr });
    await untilLogged(first, "ticket 02: attempt 1 re-adopted from live pane p-02; waiting on its exit");
    const paneId = await untilHeld(first, "01");
    expect(eventsOf(world, "01", "spawned")[0]!.payload.cwd).toBe(world.repo);
    await keepTalking(first, herdr, paneId, join(world.pool, "runs", "01.outcome.json"));

    // 02 ends done with work on its branch while 01 talks in the checkout:
    // its merge meets the held gate, recorded at once with no drive running.
    commitIn(worktree.path, "held.txt");
    writeOutcome(world, "02.outcome.json", { status: "done", summary: "done", commitSha: null });
    await until(() => eventsOf(world, "02", "merge-deferred").length, (n) => n > 0, {
      what: "02's merge-deferred record",
      ms: 30_000,
    });
    expect(existsSync(join(world.repo, "held.txt"))).toBe(false);
    await first.stop();

    const second = await startLeg(t, world, 1, { herdr });
    await untilLive(second, "01", 2);
    await untilLogged(second, `ticket 01: continued attempt 2 re-adopted from live pane ${paneId}; waiting on its Outcome`);
    // The Continued attempt holds the checkout again: the redone merge waits.
    await untilLogged(second, "ticket 02: merge dropped at the last shutdown chained again");
    expect(cardOf(await snapshotOf(second), "02")).toMatchObject({ status: "done", mergeState: "queued" });
    expect(existsSync(join(world.repo, "held.txt"))).toBe(false);
    expect(eventsOf(world, "02", "merged")).toEqual([]);

    writeOutcome(world, "01.outcome.json", { status: "done", summary: "talked", commitSha: null });
    await until(() => existsSync(join(world.repo, "held.txt")), Boolean, { what: "the redone merge", ms: 30_000 });
    await until(() => eventsOf(world, "02", "merged").length, (n) => n === 1, { what: "02's merged record", ms: 30_000 });
    expect(await eventLinesAfterTabClose(world, "02")).toEqual(DEFERRED_TWICE);
    await settle(second, "both done and the Review raised", quiescentWith("REVIEW:review"));
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:889
restartCase(
  "a merge a stop dropped at the pool checkout's gate is redone after the restart once the Continued attempt ends",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a", { body: BODY })], config: TERMINAL });
    world.stubs.script("01", pause());
    // The Conversation talks on opencode, its stub held in its pane; the
    // Ticket it proposes runs on claude and commits its work.
    world.stubs.script("_opencode", { hold: 150 });
    world.stubs.script("conv-1-spawn-1", { work: { file: "side.txt", line: "side", message: "side work" } });
    const herdr = await t.herdr(world, { rendered: BOTH_READY });
    const first = await startLeg(t, world, 0, { herdr });
    const paneId = await untilHeld(first, "01");
    await keepTalking(first, herdr, paneId, join(world.pool, "runs", "01.outcome.json"));
    const started = await first.http.post("/api/conversations", { title: "Spawner", assign: { harness: "opencode" } });
    expect(started.status, started.text).toBe(201);
    writeFileSync(
      join(world.pool, "runs", "conv-1.spawn.json"),
      JSON.stringify({
        spawn: [
          {
            title: "Side ticket",
            body: "do a small side thing please, in its own worktree",
            assign: { harness: "claude" },
          },
        ],
      }),
    );
    // The proposed Ticket runs in its own worktree and ends done while 01
    // talks in the checkout: its merge waits at the gate.
    await until(() => eventsOf(world, "conv-1-spawn-1", "merge-deferred").length, (n) => n > 0, {
      what: "conv-1-spawn-1's merge-deferred record",
      ms: 60_000,
    });
    expect(String(eventsOf(world, "conv-1-spawn-1", "spawned")[0]!.payload.cwd)).not.toBe(world.repo);
    expect(existsSync(join(world.repo, "side.txt"))).toBe(false);
    await first.stop();

    const second = await startLeg(t, world, 1, { herdr });
    await untilLive(second, "01", 2);
    await untilLogged(second, "ticket conv-1-spawn-1: merge dropped at the last shutdown chained again");
    expect(cardOf(await snapshotOf(second), "conv-1-spawn-1")).toMatchObject({ status: "done", mergeState: "queued" });
    // Re-adopted, the Continued attempt still holds the checkout: the redone merge waits at the gate again.
    expect(existsSync(join(world.repo, "side.txt"))).toBe(false);
    expect(eventsOf(world, "conv-1-spawn-1", "merged")).toEqual([]);

    writeOutcome(world, "01.outcome.json", { status: "done", summary: "talked", commitSha: null });
    await until(() => eventsOf(world, "conv-1-spawn-1", "merged").length, (n) => n === 1, {
      what: "conv-1-spawn-1's redone merge",
      ms: 30_000,
    });
    expect(existsSync(join(world.repo, "side.txt"))).toBe(true);
    // Deferred once at the gate before the stop and once more by the redo.
    expect(await eventLinesAfterTabClose(world, "conv-1-spawn-1")).toEqual(DEFERRED_TWICE);
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:993
conformance("restart", "an Attempt re-adopted at boot in its worktree that ends done is merged onto the target", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { status: "in-progress", body: BODY })],
    config: TERMINAL,
  });
  const worktree = makeWorktree(world, "01");
  writeEvents(world, "01", [
    { attempt: 1, kind: "scheduled", payload: {} },
    { attempt: 1, kind: "spawned", payload: spawnedIn(world, worktree.path, worktree.branch, "p-01", "t-01") },
  ]);
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await herdr.control("injectPane", "p-01", { tabId: "t-01", cwd: worktree.path, workspaceId: "w1" });
  const server = await t.start(world, { herdr });

  await untilLogged(server, "ticket 01: attempt 1 re-adopted from live pane p-01; waiting on its exit");
  commitIn(worktree.path, "adopted.txt");
  writeOutcome(world, "01.outcome.json", { status: "done", summary: "finished after the restart", commitSha: null });

  const review = await settle(server, "01 merged and the Review raised", quiescentWith("REVIEW:review"));
  expect(cardOf(review, "01").status).toBe("done");
  expect(eventsOf(world, "01", "merged").map((event) => event.attempt)).toEqual([1]);
  expect(existsSync(join(world.repo, "adopted.txt"))).toBe(true);
  expect(world.git(["log", "-1", "--format=%s", "main", "--", "adopted.txt"]).trim()).toBe("add adopted.txt");
  expect((await poolLog(server)).some((line) => line.includes("attempt 1 re-adopted"))).toBe(true);
});
