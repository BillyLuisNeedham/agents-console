/**
 * Needs input: the fixed left tray listing every ticket with an unresolved
 * Interrupt, the operator's work queue. One module owns the tray's
 * per-session state (note drafts keyed by ticket id, the collapsed flag) and
 * renders the rows from the projection, following the canvas/detail/drawers
 * split. A row whose interrupt has a matching Queued answer greys out in
 * place as "answered · waiting", its actions disabled, until the
 * super-step boundary drains it (ADR-0004); the collapsed tray leaves a
 * badge reading "needs input · N", waiting rows included in the count. A row
 * answers through the same handler seam the card and Detail forms use, so
 * all three surfaces stay live together; clicking a row's ticket id selects
 * the card and opens its Detail. State survives the full-DOM rebuild on
 * every snapshot: drafts and the collapsed flag live on the instance, and a
 * note being typed keeps focus and cursor across the swap.
 */

import type { NoteFocus } from "./detail";
import { h } from "./dom";
import type { InterruptAction, NeedsInputRow } from "./project";

/** The handlers the tray's interactive elements report through. */
export interface NeedsInputHandlers {
  onAnswer: (ticketId: string, action: InterruptAction, note?: string) => void;
  /** A row's ticket id was clicked: select that card and open its Detail. */
  onSelect: (cardId: string) => void;
  /** The tray toggled its collapsed flag; the caller re-renders. */
  onToggle: () => void;
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

  // Collapsed, the tray leaves only its "needs input · N" badge. Session
  // state, like the drafts: a snapshot re-render never expands it.
  private collapsed = false;

  /** The note draft held for a ticket, or "" when none is held. */
  note(ticketId: string): string {
    return this.drafts.get(ticketId) ?? "";
  }

  setNote(ticketId: string, value: string): void {
    this.drafts.set(ticketId, value);
  }

  /** Drop drafts whose interrupt resolved (or whose ticket left the pool). */
  pruneDrafts(pendingTicketIds: ReadonlySet<string>): void {
    for (const id of [...this.drafts.keys()]) {
      if (!pendingTicketIds.has(id)) this.drafts.delete(id);
    }
  }

  get isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
  }

  /**
   * Remember a note being typed before the rebuild: the text lives in the
   * drafts map, focus and cursor are restored after the swap. The tray's
   * note is a single-line input (the prototype's row shape), so this
   * captures input elements; the Detail's capture covers its textareas.
   */
  captureNoteFocus(): NoteFocus | null {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.dataset.noteKey) {
      return {
        key: active.dataset.noteKey,
        // A text input always reports a selection; the null arm is for
        // input types without one, which the tray never renders.
        start: active.selectionStart ?? 0,
        end: active.selectionEnd ?? 0,
      };
    }
    return null;
  }

  /** Restore a captured note focus onto the freshly rebuilt input. */
  restoreNoteFocus(root: HTMLElement, focus: NoteFocus | null): void {
    if (!focus) return;
    const next = root.querySelector<HTMLInputElement>(
      `input[data-note-key="${CSS.escape(focus.key)}"]`,
    );
    if (next) {
      next.focus();
      next.setSelectionRange(
        Math.min(focus.start, next.value.length),
        Math.min(focus.end, next.value.length),
      );
    }
  }

  /**
   * The tray, its badge, or null: at zero pending interrupts neither
   * renders, an idle pool shows no dead chrome. The header count is the row
   * count, waiting rows included; every unresolved interrupt lists, one row
   * per card, in the projection's card order.
   */
  render(rows: NeedsInputRow[], handlers: NeedsInputHandlers): HTMLElement | null {
    if (rows.length === 0) return null;
    if (this.collapsed) {
      return h(
        "button",
        {
          class: "needs-input-badge",
          title: "expand the needs input tray",
          onclick: () => {
            this.setCollapsed(false);
            handlers.onToggle();
          },
        },
        `needs input · ${rows.length}`,
      );
    }
    return h(
      "div",
      { class: "needs-input-tray" },
      h(
        "div",
        { class: "needs-input-head" },
        h("span", {}, `needs input · ${rows.length}`),
        h(
          "button",
          {
            class: "needs-input-collapse",
            title: "collapse to a badge",
            onclick: () => {
              this.setCollapsed(true);
              handlers.onToggle();
            },
          },
          "collapse",
        ),
      ),
      ...rows.map((row) => this.renderRow(row, handlers)),
    );
  }

  // One row: the ticket id (a click selects the card), the interrupt kind,
  // a note field, and the interrupt's own action set from the shared form
  // config. The interrupt body stays in the Detail; the row is the queue
  // entry, not the reading surface. A waiting row greys out in place: the
  // answer is recorded, so its note and actions disable and the waiting
  // line stands in, until the boundary snapshot drops the row.
  private renderRow(row: NeedsInputRow, handlers: NeedsInputHandlers): HTMLElement {
    const status = waitingStatus(row);
    const waiting = status !== null;
    const note = h("input", {
      class: "interrupt-note needs-input-note",
      type: "text",
      placeholder: row.interrupt.form.notePlaceholder ?? "note",
      "data-note-key": `${row.ticketId}:tray`,
      disabled: waiting,
    }) as HTMLInputElement;
    note.value = this.note(row.ticketId);
    note.addEventListener("input", () => this.setNote(row.ticketId, note.value));
    return h(
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
              onclick: () =>
                handlers.onAnswer(row.ticketId, action, this.note(row.ticketId)),
            },
            label,
          ),
        ),
      ),
    );
  }
}
