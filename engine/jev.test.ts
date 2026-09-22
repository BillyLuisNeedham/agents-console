/**
 * The Jev port (issue #105, ADR-0020) against the wire fake: the real SDK
 * client with a scripted fetch, so retries, error classes and body parsing
 * are the SDK's own. Every failure comes back as `{ ok: false, cause }`,
 * never a throw, and each cause is announced once.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  choice,
  createJev,
  JEV_BASE_URL,
  JEV_CHARS_PER_TOKEN,
  JEV_LIMITS,
  JEV_MODEL,
  noul,
  score,
  type Evidence,
  type Jev,
  type JevNotice,
  type Questions,
} from "./jev.ts";
import { fakeJev, startFakeJev, stopFakeJevs, type FakeJev } from "./jev-fake.ts";

afterEach(stopFakeJevs);

// The SDK's default is two retries with a backoff from 500ms: a suite that
// waits that out per failure is slow for nothing, so the port takes the
// retry policy as an option and the tests turn it down.
const NO_RETRY = { retry: { maxRetries: 0 } };
const ONE_QUICK_RETRY = { retry: { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 1 } };

const QUESTIONS = {
  waiting: noul("Is the agent waiting on the operator?", { true: "yes", false: "no" }),
  why: choice("Why did the attempt end?", { finished: null, stuck: null, ceiling: null }),
  brief: score("How complete is the Brief?", ["empty", "thin", "complete"]),
};
const EVIDENCE = { pane: "❯ ", ticket: "01" };

function configured(fake: FakeJev, extra: Record<string, unknown> = {}): Jev {
  return createJev({ apiKey: "test-key", fetch: fake.fetch, ...NO_RETRY, ...extra });
}

function noticesOf(jev: Jev): JevNotice[] {
  const seen: JevNotice[] = [];
  jev.subscribe((notice) => seen.push(notice));
  return seen;
}

describe("createJev: answers", () => {
  it("asks every question over one Evidence in one request and returns each typed Judgement", async () => {
    const fake = startFakeJev({ answers: { waiting: 0.93, why: "stuck", brief: 2 } });
    const jev = configured(fake);
    const result = await jev.ask(EVIDENCE, QUESTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.cause);
    expect(result.answers.waiting.noul).toBe(0.93);
    expect(result.answers.why.choice).toBe("stuck");
    expect(result.answers.why.probabilities.stuck).toBe(0.9);
    expect(result.answers.why.confidence).toBe(0.9);
    expect(result.answers.brief.score).toBeCloseTo(1.85);
    expect(result.answers.brief.probabilities["2"]).toBe(0.9);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    // One request, carrying the Evidence as state, every question, the pinned model.
    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req!.url).toBe(`${JEV_BASE_URL}/v1/systemone`);
    expect(req!.authorization).toBe("Bearer test-key");
    expect(req!.body.state).toEqual(EVIDENCE);
    expect(Object.keys(req!.body.questions)).toEqual(["waiting", "why", "brief"]);
    expect(req!.body.model).toBe(JEV_MODEL);
  });

  it("explicit configuration wins over everything the SDK would read from the environment", async () => {
    const saved = {
      key: process.env.TYPESAFE_API_KEY,
      url: process.env.TYPESAFE_BASE_URL,
      model: process.env.TYPESAFE_DEFAULT_MODEL,
    };
    process.env.TYPESAFE_API_KEY = "from-env";
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-from-env";
    try {
      const fake = startFakeJev();
      const jev = configured(fake);
      expect((await jev.ask(EVIDENCE, QUESTIONS)).ok).toBe(true);
      expect(fake.requests[0]!.url).toBe(`${JEV_BASE_URL}/v1/systemone`);
      expect(fake.requests[0]!.authorization).toBe("Bearer test-key");
      expect(fake.requests[0]!.body.model).toBe(JEV_MODEL);
      // And no key passed means unconfigured, whatever the environment holds:
      // the boundary decides, never the SDK's own fallback.
      const unset = createJev({ fetch: fake.fetch });
      expect(unset.configured).toBe(false);
      const result = await unset.ask(EVIDENCE, QUESTIONS);
      expect(result).toMatchObject({ ok: false, cause: "not-configured" });
      expect(fake.requests).toHaveLength(1);
    } finally {
      restore("TYPESAFE_API_KEY", saved.key);
      restore("TYPESAFE_BASE_URL", saved.url);
      restore("TYPESAFE_DEFAULT_MODEL", saved.model);
    }
  });
});

describe("createJev: fallback causes", () => {
  it("unconfigured: falls back before any request, announced once across many asks", async () => {
    const fake = startFakeJev();
    const jev = createJev({ fetch: fake.fetch });
    const notices = noticesOf(jev);
    expect(jev.configured).toBe(false);
    for (let i = 0; i < 3; i++) {
      expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "not-configured" });
    }
    expect(fake.requests).toHaveLength(0);
    expect(notices).toEqual([
      { kind: "unavailable", cause: "not-configured", detail: "no TYPESAFE_API_KEY at launch" },
    ]);
  });

  it("a rejected key (401 or 403) is bad-key", async () => {
    for (const status of [401, 403]) {
      const jev = configured(startFakeJev({ fail: { status } }));
      expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "bad-key" });
    }
  });

  it("429 is rate-limited, once the SDK's retries are spent", async () => {
    const fake = startFakeJev({ fail: { status: 429 } });
    const jev = configured(fake, ONE_QUICK_RETRY);
    expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "rate-limited" });
    expect(fake.requests).toHaveLength(2);
  });

  it("a transient failure the retry clears still answers", async () => {
    const fake = startFakeJev({ fail: { status: 529, times: 1 }, answers: { waiting: 0.2 } });
    const jev = configured(fake, ONE_QUICK_RETRY);
    const notices = noticesOf(jev);
    const result = await jev.ask(EVIDENCE, QUESTIONS);
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(2);
    expect(notices).toEqual([]);
  });

  it("a 5xx with no retry left is unreachable, as is a fetch that throws", async () => {
    const dead = configured(startFakeJev({ fail: { status: 500 } }));
    expect(await dead.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "unreachable" });
    const cut = configured(startFakeJev({ disconnect: true }));
    expect(await cut.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "unreachable" });
  });

  it("no answer within the timeout is timed-out", async () => {
    const jev = configured(startFakeJev({ delayMs: 500 }), { timeout: 20 });
    const result = await jev.ask(EVIDENCE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, cause: "timed-out" });
    if (result.ok) throw new Error("answered");
    expect(result.detail).toContain("20ms");
  });

  it("400 and 422 are invalid-question", async () => {
    for (const status of [400, 422]) {
      const jev = configured(startFakeJev({ fail: { status } }));
      expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "invalid-question" });
    }
  });

  it("a 400 carrying max_tokens_exceeded is evidence-too-large with the body preserved", async () => {
    const jev = configured(
      startFakeJev({ fail: { status: 400, body: { detail: { error_type: "max_tokens_exceeded" } } } }),
    );
    const result = await jev.ask(EVIDENCE, QUESTIONS);
    expect(result).toMatchObject({ ok: false, cause: "evidence-too-large" });
    if (result.ok) throw new Error("answered");
    expect(result.detail).toContain("max_tokens_exceeded");
    // A 400 for any other reason stays invalid-question.
    const other = configured(
      startFakeJev({ fail: { status: 400, body: { detail: { error_type: "bad_question" } } } }),
    );
    expect(await other.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "invalid-question" });
    // And 422 never becomes a size rejection, whatever it carries.
    const unprocessable = configured(
      startFakeJev({ fail: { status: 422, body: { detail: { error_type: "max_tokens_exceeded" } } } }),
    );
    expect(await unprocessable.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "invalid-question" });
  });

  it("a 200 whose body is not JSON is malformed", async () => {
    const jev = configured(startFakeJev({ garbage: true }));
    expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "malformed" });
  });

  it("an answer of the wrong type, or a label not offered, is malformed", async () => {
    const wrongType = configured(startFakeJev({ answers: { why: { type: "noul", noul: 0.2 } } }));
    const a = await wrongType.ask(EVIDENCE, QUESTIONS);
    expect(a).toMatchObject({ ok: false, cause: "malformed" });
    if (a.ok) throw new Error("answered");
    expect(a.detail).toContain("why");
    const offLabel = configured(
      startFakeJev({
        answers: { why: { choice: "other", confidence: 0.9, probabilities: { other: 0.9 } } },
      }),
    );
    expect(await offLabel.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "malformed" });
  });
});

describe("createJev: limits, checked before the wire", () => {
  it("a Choice past the label cap, a Score outside 2-10 levels, or no questions at all is invalid-question", async () => {
    const fake = startFakeJev();
    const jev = configured(fake);
    const tooMany = Object.fromEntries(
      Array.from({ length: JEV_LIMITS.choiceOptionsMax + 1 }, (_, i) => [`l${i}`, null]),
    );
    expect(await jev.ask(EVIDENCE, { pick: choice("which?", tooMany) })).toMatchObject({
      ok: false,
      cause: "invalid-question",
    });
    const eleven = { type: "score", instructions: "?", criteria: Array(11).fill("level") } as unknown as Questions[string];
    expect(await jev.ask(EVIDENCE, { rate: eleven })).toMatchObject({ ok: false, cause: "invalid-question" });
    const one = { type: "score", instructions: "?", criteria: ["only"] } as unknown as Questions[string];
    expect(await jev.ask(EVIDENCE, { rate: one })).toMatchObject({ ok: false, cause: "invalid-question" });
    expect(await jev.ask(EVIDENCE, {})).toMatchObject({ ok: false, cause: "invalid-question" });
    expect(fake.requests).toHaveLength(0);
  });

  it("Evidence past the token estimate is evidence-too-large", async () => {
    const fake = startFakeJev();
    const jev = configured(fake);
    const huge = {
      log: "x".repeat(Math.ceil(JEV_LIMITS.evidenceTokens * JEV_CHARS_PER_TOKEN) + 100),
    };
    expect(await jev.ask(huge, QUESTIONS)).toMatchObject({ ok: false, cause: "evidence-too-large" });
    expect(fake.requests).toHaveLength(0);
  });

  it("about 120k characters of real Evidence is evidence-too-large before the wire", async () => {
    const fake = startFakeJev();
    const jev = configured(fake);
    // The size a live bench measured on 2026-09-20: it passed the old
    // four-characters-per-token guess at about 30k and was rejected by the
    // API at about 35k real tokens.
    const evidence = evidenceOf(120_000);
    expect(JSON.stringify(evidence).length).toBe(120_000);
    expect(await jev.ask(evidence, QUESTIONS)).toMatchObject({ ok: false, cause: "evidence-too-large" });
    expect(fake.requests).toHaveLength(0);
  });

  it("the estimate counts the longest question as well as the Evidence", async () => {
    const fake = startFakeJev();
    const jev = configured(fake);
    // Evidence one margin short of the budget on its own: it fits with a
    // short question and does not once a long question joins it.
    const budgetChars = Math.floor(JEV_LIMITS.evidenceTokens * JEV_CHARS_PER_TOKEN);
    const evidence = evidenceOf(budgetChars - 1_000);
    const long = "Describe what happened to this attempt in complete sentences. ".repeat(20);
    expect(await jev.ask(evidence, { why: choice(long, { finished: null, stuck: null }) })).toMatchObject({
      ok: false,
      cause: "evidence-too-large",
    });
    expect(fake.requests).toHaveLength(0);
    // The same Evidence with a short question fits, in one request.
    expect((await jev.ask(evidence, { why: choice("Why?", { finished: null, stuck: null }) })).ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("createJev: notices", () => {
  it("announces a cause once, again when the cause changes, and one recovery when answers resume", async () => {
    let current = startFakeJev({ fail: { status: 401 } });
    const jev = createJev({
      apiKey: "k",
      fetch: (input, init) => current.fetch(input, init),
      ...NO_RETRY,
    });
    const notices = noticesOf(jev);
    await jev.ask(EVIDENCE, QUESTIONS);
    await jev.ask(EVIDENCE, QUESTIONS);
    current = startFakeJev({ fail: { status: 429 } });
    await jev.ask(EVIDENCE, QUESTIONS);
    await jev.ask(EVIDENCE, QUESTIONS);
    current = startFakeJev();
    await jev.ask(EVIDENCE, QUESTIONS);
    await jev.ask(EVIDENCE, QUESTIONS);
    expect(notices.map((n) => (n.kind === "recovered" ? "recovered" : n.cause))).toEqual([
      "bad-key",
      "rate-limited",
      "recovered",
    ]);
  });

  it("unsubscribing stops the notices", async () => {
    const jev = configured(startFakeJev({ fail: { status: 401 } }));
    const seen: JevNotice[] = [];
    const off = jev.subscribe((n) => seen.push(n));
    off();
    await jev.ask(EVIDENCE, QUESTIONS);
    expect(seen).toEqual([]);
  });
});

describe("fakeJev, the port fake", () => {
  it("answers by question id, falls back by scripted cause, and announces through the same board", async () => {
    const jev = fakeJev({ answers: { waiting: 0.8, why: "ceiling" } });
    const notices = noticesOf(jev);
    const answered = await jev.ask(EVIDENCE, QUESTIONS);
    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(answered.cause);
    expect(answered.answers.waiting.noul).toBe(0.8);
    expect(answered.answers.why.choice).toBe("ceiling");
    expect(answered.answers.brief.probabilities["0"]).toBeCloseTo(1 / 3);
    jev.script({ cause: "timed-out" });
    expect(await jev.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "timed-out" });
    jev.script({});
    expect((await jev.ask(EVIDENCE, QUESTIONS)).ok).toBe(true);
    expect(jev.asks).toHaveLength(3);
    expect(notices.map((n) => (n.kind === "recovered" ? "recovered" : n.cause))).toEqual([
      "timed-out",
      "recovered",
    ]);
    const unset = fakeJev({ configured: false });
    expect(unset.configured).toBe(false);
    expect(await unset.ask(EVIDENCE, QUESTIONS)).toMatchObject({ ok: false, cause: "not-configured" });
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Evidence whose serialised JSON is exactly `length` characters: repetitive English, like a log read. */
function evidenceOf(length: number): Evidence {
  const sentence = "the agent is waiting on the operator. ";
  const filler = sentence.repeat(Math.ceil(length / sentence.length) + 1);
  return { log: filler.slice(0, length - 10) };
}
