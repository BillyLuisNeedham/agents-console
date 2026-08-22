// PROTOTYPE — throwaway. Variant A "Phase tabs" for issue #11 (see ticket details).

import { h, renderInterrupt, renderTimelineSection, statusLabel } from "../view";
import type { TicketDetailView, TimelineView } from "../project";

export interface VariantProps {
  detail: TicketDetailView; // { kind:"ticket", ticketId, title, status, blockedBy, outcome, interrupt }
  body: string | null; // raw markdown text of the ticket file, null while loading/missing
  timeline: TimelineView | null;
  onAnswer: (ticketId: string, action: string, note?: string) => void;
}

export const variantName = "Phase tabs";

type TabId = "spec" | "progress" | "outcome";

const TABS: { id: TabId; label: string }[] = [
  { id: "spec", label: "Spec" },
  { id: "progress", label: "Progress" },
  { id: "outcome", label: "Outcome" },
];

// Module-scope tab state: the Console rebuilds the whole DOM on every server
// snapshot, so a clicked tab must survive in module scope the way the Detail's
// own selection does. null means "auto from phase"; lastTicketId resets the
// choice whenever the selected ticket changes.
let activeTab: TabId | null = null;
let lastTicketId: string | null = null;

function autoTab(detail: TicketDetailView): TabId {
  // A pending interrupt always wins: a merge-conflict can leave a *done*
  // ticket waiting on a human, and the Progress tab is where the action
  // lives. The canvas's own styling follows the same rule (interrupt beats
  // status), so the Detail's default should too.
  if (detail.interrupt) return "progress";
  if (detail.status === "done") return "outcome";
  if (detail.status === "in-progress" || detail.status === "checkpoint") return "progress";
  return "spec";
}

function currentTab(detail: TicketDetailView): TabId {
  if (lastTicketId !== detail.ticketId) {
    lastTicketId = detail.ticketId;
    activeTab = null;
  }
  return activeTab ?? autoTab(detail);
}

// ---------------------------------------------------------------------------
// Styles: appended once, guarded by a module boolean. The shared styles.css is
// owned by another agent, so the variant ships its own <style> using the same
// raw token values (#0b0e14 bg, #12161f/#1a2030 panels, #232a3b border,
// #d4dae4 text, #7d8597 dim, #4cc2ff accent, mono stack, 13px base feel).
// ---------------------------------------------------------------------------

let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.proto-a-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.proto-a-title {
  font-size: 12px;
  font-weight: 700;
  color: #d4dae4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-a-tabs {
  display: flex;
  flex-shrink: 0;
  border-bottom: 1px solid #232a3b;
}
.proto-a-tab {
  appearance: none;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 5px 12px 4px;
  color: #7d8597;
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
    "Liberation Mono", monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}
.proto-a-tab:hover {
  color: #d4dae4;
}
.proto-a-tab-active,
.proto-a-tab-active:hover {
  color: #4cc2ff;
  border-bottom-color: #4cc2ff;
}
.proto-a-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.proto-a-section {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #7d8597;
}
.proto-a-section-gap {
  margin-top: 6px;
}
.proto-a-dim {
  color: #7d8597;
  font-size: 11px;
}
.proto-a-empty {
  padding: 6px 0;
}
.proto-a-blockers {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-a-status {
  font-size: 12px;
}
.proto-a-divider {
  height: 1px;
  background: #232a3b;
  margin: 4px 0;
}
.proto-a-body,
.proto-a-outcome-pre {
  margin: 0;
  padding: 8px 10px;
  background: #0b0e14;
  border: 1px solid #232a3b;
  border-radius: 4px;
  color: #d4dae4;
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
    "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  max-height: 60vh;
  overflow: auto;
}
.proto-a-outcome-pre {
  max-height: 40vh;
}
.proto-a-commit {
  font-size: 11px;
  color: #7d8597;
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Tab content
// ---------------------------------------------------------------------------

/** Strip a leading line-1 `<!-- ... -->` marker (the ticket file's state
 * comment) so the raw body reads as the ticket's own prose. */
function stripFrontMarker(body: string): string {
  if (!body.startsWith("<!--")) return body;
  const end = body.indexOf("-->");
  if (end === -1) return body;
  return body.slice(end + 3).replace(/^\r?\n/, "");
}

function renderSpec(props: VariantProps): HTMLElement {
  const { detail, body } = props;
  return h(
    "div",
    { class: "proto-a-panel" },
    h(
      "div",
      { class: "proto-a-dim proto-a-blockers" },
      detail.blockedBy.length > 0 ? `blocked by ${detail.blockedBy.join(", ")}` : "no blockers",
    ),
    body == null
      ? h("div", { class: "proto-a-dim proto-a-empty" }, "loading ticket body…")
      : h("pre", { class: "proto-a-body" }, stripFrontMarker(body)),
  );
}

function renderProgress(props: VariantProps): HTMLElement {
  const { detail, timeline } = props;
  const sections: (Node | string | null)[] = [
    h("div", { class: "proto-a-section" }, "status"),
    h("div", { class: `proto-a-status ticket-state-${detail.status}` }, statusLabel(detail.status)),
  ];
  if (detail.interrupt) {
    sections.push(
      h("div", { class: "proto-a-section proto-a-section-gap" }, "action needed"),
      renderInterrupt(detail.interrupt, { onAnswer: props.onAnswer } as any),
    );
  }
  if (timeline) {
    if (detail.interrupt) sections.push(h("div", { class: "proto-a-divider" }));
    // PROTOTYPE — throwaway: adapted to the current renderTimelineSection
    // (ticketId, timeline, logPane, handlers) signature; the variant has no
    // log pane, and a no-op attempt selector keeps row clicks inert here.
    sections.push(
      renderTimelineSection(detail.ticketId, timeline, null, {
        onAnswer: props.onAnswer,
        onSelectAttempt: () => {},
      } as any),
    );
  }
  return h("div", { class: "proto-a-panel" }, ...sections);
}

function renderOutcome(props: VariantProps): HTMLElement {
  const outcome = props.detail.outcome;
  if (!outcome) {
    return h(
      "div",
      { class: "proto-a-panel" },
      h("div", { class: "proto-a-dim proto-a-empty" }, "not finished yet"),
    );
  }
  return h(
    "div",
    { class: "proto-a-panel" },
    h("pre", { class: "proto-a-outcome-pre" }, outcome.summary || "-"),
    outcome.commitSha
      ? h("div", { class: "proto-a-dim proto-a-commit" }, `commit ${outcome.commitSha}`)
      : null,
  );
}

function renderPanel(props: VariantProps, tab: TabId): HTMLElement {
  switch (tab) {
    case "spec":
      return renderSpec(props);
    case "progress":
      return renderProgress(props);
    case "outcome":
      return renderOutcome(props);
  }
}

function drawTabs(
  container: HTMLElement,
  active: TabId,
  onSelect: (tab: TabId) => void,
): void {
  container.replaceChildren(
    ...TABS.map(({ id, label }) =>
      h(
        "button",
        {
          type: "button",
          class: "proto-a-tab" + (id === active ? " proto-a-tab-active" : ""),
          onclick: () => onSelect(id),
        },
        label,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------

export function VariantA(props: VariantProps): HTMLElement {
  ensureStyles();
  const root = h("div", { class: "proto-a-root" });
  const tabsEl = h("div", { class: "proto-a-tabs" });
  const panelEl = h("div", { class: "proto-a-panel" });

  // Tab clicks re-draw in place (no URL touch). Between server snapshots the
  // whole DOM is rebuilt and this closure is discarded; module state carries
  // the selection forward.
  const select = (tab: TabId): void => {
    activeTab = tab;
    drawTabs(tabsEl, tab, select);
    panelEl.replaceChildren(renderPanel(props, tab));
  };

  root.append(
    h("div", { class: "proto-a-title", title: props.detail.ticketId }, props.detail.title),
    tabsEl,
    panelEl,
  );
  const tab = currentTab(props.detail);
  drawTabs(tabsEl, tab, select);
  panelEl.replaceChildren(renderPanel(props, tab));
  return root;
}