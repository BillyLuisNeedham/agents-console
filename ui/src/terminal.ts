/**
 * Terminal surface: the client side of the card's terminal-backed attempt
 * surface (ADR-0014). The store polls the peek endpoint for every ticket
 * whose enriched snapshot entry carries a pane (`ticketPaneId`: a live
 * attempt's while a terminal-backed attempt runs, or a Held pane's while
 * the ticket waits at a checkpoint, issue #139), every 2s and
 * once per pool snapshot (throttled, so a burst asks once, issue #157), and
 * holds the peek text and focus confirmations the cards' surfaces project
 * from. A ticket whose pane leaves the snapshot (the
 * attempt ended, the checkpoint was answered or its pane closed, or the
 * ticket left the pool) is pruned, so its polling
 * stops with its surface; a re-spawned attempt's new pane id resets the
 * entry to pending. Module scope in the bootstrap, so no render drops the
 * entries. The renderer shapes the surface: a dim,
 * pointer-events-none peek viewport (typing happens in herdr, never here),
 * the "Open in herdr" jump, and the copyable attach-command chip.
 */

import {
  ticketPaneId,
  type EnrichedSnapshot,
  type KeepTalkingView,
  type TerminalPeekResponse,
  type TerminalSurfaceView,
} from "./project";
import { h } from "./dom";
import { TargetPoller } from "./poll";

/** The peek poll cadence: one request per terminal-backed ticket per interval. */
export const TERMINAL_POLL_MS = 2_000;

/** How long the card confirms a successful "Open in herdr". */
export const TERMINAL_CONFIRM_MS = 2_500;

export type TerminalPeekFetch = (ticketId: string) => Promise<TerminalPeekResponse>;
export type TerminalFocusFetch = (ticketId: string) => Promise<void>;

export interface TerminalSurfaceOptions {
  peek: TerminalPeekFetch;
  focus: TerminalFocusFetch;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
  /** The poll cadence; tests shorten or lengthen it. */
  pollMs?: number;
  /** The focus confirmation window; tests shorten or lengthen it. */
  confirmMs?: number;
}

export class TerminalSurface {
  private readonly peekFetch: TerminalPeekFetch;
  private readonly focusFetch: TerminalFocusFetch;
  private readonly notify: () => void;
  private readonly pollMs: number;
  private readonly confirmMs: number;
  /** Ticket id -> current attempt's pane id, the poll candidate set. */
  private candidates = new Map<string, string>();
  /** Ticket id -> the surface state the projection renders from. */
  private readonly entries = new Map<string, TerminalSurfaceView>();
  /** The per-pane cadence: one peek out per pane, so a slow answer never
   *  stacks or delays the others, and the snapshot's peek throttled. */
  private readonly poller: TargetPoller;
  /** Focus calls already out; a double click never fires twice. */
  private readonly focusing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TerminalSurfaceOptions) {
    this.peekFetch = options.peek;
    this.focusFetch = options.focus;
    this.notify = options.onChange;
    this.pollMs = options.pollMs ?? TERMINAL_POLL_MS;
    this.confirmMs = options.confirmMs ?? TERMINAL_CONFIRM_MS;
    this.poller = new TargetPoller({
      run: (ticketId) => this.peek(ticketId),
      gapMs: this.pollMs / 2,
    });
    if (typeof setInterval !== "undefined") {
      this.timer = setInterval(() => this.tick(), this.pollMs);
    }
  }

  /**
   * The snapshot cadence: prune to the tickets and Conversations that have
   * a pane to show (a live attempt's or a Held pane's on the enriched
   * snapshot),
   * reset entries whose attempt re-spawned under a new pane id, and peek
   * each once, so a freshly spawned attempt's surface fills as soon as its
   * snapshot lands rather than after up to 2s. A live Conversation carries
   * its pane the same way a running ticket attempt does, keyed by its own
   * id: the server accepts `?ticket=<conv-id>` for peek/focus unchanged.
   */
  update(snapshot: EnrichedSnapshot | null): void {
    const paneOf = new Map<string, string>();
    for (const ticket of snapshot?.state.tickets ?? []) {
      const paneId = ticketPaneId(ticket);
      if (typeof paneId === "string" && paneId !== "") {
        paneOf.set(ticket.id, paneId);
      }
    }
    for (const conversation of snapshot?.state.conversations ?? []) {
      if (typeof conversation.paneId === "string" && conversation.paneId !== "") {
        paneOf.set(conversation.id, conversation.paneId);
      }
    }
    for (const [id, entry] of [...this.entries]) {
      const paneId = paneOf.get(id);
      // The attempt ended or the ticket left the pool: the surface and its
      // polling stop together.
      if (paneId === undefined) {
        this.entries.delete(id);
        this.poller.forget(id);
      } else if (paneId !== entry.paneId) {
        this.entries.set(id, {
          paneId,
          status: "pending",
          text: "",
          justFocused: false,
        });
        // A new pane is owed its first peek now, not after the throttle.
        this.poller.forget(id);
      }
    }
    this.candidates = paneOf;
    for (const [id, paneId] of paneOf) {
      // First sight of this candidate: seed a pending entry so the card
      // renders the surface shell while the first peek is out.
      if (!this.entries.has(id)) {
        this.entries.set(id, {
          paneId,
          status: "pending",
          text: "",
          justFocused: false,
        });
      }
      this.poller.pollSoon(id);
    }
  }

  /** The per-ticket surface input the projection renders from. */
  state(): Record<string, TerminalSurfaceView> {
    const state: Record<string, TerminalSurfaceView> = {};
    for (const [id, entry] of this.entries) {
      state[id] = this.focusing.has(id) ? { ...entry, focusing: true } : { ...entry };
    }
    return state;
  }

  /**
   * "Open in herdr": focus the attempt's pane. The request goes out before
   * anything else happens, and the button reads as opening from the next
   * frame until the server answers (issue #157), so a slow focus never looks
   * like a click that missed. Resolves true when the server accepted the
   * focus (the card shows its transient confirmation); false on any failure
   * or when the ticket no longer holds a live pane, leaving the card as it
   * was.
   */
  async focus(ticketId: string): Promise<boolean> {
    if (!this.candidates.has(ticketId) || this.focusing.has(ticketId)) return false;
    this.focusing.add(ticketId);
    const request = this.focusFetch(ticketId);
    this.notify();
    let accepted = true;
    try {
      await request;
    } catch {
      accepted = false;
    }
    this.focusing.delete(ticketId);
    if (!accepted) {
      this.notify();
      return false;
    }
    const entry = this.entries.get(ticketId);
    if (entry) this.entries.set(ticketId, { ...entry, justFocused: true });
    this.notify();
    setTimeout(() => {
      const current = this.entries.get(ticketId);
      if (current?.justFocused) {
        this.entries.set(ticketId, { ...current, justFocused: false });
        this.notify();
      }
    }, this.confirmMs);
    return true;
  }

  /** Stop the poll timer (session teardown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.poller.dispose();
  }

  private tick(): void {
    for (const id of this.candidates.keys()) this.poller.poll(id);
  }

  private async peek(ticketId: string): Promise<void> {
    const paneId = this.candidates.get(ticketId);
    if (paneId === undefined) return;
    try {
      const response = await this.peekFetch(ticketId);
      const text = typeof response.text === "string" ? response.text : "";
      // An empty read (a background tab still warming up, per the
      // prototype's herdr findings) is "waiting", never an error.
      this.settle(ticketId, paneId, text === "" ? "waiting" : "live", text);
    } catch {
      // A missing or unreadable pane renders "pane unavailable" and
      // disables the focus button; polling continues so a transient
      // daemon failure recovers, and the snapshot drops the entry for
      // good once the attempt truly ends.
      this.settle(ticketId, paneId, "unavailable", "");
    }
  }

  // A peek's outcome lands on the entry, and the view repaints only when
  // the surface it projects (status or text) actually moved: a render on
  // every poll response for a pane that printed nothing new is work for
  // nothing, and before the morph it tore focus out of the operator's hands
  // every 2s (issue #122).
  private settle(
    ticketId: string,
    paneId: string,
    status: TerminalSurfaceView["status"],
    text: string,
  ): void {
    const previous = this.entries.get(ticketId);
    // The entry left (the attempt ended) or re-spawned under another pane
    // while this read was out: a stale answer never revives or overwrites it.
    if (!previous || previous.paneId !== paneId) return;
    if (previous.status === status && previous.text === text) return;
    this.entries.set(ticketId, { ...previous, status, text });
    this.notify();
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export interface TerminalSurfaceActions {
  /** "Open in herdr": focuses the attempt's pane; resolves false on failure. */
  onFocus: () => Promise<boolean>;
  /** The focus button's words when the pane is not the Ticket's own agent's:
   *  "open resolver" for a resolver on its merge (issue #129). */
  focusLabel?: string;
}

/**
 * The card's terminal surface: a dim read-only peek of the attempt pane's
 * recent output, the "Open in herdr" jump, and the copyable
 * `herdr agent attach <pane_id>` chip. The peek is a viewport, not a
 * terminal: pointer-events none, no cursor, no input path; typing happens
 * in herdr. Both controls are <button>s, which the canvas drag logic
 * already excludes from card drag.
 */
export function renderTerminalSurface(
  view: TerminalSurfaceView,
  actions: TerminalSurfaceActions,
): HTMLElement {
  const peekBody =
    view.status === "live"
      ? view.text
      : view.status === "unavailable"
        ? "pane unavailable"
        : "waiting for output";
  return h(
    "div",
    { class: "terminal-surface" },
    h(
      "pre",
      {
        class:
          "terminal-peek" +
          (view.status === "unavailable" ? " terminal-peek-unavailable" : ""),
      },
      peekBody,
    ),
    h(
      "div",
      { class: "terminal-row" },
      h(
        "button",
        {
          class: "btn terminal-focus",
          type: "button",
          disabled: view.status === "unavailable" || view.focusing === true,
          title: actions.focusLabel
            ? `${actions.focusLabel}: focus its tab in the herdr TUI`
            : "focus the attempt's tab in the herdr TUI",
          onclick: () => {
            void actions.onFocus();
          },
        },
        view.focusing ? "opening..." : (actions.focusLabel ?? "Open in herdr"),
      ),
      h(
        "button",
        {
          class: "btn terminal-chip",
          type: "button",
          title: "copy: herdr agent attach " + view.paneId,
          onclick: () => {
            void navigator.clipboard
              ?.writeText(`herdr agent attach ${view.paneId}`)
              .catch(() => {
                // Clipboard denied (permissions, insecure context): the chip
                // keeps showing the full command for the operator to type.
              });
          },
        },
        h("code", { class: "terminal-chip-cmd" }, "herdr agent attach "),
        h("span", { class: "terminal-chip-pane" }, view.paneId),
      ),
      view.justFocused
        ? h("span", { class: "terminal-note" }, "focused in herdr")
        : null,
    ),
  );
}

/**
 * Keep talking (issue #139): the button beside Resume on a checkpoint whose
 * ticket still has its Held pane, shared by the Detail's interrupt form and
 * the Needs input tray so both say the same thing. It lives with the
 * terminal surface because that is what it continues: the checkpointed
 * Attempt's own herdr pane, conversation and all, as a Continued attempt,
 * where Resume would start a fresh Attempt from the Issue. Disabled while
 * the request is out and after the engine accepts, until the snapshot moves
 * the ticket off checkpoint. An answer already queued withdraws the offer
 * (the projection's `keepTalking` goes null), so a waiting row never shows
 * it. A refusal's reason renders beside the form through
 * `renderKeepTalkingFailure`, never on the global banner.
 */
export function renderKeepTalkingButton(
  view: KeepTalkingView,
  onKeepTalking: () => void,
): HTMLElement {
  return h(
    "button",
    {
      class: "btn keep-talking",
      type: "button",
      key: "keep-talking",
      disabled: view.requesting,
      title:
        "continue this conversation in the same terminal instead of starting a fresh attempt",
      onclick: () => onKeepTalking(),
    },
    "Keep talking",
  );
}

/** A refused Keep talking's reason, or null while there is none. */
export function renderKeepTalkingFailure(view: KeepTalkingView): HTMLElement | null {
  return view.failure
    ? h("div", { class: "error-inline keep-talking-failure" }, view.failure)
    : null;
}
