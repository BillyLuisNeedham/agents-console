/**
 * Log pane: the ticket log's byte-window state machine, one deep module for
 * the Console's most delicate behavior, fed by the socket (issue #161). The
 * server streams each subscribed card's log: a `window` (the last 64 KiB of
 * the followed attempt's file) when the card is subscribed or the attempt
 * it follows changes, then `append` frames with the new bytes. The pane
 * holds one log per subscribed card, so a card hovered before it is clicked
 * opens with its tail already in hand, and shows the selected card's.
 *
 * Three guards define it. An append continues the window only from the
 * byte the pane holds up to; a frame naming another attempt or variant (one
 * already on the wire when the pane moved) is dropped, and a gap re-sends
 * the follow, whose reply replaces the window. A clicked attempt is the
 * follow the server keeps (attempt-stay); an unclicked pane follows the
 * latest attempt, which the server moves it to. And a "load earlier" or a
 * follow answering after the window it was asked of was replaced is dropped
 * by the window's generation. The tail pin and the prepend anchor live
 * here too, so the view only renders and the bootstrap only drives.
 */

import { earlierLogOffset, logAtBottom, type TicketLogResponse } from "./project";
import type {
  LogFollow,
  LogFollowResult,
  LogPush,
  LogReadRequest,
} from "../../protocol/protocol.ts";

/**
 * The most text the pane holds while it follows the tail: four of the
 * server's 64 KiB windows. Past it the oldest whole chunks are let go, and
 * "load earlier" reads them back, so an attempt that runs for hours costs a
 * bounded string and a bounded rewrite of the pane's one text node, not one
 * that grows with the run (issue #157).
 */
export const LOG_PANE_MAX_CHARS = 256 * 1024;

export interface LogPaneOptions {
  /** Point a subscribed card's appends at another attempt or variant;
   *  answers with that log's tail window, naming the attempt and variant. */
  follow: (ticketId: string, follow: LogFollow) => Promise<LogFollowResult>;
  /** One byte range of an attempt's log: how "load earlier" reads. */
  read: (request: LogReadRequest) => Promise<TicketLogResponse>;
  /** Called after every change to the shown log the view should repaint. */
  onChange: () => void;
}

/**
 * One card's held log: which attempt and variant it shows, the bytes held
 * (`firstOffset`..`offset` bookend the window inside a log of `totalSize`),
 * and the last read's error. `clicked` records whether the attempt was
 * picked by hand: a clicked attempt stays when a new attempt starts, an
 * unclicked pane follows the latest. `stream` is the variant: true shows the
 * attempt's Stream file (the raw stream tee) rather than its derived log.
 * `attempts` is the latest per-attempt listing (attempt number to Stream
 * file), held for the timeline's stream links. A null `attempt` is a card
 * with no attempt yet, or one whose first window has not landed.
 */
export interface LogPaneState {
  ticketId: string | null;
  attempt: number | null;
  clicked: boolean;
  stream: boolean;
  content: string;
  firstOffset: number;
  offset: number;
  totalSize: number;
  error: string | null;
  attempts: { attempt: number; streamFile: string | null }[];
}

interface HeldLog extends LogPaneState {
  ticketId: string;
  // Where each held chunk starts in the log and how much of `content` it
  // is, oldest first, so the cap can let go of whole chunks and leave
  // `firstOffset` on a byte the server can page back from.
  chunks: { offset: number; length: number }[];
  // Counts the windows: a read answering after the window it was asked of
  // was replaced is dropped.
  generation: number;
  // A follow is out: appends wait for its window.
  following: boolean;
  // The window a "load earlier" is out for: one at a time per window, and a
  // new window is free to ask at once.
  earlierFor: number | null;
}

const EMPTY: LogPaneState = Object.freeze({
  ticketId: null,
  attempt: null,
  clicked: false,
  stream: false,
  content: "",
  firstOffset: 0,
  offset: 0,
  totalSize: 0,
  error: null,
  attempts: [],
}) as LogPaneState;

function blank(ticketId: string): HeldLog {
  return {
    ticketId,
    attempt: null,
    clicked: false,
    stream: false,
    content: "",
    firstOffset: 0,
    offset: 0,
    totalSize: 0,
    error: null,
    attempts: [],
    chunks: [],
    generation: 0,
    following: false,
    earlierFor: null,
  };
}

export class LogPane {
  private readonly followSeam: LogPaneOptions["follow"];
  private readonly readSeam: LogPaneOptions["read"];
  private readonly onChange: () => void;
  private readonly held = new Map<string, HeldLog>();
  private shown: string | null = null;

  constructor(options: LogPaneOptions) {
    this.followSeam = options.follow;
    this.readSeam = options.read;
    this.onChange = options.onChange;
  }

  /** The shown card's log; an empty pane while none is shown. */
  get state(): Readonly<LogPaneState> {
    if (this.shown === null) return EMPTY;
    return this.held.get(this.shown) ?? { ...EMPTY, ticketId: this.shown };
  }

  /** Show a card's log: what it holds already (a hovered card's prefetch),
   *  or an empty pane until its window lands. The caller repaints. */
  show(ticketId: string | null): void {
    this.shown = ticketId;
  }

  /** Clear the pane: the selection went away. The caller repaints. */
  reset(): void {
    this.shown = null;
  }

  /** The card is no longer subscribed: let its log go. */
  forget(ticketId: string): void {
    this.held.delete(ticketId);
  }

  /**
   * A subscribed card's log, pushed: a window replaces what the card holds,
   * an append continues it, and null is a card with no attempt.
   */
  push(ticketId: string, log: LogPush | null): void {
    if (log === null) {
      const entry = this.entry(ticketId);
      if (entry.following) return;
      this.replace(entry, null, false);
      this.changed(ticketId);
      return;
    }
    if (log.mode === "window") {
      const entry = this.entry(ticketId);
      // A window for what a follow still out has moved away from is the
      // old follow's; the follow's reply brings the window that counts.
      if (entry.following) return;
      this.replace(entry, log, log.stream);
      if (log.attempts) entry.attempts = log.attempts;
      this.changed(ticketId);
      return;
    }
    const entry = this.held.get(ticketId);
    if (!entry || entry.following) return;
    // A frame already on the wire when the pane moved names the old log.
    if (log.attempt !== entry.attempt || log.stream !== entry.stream) return;
    if (log.attempts) entry.attempts = log.attempts;
    if (log.offset !== entry.offset) {
      // A gap: ask for the follow again, and its window starts over.
      void this.refollow(entry);
      return;
    }
    entry.content += log.content;
    entry.chunks.push({ offset: log.offset, length: log.content.length });
    entry.offset = log.nextOffset;
    entry.totalSize = log.totalSize;
    if (pinned || ticketId !== this.shown) trimToCap(entry);
    this.changed(ticketId);
  }

  /**
   * A hand-picked attempt from the timeline: clicked, so the server keeps
   * it when a newer attempt starts. Re-picking the shown attempt's log is a
   * no-op; picking the attempt row while the pane shows its Stream file
   * switches back to the derived log.
   */
  selectAttempt(ticketId: string, attempt: number): void {
    const entry = this.held.get(ticketId);
    if (entry?.attempt === attempt && !entry.stream && !entry.following) return;
    void this.moveTo(ticketId, attempt, false);
  }

  /**
   * A hand-picked Stream file from an attempt row's stream link: clicked,
   * the same attempt-stay rule as `selectAttempt`, in the stream variant.
   */
  selectStream(ticketId: string, attempt: number): void {
    const entry = this.held.get(ticketId);
    if (entry?.attempt === attempt && entry.stream && !entry.following) return;
    void this.moveTo(ticketId, attempt, true);
  }

  /**
   * Prepend the window before the oldest byte held ("load earlier"). The
   * read is bounded by `firstOffset`, so it cannot overlap the held
   * content. The anchor captured before the change keeps the opened view
   * put once the render lands the taller content.
   */
  async loadEarlier(ticketId: string, attempt: number): Promise<void> {
    const entry = this.held.get(ticketId);
    if (!entry || entry.attempt !== attempt || entry.earlierFor === entry.generation) return;
    const from = earlierLogOffset(entry.firstOffset);
    if (from === null) return;
    const generation = entry.generation;
    const end = entry.firstOffset;
    entry.earlierFor = generation;
    try {
      const chunk = await this.readSeam({
        id: ticketId,
        attempt,
        offset: from,
        end,
        stream: entry.stream,
      });
      if (!this.isCurrent(entry, generation) || entry.firstOffset !== end) return;
      if (ticketId === this.shown) captureLogAnchor();
      entry.content = chunk.content + entry.content;
      entry.chunks.unshift({ offset: chunk.offset, length: chunk.content.length });
      entry.firstOffset = chunk.offset;
      this.changed(ticketId);
    } catch {
      this.fail(entry, generation);
    } finally {
      if (entry.earlierFor === generation) entry.earlierFor = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private entry(ticketId: string): HeldLog {
    let entry = this.held.get(ticketId);
    if (!entry) {
      entry = blank(ticketId);
      this.held.set(ticketId, entry);
    }
    return entry;
  }

  // Move the pane to a picked attempt and variant: the pane shows it at
  // once, empty, and the follow's reply fills it.
  private async moveTo(ticketId: string, attempt: number, stream: boolean): Promise<void> {
    const entry = this.entry(ticketId);
    entry.clicked = true;
    this.replace(entry, null, stream);
    entry.attempt = attempt;
    this.changed(ticketId);
    await this.followNow(entry, { attempt, stream });
  }

  // A gap in the appends: the same follow again, its window replacing the
  // pane's.
  private refollow(entry: HeldLog): Promise<void> {
    return this.followNow(
      entry,
      entry.clicked ? { attempt: entry.attempt, stream: entry.stream } : { attempt: null, stream: entry.stream },
    );
  }

  private async followNow(entry: HeldLog, follow: LogFollow): Promise<void> {
    entry.following = true;
    const generation = entry.generation;
    try {
      const window = await this.followSeam(entry.ticketId, follow);
      if (!this.isCurrent(entry, generation)) return;
      entry.following = false;
      // The reply names the attempt and variant the server read, which is
      // how a follow of the latest attempt learns which one that is.
      this.replace(entry, { mode: "window", ...window }, window.stream);
      entry.attempts = window.attempts;
      this.changed(entry.ticketId);
    } catch {
      if (!this.isCurrent(entry, generation)) return;
      entry.following = false;
      this.fail(entry, generation);
    }
  }

  // A new window: every read still out for the old one is now stale.
  private replace(entry: HeldLog, window: LogPush | null, stream: boolean): void {
    entry.generation += 1;
    entry.attempt = window?.attempt ?? null;
    entry.stream = stream;
    entry.content = window?.content ?? "";
    entry.firstOffset = window?.offset ?? 0;
    entry.offset = window?.nextOffset ?? 0;
    entry.totalSize = window?.totalSize ?? 0;
    entry.chunks = window ? [{ offset: window.offset, length: window.content.length }] : [];
    entry.error = null;
  }

  private isCurrent(entry: HeldLog, generation: number): boolean {
    return this.held.get(entry.ticketId) === entry && entry.generation === generation;
  }

  /** A failed read marks the pane, but only while its window stands. */
  private fail(entry: HeldLog, generation: number): void {
    if (!this.isCurrent(entry, generation)) return;
    entry.error = `log fetch failed: ${entry.ticketId}:${entry.attempt ?? "?"}`;
    this.changed(entry.ticketId);
  }

  // Only the shown card's log is on screen: a prefetched card's change
  // repaints nothing.
  private changed(ticketId: string): void {
    if (ticketId === this.shown) this.onChange();
  }
}

/**
 * Let go of the oldest whole chunks while the pane holds more than the
 * cap. `firstOffset` moves to the first chunk kept, so "load earlier"
 * reads exactly what was let go.
 */
function trimToCap(entry: HeldLog): void {
  let drop = 0;
  while (entry.chunks.length > 1 && entry.content.length - drop > LOG_PANE_MAX_CHARS) {
    drop += entry.chunks.shift()!.length;
  }
  if (drop === 0) return;
  entry.content = entry.content.slice(drop);
  entry.firstOffset = entry.chunks[0]!.offset;
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
 * that lands a prepend. Called just before the held content changes, or
 * before the Detail draws more of what it holds above what it shows.
 */
export function captureLogAnchor(): void {
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
