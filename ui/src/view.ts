/**
 * The view's composition root: a thin layer over the view model from
 * project.ts. All data flows in through `ConsoleView.render`; all user
 * intent flows out through `Handlers`. The canvas (pan, zoom, drag, edge
 * routing, persisted positions), the Detail (render, width drag, fullscreen,
 * interrupt forms), and the drawers (strip render and resize) each live in
 * their own module owning their own state; this module owns the selection
 * and the Draft answers the Detail and the Needs input tray share, and wires
 * them together.
 */

import {
  nextNodeSelection,
  type ConversationNeedsInputRow,
  type ConversationTrayRow,
  type DetailTab,
  type DetailTabView,
  type DetailView,
  type EnlistBlockRow,
  type HeldSpawnRow,
  type PendingSpawnRow,
  type LogPaneView,
  type NeedsInputRow,
  type PoolCardView,
  type ReassignTicketRow,
  type ResumeAction,
  type RunPhase,
  type SpawnLineView,
  type StewardOnDutyView,
  type TimelineView,
} from "./project";
import { flowNeighbourhood, type TopologyEdge } from "./geometry";
import { settleLogScroll } from "./log-pane";
import { commit } from "./morph";
import { Canvas } from "./canvas";
import {
  ConversationsTray,
  type ConversationsOptions,
} from "./conversations";
import { EnlistStore, type EnlistHandler, type ListPanesHandler } from "./enlist";
import {
  SettingsStore,
  type GetSettingsHandler,
  type SaveMachineHandler,
  type SavePoolHandler,
} from "./settings";
import { ReassignStore, type ReassignHandler } from "./reassign";
import {
  HeldSpawnsStore,
  type HeldSpawnHandler,
  type PendingSpawnHandler,
} from "./held-spawns";
import { Detail, type DetailHandlers } from "./detail";
import { DraftAnswers } from "./drafts";
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

/**
 * The Restart control's view slice (ADR-0026, issue #121). `offered` gates
 * the control on a live stream in any phase, since a boot-only key takes
 * effect no other way; `state` is the same inline confirmation machine the
 * Stop control uses; `failure` is a refusal's reason, shown beside the
 * button; `waiting` marks the tab that asked, which is the one tab that can
 * honestly say the server is coming back rather than gone.
 */
export interface RestartView {
  offered: boolean;
  state: StopState;
  failure: string | null;
  waiting: boolean;
}

/**
 * The pool header's "Close N finished terminals" control (issue #139).
 * `offered` gates it on a live stream with at least one Finished terminal
 * open; `count` is the snapshot's; `state` is the Stop control's inline
 * confirmation machine; `failure` is a refusal's reason, shown beside it.
 */
export interface CloseTerminalsView {
  offered: boolean;
  count: number;
  state: StopState;
  failure: string | null;
}

export interface AppModel {
  /** The pool as the Console names it (issue #100): Pool title, else directory. */
  poolName: string | null;
  phase: RunPhase | null;
  phaseLabel: string;
  cards: PoolCardView[];
  edges: TopologyEdge[];
  log: string[];
  logOpen: boolean;
  /** The State inspector's text; empty while the drawer is closed. */
  inspectorJson: string;
  inspectorOpen: boolean;
  connected: boolean;
  seq: number;
  error: string | null;
  /** The Stop control and the stopped-server notice (issue #97). */
  stop: StopView;
  /** The Settings pane's Restart control and the restarting notice (ADR-0026). */
  restart: RestartView;
  /** The pool header's bulk close of Finished terminals (issue #139). */
  closeTerminals: CloseTerminalsView;
  /** The pool is Terminal-backed: the header offers Enlist only then. */
  terminalBacked: boolean;
  /** The canvas header's Merge queue line (issue #129); null with no hold. */
  mergeQueueLine: string | null;
  /** The canvas header's Spawn caps line (issue #149); null before a snapshot. */
  spawnLine: SpawnLineView | null;
  /** The Pending spawns the Spawn caps line's list shows first (issue #150). */
  pendingSpawns: PendingSpawnRow[];
  /** The Held spawns list the Spawn caps line opens (issue #149). */
  heldSpawns: HeldSpawnRow[];
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
  /** The Steward on duty (ADR-0030); null when none is. The header names it,
   *  and Start Steward and Enlist as Steward stand disabled while it is. */
  steward: StewardOnDutyView | null;
  /** The Steward's Assignment (its Pool settings entry over the pool
   *  defaults), shown as the Start Steward form's placeholders. */
  stewardDefaults: { harness?: string; model?: string; effort?: string; drivers?: string };
  /** The Enlist form's "Blocks" tick list: every ticket not yet done. */
  enlistBlocks: EnlistBlockRow[];
  /** Reassign (issue #126): every ticket the engine says can be reassigned,
   *  as the bulk dialog lists them. */
  reassignTickets: ReassignTicketRow[];
}

export interface Handlers {
  onToggleLog: () => void;
  onToggleInspector: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onSelectAttempt: (ticketId: string, attempt: number) => void;
  onSelectStream: (ticketId: string, attempt: number) => void;
  onLoadEarlier: (ticketId: string, attempt: number) => void;
  onAnswer: (ticketId: string, action: ResumeAction, note?: string) => void;
  /** Keep talking on a checkpoint with a Held pane (issue #139), from the
   *  Detail or the Needs input tray; the session holds its state. */
  onKeepTalking: (ticketId: string) => void;
  onSelectTab: (ticketId: string, tab: DetailTab) => void;
  /** The Stop control's three intents (issue #97): raise the inline
   *  confirmation, drop it (nothing is sent), and send the stop. */
  onArmStop: () => void;
  onCancelStop: () => void;
  onConfirmStop: () => void;
  /** The Restart control's three intents (ADR-0026), the Stop control's
   *  shape exactly. Cancel sends nothing. */
  onArmRestart: () => void;
  onCancelRestart: () => void;
  onConfirmRestart: () => void;
  /** The pool header's close-finished-terminals control (issue #139), the
   *  Stop control's three intents again. Cancel sends nothing. */
  onArmCloseTerminals: () => void;
  onCancelCloseTerminals: () => void;
  onConfirmCloseTerminals: () => void;
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
    /** The Settings pane's read and its two writes (ADR-0026), fetched when
     *  the pane opens rather than through the snapshot. */
    onGetSettings: GetSettingsHandler;
    onSavePoolSettings: SavePoolHandler;
    onSaveMachineDefaults: SaveMachineHandler;
    /** The Reassign write (issue #126). It answers with a fresh snapshot,
     *  which the bootstrap pushes through setSnapshot. */
    onReassign: ReassignHandler;
    /** A Held spawn's Adopt and Discard (issue #149, ADR-0029). The engine
     *  pushes the snapshot that shows either, so neither answers with one. */
    onAdoptHeldSpawn: HeldSpawnHandler;
    onDiscardHeldSpawn: HeldSpawnHandler;
    /** A Pending spawn's Hold and Discard (issue #150), the same way. */
    onHoldPendingSpawn: PendingSpawnHandler;
    onDiscardPendingSpawn: PendingSpawnHandler;
  };

/**
 * The per-session view state: one instance created by the bootstrap, holding
 * the selection plus the three sub-views with their own state, so a session's
 * dragged positions, panel width, drawer height, and note drafts render the
 * same on every snapshot. Every render builds the whole page afresh with
 * `h`, and the commit morphs the page already on screen to match it
 * (morph.ts, ADR-0025): a node that is still wanted is the same node, so
 * scroll positions, focus and caret, hover, and a drag in flight survive on
 * their own. What runs after the commit is what needs layout: the log pane's
 * tail pin and the canvas's edge routes. The tray's answer seam and
 * re-render trigger are wired here once, the LogPane way: async IO plus
 * change notification belong to the module, not the render pass.
 */
export class ConsoleView {
  private readonly canvas: Canvas;
  // One Draft answer per ticket, whichever surface it is typed in (issue
  // #147): the Detail and the Needs input tray both read and write this
  // store, and the render prunes it once.
  private readonly drafts = new DraftAnswers();
  private readonly detail = new Detail({
    onClose: () => this.closeDetail(),
    drafts: this.drafts,
  });
  private readonly drawers = new Drawers();
  private readonly needsInput: NeedsInputTray;
  private readonly conversationsTray: ConversationsTray;
  private readonly enlist: EnlistStore;
  private readonly settings: SettingsStore;
  private readonly reassign: ReassignStore;
  private readonly heldSpawns: HeldSpawnsStore;
  private readonly onFocusTerminal: (id: string) => Promise<boolean>;
  private readonly onChange: () => void;
  // The selection outlives any one render (snapshots never close the panel
  // or lose the selection); its one-hop flow neighbourhood is recomputed from
  // the model's edges on every render, so a live snapshot re-derives the
  // highlight instead of stripping it.
  private selectedNodeId: string | null = null;
  private onSelectNode: ((nodeId: string | null) => void) | null = null;
  // The canvas header's Stop and close-finished-terminals controls are
  // built once with the canvas, but their intents belong to the render
  // handlers, so they land through the latest render's set, the way the
  // selection does.
  private headerHandlers: Pick<
    Handlers,
    | "onArmStop"
    | "onCancelStop"
    | "onConfirmStop"
    | "onArmCloseTerminals"
    | "onCancelCloseTerminals"
    | "onConfirmCloseTerminals"
  > | null = null;

  constructor(options: ConsoleViewOptions) {
    this.onFocusTerminal = options.onFocusTerminal;
    this.onChange = options.onChange;
    this.conversationsTray = new ConversationsTray(options);
    this.enlist = new EnlistStore({
      onListPanes: options.onListPanes,
      onEnlist: options.onEnlist,
      onChange: options.onChange,
    });
    this.reassign = new ReassignStore({
      onGetSettings: options.onGetSettings,
      onReassign: options.onReassign,
      onChange: options.onChange,
    });
    this.heldSpawns = new HeldSpawnsStore({
      onAdopt: options.onAdoptHeldSpawn,
      onDiscard: options.onDiscardHeldSpawn,
      onHold: options.onHoldPendingSpawn,
      onDiscardPending: options.onDiscardPendingSpawn,
      onChange: options.onChange,
    });
    this.settings = new SettingsStore({
      onGetSettings: options.onGetSettings,
      onSavePool: options.onSavePoolSettings,
      onSaveMachine: options.onSaveMachineDefaults,
      onOpenReassign: () => this.reassign.openDialog(),
      onChange: options.onChange,
    });
    this.canvas = new Canvas({
      onChange: options.onChange,
      onCardTap: (nodeId) => this.selectNode(nodeId),
      onFocusTerminal: options.onFocusTerminal,
      onNewConversation: () => this.conversationsTray.openForm(),
      onStartSteward: () => this.conversationsTray.openStewardForm(),
      onFocusSteward: (cardId) => this.focusCard(cardId),
      onEnlist: () => {
        void this.enlist.openPicker();
      },
      onOpenSettings: () => this.settings.toggle(),
      onOpenHeldSpawns: () => this.heldSpawns.toggle(),
      onResetLayout: () => this.needsInput.resetWidth(),
      onEndConversation: (conversationId) => {
        void this.conversationsTray.endConversation(conversationId);
      },
      onArmStop: () => this.headerHandlers?.onArmStop(),
      onCancelStop: () => this.headerHandlers?.onCancelStop(),
      onConfirmStop: () => this.headerHandlers?.onConfirmStop(),
      onArmCloseTerminals: () => this.headerHandlers?.onArmCloseTerminals(),
      onCancelCloseTerminals: () => this.headerHandlers?.onCancelCloseTerminals(),
      onConfirmCloseTerminals: () => this.headerHandlers?.onConfirmCloseTerminals(),
    });
    this.needsInput = new NeedsInputTray({ ...options, drafts: this.drafts });
  }

  /** The Conversations store's per-conversation End state, for the pool
   *  projection's endings map (mirrors the terminal store's `.state()`). */
  conversationEndState(): Record<string, { ending: boolean; failure: string | null }> {
    return this.conversationsTray.endState();
  }

  render(root: HTMLElement, model: AppModel, handlers: Handlers): void {
    this.onSelectNode = handlers.onSelectNode;
    this.headerHandlers = handlers;
    this.canvas.sync(model.cards);
    const pendingInterrupts = new Set(model.needsInput.map((row) => row.ticketId));
    this.drafts.prune(pendingInterrupts);
    this.needsInput.pruneFailures(pendingInterrupts);
    this.conversationsTray.pruneEndFailures(
      new Set(model.conversationsTray.map((row) => row.id)),
    );
    // A Reassign draft belongs to a ticket a write could still reach; one
    // that started an Attempt or finished loses its draft rather than
    // holding an edit that can no longer land.
    this.reassign.pruneDrafts(new Set(model.reassignTickets.map((row) => row.id)));
    this.heldSpawns.prune(
      new Set([...model.pendingSpawns, ...model.heldSpawns].map((row) => row.id)),
    );
    // The harness list is read once, when a Reassign surface first needs it.
    if (model.detail?.kind === "ticket" && model.detail.reassign.eligible) {
      this.reassign.ensureHarnesses();
    }
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
      onFocusResolver: (ticketId: string) => this.onFocusTerminal(ticketId),
      // "Use as answer" on a Steward note (ADR-0030): the note becomes the
      // shared Draft answer, so the tray's row shows it too.
      onUseStewardNote: (ticketId: string, text: string) => {
        this.drafts.set(ticketId, text);
        this.onChange();
      },
      reassign: this.reassign,
      renderSpawnDecision: (row, state) => this.heldSpawns.renderDecision(row, state),
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
        onKeepTalking: handlers.onKeepTalking,
        onExpand: (cardId, ticketId) => this.writeFullSize(cardId, ticketId, handlers),
      }),
      this.conversationsTray.render(
        model.conversationsTray,
        model.conversationDefaults,
        { onSelect: (cardId) => this.selectNode(cardId) },
        { onDuty: model.steward, defaults: model.stewardDefaults },
      ),
      this.enlist.render(model.enlistBlocks, model.steward),
      this.settings.render(model.restart, handlers),
      this.reassign.render(model.reassignTickets),
      model.spawnLine
        ? this.heldSpawns.render(model.pendingSpawns, model.heldSpawns, model.spawnLine)
        : null,
    );
    const content = h(
      "div",
      { class: "content" },
      canvasColumn,
      model.detail ? this.detail.renderHandle() : null,
      this.detail.render(model, detailHandlers),
    );
    commit(root, () =>
      h("div", { class: "shell" }, content, this.drawers.render(model, handlers)),
    );
    const logPaneKey =
      model.detail?.kind === "ticket" &&
      model.logPane &&
      !model.logPane.neverRun &&
      model.logPane.selectedAttempt !== null
        ? `${model.detail.ticketId}:${model.logPane.selectedAttempt}` +
          (model.logPane.stream ? ":stream" : "")
        : null;
    settleLogScroll(logPaneKey);
    this.detail.settleNoteFocus(root);
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

  // The header's Steward line (ADR-0030): its card selected, its Detail
  // open, and the canvas panned to it. A select rather than a toggle, so a
  // second click never closes what the first opened; and out of fullscreen,
  // which would cover the card it brings into view.
  private focusCard(cardId: string): void {
    this.detail.exitFullscreen();
    this.selectedNodeId = cardId;
    this.canvas.reveal(cardId);
    this.onSelectNode?.(cardId);
  }

  // A Needs input row's expand (issue #147): the ticket's Detail, full size
  // on Progress with its note focused. Selecting a card leaves fullscreen,
  // so the selection comes first; a card already selected is not selected
  // again, which would close it. The tab change renders, and that render's
  // commit focuses the note.
  private writeFullSize(cardId: string, ticketId: string, handlers: Handlers): void {
    if (this.selectedNodeId !== cardId) this.selectNode(cardId);
    this.detail.writeFullSize(ticketId);
    handlers.onSelectTab(ticketId, "progress");
  }

  private closeDetail(): void {
    this.detail.exitFullscreen();
    this.selectedNodeId = null;
    this.onSelectNode?.(null);
  }
}
