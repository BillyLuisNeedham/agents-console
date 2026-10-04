/**
 * Finished terminals and their bulk close (issue #139), seen from outside the
 * server (ADR-0036): the herdr tabs a terminal-backed pool opened that are
 * still open over an Attempt or a Conversation that has ended, counted on the
 * snapshot as `finishedTerminals` and closed only by POST
 * /api/terminals/close-finished. Rows of the `herdr` area in the Rust port
 * inventory (docs/research/rust-port/test-inventory.md, ticket C15), with
 * the area's gaps on the bulk close.
 *
 * The count is derived from the pane survey's last listing, which lands on
 * the survey's fifteen-second cadence or when the engine asks for one: a
 * Held pane, a closed tab, a Keep talking, a bulk close. A case reads the
 * count once such a listing has landed. The bulk close lists afresh before
 * it closes anything, so its answer, and the tabs it asks herdr to close,
 * show the set exactly as the engine derives it.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { answerPrompt, awaitPrompt, callsOf, doneOutcome, poolLog, readyTicket, TERMINAL_CONFIG } from "../harness/herdr-tui.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import {
  bootWorld,
  builtSnapshots,
  CHECKPOINT,
  closedFinished,
  closeFinished,
  event,
  fakeHerdr,
  plantWitness,
  publish,
  quitTui,
  snapshotOf,
  spawnedTerminal,
  tabCloses,
  terminalWorld,
  ticketAt,
  ticketIn,
  untilHeld,
  untilSnapshot,
  untilSurveyed,
  writeEvents,
} from "./herdr-panes-support.ts";

/** The Finished terminals count GET /api/state serves now. */
async function finishedNow(server: Parameters<typeof snapshotOf>[0]): Promise<number> {
  return (await snapshotOf(server)).finishedTerminals;
}

/** Wait for the count to read `n`. */
function untilFinished(server: Parameters<typeof snapshotOf>[0], n: number, ms = 30_000): Promise<EnrichedSnapshot> {
  return untilSnapshot(server, (snap) => snap.finishedTerminals === n, `finishedTerminals ${n}`, ms);
}

// engine/finished-terminals.test.ts:38
conformance("herdr", "finished terminals › reads every tab the owners' spawned events name, once each", async (t) => {
  const world = bootWorld(t, {
    tickets: [ticketAt("01", "done"), ticketAt("enlist-1", "done", "enlisted-from=pe")],
    poolFiles: {
      "conversations/conv-1.md":
        "<!-- conversation: id=conv-1 status=crashed spawned-by=none harness=claude model=m drivers=implement -->\n\n# Crashed talk\n\nhi\n",
    },
  });
  // Ticket 01's attempt 1 opened t1 and its Continued attempt 2 named it
  // again; attempt 3 ran headless. A crashed Conversation opened tc, and an
  // enlisted Ticket's events name the operator's te.
  writeEvents(world, "01", [
    event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1", tab_id: "t1", terminal_id: "term_a" }),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(2, "spawned", { argv: [], cwd: world.repo, pane_id: "p1", tab_id: "t1", continued: true, continues: 1 }),
    event(2, "exited", { code: 0, status: "done" }),
    event(3, "spawned", { argv: ["claude", "-p"], cwd: world.repo, pid: 7 }),
    event(3, "exited", { code: 0, status: "done" }),
  ]);
  writeEvents(world, "conv-1", [event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "pc", tab_id: "tc" })]);
  writeEvents(world, "enlist-1", [event(1, "spawned", { argv: [], cwd: world.repo, pane_id: "pe", tab_id: "te" })]);
  const herdr = await fakeHerdr(t, world);
  for (const [pane, tab] of [["p1", "t1"], ["pc", "tc"], ["pe", "te"]] as const) {
    await herdr.control("injectPane", pane, { tabId: tab, cwd: world.repo });
  }
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  expect((await untilSurveyed(server)).finishedTerminals).toBe(2);
  expect(await closedFinished(server)).toBe(2);
  // t1 once, for all three of 01's attempts; never the enlisted te.
  expect((await tabCloses(herdr)).sort()).toEqual(["t1", "tc"]);
  expect(await finishedNow(server)).toBe(0);
  // Each close is recorded on its owner's latest attempt, as the later of
  // the two spawns that named t1 recorded it: with no terminal id.
  const closedOn = (id: string) =>
    readEvents(world.pool, id).filter((e) => e.kind === "tab-closed").map((e) => [e.attempt, e.payload]);
  expect(closedOn("01")).toEqual([[3, { tab_id: "t1", reason: "finished terminals closed" }]]);
  expect(closedOn("conv-1")).toEqual([[1, { tab_id: "tc", reason: "finished terminals closed" }]]);
  expect(closedOn("enlist-1")).toEqual([]);
});

// engine/finished-terminals.test.ts:52
conformance(
  "herdr",
  "finished terminals › counts the tabs herdr still lists whose panes nothing is using",
  async (t) => {
    // Five Tickets in one super-step, each in a tab of its own. A TUI that
    // quits leaves its shell, as a real herdr pane does, so a crashed
    // attempt's tab stays listed.
    const { world, tui } = terminalWorld(t, {
      tickets: ["01", "02", "03", "04", "05"].map((id) => readyTicket(id, `Tab ${id}`)),
    });
    const herdr = await fakeHerdr(t, world, { holdPane: true });
    const server = await t.start(world, { herdr });
    await Promise.all(["01", "02", "03", "04", "05"].map((id) => awaitPrompt(herdr, id, { ms: 60_000 })));

    // 01, 04 and 05 crash: each TUI quits with no Outcome. Their crash
    // Interrupts wait for the super-step, which 02 holds open; the Attempts
    // are over at once.
    for (const id of ["01", "04", "05"]) quitTui(world, tui, id, 1);
    await untilSnapshot(
      server,
      (snap) => ["01", "04", "05"].every((id) => ticketIn(snap, id).liveAttempt === null),
      "01, 04 and 05's attempts to end",
    );
    // The operator closes 04's tab, and moves 02's live pane into 05's tab.
    await herdr.control("closeTab", spawnedTerminal(world, "04").tabId);
    await herdr.control("relistPane", spawnedTerminal(world, "02").paneId, { tabId: spawnedTerminal(world, "05").tabId });
    // 03 checkpoints last; holding its pane lists every pane afresh.
    await answerPrompt(herdr, "03", CHECKPOINT);
    await untilHeld(server, "03");

    // 02 is live, 03 held, 04 gone, and 05's tab holds 02's pane: 01 alone.
    await untilFinished(server, 1);
    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual([spawnedTerminal(world, "01").tabId]);
    expect(await finishedNow(server)).toBe(0);
  },
  { timeoutMs: 120_000 },
);

// engine/finished-terminals.test.ts:66
conformance(
  "herdr",
  "finished terminals › never counts a tab someone enlisted from, whoever opened it (review item 2)",
  async (t) => {
    // A lone Ticket runs in the pool checkout and merges nothing, so its
    // tab stays open once it is done, its TUI still up.
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Finish and stay")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", doneOutcome());
    // Nothing asks the survey to list after an attempt ends done: the count
    // reads 1 at its next cadence.
    await untilFinished(server, 1, 45_000);
    const { paneId, tabId } = spawnedTerminal(world, "01");

    // The operator enlists the agent still live in that tab as a new Ticket.
    await herdr.control("seedAgent", { paneId, agent: "claude", cwd: world.repo, title: "still here", status: "idle" });
    const enlisted = await server.http.post("/api/enlist", { becomes: "ticket", paneId, title: "Theirs now", spec: "" });
    expect(enlisted.status).toBe(201);
    expect(await finishedNow(server)).toBe(0);
    expect(await closedFinished(server)).toBe(0);

    // Done and no longer live, the enlisted Ticket's tab is still theirs.
    await Bun.write(join(world.pool, "runs", "enlist-1.outcome.json"), JSON.stringify(doneOutcome()));
    await until(() => readMarkers(world.pool)["enlist-1"]?.status, (status) => status === "done", {
      ms: 30_000,
      what: "enlist-1 done",
    });
    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    expect(await tabCloses(herdr)).not.toContain(tabId);
  },
  { slow: true },
);

// engine/finished-terminals.test.ts:75
conformance(
  "herdr",
  "finished terminals › never counts a tab herdr lists differently from how it was recorded (review item 4)",
  async (t) => {
    // Six done Tickets, each recorded in its own tab with no terminal id,
    // and each pane listed by the fake its own way. The Pool workspace is
    // the one the server creates at boot, w1.
    const ids = ["01", "02", "03", "04", "05", "06"];
    const world = bootWorld(t, { tickets: ids.map((id) => ticketAt(id, "done")) });
    const herdr = await fakeHerdr(t, world);
    for (const id of ids) {
      writeEvents(world, id, [
        event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: `p${id}`, tab_id: `t${id}` }),
        event(1, "exited", { code: 0, status: "done" }),
      ]);
      await herdr.control("injectPane", `p${id}`, { tabId: `t${id}`, cwd: world.repo, workspaceId: "w1" });
    }
    // As recorded; the directory with a trailing slash; nothing but the pane
    // id reported: each is the pane recorded.
    await herdr.control("relistPane", "p02", { cwd: `${world.repo}/` });
    await herdr.control("relistPane", "p03", { tabId: null, workspaceId: null, cwd: null });
    // In another tab, outside the Pool workspace, in another directory: not ours.
    await herdr.control("relistPane", "p04", { tabId: "t-other" });
    await herdr.control("relistPane", "p05", { workspaceId: "w-other" });
    await herdr.control("relistPane", "p06", { cwd: world.root });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });

    expect((await untilSurveyed(server)).finishedTerminals).toBe(3);
    expect(await closedFinished(server)).toBe(3);
    expect((await tabCloses(herdr)).sort()).toEqual(["t01", "t02", "t03"]);
  },
);

// engine/finished-terminals.test.ts:100
conformance(
  "herdr",
  "finished terminals › never counts a tab whose terminal herdr now names differently (terminal_id)",
  async (t) => {
    // Recorded under term-1, listed under term-9: another terminal behind
    // the same pane and tab ids.
    const world = bootWorld(t, { tickets: [ticketAt("01", "done")] });
    writeEvents(world, "01", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1", tab_id: "t1", terminal_id: "term-1" }),
      event(1, "exited", { code: 0, status: "done" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p1", { tabId: "t1", cwd: world.repo, terminalId: "term-9" });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });
    expect((await untilSurveyed(server)).finishedTerminals).toBe(0);
    expect(await closedFinished(server)).toBe(0);
    expect(await tabCloses(herdr)).toEqual([]);

    // A spawn recorded before herdr gave terminal ids falls back to the
    // tab and directory, which agree.
    const older = bootWorld(t, { tickets: [ticketAt("01", "done")] });
    writeEvents(older, "01", [
      event(1, "spawned", { argv: ["claude"], cwd: older.repo, pane_id: "p1", tab_id: "t1" }),
      event(1, "exited", { code: 0, status: "done" }),
    ]);
    const herdrOlder = await fakeHerdr(t, older);
    await herdrOlder.control("injectPane", "p1", { tabId: "t1", cwd: older.repo, terminalId: "term-9" });
    await plantWitness(older, herdrOlder);
    const serverOlder = await t.start(older, { herdr: herdrOlder });
    expect((await untilSurveyed(serverOlder)).finishedTerminals).toBe(1);
    expect(await closedFinished(serverOlder)).toBe(1);
    expect(await tabCloses(herdrOlder)).toEqual(["t1"]);
  },
);

// engine/finished-terminals.test.ts:115
conformance(
  "herdr",
  "finished terminals › knows a tab closed by its terminal id when one was recorded, by its tab id otherwise (R7)",
  async (t) => {
    const world = bootWorld(t, { tickets: [ticketAt("01", "done"), ticketAt("02", "done"), ticketAt("03", "done")] });
    // 01: t1 closed as term-a, then reused by term-b: the later t1 is open.
    writeEvents(world, "01", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1a", tab_id: "t1", terminal_id: "term-a" }),
      event(1, "tab-closed", { tab_id: "t1", terminal_id: "term-a", reason: "role ended" }),
      event(2, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1b", tab_id: "t1", terminal_id: "term-b" }),
    ]);
    // 02: the close recorded no terminal id, so it matches by tab id.
    writeEvents(world, "02", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p2a", tab_id: "t2", terminal_id: "term-c" }),
      event(1, "tab-closed", { tab_id: "t2", reason: "role ended" }),
      event(2, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p2b", tab_id: "t2", terminal_id: "term-d" }),
    ]);
    // 03: the later spawn recorded none, so it matches by tab id too.
    writeEvents(world, "03", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p3a", tab_id: "t3", terminal_id: "term-e" }),
      event(1, "tab-closed", { tab_id: "t3", terminal_id: "term-e", reason: "role ended" }),
      event(2, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p3b", tab_id: "t3" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p1b", { tabId: "t1", cwd: world.repo, terminalId: "term-b" });
    await herdr.control("injectPane", "p2b", { tabId: "t2", cwd: world.repo, terminalId: "term-d" });
    await herdr.control("injectPane", "p3b", { tabId: "t3", cwd: world.repo, terminalId: "term-f" });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });

    expect((await untilSurveyed(server)).finishedTerminals).toBe(1);
    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual(["t1"]);
  },
);

// engine/finished-terminals.test.ts:128
conformance("herdr", "finished terminals › leaves out a tab its owner's events record closed", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("01", "done")] });
  writeEvents(world, "01", [
    event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1", tab_id: "t1", terminal_id: "term-a" }),
    event(2, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p2", tab_id: "t2" }),
    event(1, "tab-closed", { tab_id: "t1", terminal_id: "term-a", reason: "role ended" }),
  ]);
  const herdr = await fakeHerdr(t, world);
  // The listing still has both panes, as recorded: one taken before the
  // close would.
  await herdr.control("injectPane", "p1", { tabId: "t1", cwd: world.repo, terminalId: "term-a" });
  await herdr.control("injectPane", "p2", { tabId: "t2", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  expect((await untilSurveyed(server)).finishedTerminals).toBe(1);
  expect(await closedFinished(server)).toBe(1);
  expect(await tabCloses(herdr)).toEqual(["t2"]);
});

// engine/keep-talking.test.ts:378
conformance(
  "herdr",
  "Finished terminals (issue #139) › counts a done ticket's still-open tab and closes it on the bulk close alone",
  async (t) => {
    const { world } = terminalWorld(t, { git: false, tickets: [readyTicket("01", "Done and left open")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", doneOutcome());
    await until(() => readMarkers(world.pool)["01"]?.status, (status) => status === "done", { ms: 30_000, what: "01 done" });

    // Counted at the survey's next cadence, and nothing closes it on its own.
    await untilFinished(server, 1, 45_000);
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);

    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual([spawnedTerminal(world, "01").tabId]);
    await untilFinished(server, 0);
  },
  { slow: true },
);

// gap: engine/engine.ts:5284-5311 and 9415-9437 (the bulk close itself)
conformance(
  "herdr",
  "the bulk close closes a done Ticket's tab left over a bare shell, records it and says so",
  async (t) => {
    // The TUI quits after its Outcome and the pane keeps its shell, as a
    // real herdr pane does: a Finished terminal all the same.
    const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Done and quit")] });
    const herdr = await fakeHerdr(t, world, { holdPane: true });
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", doneOutcome());
    await until(() => readMarkers(world.pool)["01"]?.status, (status) => status === "done", { ms: 30_000, what: "01 done" });
    quitTui(world, tui, "01");
    const { tabId } = spawnedTerminal(world, "01");

    expect(await closeFinished(server)).toEqual({ status: 200, body: { closed: 1 } });
    expect(await tabCloses(herdr)).toEqual([tabId]);
    const closed = readEvents(world.pool, "01").filter((e) => e.kind === "tab-closed");
    expect(closed.map((e) => e.payload)).toEqual([
      { tab_id: tabId, terminal_id: "term-1", reason: "finished terminals closed" },
    ]);
    expect(closed[0]!.attempt).toBe(1);
    expect(await poolLog(server)).toContain("closed 1 finished terminal");
    expect(await finishedNow(server)).toBe(0);
  },
);

// gap: engine/engine.ts:5289 (the bulk close when pane.list fails)
conformance(
  "herdr",
  "the bulk close refuses when the daemon cannot list its panes, and closes nothing",
  async (t) => {
    const world = bootWorld(t, { tickets: [ticketAt("01", "done")] });
    writeEvents(world, "01", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "p1", tab_id: "t1" }),
      event(1, "exited", { code: 0, status: "done" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p1", { tabId: "t1", cwd: world.repo });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });
    expect((await untilSurveyed(server)).finishedTerminals).toBe(1);

    await herdr.control("fail", "pane.list", true);
    const close = await closeFinished(server);
    expect(close).toEqual({
      status: 409,
      body: { reason: "close finished terminals: the herdr daemon could not list its panes" },
    });
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);
    expect(await finishedNow(server)).toBe(1);
  },
);

// engine/keep-talking.test.ts:436
conformance(
  "herdr",
  "Finished terminals (issue #139) › never counts or closes an ended enlisted Conversation's tab (issue #140)",
  async (t) => {
    const world = bootWorld(t, {
      tickets: [ticketAt("01", "done")],
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model= drivers=tdd " +
          `pane=p-op tab=tab-ghost directory=${encodeURIComponent("/x")} branch=main session=none -->\n\n# Theirs\n\nhi\n`,
      },
    });
    writeEvents(world, "conv-1", [
      event(1, "spawned", { argv: [], cwd: world.repo, pane_id: "p-op", tab_id: "tab-ghost" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "p-op", { tabId: "tab-ghost", cwd: world.repo });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });

    const surveyed = await untilSurveyed(server);
    expect(surveyed.state.conversations.find((c) => c.id === "conv-1")?.enlisted).toBe(true);
    expect(surveyed.finishedTerminals).toBe(0);
    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    expect(await tabCloses(herdr)).toEqual([]);
  },
);

// engine/keep-talking.test.ts:467, and the gap at engine/engine.ts:9437-9452
// (a refused tab.close on the bulk close)
conformance(
  "herdr",
  "Finished terminals (issue #139) › records a tab herdr refuses to close, and keeps the close best-effort",
  async (t) => {
    const { world } = terminalWorld(t, { git: false, tickets: [readyTicket("01", "Done and left open")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", doneOutcome());
    await until(() => readMarkers(world.pool)["01"]?.status, (status) => status === "done", { ms: 30_000, what: "01 done" });
    const { tabId } = spawnedTerminal(world, "01");

    await herdr.control("fail", "tab.close", true);
    expect(await closedFinished(server)).toBe(0);
    expect(await tabCloses(herdr)).toEqual([tabId]);
    const error = `tab.close failed: {"code":-32000,"message":"tab.close refused"}`;
    const failed = readEvents(world.pool, "01").filter((e) => e.kind === "tab-close-failed");
    expect(failed.map((e) => [e.attempt, e.payload])).toEqual([[1, { tab_id: tabId, error }]]);
    expect(readEvents(world.pool, "01").some((e) => e.kind === "tab-closed")).toBe(false);
    expect(await poolLog(server)).toContain(`01: herdr tab ${tabId} could not be closed (${error})`);
    expect(await poolLog(server)).toContain("closed 0 finished terminals");
    expect(await finishedNow(server)).toBe(1);
  },
);

// engine/keep-talking.test.ts:491
conformance(
  "herdr",
  "Finished terminals (issue #139) › records a Conversation tab herdr refuses to close at its crash",
  async (t) => {
    // The plain stub, no TUI stand-in: claude exits 1 the moment it starts,
    // before the Conversation is up.
    const world = t.world({ config: TERMINAL_CONFIG, tickets: [ticketAt("01", "done")] });
    world.stubs.script("_claude", { exitCode: 1 });
    const herdr = await fakeHerdr(t, world, { fail: ["tab.close"] });
    const server = await t.start(world, { herdr });

    const started = await server.http.post("/api/conversations", { title: "Doomed" });
    expect(started.status).toBe(201);
    const view = started.json<{ conversation: { id: string; status: string } }>().conversation;
    expect(view.status).toBe("crashed");
    const failed = await until(
      () => readEvents(world.pool, view.id).filter((e) => e.kind === "tab-close-failed"),
      (events) => events.length > 0,
      { ms: 30_000, what: `the refused close on ${view.id}'s events` },
    );
    const tabId = String(failed[0]!.payload.tab_id);
    expect(tabId).toBe(spawnedTerminal(world, view.id).tabId);
    expect(failed.map((e) => e.payload)).toEqual([
      { tab_id: tabId, error: `tab.close failed: {"code":-32000,"message":"tab.close refused"}` },
    ]);
    // The line joins the pool log without a snapshot of its own; the next
    // one carries it (NOT-PORTED.md, `herdr` panes).
    await publish(server);
    expect(await poolLog(server)).toContain(
      `${view.id}: herdr tab ${tabId} could not be closed (tab.close failed: {"code":-32000,"message":"tab.close refused"})`,
    );
  },
);

// engine/keep-talking.test.ts:510
conformance(
  "herdr",
  "Finished terminals (issue #139) › never counts a Held pane, a Live attempt's pane or a Continued attempt's",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Talk it through")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    const typed = await awaitPrompt(herdr, "01");

    // Live.
    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    // Held.
    await Bun.write(typed.outcomePath, JSON.stringify(CHECKPOINT));
    await untilHeld(server, "01");
    expect(await finishedNow(server)).toBe(0);
    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    // Continued.
    expect((await server.http.post("/api/keep-talking", { ticketId: "01" })).status).toBe(202);
    await untilSnapshot(server, (snap) => ticketIn(snap, "01").liveAttempt?.attempt === 2, "the Continued attempt live");
    expect(await finishedNow(server)).toBe(0);
    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);
  },
);

// engine/keep-talking.test.ts:520
conformance("herdr", "Finished terminals (issue #139) › refuses the bulk close in a headless pool", async (t) => {
  const world = t.world({
    tickets: [readyTicket("01", "Headless")],
    config: { defaults: TERMINAL_CONFIG.defaults },
  });
  const server = await t.start(world);
  await until(() => readMarkers(world.pool)["01"]?.status, (status) => status === "done", { ms: 30_000, what: "01 done" });
  expect(await finishedNow(server)).toBe(0);

  expect(await closeFinished(server)).toEqual({
    status: 409,
    body: { reason: "close finished terminals: the pool is not terminal-backed" },
  });
  const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
  expect(talk.status).toBe(409);
  expect(talk.json<object>()).toEqual({ reason: "keep talking: ticket 01 is in a pool that is not terminal-backed" });
});

// engine/keep-talking.test.ts:734
conformance(
  "herdr",
  "Keep talking review fixes (issue #139) › never counts or closes a finished tab whose agent was enlisted afterwards (review item 2)",
  async (t) => {
    // 01 will open w1:t1 over w1:p1, the fake's first; the operator had
    // enlisted that live agent as enlist-1, which is done.
    const { world } = terminalWorld(t, {
      git: false,
      tickets: [readyTicket("01", "Done and left open"), ticketAt("enlist-1", "done", "enlisted-from=w1:p1")],
    });
    writeEvents(world, "enlist-1", [
      event(1, "spawned", {
        argv: [],
        cwd: world.repo,
        branch: "main",
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        harness: "claude",
      }),
    ]);
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", doneOutcome());
    await until(() => readMarkers(world.pool)["01"]?.status, (status) => status === "done", { ms: 30_000, what: "01 done" });
    expect(spawnedTerminal(world, "01")).toMatchObject({ paneId: "w1:p1", tabId: "w1:t1" });

    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);
  },
);

// engine/keep-talking.test.ts:1032
conformance(
  "herdr",
  "Keep talking review fixes (issue #139) › drops a tab from the Finished terminals count the moment the engine closes it (minor 2)",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [ticketAt("01", "done")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    const client = await t.socket(server, { visible: true });

    const started = await server.http.post("/api/conversations", { title: "Brief" });
    expect(started.status).toBe(201);
    const id = started.json<{ conversation: { id: string } }>().conversation.id;
    // Live, its tab is in use.
    expect(await closedFinished(server)).toBe(0);

    await client.sync();
    const from = client.frames.length;
    expect((await server.http.post("/api/conversations/end", { id })).status).toBe(202);
    // Every snapshot pushed from the End on, up to the one showing it ended
    // with its tab closed, counts nothing: the closed tab never shows as a
    // Finished terminal, not even until the survey's next cadence.
    await until(
      () => client.pushed?.snapshot,
      (snap) => snap?.state.conversations.find((c) => c.id === id)?.status === "ended",
      { ms: 30_000, what: `${id} ended, on the socket` },
    );
    expect(readEvents(world.pool, id).filter((e) => e.kind === "tab-closed").map((e) => e.payload.reason)).toEqual(["end"]);
    const after = builtSnapshots(client).filter(({ at }) => at >= from);
    expect(after.length).toBeGreaterThan(0);
    expect(after.map(({ snapshot }) => snapshot.finishedTerminals)).toEqual(after.map(() => 0));
    expect(await finishedNow(server)).toBe(0);
    expect(await tabCloses(herdr)).toEqual([spawnedTerminal(world, id).tabId]);
  },
  { timeoutMs: 120_000 },
);

// engine/live-attempts.test.ts:84
conformance(
  "herdr",
  "live attempts registry › lists every live Attempt's pane, a fan-out's earlier candidates included (issue #139)",
  async (t) => {
    const { world } = terminalWorld(t, {
      tickets: [readyTicket("01", "Fan out")],
      config: { ...TERMINAL_CONFIG, assign: { "01": { verify: 2 } } },
    });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await Promise.all([awaitPrompt(herdr, "01.attempt-1"), awaitPrompt(herdr, "01.attempt-2")]);

    expect(await closedFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);
  },
);

// engine/herdr.test.ts:560
conformance(
  "herdr",
  "listPanes (issue #139) › reads herdr's tab_not_found as a tab already gone",
  async (t) => {
    const world = bootWorld(t, { tickets: [ticketAt("01", "done")] });
    writeEvents(world, "01", [
      event(1, "spawned", { argv: ["claude"], cwd: world.repo, pane_id: "w1:p1", tab_id: "w1:t1" }),
      event(1, "exited", { code: 0, status: "done" }),
    ]);
    const herdr = await fakeHerdr(t, world);
    await herdr.control("injectPane", "w1:p1", { tabId: "w1:t1", cwd: world.repo });
    await plantWitness(world, herdr);
    const server = await t.start(world, { herdr });
    expect((await untilSurveyed(server)).finishedTerminals).toBe(1);

    // The operator closed it already, as far as herdr is concerned.
    await herdr.control("answerWith", "tab.close", { error: { code: -32000, message: "tab_not_found: w1:t1" } });
    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual(["w1:t1"]);
    const kinds = readEvents(world.pool, "01").map((e) => e.kind);
    expect(kinds).toContain("tab-closed");
    expect(kinds).not.toContain("tab-close-failed");
    expect(readEvents(world.pool, "01").find((e) => e.kind === "tab-closed")!.payload).toEqual({
      tab_id: "w1:t1",
      reason: "finished terminals closed",
    });
    expect((await poolLog(server)).some((line) => line.includes("could not be closed"))).toBe(false);
    expect(await poolLog(server)).toContain("closed 1 finished terminal");
    expect(await finishedNow(server)).toBe(0);
  },
);
