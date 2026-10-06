/**
 * Close (issue #154), seen from outside the server (ADR-0036): a Ticket at
 * a checkpoint, merge-conflict or deadlock Interrupt answered with
 * POST /api/resume `action: close` is dropped where it stands. Its state
 * line reads closed, a note lands under its own heading, its branches and
 * worktrees go unmerged (what an agent wrote into the worktree copy of the
 * Ticket file is kept), a lone Ticket's commits in the pool checkout stay,
 * its engine-written judges close with it, and every dependent gets a
 * deadlock Interrupt naming it. A closed Ticket counts as finished for the
 * Review and never comes back on a reject. Ticket C08 of the inventory's
 * split (docs/research/rust-port/test-inventory.md): each case names the
 * engine test it carries over.
 *
 * The pool is a git checkout with the pool at `.scratch/pool`, ignored by
 * git: two Tickets ready together run in worktrees of their own, a lone one
 * runs in the checkout itself. A worktree gets a copy of its Ticket file at
 * the same path under it, `.scratch/pool/issues/<file>`.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PushedSnapshot } from "../../protocol/protocol.ts";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes } from "../harness/equal.ts";
import { gitIn, ticketWorktree } from "../harness/git-pool.ts";
import { answer, approveReview, resume, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { attemptBranch, attemptCwd, branchExists } from "./verify-common.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
const NO_RESOLVER = { ...CONFIG, resolver: "none" } satisfies PoolConfig;
const REVIEW = "REVIEW";

const marker = (id: string, blockedBy = "none", status = "ready"): string =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=${status} -->`;

/** A Ticket `<id>-t.md`, with an optional body. */
function ticket(id: string, options: { blockedBy?: string; status?: string; body?: string } = {}): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: marker(id, options.blockedBy, options.status),
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

/** Every launch's key, in launch order. */
const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);
const pending = (s: EnrichedSnapshot): [string, string][] => s.state.interrupts.map((i) => [i.ticketId, i.kind]);
const interrupted = (s: EnrichedSnapshot, id: string, kind: string): boolean =>
  s.state.interrupts.some((i) => i.ticketId === id && i.kind === kind);

/** The Brief the engine lands for a checkpoint that wrote none (engine/engine.ts). */
const PLACEHOLDER =
  "The agent signalled a checkpoint but wrote no brief, so what the attempt completed is only in the " +
  "ticket log. Answer the interrupt to point the next attempt.";

/** Bash for a stub that writes `file` in its working directory and commits it as `message`. */
function commitFile(file: string, content: string, message: string): string {
  return [
    `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(file)}`,
    `git add ${JSON.stringify(file)}`,
    `git commit -qm ${JSON.stringify(message)}`,
  ].join("\n");
}

/** Whether the working branch's history has a commit with this subject. */
const onMain = (world: World, subject: string): boolean =>
  gitIn(world.repo, ["log", "--format=%s"]).split("\n").includes(subject);

/** The run resting with `id` at an Interrupt of `kind`. */
const untilInterrupt = (server: CaseServer, id: string, kind: string): Promise<EnrichedSnapshot> =>
  settle(server, (s) => interrupted(s, id, kind), { what: `a ${kind} Interrupt on ${id}` });

/** The pool log line a Close of `id` at an Interrupt of `kind` writes, up to its account of the work. */
const closedLine = (id: string, kind: string): string => `interrupt answered for ${id} (${kind}): closed; `;

/** Close a Ticket through POST /api/resume, which must be accepted. */
function close(server: CaseServer, ticketId: string, note?: string): Promise<void> {
  return answer(server, { ticketId, action: "close", ...(note !== undefined ? { note } : {}) });
}

/** Every version a socket was pushed, in order, each its whole snapshot. */
function pushedVersions(socket: SocketClient): EnrichedSnapshot[] {
  const versions: EnrichedSnapshot[] = [];
  let held: PushedSnapshot | null = null;
  for (const frame of socket.frames) {
    if (frame.type === "snapshot") {
      held = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && held !== null) {
      held = applySnapshotDelta(held, frame.delta);
    } else {
      continue;
    }
    if (held !== null) versions.push(held.snapshot);
  }
  return versions;
}

// engine/engine.test.ts:13495
conformance(
  "interrupts",
  "a checkpointed Ticket closed with a note is discarded unmerged, keeps its agent's notes, and the Review counts it closed",
  async (t) => {
    const body = "# 01\n\nthe task\n\n## Notes\n\nnone yet\n\n## Done when\n\nit is done";
    const world = t.world({ tickets: [ticket("01", { body }), ticket("02")], config: CONFIG });
    // 01 commits work in its worktree and notes something in the worktree's
    // copy of its Ticket file, then checkpoints.
    world.stubs.script("01", {
      status: "checkpoint",
      run: [
        commitFile("one.txt", "one", "work-01"),
        "copy=.scratch/pool/issues/01-t.md",
        `sed "s/^none yet$/the agent's own note/" "$copy" > "$copy.new"`,
        'mv "$copy.new" "$copy"',
      ].join("\n"),
    });
    world.stubs.script("02", { run: commitFile("two.txt", "two", "work-02") });
    const server = await t.start(world);
    const held = await untilInterrupt(server, "01", "checkpoint");
    expect(pending(held)).toEqual([["01", "checkpoint"]]);
    const { path, branch } = ticketWorktree(world.repo, "01");
    expect(existsSync(path)).toBe(true);

    await close(server, "01", "the direction changed");
    const review = await untilInterrupt(server, REVIEW, "review");

    expect(statuses(review)).toEqual({ "01": "closed", "02": "done" });
    expectSameBytes(
      readTicketFile(world.pool, "01-t.md"),
      `${marker("01", "none", "closed")}\n\n# 01\n\nthe task\n\n## Notes\n\nthe agent's own note\n\n## Done when\n\nit is done\n\n` +
        `---\n\n## Brief, written by the engine\n\n${PLACEHOLDER}\n\n## Close note\n\nthe direction changed\n`,
      "issues/01-t.md",
    );
    expectParsedEqual(
      readEvents(world.pool, "01").find((e) => e.kind === "answered"),
      { at: anyIsoTime(), attempt: 1, kind: "answered", payload: { kind: "checkpoint", action: "close", note: "the direction changed" } },
      "01's answered event",
    );
    expect(branchExists(world, branch)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(world.repo, "one.txt"))).toBe(false);
    expect(onMain(world, "work-01")).toBe(false);
    expect(onMain(world, "work-02")).toBe(true);
    expect(review.state.log).toContain(`${closedLine("01", "checkpoint")}discarded ${branch} unmerged, with its worktree`);
    expect(review.state.interrupts).toEqual([
      {
        ticketId: REVIEW,
        kind: "review",
        body:
          "every ticket is done or closed.\n- 01: closed without merging\n- 02: summary-02\n" +
          "approve to end the run, or reject with a note naming the tickets to send back; " +
          "their downstream tickets return to ready with them.",
      },
    ]);

    const done = await approveReview(server);
    expect(done.state.log.at(-1)).toBe("pool done: every ticket reached done or was closed (01 closed)");
  },
);

// engine/engine.test.ts:13548
conformance(
  "interrupts",
  "a lone verify Attempt closed at the checkpoint its flagged grade raised is discarded, and its grader stays done",
  async (t) => {
    const world = t.world({ tickets: [ticket("01")], config: { ...CONFIG, assign: { "01": { verify: 1 } } } });
    world.stubs.script("01.attempt-1", { run: commitFile("a.txt", "a", "work-a") });
    world.stubs.script("01-grader-1", { grade: { score: 2, verdict: "flag", reasons: "off target" } });
    const server = await t.start(world);
    await untilInterrupt(server, "01", "checkpoint");
    const branch = attemptBranch(world, "01", 1);
    const path = attemptCwd(world, "01", 1);
    expect(branchExists(world, branch)).toBe(true);

    await close(server, "01");
    const review = await untilInterrupt(server, REVIEW, "review");

    expect(branchExists(world, branch)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(world.repo, "a.txt"))).toBe(false);
    expect(onMain(world, "work-a")).toBe(false);
    expect(review.state.log).toContain(`${closedLine("01", "checkpoint")}discarded ${branch} unmerged, with its worktree`);
    expect(statuses(review)).toEqual({ "01": "closed", "01-grader-1": "done" });
    expect(readStateLine(world.pool, "01-grader-1.md").status).toBe("done");
    await approveReview(server);
  },
);

// engine/engine.test.ts:13575
conformance("interrupts", "a Close says a worktree Ticket's branch was already gone, never that its work was left in place", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", run: commitFile("one.txt", "one", "work-01") });
  const server = await t.start(world);
  await untilInterrupt(server, "01", "checkpoint");
  // Someone tidied the branch away by hand before the Close.
  const { path, branch } = ticketWorktree(world.repo, "01");
  world.git(["worktree", "remove", "--force", path]);
  world.git(["branch", "-D", branch]);

  await close(server, "01");
  const review = await untilInterrupt(server, REVIEW, "review");
  expect(statuses(review)).toEqual({ "01": "closed", "02": "done" });
  expect(review.state.log).toContain(
    `${closedLine("01", "checkpoint")}its branch was already gone, so there was no work to discard`,
  );
  expect(review.state.log.some((line) => line.includes("left in place"))).toBe(false);
});

// engine/engine.test.ts:13597
conformance("interrupts", "a Close whose discard fails part way still closes the Ticket and says what is left", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", run: commitFile("one.txt", "one", "work-01") });
  const server = await t.start(world);
  await untilInterrupt(server, "01", "checkpoint");
  // The worktree's copy of the Ticket file cannot be read.
  const { path, branch } = ticketWorktree(world.repo, "01");
  const copy = join(path, ".scratch", "pool", "issues", "01-t.md");
  rmSync(copy);
  mkdirSync(copy);

  await close(server, "01", "dropped anyway");
  const review = await untilInterrupt(server, REVIEW, "review");

  expect(statuses(review)).toEqual({ "01": "closed", "02": "done" });
  expect(interrupted(review, "01", "checkpoint")).toBe(false);
  expectSameBytes(
    readTicketFile(world.pool, "01-t.md"),
    `${marker("01", "none", "closed")}\n\n# body\n\n---\n\n## Brief, written by the engine\n\n${PLACEHOLDER}\n` +
      "\n## Close note\n\ndropped anyway\n",
    "issues/01-t.md",
  );
  // The reason is the server's own error; what is pinned is the line around it.
  const line = review.state.log.find((entry) => entry.startsWith(closedLine("01", "checkpoint")));
  expect(line).toStartWith(`${closedLine("01", "checkpoint")}discarding its work failed (`);
  expect(line).toEndWith(`); ${branch} is still there`);
  expect(branchExists(world, branch)).toBe(true);
});

// engine/engine.test.ts:13624
conformance("interrupts", "closing the head of a blocked chain names the closed Ticket in every deadlock down it", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: "01" }), ticket("03", { blockedBy: "02" })],
    config: CONFIG,
  });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await untilInterrupt(server, "01", "checkpoint");

  await close(server, "01");
  const after = await settle(server, (s) => s.state.interrupts.length === 2, { what: "the two deadlocks" });
  expect(after.phase).toBe("quiescent");
  expect(after.state.interrupts).toEqual([
    { ticketId: "02", kind: "deadlock", body: "blocker 01 was closed" },
    { ticketId: "03", kind: "deadlock", body: "blocker 02 can never complete (blocker 01 was closed)" },
  ]);
  expect(statuses(after)).toEqual({ "01": "closed", "02": "ready", "03": "ready" });
  expect(launches(world)).toEqual(["01"]);
});

// engine/engine.test.ts:13644
conformance("interrupts", "a lone Ticket closed without a note keeps its work on the pool branch, and says so", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint", run: commitFile("one.txt", "one", "work-01") });
  const server = await t.start(world);
  await untilInterrupt(server, "01", "checkpoint");
  // A lone Ticket runs in the pool checkout itself.
  expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned")?.payload.cwd).toBe(world.repo);

  await close(server, "01");
  const review = await untilInterrupt(server, REVIEW, "review");

  expect(statuses(review)).toEqual({ "01": "closed" });
  expect(existsSync(join(world.repo, "one.txt"))).toBe(true);
  expect(onMain(world, "work-01")).toBe(true);
  expect(review.state.log).toContain(
    `${closedLine("01", "checkpoint")}it ran in the pool checkout, so its work was left in place there; nothing was reset`,
  );
  // No note, no heading.
  expectSameBytes(
    readTicketFile(world.pool, "01-t.md"),
    `${marker("01", "none", "closed")}\n\n# body\n\n---\n\n## Brief, written by the engine\n\n${PLACEHOLDER}\n`,
    "issues/01-t.md",
  );
  expectParsedEqual(
    readEvents(world.pool, "01").find((e) => e.kind === "answered")?.payload,
    { kind: "checkpoint", action: "close" },
    "01's answered payload",
  );
  const done = await approveReview(server);
  expect(done.phase).toBe("done");
});

// engine/engine.test.ts:13667
conformance(
  "interrupts",
  "a merge-conflicted Ticket closed at its Interrupt is discarded unmerged and the hold lifts",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03", { blockedBy: "02" })],
      config: NO_RESOLVER,
      repoFiles: { "shared.txt": "base\n" },
    });
    world.stubs.script("01", { run: commitFile("shared.txt", "from-01", "work-01") });
    // 02 commits its own line only once 01's has merged, so its merge is the
    // one that conflicts.
    world.stubs.script("02", {
      run: [
        "for _ in $(seq 1 400); do",
        `  git -C ${JSON.stringify(world.repo)} log --format=%s | grep -qx work-01 && break`,
        "  sleep 0.05",
        "done",
        commitFile("shared.txt", "from-02", "work-02"),
      ].join("\n"),
    });
    const server = await t.start(world);
    // A conflicted merge holds the pool (ADR-0014), so the run never rests.
    await until(() => snapshot(server), (s) => interrupted(s, "02", "merge-conflict"), {
      ms: 30_000,
      what: "02's merge-conflict Interrupt",
    });
    const { path, branch } = ticketWorktree(world.repo, "02");
    expect(branchExists(world, branch)).toBe(true);

    await close(server, "02", "01 already covers it");
    const after = await settle(server, (s) => interrupted(s, "03", "deadlock"), { what: "03's deadlock" });

    expect(statuses(after)).toEqual({ "01": "done", "02": "closed", "03": "ready" });
    expect(after.state.interrupts).toEqual([{ ticketId: "03", kind: "deadlock", body: "blocker 02 was closed" }]);
    expect(branchExists(world, branch)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("from-01\n");
    expect(onMain(world, "work-02")).toBe(false);
    expect(after.state.log).toContain(`${closedLine("02", "merge-conflict")}discarded ${branch} unmerged, with its worktree`);
    expect(readTicketFile(world.pool, "02-t.md")).toEndWith("\n## Close note\n\n01 already covers it\n");
    expect(readStateLine(world.pool, "02-t.md").status).toBe("closed");
    expect(launches(world).sort()).toEqual(["01", "02"]);
  },
);

// engine/engine.test.ts:13702
conformance(
  "interrupts",
  "a deadlock on a closed blocker is closed in turn, one click per dependent, and the run ends done",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02", { blockedBy: "01" }), ticket("03")],
      config: CONFIG,
    });
    world.stubs.script("01", { status: "checkpoint", brief: "obsolete?" });
    const server = await t.start(world);
    await settle(server, (s) => interrupted(s, "01", "checkpoint") && statuses(s)["03"] === "done", {
      what: "01's checkpoint beside 03 done",
    });

    await close(server, "01", "superseded");
    const afterClose = await untilInterrupt(server, "02", "deadlock");
    expect(afterClose.phase).toBe("quiescent");
    expect(afterClose.state.interrupts).toEqual([{ ticketId: "02", kind: "deadlock", body: "blocker 01 was closed" }]);
    const last = readEvents(world.pool, "02").at(-1)!;
    expect([last.kind, last.payload]).toEqual(["deadlock", { blockers: ["01"] }]);

    // Close is one click per dependent, never a cascade.
    await close(server, "02", "goes with 01");
    const review = await untilInterrupt(server, REVIEW, "review");
    expect(statuses(review)).toEqual({ "01": "closed", "02": "closed", "03": "done" });
    expect(review.state.log).toContain(`${closedLine("02", "deadlock")}it never ran, so there was no work to discard`);
    expect(pending(review)).toEqual([[REVIEW, "review"]]);
    const done = await approveReview(server);
    expect(done.state.log.at(-1)).toBe("pool done: every ticket reached done or was closed (01, 02 closed)");
    expect(launches(world).sort()).toEqual(["01", "03"]);
  },
);

// engine/engine.test.ts:13737
conformance(
  "interrupts",
  "a Close accepted mid-run is drained at the boundary and raises the dependent's deadlock, never ending stalled",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02", { blockedBy: "01" }), ticket("03"), ticket("04", { blockedBy: "03" })],
      config: CONFIG,
    });
    world.stubs.script("01", { status: "checkpoint" });
    const held = world.stubs.hold("04");
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    await until(() => launches(world), (keys) => keys.includes("04"), { what: "04 to launch", ms: 30_000 });
    await until(() => snapshot(server), (s) => interrupted(s, "01", "checkpoint"), { what: "01's checkpoint", ms: 30_000 });

    const accepted = await resume(server, { ticketId: "01", action: "close", note: "drop it" });
    expect(accepted.status).toBe(202);
    // Queued behind the super-step 04 holds open: nothing is closed yet.
    expect(readStateLine(world.pool, "01-t.md").status).toBe("checkpoint");
    expect(statuses(await snapshot(server))["01"]).toBe("checkpoint");

    await held.release();
    const after = await untilInterrupt(server, "02", "deadlock");
    expect(after.phase).toBe("quiescent");
    expect(statuses(after)).toEqual({ "01": "closed", "02": "ready", "03": "done", "04": "done" });
    expect(after.state.interrupts).toEqual([{ ticketId: "02", kind: "deadlock", body: "blocker 01 was closed" }]);
    const phases = await until(
      () => pushedVersions(socket).map((s) => s.phase),
      (seen) => seen.at(-1) === "quiescent" && seen.length > 1,
      { what: "the resting version pushed on the socket", ms: 30_000 },
    );
    expect(phases).not.toContain("stalled");
    expect(after.state.log.some((line) => line.startsWith("pool stalled"))).toBe(false);
  },
);

// engine/engine.test.ts:13772
conformance(
  "interrupts",
  "closing a build Ticket closes its engine-written judges with it, and only those",
  async (t) => {
    const world = t.world({
      tickets: [
        ticket("01", { status: "checkpoint", body: "# 01\n\n## Brief\n\nshould this still happen?" }),
        { file: "01-grader-1.md", marker: marker("01-grader-1", "01") },
        { file: "01-head-to-head.md", marker: marker("01-head-to-head", "01") },
        ticket("02", { blockedBy: "01" }),
      ],
      config: CONFIG,
    });
    const server = await t.start(world);
    const held = await untilInterrupt(server, "01", "checkpoint");
    expect(held.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: "should this still happen?" }]);

    await close(server, "01");
    const after = await untilInterrupt(server, "02", "deadlock");
    expect(statuses(after)).toEqual({ "01": "closed", "01-grader-1": "closed", "01-head-to-head": "closed", "02": "ready" });
    expect(after.state.log).toContain("ticket 01-grader-1: closed with its build ticket 01");
    expect(after.state.log).toContain("ticket 01-head-to-head: closed with its build ticket 01");
    expect(readStateLine(world.pool, "01-grader-1.md").line).toBe(marker("01-grader-1", "01", "closed"));
    expect(readStateLine(world.pool, "01-head-to-head.md").line).toBe(marker("01-head-to-head", "01", "closed"));
    // The hand-written dependent is the operator's to decide.
    expect(after.state.interrupts).toEqual([{ ticketId: "02", kind: "deadlock", body: "blocker 01 was closed" }]);
    expect(launches(world)).toEqual([]);
  },
);

// engine/engine.test.ts:13807
conformance(
  "interrupts",
  "a Close behind a queued Resume and a Resume behind a queued Close are refused, and Close never answers a crash",
  async (t) => {
    const world = t.world({ tickets: [ticket("01"), ticket("02"), ticket("03")], config: CONFIG });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    world.stubs.script("03", { status: "checkpoint" });
    // 02 holds the super-step open, then crashes: no Outcome, exit 1.
    const held = world.stubs.hold("02", { status: "keep", exitCode: 1 });
    const server = await t.start(world);
    await until(() => launches(world), (keys) => keys.includes("02"), { what: "02 to launch", ms: 30_000 });
    await until(() => snapshot(server), (s) => interrupted(s, "01", "checkpoint") && interrupted(s, "03", "checkpoint"), {
      what: "01 and 03 at their checkpoints",
      ms: 30_000,
    });

    expect((await resume(server, { ticketId: "01", note: "go on" })).status).toBe(202);
    const closeBehindResume = await resume(server, { ticketId: "01", action: "close", note: "drop it" });
    expect(closeBehindResume.status).toBe(409);
    expectParsedEqual(closeBehindResume.text, { error: "answer: ticket 01 already has an answer queued" }, "the 409 for 01");
    expect((await resume(server, { ticketId: "03", action: "close", note: "drop it" })).status).toBe(202);
    const resumeBehindClose = await resume(server, { ticketId: "03", note: "go on" });
    expect(resumeBehindClose.status).toBe(409);
    expectParsedEqual(resumeBehindClose.text, { error: "answer: ticket 03 already has an answer queued" }, "the 409 for 03");
    // A retry of the queued Close is acknowledged, and records nothing more.
    expect((await resume(server, { ticketId: "03", action: "close", note: "drop it" })).status).toBe(202);
    const queue = JSON.parse(readFileSync(join(world.pool, "runs", "queued-answers.json"), "utf8")) as {
      answers: { ticketId: string; action?: string; processedAt: string | null }[];
    };
    expect(queue.answers.map((a) => [a.ticketId, a.action ?? "resume", a.processedAt])).toEqual([
      ["01", "resume", null],
      ["03", "close", null],
    ]);

    await held.release();
    const after = await settle(
      server,
      (s) => interrupted(s, "02", "crash") && statuses(s)["01"] === "done" && statuses(s)["03"] === "closed",
      { what: "02's crash with 01 re-run and 03 closed" },
    );
    expect(pending(after)).toEqual([["02", "crash"]]);
    const crashClose = await resume(server, { ticketId: "02", action: "close" });
    expect(crashClose.status).toBe(400);
    expectParsedEqual(
      crashClose.text,
      { error: "answer: close takes a checkpoint, merge-conflict or deadlock interrupt, got crash for 02" },
      "the 400 for 02's crash",
    );
    expect(pending(await snapshot(server))).toEqual([["02", "crash"]]);
  },
);

// engine/engine.test.ts:13856
conformance("interrupts", "a Review reject never reopens a closed Ticket", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
  world.stubs.script("01", { status: "checkpoint" });
  const server = await t.start(world);
  await untilInterrupt(server, "01", "checkpoint");
  await close(server, "01");
  await untilInterrupt(server, REVIEW, "review");

  const refused = await resume(server, { ticketId: REVIEW, action: "reject", note: "redo 01" });
  expect(refused.status).toBe(400);
  expectParsedEqual(refused.text, { error: "review reject: name at least one ticket in the note (known: 02)" }, "the 400");

  await answer(server, { ticketId: REVIEW, action: "reject", note: "redo 01 and 02" });
  const again = await settle(
    server,
    (s) => interrupted(s, REVIEW, "review") && launches(world).filter((key) => key === "02").length === 2,
    { what: "02 run again to a fresh Review" },
  );
  expect(again.state.log).toContain("review rejected: 02 back to ready");
  expect(statuses(again)).toEqual({ "01": "closed", "02": "done" });
  expect(readStateLine(world.pool, "01-t.md").status).toBe("closed");
  expect(launches(world).filter((key) => key === "01")).toHaveLength(1);
});
