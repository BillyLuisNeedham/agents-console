/**
 * PROTOTYPE (throwaway) — the three bulk-resume UI variants, issue #27.
 * Each is chrome appended over the real canvas render; every variant answers
 * the same question with a different structure: where does the selection
 * live, and where does the per-ticket instruction live?
 *
 * A · card checkboxes — selection embedded in the cards, a floating bulk bar
 *   carries one note field per selected ticket.
 * B · needs-input tray — no selection at all: a pinned work queue lists every
 *   waiting interrupt, with per-row notes and a resume-all.
 * C · resume-all modal — no selection either: one header button opens a
 *   modal with a single shared note applied to every waiting ticket.
 */

import { h } from "../dom";
import type { TicketCardView } from "../project";
import type { ProtoPool } from "./fixture";

export type VariantKey = "A" | "B" | "C";

export const VARIANTS: { key: VariantKey; name: string; blurb: string }[] = [
  {
    key: "A",
    name: "card checkboxes",
    blurb: "tick the crashed cards · one note per ticket · fire once",
  },
  {
    key: "B",
    name: "needs-input tray",
    blurb: "a pinned queue of every waiting interrupt",
  },
  {
    key: "C",
    name: "resume-all modal",
    blurb: "one button · one shared note · everything at once",
  },
];

export interface ProtoUiState {
  checked: Set<string>;
  notes: Map<string, string>;
  modalOpen: boolean;
  sharedNote: string;
}

export interface ProtoCtx {
  pool: ProtoPool;
  render: () => void;
  select: (nodeId: string) => void;
  state: ProtoUiState;
}

export type PendingCard = TicketCardView & { interrupt: NonNullable<TicketCardView["interrupt"]> };

function fire(ctx: ProtoCtx, entries: { ticketId: string; note?: string }[]): void {
  for (const entry of entries) {
    if (entry.ticketId) ctx.pool.acceptAnswer(entry.ticketId, "resume", entry.note);
  }
  ctx.state.checked.clear();
  ctx.state.modalOpen = false;
}

function noteInput(
  className: string,
  placeholder: string,
  value: string,
  onType: (value: string) => void,
): HTMLElement {
  const input = h("input", { class: className, placeholder, value }) as HTMLInputElement;
  input.addEventListener("input", () => onType(input.value));
  return input;
}

// ---------------------------------------------------------------------------
// A · card checkboxes + floating bulk bar
// ---------------------------------------------------------------------------

function chromeA(root: HTMLElement, pending: PendingCard[], ctx: ProtoCtx): void {
  for (const card of pending) {
    const el = root.querySelector(`[data-node-id="${card.id}"]`);
    const head = el?.querySelector(".node-card-head");
    if (!head) continue;
    if (card.interrupt.queued) {
      head.append(h("span", { class: "proto-tag", title: "answer accepted, waiting on the engine" }, "queued"));
      continue;
    }
    const box = h("input", {
      type: "checkbox",
      class: "proto-check",
      checked: ctx.state.checked.has(card.ticketId),
      title: "add to bulk resume",
    }) as HTMLInputElement;
    box.addEventListener("change", () => {
      if (box.checked) ctx.state.checked.add(card.ticketId);
      else ctx.state.checked.delete(card.ticketId);
      ctx.render();
    });
    head.prepend(h("label", { class: "proto-check-label", title: "add to bulk resume" }, box));
    if (el && ctx.state.checked.has(card.ticketId)) {
      el.classList.add("proto-picked");
    }
  }

  if (ctx.state.checked.size === 0) return;
  const rows = [...ctx.state.checked].map((ticketId) => {
    const card = pending.find((c) => c.ticketId === ticketId);
    if (!card) return null;
    return h(
      "div",
      { class: "proto-bulkbar-row" },
      h("span", { class: "proto-mono" }, ticketId),
      noteInput(
        "proto-note",
        `note for ${ticketId}`,
        ctx.state.notes.get(ticketId) ?? "",
        (value) => ctx.state.notes.set(ticketId, value),
      ),
      h(
        "button",
        {
          class: "btn",
          title: "remove from bulk resume",
          onclick: () => {
            ctx.state.checked.delete(ticketId);
            ctx.render();
          },
        },
        "×",
      ),
    );
  });
  root.append(
    h(
      "div",
      { class: "proto-bulkbar" },
      h("div", { class: "proto-bulkbar-head" }, "bulk resume"),
      ...rows,
      h(
        "div",
        { class: "proto-bulkbar-foot" },
        h(
          "button",
          {
            class: "btn proto-primary",
            onclick: () =>
              fire(
                ctx,
                [...ctx.state.checked].map((ticketId) => ({
                  ticketId,
                  note: ctx.state.notes.get(ticketId),
                })),
              ),
          },
          `resume ${ctx.state.checked.size}`,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// B · needs-input tray
// ---------------------------------------------------------------------------

function chromeB(root: HTMLElement, pending: PendingCard[], ctx: ProtoCtx): void {
  const open = pending.filter((c) => !c.interrupt.queued);
  const rows = pending.map((card) => {
    if (card.interrupt.queued) {
      return h(
        "div",
        { class: "proto-tray-row proto-tray-waiting" },
        h("button", { class: "proto-link", onclick: () => ctx.select(card.id) }, card.ticketId),
        h("span", { class: "dim" }, `${card.interrupt.kind} · answered · waiting`),
      );
    }
    return h(
      "div",
      { class: "proto-tray-row" },
      h("button", { class: "proto-link", onclick: () => ctx.select(card.id) }, card.ticketId),
      h("span", { class: `proto-kind proto-kind-${card.interrupt.kind}` }, card.interrupt.kind),
      noteInput(
        "proto-note",
        "note",
        ctx.state.notes.get(card.ticketId) ?? "",
        (value) => ctx.state.notes.set(card.ticketId, value),
      ),
      h(
        "button",
        {
          class: "btn",
          onclick: () =>
            fire(ctx, [
              { ticketId: card.ticketId, note: ctx.state.notes.get(card.ticketId) },
            ]),
        },
        "resume",
      ),
    );
  });
  root.append(
    h(
      "div",
      { class: "proto-tray" },
      h(
        "div",
        { class: "proto-tray-head" },
        h("span", {}, `needs input · ${pending.length}`),
        h(
          "button",
          {
            class: "btn proto-primary",
            disabled: open.length === 0,
            onclick: () =>
              fire(
                ctx,
                open.map((c) => ({
                  ticketId: c.ticketId,
                  note: ctx.state.notes.get(c.ticketId),
                })),
              ),
          },
          `resume all ${open.length}`,
        ),
      ),
      ...rows,
    ),
  );
}

// ---------------------------------------------------------------------------
// C · resume-all modal from the canvas header
// ---------------------------------------------------------------------------

function chromeC(root: HTMLElement, pending: PendingCard[], ctx: ProtoCtx): void {
  const open = pending.filter((c) => !c.interrupt.queued);
  const tools = root.querySelector(".canvas-tools");
  tools?.prepend(
    h(
      "button",
      {
        class: "btn proto-primary",
        disabled: open.length === 0,
        onclick: () => {
          ctx.state.modalOpen = true;
          ctx.render();
        },
      },
      `resume all ${open.length}`,
    ),
  );
  if (!ctx.state.modalOpen) return;

  const shared = h("textarea", {
    class: "proto-note proto-shared",
    placeholder: "one instruction applied to every ticket",
    value: ctx.state.sharedNote,
  }) as HTMLTextAreaElement;
  shared.addEventListener("input", () => {
    ctx.state.sharedNote = shared.value;
  });

  root.append(
    h(
      "div",
      { class: "proto-modal-back" },
      h(
        "div",
        { class: "proto-modal" },
        h("div", { class: "proto-modal-title" }, `resume ${open.length} tickets`),
        h(
          "div",
          { class: "proto-modal-list" },
          ...open.map((card) =>
            h(
              "div",
              { class: "proto-modal-row" },
              h("span", { class: "proto-mono" }, card.ticketId),
              h("span", { class: `proto-kind proto-kind-${card.interrupt.kind}` }, card.interrupt.kind),
              h("span", { class: "dim proto-modal-title-text" }, card.title),
            ),
          ),
        ),
        shared,
        h(
          "div",
          { class: "proto-modal-actions" },
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                ctx.state.modalOpen = false;
                ctx.render();
              },
            },
            "cancel",
          ),
          h(
            "button",
            {
              class: "btn proto-primary",
              onclick: () =>
                fire(
                  ctx,
                  open.map((c) => ({ ticketId: c.ticketId, note: ctx.state.sharedNote })),
                ),
            },
            `resume ${open.length}`,
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------

const CHROME: Record<VariantKey, (root: HTMLElement, pending: PendingCard[], ctx: ProtoCtx) => void> = {
  A: chromeA,
  B: chromeB,
  C: chromeC,
};

export function applyVariant(
  root: HTMLElement,
  key: VariantKey,
  pending: PendingCard[],
  ctx: ProtoCtx,
): void {
  CHROME[key](root, pending, ctx);
}
