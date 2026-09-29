/// <reference types="bun" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  NEEDS_INPUT_WIDTH_KEY,
  NeedsInputTray,
  noteRows,
  waitingStatus,
  type AnswerHandler,
  type NeedsInputFailure,
  type NeedsInputHandlers,
} from "./needs-input";
import {
  projectNeedsInput,
  projectPool,
  type EnrichedSnapshot,
  type InterruptKind,
  type InterruptView,
  type NeedsInputRow,
  type ResumeAction,
} from "./project";
import { DraftAnswers } from "./drafts";
import { commit } from "./morph";
import { useDom } from "./test-dom";

useDom();

// The form shapes the resume-all tests need: the single-action resume form
// for the resume kinds, the two-action approve/reject form for review. The
// projection's own mapping is pinned by project.test.ts through
// projectNeedsInput; these fixtures only need the distinction.
function form(kind: string): InterruptView["form"] {
  if (kind === "review" || kind === "merge-approval") {
    return {
      title: kind,
      actions: [
        { action: "approve", label: "approve", tone: "primary" },
        { action: "reject", label: "reject", tone: "danger" },
      ],
    };
  }
  return {
    title: kind,
    actions: [{ action: "resume", label: "resume", tone: "primary" }],
  };
}

function row(ticketId: string, kind: InterruptKind, queued = false): NeedsInputRow {
  return {
    cardId: `ticket:${ticketId}`,
    ticketId,
    label: ticketId,
    title: `ticket ${ticketId}`,
    interrupt: {
      ticketId,
      kind,
      body: "",
      queued,
      form: form(kind),
      keepTalking: null,
    },
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A hand-settled fake answer seam: every call is recorded and parked on a
// per-ticket deferred the test settles when it chooses, so a test pins the
// dispatch order before any outcome lands.
function fakeAnswer(): {
  answer: AnswerHandler;
  calls: { ticketId: string; action: ResumeAction; note?: string }[];
  deferreds: Map<string, Deferred>;
} {
  const calls: { ticketId: string; action: ResumeAction; note?: string }[] = [];
  const deferreds = new Map<string, Deferred>();
  const answer: AnswerHandler = (ticketId, action, note) => {
    calls.push({ ticketId, action, note });
    const d = deferred();
    deferreds.set(ticketId, d);
    return d.promise;
  };
  return { answer, calls, deferreds };
}

function trayWith(
  fake: ReturnType<typeof fakeAnswer>,
  drafts = new DraftAnswers(),
): NeedsInputTray {
  return new NeedsInputTray({ onAnswer: fake.answer, onChange: () => {}, drafts });
}

// A tray for the state-only tests: the answer seam is never fired, so a
// neutral one stands in for the composition's wiring.
function stateTray(drafts = new DraftAnswers()): NeedsInputTray {
  return new NeedsInputTray({ onAnswer: () => Promise.resolve(), onChange: () => {}, drafts });
}

// The handlers a painted tray reports through, each a no-op unless the test
// overrides it.
function trayHandlers(overrides: Partial<NeedsInputHandlers> = {}): NeedsInputHandlers {
  return {
    onSelect: () => {},
    onFocusConversation: () => Promise.resolve(true),
    onKeepTalking: () => {},
    onExpand: () => {},
    ...overrides,
  };
}

describe("NeedsInputTray note drafts", () => {
  it("holds a draft per ticket id across renders", () => {
    const tray = stateTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    // The drafts are instance state: a re-render reads them back unchanged.
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("starts empty for a ticket with no draft", () => {
    const tray = stateTray();
    expect(tray.note("01")).toBe("");
  });

  it("reads and writes the shared Draft answers store (issue #147)", () => {
    const drafts = new DraftAnswers();
    const tray = stateTray(drafts);
    drafts.set("01", "typed in the Detail");
    expect(tray.note("01")).toBe("typed in the Detail");
    tray.setNote("02", "typed in the tray");
    expect(drafts.get("02")).toBe("typed in the tray");
  });
});

describe("NeedsInputTray collapse", () => {
  it("starts expanded", () => {
    const tray = stateTray();
    expect(tray.isCollapsed).toBe(false);
  });

  it("keeps drafts across a collapse and an expand, both directions", () => {
    const tray = stateTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    tray.setCollapsed(true);
    expect(tray.isCollapsed).toBe(true);
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
    tray.setCollapsed(false);
    expect(tray.isCollapsed).toBe(false);
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("holds the collapsed flag while snapshots re-render and prune", () => {
    const drafts = new DraftAnswers();
    const tray = stateTray(drafts);
    tray.setCollapsed(true);
    tray.setNote("01", "clean the worktree first");
    // A snapshot render prunes against the pending interrupts; neither the
    // prune nor the rebuild touches the collapsed flag or the drafts.
    drafts.prune(new Set(["01"]));
    expect(tray.isCollapsed).toBe(true);
    expect(tray.note("01")).toBe("clean the worktree first");
  });
});

describe("NeedsInputTray waiting rows", () => {
  // The engine's accept-now / drain-at-boundary contract (ADR-0004): an
  // answered interrupt stays listed with its queued flag set until the
  // super-step boundary snapshot drops it.
  function queuedAnswerSnapshot(): EnrichedSnapshot {
    return {
      seq: 0,
      phase: "running",
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
            assignment: { harness: null, model: null, drivers: "implement" },
            liveAttempt: null,
            heldPane: null,
            reassign: {
              eligible: true,
              reason: null,
              verify: null,
              sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
            },
          },
          {
            id: "B",
            title: "ticket B",
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
          },
        ],
        conversations: [],
        log: [],
        outcomes: {},
        mergeQueue: [],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief A" },
          { ticketId: "B", kind: "checkpoint", body: "brief B" },
        ],
        queuedAnswers: [
          {
            seq: 1,
            ticketId: "A",
            kind: "checkpoint",
            at: "2026-09-12T10:00:00Z",
            processedAt: null,
          },
        ],
        config: {},
      },
    };
  }

  function drainedSnapshot(): EnrichedSnapshot {
    const snap = queuedAnswerSnapshot();
    snap.state.interrupts = snap.state.interrupts.filter((i) => i.ticketId !== "A");
    snap.state.queuedAnswers = [];
    return snap;
  }

  it("marks a row with a matching queued answer as answered and waiting", () => {
    const rows = projectNeedsInput(projectPool(queuedAnswerSnapshot()).cards);
    expect(waitingStatus(rows[0])).toBe("answered · waiting");
    expect(waitingStatus(rows[1])).toBeNull();
  });

  it("keeps a waiting row's draft pending until the boundary drains it", () => {
    const drafts = new DraftAnswers();
    const tray = stateTray(drafts);
    tray.setNote("A", "clean the worktree first");
    tray.setNote("B", "skip the flaky test");
    // While A waits, its row still lists, so its draft stays pending.
    const waiting = projectNeedsInput(projectPool(queuedAnswerSnapshot()).cards);
    drafts.prune(new Set(waiting.map((row) => row.ticketId)));
    expect(tray.note("A")).toBe("clean the worktree first");
    expect(tray.note("B")).toBe("skip the flaky test");
    // The boundary applies the queued answer and the row disappears; the
    // draft goes with it, and the still-open row's draft stands.
    const drained = projectNeedsInput(projectPool(drainedSnapshot()).cards);
    drafts.prune(new Set(drained.map((row) => row.ticketId)));
    expect(tray.note("A")).toBe("");
    expect(tray.note("B")).toBe("skip the flaky test");
  });
});

describe("NeedsInputTray resume all", () => {
  it("fires exactly the open resume-kind rows in parallel, each with its own note", () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    tray.setNote("01", "clean the worktree first");
    tray.setNote("03", "skip the flaky test");
    const rows = [
      row("01", "checkpoint"),
      row("02", "review"),
      row("03", "crash"),
      row("04", "checkpoint", true),
    ];
    const fired = tray.resumeAll(rows);
    // Both calls are recorded before any settlement: the review row and the
    // queued row never fire.
    expect(fake.calls).toEqual([
      { ticketId: "01", action: "resume", note: "clean the worktree first" },
      { ticketId: "03", action: "resume", note: "skip the flaky test" },
    ]);
    fake.deferreds.get("01")!.resolve();
    fake.deferreds.get("03")!.resolve();
    return fired;
  });

  it("marks a rejected row alone, leaving its note and the other rows standing", async () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    const fired = tray.resumeAll([row("01", "checkpoint"), row("02", "deadlock")]);
    fake.deferreds.get("01")!.resolve();
    fake.deferreds.get("02")!.reject(new Error("pool resume failed: 500"));
    await fired;
    expect(tray.failure("01")).toBeNull();
    expect(tray.failure("02")).toEqual({
      action: "resume",
      message: "pool resume failed: 500",
    } satisfies NeedsInputFailure);
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("retry refires the failed action with the same note, and success clears the mark", async () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    tray.setNote("01", "clean the worktree first");
    const fired = tray.resumeAll([row("01", "merge-conflict")]);
    fake.deferreds.get("01")!.reject(new Error("pool resume failed: 500"));
    await fired;
    expect(tray.failure("01")).not.toBeNull();
    const retried = tray.retry("01");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toEqual({
      ticketId: "01",
      action: "resume",
      note: "clean the worktree first",
    });
    fake.deferreds.get("01")!.resolve();
    await retried;
    expect(tray.failure("01")).toBeNull();
  });

  it("retry is a no-op for a row with no failure mark", async () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    await tray.retry("01");
    expect(fake.calls).toEqual([]);
  });

  it("drops a row's failure mark when its interrupt resolves", async () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    const fired = tray.resumeAll([row("01", "checkpoint")]);
    fake.deferreds.get("01")!.reject(new Error("pool resume failed: 500"));
    await fired;
    tray.pruneFailures(new Set());
    expect(tray.failure("01")).toBeNull();
  });
});

describe("NeedsInputTray Keep talking (issue #139)", () => {
  // A row as the projection hands it over: `keepTalking` set only on a
  // checkpoint whose ticket still has its Held pane.
  function offered(
    ticketId: string,
    kind: InterruptKind,
    keepTalking: InterruptView["keepTalking"],
  ): NeedsInputRow {
    const base = row(ticketId, kind);
    return { ...base, interrupt: { ...base.interrupt, keepTalking } };
  }

  function paint(rows: NeedsInputRow[]) {
    const keepTalks: string[] = [];
    const tray = stateTray();
    const el = tray.render(
      rows,
      [],
      trayHandlers({ onKeepTalking: (ticketId) => keepTalks.push(ticketId) }),
    )!;
    return { el, keepTalks };
  }

  const keepTalkingIn = (el: HTMLElement, cardId: string) =>
    el.querySelector<HTMLButtonElement>(`[data-key="${cardId}"] .keep-talking`);

  it("offers it on a checkpoint row with a Held pane, beside Resume, and calls the seam", () => {
    const { el, keepTalks } = paint([
      offered("01", "checkpoint", { requesting: false, failure: null }),
    ]);
    const actions = [...el.querySelectorAll('[data-key="ticket:01"] .needs-input-actions button')];
    expect(actions.map((b) => b.textContent)).toEqual(["resume", "Keep talking"]);
    keepTalkingIn(el, "ticket:01")!.click();
    expect(keepTalks).toEqual(["01"]);
  });

  it("offers it nowhere the projection withholds it", () => {
    const { el } = paint([
      offered("01", "checkpoint", null),
      offered("02", "merge-conflict", null),
      offered("03", "merge-approval", null),
    ]);
    expect(el.querySelectorAll(".keep-talking")).toHaveLength(0);
  });

  it("stays out of resume all, which fires Resume alone", () => {
    const fake = fakeAnswer();
    const tray = trayWith(fake);
    const fired = tray.resumeAll([
      offered("01", "checkpoint", { requesting: false, failure: null }),
    ]);
    expect(fake.calls).toEqual([{ ticketId: "01", action: "resume", note: "" }]);
    fake.deferreds.get("01")!.resolve();
    return fired;
  });

  it("disables while the request is out and shows a refusal's reason under the row", () => {
    const { el } = paint([
      offered("01", "checkpoint", { requesting: true, failure: null }),
      offered("02", "checkpoint", { requesting: false, failure: "the pane is gone" }),
    ]);
    expect(keepTalkingIn(el, "ticket:01")?.disabled).toBe(true);
    expect(keepTalkingIn(el, "ticket:02")?.disabled).toBe(false);
    const failures = [...el.querySelectorAll(".keep-talking-failure")];
    expect(failures.map((f) => f.textContent)).toEqual(["the pane is gone"]);
  });
});

describe("NeedsInputTray row layout (issue #147)", () => {
  const longId = "conv-1-spawn-2-spawn-1-a-ticket-id-long-enough-to-squeeze-the-row";

  it("puts the note on its own full-width line under the id, kind and actions", () => {
    const tray = stateTray();
    const el = tray.render([row(longId, "checkpoint")], [], trayHandlers())!;
    const rowEl = el.querySelector(`[data-key="ticket:${longId}"]`)!;
    const line = rowEl.querySelector(":scope > .needs-input-row-line")!;
    expect(line).not.toBeNull();
    expect(line.querySelector(".needs-input-id")?.textContent).toBe(longId);
    expect(line.querySelector(".needs-input-kind")).not.toBeNull();
    expect(line.querySelector(".needs-input-actions")).not.toBeNull();
    // The note is the row's own child after the line, never squeezed beside
    // the id: a textarea, keeping the classes the Detail's note shares.
    const note = rowEl.querySelector(":scope > .needs-input-note")!;
    expect(note.tagName).toBe("TEXTAREA");
    expect(note.classList.contains("interrupt-note")).toBe(true);
    expect(line.querySelector(".needs-input-note")).toBeNull();
    expect(rowEl.lastElementChild).toBe(note);
  });

  it("grows the note's rows with its lines, floored at two and capped at eight", () => {
    expect(noteRows("")).toBe(2);
    expect(noteRows("one line")).toBe(2);
    expect(noteRows("a\nb\nc")).toBe(3);
    expect(noteRows(Array.from({ length: 20 }, () => "x").join("\n"))).toBe(8);
    const tray = stateTray();
    tray.setNote("01", "a\nb\nc\nd");
    const el = tray.render([row("01", "checkpoint")], [], trayHandlers())!;
    expect(el.querySelector("textarea.needs-input-note")!.getAttribute("rows")).toBe("4");
  });

  it("writes what is typed in the note to the shared Draft answers", () => {
    const drafts = new DraftAnswers();
    const tray = stateTray(drafts);
    const el = tray.render([row("01", "checkpoint")], [], trayHandlers())!;
    const note = el.querySelector<HTMLTextAreaElement>("textarea.needs-input-note")!;
    note.value = "line one\nline two";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    expect(drafts.get("01")).toBe("line one\nline two");
  });

  it("shows a draft typed elsewhere, and resume all sends it", () => {
    const drafts = new DraftAnswers();
    const fake = fakeAnswer();
    const tray = trayWith(fake, drafts);
    drafts.set("01", "written full size in the Detail");
    const el = tray.render([row("01", "checkpoint")], [], trayHandlers())!;
    expect(el.querySelector<HTMLTextAreaElement>("textarea.needs-input-note")!.value).toBe(
      "written full size in the Detail",
    );
    const fired = tray.resumeAll([row("01", "checkpoint")]);
    expect(fake.calls).toEqual([
      { ticketId: "01", action: "resume", note: "written full size in the Detail" },
    ]);
    fake.deferreds.get("01")!.resolve();
    return fired;
  });
});

describe("NeedsInputTray expand (issue #147)", () => {
  it("offers expand on every interrupt row and reports the card and ticket", () => {
    const expanded: [string, string][] = [];
    const tray = stateTray();
    const el = tray.render(
      [row("01", "checkpoint"), row("02", "review")],
      [],
      trayHandlers({ onExpand: (cardId, ticketId) => expanded.push([cardId, ticketId]) }),
    )!;
    const expand = el.querySelector<HTMLButtonElement>('[data-key="ticket:02"] .needs-input-expand')!;
    expect(expand.title).toBe("write this answer full size");
    expand.click();
    expect(expanded).toEqual([["ticket:02", "02"]]);
    // Expand is not an answer: the actions keep exactly the form's set.
    const actions = [...el.querySelectorAll('[data-key="ticket:02"] .needs-input-actions button')];
    expect(actions.map((b) => b.textContent)).toEqual(["approve", "reject"]);
  });

  it("disables expand on a waiting row, whose Detail has no note to write", () => {
    const tray = stateTray();
    const el = tray.render([row("01", "checkpoint", true)], [], trayHandlers())!;
    expect(el.querySelector<HTMLButtonElement>(".needs-input-expand")!.disabled).toBe(true);
  });
});

describe("NeedsInputTray width (issue #147)", () => {
  beforeEach(() => localStorage.clear());

  function mount(tray: NeedsInputTray) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.className = "shell";
        shell.appendChild(tray.render([row("01", "checkpoint")], [], trayHandlers())!);
        return shell;
      });
    paint();
    const trayEl = () => root.querySelector<HTMLElement>(".needs-input-tray")!;
    return { root, paint, trayEl };
  }

  function pointer(type: string, target: Element, x: number): void {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: 10 }),
    );
  }

  it("starts at the original 300px", () => {
    const { trayEl } = mount(stateTray());
    expect(trayEl().style.width).toBe("300px");
  });

  it("widens by dragging its right edge, and remembers the width", () => {
    const { root, paint, trayEl } = mount(stateTray());
    const handle = root.querySelector(".needs-input-handle")!;
    pointer("pointerdown", handle, 300);
    pointer("pointermove", handle, 360);
    pointer("pointermove", handle, 420);
    expect(trayEl().style.width).toBe("420px");
    pointer("pointerup", handle, 420);
    expect(localStorage.getItem(NEEDS_INPUT_WIDTH_KEY)).toBe("420");
    // A re-render draws the dragged width, and a new session reads it back.
    paint();
    expect(trayEl().style.width).toBe("420px");
    expect(mount(stateTray()).trayEl().style.width).toBe("420px");
  });

  it("lets go of a drag whose pointer capture is lost, so the next drag starts", () => {
    const { root, trayEl } = mount(stateTray());
    const handle = root.querySelector(".needs-input-handle")!;
    pointer("pointerdown", handle, 300);
    pointer("pointermove", handle, 360);
    // The tray unmounted mid-drag: the capture goes and no pointerup comes.
    pointer("lostpointercapture", handle, 360);
    pointer("pointermove", handle, 500);
    expect(trayEl().style.width).toBe("360px");
    pointer("pointerdown", handle, 360);
    pointer("pointermove", handle, 400);
    expect(trayEl().style.width).toBe("400px");
  });

  it("never narrows below 300px", () => {
    const { root, trayEl } = mount(stateTray());
    const handle = root.querySelector(".needs-input-handle")!;
    pointer("pointerdown", handle, 300);
    pointer("pointermove", handle, 100);
    pointer("pointerup", handle, 100);
    expect(trayEl().style.width).toBe("300px");
  });

  it("resets to the default width and forgets the stored one", () => {
    localStorage.setItem(NEEDS_INPUT_WIDTH_KEY, "480");
    const tray = stateTray();
    const { trayEl, paint } = mount(tray);
    expect(trayEl().style.width).toBe("480px");
    tray.resetWidth();
    expect(trayEl().style.width).toBe("300px");
    expect(localStorage.getItem(NEEDS_INPUT_WIDTH_KEY)).toBeNull();
    paint();
    expect(trayEl().style.width).toBe("300px");
  });
});
