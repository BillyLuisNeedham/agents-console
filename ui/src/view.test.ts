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
  pendingSpawns: [],
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
 *  the network: every request parks, and subscriptions go nowhere. */
function mountConsole(snapshot: EnrichedSnapshot = SNAPSHOT) {
  const answers: { ticketId: string; action: ResumeAction; note?: string }[] = [];
  const adopted: string[] = [];
  // One Console on the page at a time: the Detail's fullscreen writes find
  // the page's panel by class, as they do in the app.
  document.body.replaceChildren();
  const root = document.createElement("div");
  document.body.appendChild(root);
  const session = new ConsoleSession({
    socket: {
      request: () => new Promise(() => {}),
      subscribe: () => {},
      unsubscribe: () => {},
      follow: () => new Promise(() => {}),
    },
    vitals: { update: () => {}, apply: () => {}, state: () => ({}) },
    terminal: { update: () => {}, apply: () => {}, state: () => ({}) },
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
    onListPlans: () => new Promise(() => {}),
    onGetPlan: () => new Promise(() => {}),
    onEditPlan: () => new Promise(() => {}),
    onSavePlan: () => new Promise(() => {}),
    onDeletePlan: () => new Promise(() => {}),
    onBootPlan: () => new Promise(() => {}),
    onEditLine: () => new Promise(() => {}),
  });
  const handlers: Handlers = {
    onToggleLog: () => session.toggleLog(),
    onToggleInspector: () => session.toggleInspector(),
    onSelectNode: (nodeId) => session.select(nodeId),
    onHoverNode: () => {},
    onLoadEarlierPoolLog: () => {},
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
        overlaps: [],
        unknownOverlaps: [],
        startedIds: [],
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
    // Once the next Tick writes it, the row goes with the snapshot.
    c.session.setSnapshot({ ...HELD, seq: 2, heldSpawns: [] });
    expect(c.q('[data-key="held-spawn-held-1"]')).toBeNull();
    expect(c.q(".held-spawns-empty")).not.toBeNull();
  });
});

describe("ConsoleView: a Held spawn's faded card and its Detail (issue #150)", () => {
  const HELD: EnrichedSnapshot = {
    ...SNAPSHOT,
    spawnUsage: { spawnedThisRun: 20, perAttempt: 5, perRun: 20 },
    heldSpawns: [
      {
        id: "proposal-1",
        parentId: "A",
        origin: "ticket",
        kind: "ticket",
        title: "Write the migration guide",
        body: "Document every renamed flag.",
        blockedBy: [],
        blocks: ["B"],
        overlaps: [],
        unknownOverlaps: [],
        startedIds: [],
        reason: "per-run",
        at: "2026-09-29T10:00:00Z",
        adopting: false,
      },
    ],
  };

  it("draws a faded card whose Detail shows the proposal and shares the list's decisions", () => {
    const c = mountConsole(HELD);
    const card = c.q<HTMLElement>('.spawn-card[data-key="spawn:proposal-1"]')!;
    expect(card.textContent).toContain("held · per-run cap");
    c.session.select("spawn:proposal-1");
    expect(c.q(".detail-title")?.textContent).toBe("proposal-1");
    const detail = c.q<HTMLElement>(".spawn-detail")!;
    expect(detail.textContent).toContain("Document every renamed flag.");
    expect(detail.textContent).toContain("blocks");
    expect(detail.querySelector(".peek, .log-pane")).toBeNull();
    detail.querySelector<HTMLButtonElement>(".held-spawn-adopt")!.click();
    expect(c.adopted).toEqual(["proposal-1"]);
    c.q<HTMLButtonElement>(".canvas-spawn-line")!.click();
    expect(
      c.q<HTMLButtonElement>('[data-key="held-spawn-proposal-1"] .held-spawn-adopt')!.disabled,
    ).toBe(true);
    // Once the Tick lands it the faded card and its Detail go with the snapshot.
    c.session.setSnapshot({ ...HELD, seq: 2, heldSpawns: [] });
    expect(c.q('[data-key="spawn:proposal-1"]')).toBeNull();
    expect(c.q(".spawn-detail")).toBeNull();
  });
});

describe("ConsoleView: the Steward (ADR-0030)", () => {
  const note = { text: "resume with: use the fixture, not the live API", at: "2026-10-01T02:00:00Z", conversation: "conv-3" };
  const STEWARD_SNAPSHOT: EnrichedSnapshot = {
    ...SNAPSHOT,
    stewardBudget: { budget: 5, used: { B: 1 } },
    state: {
      ...SNAPSHOT.state,
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
      interrupts: [
        { ticketId: "A", kind: "checkpoint", body: "brief A", stewardNote: note },
        { ticketId: "B", kind: "checkpoint", body: "brief B" },
      ],
    },
  };

  it("Use as answer in the Detail fills the Draft answer the tray row shows too", () => {
    const c = mountConsole(STEWARD_SNAPSHOT);
    c.type(c.trayNote("A"), "my own words");
    c.session.select("ticket:A");
    c.session.selectTab("A", "progress");
    c.q<HTMLButtonElement>(".detail-open .steward-note-use")!.click();
    expect(c.detailNote()!.value).toBe(note.text);
    expect(c.trayNote("A").value).toBe(note.text);
    expect(c.trayNote("B").value).toBe("");
  });

  it("Use as answer in the tray fills the open Detail's note too", () => {
    const c = mountConsole(STEWARD_SNAPSHOT);
    c.session.select("ticket:A");
    c.session.selectTab("A", "progress");
    c.q<HTMLButtonElement>('.needs-input-row[data-key="ticket:A"] .steward-note-use')!.click();
    expect(c.detailNote()!.value).toBe(note.text);
  });

  it("selects the Steward's card from the tray's Steward box, and keeps it selected on a second click", () => {
    const c = mountConsole(STEWARD_SNAPSHOT);
    expect(c.q(".canvas-header .canvas-steward")).toBeNull();
    c.q<HTMLButtonElement>(".steward-box-name")!.click();
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("conv-3");
    c.q<HTMLButtonElement>(".steward-box-name")!.click();
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("conv-3");
    expect(c.q(".detail-open .steward-badge")).not.toBeNull();
  });

  it("leaves the waiting Steward out of Needs input", () => {
    const c = mountConsole(STEWARD_SNAPSHOT);
    expect(c.q(".needs-input-row-conversation")).toBeNull();
  });

  it("opens the Start Steward form from the tray's Steward box while none is on duty", () => {
    const c = mountConsole({ ...STEWARD_SNAPSHOT, state: { ...STEWARD_SNAPSHOT.state, conversations: [] } });
    c.q<HTMLButtonElement>(".steward-box-off .conversations-steward-toggle")!.click();
    expect(c.q(".steward-form")).not.toBeNull();
    expect(c.q<HTMLButtonElement>(".steward-start")!.disabled).toBe(false);
  });

  it("shows the Steward budget on the ticket it has answered", () => {
    const c = mountConsole(STEWARD_SNAPSHOT);
    c.session.select("ticket:B");
    c.session.selectTab("B", "progress");
    expect(c.q(".detail-steward-budget")?.textContent).toBe(
      "Steward budget · 1 of 5 used · 4 left",
    );
  });
});

describe("ConsoleView: Notices not landing", () => {
  it("writes the engine's last error out in the Conversation's Detail", () => {
    const c = mountConsole({
      ...SNAPSHOT,
      state: {
        ...SNAPSHOT.state,
        conversations: [
          {
            id: "conv-1",
            title: "a talk",
            status: "live",
            spawnedBy: null,
            assignment: { harness: "claude", model: "opus", drivers: "implement" },
            paneId: null,
            branch: null,
            turn: { state: "waiting", lastLine: "", idleSince: null },
            children: [],
            enlisted: false,
            ending: false,
            delivery: { failingSince: "2026-10-01T02:05:00.000Z", lastError: "a dialog is open" },
          },
        ],
      },
    });
    c.session.select("conversation:conv-1");
    expect(c.q(".detail-open .conversation-delivery-warn")?.textContent).toContain(
      "Notices not reaching this pane",
    );
    expect(c.q(".detail-open .conversation-delivery-error")?.textContent).toBe("a dialog is open");
  });
});

describe("ConsoleView: the Line view (ADR-0039)", () => {
  const LINE_SNAPSHOT: EnrichedSnapshot = {
    ...SNAPSHOT,
    line: {
      plan: {
        horde: 1,
        name: "Factory today",
        nodes: [
          { kind: "agent", id: "build", title: "Build", x: 0, y: 0, copies: { perItem: 2 } },
          { kind: "finish", id: "finish", title: "Finish", x: 300, y: 0 },
        ],
        edges: [{ from: "build", on: "done", to: "finish" }],
      },
      rev: 1,
      status: "finishing",
      waitingFor: ["A", "B"],
      nodes: [
        {
          id: "build",
          verdicts: ["done"],
          passes: 1,
          pass: 1,
          tickets: ["A", "B"],
          queued: 3,
          inbox: 0,
          parked: [],
          arrived: [],
        },
        { id: "finish", verdicts: [], passes: 0, tickets: [], queued: 0, inbox: 0, parked: [], arrived: [] },
      ],
      edges: [],
    },
  };
  const dot = (c: ReturnType<typeof mountConsole>, id: string) =>
    c.q<HTMLButtonElement>(`.line-pane .plan-dot[data-card="ticket:${id}"]`)!;

  it("offers the Line from the header and keeps the view shut until it is asked for", () => {
    const c = mountConsole(LINE_SNAPSHOT);
    expect(c.q(".canvas-line-open")?.textContent).toBe("Factory today · finishing");
    expect(c.q(".line-pane")).toBeNull();
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    expect(c.q(".line-pane .line-headline")?.textContent).toBe("Factory today · finishing");
    expect(c.q(".line-pane .line-waiting")?.textContent).toBe("Finish waiting for A, B");
    expect(c.root.querySelectorAll(".line-pane .plan-node").length).toBe(2);
  });

  it("draws each node's state, its copy dots by status and the queue as hollow dots", () => {
    const c = mountConsole(LINE_SNAPSHOT);
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    const build = c.q<HTMLElement>('.line-pane .plan-node[data-node="build"]')!;
    expect(build.querySelector(".plan-node-state")?.textContent).toBe("needs you");
    expect(build.querySelectorAll(".plan-dot-checkpoint").length).toBe(2);
    expect(build.querySelectorAll(".plan-dot-queued").length).toBe(3);
    expect(build.querySelector(".plan-node-line")?.textContent).toBe("pass 1 · 0 running · 3 queued");
    const finish = c.q<HTMLElement>('.line-pane .plan-node[data-node="finish"]')!;
    expect(finish.querySelector(".plan-node-state")?.textContent).toBe("waiting for 2");
  });

  it("opens a copy's Detail beside the open view, selects its card, and a second tap keeps it open", () => {
    const c = mountConsole(LINE_SNAPSHOT);
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    dot(c, "B").click();
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("B");
    expect(c.q(".line-pane")).not.toBeNull();
    expect(c.q('.node-card[data-node-id="ticket:B"]')?.classList.contains("node-card-selected")).toBe(true);
    expect(dot(c, "B").classList.contains("plan-dot-selected")).toBe(true);
    dot(c, "B").click();
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("B");
    dot(c, "A").click();
    expect(c.q(".detail-open .detail-title")?.textContent).toBe("A");
  });

  it("does not pan the graph when a copy dot is pressed", () => {
    const c = mountConsole(LINE_SNAPSHOT);
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    const world = c.q<HTMLElement>(".line-pane .plan-world")!;
    const before = world.style.transform;
    const target = dot(c, "A");
    for (const [type, x] of [["pointerdown", 10], ["pointermove", 60], ["pointerup", 60]] as const) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: 10 }));
    }
    expect(world.style.transform).toBe(before);
    expect(c.q(".line-pane .plan-panning")).toBeNull();
  });

  it("closes back to the Ticket canvas, and closes by itself when the Line goes away", () => {
    const c = mountConsole(LINE_SNAPSHOT);
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    c.q<HTMLButtonElement>(".line-close")!.click();
    expect(c.q(".line-pane")).toBeNull();
    c.q<HTMLButtonElement>(".canvas-line-open")!.click();
    expect(c.q(".line-pane")).not.toBeNull();
    c.session.setSnapshot(SNAPSHOT);
    expect(c.q(".line-pane")).toBeNull();
    expect(c.q(".canvas-line-open")).toBeNull();
    c.session.setSnapshot(LINE_SNAPSHOT);
    expect(c.q(".line-pane")).toBeNull();
  });
});
