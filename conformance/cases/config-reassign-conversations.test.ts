/**
 * Reassign on Tickets a Conversation spawned (issue #156), seen from outside
 * the server (ADR-0036): a Ticket's spawned-by may name a Conversation, whose
 * Assignment its spawns inherit, and a Reassign of one of them is checked
 * against what it inherits. The inventory's ticket C20, area `config`; each
 * case names the engine test it came from.
 *
 * The spawns wait behind Ticket 01 at its checkpoint, which the pool never
 * schedules, so they stay offered for as long as the case runs.
 */

import { expect } from "bun:test";
import type { AssignmentSources, PoolConfig, ReassignResponse } from "../../protocol/wire.ts";
import { conformance, type Case } from "../harness/case.ts";
import { readConsoleJson } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  conversationRecord,
  putReassign,
  restedSnapshot,
  snapshotOf,
  ticket,
  ticketOf,
  writeConfig,
} from "./config-support.ts";

const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };
const CHILD = "conv-9-spawn-1";
const GRANDCHILD = "conv-9-spawn-1-spawn-1";
const ALL_INHERITED: AssignmentSources = {
  harness: "inherited",
  model: "inherited",
  effort: "inherited",
  drivers: "inherited",
};

/** 01 at its checkpoint, an ended Conversation conv-9 on claude/opus at effort
 *  high, its spawn and that spawn's own spawn, both waiting. */
function conversationWorld(t: Case): World {
  return t.world({
    tickets: [
      ticket("01", { status: "checkpoint" }),
      ticket(CHILD, { spawnedBy: "conv-9", blockedBy: ["01"] }),
      ticket(GRANDCHILD, { spawnedBy: CHILD, blockedBy: [CHILD] }),
    ],
    config: DEFAULTS,
    poolFiles: conversationRecord("conv-9", {
      harness: "claude",
      model: "opus",
      effort: "high",
      drivers: "implement tdd",
    }),
  });
}

// engine/reassign.test.ts:415 Reassign on a ticket spawned by a Conversation › offers the child and grandchild, inheriting the Conversation's Assignment
conformance("config", "a Conversation's spawn and its spawn's spawn are offered, each inheriting the Conversation's Assignment", async (t) => {
  const snapshot = await restedSnapshot(await t.start(conversationWorld(t)));

  for (const id of ["01", CHILD, GRANDCHILD]) {
    expect([id, ticketOf(snapshot, id).reassign.eligible, ticketOf(snapshot, id).reassign.reason]).toEqual([id, true, null]);
  }
  for (const id of [CHILD, GRANDCHILD]) {
    expect([id, ticketOf(snapshot, id).reassign.sources]).toEqual([id, ALL_INHERITED]);
    expect([id, ticketOf(snapshot, id).assignment]).toEqual([
      id,
      { harness: "claude", model: "opus", effort: "high", effortApplied: true, drivers: "implement tdd" },
    ]);
  }
  // The Conversation is not a Ticket and has no Ticket row.
  expect(snapshot.state.tickets.map((row) => row.id)).not.toContain("conv-9");
  expect(snapshot.state.conversations.map((conversation) => conversation.id)).toContain("conv-9");
});

// engine/reassign.test.ts:435 Reassign on a ticket spawned by a Conversation › writes the child's assign entry, and the dry run resolves the grandchild from it
conformance("config", "a Reassign of a Conversation's spawn pins exactly its named fields, and the spawn's own spawn inherits them", async (t) => {
  const world = conversationWorld(t);
  const server = await t.start(world);
  await restedSnapshot(server);

  const answer = await putReassign(server, { tickets: [CHILD], fields: { model: "sonnet", effort: "low" } });
  expect(answer.status, answer.text).toBe(200);
  const reassigned = answer.json<ReassignResponse>();

  expect(reassigned.applied).toEqual([CHILD]);
  expect(reassigned.skipped).toEqual([]);
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, assign: { [CHILD]: { model: "sonnet", effort: "low" } } });
  // The answer's snapshot is the one GET /api/state serves from now on.
  for (const snapshot of [reassigned.snapshot, await snapshotOf(server)]) {
    expect(ticketOf(snapshot, CHILD).reassign.sources).toEqual({
      harness: "inherited",
      model: "pinned",
      effort: "pinned",
      drivers: "inherited",
    });
    expect(ticketOf(snapshot, GRANDCHILD).reassign).toMatchObject({ eligible: true, reason: null, sources: ALL_INHERITED });
    expect(ticketOf(snapshot, GRANDCHILD).assignment).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "low",
      effortApplied: true,
      drivers: "implement tdd",
    });
  }
});

// engine/reassign.test.ts:471 Reassign on a ticket spawned by a Conversation › writes the grandchild's assign entry too
conformance("config", "a Reassign of a Conversation's spawn's spawn writes that entry alone", async (t) => {
  const world = conversationWorld(t);
  const server = await t.start(world);
  await restedSnapshot(server);

  const answer = await putReassign(server, { tickets: [GRANDCHILD], fields: { harness: "opencode" } });
  expect(answer.status, answer.text).toBe(200);

  expect(answer.json<ReassignResponse>().applied).toEqual([GRANDCHILD]);
  expect(readConsoleJson(world.pool)).toEqual({ ...DEFAULTS, assign: { [GRANDCHILD]: { harness: "opencode" } } });
});

// engine/reassign.test.ts:487 Reassign on a ticket spawned by a Conversation › applies a write beside a ticket the file already fails to resolve
conformance("config", "a Reassign lands beside a Ticket the file already fails to resolve, which it leaves as it was", async (t) => {
  const world = t.world({
    tickets: [ticket("01", { status: "checkpoint" }), ticket("02", { status: "checkpoint" })],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  await restedSnapshot(server);

  writeConfig(world, { ...DEFAULTS, assign: { "02": { harness: "gemini" } } });
  const answer = await putReassign(server, { tickets: ["01"], fields: { model: "opus" } });
  expect(answer.status, answer.text).toBe(200);

  const { applied, skipped } = answer.json<ReassignResponse>();
  expect({ applied, skipped }).toEqual({ applied: ["01"], skipped: [] });
  expect(readConsoleJson(world.pool)).toEqual({
    ...DEFAULTS,
    assign: { "01": { model: "opus" }, "02": { harness: "gemini" } },
  });
});
