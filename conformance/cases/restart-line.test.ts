/**
 * A Line across a restart (ADR-0040), seen from outside the server: nothing of the Line is rebuilt
 * but line.json, and the first tick re-reads every fact from the pool and writes only what is
 * missing, under the same ids and the same bytes. A done Ticket whose merge has not landed hands
 * nothing on until it does; a deleted hold the Line still names is written again as it was; and
 * the Finish Ticket owed by an approval is written once. A stop with copies of a per-item node live
 * and Items still queued writes no copy twice and no queued Item early.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, LineFile } from "../../protocol/wire.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { conformance } from "../harness/case.ts";
import { answer, settle, snapshot, statuses } from "../harness/pool-run.ts";
import { refusedAtLoad } from "./config-support.ts";
import { copiesPlan, copyIds, makingItems, pieces, untilLaunched } from "./line-copies-support.ts";
import { PASS, approveFinish, atCheckpoint, begun, launches, lineOf, lineWorld, passPath, verdict } from "./line-support.ts";
import { poolLog, restartCase, startLeg, untilState } from "./restart-support.ts";

const issuePath = (pool: string, id: string): string => join(pool, "issues", `${id}.md`);
const wrote = (log: string[], id: string): number => log.filter((l) => l === `line: wrote ${id}`).length;
const mergeBlocked = (s: EnrichedSnapshot): boolean =>
  s.state.interrupts.some((i) => i.ticketId === "prove-1" && i.kind === "merge-conflict");

restartCase("a stop while prove-1 is done but its merge has not landed writes review-1 once, after the merge", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  world.stubs.script("prove-1", {
    ...PASS,
    run: "printf '%s\\n' fresh > proof.txt; git add proof.txt; git commit -qm 'prove-1 evidence note'",
  });
  writeFileSync(join(world.repo, "proof.txt"), "stale\n");
  const first = await startLeg(t, world, 0);
  await begun(first);

  const blocked = await untilState(first, "prove-1's merge to be blocked", mergeBlocked);
  expect(statuses(blocked)).toEqual({ "implement-1": "done", "prove-1": "done" });
  expect(existsSync(issuePath(world.pool, "review-1"))).toBe(false);
  expect(blocked.line?.nodes.find((n) => n.id === "prove")?.tickets).toEqual(["prove-1"]);
  await first.stop();

  rmSync(join(world.repo, "proof.txt"));
  const second = await startLeg(t, world, 1);
  const restored = await untilState(second, "prove-1's blocked merge after the restart", mergeBlocked);
  expect(statuses(restored)["prove-1"]).toBe("done");
  expect(existsSync(issuePath(world.pool, "review-1"))).toBe(false);

  await answer(second, { ticketId: "prove-1" });
  await atCheckpoint(second, "finish-1");
  expect(readFileSync(join(world.repo, "proof.txt"), "utf8")).toBe("fresh\n");
  const log = await poolLog(second);
  const merged = log.indexOf("interrupt answered for prove-1 (merge-conflict): merge landed");
  expect(merged).toBeGreaterThan(-1);
  expect(log.findIndex((l) => l === "line: wrote review-1")).toBeGreaterThan(merged);
  expect(wrote(log, "review-1")).toBe(1);
  expect(launches(world).filter((k) => k === "review-1")).toEqual(["review-1"]);
  expect(readStateLine(world.pool, "review-1.md").line).toContain("blocked-by=prove-1 status=done node=review");
});

restartCase("a deleted hold the Line still names is written again byte for byte at the next boot", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  const first = await startLeg(t, world, 0);
  await begun(first);
  await atCheckpoint(first, "finish-1");
  const bytes = readFileSync(issuePath(world.pool, "finish-1"), "utf8");
  await first.stop();

  rmSync(issuePath(world.pool, "finish-1"));
  const second = await startLeg(t, world, 1);
  const again = await atCheckpoint(second, "finish-1");
  expect(readFileSync(issuePath(world.pool, "finish-1"), "utf8")).toBe(bytes);
  expect(again.state.interrupts.map((i) => i.ticketId)).toEqual(["finish-1"]);
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1"]);
  const done = await approveFinish(second, "finish-1");
  expect(done.line?.status).toBe("done");
});

restartCase("a stop after the Finish is approved and before finish-1-act ends writes finish-1-act once", async (t) => {
  const world = lineWorld(t, { spec: "docs/specs/line.md", finish: "draft-pr" });
  world.git(["checkout", "-q", "-b", "line/x"]);
  passPath(world);
  const act = world.stubs.hold("finish-1-act", verdict({ url: "https://github.com/o/r/pull/7" }));
  const first = await startLeg(t, world, 0);
  await begun(first);
  await atCheckpoint(first, "finish-1");
  await answer(first, { ticketId: "finish-1", note: "approved" });
  await until(
    () => readStateLine(world.pool, "finish-1-act.md").line,
    (line) => line.includes("status=in-progress"),
    { what: "finish-1-act to launch" },
  );
  const bytes = readFileSync(issuePath(world.pool, "finish-1-act"), "utf8").split("\n").slice(1).join("\n");
  await first.stop();
  const saved = JSON.parse(readFileSync(join(world.pool, "line.json"), "utf8")) as LineFile;
  expect(saved.run).toMatchObject({ status: "acting", act: "finish-1-act" });

  const second = await startLeg(t, world, 1);
  expect((await snapshot(second)).line).toMatchObject({ status: "acting", act: "finish-1-act" });
  await act.release(30_000);
  const done = await settle(second, (s) => s.phase === "done", { what: "the run to be done" });
  expect(done.line?.status).toBe("done");
  expect(statuses(done)["finish-1-act"]).toBe("done");
  expect(readFileSync(issuePath(world.pool, "finish-1-act"), "utf8").split("\n").slice(1).join("\n")).toStartWith(bytes);
  expect(wrote(await poolLog(second), "finish-1-act")).toBe(1);
});

/** Every id the pool log says the Line wrote, in order: a line names several as `line: wrote a, b`. */
const wroteIds = (log: string[]): string[] =>
  log.filter((l) => l.startsWith("line: wrote ")).flatMap((l) => l.slice("line: wrote ".length).split(", "));

restartCase("a stop with two copies live and three queued writes no copy twice and no queued item early, and the pass completes", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(5)));
  const holds = [world.stubs.hold("build-1.1"), world.stubs.hold("build-1.2")];
  const first = await startLeg(t, world, 0);
  await begun(first, { plan: copiesPlan({ cap: 2, merger: true }), work: "#1" });
  await untilLaunched(world, ["build-1.1", "build-1.2"]);
  expect(wroteIds(await poolLog(first))).toEqual(["tasks-1", "build-1.1", "build-1.2"]);
  await first.stop();

  // The stop took the two live copies down: the next server runs them again, and writes nothing more.
  const second = await startLeg(t, world, 1);
  await until(
    () => world.stubs.calls().filter((call) => call.key === "build-1.1" || call.key === "build-1.2"),
    (calls) => calls.length === 4,
    { what: "both copies to launch again", ms: 30_000 },
  );
  const midPass = await snapshot(second);
  expect(statuses(midPass)).toEqual({ "tasks-1": "done", "build-1.1": "in-progress", "build-1.2": "in-progress" });
  expect(wroteIds(await poolLog(second))).toEqual(["tasks-1", "build-1.1", "build-1.2"]);
  expect((await lineOf(second))?.nodes.find((n) => n.id === "build")).toMatchObject({ tickets: ["build-1.1", "build-1.2"], queued: 3 });
  for (const id of copyIds(5).slice(2)) expect(existsSync(issuePath(world.pool, id)), `${id} is not written early`).toBe(false);

  // One hold at a time: while build-1.2 is held there is one free slot, so the queued copies take it in order.
  await holds[0]!.release();
  await untilLaunched(world, ["build-1.5"]);
  await holds[1]!.release();
  await atCheckpoint(second, "finish-1");
  expect(wroteIds(await poolLog(second))).toEqual(["tasks-1", ...copyIds(5), "check-1", "finish-1"]);
  expect(launches(world).filter((key) => key.startsWith("build-1.") && !["build-1.1", "build-1.2"].includes(key))).toEqual([
    "build-1.3",
    "build-1.4",
    "build-1.5",
  ]);
  expect(launches(world).filter((key) => key === "check-1")).toEqual(["check-1"]);
  expect(readStateLine(world.pool, "check-1.md").blockedBy).toEqual(copyIds(5));
});

conformance("restart", "a line.json from before Plans is refused at boot with the message to start a new Line, and is left as it was", async (t) => {
  const world = lineWorld(t);
  const server = await t.start(world);
  await begun(server);
  await server.stop();

  const old = JSON.stringify({
    brief: { spec: "docs/specs/line.md" },
    briefPath: "docs/specs/line.brief.json",
    status: "running",
    round: 1,
    station: "implement",
    ticket: "r1-implement",
    proveFails: 0,
    fixesBought: 0,
    gated: false,
    extraRounds: 0,
    halted: null,
    rounds: [],
  });
  const file = join(world.pool, "line.json");
  writeFileSync(file, old);

  const refused = await refusedAtLoad(world);
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain("line.json is from before Plans (ADR-0040); start a new Line");
  expect(readFileSync(file, "utf8")).toBe(old);
});
