/**
 * Verify rounds across a stop and start, seen from outside the server
 * (ADR-0036): a paused round's Candidates, a human selection Interrupt and a
 * grader's complaint all come back at the next boot and stay answerable,
 * and a grader Ticket an earlier run left on disk resolves from its build
 * Ticket's Assignment at boot. Ticket C05 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over.
 *
 * A round that stops at an Interrupt and resumes with nothing changed
 * between servers runs on the takeover harness (harness/takeover.ts), so it
 * is also matched against the same round run uninterrupted. Every Attempt,
 * grader and judge is the claude stub on PATH, and no server holds a
 * TypeSafe key, so grading goes through grader Tickets.
 */

import { expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine } from "../harness/pool-files.ts";
import { takeover } from "../harness/takeover.ts";
import type { World } from "../harness/world.ts";
import {
  answer,
  approveReview,
  quiescentWith,
  restartCase,
  settle,
  startLeg,
  statusesOf,
} from "./restart-support.ts";
import { inCheckout, ready, verifyConfig } from "./verify-common.ts";

/** A Candidate that pauses at a checkpoint with `brief`. */
function paused(brief: string) {
  return { status: "checkpoint" as const, outcome: { summary: `paused: ${brief}`, commitSha: null }, brief };
}

/** A passing grade a grader stub writes. */
function grade(score: number, reasons = `scored ${score}`) {
  return { grade: { score, verdict: "pass" as const, reasons } };
}

/** Each attempt of a Ticket's events of one kind, with its payload. */
function eventsOf(world: World, id: string, kind: string): [number, TicketEvent["payload"]][] {
  return readEvents(world.pool, id)
    .filter((event) => event.kind === kind)
    .map((event) => [event.attempt, event.payload]);
}

/**
 * A stub `run` script that waits, up to a minute, until Ticket 01's events
 * hold attempt `attempt`'s event of `kind`. The Candidates of one round run
 * side by side, and so do their graders, so the order their events land in
 * is a race; a takeover case compares that order with an uninterrupted
 * run's, so each waits for the one before it: the first Candidate for the
 * second's spawn, the second for the first's exit, the second grader for
 * the first's grade.
 */
function after(world: World, kind: string, attempt: number): string {
  const events = JSON.stringify(join(world.pool, "runs", "01.events.jsonl"));
  return [
    "for _ in $(seq 1 1200); do",
    `  grep '"kind":"${kind}"' ${events} 2>/dev/null | grep -q '"attempt":${attempt}[,}]' && break`,
    "  sleep 0.05",
    "done",
  ].join("\n");
}

/** The value after `flag` in an argv. */
function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
}

// engine/engine.test.ts:1327
takeover(
  "restart",
  "a paused verify round keeps its Candidates across each takeover, and Adopt takes one with the grade read back from the log",
  {
    world: { tickets: [ready("01")], config: verifyConfig(2) },
    prepare(world) {
      world.stubs.script("01.attempt-1", { ...paused("Which port?"), run: after(world, "spawned", 2) });
      world.stubs.script("01.attempt-2", {
        run: after(world, "exited", 1),
        work: { file: "cand-2.txt", message: "cand-2" },
      });
      world.stubs.script("01-grader-2", { grade: { score: 7, verdict: "pass", reasons: "fine" } });
    },
    // Nothing to drive: the round pauses on its own, and stopPoint waits for it.
    async reach() {},
    async stopPoint(leg) {
      // A boot launches nothing for a paused round: the takeover's own
      // comparison holds every later stop point to the launches the first
      // server made.
      const snapshot = await settle(leg.server, "the paused round's checkpoint", quiescentWith("01:checkpoint"));
      expect(snapshot.state.interrupts.map((i) => [i.kind, i.candidates])).toEqual([["checkpoint", [2]]]);
    },
    async finish(leg) {
      const launched = leg.world.stubs.calls().length;
      await answer(leg.server, { ticketId: "01", action: "adopt", attempt: 2 });
      await approveReview(leg.server);

      // The grade is the one attempt 2's grader gave before the stop, read
      // back from the Ticket's log on a server that never saw it graded.
      expect(eventsOf(leg.world, "01", "selected")).toEqual([[2, { score: 7, margin: null, rule: "human" }]]);
      expect(eventsOf(leg.world, "01", "merged").map(([attempt]) => attempt)).toEqual([2]);
      expect(inCheckout(leg.world, "cand-2.txt")).toBe(true);
      expect(readStateLine(leg.world.pool, "01-t.md").status).toBe("done");
      expect(leg.world.stubs.calls()).toHaveLength(launched);
    },
  },
  { timeoutMs: 180_000 },
);

// engine/engine.test.ts:2139
conformance("restart", "a grader Ticket an earlier run left on disk resolves from its build Ticket's Assignment at boot", async (t) => {
  const world = t.world({
    tickets: [
      ready("01"),
      // Left by a previous run: the round's fan-out writes it again.
      { file: "01-grader-1.md", content: "<!-- state: id=01-grader-1 blocked-by=01 status=ready -->\n\n# 01-grader-1\n" },
    ],
    // No pool defaults: only the build Ticket's own entry names a harness.
    config: { assign: { "01": { verify: 2, harness: "claude", model: "build-model" } } },
  });
  const server = await t.start(world);

  // No config Interrupt: the run rests at its Review alone. Both graders
  // pass at 8, the head-to-head names no pick, and the earlier attempt wins.
  const rested = await settle(server, "the run to rest at an Interrupt", (s) => s.state.interrupts.length > 0);
  expect(rested.state.interrupts.map((i) => `${i.ticketId}:${i.kind}`)).toEqual(["REVIEW:review"]);
  const done = await approveReview(server);
  expect(statusesOf(done)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-head-to-head": "done",
  });
  for (const key of ["01-grader-1", "01-grader-2"]) {
    const launches = world.stubs.calls().filter((call) => call.key === key);
    expect(launches.map((call) => [call.harness, flagValue(call.argv, "--model")])).toEqual([["claude", "build-model"]]);
  }
});

// engine/engine.test.ts:2231
restartCase("a grader's complaint is raised again from the Ticket file's Brief when console.db is gone at the next boot", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01-grader-1", { grade: { score: 2, verdict: "flag", reasons: "work is incomplete" } });
  const first = await startLeg(t, world, 0);
  const flagged = await settle(first, "the complaint's checkpoint", quiescentWith("01:checkpoint"));
  expect(flagged.state.interrupts[0]!.body).toContain("work is incomplete");
  await first.stop();

  // Killed before the boundary write, say: the state line and the Brief the
  // engine wrote into the Ticket file are all there is.
  rmSync(join(world.pool, "console.db"), { force: true });
  const launched = world.stubs.calls().length;
  const second = await startLeg(t, world, 1);

  const raised = await settle(second, "the checkpoint raised again", quiescentWith("01:checkpoint"));
  expect(raised.state.interrupts).toEqual(flagged.state.interrupts);
  expect(statusesOf(raised)["01"]).toBe("checkpoint");
  expect(world.stubs.calls()).toHaveLength(launched);
});

// engine/engine.test.ts:3354
takeover("restart", "a human selection Interrupt is kept pending and answerable across each takeover", {
  world: { tickets: [ready("01")], config: verifyConfig(2, { selection: "human" }) },
  prepare(world) {
    world.stubs.script("01.attempt-1", { run: after(world, "spawned", 2), work: { file: "cand-1.txt", message: "cand-1" } });
    world.stubs.script("01.attempt-2", { run: after(world, "exited", 1), work: { file: "cand-2.txt", message: "cand-2" } });
    world.stubs.script("01-grader-1", grade(9));
    world.stubs.script("01-grader-2", { run: after(world, "graded", 1), ...grade(8) });
  },
  // Nothing to drive: the round raises its selection on its own.
  async reach() {},
  async stopPoint(leg) {
    // The same Interrupt, body and all, at every stop point, and no launch
    // since the first server's: the takeover's comparison holds both.
    const snapshot = await settle(leg.server, "the selection Interrupt", quiescentWith("01:selection"));
    expect(statusesOf(snapshot)["01"]).toBe("in-progress");
  },
  async finish(leg) {
    const launched = leg.world.stubs.calls().length;
    await answer(leg.server, { ticketId: "01", note: "1" });
    await approveReview(leg.server);

    expect(eventsOf(leg.world, "01", "selected")).toEqual([[1, { score: null, margin: null, rule: "human" }]]);
    expect(eventsOf(leg.world, "01", "merged").map(([attempt]) => attempt)).toEqual([1]);
    expect(inCheckout(leg.world, "cand-1.txt")).toBe(true);
    expect(inCheckout(leg.world, "cand-2.txt")).toBe(false);
    expect(leg.world.stubs.calls()).toHaveLength(launched);
  },
}, { timeoutMs: 180_000 });
