/**
 * The HTTP routes, seen from outside the server (ADR-0036): status codes and
 * bodies equal once parsed.
 */

import { expect } from "bun:test";
import type { EnrichedTicketState } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";

/** A Ticket of the seeded pool as the snapshot carries it: done, on the defaults. */
function doneTicket(id: string, title: string, blockedBy: string[]): EnrichedTicketState {
  return {
    id,
    title,
    blockedBy,
    status: "done",
    mergeState: null,
    assignment: { harness: "claude", model: "m", drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    enlisted: false,
    reassign: {
      eligible: false,
      reason: "done",
      verify: null,
      sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
    },
  };
}

conformance("http", "GET /api/state answers a seeded pool's whole snapshot", async (t) => {
  // Both Tickets done already: the pool boots straight to quiescent with
  // nothing to run, so the snapshot it serves holds still.
  const world = t.world({
    tickets: [
      { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: "# First\n\nDone already." },
      { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=01 status=done -->", body: "# Second\n\nDone too." },
    ],
    config: { defaults: { harness: "claude", model: "m" } },
    agentMd: "# Standing instructions\n",
  });
  const server = await t.start(world);

  const answer = await until(
    () => server.http.get("/api/state"),
    (got) => got.status === 200 && got.json<{ snapshot: { phase: string } | null }>().snapshot?.phase === "quiescent",
    { what: "the pool to settle" },
  );

  expect(answer.status).toBe(200);
  expectParsedEqual(
    answer.text,
    {
      snapshot: {
        seq: 1,
        phase: "quiescent",
        poolName: ".scratch/pool",
        poolTitle: null,
        poolDir: world.pool,
        finishedTerminals: 0,
        spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
        pendingSpawns: [],
        heldSpawns: [],
        stewardBudget: { budget: 5, used: {} },
        state: {
          tickets: [doneTicket("01", "First", []), doneTicket("02", "Second", ["01"])],
          conversations: [],
          log: [
            "Jev not configured, heuristics only",
            "interrupt raised for REVIEW (review)",
            "pool quiescent: interrupts pending for REVIEW",
          ],
          outcomes: {},
          interrupts: [
            {
              ticketId: "REVIEW",
              kind: "review",
              body:
                "every ticket is done.\n- 01: (no outcome recorded)\n- 02: (no outcome recorded)\n" +
                "approve to end the run, or reject with a note naming the tickets to send back; " +
                "their downstream tickets return to ready with them.",
            },
          ],
          mergeQueue: [],
          queuedAnswers: [],
          config: { defaults: { harness: "claude", model: "m" } },
        },
      },
    },
    "GET /api/state",
  );
});
