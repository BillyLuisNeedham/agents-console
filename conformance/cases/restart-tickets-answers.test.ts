/**
 * Queued answers across a stop and start, seen from outside the server
 * (ADR-0036). An answer is accepted first (its `answered` event, then its
 * record in runs/queued-answers.json) and processed after; a server that
 * goes down between the two leaves the record pending, and the next boot
 * drains it at its first boundary without anyone answering again. One that
 * goes down after the processing finds the answer already in the last
 * checkpoint. Ticket C05 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * What a kill between acceptance and processing leaves is written by hand
 * while no server runs, in the exact shapes acceptance writes: no server
 * can be stopped at that point from outside.
 */

import { expect } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedAnswer, TicketEvent } from "../../protocol/wire.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  CONFIG,
  ENGINE_RESET_NOTE,
  answer,
  approveReview,
  launchKeys,
  poolLog,
  quiescentWith,
  restartCase,
  settle,
  startLeg,
  ticket,
} from "./restart-support.ts";
import { inCheckout } from "./verify-common.ts";

/** runs/queued-answers.json as the store writes it. */
interface QueueFile {
  nextSeq: number;
  answers: QueuedAnswer[];
}

function queuePath(world: World): string {
  return join(world.pool, "runs", "queued-answers.json");
}

/** runs/queued-answers.json, parsed. */
function readQueue(world: World): QueueFile {
  return JSON.parse(readFileSync(queuePath(world), "utf8")) as QueueFile;
}

/**
 * An `answered` event appended as acceptance appends one: on the Ticket's
 * latest attempt, its payload the Interrupt's kind and any action.
 */
function appendAnswered(world: World, id: string, payload: Record<string, unknown>): void {
  const attempt = Math.max(0, ...readEvents(world.pool, id).map((event) => event.attempt));
  const event = { at: new Date().toISOString(), attempt, kind: "answered", payload };
  appendFileSync(join(world.pool, "runs", `${id}.events.jsonl`), `${JSON.stringify(event)}\n`);
}

/** A Ticket's events of one kind. */
function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** A Candidate that pauses at a checkpoint with `brief`. */
function paused(brief: string) {
  return { status: "checkpoint" as const, outcome: { summary: `paused: ${brief}`, commitSha: null }, brief };
}

/** Whether a process is still there to signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stub `run` script that waits for `path`, up to two minutes or until the world is deleted. */
function waitScript(path: string): string {
  return [
    "for _ in $(seq 1 2400); do",
    `  [ -e ${JSON.stringify(path)} ] && break`,
    '  [ -d "$CONFORMANCE_STUBS" ] || exit 0',
    "  sleep 0.05",
    "done",
  ].join("\n");
}

// engine/engine.test.ts:1357
restartCase("a queued Adopt and a queue record from before Adopt are read back at boot, and each takes effect", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a"), ticket("02", "b")],
    config: { ...CONFIG, assign: { "02": { verify: 2 } } },
  });
  world.stubs.launches("01", [{ status: "checkpoint", brief: "which way?" }, { status: "done" }]);
  world.stubs.script("02.attempt-1", paused("Which port?"));
  world.stubs.script("02.attempt-2", { work: { file: "cand-2.txt", message: "cand-2" } });
  world.stubs.script("02-grader-2", { grade: { score: 7, verdict: "pass", reasons: "tidy" } });
  const first = await startLeg(t, world, 0);
  const stopped = await settle(first, "01's lone checkpoint and 02's paused round", quiescentWith("01:checkpoint", "02:checkpoint"));
  expect(stopped.state.interrupts.find((i) => i.ticketId === "02")?.candidates).toEqual([2]);
  await first.stop();

  // Both answers accepted and neither processed when the server went down:
  // 01's in the shape a server from before Adopt wrote, with no action
  // field, and an Adopt of 02's finished Candidate.
  const before = {
    seq: 1,
    ticketId: "01",
    kind: "checkpoint",
    note: "carry on",
    at: "2026-10-01T00:00:00.000Z",
    processedAt: null,
  };
  const adopt = {
    seq: 2,
    ticketId: "02",
    kind: "checkpoint",
    action: "adopt",
    attempt: 2,
    note: "the tidy one",
    at: "2026-10-01T00:00:01.000Z",
    processedAt: null,
  };
  appendAnswered(world, "01", { kind: "checkpoint" });
  appendAnswered(world, "02", { kind: "checkpoint", action: "adopt", attempt: 2, note: "the tidy one" });
  writeFileSync(queuePath(world), JSON.stringify({ nextSeq: 3, answers: [before, adopt] }));
  const launched = launchKeys(world);

  const second = await startLeg(t, world, 1);
  await settle(second, "both answers drained and the Review raised", quiescentWith("REVIEW:review"));
  // Read before the Review is approved, which queues an answer of its own.
  const drained = readQueue(world);
  await approveReview(second);

  // 01 was resumed and ran again; 02's Candidate 2 merged as the Winner,
  // nothing of 02 running again.
  expect(launchKeys(world).slice(launched.length)).toEqual(["01"]);
  expect(readTicketFile(world.pool, "01-a.md")).toEndWith("\n## Resume note\n\ncarry on\n");
  expect(readStateLine(world.pool, "02-b.md").status).toBe("done");
  expect(eventsOf(world, "02", "selected").map((e) => [e.attempt, e.payload])).toEqual([
    [2, { score: 7, margin: null, rule: "human" }],
  ]);
  expect(eventsOf(world, "02", "merged").map((e) => e.attempt)).toEqual([2]);
  expect(inCheckout(world, "cand-2.txt")).toBe(true);
  // Each record processed and otherwise as it was: the old one gains no
  // action, and the Adopt keeps its Candidate. No answer was given twice.
  expectParsedEqual(drained, {
    nextSeq: 3,
    answers: [
      { ...before, processedAt: anyIsoTime() },
      { ...adopt, processedAt: anyIsoTime() },
    ],
  }, "runs/queued-answers.json");
  expect(eventsOf(world, "01", "answered")).toHaveLength(1);
  expect(eventsOf(world, "02", "answered")).toHaveLength(1);
});

// engine/engine.test.ts:12502
restartCase("a Queued answer a killed server left unprocessed is drained after the next boot, with no answer given again", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  world.stubs.launches("01", [{ status: "checkpoint" }, { status: "done" }]);
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await first.stop();
  const checkpointed = readTicketFile(world.pool, "01-a.md");

  // Acceptance's own writes, in its order, with the Interrupt still pending
  // in the last checkpoint: the answered event, then the queued record.
  appendAnswered(world, "01", { kind: "checkpoint" });
  const record = { ticketId: "01", kind: "checkpoint", note: "the name is Foo", at: new Date().toISOString(), seq: 1, processedAt: null };
  writeFileSync(queuePath(world), JSON.stringify({ nextSeq: 2, answers: [record] }, null, 2));

  const second = await startLeg(t, world, 1);
  await settle(second, "01 and 02 run to the Review", quiescentWith("REVIEW:review"));

  expect(launchKeys(world)).toEqual(["01", "01", "02"]);
  expectParsedEqual(readQueue(world), { nextSeq: 2, answers: [{ ...record, processedAt: anyIsoTime() }] }, "runs/queued-answers.json");
  expect(eventsOf(world, "01", "answered")).toHaveLength(1);
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    checkpointed.replace("status=checkpoint", "status=done") + "\n## Resume note\n\nthe name is Foo\n",
    "issues/01-a.md",
  );
  expect(await poolLog(second)).toContain("interrupt answered for 01 (checkpoint): resumed");
});

// engine/engine.test.ts:12561
restartCase("an answer processed before a SIGKILL is still answered at the next boot, and the run goes on to its Review", async (t) => {
  const world = t.world({
    tickets: [ticket("01", "a", { body: "# 01\n\n## Brief\n\npick a name" }), ticket("02", "b", { blockedBy: "01" })],
    config: CONFIG,
  });
  const release = join(world.root, "release-01");
  // The resumed attempt holds its super-step open, so the kill lands after
  // the answer is processed and before the next boundary.
  world.stubs.launches("01", [
    { status: "checkpoint", brief: "pick a name" },
    { status: "keep", run: waitScript(release) },
    { status: "done" },
  ]);
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await answer(first, { ticketId: "01", note: "the name is Foo" });
  await until(
    () => ({ processed: readQueue(world).answers[0]?.processedAt ?? null, launches: launchKeys(world) }),
    (seen) => seen.processed !== null && seen.launches.length === 2,
    { what: "the answer processed and 01 launched again", ms: 30_000 },
  );
  const answeredBody = readTicketFile(world.pool, "01-a.md");
  await first.kill();

  // The killed server's resumed attempt is nobody's now: let it go, and
  // boot only once it is gone, so the next server finds no agent alive.
  writeFileSync(release, "go");
  const pid = readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 2)?.payload.pid;
  if (typeof pid !== "number") throw new Error("01's attempt 2 recorded no pid");
  await until(() => alive(pid), (live) => !live, { what: `01's attempt 2 (pid ${pid}) to exit`, ms: 30_000 });

  const second = await startLeg(t, world, 1);
  await settle(second, "01 and 02 run to the Review", quiescentWith("REVIEW:review"));

  // The answer was in the last checkpoint already: its log line came back
  // with it, and nothing asked for it again.
  expect(await poolLog(second)).toContain("interrupt answered for 01 (checkpoint): resumed");
  expect(launchKeys(world)).toEqual(["01", "01", "01", "02"]);
  expectParsedEqual(
    readQueue(world),
    {
      nextSeq: 2,
      answers: [{ seq: 1, ticketId: "01", kind: "checkpoint", note: "the name is Foo", at: anyIsoTime(), processedAt: anyIsoTime() }],
    },
    "runs/queued-answers.json",
  );
  expect(eventsOf(world, "01", "answered")).toHaveLength(1);
  // The resumed attempt died with the server, so the boot put 01 back to
  // ready with the engine's note, after the Resume note.
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    answeredBody.replace("status=in-progress", "status=done") + ENGINE_RESET_NOTE,
    "issues/01-a.md",
  );
  expect(answeredBody).toEndWith("\n## Resume note\n\nthe name is Foo\n");
});

// Gap: engine/queued-answers.ts:61. A queue file torn mid-write starts the
// queue empty rather than taking the pool down.
restartCase("a torn runs/queued-answers.json starts the queue empty at boot, and the next answer writes it afresh", async (t) => {
  const world = t.world({ tickets: [ticket("01", "a")], config: CONFIG });
  world.stubs.launches("01", [{ status: "checkpoint", brief: "which way?" }, { status: "done" }]);
  const first = await startLeg(t, world, 0);
  await settle(first, "01's checkpoint", quiescentWith("01:checkpoint"));
  await first.stop();

  writeFileSync(queuePath(world), '{"nextSeq": 3, "answers": [');
  const second = await startLeg(t, world, 1);
  const booted = await settle(second, "01's checkpoint after the boot", quiescentWith("01:checkpoint"));
  expect(booted.state.queuedAnswers).toEqual([]);

  await answer(second, { ticketId: "01", note: "carry on" });
  const queue = await until(() => readQueue(world), (file) => file.answers[0]?.processedAt != null, {
    what: "the answer processed",
    ms: 30_000,
  });
  expectParsedEqual(
    queue,
    { nextSeq: 2, answers: [{ seq: 1, ticketId: "01", kind: "checkpoint", note: "carry on", at: anyIsoTime(), processedAt: anyIsoTime() }] },
    "runs/queued-answers.json",
  );
  await approveReview(second);
  expect(launchKeys(world)).toEqual(["01", "01"]);
});
