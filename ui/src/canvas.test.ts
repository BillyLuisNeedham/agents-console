/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Canvas, canvasStatusText, type CanvasModel } from "./canvas";
import { commit as commitTree } from "./morph";
import { useDom } from "./test-dom";
import { projectPool, type EnrichedSnapshot } from "./project";
import type { CloseTerminalsView, RestartView, StopView } from "./view";
import type { TopologyEdge } from "./geometry";

useDom();

// The canvas header's status line, pinned as a pure function, and the
// mechanics that must hold across a morphing render: the viewport keeps its
// node from one render to the next, so a listener bound per render would
// stack, and a drag in flight would lose its floor.

function stop(overrides: Partial<StopView> = {}): StopView {
  return {
    offered: false,
    state: "idle",
    failure: null,
    stoppedFromHere: false,
    relaunch: null,
    ...overrides,
  };
}

function restart(overrides: Partial<RestartView> = {}): RestartView {
  return {
    offered: false,
    state: "idle",
    failure: null,
    waiting: false,
    ...overrides,
  };
}

function model(overrides: Partial<CanvasModel> = {}): CanvasModel {
  return {
    cards: [],
    connected: true,
    poolName: null,
    phase: "running",
    phaseLabel: "running",
    seq: 7,
    error: null,
    stop: stop(),
    restart: restart(),
    terminalBacked: false,
    mergeQueueLine: null,
    spawnLine: null,
    closeTerminals: { offered: false, count: 0, state: "idle", failure: null },
    steward: null,
    ...overrides,
  };
}

describe("canvasStatusText", () => {
  it("reports the phase and the snapshot number on a live stream", () => {
    expect(canvasStatusText(model())).toBe("pool · running · snapshot 7");
  });

  it("reports connecting while the stream is down", () => {
    expect(canvasStatusText(model({ connected: false }))).toBe("pool · connecting");
  });

  it("reports a stopped server whatever the connection says (issue #97)", () => {
    // The stream drops the moment after the farewell snapshot, so waiting on
    // `connected` would replace the one true thing the page knows.
    expect(canvasStatusText(model({ phase: "stopped", phaseLabel: "stopped" }))).toBe(
      "pool · stopped",
    );
    expect(
      canvasStatusText(
        model({ phase: "stopped", phaseLabel: "stopped", connected: false }),
      ),
    ).toBe("pool · stopped");
  });

  it("names the page that asked for the stop", () => {
    expect(
      canvasStatusText(
        model({
          phase: "stopped",
          phaseLabel: "stopped",
          connected: false,
          stop: stop({ stoppedFromHere: true }),
        }),
      ),
    ).toBe("pool · stopped · from this page");
  });

  it("reads a farewell as restarting for the tab that asked for one", () => {
    expect(
      canvasStatusText(
        model({
          phase: "stopped",
          connected: false,
          stop: stop({ stoppedFromHere: true }),
          restart: restart({ waiting: true }),
        }),
      ),
    ).toBe("pool · restarting...");
  });
});

describe("the pool's name in the header (issue #100)", () => {
  it("leads every status line with the Pool title, or the directory it falls back to", () => {
    expect(canvasStatusText(model({ poolName: "Jev as the grader" }))).toBe(
      "Jev as the grader · running · snapshot 7",
    );
    expect(
      canvasStatusText(model({ poolName: "Jev as the grader", connected: false })),
    ).toBe("Jev as the grader · connecting");
    expect(
      canvasStatusText(
        model({ poolName: "Jev as the grader", phase: "stopped", phaseLabel: "stopped" }),
      ),
    ).toBe("Jev as the grader · stopped");
    expect(
      canvasStatusText(
        model({
          poolName: ".scratch/jev-integration",
          phase: "stopped",
          stop: stop({ stoppedFromHere: true }),
        }),
      ),
    ).toBe(".scratch/jev-integration · stopped · from this page");
  });

  it("names the pool in the stopped notice", () => {
    const { root, commit } = mountCanvas(
      model({
        cards: [{ kind: "utility", id: "u-1", label: "grader", interrupt: null, x: 100, y: 100 }],
        poolName: "Jev as the grader",
        phase: "stopped",
        phaseLabel: "stopped",
        connected: false,
        stop: stop({ relaunch: "bun run engine/server.ts --pool /tmp/pool" }),
      }),
    );
    commit();
    const notice = root.querySelector(".canvas-stopped-text")?.textContent ?? "";
    expect(notice).toStartWith("The server for Jev as the grader has stopped.");
    expect(root.querySelector(".canvas-stopped-command")?.textContent).toBe(
      "bun run engine/server.ts --pool /tmp/pool",
    );
  });
});

/** A canvas mounted the way the composition root mounts it: render, morph
 *  the tree already on the page, bind the mechanics to what is now there. */
function mountCanvas(
  model: CanvasModel,
  intents: Partial<ConstructorParameters<typeof Canvas>[0]> = {},
  edges: { current: TopologyEdge[] } = { current: [] },
): { canvas: Canvas; root: HTMLElement; commit(): void } {
  const canvas = new Canvas({
    onChange: () => commit(),
    onCardTap: () => {},
    onFocusTerminal: async () => true,
    onNewConversation: () => {},
    onStartSteward: () => {},
    onFocusSteward: () => {},
    onEnlist: () => {},
    onOpenSettings: () => {},
    onOpenHeldSpawns: () => {},
    onResetLayout: () => {},
    onEndConversation: () => {},
    onArmStop: () => {},
    onCancelStop: () => {},
    onConfirmStop: () => {},
    onArmCloseTerminals: () => {},
    onCancelCloseTerminals: () => {},
    onConfirmCloseTerminals: () => {},
    ...intents,
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const selection = { selectedId: null, inflow: new Set<string>(), outflow: new Set<string>() };
  const commit = () => {
    canvas.sync(model.cards);
    commitTree(root, () => canvas.render(model, selection));
    const world = root.querySelector<HTMLElement>(".canvas-world")!;
    const viewport = root.querySelector<HTMLElement>(".canvas-viewport")!;
    canvas.bindCanvas(viewport, world, edges.current, null);
  };
  return { canvas, root, commit };
}

function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }),
  );
}

describe("Canvas across a morphing render", () => {
  const withCard = model({
    cards: [{ kind: "utility", id: "u-1", label: "grader", interrupt: null, x: 100, y: 100 }],
  });
  const withTicket = model({
    cards: [
      {
        kind: "ticket",
        id: "ticket:t-1",
        ticketId: "t-1",
        title: "a ticket",
        blockedBy: [],
        blockedByCheckpoint: [],
        status: "in-progress",
        mergeState: null,
        resolver: null,
        assignment: { harness: "claude", model: "opus", drivers: "tdd" },
        enlisted: false,
        reassign: {
          eligible: false,
          reason: "an Attempt is in flight",
          verify: null,
          sources: { harness: "pinned", model: "default", effort: "unset", drivers: "default" },
        },
        hasLiveAttempt: true,
        outcome: null,
        interrupt: null,
        stewardBudget: null,
        grade: null,
        vitals: null,
        paneId: null,
        terminal: null,
        x: 100,
        y: 100,
      },
    ],
  });

  it("rebuilds only the cards whose view moved, keeping every other node untouched (#161)", () => {
    const two = model({
      cards: [
        { kind: "utility", id: "u-1", label: "grader", interrupt: null, x: 100, y: 100 },
        { kind: "utility", id: "u-2", label: "reviewer", interrupt: null, x: 400, y: 100 },
      ],
    });
    const { root, commit } = mountCanvas(two);
    commit();
    const node = (id: string) => root.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
    const [first, second] = [node("u-1"), node("u-2")];
    // A mark no render draws: a card the morph walks loses it, one it keeps does not.
    first.setAttribute("data-mark", "");
    second.setAttribute("data-mark", "");
    two.cards = [two.cards[0]!, { ...two.cards[1]!, label: "reviewer 2" } as never];
    commit();
    expect(node("u-1")).toBe(first);
    expect(first.hasAttribute("data-mark")).toBe(true);
    expect(node("u-2")).toBe(second);
    expect(second.hasAttribute("data-mark")).toBe(false);
    expect(second.textContent).toContain("reviewer 2");
    // Once drawn, the changed card is kept too while nothing about it moves.
    second.setAttribute("data-mark", "");
    commit();
    expect(first.hasAttribute("data-mark")).toBe(true);
    expect(second.hasAttribute("data-mark")).toBe(true);
  });

  it("keeps the Assignment badge expanded across the renders after the click", () => {
    const { root, commit } = mountCanvas(withTicket);
    commit();
    const badge = root.querySelector<HTMLElement>(".assignment-badge")!;
    badge.click();
    commit();
    expect(root.querySelector(".assignment-badge")).toBe(badge);
    expect(badge.classList.contains("assignment-badge-expanded")).toBe(true);
    badge.click();
    commit();
    expect(badge.classList.contains("assignment-badge-expanded")).toBe(false);
  });

  it("shows the effort on the badge, marked when the harness cannot take it", () => {
    const card = withTicket.cards[0] as Extract<(typeof withTicket.cards)[number], { kind: "ticket" }>;
    const effortOf = (assignment: typeof card.assignment) => {
      const { root, commit } = mountCanvas(model({ cards: [{ ...card, assignment }] }));
      commit();
      return root.querySelector<HTMLElement>(".assignment-badge-effort");
    };
    const applied = effortOf({ ...card.assignment, effort: "high", effortApplied: true })!;
    expect(applied.textContent).toBe("· effort high");
    expect(applied.classList.contains("assignment-badge-effort-unapplied")).toBe(false);
    const unapplied = effortOf({ ...card.assignment, effort: "high", effortApplied: false })!;
    expect(unapplied.textContent).toBe("· effort high (not applied)");
    expect(unapplied.classList.contains("assignment-badge-effort-unapplied")).toBe(true);
    // None set: the harness runs on its own default, and the badge says nothing.
    expect(effortOf(card.assignment)).toBeNull();
  });

  it("zooms once per wheel notch however many renders the viewport has seen", () => {
    const { root, commit } = mountCanvas(withCard);
    commit();
    commit();
    commit();
    const viewport = root.querySelector<HTMLElement>(".canvas-viewport")!;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    const world = root.querySelector<HTMLElement>(".canvas-world")!;
    const scale = /scale\(([\d.]+)\)/.exec(world.style.transform)?.[1];
    expect(Number(scale)).toBeCloseTo(1.1618, 3);
  });

  it("keeps a card drag going across a render that lands mid-drag", () => {
    const { root, commit } = mountCanvas(withCard);
    commit();
    const viewport = root.querySelector<HTMLElement>(".canvas-viewport")!;
    const card = root.querySelector<HTMLElement>('[data-node-id="u-1"]')!;
    pointer(card, "pointerdown", 10, 10);
    pointer(viewport, "pointermove", 30, 25);
    commit();
    pointer(viewport, "pointermove", 50, 45);
    pointer(viewport, "pointerup", 50, 45);
    expect(root.querySelector<HTMLElement>('[data-node-id="u-1"]')).toBe(card);
    expect(card.style.left).toBe("140px");
    expect(card.style.top).toBe("135px");
  });

  it("moves a dragged card once a frame, to where the last pointer move put it (#157)", async () => {
    const { root, commit } = mountCanvas(withCard);
    commit();
    const viewport = root.querySelector<HTMLElement>(".canvas-viewport")!;
    const card = root.querySelector<HTMLElement>('[data-node-id="u-1"]')!;
    // Where the card starts depends on the layout an earlier drag stored.
    const left = parseFloat(card.style.left);
    const top = parseFloat(card.style.top);
    pointer(card, "pointerdown", 10, 10);
    for (let i = 1; i <= 5; i++) pointer(viewport, "pointermove", 10 + i * 10, 10 + i * 5);
    // The moves are held, not yet painted.
    expect(card.style.left).toBe(`${left}px`);
    await Bun.sleep(40);
    expect(card.style.left).toBe(`${left + 50}px`);
    expect(card.style.top).toBe(`${top + 25}px`);
    pointer(viewport, "pointerup", 60, 35);
  });
});

describe("the canvas's edges across renders (#157)", () => {
  const twoCards = model({
    cards: [
      { kind: "utility", id: "u-1", label: "a", interrupt: null, x: 100, y: 100 },
      { kind: "utility", id: "u-2", label: "b", interrupt: null, x: 500, y: 100 },
      { kind: "utility", id: "u-3", label: "c", interrupt: null, x: 100, y: 400 },
    ],
  });

  it("keeps each edge's path and label from one render to the next", () => {
    const edges = { current: [{ source: "u-1", target: "u-2", data: "spec" }] as TopologyEdge[] };
    const { root, commit } = mountCanvas(twoCards, {}, edges);
    commit();
    const path = root.querySelector<SVGPathElement>("path.canvas-edge")!;
    const label = root.querySelector<SVGTextElement>("text.canvas-edge-label")!;
    expect(path).not.toBeNull();
    expect(label.textContent).toBe("spec");
    commit();
    commit();
    expect(root.querySelectorAll("path.canvas-edge")).toHaveLength(1);
    expect(root.querySelector("path.canvas-edge")).toBe(path);
    expect(root.querySelector("text.canvas-edge-label")).toBe(label);
    // The arrowhead's defs stay too: the morph leaves the layer's children be.
    expect(root.querySelector("svg.canvas-edges marker")).not.toBeNull();
  });

  it("leaves a fresh page's measuring and edges to the next frame, unless a render comes first (#161)", () => {
    const queued: (() => void)[] = [];
    const edges = { current: [{ source: "u-1", target: "u-2" }] as TopologyEdge[] };
    const { root, commit } = mountCanvas(twoCards, { settleLater: (run) => queued.push(run) }, edges);
    commit();
    // The first render drew the cards and nothing that needs their layout.
    expect(root.querySelectorAll(".node-card")).toHaveLength(3);
    expect(root.querySelector("path.canvas-edge")).toBeNull();
    // The pan is seeded from the window the fresh page's canvas spans.
    expect(root.querySelector<HTMLElement>(".canvas-world")!.style.transform).toContain(
      `translate(${Math.max(8, (window.innerWidth - 960) / 2)}px, 8px)`,
    );
    expect(queued).toHaveLength(1);
    queued[0]!();
    expect(root.querySelectorAll("path.canvas-edge")).toHaveLength(1);
    // A render before the frame measures as every render does, and the frame then has nothing left.
    const again = mountCanvas(twoCards, { settleLater: (run) => queued.push(run) }, edges);
    again.commit();
    again.commit();
    expect(again.root.querySelectorAll("path.canvas-edge")).toHaveLength(1);
    const path = again.root.querySelector("path.canvas-edge");
    queued[1]!();
    expect(again.root.querySelector("path.canvas-edge")).toBe(path);
  });

  it("adds, drops and restyles edges in place as the model's edges change", () => {
    const edges = { current: [{ source: "u-1", target: "u-2" }] as TopologyEdge[] };
    const { root, commit } = mountCanvas(twoCards, {}, edges);
    commit();
    const first = root.querySelector<SVGPathElement>("path.canvas-edge")!;
    edges.current = [
      { source: "u-1", target: "u-2", conditional: true },
      { source: "u-1", target: "u-3" },
    ];
    commit();
    const paths = root.querySelectorAll<SVGPathElement>("path.canvas-edge");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(first);
    expect(first.getAttribute("class")).toContain("canvas-edge-conditional");
    expect(first.hasAttribute("stroke-dasharray")).toBe(true);
    edges.current = [{ source: "u-1", target: "u-3" }];
    commit();
    expect(root.querySelectorAll("path.canvas-edge")).toHaveLength(1);
    expect(first.isConnected).toBe(false);
  });
});

describe("the header's close-finished-terminals control (issue #139)", () => {
  function closeTerminals(overrides: Partial<CloseTerminalsView> = {}): CloseTerminalsView {
    return { offered: true, count: 3, state: "idle", failure: null, ...overrides };
  }

  // A card on the canvas, so the world the mount binds to is there.
  const cards: CanvasModel["cards"] = [
    { kind: "utility", id: "u-1", label: "grader", interrupt: null, x: 100, y: 100 },
  ];

  function mount(close: CloseTerminalsView, stopView: StopView = stop()) {
    const intents: string[] = [];
    const { root, commit } = mountCanvas(model({ cards, closeTerminals: close, stop: stopView }), {
      onArmCloseTerminals: () => intents.push("arm"),
      onCancelCloseTerminals: () => intents.push("cancel"),
      onConfirmCloseTerminals: () => intents.push("confirm"),
    });
    commit();
    return { root, intents };
  }

  const control = (root: HTMLElement) => root.querySelector(".canvas-close-terminals");

  it("is hidden while no Finished terminal is open", () => {
    const { root } = mount(closeTerminals({ offered: false, count: 0 }));
    expect(control(root)).toBeNull();
  });

  it("reads the count, singular at one", () => {
    const many = mount(closeTerminals({ count: 3 }));
    expect(control(many.root)?.textContent).toBe("Close 3 finished terminals");
    const one = mount(closeTerminals({ count: 1 }));
    expect(control(one.root)?.textContent).toBe("Close 1 finished terminal");
  });

  it("arms on a click rather than closing anything", () => {
    const { root, intents } = mount(closeTerminals());
    root.querySelector<HTMLButtonElement>(".canvas-close-terminals-open")!.click();
    expect(intents).toEqual(["arm"]);
  });

  it("confirms or cancels from the inline prompt, the way Stop does", () => {
    const { root, intents } = mount(closeTerminals({ state: "armed" }));
    const armed = control(root)!;
    expect(armed.classList.contains("canvas-close-terminals-armed")).toBe(true);
    expect(armed.querySelector(".canvas-close-terminals-prompt")?.textContent).toBe(
      "Really close 3?",
    );
    const [confirm, cancel] = [...armed.querySelectorAll("button")];
    expect(confirm!.textContent).toBe("Close");
    confirm!.click();
    cancel!.click();
    expect(intents).toEqual(["confirm", "cancel"]);
  });

  it("disables itself while the POST is out", () => {
    const { root } = mount(closeTerminals({ state: "requesting" }));
    const button = control(root)!.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("closing...");
  });

  it("shows a refusal beside the button", () => {
    const { root } = mount(closeTerminals({ failure: "this pool is headless" }));
    expect(root.querySelector(".canvas-close-terminals-failure")?.textContent).toBe(
      "this pool is headless",
    );
  });

  it("sits beside Stop, each keyed as its own control", () => {
    const { root } = mount(closeTerminals(), stop({ offered: true }));
    expect(root.querySelector(".canvas-stop-server")?.textContent).toBe("Stop server");
    expect(control(root)?.getAttribute("data-key")).toBe("canvas-close-terminals");
    expect(root.querySelector(".canvas-stop")?.getAttribute("data-key")).toBe("canvas-stop");
  });
});

describe("a ticket card over a Held pane (issue #139)", () => {
  it("keeps the peek and the attach chip while the ticket waits at a checkpoint", () => {
    const snapshot: EnrichedSnapshot = {
      seq: 1,
      phase: "quiescent",
      poolName: "repo/pool",
      poolTitle: null,
      poolDir: "/tmp/pool",
      finishedTerminals: 0,
      spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
      pendingSpawns: [],
      heldSpawns: [],
      state: {
        tickets: [
          {
            id: "A",
            title: "ticket A",
            blockedBy: [],
            status: "checkpoint",
            mergeState: null,
            enlisted: false,
            assignment: { harness: "claude", model: "opus", drivers: "implement" },
            liveAttempt: null,
            heldPane: { attempt: 2, paneId: "w3:p1" },
            reassign: {
              eligible: true,
              reason: null,
              verify: null,
              sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
            },
          },
        ],
        conversations: [],
        log: [],
        outcomes: {},
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
        mergeQueue: [],
        queuedAnswers: [],
        config: { terminal: "herdr" },
      },
    };
    const focused: string[] = [];
    const { root, commit } = mountCanvas(model({ cards: projectPool(snapshot).cards }), {
      onFocusTerminal: async (ticketId) => {
        focused.push(ticketId);
        return true;
      },
    });
    commit();
    const card = root.querySelector('[data-ticket-id="A"]')!;
    expect(card.querySelector(".terminal-peek")).not.toBeNull();
    expect(card.querySelector(".terminal-chip-pane")?.textContent).toBe("w3:p1");
    card.querySelector<HTMLButtonElement>(".terminal-focus")!.click();
    expect(focused).toEqual(["A"]);
  });
});

describe("the Spawn caps header line (issue #149)", () => {
  const cards: CanvasModel["cards"] = [
    { kind: "utility", id: "u-1", label: "start", interrupt: null, x: 100, y: 100 },
  ];

  it("shows the line and opens the Held spawns list when clicked", () => {
    let opens = 0;
    const { root, commit } = mountCanvas(
      model({ cards, spawnLine: { text: "Spawns 3/20 this run · 5 per attempt", warn: false } }),
      { onOpenHeldSpawns: () => (opens += 1) },
    );
    commit();
    const line = root.querySelector<HTMLButtonElement>(".canvas-spawn-line")!;
    expect(line.textContent).toBe("Spawns 3/20 this run · 5 per attempt");
    expect(line.classList.contains("spawn-line-warn")).toBe(false);
    line.click();
    expect(opens).toBe(1);
  });

  it("wears the warning colour at the cap or with anything held", () => {
    const { root, commit } = mountCanvas(
      model({ cards, spawnLine: { text: "Spawns 20/20 this run · 5 per attempt · 1 held", warn: true } }),
    );
    commit();
    expect(
      root.querySelector(".canvas-spawn-line")?.classList.contains("spawn-line-warn"),
    ).toBe(true);
  });

  it("shows no line before a snapshot says what the caps are", () => {
    const { root, commit } = mountCanvas(model({ cards }));
    commit();
    expect(root.querySelector(".canvas-spawn-line")).toBeNull();
  });
});

describe("faded cards for Pending and Held spawns (issue #150)", () => {
  const spawnCard = (
    overrides: Partial<Extract<CanvasModel["cards"][number], { kind: "spawn" }>> = {},
  ): CanvasModel["cards"][number] => ({
    kind: "spawn",
    id: "spawn:proposal-1",
    proposalId: "proposal-1",
    state: "pending",
    label: "lands next boundary",
    title: "Write the migration guide",
    parentCardId: "ticket:01",
    parentId: "01",
    spawnKind: "ticket",
    body: "Document every renamed flag.",
    blockedBy: [],
    blocks: null,
    overlaps: [],
    x: 100,
    y: 300,
    ...overrides,
  });

  it("draws each proposal as a faded card under its own key, selectable like any card", () => {
    const { root, commit } = mountCanvas(
      model({
        cards: [
          spawnCard(),
          spawnCard({
            id: "spawn:proposal-2",
            proposalId: "proposal-2",
            state: "held",
            label: "held · overlaps 02",
            spawnKind: "conversation",
          }),
        ],
      }),
    );
    commit();
    const pending = root.querySelector<HTMLElement>('[data-key="spawn:proposal-1"]')!;
    expect(pending.classList.contains("spawn-card-pending")).toBe(true);
    expect(pending.dataset.nodeId).toBe("spawn:proposal-1");
    expect(pending.querySelector(".spawn-card-label")?.textContent).toBe("lands next boundary");
    expect(pending.querySelector(".spawn-card-parent")?.textContent).toBe("from 01");
    const held = root.querySelector<HTMLElement>('[data-key="spawn:proposal-2"]')!;
    expect(held.classList.contains("spawn-card-held")).toBe(true);
    expect(held.querySelector(".spawn-card-label")?.textContent).toBe("held · overlaps 02");
    expect(held.querySelector(".spawn-card-parent")?.textContent).toBe("Conversation from 01");
  });
});

describe("the Steward on the canvas (ADR-0030)", () => {
  function stewardPool(): CanvasModel {
    const snapshot: EnrichedSnapshot = {
      seq: 1,
      phase: "running",
      poolName: "repo/pool",
      poolTitle: null,
      poolDir: "/tmp/pool",
      finishedTerminals: 0,
      spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
      pendingSpawns: [],
      heldSpawns: [],
      state: {
        tickets: [],
        conversations: [
          {
            id: "conv-3",
            title: "Steward",
            status: "live",
            spawnedBy: null,
            assignment: { harness: "claude", model: "opus", drivers: "implement" },
            paneId: null,
            branch: null,
            turn: { state: "waiting", lastLine: "", idleSince: null },
            children: [],
            enlisted: false,
            ending: false,
            role: "steward",
          },
        ],
        log: [],
        outcomes: {},
        interrupts: [],
        mergeQueue: [],
        queuedAnswers: [],
        config: {},
      },
    };
    const view = projectPool(snapshot);
    return model({ cards: view.cards, steward: view.steward });
  }

  it("marks the Steward's card", () => {
    const { root, commit } = mountCanvas(stewardPool());
    commit();
    const card = root.querySelector('[data-conversation-id="conv-3"]')!;
    expect(card.classList.contains("conversation-card-steward")).toBe(true);
    expect(card.querySelector(".steward-badge")?.textContent).toBe("Steward");
  });

  it("says a Steward is on duty in the header, a click focusing its card", () => {
    const focused: string[] = [];
    const { root, commit } = mountCanvas(stewardPool(), {
      onFocusSteward: (cardId) => focused.push(cardId),
    });
    commit();
    const line = root.querySelector<HTMLButtonElement>(".canvas-steward")!;
    expect(line.textContent).toBe("Steward on duty · conv-3");
    line.click();
    expect(focused).toEqual(["conversation:conv-3"]);
  });

  it("disables Start Steward with the reason while one is on duty", () => {
    const { root, commit } = mountCanvas(stewardPool());
    commit();
    const start = root.querySelector<HTMLButtonElement>(".canvas-start-steward")!;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain("already on duty (conv-3)");
  });

  it("offers Start Steward, and no on-duty line, while none is", () => {
    const started: number[] = [];
    const { root, commit } = mountCanvas(
      model({ cards: [{ kind: "utility", id: "u-1", label: "start", interrupt: null, x: 100, y: 100 }] }),
      { onStartSteward: () => started.push(1) },
    );
    commit();
    expect(root.querySelector(".canvas-steward")).toBeNull();
    const start = root.querySelector<HTMLButtonElement>(".canvas-start-steward")!;
    expect(start.disabled).toBe(false);
    start.click();
    expect(started).toEqual([1]);
  });
});

describe("Notices not landing on the canvas", () => {
  it("warns on the card and turns the Steward's on-duty line amber, the error on hover", () => {
    const delivery = { failingSince: "2026-10-01T02:05:00.000Z", lastError: "a dialog is open" };
    const snapshot: EnrichedSnapshot = {
      seq: 1,
      phase: "running",
      poolName: "repo/pool",
      poolTitle: null,
      poolDir: "/tmp/pool",
      finishedTerminals: 0,
      spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
      pendingSpawns: [],
      heldSpawns: [],
      state: {
        tickets: [],
        conversations: [
          {
            id: "conv-3",
            title: "Steward",
            status: "live",
            spawnedBy: null,
            assignment: { harness: "claude", model: "opus", drivers: "implement" },
            paneId: null,
            branch: null,
            turn: { state: "waiting", lastLine: "", idleSince: null },
            children: [],
            enlisted: false,
            ending: false,
            role: "steward",
            delivery,
          },
        ],
        log: [],
        outcomes: {},
        interrupts: [],
        mergeQueue: [],
        queuedAnswers: [],
        config: {},
      },
    };
    const view = projectPool(snapshot);
    const { root, commit } = mountCanvas(model({ cards: view.cards, steward: view.steward }));
    commit();
    const warn = root.querySelector<HTMLElement>(
      '[data-conversation-id="conv-3"] .conversation-delivery-warn',
    );
    expect(warn?.textContent).toContain("Notices not reaching this pane");
    expect(warn?.title).toBe("a dialog is open");
    const line = root.querySelector<HTMLElement>(".canvas-steward")!;
    expect(line.classList.contains("canvas-steward-warn")).toBe(true);
    expect(line.title).toContain("a dialog is open");
  });
});
