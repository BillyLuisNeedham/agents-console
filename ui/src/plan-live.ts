import { h } from "./dom";
import type { LiveCopy, LiveNode } from "./line-projection";
import { KIND_LABEL, type DrawnNode } from "./plan-projection";

const TONE_TEXT: Record<LiveCopy["tone"], string> = {
  pending: "pending",
  running: "running",
  checkpoint: "at a checkpoint",
  done: "done",
  closed: "closed",
};

function copyTitle(copy: LiveCopy): string {
  return `${copy.id}: ${TONE_TEXT[copy.tone]}`;
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
            ...live.copies.map((copy) =>
              h("button", {
                class: `plan-dot plan-dot-${copy.tone}` + (copy.selected ? " plan-dot-selected" : ""),
                type: "button",
                key: `dot:${copy.id}`,
                "data-card": copy.card,
                title: copyTitle(copy),
              }),
            ),
            ...Array.from({ length: live.queued }, (_, i) =>
              h("span", { class: "plan-dot plan-dot-queued", key: `queued:${i}`, title: "queued" }),
            ),
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
        ? h("div", { class: "plan-node-line plan-live-summary", title: live.summary }, live.summary)
        : null,
  );
}
