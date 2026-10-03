/**
 * The Jev port fake: it implements the `Jev` port without the SDK at all,
 * answering by question id, so an engine suite can say "Jev answers waiting
 * at 0.93" or "Jev is rate-limited" and drive a call site. Not a test file,
 * so importing it never drags another suite's cases in.
 *
 * Its answers come from the wire fake's `answerFor`, so the wording a suite
 * scripts here is the wording the wire would carry. The wire fake moved to
 * conformance/fixtures (ADR-0036); this half stays with the engine because
 * it is the engine's own port, notice board included, and means nothing
 * outside the TypeScript process.
 */

import { answerFor, type ScriptedAnswer } from "../conformance/fixtures/jev-fake.ts";
import {
  createNoticeBoard,
  JEV_MODEL,
  type Evidence,
  type Jev,
  type JevCause,
  type JevResult,
  type Questions,
} from "./jev.ts";

export interface PortFakeOptions {
  /** Answers by question id, as for the wire fake. */
  answers?: Record<string, ScriptedAnswer>;
  /**
   * A per-ask answer script chosen from the Evidence, for a suite that needs
   * one port to answer two Attempts differently (a verify round grades each
   * Attempt over its own Evidence). Wins over `answers` when it returns a
   * map; returning undefined falls back to `answers`.
   */
  answersFor?: (evidence: Evidence) => Record<string, ScriptedAnswer> | undefined;
  /**
   * Fail the asks whose Evidence `failFor` selects, for a suite that needs
   * one port to answer one Attempt and fall back on another (a verify round
   * is one instrument, so a failure on any Attempt falls the whole round
   * back). Checked after `cause`, which fails every ask; returning undefined
   * answers normally. `detail` defaults to "scripted by the test".
   */
  failFor?: (evidence: Evidence) => { cause: JevCause; detail?: string } | undefined;
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
      const failure = options.failFor?.(evidence);
      if (failure) {
        const detail = failure.detail ?? "scripted by the test";
        board.fellBack(failure.cause, detail);
        return { ok: false, cause: failure.cause, detail };
      }
      const scripted = options.answersFor?.(evidence) ?? answers;
      const built: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(questions)) {
        built[id] = answerFor(question, scripted[id]);
      }
      board.succeeded();
      return {
        ok: true,
        answers: built as unknown as Extract<JevResult<Q>, { ok: true }>["answers"],
        usage: { input_tokens: 0, output_tokens: 0 },
        model: JEV_MODEL,
      };
    },
  };
}
