// Variant B: ambient color-coding. Each harness gets a hue; cards take a
// colored left edge and a dot, and a floating legend maps colors to harnesses
// and models with ticket counts.
import { h } from "../dom";
import type { ResolvedAssignment } from "./assignments";
import type { AssignmentRenderContext, AssignmentVariant } from "./index";
import "./variant-b.css";

const HUES = [210, 150, 30, 280, 0, 90, 330, 60];

function harnessColor(harness: string, order: ReadonlyMap<string, number>): string {
  const i = order.get(harness) ?? 0;
  return `hsl(${HUES[i % HUES.length]} 70% 60%)`;
}

let legend: HTMLElement | null = null;

function render(ctx: AssignmentRenderContext): void {
  const order = new Map<string, number>();
  for (const a of ctx.assignments.values()) {
    if (a.harness && !order.has(a.harness)) order.set(a.harness, order.size);
  }

  const cards = ctx.root.querySelectorAll<HTMLElement>("[data-ticket-id]");
  for (const card of cards) {
    const id = card.dataset.ticketId;
    if (!id) continue;
    card.querySelector(".pasgB-dot")?.remove();
    card.style.borderLeft = "";
    const a = ctx.assignments.get(id);
    if (!a || !a.harness) continue;
    const color = harnessColor(a.harness, order);
    card.style.borderLeft = `4px solid ${color}`;
    card.appendChild(
      h(
        "div",
        { class: "pasgB-dot", title: `${a.harness} · ${a.model ?? "?"}` },
        h("span", { class: "pasgB-swatch", style: `background: ${color}` }),
        h("span", { class: "pasgB-model" }, a.model ?? "?"),
      ),
    );
  }

  legend?.remove();
  const byHarness = new Map<string, ResolvedAssignment[]>();
  for (const a of ctx.assignments.values()) {
    if (!a.harness) continue;
    const list = byHarness.get(a.harness) ?? [];
    list.push(a);
    byHarness.set(a.harness, list);
  }
  legend = h(
    "div",
    { class: "pasgB-legend" },
    h("div", { class: "pasgB-title" }, "harness · model"),
    ...[...byHarness.entries()].map(([harness, list]) => {
      const models = [...new Set(list.map((a) => a.model ?? "?"))];
      return h(
        "div",
        { class: "pasgB-row" },
        h("span", {
          class: "pasgB-swatch",
          style: `background: ${harnessColor(harness, order)}`,
        }),
        h("span", { class: "pasgB-harness" }, harness),
        h("span", { class: "pasgB-models" }, models.join(", ")),
        h("span", { class: "pasgB-count" }, `${list.length}`),
      );
    }),
  );
  document.body.appendChild(legend);
}

function unmount(): void {
  legend?.remove();
  legend = null;
  for (const card of document.querySelectorAll<HTMLElement>("[data-ticket-id]")) {
    card.style.borderLeft = "";
    card.querySelector(".pasgB-dot")?.remove();
  }
}

export const variantB: AssignmentVariant = {
  key: "B",
  name: "Color code + legend",
  render,
  unmount,
};
