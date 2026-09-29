/// <reference types="bun" />

import { beforeEach, describe, expect, it } from "bun:test";
import { ConsoleSession } from "./session";
import { ConsoleView, type Handlers } from "./view";
import { NEEDS_INPUT_WIDTH_KEY } from "./needs-input";
import type { EnrichedSnapshot, EnrichedTicketState, ResumeAction } from "./project";
import { useDom } from "./test-dom";

useDom();

function ticket(id: string): EnrichedTicketState {
  return {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "checkpoint",
    mergeState: null,
    enlisted: false,
    assignment: { harness: null, model: null, drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    reassign: {
      eligible: true,
      reason: null,
      verify: null,
      sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
    },
  };
}

// Two checkpointed tickets, both waiting on the operator.
const SNAPSHOT: EnrichedSnapshot = {
  seq: 1,
  phase: "running",
  poolName: "repo/pool",
  poolTitle: null,
  poolDir: "/tmp/pool",
  finishedTerminals: 0,
  spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
  heldSpawns: [],
  state: {
    tickets: [ticket("A"), ticket("B")],
    conversations: [],
    log: [],
    outcomes: {},
    interrupts: [
      { ticketId: "A", kind: "checkpoint", body: "brief A" },
      { ticketId: "B", kind: "checkpoint", body: "brief B" },
    ],
    mergeQueue: [],
    queuedAnswers: [],
    config: {},
  },
};

/** The composition root over the real session, the bootstrap's wiring minus
 *  the network: every seam that would fetch parks or answers at once. */
function mountConsole(snapshot: EnrichedSnapshot = SNAPSHOT) {
  const answers: { ticketId: string; action: ResumeAction; note?: string }[] = [];
  const adopted: string[] = [];
  // One Console on the page at a time: the Detail's fullscreen writes find
  // the page's panel by class, as they do in the app.
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const session = new ConsoleSession({
    getState: () => Promise.resolve(snapshot),
    getEvents: () => new Promise(() => {}),
    getTicket: () => new Promise(() => {}),
    getGrades: () => Promise.resolve({}),
    getLog: () => new Promise(() => {}),
    answer: () => new Promise(() => {}),
    stop: () => new Promise(() => {}),
    restart: () => new Promise(() => {}),
    keepTalking: () => new Promise(() => {}),
    closeFinishedTerminals: () => new Promise(() => {}),
    stream: () => () => {},
    vitals: { update: () => {}, state: () => ({}) },
    terminal: { update: () => {}, state: () => ({}) },
    onChange: () => render(),
  });
  const view = new ConsoleView({
    onAnswer: (ticketId, action, note) => {
      answers.push({ ticketId, action, note });
      return new Promise(() => {});
    },
    onChange: () => render(),
    onStart: () => new Promise(() => {}),
    onEnd: () => new Promise(() => {}),
    onFocusTerminal: () => Promise.resolve(true),
    onListPanes: () => new Promise(() => {}),
    onEnlist: () => new Promise(() => {}),
    onGetSettings: () => new Promise(() => {}),
    onSavePoolSettings: () => new Promise(() => {}),
    onSaveMachineDefaults: () => new Promise(() => {}),
    onReassign: () => new Promise(() => {}),
    onAdoptHeldSpawn: (id) => {
      adopted.push(id);
      return new Promise(() => {});
    },
    onDiscardHeldSpawn: () => new Promise(() => {}),
  });
  const handlers: Handlers = {
    onToggleLog: () => session.toggleLog(),
    onToggleInspector: () => session.toggleInspector(),
    onSelectNode: (nodeId) => session.select(nodeId),
    onSelectAttempt: () => {},
    onSelectStream: () => {},
    onLoadEarlier: () => {},
    onAnswer: () => {},
    onKeepTalking: () => {},
    onSelectTab: (ticketId, tab) => session.selectTab(ticketId, tab),
    onArmStop: () => {},
    onCancelStop: () => {},
    onConfirmStop: () => {},
    onArmRestart: () => {},
    onCancelRestart: () => {},
    onConfirmRestart: () => {},
    onArmCloseTerminals: () => {},
    onCancelCloseTerminals: () => {},
    onConfirmCloseTerminals: () => {},
  };
  function render(): void {
    view.render(root, session.model(view.conversationEndState()), handlers);
  }
  session.setSnapshot(snapshot);
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const trayNote = (ticketId: string) =>
    q<HTMLTextAreaElement>(`.needs-input-row[data-key="ticket:${ticketId}"] textarea.needs-input-note`)!;
  const detailNote = () => q<HTMLTextAreaElement>(".detail-open textarea.interrupt-note");
  const type = (el: HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { root, session, render, answers, adopted, q, trayNote, detailNote, type };
}

describe("ConsoleView: one Draft answer per ticket (issue #147)", () => {
  it("shows a note typed in the tray in the Detail, and one typed in the Detail in the tray", () => {
    const c = mountConsole();
    c.type(c.trayNote("A"), "started in the tray");
    c.session.select("ticket:A");
    c.session.selectTab("A", "progress");
    expect(c.detailNote()!.value).toBe("started in the tray");
    c.type(c.detailNote()!, "finished in the Detail");
    c.render();
    expect(c.trayNote("A").value).toBe("finished in the Detail");
  });

  it("keeps the tray row in step while typing in the Detail, with no render between", () => {
    const c = mountConsole();
    c.session.select("ticket:A");
    c.session.selectTab("A", "progress");
    c.type(c.detailNote()!, "a long answer written full size");
    // No snapshot arrives while every ticket waits on the operator, so the
    // tray must not hold a stale copy its next keystroke would write back.
    expect(c.trayNote("A").value).toBe("a long answer written full size");
    c.type(c.trayNote("A"), `${c.trayNote("A").value}!`);
    expect(c.detailNote()!.value).toBe("a long answer written full size!");
    expect(c.trayNote("B").value).toBe("");
  });

  it("resume all sends the draft written in the Detail", () => {
    const c = mountConsole();
    c.session.select("ticket:B");
    c.session.selectTab("B", "progress");
    c.type(c.detailNote()!, "written full size");
    c.q<HTMLButtonElement>(".needs-input-resume-all")!.click();
    expect(c.answers).toEqual([
      { ticketId: "A", action: "resume", note: "" },
      { ticketId: "B", action: "resume", note: "written full size" },
    ]);
  });
});

describe("ConsoleView: expand a Needs input row (issue #147)", () => {
  const expand = (c: ReturnType<typeof mountConsole>, ticketId: string) =>
    c.q<HTMLButtonElement>(`.needs-input-row[data-key="ticket:${ticketId}"] .needs-input-expand`)!.click();

  it("opens the ticket's Detail full size on Progress with the note focused at its end", () => {
    const c = mountConsole();
    c.type(c.trayNote("B"), "a long answer");
    expand(c, "B");
    const detail = c.q<HTMLElement>(".detail-open")!;
    expect(detail.querySelector(".detail-title")?.textContent).toBe("B");
    expect(detail.classList.contains("detail-fullscreen")).toBe(true);
    expect(detail.querySelector(".detail-tab-active")?.textContent).toContain("Progress");
    const note = c.detailNote()!;
    expect(note.value).toBe("a long answer");
    expect(document.activeElement).toBe(note);
    expect([note.selectionStart, note.selectionEnd]).toEqual([13, 13]);
  });

  it("keeps an already selected card open rather than toggling it closed", () => {
    const c = mountConsole();
    c.session.select("ticket:A");
    expand(c, "A");
    // The view's own selection toggles on a repeat press; expand must not
    // be one, or the Detail it opens would close.
    expand(c, "A");
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("A");
    expect(c.q(".detail-open")?.classList.contains("detail-fullscreen")).toBe(true);
  });

  it("returns to the tray on Esc, the Detail left open beside it", () => {
    const c = mountConsole();
    expand(c, "A");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(c.q(".detail-open")?.classList.contains("detail-fullscreen")).toBe(false);
    c.render();
    expect(c.q(".detail-fullscreen")).toBeNull();
    expect(c.q(".needs-input-tray")).not.toBeNull();
  });
});

describe("ConsoleView: reset layout resets the tray width (issue #147)", () => {
  beforeEach(() => localStorage.clear());

  it("restores the tray's default width and forgets the stored one", () => {
    localStorage.setItem(NEEDS_INPUT_WIDTH_KEY, "480");
    const c = mountConsole();
    expect(c.q<HTMLElement>(".needs-input-tray")!.style.width).toBe("480px");
    const reset = [...c.root.querySelectorAll<HTMLButtonElement>(".canvas-header button")].find(
      (b) => b.textContent === "reset layout",
    )!;
    reset.click();
    expect(c.q<HTMLElement>(".needs-input-tray")!.style.width).toBe("300px");
    expect(localStorage.getItem(NEEDS_INPUT_WIDTH_KEY)).toBeNull();
  });
});

describe("ConsoleView: the Held spawns list (issue #149)", () => {
  const HELD: EnrichedSnapshot = {
    ...SNAPSHOT,
    spawnUsage: { spawnedThisRun: 20, perAttempt: 5, perRun: 20 },
    heldSpawns: [
      {
        id: "held-1",
        parentId: "A",
        origin: "ticket",
        kind: "ticket",
        title: "Fix the flaky login test",
        body: "fails one run in five",
        blockedBy: [],
        blocks: "all",
        reason: "per-run",
        at: "2026-09-29T10:00:00Z",
        adopting: false,
      },
    ],
  };

  it("opens from the header line and adopts from the list, never from Needs input", () => {
    const c = mountConsole(HELD);
    const line = c.q<HTMLButtonElement>(".canvas-spawn-line")!;
    expect(line.textContent).toBe("Spawns 20/20 this run · 5 per attempt · 1 held");
    expect(c.q(".needs-input-tray")?.textContent).not.toContain("Fix the flaky login test");
    expect(c.q(".held-spawns-pane")).toBeNull();
    line.click();
    c.q<HTMLButtonElement>('[data-key="held-spawn-held-1"] .held-spawn-adopt')!.click();
    expect(c.adopted).toEqual(["held-1"]);
    // Once the boundary writes it, the row goes with the snapshot.
    c.session.setSnapshot({ ...HELD, seq: 2, heldSpawns: [] });
    expect(c.q('[data-key="held-spawn-held-1"]')).toBeNull();
    expect(c.q(".held-spawns-empty")).not.toBeNull();
  });
});
