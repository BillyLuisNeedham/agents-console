/**
 * Who may be reassigned (issue #126), seen from outside the server
 * (ADR-0036): the Reassign row every Ticket carries on the snapshot, whether
 * a write would reach it, why not, the layer each field of its Assignment
 * came from, and the Assignment its card shows. The inventory's ticket C20,
 * area `config`; each case names the engine test it came from.
 *
 * A Ticket "waiting" here waits on a Ticket at its checkpoint, which the
 * pool never schedules, so nothing runs under the case and nothing times
 * out. A case that needs an Attempt in flight holds its stub open until the
 * server stops it. The rows are built from console.json as it stands when
 * the snapshot is built, so a case that edits the pool's files by hand reads
 * the edit through `rebuiltSnapshot` (config-support.ts).
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssignmentSources, PoolConfig } from "../../engine/wire.ts";
import { conformance, type Case } from "../harness/case.ts";
import { ticketContent, type TicketSeed, type World } from "../harness/world.ts";
import {
  conversationRecord,
  doneTicket,
  rebuiltSnapshot,
  restedSnapshot,
  ticket,
  ticketOf,
  untilInFlight,
  untilSnapshot,
  writeConfig,
} from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };

/** The engine's own grader and head-to-head Tickets are never offered. */
const ENGINE_RUNS_IT = "the engine runs this one and assigns it from its build ticket";
const ENLISTED_NOTE = "enlisted: only the harness can change, and it waits until the engine releases it";
/** What follows a Ticket's own resolver error in its reason. */
const WHOLE_POOL_HELD = "(the engine keeps the whole pool on its last good config until this resolves)";

/** Sources no layer of the file answered for. */
const NO_SOURCES: AssignmentSources = { harness: "unset", model: "unset", effort: "unset", drivers: "unset" };

/** A Ticket at its checkpoint: offered for Reassign, never scheduled. */
function atCheckpoint(id: string, options: { spawnedBy?: string; extra?: string } = {}): TicketSeed {
  return ticket(id, { ...options, status: "checkpoint" });
}

/** Rewrite a Ticket file under the running server, as a person would. */
function rewriteTicket(world: World, seed: TicketSeed): void {
  writeFileSync(join(world.pool, "issues", seed.file), ticketContent(seed));
}

/** A terminal-backed pool holding an enlisted Ticket (issue #101), written as
 *  the engine writes one, at its checkpoint so the pool never re-runs it. */
function enlistedWorld(t: Case, config: PoolConfig = {}): World {
  return t.world({
    tickets: [
      doneTicket("00"),
      atCheckpoint("01"),
      atCheckpoint("enlist-1", { extra: "enlisted-from=pane-op" }),
    ],
    config: { ...DEFAULTS, terminal: "herdr", ...config },
  });
}

// engine/reassign.test.ts:100 reassignViews: who may be reassigned › offers an ordinary ticket with nothing running, and resolves it from the file
conformance("config", "a waiting Ticket is offered with no reason, its card resolved from console.json as it stands", async (t) => {
  const world = t.world({
    tickets: [doneTicket("00"), atCheckpoint("01"), ticket("02", { blockedBy: ["01"] })],
    config: { ...DEFAULTS, assign: { "02": { model: "opus" } } },
  });
  const server = await t.start(world);
  const booted = ticketOf(await restedSnapshot(server), "02");

  expect(booted.liveAttempt).toBeNull();
  expect(booted.reassign).toMatchObject({ eligible: true, reason: null });
  expect(booted.assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });

  // The card follows the file, not the run: nothing has reloaded it.
  writeConfig(world, { ...DEFAULTS, assign: { "02": { model: "sonnet" } } });
  const edited = ticketOf(await rebuiltSnapshot(server, "00"), "02");
  expect(edited.reassign).toMatchObject({ eligible: true, reason: null });
  expect(edited.assignment).toEqual({ harness: "claude", model: "sonnet", drivers: "implement" });
});

// engine/reassign.test.ts:114 reassignViews: who may be reassigned › names the layer each field came from, not the value it happens to match
conformance("config", "a field's source is the layer that set it, even when its value matches the default", async (t) => {
  const world = t.world({ tickets: [atCheckpoint("01")], config: { ...DEFAULTS, assign: { "01": { model: "m" } } } });
  const row = ticketOf(await restedSnapshot(await t.start(world)), "01");

  expect(row.reassign.sources).toEqual({ harness: "default", model: "pinned", effort: "unset", drivers: "default" });
  expect(row.assignment).toEqual({ harness: "claude", model: "m", drivers: "implement" });
});

// engine/reassign.test.ts:128 reassignViews: who may be reassigned › names the parent as the source of a spawned ticket's inherited fields
conformance("config", "a spawned Ticket's fields read inherited from its parent, drivers too, and effort unset", async (t) => {
  const world = t.world({
    tickets: [atCheckpoint("01"), ticket("01-spawn-1", { spawnedBy: "01", blockedBy: ["01"] })],
    config: { ...DEFAULTS, assign: { "01": { harness: "claude", model: "opus" } } },
  });
  const row = ticketOf(await restedSnapshot(await t.start(world)), "01-spawn-1");

  expect(row.reassign).toMatchObject({ eligible: true, reason: null });
  expect(row.reassign.sources).toEqual({
    harness: "inherited",
    model: "inherited",
    effort: "unset",
    drivers: "inherited",
  });
  expect(row.assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
});

// engine/reassign.test.ts:154 reassignViews: who may be reassigned › names a field the Spawn proposal requested as requested, under a pinned one
conformance("config", "a field the Spawn proposal asked for reads requested, under the operator's own entry", async (t) => {
  const spawnAssign = (assign: Record<string, string>) => `spawn-assign=${encodeURIComponent(JSON.stringify(assign))}`;
  const world = t.world({
    tickets: [
      atCheckpoint("01"),
      ticket("01-spawn-1", { spawnedBy: "01", blockedBy: ["01"], extra: spawnAssign({ model: "sonnet", effort: "max" }) }),
      // An effort asked for with no entry over it: NOT-PORTED.md's formats
      // section saw this read unset; it reads requested.
      ticket("01-spawn-2", { spawnedBy: "01", blockedBy: ["01"], extra: spawnAssign({ effort: "max" }) }),
    ],
    config: {
      ...DEFAULTS,
      assign: { "01": { harness: "claude", model: "opus" }, "01-spawn-1": { effort: "low" } },
    },
  });
  const snapshot = await restedSnapshot(await t.start(world));

  expect(ticketOf(snapshot, "01-spawn-1").reassign.sources).toEqual({
    harness: "inherited",
    model: "requested",
    effort: "pinned",
    drivers: "inherited",
  });
  expect(ticketOf(snapshot, "01-spawn-1").assignment).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "low",
    effortApplied: true,
    drivers: "implement",
  });
  expect(ticketOf(snapshot, "01-spawn-2").reassign.sources).toEqual({
    harness: "inherited",
    model: "inherited",
    effort: "requested",
    drivers: "inherited",
  });
  expect(ticketOf(snapshot, "01-spawn-2").assignment).toMatchObject({ model: "opus", effort: "max" });
});

// engine/reassign.test.ts:187 reassignViews: who may be reassigned › reads an unassigned field as unset, with no defaults to fall back on
conformance("config", "with no defaults and no entry every field reads unset but drivers, which reads default", async (t) => {
  const world = t.world({ tickets: [ticket("01")] });
  const row = ticketOf(await restedSnapshot(await t.start(world)), "01");

  expect(row.reassign.sources).toEqual({ harness: "unset", model: "unset", effort: "unset", drivers: "default" });
});

// engine/reassign.test.ts:197 reassignViews: who may be reassigned › marks an effort not applied where the pool's launch mode cannot take it
conformance("config", "an effort is marked not applied where the pool's launch mode cannot take it, its source unchanged", async (t) => {
  const config: PoolConfig = {
    defaults: { harness: "claude", model: "m", effort: "high" },
    assign: { "02": { harness: "opencode" } },
  };
  const tickets = [atCheckpoint("01"), atCheckpoint("02")];
  const headless = await restedSnapshot(await t.start(t.world({ tickets, config })));
  const terminalWorld = t.world({ tickets, config: { ...config, terminal: "herdr" } });
  const terminal = await restedSnapshot(await t.start(terminalWorld, { herdr: await t.herdr(terminalWorld) }));

  // Headless, both run in batch, where both harnesses take an effort.
  expect(ticketOf(headless, "01").assignment).toMatchObject({ harness: "claude", effort: "high", effortApplied: true });
  expect(ticketOf(headless, "02").assignment).toMatchObject({ harness: "opencode", effort: "high", effortApplied: true });
  expect(ticketOf(headless, "02").reassign.sources.effort).toBe("default");
  // Terminal-backed, opencode's TUI has no effort flag; claude's does.
  expect(ticketOf(terminal, "01").assignment).toMatchObject({ harness: "claude", effort: "high", effortApplied: true });
  expect(ticketOf(terminal, "02").assignment).toMatchObject({ harness: "opencode", effort: "high", effortApplied: false });
  expect(ticketOf(terminal, "02").reassign.sources.effort).toBe("default");
});

// engine/reassign.test.ts:222 reassignViews: who may be reassigned › carries the ticket's own verify, and nothing when the file has none
conformance("config", "a Ticket's row carries its own verify, and null when its entry has none", async (t) => {
  const world = t.world({
    tickets: [atCheckpoint("01"), atCheckpoint("02")],
    config: { ...DEFAULTS, assign: { "01": { verify: 3 } } },
  });
  const snapshot = await restedSnapshot(await t.start(world));

  expect(ticketOf(snapshot, "01").reassign.verify).toBe(3);
  expect(ticketOf(snapshot, "02").reassign.verify).toBeNull();
});

// engine/reassign.test.ts:231 reassignViews: who may be reassigned › refuses the engine's own grader and head-to-head tickets
conformance("config", "the engine's own grader and head-to-head Tickets are refused, their cards the engine's record", async (t) => {
  const world = t.world({
    tickets: [
      atCheckpoint("01"),
      ticket("01-grader-1", { blockedBy: ["01"] }),
      ticket("01-head-to-head", { blockedBy: ["01"] }),
    ],
    config: { ...DEFAULTS, assign: { "01": { harness: "opencode", model: "o3" } } },
  });
  const snapshot = await restedSnapshot(await t.start(world));

  for (const id of ["01-grader-1", "01-head-to-head"]) {
    const row = ticketOf(snapshot, id);
    expect([id, row.reassign.eligible, row.reassign.reason]).toEqual([id, false, ENGINE_RUNS_IT]);
    // What the engine resolved for it from its build Ticket.
    expect([id, row.assignment]).toEqual([id, { harness: "opencode", model: "o3", drivers: "implement" }]);
  }
  expect(ticketOf(snapshot, "01").reassign).toMatchObject({ eligible: true, reason: null });
});

// engine/reassign.test.ts:246 reassignViews: who may be reassigned › refuses a ticket with an Attempt in flight, and keeps the engine's record
conformance("config", "a Ticket with an Attempt in flight is refused, its card the Assignment it launched on through an edit", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: DEFAULTS });
  world.stubs.hold("01");
  const server = await t.start(world);
  await untilInFlight(server, "01");

  writeConfig(world, { ...DEFAULTS, assign: { "01": { model: "other" }, "02": { model: "other" } } });
  const snapshot = await rebuiltSnapshot(server, "01");

  expect(ticketOf(snapshot, "01").reassign).toMatchObject({ eligible: false, reason: "an Attempt is running" });
  expect(ticketOf(snapshot, "01").assignment).toEqual({ harness: "claude", model: "m", drivers: "implement" });
  // The snapshot was built from the edit: 02, waiting, shows it.
  expect(ticketOf(snapshot, "02").assignment.model).toBe("other");
});

// engine/reassign.test.ts:264 reassignViews: who may be reassigned › offers an enlisted ticket with a note rather than refusing it
conformance("config", "an enlisted Ticket is offered with a note, not refused", async (t) => {
  const world = enlistedWorld(t);
  const server = await t.start(world, { herdr: await t.herdr(world) });
  const row = ticketOf(await restedSnapshot(server), "enlist-1");

  expect(row.enlisted).toBe(true);
  expect(row.reassign.eligible).toBe(true);
  expect(row.reassign.reason).toBe(ENLISTED_NOTE);
  // The Bun server serves no layer for an enlisted Ticket's fields: it is
  // seeded frozen from the engine's record, which no layer of the file
  // supplied. The engine test expects harness default and drivers default
  // (conformance/NOT-PORTED.md, C20).
  expect(row.reassign.sources).toEqual(NO_SOURCES);
  expect(row.assignment).toEqual({ harness: "claude", model: null, drivers: "implement" });
});

// engine/reassign.test.ts:280 reassignViews: who may be reassigned › reports no verify on an enlisted ticket even when the file carries one
conformance("config", "an enlisted Ticket reports no verify, whatever its entry says", async (t) => {
  const world = enlistedWorld(t, { assign: { "enlist-1": { verify: 3 } } });
  const server = await t.start(world, { herdr: await t.herdr(world) });

  expect(ticketOf(await restedSnapshot(server), "enlist-1").reassign.verify).toBeNull();
});

// engine/reassign.test.ts:291 reassignViews: who may be reassigned › inherits an in-flight parent's frozen Assignment, not the file's new default
conformance("config", "a spawn of an in-flight parent inherits the parent's frozen Assignment, not the file's new default", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01"),
      ticket("01-spawn-1", { spawnedBy: "01", blockedBy: ["01"] }),
      ticket("02", { blockedBy: ["01"] }),
    ],
    config: { defaults: { harness: "claude", model: "model-a" } },
  });
  world.stubs.hold("01");
  const server = await t.start(world);
  await untilInFlight(server, "01");

  writeConfig(world, { defaults: { harness: "claude", model: "model-b" } });
  const snapshot = await rebuiltSnapshot(server, "01");

  const child = ticketOf(snapshot, "01-spawn-1");
  expect(child.reassign).toMatchObject({ eligible: true, reason: null });
  expect(child.assignment).toEqual({ harness: "claude", model: "model-a", drivers: "implement" });
  expect(child.reassign.sources).toEqual({
    harness: "inherited",
    model: "inherited",
    effort: "unset",
    drivers: "inherited",
  });
  // A Ticket with no parent in flight takes the new default.
  expect(ticketOf(snapshot, "02").assignment.model).toBe("model-b");
});

// engine/reassign.test.ts:318 reassignViews: who may be reassigned › keeps an enlisted ticket's frozen record rather than re-resolving it
conformance("config", "an enlisted Ticket's card keeps the engine's record through an edit naming another harness", async (t) => {
  const world = enlistedWorld(t);
  const server = await t.start(world, { herdr: await t.herdr(world) });
  expect(ticketOf(await restedSnapshot(server), "enlist-1").assignment).toEqual({
    harness: "claude",
    model: null,
    drivers: "implement",
  });

  writeConfig(world, {
    ...DEFAULTS,
    terminal: "herdr",
    assign: { "enlist-1": { harness: "opencode" }, "01": { model: "other" } },
  });
  const snapshot = await rebuiltSnapshot(server, "00");

  expect(ticketOf(snapshot, "enlist-1").assignment).toEqual({ harness: "claude", model: null, drivers: "implement" });
  // The snapshot was built from the edit: 01 shows it.
  expect(ticketOf(snapshot, "01").assignment.model).toBe("other");
});

// engine/reassign.test.ts:334 reassignViews: who may be reassigned › refuses only the ticket the config does not resolve, saying why
conformance("config", "only the Ticket the edited config does not resolve is refused, and its reason says why", async (t) => {
  const world = t.world({ tickets: [doneTicket("00"), atCheckpoint("01"), atCheckpoint("02")], config: DEFAULTS });
  const server = await t.start(world);
  await restedSnapshot(server);

  writeConfig(world, { ...DEFAULTS, assign: { "02": { harness: "gemini" } } });
  const snapshot = await rebuiltSnapshot(server, "00");

  expect(ticketOf(snapshot, "01").reassign).toMatchObject({ eligible: true, reason: null });
  expect(ticketOf(snapshot, "02").reassign).toMatchObject({
    eligible: false,
    reason:
      "the pool config does not resolve: pool config: ticket 02 names unknown harness 'gemini'. " +
      `Known: claude, cursor, opencode ${WHOLE_POOL_HELD}`,
  });
});

// engine/reassign.test.ts:347 reassignViews: who may be reassigned › refuses only a ticket whose parent has no Assignment, naming the parent
conformance("config", "a spawn of a Conversation with no Assignment is refused naming the parent, and its child naming it", async (t) => {
  const world = t.world({
    tickets: [doneTicket("00"), atCheckpoint("01")],
    config: DEFAULTS,
    // A Conversation that names no harness: the engine seeds no Assignment for it.
    poolFiles: conversationRecord("conv-3", { harness: "", model: "" }),
  });
  const server = await t.start(world);
  await restedSnapshot(server);

  // Added by hand: at boot they would stop the pool's load.
  rewriteTicket(world, ticket("conv-3-spawn-1", { spawnedBy: "conv-3", blockedBy: ["01"] }));
  rewriteTicket(world, ticket("conv-3-spawn-1-spawn-1", { spawnedBy: "conv-3-spawn-1", blockedBy: ["01"] }));
  const snapshot = await rebuiltSnapshot(server, "00");

  expect(ticketOf(snapshot, "01").reassign).toMatchObject({ eligible: true, reason: null });
  expect(ticketOf(snapshot, "conv-3-spawn-1").reassign).toMatchObject({
    eligible: false,
    reason: `the pool config does not resolve: pool config: ticket conv-3-spawn-1: parent conv-3 has no Assignment ${WHOLE_POOL_HELD}`,
  });
  expect(ticketOf(snapshot, "conv-3-spawn-1-spawn-1").reassign).toMatchObject({
    eligible: false,
    reason:
      "the pool config does not resolve: pool config: ticket conv-3-spawn-1-spawn-1: " +
      `parent conv-3-spawn-1 did not resolve ${WHOLE_POOL_HELD}`,
  });
});

// engine/reassign.test.ts:371 reassignViews: who may be reassigned › still reports a real spawned-by cycle as a cycle
conformance("config", "Tickets edited into a spawned-by cycle are each refused naming the cycle from themselves", async (t) => {
  const world = t.world({
    tickets: [doneTicket("00"), atCheckpoint("01"), atCheckpoint("a"), atCheckpoint("b")],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  await restedSnapshot(server);

  rewriteTicket(world, atCheckpoint("a", { spawnedBy: "b" }));
  rewriteTicket(world, atCheckpoint("b", { spawnedBy: "a" }));
  const snapshot = await rebuiltSnapshot(server, "00");

  expect(ticketOf(snapshot, "01").reassign).toMatchObject({ eligible: true, reason: null });
  expect(ticketOf(snapshot, "a").reassign).toMatchObject({
    eligible: false,
    reason: `the pool config does not resolve: pool config: ticket a: spawned-by cycle: a -> b -> a ${WHOLE_POOL_HELD}`,
  });
  expect(ticketOf(snapshot, "b").reassign).toMatchObject({
    eligible: false,
    reason: `the pool config does not resolve: pool config: ticket b: spawned-by cycle: b -> a -> b ${WHOLE_POOL_HELD}`,
  });
});

// engine/reassign.test.ts:382 reassignViews: who may be reassigned › refuses every ticket while the config will not parse
conformance("config", "every Ticket is refused while console.json will not parse, the reason carrying the parse error", async (t) => {
  const world = t.world({ tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })], config: DEFAULTS });
  const held = world.stubs.hold("01");
  const server = await t.start(world);
  await untilInFlight(server, "01");

  writeConfig(world, "{ not json");
  await held.release();
  // The engine publishes 01's end, built from the broken file. The parse
  // error is the JSON parser's own words, so only its prefix is pinned.
  const snapshot = await untilSnapshot(server, (s) => ticketOf(s, "01").liveAttempt === null, "01's Attempt to end");

  const prefix = "the pool config does not resolve: ";
  for (const row of snapshot.state.tickets) {
    expect([row.id, row.reassign.eligible]).toEqual([row.id, false]);
    expect(row.reassign.reason).toStartWith(prefix);
    expect(row.reassign.reason!.length).toBeGreaterThan(prefix.length);
    expect([row.id, row.reassign.sources]).toEqual([row.id, NO_SOURCES]);
  }
});
