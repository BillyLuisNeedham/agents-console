/**
 * The two Jev fakes, in the herdr-fake.ts spirit: not a test file, so
 * importing one never drags another suite's cases in.
 *
 * `startFakeJev` is the wire fake: a scripted `fetch` handed to the real
 * SDK client, speaking the real request and response shape of
 * `POST /v1/systemone`, so jev.test.ts exercises the SDK's retries, error
 * classes and body parsing for real without a network. Scripted by options
 * (an answer per question id, a failure to serve, a garbage body, a delay);
 * assertions read `requests` afterwards.
 *
 * `fakeJev` is the port fake: it implements the `Jev` port without the SDK
 * at all, answering by question id, so an engine suite can say "Jev
 * answers waiting at 0.93" or "Jev is rate-limited" and drive a call site.
 */

import {
  createNoticeBoard,
  JEV_CHARS_PER_TOKEN,
  JEV_MODEL,
  type Evidence,
  type Jev,
  type JevCause,
  type JevResult,
  type Question,
  type Questions,
} from "./jev.ts";
import type { Fetch, SystemOneResult } from "@typesafe-ai/sdk";

/**
 * How a test scripts one answer: a number for a Noul (the probability of
 * yes) or a Score (the level, given 0.9 of the mass), a string for a Choice
 * (the label, given 0.9 of the mass), or a full answer object to use as is.
 */
export type ScriptedAnswer = number | string | Record<string, unknown>;

/** The mass a scripted label or level gets; the rest is spread evenly. */
const SCRIPTED_MASS = 0.9;

export interface FakeJevRequest {
  url: string;
  authorization: string | null;
  body: { state: unknown; questions: Questions; model?: string };
}

export interface FakeJevOptions {
  /** Answers by question id; an unscripted question gets a uniform answer of its type. */
  answers?: Record<string, ScriptedAnswer>;
  /** Serve this HTTP status instead of answers, for the first `times` requests (every request when unset). */
  fail?: { status: number; body?: unknown; times?: number };
  /** Serve a 200 whose body is not JSON. */
  garbage?: boolean;
  /** Hold every response this long; with the SDK timeout shorter, the request times out. */
  delayMs?: number;
  /** Reject from fetch itself, the shape of a dead network. */
  disconnect?: boolean;
}

export interface FakeJev {
  fetch: Fetch;
  requests: FakeJevRequest[];
}

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** Clear every delayed response still pending, for `afterEach`. */
export function stopFakeJevs(): void {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
}

export function startFakeJev(options: FakeJevOptions = {}): FakeJev {
  const requests: FakeJevRequest[] = [];
  let failuresServed = 0;

  const fetch: Fetch = async (input, init) => {
    const url = input;
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as FakeJevRequest["body"];
    requests.push({ url, authorization: headers.get("authorization"), body });

    if (options.delayMs !== undefined) await hold(options.delayMs, init?.signal);
    if (options.disconnect) throw new TypeError("fetch failed: connection refused");
    if (options.fail && (options.fail.times === undefined || failuresServed < options.fail.times)) {
      failuresServed += 1;
      return json(options.fail.status, options.fail.body ?? { error: `status ${options.fail.status}` });
    }
    if (options.garbage) {
      return new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] = answerFor(question, options.answers?.[id]);
    }
    return json(200, {
      model: JEV_MODEL,
      answers,
      usage: {
        input_tokens: Math.ceil(String(init?.body ?? "").length / JEV_CHARS_PER_TOKEN),
        output_tokens: 0,
      },
    });
  };

  return { fetch, requests };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Wait, but let the SDK's abort (its timeout) win, as a real fetch would. */
function hold(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    pendingTimers.add(timer);
    function onAbort(): void {
      clearTimeout(timer);
      pendingTimers.delete(timer);
      reject(new DOMException("This operation was aborted", "AbortError"));
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One answer of the question's type, scripted or uniform. */
export function answerFor(question: Question, scripted: ScriptedAnswer | undefined): Record<string, unknown> {
  if (scripted !== null && typeof scripted === "object") return { type: question.type, ...scripted };
  if (question.type === "noul") {
    return { type: "noul", noul: typeof scripted === "number" ? scripted : 0.5 };
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    const picked = typeof scripted === "string" ? scripted : labels[0]!;
    const probabilities = spread(labels, typeof scripted === "string" ? picked : null);
    return { type: "choice", choice: picked, confidence: confidenceOf(probabilities), probabilities };
  }
  const levels = question.criteria.map((_, i) => String(i));
  const picked = typeof scripted === "number" ? String(scripted) : null;
  const probabilities = spread(levels, picked);
  const expected = levels.reduce((sum, level) => sum + Number(level) * probabilities[level]!, 0);
  const legend = Object.fromEntries(question.criteria.map((text, i) => [String(i), text]));
  return { type: "score", score: expected, confidence: confidenceOf(probabilities), legend, probabilities };
}

function spread(keys: string[], picked: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (picked === null || keys.length === 1) {
    for (const key of keys) out[key] = 1 / keys.length;
    return out;
  }
  const rest = (1 - SCRIPTED_MASS) / (keys.length - 1);
  for (const key of keys) out[key] = key === picked ? SCRIPTED_MASS : rest;
  return out;
}

function confidenceOf(probabilities: Record<string, number>): number {
  return Math.max(...Object.values(probabilities));
}

export interface PortFakeOptions {
  /** Answers by question id, as for the wire fake. */
  answers?: Record<string, ScriptedAnswer>;
  /** Fall back with this cause on every ask instead of answering. */
  cause?: JevCause;
  /** Report as unconfigured (every ask falls back with `not-configured`). Default: configured. */
  configured?: boolean;
}

export interface PortFake extends Jev {
  asks: { evidence: Evidence; questions: Questions }[];
  /** Change what later asks do, to play a recovery or a new cause mid-test. */
  script(next: Pick<PortFakeOptions, "answers" | "cause">): void;
}

export function fakeJev(options: PortFakeOptions = {}): PortFake {
  const board = createNoticeBoard();
  const configured = options.configured ?? true;
  let answers = options.answers ?? {};
  let cause: JevCause | undefined = configured ? options.cause : "not-configured";
  const asks: PortFake["asks"] = [];
  return {
    configured,
    asks,
    subscribe: board.subscribe,
    script(next) {
      answers = next.answers ?? answers;
      cause = next.cause;
    },
    async ask<Q extends Questions>(evidence: Evidence, questions: Q): Promise<JevResult<Q>> {
      asks.push({ evidence, questions });
      if (cause) {
        board.fellBack(cause, "scripted by the test");
        return { ok: false, cause, detail: "scripted by the test" };
      }
      const built: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(questions)) {
        built[id] = answerFor(question, answers[id]);
      }
      board.succeeded();
      return {
        ok: true,
        answers: built as unknown as SystemOneResult<Q>["answers"],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  };
}
