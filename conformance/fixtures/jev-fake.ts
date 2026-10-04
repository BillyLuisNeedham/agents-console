/**
 * The Jev wire fake, in the herdr-fake.ts spirit: not a test file, so
 * importing it never drags another suite's cases in.
 *
 * It speaks the real request and response shape of `POST /v1/systemone`,
 * scripted by options (an answer per question id, a failure to serve, a
 * garbage body, a delay); assertions read `requests` afterwards. It comes
 * in two forms over one handler:
 *
 * - `startFakeJev` is a scripted `fetch` handed to the real SDK client, so
 *   jev.test.ts exercises the SDK's retries, error classes and body parsing
 *   for real without a network.
 * - `serveFakeJev` is the same fake as an HTTP server on a free local port,
 *   for a server under test running as its own process: the CLI boundary
 *   reads `JEV_BASE_URL` beside `TYPESAFE_API_KEY`, so a conformance case
 *   points the server at `url` and scripts what Jev answers (ADR-0036).
 *
 * It sits in conformance/fixtures (ADR-0036), where nothing may import the
 * engine but the wire's types, so it speaks only the API's own shapes. The
 * port fake that answers through `answerFor` without the SDK at all is the
 * engine's own Jev port, notice board included, so it stays with the engine
 * suites as engine/jev-port-fake.ts.
 */

import type { Fetch, Question, Questions } from "@typesafe-ai/sdk";

/** The model the API answers with when a request names none. */
const DEFAULT_MODEL = "jev-latest";

/** Characters per token in the usage the fake reports: the API's measured rate. */
const CHARS_PER_TOKEN = 3.5;

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
  /**
   * Answers by question id for one request, from the Evidence it carries
   * as `state`; laid over `answers`. How a case answers each Attempt of a
   * verify round differently, whatever order the asks arrive in.
   */
  answersFor?: (state: unknown) => Record<string, ScriptedAnswer>;
  /** Serve this HTTP status instead of answers, for the first `times` requests (every request when unset). */
  fail?: { status: number; body?: unknown; times?: number };
  /**
   * Serve this HTTP status instead of answers for one request, from the
   * Evidence it carries as `state`; undefined lets the request through to
   * `fail` and the answers. How a case fails one Attempt's ask, or one
   * Ticket's, and answers the rest, whatever order the asks arrive in.
   */
  failFor?: (state: unknown) => { status: number; body?: unknown } | undefined;
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
  const fake = fakeJevHandler(options);
  const fetch: Fetch = async (input, init) => {
    const response = await fake.respond(input, new Headers(init?.headers), String(init?.body ?? "{}"), init?.signal);
    if (response === "disconnect") throw new TypeError("fetch failed: connection refused");
    return response;
  };
  return { fetch, requests: fake.requests };
}

/** The served fake: `disconnect` has no meaning over a socket, so a case wanting a dead network points the server at a port nobody listens on. */
export type ServedFakeJevOptions = Omit<FakeJevOptions, "disconnect">;

export interface ServedFakeJev {
  /** The API root to hand a server as `JEV_BASE_URL`, `http://127.0.0.1:<port>`. */
  url: string;
  requests: FakeJevRequest[];
  stop(): Promise<void>;
}

/** The fake as an HTTP server on a free local port. Every request is recorded; any path but `POST /v1/systemone` answers 404. */
export function serveFakeJev(options: ServedFakeJevOptions = {}): ServedFakeJev {
  const fake = fakeJevHandler(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Bun cuts a connection idle for 10 s by default, the client's own
    // timeout too: a `delayMs` past it must be the client's to time out.
    idleTimeout: 0,
    async fetch(request) {
      const body = await request.text();
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/systemone") {
        fake.requests.push({ url: request.url, authorization: request.headers.get("authorization"), body: parseBody(body) });
        return json(404, { error: `no route ${request.method} ${new URL(request.url).pathname}` });
      }
      const response = await fake.respond(request.url, request.headers, body, request.signal);
      if (response === "disconnect") throw new Error("unreachable: the served fake takes no disconnect");
      return response;
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: fake.requests,
    async stop() {
      await server.stop(true);
    },
  };
}

function parseBody(text: string): FakeJevRequest["body"] {
  try {
    return JSON.parse(text) as FakeJevRequest["body"];
  } catch {
    return { state: text, questions: {} };
  }
}

/** The one reading of the options both forms share: record the request, then serve what was scripted. */
function fakeJevHandler(options: FakeJevOptions): {
  requests: FakeJevRequest[];
  respond(
    url: string,
    headers: Headers,
    rawBody: string,
    signal: AbortSignal | null | undefined,
  ): Promise<Response | "disconnect">;
} {
  const requests: FakeJevRequest[] = [];
  let failuresServed = 0;
  return {
    requests,
    async respond(url, headers, rawBody, signal) {
      const body = JSON.parse(rawBody) as FakeJevRequest["body"];
      requests.push({ url, authorization: headers.get("authorization"), body });

      if (options.delayMs !== undefined) await hold(options.delayMs, signal);
      if (options.disconnect) return "disconnect";
      const failure = options.failFor?.(body.state);
      if (failure) return json(failure.status, failure.body ?? { error: `status ${failure.status}` });
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
      const scripted = { ...options.answers, ...options.answersFor?.(body.state) };
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        answers[id] = answerFor(question, scripted[id]);
      }
      return json(200, {
        model: body.model ?? DEFAULT_MODEL,
        answers,
        usage: {
          input_tokens: Math.ceil(rawBody.length / CHARS_PER_TOKEN),
          output_tokens: 0,
        },
      });
    },
  };
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
