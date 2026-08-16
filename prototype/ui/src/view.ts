/**
 * DOM rendering: a thin layer over the view model from project.ts. All data
 * flows in through `renderApp`; all user intent flows out through `Handlers`.
 */

import {
  TICKET_POOLS,
  edgePath,
  mergeLayout,
  parseStoredLayout,
  strokeWidthForZoom,
  isTicketCardId,
  layoutStorageKey,
  zoomAtCursor,
  type CardBox,
  type ChannelView,
  type EdgeMode,
  type InterruptDecision,
  type InterruptFormView,
  type NodeCardView,
  type Point,
  type ThreadSummary,
  type TicketCardView,
  type TicketView,
  type TopologyEdge,
  type ViewTransform,
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
  ticketCards: TicketCardView[];
  edges: TopologyEdge[];
  log: string[];
  logOpen: boolean;
  inspector: ChannelView[];
  inspectorOpen: boolean;
  streaming: boolean;
  streamError: string | null;
  error: string | null;
  start: StartFormModel;
}

export interface Handlers {
  onSelectThread: (threadId: string) => void;
  onToggleShowAll: (showAll: boolean) => void;
  onToggleLog: () => void;
  onToggleInspector: () => void;
  onRefresh: () => void;
  onStartField: (field: "topic" | "ticketDir" | "packet", value: string) => void;
  onStartRun: () => void;
  onResume: (decision: InterruptDecision) => void;
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
      placeholder: "packet (optional; blank uses the demo packet)",
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
// Main panel: graph canvas, node cards + edges
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_ID = "canvas-arrow";
const CARD_WIDTH = 280;
const LAYOUT_KEY = "console-canvas-layout";
const DRAG_THRESHOLD = 4;
const WORLD_MIN_WIDTH = 960;

const nodePos = new Map<string, Point>();
const expandedTickets = new Set<string>();
const view: ViewTransform & { seeded: boolean } = { x: 0, y: 0, zoom: 1, seeded: false };
let edgeMode: EdgeMode = "ortho";
let layoutThreadId: string | null = null;

type Positioned = { id: string; x: number; y: number };

type Drag =
  | {
      kind: "node";
      nodeId: string;
      startX: number;
      startY: number;
      startNode: Point;
      moved: boolean;
    }
  | {
      kind: "pan";
      startX: number;
      startY: number;
      startView: Point;
      moved: boolean;
    };

interface DrawnEdge {
  el: SVGPathElement;
  label: SVGTextElement | null;
  source: string;
  target: string;
  conditional: boolean;
}

interface CanvasBind {
  viewport: HTMLElement;
  world: HTMLElement;
  svg: SVGSVGElement;
  nodesById: Map<string, HTMLElement>;
  edgeEls: DrawnEdge[];
}

let canvas: CanvasBind | null = null;
let drag: Drag | null = null;

function readStored(): Record<string, Point> {
  try {
    return parseStoredLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    return {};
  }
}

function writeStored(): void {
  const stored = readStored();
  for (const [id, pos] of nodePos) stored[layoutStorageKey(id, layoutThreadId)] = pos;
  for (const key of Object.keys(stored)) {
    if (key.startsWith("ticket:")) delete stored[key];
  }
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
  } catch {
    // quota or private mode: layout just will not persist
  }
}

function seedPositions(cards: Positioned[]): void {
  const stored = readStored();
  const defaults: Record<string, Point> = {};
  const overrides: Record<string, Point> = {};
  for (const card of cards) {
    defaults[card.id] = { x: card.x, y: card.y };
    const saved = stored[layoutStorageKey(card.id, layoutThreadId)];
    if (saved) overrides[card.id] = saved;
  }
  const merged = mergeLayout(defaults, overrides);
  for (const card of cards) {
    if (!nodePos.has(card.id)) nodePos.set(card.id, merged[card.id] ?? { x: card.x, y: card.y });
  }
}

function resetLayout(cards: Positioned[]): void {
  const stored = readStored();
  for (const card of cards) {
    delete stored[layoutStorageKey(card.id, layoutThreadId)];
    nodePos.set(card.id, { x: card.x, y: card.y });
  }
  for (const key of Object.keys(stored)) {
    if (key.startsWith("ticket:")) delete stored[key];
  }
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
  } catch {
    // ignore
  }
}

function cardBox(el: HTMLElement): CardBox {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

function posOf(card: Positioned): Point {
  return nodePos.get(card.id) ?? { x: card.x, y: card.y };
}

function canvasCards(model: AppModel): Positioned[] {
  return [...model.cards, ...model.ticketCards];
}

function toggleTicketExpand(id: string): void {
  if (expandedTickets.has(id)) expandedTickets.delete(id);
  else expandedTickets.add(id);
  const el = canvas?.nodesById.get(id);
  el?.classList.toggle("ticket-card-expanded", expandedTickets.has(id));
  if (canvas) {
    fitWorld(canvas.world);
    updateEdges();
  }
}

function applyTransform(): void {
  if (!canvas) return;
  canvas.world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  paintStrokeScale();
}

function paintStrokeScale(): void {
  if (!canvas) return;
  const width = strokeWidthForZoom(view.zoom);
  const dash = `${4 / view.zoom} ${3 / view.zoom}`;
  for (const edge of canvas.edgeEls) {
    edge.el.setAttribute("stroke-width", String(width));
    if (edge.conditional) edge.el.setAttribute("stroke-dasharray", dash);
    edge.label?.setAttribute("font-size", String(10 / view.zoom));
  }
}

function updateEdges(): void {
  if (!canvas) return;
  const boxes = new Map<string, CardBox>();
  for (const [id, el] of canvas.nodesById) boxes.set(id, cardBox(el));
  for (const edge of canvas.edgeEls) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;
    const geom = edgePath(source, target, edgeMode);
    edge.el.setAttribute("d", geom.d);
    edge.label?.setAttribute("x", String(geom.lx));
    edge.label?.setAttribute("y", String(geom.ly));
  }
  paintStrokeScale();
}

function applyPositions(): void {
  if (!canvas) return;
  for (const [id, card] of canvas.nodesById) {
    const pos = nodePos.get(id);
    if (!pos) continue;
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
  }
}

function zoomBy(factor: number): void {
  if (!canvas) return;
  const rect = canvas.viewport.getBoundingClientRect();
  const next = zoomAtCursor(view, { x: rect.width / 2, y: rect.height / 2 }, factor);
  view.x = next.x;
  view.y = next.y;
  view.zoom = next.zoom;
  applyTransform();
}

function resetView(): void {
  if (!canvas) return;
  view.zoom = 1;
  const rect = canvas.viewport.getBoundingClientRect();
  view.x = Math.max(8, (rect.width - WORLD_MIN_WIDTH) / 2);
  view.y = 8;
  view.seeded = true;
  applyTransform();
}

function endDrag(event?: PointerEvent): void {
  if (!drag) return;
  if (event && canvas) {
    try {
      canvas.viewport.releasePointerCapture(event.pointerId);
    } catch {
      // never captured or already released
    }
  }
  if (canvas) {
    for (const card of canvas.nodesById.values()) card.classList.remove("node-card-dragging");
    canvas.viewport.classList.remove("canvas-panning");
  }
  const clicked =
    event != null && drag.kind === "node" && !drag.moved && isTicketCardId(drag.nodeId);
  const clickedId = drag.kind === "node" ? drag.nodeId : "";
  if (drag.kind === "node" && drag.moved) writeStored();
  drag = null;
  if (clicked) toggleTicketExpand(clickedId);
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerup", (event) => endDrag(event));
  window.addEventListener("pointercancel", (event) => endDrag(event));
}

function bindCanvas(viewport: HTMLElement, world: HTMLElement, edges: TopologyEdge[]): void {
  const svg = world.querySelector("svg.canvas-edges");
  if (!(svg instanceof SVGSVGElement)) return;
  const nodesById = new Map<string, HTMLElement>();
  for (const el of world.querySelectorAll<HTMLElement>("[data-node-id]")) {
    const id = el.dataset.nodeId;
    if (id) nodesById.set(id, el);
  }
  canvas = { viewport, world, svg, nodesById, edgeEls: [] };
  if (!view.seeded && viewport.clientWidth > 0) {
    view.seeded = true;
    view.x = Math.max(8, (viewport.clientWidth - WORLD_MIN_WIDTH) / 2);
    view.y = 8;
  }
  applyTransform();
  fitWorld(world);
  drawEdges(world, edges);
  updateEdges();

  viewport.addEventListener("pointerdown", (event) => {
    if (drag) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest(".node-card");
    const interactive = target?.closest("button, input, select, textarea, a, summary, label");
    if (card instanceof HTMLElement && !interactive) {
      const id = card.dataset.nodeId ?? "";
      drag = {
        kind: "node",
        nodeId: id,
        startX: event.clientX,
        startY: event.clientY,
        startNode: { ...(nodePos.get(id) ?? { x: 0, y: 0 }) },
        moved: false,
      };
    } else if (!card) {
      drag = {
        kind: "pan",
        startX: event.clientX,
        startY: event.clientY,
        startView: { x: view.x, y: view.y },
        moved: false,
      };
    } else {
      return;
    }
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      // pointer already gone
    }
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!drag || !canvas) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    if (drag.kind === "node") {
      const next = { x: drag.startNode.x + dx / view.zoom, y: drag.startNode.y + dy / view.zoom };
      nodePos.set(drag.nodeId, next);
      const el = canvas.nodesById.get(drag.nodeId);
      if (el) {
        el.style.left = `${next.x}px`;
        el.style.top = `${next.y}px`;
        el.classList.add("node-card-dragging");
      }
      fitWorld(canvas.world);
      updateEdges();
    } else {
      view.x = drag.startView.x + dx;
      view.y = drag.startView.y + dy;
      canvas.viewport.classList.add("canvas-panning");
      applyTransform();
    }
  });

  viewport.addEventListener("pointerup", (event) => endDrag(event));
  viewport.addEventListener("pointercancel", (event) => endDrag(event));
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const next = zoomAtCursor(
        view,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        Math.exp(-event.deltaY * 0.0015),
      );
      view.x = next.x;
      view.y = next.y;
      view.zoom = next.zoom;
      applyTransform();
    },
    { passive: false },
  );
}

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
    return h("pre", { class: "card-pre" }, snippet(channel.text, 8) || "-");
  }
  if (channel.kind === "json") {
    return h("pre", { class: "card-pre" }, snippet(channel.json, 8));
  }
  return h("div", { class: "card-text" }, channel.text);
}

function statusLabel(status: NodeCardView["status"]): string {
  if (status === "interrupted") return "interrupted";
  if (status === "active") return "running";
  if (status === "next") return "next";
  if (status === "ran") return "ran";
  return "idle";
}

function renderInterruptForm(form: InterruptFormView, handlers: Handlers): HTMLElement {
  const box = h("div", { class: "interrupt-box" }, h("div", { class: "interrupt-kind" }, `interrupt · ${form.kind}`));
  if (form.kind === "approve-spec") {
    box.append(
      h("div", { class: "dim" }, "spec waiting for your call"),
      h("pre", { class: "card-pre interrupt-spec" }, form.spec || "-"),
      ...form.tickets.map(ticketRow),
      h(
        "div",
        { class: "interrupt-actions" },
        h("button", { class: "btn btn-primary", onclick: () => handlers.onResume({ action: "approve" }) }, "approve"),
        h("button", { class: "btn btn-danger", onclick: () => handlers.onResume({ action: "reject" }) }, "reject"),
      ),
    );
  } else if (form.kind === "deadlock") {
    box.append(
      h("div", { class: "dim" }, "blocked tickets can't start"),
      h(
        "div",
        { class: "ticket-row" },
        ...form.pending.map((id) => h("span", { class: "chip chip-pending" }, id)),
      ),
      h("div", { class: "card-text" }, form.hint),
      h(
        "div",
        { class: "interrupt-actions" },
        h("button", { class: "btn btn-primary", onclick: () => handlers.onResume({ action: "reload" }) }, "reload"),
        h("button", { class: "btn btn-danger", onclick: () => handlers.onResume({ action: "abort" }) }, "abort"),
      ),
    );
  } else {
    const checks = new Map<string, HTMLInputElement>();
    const rows = form.tickets.map((ticket) => {
      const cb = h("input", { type: "checkbox", value: ticket.id }) as HTMLInputElement;
      checks.set(ticket.id, cb);
      return h(
        "label",
        { class: "checkrow interrupt-check" },
        cb,
        h("span", { class: `chip chip-${ticket.status}` }, ticket.id),
        h("span", { class: "dim" }, ticket.title),
      );
    });
    const retry = h("button", { class: "btn" }, "retry") as HTMLButtonElement;
    retry.disabled = true;
    retry.addEventListener("click", () => {
      const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
      handlers.onResume({ action: "retry", ids });
    });
    for (const [, cb] of checks) {
      cb.addEventListener("change", () => {
        retry.disabled = ![...checks.values()].some((c) => c.checked);
      });
    }
    box.append(
      h("div", { class: "dim" }, "all tickets implemented; your call"),
      ...rows,
      h(
        "div",
        { class: "interrupt-actions" },
        h("button", { class: "btn btn-primary", onclick: () => handlers.onResume({ action: "approve" }) }, "approve"),
        retry,
        h("button", { class: "btn", onclick: () => handlers.onResume({ action: "replan" }) }, "replan"),
      ),
    );
  }
  box.append(
    h(
      "details",
      { class: "interrupt-raw" },
      h("summary", {}, "raw payload"),
      h("pre", {}, JSON.stringify(form.raw, null, 2)),
    ),
  );
  return box;
}

function renderTicketCard(card: TicketCardView): HTMLElement {
  const pos = posOf(card);
  const expanded = expandedTickets.has(card.id);
  const blocked =
    card.status === "pending" && card.blockedBy.length > 0
      ? h("div", { class: "dim ticket-card-blocked" }, `blockedBy ${card.blockedBy.join(", ")}`)
      : null;
  const details = h(
    "div",
    { class: "ticket-card-details" },
    h("div", { class: "card-text" }, `id ${card.ticketId}`),
    h("div", { class: "card-text" }, card.title),
    h("div", { class: "dim" }, `status ${card.status}`),
    h(
      "div",
      { class: "dim" },
      card.blockedBy.length > 0 ? `blockedBy ${card.blockedBy.join(", ")}` : "blockedBy none",
    ),
  );
  return h(
    "div",
    {
      class:
        `node-card ticket-card ticket-card-${card.status}` +
        (expanded ? " ticket-card-expanded" : ""),
      "data-node-id": card.id,
      style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
    },
    h(
      "div",
      { class: "node-card-head" },
      h("span", { class: "node-card-id" }, card.ticketId),
      h("span", { class: `node-card-state ticket-state-${card.status}` }, card.status),
    ),
    h(
      "div",
      { class: "node-card-body" },
      h("div", { class: "card-text ticket-card-summary" }, card.title),
      blocked,
      details,
    ),
  );
}

function renderCard(card: NodeCardView, handlers: Handlers): HTMLElement {
  const body =
    card.channels.length > 0
      ? card.channels.map(renderCardChannel)
      : card.interrupt
        ? []
        : [h("div", { class: "dim" }, "-")];
  if (card.interrupt) body.push(renderInterruptForm(card.interrupt, handlers));
  const pos = posOf(card);
  return h(
    "div",
    {
      class: `node-card node-card-${card.status}`,
      "data-node-id": card.id,
      style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
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

function worldSize(cards: Positioned[]): { width: number; height: number } {
  let width = WORLD_MIN_WIDTH;
  let height = 400;
  for (const card of cards) {
    const pos = posOf(card);
    width = Math.max(width, pos.x + CARD_WIDTH + 48);
    height = Math.max(height, pos.y + 48);
  }
  return { width, height };
}

function renderCanvasHeader(model: AppModel): HTMLElement {
  const edgeToggle = h("input", {
    type: "checkbox",
    checked: edgeMode === "ortho",
  }) as HTMLInputElement;
  edgeToggle.addEventListener("change", () => {
    edgeMode = edgeToggle.checked ? "ortho" : "straight";
    updateEdges();
  });
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
    h(
      "div",
      { class: "canvas-tools" },
      h("label", { class: "canvas-edge-toggle", title: "edge routing" }, edgeToggle, "right angles"),
      h("button", { class: "btn", title: "zoom out", onclick: () => zoomBy(1 / 1.25) }, "−"),
      h("button", { class: "btn", title: "zoom in", onclick: () => zoomBy(1.25) }, "+"),
      h("button", { class: "btn", title: "reset pan and zoom", onclick: () => resetView() }, "reset"),
      h(
        "button",
        {
          class: "btn",
          title: "restore default card positions",
          onclick: () => {
            resetLayout(canvasCards(model));
            applyPositions();
            if (canvas) {
              fitWorld(canvas.world);
              updateEdges();
            }
          },
        },
        "reset layout",
      ),
    ),
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
  if (!(svg instanceof SVGSVGElement) || !canvas) return;
  for (const child of [...svg.children]) {
    if (child.tagName.toLowerCase() !== "defs") child.remove();
  }
  canvas.edgeEls = [];
  const boxes = new Map<string, CardBox>();
  for (const [id, el] of canvas.nodesById) boxes.set(id, cardBox(el));
  for (const edge of edges) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;
    const geom = edgePath(source, target, edgeMode);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", geom.d);
    path.setAttribute(
      "class",
      "canvas-edge" + (edge.conditional ? " canvas-edge-conditional" : ""),
    );
    path.setAttribute("marker-end", `url(#${ARROW_ID})`);
    svg.appendChild(path);
    let label: SVGTextElement | null = null;
    if (edge.data) {
      label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "canvas-edge-label");
      label.setAttribute("x", String(geom.lx));
      label.setAttribute("y", String(geom.ly));
      label.textContent = edge.data;
      svg.appendChild(label);
    }
    canvas.edgeEls.push({
      el: path,
      label,
      source: edge.source,
      target: edge.target,
      conditional: edge.conditional === true,
    });
  }
  paintStrokeScale();
}

function renderMain(model: AppModel, handlers: Handlers): HTMLElement {
  const main = h("div", { class: "main" });
  if (model.error) {
    main.append(h("div", { class: "error" }, model.error));
    return main;
  }
  if (model.cards.length === 0) {
    main.append(h("div", { class: "dim placeholder" }, "graph topology not loaded"));
    return main;
  }
  const size = worldSize(canvasCards(model));
  const world = h("div", {
    class: "canvas-world",
    style: `width:${size.width}px;height:${size.height}px`,
  });
  world.append(
    makeSvg(),
    ...model.cards.map((card) => renderCard(card, handlers)),
    ...model.ticketCards.map(renderTicketCard),
  );
  const viewport = h("div", { class: "canvas-viewport" }, world);
  main.append(renderCanvasHeader(model), viewport);
  return main;
}

// ---------------------------------------------------------------------------
// Bottom drawers: log channel and full State inspector, side by side
// ---------------------------------------------------------------------------

function renderLogDrawer(model: AppModel, handlers: Handlers): HTMLElement {
  const lines = model.log.length > 0 ? model.log.join("\n") : "- no log lines yet -";
  return h(
    "div",
    { class: "log-drawer" + (model.logOpen ? " log-open" : "") },
    h(
      "button",
      { class: "drawer-bar", onclick: () => handlers.onToggleLog() },
      `log (${model.log.length}) ${model.logOpen ? "▾" : "▴"}`,
    ),
    model.logOpen ? h("pre", { class: "log-lines" }, lines) : null,
  );
}

function renderInspectorChannel(channel: ChannelView): HTMLElement {
  let body: HTMLElement;
  if (channel.kind === "tickets") {
    body =
      channel.tickets.length === 0
        ? h("div", { class: "channel-body dim" }, "no tickets")
        : h("div", { class: "channel-body" }, ...channel.tickets.map(ticketRow));
  } else if (channel.kind === "pre") {
    body = h("pre", { class: "channel-pre" }, channel.text || "-");
  } else if (channel.kind === "json") {
    body = h("pre", { class: "channel-pre" }, channel.json);
  } else {
    body = h("div", { class: "channel-body" }, channel.text);
  }
  return h("div", { class: "channel" }, h("div", { class: "channel-name" }, channel.name), body);
}

function renderInspectorDrawer(model: AppModel, handlers: Handlers): HTMLElement {
  const body =
    model.inspector.length > 0
      ? h("div", { class: "inspector-channels" }, ...model.inspector.map(renderInspectorChannel))
      : h("div", { class: "inspector-empty dim" }, "- no state yet -");
  return h(
    "div",
    { class: "inspector-drawer" + (model.inspectorOpen ? " inspector-open" : "") },
    h(
      "button",
      { class: "drawer-bar", onclick: () => handlers.onToggleInspector() },
      `state (${model.inspector.length}) ${model.inspectorOpen ? "▾" : "▴"}`,
    ),
    model.inspectorOpen ? body : null,
  );
}

function renderDrawers(model: AppModel, handlers: Handlers): HTMLElement {
  return h(
    "div",
    { class: "drawers" },
    renderLogDrawer(model, handlers),
    renderInspectorDrawer(model, handlers),
  );
}

// ---------------------------------------------------------------------------

export function renderApp(root: HTMLElement, model: AppModel, handlers: Handlers): void {
  endDrag();
  if (model.selectedId !== layoutThreadId) {
    for (const id of [...nodePos.keys()]) {
      if (isTicketCardId(id)) nodePos.delete(id);
    }
    layoutThreadId = model.selectedId;
  }
  const liveTicketIds = new Set(model.ticketCards.map((card) => card.id));
  for (const id of [...expandedTickets]) {
    if (!liveTicketIds.has(id)) expandedTickets.delete(id);
  }
  for (const id of [...nodePos.keys()]) {
    if (isTicketCardId(id) && !liveTicketIds.has(id)) nodePos.delete(id);
  }
  seedPositions(canvasCards(model));
  const content = h("div", { class: "content" }, renderRail(model, handlers), renderMain(model, handlers));
  root.replaceChildren(h("div", { class: "shell" }, content, renderDrawers(model, handlers)));
  const world = root.querySelector(".canvas-world");
  const viewport = root.querySelector(".canvas-viewport");
  if (world instanceof HTMLElement && viewport instanceof HTMLElement) {
    bindCanvas(viewport, world, model.edges);
  } else {
    canvas = null;
  }
}
