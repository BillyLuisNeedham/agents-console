/**
 * How a headless Attempt's ending is read, seen from outside the server
 * (ADR-0036): the child's exit, then its Outcome; the exited and crash
 * events and the crash Interrupt that record it; the pool log line beside
 * them; and the subject a crash reason names, a resolver's included.
 *
 * Ticket C13 of the Rust port inventory (docs/research/rust-port/
 * test-inventory.md, area `attempts`); each case names the rows it covers.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { anyIsoTime, expectJsonlEqual } from "../harness/equal.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  conflictWorld,
  crashBody,
  eventsOf,
  expectedCrashBody,
  HEADLESS,
  lines,
  poolLog,
  printLines,
  readRuns,
  ready,
  SAMPLE,
  snapshot,
  waitForEvent,
  waitForExit,
} from "./attempts-endings-support.ts";

/** The spawned event of a lone Ticket's headless claude launch, run in the checkout. */
function spawnedInCheckout(world: World): Record<string, unknown> {
  return {
    at: anyIsoTime(),
    attempt: 1,
    kind: "spawned",
    payload: expect.objectContaining({ cwd: world.repo, branch: null, harness: "claude", model: "m", pid: expect.any(Number) }),
  };
}

// attempt-ending.test.ts:318 waitForAttemptEnding with a headless watch › ends on the child's exit and reads the result after
conformance("attempts", "a headless Attempt that writes a done Outcome and exits 0 ends done, with no crash", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  await t.start(world);

  await waitForExit(world, "01");
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    spawnedInCheckout(world),
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
  ], "runs/01.events.jsonl");
  await until(() => readStateLine(world.pool, "01-t.md"), (line) => line.status === "done", { what: "01 done" });
});

// attempt-ending.test.ts:335 waitForAttemptEnding with a headless watch › carries the child's own code and names the harness on a crash
// attempt-ending.test.ts:429 exitCrashReason › names the harness and its code for a real exit
conformance("attempts", "a headless Attempt that exits 3 with no Outcome is a crash naming the harness and its code", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  world.stubs.script("01", { outcome: null, exitCode: 3 });
  const server = await t.start(world);

  await waitForEvent(world, "01", "crash");
  const reason = "harness exited 3";
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    spawnedInCheckout(world),
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 3, status: "in-progress", logTail: [], outcomeExists: false } },
    { at: anyIsoTime(), attempt: 1, kind: "crash", payload: { code: 3, reason, logTail: [], outcomeExists: false } },
  ], "runs/01.events.jsonl");
  const body = await crashBody(server, "01");
  expect(body.startsWith("crash: harness exited 3\n")).toBe(true);
  expect(body).toBe(expectedCrashBody(world, "01", reason, [], false));
  expect(readStateLine(world.pool, "01-t.md").status).toBe("in-progress");
});

// attempt-ending.test.ts:349 waitForAttemptEnding with a headless watch › reads a clean exit with no result as the missing-outcome crash
conformance("attempts", "a headless Attempt that exits 0 with no Outcome is the missing-outcome crash", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  world.stubs.script("01", { outcome: null, stdout: "worked a while\n" });
  const server = await t.start(world);

  await waitForEvent(world, "01", "crash");
  const reason = "no outcome written";
  const tail = ["worked a while"];
  expect(eventsOf(world, "01", "exited")[0]!.payload).toEqual({ code: 0, status: "in-progress", logTail: tail, outcomeExists: false });
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({ code: 0, reason, logTail: tail, outcomeExists: false });
  expect(await crashBody(server, "01")).toBe(expectedCrashBody(world, "01", reason, tail, false));
});

// attempt-ending.test.ts:474 exitedPhrase › reads as the shell's own status for a real exit
conformance("attempts", "the pool log gives a real exit as the shell's status beside the marker and the crash", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: HEADLESS });
  world.stubs.script("01", { outcome: null, exitCode: 3 });
  const server = await t.start(world);

  await waitForEvent(world, "01", "crash");
  await waitForExit(world, "02");
  const log = await until(
    () => poolLog(server),
    (got) => got.some((line) => line.startsWith("ticket 02: exited")),
    { what: "02's ending in the pool log" },
  );
  expect(log).toContain("ticket 01: exited 3, marker in-progress, crash: harness exited 3");
  expect(log).toContain("ticket 02: exited 0, marker done");
});

// attempt-ending.test.ts:435 exitCrashReason › carries the subject through, so a resolver reads as one
conformance("attempts", "a resolver that exits 2 is the subject of its crash, and its log and Stream file are kept", async (t) => {
  const world = conflictWorld(t, `${printLines(SAMPLE.raw)}; exit 2`);
  const server = await t.start(world);

  const snap = await until(
    () => snapshot(server),
    (s) => s.state.interrupts.some((i) => i.ticketId === "01" && i.kind === "merge-conflict"),
    { ms: 40_000, what: "01's merge-conflict Interrupt" },
  );
  const body = snap.state.interrupts.find((i) => i.ticketId === "01")!.body;
  expect(body.endsWith("\nThe resolver agent attempted: resolver exited 2")).toBe(true);
  expect(readRuns(world, "01.resolver.stream.jsonl")).toBe(lines(...SAMPLE.raw));
  expect(readRuns(world, "01.resolver.log")).toBe(lines(...SAMPLE.derived));
  // A resolver run records its spawn and nothing after it.
  expect(readEvents(world.pool, "01").filter((e) => e.attempt === 2).map((e) => e.kind)).toEqual(["resolver", "spawned"]);
});
