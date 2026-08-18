/**
 * Variant C — "Graph-Centric Flow"
 *
 * The graph topology IS the app: a large vertically-flowing node diagram
 * (START → writeSpec → approveSpec → schedule → implementTicket → review →
 * END, with deadlockGate hanging off schedule) drawn as DOM node cards wired
 * together by SVG edges. State is read THROUGH the graph — each node card
 * shows what that node currently holds or did — and interrupts render inline
 * in the node that raised them, pulsing red so your eye goes straight there.
 *
 * - Left rail (narrow): thread picker (UI-created default + "show all") and a
 *   compact "Start run" (topic, ticket-pool dropdown, packet behind a twisty).
 * - Side drawer (right): node detail on hover/click.
 * - Bottom drawer: the run log slides up instead of being a permanent pane.
 *
 * Shallow wiring: resume buttons call `ctx.resumeRun`, Start calls
 * `ctx.streamRun`; in MOCK DATA mode both are read-only no-ops.
 */

import { TICKET_POOLS } from "../data";
import type {
  InterruptDecision,
  InterruptProjection,
  ShellContext,
  ThreadListItem,
  Ticket,
} from "../data";

export const name = "Graph-Centric Flow";

// ---------------------------------------------------------------------------
// Layout — nodes sit in a vertical column; deadlockGate hangs off to the side.
// ---------------------------------------------------------------------------

const LAYOUT: Record<string, { x: number; y: number }> = {
  START: { x: 300, y: 16 },
  writeSpec: { x: 300, y: 196 },
  approveSpec: { x: 300, y: 376 },
  schedule: { x: 300, y: 556 },
  implementTicket: { x: 300, y: 736 },
  deadlockGate: { x: 620, y: 596 },
  review: { x: 300, y: 916 },
  END: { x: 300, y: 1096 },
};

/** Which interrupt kind a node owns — interrupts render inline in their node. */
const NODE_KIND: Record<string, string> = {
  approveSpec: "approve-spec",
  deadlockGate: "deadlock",
  review: "review",
};

/** Fallback labels for conditional edges (live data may carry its own `data`). */
const EDGE_LABELS: Record<string, string> = {
  "approveSpec>schedule": "approve",
  "approveSpec>writeSpec": "reject",
  "schedule>implementTicket": "send",
  "schedule>review": "no ready",
  "schedule>deadlockGate": "stuck",
  "deadlockGate>schedule": "reload",
  "deadlockGate>END": "abort",
  "review>schedule": "retry",
  "review>writeSpec": "replan",
  "review>END": "approve",
};

const ARROW_ID = "vc-arrow-" + Math.random().toString(36).slice(2, 8);
const STYLE_ID = "vc-c-styles";
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value as Partial<CSSStyleDeclaration>);
    } else if (key === "checked" || key === "disabled" || key.startsWith("on")) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function snippet(text: string, lines: number): string {
  return text.split("\n").slice(0, lines).join("\n");
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

function statusClass(status: Ticket["status"]): string {
  return status === "done"
    ? "t-status-done"
    : status === "running"
      ? "t-status-running"
      : "t-status-pending";
}

function ticketRow(t: Ticket): HTMLElement {
  return h(
    "div",
    { class: "vc-row" },
    h("span", { class: "vc-chip " + statusClass(t.status) }, t.id),
    h(
      "span",
      {
        class: "vc-dim",
        title: t.blockedBy.length ? "after " + t.blockedBy.join(", ") : "no blockers",
      },
      t.title,
    ),
  );
}

function rawDetails(value: unknown, label = "raw json"): HTMLElement {
  return h(
    "details",
    { class: "vc-raw" },
    h("summary", {}, label),
    h("pre", {}, JSON.stringify(value, null, 2)),
  );
}

/** `append` that tolerates nulls (conditional children). */
function appendAll(parent: HTMLElement, ...kids: (Node | string | null)[]): void {
  for (const kid of kids) {
    if (kid != null) parent.append(kid);
  }
}

/** Which node the last log line points at (for the "active" glow). */
function logNodeId(line: string): string | null {
  if (/^writeSpec/.test(line)) return "writeSpec";
  if (/^schedule\b/.test(line)) return "schedule";
  if (/^deadlock/.test(line)) return "deadlockGate";
  if (/^implementTicket/.test(line)) return "implementTicket";
  if (/^review/.test(line)) return "review";
  if (/approve|approval/.test(line)) return "approveSpec";
  return null;
}

function nodeStateLabel(nodeId: string, thread: ThreadListItem | null): string {
  if (!thread) return "idle";
  if (thread.interrupts.some((i) => NODE_KIND[nodeId] === i.kind)) return "interrupted";
  const log = thread.values?.log ?? [];
  const own = logNodeId(log[log.length - 1] ?? "");
  return own === nodeId ? "active" : "idle";
}

// ---------------------------------------------------------------------------
// Interrupts — structured mini-forms rendered inline in the raising node
// ---------------------------------------------------------------------------

function buildInterruptForm(
  int: InterruptProjection,
  thread: ThreadListItem,
  ctx: ShellContext,
): HTMLElement {
  const box = h("div", { class: "vc-interrupt-box" });
  box.append(h("div", { class: "vc-interrupt-kind" }, "interrupt · " + int.kind));
  const resume = (d: InterruptDecision): void => {
    void ctx.resumeRun(thread.threadId, d);
  };
  const v = int.value;
  switch (v.kind) {
    case "approve-spec": {
      box.append(
        h("div", { class: "vc-dim" }, "spec waiting for your call"),
        h("div", { class: "vc-spec-preview" }, v.spec),
        h(
          "div",
          { class: "vc-btnrow" },
          h(
            "button",
            { class: "vc-btn vc-btn-primary", onclick: () => resume({ action: "approve" }) },
            "Approve",
          ),
          h(
            "button",
            { class: "vc-btn vc-btn-danger", onclick: () => resume({ action: "reject" }) },
            "Reject",
          ),
        ),
      );
      break;
    }
    case "deadlock": {
      box.append(
        h("div", { class: "vc-dim" }, "blocked tickets can't start"),
        h(
          "div",
          { class: "vc-row" },
          ...v.pending.map((id) => h("span", { class: "vc-chip t-status-pending" }, id)),
        ),
        h("div", { class: "vc-dim" }, v.hint),
        h(
          "div",
          { class: "vc-btnrow" },
          h(
            "button",
            { class: "vc-btn vc-btn-primary", onclick: () => resume({ action: "reload" }) },
            "Reload",
          ),
          h(
            "button",
            { class: "vc-btn vc-btn-danger", onclick: () => resume({ action: "abort" }) },
            "Abort",
          ),
        ),
      );
      break;
    }
    case "review": {
      const checks = new Map<string, HTMLInputElement>();
      const rows = v.tickets.map((t) => {
        const cb = h("input", { type: "checkbox", value: t.id });
        checks.set(t.id, cb);
        return h(
          "label",
          { class: "vc-checkrow" },
          cb,
          h("span", { class: "vc-chip " + statusClass(t.status) }, t.id),
          h("span", { class: "vc-dim" }, t.title),
        );
      });
      const retry = h(
        "button",
        {
          class: "vc-btn",
          onclick: () => {
            const ids = [...checks.entries()]
              .filter(([, cb]) => cb.checked)
              .map(([id]) => id);
            resume({ action: "retry", ids });
          },
        },
        "Retry",
      );
      retry.disabled = true;
      for (const [, cb] of checks) {
        cb.addEventListener("change", () => {
          retry.disabled = ![...checks.values()].some((c) => c.checked);
        });
      }
      box.append(
        h("div", { class: "vc-dim" }, "all tickets implemented — your call"),
        ...rows,
        h(
          "div",
          { class: "vc-btnrow" },
          h(
            "button",
            { class: "vc-btn vc-btn-primary", onclick: () => resume({ action: "approve" }) },
            "Approve",
          ),
          retry,
          h("button", { class: "vc-btn", onclick: () => resume({ action: "replan" }) }, "Replan"),
        ),
      );
      break;
    }
  }
  box.append(rawDetails(int.value));
  return box;
}

// ---------------------------------------------------------------------------
// Node cards — what each node holds or did, read from the thread's State
// ---------------------------------------------------------------------------

function buildNodeBody(
  nodeId: string,
  thread: ThreadListItem | null,
  ctx: ShellContext,
): HTMLElement {
  const body = h("div", { class: "vc-node-body" });
  const values = thread?.values ?? null;
  const ownInterrupt = thread?.interrupts.find((i) => NODE_KIND[nodeId] === i.kind) ?? null;

  switch (nodeId) {
    case "START": {
      appendAll(
        body,
        h("div", { class: "vc-dim" }, "run entry"),
        thread
          ? h(
              "div",
              { class: "vc-row" },
              h("span", { class: "vc-chip t-status-pending" }, thread.label),
              h("span", { class: "vc-dim" }, fmtTime(thread.updatedAt)),
            )
          : null,
        values?.packet
          ? h("div", { class: "vc-spec-preview" }, snippet(values.packet, 4))
          : h("div", { class: "vc-dim" }, "no packet"),
      );
      break;
    }
    case "writeSpec": {
      appendAll(
        body,
        h("div", { class: "vc-dim" }, values?.spec ? "spec drafted" : "waiting for a spec"),
        values?.spec ? h("div", { class: "vc-spec-preview" }, snippet(values.spec, 8)) : null,
      );
      break;
    }
    case "approveSpec": {
      if (ownInterrupt) {
        appendAll(
          body,
          h("div", { class: "vc-state vc-state-interrupt" }, "interrupted"),
          thread ? buildInterruptForm(ownInterrupt, thread, ctx) : null,
        );
      } else if (values?.spec) {
        const approved = values.log.some((l) => /approv/i.test(l) && /spec/i.test(l));
        body.append(
          h(
            "div",
            { class: approved ? "t-status-done" : "vc-dim" },
            approved ? "spec approved" : "spec drafted — not yet approved",
          ),
          h("div", { class: "vc-spec-preview" }, snippet(values.spec, 8)),
        );
      } else {
        body.append(h("div", { class: "vc-dim" }, "no spec yet"));
      }
      break;
    }
    case "schedule": {
      const tickets = values?.tickets ?? [];
      if (tickets.length === 0) {
        body.append(h("div", { class: "vc-dim" }, "queue empty"));
        break;
      }
      const done = tickets.filter((t) => t.status === "done").length;
      const pending = tickets.filter((t) => t.status === "pending").length;
      body.append(
        h("div", { class: "vc-dim" }, `ticket queue · ${done} done · ${pending} pending`),
      );
      for (const t of tickets) body.append(ticketRow(t));
      break;
    }
    case "implementTicket": {
      const tickets = values?.tickets ?? [];
      const log = values?.log ?? [];
      const ran = new Set<string>();
      for (const line of log) {
        const m = /^implementTicket\s+(\S+)/.exec(line);
        if (m) ran.add(m[1]);
      }
      const inFlight = tickets.filter((t) => ran.has(t.id) || t.status === "running");
      const rest = tickets.filter((t) => !ran.has(t.id) && t.status !== "running");
      if (inFlight.length === 0) {
        body.append(h("div", { class: "vc-dim" }, "fan-out idle — nothing in flight"));
        break;
      }
      body.append(
        h("div", { class: "vc-dim" }, `in flight · ${inFlight.length} ticket${inFlight.length === 1 ? "" : "s"}`),
      );
      for (const t of inFlight) body.append(ticketRow(t));
      if (rest.length) body.append(h("div", { class: "vc-dim" }, `${rest.length} still queued`));
      break;
    }
    case "deadlockGate": {
      if (ownInterrupt) {
        appendAll(
          body,
          h("div", { class: "vc-state vc-state-interrupt" }, "interrupted"),
          thread ? buildInterruptForm(ownInterrupt, thread, ctx) : null,
        );
      } else {
        body.append(h("div", { class: "vc-dim" }, "no deadlock — schedule clear"));
      }
      break;
    }
    case "review": {
      if (ownInterrupt) {
        appendAll(
          body,
          h("div", { class: "vc-state vc-state-interrupt" }, "interrupted"),
          thread ? buildInterruptForm(ownInterrupt, thread, ctx) : null,
        );
      } else {
        const done = values?.tickets.filter((t) => t.status === "done").length ?? 0;
        body.append(h("div", { class: "vc-dim" }, `review gate · ${done} done`));
      }
      break;
    }
    case "END": {
      const log = values?.log ?? [];
      if (log.length === 0) body.append(h("div", { class: "vc-dim" }, "run not finished"));
      else {
        body.append(
          h("div", { class: "t-status-done" }, "run complete"),
          h("div", { class: "vc-spec-preview" }, log.slice(-4).join("\n")),
        );
      }
      break;
    }
    default:
      body.append(h("div", { class: "vc-dim" }, "node — no state mapped"));
  }
  return body;
}

// ---------------------------------------------------------------------------
// Styles (component-scoped, injected once)
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.vc-root {
  position: relative;
  display: flex;
  flex-direction: row;
  height: calc(100vh - 120px);
  min-height: 480px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.vc-rail {
  width: 264px;
  flex: 0 0 264px;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.vc-rail-scroll { overflow-y: auto; flex: 1; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.vc-rail h2 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); }
.vc-section-head { display: flex; justify-content: space-between; align-items: center; }
.vc-thread-list { display: flex; flex-direction: column; gap: 4px; max-height: 38vh; overflow-y: auto; }
.vc-thread-item { padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-panel-2); cursor: pointer; }
.vc-thread-item:hover { border-color: var(--accent); }
.vc-thread-item.vc-active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.vc-thread-label { color: var(--text); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vc-thread-meta { font-size: 11px; color: var(--text-dim); display: flex; justify-content: space-between; align-items: center; margin-top: 2px; }
.vc-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-left: 4px; }
.vc-dot-interrupt { background: var(--interrupt); }
.vc-run-form { display: flex; flex-direction: column; gap: 6px; }
.vc-run-form input, .vc-run-form select, .vc-run-form textarea {
  width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 4px; padding: 5px 7px; font-family: var(--mono); font-size: 12px;
}
.vc-btn {
  background: var(--bg-panel-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 4px; padding: 5px 10px; cursor: pointer; font-family: var(--mono); font-size: 12px;
}
.vc-btn:hover { border-color: var(--accent); color: var(--accent); }
.vc-btn-primary { background: var(--accent); color: #0b0e14; border-color: var(--accent); font-weight: 700; }
.vc-btn-primary:hover { color: #0b0e14; }
.vc-btn-danger { border-color: var(--interrupt); color: var(--interrupt); }
.vc-btn:disabled { opacity: 0.4; cursor: default; }

.vc-graph-area { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.vc-graph-header {
  display: flex; align-items: center; gap: 12px; flex-shrink: 0;
  padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg); z-index: 5;
}
.vc-graph-title { font-size: 13px; font-weight: 700; }
.vc-graph-sub { color: var(--text-dim); font-size: 11px; }
.vc-zoom { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.vc-zoom .vc-btn { padding: 2px 8px; }
.vc-edge-toggle {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
  border: 1px solid var(--border); border-radius: 4px; cursor: pointer;
  font-size: 11px; color: var(--text-dim); white-space: nowrap;
}
.vc-edge-toggle:hover { border-color: var(--accent); color: var(--accent); }
.vc-edge-toggle input { margin: 0; accent-color: var(--accent); }
.vc-graph-viewport {
  position: relative; flex: 1; overflow: hidden; background: var(--bg);
  cursor: grab; touch-action: none; user-select: none;
}
.vc-graph-viewport.vc-panning { cursor: grabbing; }
.vc-graph-container {
  position: absolute; top: 0; left: 0; width: 960px; height: 1420px;
  transform-origin: 0 0; will-change: transform;
}
.vc-node {
  position: absolute; width: 280px; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 6px; cursor: grab; transition: border-color 0.15s, box-shadow 0.15s;
}
.vc-node.vc-node-dragging { cursor: grabbing; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5); }
.vc-node:hover { border-color: var(--accent); }
.vc-node-interrupted { border-color: var(--interrupt); animation: vc-pulse 1.6s ease-in-out infinite; }
.vc-node-head {
  display: flex; justify-content: space-between; align-items: center; gap: 6px;
  padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--bg-panel-2);
  border-radius: 5px 5px 0 0;
}
.vc-node-id { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.vc-node-state { font-size: 10px; color: var(--text-dim); }
.vc-state-live { color: var(--accent); }
.vc-state-interrupt { color: var(--interrupt); font-weight: 700; }
.vc-node-body { padding: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }

.vc-chip { display: inline-block; padding: 1px 6px; border-radius: 3px; border: 1px solid currentColor; font-size: 11px; line-height: 1.5; }
.vc-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.vc-row .vc-dim { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-dim { color: var(--text-dim); font-size: 11px; }
.vc-spec-preview {
  max-height: 120px; overflow: auto; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; padding: 6px; white-space: pre-wrap; font-size: 11px; color: var(--text-dim);
}
.vc-interrupt-box { border: 1px solid var(--interrupt); background: rgba(248, 81, 73, 0.08); border-radius: 4px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.vc-interrupt-kind { color: var(--interrupt); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.vc-btnrow { display: flex; gap: 6px; flex-wrap: wrap; }
.vc-checkrow { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.vc-checkrow input { accent-color: var(--interrupt); }
details.vc-raw summary { cursor: pointer; color: var(--text-dim); font-size: 11px; }
details.vc-raw pre {
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px;
  font-size: 10px; overflow: auto; color: var(--text-dim); max-height: 160px; white-space: pre-wrap;
}

.vc-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.vc-edge { stroke: var(--border); stroke-width: 1.4; fill: none; transition: stroke 0.15s; }
.vc-edge-hot { stroke: var(--accent); stroke-width: 1.8; }
.vc-edge-label { fill: var(--text-dim); font-family: var(--mono); font-size: 10px; }
.vc-edge-label-hot { fill: var(--accent); }

.vc-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 340px; background: var(--bg-panel);
  border-left: 1px solid var(--border); transform: translateX(102%); transition: transform 0.18s ease;
  overflow-y: auto; z-index: 30; display: flex; flex-direction: column; gap: 10px; padding: 12px;
}
.vc-drawer-open { transform: translateX(0); }
.vc-drawer-head { display: flex; justify-content: space-between; align-items: center; }
.vc-drawer-title { font-weight: 700; font-size: 13px; }
.vc-log-drawer {
  position: absolute; left: 0; right: 0; bottom: 0; height: 40vh; background: var(--bg-panel);
  border-top: 1px solid var(--border); transform: translateY(102%); transition: transform 0.18s ease;
  z-index: 40; display: flex; flex-direction: column; gap: 8px; padding: 10px;
}
.vc-log-open { transform: translateY(0); }
.vc-log-head { display: flex; justify-content: space-between; align-items: center; }
.vc-log-lines {
  flex: 1; overflow: auto; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; padding: 8px; font-size: 12px; white-space: pre-wrap;
}

@keyframes vc-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.55); }
  50% { box-shadow: 0 0 0 10px rgba(248, 81, 73, 0); }
}
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VariantC(root: HTMLElement, ctx: ShellContext): void {
  injectStyles();

  const state = {
    activeThreadId: ctx.selectedThreadId,
    showAll: false,
    pinnedNode: null as string | null,
    drawerOpen: false,
    logOpen: false,
    edgeMode: "ortho" as "straight" | "ortho",
  };

  // ---- canvas interaction state (survives re-renders: thread switches etc.) ----
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 2.5;
  const DRAG_THRESHOLD = 4;
  const nodePos = new Map<string, { x: number; y: number }>();
  const view = { x: 0, y: 0, zoom: 1, seeded: false };
  let highlightedNode: string | null = null;

  const shell = h("div", { class: "vc-root" });
  const rail = h("div", { class: "vc-rail" });
  const railBody = h("div", { class: "vc-rail-scroll" });
  const graphArea = h("div", { class: "vc-graph-area" });
  const drawer = h("aside", { class: "vc-drawer" });
  const logDrawer = h("div", { class: "vc-log-drawer" });
  rail.appendChild(railBody);
  shell.append(rail, graphArea, drawer, logDrawer);
  root.appendChild(shell);

  const findThread = (id: string | null): ThreadListItem | null =>
    ctx.allThreads.find((t) => t.threadId === id) ?? null;
  const activeThread = (): ThreadListItem | null => findThread(state.activeThreadId);

  function toggleLog(): void {
    state.logOpen = !state.logOpen;
    renderLog();
  }

  function refresh(): void {
    renderGraph();
    renderDrawer();
    renderLog();
  }

  // ---- left rail: thread picker + start run ----

  function renderRail(): void {
    railBody.replaceChildren();
    const list = state.showAll ? ctx.allThreads : ctx.threads;

    if (ctx.mock) railBody.append(h("span", { class: "mock-badge" }, "MOCK DATA"));

    const showAllToggle = h(
      "label",
      { class: "vc-checkrow vc-dim" },
      h("input", {
        type: "checkbox",
        checked: state.showAll,
        onclick: () => {
          state.showAll = !state.showAll;
          if (!state.showAll && !ctx.threads.some((t) => t.threadId === state.activeThreadId)) {
            state.activeThreadId = ctx.selectedThreadId;
          }
          renderRail();
          refresh();
        },
      }),
      "show all",
    );

    railBody.append(
      h("div", { class: "vc-section-head" }, h("h2", {}, "Threads"), showAllToggle),
    );

    if (list.length === 0) railBody.append(h("div", { class: "vc-dim" }, "no threads"));
    const listEl = h("div", { class: "vc-thread-list" });
    for (const t of list) {
      const item = h(
        "div",
        {
          class: "vc-thread-item" + (t.threadId === state.activeThreadId ? " vc-active" : ""),
          onclick: () => {
            state.activeThreadId = t.threadId;
            state.drawerOpen = false;
            state.pinnedNode = null;
            refresh();
          },
        },
        h("div", { class: "vc-thread-label" }, t.label),
      );
      const metaRight = h("span", {}, t.status);
      if (t.interrupts.length > 0) {
        metaRight.append(
          h("span", {
            class: "vc-dot vc-dot-interrupt",
            title: `${t.interrupts.length} pending interrupt${t.interrupts.length === 1 ? "" : "s"}`,
          }),
        );
      }
      item.append(
        h("div", { class: "vc-thread-meta" }, h("span", {}, t.origin), metaRight),
      );
      listEl.appendChild(item);
    }
    railBody.append(listEl);

    // ---- Start run ----
    const topic = h("input", { type: "text", placeholder: "topic" }) as HTMLInputElement;
    const pool = h("select", {}) as HTMLSelectElement;
    for (const p of TICKET_POOLS) pool.append(h("option", { value: p }, p));
    pool.value = TICKET_POOLS[0] ?? "tickets";
    const packet = h("textarea", { rows: 3, placeholder: "packet (optional)" }) as HTMLTextAreaElement;
    const twisty = h("details", {}, h("summary", { class: "vc-dim" }, "packet"), packet);
    const start = h(
      "button",
      {
        class: "vc-btn vc-btn-primary",
        onclick: () => {
          const target = activeThread();
          void ctx.streamRun(target ? target.threadId : "ui-run", {
            topic: topic.value.trim() || "untitled",
            ticketDir: pool.value,
            packet: packet.value.trim() || undefined,
          });
        },
      },
      "Start",
    );

    railBody.append(
      h("div", { class: "vc-section-head" }, h("h2", {}, "Start run")),
      h("div", { class: "vc-run-form" }, topic, h("div", { class: "vc-dim" }, "ticket pool"), pool, twisty, start),
    );
  }

  // ---- graph hero ----

  function renderGraph(): void {
    const thread = activeThread();
    graphArea.replaceChildren();

    const edgeToggleInput = h("input", { type: "checkbox" }) as HTMLInputElement;

    const header = h(
      "div",
      { class: "vc-graph-header" },
      h("span", { class: "vc-graph-title" }, name),
      h(
        "span",
        { class: "vc-graph-sub" },
        thread ? `thread · ${thread.label} · ${thread.status}` : "no thread selected",
      ),
      h("button", { class: "vc-btn", onclick: () => toggleLog() }, state.logOpen ? "hide log" : "run log"),
      h("button", {
        class: "vc-btn",
        onclick: () => {
          state.drawerOpen = false;
          state.pinnedNode = null;
          renderDrawer();
        },
      }, "close detail"),
      h(
        "div",
        { class: "vc-zoom" },
        h(
          "label",
          { class: "vc-edge-toggle", title: "edge routing" },
          edgeToggleInput,
          "right angles",
        ),
        h("button", { class: "vc-btn", title: "zoom out", onclick: () => zoomBy(1 / 1.25) }, "−"),
        h("button", { class: "vc-btn", title: "zoom in", onclick: () => zoomBy(1.25) }, "+"),
        h("button", { class: "vc-btn", title: "reset pan & zoom", onclick: () => resetView() }, "reset"),
      ),
    );

    // Only the canvas (viewport + transformed container) pans/zooms — the
    // header, left rail and drawers all stay fixed.
    const viewport = h("div", { class: "vc-graph-viewport" });
    const container = h("div", { class: "vc-graph-container" });

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "vc-edges");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    const defs = document.createElementNS(SVG_NS, "defs");
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", ARROW_ID);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrowPath = document.createElementNS(SVG_NS, "path");
    arrowPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrowPath.setAttribute("fill", "#232a3b");
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);
    container.appendChild(svg);

    const nodesById = new Map<string, HTMLElement>();
    const unknownLayout = new Map<string, number>();

    const layoutFor = (id: string): { x: number; y: number } => {
      const known = LAYOUT[id];
      if (known) return known;
      const idx = unknownLayout.get(id) ?? 0;
      unknownLayout.set(id, idx + 1);
      return { x: 640, y: 16 + idx * 160 };
    };

    for (const node of ctx.topology.nodes) {
      // Seed positions once from the static layout; keep user-moved positions.
      if (!nodePos.has(node.id)) nodePos.set(node.id, layoutFor(node.id));
      const pos = nodePos.get(node.id) ?? layoutFor(node.id);
      const interrupted = thread?.interrupts.some((i) => NODE_KIND[node.id] === i.kind) ?? false;
      const label = nodeStateLabel(node.id, thread);
      const card = h("div", {
        class: "vc-node" + (interrupted ? " vc-node-interrupted" : ""),
        style: { left: `${pos.x}px`, top: `${pos.y}px`, width: "280px" },
        "data-node-id": node.id,
      });
      card.append(
        h(
          "div",
          { class: "vc-node-head" },
          h("span", { class: "vc-node-id" }, node.name ?? node.id),
          h(
            "span",
            {
              class:
                "vc-node-state " +
                (interrupted
                  ? "vc-state-interrupt"
                  : label === "active"
                    ? "vc-state-live"
                    : ""),
            },
            label,
          ),
        ),
        buildNodeBody(node.id, thread, ctx),
      );
      card.addEventListener("mouseenter", () => {
        state.drawerOpen = true;
        state.pinnedNode = node.id;
        renderDrawer();
        highlightEdges(node.id);
      });
      nodesById.set(node.id, card);
      container.appendChild(card);
    }

    viewport.appendChild(container);
    graphArea.append(header, viewport);

    // Seed the initial view once (horizontally centered), keep later pan/zoom.
    if (!view.seeded && viewport.clientWidth > 0) {
      view.seeded = true;
      view.x = Math.max(8, (viewport.clientWidth - 960) / 2);
      view.y = 8;
    }
    container.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;

    // ---- SVG edges: computed from node positions + live card geometry ----
    const edgeEls: {
      el: SVGPathElement;
      label: SVGTextElement | null;
      source: string;
      target: string;
    }[] = [];

    const nodeCenter = (id: string): { x: number; y: number } | null => {
      const pos = nodePos.get(id);
      const card = nodesById.get(id);
      if (!pos || !card) return null;
      // offset* are layout-space (unaffected by the container transform).
      return { x: pos.x + card.offsetWidth / 2, y: pos.y + card.offsetHeight / 2 };
    };

    const edgeGeom = (
      source: string,
      target: string,
    ): { d: string; up: boolean; lx: number; ly: number } | null => {
      const s = nodeCenter(source);
      const t = nodeCenter(target);
      if (!s || !t) return null;
      const up = t.y < s.y;
      if (state.edgeMode === "ortho") {
        // Right-angle routing: leave the source card on its vertical
        // centerline (bottom edge for downward edges, top edge for upward
        // ones), one horizontal elbow, then enter the target card on the
        // facing edge. Pure H/V segments — recomputed live as cards drag.
        const sCard = nodesById.get(source);
        const tCard = nodesById.get(target);
        const sh = sCard?.offsetHeight ?? 0;
        const th = tCard?.offsetHeight ?? 0;
        const outY = up ? s.y - sh / 2 : s.y + sh / 2;
        const inY = up ? t.y + th / 2 : t.y - th / 2;
        const midY = (outY + inY) / 2;
        const d = `M ${s.x} ${outY} L ${s.x} ${midY} L ${t.x} ${midY} L ${t.x} ${inY}`;
        return { d, up, lx: s.x + 6, ly: midY };
      }
      const bow = 120;
      const d = up
        ? `M ${s.x} ${s.y} C ${s.x + bow} ${s.y}, ${t.x + bow} ${t.y}, ${t.x} ${t.y}`
        : `M ${s.x} ${s.y} C ${s.x} ${s.y + 40}, ${t.x} ${t.y - 40}, ${t.x} ${t.y}`;
      return { d, up, lx: up ? s.x + bow + 6 : s.x + 6, ly: (s.y + t.y) / 2 };
    };

    const drawEdges = (): void => {
      for (const edge of ctx.topology.edges) {
        const g = edgeGeom(edge.source, edge.target);
        if (!g) continue;
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", g.d);
        path.setAttribute("class", "vc-edge");
        path.setAttribute("marker-end", `url(#${ARROW_ID})`);
        svg.appendChild(path);

        let label: SVGTextElement | null = null;
        const labelText = edgeLabel(edge);
        if (labelText) {
          label = document.createElementNS(SVG_NS, "text");
          label.setAttribute("class", "vc-edge-label");
          label.setAttribute("x", String(g.lx));
          label.setAttribute("y", String(g.ly));
          label.textContent = labelText;
          svg.appendChild(label);
        }
        edgeEls.push({ el: path, label, source: edge.source, target: edge.target });
      }
    };

    const updateEdges = (): void => {
      for (const e of edgeEls) {
        const g = edgeGeom(e.source, e.target);
        if (!g) continue;
        e.el.setAttribute("d", g.d);
        e.label?.setAttribute("x", String(g.lx));
        e.label?.setAttribute("y", String(g.ly));
      }
    };

    const highlightEdges = (nodeId: string): void => {
      highlightedNode = nodeId;
      for (const e of edgeEls) {
        const hot = e.source === nodeId || e.target === nodeId;
        e.el.setAttribute("class", hot ? "vc-edge vc-edge-hot" : "vc-edge");
        e.label?.setAttribute(
          "class",
          hot ? "vc-edge-label vc-edge-label-hot" : "vc-edge-label",
        );
      }
    };

    // ---- pan / zoom / node-drag wiring ----
    const applyTransform = (): void => {
      container.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    };

    const zoomAt = (clientX: number, clientY: number, factor: number): void => {
      const rect = viewport.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
      if (next === view.zoom) return;
      // Keep the world point under the cursor stationary.
      const wx = (mx - view.x) / view.zoom;
      const wy = (my - view.y) / view.zoom;
      view.zoom = next;
      view.x = mx - wx * next;
      view.y = my - wy * next;
      applyTransform();
    };

    const zoomBy = (factor: number): void => {
      const rect = viewport.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    };

    const resetView = (): void => {
      view.zoom = 1;
      const rect = viewport.getBoundingClientRect();
      view.x = Math.max(8, (rect.width - 960) / 2);
      view.y = 8;
      view.seeded = true;
      applyTransform();
    };

    let activeDrag: {
      kind: "node" | "pan" | "click";
      nodeId?: string;
      startX: number;
      startY: number;
      startNode?: { x: number; y: number };
      startView?: { x: number; y: number };
      moved: boolean;
    } | null = null;

    viewport.addEventListener("pointerdown", (e) => {
      if (activeDrag) return;
      const target = e.target instanceof Element ? e.target : null;
      const card = target?.closest(".vc-node") ?? null;
      const interactive =
        target?.closest("button, input, select, textarea, a, summary, label") ?? null;
      if (card && !interactive) {
        const id = (card as HTMLElement).dataset.nodeId ?? "";
        activeDrag = {
          kind: "node",
          nodeId: id,
          startX: e.clientX,
          startY: e.clientY,
          startNode: { ...(nodePos.get(id) ?? { x: 0, y: 0 }) },
          moved: false,
        };
      } else if (!card) {
        activeDrag = {
          kind: "pan",
          startX: e.clientX,
          startY: e.clientY,
          startView: { x: view.x, y: view.y },
          moved: false,
        };
      } else {
        // Interactive element inside a node (button/checkbox/summary): no drag,
        // but a plain click still opens the detail drawer.
        activeDrag = {
          kind: "click",
          nodeId: (card as HTMLElement).dataset.nodeId ?? "",
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
      }
    });

    viewport.addEventListener("pointermove", (e) => {
      if (!activeDrag) return;
      const dx = e.clientX - activeDrag.startX;
      const dy = e.clientY - activeDrag.startY;
      if (!activeDrag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        activeDrag.moved = true;
        if (activeDrag.kind !== "click") {
          try {
            viewport.setPointerCapture(e.pointerId);
          } catch {
            // pointer already gone — ignore
          }
        }
      }
      if (!activeDrag.moved) return;
      if (activeDrag.kind === "node" && activeDrag.nodeId && activeDrag.startNode) {
        // Convert pointer deltas into container space (divide by zoom).
        const id = activeDrag.nodeId;
        const nx = activeDrag.startNode.x + dx / view.zoom;
        const ny = activeDrag.startNode.y + dy / view.zoom;
        nodePos.set(id, { x: nx, y: ny });
        const card = nodesById.get(id);
        if (card) {
          card.style.left = `${nx}px`;
          card.style.top = `${ny}px`;
          card.classList.add("vc-node-dragging");
        }
        updateEdges();
      } else if (activeDrag.kind === "pan" && activeDrag.startView) {
        view.x = activeDrag.startView.x + dx;
        view.y = activeDrag.startView.y + dy;
        viewport.classList.add("vc-panning");
        applyTransform();
      }
    });

    const endDrag = (e: PointerEvent): void => {
      if (!activeDrag) return;
      if (activeDrag.moved) {
        try {
          viewport.releasePointerCapture(e.pointerId);
        } catch {
          // never captured — ignore
        }
      } else if (
        (activeDrag.kind === "node" || activeDrag.kind === "click") &&
        activeDrag.nodeId
      ) {
        // Plain click (no drag): open the detail drawer.
        state.drawerOpen = true;
        state.pinnedNode = activeDrag.nodeId;
        renderDrawer();
      }
      for (const card of nodesById.values()) card.classList.remove("vc-node-dragging");
      viewport.classList.remove("vc-panning");
      activeDrag = null;
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    viewport.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );

    edgeToggleInput.checked = state.edgeMode === "ortho";
    edgeToggleInput.addEventListener("change", () => {
      state.edgeMode = edgeToggleInput.checked ? "ortho" : "straight";
      updateEdges();
    });

    drawEdges();
    if (highlightedNode) highlightEdges(highlightedNode);
  }

  function edgeLabel(edge: { source: string; target: string; data?: string }): string | null {
    if (typeof edge.data === "string" && edge.data.length > 0) return edge.data;
    return EDGE_LABELS[`${edge.source}>${edge.target}`] ?? null;
  }

  // ---- side drawer: node detail + raw state ----

  function renderDrawer(): void {
    drawer.replaceChildren();
    if (!state.drawerOpen || !state.pinnedNode) {
      // Close paths (X button, "close detail", thread switch) all funnel
      // through here — drop the open class or the panel stays visible empty.
      drawer.classList.remove("vc-drawer-open");
      return;
    }
    const thread = activeThread();
    const node = ctx.topology.nodes.find((n) => n.id === state.pinnedNode) ?? null;
    if (!node) {
      drawer.classList.remove("vc-drawer-open");
      return;
    }
    drawer.classList.add("vc-drawer-open");
    drawer.append(
      h(
        "div",
        { class: "vc-drawer-head" },
        h("span", { class: "vc-drawer-title" }, node.name ?? node.id),
        h("button", {
          class: "vc-btn",
          onclick: () => {
            state.drawerOpen = false;
            state.pinnedNode = null;
            renderDrawer();
          },
        }, "✕"),
      ),
      buildNodeBody(node.id, thread, ctx),
      h("div", { class: "vc-section-head" }, h("h2", {}, "State")),
      rawDetails(thread?.values ?? null, "raw thread values"),
      rawDetails(thread?.interrupts ?? [], "raw interrupts"),
    );
  }

  // ---- bottom drawer: the run log slides up ----

  function renderLog(): void {
    logDrawer.replaceChildren();
    logDrawer.classList.toggle("vc-log-open", state.logOpen);
    const thread = activeThread();
    const lines = thread?.values?.log ?? [];
    logDrawer.append(
      h(
        "div",
        { class: "vc-log-head" },
        h("span", { class: "vc-graph-title" }, "Run log"),
        h("button", { class: "vc-btn", onclick: () => toggleLog() }, "close"),
      ),
      h("div", { class: "vc-log-lines" }, lines.length > 0 ? lines.join("\n") : "— no log lines yet —"),
    );
  }

  renderRail();
  refresh();
}


