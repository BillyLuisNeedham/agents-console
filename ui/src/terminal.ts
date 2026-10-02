/**
 * Terminal surface: the Console's side of the card's terminal-backed
 * attempt surface (ADR-0014), fed by the socket (issue #161). The store
 * holds a surface for every ticket whose enriched snapshot entry carries a
 * pane (`ticketPaneId`: a live attempt's while a terminal-backed attempt
 * runs, or a Held pane's while the ticket waits at a checkpoint, issue
 * #139) and for every live Conversation with one, and takes the peek text
 * the server reads for all of them, once for every tab, from the `live`
 * frames that carry the reads that moved. A surface whose pane leaves the
 * snapshot (the attempt ended, the checkpoint was answered or its pane
 * closed, or the ticket left the pool) is pruned, and a re-spawned
 * attempt's new pane id resets the entry to pending. Module scope in the
 * bootstrap, so no render drops the entries. The renderer shapes the
 * surface: a dim, pointer-events-none peek viewport (typing happens in
 * herdr, never here), the "Open in herdr" jump, and the copyable
 * attach-command chip.
 */

import {
  ticketPaneId,
  type EnrichedSnapshot,
  type KeepTalkingView,
  type TerminalPeekResponse,
  type TerminalSurfaceView,
} from "./project";
import type { PeekFailure } from "../../engine/protocol.ts";
import { h } from "./dom";

/** How long the card confirms an "Open in herdr". */
export const TERMINAL_CONFIRM_MS = 2_500;

/** The focus request: resolves once the server focused the pane, rejects
 *  with the refusal's reason as the Error's message. */
export type TerminalFocusFetch = (ticketId: string) => Promise<unknown>;

export interface TerminalSurfaceOptions {
  focus: TerminalFocusFetch;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
  /** The focus confirmation window; tests shorten or lengthen it. */
  confirmMs?: number;
}

export class TerminalSurface {
  private readonly focusFetch: TerminalFocusFetch;
  private readonly notify: () => void;
  private readonly confirmMs: number;
  /** Ticket id -> current attempt's pane id: the surfaces there are. */
  private candidates = new Map<string, string>();
  /** Ticket id -> the surface state the projection renders from. */
  private readonly entries = new Map<string, TerminalSurfaceView>();
  /** Focus calls already out; a double click never fires twice. */
  private readonly focusing = new Set<string>();
  /** A refused focus's reason, beside the button until the next press. */
  private readonly focusFailures = new Map<string, string>();
  private readonly confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: TerminalSurfaceOptions) {
    this.focusFetch = options.focus;
    this.notify = options.onChange;
    this.confirmMs = options.confirmMs ?? TERMINAL_CONFIRM_MS;
  }

  /**
   * The snapshot cadence: prune to the tickets and Conversations that have
   * a pane to show (a live attempt's or a Held pane's on the enriched
   * snapshot), reset entries whose attempt re-spawned under a new pane id,
   * and seed a pending entry for a new one, so its surface shell renders
   * while the server's first read of it is on the way. A live Conversation
   * carries its pane the same way a running ticket attempt does, keyed by
   * its own id.
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
      // The attempt ended or the ticket left the pool: the surface goes.
      if (paneId === undefined) {
        this.entries.delete(id);
        this.focusFailures.delete(id);
      } else if (paneId !== entry.paneId) {
        this.entries.set(id, { paneId, status: "pending", text: "", justFocused: false });
        this.focusFailures.delete(id);
      }
    }
    this.candidates = paneOf;
    for (const [id, paneId] of paneOf) {
      if (!this.entries.has(id)) {
        this.entries.set(id, { paneId, status: "pending", text: "", justFocused: false });
      }
    }
  }

  /**
   * A `live` frame's peeks, by ticket or Conversation id: the reads that
   * moved. A failure renders "pane unavailable" and disables the focus
   * button until a read succeeds again. Repaints once for the whole frame,
   * and only when a surface moved: before the morph, a render per unchanged
   * peek tore focus out of the operator's hands every 2s (issue #122).
   */
  apply(peeks: Record<string, TerminalPeekResponse | PeekFailure>): void {
    let changed = false;
    for (const [id, peek] of Object.entries(peeks)) {
      const previous = this.entries.get(id);
      // A pane the snapshot does not show (yet, or any more), or a read of
      // a pane the attempt has re-spawned away from, revives nothing.
      if (!previous) continue;
      if ("paneId" in peek && peek.paneId !== previous.paneId) continue;
      const text = "text" in peek && typeof peek.text === "string" ? peek.text : "";
      // An empty read (a background tab still warming up, per the
      // prototype's herdr findings) is "waiting", never an error.
      const status: TerminalSurfaceView["status"] =
        "error" in peek ? "unavailable" : text === "" ? "waiting" : "live";
      if (previous.status === status && previous.text === text) continue;
      this.entries.set(id, { ...previous, status, text });
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The per-ticket surface input the projection renders from. */
  state(): Record<string, TerminalSurfaceView> {
    const state: Record<string, TerminalSurfaceView> = {};
    for (const [id, entry] of this.entries) {
      const failure = this.focusFailures.get(id) ?? null;
      const focusing = this.focusing.has(id);
      state[id] = focusing || failure ? { ...entry, focusing, focusFailure: failure } : entry;
    }
    return state;
  }

  /**
   * "Open in herdr": focus the attempt's pane. Optimistic (issue #161):
   * the card says "focused in herdr" in the press's own frame and the
   * request goes out with it; a refusal takes that back and puts the reason
   * beside the button until the next press. Resolves true when the server
   * focused the pane, false on a refusal or when the ticket no longer holds
   * a live pane.
   */
  async focus(ticketId: string): Promise<boolean> {
    if (!this.candidates.has(ticketId) || this.focusing.has(ticketId)) return false;
    this.focusing.add(ticketId);
    this.focusFailures.delete(ticketId);
    this.confirm(ticketId, true);
    const request = this.focusFetch(ticketId);
    this.notify();
    let failure: string | null = null;
    try {
      await request;
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    this.focusing.delete(ticketId);
    if (failure !== null) {
      this.confirm(ticketId, false);
      if (this.entries.has(ticketId)) this.focusFailures.set(ticketId, failure);
    }
    this.notify();
    return failure === null;
  }

  /** Drop the confirmation timers (session teardown). */
  dispose(): void {
    for (const timer of this.confirmTimers.values()) clearTimeout(timer);
    this.confirmTimers.clear();
  }

  // Show, or take back, the card's "focused in herdr", which goes on its
  // own once the confirmation window is up.
  private confirm(ticketId: string, on: boolean): void {
    const timer = this.confirmTimers.get(ticketId);
    if (timer !== undefined) clearTimeout(timer);
    this.confirmTimers.delete(ticketId);
    const entry = this.entries.get(ticketId);
    if (entry && entry.justFocused !== on) this.entries.set(ticketId, { ...entry, justFocused: on });
    if (!on) return;
    this.confirmTimers.set(
      ticketId,
      setTimeout(() => {
        this.confirmTimers.delete(ticketId);
        const current = this.entries.get(ticketId);
        if (current?.justFocused) {
          this.entries.set(ticketId, { ...current, justFocused: false });
          this.notify();
        }
      }, this.confirmMs),
    );
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
 * already excludes from card drag. A refused focus's reason sits under the
 * row until the next press.
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
        actions.focusLabel ?? "Open in herdr",
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
    view.focusFailure
      ? h("div", { class: "error-inline terminal-focus-failure" }, view.focusFailure)
      : null,
  );
}

/**
 * Keep talking (issue #139): the button beside Resume on a checkpoint whose
 * ticket still has its Held pane, shared by the Detail's interrupt form and
 * the Needs input tray so both say the same thing. It lives with the
 * terminal surface because that is what it continues: the checkpointed
 * Attempt's own herdr pane, conversation and all, as a Continued attempt,
 * where Resume would start a fresh Attempt from the Issue. Disabled from
 * the press, in its own frame, until the snapshot moves the ticket off
 * checkpoint. An answer already queued withdraws the offer (the
 * projection's `keepTalking` goes null), so a waiting row never shows it. A
 * refusal's reason renders beside the form through
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
