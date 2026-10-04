/**
 * Jev grading, seen from outside the server (ADR-0036, ADR-0023): the
 * server holds a TypeSafe key and its JEV_BASE_URL names a fake TypeSafe
 * endpoint this process serves, so what Jev answers is scripted here and
 * what the server makes of it is read from the pool's files and HTTP.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import { CONFORMANCE_JEV_KEY, conformance } from "../harness/case.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";

/** A clean pass, scripted for every rubric question the server asks. */
const CLEAN = {
  ticket_fit: 4,
  claim_fidelity: 3,
  log_health: 3,
  contradicted_claim: 0.1,
  untouched_criterion: 0.1,
  failing_at_end: 0.1,
  summary_claims_tests_pass: 0.1,
  no_test_run: 0.1,
  evidence_too_thin: 0.1,
};

conformance("verify", "a verify: 2 round is graded through Jev and selects from the composed scores", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-pick.md",
        marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        body: "# Pick\n\nWrite the thing.",
      },
    ],
    config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: 2 } } },
  });
  // Each Attempt's Evidence carries its Outcome summary, which the stub
  // writes as summary-<key>: attempt 1 earns a full ticket fit, attempt 2
  // lands low, so the composed scores separate by more than the outright
  // margin.
  const jev = t.jev({
    answersFor: (state) =>
      JSON.stringify(state).includes("summary-01.attempt-1") ? CLEAN : { ...CLEAN, ticket_fit: 1 },
  });
  const server = await t.start(world, { jev });

  await until(
    () => readStateLine(world.pool, "01-pick.md"),
    (marker) => marker.status === "done",
    { what: "01's marker to say done", ms: 30_000 },
  );

  // One request per Attempt, each to the systemone route with the key the
  // server was started with and the pinned model.
  expect(jev.requests).toHaveLength(2);
  for (const request of jev.requests) {
    expect(request.url).toBe(`${jev.url}/v1/systemone`);
    expect(request.authorization).toBe(`Bearer ${CONFORMANCE_JEV_KEY}`);
    expect(request.body.model).toBe("jev-latest");
  }

  // The round was Jev's: no grader or head-to-head Ticket, and nothing but
  // the two Attempts launched.
  for (const file of ["01-grader-1.md", "01-grader-2.md", "01-head-to-head.md"]) {
    expect(existsSync(join(world.pool, "issues", file))).toBe(false);
  }
  expect(world.stubs.calls().map((call) => call.key).sort()).toEqual(["01.attempt-1", "01.attempt-2"]);

  // A graded event per Attempt with the composed score, verdict and provenance.
  const events = readEvents(world.pool, "01");
  const graded = events.filter((event) => event.kind === "graded").sort((a, b) => a.attempt - b.attempt);
  expect(graded.map((event) => event.attempt)).toEqual([1, 2]);
  expect(graded[0]!.payload).toMatchObject({
    score: 9.4,
    verdict: "pass",
    rubric: "jev-grader-rubric/2026-09-20.1",
    model: "jev-latest",
    evidenceBudget: "base",
  });
  expect(String(graded[0]!.payload.reasons)).toContain("ticket fit: all criteria met");
  expect(graded[1]!.payload).toMatchObject({ score: 6.7, verdict: "pass" });

  // Selection used the composed scores: attempt 1 takes it outright.
  expect(events.find((event) => event.kind === "selected")?.payload).toEqual({
    score: 9.4,
    margin: 2.7,
    rule: "outright",
  });

  // The pool log, once the snapshot has caught up with the grades.
  const log = await until(
    async () => (await server.http.get("/api/state")).json<{ snapshot: EnrichedSnapshot | null }>().snapshot?.state.log ?? [],
    (lines) => lines.some((line) => line.startsWith("ticket 01: attempt 2 graded")),
    { what: "the pool log to carry both grades" },
  );
  expect(log).toContain("Jev configured (jev-latest)");
  const round = log.indexOf("ticket 01: grading 2 attempts with Jev");
  expect(round).toBeGreaterThanOrEqual(0);
  expect(round).toBeLessThan(log.findIndex((line) => line.startsWith("ticket 01: attempt 1 graded")));
});
