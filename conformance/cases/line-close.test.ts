/**
 * Closing a Line Ticket (ADR-0040), seen from outside the server: `closed` is a verdict the Plan
 * routes like any other. In Factory today `implement.closed -> decide` runs Decide with the halt,
 * and a `closed` with no edge of its own goes to the Finish carrying the reason. A Closed Ticket
 * is never a blocker, so what follows it waits on nothing. A closed loop hold's id is never raised
 * again.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { answer, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { interruptRaised } from "./line-copies-support.ts";
import { FAIL, NO_FINDINGS, PASS, SHIP, atCheckpoint, begun, interruptOn, issue, launches, lineOf, lineWorld } from "./line-support.ts";
import { edge, node, plan } from "./plans-support.ts";

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

for (const node of ["prove", "review"] as const) {
  conformance("line", `closing ${node}-1 runs decide with the halt, whose body and brief name it`, async (t) => {
    const world = lineWorld(t);
    if (node === "review") world.stubs.script("prove-1", PASS);
    world.stubs.script(`${node}-1`, { status: "checkpoint", brief: "cannot judge" });
    world.stubs.script("decide-1", SHIP);
    const server = await t.start(world);
    await begun(server);

    await atCheckpoint(server, `${node}-1`);
    await answer(server, { ticketId: `${node}-1`, action: "close" });
    const halted = await atCheckpoint(server, "finish-1");
    expect(statuses(halted)[`${node}-1`]).toBe("closed");
    expect(statuses(halted)["decide-1"]).toBe("done");
    expect(launches(world)).toEqual(
      node === "prove" ? ["implement-1", "prove-1", "decide-1"] : ["implement-1", "prove-1", "review-1", "decide-1"],
    );
    const decide = issue(world, "decide-1");
    expect(decide).toContain(`## Halted upstream\n\nWork upstream halted: ${node}-1 was closed.`);
    expect(decide).toContain(`Decide how this pass ends. Work upstream halted (${node}-1 was closed). Record "ship"`);
  });
}

conformance("line", "a spent loop spent again after its hold was closed raises a fresh hold, never reading the closed one as its answer", async (t) => {
  const world = lineWorld(t);
  for (const id of ["prove-1", "prove-2", "prove-3"]) world.stubs.script(id, FAIL);
  const again = world.stubs.hold("a-2");
  const server = await t.start(world);
  const twoEntries = plan(
    [node.agent("a"), node.agent("b"), node.prove("prove"), node.finish()],
    [edge("a", "done", "prove"), edge("b", "done", "prove"), edge("prove", "pass", "finish"), edge("prove", "fail", "a", { max: 1 })],
  );
  await begun(server, { plan: twoEntries, work: "#1" });

  await interruptRaised(server, "prove-fail-a-2");
  await answer(server, { ticketId: "prove-fail-a-2", action: "close" });
  await until(
    () => snapshot(server),
    (s) => statuses(s)["prove-fail-a-2"] === "closed",
    { what: "prove-fail-a-2 to close", ms: 30_000 },
  );
  await again.release();

  const spent = await atCheckpoint(server, "prove-fail-a-3");
  expect(statuses(spent)).toMatchObject({ "prove-3": "done", "prove-fail-a-2": "closed", "prove-fail-a-3": "checkpoint" });
  expect(launches(world)).not.toContain("a-3");
});
