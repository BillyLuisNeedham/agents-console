import { h } from "../dom";
import type { PrototypeRenderContext, PrototypeVariant, TicketActivity } from "./index";
import "./variant-b.css";

const previousSamples = new Map<string, { size: number; at: number }>();

function newestSignalAt(a: TicketActivity): number | null {
  let latest: number | null = null;
  for (const iso of [a.lastEventAt, a.log?.mtime ?? null]) {
    if (!iso) continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRate(bytesPerSec: number): string {
  const sign = bytesPerSec >= 0 ? "+" : "−";
  return `${sign}${formatBytes(Math.abs(bytesPerSec))}/s`;
}

function formatIdle(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function cell(ctx: PrototypeRenderContext, a: TicketActivity): HTMLElement {
  const signalAt = newestSignalAt(a);
  const ageMs = signalAt === null ? Infinity : Math.max(0, ctx.now - signalAt);
  const freshness = ageMs < 10_000 ? "fresh" : ageMs <= 60_000 ? "warm" : "stale";
  const idleMs = signalAt === null ? null : ageMs > 60_000 ? ageMs : null;

  const size = a.log?.size ?? 0;
  const prev = previousSamples.get(a.ticketId);
  previousSamples.set(a.ticketId, { size, at: ctx.now });
  const rateText =
    prev && ctx.now > prev.at
      ? formatRate((size - prev.size) / ((ctx.now - prev.at) / 1000))
      : "—";

  const diffText = a.diff
    ? `+${a.diff.added} −${a.diff.removed} · ${a.diff.files.length} file${a.diff.files.length === 1 ? "" : "s"}`
    : "no changes yet";
  const lastFile = a.diff && a.diff.files.length > 0 ? basename(a.diff.files[a.diff.files.length - 1]) : null;

  return h(
    "div",
    { class: `protoB-cell${idleMs !== null ? " protoB-cell-idle" : ""}` },
    h("span", { class: `protoB-dot protoB-dot-${freshness}` }),
    h("span", { class: "protoB-id" }, a.ticketId),
    h("span", { class: "protoB-rate" }, rateText),
    h("span", { class: "protoB-size" }, formatBytes(size)),
    h("span", { class: "protoB-diff" }, diffText),
    lastFile ? h("span", { class: "protoB-file" }, lastFile) : null,
    idleMs !== null ? h("span", { class: "protoB-idle" }, `idle ${formatIdle(idleMs)}`) : null,
  );
}

function render(ctx: PrototypeRenderContext): void {
  for (const el of Array.from(document.querySelectorAll(".protoB-strip"))) {
    el.remove();
  }
  const entries = [...ctx.activity.values()].filter((a) => ctx.demo || a.running);
  const strip =
    entries.length === 0
      ? h("div", { class: "protoB-strip protoB-strip-empty" }, "no active agents")
      : h("div", { class: "protoB-strip" }, ...entries.map((a) => cell(ctx, a)));
  const viewport = ctx.root.querySelector(".canvas-viewport");
  if (viewport instanceof HTMLElement) {
    strip.classList.add("protoB-strip-overlay");
    viewport.appendChild(strip);
  } else {
    strip.classList.add("protoB-strip-fixed");
    document.body.appendChild(strip);
  }
}

export const variantB: PrototypeVariant = { key: "B", name: "Telemetry strip", render };
