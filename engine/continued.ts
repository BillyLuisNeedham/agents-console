/**
 * Continued attempts (issue #139, CONTEXT.md "Continued attempt"): the
 * runtime half of Keep talking. Where the engine's one-shot claim
 * (engine.ts's keepTalking) answers the checkpoint Interrupt, numbers the
 * Attempt and records its `spawned` event, this module owns what lives on in
 * the Held pane: the derived log, the operator's focus, the one teaching Turn
 * and the watch for the ending.
 *
 * A Continued attempt launches nothing. The harness is the checkpointed
 * Attempt's TUI, still running under that attempt's wrapper, so there is no
 * wrapper of its own, no exit-code file of its own and no Stream file of its
 * own: `script` keeps writing the Stream file of the attempt it continues.
 * That shapes the three jobs here.
 *
 * - The log: the pane's Stream file is tailed from where it stood when the
 *   Continued attempt began, so its log is its own part of the session.
 * - The teaching Turn: the agent was told where its Outcome went, and that
 *   Outcome is written; it has to be told a fresh one is expected. The Turn is
 *   typed once the pane is waiting, never mid-reply, exactly as an enlist's
 *   is, bounded the same way; a pane that will not take it ends the attempt
 *   untaught, since an agent that does not know it owes an Outcome would
 *   leave the ticket running forever.
 * - The ending: an enlisted attempt's two-form race (enlisted.ts), a valid
 *   Outcome on disk against the pane leaving herdr's listing, because the
 *   wrapper's exit-code file belongs to the attempt before and only lands
 *   when the TUI is closed, which the pane leaving already says.
 *
 * The engine records whatever ending this reports; nothing here writes pool
 * state.
 */

import { focusPane, peekPane } from "./herdr.ts";
import { startPaneStreamTail } from "./attempt-run.ts";
import { waitForEnlistedEnding } from "./enlisted.ts";
import { READINESS_TIMEOUT_MS, typeVerified } from "./pane-session.ts";
import { defaultHarnessDescriptors, idlePatternFor } from "./spawn.ts";
import { FRESH_TURN, IDLE_STABLE_READS, nextTurnState } from "./turn-state.ts";

const CONTINUED_POLL_MS = 2_000;

/**
 * How a Continued attempt ended: its Outcome landed, its pane went with none
 * behind it, or the teaching Turn could not be typed (with why). `released`
 * is the engine letting go first (an abandoned adoption, a shutdown), which
 * is no ending at all and records nothing.
 */
export type ContinuedEnding =
  | { kind: "outcome" }
  | { kind: "pane-gone" }
  | { kind: "untaught"; reason: string }
  | { kind: "released" };

export interface ContinuedEnv {
  herdrSocket: string;
  /** How often the Turn wait and the ending race re-read; 2s unless a test shortens it. */
  pollMs?: number;
  /** How long the teaching Turn waits for a working pane; a Launch's bound unless a test shortens it. */
  teachingWaitMs?: number;
}

export interface ContinuedInput {
  paneId: string;
  /** The harness the pane runs, for its Turn-state and echo patterns. */
  harness: string;
  /** The teaching Turn; null for a pane re-adopted at boot, taught before the restart. */
  teaching: string | null;
  /** Whether to bring the pane forward in the operator's herdr first. */
  focus: boolean;
  /** Where the agent writes this attempt's Outcome; the ending race reads it. */
  outcomePath: string;
  /** The Stream file the pane's `script` writes, and where it stood at the start. */
  streamPath: string | null;
  streamOffset: number;
  /** This attempt's derived log. */
  logPath: string;
}

export interface ContinuedRun {
  /** The ending, once observed; never rejects. The derived log is drained first. */
  ending: Promise<ContinuedEnding>;
  /** Let the pane go without an ending: the watch and the tail stop. */
  release(): void;
}

/** Start a Continued attempt's runtime in its Held pane. */
export function runContinued(env: ContinuedEnv, input: ContinuedInput): ContinuedRun {
  const pollMs = env.pollMs ?? CONTINUED_POLL_MS;
  const teachingWaitMs = env.teachingWaitMs ?? READINESS_TIMEOUT_MS;
  const released = new AbortController();
  const tailer = input.streamPath
    ? startPaneStreamTail(input.streamPath, input.logPath, input.streamOffset)
    : null;
  const whenReleased = new Promise<ContinuedEnding>((resolve) => {
    released.signal.addEventListener("abort", () => resolve({ kind: "released" }), {
      once: true,
    });
  });
  const watch = async (): Promise<ContinuedEnding> => {
    // The operator chose to talk: the pane comes forward the moment the
    // attempt is theirs. Best-effort, as every focus is.
    if (input.focus) await focusPane(env.herdrSocket, input.paneId).catch(() => {});
    if (input.teaching !== null) {
      const taught = await teach(env.herdrSocket, input, pollMs, teachingWaitMs, released.signal);
      if (taught !== null) return { kind: "untaught", reason: taught };
    }
    const ending = await waitForEnlistedEnding(
      env.herdrSocket,
      input.paneId,
      input.outcomePath,
      released.signal,
      pollMs,
    );
    return { kind: ending };
  };
  const ending = Promise.race([
    watch().catch((err): ContinuedEnding => ({
      kind: "untaught",
      reason: err instanceof Error ? err.message : String(err),
    })),
    whenReleased,
  ]).then(async (result) => {
    if (tailer) await tailer.finish().catch(() => {});
    return released.signal.aborted ? { kind: "released" as const } : result;
  });
  return { ending, release: () => released.abort() };
}

/**
 * Type the teaching Turn once the pane is waiting on the operator: one read
 * establishes the transcript, IDLE_STABLE_READS more with the idle pattern
 * present settle it as waiting (turn-state.ts's rule, as an enlist settles
 * it), and a pane still working is re-read every poll up to the bound.
 * Resolves null once the Turn is in, or why it is not. A custom harness has
 * no idle pattern to wait on, so its Turn is typed at once and verified on
 * its own text.
 */
async function teach(
  socketPath: string,
  input: ContinuedInput,
  pollMs: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const teaching = input.teaching!;
  const descriptor = defaultHarnessDescriptors[input.harness.trim().toLowerCase()];
  if (descriptor) {
    const idle = idlePatternFor(descriptor);
    let turn = FRESH_TURN;
    const read = async (): Promise<void> => {
      const text = await peekPane(socketPath, input.paneId, { source: "visible" });
      turn = nextTurnState(turn, text, idle, new Date().toISOString()).turn;
    };
    try {
      for (let reads = 0; reads <= IDLE_STABLE_READS && turn.state !== "waiting"; reads++) {
        await read();
      }
      const deadline = Date.now() + waitMs;
      while (turn.state !== "waiting") {
        if (signal.aborted) return "released";
        if (Date.now() >= deadline) {
          return `the pane was still working after ${Math.round(waitMs / 1000)} s`;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        await read();
      }
    } catch (err) {
      return `the pane could not be read (${err instanceof Error ? err.message : String(err)})`;
    }
  }
  const echoTargets = [descriptor?.echoPattern, teaching].filter(
    (target): target is string => typeof target === "string" && target.length > 0,
  );
  let delivered = false;
  try {
    delivered = await typeVerified(
      socketPath,
      input.paneId,
      teaching,
      echoTargets,
      descriptor?.clearKeys ?? [],
    );
  } catch {
    delivered = false;
  }
  return delivered ? null : "the teaching Turn could not be delivered";
}
