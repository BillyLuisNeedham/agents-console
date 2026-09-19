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
 * The module mirrors conversations.ts in shape (env + host, a per-id runtime,
 * a fixed-interval tick) but is deliberately smaller: ticket 04 gives the
 * enlisted Ticket its endings, and this module is where they will attach.
 */

import {
  attemptTabLabel,
  peekPane,
  relabelTab,
  releasePaneAgent,
  reportPaneAgent,
} from "./herdr.ts";
import { INTERACTIVE_PANE_READ_LINES, typeVerified } from "./pane-session.ts";
import { defaultHarnessDescriptors, idlePatternFor, type HarnessDescriptor } from "./spawn.ts";
import { FRESH_TURN, IDLE_STABLE_READS, nextTurnState, type TurnState } from "./turn-state.ts";

const ENLISTED_POLL_MS = 2_000;

export interface EnlistedEnv {
  herdrSocket: string;
  /** How often the tick re-reads the pane; 2s unless a test shortens it. */
  pollMs?: number;
}

export interface EnlistedHost {
  /** Publish a snapshot after a runtime event that happens off the drive loop. */
  publish(): void;
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
  /** The teaching Turn to type once the pane is waiting (queued while working). */
  teaching: string;
}

export type EnlistRegistration =
  | { ok: true }
  | { ok: false; reason: string };

export interface EnlistedAttempts {
  /** Claim a found pane and register its runtime; resolves a reason on failure. */
  register(input: RegisterEnlistedInput): Promise<EnlistRegistration>;
  /** Whether an enlisted attempt is live under this id. */
  isLive(id: string): boolean;
  /** The runtime's Turn state, for callers that read it (tests, ticket 04). */
  turnOf(id: string): TurnState | null;
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
      turn: FRESH_TURN,
      queued: [input.teaching],
      release: new AbortController(),
      timer: null,
    };

    // Settle the Turn state from consecutive reads (the same rule
    // turn-state.ts applies on its own tick), so an idle pane is taught now
    // and a working pane queues the teaching for its next waiting Turn. One
    // read establishes the transcript, then IDLE_STABLE_READS more with the
    // idle pattern present flip the state to waiting.
    try {
      for (let read = 0; read <= IDLE_STABLE_READS; read++) {
        await readTurn(runtime, descriptor);
        if (runtime.turn.state === "waiting") break;
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
    if (input.tabId !== null) {
      void relabelTab(env.herdrSocket, input.tabId, runtime.label).catch(() => {});
    }

    if (runtime.turn.state === "waiting") {
      const delivered = await deliver(runtime, descriptor);
      if (!delivered) {
        releaseAgent(runtime);
        return { ok: false, reason: "the teaching Turn could not be delivered" };
      }
    }

    runtimes.set(runtime.id, runtime);
    runtime.timer = setInterval(() => tick(runtime, descriptor), pollMs);
    return { ok: true };
  }

  function stop(runtime: EnlistedRuntime): void {
    if (runtime.timer !== null) clearInterval(runtime.timer);
    runtime.timer = null;
    runtime.release.abort();
  }

  return {
    register,
    isLive: (id) => runtimes.has(id),
    turnOf: (id) => runtimes.get(id)?.turn ?? null,
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
