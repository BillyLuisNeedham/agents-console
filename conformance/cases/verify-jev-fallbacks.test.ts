/**
 * Verify with Jev, the fallback causes and their notices, and Jev at boot
 * (C22 of the Rust port's inventory, docs/research/rust-port/
 * test-inventory.md; ADR-0020, ADR-0023). Every way an ask can fail falls
 * back to the grader Tickets under one cause: bad-key for a rejected key,
 * rate-limited for 429, unreachable for a 5xx or a dead network,
 * timed-out, invalid-question for 400 and 422, evidence-too-large for a
 * 400 that says the request did not fit, malformed for an answer that
 * does not parse. 429, 408, the 5xx, a dead network and a timeout are
 * retried twice first, as the TypeSafe SDK's defaults do. The pool log
 * says each cause once as it first bites, again only when it changes, and
 * once when answers resume; the round's own line names the Attempt whose
 * ask failed. At boot the pool log says once which path is live.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServedFakeJevOptions } from "../fixtures/jev-fake.ts";
import { CONFORMANCE_JEV_KEY, conformance, type Case, type CaseServer } from "../harness/case.ts";
import { approveReview } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { DEFAULTS, ready } from "./verify-common.ts";
import {
  chain,
  CLEAN,
  couldNotGrade,
  deadPort,
  expectGraderFallback,
  gradedEvents,
  jevLines,
  poolLog,
  RUBRIC,
  settleOnReview,
  ticketIdOf,
  unavailable,
  verifyEach,
} from "./verify-jev-support.ts";

const CONFIGURED = "Jev configured (jev-latest)";

/** A one-Ticket pool at verify: 1. */
function oneTicket(t: Case): World {
  return t.world({ tickets: [ready("01")], config: verifyEach(["01"]) });
}

/** Ticket 01's one round graded against a Jev fake scripted by `options`, run until the Review. */
async function oneRound(
  t: Case,
  options: ServedFakeJevOptions,
): Promise<{ world: World; server: CaseServer; requests: number; log: string[] }> {
  const world = oneTicket(t);
  const jev = t.jev(options);
  const server = await t.start(world, { jev });
  await settleOnReview(server);
  return { world, server, requests: jev.requests.length, log: await poolLog(server) };
}

/**
 * The round fell back for one cause: the pool log's Jev lines are the boot
 * line and that cause's one notice, the round's own line names attempt 1
 * with the same cause and detail, and the grader Ticket graded it. Returns
 * the detail, for the case to pin as far as it is the server's own.
 */
function fellBack(world: World, log: string[], cause: string): string {
  const lines = jevLines(log);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(CONFIGURED);
  const match = /^Jev unavailable \(([a-z-]+): (.*)\); heuristics until it answers$/.exec(lines[1]!);
  expect(match?.[1]).toBe(cause);
  const detail = match![2]!;
  expect(log).toContain(couldNotGrade("01", 1, cause, detail));
  expect(log).toContain("ticket 01: grading 1 attempt with grader tickets 01-grader-1");
  expect(existsSync(join(world.pool, "issues", "01-grader-1.md"))).toBe(true);
  expectGraderFallback(world);
  return detail;
}

// engine.test.ts:13432
conformance("verify", "says once at boot whether Jev is configured", async (t) => {
  // No verify key, so neither pool ever asks.
  const pool = () => t.world({ tickets: [ready("01")], config: DEFAULTS });
  const without = pool();
  const withKey = pool();
  const jev = t.jev({ answers: CLEAN });
  const [bare, keyed] = await Promise.all([t.start(without), t.start(withKey, { jev })]);
  await Promise.all([approveReview(bare), approveReview(keyed)]);

  expect(jevLines(await poolLog(bare))).toEqual(["Jev not configured, heuristics only"]);
  expect(jevLines(await poolLog(keyed))).toEqual([CONFIGURED]);
  expect(jev.requests).toEqual([]);
});

// jev.test.ts:120
conformance("verify", "a rejected key, 401 or 403, falls back as bad-key without a retry", async (t) => {
  const [unauthorised, forbidden] = await Promise.all([
    oneRound(t, { fail: { status: 401 } }),
    oneRound(t, { fail: { status: 403 } }),
  ]);
  expect(fellBack(unauthorised.world, unauthorised.log, "bad-key")).toBe("HTTP 401");
  expect(fellBack(forbidden.world, forbidden.log, "bad-key")).toBe("HTTP 403");
  expect(unauthorised.requests).toBe(1);
  expect(forbidden.requests).toBe(1);
});

// jev.test.ts:127
conformance("verify", "429 falls back as rate-limited once the two retries are spent", async (t) => {
  const { world, log, requests } = await oneRound(t, { fail: { status: 429 } });
  expect(requests).toBe(3);
  expect(fellBack(world, log, "rate-limited")).toBe("HTTP 429");
});

// jev.test.ts:134
conformance("verify", "a transient failure the retry clears is still graded by Jev", async (t) => {
  const { world, log, requests } = await oneRound(t, { fail: { status: 529, times: 1 }, answers: CLEAN });
  expect(requests).toBe(2);
  expect(jevLines(log)).toEqual([CONFIGURED]);
  expect(gradedEvents(world, "01").map((e) => e.payload.rubric)).toEqual([RUBRIC]);
  expect(existsSync(join(world.pool, "issues", "01-grader-1.md"))).toBe(false);
});

// jev.test.ts:144
conformance("verify", "a 5xx with no retry left, or a dead network, falls back as unreachable", async (t) => {
  const port = await deadPort();
  const dead = oneTicket(t);
  const [serverError, cut] = await Promise.all([
    oneRound(t, { fail: { status: 500 } }),
    (async () => {
      const server = await t.start(dead, {
        env: { TYPESAFE_API_KEY: CONFORMANCE_JEV_KEY, JEV_BASE_URL: `http://127.0.0.1:${port}` },
      });
      await settleOnReview(server);
      return poolLog(server);
    })(),
  ]);
  expect(serverError.requests).toBe(3);
  expect(fellBack(serverError.world, serverError.log, "unreachable")).toBe("HTTP 500");
  // The detail of a refused connection is the HTTP client's own message.
  expect(fellBack(dead, cut, "unreachable")).not.toBe("");
});

// No inventory row: the statuses no cause names, classified by the
// SDK's error classes today, which a client of the HTTP API must match.
conformance("verify", "any other status falls back as unreachable: 408 once its retries are spent, 404 at once", async (t) => {
  const [timeout, missing] = await Promise.all([
    oneRound(t, { fail: { status: 408 } }),
    oneRound(t, { fail: { status: 404 } }),
  ]);
  expect(timeout.requests).toBe(3);
  expect(fellBack(timeout.world, timeout.log, "unreachable")).toBe("HTTP 408");
  expect(missing.requests).toBe(1);
  expect(fellBack(missing.world, missing.log, "unreachable")).toBe("HTTP 404");
});

// jev.test.ts:151
conformance(
  "verify",
  "no answer within the client's 10 s timeout falls back as timed-out",
  async (t) => {
    // Each of the three tries waits out the timeout: about 32 s in all.
    const { world, log, requests } = await oneRound(t, { delayMs: 12_000 });
    expect(requests).toBe(3);
    expect(fellBack(world, log, "timed-out")).toBe("no answer within 10000ms");
  },
  { slow: true },
);

// jev.test.ts:159
conformance("verify", "400 and 422 fall back as invalid-question, carrying the API's message", async (t) => {
  const [badRequest, unprocessable] = await Promise.all([
    oneRound(t, { fail: { status: 400, body: { error: "question set refused" } } }),
    oneRound(t, { fail: { status: 422, body: { error: "question set refused" } } }),
  ]);
  for (const [{ world, log, requests }, status] of [
    [badRequest, 400],
    [unprocessable, 422],
  ] as const) {
    const detail = fellBack(world, log, "invalid-question");
    expect(detail.startsWith(`HTTP ${status}: `)).toBe(true);
    expect(detail).toContain("question set refused");
    // Neither is retried.
    expect(requests).toBe(1);
  }
});

// jev.test.ts:166
conformance("verify", "a 400 carrying max_tokens_exceeded falls back as evidence-too-large, any other as invalid-question", async (t) => {
  const tooLarge = { detail: { error_type: "max_tokens_exceeded" } };
  const [size, other, unprocessable] = await Promise.all([
    oneRound(t, { fail: { status: 400, body: tooLarge } }),
    oneRound(t, { fail: { status: 400, body: { detail: { error_type: "bad_question" } } } }),
    oneRound(t, { fail: { status: 422, body: tooLarge } }),
  ]);
  const sized = fellBack(size.world, size.log, "evidence-too-large");
  expect(sized.startsWith("HTTP 400: ")).toBe(true);
  expect(sized).toContain("max_tokens_exceeded");
  expect(fellBack(other.world, other.log, "invalid-question").startsWith("HTTP 400: ")).toBe(true);
  // A 422 is never a size rejection, whatever it carries.
  expect(fellBack(unprocessable.world, unprocessable.log, "invalid-question").startsWith("HTTP 422: ")).toBe(true);
});

// jev.test.ts:186
conformance("verify", "a 200 whose body is not JSON falls back as malformed", async (t) => {
  const { world, log, requests } = await oneRound(t, { garbage: true });
  expect(requests).toBe(1);
  expect(fellBack(world, log, "malformed")).toBe("response is not an object");
});

// jev.test.ts:191
conformance("verify", "an answer of the wrong type falls back as malformed, naming the question", async (t) => {
  const { world, log } = await oneRound(t, { answers: { ...CLEAN, ticket_fit: { type: "noul", noul: 0.5 } } });
  expect(fellBack(world, log, "malformed")).toBe("ticket_fit: answer type noul for a score");
});

/**
 * Tickets one after another, each at verify: 1 and asked once (or three
 * times, with the retries), Jev failing a Ticket's ask with the status
 * `failures` gives its id and answering the rest. Run until the Review.
 */
async function inTurn(
  t: Case,
  ids: string[],
  failures: Record<string, number>,
): Promise<{ log: string[]; asked: string[] }> {
  const world = t.world({ tickets: chain(ids), config: verifyEach(ids) });
  const jev = t.jev({
    answers: CLEAN,
    failFor: (state) => {
      const status = failures[ticketIdOf(state)];
      return status === undefined ? undefined : { status };
    },
  });
  const server = await t.start(world, { jev });
  await settleOnReview(server, 120_000);
  return { log: await poolLog(server), asked: jev.requests.map((request) => ticketIdOf(request.body.state)) };
}

// engine.test.ts:13466
conformance(
  "verify",
  "a fallback cause lands in the pool log once, and a recovery once, however many asks",
  async (t) => {
    const { log, asked } = await inTurn(t, ["01", "02", "03", "04"], { "01": 429, "02": 429 });
    expect(asked).toEqual(["01", "01", "01", "02", "02", "02", "03", "04"]);
    expect(jevLines(log)).toEqual([CONFIGURED, unavailable("rate-limited", "HTTP 429"), "Jev answering again"]);
    expect(log.filter((line) => line.includes("Jev could not grade"))).toEqual([
      couldNotGrade("01", 1, "rate-limited", "HTTP 429"),
      couldNotGrade("02", 1, "rate-limited", "HTTP 429"),
    ]);
  },
  { timeoutMs: 180_000 },
);

// jev.test.ts:267
conformance(
  "verify",
  "the pool log announces a cause once, again when it changes, and one recovery when answers resume",
  async (t) => {
    const ids = ["01", "02", "03", "04", "05", "06"];
    const { log, asked } = await inTurn(t, ids, { "01": 401, "02": 401, "03": 429, "04": 429 });
    expect(asked).toEqual(["01", "02", "03", "03", "03", "04", "04", "04", "05", "06"]);
    expect(jevLines(log)).toEqual([
      CONFIGURED,
      unavailable("bad-key", "HTTP 401"),
      unavailable("rate-limited", "HTTP 429"),
      "Jev answering again",
    ]);
    // Each round that fell back still says so itself.
    expect(log.filter((line) => line.includes("Jev could not grade"))).toEqual([
      couldNotGrade("01", 1, "bad-key", "HTTP 401"),
      couldNotGrade("02", 1, "bad-key", "HTTP 401"),
      couldNotGrade("03", 1, "rate-limited", "HTTP 429"),
      couldNotGrade("04", 1, "rate-limited", "HTTP 429"),
    ]);
    // The recovery lands as the first answered round grades.
    expect(log.indexOf("Jev answering again")).toBeLessThan(log.indexOf("ticket 05: grading 1 attempt with Jev"));
  },
  { timeoutMs: 180_000 },
);
