/**
 * Canvas: the graph canvas and its mechanics. One module owns pan, zoom,
 * node drag, edge routing, and the persisted card positions, as instance
 * state on the class the composition root creates once per session. The
 * render is a function of model + selection, the pan and a drag in flight
 * included, so the morph that commits it finds the tree already saying what
 * the mechanics did; the pointer and wheel handlers ride the viewport as
 * props and follow it from render to render. The edges are the one thing
 * drawn after the commit, since their routes need the cards laid out. A
 * card tap (a press that never crosses the drag threshold) reports through
 * the `onCardTap` callback; selection itself belongs to the composition.
 */

import {
  checkpointNotice,
  conversationTurnLabel,
  statusLabel,
  UNASSIGNED_LABEL,
  VITALS_MAX_SAMPLES,
  type AssignmentView,
  type ConversationCardView,
  type InterruptView,
  type PoolCardView,
  type RunPhase,
  type TicketCardView,
  type UtilityCardView,
  type VitalsView,
} from "./project";
import type { RestartView, StopView } from "./view";
import {
  edgePath,
  layoutStorageKey,
  mergeLayout,
  parseStoredLayout,
  strokeWidthForZoom,
  zoomAtCursor,
  type CardBox,
  type EdgeMode,
  type Point,
  type TopologyEdge,
  type ViewTransform,
} from "./geometry";
import { h } from "./dom";
import { renderTerminalSurface } from "./terminal";

const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_ID = "canvas-arrow";
const CARD_WIDTH = 280;
const LAYOUT_KEY = "console-canvas-layout";
const DRAG_THRESHOLD = 4;
const WORLD_MIN_WIDTH = 960;
const SPARK_WIDTH = 48;
const SPARK_HEIGHT = 14;

type Positioned = { id: string; x: number; y: number };

/**
 * The Vitals footer: diff totals (`+a −r · N files`, or "no changes yet"),
 * the staleness readout, and the sparkline of recent diff totals. The copy
 * and colors come from the projection's view data; this is shape only.
 */
function renderVitals(vitals: VitalsView): HTMLElement {
  const diff = vitals.diff
    ? h(
        "span",
        { class: "vitals-diff" },
        h("span", { class: "vitals-added" }, `+${vitals.diff.added}`),
        " ",
        h("span", { class: "vitals-removed" }, `−${vitals.diff.removed}`),
        ` · ${vitals.diff.fileCount} files`,
      )
    : h("span", { class: "vitals-diff" }, "no changes yet");
  const stale = vitals.staleness
    ? h(
        "span",
        {
          class:
            "vitals-stale" +
            (vitals.staleness.kind === "idle" ? " vitals-idle" : "") +
            (vitals.staleness.fresh ? " vitals-fresh" : ""),
        },
        vitals.staleness.copy,
      )
    : null;
  return h(
    "div",
    { class: `vitals vitals-${vitals.mode}` + (vitals.elapsed ? " vitals-resolver" : "") },
    vitals.elapsed ? h("span", { class: "vitals-elapsed" }, vitals.elapsed) : null,
    diff,
    stale,
    sparkline(vitals.samples),
  );
}

/** The diff-total trend: a 48×14 polyline of the last 40 poll samples. */
function sparkline(samples: number[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "vitals-spark");
  svg.setAttribute("width", String(SPARK_WIDTH));
  svg.setAttribute("height", String(SPARK_HEIGHT));
  svg.setAttribute("viewBox", `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
  const poly = document.createElementNS(SVG_NS, "polyline");
  if (samples.length > 1) {
    const max = Math.max(...samples, 1);
    const step = SPARK_WIDTH / (VITALS_MAX_SAMPLES - 1);
    const points = samples
      .map((value, i) => {
        const x = SPARK_WIDTH - (samples.length - 1 - i) * step;
        const y = SPARK_HEIGHT - 1 - (value / max) * (SPARK_HEIGHT - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    poly.setAttribute("points", points);
  }
  svg.appendChild(poly);
  return svg;
}

/**
 * The Assignment badge: the ticket's resolved `harness · model · drivers`
 * (ADR-0013), rendered verbatim under the card head. A record with neither
 * harness nor model is an unassigned ticket and reads a muted word instead;
 * a resolved-null field renders by omission, so no bare separator is
 * stranded. One line, the model ellipsizing before the rest; a click
 * toggles the full wrapped text. Whether it is expanded is state the Canvas
 * holds per card and the render draws, so the morph keeps it from one
 * render to the next instead of the next tick folding it back. An enlisted
 * ticket (issue #101) has no model by construction, so `asFound` puts the
 * words "as found" where the model would read.
 */
function renderAssignmentBadge(
  assignment: AssignmentView,
  expanded: boolean,
  onToggle: () => void,
  asFound = false,
): HTMLElement {
  const unassigned = assignment.harness === null && assignment.model === null && !asFound;
  const badge = h("div", {
    class: [
      "assignment-badge",
      expanded ? "assignment-badge-expanded" : null,
      unassigned ? "assignment-badge-unassigned" : null,
    ]
      .filter(Boolean)
      .join(" "),
    onclick: onToggle,
  });
  if (unassigned) {
    badge.append(UNASSIGNED_LABEL);
  } else {
    const fields: { class: string; value: string }[] = [];
    if (assignment.harness) {
      fields.push({ class: "assignment-badge-harness", value: assignment.harness });
    }
    if (assignment.model) {
      fields.push({ class: "assignment-badge-model", value: assignment.model });
    } else if (asFound) {
      fields.push({ class: "assignment-badge-model", value: "as found" });
    }
    if (assignment.drivers) {
      fields.push({ class: "assignment-badge-drivers", value: assignment.drivers });
    }
    for (const [i, field] of fields.entries()) {
      // Each separator leads the value it belongs to, so the expanded wrap
      // never strands a bare dot at a line break.
      badge.append(
        h("span", { class: field.class }, i === 0 ? field.value : `· ${field.value}`),
      );
    }
  }
  return badge;
}

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
  /** The pool as the Console names it (issue #100): its Pool title, else
   *  its directory. Null until the first snapshot says which pool this is. */
  poolName: string | null;
  /** The raw phase, for the two things the label alone cannot tell apart: a
   *  stopped server's status line and its body notice (issue #97). */
  phase: RunPhase | null;
  phaseLabel: string;
  seq: number;
  error: string | null;
  stop: StopView;
  /** The Restart control's slice (ADR-0026): the canvas renders none of the
   *  control (it lives in the Settings pane) but the status line and the
   *  stopped notice both read `waiting`, the mark of the tab that asked. */
  restart: RestartView;
  /** The pool is Terminal-backed (ADR-0014): the header offers Enlist only
   *  then, so a headless pool is never shown an action it cannot perform. */
  terminalBacked: boolean;
  /** The Merge queue line (issue #129): shown under the status while the
   *  Merge hold stands, absent otherwise. */
  mergeQueueLine: string | null;
}

/**
 * The header's status line. A stopped server (issue #97) reads its phase
 * whatever the connection says: the stream drops the moment after the
 * farewell snapshot, so waiting on `connected` would replace the one true
 * thing the page knows with "connecting". The tab that asked for the stop
 * says so; every other tab just reports the stop.
 */
export function canvasStatusText(model: CanvasModel): string {
  // The pool leads (issue #100), so with several Consoles open the header
  // says which pool before it says how it is doing.
  const name = model.poolName ?? "pool";
  if (model.phase === "stopped") {
    // A Restart is a stop with a relaunch behind it, so the tab that asked
    // for one reads the same farewell as "restarting", not "stopped": the
    // server is coming back, and saying otherwise would be wrong for the
    // few seconds Boot takes.
    if (model.restart.waiting) return `${name} · restarting...`;
    return model.stop.stoppedFromHere
      ? `${name} · stopped · from this page`
      : `${name} · stopped`;
  }
  return model.connected
    ? `${name} · ${model.phaseLabel} · snapshot ${model.seq}`
    : `${name} · connecting`;
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
  /** Cards whose Assignment badge the operator has clicked open. */
  private readonly expandedBadges = new Set<string>();
  private readonly onChange: () => void;
  private readonly onCardTap: (nodeId: string) => void;
  private readonly onFocusTerminal: (ticketId: string) => Promise<boolean>;
  private readonly onNewConversation: () => void;
  private readonly onEnlist: () => void;
  private readonly onOpenSettings: () => void;
  private readonly onEndConversation: (conversationId: string) => void;
  private readonly onArmStop: () => void;
  private readonly onCancelStop: () => void;
  private readonly onConfirmStop: () => void;

  constructor(options: {
    /** Canvas-held view state changed (a badge toggled): render again. */
    onChange: () => void;
    onCardTap: (nodeId: string) => void;
    onFocusTerminal: (ticketId: string) => Promise<boolean>;
    /** The header's "New Conversation" button: opens the Conversations tray's form. */
    onNewConversation: () => void;
    /** The header's "Enlist terminal" button (issue #101): opens the pane
     *  picker. Offered only on a Terminal-backed pool. */
    onEnlist: () => void;
    /** The header's "Settings" button (ADR-0026): opens the Settings pane.
     *  Always offered; a headless pool has settings too. */
    onOpenSettings: () => void;
    /** A Conversation card's End button. Fire-and-forget: the Conversations
     *  store tracks the in-flight/failure state the card reads back. */
    onEndConversation: (conversationId: string) => void;
    /** The header's Stop control (issue #97): arm the inline confirmation,
     *  drop it, and send the stop. Cancel sends nothing. */
    onArmStop: () => void;
    onCancelStop: () => void;
    onConfirmStop: () => void;
  }) {
    this.onChange = options.onChange;
    this.onCardTap = options.onCardTap;
    this.onFocusTerminal = options.onFocusTerminal;
    this.onNewConversation = options.onNewConversation;
    this.onEnlist = options.onEnlist;
    this.onOpenSettings = options.onOpenSettings;
    this.onEndConversation = options.onEndConversation;
    this.onArmStop = options.onArmStop;
    this.onCancelStop = options.onCancelStop;
    this.onConfirmStop = options.onConfirmStop;
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
    for (const id of [...this.expandedBadges]) {
      if (!liveIds.has(id)) this.expandedBadges.delete(id);
    }
    this.seedPositions(cards);
  }

  private assignmentBadge(card: TicketCardView | ConversationCardView): HTMLElement {
    return renderAssignmentBadge(
      card.assignment,
      this.expandedBadges.has(card.id),
      () => {
        if (!this.expandedBadges.delete(card.id)) this.expandedBadges.add(card.id);
        this.onChange();
      },
      card.enlisted,
    );
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
      style: `width:${size.width}px;height:${size.height}px;transform:${this.transform()}`,
    });
    world.append(
      this.makeSvg(),
      ...model.cards.map((card) => this.renderCard(card, selection)),
    );
    const panning = this.drag?.kind === "pan" && this.drag.moved;
    const viewport = h(
      "div",
      {
        class: "canvas-viewport" + (panning ? " canvas-panning" : ""),
        onpointerdown: (event: PointerEvent) => this.pointerDown(event),
        onpointermove: (event: PointerEvent) => this.pointerMove(event),
        onpointerup: (event: PointerEvent) => this.endDrag(event),
        onpointercancel: (event: PointerEvent) => this.endDrag(event),
        onwheel: (event: WheelEvent) => this.wheel(event),
      },
      world,
    );
    main.append(this.renderCanvasHeader(model));
    const stopped = this.renderStoppedNotice(model);
    if (stopped) main.append(stopped);
    main.append(viewport);
    return main;
  }

  /**
   * Bind the mechanics to the viewport now on the page: seed the pan on
   * first mount (it needs the viewport's width), fit the world to its cards,
   * and draw the edges. The gesture handlers are already on the viewport,
   * put there by the render.
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
      this.applyTransform();
    }
    this.fitWorld(world);
    this.drawEdges(world, edges, selectedId);
    this.updateEdges();
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  // The selection's highlight and the drag in flight, both rendered from
  // state so a render landing mid-gesture says what the pointer is doing.
  private flowClass(id: string, selection: CanvasSelection): string {
    const dragging =
      this.drag?.kind === "node" && this.drag.nodeId === id && this.drag.moved
        ? " node-card-dragging"
        : "";
    if (id === selection.selectedId) return " node-card-selected" + dragging;
    if (selection.inflow.has(id)) return " node-card-inflow" + dragging;
    if (selection.outflow.has(id)) return " node-card-outflow" + dragging;
    return dragging;
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
        {
          class:
            `node-card-state ticket-state-${card.status}` +
            (card.mergeState ? ` ticket-merge-${card.mergeState}` : ""),
        },
        statusLabel(card.status, card.mergeState),
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
          (card.mergeState ? ` ticket-card-merge-${card.mergeState}` : "") +
          (card.interrupt
            ? card.interrupt.queued
              ? " ticket-card-queued"
              : " ticket-card-interrupt"
            : "") +
          this.flowClass(card.id, selection),
        key: card.id,
        "data-node-id": card.id,
        "data-ticket-id": card.ticketId,
        style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
      },
      head,
      h(
        "div",
        { class: "node-card-body" },
        // The Assignment badge rides the view model like the Vitals footer,
        // so it renders inside the card render and holds its row directly
        // under the head whether or not a live attempt puts Vitals below.
        this.assignmentBadge(card),
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
        // The Vitals footer rides the view model, so it renders inside the
        // card render like everything else.
        card.vitals ? renderVitals(card.vitals) : null,
        // The terminal surface (ADR-0014) rides the view model the same way:
        // present only while the attempt is terminal-backed and running.
        card.terminal
          ? renderTerminalSurface(card.terminal, {
              onFocus: () => this.onFocusTerminal(card.ticketId),
              ...(card.resolver ? { focusLabel: "open resolver" } : {}),
            })
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
        key: card.id,
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

  // A Conversation card (ADR-0018): title, Assignment, the Turn state badge
  // (waiting on you / agent working), the last line said, idle age, status
  // once ended or crashed, the same read-only terminal peek ticket cards
  // carry, and an End button. No blockers, no grade, no Vitals: a
  // Conversation is not a Ticket and holds no attempt.
  private renderConversationCard(
    card: ConversationCardView,
    selection: CanvasSelection,
  ): HTMLElement {
    const pos = this.posOf(card);
    const head = h(
      "div",
      { class: "node-card-head" },
      h("span", { class: "node-card-id" }, card.conversationId),
      h(
        "span",
        { class: `node-card-state conversation-turn-${card.turn.state}` },
        card.status === "live" ? conversationTurnLabel(card.turn.state) : card.status,
      ),
    );
    const body: (Node | string | null)[] = [
      this.assignmentBadge(card),
      h("div", { class: "card-text conversation-card-title" }, card.title),
    ];
    if (card.status === "live") {
      body.push(
        h(
          "div",
          { class: "dim conversation-card-last-line" },
          card.turn.lastLine || "(no Turn yet)",
        ),
      );
      if (card.idleAge) {
        body.push(h("div", { class: "dim conversation-card-idle" }, `idle ${card.idleAge}`));
      }
    } else if (card.branch) {
      body.push(h("div", { class: "dim conversation-card-branch" }, `branch ${card.branch}`));
    }
    if (card.terminal) {
      body.push(
        renderTerminalSurface(card.terminal, {
          onFocus: () => this.onFocusTerminal(card.conversationId),
        }),
      );
    }
    if (card.status === "live") {
      body.push(
        h(
          "div",
          { class: "conversation-end-row" },
          h(
            "button",
            {
              class: "btn btn-danger conversation-end",
              type: "button",
              disabled: card.endView.ending,
              title: card.endView.failure ?? "end this conversation",
              onclick: () => this.onEndConversation(card.conversationId),
            },
            card.endView.ending ? "ending..." : "End",
          ),
          card.endView.failure
            ? h("span", { class: "error-inline conversation-end-failure" }, card.endView.failure)
            : null,
        ),
      );
    }
    return h(
      "div",
      {
        class:
          `node-card conversation-card conversation-card-${card.status}` +
          this.flowClass(card.id, selection),
        key: card.id,
        "data-node-id": card.id,
        "data-conversation-id": card.conversationId,
        style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
      },
      head,
      h("div", { class: "node-card-body" }, ...body),
    );
  }

  private renderCard(card: PoolCardView, selection: CanvasSelection): HTMLElement {
    if (card.kind === "ticket") return this.renderTicketCard(card, selection);
    if (card.kind === "conversation") return this.renderConversationCard(card, selection);
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
      onchange: (event: Event) => {
        this.edgeMode = (event.currentTarget as HTMLInputElement).checked ? "ortho" : "straight";
        this.updateEdges();
      },
    });
    return h(
      "div",
      { class: "canvas-header" },
      h("span", { class: "dim" }, canvasStatusText(model)),
      model.mergeQueueLine
        ? h("span", { class: "canvas-merge-queue" }, model.mergeQueueLine)
        : null,
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
        model.terminalBacked
          ? h(
              "button",
              {
                class: "btn canvas-enlist",
                title: "enlist a live herdr terminal",
                onclick: () => this.onEnlist(),
              },
              "Enlist terminal",
            )
          : null,
        h(
          "button",
          {
            class: "btn canvas-settings",
            title: "pool settings and machine defaults",
            onclick: () => this.onOpenSettings(),
          },
          "Settings",
        ),
        h(
          "button",
          {
            class: "btn btn-primary canvas-new-conversation",
            title: "start a new Conversation",
            onclick: () => this.onNewConversation(),
          },
          "New Conversation",
        ),
        this.renderStopControl(model.stop),
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

  /**
   * The Stop control (issue #97), offered only while the pool is done and
   * the stream is live. The confirmation is inline on the button rather than
   * a modal, the way a Conversation's End button swaps its own label:
   * "Really stop?" with Stop and Cancel beside it, then a disabled
   * "stopping..." while the POST is out. Cancel sends nothing, and a refusal
   * shows beside the button, not on the global banner.
   */
  private renderStopControl(stop: StopView): HTMLElement | null {
    if (!stop.offered) return null;
    if (stop.state === "requesting") {
      return h(
        "div",
        { class: "canvas-stop" },
        h(
          "button",
          { class: "btn btn-danger", type: "button", disabled: true },
          "stopping...",
        ),
      );
    }
    if (stop.state === "armed") {
      return h(
        "div",
        { class: "canvas-stop canvas-stop-armed" },
        h("span", { class: "canvas-stop-prompt" }, "Really stop?"),
        h(
          "button",
          {
            class: "btn btn-danger",
            type: "button",
            title: "stop this pool's server",
            onclick: () => this.onConfirmStop(),
          },
          "Stop",
        ),
        h(
          "button",
          { class: "btn", type: "button", onclick: () => this.onCancelStop() },
          "Cancel",
        ),
      );
    }
    return h(
      "div",
      { class: "canvas-stop" },
      h(
        "button",
        {
          class: "btn btn-danger canvas-stop-server",
          type: "button",
          title: "stop this pool's server",
          onclick: () => this.onArmStop(),
        },
        "Stop server",
      ),
      stop.failure
        ? h("span", { class: "error-inline canvas-stop-failure" }, stop.failure)
        : null,
    );
  }

  /**
   * The stopped-server notice (issue #97): a bar under the header for the
   * one thing the operator can do about it. The page keeps retrying the
   * stream on its own, so relaunching from a terminal is all it takes.
   */
  private renderStoppedNotice(model: CanvasModel): HTMLElement | null {
    if (model.phase !== "stopped") return null;
    if (model.restart.waiting) {
      // The tab that asked for the Restart is polling for the relaunched
      // server and will move to it (or to its new port) when it answers, so
      // the relaunch command would be an instruction to do what is already
      // happening. If the wait times out, `waiting` drops and the notice
      // below takes over with the command.
      return h(
        "div",
        { class: "canvas-stopped canvas-restarting" },
        h(
          "span",
          { class: "canvas-stopped-text" },
          "This Console is restarting its server. It reconnects on its own once Boot has it back up; a stale UI build makes that take a little longer.",
        ),
      );
    }
    return h(
      "div",
      { class: "canvas-stopped" },
      h(
        "span",
        { class: "canvas-stopped-text" },
        `${model.poolName ? `The server for ${model.poolName}` : "This pool's server"} has stopped. Relaunch it from a terminal and this page will reconnect on its own:`,
      ),
      model.stop.relaunch
        ? h("code", { class: "canvas-stopped-command" }, model.stop.relaunch)
        : null,
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

  // A press on a card starts a node drag, a press on blank space a pan;
  // either captures the pointer on the viewport, which keeps its node across
  // the renders that land while the pointer is down.
  private pointerDown(event: PointerEvent): void {
    if (this.drag) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest(".node-card");
    const interactive = target?.closest(
      "button, input, select, textarea, a, summary, label, .assignment-badge",
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
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // pointer already gone
    }
  }

  private pointerMove(event: PointerEvent): void {
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
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const next = zoomAtCursor(
      this.view,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      Math.exp(-event.deltaY * 0.0015),
    );
    this.view.x = next.x;
    this.view.y = next.y;
    this.view.zoom = next.zoom;
    this.applyTransform();
  }

  private transform(): string {
    return `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.zoom})`;
  }

  private applyTransform(): void {
    if (!this.canvas) return;
    this.canvas.world.style.transform = this.transform();
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
