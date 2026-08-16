/**
 * Variant B — "Tabbed Ops".
 *
 * Layout question: TAB-SEPARATED surfaces, interrupt as a MODAL — the
 * structural opposite of an always-on dashboard. Information is parceled
 * out: the operator picks a Thread in the top bar, starts a run from the
 * "New run" form, and reads one surface at a time (Tickets / Log / Spec /
 * Graph / State) off a tab strip. Pending Interrupts surface as a blocking
 * modal with a per-kind decision form plus a collapsible raw payload; the
 * tab strip carries a pending-interrupt badge so the modal is never silent.
 *
 * Read-only layout spike: the decision buttons and the run form call the
 * real ctx.* functions, but outcomes are only logged — nothing re-renders
 * from them.
 */

import { TICKET_POOLS } from "../data";
import type {
  ApproveSpecInterruptValue,
  DeadlockInterruptValue,
  InterruptDecision,
  InterruptKind,
  InterruptProjection,
  InterruptValue,
  ReviewInterruptValue,
  ShellContext,
  ThreadListItem,
  ThreadValues,
  Ticket,
  TicketStatus,
  Topology,
  TopologyEdge,
  TopologyNode,
} from "../data";

export const name = "Tabbed Ops";

type TabId = "tickets" | "log" | "spec" | "graph" | "state";

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

/** Loose inline-style map: camelCase CSS keys, values get stringified. */
type InlineStyle = Record<string, string | number | undefined>;

interface Attrs {
  className?: string;
  text?: string;
  title?: string;
  style?: InlineStyle;
  attrs?: Record<string, string>;
  onClick?: (ev: Event) => void;
}

function cssKey(k: string): string {
  return k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  a: Attrs = {},
  ...children: (Node | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (a.className) node.className = a.className;
  if (a.title) node.title = a.title;
  if (a.text !== undefined) node.textContent = a.text;
  if (a.style) {
    for (const [k, v] of Object.entries(a.style)) {
      if (v === undefined) continue;
      node.style.setProperty(cssKey(k), String(v));
    }
  }
  if (a.attrs) for (const [k, v] of Object.entries(a.attrs)) node.setAttribute(k, v);
  if (a.onClick) node.addEventListener("click", a.onClick);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function mk(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (Node | null | undefined)[]
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.appendChild(c);
  return node;
}

// ---------------------------------------------------------------------------
// Shared inline styles (dark console aesthetic, references styles.css tokens)
// ---------------------------------------------------------------------------

const S = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 130px)",
    minHeight: 380,
  } as InlineStyle,
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
  } as InlineStyle,
  tabbar: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "0 8px",
    background: "var(--bg-panel-2)",
    borderBottom: "1px solid var(--border)",
  } as InlineStyle,
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "var(--text-dim)",
    fontFamily: "inherit",
    fontSize: 12,
    padding: "9px 12px",
    cursor: "pointer",
  } as InlineStyle,
  tabActive: {
    color: "var(--text)",
    borderBottomColor: "var(--accent)",
    background: "rgba(76, 194, 255, 0.08)",
  } as InlineStyle,
  tabInterrupt: {
    color: "var(--interrupt)",
    fontWeight: 700,
  } as InlineStyle,
  panels: {
    flex: "1",
    minHeight: 0,
    overflow: "auto",
    background: "var(--bg)",
  } as InlineStyle,
  overlay: {
    position: "fixed",
    inset: "0",
    background: "rgba(2, 4, 8, 0.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    zIndex: "1500",
  } as InlineStyle,
  modalBox: {
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderTop: "2px solid var(--interrupt)",
    borderRadius: 8,
    maxWidth: 620,
    width: "100%",
    maxHeight: "82vh",
    overflow: "auto",
    boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
    position: "relative",
    padding: 16,
  } as InlineStyle,
  modalClose: {
    position: "absolute",
    top: 8,
    right: 10,
    background: "transparent",
    border: "none",
    color: "var(--text-dim)",
    fontSize: 14,
    cursor: "pointer",
    zIndex: "2",
  } as InlineStyle,
};

const titleStyle: InlineStyle = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  marginBottom: 10,
};

const subTitle: InlineStyle = {
  color: "var(--text-dim)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  margin: "0 0 6px",
};

const preBlock: InlineStyle = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "10px 12px",
  overflow: "auto",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--text)",
};

const inputStyle: InlineStyle = {
  width: "100%",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "6px 8px",
  fontFamily: "inherit",
  fontSize: 12,
};

const btn: InlineStyle = {
  fontFamily: "inherit",
  fontSize: 12,
  padding: "6px 12px",
  borderRadius: 5,
  border: "1px solid var(--border)",
  background: "var(--bg-panel-2)",
  color: "var(--text)",
  cursor: "pointer",
};

const btnAccent: InlineStyle = {
  background: "rgba(76, 194, 255, 0.14)",
  borderColor: "var(--accent)",
  color: "var(--accent)",
};

const btnDanger: InlineStyle = {
  background: "rgba(248, 81, 73, 0.12)",
  borderColor: "var(--interrupt)",
  color: "var(--interrupt)",
};

const summaryStyle: InlineStyle = {
  color: "var(--text-dim)",
  fontSize: 11,
  cursor: "pointer",
  padding: "4px 0",
};

const cellHead: InlineStyle = {
  textAlign: "left",
  padding: "6px 10px",
  color: "var(--text-dim)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: "1px solid var(--border)",
};

const cell: InlineStyle = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

function emptyNote(text: string): HTMLElement {
  return h("div", {
    text,
    style: { color: "var(--text-dim)", fontStyle: "italic", padding: "8px 0" },
  });
}

function statusClass(s: TicketStatus): string {
  return s === "pending"
    ? "t-status-pending"
    : s === "running"
      ? "t-status-running"
      : "t-status-done";
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h(
    "label",
    { style: { display: "block", marginBottom: 10 } },
    h("span", {
      text: label,
      style: { display: "block", color: "var(--text-dim)", fontSize: 11, marginBottom: 4 },
    }),
    input,
  );
}

// ---------------------------------------------------------------------------
// Layered SVG topology (no pan/zoom)
// ---------------------------------------------------------------------------

/**
 * Assign each Node a column (layer). DFS finds cycle-closing ("back") Edges;
 * ranking ignores them (the rest of the graph is acyclic), so back Edges get
 * drawn as return arcs instead of stretching the layout forever.
 */
function layeredLayout(
  nodes: TopologyNode[],
  edges: TopologyEdge[],
): { layerOf: Map<string, number>; backEdges: Set<string> } {
  const layerOf = new Map<string, number>();
  nodes.forEach((n) => layerOf.set(n.id, 0));

  const adj = new Map<string, string[]>();
  nodes.forEach((n) => adj.set(n.id, []));
  edges.forEach((e) => adj.get(e.source)?.push(e.target));

  const color = new Map<string, number>(); // 0 = white, 1 = gray, 2 = black
  const back = new Set<string>();
  const dfs = (u: string): void => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) back.add(`${u}\u0000${v}`);
      else if (c === 0) dfs(v);
    }
    color.set(u, 2);
  };
  nodes.forEach((n) => {
    if ((color.get(n.id) ?? 0) === 0) dfs(n.id);
  });

  let changed = true;
  let guard = nodes.length + 2;
  while (changed && guard-- > 0) {
    changed = false;
    for (const e of edges) {
      if (back.has(`${e.source}\u0000${e.target}`)) continue;
      const s = layerOf.get(e.source) ?? 0;
      const t = layerOf.get(e.target) ?? 0;
      if (t < s + 1) {
        layerOf.set(e.target, s + 1);
        changed = true;
      }
    }
  }
  return { layerOf, backEdges: back };
}

const GRAPH_COLORS = {
  fill: "#1a2030",
  stroke: "#232a3b",
  accent: "#4cc2ff",
  text: "#d4dae4",
  dim: "#7d8597",
  edge: "#7d8597",
};

function panelGraph(topology: Topology): HTMLElement {
  const box = h("div", { style: { padding: 14 } });
  box.appendChild(h("div", { text: "Graph", style: titleStyle }));
  box.appendChild(
    h("div", {
      text: "Nodes read State and return partial updates; Edges route the run to the next Node. Dashed = conditional Edge; arc = cycle return.",
      style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 10 },
    }),
  );

  if (topology.nodes.length === 0) {
    box.appendChild(emptyNote("no topology"));
    return box;
  }

  const { layerOf, backEdges } = layeredLayout(topology.nodes, topology.edges);

  const NODE_W = 150;
  const NODE_H = 32;
  const GAP_X = 44;
  const GAP_Y = 16;
  const PAD = 22;

  const byLayer = new Map<number, TopologyNode[]>();
  let maxLayer = 0;
  for (const n of topology.nodes) {
    const l = layerOf.get(n.id) ?? 0;
    if (l > maxLayer) maxLayer = l;
    const arr = byLayer.get(l) ?? [];
    arr.push(n);
    byLayer.set(l, arr);
  }
  for (const arr of byLayer.values()) {
    arr.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  let maxRows = 0;
  for (const arr of byLayer.values()) maxRows = Math.max(maxRows, arr.length);

  const colW = NODE_W + GAP_X;
  const rowH = NODE_H + GAP_Y;
  const totalRowsH = (maxRows - 1) * rowH + NODE_H;
  const svgW = PAD * 2 + maxLayer * colW + NODE_W;
  const svgH = PAD * 2 + totalRowsH;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, arr] of byLayer) {
    const stackH = arr.length * NODE_H + (arr.length - 1) * GAP_Y;
    const colTop = PAD + (totalRowsH - stackH) / 2;
    arr.forEach((n, i) => pos.set(n.id, { x: PAD + l * colW, y: colTop + i * rowH }));
  }

  const svg = mk("svg", {
    width: String(svgW),
    height: String(svgH),
    viewBox: `0 0 ${svgW} ${svgH}`,
    style:
      "max-width:100%; height:auto; background:var(--bg-panel); border:1px solid var(--border); border-radius:8px",
  });

  const defs = mk("defs", {});
  defs.appendChild(
    mk(
      "marker",
      {
        id: "vb-arrow",
        viewBox: "0 0 10 10",
        refX: "9",
        refY: "5",
        markerWidth: "6",
        markerHeight: "6",
        orient: "auto",
      },
      mk("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: GRAPH_COLORS.edge }),
    ),
  );
  svg.appendChild(defs);

  for (const e of topology.edges) {
    const s = pos.get(e.source);
    const t = pos.get(e.target);
    if (!s || !t) continue;
    const sx = s.x + NODE_W;
    const sy = s.y + NODE_H / 2;
    const tx = t.x;
    const ty = t.y + NODE_H / 2;
    const back = backEdges.has(`${e.source}\u0000${e.target}`);

    if (back) {
      const bow = Math.max(sy, ty) + 30;
      const midX = (sx + tx) / 2;
      svg.appendChild(
        mk("path", {
          d: `M ${sx} ${sy} Q ${midX} ${bow} ${tx} ${ty}`,
          fill: "none",
          stroke: GRAPH_COLORS.edge,
          "stroke-width": "1",
          "stroke-dasharray": "4 3",
          "marker-end": "url(#vb-arrow)",
          opacity: "0.65",
        }),
      );
    } else {
      svg.appendChild(
        mk("line", {
          x1: String(sx),
          y1: String(sy),
          x2: String(tx),
          y2: String(ty),
          stroke: GRAPH_COLORS.edge,
          "stroke-width": "1",
          ...(e.conditional ? { "stroke-dasharray": "4 3" } : {}),
          "marker-end": "url(#vb-arrow)",
        }),
      );
    }

    if (e.conditional) {
      const lx = (sx + tx) / 2;
      const ly = (sy + ty) / 2 - 4;
      svg.appendChild(
        mk(
          "text",
          {
            x: String(lx),
            y: String(ly),
            "text-anchor": "middle",
            "font-size": "9",
            fill: GRAPH_COLORS.dim,
          },
          document.createTextNode(e.data ?? "cond"),
        ),
      );
    }
  }

  for (const n of topology.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const label = n.name ?? n.id;
    const special = n.id === "START" || n.id === "END";
    const g = mk("g", {});
    g.appendChild(
      mk("rect", {
        x: String(p.x),
        y: String(p.y),
        width: String(NODE_W),
        height: String(NODE_H),
        rx: "6",
        fill: n.id === "END" ? "#12161f" : GRAPH_COLORS.fill,
        stroke: special ? GRAPH_COLORS.accent : GRAPH_COLORS.stroke,
        "stroke-width": special ? "1.5" : "1",
        opacity: n.id === "END" ? "0.7" : "1",
      }),
    );
    g.appendChild(
      mk(
        "text",
        {
          x: String(p.x + NODE_W / 2),
          y: String(p.y + NODE_H / 2 + 4),
          "text-anchor": "middle",
          "font-size": "11",
          fill: special ? GRAPH_COLORS.accent : GRAPH_COLORS.text,
          "font-family": "ui-monospace, SF Mono, Menlo, Consolas, monospace",
        },
        document.createTextNode(label),
      ),
    );
    svg.appendChild(g);
  }

  box.appendChild(svg);
  return box;
}

// ---------------------------------------------------------------------------
// Panel builders
// ---------------------------------------------------------------------------

function panelTickets(tickets: Ticket[] | null): HTMLElement {
  const box = h("div", { style: { padding: 14 } });
  box.appendChild(
    h("div", { text: `Tickets${tickets ? ` (${tickets.length})` : ""}`, style: titleStyle }),
  );
  if (!tickets || tickets.length === 0) {
    box.appendChild(emptyNote("no tickets in this State yet"));
    return box;
  }

  const table = h("table", {
    style: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  });
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const c of ["id", "title", "blocked by", "status"]) {
    headRow.appendChild(h("th", { text: c, style: cellHead }));
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  for (const t of tickets) {
    const tr = document.createElement("tr");
    tr.appendChild(h("td", { text: t.id, style: cell }));
    tr.appendChild(h("td", { text: t.title, style: cell }));
    tr.appendChild(
      h("td", {
        text: t.blockedBy.length ? t.blockedBy.join(", ") : "—",
        style: { ...cell, color: "var(--text-dim)" },
      }),
    );
    tr.appendChild(
      h(
        "td",
        { style: cell },
        h("span", { text: t.status, className: statusClass(t.status) }),
      ),
    );
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);

  const legend = (label: string, color: string): HTMLElement =>
    h(
      "span",
      { style: { display: "inline-flex", alignItems: "center", gap: 5 } },
      h("span", {
        style: {
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
        },
      }),
      h("span", { text: label }),
    );
  box.appendChild(
    h(
      "div",
      {
        style: {
          display: "flex",
          gap: 14,
          marginTop: 10,
          fontSize: 11,
          color: "var(--text-dim)",
        },
      },
      legend("pending", "var(--status-pending)"),
      legend("running", "var(--status-running)"),
      legend("done", "var(--status-done)"),
    ),
  );
  return box;
}

function panelLog(log: string[] | null): HTMLElement {
  const box = h("div", { style: { padding: 14 } });
  box.appendChild(h("div", { text: "Log", style: titleStyle }));
  if (!log || log.length === 0) {
    box.appendChild(emptyNote("no log lines yet"));
    return box;
  }
  const scroll = h("div", { style: { overflowY: "auto", maxHeight: 440 } });
  for (const line of log) {
    scroll.appendChild(
      h("div", {
        text: line,
        style: { padding: "2px 0", fontSize: 12, whiteSpace: "pre-wrap" },
      }),
    );
  }
  scroll.scrollTop = scroll.scrollHeight;
  box.appendChild(scroll);
  return box;
}

function panelSpec(values: ThreadValues | null, thread: ThreadListItem | null): HTMLElement {
  const box = h("div", { style: { padding: 14 } });
  box.appendChild(h("div", { text: "Spec", style: titleStyle }));
  const spec = values?.spec ?? "";
  const packet = values?.packet ?? "";
  if (!spec && !packet) {
    box.appendChild(emptyNote("no Spec or Packet yet"));
    return box;
  }
  if (thread) {
    box.appendChild(
      h("div", {
        text: `thread: ${thread.label} · ${thread.status}`,
        style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 10 },
      }),
    );
  }
  if (spec) {
    box.appendChild(h("div", { text: "Spec text", style: subTitle }));
    box.appendChild(h("pre", { text: spec, style: preBlock }));
  }
  if (packet) {
    box.appendChild(h("div", { text: "Packet", style: { ...subTitle, marginTop: 12 } }));
    box.appendChild(h("pre", { text: packet, style: preBlock }));
  }
  return box;
}

function panelState(values: ThreadValues | null, thread: ThreadListItem | null): HTMLElement {
  const box = h("div", { style: { padding: 14 } });
  box.appendChild(h("div", { text: "State", style: titleStyle }));
  if (!thread) {
    box.appendChild(emptyNote("no Thread selected"));
    return box;
  }
  box.appendChild(
    h(
      "div",
      { style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 10 } },
      h("span", { text: `${thread.label} · ${thread.status}`, style: { color: "var(--text)" } }),
      h("span", { text: `  ${thread.threadId}` }),
      h("span", { text: `  origin: ${thread.origin}` }),
    ),
  );

  const valuesDetails = h(
    "details",
    { style: { marginBottom: 8 } },
    h("summary", { text: "values (channels)", style: summaryStyle }),
    h("pre", { text: JSON.stringify(values ?? null, null, 2), style: preBlock }),
  );
  (valuesDetails as HTMLDetailsElement).open = true;

  box.appendChild(valuesDetails);
  box.appendChild(
    h(
      "details",
      { style: { marginBottom: 8 } },
      h("summary", { text: `interrupts (${thread.interrupts.length})`, style: summaryStyle }),
      h("pre", { text: JSON.stringify(thread.interrupts, null, 2), style: preBlock }),
    ),
  );
  return box;
}

// ---------------------------------------------------------------------------
// Interrupt modal
// ---------------------------------------------------------------------------

/** Current ShellContext; captured when VariantB mounts so card actions can resume. */
let activeCtx: ShellContext;

function resume(threadId: string, decision: InterruptDecision, status: HTMLElement): void {
  status.textContent = `resumed → ${JSON.stringify(decision)}`;
  void activeCtx.resumeRun(threadId, decision).then(
    (o) => console.info("[variant-b] resume ok", o.interrupted),
    (e) => console.error("[variant-b] resume failed", e),
  );
}

function cardShell(opts: {
  title: string;
  id?: string;
  body: HTMLElement[];
  raw: InterruptValue;
  footer: HTMLElement | null;
}): HTMLElement {
  return h(
    "div",
    { style: { borderBottom: "1px solid var(--border)", paddingBottom: 14, marginBottom: 14 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
      h("span", { text: "⏸", style: { color: "var(--interrupt)" } }),
      h("span", { text: opts.title, style: { fontWeight: 700, fontSize: 13 } }),
      opts.id
        ? h("span", { text: opts.id, style: { color: "var(--text-dim)", fontSize: 11 } })
        : null,
    ),
    ...opts.body,
    h(
      "details",
      { style: { marginTop: 10 } },
      h("summary", { text: "raw payload", style: summaryStyle }),
      h("pre", {
        text: JSON.stringify(opts.raw, null, 2),
        style: { ...preBlock, maxHeight: 160 },
      }),
    ),
    opts.footer ?? null,
  );
}

function cardApproveSpec(
  v: ApproveSpecInterruptValue,
  id: string | undefined,
  threadId: string,
): HTMLElement {
  const status = h("span", { style: { color: "var(--text-dim)", fontSize: 11 } });
  const body: HTMLElement[] = [
    h("div", {
      text: "The Spec below was drafted from the Packet and ticket pool. Approve to schedule Tickets, or Reject to send it back to writeSpec.",
      style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 8 },
    }),
    h("pre", { text: v.spec, style: { ...preBlock, maxHeight: 200 } }),
    h("div", {
      text: `${v.tickets.length} ticket(s) in the pool`,
      style: { color: "var(--text-dim)", fontSize: 11, marginTop: 8 },
    }),
  ];
  const footer = h(
    "div",
    { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 } },
    h("button", {
      text: "Approve",
      attrs: { type: "button" },
      style: { ...btn, ...btnAccent },
      onClick: () => resume(threadId, { action: "approve" }, status),
    }),
    h("button", {
      text: "Reject",
      attrs: { type: "button" },
      style: { ...btn, ...btnDanger },
      onClick: () => resume(threadId, { action: "reject" }, status),
    }),
    status,
  );
  return cardShell({ title: "Approve spec", id, body, raw: v, footer });
}

function cardDeadlock(
  v: DeadlockInterruptValue,
  id: string | undefined,
  threadId: string,
): HTMLElement {
  const status = h("span", { style: { color: "var(--text-dim)", fontSize: 11 } });
  const body: HTMLElement[] = [
    h("div", {
      text: v.hint,
      style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 8 },
    }),
    h("div", {}, ...v.pending.map((pid) =>
      h("span", {
        text: pid,
        style: {
          display: "inline-block",
          margin: "0 6px 6px 0",
          padding: "2px 8px",
          borderRadius: 999,
          background: "var(--bg-panel-2)",
          border: "1px solid var(--border)",
          color: "var(--status-pending)",
          fontSize: 11,
        },
      }),
    )),
  ];
  const footer = h(
    "div",
    { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 } },
    h("button", {
      text: "Reload",
      attrs: { type: "button" },
      style: { ...btn, ...btnAccent },
      onClick: () => resume(threadId, { action: "reload" }, status),
    }),
    h("button", {
      text: "Abort",
      attrs: { type: "button" },
      style: { ...btn, ...btnDanger },
      onClick: () => resume(threadId, { action: "abort" }, status),
    }),
    status,
  );
  return cardShell({ title: "Deadlock", id, body, raw: v, footer });
}

function cardReview(
  v: ReviewInterruptValue,
  id: string | undefined,
  threadId: string,
): HTMLElement {
  const status = h("span", { style: { color: "var(--text-dim)", fontSize: 11 } });
  const checks: HTMLInputElement[] = [];
  const list = h("div", { style: { marginTop: 6 } });
  for (const t of v.tickets) {
    const cb = h("input", { attrs: { type: "checkbox", value: t.id } });
    checks.push(cb);
    list.appendChild(
      h(
        "label",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "3px 0",
            fontSize: 12,
            cursor: "pointer",
          },
        },
        cb,
        h("span", { text: t.id, className: statusClass(t.status), style: { width: 30 } }),
        h("span", { text: t.title }),
      ),
    );
  }
  const body: HTMLElement[] = [
    h("div", {
      text: "All Tickets finished. Approve to close, Retry the selected Ticket(s), or Replan back to writeSpec.",
      style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 8 },
    }),
    list,
  ];
  const footer = h(
    "div",
    { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 } },
    h("button", {
      text: "Approve",
      attrs: { type: "button" },
      style: { ...btn, ...btnAccent },
      onClick: () => resume(threadId, { action: "approve" }, status),
    }),
    h("button", {
      text: "Retry",
      attrs: { type: "button" },
      style: btn,
      onClick: () =>
        resume(
          threadId,
          { action: "retry", ids: checks.filter((c) => c.checked).map((c) => c.value) },
          status,
        ),
    }),
    h("button", {
      text: "Replan",
      attrs: { type: "button" },
      style: { ...btn, ...btnDanger },
      onClick: () => resume(threadId, { action: "replan" }, status),
    }),
    status,
  );
  return cardShell({ title: "Review", id, body, raw: v, footer });
}

function interruptCard(intr: InterruptProjection, threadId: string): HTMLElement {
  const v = intr.value;
  switch (v.kind) {
    case "approve-spec":
      return cardApproveSpec(v, intr.id, threadId);
    case "deadlock":
      return cardDeadlock(v, intr.id, threadId);
    case "review":
      return cardReview(v, intr.id, threadId);
  }
}

// ---------------------------------------------------------------------------
// VariantB — mount
// ---------------------------------------------------------------------------

export function VariantB(root: HTMLElement, ctx: ShellContext): void {
  activeCtx = ctx;

  const state = {
    showAll: false,
    activeTab: "tickets" as TabId,
    selectedThreadId: ctx.selectedThreadId,
    dismissed: new Set<string>(),
    newRunOpen: false,
  };

  const currentList = (): ThreadListItem[] => (state.showAll ? ctx.allThreads : ctx.threads);

  const currentThread = (): ThreadListItem | null => {
    const list = currentList();
    if (state.selectedThreadId) {
      const found = list.find((t) => t.threadId === state.selectedThreadId);
      if (found) return found;
    }
    return list[0] ?? null;
  };

  const threadInterrupts = (t: ThreadListItem | null): InterruptProjection[] =>
    t ? t.interrupts : [];

  // --- top bar -------------------------------------------------------------

  const buildTopBar = (): HTMLElement => {
    const list = currentList();
    const thread = currentThread();

    const select = h("select", {
      attrs: { "aria-label": "Select thread" },
      style: {
        background: "var(--bg-panel-2)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "5px 8px",
        fontFamily: "inherit",
        fontSize: 12,
        minWidth: 220,
      },
    });
    for (const t of list) {
      const opt = document.createElement("option");
      opt.value = t.threadId;
      const origin = t.origin === "ui" ? "" : ` · ${t.origin}`;
      opt.textContent = `${t.label}${origin} — ${t.status}${t.interrupts.length ? " ⏸" : ""}`;
      if (t.threadId === thread?.threadId) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      state.selectedThreadId = select.value;
      render();
    });

    const showAllBox = document.createElement("input");
    showAllBox.type = "checkbox";
    showAllBox.checked = state.showAll;
    showAllBox.style.margin = "0";
    showAllBox.addEventListener("change", () => {
      state.showAll = showAllBox.checked;
      render();
    });
    const showAll = h(
      "label",
      {
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          color: "var(--text-dim)",
          fontSize: 12,
          cursor: "pointer",
        },
      },
      showAllBox,
      h("span", { text: "show all" }),
    );

    const newRun = h("button", {
      text: "+ New run",
      attrs: { type: "button", title: "Start a new run (opens a form)" },
      style: { ...btn, ...btnAccent },
      onClick: () => {
        state.newRunOpen = true;
        renderNewRunModal();
      },
    });

    return h(
      "header",
      { style: S.topbar },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 10 } },
        h("span", {
          text: "Tabbed Ops",
          style: { fontWeight: 700, fontSize: 14, letterSpacing: "0.04em" },
        }),
        ctx.mock ? h("span", { className: "mock-badge", text: "MOCK DATA" }) : null,
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" } },
        showAll,
        select,
        newRun,
      ),
    );
  };

  // --- tab strip -------------------------------------------------------------

  const TABS: { id: TabId; label: string }[] = [
    { id: "tickets", label: "Tickets" },
    { id: "log", label: "Log" },
    { id: "spec", label: "Spec" },
    { id: "graph", label: "Graph" },
    { id: "state", label: "State" },
  ];

  const buildTabs = (): HTMLElement => {
    const interrupts = threadInterrupts(currentThread());
    const bar = h("nav", { style: S.tabbar });
    for (const t of TABS) {
      const active = state.activeTab === t.id;
      bar.appendChild(
        h("button", {
          text: t.label,
          attrs: {
            type: "button",
            role: "tab",
            "aria-selected": active ? "true" : "false",
          },
          style: { ...S.tab, ...(active ? S.tabActive : {}) },
          onClick: () => {
            state.activeTab = t.id;
            render();
          },
        }),
      );
    }
    if (interrupts.length > 0) {
      bar.appendChild(
        h("button", {
          text: `⏸ ${interrupts.length} pending`,
          attrs: { type: "button", title: "Pending Interrupts — click to reopen the modal" },
          style: { ...S.tab, ...S.tabInterrupt },
          onClick: () => {
            const t = currentThread();
            if (t) state.dismissed.delete(t.threadId);
            updateInterruptModal();
          },
        }),
      );
    }
    return bar;
  };

  // --- panels ------------------------------------------------------------------

  const buildPanels = (): HTMLElement => {
    const thread = currentThread();
    const values = thread?.values ?? null;
    const main = h("main", { style: S.panels });
    switch (state.activeTab) {
      case "tickets":
        main.appendChild(panelTickets(values?.tickets ?? null));
        break;
      case "log":
        main.appendChild(panelLog(values?.log ?? null));
        break;
      case "spec":
        main.appendChild(panelSpec(values, thread));
        break;
      case "graph":
        main.appendChild(panelGraph(ctx.topology));
        break;
      case "state":
        main.appendChild(panelState(values, thread));
        break;
    }
    return main;
  };

  // --- interrupt modal (blocking) ----------------------------------------------

  let interruptOverlay: HTMLElement | null = null;

  const updateInterruptModal = (): void => {
    const thread = currentThread();
    const interrupts = threadInterrupts(thread);
    const show =
      !!thread && interrupts.length > 0 && !state.dismissed.has(thread.threadId);
    if (!interruptOverlay) {
      interruptOverlay = h("div", { style: S.overlay });
      modalHost.appendChild(interruptOverlay);
    }
    interruptOverlay.style.display = show ? "flex" : "none";
    if (!show) return;

    const box = h(
      "div",
      { style: S.modalBox, attrs: { role: "dialog", "aria-modal": "true" } },
      h("button", {
        text: "✕",
        attrs: { type: "button", title: "Dismiss — keep inspecting" },
        style: S.modalClose,
        onClick: () => {
          if (thread) state.dismissed.add(thread.threadId);
          updateInterruptModal();
        },
      }),
      ...interrupts.map((intr) => interruptCard(intr, thread.threadId)),
      h("div", {
        text: "decisions call resumeRun — layout spike, results are logged only",
        style: { color: "var(--text-dim)", fontSize: 10, marginTop: 6 },
      }),
    );
    interruptOverlay.replaceChildren(box);
  };

  // --- new-run modal -------------------------------------------------------------

  let newRunOverlay: HTMLElement | null = null;

  const renderNewRunModal = (): void => {
    if (!newRunOverlay) {
      newRunOverlay = h("div", {
        style: { ...S.overlay, alignItems: "flex-start", paddingTop: "10vh", zIndex: "1200" },
      });
      modalHost.appendChild(newRunOverlay);
    }
    if (!state.newRunOpen) {
      newRunOverlay.style.display = "none";
      return;
    }

    const threadId = `run-${Date.now()}`;
    const topicInput = h("input", {
      attrs: { type: "text", placeholder: "topic…", "aria-label": "Topic" },
      style: inputStyle,
    });
    const poolSelect = h("select", {
      attrs: { "aria-label": "Ticket pool" },
      style: inputStyle,
    });
    for (const p of TICKET_POOLS) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      if (p === TICKET_POOLS[0]) opt.selected = true;
      poolSelect.appendChild(opt);
    }
    const packetArea = h("textarea", {
      attrs: { rows: "5", placeholder: "optional packet text…", "aria-label": "Packet" },
      style: { ...inputStyle, resize: "vertical", minHeight: 80 },
    });
    const statusEl = h("div", {
      text: `thread ${threadId} will be created on start`,
      style: { color: "var(--text-dim)", fontSize: 11, marginBottom: 8 },
    });

    const startRun = (ev: Event): void => {
      const topic = topicInput.value.trim();
      if (!topic) {
        statusEl.textContent = "topic is required";
        return;
      }
      const target = ev.currentTarget as HTMLButtonElement;
      target.disabled = true;
      target.textContent = "running…";
      statusEl.textContent = `starting run on ${threadId}…`;
      void ctx.streamRun(threadId, {
        topic,
        ticketDir: poolSelect.value,
        packet: packetArea.value,
      }).then(
        (o) => {
          statusEl.textContent = `done — ${o.values.length} value(s) streamed (stub)`;
          target.disabled = false;
          target.textContent = "Start run";
        },
        (err) => {
          statusEl.textContent = `failed: ${String(err)}`;
          target.disabled = false;
          target.textContent = "Start run";
        },
      );
    };

    const close = (): void => {
      state.newRunOpen = false;
      renderNewRunModal();
    };

    const box = h(
      "div",
      { style: { ...S.modalBox, borderTopColor: "var(--accent)", maxWidth: 520 }, attrs: { role: "dialog", "aria-modal": "true" } },
      h("button", {
        text: "✕",
        attrs: { type: "button", title: "Close" },
        style: S.modalClose,
        onClick: close,
      }),
      h("div", { text: "New run", style: { fontWeight: 700, fontSize: 13, marginBottom: 12 } }),
      field("Topic", topicInput),
      field("Ticket pool", poolSelect),
      field("Packet (optional)", packetArea),
      statusEl,
      h(
        "div",
        { style: { display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" } },
        h("button", {
          text: "Cancel",
          attrs: { type: "button" },
          style: { ...btn, color: "var(--text-dim)" },
          onClick: close,
        }),
        h("button", {
          text: "Start run",
          attrs: { type: "button" },
          style: { ...btn, ...btnAccent },
          onClick: startRun,
        }),
      ),
    );
    newRunOverlay.replaceChildren(box);
    newRunOverlay.style.display = "flex";
  };

  // --- render ----------------------------------------------------------------------

  const render = (): void => {
    const list = currentList();
    if (state.selectedThreadId && !list.some((t) => t.threadId === state.selectedThreadId)) {
      state.selectedThreadId = list[0]?.threadId ?? null;
    }
    if (!state.selectedThreadId && list.length > 0) state.selectedThreadId = list[0].threadId;
    mainView.replaceChildren(buildTopBar(), buildTabs(), buildPanels());
    updateInterruptModal();
  };

  const container = h("div", { style: S.container });
  const mainView = h("div", { style: { display: "contents" } });
  const modalHost = h("div", { style: { display: "contents" } });
  container.append(mainView, modalHost);
  root.appendChild(container);
  render();
}
