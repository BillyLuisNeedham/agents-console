/**
 * Canvas: the graph canvas and its mechanics. One module owns pan, zoom,
 * node drag, edge routing, and the persisted card positions, as instance
 * state on the class the composition root creates once per session. The
 * render is a function of model + selection; the pointer and wheel listeners
 * bind to the freshly rebuilt viewport after every render. A card tap (a
 * press that never crosses the drag threshold) reports through the
 * `onCardTap` callback; selection itself belongs to the composition.
 */

import {
  checkpointNotice,
  edgePath,
  layoutStorageKey,
  mergeLayout,
  parseStoredLayout,
  statusLabel,
  strokeWidthForZoom,
  zoomAtCursor,
  type CardBox,
  type EdgeMode,
  type InterruptView,
  type Point,
  type PoolCardView,
  type TicketCardView,
  type TopologyEdge,
  type UtilityCardView,
  type ViewTransform,
} from "./project";
import { h } from "./dom";

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_ID = "canvas-arrow";
const CARD_WIDTH = 280;
const LAYOUT_KEY = "console-canvas-layout";
const DRAG_THRESHOLD = 4;
const WORLD_MIN_WIDTH = 960;

type Positioned = { id: string; x: number; y: number };

// The pending/queued dot every card with an interrupt carries in its head:
// a plain dot while the interrupt waits on the operator, a queued dot once
// an answer is accepted and waiting on the engine.
function interruptDot(interrupt: InterruptView): HTMLElement {
  return h("span", {
    class: interrupt.queued ? "dot dot-queued" : "dot dot-interrupt",
    title: interrupt.queued
      ? `answered · waiting · ${interrupt.kind}`
      : `interrupt · ${interrupt.kind}`,
  });
}

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

/** The slice of the app model the canvas renders from. */
export interface CanvasModel {
  cards: PoolCardView[];
  connected: boolean;
  phaseLabel: string;
  seq: number;
  error: string | null;
}

/** The selection's one-hop flow neighbourhood, computed by the composition. */
export interface CanvasSelection {
  selectedId: string | null;
  inflow: ReadonlySet<string>;
  outflow: ReadonlySet<string>;
}

export class Canvas {
  private readonly nodePos = new Map<string, Point>();
  private readonly view: ViewTransform & { seeded: boolean } = {
    x: 0,
    y: 0,
    zoom: 1,
    seeded: false,
  };
  private edgeMode: EdgeMode = "ortho";
  private canvas: CanvasBind | null = null;
  private drag: Drag | null = null;
  private readonly onCardTap: (nodeId: string) => void;

  constructor(options: { onCardTap: (nodeId: string) => void }) {
    this.onCardTap = options.onCardTap;
    if (typeof window !== "undefined") {
      window.addEventListener("pointerup", (event) => this.endDrag(event));
      window.addEventListener("pointercancel", (event) => this.endDrag(event));
    }
  }

  /**
   * Reconcile held positions with the model's cards: drop positions for cards
   * that left the pool, seed positions for cards that arrived (stored layout
   * over the model's defaults).
   */
  sync(cards: Positioned[]): void {
    const liveIds = new Set(cards.map((card) => card.id));
    for (const id of [...this.nodePos.keys()]) {
      if (!liveIds.has(id)) this.nodePos.delete(id);
    }
    this.seedPositions(cards);
  }

  /** Drop an in-flight drag: a full-DOM rebuild pulls the floor away. */
  cancelDrag(): void {
    this.endDrag();
  }

  /** The canvas is gone from the DOM (error or empty pool): unbind it. */
  unbind(): void {
    this.canvas = null;
  }

  render(model: CanvasModel, selection: CanvasSelection): HTMLElement {
    const main = h("div", { class: "main" });
    if (model.error && model.cards.length === 0) {
      main.append(h("div", { class: "error" }, model.error));
      return main;
    }
    if (model.cards.length === 0) {
      main.append(h("div", { class: "dim placeholder" }, "pool not loaded"));
      return main;
    }
    const size = this.worldSize(model.cards);
    const world = h("div", {
      class: "canvas-world",
      style: `width:${size.width}px;height:${size.height}px`,
    });
    world.append(
      this.makeSvg(),
      ...model.cards.map((card) => this.renderCard(card, selection)),
    );
    const viewport = h("div", { class: "canvas-viewport" }, world);
    main.append(this.renderCanvasHeader(model), viewport);
    return main;
  }

  /**
   * Bind the mechanics to the freshly rebuilt viewport: seed the pan on first
   * mount, draw the edges, and listen for drag, pan, and zoom gestures.
   */
  bindCanvas(
    viewport: HTMLElement,
    world: HTMLElement,
    edges: TopologyEdge[],
    selectedId: string | null,
  ): void {
    const svg = world.querySelector("svg.canvas-edges");
    if (!(svg instanceof SVGSVGElement)) return;
    const nodesById = new Map<string, HTMLElement>();
    for (const el of world.querySelectorAll<HTMLElement>("[data-node-id]")) {
      const id = el.dataset.nodeId;
      if (id) nodesById.set(id, el);
    }
    this.canvas = { viewport, world, svg, nodesById, edgeEls: [] };
    if (!this.view.seeded && viewport.clientWidth > 0) {
      this.view.seeded = true;
      this.view.x = Math.max(8, (viewport.clientWidth - WORLD_MIN_WIDTH) / 2);
      this.view.y = 8;
    }
    this.applyTransform();
    this.fitWorld(world);
    this.drawEdges(world, edges, selectedId);
    this.updateEdges();

    viewport.addEventListener("pointerdown", (event) => {
      if (this.drag) return;
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest(".node-card");
      const interactive = target?.closest(
        "button, input, select, textarea, a, summary, label",
      );
      if (card instanceof HTMLElement && !interactive) {
        const id = card.dataset.nodeId ?? "";
        this.drag = {
          kind: "node",
          nodeId: id,
          startX: event.clientX,
          startY: event.clientY,
          startNode: { ...(this.nodePos.get(id) ?? { x: 0, y: 0 }) },
          moved: false,
        };
      } else if (!card) {
        this.drag = {
          kind: "pan",
          startX: event.clientX,
          startY: event.clientY,
          startView: { x: this.view.x, y: this.view.y },
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
      if (!this.drag || !this.canvas) return;
      const dx = event.clientX - this.drag.startX;
      const dy = event.clientY - this.drag.startY;
      if (!this.drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.drag.moved = true;
      if (this.drag.kind === "node") {
        const next = {
          x: this.drag.startNode.x + dx / this.view.zoom,
          y: this.drag.startNode.y + dy / this.view.zoom,
        };
        this.nodePos.set(this.drag.nodeId, next);
        const el = this.canvas.nodesById.get(this.drag.nodeId);
        if (el) {
          el.style.left = `${next.x}px`;
          el.style.top = `${next.y}px`;
          el.classList.add("node-card-dragging");
        }
        this.fitWorld(this.canvas.world);
        this.updateEdges();
      } else {
        this.view.x = this.drag.startView.x + dx;
        this.view.y = this.drag.startView.y + dy;
        this.canvas.viewport.classList.add("canvas-panning");
        this.applyTransform();
      }
    });

    viewport.addEventListener("pointerup", (event) => this.endDrag(event));
    viewport.addEventListener("pointercancel", (event) => this.endDrag(event));
    viewport.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const next = zoomAtCursor(
          this.view,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          Math.exp(-event.deltaY * 0.0015),
        );
        this.view.x = next.x;
        this.view.y = next.y;
        this.view.zoom = next.zoom;
        this.applyTransform();
      },
      { passive: false },
    );
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  private flowClass(id: string, selection: CanvasSelection): string {
    if (id === selection.selectedId) return " node-card-selected";
    if (selection.inflow.has(id)) return " node-card-inflow";
    if (selection.outflow.has(id)) return " node-card-outflow";
    return "";
  }

  private posOf(card: Positioned): Point {
    return this.nodePos.get(card.id) ?? { x: card.x, y: card.y };
  }

  // A card is a summary: status, title, blockers, an optional grade line for
  // verified tickets, and an interrupt dot. A click selects it and opens the
  // Detail, where the ticket is read and its interrupt answered.
  private renderTicketCard(
    card: TicketCardView,
    selection: CanvasSelection,
  ): HTMLElement {
    const pos = this.posOf(card);
    const head = h(
      "div",
      { class: "node-card-head" },
      h("span", { class: "node-card-id" }, card.ticketId),
      h(
        "span",
        { class: `node-card-state ticket-state-${card.status}` },
        statusLabel(card.status),
      ),
    );
    if (card.interrupt) {
      head.append(interruptDot(card.interrupt));
    }
    const blockers =
      card.blockedByCheckpoint.length > 0
        ? h(
            "div",
            { class: "checkpoint-blocked" },
            checkpointNotice(card.blockedByCheckpoint),
          )
        : h(
            "div",
            { class: "dim ticket-card-blocked" },
            card.blockedBy.length > 0
              ? `after ${card.blockedBy.join(", ")}`
              : "no blockers",
          );
    return h(
      "div",
      {
        class:
          `node-card ticket-card ticket-card-${card.status}` +
          (card.interrupt
            ? card.interrupt.queued
              ? " ticket-card-queued"
              : " ticket-card-interrupt"
            : "") +
          this.flowClass(card.id, selection),
        "data-node-id": card.id,
        "data-ticket-id": card.ticketId,
        style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
      },
      head,
      h(
        "div",
        { class: "node-card-body" },
        h("div", { class: "card-text ticket-card-summary" }, card.title),
        blockers,
        card.grade
          ? h(
              "div",
              {
                class: `ticket-card-grade grade-${card.grade.verdict}`,
                title: `attempt ${card.grade.attempt} graded ${card.grade.score}/10, verdict ${card.grade.verdict}`,
              },
              `grade ${card.grade.score}/10 · ${card.grade.verdict}`,
            )
          : null,
      ),
    );
  }

  private renderUtilityCard(
    card: UtilityCardView,
    selection: CanvasSelection,
  ): HTMLElement {
    const pos = this.posOf(card);
    const head = h(
      "div",
      { class: "node-card-head" },
      h("span", { class: "node-card-id" }, card.label),
    );
    if (card.interrupt) {
      head.append(interruptDot(card.interrupt));
    }
    return h(
      "div",
      {
        class:
          "node-card node-card-utility" +
          (card.interrupt
            ? card.interrupt.queued
              ? " node-card-utility-queued"
              : " node-card-utility-interrupt"
            : "") +
          this.flowClass(card.id, selection),
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

  private renderCard(card: PoolCardView, selection: CanvasSelection): HTMLElement {
    if (card.kind === "ticket") return this.renderTicketCard(card, selection);
    return this.renderUtilityCard(card, selection);
  }

  private worldSize(cards: Positioned[]): { width: number; height: number } {
    let width = WORLD_MIN_WIDTH;
    let height = 400;
    for (const card of cards) {
      const pos = this.posOf(card);
      width = Math.max(width, pos.x + CARD_WIDTH + 48);
      height = Math.max(height, pos.y + 48);
    }
    return { width, height };
  }

  private renderCanvasHeader(model: CanvasModel): HTMLElement {
    const edgeToggle = h("input", {
      type: "checkbox",
      checked: this.edgeMode === "ortho",
    }) as HTMLInputElement;
    edgeToggle.addEventListener("change", () => {
      this.edgeMode = edgeToggle.checked ? "ortho" : "straight";
      this.updateEdges();
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
        h(
          "label",
          { class: "canvas-edge-toggle", title: "edge routing" },
          edgeToggle,
          "right angles",
        ),
        h(
          "button",
          { class: "btn", title: "zoom out", onclick: () => this.zoomBy(1 / 1.25) },
          "−",
        ),
        h(
          "button",
          { class: "btn", title: "zoom in", onclick: () => this.zoomBy(1.25) },
          "+",
        ),
        h(
          "button",
          { class: "btn", title: "reset pan and zoom", onclick: () => this.resetView() },
          "reset",
        ),
        h(
          "button",
          {
            class: "btn",
            title: "restore default card positions",
            onclick: () => {
              this.resetLayout(model.cards);
              this.applyPositions();
              if (this.canvas) {
                this.fitWorld(this.canvas.world);
                this.updateEdges();
              }
            },
          },
          "reset layout",
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Positions and their persistence
  // -------------------------------------------------------------------------

  private readStored(): Record<string, Point> {
    try {
      return parseStoredLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
    } catch {
      return {};
    }
  }

  private writeStored(): void {
    const stored = this.readStored();
    for (const [id, pos] of this.nodePos) stored[layoutStorageKey(id)] = pos;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
    } catch {
      // quota or private mode: layout just will not persist
    }
  }

  private seedPositions(cards: Positioned[]): void {
    const stored = this.readStored();
    const defaults: Record<string, Point> = {};
    const overrides: Record<string, Point> = {};
    for (const card of cards) {
      defaults[card.id] = { x: card.x, y: card.y };
      const saved = stored[layoutStorageKey(card.id)];
      if (saved) overrides[card.id] = saved;
    }
    const merged = mergeLayout(defaults, overrides);
    for (const card of cards) {
      if (!this.nodePos.has(card.id)) {
        this.nodePos.set(card.id, merged[card.id] ?? { x: card.x, y: card.y });
      }
    }
  }

  private resetLayout(cards: Positioned[]): void {
    const stored = this.readStored();
    for (const card of cards) {
      delete stored[layoutStorageKey(card.id)];
      this.nodePos.set(card.id, { x: card.x, y: card.y });
    }
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(stored));
    } catch {
      // ignore
    }
  }

  private applyPositions(): void {
    if (!this.canvas) return;
    for (const [id, card] of this.canvas.nodesById) {
      const pos = this.nodePos.get(id);
      if (!pos) continue;
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
    }
  }

  // -------------------------------------------------------------------------
  // Transform, edges, and drag
  // -------------------------------------------------------------------------

  private applyTransform(): void {
    if (!this.canvas) return;
    this.canvas.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
    this.paintStrokeScale();
  }

  private paintStrokeScale(): void {
    if (!this.canvas) return;
    const width = strokeWidthForZoom(this.view.zoom);
    const dash = `${4 / this.view.zoom} ${3 / this.view.zoom}`;
    for (const edge of this.canvas.edgeEls) {
      edge.el.setAttribute("stroke-width", String(width));
      if (edge.conditional) edge.el.setAttribute("stroke-dasharray", dash);
      edge.label?.setAttribute("font-size", String(10 / this.view.zoom));
    }
  }

  private updateEdges(): void {
    if (!this.canvas) return;
    const boxes = new Map<string, CardBox>();
    for (const [id, el] of this.canvas.nodesById) boxes.set(id, cardBox(el));
    for (const edge of this.canvas.edgeEls) {
      const source = boxes.get(edge.source);
      const target = boxes.get(edge.target);
      if (!source || !target) continue;
      const geom = edgePath(source, target, this.edgeMode);
      edge.el.setAttribute("d", geom.d);
      edge.label?.setAttribute("x", String(geom.lx));
      edge.label?.setAttribute("y", String(geom.ly));
    }
    this.paintStrokeScale();
  }

  private zoomBy(factor: number): void {
    if (!this.canvas) return;
    const rect = this.canvas.viewport.getBoundingClientRect();
    const next = zoomAtCursor(
      this.view,
      { x: rect.width / 2, y: rect.height / 2 },
      factor,
    );
    this.view.x = next.x;
    this.view.y = next.y;
    this.view.zoom = next.zoom;
    this.applyTransform();
  }

  private resetView(): void {
    if (!this.canvas) return;
    this.view.zoom = 1;
    const rect = this.canvas.viewport.getBoundingClientRect();
    this.view.x = Math.max(8, (rect.width - WORLD_MIN_WIDTH) / 2);
    this.view.y = 8;
    this.view.seeded = true;
    this.applyTransform();
  }

  private endDrag(event?: PointerEvent): void {
    if (!this.drag) return;
    const nodeId = this.drag.kind === "node" ? this.drag.nodeId : "";
    const wasClick = event != null && this.drag.kind === "node" && !this.drag.moved;
    if (event && this.canvas) {
      try {
        this.canvas.viewport.releasePointerCapture(event.pointerId);
      } catch {
        // never captured or already released
      }
    }
    if (this.canvas) {
      for (const card of this.canvas.nodesById.values()) {
        card.classList.remove("node-card-dragging");
      }
      this.canvas.viewport.classList.remove("canvas-panning");
    }
    if (this.drag.kind === "node" && this.drag.moved) this.writeStored();
    this.drag = null;
    if (!wasClick || !nodeId) return;
    this.onCardTap(nodeId);
  }

  private makeSvg(): SVGSVGElement {
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

  private fitWorld(world: HTMLElement): void {
    let width = world.offsetWidth;
    let height = world.offsetHeight;
    for (const el of world.querySelectorAll<HTMLElement>("[data-node-id]")) {
      width = Math.max(width, el.offsetLeft + el.offsetWidth + 48);
      height = Math.max(height, el.offsetTop + el.offsetHeight + 48);
    }
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
  }

  private drawEdges(
    world: HTMLElement,
    edges: TopologyEdge[],
    selectedId: string | null,
  ): void {
    const svg = world.querySelector("svg.canvas-edges");
    if (!(svg instanceof SVGSVGElement) || !this.canvas) return;
    for (const child of [...svg.children]) {
      if (child.tagName.toLowerCase() !== "defs") child.remove();
    }
    this.canvas.edgeEls = [];
    const boxes = new Map<string, CardBox>();
    for (const [id, el] of this.canvas.nodesById) boxes.set(id, cardBox(el));
    for (const edge of edges) {
      const source = boxes.get(edge.source);
      const target = boxes.get(edge.target);
      if (!source || !target) continue;
      const geom = edgePath(source, target, this.edgeMode);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", geom.d);
      path.setAttribute(
        "class",
        "canvas-edge" +
          (edge.conditional ? " canvas-edge-conditional" : "") +
          (edge.target === selectedId ? " canvas-edge-inflow" : "") +
          (edge.source === selectedId ? " canvas-edge-outflow" : ""),
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
      this.canvas.edgeEls.push({
        el: path,
        label,
        source: edge.source,
        target: edge.target,
        conditional: edge.conditional === true,
      });
    }
    this.paintStrokeScale();
  }
}

function cardBox(el: HTMLElement): CardBox {
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}
