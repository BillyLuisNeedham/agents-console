/**
 * What the `plans` cases share: a started pool to ask, builders for Plan
 * files (the draft shapes of protocol/wire.ts, written as an operator's
 * editor would), the Plan library's path under the world's HOME, and the two
 * ways to ask the same question, over HTTP and on the socket.
 */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  PlanDraftResponse,
  PlanEdgeFile,
  PlanEditFile,
  PlanFile,
  PlanNodeFile,
  PlanProblem,
  PlanProblemAt,
  PlanValidateResponse,
} from "../../protocol/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import type { World } from "../harness/world.ts";
import { doneTicket, restedSnapshot } from "./config-support.ts";

/** A pool at rest with a socket on it; the Plan verbs do not depend on the pool's state. */
export async function plansPool(t: Case): Promise<{ world: World; server: CaseServer; socket: SocketClient }> {
  const world = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);
  await restedSnapshot(server);
  const socket = await t.socket(server);
  await socket.sync();
  return { world, server, socket };
}

/** `<home>/.agent-graphs/plans`. */
export function plansDir(world: World): string {
  return join(world.home, ".agent-graphs", "plans");
}

/** The library file of one slug. */
export function planFile(world: World, slug: string): string {
  return join(plansDir(world), `${slug}.json`);
}

// ---------------------------------------------------------------------------
// Plan files
// ---------------------------------------------------------------------------

type Extra<K extends PlanNodeFile["kind"]> = Partial<Omit<Extract<PlanNodeFile, { kind: K }>, "kind" | "id" | "title" | "x" | "y">>;

let place = 0;
const at = () => ({ x: (place++ % 8) * 300, y: 60 });

/** Node builders: a title from the id, and a place on the canvas. */
export const node = {
  conversation: (id: string, extra: Extra<"conversation"> = {}): PlanNodeFile => ({ kind: "conversation", id, title: id, ...at(), ...extra }),
  agent: (id: string, extra: Extra<"agent"> = {}): PlanNodeFile => ({ kind: "agent", id, title: id, ...at(), ...extra }),
  prove: (id: string, extra: Extra<"prove"> = {}): PlanNodeFile => ({ kind: "prove", id, title: id, ...at(), ...extra }),
  review: (id: string, extra: Extra<"review"> = {}): PlanNodeFile => ({ kind: "review", id, title: id, ...at(), ...extra }),
  decide: (id: string, extra: Extra<"decide"> = {}): PlanNodeFile => ({ kind: "decide", id, title: id, ...at(), ...extra }),
  merger: (id: string, of: string): PlanNodeFile => ({ kind: "merger", id, title: id, ...at(), of }),
  gate: (id: string, open?: "operator" | "steward" | "auto"): PlanNodeFile => ({ kind: "gate", id, title: id, ...at(), ...(open ? { open } : {}) }),
  finish: (id = "finish"): PlanNodeFile => ({ kind: "finish", id, title: id, ...at() }),
};

export function edge(from: string, on: string, to: string, cap?: PlanEdgeFile["cap"]): PlanEdgeFile {
  return { from, on, to, ...(cap ? { cap } : {}) };
}

export function plan(nodes: PlanNodeFile[], edges: PlanEdgeFile[], name = "A plan"): PlanFile {
  return { horde: 1, name, nodes, edges };
}

/** The smallest valid Plan: one Agent node into the Finish. */
export function smallPlan(name = "Small"): PlanFile {
  return plan([node.agent("build"), node.finish()], [edge("build", "done", "finish")], name);
}

/** A Plan using most of the format, with no problem: a Conversation, a per-item node with its Merger, a capped loop, an operator Gate. */
export function richPlan(): PlanFile {
  return plan(
    [
      node.conversation("grill"),
      node.agent("build", { copies: { perItem: 2 }, makesItems: true }),
      node.merger("build-merge", "build"),
      node.prove("test"),
      node.gate("sign-off", "operator"),
      node.finish(),
    ],
    [
      edge("grill", "done", "build"),
      edge("build", "done", "build-merge"),
      edge("build-merge", "done", "test"),
      edge("test", "pass", "sign-off"),
      edge("test", "fail", "build", { max: 2 }),
      edge("sign-off", "open", "finish"),
    ],
    "Rich",
  );
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

export const atPlan: PlanProblemAt = { kind: "plan" };
export const atNode = (id: string): PlanProblemAt => ({ kind: "node", id });
export const atEdge = (from: string, on: string, to: string): PlanProblemAt => ({ kind: "edge", from, on, to });

/** One thing a Plan must be reported for: where, and a word its message holds. Several `at` are alternatives. */
export interface Expected {
  at: PlanProblemAt | PlanProblemAt[];
  keyword: string;
}

/** Whether `problems` holds the expected one: on the named node or edge, its message holding the keyword. */
export function holds(problems: PlanProblem[], expected: Expected): boolean {
  const places = Array.isArray(expected.at) ? expected.at : [expected.at];
  return problems.some(
    (problem) =>
      places.some((place) => JSON.stringify(place) === JSON.stringify(problem.at)) && problem.message.includes(expected.keyword),
  );
}

export function expectProblem(problems: PlanProblem[], expected: Expected): void {
  expect(holds(problems, expected), `no problem ${JSON.stringify(expected)} in ${JSON.stringify(problems)}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/**
 * `plans.validate` over HTTP and on the socket, which must agree: the
 * answer for a draft, problems and warnings, as both gave it.
 */
export async function validateBothAnswers(server: CaseServer, socket: SocketClient, draft: PlanFile): Promise<PlanValidateResponse> {
  const http = await server.http.post("/api/plans/validate", { plan: draft });
  expect(http.status, http.text).toBe(200);
  const reply = await socket.request("plans.validate", { plan: draft });
  if (!reply.ok) throw new Error(`plans.validate was refused: ${JSON.stringify(reply.refusal)}`);
  const answer = http.json<PlanValidateResponse>();
  expect(reply.result).toEqual(answer);
  return answer;
}

/** The problems of a draft, as both routes answered them. */
export async function validateBoth(server: CaseServer, socket: SocketClient, draft: PlanFile): Promise<PlanProblem[]> {
  return (await validateBothAnswers(server, socket, draft)).problems;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** An installed skill: a file at `path`, under whatever directory the harness reads. */
export function installSkillFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "---\nname: installed\n---\n");
}

export async function editBoth(server: CaseServer, socket: SocketClient, draft: unknown, edits: PlanEditFile[]): Promise<PlanDraftResponse> {
  const http = await server.http.post("/api/plans/edit", { plan: draft, edits });
  expect(http.status, http.text).toBe(200);
  const reply = await socket.request("plans.edit", { plan: draft as PlanFile, edits });
  if (!reply.ok) throw new Error(`plans.edit was refused: ${JSON.stringify(reply.refusal)}`);
  const answer = http.json<PlanDraftResponse>();
  expect(reply.result).toEqual(answer);
  return answer;
}

export async function editRefusedBoth(server: CaseServer, socket: SocketClient, draft: unknown, edits: PlanEditFile[]): Promise<string> {
  const http = await server.http.post("/api/plans/edit", { plan: draft, edits });
  expect(http.status, http.text).toBe(400);
  const reason = http.json<{ reason: string }>().reason;
  const reply = await socket.request("plans.edit", { plan: draft as PlanFile, edits });
  expect(reply.ok).toBe(false);
  if (!reply.ok) expect(reply.refusal).toEqual({ reason, status: 400 });
  return reason;
}

