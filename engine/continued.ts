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
 * - The ending: a valid Outcome on disk, raced against two ways the agent
 *   can be gone without one. The TUI can exit while its pane stays open
 *   (the wrapper is typed into the pane's own shell, which outlives it), so
 *   the wrapper's exit-code file landing is one; the pane leaving herdr's
 *   listing is the other. The exit-code file is the checkpointed attempt's,
 *   known absent when the claim was made, so its appearance can only be
 *   this TUI exiting. An enlisted pane has no wrapper and no such file, so
 *   its race is the enlisted two-form one (enlisted.ts).
 *
 * The engine records whatever ending this reports; nothing here writes pool
 * state.
 */

import { existsSync, readFileSync } from "node:fs";
import { focusPane, listPaneIds, peekPane } from "./herdr.ts";
import { startPaneStreamTail } from "./attempt-run.ts";
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
  | { kind: "exited" }
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
  /** The wrapper's exit-code file, whose landing says the TUI exited; null
   *  for an enlisted pane, which has no wrapper. */
  exitCodePath: string | null;
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
    return { kind: await waitForContinuedEnding(env.herdrSocket, input, released.signal, pollMs) };
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
 * The ending race: the Outcome first each sweep, so an Outcome that landed
 * just before the TUI exited or the pane went still reads as the Outcome;
 * then the exit-code file; then the pane's presence in herdr's listing, a
 * listing the daemon cannot answer saying nothing about the pane. Released,
 * it never resolves (the caller's release wins the race above it).
 */
async function waitForContinuedEnding(
  socketPath: string,
  input: ContinuedInput,
  signal: AbortSignal,
  pollMs: number,
): Promise<"outcome" | "exited" | "pane-gone"> {
  for (;;) {
    if (outcomeIsOnDisk(input.outcomePath)) return "outcome";
    if (input.exitCodePath !== null && existsSync(input.exitCodePath)) return "exited";
    if (signal.aborted) return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (signal.aborted) return new Promise(() => {});
    let live: string[] | null;
    try {
      live = await listPaneIds(socketPath);
    } catch {
      live = null;
    }
    if (live !== null && !live.includes(input.paneId)) {
      // One more look before calling it gone: the Outcome or the exit code
      // may have landed between the sweep and the listing.
      if (outcomeIsOnDisk(input.outcomePath)) return "outcome";
      if (input.exitCodePath !== null && existsSync(input.exitCodePath)) return "exited";
      return "pane-gone";
    }
  }
}

/** A complete Outcome on disk: a file that does not parse yet is a write in flight. */
function outcomeIsOnDisk(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
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
