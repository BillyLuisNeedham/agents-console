/**
 * Terminal-backed Attempts across a stop and start, seen from outside the
 * server (ADR-0036, ADR-0014): what a server booting on a pool does with an
 * Attempt the last server left running in a herdr pane. A pane still listed
 * is re-adopted, and its exit is decided from what the pane left on disk; a
 * pane gone crashes the Attempt and the Ticket runs again; an Attempt that
 * cannot be re-entered keeps the headless orphan fate. Ticket C05 of the
 * inventory's split (docs/research/rust-port/test-inventory.md): each case
 * names the engine test it carries over, or the uncovered behaviour it pins.
 *
 * The fake herdr runs beside the servers for the whole case, as a live
 * daemon outlives a Restart, and keeps a pane open after its wrapper exits
 * (`holdPane`), as a real pane keeps its shell. A stub launched in a pane
 * reads its prompt there and is held across the stop until the case lets it
 * go, which is how its TUI exits while no server runs. A case that boots on
 * a record a dead server left seeds the events file as the engine writes it
 * and the orphan pane on the fake, and starts one server in the launch
 * workspace the fake holds.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, TicketEvent } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { ticketWorktree } from "../harness/git-pool.ts";
import { callsOf, CLAUDE_READY, OPENCODE_READY, OPENCODE_WAITING, type HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readMarkers, readTicketFile, until } from "../harness/pool-files.ts";
import type { StubHold } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import {
  ENGINE_RESET_NOTE,
  TERMINAL,
  approveReview,
  eventLine,
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

/** The fake herdr's options: claude's ready frame, and panes that outlive their wrapper. */
const HERDR = { rendered: CLAUDE_READY, holdPane: true };

/** The workspace a seeded pool's server is launched in (HERDR_WORKSPACE_ID), which the fake holds. */
const LAUNCH = "w-launch";

/** The body every Ticket here is seeded with: its title is its id. */
const BODY = "# 01\n\nWork on 01.";

/** Ticket `id` on a snapshot. */
function cardOf(snapshot: EnrichedSnapshot, id: string) {
  const card = snapshot.state.tickets.find((each) => each.id === id);
  if (!card) throw new Error(`no Ticket ${id} in the snapshot`);
  return card;
}

/**
 * Wait until Ticket `id`'s Attempt is live in a pane and its stub has read
 * the prompt typed there (the stub records its launch only then); the pane.
 */
async function liveInPane(server: CaseServer, world: World, id: string): Promise<string> {
  const snapshot = await untilState(server, `${id} live in a pane`, (s) => cardOf(s, id).liveAttempt?.paneId != null, 60_000);
  await until(() => world.stubs.calls().some((call) => call.key === id), (read) => read, {
    what: `${id}'s stub to read its prompt`,
    ms: 60_000,
  });
  return cardOf(snapshot, id).liveAttempt!.paneId!;
}

/**
 * Hold `key`'s launches as `world.stubs.hold` does, and let them go at the
 * teardown if the case failed before it did, so no stub is left waiting.
 */
function holdStub(t: Case, world: World, key: string, behaviour: Parameters<World["stubs"]["hold"]>[1]): StubHold {
  const held = world.stubs.hold(key, behaviour);
  let released = false;
  t.defer(async () => {
    if (!released) await held.release(2_000).catch(() => {});
  });
  return {
    async release(ms) {
      await held.release(ms);
      released = true;
    },
  };
}

/** Wait for a pool file to be there. */
function untilFile(world: World, path: string): Promise<boolean> {
  return until(() => existsSync(join(world.pool, path)), (there) => there, { what: path, ms: 30_000 });
}

/** A Ticket's events of one kind. */
function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** The runs directory's path. */
function runsOf(world: World): string {
  return join(world.pool, "runs");
}

// ---------------------------------------------------------------------------
// A pane the last server left live, its TUI exited while no server ran
// ---------------------------------------------------------------------------

/**
 * Ticket 01 launched in a pane, the server stopped with its stub held there,
 * the stub then let go to play `behaviour` while no server runs, and a new
 * server started once the pane's wrapper has written runs/01.exitcode. The
 * fake herdr's calls from that start on begin at `from`.
 */
async function exitWhileDown(
  t: Case,
  behaviour: Parameters<World["stubs"]["hold"]>[1],
): Promise<{ world: World; herdr: HerdrProcess; second: CaseServer; pane: string; from: number }> {
  const world = t.world({ tickets: [ticket("01", "a", { body: BODY })], config: TERMINAL });
  const herdr = await t.herdr(world, HERDR);
  const held = holdStub(t, world, "01", behaviour);
  const first = await startLeg(t, world, 0, { herdr });
  const pane = await liveInPane(first, world, "01");
  await first.stop();

  await held.release();
  await untilFile(world, "runs/01.exitcode");
  await herdr.settle();
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });
  return { world, herdr, second, pane, from };
}

/**
 * What the boot fast path leaves for an exit with no Outcome: the exited and
 * crash events of attempt 1 with `code` and `reason`, one crash Interrupt
 * naming them, the state line still in-progress with the boot's reset note
 * taken back off, nothing launched again, and no subscription on the daemon,
 * since the exit-code file already on disk decided the ending.
 */
async function expectCrashedAtBoot(
  run: { world: World; herdr: HerdrProcess; second: CaseServer; pane: string; from: number },
  code: number,
  reason: string,
): Promise<void> {
  const { world, herdr, second, pane, from } = run;
  const crashed = await settle(second, "01's crash", quiescentWith("01:crash"));
  const runs = runsOf(world);
  const [interrupt] = crashed.state.interrupts;
  expect(interrupt!.body.startsWith(`crash: ${reason}\n${runs}/01.log\n\n`)).toBe(true);
  expect(interrupt!.body.endsWith(`outcome file: ${runs}/01.outcome.json (missing)\n`)).toBe(true);
  expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 exited", "1 crash"]);
  expect(eventsOf(world, "01", "exited")[0]!.payload).toMatchObject({ code, status: "in-progress", outcomeExists: false });
  expect(eventsOf(world, "01", "crash")[0]!.payload).toMatchObject({ code, reason, outcomeExists: false });
  expect(Array.isArray(eventsOf(world, "01", "crash")[0]!.payload.logTail)).toBe(true);
  expect(cardOf(crashed, "01")).toMatchObject({ status: "in-progress", liveAttempt: null });
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "in-progress")}\n\n${BODY}\n`);
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01"]);

  await herdr.settle();
  expect(callsOf(herdr, "events.subscribe", from)).toEqual([]);
  expect(callsOf(herdr, "tab.create", from)).toEqual([]);
  expect(callsOf(herdr, "pane.close", from)).toEqual([]);
  // Re-adopted, then over: its agent reported working again, then released.
  expect(callsOf(herdr, "pane.report_agent", from).map((call) => call.params.pane_id)).toEqual([pane]);
  await herdr.waitForCall((call) => call.method === "pane.release_agent" && call.params.pane_id === pane, {
    from,
    ms: 30_000,
  });
}

// engine/attempt-ending.test.ts:248
restartCase("a re-adopted Attempt whose TUI exited 0 with no Outcome while no server ran crashes at boot, never subscribing", async (t) => {
  const run = await exitWhileDown(t, { status: "keep" });
  await expectCrashedAtBoot(run, 0, "no outcome written");
});

// engine/attempt-ending.test.ts:390
restartCase("a re-adopted Attempt whose TUI exited 7 while no server ran is decided from its exit-code file alone", async (t) => {
  const run = await exitWhileDown(t, { status: "keep", exitCode: 7 });
  await expectCrashedAtBoot(run, 7, "harness exited 7");
});

// engine/attempt-ending.test.ts:405
restartCase("a re-adopted Attempt whose TUI wrote a done Outcome while no server ran ends clean at boot and merges", async (t) => {
  // Two Tickets in one super-step, so each Attempt works in a worktree of
  // its own and its done ending has a branch to merge.
  const world = t.world({
    tickets: [ticket("01", "a", { body: BODY }), ticket("02", "b", { body: "# 02\n\nWork on 02." })],
    config: TERMINAL,
  });
  const herdr = await t.herdr(world, HERDR);
  const held = ["01", "02"].map((id) =>
    holdStub(t, world, id, { status: "done", work: { file: `from-${id}.txt`, line: `${id} was here`, message: `${id}'s work` } }),
  );
  const first = await startLeg(t, world, 0, { herdr });
  const panes = [await liveInPane(first, world, "01"), await liveInPane(first, world, "02")];
  await first.stop();

  for (const each of held) await each.release();
  await untilFile(world, "runs/01.exitcode");
  await untilFile(world, "runs/02.exitcode");
  await herdr.settle();
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });
  const review = await settle(second, "both merged and the Review raised", quiescentWith("REVIEW:review"));

  for (const [i, id] of ["01", "02"].entries()) {
    expect(cardOf(review, id)).toMatchObject({ status: "done", mergeState: null, liveAttempt: null });
    // The merged attempt's tab closes after the merge; on Bun its event lands 200 to 400 ms later, so
    // the case waits for it rather than reading in that gap (NOT-PORTED.md, restart).
    await until(() => eventLine(world, id), (lines) => lines.includes("1 tab-closed"), { what: `${id}'s tab-closed` });
    expect(eventLine(world, id)).toEqual(["1 scheduled", "1 spawned", "1 exited", "1 merged", "1 tab-closed"]);
    expect(eventsOf(world, id, "exited")[0]!.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
    expect(review.state.outcomes[id]).toEqual({ status: "done", summary: `summary-${id}`, commitSha: null });
    expect(callsOf(herdr, "pane.report_agent", from).map((call) => call.params.pane_id)).toContain(panes[i]);
    expect(world.git(["show", `main:from-${id}.txt`])).toBe(`${id} was here\n`);
  }
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${BODY}\n`);
  expect(world.stubs.calls().map((call) => call.key).sort()).toEqual(["01", "02"]);
  await herdr.settle();
  expect(callsOf(herdr, "events.subscribe", from)).toEqual([]);
  expect(callsOf(herdr, "tab.create", from)).toEqual([]);
  await approveReview(second);
});

// ---------------------------------------------------------------------------
// A record a dead server left, booted on once
// ---------------------------------------------------------------------------

/** One event as the engine writes it. */
function event(at: string, attempt: number, kind: string, payload: Record<string, unknown>): TicketEvent {
  return { at, attempt, kind, payload } as TicketEvent;
}

/** Write a Ticket's events file whole, one JSON line per event, as the engine appends them. */
function writeEvents(world: World, id: string, events: TicketEvent[]): void {
  mkdirSync(runsOf(world), { recursive: true });
  writeFileSync(join(runsOf(world), `${id}.events.jsonl`), events.map((each) => `${JSON.stringify(each)}\n`).join(""));
}

/**
 * The spawned event's payload for a terminal-backed claude launch in the
 * pool checkout, as the engine records one (engine/attempt-run.ts
 * spawnedPayload) from a herdr that reports no terminal id.
 */
function spawnedInPane(world: World, paneId: string, tabId: string, cwd = world.repo, branch: string | null = null): Record<string, unknown> {
  return {
    argv: ["claude", "--model", "m", "--permission-mode", "auto"],
    cwd,
    branch,
    commitSha: world.git(["rev-parse", "HEAD"]).trim(),
    env: { PWD: cwd },
    harness: "claude",
    model: "m",
    pane_id: paneId,
    tab_id: tabId,
  };
}

/** A terminal-backed pool seeded with Ticket 01 at `status`, and a fake herdr holding the launch workspace. */
async function seededPool(t: Case, status: string): Promise<{ world: World; herdr: HerdrProcess }> {
  const world = t.world({ tickets: [ticket("01", "a", { status, body: BODY })], config: TERMINAL });
  const herdr = await t.herdr(world, { ...HERDR, workspaces: [LAUNCH] });
  return { world, herdr };
}

/** Attempt 1 scheduled and spawned into `paneId`, never exited: what a server that died mid-attempt leaves. */
function orphanedIn(world: World, paneId: string, tabId: string): void {
  writeEvents(world, "01", [
    event("2026-09-05T00:00:00.000Z", 1, "scheduled", {}),
    event("2026-09-05T00:00:01.000Z", 1, "spawned", spawnedInPane(world, paneId, tabId)),
  ]);
}

/** Start the server in the launch workspace. */
function startInLaunch(t: Case, world: World, herdr: HerdrProcess): Promise<CaseServer> {
  return t.start(world, { herdr, env: { HERDR_WORKSPACE_ID: LAUNCH } });
}

/** The adoption checkpoint's body for attempt 1 in `paneId`, word for word. */
function adoptionBody(paneId: string): string {
  return (
    "The engine restarted while this ticket's terminal-backed attempt 1 was still running in herdr pane " +
    `${paneId}. The pane proved live at boot, so the engine re-adopted the attempt and is waiting on the ` +
    "pane's exit; the attempt's real outcome will be recorded then. Answering this interrupt abandons the " +
    "attempt (the pane is closed) and re-runs the ticket."
  );
}

// engine/engine.test.ts:6228
conformance("restart", "a live orphan pane of a resolver's Attempt keeps the headless orphan fate, and its agent is released", async (t) => {
  const { world, herdr } = await seededPool(t, "ready");
  const { path, branch } = ticketWorktree(world.repo, "01");
  writeEvents(world, "01", [
    event("2026-09-05T00:00:00.000Z", 1, "spawned", spawnedInPane(world, "pane-ghost", "tab-ghost", path, branch)),
    event("2026-09-05T00:00:01.000Z", 1, "resolver", { files: ["shared.txt"], cwd: path, branch }),
  ]);
  await herdr.control("injectPane", "pane-ghost", { tabId: "tab-ghost", cwd: path });
  const server = await startInLaunch(t, world, herdr);

  await untilLogged(server, "ticket 01: orphaned terminal attempt 1 kept the headless orphan fate (engine-run or verify attempt)");
  const release = await herdr.waitForCall(
    (call) => call.method === "pane.release_agent" && call.params.pane_id === "pane-ghost",
    { ms: 30_000 },
  );
  expect(release.params).toEqual({ pane_id: "pane-ghost", source: "herdr:agent-console", agent: "claude" });
  const done = await approveReview(server);

  // Not adopted: 01 ran again as attempt 2 in a tab of its own, and the
  // orphan's pane was never reported, typed into or closed.
  expect(cardOf(done, "01").status).toBe("done");
  expect(eventLine(world, "01")).toEqual(["1 spawned", "1 resolver", "2 scheduled", "2 spawned", "2 exited"]);
  expect(eventsOf(world, "01", "spawned")[1]!.payload.pane_id).toBe(`${LAUNCH}:p1`);
  await herdr.settle();
  const onGhost = herdr.calls.filter((call) => call.params.pane_id === "pane-ghost").map((call) => call.method);
  expect(onGhost.filter((method) => method !== "pane.release_agent" && method !== "pane.read")).toEqual([]);
});

// engine/engine.test.ts:6760
conformance("restart", "an orphan Attempt whose pane is gone at boot crashes on the record, and the Ticket runs again in a new tab", async (t) => {
  const { world, herdr } = await seededPool(t, "in-progress");
  orphanedIn(world, "pane-orphan", "tab-orphan");
  const server = await startInLaunch(t, world, herdr);

  const done = await approveReview(server);
  expect(cardOf(done, "01").status).toBe("done");
  expect(await poolLog(server)).toContain("ticket 01: attempt 1's pane is gone at boot; the attempt crashed and the ticket re-runs");
  expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 crash", "2 scheduled", "2 spawned", "2 exited"]);
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({
    code: null,
    reason: "attempt pane gone at boot reconciliation",
    logTail: [],
    outcomeExists: false,
  });
  expect(eventsOf(world, "01", "spawned").map((each) => each.payload.pane_id)).toEqual(["pane-orphan", `${LAUNCH}:p1`]);
  expect(eventsOf(world, "01", "exited")[0]!.payload).toMatchObject({ code: 0, status: "done" });
  // The boot put 01 back to ready with the engine's note, and the run that
  // followed took it to done.
  expectSameBytes(
    readTicketFile(world.pool, "01-a.md"),
    `${stateLine("01", "done")}\n\n${BODY}\n` + ENGINE_RESET_NOTE,
  );
});

// engine/engine.test.ts:6813
conformance("restart", "a live orphan pane is re-adopted at boot without a new tab, and its exit lands when the pane ends", async (t) => {
  const { world, herdr } = await seededPool(t, "in-progress");
  orphanedIn(world, "pane-ghost", "tab-ghost");
  await herdr.control("injectPane", "pane-ghost", { tabId: "tab-ghost", cwd: world.repo });
  const server = await startInLaunch(t, world, herdr);

  const adopted = await settle(server, "the adoption checkpoint", quiescentWith("01:checkpoint"));
  expect(adopted.state.interrupts).toEqual([{ ticketId: "01", kind: "checkpoint", body: adoptionBody("pane-ghost") }]);
  expect(cardOf(adopted, "01")).toMatchObject({ status: "in-progress", liveAttempt: { attempt: 1, paneId: "pane-ghost" } });
  // The boot's reset note is taken back off: the file is as the dead server left it.
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "in-progress")}\n\n${BODY}\n`);
  const report = await herdr.waitForCall(
    (call) => call.method === "pane.report_agent" && call.params.pane_id === "pane-ghost",
    { ms: 30_000 },
  );
  expect(report.params).toMatchObject({
    pane_id: "pane-ghost",
    source: "herdr:agent-console",
    agent: "claude",
    state: "working",
    message: "01 · 01",
  });

  // The pane's TUI finishes: its Outcome, then the wrapper's exit code, then the pane's end.
  writeFileSync(join(runsOf(world), "01.outcome.json"), JSON.stringify({ status: "done", summary: "adopted", commitSha: null }));
  writeFileSync(join(runsOf(world), "01.exitcode"), "0\n");
  await herdr.control("endPane", "pane-ghost");
  const review = await settle(server, "01 done and the Review raised", quiescentWith("REVIEW:review"));
  expect(cardOf(review, "01")).toMatchObject({ status: "done", liveAttempt: null });
  expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 exited"]);
  expect(eventsOf(world, "01", "exited")[0]!.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
  expect(review.state.outcomes["01"]).toEqual({ status: "done", summary: "adopted", commitSha: null });
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${BODY}\n`);
  await herdr.settle();
  expect(callsOf(herdr, "tab.create")).toEqual([]);
  expect(world.stubs.calls()).toEqual([]);
});

// engine/engine.test.ts:6896
conformance("restart", "answering the adoption checkpoint closes the re-adopted pane and runs the Ticket again", async (t) => {
  const { world, herdr } = await seededPool(t, "in-progress");
  orphanedIn(world, "pane-ghost", "tab-ghost");
  await herdr.control("injectPane", "pane-ghost", { tabId: "tab-ghost", cwd: world.repo });
  const server = await startInLaunch(t, world, herdr);
  await settle(server, "the adoption checkpoint", quiescentWith("01:checkpoint"));

  const answered = await server.http.post("/api/resume", { ticketId: "01" });
  expect(answered.status).toBe(202);
  const review = await settle(server, "01 run again to done", quiescentWith("REVIEW:review"));
  expect(cardOf(review, "01").status).toBe("done");
  expect(await poolLog(server)).toContain(
    "ticket 01: adoption abandoned (interrupt answered); pane pane-ghost closed and the ticket re-runs",
  );
  // Attempt 1 records no exit: the answer owns the Ticket from the abandon on.
  expect(eventsOf(world, "01", "spawned").map((each) => each.payload.pane_id)).toEqual(["pane-ghost", `${LAUNCH}:p1`]);
  expect(eventsOf(world, "01", "exited").map((each) => each.attempt)).toEqual([2]);
  await herdr.settle();
  expect(callsOf(herdr, "pane.close").map((call) => call.params.pane_id)).toEqual(["pane-ghost"]);
  expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 answered", "2 scheduled", "2 spawned", "2 exited"]);
  // The re-adoption took the boot's reset note back off, and the abandon
  // wrote none of its own.
  expectSameBytes(readTicketFile(world.pool, "01-a.md"), `${stateLine("01", "done")}\n\n${BODY}\n`);
});

// ---------------------------------------------------------------------------
// An enlisted Ticket's pane gone while no server ran
// ---------------------------------------------------------------------------

// Gap: engine/engine.ts:3310
restartCase("an enlisted Ticket whose pane went while no server ran is checkpointed at boot, its found branch kept", async (t) => {
  const world = t.world({
    tickets: [{ file: "01.md", marker: stateLine("01", "done") }],
    config: { defaults: { harness: "opencode", model: "m" }, terminal: "herdr" },
  });
  // The operator's own worktree on feature/x, with work on it.
  const found = join(world.root, "enlisted");
  world.git(["worktree", "add", "-q", "-b", "feature/x", found]);
  writeFileSync(join(found, "enlisted.txt"), "work\n");
  world.git(["-C", found, "add", "-A"]);
  world.git(["-C", found, "commit", "-qm", "enlist work"]);
  const head = world.git(["rev-parse", "feature/x"]).trim();
  const herdr = await t.herdr(world, { rendered: OPENCODE_READY });
  const first = await startLeg(t, world, 0, { herdr });
  await herdr.control("seedAgent", {
    paneId: "pane-op",
    agent: "opencode",
    cwd: found,
    title: "OC",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-op",
    workspaceId: "ws-operator",
  });
  const enlisted = await first.http.post("/api/enlist", { becomes: "ticket", paneId: "pane-op", title: "Gone while down", spec: "" });
  expect(enlisted.status).toBe(201);
  await untilState(first, "enlist-1 live in the operator's pane", (s) =>
    s.state.tickets.some((each) => each.id === "enlist-1" && each.liveAttempt?.paneId === "pane-op"),
  );
  const file = readMarkers(world.pool)["enlist-1"]!.file;
  const before = readTicketFile(world.pool, file);
  await first.stop();

  // The operator closes the pane while no server runs.
  await herdr.control("endPane", "pane-op");
  await herdr.settle();
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });
  const parked = await settle(second, "enlist-1's checkpoint", quiescentWith("enlist-1:checkpoint"));

  const brief =
    "The herdr pane this enlisted attempt was running in went away before the agent wrote an Outcome, so the " +
    "attempt is over and the engine did not re-run it blind. The found branch feature/x and the checkout it " +
    "lives in were left exactly where they were. Answer resume to re-run this ticket as an ordinary " +
    "engine-launched attempt, or leave it parked and finish the work by hand.";
  expect(parked.state.interrupts).toEqual([{ ticketId: "enlist-1", kind: "checkpoint", body: brief }]);
  const exited = eventsOf(world, "enlist-1", "exited");
  expect(exited.map((each) => [each.attempt, each.payload])).toEqual([
    [1, { code: -2, status: "checkpoint", logTail: [], outcomeExists: false }],
  ]);
  expect(eventLine(world, "enlist-1").slice(-2)).toEqual(["1 exited", "1 checkpoint"]);
  const [line, ...rest] = before.split("\n");
  expectSameBytes(
    readTicketFile(world.pool, file),
    `${[line!.replace("status=in-progress", "status=checkpoint"), ...rest].join("\n").replace(/\n+$/, "")}\n\n---\n\n## Brief\n\n${brief}\n`,
  );
  // The found branch and its checkout are where they were.
  expect(world.git(["rev-parse", "feature/x"]).trim()).toBe(head);
  expect(existsSync(join(found, "enlisted.txt"))).toBe(true);
  await herdr.settle();
  // The pane was asked after across the whole daemon, and nothing was opened or closed for it.
  expect(callsOf(herdr, "pane.list", from).some((call) => Object.keys(call.params).length === 0)).toBe(true);
  expect(callsOf(herdr, "tab.create", from)).toEqual([]);
  expect(callsOf(herdr, "tab.close", from)).toEqual([]);
  expect(callsOf(herdr, "pane.close", from)).toEqual([]);
});
