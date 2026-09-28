/**
 * Needs input: the fixed left tray listing every ticket with an unresolved
 * Interrupt, the operator's work queue. One module owns the tray's
 * per-session state (note drafts keyed by ticket id, the collapsed flag,
 * per-row answer errors) and renders the rows from the projection, following
 * the canvas/detail/drawers split. A row whose interrupt has a matching
 * Queued answer greys out in place as "answered · waiting", its actions
 * disabled, until the super-step boundary drains it (ADR-0004); the
 * collapsed tray leaves a badge reading "needs input · N". A row answers
 * through the promise seam the composition wires once: the handler resolves
 * when the engine accepts the answer and rejects when it does not, so a
 * failed answer marks its own row inline ("answer failed · retry") without
 * disturbing the others. The header's bulk action fires every open
 * resume-kind row at once, each with its own note. Clicking a row's ticket
 * id selects the card and opens its Detail; its expand opens that Detail
 * full size with the note focused, for an answer too long to write in a row
 * (issue #147). State outlives any one render: the collapsed flag, the
 * failure marks and the dragged width live on the instance, the note drafts
 * in the Draft answers store the Detail shares, and a note being typed keeps
 * focus and cursor across the morph.
 */

import { h } from "./dom";
import { DRAFT_TICKET_ATTR, type DraftAnswers } from "./drafts";
import { renderKeepTalkingButton, renderKeepTalkingFailure } from "./terminal";
import {
  bulkResumeRows,
  clampNeedsInputWidth,
  NEEDS_INPUT_MAX_FRACTION,
  NEEDS_INPUT_MIN_PX,
  parseStoredNeedsInputWidth,
  type ConversationNeedsInputRow,
  type ResumeAction,
  type NeedsInputRow,
} from "./project";

// One global localStorage key (not per pool) remembers the dragged tray
// width across reloads, the Detail's way.
export const NEEDS_INPUT_WIDTH_KEY = "console-needs-input-width";

// The row note's height in lines: never below two, so it reads as a text
// box, and never above eight, past which it scrolls.
const NOTE_MIN_ROWS = 2;
const NOTE_MAX_ROWS = 8;

/**
 * The tray's answer seam: resolves when the engine accepts the answer,
 * rejects when it does not. The tray marks its own row from the outcome;
 * the Detail's fire-and-forget use keeps the global banner instead.
 */
export type AnswerHandler = (
  ticketId: string,
  action: ResumeAction,
  note?: string,
) => Promise<void>;

export interface NeedsInputOptions {
  onAnswer: AnswerHandler;
  /** Tray state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

/** The handlers the tray's interactive elements report through. */
export interface NeedsInputHandlers {
  /** A row's ticket id was clicked: select that card and open its Detail. */
  onSelect: (cardId: string) => void;
  /** A waiting Conversation row's action: focus its pane in herdr. Resolves
   *  false on any failure, matching the card's terminal surface seam. */
  onFocusConversation: (conversationId: string) => Promise<boolean>;
  /** A checkpoint row's Keep talking (issue #139): the same session seam the
   *  Detail's button fires, so both surfaces disable together and show the
   *  same refusal. */
  onKeepTalking: (ticketId: string) => void;
  /** A row's expand (issue #147): open that ticket's Detail full size on
   *  Progress, its note focused, to write an answer too long for the row. */
  onExpand: (cardId: string, ticketId: string) => void;
}

/** One row's failed answer: the action a retry refires, and why it failed. */
export interface NeedsInputFailure {
  action: ResumeAction;
  message: string;
}

/**
 * The waiting line a row renders, or null while the row is open: a matching
 * Queued answer means the answer is accepted and held for the boundary.
 */
export function waitingStatus(row: NeedsInputRow): string | null {
  return row.interrupt.queued ? "answered · waiting" : null;
}

/**
 * The row note's rows for a draft: one per line, floored and capped. The
 * stylesheet's `field-sizing: content` grows the note with wrapped lines
 * too where the browser has it; this is the floor that holds without it,
 * and it is a function of the draft alone, so a render never fights the
 * height the note grew to while typing.
 */
export function noteRows(draft: string): number {
  const lines = draft.split("\n").length;
  return Math.min(NOTE_MAX_ROWS, Math.max(NOTE_MIN_ROWS, lines));
}

export class NeedsInputTray {
  // Note drafts, keyed by ticket id, so a snapshot re-render never wipes a
  // note being typed. The store is the Detail's too (issue #147), and the
  // composition prunes it when an interrupt resolves.
  private readonly drafts: DraftAnswers;
  // Per-row answer errors, keyed by ticket id: a failed answer marks its own
  // row "answer failed · retry" until a retry (or another accepted answer)
  // clears it. A failure never touches the row's note draft.
  private readonly failures = new Map<string, NeedsInputFailure>();
  // Collapsed, the tray leaves only its "needs input · N" badge. Session
  // state, like the drafts: a snapshot re-render never expands it.
  private collapsed = false;
  // The tray's dragged width (issue #147), clamped to the canvas column on
  // every read; the drag writes the page directly, as the Detail's does.
  private width = NEEDS_INPUT_MIN_PX;
  private drag: { startX: number; startWidth: number } | null = null;
  private readonly onAnswer: AnswerHandler;
  private readonly onChange: () => void;

  constructor(options: NeedsInputOptions & { drafts: DraftAnswers }) {
    this.onAnswer = options.onAnswer;
    this.onChange = options.onChange;
    this.drafts = options.drafts;
    if (typeof window !== "undefined") {
      this.width = clampNeedsInputWidth(this.readStoredWidth(), currentMaxPx());
    }
  }

  /** The note draft held for a ticket, or "" when none is held. */
  note(ticketId: string): string {
    return this.drafts.get(ticketId);
  }

  setNote(ticketId: string, value: string): void {
    this.drafts.set(ticketId, value);
  }

  /** The row's failed answer, or null while the row stands unmarked. */
  failure(ticketId: string): NeedsInputFailure | null {
    return this.failures.get(ticketId) ?? null;
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
  }

  /** Drop failure marks whose row resolved (or whose ticket left the pool). */
  pruneFailures(pendingTicketIds: ReadonlySet<string>): void {
    for (const id of [...this.failures.keys()]) {
      if (!pendingTicketIds.has(id)) this.failures.delete(id);
    }
  }

  /**
   * The canvas's reset layout (issue #147): back to the default width, the
   * stored one forgotten. Applied to the page at once, since the reset
   * repaints the canvas directly rather than through a render.
   */
  resetWidth(): void {
    this.width = NEEDS_INPUT_MIN_PX;
    try {
      localStorage.removeItem(NEEDS_INPUT_WIDTH_KEY);
    } catch {
      // private mode: nothing was stored
    }
    this.applyWidth();
  }

  /**
   * Fire every open resume-kind row at once: one answer per row, in
   * parallel, each with its own note. Resolves after every row's outcome is
   * marked; a failed row is marked inline and the other rows stand.
   */
  async resumeAll(rows: NeedsInputRow[]): Promise<void> {
    await Promise.all(
      bulkResumeRows(rows).map((row) => this.fire(row.ticketId, "resume")),
    );
  }

  /**
   * Refire a failed row's action with its note. A no-op for a row with no
   * failure mark.
   */
  async retry(ticketId: string): Promise<void> {
    const failure = this.failures.get(ticketId);
    if (!failure) return;
    await this.fire(ticketId, failure.action);
  }

  // One answer, one row: a resolve clears the row's mark (the queued flag in
  // the answer's own snapshot has already greyed the row, so a re-render is
  // only needed when a mark actually drops), a reject marks it. The note
  // draft is read at dispatch and never written, so a failure leaves it
  // intact.
  private async fire(ticketId: string, action: ResumeAction): Promise<void> {
    try {
      await this.onAnswer(ticketId, action, this.note(ticketId));
      if (this.failures.delete(ticketId)) this.onChange();
    } catch (err) {
      this.failures.set(ticketId, {
        action,
        message: err instanceof Error ? err.message : String(err),
      });
      this.onChange();
    }
  }

  /**
   * The tray, its badge, or null: at zero pending interrupts neither
   * renders, an idle pool shows no dead chrome. The header count is the row
   * count, waiting rows included; the bulk action's count is the open
   * resume-kind rows alone, and it stands disabled when that count is zero.
   * Every unresolved interrupt lists, one row per card, in the projection's
   * card order. The rows scroll under a fixed head, and the right edge is a
   * drag handle that widens the tray (issue #147).
   */
  render(
    rows: NeedsInputRow[],
    conversationRows: ConversationNeedsInputRow[],
    handlers: NeedsInputHandlers,
  ): HTMLElement | null {
    const total = rows.length + conversationRows.length;
    if (total === 0) return null;
    if (this.collapsed) {
      return h(
        "button",
        {
          class: "needs-input-badge",
          title: "expand the needs input tray",
          onclick: () => {
            this.setCollapsed(false);
            this.onChange();
          },
        },
        `needs input · ${total}`,
      );
    }
    const bulk = bulkResumeRows(rows);
    return h(
      "div",
      {
        class: "needs-input-tray",
        style: `width: ${clampNeedsInputWidth(this.width, currentMaxPx())}px`,
      },
      h(
        "div",
        { class: "needs-input-head" },
        h("span", { class: "needs-input-count" }, `needs input · ${total}`),
        h(
          "div",
          { class: "needs-input-head-actions" },
          h(
            "button",
            {
              class: "btn btn-primary needs-input-resume-all",
              disabled: bulk.length === 0,
              title: "resume every open resume row with its note; review and merge-approval rows answer individually",
              onclick: () => {
                void this.resumeAll(rows);
              },
            },
            `resume all ${bulk.length}`,
          ),
          h(
            "button",
            {
              class: "needs-input-collapse",
              title: "collapse to a badge",
              onclick: () => {
                this.setCollapsed(true);
                this.onChange();
              },
            },
            "collapse",
          ),
        ),
      ),
      h(
        "div",
        { class: "needs-input-rows" },
        ...conversationRows.map((row) => this.renderConversationRow(row, handlers)),
        ...rows.flatMap((row) => this.renderRow(row, handlers)),
      ),
      this.renderHandle(),
    );
  }

  // The tray's right edge as a drag handle, the Detail's left-edge handle
  // mirrored: pointer capture keeps the drag while the pointer leaves the
  // strip, and the width persists on release.
  private renderHandle(): HTMLElement {
    return h("div", {
      class: "needs-input-handle",
      title: "drag to resize the needs input tray",
      onpointerdown: (event: PointerEvent) => {
        if (this.drag) return;
        this.drag = {
          startX: event.clientX,
          startWidth: clampNeedsInputWidth(this.width, currentMaxPx()),
        };
        try {
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
          // pointer already gone
        }
      },
      onpointermove: (event: PointerEvent) => {
        if (!this.drag) return;
        const dx = event.clientX - this.drag.startX;
        this.width = clampNeedsInputWidth(this.drag.startWidth + dx, currentMaxPx());
        this.applyWidth();
      },
      onpointerup: () => {
        this.drag = null;
        this.writeStoredWidth();
      },
      onpointercancel: () => {
        this.drag = null;
      },
      // A snapshot can unmount the tray mid-drag, releasing the capture with
      // no pointerup; without this the drag would stick until a reload.
      onlostpointercapture: () => {
        this.drag = null;
      },
    });
  }

  private readStoredWidth(): number {
    try {
      return parseStoredNeedsInputWidth(
        localStorage.getItem(NEEDS_INPUT_WIDTH_KEY),
        currentMaxPx(),
      );
    } catch {
      // quota or private mode: the default width applies
      return NEEDS_INPUT_MIN_PX;
    }
  }

  private writeStoredWidth(): void {
    try {
      localStorage.setItem(NEEDS_INPUT_WIDTH_KEY, String(this.width));
    } catch {
      // quota or private mode: the width just will not persist
    }
  }

  private applyWidth(): void {
    const width = `${clampNeedsInputWidth(this.width, currentMaxPx())}px`;
    for (const el of document.querySelectorAll<HTMLElement>(".needs-input-tray")) {
      el.style.width = width;
    }
  }

  // A Conversation waiting on the operator: no interrupt, so no form and
  // no note, just the one line. The row's action opens the pane in herdr; a
  // click on its id still selects the card and opens the Detail, the same
  // navigation every row offers.
  private renderConversationRow(
    row: ConversationNeedsInputRow,
    handlers: NeedsInputHandlers,
  ): HTMLElement {
    return h(
      "div",
      { class: "needs-input-row needs-input-row-conversation", key: row.cardId },
      h(
        "div",
        { class: "needs-input-row-line" },
        h(
          "button",
          {
            class: "needs-input-id",
            title: row.title,
            onclick: () => handlers.onSelect(row.cardId),
          },
          row.label,
        ),
        h("span", { class: "needs-input-waiting" }, "waiting on you"),
        h(
          "div",
          { class: "needs-input-actions" },
          h(
            "button",
            {
              class: "btn btn-primary",
              onclick: () => {
                void handlers.onFocusConversation(row.conversationId);
              },
            },
            "open in herdr",
          ),
        ),
      ),
    );
  }

  // One row: a line with the ticket id (a click selects the card), the
  // interrupt kind, expand, and the interrupt's own action set from the
  // shared form config, then the note on its own full-width line beneath, so
  // a long ticket id never squeezes it (issue #147). The note is a textarea
  // that grows with the answer and scrolls past its cap; plain Enter is a
  // newline, and nothing in the row submits on a key. A waiting row greys
  // out in place: the answer is recorded, so its note, expand and actions
  // disable and the waiting line stands in, until the boundary snapshot
  // drops the row. A failed answer adds an inline mark under the row with
  // its retry. A checkpoint row whose Held pane is alive also offers Keep
  // talking beside Resume (issue #139), with a refusal's reason under the
  // row. The interrupt body stays in the Detail; the row is the queue entry,
  // not the reading surface.
  private renderRow(row: NeedsInputRow, handlers: NeedsInputHandlers): HTMLElement[] {
    const status = waitingStatus(row);
    const waiting = status !== null;
    const draft = this.note(row.ticketId);
    const note = h("textarea", {
      class: "interrupt-note needs-input-note",
      placeholder: row.interrupt.form.notePlaceholder ?? "note",
      rows: noteRows(draft),
      disabled: waiting,
      value: draft,
      [DRAFT_TICKET_ATTR]: row.ticketId,
      oninput: (event: Event) => {
        const field = event.currentTarget as HTMLTextAreaElement;
        this.drafts.input(row.ticketId, field);
        field.rows = noteRows(field.value);
      },
    });
    const elements: HTMLElement[] = [
      h(
        "div",
        {
          class: "needs-input-row" + (waiting ? " needs-input-row-waiting" : ""),
          key: row.cardId,
        },
        h(
          "div",
          { class: "needs-input-row-line" },
          h(
            "button",
            {
              class: "needs-input-id",
              // A long id is ellipsized, so the tooltip always carries it whole.
              title: row.title ? `${row.label}: ${row.title}` : row.label,
              onclick: () => handlers.onSelect(row.cardId),
            },
            row.label,
          ),
          h("span", { class: "needs-input-kind" }, row.interrupt.form.title),
          status !== null ? h("span", { class: "needs-input-waiting" }, status) : null,
          h(
            "button",
            {
              class: "btn needs-input-expand",
              title: "write this answer full size",
              disabled: waiting,
              onclick: () => handlers.onExpand(row.cardId, row.ticketId),
            },
            "expand",
          ),
          h(
            "div",
            { class: "needs-input-actions" },
            ...row.interrupt.form.actions.map(({ action, label, tone }) =>
              h(
                "button",
                {
                  class: "btn" + (tone === "primary" ? " btn-primary" : " btn-danger"),
                  disabled: waiting,
                  onclick: () => {
                    void this.fire(row.ticketId, action);
                  },
                },
                label,
              ),
            ),
            row.interrupt.keepTalking
              ? renderKeepTalkingButton(row.interrupt.keepTalking, () =>
                  handlers.onKeepTalking(row.ticketId),
                )
              : null,
          ),
        ),
        note,
      ),
    ];
    const refusal = row.interrupt.keepTalking
      ? renderKeepTalkingFailure(row.interrupt.keepTalking)
      : null;
    if (refusal) elements.push(refusal);
    const failure = this.failure(row.ticketId);
    if (failure && !waiting) {
      elements.push(
        h(
          "div",
          { class: "needs-input-row-failed" },
          "answer failed · ",
          h(
            "button",
            {
              class: "btn needs-input-retry",
              title: failure.message,
              onclick: () => {
                void this.retry(row.ticketId);
              },
            },
            "retry",
          ),
        ),
      );
    }
    return elements;
  }
}

// The tray's widest: a fraction of the canvas column it overlays, measured
// from the column on the page, or the window before the first mount.
function currentMaxPx(): number {
  const column = document.querySelector<HTMLElement>(".canvas-column");
  const width = column?.getBoundingClientRect().width || window.innerWidth;
  return Math.round(width * NEEDS_INPUT_MAX_FRACTION);
}
