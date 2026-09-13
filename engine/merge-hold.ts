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
 */

import type { TicketStatus } from "./pool.ts";
import { branchFor, currentBranch, git } from "./worktrees.ts";

/** How often a held pool re-derives the hold looking for a merge done by hand. */
export const MERGE_HOLD_WATCH_MS = 2_000;

/** The git facts the derivation reads. */
export interface MergeHoldProbe {
  /** The merge target: the pool checkout's current branch, main or a feature branch alike. */
  currentBranch(): string;
  branchFor(ticketId: string): string;
  branchExists(branch: string): boolean;
  isAncestor(branch: string, target: string): boolean;
}

export function gitMergeHoldProbe(repoRoot: string): MergeHoldProbe {
  return {
    currentBranch: () => currentBranch(repoRoot),
    branchFor: (ticketId) => branchFor(repoRoot, ticketId),
    branchExists: (branch) => git(repoRoot, ["rev-parse", "--verify", branch]).ok,
    isAncestor: (branch, target) =>
      git(repoRoot, ["merge-base", "--is-ancestor", branch, target]).ok,
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
  const candidates = Object.entries(tickets)
    .filter(([id, status]) => status === "done" && !engineRun(id))
    .map(([id]) => id);
  if (candidates.length === 0) return [];
  const target = probe.currentBranch();
  return candidates.filter((id) => {
    const branch = probe.branchFor(id);
    if (!probe.branchExists(branch)) return false;
    return !probe.isAncestor(branch, target);
  });
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
