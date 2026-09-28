/**
 * Draft answers: the operator's note for a ticket's pending Interrupt, typed
 * but not yet sent, one per ticket id. The Needs input tray and the Detail
 * both answer interrupts, and a draft is the same draft whichever surface it
 * was typed in (issue #147), so the composition root creates one store and
 * hands it to both. Each surface writes on input and reads at render and at
 * dispatch. Neither re-renders on a keystroke, and fullscreen and Esc change
 * the page without one, so a keystroke also mirrors the draft into every
 * other field showing it: a field left holding a stale copy would write that
 * copy back over the draft on its own next keystroke. The morph leaves a
 * focused field's value alone when it already matches, and it always does,
 * since the field wrote it. The composition prunes once per render against
 * the pending interrupts: a draft goes when its interrupt is answered and
 * drained or its ticket leaves the pool. Browser memory only, never
 * persisted.
 */

/** The attribute naming the ticket whose draft a note field shows. */
export const DRAFT_TICKET_ATTR = "data-draft-ticket";

export class DraftAnswers {
  private readonly drafts = new Map<string, string>();

  /** The draft held for a ticket, or "" when none is held. */
  get(ticketId: string): string {
    return this.drafts.get(ticketId) ?? "";
  }

  set(ticketId: string, value: string): void {
    this.drafts.set(ticketId, value);
  }

  /**
   * Take a keystroke from a note field: hold its value as the ticket's draft
   * and copy it into every other field on the page showing that draft.
   */
  input(ticketId: string, field: HTMLTextAreaElement): void {
    this.set(ticketId, field.value);
    const peers = field.ownerDocument.querySelectorAll<HTMLTextAreaElement>(
      `textarea[${DRAFT_TICKET_ATTR}]`,
    );
    for (const peer of peers) {
      if (peer === field || peer.getAttribute(DRAFT_TICKET_ATTR) !== ticketId) continue;
      if (peer.value !== field.value) peer.value = field.value;
    }
  }

  /** Drop drafts whose interrupt resolved (or whose ticket left the pool). */
  prune(pendingTicketIds: ReadonlySet<string>): void {
    for (const id of [...this.drafts.keys()]) {
      if (!pendingTicketIds.has(id)) this.drafts.delete(id);
    }
  }
}
