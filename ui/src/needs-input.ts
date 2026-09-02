/**
 * Needs input: the fixed left tray listing every ticket with an unresolved
 * Interrupt, the operator's work queue. One module owns the tray's
 * per-session state (note drafts keyed by ticket id; the collapsed flag and
 * per-row errors come later) and renders the rows from the projection,
 * following the canvas/detail/drawers split. A row answers through the same
 * handler seam the card and Detail forms use, so all three surfaces stay
 * live together; clicking a row's ticket id selects the card and opens its
 * Detail. State survives the full-DOM rebuild on every snapshot: drafts
 * live on the instance, and a note being typed keeps focus and cursor
 * across the swap.
 */

import type { NoteFocus } from "./detail";
import { h } from "./dom";
import type { InterruptAction, NeedsInputRow } from "./project";

/** The handlers the tray's interactive elements report through. */
export interface NeedsInputHandlers {
  onAnswer: (ticketId: string, action: InterruptAction, note?: string) => void;
  /** A row's ticket id was clicked: select that card and open its Detail. */
  onSelect: (cardId: string) => void;
}

export class NeedsInputTray {
  // Note drafts, keyed by ticket id, so a snapshot re-render never wipes a
  // note being typed. Drafts are pruned when their interrupt resolves.
  private readonly drafts = new Map<string, string>();

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
   * The tray, or null at zero pending interrupts: an idle pool shows no
   * dead chrome. The header count is the row count; every unresolved
   * interrupt lists, one row per card, in the projection's card order.
   */
  render(rows: NeedsInputRow[], handlers: NeedsInputHandlers): HTMLElement | null {
    if (rows.length === 0) return null;
    return h(
      "div",
      { class: "needs-input-tray" },
      h("div", { class: "needs-input-head" }, `needs input · ${rows.length}`),
      ...rows.map((row) => this.renderRow(row, handlers)),
    );
  }

  // One row: the ticket id (a click selects the card), the interrupt kind,
  // a note field, and the interrupt's own action set from the shared form
  // config. The interrupt body stays in the Detail; the row is the queue
  // entry, not the reading surface.
  private renderRow(row: NeedsInputRow, handlers: NeedsInputHandlers): HTMLElement {
    const note = h("input", {
      class: "interrupt-note needs-input-note",
      type: "text",
      placeholder: row.interrupt.form.notePlaceholder ?? "note",
      "data-note-key": `${row.ticketId}:tray`,
    }) as HTMLInputElement;
    note.value = this.note(row.ticketId);
    note.addEventListener("input", () => this.setNote(row.ticketId, note.value));
    return h(
      "div",
      { class: "needs-input-row" },
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
      note,
      h(
        "div",
        { class: "needs-input-actions" },
        ...row.interrupt.form.actions.map(({ action, label, tone }) =>
          h(
            "button",
            {
              class: "btn" + (tone === "primary" ? " btn-primary" : " btn-danger"),
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
