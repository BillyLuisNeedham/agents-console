/**
 * A per-item node's copies (ADR-0040), seen from outside the server: `tasks` makes Items in its
 * Outcome, and `build` starts one harness per Item under its cap, each Ticket `build-<pass>.<n>`
 * with its Item in the body. A copy keeps its slot until it ends, a checkpointed one included. With
 * a Merger the next node's Ticket is written once, when every copy has settled and merged, blocked
 * by the copies that ended done; a closed copy is left out of that list and named in the halt.
 * Items count only from a node taught to make them.
 *
 * The stubs on PATH play the Ticket nodes; a held stub is a copy that has not ended.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { answer, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { MOMENT_MS, hasIssue, buildTickets, copiesPlan, copyIds, interruptRaised, makingItems, pieces, untilLaunched } from "./line-copies-support.ts";
import { atCheckpoint, begun, interruptOn, issue, launches, lineOf, lineWorld, nodes } from "./line-support.ts";

conformance("line", "five Items under perItem 2 start two copies, no third while both are live, and the next as a slot frees", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(5)));
  const first = world.stubs.hold("build-1.1");
  const second = world.stubs.hold("build-1.2");
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 2, merger: true }), work: "#1" });

  await untilLaunched(world, ["build-1.1", "build-1.2"]);
  await Bun.sleep(MOMENT_MS);
  expect(launches(world).slice(0, 1)).toEqual(["tasks-1"]);
  expect(launches(world).slice(1).sort()).toEqual(["build-1.1", "build-1.2"]);
  expect(await buildTickets(server)).toEqual(["build-1.1", "build-1.2"]);
  for (const id of copyIds(5).slice(2)) expect(hasIssue(world.pool, id), `${id} is not written yet`).toBe(false);
  expect(readStateLine(world.pool, "build-1.1.md").line).toBe(
    "<!-- state: id=build-1.1 blocked-by=tasks-1 status=in-progress node=build -->",
  );
  expect(readStateLine(world.pool, "build-1.2.md").line).toContain("id=build-1.2 blocked-by=tasks-1 status=in-progress node=build");

  // One copy ends: its slot goes to the next Item, and so on through the queue while the other stays live.
  await first.release();
  await untilLaunched(world, ["build-1.3", "build-1.4", "build-1.5"]);
  expect(launches(world).slice(3)).toEqual(["build-1.3", "build-1.4", "build-1.5"]);
  expect(nodes(await snapshot(server))).toMatchObject(Object.fromEntries(copyIds(5).map((id) => [id, "build"])));
  expect(hasIssue(world.pool, "check-1")).toBe(false);
  await second.release();
});

conformance("line", "the next node's Ticket is written only once the fifth copy has merged, blocked by every copy", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(5)));
  const last = world.stubs.hold("build-1.5");
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 2, merger: true }), work: "#1" });

  await untilLaunched(world, copyIds(5));
  await until(
    () => snapshot(server),
    (snap) => statuses(snap)["build-1.4"] === "done",
    { what: "build-1.4 to be done", ms: 30_000 },
  );
  await Bun.sleep(MOMENT_MS);
  const waiting = await snapshot(server);
  expect(statuses(waiting)).toEqual({
    "tasks-1": "done",
    "build-1.1": "done",
    "build-1.2": "done",
    "build-1.3": "done",
    "build-1.4": "done",
    "build-1.5": "in-progress",
  });
  expect(hasIssue(world.pool, "check-1")).toBe(false);
  expect(launches(world)).not.toContain("check-1");

  await last.release();
  const done = await atCheckpoint(server, "finish-1");
  expect(launches(world).at(-1)).toBe("check-1");
  expect(readStateLine(world.pool, "check-1.md").line).toBe(
    "<!-- state: id=check-1 blocked-by=build-1.1,build-1.2,build-1.3,build-1.4,build-1.5 status=done node=check -->",
  );
  expect(statuses(done)["check-1"]).toBe("done");
  expect(launches(world).filter((key) => key === "check-1")).toHaveLength(1);
});

conformance("line", "a checkpointed copy keeps its slot, so under perItem 2 the rest wait on one slot until it is answered", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(4)));
  world.stubs.launches("build-1.1", [{ status: "checkpoint", brief: "which flag name?" }, {}]);
  const second = world.stubs.hold("build-1.2");
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 2, merger: true }), work: "#1" });

  const parked = await interruptRaised(server, "build-1.1");
  expect(interruptOn(parked, "build-1.1")).toBe("which flag name?");
  await untilLaunched(world, ["build-1.2"]);
  await Bun.sleep(MOMENT_MS);
  // build-1.1 is waiting on the operator and build-1.2 is live: both slots are taken.
  expect(launches(world).slice(1).sort()).toEqual(["build-1.1", "build-1.2"]);
  expect(hasIssue(world.pool, "build-1.3")).toBe(false);

  await second.release();
  await untilLaunched(world, ["build-1.3", "build-1.4"]);
  expect(launches(world).slice(3)).toEqual(["build-1.3", "build-1.4"]);
  await Bun.sleep(MOMENT_MS);
  expect(hasIssue(world.pool, "check-1")).toBe(false);
  expect(statuses(await snapshot(server))["build-1.1"]).toBe("checkpoint");

  await answer(server, { ticketId: "build-1.1", note: "call it --pool" });
  await atCheckpoint(server, "finish-1");
  expect(launches(world).filter((key) => key === "build-1.1")).toHaveLength(2);
  expect(readStateLine(world.pool, "check-1.md").line).toContain("blocked-by=build-1.1,build-1.2,build-1.3,build-1.4 ");
});

conformance("line", "a closed copy is left out of the next Ticket's blocked-by, and the halt names it", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(3)));
  world.stubs.script("build-1.2", { status: "checkpoint", brief: "needs a device" });
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 3, merger: true, closedToCheck: true }), work: "#1" });

  await interruptRaised(server, "build-1.2");
  await Bun.sleep(MOMENT_MS);
  expect(hasIssue(world.pool, "check-1")).toBe(false);
  await answer(server, { ticketId: "build-1.2", action: "close" });
  const done = await atCheckpoint(server, "finish-1");

  const marker = readStateLine(world.pool, "check-1.md");
  expect(marker.blockedBy).toEqual(["build-1.1", "build-1.3"]);
  expect(issue(world, "check-1")).toContain("## Halted upstream\n\nWork upstream halted: build-1.2 was closed.");
  expect(statuses(done)).toMatchObject({ "build-1.1": "done", "build-1.2": "closed", "build-1.3": "done", "check-1": "done" });
});

conformance("line", "a node taught to make Items fans its Outcome's Items out, each copy's body carrying its own", async (t) => {
  const world = lineWorld(t, null);
  const items = pieces(3);
  world.stubs.script("tasks-1", makingItems(items));
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: "all", merger: true }), work: "#1" });

  await atCheckpoint(server, "finish-1");
  expect(launches(world).filter((key) => key.startsWith("build-"))).toHaveLength(3);
  expect(hasIssue(world.pool, "build-1")).toBe(false);
  expect(hasIssue(world.pool, "build-1.4")).toBe(false);
  copyIds(3).forEach((id, i) => {
    const body = issue(world, id);
    expect(body).toContain(`# ${id}: build, pass 1: ${items[i]!.title}\n`);
    expect(body).toContain(`## Your item\n\n### ${items[i]!.title}\n\n${items[i]!.body}`);
    for (const other of items.filter((_, j) => j !== i)) expect(body).not.toContain(other.body);
  });
  // The node that makes Items is taught the field; the node that only consumes them is not.
  expect(issue(world, "tasks-1")).toContain('## Your items\n\nThis node hands its work on as items. Add `"items": [{"title": "...", "body": "..."}]`');
  expect(issue(world, "build-1.1")).not.toContain("## Your items");
  expect((await lineOf(server))?.nodes.find((n) => n.id === "build")).toMatchObject({ passes: 1 });
});

conformance("line", "Items from a node not taught to make them fan nothing out: one copy, no dot", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(3)));
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: "all", merger: true, makesItems: false }), work: "#1" });

  await atCheckpoint(server, "finish-1");
  expect(launches(world)).toEqual(["tasks-1", "build-1", "check-1"]);
  expect(hasIssue(world.pool, "build-1.1")).toBe(false);
  expect(issue(world, "build-1")).not.toContain("## Your item");
  expect(issue(world, "tasks-1")).not.toContain("## Your items");
  expect(readStateLine(world.pool, "check-1.md").line).toContain("blocked-by=build-1 ");
});
