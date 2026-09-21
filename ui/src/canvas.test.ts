/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { Canvas, canvasStatusText, type CanvasModel } from "./canvas";
import { commit as commitTree } from "./morph";
import { useDom } from "./test-dom";
import type { StopView } from "./view";

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

function model(overrides: Partial<CanvasModel> = {}): CanvasModel {
  return {
    cards: [],
    connected: true,
    phase: "running",
    phaseLabel: "running",
    seq: 7,
    error: null,
    stop: stop(),
    terminalBacked: false,
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
});

/** A canvas mounted the way the composition root mounts it: render, morph
 *  the tree already on the page, bind the mechanics to what is now there. */
function mountCanvas(model: CanvasModel): { canvas: Canvas; root: HTMLElement; commit(): void } {
  const canvas = new Canvas({
    onChange: () => commit(),
    onCardTap: () => {},
    onFocusTerminal: async () => true,
    onNewConversation: () => {},
    onEnlist: () => {},
    onEndConversation: () => {},
    onArmStop: () => {},
    onCancelStop: () => {},
    onConfirmStop: () => {},
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const selection = { selectedId: null, inflow: new Set<string>(), outflow: new Set<string>() };
  const commit = () => {
    canvas.sync(model.cards);
    commitTree(root, () => canvas.render(model, selection));
    const world = root.querySelector<HTMLElement>(".canvas-world")!;
    const viewport = root.querySelector<HTMLElement>(".canvas-viewport")!;
    canvas.bindCanvas(viewport, world, [], null);
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
        mergePending: false,
        assignment: { harness: "claude", model: "opus", drivers: "tdd" },
        enlisted: false,
        outcome: null,
        interrupt: null,
        grade: null,
        vitals: null,
        paneId: null,
        terminal: null,
        x: 100,
        y: 100,
      },
    ],
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
});
