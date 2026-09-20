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
  nextNodeSelection,
  type ConversationNeedsInputRow,
  type ConversationTrayRow,
  type DetailTab,
  type DetailTabView,
  type DetailView,
  type EnlistBlockRow,
  type LogPaneView,
  type NeedsInputRow,
  type PoolCardView,
  type ResumeAction,
  type RunPhase,
  type TimelineView,
} from "./project";
import { flowNeighbourhood, type TopologyEdge } from "./geometry";
import { restoreLogScroll } from "./log-pane";
import { Canvas } from "./canvas";
import {
  ConversationsTray,
  type ConversationsOptions,
} from "./conversations";
import { EnlistStore, type EnlistHandler, type ListPanesHandler } from "./enlist";
import { Detail, type DetailHandlers } from "./detail";
import { Drawers } from "./drawers";
import { NeedsInputTray, type NeedsInputOptions } from "./needs-input";
import { h } from "./dom";

/** The Stop control's three states (issue #97): the button, the inline
 *  "Really stop?" confirmation, and the POST in flight. */
export type StopState = "idle" | "armed" | "requesting";

/**
 * The Stop control's view slice (issue #97). `offered` gates the button on a
 * done pool over a live stream; `state` is the inline confirmation's state
 * machine; `failure` is a refused or failed request's reason, shown beside
 * the button rather than on the global banner; `stoppedFromHere` marks the
 * tab that asked for the stop; `relaunch` is the command the stopped notice
 * prints for getting the server back.
 */
export interface StopView {
  offered: boolean;
  state: StopState;
  failure: string | null;
  stoppedFromHere: boolean;
  relaunch: string | null;
}

export interface AppModel {
  phase: RunPhase | null;
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
  /** The Stop control and the stopped-server notice (issue #97). */
  stop: StopView;
  /** The pool is Terminal-backed: the header offers Enlist only then. */
  terminalBacked: boolean;
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
  /** Needs input's Conversation rows: live Conversations waiting on the operator. */
  conversationsNeedsInput: ConversationNeedsInputRow[];
  /** The Conversations tray's rows, already sorted. */
  conversationsTray: ConversationTrayRow[];
  /** The pool's default Assignment, shown as the New Conversation form's placeholders. */
  conversationDefaults: { harness?: string; model?: string; drivers?: string };
  /** The Enlist form's "Blocks" tick list: every ticket not yet done. */
  enlistBlocks: EnlistBlockRow[];
}

export interface Handlers {
  onToggleLog: () => void;
  onToggleInspector: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectAttempt: (ticketId: string, attempt: number) => void;
  onSelectStream: (ticketId: string, attempt: number) => void;
  onLoadEarlier: (ticketId: string, attempt: number) => void;
  onAnswer: (ticketId: string, action: ResumeAction, note?: string) => void;
  onSelectTab: (ticketId: string, tab: DetailTab) => void;
  /** The Stop control's three intents (issue #97): raise the inline
   *  confirmation, drop it (nothing is sent), and send the stop. */
  onArmStop: () => void;
  onCancelStop: () => void;
  onConfirmStop: () => void;
}

export type ConsoleViewOptions = NeedsInputOptions &
  ConversationsOptions & {
    /** "Open in herdr": focus a ticket's or a Conversation's pane; both are
     *  the same server-side seam, keyed by id. Resolves false on failure. */
    onFocusTerminal: (id: string) => Promise<boolean>;
    /** The Enlist picker's pane read (issue #101): fetched when the picker
     *  opens, never through the snapshot. */
    onListPanes: ListPanesHandler;
    /** The Enlist form's submit (issue #101): the engine writes the ticket. */
    onEnlist: EnlistHandler;
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
  private readonly conversationsTray: ConversationsTray;
  private readonly enlist: EnlistStore;
  private readonly onFocusTerminal: (id: string) => Promise<boolean>;
  // The selection survives the rebuild (snapshots never close the panel or
  // lose the selection); its one-hop flow neighbourhood is recomputed from
  // the model's edges on every render, so a live snapshot re-derives the
  // highlight instead of stripping it.
  private selectedNodeId: string | null = null;
  private onSelectNode: ((nodeId: string | null) => void) | null = null;
  // The canvas header's Stop control is built once with the canvas, but its
  // intents belong to the render handlers, so they land through the latest
  // render's set, the way the selection does.
  private stopHandlers: Pick<
    Handlers,
    "onArmStop" | "onCancelStop" | "onConfirmStop"
  > | null = null;

  constructor(options: ConsoleViewOptions) {
    this.onFocusTerminal = options.onFocusTerminal;
    this.conversationsTray = new ConversationsTray(options);
    this.enlist = new EnlistStore({
      onListPanes: options.onListPanes,
      onEnlist: options.onEnlist,
      onChange: options.onChange,
    });
    this.canvas = new Canvas({
      onCardTap: (nodeId) => this.selectNode(nodeId),
      onFocusTerminal: options.onFocusTerminal,
      onNewConversation: () => this.conversationsTray.openForm(),
      onEnlist: () => {
        void this.enlist.openPicker();
      },
      onEndConversation: (conversationId) => {
        void this.conversationsTray.endConversation(conversationId);
      },
      onArmStop: () => this.stopHandlers?.onArmStop(),
      onCancelStop: () => this.stopHandlers?.onCancelStop(),
      onConfirmStop: () => this.stopHandlers?.onConfirmStop(),
    });
    this.needsInput = new NeedsInputTray(options);
  }

  /** The Conversations store's per-conversation End state, for the pool
   *  projection's endings map (mirrors the terminal store's `.state()`). */
  conversationEndState(): Record<string, { ending: boolean; failure: string | null }> {
    return this.conversationsTray.endState();
  }

  render(root: HTMLElement, model: AppModel, handlers: Handlers): void {
    this.canvas.cancelDrag();
    this.drawers.cancelDrag();
    this.detail.cancelDrag();
    this.onSelectNode = handlers.onSelectNode;
    this.stopHandlers = handlers;
    this.canvas.sync(model.cards);
    const pendingInterrupts = new Set(model.needsInput.map((row) => row.ticketId));
    this.detail.pruneDrafts(pendingInterrupts);
    this.needsInput.pruneDrafts(pendingInterrupts);
    this.needsInput.pruneFailures(pendingInterrupts);
    this.conversationsTray.pruneEndFailures(
      new Set(model.conversationsTray.map((row) => row.id)),
    );
    const noteFocus = this.detail.captureNoteFocus();
    const trayFocus = this.needsInput.captureNoteFocus();
    const hood = flowNeighbourhood(model.edges, this.selectedNodeId);
    const selection = {
      selectedId: this.selectedNodeId,
      inflow: new Set(hood.inflow),
      outflow: new Set(hood.outflow),
    };
    const detailHandlers: DetailHandlers = {
      ...handlers,
      onEndConversation: (conversationId: string, closing?: string) => {
        void this.conversationsTray.endConversation(conversationId, closing);
      },
      onFocusConversationTerminal: (conversationId: string) =>
        this.onFocusTerminal(conversationId),
    };
    // The two trays overlay the canvas column, not the window: anchored to
    // its edges they stay clear of the Detail beside it, however wide the
    // operator drags that (issue #70).
    const canvasColumn = h(
      "div",
      { class: "canvas-column" },
      this.canvas.render(model, selection),
      this.needsInput.render(model.needsInput, model.conversationsNeedsInput, {
        onSelect: (cardId) => this.selectNode(cardId),
        onFocusConversation: (conversationId) => this.onFocusTerminal(conversationId),
      }),
      this.conversationsTray.render(model.conversationsTray, model.conversationDefaults, {
        onSelect: (cardId) => this.selectNode(cardId),
      }),
      this.enlist.render(model.enlistBlocks),
    );
    const content = h(
      "div",
      { class: "content" },
      canvasColumn,
      model.detail ? this.detail.renderHandle() : null,
      this.detail.render(model, detailHandlers),
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
