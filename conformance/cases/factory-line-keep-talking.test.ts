/**
 * Keep talking on a Station Ticket (issue #187, ADR-0037, ADR-0027), seen
 * from outside the server: a Station whose done Outcome carries no valid
 * verdict is the no-verdict checkpoint, its pane held while it waits like any
 * checkpointed Attempt's; Keep talking continues it there, and the Continued
 * attempt's Outcome is held to the Station's verdict as a launched one is.
 *
 * The pool is terminal-backed on the fake herdr. Each Station's stub claude
 * reads the prompt typed into its pane, writes the Outcome it is scripted
 * with, and stays up the way an interactive harness does; the case then plays
 * the agent in the held pane and writes each later Outcome itself.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, KeepTalkingResponse, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { CLAUDE_READY } from "../harness/herdr.ts";
import { settle, statuses, ticketOf } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { CONFIG, NO_FINDINGS, atCheckpoint, launches, lineOf, lineWorld, started } from "./factory-line-support.ts";

const TERMINAL = { ...CONFIG, terminal: "herdr" } satisfies PoolConfig;

/** How long each Station's stub stays up in its pane after its Outcome. */
const HOLD = 150;

const interruptOn = (snap: EnrichedSnapshot, id: string): string =>
  snap.state.interrupts.find((i) => i.ticketId === id)?.body ?? "";

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
  "factory",
  "Keep talking on a Station that wrote no verdict continues it in its pane, held to the verdict again, and a valid one routes the Line on",
  async (t) => {
    const world = lineWorld(t, undefined, {}, TERMINAL);
    world.stubs.script("r1-implement", { hold: HOLD });
    world.stubs.script("r1-prove", { status: "done", hold: HOLD });
    world.stubs.script("r1-review", { ...NO_FINDINGS, hold: HOLD });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    await started(server);

    const first = await atCheckpoint(server, "r1-prove");
    expect(interruptOn(first, "r1-prove")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
    const paneId = await untilHeld(server, "r1-prove", 1);

    // The Continued attempt is held to the Station's verdict: done without one is the same checkpoint.
    await keepTalking(server, "r1-prove", 2);
    writeOutcome(world, "r1-prove", { status: "done", summary: "proved it", commitSha: null });
    const again = await atCheckpoint(server, "r1-prove");
    expect(interruptOn(again, "r1-prove")).toStartWith("no verdict\n\nthe Outcome has no verdict.");
    expect(statuses(again)).toEqual({ "r1-implement": "done", "r1-prove": "checkpoint" });
    expect(await untilHeld(server, "r1-prove", 2)).toBe(paneId);

    await keepTalking(server, "r1-prove", 3);
    writeOutcome(world, "r1-prove", {
      status: "done",
      summary: "proved it",
      commitSha: null,
      verdict: { prove: "pass", evidence: "proof/ok.txt" },
    });
    const routed = await settle(server, (s) => statuses(s)["r1-review"] !== undefined, { what: "r1-review written" });
    expect(statuses(routed)["r1-prove"]).toBe("done");
    expect(routed.state.outcomes["r1-prove"]?.verdict).toEqual({ prove: "pass", evidence: "proof/ok.txt" });
    expect(routed.state.log).toContain("line: r1-prove routed to r1-review");
    expect(existsSync(join(world.pool, "issues", "r1-review.md"))).toBe(true);
    expect(await lineOf(server)).toMatchObject({ round: 1, station: "review", ticket: "r1-review" });
    // The Continued attempts launched nothing: r1-prove ran once, in the one pane.
    expect(launches(world).filter((key) => key === "r1-prove")).toEqual(["r1-prove"]);
  },
  { timeoutMs: 180_000 },
);
