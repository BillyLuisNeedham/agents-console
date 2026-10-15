/**
 * The Line's routing (issue #187, ADR-0037), seen from outside the server: a
 * stub harness plays each Station, writing its typed verdict in the Outcome,
 * and the engine writes the next Station Ticket with its readable id. The
 * cases walk the pass path to the Finish, a Prove fail through a fix, the
 * Prove limit and a Resume buying one more fix, Decide starting a Round up to
 * the extra-Rounds limit, the no-verdict checkpoint, a Close halting the
 * Line, spawns held inside a Line, and the Line surviving a restart.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { answer, settle, statuses, ticketOf } from "../harness/pool-run.ts";
import { readStateLine } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  FAIL,
  FINISH,
  NO_FINDINGS,
  PASS,
  approveFinish,
  atCheckpoint,
  finishing,
  launches,
  lineOf,
  lineWorld,
  started,
  stations,
  verdict,
} from "./factory-line-support.ts";

const issue = (world: World, id: string): string => readFileSync(join(world.pool, "issues", `${id}.md`), "utf8");
const interruptOn = (snap: EnrichedSnapshot, id: string): string =>
  snap.state.interrupts.find((i) => i.ticketId === id)?.body ?? "";

/** The prompt a claude launch of `key` carried, `-p` first. */
function promptOf(world: World, key: string): string {
  const call = world.stubs.calls().find((c) => c.key === key);
  if (!call) throw new Error(`no launch of ${key}`);
  expect(call.argv[0]).toBe("-p");
  return call.argv[1]!;
}

conformance("factory", "the pass path runs Implement, Prove, Review and Decide to the Finish checkpoint, and approval ends the Line", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", verdict({ findings: [{ severity: "nit", title: "Name", detail: "rename x" }] }));
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  const atFinish = await atCheckpoint(server, "r1-finish");
  expect(statuses(atFinish)).toEqual({
    "r1-implement": "done",
    "r1-prove": "done",
    "r1-review": "done",
    "r1-decide": "done",
    "r1-finish": "checkpoint",
  });
  expect(stations(atFinish)).toEqual({
    "r1-implement": "implement",
    "r1-prove": "prove",
    "r1-review": "review",
    "r1-decide": "decide",
    "r1-finish": "finish",
  });
  // No agent runs the Finish checkpoint.
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-review", "r1-decide"]);
  expect(interruptOn(atFinish, "r1-finish")).toStartWith("The Line has reached its Finish after Round 1.");
  expect(ticketOf(atFinish, "r1-prove").assignment).toMatchObject({ harness: "claude", model: "opus", drivers: "my-verify" });
  expect(ticketOf(atFinish, "r1-review").assignment).toMatchObject({ drivers: "code-review" });
  expect(ticketOf(atFinish, "r1-decide").assignment).toMatchObject({ drivers: "html" });
  expect(readStateLine(world.pool, "r1-prove.md").line).toContain("blocked-by=r1-implement status=done station=prove");
  // The Station is taught its verdict in its prompt; Implement has none to write.
  expect(promptOf(world, "r1-prove")).toContain('"verdict": {"prove": "pass" or "fail"');
  expect(promptOf(world, "r1-implement")).not.toContain('"verdict"');
  expect(issue(world, "r1-decide")).toContain("- [nit] **Name**: rename x");
  expect(atFinish.state.outcomes["r1-prove"]?.verdict).toEqual({ prove: "pass", evidence: "proof/ok.txt" });
  expect((await lineOf(server))?.status).toBe("finish");

  const done = await approveFinish(server, "r1-finish");
  expect(statuses(done)["r1-finish"]).toBe("done");
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-review", "r1-decide"]);
  const line = await lineOf(server);
  expect(line?.status).toBe("done");
  expect(line?.rounds).toEqual([
    {
      round: 1,
      proves: [{ ticket: "r1-prove", prove: "pass", evidence: "proof/ok.txt" }],
      findings: [{ severity: "nit", title: "Name", detail: "rename x" }],
      decide: { decide: "finish", fixes: [], dropped: [] },
    },
  ]);
  expect(done.state.log).toContain("line: r1-finish approved; the Line is done");
});

conformance("factory", "a Prove fail writes a fix Implement from Prove's brief, and Prove runs again", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-prove", FAIL);
  world.stubs.script("r1-prove-2", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-finish");
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-fix-1", "r1-prove-2", "r1-review", "r1-decide"]);
  const fix = issue(world, "r1-fix-1");
  expect(fix).toContain("# r1-fix-1: Fix 1, Round 1\n");
  expect(fix).toContain("## What Prove found\n\nthe CLI exits 2 on an empty pool\n\nEvidence: `proof/fail.txt`");
  expect(readStateLine(world.pool, "r1-fix-1.md").line).toContain("blocked-by=r1-prove status=done station=implement");
  const line = await lineOf(server);
  expect(line?.proveFails).toBe(1);
  expect(line?.rounds[0]?.proves.map((p) => [p.ticket, p.prove])).toEqual([
    ["r1-prove", "fail"],
    ["r1-prove-2", "pass"],
  ]);
});

conformance("factory", "the third Prove fail in a Round checkpoints the next fix; a Resume with a note buys it, and the Line survives a restart there", async (t) => {
  const world = lineWorld(t);
  for (const id of ["r1-prove", "r1-prove-2", "r1-prove-3"]) world.stubs.script(id, FAIL);
  world.stubs.script("r1-prove-4", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const first = await t.start(world);
  await started(first);

  const limited = await atCheckpoint(first, "r1-fix-3");
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-fix-1", "r1-prove-2", "r1-fix-2", "r1-prove-3"]);
  expect(statuses(limited)["r1-fix-3"]).toBe("checkpoint");
  expect(interruptOn(limited, "r1-fix-3")).toStartWith(
    "Prove has failed 3 times in Round 1 (limits.proveFailsPerRound is 2), so the Line stopped before this fix.",
  );
  const before = await lineOf(first);
  expect(before).toMatchObject({ station: "implement", ticket: "r1-fix-3", proveFails: 3, gated: true, fixesBought: 0 });

  // The server stops at the checkpoint; the next one re-reads line.json and carries on from it.
  await first.stop();
  const second = await t.start(world);
  const restored = await atCheckpoint(second, "r1-fix-3");
  expect(await lineOf(second)).toEqual(before);
  expect(interruptOn(restored, "r1-fix-3")).toStartWith("Prove has failed 3 times in Round 1");

  await answer(second, { ticketId: "r1-fix-3", note: "try the other port" });
  await atCheckpoint(second, "r1-finish");
  expect(launches(world).slice(6)).toEqual(["r1-fix-3", "r1-prove-4", "r1-review", "r1-decide"]);
  expect(issue(world, "r1-fix-3")).toContain("## Resume note\n\ntry the other port");
  expect(await lineOf(second)).toMatchObject({ fixesBought: 1, gated: false, proveFails: 3 });
});

conformance("factory", "Decide's round starts the next Round with its fixes, up to the extra-Rounds limit; notes on the Finish start one past it", async (t) => {
  const world = lineWorld(t);
  const leak = verdict({ findings: [{ severity: "must", title: "Leak", detail: "the pane leaks" }] });
  const round = { decide: "round", fixes: [{ title: "Leak", reason: "a must" }] };
  const again = verdict(round);
  for (const n of [1, 2, 3]) {
    world.stubs.script(`r${n}-prove`, PASS);
    world.stubs.script(`r${n}-review`, n === 3 ? NO_FINDINGS : leak);
    world.stubs.script(`r${n}-decide`, n === 3 ? FINISH : again);
  }
  // With the extra Round spent, Decide's round ends the Line all the same: without the report it is
  // the no-verdict checkpoint, and once the report is written it goes to the Finish.
  world.stubs.launches("r2-decide", [again, finishing(round)]);
  const server = await t.start(world);
  await started(server);

  const unreported = await atCheckpoint(server, "r2-decide");
  expect(interruptOn(unreported, "r2-decide")).toContain(`the report is not at `);
  await answer(server, { ticketId: "r2-decide", note: "write the report" });
  const limit = await atCheckpoint(server, "r2-finish");
  expect(launches(world)).toEqual([
    "r1-implement", "r1-prove", "r1-review", "r1-decide",
    "r2-implement", "r2-prove", "r2-review", "r2-decide", "r2-decide",
  ]);
  expect(issue(world, "r2-implement")).toContain("- **Leak**: a must\n  the pane leaks (must)");
  expect(readStateLine(world.pool, "r2-implement.md").line).toContain("blocked-by=r1-decide");
  expect(interruptOn(limit, "r2-finish")).toContain(
    "Decide chose another Round, but the Line has started its 1 extra Round already (limits.extraRounds).",
  );
  expect(await lineOf(server)).toMatchObject({ round: 2, extraRounds: 1, status: "finish" });

  await answer(server, { ticketId: "r2-finish", note: "rename the flag to --pool" });
  await atCheckpoint(server, "r3-finish");
  expect(launches(world).slice(9)).toEqual(["r3-implement", "r3-prove", "r3-review", "r3-decide"]);
  expect(issue(world, "r3-implement")).toContain("## The operator's notes\n\nrename the flag to --pool");
  const done = await approveFinish(server, "r3-finish");
  expect(statuses(done)["r2-finish"]).toBe("done");
  expect((await lineOf(server))?.status).toBe("done");
});

conformance("factory", "an Outcome with no valid verdict checkpoints its Ticket with no verdict, and a Resume asks for one", async (t) => {
  const world = lineWorld(t);
  world.stubs.launches("r1-prove", [{ status: "done" }, PASS]);
  world.stubs.script("r1-review", verdict({ findings: [{ severity: "must", title: "Leak", detail: "d" }] }));
  // Decide finishes without dropping the must, then accounts for it.
  world.stubs.launches("r1-decide", [
    FINISH,
    finishing({ decide: "finish", dropped: [{ title: "Leak", reason: "out of scope" }] }),
  ]);
  const server = await t.start(world);
  await started(server);

  const prove = await atCheckpoint(server, "r1-prove");
  expect(interruptOn(prove, "r1-prove")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
  expect(statuses(prove)).toEqual({ "r1-implement": "done", "r1-prove": "checkpoint" });
  expect(issue(world, "r1-prove")).toContain("## Brief\n\nno verdict\n\n");
  await answer(server, { ticketId: "r1-prove" });

  const decide = await atCheckpoint(server, "r1-decide");
  expect(interruptOn(decide, "r1-decide")).toStartWith(
    'no verdict\n\nevery must finding has to be dropped (a finish fixes nothing) with a reason; not accounted for: "Leak".',
  );
  await answer(server, { ticketId: "r1-decide", note: "drop it, it is out of scope" });

  await atCheckpoint(server, "r1-finish");
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-prove", "r1-review", "r1-decide", "r1-decide"]);
});

conformance("factory", "closing a Station Ticket halts the Line: Decide still runs, then the Line waits at its Finish, and Close there ends it", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-prove", { status: "checkpoint", brief: "needs a device" });
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  await atCheckpoint(server, "r1-prove");
  await answer(server, { ticketId: "r1-prove", action: "close" });
  const halted = await atCheckpoint(server, "r1-finish");
  expect(statuses(halted)).toEqual({
    "r1-implement": "done",
    "r1-prove": "closed",
    "r1-decide": "done",
    "r1-finish": "checkpoint",
  });
  expect(launches(world)).toEqual(["r1-implement", "r1-prove", "r1-decide"]);
  expect(issue(world, "r1-decide")).toContain("The Line was halted (r1-prove was closed).");
  expect(readStateLine(world.pool, "r1-decide.md").line).toContain("blocked-by=none");
  expect(interruptOn(halted, "r1-finish")).toContain("The Line was halted: r1-prove was closed.");
  expect((await lineOf(server))?.halted).toBe("r1-prove was closed");

  await answer(server, { ticketId: "r1-finish", action: "close" });
  // A Factory pool raises no run-wide Review: the Line closed at its Finish ends the run.
  const closed = await settle(server, (s) => s.phase === "done", { what: "the run to be done" });
  expect(closed.state.interrupts).toEqual([]);
  expect((await lineOf(server))?.status).toBe("closed");
});

conformance("factory", "a spawn proposed from inside the Line is held for the operator and the Line routes on", async (t) => {
  const world = lineWorld(t);
  world.stubs.script("r1-implement", {
    spawn: [{ title: "Tidy the logs", body: "Tidy the pool log lines the Line writes, they repeat." }],
  });
  world.stubs.script("r1-prove", PASS);
  world.stubs.script("r1-review", NO_FINDINGS);
  world.stubs.script("r1-decide", FINISH);
  const server = await t.start(world);
  await started(server);

  const atFinish = await atCheckpoint(server, "r1-finish");
  expect(atFinish.heldSpawns.map((h) => [h.id, h.parentId, h.reason, h.title])).toEqual([
    ["proposal-1", "r1-implement", "line", "Tidy the logs"],
  ]);
  expect(atFinish.pendingSpawns).toEqual([]);
  expect(Object.keys(statuses(atFinish))).not.toContain("r1-implement-spawn-1");
  expect(atFinish.state.log).toContain(
    "ticket r1-implement: 1 proposal held for the operator: proposed inside the Line (ADR-0037): proposal-1",
  );
});
