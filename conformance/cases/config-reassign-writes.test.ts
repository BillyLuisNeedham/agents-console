/**
 * What a Reassign puts in console.json (issue #126), seen from outside the
 * server (ADR-0036): PUT /api/reassign merges only the named Tickets' named
 * fields into their `assign` entries, leaves everything else in the file as
 * it was, and refuses a request it cannot apply whole with 400 { error },
 * writing nothing. The inventory's ticket C20, area `config`; each case
 * names the engine test it came from.
 *
 * The Tickets wait at their checkpoint, which the pool never schedules, so
 * each stays offered for as long as the case runs. JSON is compared once
 * parsed; "unchanged" is the file's bytes (ADR-0036).
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, ReassignResponse } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  consoleText,
  errorOf,
  putReassign,
  rawConfig,
  restedSnapshot,
  ticket,
  untilInFlight,
} from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const KNOWN = "Known: claude, cursor, opencode";
const ENLISTED = "reassign: ticket 'enlist-1' is enlisted: only harness can be reassigned";

/** A pool whose Tickets all wait at their checkpoint, started and at rest. */
async function waitingPool(
  t: Case,
  config: PoolConfig | null,
  ids: string[] = ["01"],
): Promise<{ world: World; server: CaseServer }> {
  const world = t.world({
    tickets: ids.map((id) => ticket(id, { status: "checkpoint" })),
    ...(config === null ? {} : { config }),
  });
  const server = await t.start(world);
  await restedSnapshot(server);
  return { world, server };
}

/** A terminal-backed pool holding an enlisted Ticket (issue #101), written as
 *  the engine writes one, beside an ordinary Ticket, both at their checkpoint. */
async function enlistedPool(t: Case): Promise<{ world: World; server: CaseServer }> {
  const world = t.world({
    tickets: [
      ticket("01", { status: "checkpoint" }),
      ticket("enlist-1", { status: "checkpoint", extra: "enlisted-from=pane-op" }),
    ],
    config: { ...DEFAULTS, terminal: "herdr" },
  });
  const server = await t.start(world, { herdr: await t.herdr(world) });
  await restedSnapshot(server);
  return { world, server };
}

/** PUT /api/reassign, which must be applied. */
async function applied(server: CaseServer, body: unknown): Promise<ReassignResponse> {
  const answer = await putReassign(server, body);
  expect(answer.status, answer.text).toBe(200);
  return answer.json<ReassignResponse>();
}

/** PUT /api/reassign, which must be refused with 400 and leave console.json's bytes alone. */
async function refused(server: CaseServer, world: World, body: unknown): Promise<string> {
  const before = consoleText(world);
  const answer = await putReassign(server, body);
  expect(answer.status, answer.text).toBe(400);
  expect(consoleText(world)).toBe(before);
  return errorOf(answer);
}

// ---------------------------------------------------------------------------
// What lands in console.json
// ---------------------------------------------------------------------------

// engine/reassign.test.ts:505 writeReassign: what lands in console.json › sets the named tickets' fields and leaves every other entry and key alone
conformance("config", "a Reassign sets the named Ticket's fields and leaves every other entry and key alone", async (t) => {
  const { world, server } = await waitingPool(
    t,
    rawConfig({
      ...DEFAULTS,
      port: 8787,
      assign: { "01": { verify: 2 }, "02": { model: "keep-me" } },
      somethingElse: { kept: true },
    }),
    ["01", "02"],
  );

  const answer = await applied(server, { tickets: ["01"], fields: { harness: "claude", model: "opus" } });

  expect({ applied: answer.applied, skipped: answer.skipped }).toEqual({ applied: ["01"], skipped: [] });
  expect(readConsoleJson(world.pool)).toEqual(
    rawConfig({
      ...DEFAULTS,
      port: 8787,
      assign: { "01": { verify: 2, harness: "claude", model: "opus" }, "02": { model: "keep-me" } },
      somethingElse: { kept: true },
    }),
  );
});

// engine/reassign.test.ts:531 writeReassign: what lands in console.json › leaves a field the request never names, and clears one it names null
conformance("config", "a Reassign leaves a field it does not name and clears one it names null", async (t) => {
  const { world, server } = await waitingPool(t, {
    ...DEFAULTS,
    assign: { "01": { harness: "claude", model: "opus", drivers: "fix" } },
  });

  await applied(server, { tickets: ["01"], fields: { model: null } });

  expect(readConsoleJson(world.pool)!.assign).toEqual({ "01": { harness: "claude", drivers: "fix" } });
});

// engine/reassign.test.ts:546 writeReassign: what lands in console.json › sets, leaves and clears effort tri-state, like model
conformance("config", "a Reassign sets, leaves and clears effort the way it does model, trimming what it sets", async (t) => {
  const { world, server } = await waitingPool(t, { ...DEFAULTS, assign: { "01": { model: "opus" } } }, ["01", "02"]);

  await applied(server, { tickets: ["01", "02"], fields: { effort: " high " } });
  expect(readConsoleJson(world.pool)!.assign).toEqual({ "01": { model: "opus", effort: "high" }, "02": { effort: "high" } });

  // Absent leaves it alone.
  await applied(server, { tickets: ["01"], fields: { model: "sonnet" } });
  expect(readConsoleJson(world.pool)!.assign).toEqual({ "01": { model: "sonnet", effort: "high" }, "02": { effort: "high" } });

  // Null clears it, and an entry left empty goes.
  await applied(server, { tickets: ["01", "02"], fields: { effort: null } });
  expect(readConsoleJson(world.pool)!.assign).toEqual({ "01": { model: "sonnet" } });
});

// engine/reassign.test.ts:567 writeReassign: what lands in console.json › treats an empty string as a clear, the way an empty Pool setting is
conformance("config", "a Reassign takes a blank field as a clear, and drops the entry and the assign key it empties", async (t) => {
  const { world, server } = await waitingPool(t, { ...DEFAULTS, assign: { "01": { drivers: "fix" } } });

  await applied(server, { tickets: ["01"], fields: { drivers: "  " } });

  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
});

// engine/reassign.test.ts:573 writeReassign: what lands in console.json › removes an entry that is left with no fields, and the assign map with it
conformance("config", "a Reassign that empties an entry removes it, and the assign map with it", async (t) => {
  const { world, server } = await waitingPool(t, { ...DEFAULTS, assign: { "01": { model: "opus" } } });

  await applied(server, { tickets: ["01"], fields: { model: null, verify: null } });

  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
});

// engine/reassign.test.ts:585 writeReassign: what lands in console.json › writes a verify, and clears one with null
conformance("config", "a Reassign writes a verify, and clears it with null", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS);

  await applied(server, { tickets: ["01"], fields: { verify: 3 } });
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, assign: { "01": { verify: 3 } } });

  await applied(server, { tickets: ["01"], fields: { verify: null } });
  expect(readConsoleJson(world.pool)).toEqual(DEFAULTS);
});

// engine/reassign.test.ts:594 writeReassign: what lands in console.json › creates console.json for a pool that has none
conformance("config", "a Reassign creates console.json for a pool that has none, holding only the entry", async (t) => {
  const { world, server } = await waitingPool(t, null);
  expect(existsSync(join(world.pool, "console.json"))).toBe(false);

  await applied(server, { tickets: ["01"], fields: { harness: "claude", model: "m" } });

  expect(readConsoleJson(world.pool)).toEqual({ assign: { "01": { harness: "claude", model: "m" } } });
});

// engine/reassign.test.ts:604 writeReassign: what lands in console.json › applies one write to several named tickets
conformance("config", "one Reassign applies the same fields to every Ticket it names", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS, ["01", "02"]);

  const answer = await applied(server, { tickets: ["01", "02"], fields: { model: "opus" } });

  expect(answer.applied).toEqual(["01", "02"]);
  expect(readConsoleJson(world.pool)!.assign).toEqual({ "01": { model: "opus" }, "02": { model: "opus" } });
});

// ---------------------------------------------------------------------------
// Refusals and skips
// ---------------------------------------------------------------------------

// engine/reassign.test.ts:618 writeReassign: refusals and skips › refuses an id the pool does not own, naming it, and writes nothing
conformance("config", "a Reassign naming an id the pool does not own is refused whole, naming it", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS);

  expect(await refused(server, world, { tickets: ["01", "99"], fields: { model: "opus" } })).toBe(
    "reassign: unknown ticket '99'",
  );
});

// engine/reassign.test.ts:630 writeReassign: refusals and skips › refuses a harness this pool does not know, listing the ones it does
conformance("config", "a Reassign onto a harness the pool does not know is refused, listing the ones it does", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS);

  expect(await refused(server, world, { tickets: ["01"], fields: { harness: "gemini" } })).toBe(
    `reassign: harness names unknown harness 'gemini'. ${KNOWN}`,
  );
});

// engine/reassign.test.ts:638 writeReassign: refusals and skips › refuses a verify that is not an integer of at least one
conformance("config", "a Reassign of a verify that is not a whole number of 1 or more is refused, naming it", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS);

  for (const verify of [0, -1, 1.5]) {
    expect(await refused(server, world, { tickets: ["01"], fields: { verify } })).toBe(
      `reassign: verify must be an integer >= 1 or null (got ${verify})`,
    );
  }
});

// engine/reassign.test.ts:651 writeReassign: refusals and skips › refuses a clear that would leave the ticket with no harness, naming it
conformance("config", "a Reassign clearing the only harness a Ticket has is refused, naming the Ticket", async (t) => {
  const { world, server } = await waitingPool(t, { assign: { "01": { harness: "claude", model: "m" } } });

  expect(await refused(server, world, { tickets: ["01"], fields: { harness: null } })).toBe(
    "reassign: ticket '01' would be left with no harness " +
      "(set one, or leave the field alone so it follows the pool defaults)",
  );
});

// engine/reassign.test.ts:660 writeReassign: refusals and skips › refuses a clear that would leave the ticket with no model, naming it
conformance("config", "a Reassign clearing the only model a Ticket has is refused, naming the Ticket", async (t) => {
  const { world, server } = await waitingPool(t, { assign: { "01": { harness: "claude", model: "m" } } });

  expect(await refused(server, world, { tickets: ["01"], fields: { model: null } })).toBe(
    "reassign: ticket '01' would be left with no model " +
      "(set one, or leave the field alone so it follows the pool defaults)",
  );
});

// engine/reassign.test.ts:670 writeReassign: refusals and skips › lets an enlisted ticket take a new harness, and keep its empty model
conformance("config", "an enlisted Ticket takes a harness, its empty model no refusal", async (t) => {
  const { world, server } = await enlistedPool(t);

  const answer = await applied(server, { tickets: ["enlist-1"], fields: { harness: "claude" } });

  expect(answer.applied).toEqual(["enlist-1"]);
  expect(readConsoleJson(world.pool)!.assign).toEqual({ "enlist-1": { harness: "claude" } });
});

// engine/reassign.test.ts:687 writeReassign: refusals and skips › refuses a model, effort, drivers or verify on an enlisted ticket, naming it
conformance("config", "a Reassign of a model, effort, drivers or verify onto an enlisted Ticket is refused, alone or in a bulk write", async (t) => {
  const { world, server } = await enlistedPool(t);

  const fieldsTried: [string, Record<string, unknown>][] = [
    ["model", { model: "opus" }],
    ["effort", { effort: "high" }],
    ["drivers", { drivers: "fix" }],
    ["verify", { verify: 2 }],
  ];
  for (const [field, fields] of fieldsTried) {
    expect(await refused(server, world, { tickets: ["enlist-1"], fields })).toBe(
      `${ENLISTED} (this request names ${field})`,
    );
  }
  // A bulk write that includes it is refused whole, not landed on the others.
  expect(await refused(server, world, { tickets: ["01", "enlist-1"], fields: { model: "opus" } })).toBe(
    `${ENLISTED} (this request names model)`,
  );
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, terminal: "herdr" });
});

// engine/reassign.test.ts:720 writeReassign: refusals and skips › writes nothing when every named ticket was skipped
conformance("config", "a Reassign whose every Ticket has an Attempt in flight is skipped whole and writes nothing", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS });
  world.stubs.hold("01");
  const server = await t.start(world);
  await untilInFlight(server, "01");
  const before = consoleText(world);

  const answer = await applied(server, { tickets: ["01"], fields: { model: "opus" } });

  expect({ applied: answer.applied, skipped: answer.skipped }).toEqual({
    applied: [],
    skipped: [{ id: "01", reason: "an Attempt is running" }],
  });
  expect(consoleText(world)).toBe(before);
});

// engine/reassign.test.ts:732 writeReassign: refusals and skips › refuses an empty or malformed request
conformance("config", "an empty or malformed Reassign is refused, naming what is wrong with it", async (t) => {
  const { world, server } = await waitingPool(t, DEFAULTS);

  expect(await refused(server, world, { tickets: [], fields: { model: "opus" } })).toBe(
    "reassign: name at least one ticket",
  );
  expect(await refused(server, world, { tickets: "01", fields: { model: "opus" } })).toBe(
    "reassign: tickets must be an array of ticket ids",
  );
  expect(await refused(server, world, { tickets: ["01"], fields: "model=opus" })).toBe(
    "reassign: fields must be an object",
  );
});
