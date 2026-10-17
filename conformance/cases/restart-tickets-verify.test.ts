import { expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import { takeover } from "../harness/takeover.ts";
import type { World } from "../harness/world.ts";
import {
  answer,
  approveReview,
  poolLog,
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
      world.stubs.script("01-grader-2", { run: after(world, "graded", 1), grade: { score: 7, verdict: "pass", reasons: "fine" } });
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

  rmSync(join(world.pool, "console.db"), { force: true });
  const launched = world.stubs.calls().length;
  const second = await startLeg(t, world, 1);

  const raised = await settle(second, "the checkpoint raised again", quiescentWith("01:checkpoint"));
  expect(raised.state.interrupts).toEqual(flagged.state.interrupts);
  expect(statusesOf(raised)["01"]).toBe("checkpoint");
  expect(world.stubs.calls()).toHaveLength(launched);
});

restartCase("a round stopped after every Candidate exited is graded once at the next boot, not fanned out again", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(2) });
  world.stubs.script("01.attempt-1", { work: { file: "cand-1.txt", message: "cand-1" } });
  world.stubs.script("01.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  const graders = ["01-grader-1", "01-grader-2"].map((key) => world.stubs.hold(key, grade(8)));
  const first = await startLeg(t, world, 0);
  await until(
    () => world.stubs.calls().map((call) => call.key),
    (keys) => keys.includes("01-grader-1") && keys.includes("01-grader-2"),
    { what: "both graders launched", ms: 30_000 },
  );
  expect(eventsOf(world, "01", "exited").map(([attempt]) => attempt).sort()).toEqual([1, 2]);
  await first.stop();
  const before = world.stubs.calls().length;
  const scheduled = eventsOf(world, "01", "scheduled");
  expect(scheduled.map(([attempt]) => attempt).sort()).toEqual([1, 2]);

  const second = await startLeg(t, world, 1);
  for (const held of graders) await held.release(30_000);
  await approveReview(second);

  expect(await poolLog(second)).toContain(
    "ticket 01: every candidate of its verify round ended before a restart; the round is graded, not fanned out again",
  );
  const rerun = world.stubs.calls().slice(before).map((call) => call.key);
  expect(rerun.filter((key) => key.startsWith("01.attempt-"))).toEqual([]);
  expect(rerun.filter((key) => key.includes("-grader-")).sort()).toEqual(["01-grader-1", "01-grader-2"]);
  expect(eventsOf(world, "01", "scheduled")).toEqual(scheduled);
  expect(eventsOf(world, "01", "graded").map(([attempt]) => attempt).sort()).toEqual([1, 2]);
  expect(eventsOf(world, "01", "merged").map(([attempt]) => attempt)).toEqual([1]);
  expect(inCheckout(world, "cand-1.txt")).toBe(true);
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
}, { timeoutMs: 120_000 });

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
