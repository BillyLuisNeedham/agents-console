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
 * id selects the card and opens its Detail. State survives the full-DOM
 * rebuild on every snapshot: drafts, the collapsed flag, and the failure
 * marks live on the instance, and a note being typed keeps focus and cursor
 * across the swap.
 */

import { FOCUS_KEY_ATTR } from "./focus";
import { h } from "./dom";
import {
  bulkResumeRows,
  type ConversationNeedsInputRow,
  type ResumeAction,
  type NeedsInputRow,
} from "./project";

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

export class NeedsInputTray {
  // Note drafts, keyed by ticket id, so a snapshot re-render never wipes a
  // note being typed. Drafts are pruned when their interrupt resolves.
  private readonly drafts = new Map<string, string>();
  // Per-row answer errors, keyed by ticket id: a failed answer marks its own
  // row "answer failed · retry" until a retry (or another accepted answer)
  // clears it. A failure never touches the row's note draft.
  private readonly failures = new Map<string, NeedsInputFailure>();
  // Collapsed, the tray leaves only its "needs input · N" badge. Session
  // state, like the drafts: a snapshot re-render never expands it.
  private collapsed = false;
  private readonly onAnswer: AnswerHandler;
  private readonly onChange: () => void;

  constructor(options: NeedsInputOptions) {
    this.onAnswer = options.onAnswer;
    this.onChange = options.onChange;
  }

  /** The note draft held for a ticket, or "" when none is held. */
  note(ticketId: string): string {
    return this.drafts.get(ticketId) ?? "";
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

  /** Drop drafts whose interrupt resolved (or whose ticket left the pool). */
  pruneDrafts(pendingTicketIds: ReadonlySet<string>): void {
    this.prune(this.drafts, pendingTicketIds);
  }

  /** Drop failure marks whose row resolved (or whose ticket left the pool). */
  pruneFailures(pendingTicketIds: ReadonlySet<string>): void {
    this.prune(this.failures, pendingTicketIds);
  }

  private prune<V>(map: Map<string, V>, pendingTicketIds: ReadonlySet<string>): void {
    for (const id of [...map.keys()]) {
      if (!pendingTicketIds.has(id)) map.delete(id);
    }
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
   * card order.
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
      { class: "needs-input-tray" },
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
      ...conversationRows.map((row) => this.renderConversationRow(row, handlers)),
      ...rows.flatMap((row) => this.renderRow(row, handlers)),
    );
  }

  // A Conversation waiting on the operator: no interrupt, so no form. The
  // row's action opens the pane in herdr; a click on its id still selects
  // the card and opens the Detail, the same navigation every row offers.
  private renderConversationRow(
    row: ConversationNeedsInputRow,
    handlers: NeedsInputHandlers,
  ): HTMLElement {
    return h(
      "div",
      { class: "needs-input-row needs-input-row-conversation" },
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
    );
  }

  // One row: the ticket id (a click selects the card), the interrupt kind,
  // a note field, and the interrupt's own action set from the shared form
  // config. A waiting row greys out in place: the answer is recorded, so its
  // note and actions disable and the waiting line stands in, until the
  // boundary snapshot drops the row. A failed answer adds an inline mark
  // under the row with its retry. The interrupt body stays in the Detail;
  // the row is the queue entry, not the reading surface.
  private renderRow(row: NeedsInputRow, handlers: NeedsInputHandlers): HTMLElement[] {
    const status = waitingStatus(row);
    const waiting = status !== null;
    const note = h("input", {
      class: "interrupt-note needs-input-note",
      type: "text",
      placeholder: row.interrupt.form.notePlaceholder ?? "note",
      [FOCUS_KEY_ATTR]: `${row.ticketId}:tray`,
      disabled: waiting,
    }) as HTMLInputElement;
    note.value = this.note(row.ticketId);
    note.addEventListener("input", () => this.setNote(row.ticketId, note.value));
    const elements = [
      h(
        "div",
        {
          class: "needs-input-row" + (waiting ? " needs-input-row-waiting" : ""),
        },
        h(
          "button",
          {
            class: "needs-input-id",
            title: row.title ?? "open the Detail",
            onclick: () => handlers.onSelect(row.cardId),
          },
          row.label,
        ),
        h("span", { class: "needs-input-kind" }, row.interrupt.form.title),
        status !== null ? h("span", { class: "needs-input-waiting" }, status) : null,
        note,
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
        ),
      ),
    ];
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
