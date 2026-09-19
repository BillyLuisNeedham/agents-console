/**
 * Jev, the judgement model (issue #105; ADR-0020,
 * docs/adr/0020-jev-gates-paths-engine-writes-status.md). This is the one
 * module that talks to TypeSafe's SDK. It hands the engine a port that asks
 * narrow, typed questions over one Evidence object and gets a Judgement per
 * question back, or a cause for why it could not.
 *
 * The port is failsafe by construction. `ask` never throws: a pool without
 * a key, a bad key, a rate limit, a timeout, a dead network, or a response
 * that does not parse all come back as `{ ok: false, cause }`, and the call
 * site takes the heuristic path it always had. A cause is announced to
 * subscribers the first time it makes an ask fall back and again only when
 * the cause changes, so the pool log carries one line per cause rather than
 * one per call.
 *
 * The API key never enters this module from the environment: the CLI
 * boundary (server.ts) reads `TYPESAFE_API_KEY` and passes it in. Every
 * option the SDK would otherwise read from `process.env` (base URL, model,
 * log level) is passed explicitly here, so nothing below the boundary
 * consults the environment (the rule at engine.ts, RunOptions).
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  choice,
  noul,
  score,
  type ChoiceResponse,
  type Fetch,
  type JsonValue,
  type NoulResponse,
  type Question,
  type Questions,
  type RetryPolicy,
  type ScoreResponse,
  type SystemOneResult,
  type Usage,
} from "@typesafe-ai/sdk";

// The question helpers and answer types, re-exported so a call site imports
// everything Jev-shaped from here and never from the SDK directly.
export { choice, noul, score };
export type {
  ChoiceResponse,
  NoulResponse,
  Question,
  Questions,
  ScoreResponse,
  Usage,
};

/** The model every request names; the SDK's own default, pinned here so a `TYPESAFE_DEFAULT_MODEL` in the environment changes nothing. */
export const JEV_MODEL = "jev-latest";
/** The API root, pinned for the same reason as the model. */
export const JEV_BASE_URL = "https://api.typesafe.ai";

/**
 * The documented limits (https://docs.typesafe.ai/llms.txt). The token
 * limits are enforced here by estimate, so an oversized Evidence falls back
 * at once instead of paying a round trip for a 422; the structural ones
 * are exact.
 */
export const JEV_LIMITS = {
  /** Tokens per request: Evidence, questions and answers together. */
  requestTokens: 64_000,
  /** Tokens the Evidence alone may take. */
  evidenceTokens: 32_000,
  /** Labels one Choice may offer. */
  choiceOptionsMax: 255,
  /** Levels one Score rubric may have, inclusive. */
  scoreLevelsMin: 2,
  scoreLevelsMax: 10,
} as const;
/** The estimate the size checks use: roughly four characters per token. */
export const JEV_CHARS_PER_TOKEN = 4;
/** Cost per million input tokens in USD; output is free. Informational. */
export const JEV_INPUT_USD_PER_MILLION_TOKENS = 0.042;
/** Typical round-trip latency, for the reader deciding where a call belongs. */
export const JEV_TYPICAL_LATENCY_MS = 150;

/** The named JSON object a call site hands Jev: only the context the questions need. */
export type Evidence = { readonly [key: string]: JsonValue };

/** Why an ask fell back to the heuristic path. */
export type JevCause =
  | "not-configured"
  | "bad-key"
  | "rate-limited"
  | "timed-out"
  | "unreachable"
  | "malformed"
  | "invalid-question"
  | "evidence-too-large";

/** The Judgements for one ask, or the one cause it produced none. */
export type JevResult<Q extends Questions> =
  | { ok: true; answers: SystemOneResult<Q>["answers"]; usage: Usage }
  | { ok: false; cause: JevCause; detail: string };

/** What subscribers hear: a cause the first time it bites, and one recovery once asks succeed again. */
export type JevNotice =
  | { kind: "unavailable"; cause: JevCause; detail: string }
  | { kind: "recovered" };

export interface Jev {
  /** False for the port a pool without a key gets: every ask falls back at once, nothing is ever sent. */
  readonly configured: boolean;
  /** Ask every question over one Evidence in one request. Never throws. */
  ask<Q extends Questions>(evidence: Evidence, questions: Q): Promise<JevResult<Q>>;
  /** Hear each fallback cause once (and a recovery), not once per call. Returns the unsubscribe. */
  subscribe(listener: (notice: JevNotice) => void): () => void;
}

export interface JevOptions {
  /** The key the CLI boundary read. Absent, the port is unconfigured. */
  apiKey?: string;
  /** Transport override; the wire fake hands one in. Defaults to global fetch. */
  fetch?: Fetch;
  /** Per-attempt timeout in ms; the SDK's default (10s) when unset. */
  timeout?: number;
  /** Retry overrides; the SDK's default (2 retries, backoff from 500ms) when unset. */
  retry?: Partial<RetryPolicy>;
}

/**
 * The dedupe every port shares (the real one and the fake): a cause is
 * announced when it differs from the last one, and a recovery once after
 * any fallback. Comparing against remembered state, not a seen-set, so a
 * cause that returns after a different one is heard again.
 */
export function createNoticeBoard(): {
  subscribe: Jev["subscribe"];
  fellBack(cause: JevCause, detail: string): void;
  succeeded(): void;
} {
  const listeners = new Set<(notice: JevNotice) => void>();
  let lastCause: JevCause | null = null;
  const announce = (notice: JevNotice): void => {
    for (const listener of listeners) listener(notice);
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fellBack(cause, detail) {
      if (cause === lastCause) return;
      lastCause = cause;
      announce({ kind: "unavailable", cause, detail });
    },
    succeeded() {
      if (lastCause === null) return;
      lastCause = null;
      announce({ kind: "recovered" });
    },
  };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function createJev(options: JevOptions = {}): Jev {
  const board = createNoticeBoard();
  const configured = typeof options.apiKey === "string" && options.apiKey.length > 0;
  // Built only with a key: the SDK's constructor otherwise falls back to
  // the environment for one, which is exactly the read this module must
  // not make.
  const client = configured
    ? new TypeSafeClient({
        apiKey: options.apiKey,
        baseURL: JEV_BASE_URL,
        defaultModel: JEV_MODEL,
        logLevel: "error",
        logger: silentLogger,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.retry ? { retry: options.retry } : {}),
      })
    : null;

  const fallBack = <Q extends Questions>(
    cause: JevCause,
    detail: string,
  ): JevResult<Q> => {
    board.fellBack(cause, detail);
    return { ok: false, cause, detail };
  };

  return {
    configured,
    subscribe: board.subscribe,
    async ask(evidence, questions) {
      if (!client) return fallBack("not-configured", "no TYPESAFE_API_KEY at launch");
      const rejected = checkQuestions(questions) ?? checkEvidence(evidence);
      if (rejected) return fallBack(rejected.cause, rejected.detail);
      let result: SystemOneResult<typeof questions>;
      try {
        result = await client.systemOne({ state: evidence, questions, model: JEV_MODEL });
      } catch (err) {
        const { cause, detail } = classifyError(err);
        return fallBack(cause, detail);
      }
      const malformed = checkAnswers(questions, result);
      if (malformed) return fallBack("malformed", malformed);
      board.succeeded();
      return { ok: true, answers: result.answers, usage: result.usage };
    },
  };
}

type Rejection = { cause: JevCause; detail: string };

function checkQuestions(questions: Questions): Rejection | null {
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    return { cause: "invalid-question", detail: "no questions" };
  }
  for (const [id, question] of entries) {
    if (question.type === "choice") {
      const labels = Object.keys(question.criteria).length;
      if (labels < 2 || labels > JEV_LIMITS.choiceOptionsMax) {
        return {
          cause: "invalid-question",
          detail: `${id}: a Choice needs 2 to ${JEV_LIMITS.choiceOptionsMax} labels, has ${labels}`,
        };
      }
    } else if (question.type === "score") {
      const levels = question.criteria.length;
      if (levels < JEV_LIMITS.scoreLevelsMin || levels > JEV_LIMITS.scoreLevelsMax) {
        return {
          cause: "invalid-question",
          detail: `${id}: a Score needs ${JEV_LIMITS.scoreLevelsMin} to ${JEV_LIMITS.scoreLevelsMax} levels, has ${levels}`,
        };
      }
    } else if (question.type !== "noul") {
      return { cause: "invalid-question", detail: `${id}: unknown question type` };
    }
  }
  return null;
}

function checkEvidence(evidence: Evidence): Rejection | null {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { cause: "invalid-question", detail: "Evidence must be a named JSON object" };
  }
  const tokens = Math.ceil(JSON.stringify(evidence).length / JEV_CHARS_PER_TOKEN);
  if (tokens > JEV_LIMITS.evidenceTokens) {
    return {
      cause: "evidence-too-large",
      detail: `about ${tokens} tokens of Evidence, limit ${JEV_LIMITS.evidenceTokens}`,
    };
  }
  return null;
}

function classifyError(err: unknown): Rejection {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return { cause: "bad-key", detail: `HTTP ${err.status}` };
  }
  if (err instanceof RateLimitError) return { cause: "rate-limited", detail: "HTTP 429" };
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    return { cause: "invalid-question", detail: `HTTP ${err.status}: ${message}` };
  }
  if (err instanceof APITimeoutError) {
    return { cause: "timed-out", detail: `no answer within ${err.timeoutMs}ms` };
  }
  if (err instanceof APIConnectionError) return { cause: "unreachable", detail: message };
  if (err instanceof APIError) return { cause: "unreachable", detail: `HTTP ${err.status}` };
  return { cause: "malformed", detail: message };
}

/** The response is trusted only once every question has an answer of its own type and shape. */
function checkAnswers(questions: Questions, result: unknown): string | null {
  if (result === null || typeof result !== "object") return "response is not an object";
  const answers = (result as { answers?: unknown }).answers;
  if (answers === null || typeof answers !== "object") return "response has no answers";
  for (const [id, question] of Object.entries(questions)) {
    const answer = (answers as Record<string, unknown>)[id];
    if (answer === null || typeof answer !== "object") return `no answer for ${id}`;
    const a = answer as Record<string, unknown>;
    if (a.type !== question.type) return `${id}: answer type ${String(a.type)} for a ${question.type}`;
    if (question.type === "noul") {
      if (!isProbability(a.noul)) return `${id}: noul is not a probability`;
    } else if (question.type === "choice") {
      if (typeof a.choice !== "string" || !(a.choice in question.criteria)) {
        return `${id}: choice is not one of the labels`;
      }
      if (!isProbability(a.confidence)) return `${id}: confidence is not a probability`;
      if (a.probabilities === null || typeof a.probabilities !== "object") {
        return `${id}: no probabilities`;
      }
    } else {
      if (typeof a.score !== "number" || !Number.isFinite(a.score)) return `${id}: score is not a number`;
      if (!isProbability(a.confidence)) return `${id}: confidence is not a probability`;
      if (a.probabilities === null || typeof a.probabilities !== "object") {
        return `${id}: no probabilities`;
      }
    }
  }
  return null;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}
