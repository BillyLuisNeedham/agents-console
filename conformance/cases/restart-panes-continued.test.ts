import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { gitIn, ticketWorktree } from "../harness/git-pool.ts";
import { callsOf, CLAUDE_READY, type HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readTicketFile, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  TERMINAL,
  poolLog,
  quiescentWith,
  restartCase,
  settle,
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

function cardOf(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const card = snapshot.state.tickets.find((each) => each.id === id);
  if (!card) throw new Error(`no Ticket ${id} in the snapshot`);
  return card;
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
