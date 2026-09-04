// Variant C: a table of the whole pool's assignments, one row per ticket,
// grouped by harness, overrides called out. The card canvas stays untouched.
import { h } from "../dom";
import { sourceLabel, type ResolvedAssignment } from "./assignments";
import type { AssignmentRenderContext, AssignmentVariant } from "./index";
import "./variant-c.css";

let panel: HTMLElement | null = null;

function row(a: ResolvedAssignment): HTMLElement {
  return h(
    "tr",
    { class: `pasgC-row pasgC-${a.source.kind}` },
    h("td", { class: "pasgC-id" }, a.ticketId),
    h("td", {}, a.harness ?? "—"),
    h("td", {}, a.model ?? "—"),
    h("td", { class: "pasgC-drivers" }, a.drivers.join(", ") || "—"),
    h("td", { class: "pasgC-src" }, sourceLabel(a.source)),
  );
}

function render(ctx: AssignmentRenderContext): void {
  panel?.remove();
  const all = [...ctx.assignments.values()];
  const harnesses = new Set(all.map((a) => a.harness).filter(Boolean));
  const models = new Set(all.map((a) => a.model).filter(Boolean));
  const overrides = all.filter((a) => a.source.kind === "override").length;

  const groups = new Map<string, ResolvedAssignment[]>();
  for (const a of all) {
    const key = a.harness ?? "unassigned";
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }

  const body = h("tbody", {});
  for (const [harness, list] of [...groups.entries()].sort()) {
    body.appendChild(
      h(
        "tr",
        { class: "pasgC-group" },
        h("td", { colspan: "5" }, `${harness} (${list.length})`),
      ),
    );
    for (const a of list) body.appendChild(row(a));
  }

  panel = h(
    "div",
    { class: "pasgC-panel" },
    h("div", { class: "pasgC-head" }, "Assignments"),
    h(
      "div",
      { class: "pasgC-summary" },
      `${all.length} tickets · ${harnesses.size} harnesses · ` +
        `${models.size} models · ${overrides} overrides`,
    ),
    h(
      "table",
      { class: "pasgC-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "ticket"),
          h("th", {}, "harness"),
          h("th", {}, "model"),
          h("th", {}, "drivers"),
          h("th", {}, "source"),
        ),
      ),
      body,
    ),
  );
  document.body.appendChild(panel);
}

function unmount(): void {
  panel?.remove();
  panel = null;
}

export const variantC: AssignmentVariant = {
  key: "C",
  name: "Assignment table",
  render,
  unmount,
};
