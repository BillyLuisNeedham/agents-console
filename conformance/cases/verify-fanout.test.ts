/**
 * Verify without Jev, the fan-out (C21 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md): `verify: N` runs N
 * same-round Attempts on their own branches, and a round with a paused or
 * crashed Candidate stops at one Interrupt instead of selecting.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine } from "../harness/pool-files.ts";
import { approveReview, settleOn, statuses } from "../harness/pool-run.ts";
import {
  attemptBranch,
  attemptBranches,
  attemptCwd,
  DEFAULTS,
  inCheckout,
  kindsOf,
  ready,
  verifyConfig,
} from "./verify-common.ts";

conformance("verify", "a pool with no verify key runs each Ticket once, with no grader or head-to-head", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: DEFAULTS });
  const server = await t.start(world);

  const done = await approveReview(server);

  expect(done.phase).toBe("done");
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01"]);
  expect(Object.keys(statuses(done))).toEqual(["01"]);
  expect(existsSync(join(world.pool, "issues", "01-grader-1.md"))).toBe(false);
  expect(existsSync(join(world.pool, "issues", "01-head-to-head.md"))).toBe(false);
});

conformance("verify", "verify: 3 fans out three same-round attempts on their own branches from one HEAD", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(3) });
  const head = world.git(["rev-parse", "HEAD"]).trim();
  // A three-way rendezvous: each attempt waits for the next to start, so
  // a server that ran them one after another would time the wait out.
  const started = (n: number) => join(world.root, `started-${n}`);
  for (const n of [1, 2, 3]) {
    world.stubs.script(`01.attempt-${n}`, {
      touch: started(n),
      waitFor: started(n === 1 ? 3 : n - 1),
      work: { file: `cand-${n}.txt`, message: `cand-${n}` },
    });
  }
  const server = await t.start(world);

  const snap = await settleOn(server, "REVIEW", "review");

  expect(statuses(snap)).toEqual({
    "01": "done",
    "01-grader-1": "done",
    "01-grader-2": "done",
    "01-grader-3": "done",
    "01-head-to-head": "done",
  });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(snap.state.log.some((line) =>
    line.startsWith("ticket 01: verify fan-out complete: 3 attempts exited (3 done, 0 checkpoint, 0 crash)"),
  )).toBe(true);

  // Same-round launches start in any order: the three attempts, then the
  // three graders, then the head-to-head.
  const calls = world.stubs.calls();
  const keys = calls.map((call) => call.key);
  expect(keys).toHaveLength(7);
  expect(keys.slice(0, 3).sort()).toEqual(["01.attempt-1", "01.attempt-2", "01.attempt-3"]);
  expect(keys.slice(3, 6).sort()).toEqual(["01-grader-1", "01-grader-2", "01-grader-3"]);
  expect(keys[6]).toBe("01-head-to-head");
  for (const n of [1, 2, 3]) {
    const call = calls.find((c) => c.key === `01.attempt-${n}`)!;
    expect(call.outcome).toBe(join(world.pool, "runs", `01.attempt-${n}.outcome.json`));
    expect(call.head).toBe(head);
    expect(call.cwd).toBe(attemptCwd(world, "01", n));
    expect(call.branch).toBe(attemptBranch(world, "01", n));
    expect(call.branch).toMatch(new RegExp(`^pool/[^/]+/01\\.attempt-${n}$`));
    expect(JSON.parse(readFileSync(call.outcome, "utf8")).status).toBe("done");
  }

  // The default grades tie at 8 and the head-to-head names no winner, so
  // the earlier attempt wins: attempt 1 merges, every branch goes.
  const events = readEvents(world.pool, "01");
  for (const n of [1, 2, 3]) {
    expect(kindsOf(events, n)).toEqual(
      n === 1
        ? ["scheduled", "spawned", "exited", "graded", "selected", "merged"]
        : ["scheduled", "spawned", "exited", "graded"],
    );
    expect(inCheckout(world, `cand-${n}.txt`)).toBe(n === 1);
  }
  const lastScheduled = Math.max(...events.map((e, i) => (e.kind === "scheduled" ? i : -1)));
  expect(lastScheduled).toBeLessThan(events.findIndex((e) => e.kind === "spawned"));
  expect(attemptBranches(world)).toEqual([]);
});

conformance("verify", "verify: 1 marks the Ticket done on a passing grade and merges its attempt branch", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: verifyConfig(1) });
  world.stubs.script("01.attempt-1", { work: { file: "cand.txt", message: "cand" } });
  const server = await t.start(world);

  const done = await approveReview(server);

  expect(statuses(done)).toEqual({ "01": "done", "01-grader-1": "done" });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("done");
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01.attempt-1", "01-grader-1"]);
  expect(inCheckout(world, "cand.txt")).toBe(true);
  expect(done.state.outcomes["01"]?.summary).toBe("summary-01.attempt-1");
  expect(readEvents(world.pool, "01").map((e) => e.kind)).toEqual(["scheduled", "spawned", "exited", "graded", "merged"]);
  expect(attemptBranches(world)).toEqual([]);
});
