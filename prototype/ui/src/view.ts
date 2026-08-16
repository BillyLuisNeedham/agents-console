/**
 * DOM rendering: a thin layer over the view model from project.ts. All data
 * flows in through `renderApp`; all user intent flows out through `Handlers`.
 */

import {
  TICKET_POOLS,
  type ChannelView,
  type NodeCardView,
  type ThreadSummary,
  type TicketView,
  type TopologyEdge,
} from "./project";

export interface StartFormModel {
  topic: string;
  ticketDir: string;
  packet: string;
  starting: boolean;
  error: string | null;
}

export interface AppModel {
  threads: ThreadSummary[];
  showAll: boolean;
  selectedId: string | null;
  cards: NodeCardView[];
  edges: TopologyEdge[];
  log: string[];
  logOpen: boolean;
  streaming: boolean;
  streamError: string | null;
  error: string | null;
  start: StartFormModel;
}

export interface Handlers {
  onSelectThread: (threadId: string) => void;
  onToggleShowAll: (showAll: boolean) => void;
  onToggleLog: () => void;
  onRefresh: () => void;
  onStartField: (field: "topic" | "ticketDir" | "packet", value: string) => void;
  onStartRun: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "checked" || key === "disabled" || key.startsWith("on")) {
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Left rail: start-run form + thread list + show-all toggle
// ---------------------------------------------------------------------------

function renderStartForm(model: AppModel, handlers: Handlers): HTMLElement {
  const start = model.start;

  const topic = h("input", {
    class: "field",
    type: "text",
    placeholder: "topic",
    value: start.topic,
    "data-field": "start-topic",
    disabled: start.starting || null,
  }) as HTMLInputElement;
  topic.addEventListener("input", () => handlers.onStartField("topic", topic.value));

  const pool = h("select", {
    class: "field",
    "data-field": "start-pool",
    disabled: start.starting || null,
  }) as HTMLSelectElement;
  for (const dir of TICKET_POOLS) {
    pool.append(h("option", { value: dir }, dir));
  }
  pool.value = start.ticketDir;
  pool.addEventListener("change", () => handlers.onStartField("ticketDir", pool.value));

  const packet = h(
    "textarea",
    {
      class: "field",
      rows: 4,
      placeholder: "packet (optional — blank uses the demo packet)",
      "data-field": "start-packet",
      disabled: start.starting || null,
    },
    start.packet,
  ) as HTMLTextAreaElement;
  packet.addEventListener("input", () => handlers.onStartField("packet", packet.value));

  const form = h(
    "form",
    { class: "start-form" },
    h("h2", {}, "start a run"),
    topic,
    pool,
    packet,
    h(
      "button",
      {
        class: "btn",
        disabled: start.starting || start.topic.trim() === "" || null,
      },
      start.starting ? "starting…" : "start run",
    ),
    start.error ? h("span", { class: "error-inline" }, start.error) : null,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handlers.onStartRun();
  });
  return form;
}


function renderRail(model: AppModel, handlers: Handlers): HTMLElement {
  const toggle = h("input", { type: "checkbox", checked: model.showAll }) as HTMLInputElement;
  toggle.addEventListener("change", () => handlers.onToggleShowAll(toggle.checked));

  const list = h("div", { class: "thread-list" });
  if (model.threads.length === 0) {
    list.append(h("div", { class: "dim" }, model.showAll ? "no threads" : "no Console threads yet"));
  }
  for (const t of model.threads) {
    const meta = h("span", {}, t.status);
    if (t.interruptCount > 0) {
      meta.append(
        h("span", {
          class: "dot dot-interrupt",
          title: `${t.interruptCount} pending interrupt${t.interruptCount === 1 ? "" : "s"}`,
        }),
      );
    }
    list.append(
      h(
        "div",
        {
          class: "thread-item" + (t.threadId === model.selectedId ? " thread-active" : ""),
          onclick: () => handlers.onSelectThread(t.threadId),
        },
        h("div", { class: "thread-label" }, t.label),
        h("div", { class: "thread-meta" }, h("span", {}, t.origin), meta),
      ),
    );
  }

  return h(
    "div",
    { class: "rail" },
    h(
      "div",
      { class: "rail-head" },
      h("h2", {}, "Threads"),
      h("label", { class: "dim checkrow" }, toggle, "show all"),
      h("button", { class: "btn", onclick: () => handlers.onRefresh() }, "refresh"),
    ),
    renderStartForm(model, handlers),
    list,
  );
}

// ---------------------------------------------------------------------------
// Main panel: graph canvas — node cards + edges
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_ID = "canvas-arrow";
const CARD_WIDTH = 280;

function ticketRow(t: TicketView): HTMLElement {
  return h(
    "div",
    { class: "ticket-row" },
    h("span", { class: `chip chip-${t.status}` }, t.id),
    h("span", { class: "dim" }, t.title),
    t.blockedBy.length > 0 ? h("span", { class: "dim" }, `after ${t.blockedBy.join(", ")}`) : null,
  );
}

function snippet(text: string, lines: number): string {
  return text.split("\n").slice(0, lines).join("\n");
}

function renderCardChannel(channel: ChannelView): HTMLElement {
  if (channel.kind === "tickets") {
    if (channel.tickets.length === 0) return h("div", { class: "dim" }, "no tickets");
    return h("div", { class: "card-channels" }, ...channel.tickets.map(ticketRow));
  }
  if (channel.kind === "pre") {
    return h("pre", { class: "card-pre" }, snippet(channel.text, 8) || "—");
  }
  if (channel.kind === "json") {
    return h("pre", { class: "card-pre" }, snippet(channel.json, 8));
  }
  return h("div", { class: "card-text" }, channel.text);
}

function statusLabel(status: NodeCardView["status"]): string {
  if (status === "active") return "running";
  if (status === "next") return "next";
  if (status === "ran") return "ran";
  return "idle";
}

function renderCard(card: NodeCardView): HTMLElement {
  const body =
    card.channels.length > 0
      ? card.channels.map(renderCardChannel)
      : [h("div", { class: "dim" }, "—")];
  return h(
    "div",
    {
      class: `node-card node-card-${card.status}`,
      "data-node-id": card.id,
      style: `left:${card.x}px;top:${card.y}px;width:${CARD_WIDTH}px`,
    },
    h(
      "div",
      { class: "node-card-head" },
      h("span", { class: "node-card-id" }, card.name),
      h("span", { class: `node-card-state node-state-${card.status}` }, statusLabel(card.status)),
    ),
    h("div", { class: "node-card-body" }, ...body),
  );
}

function worldSize(cards: NodeCardView[]): { width: number; height: number } {
  let width = 960;
  let height = 400;
  for (const card of cards) {
    width = Math.max(width, card.x + CARD_WIDTH + 48);
    height = Math.max(height, card.y + 48);
  }
  return { width, height };
}

function renderCanvasHeader(model: AppModel): HTMLElement {
  return h(
    "div",
    { class: "canvas-header" },
    model.streaming ? h("span", { class: "dot dot-live", title: "streaming" }) : null,
    h(
      "span",
      { class: "dim" },
      model.selectedId ? `thread · ${model.selectedId}` : "no thread selected",
    ),
    model.streamError ? h("span", { class: "error-inline" }, model.streamError) : null,
  );
}

function makeSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "canvas-edges");
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
  const tip = document.createElementNS(SVG_NS, "path");
  tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  tip.setAttribute("class", "canvas-arrow");
  marker.appendChild(tip);
  defs.appendChild(marker);
  svg.appendChild(defs);
  return svg;
}

function fitWorld(world: HTMLElement): void {
  let width = world.offsetWidth;
  let height = world.offsetHeight;
  for (const el of world.querySelectorAll<HTMLElement>("[data-node-id]")) {
    width = Math.max(width, el.offsetLeft + el.offsetWidth + 48);
    height = Math.max(height, el.offsetTop + el.offsetHeight + 48);
  }
  world.style.width = `${width}px`;
  world.style.height = `${height}px`;
}

function drawEdges(world: HTMLElement, edges: TopologyEdge[]): void {
  const svg = world.querySelector("svg.canvas-edges");
  if (!(svg instanceof SVGElement)) return;
  for (const child of [...svg.children]) {
    if (child.tagName.toLowerCase() !== "defs") child.remove();
  }
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const el of world.querySelectorAll<HTMLElement>("[data-node-id]")) {
    const id = el.dataset.nodeId;
    if (!id) continue;
    boxes.set(id, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  }
  for (const edge of edges) {
    const s = boxes.get(edge.source);
    const t = boxes.get(edge.target);
    if (!s || !t) continue;
    const sx = s.x + s.w / 2;
    const sy = s.y + s.h / 2;
    const tx = t.x + t.w / 2;
    const ty = t.y + t.h / 2;
    const up = ty < sy;
    const outY = up ? s.y : s.y + s.h;
    const inY = up ? t.y + t.h : t.y;
    const midY = (outY + inY) / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${sx} ${outY} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${inY}`);
    path.setAttribute(
      "class",
      "canvas-edge" + (edge.conditional ? " canvas-edge-conditional" : ""),
    );
    path.setAttribute("marker-end", `url(#${ARROW_ID})`);
    svg.appendChild(path);
  }
}

function renderMain(model: AppModel): HTMLElement {
  const main = h("div", { class: "main" });
  if (model.error) {
    main.append(h("div", { class: "error" }, model.error));
    return main;
  }
  if (model.cards.length === 0) {
    main.append(h("div", { class: "dim placeholder" }, "graph topology not loaded"));
    return main;
  }
  const size = worldSize(model.cards);
  const world = h("div", {
    class: "canvas-world",
    style: `width:${size.width}px;height:${size.height}px`,
  });
  world.append(makeSvg(), ...model.cards.map(renderCard));
  const viewport = h("div", { class: "canvas-viewport" }, world);
  main.append(renderCanvasHeader(model), viewport);
  return main;
}

// ---------------------------------------------------------------------------
// Bottom drawer: the log channel, collapsible
// ---------------------------------------------------------------------------

function renderLogDrawer(model: AppModel, handlers: Handlers): HTMLElement {
  const lines = model.log.length > 0 ? model.log.join("\n") : "— no log lines yet —";
  return h(
    "div",
    { class: "log-drawer" + (model.logOpen ? " log-open" : "") },
    h(
      "button",
      { class: "log-bar", onclick: () => handlers.onToggleLog() },
      `log (${model.log.length}) ${model.logOpen ? "▾" : "▴"}`,
    ),
    model.logOpen ? h("pre", { class: "log-lines" }, lines) : null,
  );
}

// ---------------------------------------------------------------------------

export function renderApp(root: HTMLElement, model: AppModel, handlers: Handlers): void {
  const content = h("div", { class: "content" }, renderRail(model, handlers), renderMain(model));
  root.replaceChildren(h("div", { class: "shell" }, content, renderLogDrawer(model, handlers)));
  const world = root.querySelector(".canvas-world");
  if (world instanceof HTMLElement) {
    fitWorld(world);
    drawEdges(world, model.edges);
  }
}
