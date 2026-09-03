import { h } from "../dom";
import type { TicketActivity } from "./activity";
import type { PrototypeRenderContext, PrototypeVariant } from "./index";
import "./variant-a.css";

const history = new Map<string, number[]>();
const MAX_SAMPLES = 40;

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function fmtIdle(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function sparkline(samples: number[]): SVGSVGElement {
  const w = 48;
  const hgt = 14;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "protoA-spark");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(hgt));
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  if (samples.length > 1) {
    const max = Math.max(...samples, 1);
    const step = w / (MAX_SAMPLES - 1);
    const pts = samples
      .map((v, i) => {
        const x = w - (samples.length - 1 - i) * step;
        const y = hgt - 1 - (v / max) * (hgt - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    poly.setAttribute("points", pts);
  }
  svg.appendChild(poly);
  return svg;
}

function diffPart(a: TicketActivity): HTMLElement {
  const d = a.diff;
  const total = d ? d.added + d.removed : 0;
  if (!d || total === 0) {
    return h("span", { class: "protoA-diff" }, "no changes yet");
  }
  return h(
    "span",
    { class: "protoA-diff" },
    h("span", { class: "protoA-added" }, `+${d.added}`),
    " ",
    h("span", { class: "protoA-removed" }, `−${d.removed}`),
    ` · ${d.files.length} files`,
  );
}

function stalePart(a: TicketActivity, now: number): HTMLElement {
  const logAt = a.log?.mtime ? Date.parse(a.log.mtime) : null;
  const eventAt = a.lastEventAt ? Date.parse(a.lastEventAt) : null;
  const candidates: { at: number; kind: "changed" | "output" }[] = [];
  if (eventAt != null && !Number.isNaN(eventAt)) candidates.push({ at: eventAt, kind: "changed" });
  if (logAt != null && !Number.isNaN(logAt)) candidates.push({ at: logAt, kind: "output" });
  if (candidates.length === 0) {
    return h("span", { class: "protoA-stale protoA-idle" }, "idle");
  }
  candidates.sort((x, y) => y.at - x.at);
  const newest = candidates[0];
  const age = now - newest.at;
  if (age > 60_000) {
    return h("span", { class: "protoA-stale protoA-idle" }, `idle ${fmtIdle(age)}`);
  }
  return h("span", { class: "protoA-stale" }, `${newest.kind} ${fmtAgo(age)}`);
}

function render(ctx: PrototypeRenderContext): void {
  const cards = ctx.root.querySelectorAll<HTMLElement>("[data-ticket-id]");
  for (const card of cards) {
    const id = card.dataset.ticketId;
    if (!id) continue;
    const a = ctx.activity.get(id);
    if (!a) continue;
    if (!ctx.demo && !a.running) continue;
    const total = a.diff ? a.diff.added + a.diff.removed : 0;
    const samples = history.get(id) ?? [];
    samples.push(total);
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    history.set(id, samples);
    const vitals = h(
      "div",
      { class: "protoA-vitals" },
      diffPart(a),
      stalePart(a, ctx.now),
      sparkline(samples),
    );
    card.querySelector(".protoA-vitals")?.remove();
    card.appendChild(vitals);
  }
}

export const variantA: PrototypeVariant = { key: "A", name: "Card vitals", render };
