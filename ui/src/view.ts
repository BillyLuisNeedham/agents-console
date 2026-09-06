/**
 * The view's composition root: a thin layer over the view model from
 * project.ts. All data flows in through `ConsoleView.render`; all user
 * intent flows out through `Handlers`. The canvas (pan, zoom, drag, edge
 * routing, persisted positions), the Detail (render, width drag, fullscreen,
 * interrupt forms, note drafts), and the drawers (strip render and resize)
 * each live in their own module owning their own state; this module owns
 * only the selection and wires the three together.
 */

import {
  flowNeighbourhood,
  nextNodeSelection,
  type DetailTab,
  type DetailTabView,
  type DetailView,
  type InterruptAction,
  type LogPaneView,
  type NeedsInputRow,
  type PoolCardView,
  type PoolPhase,
  type TimelineView,
  type TopologyEdge,
} from "./project";
import { restoreLogScroll } from "./log-pane";
import { Canvas } from "./canvas";
import { Detail } from "./detail";
import { Drawers } from "./drawers";
import { NeedsInputTray, type NeedsInputOptions } from "./needs-input";
import { h } from "./dom";

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
  /** The ticket Detail's tab bar; null for a utility Detail or no selection. */
  detailTabs: DetailTabView[] | null;
  /** The selected ticket's body: undefined while the first fetch is out, null for known-missing. */
  detailBody: string | null | undefined;
  /** The last body fetch's failure for the selected ticket, if any. */
  detailBodyError: string | null;
  timeline: TimelineView | null;
  logPane: LogPaneView | null;
  /** The Needs input tray's rows: every card holding an unresolved interrupt. */
  needsInput: NeedsInputRow[];
}

export interface Handlers {
  onToggleLog: () => void;
  onToggleInspector: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectAttempt: (ticketId: string, attempt: number) => void;
  onSelectStream: (ticketId: string, attempt: number) => void;
  onLoadEarlier: (ticketId: string, attempt: number) => void;
  onAnswer: (ticketId: string, action: InterruptAction, note?: string) => void;
  onSelectTab: (ticketId: string, tab: DetailTab) => void;
}

export type ConsoleViewOptions = NeedsInputOptions & {
  /** "Open in herdr": focus the attempt's pane; resolves false on failure. */
  onFocusTerminal: (ticketId: string) => Promise<boolean>;
};

/**
 * The per-session view state: one instance created by the bootstrap, holding
 * the selection plus the three sub-views with their own state, so a session's
 * dragged positions, panel width, drawer height, and note drafts survive the
 * full-DOM rebuild on every snapshot. The tray's answer seam and re-render
 * trigger are wired here once, the LogPane way: async IO plus change
 * notification belong to the module, not the render pass.
 */
export class ConsoleView {
  private readonly canvas: Canvas;
  private readonly detail = new Detail({
    onClose: () => this.closeDetail(),
  });
  private readonly drawers = new Drawers();
  private readonly needsInput: NeedsInputTray;
  // The selection survives the rebuild (snapshots never close the panel or
  // lose the selection); its one-hop flow neighbourhood is recomputed from
  // the model's edges on every render, so a live snapshot re-derives the
  // highlight instead of stripping it.
  private selectedNodeId: string | null = null;
  private onSelectNode: ((nodeId: string | null) => void) | null = null;

  constructor(options: ConsoleViewOptions) {
    this.canvas = new Canvas({
      onCardTap: (nodeId) => this.selectNode(nodeId),
      onFocusTerminal: options.onFocusTerminal,
    });
    this.needsInput = new NeedsInputTray(options);
  }

  render(root: HTMLElement, model: AppModel, handlers: Handlers): void {
    this.canvas.cancelDrag();
    this.drawers.cancelDrag();
    this.detail.cancelDrag();
    this.onSelectNode = handlers.onSelectNode;
    this.canvas.sync(model.cards);
    const pendingInterrupts = new Set(model.needsInput.map((row) => row.ticketId));
    this.detail.pruneDrafts(pendingInterrupts);
    this.needsInput.pruneDrafts(pendingInterrupts);
    this.needsInput.pruneFailures(pendingInterrupts);
    const noteFocus = this.detail.captureNoteFocus();
    const trayFocus = this.needsInput.captureNoteFocus();
    const hood = flowNeighbourhood(model.edges, this.selectedNodeId);
    const selection = {
      selectedId: this.selectedNodeId,
      inflow: new Set(hood.inflow),
      outflow: new Set(hood.outflow),
    };
    const content = h(
      "div",
      { class: "content" },
      this.canvas.render(model, selection),
      model.detail ? this.detail.renderHandle() : null,
      this.detail.render(model, handlers),
      this.needsInput.render(model.needsInput, {
        onSelect: (cardId) => this.selectNode(cardId),
      }),
    );
    root.replaceChildren(
      h("div", { class: "shell" }, content, this.drawers.render(model, handlers)),
    );
    this.detail.afterRender();
    const logPaneKey =
      model.detail?.kind === "ticket" &&
      model.logPane &&
      !model.logPane.neverRun &&
      model.logPane.selectedAttempt !== null
        ? `${model.detail.ticketId}:${model.logPane.selectedAttempt}` +
          (model.logPane.stream ? ":stream" : "")
        : null;
    restoreLogScroll(logPaneKey);
    this.detail.restoreNoteFocus(root, noteFocus);
    this.needsInput.restoreNoteFocus(root, trayFocus);
    const world = root.querySelector(".canvas-world");
    const viewport = root.querySelector(".canvas-viewport");
    if (world instanceof HTMLElement && viewport instanceof HTMLElement) {
      this.canvas.bindCanvas(viewport, world, model.edges, this.selectedNodeId);
    } else {
      this.canvas.unbind();
    }
  }

  private selectNode(nodeId: string): void {
    this.detail.exitFullscreen();
    this.selectedNodeId = nextNodeSelection(this.selectedNodeId, nodeId);
    this.onSelectNode?.(this.selectedNodeId);
  }

  private closeDetail(): void {
    this.detail.exitFullscreen();
    this.selectedNodeId = null;
    this.onSelectNode?.(null);
  }
}
