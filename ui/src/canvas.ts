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
  stewardLiveReason,
  stewardOnDutyLine,
  UNASSIGNED_LABEL,
  VITALS_MAX_SAMPLES,
  type AssignmentView,
  type ConversationCardView,
  type InterruptView,
  type PoolCardView,
  type SpawnCardView,
  type RunPhase,
  type SpawnLineView,
  type StewardOnDutyView,
  type TicketCardView,
  type UtilityCardView,
  type VitalsView,
} from "./project";
import { EFFORT_NOT_APPLIED_TITLE, effortText } from "./effort";
import type { CloseTerminalsView, RestartView, StopState, StopView } from "./view";
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
import { nextFrame } from "./frame";
import { KEEP_CHILDREN, keep } from "./morph";
import { renderTerminalSurface } from "./terminal";
import { renderStewardBadge } from "./steward";
import { renderDeliveryWarning } from "./conversations";

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
  if (samples.length > 1) poly.setAttribute("points", sparkPoints(samples));
  svg.appendChild(poly);
  return svg;
}

// The Vitals store keeps a ticket's samples array until a poll moves it, so
// the points it draws are worked out once per array, not once per render.
const sparkPointsOf = new WeakMap<number[], string>();

function sparkPoints(samples: number[]): string {
  const held = sparkPointsOf.get(samples);
  if (held !== undefined) return held;
  const max = Math.max(...samples, 1);
  const step = SPARK_WIDTH / (VITALS_MAX_SAMPLES - 1);
  const points = samples
    .map((value, i) => {
      const x = SPARK_WIDTH - (samples.length - 1 - i) * step;
      const y = SPARK_HEIGHT - 1 - (value / max) * (SPARK_HEIGHT - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  sparkPointsOf.set(samples, points);
  return points;
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
    const fields: { class: string; value: string; title?: string }[] = [];
    if (assignment.harness) {
      fields.push({ class: "assignment-badge-harness", value: assignment.harness });
    }
    if (assignment.model) {
      fields.push({ class: "assignment-badge-model", value: assignment.model });
    } else if (asFound) {
      fields.push({ class: "assignment-badge-model", value: "as found" });
    }
    const effort = effortText(assignment);
    if (effort) {
      fields.push(
        assignment.effortApplied === false
          ? {
              class: "assignment-badge-effort assignment-badge-effort-unapplied",
              value: effort,
              title: EFFORT_NOT_APPLIED_TITLE,
            }
          : { class: "assignment-badge-effort", value: effort },
      );
    }
    if (assignment.drivers) {
      fields.push({ class: "assignment-badge-drivers", value: assignment.drivers });
    }
    for (const [i, field] of fields.entries()) {
      // Each separator leads the value it belongs to, so the expanded wrap
      // never strands a bare dot at a line break.
      badge.append(
        h(
          "span",
          { class: field.class, title: field.title ?? null },
          i === 0 ? field.value : `· ${field.value}`,
        ),
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
  /** Drawn dashed: a conditional edge, or one to or from a Pending or Held
   *  spawn's faded card (issue #150). */
  dashed: boolean;
  /** The route last written, so an edge whose cards did not move is not
   *  written again. */
  route: string;
}

interface CanvasBind {
  viewport: HTMLElement;
  world: HTMLElement;
  svg: SVGSVGElement;
  nodesById: Map<string, HTMLElement>;
  /** The drawn edges, keyed by source and target, kept across renders and
   *  updated in place (issue #157). */
  edges: Map<string, DrawnEdge>;
  /** Each card's box: its position from the held layout, its size as last
   *  measured. The edges route from these, and a drag moves one in place. */
  boxes: Map<string, CardBox>;
}

/** The slice of the app model the canvas renders from. */
/**
 * The header's inline confirmation (issue #97's Stop, reused by issue #139's
 * close-finished-terminals): the control's button, then on a click a prompt
 * with the confirming action and Cancel beside it, then a disabled
 * requesting label while the POST is out. The session owns the state
 * machine; this only draws it. Cancel sends nothing, and a refusal's reason
 * shows beside the button rather than on the global banner. Every class is
 * `base`-prefixed, so each control keeps its own hooks and styling; the
 * wrapper is keyed by `base`, so two such controls side by side never
 * trade places in a morph.
 */
interface InlineConfirmSpec {
  base: string;
  /** Extra classes on the idle button, beside `btn`. */
  openClass: string;
  label: string;
  title: string;
  prompt: string;
  confirmLabel: string;
  requestingLabel: string;
  state: StopState;
  failure: string | null;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function renderInlineConfirm(spec: InlineConfirmSpec): HTMLElement {
  if (spec.state === "requesting") {
    return h(
      "div",
      { class: spec.base, key: spec.base },
      h(
        "button",
        { class: "btn btn-danger", type: "button", disabled: true },
        spec.requestingLabel,
      ),
    );
  }
  if (spec.state === "armed") {
    return h(
      "div",
      { class: `${spec.base} ${spec.base}-armed`, key: spec.base },
      h("span", { class: `${spec.base}-prompt` }, spec.prompt),
      h(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          title: spec.title,
          onclick: () => spec.onConfirm(),
        },
        spec.confirmLabel,
      ),
      h(
        "button",
        { class: "btn", type: "button", onclick: () => spec.onCancel() },
        "Cancel",
      ),
    );
  }
  return h(
    "div",
    { class: spec.base, key: spec.base },
    h(
      "button",
      {
        class: `btn ${spec.openClass}`,
        type: "button",
        title: spec.title,
        onclick: () => spec.onArm(),
      },
      spec.label,
    ),
    spec.failure
      ? h("span", { class: `error-inline ${spec.base}-failure` }, spec.failure)
      : null,
  );
}

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
  /** The Spawn caps line (issue #149), beside the Merge queue line; a
   *  button that opens the Held spawns list. Null before the first snapshot. */
  spawnLine: SpawnLineView | null;
  /** The header's "Close N finished terminals" control (issue #139). */
  closeTerminals: CloseTerminalsView;
  /** The Steward on duty (ADR-0030): the header says so, a click focusing
   *  its card, and Start Steward stands disabled. Null when none is. */
  steward: StewardOnDutyView | null;
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
  /** A card drag's DOM work is waiting on the next frame. */
  private dragFrame = false;
  /** The zoom the edges' strokes were last scaled for. */
  private strokeZoom: number | null = null;
  /** Each card's size as last measured, so the render sizes the world the
   *  way the fit after it would, and the fit has nothing to write. */
  private readonly sizes = new Map<string, { w: number; h: number }>();
  /** The stored layout, read from localStorage once and kept in step with
   *  every write, rather than read and parsed on every render. */
  private stored: Record<string, Point> | null = null;
  /** Cards whose Assignment badge the operator has clicked open. */
  private readonly expandedBadges = new Set<string>();
  /** Where the first bind leaves its measuring, when it may (issue #161),
   *  and the edges it owes until then. */
  private readonly settleLater: ((run: () => void) => void) | null;
  private unsettled: { edges: TopologyEdge[]; selectedId: string | null } | null = null;
  /**
   * What each card on the page was drawn from (issue #161): its view, place,
   * selection and badge, as of the last committed render, and those the
   * render in progress draws. A card whose next draw would be the same is
   * not rebuilt; the morph keeps its node as it stands.
   */
  private drawn = new Map<string, string>();
  private drawing = new Map<string, string>();
  private readonly onChange: () => void;
  private readonly onCardTap: (nodeId: string) => void;
  private readonly onCardHover: (nodeId: string | null) => void;
  /** The card the pointer is over, so a move inside it reports nothing. */
  private hoveredCard: string | null = null;
  private readonly onFocusTerminal: (ticketId: string) => Promise<boolean>;
  private readonly onNewConversation: () => void;
  private readonly onStartSteward: () => void;
  private readonly onFocusSteward: (cardId: string) => void;
  private readonly onEnlist: () => void;
  private readonly onOpenSettings: () => void;
  private readonly onOpenHeldSpawns: () => void;
  private readonly onResetLayout: () => void;
  private readonly onEndConversation: (conversationId: string) => void;
  private readonly onArmStop: () => void;
  private readonly onCancelStop: () => void;
  private readonly onConfirmStop: () => void;
  private readonly onArmCloseTerminals: () => void;
  private readonly onCancelCloseTerminals: () => void;
  private readonly onConfirmCloseTerminals: () => void;

  constructor(options: {
    /** Canvas-held view state changed (a badge toggled): render again. */
    onChange: () => void;
    onCardTap: (nodeId: string) => void;
    /** The pointer moved onto a card, or off every card (null), for the
     *  hover prefetch (issue #161). */
    onCardHover?: (nodeId: string | null) => void;
    /** Run something in the next frame: given, the first bind measures the
     *  cards and draws the edges there, after the first paint, rather than
     *  forcing the page's first layout inside the render (issue #161). */
    settleLater?: (run: () => void) => void;
    onFocusTerminal: (ticketId: string) => Promise<boolean>;
    /** The header's "New Conversation" button: opens the Conversations tray's form. */
    onNewConversation: () => void;
    /** The header's "Start Steward" button (ADR-0030): opens the
     *  Conversations tray's Start Steward form. */
    onStartSteward: () => void;
    /** The header's "Steward on duty" line: select and reveal its card. */
    onFocusSteward: (cardId: string) => void;
    /** The header's "Enlist terminal" button (issue #101): opens the pane
     *  picker. Offered only on a Terminal-backed pool. */
    onEnlist: () => void;
    /** The header's "Settings" button (ADR-0026): opens the Settings pane.
     *  Always offered; a headless pool has settings too. */
    onOpenSettings: () => void;
    /** The header's Spawn caps line (issue #149): opens the Held spawns list. */
    onOpenHeldSpawns: () => void;
    /** The header's "reset layout" button, after the canvas has restored its
     *  own card positions: resets what other modules lay out (the Needs
     *  input tray's dragged width, issue #147). */
    onResetLayout: () => void;
    /** A Conversation card's End button. Fire-and-forget: the Conversations
     *  store tracks the in-flight/failure state the card reads back. */
    onEndConversation: (conversationId: string) => void;
    /** The header's Stop control (issue #97): arm the inline confirmation,
     *  drop it, and send the stop. Cancel sends nothing. */
    onArmStop: () => void;
    onCancelStop: () => void;
    onConfirmStop: () => void;
    /** The header's close-finished-terminals control (issue #139), the Stop
     *  control's three intents again. Cancel sends nothing. */
    onArmCloseTerminals: () => void;
    onCancelCloseTerminals: () => void;
    onConfirmCloseTerminals: () => void;
  }) {
    this.onChange = options.onChange;
    this.onCardTap = options.onCardTap;
    this.onCardHover = options.onCardHover ?? (() => {});
    this.settleLater = options.settleLater ?? null;
    this.onFocusTerminal = options.onFocusTerminal;
    this.onNewConversation = options.onNewConversation;
    this.onStartSteward = options.onStartSteward;
    this.onFocusSteward = options.onFocusSteward;
    this.onEnlist = options.onEnlist;
    this.onOpenSettings = options.onOpenSettings;
    this.onOpenHeldSpawns = options.onOpenHeldSpawns;
    this.onResetLayout = options.onResetLayout;
    this.onEndConversation = options.onEndConversation;
    this.onArmStop = options.onArmStop;
    this.onCancelStop = options.onCancelStop;
    this.onConfirmStop = options.onConfirmStop;
    this.onArmCloseTerminals = options.onArmCloseTerminals;
    this.onCancelCloseTerminals = options.onCancelCloseTerminals;
    this.onConfirmCloseTerminals = options.onConfirmCloseTerminals;
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
    this.drawn.clear();
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
    this.drawing = new Map();
    world.append(
      this.makeSvg(),
      ...model.cards.map((card) => this.drawCard(card, selection)),
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
        onpointerover: (event: PointerEvent) => this.hoverCard(event.target),
        onpointerout: (event: PointerEvent) => this.hoverCard(event.relatedTarget),
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
   * first mount (it needs the viewport's width), measure the cards, fit the
   * world to them, and draw the edges. The cards are measured in one pass
   * after the commit, the one layout read a render makes, and everything
   * after it only writes, and only what moved (issue #157). The gesture
   * handlers are already on the viewport, put there by the render.
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
    // The edge layer keeps its paths across renders (the morph leaves its
    // children be), so the drawn edges carry over while it is the same layer.
    const kept = this.canvas?.svg === svg ? this.canvas.edges : new Map<string, DrawnEdge>();
    if (kept.size === 0) this.strokeZoom = null;
    this.canvas = { viewport, world, svg, nodesById, edges: kept, boxes: new Map() };
    // The render is on the page: its cards are what the next one compares.
    this.drawn = this.drawing;
    if (!this.view.seeded && this.settleLater) {
      // A fresh page (issue #161): the canvas spans the window, so the pan
      // is seeded from the window's width rather than the viewport's, and
      // the cards are measured and the edges drawn in the next frame, so
      // the first render forces no layout and the first paint waits on no
      // edge. A render before that frame measures as every render does.
      this.view.seeded = true;
      this.view.x = Math.max(8, (window.innerWidth - WORLD_MIN_WIDTH) / 2);
      this.view.y = 8;
      this.applyTransform();
      this.unsettled = { edges, selectedId };
      this.settleLater(() => {
        const owed = this.unsettled;
        this.unsettled = null;
        if (owed) this.settle(owed.edges, owed.selectedId);
      });
      return;
    }
    if (!this.view.seeded && viewport.clientWidth > 0) {
      this.view.seeded = true;
      this.view.x = Math.max(8, (viewport.clientWidth - WORLD_MIN_WIDTH) / 2);
      this.view.y = 8;
      this.applyTransform();
    }
    this.unsettled = null;
    this.settle(edges, selectedId);
  }

  // Measure the cards, fit the world to them, and draw the edges: the
  // reads first, in one pass, then only writes.
  private settle(edges: TopologyEdge[], selectedId: string | null): void {
    this.measure();
    this.fitWorld();
    this.drawEdges(edges, selectedId);
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
      card.steward ? renderStewardBadge() : null,
      h(
        "span",
        { class: `node-card-state conversation-turn-${card.turn.state}` },
        card.status === "live" ? conversationTurnLabel(card.turn.state) : card.status,
      ),
    );
    const body: (Node | string | null)[] = [
      this.assignmentBadge(card),
      h("div", { class: "card-text conversation-card-title" }, card.title),
      card.delivery ? renderDeliveryWarning(card.delivery) : null,
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
          (card.steward ? " conversation-card-steward" : "") +
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

  // A Pending or Held spawn's faded card (issue #150): work on its way, not
  // in the pool. It says when it lands, or why it is held, and where it came
  // from; a click selects it and the Detail offers its decisions. Its key is
  // the `spawn:` card id, so the morph never mistakes it for a ticket's card,
  // and the ticket it lands as arrives as a card of its own.
  private renderSpawnCard(card: SpawnCardView, selection: CanvasSelection): HTMLElement {
    const pos = this.posOf(card);
    return h(
      "div",
      {
        class:
          `node-card spawn-card spawn-card-${card.state}` + this.flowClass(card.id, selection),
        key: card.id,
        "data-node-id": card.id,
        "data-proposal-id": card.proposalId,
        style: `left:${pos.x}px;top:${pos.y}px;width:${CARD_WIDTH}px`,
      },
      h(
        "div",
        { class: "node-card-head" },
        h("span", { class: "node-card-id" }, card.proposalId),
        h("span", { class: `node-card-state spawn-card-label` }, card.label),
      ),
      h(
        "div",
        { class: "node-card-body" },
        h("div", { class: "card-text spawn-card-title" }, card.title),
        h(
          "div",
          { class: "dim spawn-card-parent" },
          `${card.spawnKind === "conversation" ? "Conversation " : ""}from ${card.parentId}`,
        ),
      ),
    );
  }

  /**
   * A card, or a stand-in for its node when nothing it is drawn from moved
   * since the render that drew it (issue #161). The snapshot's deltas leave
   * every other ticket as it was, so a busy pool's render rebuilds the few
   * cards that changed, and the morph walks only those. What a card is drawn
   * from is its projected view, its place on the canvas, its selection and
   * drag classes and its Assignment badge's state; its handlers close over
   * its id alone.
   */
  private drawCard(card: PoolCardView, selection: CanvasSelection): Element {
    const pos = this.posOf(card);
    const from =
      `${this.flowClass(card.id, selection)}|${pos.x},${pos.y}|` +
      `${this.expandedBadges.has(card.id)}|${JSON.stringify(card)}`;
    this.drawing.set(card.id, from);
    const node = this.canvas?.nodesById.get(card.id);
    if (node?.isConnected && this.drawn.get(card.id) === from) return keep(node);
    return this.renderCard(card, selection);
  }

  private renderCard(card: PoolCardView, selection: CanvasSelection): HTMLElement {
    if (card.kind === "ticket") return this.renderTicketCard(card, selection);
    if (card.kind === "conversation") return this.renderConversationCard(card, selection);
    if (card.kind === "spawn") return this.renderSpawnCard(card, selection);
    return this.renderUtilityCard(card, selection);
  }

  // The world's size from the held positions and the last measured heights:
  // the same sum the fit after the commit makes, so the two agree and a
  // render with nothing moved writes nothing.
  private worldSize(cards: Positioned[]): { width: number; height: number } {
    return fitSize(
      cards.map((card) => {
        const pos = this.posOf(card);
        const size = this.sizes.get(card.id) ?? { w: CARD_WIDTH, h: 0 };
        return { x: pos.x, y: pos.y, ...size };
      }),
    );
  }

  private renderCanvasHeader(model: CanvasModel): HTMLElement {
    const edgeToggle = h("input", {
      type: "checkbox",
      checked: this.edgeMode === "ortho",
      onchange: (event: Event) => {
        this.edgeMode = (event.currentTarget as HTMLInputElement).checked ? "ortho" : "straight";
        this.routeEdges();
      },
    });
    return h(
      "div",
      { class: "canvas-header" },
      h("span", { class: "dim" }, canvasStatusText(model)),
      model.steward ? this.renderStewardOnDuty(model.steward) : null,
      model.mergeQueueLine
        ? h("span", { class: "canvas-merge-queue" }, model.mergeQueueLine)
        : null,
      model.spawnLine
        ? h(
            "button",
            {
              class: "canvas-spawn-line" + (model.spawnLine.warn ? " spawn-line-warn" : ""),
              type: "button",
              // The line ellipsises in a narrow header, so the hover says it whole.
              title: `${model.spawnLine.text} (open the pending and held spawns)`,
              onclick: () => this.onOpenHeldSpawns(),
            },
            model.spawnLine.text,
          )
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
        h(
          "button",
          {
            class: "btn canvas-start-steward",
            disabled: model.steward !== null,
            title: model.steward
              ? stewardLiveReason(model.steward)
              : "start a Steward to answer Interrupts while you are away",
            onclick: () => this.onStartSteward(),
          },
          "Start Steward",
        ),
        this.renderCloseTerminalsControl(model.closeTerminals),
        this.renderStopControl(model.stop),
        h(
          "button",
          {
            class: "btn",
            title: "restore default card positions and the needs input tray's width",
            onclick: () => {
              this.resetLayout(model.cards);
              this.applyPositions();
              this.fitWorld();
              this.routeEdges();
              this.onResetLayout();
            },
          },
          "reset layout",
        ),
      ),
    );
  }

  /**
   * The header's word that a Steward is on duty (ADR-0030), first after the
   * status line because it says who is answering while the operator is
   * away. A click selects the Steward's card and brings it into view. While
   * its Notices keep failing it is on duty but blind to every Interrupt, so
   * the line warns and the hover says why.
   */
  private renderStewardOnDuty(steward: StewardOnDutyView): HTMLElement {
    return h(
      "button",
      {
        class: "canvas-steward" + (steward.delivery ? " canvas-steward-warn" : ""),
        type: "button",
        title: steward.delivery
          ? `${steward.delivery.text} (${steward.delivery.lastError}); show its card`
          : `${steward.title} is on duty (show its card)`,
        onclick: () => this.onFocusSteward(steward.cardId),
      },
      stewardOnDutyLine(steward),
    );
  }

  /**
   * Pan the canvas so a card stands in view, its middle across and a third
   * of the way down, at the current zoom: the header's Steward line uses it
   * to take the operator to a card that may be far off screen.
   */
  reveal(nodeId: string): void {
    const pos = this.nodePos.get(nodeId);
    if (!pos || !this.canvas) return;
    const rect = this.canvas.viewport.getBoundingClientRect();
    // Whole pixels, as a drag leaves them, so the pan stays crisp.
    this.view.x = Math.round(rect.width / 2 - (pos.x + CARD_WIDTH / 2) * this.view.zoom);
    this.view.y = Math.round(rect.height / 3 - pos.y * this.view.zoom);
    this.view.seeded = true;
    this.applyTransform();
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
    return renderInlineConfirm({
      base: "canvas-stop",
      openClass: "btn-danger canvas-stop-server",
      label: "Stop server",
      title: "stop this pool's server",
      prompt: "Really stop?",
      confirmLabel: "Stop",
      requestingLabel: "stopping...",
      state: stop.state,
      failure: stop.failure,
      onArm: () => this.onArmStop(),
      onCancel: () => this.onCancelStop(),
      onConfirm: () => this.onConfirmStop(),
    });
  }

  /**
   * "Close N finished terminals" (issue #139): the herdr tabs this pool
   * opened whose Attempt or Conversation has ended, which the engine never
   * closes on its own. Hidden at zero, and behind the Stop control's inline
   * confirmation, since closing a tab takes its scrollback with it.
   */
  private renderCloseTerminalsControl(close: CloseTerminalsView): HTMLElement | null {
    if (!close.offered) return null;
    const noun = close.count === 1 ? "terminal" : "terminals";
    return renderInlineConfirm({
      base: "canvas-close-terminals",
      openClass: "canvas-close-terminals-open",
      label: `Close ${close.count} finished ${noun}`,
      title: "close the herdr tabs of Attempts and Conversations that have ended",
      prompt: `Really close ${close.count}?`,
      confirmLabel: "Close",
      requestingLabel: "closing...",
      state: close.state,
      failure: close.failure,
      onArm: () => this.onArmCloseTerminals(),
      onCancel: () => this.onCancelCloseTerminals(),
      onConfirm: () => this.onConfirmCloseTerminals(),
    });
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

  // A write reads the file fresh, so what another tab stored since is kept,
  // and the copy held for seeding follows it.
  private readStored(): Record<string, Point> {
    try {
      this.stored = parseStoredLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null"));
    } catch {
      this.stored = {};
    }
    return this.stored;
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

  // Seeding runs on every render but only has work when a card arrives, and
  // then reads the layout held since the first read, not the file.
  private seedPositions(cards: Positioned[]): void {
    if (cards.every((card) => this.nodePos.has(card.id))) return;
    const stored = this.stored ?? this.readStored();
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
      const box = this.canvas.boxes.get(id);
      if (box) {
        box.x = pos.x;
        box.y = pos.y;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Transform, edges, and drag
  // -------------------------------------------------------------------------

  // A press on a card starts a node drag, a press on blank space a pan;
  // either captures the pointer on the viewport, which keeps its node across
  // the renders that land while the pointer is down.
  // The card under the pointer, as the pointer crosses into an element (or
  // out of one, to wherever it went): reported only when it changes, so a
  // move inside one card says nothing.
  private hoverCard(target: EventTarget | null): void {
    const card = target instanceof Element ? target.closest(".node-card") : null;
    const id = card instanceof HTMLElement ? (card.dataset.nodeId ?? null) : null;
    if (id === this.hoveredCard) return;
    this.hoveredCard = id;
    this.onCardHover(id);
  }

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
      // The held position follows the pointer at once, so a render landing
      // mid-drag draws the card where the pointer has it; moving the card
      // and its edges waits for the next frame, once for however many moves
      // came before it (issue #157).
      this.nodePos.set(this.drag.nodeId, {
        x: this.drag.startNode.x + dx / this.view.zoom,
        y: this.drag.startNode.y + dy / this.view.zoom,
      });
      if (!this.dragFrame) {
        this.dragFrame = true;
        nextFrame(() => this.paintDrag());
      }
    } else {
      this.view.x = this.drag.startView.x + dx;
      this.view.y = this.drag.startView.y + dy;
      this.canvas.viewport.classList.add("canvas-panning");
      this.applyTransform();
    }
  }

  /**
   * A card drag's frame: the card to its held position, its box with it,
   * the world fitted around it, and the edges that touch it re-routed. No
   * layout is read: a dragged card keeps the size last measured.
   */
  private paintDrag(): void {
    if (!this.dragFrame) return;
    this.dragFrame = false;
    if (this.drag?.kind !== "node" || !this.canvas) return;
    const id = this.drag.nodeId;
    const pos = this.nodePos.get(id);
    const el = this.canvas.nodesById.get(id);
    if (!pos || !el) return;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.classList.add("node-card-dragging");
    const box = this.canvas.boxes.get(id);
    if (box) {
      box.x = pos.x;
      box.y = pos.y;
    }
    this.fitWorld();
    this.routeEdges(id);
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

  // The strokes depend on the zoom alone, so a pan, which moves the world
  // and not the zoom, rewrites none of them.
  private paintStrokeScale(): void {
    if (!this.canvas || this.strokeZoom === this.view.zoom) return;
    this.strokeZoom = this.view.zoom;
    for (const edge of this.canvas.edges.values()) this.strokeEdge(edge);
  }

  /** An edge's stroke, dash and label size, held constant on screen at any zoom. */
  private strokeEdge(edge: DrawnEdge): void {
    const zoom = this.view.zoom;
    edge.el.setAttribute("stroke-width", String(strokeWidthForZoom(zoom)));
    if (edge.dashed) edge.el.setAttribute("stroke-dasharray", `${4 / zoom} ${3 / zoom}`);
    else edge.el.removeAttribute("stroke-dasharray");
    edge.label?.setAttribute("font-size", String(10 / zoom));
  }

  /** Re-route the drawn edges from the held boxes, or only those touching one card. */
  private routeEdges(only?: string): void {
    if (!this.canvas) return;
    for (const edge of this.canvas.edges.values()) {
      if (only !== undefined && edge.source !== only && edge.target !== only) continue;
      this.routeEdge(edge);
    }
  }

  /** Route one edge between its cards' boxes; a route that did not move is not written. */
  private routeEdge(edge: DrawnEdge): void {
    const source = this.canvas?.boxes.get(edge.source);
    const target = this.canvas?.boxes.get(edge.target);
    if (!source || !target) return;
    const geom = edgePath(source, target, this.edgeMode);
    const route = `${geom.d}|${geom.lx}|${geom.ly}`;
    if (route === edge.route) return;
    edge.route = route;
    edge.el.setAttribute("d", geom.d);
    edge.label?.setAttribute("x", String(geom.lx));
    edge.label?.setAttribute("y", String(geom.ly));
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
    // A move still waiting on its frame lands first, so the drag ends where
    // the pointer let go.
    this.paintDrag();
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

  // The edge layer's children are the canvas's own, drawn after the commit,
  // so the morph is told to leave them be and only the layer itself renders.
  private makeSvg(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "canvas-edges");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute(KEEP_CHILDREN, "");
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

  /**
   * Read every card's size in one pass: the one layout read a render makes.
   * A card's position is the held layout's, which is what the render just
   * wrote into its style.
   */
  private measure(): void {
    if (!this.canvas) return;
    for (const [id, el] of this.canvas.nodesById) {
      const pos = this.nodePos.get(id) ?? { x: el.offsetLeft, y: el.offsetTop };
      const box = { x: pos.x, y: pos.y, w: el.offsetWidth, h: el.offsetHeight };
      this.canvas.boxes.set(id, box);
      this.sizes.set(id, { w: box.w, h: box.h });
    }
    for (const id of [...this.sizes.keys()]) {
      if (!this.canvas.nodesById.has(id)) this.sizes.delete(id);
    }
  }

  /** Fit the world around the cards' boxes; a size it already has is not written again. */
  private fitWorld(): void {
    if (!this.canvas) return;
    const size = fitSize(this.canvas.boxes.values());
    const style = this.canvas.world.style;
    if (style.width !== `${size.width}px`) style.width = `${size.width}px`;
    if (style.height !== `${size.height}px`) style.height = `${size.height}px`;
  }

  /**
   * Draw the model's edges into the kept layer: one already drawn is
   * updated in place, its class, label and route written only where they
   * moved; a new one is added; one the model no longer has is removed.
   * Keyed by source and target, counted for a pair drawn twice.
   */
  private drawEdges(edges: TopologyEdge[], selectedId: string | null): void {
    if (!this.canvas) return;
    const { svg, boxes, edges: drawn } = this.canvas;
    const wanted = new Set<string>();
    const pairs = new Map<string, number>();
    for (const edge of edges) {
      if (!boxes.has(edge.source) || !boxes.has(edge.target)) continue;
      const pair = `${edge.source}>${edge.target}`;
      const n = pairs.get(pair) ?? 0;
      pairs.set(pair, n + 1);
      const key = `${pair}#${n}`;
      wanted.add(key);
      const dashed = edge.conditional === true || edge.proposed === true;
      let line = drawn.get(key);
      if (!line) {
        const el = document.createElementNS(SVG_NS, "path");
        el.setAttribute("marker-end", `url(#${ARROW_ID})`);
        svg.appendChild(el);
        line = { el, label: null, source: edge.source, target: edge.target, dashed, route: "" };
        drawn.set(key, line);
        this.strokeEdge(line);
      }
      const cls =
        "canvas-edge" +
        (edge.conditional ? " canvas-edge-conditional" : "") +
        (edge.proposed ? " canvas-edge-proposed" : "") +
        (edge.target === selectedId ? " canvas-edge-inflow" : "") +
        (edge.source === selectedId ? " canvas-edge-outflow" : "");
      if (line.el.getAttribute("class") !== cls) line.el.setAttribute("class", cls);
      if (line.dashed !== dashed) {
        line.dashed = dashed;
        this.strokeEdge(line);
      }
      if (edge.data) {
        if (!line.label) {
          line.label = document.createElementNS(SVG_NS, "text");
          line.label.setAttribute("class", "canvas-edge-label");
          line.el.after(line.label);
          // The new label needs placing even where the path did not move.
          line.route = "";
          this.strokeEdge(line);
        }
        if (line.label.textContent !== edge.data) line.label.textContent = edge.data;
      } else if (line.label) {
        line.label.remove();
        line.label = null;
      }
      this.routeEdge(line);
    }
    for (const [key, line] of drawn) {
      if (wanted.has(key)) continue;
      line.el.remove();
      line.label?.remove();
      drawn.delete(key);
    }
    this.paintStrokeScale();
  }
}

/** The world's size around a set of card boxes: room for each and a margin,
 *  never under the minimum. */
function fitSize(boxes: Iterable<CardBox>): { width: number; height: number } {
  let width = WORLD_MIN_WIDTH;
  let height = 400;
  for (const box of boxes) {
    width = Math.max(width, box.x + box.w + 48);
    height = Math.max(height, box.y + box.h + 48);
  }
  return { width, height };
}
