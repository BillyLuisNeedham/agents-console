/**
 * Log pane: the ticket log's byte-window state machine, one deep module for
 * the Console's most delicate behavior. The pane opens an attempt's raw log
 * tail-first, tails it live on the snapshot cadence, and prepends earlier
 * windows on demand. Three guards define it: a clicked attempt is never
 * switched away from (attempt-stay), a slow fetch answering after a newer
 * selection never clobbers the newer pane (stale-selection), and a fetch
 * answering after a newer window began — even a re-open of the same attempt —
 * is dropped by the shared stale-answer generation guard. The fetch is
 * injected at construction, so the guards run under unit tests with fake
 * fetches; the tail pin and the prepend anchor live here too, so the view
 * only renders and the bootstrap only drives.
 */

import {
  earlierLogOffset,
  initialLogWindow,
  logAtBottom,
  logTailOffset,
  selectLogAttempt,
  type TimelineView,
} from "./project";
import { StaleGuard } from "./guard";

// ---------------------------------------------------------------------------
// Injected fetch seam
// ---------------------------------------------------------------------------

/**
 * A byte range of an attempt's log, as the wire serves it. `offset` is where
 * the range was read from, `nextOffset` where the next range starts, and
 * `totalSize` the log's full byte size; the pane pages until `nextOffset`
 * reaches `totalSize`. `attempts` is the response's per-attempt listing with
 * each row's resolved Stream file; the pane holds the latest one for the
 * timeline's stream links.
 */
export interface LogChunk {
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  attempts?: { attempt: number; streamFile: string | null }[];
}

/**
 * The one wire call the pane needs: a byte range of a ticket's attempt log,
 * or of its Stream file when `stream` is set, optionally bounded by `end`
 * (how "load earlier" reads exactly the prefix before the bytes the pane
 * already holds).
 */
export type LogFetch = (
  ticketId: string,
  attempt: number,
  offset: number,
  end?: number,
  stream?: boolean,
) => Promise<LogChunk>;

// The pane has one window at a time, so its stale-answer guard lives under
// a single key.
const WINDOW_KEY = "window";

export interface LogPaneOptions {
  fetch: LogFetch;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
}

// ---------------------------------------------------------------------------
// The byte-window state machine
// ---------------------------------------------------------------------------

export class LogPane {
  /**
   * The held window: which ticket and attempt the pane shows, the bytes held
   * (`firstOffset`..`offset` bookend the window inside a log of `totalSize`),
   * and the last fetch error. `clicked` records whether the attempt was
   * picked by hand: a clicked attempt stays when a new attempt starts, an
   * unclicked pane follows the running one. `stream` is the pane's variant:
   * true shows the attempt's Stream file (the raw stream tee) rather than
   * its derived log. `attempts` is the latest response's per-attempt listing
   * (attempt number to Stream file), held for the timeline's stream links.
   */
  readonly state = {
    ticketId: null as string | null,
    attempt: null as number | null,
    clicked: false,
    stream: false,
    content: "",
    firstOffset: 0,
    offset: 0,
    totalSize: 0,
    error: null as string | null,
    attempts: [] as { attempt: number; streamFile: string | null }[],
  };

  private readonly fetchChunk: LogFetch;
  private readonly onChange: () => void;
  // The stale-answer half of the stale-selection guard: every window reset
  // (open, reset) begins a new generation, so a fetch answered after one is
  // dropped even when it names the very ticket, attempt and variant still
  // showing (a re-open of the same attempt would otherwise double-append).
  private readonly guard = new StaleGuard();
  private windowToken = 0;
  private tailInFlight = false;
  private earlierInFlight = false;

  constructor(options: LogPaneOptions) {
    this.fetchChunk = options.fetch;
    this.onChange = options.onChange;
  }

  /** Clear the pane: the selection went away. The caller repaints. */
  reset(): void {
    this.resetWindow(null);
  }

  /**
   * Open an attempt's raw log tail-first: probe the size (an offset past EOF
   * serves empty content plus the total), fetch the last window, then tail
   * whatever grew in the meantime. A null attempt holds an empty pane for a
   * ticket with no attempts. `stream` opens the attempt's Stream file
   * instead of its derived log, through the same byte-window machine. A slow
   * answer only lands when it is still the selected attempt and variant.
   */
  async open(
    ticketId: string,
    attempt: number | null,
    clicked: boolean,
    stream = false,
  ): Promise<void> {
    this.resetWindow(ticketId);
    const token = this.windowToken;
    this.state.attempt = attempt;
    this.state.clicked = clicked;
    this.state.stream = stream;
    this.onChange();
    if (attempt === null) return;
    try {
      const probe = await this.fetchChunk(
        ticketId,
        attempt,
        Number.MAX_SAFE_INTEGER,
        undefined,
        stream,
      );
      if (!this.isCurrent(ticketId, attempt, stream, token)) return;
      const chunk = await this.fetchChunk(
        ticketId,
        attempt,
        initialLogWindow(probe.totalSize),
        undefined,
        stream,
      );
      if (!this.isCurrent(ticketId, attempt, stream, token)) return;
      this.note(chunk);
      this.state.content = chunk.content;
      this.state.firstOffset = chunk.offset;
      this.state.offset = chunk.nextOffset;
      this.state.totalSize = chunk.totalSize;
      this.onChange();
      // The attempt may have grown while the open fetched.
      void this.tail(ticketId, attempt, stream, token);
    } catch {
      this.fail(ticketId, attempt, stream, token);
    }
  }

  /**
   * The snapshot-cadence liveness step for the open pane. Attempt-stay: a
   * clicked attempt is never switched away from; an unclicked pane follows
   * the running attempt as new attempts start, keeping its variant (a pane
   * following in stream mode stays in stream mode). The selected attempt
   * tails.
   */
  follow(
    ticketId: string,
    timeline: TimelineView | null,
  ): Promise<void> | void {
    if (!timeline) return;
    if (this.state.attempt === null) {
      if (timeline.attempts.length > 0) {
        return this.open(
          ticketId,
          selectLogAttempt(timeline, null),
          false,
          this.state.stream,
        );
      }
      return;
    }
    const desired = selectLogAttempt(
      timeline,
      this.state.clicked ? this.state.attempt : null,
    );
    if (desired === null) return;
    if (desired !== this.state.attempt) {
      return this.open(ticketId, desired, false, this.state.stream);
    }
    return this.tail(ticketId, desired, this.state.stream);
  }

  /**
   * A hand-picked attempt from the timeline: clicked, so attempt-stay keeps
   * it when a newer attempt starts. Re-picking the shown attempt's log is a
   * no-op; picking the attempt row while the pane shows its Stream file
   * switches back to the derived log.
   */
  selectAttempt(ticketId: string, attempt: number): void {
    if (
      this.state.ticketId === ticketId &&
      this.state.attempt === attempt &&
      !this.state.stream
    ) {
      return;
    }
    void this.open(ticketId, attempt, true, false);
  }

  /**
   * A hand-picked Stream file from an attempt row's stream link: clicked,
   * same attempt-stay rule as `selectAttempt`, in the pane's stream variant.
   */
  selectStream(ticketId: string, attempt: number): void {
    if (
      this.state.ticketId === ticketId &&
      this.state.attempt === attempt &&
      this.state.stream
    ) {
      return;
    }
    void this.open(ticketId, attempt, true, true);
  }

  /**
   * Prepend the window before the oldest byte held ("load earlier"). The
   * fetch is bounded by `firstOffset`, so the range cannot overlap the held
   * content. The anchor captured before the mutation keeps the opened view
   * put once the render lands the taller content.
   */
  async loadEarlier(ticketId: string, attempt: number): Promise<void> {
    if (this.earlierInFlight) return;
    const token = this.windowToken;
    if (!this.isCurrent(ticketId, attempt, this.state.stream, token)) return;
    const from = earlierLogOffset(this.state.firstOffset);
    if (from === null) return;
    this.earlierInFlight = true;
    try {
      const chunk = await this.fetchChunk(
        ticketId,
        attempt,
        from,
        this.state.firstOffset,
        this.state.stream,
      );
      if (!this.isCurrent(ticketId, attempt, this.state.stream, token)) return;
      this.note(chunk);
      captureLogAnchor();
      this.state.content = chunk.content + this.state.content;
      this.state.firstOffset = chunk.offset;
      this.onChange();
    } catch {
      this.fail(ticketId, attempt, this.state.stream, token);
    } finally {
      this.earlierInFlight = false;
    }
  }

  /**
   * Append whatever bytes the selected attempt's file has grown since the
   * last read: the live tail, driven by the snapshot cadence. Fetches only
   * bytes past the last offset read; a no-op once caught up.
   */
  private async tail(
    ticketId: string,
    attempt: number,
    stream: boolean,
    token: number = this.windowToken,
  ): Promise<void> {
    if (this.tailInFlight) return;
    if (!this.isCurrent(ticketId, attempt, stream, token)) return;
    this.tailInFlight = true;
    try {
      while (logTailOffset(this.state.offset, this.state.totalSize) !== null) {
        const from = this.state.offset;
        const chunk = await this.fetchChunk(
          ticketId,
          attempt,
          from,
          undefined,
          stream,
        );
        if (!this.isCurrent(ticketId, attempt, stream, token)) return;
        this.note(chunk);
        this.state.content += chunk.content;
        this.state.offset = chunk.nextOffset;
        this.state.totalSize = chunk.totalSize;
        this.onChange();
        if (chunk.nextOffset <= from) break;
      }
    } catch {
      this.fail(ticketId, attempt, stream, token);
    } finally {
      this.tailInFlight = false;
    }
  }

  /** A failed fetch marks the pane, but only while it is still selected. */
  private fail(
    ticketId: string,
    attempt: number,
    stream: boolean,
    token: number,
  ): void {
    if (this.isCurrent(ticketId, attempt, stream, token)) {
      this.state.error = `log fetch failed: ${ticketId}:${attempt}`;
      this.onChange();
    }
  }

  /**
   * The stale-selection guard: an answer lands only while the pane still
   * shows the same ticket, attempt, and variant and the fetching operation's
   * token is still the window's generation, so an in-flight log tail never
   * appends into a view the user has switched away from, or re-opened
   * underneath it.
   */
  private isCurrent(
    ticketId: string,
    attempt: number,
    stream: boolean,
    token: number,
  ): boolean {
    return (
      this.guard.isCurrent(WINDOW_KEY, token) &&
      this.state.ticketId === ticketId &&
      this.state.attempt === attempt &&
      this.state.stream === stream
    );
  }

  /** Hold the response's per-attempt listing: the latest one wins, and the
   *  timeline's stream links re-join from it on every render. */
  private note(chunk: LogChunk): void {
    if (chunk.attempts) this.state.attempts = chunk.attempts;
  }

  private resetWindow(ticketId: string | null): void {
    this.windowToken = this.guard.begin(WINDOW_KEY);
    if (ticketId !== this.state.ticketId) this.state.attempts = [];
    this.state.ticketId = ticketId;
    this.state.attempt = null;
    this.state.clicked = false;
    this.state.stream = false;
    this.state.content = "";
    this.state.firstOffset = 0;
    this.state.offset = 0;
    this.state.totalSize = 0;
    this.state.error = null;
  }
}

// ---------------------------------------------------------------------------
// Scroll pin and prepend anchor
// ---------------------------------------------------------------------------

// The pane's node persists across renders, so a reading position off the
// tail keeps itself; what the render cannot know is whether to follow the
// tail as it grows. The pane follows only while pinned at the bottom;
// scrolling up unpins, scrolling back into the bottom slack resumes.
// Switching ticket or attempt resets to following.
let paneKey: string | null = null;
let pinned = true;
// Armed between a "load earlier" content change and the render that shows
// it. The pane holds one text node, so the browser's own scroll anchoring
// has nothing to anchor on when that node grows at the top: the prepend's
// added height is applied by hand so the opened view stays on the same line.
let anchor: { prevHeight: number; prevTop: number } | null = null;

/**
 * Remember the log pane's current scroll metrics, to be applied by the render
 * that lands a prepend. Called just before the held content changes.
 */
function captureLogAnchor(): void {
  if (typeof document === "undefined") return;
  const pre = document.querySelector<HTMLElement>(".log-pane-content");
  if (pre) anchor = { prevHeight: pre.scrollHeight, prevTop: pre.scrollTop };
}

/**
 * The user's own scroll moves the pin: at the tail the pane follows, off the
 * tail the reading position holds. The view's scroll listener reports here.
 */
export function noteLogScroll(
  top: number,
  clientHeight: number,
  scrollHeight: number,
): void {
  pinned = logAtBottom(top, clientHeight, scrollHeight);
}

/**
 * After a render: follow the tail if pinned, or land a pending prepend
 * anchor. `key` identifies the pane's ticket and attempt; a changed key
 * resets to following the tail.
 */
export function settleLogScroll(key: string | null): void {
  if (key !== paneKey) {
    paneKey = key;
    pinned = true;
    anchor = null;
  }
  if (typeof document === "undefined") return;
  const pre = document.querySelector<HTMLElement>(".log-pane-content");
  if (!pre || key === null) return;
  if (anchor) {
    const delta = pre.scrollHeight - anchor.prevHeight;
    pre.scrollTop = Math.max(0, anchor.prevTop + delta);
    anchor = null;
    pinned = logAtBottom(pre.scrollTop, pre.clientHeight, pre.scrollHeight);
    return;
  }
  if (pinned) pre.scrollTop = pre.scrollHeight;
}
