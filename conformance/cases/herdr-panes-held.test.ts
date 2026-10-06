/**
 * Held panes (issue #139), seen from outside the server (ADR-0036): the
 * still-live herdr pane of a terminal-backed Attempt that ended at a
 * checkpoint, which the snapshot carries as the Ticket's `heldPane` while
 * its Interrupt waits, which Keep talking continues as a Continued attempt,
 * and whose tab a plain Resume or a Close closes. Rows of the `herdr` area
 * in the Rust port inventory (docs/research/rust-port/test-inventory.md,
 * ticket C15), with the `enlist` row on closing an enlisted Ticket.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { callsOf, type HerdrProcess } from "../harness/herdr.ts";
import {
  answerPrompt,
  awaitPrompt,
  poolLog,
  readyTicket,
  TERMINAL_CONFIG,
} from "../harness/herdr-tui.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import {
  bootWorld,
  CHECKPOINT,
  event,
  fakeHerdr,
  keepTalking,
  plantWitness,
  quitTui,
  snapshotOf,
  spawnedTerminal,
  tabCloses,
  terminalWorld,
  ticketAt,
  ticketIn,
  untilExitCode,
  untilHeld,
  untilInterrupt,
  untilSnapshot,
  untilSurveyed,
  writeEvents,
} from "./herdr-panes-support.ts";

/** The `spawned` event payload of one attempt of a Ticket. */
function spawnedOf(world: Parameters<typeof spawnedTerminal>[0], id: string, attempt: number): Record<string, unknown> {
  const spawned = readEvents(world.pool, id).find((e) => e.kind === "spawned" && e.attempt === attempt);
  if (!spawned) throw new Error(`no spawned event for ${id} attempt ${attempt}`);
  return spawned.payload;
}

/** Wait for a Turn typed into `paneId` that says `text`, and its Enter, at or after call `from`. */
async function typedInto(
  herdr: HerdrProcess,
  paneId: string,
  text: string,
  from = 0,
): Promise<void> {
  const typed = await herdr.waitForCall(
    (call) =>
      call.method === "pane.send_input" &&
      call.params.pane_id === paneId &&
      typeof call.params.text === "string" &&
      call.params.text.includes(text),
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

const NO_TERMINAL = (id: string) => `keep talking: ticket ${id} has no terminal left to continue in`;

// engine/held-panes.test.ts:16
conformance(
  "herdr",
  "held panes › reads a checkpointed attempt's pane, place and Assignment off its spawned event",
  async (t) => {
    const { world } = terminalWorld(t, {
      tickets: [readyTicket("01", "Talk it through")],
      config: { defaults: { harness: "claude", model: "opus" }, terminal: "herdr" },
    });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);

    const held = await untilHeld(server, "01");
    const first = spawnedOf(world, "01", 1);
    expect(held).toEqual({ attempt: 1, paneId: String(first.pane_id) });

    // Reassigned since: the pane still runs the model it launched with.
    const reassigned = await server.http.put("/api/reassign", { tickets: ["01"], fields: { model: "sonnet" } });
    expect(reassigned.status).toBe(200);
    const from = herdr.calls.length;
    const talk = await keepTalking(server, "01");
    expect(talk.status).toBe(202);
    expect(talk.json<object>()).toEqual({ ticketId: "01", attempt: 2 });
    await typedInto(herdr, held.paneId, "You are now its attempt 2", from);

    expect(spawnedOf(world, "01", 2)).toMatchObject({
      pane_id: held.paneId,
      tab_id: first.tab_id,
      cwd: first.cwd,
      branch: first.branch,
      harness: "claude",
      model: "opus",
      continued: true,
      continues: 1,
    });
  },
);

// engine/held-panes.test.ts:48
conformance("herdr", "held panes › knows a verify candidate by the attempt worktree it ran in", async (t) => {
  const { world } = terminalWorld(t, {
    tickets: [readyTicket("01", "Fan out once")],
    config: { ...TERMINAL_CONFIG, assign: { "01": { verify: 1 } } },
  });
  const herdr = await fakeHerdr(t, world);
  const server = await t.start(world, { herdr });
  await answerPrompt(herdr, "01.attempt-1", CHECKPOINT);
  // The candidate is graded before its checkpoint is raised.
  await answerPrompt(herdr, "01-grader-1", {
    status: "done",
    summary: "graded",
    commitSha: null,
    grade: { score: 8, verdict: "pass", reasons: "fine" },
  });
  const held = await untilHeld(server, "01");
  expect(held.attempt).toBe(1);

  const from = herdr.calls.length;
  expect((await keepTalking(server, "01")).json<object>()).toEqual({ ticketId: "01", attempt: 2 });
  await typedInto(herdr, held.paneId, join(world.pool, "runs", "01.attempt-2.outcome.json"), from);

  const first = spawnedOf(world, "01", 1);
  expect(spawnedOf(world, "01", 2)).toMatchObject({
    pane_id: held.paneId,
    cwd: first.cwd,
    continues: 1,
    work_attempt: 1,
    numbered: true,
  });
});

// engine/held-panes.test.ts:55
conformance(
  "herdr",
  "held panes › follows a Continued attempt back to the attempt whose worktree and Stream file it uses",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Talk twice")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    const held = await untilHeld(server, "01");

    let from = herdr.calls.length;
    expect((await keepTalking(server, "01")).status).toBe(202);
    await typedInto(herdr, held.paneId, "You are now its attempt 2", from);
    // Continued attempt 2 checkpoints in turn, over the same pane.
    await Bun.write(join(world.pool, "runs", "01.outcome.json"), JSON.stringify({ ...CHECKPOINT, brief: "once more" }));
    await untilSnapshot(server, (snap) => ticketIn(snap, "01").heldPane?.attempt === 2, "attempt 2's Held pane");
    expect(ticketIn(await snapshotOf(server), "01").heldPane).toEqual({ attempt: 2, paneId: held.paneId });

    from = herdr.calls.length;
    expect((await keepTalking(server, "01")).json<object>()).toEqual({ ticketId: "01", attempt: 3 });
    await typedInto(herdr, held.paneId, "You are now its attempt 3", from);

    const stream = join(world.pool, "runs", "01.attempt-1.stream.jsonl");
    expect(spawnedOf(world, "01", 2)).toMatchObject({ continues: 1, work_attempt: 1, stream });
    expect(spawnedOf(world, "01", 3)).toMatchObject({
      pane_id: held.paneId,
      continued: true,
      continues: 2,
      work_attempt: 1,
      numbered: false,
      stream,
    });
  },
  { timeoutMs: 120_000 },
);

// engine/held-panes.test.ts:78
conformance(
  "herdr",
  "held panes › holds nothing for a headless attempt, a fallback, a resolver or an attempt never spawned",
  async (t) => {
    // Booted over checkpoints a restart finds: 01's attempt ran headless,
    // 02's last attempt was a resolver's (in a pane the fake still lists),
    // and 03 has no attempt on record. The witness is held, so the survey
    // has listed when the others are read.
    const world = bootWorld(t, {
      tickets: [ticketAt("01", "checkpoint"), ticketAt("02", "checkpoint"), ticketAt("03", "checkpoint")],
    });
    writeEvents(world, "01", [
      event(1, "spawned", { argv: ["claude", "-p", "the prompt"], cwd: world.repo, pid: 42 }),
      event(1, "exited", { code: 0, status: "checkpoint" }),
    ]);
    writeEvents(world, "02", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p2a", tab_id: "t2a" }),
      event(1, "exited", { code: 0, status: "done" }),
      event(2, "resolver", {}),
      event(2, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p2b", tab_id: "t2b" }),
      event(2, "exited", { code: 0, status: "done" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p2b", { tabId: "t2b", cwd: world.repo });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });
    const surveyed = await untilSurveyed(server);
    for (const id of ["01", "02", "03"]) {
      expect(surveyed.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint")).toBe(true);
      expect(ticketIn(surveyed, id).heldPane).toBeNull();
      const talk = await keepTalking(server, id);
      expect(talk.status).toBe(409);
      expect(talk.json<object>()).toEqual({ reason: NO_TERMINAL(id) });
    }

    // A fallback: herdr refused the tab, so the attempt ran headless and
    // checkpointed there.
    const { world: fallback } = terminalWorld(t, { tickets: [readyTicket("01", "Fall back")] });
    fallback.stubs.script("01", { status: "checkpoint", brief: "ask me" });
    const refusing = await fakeHerdr(t, fallback, { fail: ["tab.create"] });
    const server2 = await t.start(fallback, { herdr: refusing });
    const raised = await untilInterrupt(server2, "01", "checkpoint");
    expect(spawnedOf(fallback, "01", 1)).toMatchObject({ pane_id: null });
    expect(ticketIn(raised, "01").heldPane).toBeNull();
    const talk = await keepTalking(server2, "01");
    expect(talk.status).toBe(409);
    expect(talk.json<object>()).toEqual({ reason: NO_TERMINAL("01") });
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:218
conformance(
  "herdr",
  "Keep talking (issue #139) › lets a Held pane go when its TUI exits and offers no Keep talking over the bare shell (review item 1)",
  async (t) => {
    // The pane keeps its shell when the TUI exits, as a real herdr pane does.
    const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Quit on me")] });
    const herdr = await fakeHerdr(t, world, { holdPane: true });
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    await untilHeld(server, "01");

    quitTui(world, tui, "01");
    await untilExitCode(world, "01");
    // Let go at the pane survey's next listing, within its cadence.
    const gone = await untilSnapshot(server, (snap) => ticketIn(snap, "01").heldPane === null, "the Held pane let go", 45_000);
    expect(gone.state.interrupts.filter((i) => i.ticketId === "01").map((i) => i.kind)).toEqual(["checkpoint"]);
    const talk = await keepTalking(server, "01");
    expect(talk.status).toBe(409);
    expect(talk.json<object>()).toEqual({ reason: NO_TERMINAL("01") });
  },
  { slow: true },
);

// engine/keep-talking.test.ts:251
conformance(
  "herdr",
  "Keep talking (issue #139) › lets the Held pane go when the pane leaves herdr, and then refuses to continue",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Gone from herdr")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    const held = await untilHeld(server, "01");

    // The pane leaves herdr's listing; its TUI never wrote an exit code.
    await herdr.control("endPane", held.paneId);
    const gone = await untilSnapshot(server, (snap) => ticketIn(snap, "01").heldPane === null, "the Held pane let go", 45_000);
    expect(existsSync(join(world.pool, "runs", "01.exitcode"))).toBe(false);
    expect(gone.state.interrupts.filter((i) => i.ticketId === "01").map((i) => i.kind)).toEqual(["checkpoint"]);
    const talk = await keepTalking(server, "01");
    expect(talk.status).toBe(409);
    expect(talk.json<object>()).toEqual({ reason: NO_TERMINAL("01") });
  },
  { slow: true },
);

// engine/keep-talking.test.ts:266
conformance(
  "herdr",
  "Keep talking (issue #139) › closes the checkpointed attempt's tab before a plain Resume launches afresh, once (review item 10)",
  async (t) => {
    const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Start over")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    await untilHeld(server, "01");
    const first = spawnedTerminal(world, "01", 1);

    let from = herdr.calls.length;
    expect((await server.http.post("/api/resume", { ticketId: "01", action: "resume" })).status).toBe(202);
    await awaitPrompt(herdr, "01", { from });
    const methods = herdr.calls.map((call) => (call.method === "tab.close" ? `tab.close ${String(call.params.tab_id)}` : call.method));
    const creates = methods.flatMap((method, i) => (method === "tab.create" ? [i] : []));
    expect(creates).toHaveLength(2);
    const closedAt = methods.indexOf(`tab.close ${first.tabId}`);
    expect(closedAt).toBeGreaterThan(-1);
    expect(closedAt).toBeLessThan(creates[1]!);
    const closed = readEvents(world.pool, "01").filter((e) => e.kind === "tab-closed");
    expect(closed.map((e) => [e.attempt, e.payload])).toEqual([[1, { tab_id: first.tabId, terminal_id: "term-1", reason: "resume" }]]);

    // Attempt 2 crashes; resuming it launches attempt 3, and the Resume
    // reaches back for nothing: the checkpointed tab is closed already, and
    // a crashed attempt's tab stays.
    const second = spawnedTerminal(world, "01", 2);
    quitTui(world, tui, "01", 1, 2);
    await untilInterrupt(server, "01", "crash");
    from = herdr.calls.length;
    expect((await server.http.post("/api/resume", { ticketId: "01", action: "resume" })).status).toBe(202);
    await awaitPrompt(herdr, "01", { from });
    expect(callsOf(herdr, "tab.create")).toHaveLength(3);
    expect((await tabCloses(herdr)).filter((tab) => tab === first.tabId)).toHaveLength(1);
    expect(await tabCloses(herdr)).not.toContain(second.tabId);
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "tab-closed")).toHaveLength(1);
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:303
conformance(
  "herdr",
  "Keep talking (issue #139) › closes the Held pane's tab at a Close, which never relaunches the ticket (issue #154)",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Drop it")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    await untilHeld(server, "01");
    const first = spawnedTerminal(world, "01", 1);

    expect((await server.http.post("/api/resume", { ticketId: "01", action: "close", note: "dropped" })).status).toBe(202);
    await until(() => readEvents(world.pool, "01").filter((e) => e.kind === "tab-closed"), (closed) => closed.length > 0, {
      ms: 30_000,
      what: "the Held pane's tab closed",
    });
    expect(readMarkers(world.pool)["01"]!.status).toBe("closed");
    const closed = await untilSnapshot(server, (snap) => ticketIn(snap, "01").status === "closed", "01 closed");
    expect(ticketIn(closed, "01").heldPane).toBeNull();
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "tab-closed").map((e) => [e.payload.tab_id, e.payload.reason])).toEqual([
      [first.tabId, "closed"],
    ]);
    expect(await tabCloses(herdr)).toEqual([first.tabId]);
    // Nothing launched after it.
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "spawned")).toHaveLength(1);
    expect(callsOf(herdr, "tab.create")).toHaveLength(1);
  },
);

// engine/keep-talking.test.ts:321
conformance(
  "herdr",
  "Keep talking (issue #139) › leaves the tab open at a Resume when a Continued attempt crashed in it after the checkpoint (R6)",
  async (t) => {
    const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Crash while talking")] });
    const herdr = await fakeHerdr(t, world, { holdPane: true });
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    const held = await untilHeld(server, "01");
    const first = spawnedTerminal(world, "01", 1);

    let from = herdr.calls.length;
    expect((await keepTalking(server, "01")).status).toBe(202);
    await typedInto(herdr, held.paneId, "You are now its attempt 2", from);
    // The Continued attempt's TUI exits with no Outcome: a crash, and its tab
    // stays open as every crashed attempt's does.
    quitTui(world, tui, "01");
    await untilInterrupt(server, "01", "crash");

    from = herdr.calls.length;
    expect((await server.http.post("/api/resume", { ticketId: "01", action: "resume" })).status).toBe(202);
    await awaitPrompt(herdr, "01", { from });
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "spawned").map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(spawnedTerminal(world, "01", 3).tabId).not.toBe(first.tabId);
    expect(await tabCloses(herdr)).not.toContain(first.tabId);
  },
  { timeoutMs: 120_000 },
);

// engine/keep-talking.test.ts:689
conformance(
  "enlist",
  "Keep talking review fixes (issue #139) › closes an enlisted Ticket but leaves its pane, tab and branch as found (issue #154)",
  async (t) => {
    // Booted over enlist-1 waiting at a checkpoint in the operator's pane,
    // on their branch.
    const world = t.world({
      config: TERMINAL_CONFIG,
      tickets: [ticketAt("enlist-1", "checkpoint", "enlisted-from=p-op")],
    });
    world.git(["branch", "op-branch"]);
    writeEvents(world, "enlist-1", [
      event(1, "spawned", {
        argv: [],
        cwd: world.repo,
        pane_id: "p-op",
        tab_id: "tab-ghost",
        branch: "op-branch",
        harness: "opencode",
      }),
      event(1, "exited", { status: "checkpoint" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p-op", { tabId: "tab-ghost", cwd: world.repo });
    const server = await t.start(world, { herdr });
    expect(await untilHeld(server, "enlist-1")).toEqual({ attempt: 1, paneId: "p-op" });

    const close = await server.http.post("/api/resume", { ticketId: "enlist-1", action: "close", note: "not this way" });
    expect(close.status).toBe(202);
    const closed = await untilSnapshot(server, (snap) => ticketIn(snap, "enlist-1").status === "closed", "enlist-1 closed");
    expect(readMarkers(world.pool)["enlist-1"]!.status).toBe("closed");
    expect(ticketIn(closed, "enlist-1").heldPane).toBeNull();
    expect(await poolLog(server)).toContain(
      "interrupt answered for enlist-1 (checkpoint): closed; enlisted, so its branch, directory and pane were left as found",
    );
    await herdr.settle();
    expect(herdr.calls.filter((call) => call.method === "tab.close" || call.method === "pane.close")).toEqual([]);
    expect(world.git(["branch", "--list", "op-branch"]).trim()).not.toBe("");
    expect(readFileSync(join(world.pool, "issues", "enlist-1.md"), "utf8")).toContain("## Close note\n\nnot this way");
  },
);
