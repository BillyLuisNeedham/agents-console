/**
 * Keep talking on a Line Ticket (ADR-0037, ADR-0039, ADR-0027), seen from
 * outside the server: a Ticket whose done Outcome carries no valid verdict
 * for its node is the no-verdict checkpoint, its pane held while it waits like
 * any checkpointed Attempt's; Keep talking continues it there, and the
 * Continued attempt's Outcome is held to the node's verdict as a launched one
 * is.
 *
 * The pool is terminal-backed on the fake herdr. Each Ticket's stub claude
 * reads the prompt typed into its pane, writes the Outcome it is scripted
 * with, and stays up the way an interactive harness does; the case then plays
 * the agent in the held pane and writes each later Outcome itself.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeepTalkingResponse, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { CLAUDE_READY } from "../harness/herdr.ts";
import { settle, statuses, ticketOf } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { CONFIG, NO_FINDINGS, atCheckpoint, begun, interruptOn, launches, lineOf, lineWorld } from "./line-support.ts";

const TERMINAL = { ...CONFIG, terminal: "herdr" } satisfies PoolConfig;

/** How long each Ticket's stub stays up in its pane after its Outcome. */
const HOLD = 150;

/** Wait for a Ticket's Held pane of `attempt`; its pane id. */
async function untilHeld(server: CaseServer, id: string, attempt: number): Promise<string> {
  const snap = await settle(server, (s) => ticketOf(s, id).heldPane?.attempt === attempt, {
    what: `${id}'s Held pane of attempt ${attempt}`,
  });
  return ticketOf(snap, id).heldPane!.paneId;
}

/** POST /api/keep-talking, which must continue `id` as `attempt`. */
async function keepTalking(server: CaseServer, id: string, attempt: number): Promise<void> {
  const answer = await server.http.post("/api/keep-talking", { ticketId: id });
  expect(answer.status, answer.text).toBe(202);
  expect(answer.json<KeepTalkingResponse>()).toEqual({ ticketId: id, attempt });
}

/** Write a Ticket's Outcome where its teaching said, as the agent in the pane would. */
function writeOutcome(world: World, id: string, outcome: Record<string, unknown>): void {
  writeFileSync(join(world.pool, "runs", `${id}.outcome.json`), JSON.stringify(outcome));
}

conformance(
  "line",
  "Keep talking on a Line Ticket that wrote no verdict continues it in its pane, held to the verdict again, and a valid one hands the Line on",
  async (t) => {
    const world = lineWorld(t, undefined, {}, TERMINAL);
    world.stubs.script("implement-1", { hold: HOLD });
    world.stubs.script("prove-1", { status: "done", hold: HOLD });
    world.stubs.script("review-1", { ...NO_FINDINGS, hold: HOLD });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    await begun(server);

    const first = await atCheckpoint(server, "prove-1");
    expect(interruptOn(first, "prove-1")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
    const paneId = await untilHeld(server, "prove-1", 1);

    // The Continued attempt is held to the node's verdict: done without one is the same checkpoint.
    await keepTalking(server, "prove-1", 2);
    writeOutcome(world, "prove-1", { status: "done", summary: "proved it", commitSha: null });
    const again = await atCheckpoint(server, "prove-1");
    expect(interruptOn(again, "prove-1")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
    expect(statuses(again)).toEqual({ "implement-1": "done", "prove-1": "checkpoint" });
    expect(await untilHeld(server, "prove-1", 2)).toBe(paneId);

    await keepTalking(server, "prove-1", 3);
    writeOutcome(world, "prove-1", {
      status: "done",
      summary: "proved it",
      commitSha: null,
      verdict: { prove: "pass", evidence: "proof/ok.txt" },
    });
    const routed = await settle(server, (s) => statuses(s)["review-1"] !== undefined, { what: "review-1 written" });
    expect(statuses(routed)["prove-1"]).toBe("done");
    expect(routed.state.outcomes["prove-1"]?.verdict).toEqual({ prove: "pass", evidence: "proof/ok.txt" });
    expect(routed.state.log).toContain("line: prove-1 hands on pass");
    expect(existsSync(join(world.pool, "issues", "review-1.md"))).toBe(true);
    expect((await lineOf(server))?.nodes.find((n) => n.id === "review")).toMatchObject({ pass: 1, tickets: ["review-1"] });
    // The Continued attempts launched nothing: prove-1 ran once, in the one pane.
    expect(launches(world).filter((key) => key === "prove-1")).toEqual(["prove-1"]);
  },
  { timeoutMs: 180_000 },
);
