/**
 * The pane read register (issue #122, ADR-0021's amendment): the engine's
 * remembered last viewport read of every pane one of its steady-state loops
 * watches, an enlisted attempt's (enlisted.ts) or a Conversation's
 * (conversations.ts).
 *
 * A pane an operator sits in is read once per tick and for one purpose:
 * Turn state. The Console's card Peek used to read the same pane a second
 * time from the peek route, and every read of scrollback moved the
 * operator's viewport under their hands. The register is what lets the
 * peek route answer from the loop's read instead: the loop records what it
 * saw and when, the route serves it, and herdr is asked once.
 *
 * An entry lives exactly as long as the loop that writes it. The loop
 * forgets the pane when its runtime is released, the Conversation ends or
 * the pane is gone, so the route never serves a stale viewport for a pane
 * nothing watches; a pane with no entry (a spawned terminal-backed attempt,
 * which no loop watches) is the route's cue to read herdr live.
 */

export interface PaneRead {
  /** The viewport's text as herdr rendered it, ANSI stripped. */
  text: string;
  /** When the loop read it (ISO). */
  at: string;
}

export interface PaneReadRegister {
  /** Remember the loop's latest read of `paneId`, replacing the previous one. */
  record(paneId: string, text: string, at: string): void;
  /** Drop the pane's entry: no loop watches it any more. A pane never recorded is a no-op. */
  forget(paneId: string): void;
  /** The latest recorded read, or null when no loop watches the pane. */
  latest(paneId: string): PaneRead | null;
}

export function createPaneReadRegister(): PaneReadRegister {
  const reads = new Map<string, PaneRead>();
  return {
    record: (paneId, text, at) => {
      reads.set(paneId, { text, at });
    },
    forget: (paneId) => {
      reads.delete(paneId);
    },
    latest: (paneId) => reads.get(paneId) ?? null,
  };
}
