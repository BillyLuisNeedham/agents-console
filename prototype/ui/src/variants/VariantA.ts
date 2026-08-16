/**
 * Variant A — "Always-On Dashboard".
 *
 * The layout question this variant answers: single always-visible dashboard,
 * interrupt as an EXPANDABLE BANNER. No tabs, no routing — one dense screen:
 *
 *   - Left rail: thread picker (UI-created threads by default, "show all"
 *     toggle) + "Start run" (topic, ticket pool, collapsible packet).
 *   - Center: pinned interrupt banner zone on top; then live state — tickets
 *     with status colors, scrolling log, spec/packet viewer.
 *   - Right: layered SVG topology (running + next nodes highlighted) + raw
 *     thread values in a collapsible <details>.
 *
 * Buttons call ctx.resumeRun where sensible; wiring is deliberately shallow
 * (this is a layout spike — the shell does not re-render after a stream).
 */

import type {
  InterruptDecision,
  InterruptProjection,
  ShellContext,
  ThreadListItem,
  ThreadValues,
  Ticket,
  TicketStatus,
  Topology,
} from "../data";
import { TICKET_POOLS } from "../data";

export const name = "Always-On Dashboard";

/* ------------------------------------------------------------------ *
 * Scoped styles (inline — this variant owns its own look).            *
 * ------------------------------------------------------------------ */

const STYLE = `
.va-shell{display:flex;flex-direction:column;gap:8px;height:calc(100vh - 116px);min-width:0;}
.va-header{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-panel);border:1px solid var(--border);border-radius:6px;flex:none;}
.va-title{font-size:14px;font-weight:700;letter-spacing:0.02em;white-space:nowrap;}
.va-sub{color:var(--text-dim);font-size:11px;white-space:nowrap;}
.va-flash{margin-left:auto;font-size:11px;color:var(--accent);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.va-main{display:grid;grid-template-columns:280px minmax(0,1fr) 320px;gap:8px;flex:1;min-height:0;}
.va-left,.va-right{display:flex;flex-direction:column;gap:8px;min-height:0;min-width:0;}
.va-pane{background:var(--bg-panel);border:1px solid var(--border);border-radius:6px;display:flex;flex-direction:column;min-height:0;min-width:0;}
.va-left .va-pane:first-child{flex:1.6;}
.va-left .va-pane:last-child{flex:1;}
.va-right .va-pane{flex:1;}
.va-pane-head{flex:none;padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;}
.va-pane-head .va-spacer{margin-left:auto;}
.va-pane-body{flex:1;min-height:0;padding:8px;overflow:auto;}
.va-empty{padding:12px;color:var(--text-dim);font-size:12px;}

/* thread picker */
.va-thread{border:1px solid transparent;border-radius:4px;padding:6px 8px;cursor:pointer;display:flex;flex-direction:column;gap:3px;}
.va-thread:hover{background:var(--bg-panel-2);}
.va-thread.sel{border-color:var(--accent);background:var(--bg-panel-2);}
.va-thread-row1{display:flex;align-items:center;gap:6px;min-width:0;}
.va-thread-label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.va-tag{flex:none;font-size:10px;padding:0 5px;border:1px solid var(--border);border-radius:3px;color:var(--text-dim);}
.va-thread-row2{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-dim);}
.va-thread-status{font-size:11px;text-transform:capitalize;}
.va-dot{flex:none;width:8px;height:8px;border-radius:50%;}
.va-thread-int{margin-left:auto;color:var(--interrupt);font-size:11px;font-weight:700;}
.va-toggle{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;text-transform:none;letter-spacing:0;font-size:11px;}
.va-toggle input{accent-color:var(--accent);margin:0;}

/* start run */
.va-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;}
.va-field label{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);}
.va-input{width:100%;background:var(--bg-panel-2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:5px 7px;border-radius:4px;}
.va-input:focus{outline:none;border-color:var(--accent);}
.va-details summary{cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);user-select:none;}
.va-details .va-input{margin-top:5px;}
.va-btn{border:1px solid var(--border);background:var(--bg-panel-2);color:var(--text);font-family:var(--mono);font-size:12px;padding:5px 10px;border-radius:4px;cursor:pointer;}
.va-btn:hover{border-color:var(--accent);}
.va-btn:disabled{opacity:.4;cursor:default;border-color:var(--border);}
.va-btn-primary{border-color:var(--accent);color:var(--accent);}
.va-btn-primary:hover{background:rgba(76,194,255,.12);}
.va-btn-approve{border-color:var(--status-done);color:var(--status-done);}
.va-btn-approve:hover{background:rgba(63,185,80,.12);}
.va-btn-reject{border-color:var(--interrupt);color:var(--interrupt);}
.va-btn-reject:hover{background:rgba(248,81,73,.12);}
.va-start{width:100%;margin-top:2px;}
.va-note{font-size:11px;color:var(--text-dim);margin-top:6px;line-height:1.4;}

/* interrupt banner */
.va-banner-zone{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 8px 0;}
.va-banner{border:1px solid rgba(248,81,73,.5);background:rgba(248,81,73,.06);border-radius:6px;}
.va-banner-row{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;user-select:none;}
.va-banner-row .va-banner-icon{flex:none;color:var(--interrupt);}
.va-banner-row .va-banner-wait{color:var(--text);font-weight:600;}
.va-banner-row .va-banner-kind{color:var(--interrupt);font-weight:700;white-space:nowrap;}
.va-banner-row .va-banner-thread{margin-left:auto;color:var(--text-dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.va-banner-chev{flex:none;color:var(--text-dim);font-size:11px;font-weight:700;}
.va-banner-body{display:none;flex-direction:column;gap:8px;padding:4px 10px 10px;border-top:1px solid rgba(248,81,73,.25);}
.va-banner.open .va-banner-body{display:flex;}
.va-banner-meta{font-size:11px;color:var(--text-dim);}
.va-banner-pre{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;margin:0;font-family:var(--mono);font-size:12px;color:var(--text);max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.va-banner-actions{display:flex;gap:8px;flex-wrap:wrap;}
.va-check{display:flex;gap:6px;align-items:center;font-size:12px;padding:3px 0;color:var(--text);}
.va-check input{accent-color:var(--accent);margin:0;}
.va-raw summary{cursor:pointer;font-size:11px;color:var(--text-dim);user-select:none;}
.va-raw pre{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;margin:6px 0 0;font-family:var(--mono);font-size:11px;color:var(--text);max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;}

/* center live state */
.va-section{margin-bottom:12px;}
.va-section-head{display:flex;align-items:center;gap:8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-dim);margin-bottom:6px;}
.va-section-head .va-count{margin-left:auto;font-size:10px;}
.va-tickets{display:flex;flex-direction:column;gap:2px;}
.va-ticket{display:flex;align-items:baseline;gap:8px;padding:3px 6px;border-radius:4px;min-width:0;}
.va-ticket:hover{background:var(--bg-panel-2);}
.va-ticket-id{flex:none;font-weight:700;min-width:34px;font-size:12px;}
.va-ticket-title{flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.va-ticket-blk{flex:none;font-size:11px;color:var(--text-dim);}
.va-ticket-status{flex:none;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;min-width:56px;text-align:right;}
.va-log{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;margin:0;font-family:var(--mono);font-size:12px;color:var(--text);height:170px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.va-log-empty{color:var(--text-dim);}
.va-seg{display:flex;gap:4px;margin-bottom:6px;}
.va-seg button{border:1px solid var(--border);background:transparent;color:var(--text-dim);font-family:var(--mono);font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;}
.va-seg button.on{border-color:var(--accent);color:var(--accent);background:rgba(76,194,255,.1);}
.va-doc{background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:8px;margin:0;font-family:var(--mono);font-size:12px;color:var(--text);max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;}
.va-doc-empty{color:var(--text-dim);}

/* topology */
.va-topo-wrap{flex:1;min-height:0;overflow:auto;padding:8px;}
.va-legend{display:flex;gap:14px;font-size:11px;color:var(--text-dim);margin-bottom:8px;flex-wrap:wrap;}
.va-legend span{display:inline-flex;align-items:center;gap:5px;}
.va-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;}
`;

/* ------------------------------------------------------------------ *
 * Small DOM helpers                                                    *
 * ------------------------------------------------------------------ */

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svgEl(tag: string): SVGElement {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--status-pending)",
  running: "var(--status-running)",
  done: "var(--status-done)",
  interrupted: "var(--interrupt)",
  idle: "var(--status-pending)",
};

function ticketStatusClass(s: TicketStatus): string {
  return `t-status-${s}`;
}

function threadStatusClass(status: string): string {
  if (status === "interrupted") return "t-interrupt";
  if (status === "running") return "t-status-running";
  if (status === "done") return "t-status-done";
  return "t-status-pending";
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function countByStatus(tickets: Ticket[]): { pending: number; running: number; done: number } {
  const out = { pending: 0, running: 0, done: 0 };
  for (const t of tickets) out[t.status] += 1;
  return out;
}

/* ------------------------------------------------------------------ *
 * Layered topology layout (shortest-path layers, no pan/zoom)          *
 * ------------------------------------------------------------------ */

function computeLayers(topo: Topology): Map<string, number> {
  const dist = new Map<string, number>();
  for (const n of topo.nodes) dist.set(n.id, Number.POSITIVE_INFINITY);
  const hasIn = new Set(topo.edges.map((e) => e.target));
  const roots = topo.nodes.filter((n) => !hasIn.has(n.id)).map((n) => n.id);
  const queue: string[] = roots.length > 0 ? roots : topo.nodes.map((n) => n.id);
  for (const r of queue) dist.set(r, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const d = dist.get(id) ?? Number.POSITIVE_INFINITY;
    if (d === Number.POSITIVE_INFINITY) continue;
    for (const e of topo.edges) {
      if (e.source !== id) continue;
      const td = dist.get(e.target) ?? Number.POSITIVE_INFINITY;
      if (d + 1 < td) {
        dist.set(e.target, d + 1);
        queue.push(e.target);
      }
    }
  }
  let max = 0;
  for (const v of dist.values()) {
    if (v < Number.POSITIVE_INFINITY && v > max) max = v;
  }
  for (const n of topo.nodes) {
    if (dist.get(n.id) === Number.POSITIVE_INFINITY) dist.set(n.id, max + 1);
  }
  return dist;
}

/* ------------------------------------------------------------------ *
 * Variant A                                                            *
 * ------------------------------------------------------------------ */

export function VariantA(root: HTMLElement, ctx: ShellContext): void {
  const state: {
    showAll: boolean;
    selectedId: string | null;
    thread: ThreadListItem | null;
    values: ThreadValues | null;
    interrupts: InterruptProjection[];
    expanded: number; // index into interrupts; -1 = all collapsed
    docView: "spec" | "packet";
  } = {
    showAll: false,
    selectedId: null,
    thread: null,
    values: null,
    interrupts: [],
    expanded: -1,
    docView: "spec",
  };

  const styleEl = h("style");
  styleEl.textContent = STYLE;
  root.appendChild(styleEl);

  const shell = h("div", "va-shell");
  root.appendChild(shell);

  /* --------------------------- header --------------------------- */

  const flashEl = h("span", "va-flash");
  const header = h("div", "va-header");
  header.append(
    h("span", "va-title", "Always-On Dashboard"),
    h("span", "va-sub", "Console — single-screen live state"),
  );
  if (ctx.mock) {
    const badge = h("span", "mock-badge", "MOCK DATA");
    header.appendChild(badge);
  }
  const metaEl = h("span", "va-sub");
  header.append(metaEl, flashEl);
  shell.appendChild(header);

  let flashTimer: number | undefined;
  function flash(msg: string): void {
    flashEl.textContent = msg;
    if (flashTimer !== undefined) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      flashEl.textContent = "";
    }, 4000);
  }

  /* --------------------------- layout --------------------------- */

  const main = h("div", "va-main");
  shell.appendChild(main);

  const left = h("div", "va-left");
  const center = h("div", "va-pane");
  const right = h("div", "va-right");
  main.append(left, center, right);

  /* --------------------- left rail: threads --------------------- */

  const threadsHead = h("div", "va-pane-head", "Threads");
  const threadCountEl = h("span");
  const allToggle = h("label", "va-toggle");
  const allCheck = h("input", "va-toggle-input") as HTMLInputElement;
  allCheck.type = "checkbox";
  allToggle.append(allCheck, document.createTextNode("show all"));
  threadsHead.append(threadCountEl, h("span", "va-spacer"), allToggle);

  const threadListEl = h("div", "va-pane-body");
  const threadsPane = h("div", "va-pane");
  threadsPane.append(threadsHead, threadListEl);
  left.appendChild(threadsPane);

  /* ------------------- left rail: start run --------------------- */

  const runHead = h("div", "va-pane-head", "Start run");
  const runBody = h("div", "va-pane-body");

  const topicField = h("div", "va-field");
  topicField.appendChild(h("label", undefined, "Topic"));
  const topicInput = h("input", "va-input");
  topicInput.type = "text";
  topicInput.placeholder = "e.g. build the exercise scaffold";
  topicField.appendChild(topicInput);

  const poolField = h("div", "va-field");
  poolField.appendChild(h("label", undefined, "Ticket pool"));
  const poolSelect = h("select", "va-input");
  for (const pool of TICKET_POOLS) {
    const opt = h("option", undefined, pool);
    opt.value = pool;
    poolSelect.appendChild(opt);
  }
  poolField.appendChild(poolSelect);

  const packetDetails = h("details", "va-details");
  packetDetails.appendChild(h("summary", undefined, "Packet (optional)"));
  const packetInput = h("textarea", "va-input");
  packetInput.rows = 4;
  packetInput.placeholder = "Extra context for the run — decisions, constraints…";
  packetDetails.appendChild(packetInput);

  const startBtn = h("button", "va-btn va-btn-primary va-start", "Start run");
  startBtn.type = "button";
  const runNote = h("div", "va-note", "Starts a run on the selected thread. Shallow wiring — the shell does not re-render after streaming.");

  runBody.append(topicField, poolField, packetDetails, startBtn, runNote);
  const runPane = h("div", "va-pane");
  runPane.append(runHead, runBody);
  left.appendChild(runPane);

  /* --------------------- center pane: banners ------------------- */

  const centerHead = h("div", "va-pane-head", "Live state");
  const bannerZone = h("div", "va-banner-zone");
  const centerBody = h("div", "va-pane-body");
  center.append(centerHead, bannerZone, centerBody);

  /* ------------------- right rail: panes ------------------------ */

  const topoHead = h("div", "va-pane-head", "Topology");
  const topoLegend = h("div", "va-legend");
  const runningDot = h("i");
  runningDot.style.background = "var(--accent)";
  const runningLegend = h("span");
  runningLegend.append(runningDot, document.createTextNode("running"));
  const nextDot = h("i");
  nextDot.style.background = "var(--status-running)";
  const nextLegend = h("span");
  nextLegend.append(nextDot, document.createTextNode("next"));
  topoLegend.append(runningLegend, nextLegend);
  const topoWrap = h("div", "va-topo-wrap");
  topoWrap.appendChild(topoLegend);
  const topoPane = h("div", "va-pane");
  topoPane.append(topoHead, topoWrap);

  const stateHead = h("div", "va-pane-head", "State");
  const stateBody = h("div", "va-pane-body");
  const statePane = h("div", "va-pane");
  statePane.append(stateHead, stateBody);

  right.append(topoPane, statePane);

  /* --------------------------- actions -------------------------- */

  function resume(decision: InterruptDecision): void {
    const thread = state.thread;
    if (!thread) {
      flash("no thread selected");
      return;
    }
    if (ctx.mock) {
      flash(`MOCK DATA — resume stubbed (${decision.action} is a no-op)`);
      return;
    }
    ctx.resumeRun(thread.threadId, decision)
      .then(() => flash(`resumed ${decision.action} — streamed; this spike does not re-render`))
      .catch((err: unknown) => flash(`resume failed: ${String(err)}`));
  }

  function selectThread(t: ThreadListItem): void {
    state.selectedId = t.threadId;
    state.thread = t;
    state.values = t.values;
    state.interrupts = t.interrupts;
    state.expanded = t.interrupts.length > 0 ? 0 : -1;
    renderThreadList();
    renderBanners();
    renderCenter();
    renderTopology();
    renderState();
  }

  function threadSource(): ThreadListItem[] {
    return state.showAll ? ctx.allThreads : ctx.threads;
  }

  function renderThreadList(): void {
    const list = threadSource();
    threadCountEl.textContent = `${list.length}`;
    const interrupted = list.filter((t) => t.interrupts.length > 0).length;
    metaEl.textContent = `${list.length} thread${list.length === 1 ? "" : "s"} · ${interrupted} interrupted · selected: ${state.thread?.label ?? "—"}`;
    threadListEl.replaceChildren();
    if (list.length === 0) {
      threadListEl.appendChild(h("div", "va-empty", "No UI-created threads yet — start a run."));
      return;
    }
    for (const t of list) {
      const item = h("div", "va-thread" + (t.threadId === state.selectedId ? " sel" : ""));
      item.addEventListener("click", () => selectThread(t));

      const dot = h("span", "va-dot");
      dot.style.background = STATUS_COLOR[t.status] ?? "var(--status-pending)";
      const row1 = h("div", "va-thread-row1");
      row1.append(dot, h("span", "va-thread-label", t.label), h("span", "va-tag", t.origin));

      const statusEl = h("span", "va-thread-status " + threadStatusClass(t.status), t.status);
      const row2 = h("div", "va-thread-row2");
      row2.append(statusEl, h("span", undefined, fmtTime(t.updatedAt)));
      if (t.interrupts.length > 0) {
        row2.appendChild(h("span", "va-thread-int", `⏸ ${t.interrupts.length}`));
      }

      item.append(row1, row2);
      threadListEl.appendChild(item);
    }
  }

  /* ------------------------- banners ---------------------------- */

  function resumeButtons(int: InterruptProjection): HTMLElement {
    const row = h("div", "va-banner-actions");
    const v = int.value;

    if (v.kind === "approve-spec") {
      const approve = h("button", "va-btn va-btn-approve", "Approve");
      approve.type = "button";
      approve.addEventListener("click", () => resume({ action: "approve" }));
      const reject = h("button", "va-btn va-btn-reject", "Reject");
      reject.type = "button";
      reject.addEventListener("click", () => resume({ action: "reject" }));
      row.append(approve, reject);
    } else if (v.kind === "deadlock") {
      const reload = h("button", "va-btn va-btn-approve", "Reload");
      reload.type = "button";
      reload.addEventListener("click", () => resume({ action: "reload" }));
      const abort = h("button", "va-btn va-btn-reject", "Abort");
      abort.type = "button";
      abort.addEventListener("click", () => resume({ action: "abort" }));
      row.append(reload, abort);
    } else {
      // review
      const approve = h("button", "va-btn va-btn-approve", "Approve");
      approve.type = "button";
      approve.addEventListener("click", () => resume({ action: "approve" }));
      const retry = h("button", "va-btn va-btn-primary", "Retry");
      retry.type = "button";
      retry.disabled = true;
      const replan = h("button", "va-btn va-btn-reject", "Replan");
      replan.type = "button";
      replan.addEventListener("click", () => resume({ action: "replan" }));
      row.append(approve, retry, replan);
      retry.addEventListener("click", () => {
        const ids = Array.from(
          row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
        ).map((c) => c.value);
        if (ids.length === 0) {
          flash("select at least one ticket to retry");
          return;
        }
        resume({ action: "retry", ids });
      });
    }
    return row;
  }

  function bannerBody(int: InterruptProjection): HTMLElement {
    const body = h("div", "va-banner-body");
    const v = int.value;
    let reviewList: HTMLElement | null = null;

    body.appendChild(
      h(
        "div",
        "va-banner-meta",
        `thread ${state.thread?.threadId ?? "?"} · ns ${int.ns.join("/")} · id ${int.id ?? "—"}`,
      ),
    );

    if (v.kind === "approve-spec") {
      const tickets = countByStatus(v.tickets);
      body.appendChild(
        h("div", "va-banner-meta", `${v.tickets.length} tickets planned (${tickets.pending} pending · ${tickets.running} running · ${tickets.done} done) — approve to schedule, or reject to loop back to writeSpec.`),
      );
      const pre = h("pre", "va-banner-pre", v.spec);
      body.appendChild(pre);
    } else if (v.kind === "deadlock") {
      body.appendChild(
        h("div", "va-banner-meta", `No ticket can start — pending: ${v.pending.join(", ") || "—"}. ${v.hint}`),
      );
    } else {
      reviewList = h("div", "va-check-list");
      for (const t of v.tickets) {
        const label = h("label", "va-check");
        const cb = h("input");
        cb.type = "checkbox";
        cb.value = t.id;
        const idSpan = h("span", "va-ticket-id " + ticketStatusClass(t.status), t.id);
        idSpan.style.minWidth = "auto";
        label.append(cb, idSpan, h("span", undefined, t.title));
        reviewList.appendChild(label);
      }
      body.appendChild(reviewList);
    }

    const raw = h("details", "va-raw");
    raw.appendChild(h("summary", undefined, "Raw interrupt JSON"));
    raw.appendChild(h("pre", undefined, JSON.stringify(v, null, 2)));
    body.appendChild(raw);

    const actions = resumeButtons(int);
    body.appendChild(actions);

    // Wire the retry enable-state once the buttons are in the DOM.
    if (reviewList) {
      const retryBtn = actions.querySelector<HTMLButtonElement>(".va-btn-primary");
      if (retryBtn) {
        reviewList.addEventListener("change", () => {
          const n = reviewList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked').length;
          retryBtn.disabled = n === 0;
        });
      }
    }

    return body;
  }

  function renderBanners(): void {
    bannerZone.replaceChildren();
    const interrupts = state.interrupts;
    bannerZone.style.display = interrupts.length === 0 ? "none" : "flex";
    interrupts.forEach((int, i) => {
      const banner = h("div", "va-banner" + (state.expanded === i ? " open" : ""));
      const row = h("div", "va-banner-row");
      row.setAttribute("aria-expanded", String(state.expanded === i));

      const icon = h("span", "va-banner-icon", "⏸");
      const wait = h("span", "va-banner-wait", "Waiting on you —");
      const kind = h("span", "va-banner-kind", int.kind);
      const threadId = h("span", "va-banner-thread", state.thread?.threadId ?? "");
      const chev = h("span", "va-banner-chev", state.expanded === i ? "▾" : "▸");
      row.append(icon, wait, kind, threadId, chev);
      row.addEventListener("click", () => {
        state.expanded = state.expanded === i ? -1 : i;
        renderBanners();
      });

      banner.append(row, bannerBody(int));
      bannerZone.appendChild(banner);
    });
  }

  /* ------------------------ center body ------------------------- */

  function ticketsSection(values: ThreadValues): HTMLElement {
    const sec = h("div", "va-section");
    const counts = countByStatus(values.tickets);
    const head = h("div", "va-section-head", "Tickets");
    head.appendChild(h("span", "va-count", `${values.tickets.length} total`));
    sec.appendChild(head);

    const list = h("div", "va-tickets");
    if (values.tickets.length === 0) {
      list.appendChild(h("div", "va-empty", "No tickets in state yet."));
    }
    for (const t of values.tickets) {
      const row = h("div", "va-ticket");
      const id = h("span", "va-ticket-id " + ticketStatusClass(t.status), t.id);
      const blk =
        t.blockedBy.length > 0
          ? h("span", "va-ticket-blk", `after ${t.blockedBy.join(", ")}`)
          : null;
      const status = h("span", "va-ticket-status " + ticketStatusClass(t.status), t.status);
      row.append(id, h("span", "va-ticket-title", t.title));
      if (blk) row.appendChild(blk);
      row.appendChild(status);
      list.appendChild(row);
    }
    sec.appendChild(list);
    return sec;
  }

  function logSection(values: ThreadValues): HTMLElement {
    const sec = h("div", "va-section");
    sec.appendChild(h("div", "va-section-head", "Log"));
    const pre = h("pre", "va-log");
    const lines = values.log.slice().reverse();
    pre.textContent = lines.length > 0 ? lines.join("\n") : "— no log lines —";
    if (lines.length === 0) pre.classList.add("va-log-empty");
    sec.appendChild(pre);
    return sec;
  }

  function docSection(values: ThreadValues): HTMLElement {
    const sec = h("div", "va-section");
    const head = h("div", "va-section-head", "Spec / Packet");
    sec.appendChild(head);

    const seg = h("div", "va-seg");
    const specBtn = h("button", state.docView === "spec" ? "on" : undefined, "Spec");
    const packetBtn = h("button", state.docView === "packet" ? "on" : undefined, "Packet");
    specBtn.type = "button";
    packetBtn.type = "button";
    specBtn.addEventListener("click", () => {
      state.docView = "spec";
      renderCenter();
    });
    packetBtn.addEventListener("click", () => {
      state.docView = "packet";
      renderCenter();
    });
    seg.append(specBtn, packetBtn);
    sec.appendChild(seg);

    const pre = h("pre", "va-doc");
    const content = state.docView === "spec" ? values.spec : values.packet;
    pre.textContent = content && content.trim().length > 0 ? content : "— empty —";
    if (!content || content.trim().length === 0) pre.classList.add("va-doc-empty");
    sec.appendChild(pre);
    return sec;
  }

  function renderCenter(): void {
    centerBody.replaceChildren();
    const values = state.values;
    if (!state.thread) {
      centerBody.appendChild(h("div", "va-empty", "No thread selected — pick one on the left, or start a run."));
      return;
    }
    if (!values) {
      centerBody.appendChild(h("div", "va-empty", "Thread has no State values yet."));
      return;
    }
    centerBody.append(ticketsSection(values), logSection(values), docSection(values));
  }

  /* ------------------------ topology ---------------------------- */

  function inferNode(topo: Topology): { current: string | null; next: string[] } {
    let current: string | null = null;
    if (state.interrupts.length > 0) {
      const k = state.interrupts[0].kind;
      current = k === "approve-spec" ? "approveSpec" : k === "deadlock" ? "deadlockGate" : "review";
    } else if (state.values?.log.length) {
      const last = state.values.log[state.values.log.length - 1];
      const m = /^([A-Za-z_]+)/.exec(last);
      if (m) current = m[1];
    }
    const next = current ? topo.edges.filter((e) => e.source === current).map((e) => e.target) : [];
    return { current, next };
  }

  function renderTopology(): void {
    // Keep the legend; rebuild everything below it.
    while (topoWrap.childNodes.length > 1) topoWrap.removeChild(topoWrap.lastChild as ChildNode);

    const topo = ctx.topology;
    if (topo.nodes.length === 0) {
      topoWrap.appendChild(h("div", "va-empty", "No topology available."));
      return;
    }

    const { current, next } = inferNode(topo);
    const layer = computeLayers(topo);

    const cols = new Map<number, string[]>();
    for (const n of topo.nodes) {
      const l = layer.get(n.id) ?? 0;
      const arr = cols.get(l) ?? [];
      arr.push(n.id);
      cols.set(l, arr);
    }
    const sortedLayers = [...cols.keys()].sort((a, b) => a - b);
    const layerIndex = new Map(sortedLayers.map((l, i) => [l, i] as const));

    const COL_W = 150;
    const ROW_H = 56;
    const TOP = 24;

    const pos = new Map<string, { cx: number; cy: number; w: number }>();
    for (const [l, ids] of cols) {
      const col = layerIndex.get(l) ?? 0;
      ids.forEach((id, i) => {
        const node = topo.nodes.find((n) => n.id === id);
        const nameLen = node?.name?.length ?? id.length;
        pos.set(id, { cx: 20 + col * COL_W + COL_W / 2, cy: TOP + i * ROW_H, w: Math.max(78, nameLen * 7.2 + 18) });
      });
    }

    const maxCol = Math.max(0, sortedLayers.length - 1);
    const width = 20 + maxCol * COL_W + COL_W / 2 + 70;
    const maxY = Math.max(40, ...[...pos.values()].map((p) => p.cy + 14));

    const svg = svgEl("svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(maxY));
    svg.style.display = "block";

    const defs = svgEl("defs");
    const marker = svgEl("marker");
    marker.setAttribute("id", "va-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const markerPath = svgEl("path");
    markerPath.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    markerPath.setAttribute("fill", "#3a4356");
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // edges first (under nodes)
    for (const e of topo.edges) {
      const s = pos.get(e.source);
      const t = pos.get(e.target);
      if (!s || !t) continue;
      const sx = s.cx + s.w / 2;
      const sy = s.cy;
      const tx = t.cx - t.w / 2;
      const ty = t.cy;
      const isNext = current === e.source && next.includes(e.target);
      const d =
        sx >= tx
          ? `M ${sx} ${sy} C ${sx} ${sy + 36}, ${tx} ${ty + 36}, ${tx} ${ty}`
          : `M ${sx} ${sy} C ${(sx + tx) / 2} ${sy}, ${(sx + tx) / 2} ${ty}, ${tx} ${ty}`;
      const path = svgEl("path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.style.stroke = isNext ? "var(--accent)" : "#3a4356";
      path.style.strokeWidth = isNext ? "1.5" : "1";
      if (e.conditional) path.setAttribute("stroke-dasharray", "3 3");
      if (!e.conditional || !isNext) path.setAttribute("marker-end", "url(#va-arrow)");
      svg.appendChild(path);

      if (e.data) {
        const lbl = svgEl("text");
        lbl.setAttribute("x", String((sx + tx) / 2));
        lbl.setAttribute("y", String((sy + ty) / 2 - 4));
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("font-size", "9");
        lbl.style.fill = "var(--text-dim)";
        lbl.textContent = String(e.data);
        svg.appendChild(lbl);
      }
    }

    // nodes
    for (const n of topo.nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const x = p.cx - p.w / 2;
      const y = p.cy - 13;
      const isRunning = current === n.id;
      const isNextNode = next.includes(n.id);

      const g = svgEl("g");
      const rect = svgEl("rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(p.w));
      rect.setAttribute("height", "26");
      rect.setAttribute("rx", "4");
      rect.setAttribute("fill", "#1a2030");
      rect.setAttribute("stroke", "#2c3547");
      if (isRunning) {
        rect.setAttribute("fill", "rgba(76,194,255,.14)");
        rect.style.stroke = "var(--accent)";
        rect.style.strokeWidth = "1.5";
      } else if (isNextNode) {
        rect.style.stroke = "var(--status-running)";
        rect.style.strokeDasharray = "3 3";
      }
      g.appendChild(rect);

      const text = svgEl("text");
      text.setAttribute("x", String(p.cx));
      text.setAttribute("y", String(p.cy + 4));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "11");
      text.style.fill = isRunning ? "var(--accent)" : "var(--text)";
      text.textContent = n.name ?? n.id;
      g.appendChild(text);

      svg.appendChild(g);
    }

    topoWrap.appendChild(svg);
  }

  /* --------------------------- state ---------------------------- */

  function renderState(): void {
    stateBody.replaceChildren();
    if (!state.thread) {
      stateBody.appendChild(h("div", "va-empty", "No State."));
      return;
    }
    const t = state.thread;
    const meta = h("div", "va-banner-meta");
    meta.style.marginBottom = "8px";
    meta.textContent = `${t.label} · ${t.threadId} · ${t.status} · origin ${t.origin} · created ${fmtTime(t.createdAt)} · updated ${fmtTime(t.updatedAt)}`;
    stateBody.appendChild(meta);

    const details = h("details", "va-raw");
    details.open = true;
    details.appendChild(h("summary", undefined, "Raw thread values (JSON)"));
    details.appendChild(h("pre", undefined, JSON.stringify(t.values ?? null, null, 2)));
    stateBody.appendChild(details);
  }

  /* --------------------------- boot ----------------------------- */

  allCheck.addEventListener("change", () => {
    state.showAll = allCheck.checked;
    const list = threadSource();
    if (!state.thread || !list.some((t) => t.threadId === state.thread?.threadId)) {
      const next = list[0] ?? null;
      if (next) selectThread(next);
    }
    renderThreadList();
  });

  startBtn.addEventListener("click", () => {
    const topic = topicInput.value.trim();
    const ticketDir = poolSelect.value;
    const packet = packetInput.value.trim();
    if (!topic) {
      flash("topic is required to start a run");
      return;
    }
    const threadId = state.selectedId ?? "new";
    if (ctx.mock) {
      flash("MOCK DATA — streamRun is a no-op");
      return;
    }
    ctx
      .streamRun(threadId, { topic, ticketDir, ...(packet ? { packet } : {}) })
      .then(() => flash(`run started on ${threadId} — streamed; this spike does not re-render`))
      .catch((err: unknown) => flash(`start failed: ${String(err)}`));
  });

  // Initial selection: prefer the shell's default, else first available.
  const initialPool = ctx.threads;
  const initial =
    initialPool.find((t) => t.threadId === ctx.selectedThreadId) ??
    ctx.allThreads.find((t) => t.threadId === ctx.selectedThreadId) ??
    initialPool[0] ??
    null;
  state.thread = initial;
  state.selectedId = initial?.threadId ?? null;
  state.values = initial?.values ?? ctx.selected ?? null;
  state.interrupts = initial?.interrupts ?? ctx.interrupts ?? [];
  state.expanded = state.interrupts.length > 0 ? 0 : -1;

  renderThreadList();
  renderBanners();
  renderCenter();
  renderTopology();
  renderState();
}
