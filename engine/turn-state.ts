/**
 * Turn-state derivation (the Conversations ADR, docs/adr/0017-conversations-
 * beside-tickets.md; CONTEXT.md: Turn): a Conversation is always either
 * `working` (its agent is acting, or nobody has looked yet) or `waiting` (on
 * the operator). Detected purely from two consecutive pane reads, with no
 * knowledge of herdr, sockets, or timers — engine/notices.ts's poller is the
 * only caller, on a fixed tick, and owns everything about *when* to read a
 * pane and what to do once the state changes (emit a snapshot, deliver a
 * queued Notice). Kept pure and free of engine.ts/conversations.ts imports so
 * its rules are trivial to table-test.
 */

import type { TurnState } from "./conversations.ts";
import { VIEWPORT_WRAP_CHROME } from "./pane-session.ts";

// "unchanged for 2 reads with the idle pattern present" (the plan): a single
// stable-and-idle read is discounted as a boot flicker or a mid-render
// snapshot, the same reasoning waitForReadiness applies to its own
// consecutive-match rule (pane-session.ts), so the same shape of rule is
// reused here rather than invented twice.
export const IDLE_STABLE_READS = 2;

export interface TurnStatePrev {
  text: string;
  state: TurnState;
  stableReads: number;
}

export interface TurnStateResult {
  state: TurnState;
  lastLine: string;
  // Carried back to the caller so it can hand the same shape in as `prev` on
  // the next read; deriveTurnState itself holds nothing between calls.
  stableReads: number;
  // Whether `state` or `lastLine` moved since `prev` — the poller's signal to
  // emit a snapshot rather than silently updating the runtime and waiting for
  // some other reason to publish one.
  changed: boolean;
}

/**
 * Last non-empty line "above the input box after stripping viewport chrome":
 * scan the pane's rendered lines from the bottom, stripping each of
 * VIEWPORT_WRAP_CHROME's whitespace-and-box-drawing runs (the same regex
 * viewportShows uses to tolerate a wrapped echo target), and return the
 * first that still has content once stripped. A TUI's input box renders as
 * bordered rows of box-drawing characters with padding, which strip to
 * nothing and are skipped; the trailing blank rows a fixed-size pane read
 * pads out below the real content are already empty. What survives is
 * whatever text row sits highest among the ones scanned, which in practice
 * is the transcript line the operator would actually read as "the last
 * thing said" — an unverified heuristic (no live TUI capture pins this
 * exactly), documented here rather than assumed silently.
 */
export function extractLastLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const stripped = lines[i].replace(VIEWPORT_WRAP_CHROME, " ").trim();
    if (stripped !== "") return stripped;
  }
  return "";
}

const FRESH: TurnStatePrev = { text: "", state: "working", stableReads: 0 };

/**
 * One turn-state read. `prev` is the previous call's result reshaped as
 * input (null for the very first read of a freshly launched Conversation,
 * treated identically to a prior empty read: working, unstable, nothing
 * said yet). Any change in the pane's rendered text — the agent streaming,
 * the operator typing, a Notice just delivered — resets the idle count and
 * marks the turn `working`, whatever it was before: only a text-stable pane
 * can be idle. Once text stops changing, `idlePattern`'s presence is
 * checked each read; IDLE_STABLE_READS consecutive stable-and-idle reads
 * flip the state to `waiting`, and it stays there (through further
 * stable-and-idle reads) until the text changes again. A text-stable pane
 * whose idle pattern is absent (a dialog, a crash in progress) never
 * reaches `waiting` and resets its stable-idle count the same way an
 * outright text change would; it simply holds `prev.state` for the state
 * itself, so a Conversation already `waiting` does not flap back to
 * `working` on a read that is stable but not (yet) idle, and one already
 * `working` does not flip early.
 */
export function deriveTurnState(
  prev: TurnStatePrev | null,
  text: string,
  idlePattern: string,
): TurnStateResult {
  const p = prev ?? FRESH;
  const lastLine = extractLastLine(text);
  if (text !== p.text) {
    const changed = p.state !== "working" || lastLine !== extractLastLine(p.text);
    return { state: "working", lastLine, stableReads: 0, changed };
  }
  const idle = idlePattern.length > 0 && text.includes(idlePattern);
  // Mirrors waitForReadiness's own stable-count rule (pane-session.ts): a
  // stable-but-not-idle read (a dialog, a mid-render frame) resets the
  // count rather than merely pausing it, so `waiting` requires the idle
  // pattern on IDLE_STABLE_READS *consecutive* reads, not just any two ever
  // seen while text happened not to change.
  const stableReads = idle ? p.stableReads + 1 : 0;
  const state: TurnState =
    idle && stableReads >= IDLE_STABLE_READS ? "waiting" : p.state;
  return { state, lastLine, stableReads, changed: state !== p.state };
}
