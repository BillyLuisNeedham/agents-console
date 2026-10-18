/**
 * Closing a Line Ticket (ADR-0039), seen from outside the server: `closed` is a verdict the Plan
 * routes like any other. In Factory today `implement.closed -> decide` runs Decide with the halt,
 * and a `closed` with no edge of its own goes to the Finish carrying the reason. A Closed Ticket
 * is never a blocker, so what follows it waits on nothing.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { answer, settle, statuses } from "../harness/pool-run.ts";
import { readStateLine } from "../harness/pool-files.ts";
import { NO_FINDINGS, PASS, SHIP, atCheckpoint, begun, interruptOn, issue, launches, lineOf, lineWorld } from "./line-support.ts";

conformance("line", "closing implement-1 runs decide with the halt, and Close on the Finish hold ends the Line closed", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("implement-1", { status: "checkpoint", brief: "needs a device" });
  world.stubs.script("decide-1", SHIP);
  const server = await t.start(world);
  await begun(server);

  await atCheckpoint(server, "implement-1");
  await answer(server, { ticketId: "implement-1", action: "close" });
  const halted = await atCheckpoint(server, "finish-1");
  expect(statuses(halted)).toEqual({
    "implement-1": "closed",
    "decide-1": "done",
    "finish-1": "checkpoint",
  });
  expect(launches(world)).toEqual(["implement-1", "decide-1"]);
  const decide = issue(world, "decide-1");
  expect(decide).toContain("## Halted upstream\n\nWork upstream halted: implement-1 was closed.");
  expect(decide).toContain('Decide how this pass ends. Work upstream halted (implement-1 was closed). Record "ship"');
  expect(readStateLine(world.pool, "decide-1.md").line).toContain("blocked-by=none");
  expect(interruptOn(halted, "finish-1")).toContain("Work upstream halted: implement-1 was closed.");

  await answer(server, { ticketId: "finish-1", action: "close" });
  const closed = await settle(server, (s) => s.phase === "done", { what: "the run to be done" });
  expect(closed.state.interrupts).toEqual([]);
  expect(statuses(closed)["finish-1"]).toBe("closed");
  expect((await lineOf(server))?.status).toBe("closed");
});

conformance("line", "a closed with no edge of its own reaches the Finish with the reason", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("prove-1", PASS);
  world.stubs.script("review-1", NO_FINDINGS);
  world.stubs.script("decide-1", { status: "checkpoint", brief: "cannot decide" });
  const server = await t.start(world);
  await begun(server);

  await atCheckpoint(server, "decide-1");
  await answer(server, { ticketId: "decide-1", action: "close" });
  const atFinish = await atCheckpoint(server, "finish-1");
  expect(statuses(atFinish)["decide-1"]).toBe("closed");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1"]);
  expect(readStateLine(world.pool, "finish-1.md").line).toContain("id=finish-1 blocked-by=none status=checkpoint node=finish hold");
  expect(interruptOn(atFinish, "finish-1")).toContain("Work upstream halted: decide-1 was closed.");
  expect(atFinish.line?.nodes.find((n) => n.id === "decide")?.parked).toEqual([]);
});
