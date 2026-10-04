/**
 * The pane survey (issue #139), seen from outside the server (ADR-0036): the
 * engine's cached listing of herdr's panes, taken on a fifteen-second cadence
 * and whenever the engine asks for a fresh one, from which the snapshot
 * derives its Held panes and its Finished terminals count. A pane counts as
 * the pool's only while herdr lists it as the engine recorded it, and a
 * listing herdr cannot give changes nothing. Rows of the `herdr` area in the
 * Rust port inventory (docs/research/rust-port/test-inventory.md, ticket
 * C15).
 *
 * Where a case needs a listing at a moment of its own choosing it asks for
 * the bulk close, which lists afresh through the survey before it closes
 * anything and closes nothing a Held pane or a pane listed differently sits
 * in. The cases about the cadence itself wait it out for real.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance, type Case } from "../harness/case.ts";
import { OPENCODE_READY, OPENCODE_WAITING } from "../harness/herdr.ts";
import { answerPrompt, awaitPrompt, readyTicket } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import {
  builtSnapshots,
  CHECKPOINT,
  closedFinished,
  closeFinished,
  fakeHerdr,
  keepTalking,
  quitTui,
  snapshotOf,
  spawnedTerminal,
  tabCloses,
  terminalWorld,
  ticketAt,
  ticketIn,
  untilHeld,
  untilSnapshot,
} from "./herdr-panes-support.ts";

/**
 * Two Tickets in one super-step, in a fake whose panes keep their shell when
 * a TUI exits: 01's TUI quits with no Outcome, leaving a Finished terminal,
 * then 02 checkpoints, and holding its pane lists both afresh.
 */
async function crashedAndHeld(t: Case) {
  const { world, tui } = terminalWorld(t, { tickets: [readyTicket("01", "Crash"), readyTicket("02", "Hold")] });
  const herdr = await fakeHerdr(t, world, { holdPane: true });
  const server = await t.start(world, { herdr });
  await Promise.all([awaitPrompt(herdr, "01", { ms: 60_000 }), awaitPrompt(herdr, "02", { ms: 60_000 })]);
  quitTui(world, tui, "01", 1);
  await untilSnapshot(server, (snap) => ticketIn(snap, "01").liveAttempt === null, "01's attempt to end");
  await answerPrompt(herdr, "02", CHECKPOINT);
  await untilHeld(server, "02");
  const listed = await untilSnapshot(server, (snap) => snap.finishedTerminals === 1, "01's tab counted");
  return { world, herdr, server, listed, crashed: spawnedTerminal(world, "01"), held: ticketIn(listed, "02").heldPane! };
}

/** The survey's own listing: pane.list across the daemon, no workspace named. */
function surveyListing(call: { method: string; params: Record<string, unknown> }): boolean {
  return call.method === "pane.list" && Object.keys(call.params).length === 0;
}

// engine/pane-survey.test.ts:9
conformance(
  "herdr",
  "pane survey › serves the last listing and hands every one to the engine",
  async (t) => {
    const { herdr, server, crashed } = await crashedAndHeld(t);
    const client = await t.socket(server, { visible: true });
    await client.sync();
    expect(client.pushed!.snapshot.finishedTerminals).toBe(1);

    // The operator closes 01's tab from herdr: nothing tells the engine but
    // the survey's next listing, within its cadence, and the snapshot it
    // moves is pushed.
    await herdr.control("closeTab", crashed.tabId);
    await until(() => client.pushed?.snapshot.finishedTerminals, (n) => n === 0, {
      ms: 45_000,
      what: "a snapshot with the count dropped, pushed on the socket",
    });
    expect((await snapshotOf(server)).finishedTerminals).toBe(0);
    expect(await tabCloses(herdr)).toEqual([]);
  },
  { slow: true },
);

/**
 * A daemon that will not list (`fail`, or `answerWith` a malformed
 * answer): the survey's next listing at its cadence changes nothing and
 * pushes nothing, and the bulk close refuses for want of a listing.
 */
async function lastGoodListingStands(t: Case, breakListing: (herdr: Awaited<ReturnType<typeof crashedAndHeld>>["herdr"]) => Promise<unknown>) {
  const { herdr, server, held } = await crashedAndHeld(t);
  const client = await t.socket(server, { visible: true });
  await client.sync();
  const frames = client.frames.length;

  await breakListing(herdr);
  // Every call before the control's answer is in hand, so the listing
  // waited for here is one the daemon could not give.
  await herdr.waitForCall(surveyListing, { from: herdr.calls.length, ms: 45_000 });
  // Queued behind any listing still out, so the cadence's has been read.
  const close = await closeFinished(server);
  expect(close).toEqual({
    status: 409,
    body: { reason: "close finished terminals: the herdr daemon could not list its panes" },
  });

  const after = await snapshotOf(server);
  expect(ticketIn(after, "02").heldPane).toEqual(held);
  expect(after.finishedTerminals).toBe(1);
  await client.sync();
  expect(builtSnapshots(client).filter(({ at }) => at >= frames)).toEqual([]);
  expect(await tabCloses(herdr)).toEqual([]);
}

// engine/pane-survey.test.ts:25
conformance(
  "herdr",
  "pane survey › keeps the last good listing when the daemon cannot answer, and says nothing",
  (t) => lastGoodListingStands(t, (herdr) => herdr.control("fail", "pane.list", true)),
  { slow: true },
);

// engine/herdr.test.ts:497
conformance(
  "herdr",
  "listPanes (issue #139) › throws on an answer with no panes list rather than reading it as none (review item 8)",
  (t) => lastGoodListingStands(t, (herdr) => herdr.control("answerWith", "pane.list", { result: { type: "ok" } })),
  { slow: true },
);

// engine/pane-survey.test.ts:102
conformance(
  "herdr",
  "listedAsRecorded › holds a pane only as it was recorded",
  async (t) => {
    // Six Tickets held at their checkpoints, each pane then listed its own
    // way, with no terminal id to settle it.
    const ids = ["01", "02", "03", "04", "05", "06"];
    const { world } = terminalWorld(t, { tickets: ids.map((id) => readyTicket(id, `Held ${id}`)) });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await Promise.all(ids.map((id) => answerPrompt(herdr, id, CHECKPOINT, { ms: 60_000 })));
    for (const id of ids) await untilHeld(server, id, 60_000);
    const pane = (id: string) => spawnedTerminal(world, id).paneId;

    // Every field it reports agrees; it reports none: the pane recorded.
    await herdr.control("relistPane", pane("01"), { terminalId: null });
    await herdr.control("relistPane", pane("02"), { tabId: null, workspaceId: null, cwd: null, terminalId: null });
    // Another tab, outside the Pool workspace, another directory, gone.
    await herdr.control("relistPane", pane("03"), { terminalId: null, tabId: "w1:t-other" });
    await herdr.control("relistPane", pane("04"), { terminalId: null, workspaceId: "w-other" });
    await herdr.control("relistPane", pane("05"), { terminalId: null, cwd: world.root });
    await herdr.control("closeTab", spawnedTerminal(world, "06").tabId);
    expect(await closedFinished(server)).toBe(0);

    const after = await snapshotOf(server);
    expect(ids.map((id) => ticketIn(after, id).heldPane)).toEqual([
      { attempt: 1, paneId: pane("01") },
      { attempt: 1, paneId: pane("02") },
      null,
      null,
      null,
      null,
    ]);
    for (const id of ids) {
      expect(after.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint")).toBe(true);
    }
    const talk = await keepTalking(server, "03");
    expect(talk.status).toBe(409);
    expect(talk.json<object>()).toEqual({ reason: "keep talking: ticket 03 has no terminal left to continue in" });
    // A pane let go stays let go: listed as recorded again, 03's is no Held
    // pane but a Finished terminal, and the bulk close closes its tab.
    const recorded03 = readEvents(world.pool, "03").find((e) => e.kind === "spawned")!.payload;
    await herdr.control("relistPane", pane("03"), {
      tabId: String(recorded03.tab_id),
      terminalId: String(recorded03.terminal_id),
    });
    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual([String(recorded03.tab_id)]);
    expect(ticketIn(await snapshotOf(server), "03").heldPane).toBeNull();

    // An enlisted Ticket's pane is the operator's, wherever they keep it:
    // listed outside the Pool workspace, it is still held.
    const enlisted = t.world({
      config: { defaults: { harness: "opencode", model: "m" }, terminal: "herdr" },
      tickets: [ticketAt("01", "done")],
    });
    const worktree = join(enlisted.root, "found");
    enlisted.git(["worktree", "add", "-q", "-b", "feature/x", worktree]);
    const herdrB = await t.herdr(enlisted, { rendered: OPENCODE_READY });
    await herdrB.control("seedAgent", {
      paneId: "pane-op",
      agent: "opencode",
      cwd: worktree,
      title: "OC",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-op",
      workspaceId: "ws-operator",
    });
    const serverB = await t.start(enlisted, { herdr: herdrB });
    const res = await serverB.http.post("/api/enlist", { becomes: "ticket", paneId: "pane-op", title: "Theirs", spec: "" });
    expect(res.status).toBe(201);
    writeFileSync(join(enlisted.pool, "runs", "enlist-1.outcome.json"), JSON.stringify(CHECKPOINT));
    expect(await untilHeld(serverB, "enlist-1", 45_000)).toEqual({ attempt: 1, paneId: "pane-op" });
    expect(await closedFinished(serverB)).toBe(0);
    expect(ticketIn(await snapshotOf(serverB), "enlist-1").heldPane).toEqual({ attempt: 1, paneId: "pane-op" });
  },
  { timeoutMs: 180_000 },
);

// engine/pane-survey.test.ts:116
conformance(
  "herdr",
  "listedAsRecorded › requires herdr's terminal id to match where both sides carry one",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Another terminal"), readyTicket("02", "No terminal id")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await Promise.all(["01", "02"].map((id) => answerPrompt(herdr, id, CHECKPOINT, { ms: 60_000 })));
    for (const id of ["01", "02"]) await untilHeld(server, id);
    expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned")!.payload.terminal_id).toMatch(/^term-/);

    // The same pane and tab ids over another terminal: not ours. Listed
    // with no terminal id: the tab and directory agree, so it is.
    await herdr.control("relistPane", spawnedTerminal(world, "01").paneId, { terminalId: "term-9" });
    await herdr.control("relistPane", spawnedTerminal(world, "02").paneId, { terminalId: null });
    expect(await closedFinished(server)).toBe(0);
    const after = await snapshotOf(server);
    expect(ticketIn(after, "01").heldPane).toBeNull();
    expect(ticketIn(after, "02").heldPane).toEqual({ attempt: 1, paneId: spawnedTerminal(world, "02").paneId });
  },
  { timeoutMs: 120_000 },
);

// engine/pane-survey.test.ts:129
conformance(
  "herdr",
  "listedAsRecorded › takes a terminal id match as ours on its own, a tab moved to another workspace included",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Moved")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await answerPrompt(herdr, "01", CHECKPOINT);
    const held = await untilHeld(server, "01");

    // Its terminal id as recorded, in another tab, workspace and directory.
    await herdr.control("relistPane", held.paneId, { tabId: "w9:t9", workspaceId: "w9", cwd: world.root });
    expect(await closedFinished(server)).toBe(0);
    expect(ticketIn(await snapshotOf(server), "01").heldPane).toEqual(held);
    const talk = await keepTalking(server, "01");
    expect(talk.status).toBe(202);
    expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 2)!.payload.pane_id).toBe(held.paneId);
  },
);

// engine/herdr.test.ts:483
conformance(
  "herdr",
  "listPanes (issue #139) › reads each pane's tab, workspace, directory and terminal id",
  async (t) => {
    const { world, herdr, server, crashed } = await crashedAndHeld(t);
    const spawned = readEvents(world.pool, "01").find((e) => e.kind === "spawned")!.payload;
    const recorded = {
      tabId: String(spawned.tab_id),
      workspaceId: "w1",
      cwd: String(spawned.cwd),
      terminalId: String(spawned.terminal_id),
    };
    // Listed as recorded, every field reported: counted (crashedAndHeld).
    expect(recorded.terminalId).toMatch(/^term-/);

    for (const listing of [
      { ...recorded, terminalId: "term-other" },
      { ...recorded, terminalId: null, tabId: "w1:t-other" },
      { ...recorded, terminalId: null, workspaceId: "w-other" },
      { ...recorded, terminalId: null, cwd: world.root },
    ]) {
      await herdr.control("relistPane", crashed.paneId, listing);
      expect(await closedFinished(server)).toBe(0);
      expect((await snapshotOf(server)).finishedTerminals).toBe(0);
    }
    await herdr.control("relistPane", crashed.paneId, recorded);
    expect(await closedFinished(server)).toBe(1);
    expect(await tabCloses(herdr)).toEqual([crashed.tabId]);
  },
  { timeoutMs: 120_000 },
);

// engine/herdr.test.ts:513
conformance(
  "herdr",
  "listPanes (issue #139) › takes the root pane's terminal id off a tab.create answer that carries one",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Terminal id")] });
    const herdr = await fakeHerdr(t, world);
    await t.start(world, { herdr });
    // The fake's tab.create answers with root_pane.terminal_id, term-1 for
    // its first tab.
    await awaitPrompt(herdr, "01");
    expect(readEvents(world.pool, "01").find((e) => e.kind === "spawned")!.payload).toMatchObject({
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      terminal_id: "term-1",
    });
  },
);
