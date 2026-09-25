/**
 * The Live attempts registry (CONTEXT.md "Live attempt"): what the engine
 * knows in memory about every Attempt between its launch and its Attempt
 * ending. The Attempt-run module registers an Attempt the moment its
 * `spawned` event is recorded and clears it where the ending is recorded;
 * boot adoption and the Conversation module go through the same two calls.
 * The engine reads the registry only when it emits a snapshot, so the
 * Console and the terminal routes learn the live pane from the snapshot and
 * never work it out from the events files.
 *
 * Nothing here is persisted: a restart knows only what it re-adopts.
 */

/**
 * What a live Attempt is doing for its Ticket (issue #129): the Ticket's own
 * work, or a resolver staging the resolution of its conflicted merge. A
 * done card with a live resolver is a merge being resolved, not a Ticket
 * re-running, and the Console says so only because the engine says so here.
 */
export type AttemptRole = "agent" | "resolver";

/** One live Attempt as the snapshot carries it; `tabId` stays engine-side. */
export interface LiveAttemptRecord {
  attempt: number;
  /** The herdr pane the Attempt runs in; null when headless. */
  paneId: string | null;
  role: AttemptRole;
  /** When the engine registered the Attempt live (ISO): the Console ticks
   *  the elapsed time from it client-side, so no emit is spent on a clock. */
  startedAt: string;
}

interface LiveAttemptEntry extends LiveAttemptRecord {
  tabId: string | null;
}

export interface LiveAttempts {
  /**
   * An Attempt spawned: its number and, for a Terminal-backed attempt, its
   * pane. The role defaults to the Ticket's own agent and the start to now.
   */
  register(
    id: string,
    attempt: number,
    pane: {
      paneId: string | null;
      tabId: string | null;
      role?: AttemptRole;
      startedAt?: string;
    },
  ): void;
  /** The Attempt ended; a number never registered is a no-op. */
  clear(id: string, attempt: number): void;
  /** Whether any Attempt of this id is live. */
  isLive(id: string): boolean;
  /**
   * Every live Attempt's pane, not only each id's highest (issue #139): a
   * verify fan-out's earlier candidates are live too, and a tab over any of
   * them is in use, never a Finished terminal.
   */
  panes(): Set<string>;
  /**
   * One record per id, the highest-numbered live Attempt: a verify fan-out
   * has several live Attempts on one Ticket id, and when the highest ends
   * first the record falls back to an earlier one still live. Ids the
   * predicate excludes (a Conversation's, whose pane rides its own view)
   * are left out.
   */
  records(exclude?: (id: string) => boolean): Record<string, LiveAttemptRecord>;
}

/**
 * Build the registry. `onChange` runs after every register and clear that
 * changed the set, so the engine can emit a snapshot the moment a pane
 * becomes reachable or stops being so, instead of at the next boundary.
 */
export function createLiveAttempts(onChange?: () => void): LiveAttempts {
  const live = new Map<string, Map<number, LiveAttemptEntry>>();
  return {
    register(id, attempt, pane) {
      let attempts = live.get(id);
      if (!attempts) {
        attempts = new Map();
        live.set(id, attempts);
      }
      attempts.set(attempt, {
        attempt,
        paneId: pane.paneId,
        tabId: pane.tabId,
        role: pane.role ?? "agent",
        startedAt: pane.startedAt ?? new Date().toISOString(),
      });
      onChange?.();
    },
    clear(id, attempt) {
      const attempts = live.get(id);
      if (!attempts?.delete(attempt)) return;
      if (attempts.size === 0) live.delete(id);
      onChange?.();
    },
    isLive(id) {
      return live.has(id);
    },
    panes() {
      const panes = new Set<string>();
      for (const attempts of live.values()) {
        for (const entry of attempts.values()) {
          if (entry.paneId !== null) panes.add(entry.paneId);
        }
      }
      return panes;
    },
    records(exclude) {
      const out: Record<string, LiveAttemptRecord> = {};
      for (const [id, attempts] of live) {
        if (exclude?.(id)) continue;
        let top: LiveAttemptEntry | null = null;
        for (const entry of attempts.values()) {
          if (top === null || entry.attempt > top.attempt) top = entry;
        }
        if (top) {
          out[id] = {
            attempt: top.attempt,
            paneId: top.paneId,
            role: top.role,
            startedAt: top.startedAt,
          };
        }
      }
      return out;
    },
  };
}
