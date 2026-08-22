/**
 * DOM rendering: a thin layer over the view model from project.ts. All data
 * flows in through `renderApp`; all user intent flows out through `Handlers`.
 * The canvas mechanics (pan, zoom, drag, edge routing, persisted positions)
 * are unchanged from the thread-driven Console; only what a card is changed:
 * the pool renders ticket cards and the start/review utility cards.
 */

import {
  clampDrawersHeight,
  DRAWER_DEFAULT_VH,
  edgePath,
  flowNeighbourhood,
  mergeLayout,
  parseStoredLayout,
  strokeWidthForZoom,
  layoutStorageKey,
  nextNodeSelection,
  zoomAtCursor,
  type CardBox,
  type DetailView,
  type EdgeMode,
  type InterruptAction,
  type InterruptView,
  type Point,
  type PoolCardView,
  type PoolPhase,
  type PoolStatus,
  type TicketCardView,
  type TopologyEdge,
  type TimelineView,
  type UtilityCardView,
  type ViewTransform,
} from "./project";

export interface AppModel {
  phase: PoolPhase | null;
  phaseLabel: string;
  cards: PoolCardView[];
  edges: TopologyEdge[];
  log: string[];
  logOpen: boolean;
  inspectorJson: string;
  inspectorOpen: boolean;
  connected: boolean;
  seq: number;
  error: string | null;
  detail: DetailView | null;
  timeline: TimelineView | null;
}

export interface Handlers {
  onToggleLog: () => void;
  onToggleInspector: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onAnswer: (ticketId: string, action: InterruptAction, note?: string) => void;
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

// ---------------------------------------------------------------------------
// Main panel: graph canvas, cards + edges
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_ID = "canvas-arrow";
const CARD_WIDTH = 280;
const LAYOUT_KEY = "console-canvas-layout";
const DRAG_THRESHOLD = 4;
const WORLD_MIN_WIDTH = 960;

const nodePos = new Map<string, Point>();
const view: ViewTransform & { seeded: boolean } = { x: 0, y: 0, zoom: 1, seeded: false };
let edgeMode: EdgeMode = "ortho";

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

// Detail panel selection: module scope so it survives the full-DOM rebuild on
// every render (snapshots never close the panel or lose the selection).
let selectedNodeId: string | null = null;
let onSelectNode: ((nodeId: string | null) => void) | null = null;

// The selection's one-hop flow neighbourhood: module scope alongside the
// selection, recomputed from the model's edges on every render, so a live
// snapshot re-derives the highlight instead of stripping it.
let flowInflow = new Set<string>();
let flowOutflow = new Set<string>();

function flowClass(id: string): string {
  if (id === selectedNodeId) return " node-card-selected";
  if (flowInflow.has(id)) return " node-card-inflow";
  if (flowOutflow.has(id)) return " node-card-outflow";
  return "";
}

// Drawers strip height: module scope so it survives re-renders while snapshots
// stream. One shared vh height drives both drawer bodies.
let drawersHeight = DRAWER_DEFAULT_VH;
let drawerDrag: { startY: number; startHeight: number } | null = null;

// Interrupt note drafts, keyed by ticket id: module scope so a snapshot
// re-render (siblings keep running while an interrupt waits) never wipes a
// note being typed. Drafts are pruned when their interrupt resolves. Focus
// and cursor are restored across the rebuild via the textarea's
// data-note-key.
const interruptDrafts = new Map<string, string>();

function readStored(): Record<string, Point> {
  try {
    return parseStoredLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
  } catch {
    return {};
  }
}

function writeStored(): void {
  const stored = readStored();
  for (const [id, pos] of nodePos) stored[layoutStorageKey(id)] = pos;
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
    const saved = stored[layoutStorageKey(card.id)];
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
    delete stored[layoutStorageKey(card.id)];
    nodePos.set(card.id, { x: card.x, y: card.y });
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
  return model.cards;
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
  const nodeId = drag.kind === "node" ? drag.nodeId : "";
  const wasClick = event != null && drag.kind === "node" && !drag.moved;
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
  if (drag.kind === "node" && drag.moved) writeStored();
  drag = null;
  if (!wasClick || !nodeId) return;
  selectNode(nodeId);
}

function selectNode(nodeId: string): void {
  selectedNodeId = nextNodeSelection(selectedNodeId, nodeId);
  onSelectNode?.(selectedNodeId);
}

function closeDetail(): void {
  selectedNodeId = null;
  onSelectNode?.(null);
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

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function statusLabel(status: PoolStatus): string {
  return status === "in-progress" ? "running" : status;
}

// One interrupt form shape, rendered in the Detail: the only place an
// interrupt is read and answered. The kind-specific body comes from the
// engine: a checkpoint's Brief, a crash's log path, a conflict's resolution
// or attempt.
function renderInterrupt(interrupt: InterruptView, handlers: Handlers): HTMLElement {
  const box = h(
    "div",
    { class: "interrupt-box" },
    h("span", { class: "interrupt-kind" }, interrupt.form.title),
    h("pre", { class: "interrupt-body" }, interrupt.body || "(no details)"),
  );
  const note = h("textarea", {
    class: "interrupt-note",
    placeholder:
      interrupt.form.notePlaceholder ?? "note (optional, appended to the Issue)",
    "data-note-key": `${interrupt.ticketId}:detail`,
    rows: 3,
  }) as HTMLTextAreaElement;
  note.value = interruptDrafts.get(interrupt.ticketId) ?? "";
  note.addEventListener("input", () => {
    interruptDrafts.set(interrupt.ticketId, note.value);
  });
  box.append(note);
  box.append(
    h(
      "div",
      { class: "interrupt-actions" },
      ...interrupt.form.actions.map(({ action, label, tone }) =>
        h(
          "button",
          {
            class: "btn" + (tone === "primary" ? " btn-primary" : " btn-danger"),
            onclick: () =>
              handlers.onAnswer(
                interrupt.ticketId,
                action,
                interruptDrafts.get(interrupt.ticketId),
              ),
          },
          label,
        ),
      ),
    ),
  );
  return box;
}

// A card is a summary: status, title, blockers, and an interrupt dot. A
// click selects it and opens the Detail, where the ticket is read and its
// interrupt answered.
function renderTicketCard(card: TicketCardView): HTMLElement {
  const pos = posOf(card);
  const head = h(
    "div",
    { class: "node-card-head" },
    h("span", { class: "node-card-id" }, card.ticketId),
    h("span", { class: `node-card-state ticket-state-${card.status}` }, statusLabel(card.status)),
  );
  if (card.interrupt) {
    head.append(h("span", { class: "dot dot-interrupt", title: `interrupt · ${card.interrupt.kind}` }));
  }
  return h(
    "div",
    {
      class:
        `node-card ticket-card ticket-card-${card.status}` +
        (card.interrupt ? " ticket-card-interrupt" : "") +
        flowClass(card.id),
      "data-node-id": card.id,
      style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
    },
    head,
    h(
      "div",
      { class: "node-card-body" },
      h("div", { class: "card-text ticket-card-summary" }, card.title),
      h("div", { class: "dim ticket-card-blocked" },
        card.blockedBy.length > 0 ? `after ${card.blockedBy.join(", ")}` : "no blockers"),
    ),
  );
}

function renderUtilityCard(card: UtilityCardView): HTMLElement {
  const pos = posOf(card);
  const head = h(
    "div",
    { class: "node-card-head" },
    h("span", { class: "node-card-id" }, card.label),
  );
  if (card.interrupt) {
    head.append(h("span", { class: "dot dot-interrupt", title: `interrupt · ${card.interrupt.kind}` }));
  }
  return h(
    "div",
    {
      class:
        "node-card node-card-utility" +
        (card.interrupt ? " node-card-utility-interrupt" : "") +
        flowClass(card.id),
      "data-node-id": card.id,
      style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
    },
    head,
    h(
      "div",
      { class: "node-card-body" },
      h("div", { class: "dim" }, "utility"),
    ),
  );
}

function renderCard(card: PoolCardView): HTMLElement {
  if (card.kind === "ticket") return renderTicketCard(card);
  return renderUtilityCard(card);
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
    h(
      "span",
      { class: "dim" },
      model.connected
        ? `pool · ${model.phaseLabel} · snapshot ${model.seq}`
        : "pool · connecting",
    ),
    model.error ? h("span", { class: "error-inline" }, model.error) : null,
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
      "canvas-edge" +
        (edge.conditional ? " canvas-edge-conditional" : "") +
        (edge.target === selectedNodeId ? " canvas-edge-inflow" : "") +
        (edge.source === selectedNodeId ? " canvas-edge-outflow" : ""),
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
  if (model.error && model.cards.length === 0) {
    main.append(h("div", { class: "error" }, model.error));
    return main;
  }
  if (model.cards.length === 0) {
    main.append(h("div", { class: "dim placeholder" }, "pool not loaded"));
    return main;
  }
  const size = worldSize(canvasCards(model));
  const world = h("div", {
    class: "canvas-world",
    style: `width:${size.width}px;height:${size.height}px`,
  });
  world.append(makeSvg(), ...model.cards.map((card) => renderCard(card)));
  const viewport = h("div", { class: "canvas-viewport" }, world);
  main.append(renderCanvasHeader(model), viewport);
  return main;
}

// ---------------------------------------------------------------------------
// Detail panel: right-hand flex sibling for the selected card
// ---------------------------------------------------------------------------

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

// The ticket's timeline: one row per attempt with its events, read from the
// events endpoint and rendered under the interrupt form. The currently
// running attempt is marked; a reconstructed timeline (a pre-feature pool
// with no events file) notes that its rows came from log files.
function renderTimelineSection(timeline: TimelineView): HTMLElement {
  const body = h("div", { class: "timeline" });
  body.append(h("div", { class: "dim" }, "timeline"));
  if (timeline.attempts.length === 0) {
    body.append(h("div", { class: "dim timeline-empty" }, "no attempts yet"));
    return body;
  }
  if (timeline.reconstructed) {
    body.append(
      h(
        "div",
        { class: "dim timeline-note" },
        "attempts reconstructed from log files",
      ),
    );
  }
  for (const attempt of timeline.attempts) {
    const row = h(
      "div",
      {
        class:
          "timeline-attempt" +
          (attempt.running ? " timeline-attempt-running" : ""),
      },
    );
    row.append(
      h(
        "div",
        { class: "timeline-attempt-head" },
        h(
          "span",
          { class: "timeline-attempt-number" },
          `attempt ${attempt.number}`,
        ),
        attempt.running
          ? h("span", { class: "timeline-running" }, "running")
          : null,
        attempt.reconstructed
          ? h("span", { class: "dim" }, "reconstructed")
          : null,
      ),
    );
    if (attempt.events.length === 0) {
      row.append(
        h("div", { class: "dim timeline-event" }, "no events recorded"),
      );
    } else {
      for (const event of attempt.events) {
        row.append(
          h(
            "div",
            { class: "timeline-event" },
            h("span", { class: "timeline-event-kind" }, event.kind),
            h("span", { class: "dim timeline-event-at" }, formatEventTime(event.at)),
          ),
        );
      }
    }
    body.append(row);
  }
  return body;
}

function renderTicketDetail(
  detail: Extract<DetailView, { kind: "ticket" }>,
  timeline: TimelineView | null,
  handlers: Handlers,
): HTMLElement {
  const body = h("div", { class: "detail-body" });
  body.append(
    h("div", { class: "dim" }, "status"),
    h("div", { class: `detail-status ticket-state-${detail.status}` }, statusLabel(detail.status)),
    h("div", { class: "dim" }, "blocked by"),
    h(
      "div",
      { class: "card-text" },
      detail.blockedBy.length > 0 ? detail.blockedBy.join(", ") : "none",
    ),
  );
  if (detail.interrupt) {
    body.append(renderInterrupt(detail.interrupt, handlers));
  }
  if (timeline) {
    body.append(renderTimelineSection(timeline));
  }
  if (detail.outcome) {
    body.append(
      h("div", { class: "dim" }, "outcome"),
      h("pre", { class: "detail-pre" }, detail.outcome.summary || "-"),
    );
    if (detail.outcome.commitSha) {
      body.append(h("div", { class: "dim" }, `commit ${detail.outcome.commitSha}`));
    }
  }
  return body;
}

function renderUtilityDetail(
  detail: Extract<DetailView, { kind: "utility" }>,
  handlers: Handlers,
): HTMLElement {
  const body = h(
    "div",
    { class: "detail-body" },
    h("div", { class: "dim" }, "kind"),
    h("div", { class: "card-text" }, "utility card"),
    h("div", { class: "dim" }, "label"),
    h("div", { class: "card-text" }, detail.label),
  );
  if (detail.interrupt) {
    body.append(renderInterrupt(detail.interrupt, handlers));
  }
  return body;
}

function renderDetail(model: AppModel, handlers: Handlers): HTMLElement {
  const detail = h("div", { class: "detail" });
  const view = model.detail;
  if (!view) return detail;
  detail.classList.add("detail-open");
  const title = view.kind === "ticket" ? view.ticketId : view.label;
  detail.append(
    h(
      "div",
      { class: "detail-head" },
      h("span", { class: "detail-title" }, title),
      h(
        "button",
        { class: "btn", title: "close detail", onclick: () => closeDetail() },
        "✕",
      ),
    ),
    view.kind === "ticket"
      ? renderTicketDetail(view, model.timeline, handlers)
      : renderUtilityDetail(view, handlers),
  );
  return detail;
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
    model.logOpen
      ? h("pre", { class: "log-lines", style: `height:${drawersHeight}vh` }, lines)
      : null,
  );
}

function renderInspectorDrawer(model: AppModel, handlers: Handlers): HTMLElement {
  const body = h("pre", { class: "inspector-channels", style: `height:${drawersHeight}vh` }, model.inspectorJson);
  return h(
    "div",
    { class: "inspector-drawer" + (model.inspectorOpen ? " inspector-open" : "") },
    h(
      "button",
      { class: "drawer-bar", onclick: () => handlers.onToggleInspector() },
      `state ${model.inspectorOpen ? "▾" : "▴"}`,
    ),
    model.inspectorOpen ? body : null,
  );
}

function drawerBodies(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".log-lines, .inspector-channels"));
}

function applyDrawersHeight(): void {
  const height = `${drawersHeight}vh`;
  for (const body of drawerBodies()) body.style.height = height;
}

function bindDrawerHandle(handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (event) => {
    if (drawerDrag) return;
    drawerDrag = { startY: event.clientY, startHeight: drawersHeight };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // pointer already gone
    }
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drawerDrag) return;
    const dy = event.clientY - drawerDrag.startY;
    const vhPerPx = 100 / window.innerHeight;
    drawersHeight = clampDrawersHeight(drawerDrag.startHeight - dy * vhPerPx);
    applyDrawersHeight();
  });
  handle.addEventListener("pointerup", () => {
    drawerDrag = null;
  });
  handle.addEventListener("pointercancel", () => {
    drawerDrag = null;
  });
}

function renderDrawers(model: AppModel, handlers: Handlers): HTMLElement {
  const handle = h("div", { class: "drawer-handle", title: "drag to resize drawers" });
  bindDrawerHandle(handle);
  const row = h(
    "div",
    { class: "drawer-row" },
    renderLogDrawer(model, handlers),
    renderInspectorDrawer(model, handlers),
  );
  return h("div", { class: "drawers" }, handle, row);
}

// ---------------------------------------------------------------------------

export function renderApp(root: HTMLElement, model: AppModel, handlers: Handlers): void {
  endDrag();
  drawerDrag = null;
  onSelectNode = handlers.onSelectNode;
  const liveIds = new Set(model.cards.map((card) => card.id));
  for (const id of [...nodePos.keys()]) {
    if (!liveIds.has(id)) nodePos.delete(id);
  }
  const pendingInterrupts = new Set(
    model.cards.flatMap((card) => (card.interrupt ? [card.interrupt.ticketId] : [])),
  );
  for (const id of [...interruptDrafts.keys()]) {
    if (!pendingInterrupts.has(id)) interruptDrafts.delete(id);
  }
  // Preserve a note being typed across the rebuild: text lives in
  // interruptDrafts, focus and cursor are restored after the swap.
  let noteFocus: { key: string; start: number; end: number } | null = null;
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.dataset.noteKey) {
    noteFocus = {
      key: active.dataset.noteKey,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  seedPositions(canvasCards(model));
  const hood = flowNeighbourhood(model.edges, selectedNodeId);
  flowInflow = new Set(hood.inflow);
  flowOutflow = new Set(hood.outflow);
  const content = h(
    "div",
    { class: "content" },
    renderMain(model, handlers),
    renderDetail(model, handlers),
  );
  root.replaceChildren(h("div", { class: "shell" }, content, renderDrawers(model, handlers)));
  if (noteFocus) {
    const next = root.querySelector<HTMLTextAreaElement>(
      `textarea[data-note-key="${CSS.escape(noteFocus.key)}"]`,
    );
    if (next) {
      next.focus();
      next.setSelectionRange(
        Math.min(noteFocus.start, next.value.length),
        Math.min(noteFocus.end, next.value.length),
      );
    }
  }
  const world = root.querySelector(".canvas-world");
  const viewport = root.querySelector(".canvas-viewport");
  if (world instanceof HTMLElement && viewport instanceof HTMLElement) {
    bindCanvas(viewport, world, model.edges);
  } else {
    canvas = null;
  }
}
