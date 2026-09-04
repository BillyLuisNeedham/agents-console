// Variant A: a badge on every ticket card naming its harness and model.
import { h } from "../dom";
import { sourceLabel } from "./assignments";
import type { AssignmentRenderContext, AssignmentVariant } from "./index";
import "./variant-a.css";

const SVG_NS = "http://www.w3.org/2000/svg";

// A fake Vitals footer, same markup and classes as canvas.ts renderVitals,
// so a "working" card shows the badge sitting next to the real stats chrome.
function fakeVitals(seed: number): HTMLElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "vitals-spark");
  svg.setAttribute("width", "48");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 48 14");
  const poly = document.createElementNS(SVG_NS, "polyline");
  const points = [3, 5, 4, 9, 12, 11, 18, 22]
    .map((v, i) => `${(i * (48 / 7)).toFixed(1)},${(13 - Math.min(12, (v * (seed + 1)) / 24)).toFixed(1)}`)
    .join(" ");
  poly.setAttribute("points", points);
  svg.appendChild(poly);
  return h(
    "div",
    { class: "vitals vitals-live pasgA-fake-vitals" },
    h(
      "span",
      { class: "vitals-diff" },
      h("span", { class: "vitals-added" }, `+${128 + seed * 40}`),
      " ",
      h("span", { class: "vitals-removed" }, `−${34 + seed * 11}`),
      ` · ${6 - seed * 2} files`,
    ),
    h("span", { class: "vitals-stale vitals-fresh" }, "changed 4s ago"),
    svg,
  );
}

function render(ctx: AssignmentRenderContext): void {
  const cards = [...ctx.root.querySelectorAll<HTMLElement>("[data-ticket-id]")];
  let faked = 0;
  for (const card of cards) {
    const id = card.dataset.ticketId;
    if (!id) continue;
    card.querySelector(".pasgA-badge")?.remove();
    card.querySelector(".pasgA-fake-vitals")?.remove();
    const body = card.querySelector<HTMLElement>(".node-card-body") ?? card;
    if (ctx.working && faked < 2 && !body.querySelector(".vitals")) {
      body.appendChild(fakeVitals(faked));
      faked += 1;
    }
    const a = ctx.assignments.get(id);
    if (!a || !a.harness) continue;
    body.appendChild(
      h(
        "div",
        { class: `pasgA-badge pasgA-${a.source.kind}` },
        h("span", { class: "pasgA-pair" }, `${a.harness} · ${a.model ?? "?"}`),
        h("span", { class: "pasgA-src" }, sourceLabel(a.source)),
      ),
    );
  }
}

export const variantA: AssignmentVariant = {
  key: "A",
  name: "Card badges",
  render,
};
