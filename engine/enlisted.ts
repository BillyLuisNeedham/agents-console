/**
 * Enlisted attempts (issue #101, docs/specs/2026-09-19-enlist-herdr-terminal.md):
 * the runtime half of enlisting a live herdr pane the operator opened as a
 * Pool Ticket. Where the engine's one-shot enlist (engine.ts's enlistTicket)
 * resolves the pane, applies the branch rule and writes the pool, this module
 * owns what lives on: the pane, its tab, the Agent identity claim, the Turn
 * state read from the pane, and the Turns the engine has to type into it.
 *
 * A spawned terminal attempt gets its pane, its agent report and its prompt
 * from the Attempt-run module; an enlisted one has all three already
 * (ADR-0014, ADR-0015). So registration here takes the found pane and does the
 * claim: report the agent identity, relabel the operator's tab to the attempt
 * label, and type the teaching Turn. Turn state is read from the pane for an
 * enlisted Ticket exactly as it is for a Conversation (engine/turn-state.ts);
 * the teaching Turn is typed only while the pane is waiting and queued while
 * it is working, so it never lands mid-reply.
 *
 * Ticket 04 gives the enlisted Ticket its endings here. There is no wrapper,
 * so there is no exit-code file and no Stream file: the Attempt ending is
 * raced between two observations instead of three (spec "Attempt ending for
 * an enlisted Ticket"), a valid Outcome appearing on disk and the pane
 * leaving herdr's listing. The watch reports the ending to the host, which
 * owns the record; a pane that goes after the Outcome is a trailing exit and
 * changes nothing about the ticket. `waitForEnlistedEnding` is exported so
 * boot re-adoption, which has no runtime here, waits the same way.
 *
 * The module mirrors conversations.ts in shape (env + host, a per-id runtime,
 * a fixed-interval tick).
 */

import { existsSync, readFileSync } from "node:fs";
import {
  attemptTabLabel,
  listPaneIds,
  peekPane,
  relabelTab,
  releasePaneAgent,
  reportPaneAgent,
} from "./herdr.ts";
import {
  INTERACTIVE_PANE_READ_LINES,
  READINESS_TIMEOUT_MS,
  stillWorkingReason,
  typeVerified,
} from "./pane-session.ts";
import { defaultHarnessDescriptors, idlePatternFor, type HarnessDescriptor } from "./spawn.ts";
import { FRESH_TURN, IDLE_STABLE_READS, nextTurnState, type TurnState } from "./turn-state.ts";

const ENLISTED_POLL_MS = 2_000;

/**
 * How an enlisted attempt ended. There is no wrapper and so no exit-code
 * file: the Outcome landing is `outcome`, and the pane leaving herdr's
 * listing with no Outcome behind it is `pane-gone`. A pane that goes after
 * the Outcome is a trailing exit, not an ending: the attempt already ended.
 */
export type EnlistedEnding = "outcome" | "pane-gone";

/**
 * Wait for an enlisted attempt's ending: an Outcome on disk, or the pane
 * leaving herdr's listing, whichever the poll sees first. The Outcome check
 * comes first each sweep, so an Outcome that landed just before the pane went
 * still reads as `outcome`. A daemon the listing cannot answer says nothing
 * about the pane, so that sweep is skipped rather than read as a gone pane.
 *
 * Exported for boot re-adoption (`engine.ts`'s `finalizeAdoptedEnlisted`),
 * which has no runtime here but must apply the same two-form race.
 */
export async function waitForEnlistedEnding(
  socketPath: string,
  paneId: string,
  outcomePath: string,
  signal: AbortSignal,
  pollMs: number = ENLISTED_POLL_MS,
): Promise<EnlistedEnding> {
  for (;;) {
    if (outcomeIsOnDisk(outcomePath)) return "outcome";
    if (signal.aborted) return neverEnding();
    await sleepAbortable(pollMs, signal);
    if (signal.aborted) return neverEnding();
    const live = await livePaneIds(socketPath);
    if (signal.aborted) return neverEnding();
    if (live !== null && !live.includes(paneId)) return "pane-gone";
  }
}

/** A pane listing, or null when the daemon could not answer this sweep. */
async function livePaneIds(socketPath: string): Promise<string[] | null> {
  try {
    return await listPaneIds(socketPath);
  } catch {
    return null;
  }
}

/**
 * Whether a complete Outcome is on disk. A file that exists but is not yet
 * parseable JSON is a write in flight, not an ending, so the wait keeps
 * polling; the engine's own validator decides the shape afterwards.
 */
function outcomeIsOnDisk(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function neverEnding(): Promise<never> {
  return new Promise<never>(() => {});
}

export interface EnlistedEnv {
  herdrSocket: string;
  /** How often the tick re-reads the pane; 2s unless a test shortens it. */
  pollMs?: number;
  /** How long an enlist waits for a working pane to reach waiting so the
   *  teaching Turn can be typed; a Launch's readiness bound unless a test
   *  shortens it. */
  teachingWaitMs?: number;
}

export interface EnlistedHost {
  /** Publish a snapshot after a runtime event that happens off the drive loop. */
  publish(): void;
  /**
   * An enlisted attempt's ending was observed. The host records it (the
   * engine writes the status, the events and the merge); the runtime stops
   * its Turn tick either way.
   */
  ended(id: string, ending: EnlistedEnding): void;
  /**
   * The pane left herdr's listing after the Outcome had already ended the
   * attempt: a trailing exit. The ticket does not change.
   */
  trailingExit(id: string): void;
}

export interface RegisterEnlistedInput {
  id: string;
  paneId: string;
  tabId: string | null;
  /** herdr's agent label: the harness the pane is running. */
  harness: string;
  title: string;
  branch: string;
  directory: string;
  /** Where the agent writes its Outcome; the ending watch reads it. */
  outcomePath: string;
  /**
   * The teaching Turn to type once the pane is waiting: the claim waits for
   * a working pane, bounded by `teachingWaitMs`, and refuses when the bound
   * expires. Null for a pane taught before a restart (boot re-adoption),
   * which registers the tick and the ending watch and types nothing.
   */
  teaching: string | null;
}

export type EnlistRegistration =
  | { ok: true }
  | { ok: false; reason: string };

export interface EnlistedAttempts {
  /** Claim a found pane and register its runtime; resolves a reason on failure. */
  register(input: RegisterEnlistedInput): Promise<EnlistRegistration>;
  /** Stop the tick and drop the runtime (the agent identity is the caller's). */
  release(id: string): void;
  /** Stop every tick; the engine's shutdown. */
  dispose(): void;
}

interface EnlistedRuntime {
  id: string;
  paneId: string;
  tabId: string | null;
  harness: string;
  title: string;
  label: string;
  branch: string;
  directory: string;
  outcomePath: string;
  turn: TurnState;
  queued: string[];
  release: AbortController;
  timer: ReturnType<typeof setInterval> | null;
}

/** The descriptor for a herdr agent label, or null when the engine has none. */
function descriptorFor(harness: string): HarnessDescriptor | null {
  return defaultHarnessDescriptors[harness.trim().toLowerCase()] ?? null;
}

export function createEnlistedAttempts(
  env: EnlistedEnv,
  host: EnlistedHost,
): EnlistedAttempts {
  const pollMs = env.pollMs ?? ENLISTED_POLL_MS;
  const teachingWaitMs = env.teachingWaitMs ?? READINESS_TIMEOUT_MS;
  const runtimes = new Map<string, EnlistedRuntime>();

  function reportState(runtime: EnlistedRuntime, state: "working" | "blocked"): void {
    void reportPaneAgent(
      env.herdrSocket,
      runtime.paneId,
      runtime.harness.toLowerCase(),
      state,
      runtime.label,
    ).catch(() => {});
  }

  function releaseAgent(runtime: EnlistedRuntime): void {
    void releasePaneAgent(
      env.herdrSocket,
      runtime.paneId,
      runtime.harness.toLowerCase(),
    ).catch(() => {});
  }

  /** One Turn-state read from the pane; a failed read leaves the state as it was. */
  async function readTurn(
    runtime: EnlistedRuntime,
    descriptor: HarnessDescriptor,
  ): Promise<void> {
    const text = await peekPane(
      env.herdrSocket,
      runtime.paneId,
      INTERACTIVE_PANE_READ_LINES,
    );
    const { turn, publish } = nextTurnState(
      runtime.turn,
      text,
      idlePatternFor(descriptor),
      new Date().toISOString(),
    );
    const flipped = runtime.turn.state !== turn.state;
    runtime.turn = turn;
    if (publish) host.publish();
    if (flipped) {
      reportState(runtime, turn.state === "waiting" ? "blocked" : "working");
    }
  }

  /**
   * Type every queued Turn into the pane, in order. Claims the whole queue up
   * front (a synchronous splice) so a tick and an enqueue cannot double-type
   * one Turn; a Turn whose echo never confirms (or whose send throws) stops
   * the drain and the remainder goes back to the front for the next trigger.
   * Resolves false when anything is still queued.
   */
  async function deliver(
    runtime: EnlistedRuntime,
    descriptor: HarnessDescriptor,
  ): Promise<boolean> {
    if (runtime.queued.length === 0) return true;
    const queue = runtime.queued.splice(0);
    for (let i = 0; i < queue.length; i++) {
      const text = queue[i];
      const echoTargets = [descriptor.echoPattern, text].filter(
        (target): target is string => typeof target === "string" && target.length > 0,
      );
      let delivered = false;
      try {
        delivered = await typeVerified(
          env.herdrSocket,
          runtime.paneId,
          text,
          echoTargets,
          descriptor.clearKeys,
        );
      } catch {
        delivered = false;
      }
      if (!delivered) {
        runtime.queued.unshift(...queue.slice(i));
        return false;
      }
    }
    return true;
  }

  function tick(runtime: EnlistedRuntime, descriptor: HarnessDescriptor): void {
    void readTurn(runtime, descriptor)
      .then(() => {
        if (runtime.turn.state === "waiting" && runtime.queued.length > 0) {
          return deliver(runtime, descriptor);
        }
        return true;
      })
      .catch(() => {
        // One tick's failure is not fatal; the next tick tries again.
      });
  }

  /**
   * The ending watch: waits for the two-form race and tells the host. The
   * Turn tick stops the moment the attempt is over, so no further Turn is
   * typed into a finished attempt. On an Outcome the runtime stays for one
   * more job, watching the pane so a later tab close is reported as a
   * trailing exit; on a gone pane there is nothing left to watch and the
   * runtime is dropped.
   */
  async function watchEnding(
    runtime: EnlistedRuntime,
    descriptor: HarnessDescriptor,
  ): Promise<void> {
    let ending: EnlistedEnding;
    try {
      ending = await waitForEnlistedEnding(
        env.herdrSocket,
        runtime.paneId,
        runtime.outcomePath,
        runtime.release.signal,
        pollMs,
      );
    } catch {
      return;
    }
    if (runtime.release.signal.aborted) return;
    stopTick(runtime);
    host.ended(runtime.id, ending);
    if (ending === "outcome") {
      void watchTrailingExit(runtime);
    } else {
      runtimes.delete(runtime.id);
    }
  }

  /** Wait for the pane to leave the listing after its Outcome, once. */
  async function watchTrailingExit(runtime: EnlistedRuntime): Promise<void> {
    for (;;) {
      await sleepAbortable(pollMs, runtime.release.signal);
      if (runtime.release.signal.aborted) return;
      const live = await livePaneIds(env.herdrSocket);
      if (runtime.release.signal.aborted) return;
      if (live !== null && !live.includes(runtime.paneId)) break;
    }
    runtimes.delete(runtime.id);
    host.trailingExit(runtime.id);
  }

  function stopTick(runtime: EnlistedRuntime): void {
    if (runtime.timer !== null) clearInterval(runtime.timer);
    runtime.timer = null;
  }

  async function register(input: RegisterEnlistedInput): Promise<EnlistRegistration> {
    const descriptor = descriptorFor(input.harness);
    if (!descriptor) {
      return { ok: false, reason: "no harness the engine knows" };
    }
    const runtime: EnlistedRuntime = {
      id: input.id,
      paneId: input.paneId,
      tabId: input.tabId,
      harness: input.harness,
      title: input.title,
      label: attemptTabLabel(input.id, input.title),
      branch: input.branch,
      directory: input.directory,
      outcomePath: input.outcomePath,
      turn: FRESH_TURN,
      queued: input.teaching === null ? [] : [input.teaching],
      release: new AbortController(),
      timer: null,
    };

    // Settle the Turn state from consecutive reads (the same rule
    // turn-state.ts applies on its own tick), so an idle pane is taught now.
    // One read establishes the transcript, then IDLE_STABLE_READS more with
    // the idle pattern present flip the state to waiting. A pane still
    // working then is given the same bound a Launch gives a TUI to reach its
    // ready frame, re-read every poll, so the teaching lands the moment the
    // agent is waiting on the operator and never mid-reply (spec, story 14);
    // past the bound the enlist is refused and leaves nothing (spec, "Failed
    // enlist leaves nothing"), never a Ticket whose agent was not taught.
    try {
      for (let read = 0; read <= IDLE_STABLE_READS; read++) {
        await readTurn(runtime, descriptor);
        if (runtime.turn.state === "waiting") break;
      }
      if (input.teaching !== null) {
        const deadline = Date.now() + teachingWaitMs;
        while (runtime.turn.state !== "waiting") {
          if (Date.now() >= deadline) {
            return { ok: false, reason: stillWorkingReason(teachingWaitMs) };
          }
          await sleepAbortable(pollMs, runtime.release.signal);
          await readTurn(runtime, descriptor);
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `the pane could not be read (${
          err instanceof Error ? err.message : String(err)
        })`,
      };
    }

    reportState(runtime, runtime.turn.state === "waiting" ? "blocked" : "working");

    if (runtime.turn.state === "waiting") {
      const delivered = await deliver(runtime, descriptor);
      if (!delivered) {
        releaseAgent(runtime);
        return { ok: false, reason: "the teaching Turn could not be delivered" };
      }
    }
    // The operator's tab is relabelled only once the claim has held, so a
    // refused enlist leaves the label as it found it; awaited (still
    // best-effort) so the claim is whole when the enlist answers.
    if (input.tabId !== null) {
      await relabelTab(env.herdrSocket, input.tabId, runtime.label).catch(() => {});
    }

    runtimes.set(runtime.id, runtime);
    runtime.timer = setInterval(() => tick(runtime, descriptor), pollMs);
    void watchEnding(runtime, descriptor);
    return { ok: true };
  }

  function stop(runtime: EnlistedRuntime): void {
    stopTick(runtime);
    runtime.release.abort();
  }

  return {
    register,
    release: (id) => {
      const runtime = runtimes.get(id);
      if (!runtime) return;
      stop(runtime);
      runtimes.delete(id);
    },
    dispose: () => {
      for (const runtime of runtimes.values()) stop(runtime);
    },
  };
}
