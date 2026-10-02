/**
 * The Merge hold (ADR-0014, amended by ticket 05 of #54): the one derivation
 * of the done-but-unmerged ticket set, and the watch that notices the hold
 * moving without an emit.
 *
 * The derivation takes the ticket statuses and a git probe and returns the
 * held ids. The two rules that once differed between the engine's copy and
 * the server's are pinned here: an engine-run ticket (a grader, the
 * head-to-head judge) is skipped by the id rule, never by the branch
 * reading, because it reaches done in the main checkout with no branch; and
 * a missing branch reads as landed, the reading `mergeBranch` applies (the
 * engine deletes a branch once its merge lands, and a human finishing the
 * job by hand is trusted). A git-less pool passes no probe and holds
 * nothing.
 *
 * The hold is derived on demand and never persisted (ADR-0014): the engine
 * derives it fresh at every emit and puts the set on the snapshot, so the
 * server and the Console read it and never git. What the watch adds is the
 * case ADR-0014 named, a manual CLI merge that raises no snapshot: while
 * the last emitted set is non-empty the watch re-derives on a slow cadence
 * and asks the engine to emit when the set differs; when the set is empty
 * nothing runs.
 *
 * The wait-and-recompute rule (ADR-0014, amended by ticket 06 of #54) lives
 * here too: the one way any scheduling flow computes a spawn set through
 * the hold. It recomputes, and if the recompute found the hold standing it
 * waits the hold out and recomputes again, until a recompute finds nothing
 * held. The super-step boundary's recompute is the whole boundary; an
 * engine-run flow's recompute is its spawn set. Either way a hold that
 * re-engages between the wait's exit and the recompute is a re-wait, never
 * a set handed back under a hold.
 *
 * The Merge queue (CONTEXT.md, amending ADR-0014 for issue #129) lives here
 * too: the hold set put in the order the engine actually works through it,
 * each ticket named by where its merge stands. The engine records, in
 * memory only, the order it took merges on (the serialised merge chain's
 * order, which is attempt-exit order, and the order the post-join conflict
 * loop runs resolvers in), which of them it has not finished with, and
 * which one it is resolving now; the queue is derived from those, the live
 * resolvers and the open interrupts at every emit, beside the hold, and is
 * never persisted.
 */

import type { TicketStatus } from "./pool.ts";
import { branchFor, currentBranch, git, refStamp } from "./worktrees.ts";

/** How often a held pool re-derives the hold looking for a merge done by hand. */
export const MERGE_HOLD_WATCH_MS = 2_000;

/**
 * The poll cadence of a waiting flow (ADR-0014). The hold is re-derived on
 * every tick, so a manual CLI merge is observed without any Console action;
 * the cadence is only the latency between the merge landing and the flow
 * resuming.
 */
export const MERGE_HOLD_POLL_MS = 250;

/** The git facts the derivation reads. */
export interface MergeHoldProbe {
  /** The merge target: the pool checkout's current branch, main or a feature branch alike. */
  currentBranch(): string;
  branchFor(ticketId: string): string;
  branchExists(branch: string): boolean;
  isAncestor(branch: string, target: string): boolean;
  /**
   * A stamp of everything the three git answers above read for these
   * branches and the merge target: equal stamps promise equal answers. Null
   * when the probe cannot vouch for that right now; absent on a probe that
   * never can. Only the memo below reads it.
   */
  stamp?(branches: readonly string[]): string | null;
}

export function gitMergeHoldProbe(repoRoot: string): MergeHoldProbe {
  return {
    currentBranch: () => currentBranch(repoRoot),
    branchFor: (ticketId) => branchFor(repoRoot, ticketId),
    branchExists: (branch) => git(repoRoot, ["rev-parse", "--verify", branch]).ok,
    isAncestor: (branch, target) =>
      git(repoRoot, ["merge-base", "--is-ancestor", branch, target]).ok,
    stamp: (branches) => refStamp(repoRoot, branches),
  };
}

/**
 * The held ids: every done ticket that is not engine-run and whose branch
 * exists but has not landed in the merge target. The target is read once
 * per derivation, and only when there is a candidate to check, so a pool
 * with nothing done spawns no git at all.
 */
export function deriveMergeHold(
  tickets: Record<string, TicketStatus>,
  engineRun: (ticketId: string) => boolean,
  probe: MergeHoldProbe | null,
): string[] {
  if (!probe) return [];
  const candidates = holdCandidates(tickets, engineRun);
  if (candidates.length === 0) return [];
  const target = probe.currentBranch();
  return candidates.filter((id) => {
    const branch = probe.branchFor(id);
    if (!probe.branchExists(branch)) return false;
    return !probe.isAncestor(branch, target);
  });
}

function holdCandidates(
  tickets: Record<string, TicketStatus>,
  engineRun: (ticketId: string) => boolean,
): string[] {
  return Object.entries(tickets)
    .filter(([id, status]) => status === "done" && !engineRun(id))
    .map(([id]) => id);
}

/**
 * The derivation behind a memo (issue #157). The hold is derived at every
 * emit and on every tick of a wait and of the watch, and each derivation
 * spawned git synchronously on the engine's one thread. The memo keeps the
 * last answer under a key of the done candidates, their branch names and
 * the probe's stamp of the refs those names read, and answers from it while
 * the key is unchanged, with no git at all.
 *
 * What makes it safe for ADR-0014, where a stale "landed" would release the
 * hold early: the answer is a function of the key's parts alone. Which
 * tickets are candidates and what their branches are called is in the key;
 * whether a branch exists and whether it has landed depends only on the
 * refs the stamp covers, since commits never change. The stamp is taken
 * before the derivation, so a ref that moves while git runs leaves the
 * answer under a stamp the next call no longer matches: a stale answer is
 * never kept under a fresh key. A probe that cannot vouch (no stamp, or a
 * ref written too recently to trust its file times) is derived every time,
 * as before.
 */
export function memoizedMergeHold(): (
  tickets: Record<string, TicketStatus>,
  engineRun: (ticketId: string) => boolean,
  probe: MergeHoldProbe | null,
) => string[] {
  let last: { key: string; hold: string[] } | null = null;
  return (tickets, engineRun, probe) => {
    if (!probe?.stamp) return deriveMergeHold(tickets, engineRun, probe);
    const candidates = holdCandidates(tickets, engineRun);
    if (candidates.length === 0) return [];
    const branches = candidates.map((id) => probe.branchFor(id));
    const stamp = probe.stamp(branches);
    if (stamp === null) return deriveMergeHold(tickets, engineRun, probe);
    const key = JSON.stringify([candidates, branches, stamp]);
    if (last?.key !== key) last = { key, hold: deriveMergeHold(tickets, engineRun, probe) };
    return [...last.hold];
  };
}

/**
 * What the wait-and-recompute rule needs of the engine: the hold, derived
 * fresh on every call; the drain of queued answers, reporting whether it
 * applied any; the log line that says the pool paused and why, written once
 * per wait; and the emit that shows the pause and each applied answer.
 */
export interface HoldHost {
  derive(): string[];
  /** Applies queued answers; true when at least one was applied. */
  drain(): boolean;
  engaged(hold: string[]): void;
  emit(): void;
}

/**
 * The recompute's answer: the value the flow wants and the hold the
 * recompute observed while computing it. A non-empty hold means the value
 * was computed under the hold and must not be handed back.
 */
export interface Recomputed<T> {
  value: T;
  hold: string[];
}

/**
 * The one wait-and-recompute rule. Recomputes; if the recompute saw the
 * hold standing, waits the hold out and recomputes again; hands back the
 * first value a recompute produced with nothing held.
 *
 * The wait is live: it polls the derivation and drains queued answers on
 * every tick, so an approved or rejected merge processes here rather than
 * at a boundary the paused flow never reaches, and a pause is never stuck
 * behind the very answer that lifts it. Draining mid-super-step is safe
 * exactly where the boundary drain is safe (ADR-0004): at every wait site
 * every attempt has exited and the join is done, so the answer cannot be
 * undone, and processing never spawns. The engagement is logged once per
 * wait, so a held pool says why in the log the Console already shows.
 *
 * The loop cannot run away on its own: each wait exits only once nothing
 * holds, and whatever re-engaged the hold between the wait's exit and the
 * recompute is what the next wait drains or observes.
 */
export async function throughMergeHold<T>(
  host: HoldHost,
  recompute: () => Recomputed<T> | Promise<Recomputed<T>>,
  options: { intervalMs?: number } = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? MERGE_HOLD_POLL_MS;
  for (;;) {
    const { value, hold } = await recompute();
    if (hold.length === 0) return value;
    host.engaged(hold);
    host.emit();
    while (host.derive().length > 0) {
      if (host.drain()) host.emit();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

export interface MergeHoldWatch {
  /** The engine emitted a snapshot carrying this hold set. */
  emitted(hold: string[]): void;
  /** A dead or closed drive stops the watch for good. */
  stop(): void;
}

/**
 * The hold watch. `derive` is the engine's derivation; `onChange` asks the
 * engine to emit, and the emit's own `emitted` call is what records the new
 * set and stops the interval once the set is empty. Sets are compared by
 * value, so the boundary's own emit of an unchanged set never re-emits.
 */
export function createMergeHoldWatch(options: {
  derive: () => string[];
  onChange: () => void;
  intervalMs?: number;
}): MergeHoldWatch {
  const intervalMs = options.intervalMs ?? MERGE_HOLD_WATCH_MS;
  let last: string[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const stopTimer = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = (): void => {
    if (sameSet(options.derive(), last)) return;
    options.onChange();
  };
  return {
    emitted(hold) {
      last = [...hold];
      if (stopped) return;
      if (hold.length === 0) stopTimer();
      else if (timer === null) timer = setInterval(tick, intervalMs);
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/**
 * Where one held ticket's merge stands (CONTEXT.md: Merge queue). The first
 * three are a head, a merge that is moving: a resolver on it (or the engine
 * launching one), or the operator's answer awaited at a merge-approval or a
 * merge-conflict interrupt. `queued` is behind the engine's own work, with
 * nothing running on its behalf. `stalled` is held with none of those: no
 * resolver, no interrupt, and no merge the engine has taken on and not yet
 * finished with (issue #87's case, named here, not fixed).
 */
export type MergeQueueState =
  | "resolving"
  | "awaiting-approval"
  | "needs-you"
  | "queued"
  | "stalled";

/** One held ticket in the Merge queue, as the snapshot carries it. */
export interface MergeQueueEntry {
  ticketId: string;
  state: MergeQueueState;
}

/**
 * The engine's record of the merges it has taken on, in memory only. The
 * order is the order `taken` was called in: the moment a done ticket's
 * merge joins the serialised merge chain, which is attempt-exit order, and
 * the order the conflict loop then resolves them in. A ticket held after a
 * restart was never taken, so it has no place in the line and sorts after
 * it by id.
 */
export interface MergeLine {
  /** The ticket's merge joined the merge chain: it goes to the back of the line. */
  taken(id: string): void;
  /** The engine is handling the ticket's conflict: launching or running its resolver. */
  resolving(id: string): void;
  /** The engine is finished with the ticket's merge: it landed, or an interrupt now owns it. */
  settled(id: string): void;
  /**
   * The Merge queue: the held ids in line order, each with its state. The
   * resolvers are the ids with a live resolver Attempt; the interrupts are
   * the pool's open ones. A read only: calling it twice gives the same
   * answer. The line needs no pruning, since `taken` keeps one entry per
   * id and so it never outgrows the pool; ids that are not held are left
   * out of the answer, not out of the line.
   */
  queue(
    hold: readonly string[],
    resolvers: ReadonlySet<string>,
    interrupts: readonly { ticketId: string; kind: string }[],
  ): MergeQueueEntry[];
}

export function createMergeLine(): MergeLine {
  let order: string[] = [];
  const pending = new Set<string>();
  let active: string | null = null;
  return {
    taken(id) {
      order = order.filter((o) => o !== id);
      order.push(id);
      pending.add(id);
    },
    resolving(id) {
      active = id;
    },
    settled(id) {
      pending.delete(id);
      if (active === id) active = null;
    },
    queue(hold, resolvers, interrupts) {
      const held = new Set(hold);
      const lined = order.filter((id) => held.has(id));
      const rest = hold.filter((id) => !order.includes(id)).sort();
      const stateOf = (id: string): MergeQueueState => {
        if (active === id || resolvers.has(id)) return "resolving";
        const kinds = new Set(interrupts.filter((i) => i.ticketId === id).map((i) => i.kind));
        if (kinds.has("merge-approval")) return "awaiting-approval";
        if (kinds.has("merge-conflict")) return "needs-you";
        return pending.has(id) ? "queued" : "stalled";
      };
      return [...lined, ...rest].map((ticketId) => ({ ticketId, state: stateOf(ticketId) }));
    },
  };
}
