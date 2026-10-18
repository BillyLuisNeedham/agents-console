import type { PlanFile, PlanNodeKind, PlanProblem } from "../../protocol/wire.ts";
import { h } from "./dom";
import { nextFrame } from "./frame";
import { zoomAtCursor, type Point, type ViewTransform } from "./geometry";
import {
  CARD_H,
  CARD_W,
  KIND_LABEL,
  edgeDomKey,
  edgeKeyText,
  fitView,
  freeSpot,
  hitNode,
  projectPlan,
  type DrawnEdge,
  type DrawnNode,
  type EdgeKey,
  type PlanDrawing,
} from "./plan-projection";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD = 4;
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_PADDING = 12;
export const VIEW_ORIGIN: Point = { x: 24, y: 24 };

export type PlanSelection = { kind: "node"; id: string } | { kind: "edge"; key: EdgeKey } | null;

export const SHELF: readonly PlanNodeKind[] = [
  "conversation",
  "agent",
  "prove",
  "review",
  "decide",
  "gate",
  "finish",
];

export interface PlanCanvasModel {
  fitKey: string;
  plan: PlanFile;
  problems: readonly PlanProblem[];
  verdicts: ReadonlyMap<string, readonly string[]>;
  pendingDrops: ReadonlyMap<string, Point>;
  selection: PlanSelection;
  editable: boolean;
}

export interface PlanCanvasEvents {
  select(selection: PlanSelection): void;
  move(id: string, at: Point): void;
  link(key: EdgeKey): void;
  add(kind: PlanNodeKind, at: Point): void;
  remove(selection: Exclude<PlanSelection, null>): void;
}

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; start: Point; startView: Point; tap: PlanSelection; moved: boolean }
  | { kind: "node"; id: string; start: Point; startAt: Point; at: Point; moved: boolean }
  | { kind: "link"; from: string; on: string; start: Point; end: Point; over: string | null; moved: boolean };

export class PlanCanvas {
  private view: ViewTransform = { ...VIEW_ORIGIN, zoom: 1 };
  private gesture: Gesture = { kind: "none" };
  private model: PlanCanvasModel | null = null;
  private drawing: PlanDrawing | null = null;
  private viewport: HTMLElement | null = null;
  private fitted: { key: string; size: { w: number; h: number } } | null = null;
  private adjusted = false;
  private resizes: ResizeObserver | null = null;
  private framePending = false;

  constructor(private readonly events: PlanCanvasEvents) {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.gesture.kind === "link") this.cancelGesture();
      });
    }
  }

  render(model: PlanCanvasModel): HTMLElement {
    this.model = model;
    const drawing = this.project();
    const g = this.gesture;
    const viewport = h(
      "div",
      {
        class:
          "plan-viewport" +
          (g.kind === "pan" && g.moved ? " plan-panning" : "") +
          (g.kind === "link" && g.moved ? " plan-linking" : ""),
        key: "plan-viewport",
        tabindex: "0",
        onpointerdown: (event: PointerEvent) => this.pointerDown(event),
        onpointermove: (event: PointerEvent) => this.pointerMove(event),
        onpointerup: (event: PointerEvent) => this.endGesture(event),
        onpointercancel: () => this.cancelGesture(),
        onwheel: (event: WheelEvent) => this.wheel(event),
        onkeydown: (event: KeyboardEvent) => this.keyDown(event),
      },
      h(
        "div",
        { class: "plan-world", style: `transform:${this.transform()}` },
        this.renderEdges(drawing),
        ...drawing.nodes.map((node) => this.renderNode(node)),
      ),
    );
    return h(
      "div",
      { class: "plan-canvas", key: "plan-canvas" },
      h(
        "div",
        { class: "plan-shelf" },
        model.editable ? h("span", { class: "plan-shelf-label" }, "put down") : null,
        ...(model.editable
          ? SHELF.map((kind) =>
              h(
                "button",
                {
                  class: "btn plan-shelf-add",
                  type: "button",
                  key: `add-${kind}`,
                  "data-kind": kind,
                  title: `add a ${KIND_LABEL[kind]} node in view`,
                  onclick: () => this.events.add(kind, this.freeSpotInView()),
                },
                KIND_LABEL[kind],
              ),
            )
          : []),
        h("span", { class: "plan-shelf-sep" }),
        h("button", { class: "btn", type: "button", title: "zoom out", onclick: () => this.zoomBy(1 / 1.25) }, "−"),
        h("button", { class: "btn", type: "button", title: "zoom in", onclick: () => this.zoomBy(1.25) }, "+"),
        h("button", { class: "btn plan-fit", type: "button", title: "frame every node", onclick: () => this.fit() }, "fit"),
      ),
      viewport,
    );
  }

  bind(viewport: HTMLElement): void {
    if (this.viewport !== viewport && typeof ResizeObserver !== "undefined") {
      this.resizes?.disconnect();
      this.resizes = new ResizeObserver(() => this.autoFit());
      this.resizes.observe(viewport);
    }
    this.viewport = viewport;
    this.autoFit();
  }

  unbind(): void {
    this.resizes?.disconnect();
    this.resizes = null;
    this.viewport = null;
    this.gesture = { kind: "none" };
  }

  private project(): PlanDrawing {
    const model = this.model!;
    const g = this.gesture;
    const places = g.kind === "node" && g.moved ? new Map(model.pendingDrops).set(g.id, g.at) : model.pendingDrops;
    this.drawing = projectPlan({ plan: model.plan, problems: model.problems, verdicts: model.verdicts, places });
    return this.drawing;
  }

  private renderNode(drawn: DrawnNode): HTMLElement {
    const { node, at } = drawn;
    const model = this.model!;
    const g = this.gesture;
    const selected = model.selection?.kind === "node" && model.selection.id === node.id;
    const cls =
      "plan-node plan-node-" +
      node.kind +
      (selected ? " plan-node-selected" : "") +
      (drawn.problems.length ? " plan-node-problem" : "") +
      (g.kind === "node" && g.moved && g.id === node.id ? " plan-node-dragging" : "") +
      (g.kind === "link" && g.over === node.id ? " plan-node-drop" : "");
    return h(
      "div",
      {
        class: cls,
        key: `plan-node:${node.id}`,
        "data-node": node.id,
        style: `left:${at.x}px;top:${at.y}px;width:${CARD_W}px;height:${CARD_H}px`,
        title: drawn.problems.length ? drawn.problems.join("\n") : null,
      },
      h(
        "div",
        { class: "plan-node-head" },
        h("span", { class: "plan-node-title" }, node.title),
        drawn.problems.length
          ? h("span", { class: "plan-node-flag" }, `${drawn.problems.length} problem${drawn.problems.length > 1 ? "s" : ""}`)
          : null,
      ),
      h(
        "div",
        { class: "plan-node-body" },
        h(
          "div",
          { class: "plan-node-row" },
          h("span", { class: "plan-kind" }, KIND_LABEL[node.kind]),
          h("span", { class: "plan-node-id" }, node.id),
        ),
        ...drawn.lines.map((line) => h("div", { class: "plan-node-line" }, line)),
        drawn.chips.length
          ? h("div", { class: "plan-chips" }, ...drawn.chips.map((chip) => h("span", { class: "plan-chip" }, chip)))
          : null,
      ),
      drawn.ports.length
        ? h(
            "div",
            {
              class: "plan-ports",
              style: `grid-template-columns:${drawn.ports.map((p) => `minmax(0,${p.weight}fr)`).join(" ")}`,
            },
            ...drawn.ports.map((port) =>
              h(
                "button",
                {
                  class: "plan-port" + (port.linked ? "" : " plan-port-open"),
                  type: "button",
                  key: port.on,
                  "data-node": node.id,
                  "data-on": port.on,
                  title: `drag onto the node that follows when ${node.id} says ${port.on}`,
                },
                port.on,
              ),
            ),
          )
        : null,
    );
  }

  private renderEdges(drawing: PlanDrawing): SVGElement {
    const model = this.model!;
    const sel = model.selection;
    const selectedKey = sel?.kind === "edge" ? edgeKeyText(sel.key) : null;
    const g = this.gesture;
    return svg(
      "svg",
      { class: "plan-edges", width: drawing.size.w, height: drawing.size.h },
      svg(
        "defs",
        {},
        svg(
          "marker",
          {
            id: "plan-arrow",
            viewBox: "0 0 10 10",
            refX: 9,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: "auto-start-reverse",
          },
          svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "plan-arrow" }),
        ),
      ),
      ...drawing.edges.map((edge) => renderEdge(edge, edgeDomKey(edge) === selectedKey)),
      g.kind === "link" && g.moved ? svg("path", ghostAttrs(this.portAt(g.from, g.on), g.end)) : null,
    );
  }

  private portAt(id: string, on: string): Point {
    const node = this.drawing?.nodes.find((n) => n.node.id === id);
    return node?.ports.find((p) => p.on === on)?.at ?? { x: 0, y: 0 };
  }

  private toWorld(client: Point): Point {
    const rect = this.viewport?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return {
      x: (client.x - rect.left - this.view.x) / this.view.zoom,
      y: (client.y - rect.top - this.view.y) / this.view.zoom,
    };
  }

  private pointerDown(event: PointerEvent): void {
    if (this.gesture.kind !== "none" || !this.model || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const start = { x: event.clientX, y: event.clientY };
    const port = target?.closest(".plan-port");
    const card = target?.closest(".plan-node");
    const label = target?.closest("[data-edge]");
    if (port instanceof HTMLElement && this.model.editable) {
      this.gesture = {
        kind: "link",
        from: port.dataset.node ?? "",
        on: port.dataset.on ?? "",
        start,
        end: this.toWorld(start),
        over: null,
        moved: false,
      };
    } else if (card instanceof HTMLElement) {
      const id = card.dataset.node ?? "";
      const at = this.drawing?.nodes.find((n) => n.node.id === id)?.at ?? { x: 0, y: 0 };
      this.gesture = { kind: "node", id, start, startAt: at, at, moved: false };
    } else {
      const key = label?.getAttribute("data-edge");
      const edge = key ? this.drawing?.edges.find((e) => edgeDomKey(e) === key)?.edge : undefined;
      this.gesture = {
        kind: "pan",
        start,
        startView: { x: this.view.x, y: this.view.y },
        tap: edge ? { kind: "edge", key: { from: edge.from, on: edge.on, to: edge.to } } : null,
        moved: false,
      };
    }
    const viewport = event.currentTarget as HTMLElement;
    viewport.focus({ preventScroll: true });
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      // the pointer is already gone
    }
  }

  private pointerMove(event: PointerEvent): void {
    const g = this.gesture;
    if (g.kind === "none") return;
    const dx = event.clientX - g.start.x;
    const dy = event.clientY - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    g.moved = true;
    if (g.kind === "pan") {
      this.adjusted = true;
      this.view.x = g.startView.x + dx;
      this.view.y = g.startView.y + dy;
      this.viewport?.classList.add("plan-panning");
      this.applyTransform();
      return;
    }
    if (g.kind === "node" && !this.model?.editable) return;
    if (g.kind === "node") {
      g.at = { x: g.startAt.x + dx / this.view.zoom, y: g.startAt.y + dy / this.view.zoom };
    } else {
      g.end = this.toWorld({ x: event.clientX, y: event.clientY });
      g.over = this.drawing ? hitNode(this.drawing.nodes, g.end) : null;
    }
    if (!this.framePending) {
      this.framePending = true;
      nextFrame(() => this.paint());
    }
  }

  private paint(): void {
    this.framePending = false;
    const g = this.gesture;
    const viewport = this.viewport;
    if (!viewport || !this.model || (g.kind !== "node" && g.kind !== "link")) return;
    const drawing = this.project();
    if (g.kind === "node") {
      const card = viewport.querySelector<HTMLElement>(`.plan-node[data-node="${CSS.escape(g.id)}"]`);
      if (card) {
        card.style.left = `${g.at.x}px`;
        card.style.top = `${g.at.y}px`;
        card.classList.add("plan-node-dragging");
      }
      for (const edge of drawing.edges) {
        if (edge.edge.from !== g.id && edge.edge.to !== g.id) continue;
        const el = viewport.querySelector(`[data-key="edge:${CSS.escape(edgeDomKey(edge))}"]`);
        if (el) paintEdge(el, edge);
      }
      return;
    }
    viewport.classList.add("plan-linking");
    for (const card of viewport.querySelectorAll<HTMLElement>(".plan-node")) {
      card.classList.toggle("plan-node-drop", card.dataset.node === g.over);
    }
    const edges = viewport.querySelector("svg.plan-edges");
    let ghost = edges?.querySelector('[data-key="plan-ghost"]');
    if (edges && !ghost) {
      ghost = svg("path", ghostAttrs(this.portAt(g.from, g.on), g.end));
      edges.appendChild(ghost);
    } else {
      ghost?.setAttribute("d", ghostAttrs(this.portAt(g.from, g.on), g.end).d);
    }
  }

  private endGesture(event: PointerEvent): void {
    const g = this.gesture;
    if (g.kind === "none") return;
    if (g.kind === "node" && g.moved) this.paint();
    if (g.kind === "link" && g.moved && this.drawing) {
      g.over = hitNode(this.drawing.nodes, this.toWorld({ x: event.clientX, y: event.clientY }));
    }
    this.clearGesture(event);
    if (g.kind === "pan") {
      if (!g.moved) this.events.select(g.tap);
    } else if (g.kind === "node") {
      if (g.moved && this.model?.editable) {
        this.events.move(g.id, { x: Math.round(g.at.x), y: Math.round(g.at.y) });
      } else if (!g.moved) {
        this.events.select({ kind: "node", id: g.id });
      }
    } else if (!g.moved) {
      this.events.select({ kind: "node", id: g.from });
    } else if (g.over) {
      this.events.link({ from: g.from, on: g.on, to: g.over });
    }
  }

  private cancelGesture(): void {
    if (this.gesture.kind !== "none") this.clearGesture(null);
  }

  private clearGesture(released: PointerEvent | null): void {
    this.gesture = { kind: "none" };
    const viewport = this.viewport;
    if (!viewport) return;
    if (released) {
      try {
        viewport.releasePointerCapture(released.pointerId);
      } catch {
        // never captured, or already released
      }
    }
    viewport.classList.remove("plan-panning", "plan-linking");
    viewport.querySelector('[data-key="plan-ghost"]')?.remove();
    for (const card of viewport.querySelectorAll(".plan-node-drop, .plan-node-dragging")) {
      card.classList.remove("plan-node-drop", "plan-node-dragging");
    }
  }

  private keyDown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    const selection = this.model?.selection;
    if ((event.key === "Delete" || event.key === "Backspace") && selection && this.model?.editable) {
      event.preventDefault();
      this.events.remove(selection);
    }
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    this.adjusted = true;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.view = zoomAtCursor(
      this.view,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      Math.exp(-event.deltaY * 0.0015),
    );
    this.applyTransform();
  }

  private zoomBy(factor: number): void {
    const rect = this.viewport?.getBoundingClientRect();
    if (!rect) return;
    this.adjusted = true;
    this.view = zoomAtCursor(this.view, { x: rect.width / 2, y: rect.height / 2 }, factor);
    this.applyTransform();
  }

  private autoFit(): void {
    const viewport = this.viewport;
    if (!viewport || !this.model || viewport.clientWidth <= 0) return;
    const { fitted } = this;
    if (!fitted || fitted.key !== this.model.fitKey) return this.fit();
    const resized = fitted.size.w !== viewport.clientWidth || fitted.size.h !== viewport.clientHeight;
    if (resized && !this.adjusted) this.fit();
  }

  private fit(): void {
    if (!this.viewport || !this.drawing || !this.model) return;
    const size = { w: this.viewport.clientWidth, h: this.viewport.clientHeight };
    this.view = fitView(this.drawing.nodes, size);
    this.fitted = { key: this.model.fitKey, size };
    this.adjusted = false;
    this.applyTransform();
  }

  private freeSpotInView(): Point {
    const rect = this.viewport?.getBoundingClientRect();
    const centre = rect
      ? this.toWorld({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: CARD_W, y: CARD_H };
    return freeSpot(this.drawing?.nodes ?? [], centre);
  }

  private transform(): string {
    return `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
  }

  private applyTransform(): void {
    const world = this.viewport?.querySelector<HTMLElement>(".plan-world");
    if (world) world.style.transform = this.transform();
  }
}

function labelBox(edge: DrawnEdge): { x: number; y: number; width: number } {
  const width = edge.label.length * LABEL_CHAR_WIDTH + LABEL_PADDING;
  return { x: edge.route.label.x - width / 2, y: edge.route.label.y - 9, width };
}

function renderEdge(edge: DrawnEdge, selected: boolean): SVGElement {
  const box = labelBox(edge);
  return svg(
    "g",
    {
      "data-key": `edge:${edgeDomKey(edge)}`,
      class:
        "plan-edge" +
        (edge.route.back ? " plan-edge-back" : "") +
        (edge.problems.length ? " plan-edge-problem" : "") +
        (selected ? " plan-edge-selected" : ""),
    },
    svg("path", { class: "plan-edge-path", d: edge.route.d, "marker-end": "url(#plan-arrow)" }),
    svg(
      "g",
      { class: "plan-edge-label", "data-edge": edgeDomKey(edge) },
      svg("title", {}, edge.problems.length ? edge.problems.join("\n") : edgeKeyText(edge.edge)),
      svg("rect", { ...box, height: 18, rx: 9 }),
      svg("text", { x: edge.route.label.x, y: edge.route.label.y + 3.5, "text-anchor": "middle" }, edge.label),
    ),
  );
}

function paintEdge(el: Element, edge: DrawnEdge): void {
  el.querySelector(".plan-edge-path")?.setAttribute("d", edge.route.d);
  const box = labelBox(edge);
  const rect = el.querySelector("rect");
  rect?.setAttribute("x", String(box.x));
  rect?.setAttribute("y", String(box.y));
  const text = el.querySelector("text");
  text?.setAttribute("x", String(edge.route.label.x));
  text?.setAttribute("y", String(edge.route.label.y + 3.5));
}

function ghostAttrs(from: Point, to: Point): Record<string, string> {
  return { "data-key": "plan-ghost", class: "plan-ghost", d: `M ${from.x} ${from.y} L ${to.x} ${to.y}` };
}

function svg(
  tag: string,
  attrs: Record<string, string | number>,
  ...kids: (Node | string | null)[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const kid of kids) {
    if (kid != null) el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return el;
}
