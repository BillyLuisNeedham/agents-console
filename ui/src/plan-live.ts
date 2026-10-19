import { h } from "./dom";
import type { LiveCopy, LiveNode } from "./line-projection";
import { CARD_W, KIND_LABEL, type DrawnNode } from "./plan-projection";

const TONE_TEXT: Record<LiveCopy["tone"], string> = {
  pending: "pending",
  running: "running",
  interrupted: "needs input",
  checkpoint: "at a checkpoint",
  done: "done",
  closed: "closed",
};

function copyTitle(copy: LiveCopy): string {
  return `${copy.id}: ${TONE_TEXT[copy.tone]}`;
}

const DOT = 10;
const DOT_GAP = 3;
const SLOT = DOT + DOT_GAP;
const MONO_CHAR = 6;
const PILL_CHROME = 10;
const CARD_BORDER = 1;
const BODY_PADDING = 10;
const BODY_WIDTH = CARD_W - 2 * CARD_BORDER - 2 * BODY_PADDING;
const COPIES_PADDING = 4;
const ROW_GAP = 6;
const HOLD_CHROME = 12;
const HOLD_MAX = 0.55 * BODY_WIDTH;

export function copyRoom(hold: Pick<LiveCopy, "id"> | null): number {
  const holdWidth = hold ? ROW_GAP + Math.min(HOLD_MAX, hold.id.length * MONO_CHAR + HOLD_CHROME) : 0;
  return Math.floor((BODY_WIDTH - holdWidth - COPIES_PADDING + DOT_GAP) / SLOT);
}

const SUMMARY_CHAR = 6.3;

/** The longest of a summary's wordings that fits the card body, else the shortest. */
export function fitSummary(wordings: readonly string[]): string {
  return wordings.find((wording) => wording.length * SUMMARY_CHAR <= BODY_WIDTH) ?? wordings[wordings.length - 1]!;
}

const pillSlots = (text: string): number => Math.ceil((text.length * MONO_CHAR + PILL_CHROME + DOT_GAP) / SLOT);

export interface CopyRow {
  dots: LiveCopy[];
  done: number;
  queued: number;
  more: { count: number; next: LiveCopy } | null;
}

const needsOperator = (copy: LiveCopy): boolean =>
  copy.tone === "interrupted" || copy.tone === "checkpoint" || copy.tone === "closed";

function wearRank(copy: LiveCopy): number {
  if (copy.selected) return 0;
  if (needsOperator(copy)) return 1;
  return copy.tone === "running" ? 2 : 3;
}

export function copyRow(copies: readonly LiveCopy[], queued: number, room: number): CopyRow {
  if (copies.length + queued <= room) return { dots: [...copies], done: 0, queued, more: null };
  const active = copies.filter((copy) => copy.tone !== "done");
  const done = copies.length - active.length;
  const free = room - (done > 0 ? pillSlots(String(done)) : 0);
  if (active.length <= free) return { dots: active, done, queued: Math.min(queued, free - active.length), more: null };
  const shown = new Set(
    active
      .map((copy, i) => ({ copy, i }))
      .sort((a, b) => wearRank(a.copy) - wearRank(b.copy) || a.i - b.i)
      .slice(0, Math.max(0, free - pillSlots(`+${active.length}`)))
      .map(({ copy }) => copy),
  );
  const hidden = active.filter((copy) => !shown.has(copy));
  return {
    dots: active.filter((copy) => shown.has(copy)),
    done,
    queued: 0,
    more: { count: hidden.length, next: firstHiddenAfterSelected(copies, hidden) },
  };
}

function firstHiddenAfterSelected(copies: readonly LiveCopy[], hidden: readonly LiveCopy[]): LiveCopy {
  const selected = copies.findIndex((copy) => copy.selected);
  return hidden.find((copy) => copies.indexOf(copy) > selected) ?? hidden[0]!;
}

/** A live card's head label: the node's state word, coloured by its tone. */
export function liveState(live: LiveNode): HTMLElement {
  return h(
    "span",
    { class: `plan-node-state plan-state-${live.state.tone}`, title: live.state.text },
    live.state.text,
  );
}

/**
 * A live card's body: the kind and id, a row of one dot per copy with hollow
 * dots for what is queued and the hold as a chip, then the pass summary or,
 * on the Finish, what it waits for. A dot and a chip are buttons that open
 * their Ticket or Conversation (`data-card`).
 */
export function liveBody(drawn: DrawnNode, live: LiveNode): HTMLElement {
  const { node } = drawn;
  const row = copyRow(live.copies, live.queued, copyRoom(live.hold));
  return h(
    "div",
    { class: "plan-node-body" },
    h(
      "div",
      { class: "plan-node-row" },
      h("span", { class: "plan-kind" }, KIND_LABEL[node.kind]),
      h("span", { class: "plan-node-id" }, node.id),
    ),
    live.copies.length > 0 || live.queued > 0 || live.hold
      ? h(
          "div",
          { class: "plan-live-row" },
          h(
            "div",
            { class: "plan-copies" },
            row.done > 0
              ? h(
                  "span",
                  { class: "plan-copies-done", key: "done", title: `${row.done} done` },
                  String(row.done),
                )
              : null,
            ...row.dots.map((copy) =>
              h("button", {
                class: `plan-dot plan-dot-${copy.tone}` + (copy.selected ? " plan-dot-selected" : ""),
                type: "button",
                key: `dot:${copy.id}`,
                "data-card": copy.card,
                title: copyTitle(copy),
              }),
            ),
            ...Array.from({ length: row.queued }, (_, i) =>
              h("span", { class: "plan-dot plan-dot-queued", key: `queued:${i}`, title: "queued" }),
            ),
            row.more
              ? h(
                  "button",
                  {
                    class: "plan-copies-more",
                    type: "button",
                    key: "more",
                    "data-card": row.more.next.card,
                    title: `${row.more.count} more running or waiting: opens ${row.more.next.id}`,
                  },
                  `+${row.more.count}`,
                )
              : null,
          ),
          live.hold
            ? h(
                "button",
                {
                  class: "plan-hold" + (live.hold.selected ? " plan-hold-selected" : ""),
                  type: "button",
                  key: "hold",
                  "data-card": live.hold.card,
                  title: `${copyTitle(live.hold)} (holds this node)`,
                },
                live.hold.id,
              )
            : null,
        )
      : null,
    live.waitingFor.length > 0
      ? h(
          "div",
          { class: "plan-node-line plan-live-waiting", title: `Finish waiting for ${live.waitingFor.join(", ")}` },
          `waiting for ${live.waitingFor.join(", ")}`,
        )
      : live.summary
        ? h("div", { class: "plan-node-line plan-live-summary", title: live.summary[0] }, fitSummary(live.summary))
        : null,
  );
}
