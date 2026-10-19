/**
 * A Line running Factory today (ADR-0039), seen from outside the server: a stub harness plays each
 * Ticket node, writing its typed verdict in the Outcome, and the engine writes the next node's
 * Ticket under its `{node}-{pass}` id along the Plan's edges. The cases walk the pass path to the
 * Finish hold, a Prove fail round the capped loop, the spent loop's hold buying one traversal
 * across a restart, two loops with the same ends leaving each other's count alone, Decide's
 * another-round up to its cap and the Finish's notes resetting it, the
 * no-verdict checkpoint, and a spawn held inside the Line keeping the Finish waiting.
 */

import { expect } from "bun:test";
import { conformance, type CaseServer } from "../harness/case.ts";
import { answer, settle, statuses, ticketOf } from "../harness/pool-run.ts";
import { readStateLine } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  FAIL,
  NO_FINDINGS,
  PASS,
  SHIP,
  approveFinish,
  atCheckpoint,
  begun,
  deciding,
  interruptOn,
  issue,
  launches,
  lineOf,
  lineWorld,
  nodes,
  passPath,
  verdict,
} from "./line-support.ts";
import { edge, node, plan } from "./plans-support.ts";

/** The prompt a claude launch of `key` carried, `-p` first. */
function promptOf(world: World, key: string): string {
  const call = world.stubs.calls().find((c) => c.key === key);
  if (!call) throw new Error(`no launch of ${key}`);
  expect(call.argv[0]).toBe("-p");
  return call.argv[1]!;
}

/** A capped loop edge of the live graph, by its `from.on`. */
async function loopOf(server: CaseServer, from: string, on: string) {
  return (await lineOf(server))?.edges.find((e) => e.edge.from === from && e.edge.on === on);
}

conformance("line", "the pass path runs implement, prove, review and decide to the Finish hold, which no agent runs, and approval ends the Line", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  world.stubs.script("review-1", verdict({ findings: [{ severity: "nit", title: "Name", detail: "rename x" }] }));
  const server = await t.start(world);
  await begun(server);

  const atFinish = await atCheckpoint(server, "finish-1");
  expect(statuses(atFinish)).toEqual({
    "implement-1": "done",
    "prove-1": "done",
    "review-1": "done",
    "decide-1": "done",
    "finish-1": "checkpoint",
  });
  expect(nodes(atFinish)).toEqual({
    "implement-1": "implement",
    "prove-1": "prove",
    "review-1": "review",
    "decide-1": "decide",
    "finish-1": "finish",
  });
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1"]);
  expect(readStateLine(world.pool, "finish-1.md").line).toBe(
    "<!-- state: id=finish-1 blocked-by=decide-1 status=checkpoint node=finish hold -->",
  );
  expect(interruptOn(atFinish, "finish-1")).toStartWith("The Line has reached its Finish, after `decide-1`.");
  expect(ticketOf(atFinish, "prove-1").assignment).toMatchObject({ harness: "claude", model: "opus", drivers: "my-verify" });
  expect(ticketOf(atFinish, "review-1").assignment).toMatchObject({ drivers: "code-review" });
  expect(ticketOf(atFinish, "decide-1").assignment).toMatchObject({ drivers: "html" });
  expect(readStateLine(world.pool, "prove-1.md").line).toContain("blocked-by=implement-1 status=done node=prove");
  expect(promptOf(world, "prove-1")).toContain("/my-verify ");
  expect(issue(world, "prove-1")).toContain('## Your verdict\n\nThis Ticket runs a Prove node of a Line. Its Outcome must carry a verdict beside status "done": "verdict": {"prove": "pass" or "fail"');
  expect(issue(world, "implement-1")).not.toContain('"verdict"');
  expect(issue(world, "decide-1")).toContain("## Review findings since the last Decide\n\n- [nit] **Name**: rename x (`review-1`)");
  expect(issue(world, "decide-1")).toContain("## Prove since the last Decide\n\n- `prove-1`: pass (evidence `proof/ok.txt`)");
  expect(atFinish.state.outcomes["prove-1"]?.verdict).toEqual({ prove: "pass", evidence: "proof/ok.txt" });
  const finishing = await lineOf(server);
  expect(finishing).toMatchObject({ status: "finishing", waitingFor: [] });
  expect(finishing?.nodes.find((n) => n.id === "finish")?.hold).toBe("finish-1");

  const done = await approveFinish(server, "finish-1");
  expect(statuses(done)["finish-1"]).toBe("done");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1"]);
  expect((await lineOf(server))?.status).toBe("done");
  expect(done.state.log).toContain("line: finish-1 answered open");
});

conformance("line", "a Prove fail sends the work back to implement with Prove's brief, and prove runs again", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  world.stubs.script("prove-1", FAIL);
  world.stubs.script("prove-2", PASS);
  const server = await t.start(world);
  await begun(server);

  await atCheckpoint(server, "finish-1");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "implement-2", "prove-2", "review-1", "decide-1"]);
  const fix = issue(world, "implement-2");
  expect(fix).toContain("# implement-2: Implement, pass 2\n");
  expect(fix).toContain("### Prove `prove-1` failed\n\n");
  expect(fix).toContain("What Prove found:\n\nthe CLI exits 2 on an empty pool\n\nEvidence: `proof/fail.txt`");
  expect(readStateLine(world.pool, "implement-2.md").line).toContain("blocked-by=prove-1 status=done node=implement");
  expect(await loopOf(server, "prove", "fail")).toMatchObject({ count: 1, max: 2, bought: 0 });
  expect(issue(world, "decide-1")).toContain(
    "## Prove since the last Decide\n\n- `prove-1`: fail (evidence `proof/fail.txt`)\n- `prove-2`: pass (evidence `proof/ok.txt`)",
  );
});

conformance("line", "the third Prove fail raises the spent loop's hold, which survives a restart, and a Resume with a note buys one traversal", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  for (const id of ["prove-1", "prove-2", "prove-3"]) world.stubs.script(id, FAIL);
  world.stubs.script("prove-4", PASS);
  const first = await t.start(world);
  await begun(first);

  const spent = await atCheckpoint(first, "prove-fail-implement-3");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "implement-2", "prove-2", "implement-3", "prove-3"]);
  expect(statuses(spent)["prove-fail-implement-3"]).toBe("checkpoint");
  expect(readStateLine(world.pool, "prove-fail-implement-3.md").line).toBe(
    "<!-- state: id=prove-fail-implement-3 blocked-by=prove-3 status=checkpoint node=prove hold -->",
  );
  expect(interruptOn(spent, "prove-fail-implement-3")).toStartWith(
    "The loop prove -> implement is spent (2 of 2); Resume buys one more pass, Close stops it.",
  );
  const before = await lineOf(first);
  expect(before?.edges.find((e) => e.edge.on === "fail")).toMatchObject({
    count: 2,
    max: 2,
    bought: 0,
    hold: "prove-fail-implement-3",
  });

  await first.stop();
  const second = await t.start(world);
  const restored = await atCheckpoint(second, "prove-fail-implement-3");
  expect(await lineOf(second)).toEqual(before);
  expect(interruptOn(restored, "prove-fail-implement-3")).toStartWith("The loop prove -> implement is spent (2 of 2)");
  expect(launches(world)).toHaveLength(6);

  await answer(second, { ticketId: "prove-fail-implement-3", note: "try the other port" });
  await atCheckpoint(second, "finish-1");
  expect(launches(world).slice(6)).toEqual(["implement-4", "prove-4", "review-1", "decide-1"]);
  expect(issue(world, "prove-fail-implement-3")).toContain("## Resume note\n\ntry the other port");
  expect(readStateLine(world.pool, "prove-fail-implement-3.md").line).toContain("status=done node=prove hold");
  expect(issue(world, "implement-4")).toContain("## Notes\n\nThe work came back through a hold answered with these notes: act on them.\n\ntry the other port");
  expect(readStateLine(world.pool, "implement-4.md").line).toContain("blocked-by=prove-3,prove-fail-implement-3");
  expect(await loopOf(second, "prove", "fail")).toMatchObject({ count: 3, max: 2, bought: 1 });
});

conformance("line", "two capped loops with the same ends never reset each other: a closed Prove between fails still leaves the fail loop spent", async (t) => {
  const world = lineWorld(t);
  for (const id of ["prove-1", "prove-2", "prove-4"]) world.stubs.script(id, FAIL);
  world.stubs.script("prove-3", { status: "checkpoint", brief: "the device is gone" });
  const server = await t.start(world);
  const twin = plan(
    [node.agent("implement"), node.prove("prove"), node.finish()],
    [
      edge("implement", "done", "prove"),
      edge("prove", "pass", "finish"),
      edge("prove", "fail", "implement", { max: 2 }),
      edge("prove", "closed", "implement", { max: 1 }),
    ],
  );
  await begun(server, { plan: twin, work: "#1" });

  await atCheckpoint(server, "prove-3");
  await answer(server, { ticketId: "prove-3", action: "close" });
  await atCheckpoint(server, "prove-fail-implement-3");
  expect(launches(world)).toEqual([
    "implement-1", "prove-1", "implement-2", "prove-2", "implement-3", "prove-3", "implement-4", "prove-4",
  ]);
  expect(await loopOf(server, "prove", "fail")).toMatchObject({ count: 2, max: 2, hold: "prove-fail-implement-3" });
  expect(await loopOf(server, "prove", "closed")).toMatchObject({ count: 1, max: 1 });
});

conformance("line", "decide's another-round sends its fixes back to implement up to the loop's cap, then goes to the Finish halted, and notes on the Finish reset the cap", async (t) => {
  const world = lineWorld(t);
  const leak = verdict({ findings: [{ severity: "must", title: "Leak", detail: "the pane leaks" }] });
  const round = { decide: "another-round", fixes: [{ title: "Leak", reason: "a must" }] };
  for (const n of [1, 2, 3, 4]) {
    world.stubs.script(`prove-${n}`, PASS);
    world.stubs.script(`review-${n}`, n === 4 ? NO_FINDINGS : leak);
    world.stubs.script(`decide-${n}`, n === 4 ? SHIP : deciding(round));
  }
  // The first launch records its verdict without the report: the no-verdict checkpoint.
  world.stubs.launches("decide-2", [verdict(round), deciding(round)]);
  const server = await t.start(world);
  await begun(server);

  const unreported = await atCheckpoint(server, "decide-2");
  expect(interruptOn(unreported, "decide-2")).toContain("the report is not at ");
  expect(issue(world, "decide-2")).toContain(
    "No round is left: another-round now goes to finish instead, so record \"ship\", dropping every must with a reason.",
  );
  await answer(server, { ticketId: "decide-2", note: "write the report" });
  const spent = await atCheckpoint(server, "finish-1");
  expect(launches(world)).toEqual([
    "implement-1", "prove-1", "review-1", "decide-1",
    "implement-2", "prove-2", "review-2", "decide-2", "decide-2",
  ]);
  expect(issue(world, "implement-2")).toContain("### Decide `decide-1` chose another round\n\n");
  expect(issue(world, "implement-2")).toContain("- **Leak**: a must\n  the pane leaks (must)");
  expect(readStateLine(world.pool, "implement-2.md").line).toContain("blocked-by=decide-1");
  expect(interruptOn(spent, "finish-1")).toContain("Work upstream halted: the loop decide -> implement is spent (1 of 1).");
  expect(await loopOf(server, "decide", "another-round")).toMatchObject({ count: 1, max: 1 });

  await answer(server, { ticketId: "finish-1", note: "rename the flag to --pool" });
  await atCheckpoint(server, "finish-2");
  expect(launches(world).slice(9)).toEqual([
    "implement-3", "prove-3", "review-3", "decide-3",
    "implement-4", "prove-4", "review-4", "decide-4",
  ]);
  expect(issue(world, "implement-3")).toContain("## Notes\n\nThe work came back through a hold answered with these notes: act on them.\n\nrename the flag to --pool");
  expect(readStateLine(world.pool, "implement-3.md").line).toContain("blocked-by=finish-1");
  expect(issue(world, "decide-3")).toContain("Choose another round");
  const done = await approveFinish(server, "finish-2");
  expect(statuses(done)["finish-1"]).toBe("done");
  expect((await lineOf(server))?.status).toBe("done");
});

conformance("line", "an Outcome with no valid verdict checkpoints its Ticket with no verdict, and a Resume asks for one", async (t) => {
  const world = lineWorld(t);
  world.stubs.launches("prove-1", [{ status: "done" }, PASS]);
  world.stubs.script("review-1", verdict({ findings: [{ severity: "must", title: "Leak", detail: "d" }] }));
  world.stubs.launches("decide-1", [SHIP, deciding({ decide: "ship", dropped: [{ title: "Leak", reason: "out of scope" }] })]);
  const server = await t.start(world);
  await begun(server);

  const prove = await atCheckpoint(server, "prove-1");
  expect(interruptOn(prove, "prove-1")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
  expect(statuses(prove)).toEqual({ "implement-1": "done", "prove-1": "checkpoint" });
  expect(issue(world, "prove-1")).toContain("## Brief\n\nno verdict\n\n");
  await answer(server, { ticketId: "prove-1" });

  const decide = await atCheckpoint(server, "decide-1");
  expect(interruptOn(decide, "decide-1")).toStartWith(
    'no verdict\n\nevery must finding has to be dropped (ship fixes nothing) with a reason; not accounted for: "Leak".',
  );
  await answer(server, { ticketId: "decide-1", note: "drop it, it is out of scope" });

  await atCheckpoint(server, "finish-1");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "prove-1", "review-1", "decide-1", "decide-1"]);
});

conformance("line", "a spawn proposed from inside the Line is held for the operator, the Line routes on, and the Finish waits for it", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  world.stubs.script("implement-1", {
    spawn: [{ title: "Tidy the logs", body: "Tidy the pool log lines the Line writes, they repeat." }],
  });
  const server = await t.start(world);
  await begun(server);

  const waiting = await settle(server, (s) => s.line?.status === "finishing" && s.line.waitingFor.length > 0, {
    what: "the Finish to wait",
  });
  expect(waiting.line?.waitingFor).toEqual(["the Held spawn proposal-1"]);
  expect(waiting.heldSpawns.map((h) => [h.id, h.parentId, h.reason, h.title])).toEqual([
    ["proposal-1", "implement-1", "line", "Tidy the logs"],
  ]);
  expect(waiting.pendingSpawns).toEqual([]);
  expect(statuses(waiting)).toEqual({
    "implement-1": "done",
    "prove-1": "done",
    "review-1": "done",
    "decide-1": "done",
  });
  expect(waiting.state.log).toContain(
    "ticket implement-1: 1 proposal held for the operator: proposed inside the Line (ADR-0037): proposal-1",
  );

  const discarded = await server.http.post("/api/spawns/held/discard", { id: "proposal-1" });
  expect(discarded.status).toBeLessThan(300);
  const atFinish = await atCheckpoint(server, "finish-1");
  expect(atFinish.line?.waitingFor).toEqual([]);
});
