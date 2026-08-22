// PROTOTYPE — throwaway. Variant B "Document reader" for issue #11 (see ticket details).
/**
 * Document-first reader: the ticket's own markdown IS the interface.
 *
 * Layout, top to bottom:
 *   1. a slim status rail (status chip · blockers · attempt count)
 *   2. the ticket body as the main reading surface (a raw-markdown <pre>)
 *   3. a collapsible "work log" (timeline + outcome + commit) at the bottom
 *   4. a sticky action bar pinning a pending interrupt to the panel's bottom
 *
 * The document dominates; everything else is secondary and scrolls past it.
 * Work-log collapse state is keyed per ticket in a module map so the full-DOM
 * rebuild on every snapshot never loses the reader's choice.
 */

import { h, renderInterrupt, renderTimelineSection, statusLabel } from "../view";
import type { InterruptView, TicketDetailView, TimelineView } from "../project";

export interface VariantProps {
  detail: TicketDetailView; // { kind:"ticket", ticketId, title, status, blockedBy, outcome, interrupt }
  body: string | null; // raw markdown text of the ticket file, null while loading/missing
  timeline: TimelineView | null;
  onAnswer: (ticketId: string, action: string, note?: string) => void;
}

export const variantName = "Document reader";

// ---------------------------------------------------------------------------
// Module state: survives the full-DOM rebuild on every snapshot
// ---------------------------------------------------------------------------

// Work-log collapse state per ticket. Missing key falls back to the default:
// expanded when the ticket is done, collapsed otherwise.
const workLogOpen = new Map<string, boolean>();

function isWorkLogOpen(ticketId: string, status: string): boolean {
  return workLogOpen.get(ticketId) ?? status === "done";
}

// ---------------------------------------------------------------------------
// Styles: one <style> injected once, tokens inlined (styles.css is another
// agent's file). Classes prefixed proto-b-. Dark, dense, developer-console.
// ---------------------------------------------------------------------------

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.proto-b {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  background: #12161f;
  color: #d4dae4;
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
}

/* 1. Slim status rail: one row, full width */
.proto-b-rail {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 12px;
  border-bottom: 1px solid #232a3b;
  background: #12161f;
  flex-shrink: 0;
}

.proto-b-chip {
  display: inline-block;
  padding: 1px 7px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  line-height: 1.5;
}

.proto-b-dim {
  color: #7d8597;
  font-size: 11px;
}

.proto-b-attempts {
  margin-left: auto;
  white-space: nowrap;
}

/* 2. The document: the ticket body is the main reading surface */
.proto-b-doc {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px;
}

.proto-b-doc-label {
  color: #7d8597;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.proto-b-body {
  flex: 1 1 auto;
  margin: 0;
  padding: 14px 16px;
  background: #0b0e14;
  border: 1px solid #232a3b;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  color: #d4dae4;
  font-size: 13px;
  line-height: 1.7;
  user-select: text;
}

.proto-b-doc-placeholder {
  flex: 1 1 auto;
  min-height: 160px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0b0e14;
  border: 1px dashed #232a3b;
  border-radius: 6px;
}

/* 3. Collapsible work log at the bottom */
.proto-b-log {
  flex-shrink: 0;
  border-top: 1px solid #232a3b;
}

.proto-b-log-toggle {
  display: block;
  width: 100%;
  padding: 6px 12px;
  background: #1a2030;
  border: none;
  color: #7d8597;
  font-family: inherit;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-align: left;
  cursor: pointer;
}

.proto-b-log-toggle:hover {
  color: #4cc2ff;
}

.proto-b-log-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}

.proto-b-log-body[hidden] {
  display: none;
}

.proto-b-log-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.proto-b-outcome {
  margin: 0;
  padding: 8px;
  background: #0b0e14;
  border: 1px solid #232a3b;
  border-radius: 4px;
  white-space: pre-wrap;
  color: #d4dae4;
  font-size: 12px;
  line-height: 1.6;
}

/* 4. Sticky action bar: a pending interrupt stays pinned while reading */
.proto-b-actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  padding: 8px 12px 10px;
  background: #12161f;
  border-top: 1px solid #232a3b;
  flex-shrink: 0;
}

.proto-b-actions-label {
  margin-bottom: 6px;
  color: #f85149;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip a leading line-1 `<!-- ... -->` marker (the engine's header comment). */
function stripFrontMatter(body: string): string {
  const match = /^[ \t]*<!--[\s\S]*?-->/.exec(body);
  if (!match) return body;
  return body.slice(match[0].length).replace(/^\r?\n/, "");
}

function attemptsLabel(timeline: TimelineView | null): string {
  if (!timeline || timeline.attempts.length === 0) return "no attempts yet";
  const n = timeline.attempts.length;
  return `${n} attempt${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Variant B
// ---------------------------------------------------------------------------

export function VariantB(props: VariantProps): HTMLElement {
  ensureStyle();
  const detail = props.detail;
  if (detail.kind !== "ticket") {
    return h("div", { class: "proto-b proto-b-dim" }, "not a ticket detail");
  }

  // 1. Slim status rail: status chip · blockers · attempt count
  const rail = h(
    "div",
    { class: "proto-b-rail" },
    h(
      "span",
      { class: `proto-b-chip ticket-state-${detail.status}` },
      statusLabel(detail.status),
    ),
    h(
      "span",
      { class: "proto-b-dim" },
      detail.blockedBy.length > 0
        ? `blocked by ${detail.blockedBy.join(", ")}`
        : "no blockers",
    ),
    h("span", { class: "proto-b-dim proto-b-attempts" }, attemptsLabel(props.timeline)),
  );

  // 2. The document: the ticket body dominates the panel
  const cleaned = props.body === null ? null : stripFrontMatter(props.body);
  let doc: HTMLElement;
  if (cleaned === null) {
    doc = h("div", { class: "proto-b-dim proto-b-doc-placeholder" }, "loading ticket body…");
  } else if (cleaned === "") {
    doc = h("div", { class: "proto-b-dim proto-b-doc-placeholder" }, "(no ticket body yet)");
  } else {
    doc = h("pre", { class: "proto-b-body" }, cleaned);
  }
  const docArea = h(
    "div",
    { class: "proto-b-doc" },
    h("div", { class: "proto-b-doc-label" }, "ticket body"),
    doc,
  );

  // 3. Collapsible work log: timeline, then outcome + commit when present
  const logOpen = isWorkLogOpen(detail.ticketId, detail.status);
  const logToggle = h(
    "button",
    { class: "proto-b-log-toggle", type: "button", "aria-expanded": String(logOpen) },
    logOpen ? "▾ work log" : "▸ work log",
  );
  // Set the property, not the h() attribute: the h() helper would set
  // attribute hidden="false", and the mere presence of the boolean `hidden`
  // attribute hides the element.
  const logBody = h("div", { class: "proto-b-log-body" });
  logBody.hidden = !logOpen;
  if (props.timeline) {
    // PROTOTYPE — throwaway: adapted to the current renderTimelineSection
    // (ticketId, timeline, logPane, handlers) signature; the variant has no
    // log pane, and a no-op attempt selector keeps row clicks inert here.
    logBody.append(
      renderTimelineSection(detail.ticketId, props.timeline, null, {
        onAnswer: props.onAnswer,
        onSelectAttempt: () => {},
      } as any),
    );
  } else {
    logBody.append(h("div", { class: "proto-b-dim" }, "no timeline yet"));
  }
  if (detail.outcome) {
    logBody.append(h("div", { class: "proto-b-dim proto-b-log-label" }, "outcome"));
    logBody.append(h("pre", { class: "proto-b-outcome" }, detail.outcome.summary || "-"));
    if (detail.outcome.commitSha) {
      logBody.append(h("div", { class: "proto-b-dim" }, `commit ${detail.outcome.commitSha}`));
    }
  }
  logToggle.addEventListener("click", () => {
    const next = !isWorkLogOpen(detail.ticketId, detail.status);
    workLogOpen.set(detail.ticketId, next);
    logToggle.textContent = next ? "▾ work log" : "▸ work log";
    logToggle.setAttribute("aria-expanded", String(next));
    logBody.hidden = !next;
  });
  const logSection = h("div", { class: "proto-b-log" }, logToggle, logBody);

  const root = h("div", { class: "proto-b" }, rail, docArea, logSection);

  // 4. Sticky action bar: a pending interrupt stays visible while reading
  if (detail.interrupt) {
    root.append(
      h(
        "div",
        { class: "proto-b-actions" },
        h("div", { class: "proto-b-actions-label" }, "action needed"),
        renderInterrupt(detail.interrupt, { onAnswer: props.onAnswer } as any),
      ),
    );
  }

  return root;
}