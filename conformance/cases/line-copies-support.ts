/**
 * What the per-item cases share (ADR-0039, ADR-0040): a Plan whose `tasks` node makes Items, a
 * per-item `build` node on a cap with or without a Merger, and `check` after it, the stub Outcomes
 * that carry Items, and the reads of the copies from outside the server.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PlanFile, PlanNodeFile } from "../../protocol/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import { until } from "../harness/pool-files.ts";
import { snapshot } from "../harness/pool-run.ts";
import type { ConformanceStubBehaviour, StubHold } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import { edge, node, plan } from "./plans-support.ts";
import { begun, launches, lineOf, lineWorld } from "./line-support.ts";

/** `n` Items, titled `Piece 1` and so on, each with a body of its own. */
export function pieces(n: number): { title: string; body: string }[] {
  return Array.from({ length: n }, (_, i) => ({ title: `Piece ${i + 1}`, body: `Build piece ${i + 1} and nothing else.` }));
}

/** A done Outcome carrying `items` as given, which may be malformed on purpose. */
export function makingItems(items: unknown): ConformanceStubBehaviour {
  return { outcomeRaw: JSON.stringify({ status: "done", summary: "tasks done", commitSha: null, items }) };
}

export interface CopiesPlan {
  /** Cap on the copies of `build` at once: a number or "all". */
  cap: number | "all";
  /** A Merger after `build`, with its conflict policy when given. */
  merger?: boolean | { conflict: "wait" | { resolver: { harness?: string; model?: string; effort?: string } } };
  /** Whether `tasks` is taught to make Items; true by default. */
  makesItems?: boolean;
  /** Route a closed pass to `check` as well, so a closed copy does not send the Line to its Finish. */
  closedToCheck?: boolean;
}

/** tasks -> build (one copy per Item) -> [build-merge] -> check -> finish. */
export function copiesPlan(spec: CopiesPlan): PlanFile {
  const merged = spec.merger !== undefined && spec.merger !== false;
  const folded = merged ? "build-merge" : "build";
  const nodes: PlanNodeFile[] = [
    node.agent("tasks", { makesItems: spec.makesItems ?? true }),
    node.agent("build", { copies: { perItem: spec.cap } }),
    ...(merged
      ? [
          {
            ...node.merger("build-merge", "build"),
            ...(typeof spec.merger === "object" ? { conflict: spec.merger.conflict } : {}),
          } as PlanNodeFile,
        ]
      : []),
    node.agent("check"),
    node.finish(),
  ];
  const edges = [
    edge("tasks", "done", "build"),
    ...(merged ? [edge("build", "done", "build-merge")] : []),
    ...(merged && spec.closedToCheck ? [edge("build", "closed", "build-merge")] : []),
    edge(folded, "done", "check"),
    ...(spec.closedToCheck ? [edge(folded, "closed", "check")] : []),
    edge("check", "done", "finish"),
  ];
  return plan(nodes, edges, "Copies");
}

/**
 * tasks -> build (one copy per Item, under cap 2) -> build-merge -> finish, with `tasks` also
 * routed straight to finish. A verdict fans out to every edge that routes it, so the Finish
 * has its handoff while build's copies run and waits on them.
 */
export function forkedPlan(): PlanFile {
  return plan(
    [
      node.agent("tasks", { makesItems: true }),
      node.agent("build", { copies: { perItem: 2 } }),
      node.merger("build-merge", "build"),
      node.finish(),
    ],
    [
      edge("tasks", "done", "build"),
      edge("tasks", "done", "finish"),
      edge("build", "done", "build-merge"),
      edge("build-merge", "done", "finish"),
    ],
    "Forked",
  );
}

/**
 * A Line on `forkedPlan()` whose `tasks` makes five Items, with `build-1.1` and `build-1.2`
 * held live and the other three queued, once both copies have launched. A held copy ends on
 * its `release()`.
 */
export async function liveCopies(t: Case): Promise<{ world: World; server: CaseServer; first: StubHold; second: StubHold }> {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(5)));
  const first = world.stubs.hold("build-1.1");
  const second = world.stubs.hold("build-1.2");
  const server = await t.start(world);
  await begun(server, { plan: forkedPlan(), work: "#1" });
  await untilLaunched(world, ["build-1.1", "build-1.2"]);
  return { world, server, first, second };
}

/** Whether the Finish of `liveCopies`' Line waits on its two copies and three queued Items. */
export const finishWaitsOnBuild = (snap: EnrichedSnapshot): boolean =>
  snap.line?.status === "finishing" && snap.line.waitingFor.length === 3;

/** `build-1.1` to `build-1.n`: the ids of one pass's copies. */
export function copyIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `build-1.${i + 1}`);
}

/** Wait until every key in `keys` has been launched. */
export function untilLaunched(world: World, keys: string[], what = `${keys.join(", ")} to launch`): Promise<string[]> {
  return until(() => launches(world), (seen) => keys.every((key) => seen.includes(key)), { what, ms: 30_000 });
}

/** The Tickets the Line has written for `build`'s current pass, from GET /api/line. */
export async function buildTickets(server: CaseServer): Promise<string[]> {
  return (await lineOf(server))?.nodes.find((n) => n.id === "build")?.tickets ?? [];
}

/** Wait for the checkpoint Interrupt on `id` while other work may still be running. */
export function interruptRaised(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  return until(
    () => snapshot(server),
    (snap) => snap.state.interrupts.some((i) => i.ticketId === id && i.kind === "checkpoint"),
    { what: `a checkpoint on ${id}`, ms: 30_000 },
  );
}

/** Whether the Line has written Ticket `id` yet. */
export const hasIssue = (pool: string, id: string): boolean => existsSync(join(pool, "issues", `${id}.md`));

/** Let the server run on for a moment, so an absence it should keep has had its chance to break. */
export const MOMENT_MS = 1500;
