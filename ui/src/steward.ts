/**
 * The Steward's marks (ADR-0030; CONTEXT.md: Steward, Steward note): the
 * badge that tells the Steward's card and tray row from an ordinary
 * Conversation's, and the Steward note box the Needs input row and the
 * Detail's interrupt form both show, the terminal.ts way: one drawing, so
 * both surfaces say the same thing. "Use as answer" copies the note into
 * the Interrupt's Draft answer through whichever surface's seam drew it;
 * the operator still sends it, and may edit it first.
 */

import { h } from "./dom";
import type { StewardNote } from "./project";

/** The badge on the Steward's card, Detail and tray row. */
export function renderStewardBadge(): HTMLElement {
  return h(
    "span",
    {
      class: "steward-badge",
      title: "the Steward: answers this Pool's Interrupts while you are away",
    },
    "Steward",
  );
}

/**
 * The Steward note on a pending Interrupt: the Steward's recommendation,
 * which it left for the operator rather than answering, and "Use as answer",
 * which makes it the Draft answer. Disabled with the rest of the form once
 * an answer is queued.
 */
export function renderStewardNote(
  note: StewardNote,
  options: { disabled: boolean; onUse: () => void },
): HTMLElement {
  return h(
    "div",
    { class: "steward-note", key: "steward-note" },
    h(
      "div",
      { class: "steward-note-head" },
      h("span", { class: "steward-note-label" }, "Steward note"),
      h(
        "button",
        {
          class: "btn steward-note-use",
          type: "button",
          disabled: options.disabled,
          title: "copy the Steward note into your answer, to send or edit",
          onclick: () => options.onUse(),
        },
        "Use as answer",
      ),
    ),
    h("div", { class: "steward-note-text" }, note.text),
  );
}
