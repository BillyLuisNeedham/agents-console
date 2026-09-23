/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  NeedsInputTray,
  waitingStatus,
  type AnswerHandler,
  type NeedsInputFailure,
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

function trayWith(fake: ReturnType<typeof fakeAnswer>): NeedsInputTray {
  return new NeedsInputTray({ onAnswer: fake.answer, onChange: () => {} });
}

// A tray for the state-only tests: the answer seam is never fired, so a
// neutral one stands in for the composition's wiring.
function stateTray(): NeedsInputTray {
  return new NeedsInputTray({ onAnswer: () => Promise.resolve(), onChange: () => {} });
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

  it("prunes drafts whose interrupt resolved, keeping the still-pending ones", () => {
    const tray = stateTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    tray.pruneDrafts(new Set(["02"]));
    expect(tray.note("01")).toBe("");
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("prunes nothing when every draft's interrupt is still pending", () => {
    const tray = stateTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    tray.pruneDrafts(new Set(["01", "02", "03"]));
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
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
    const tray = stateTray();
    tray.setCollapsed(true);
    tray.setNote("01", "clean the worktree first");
    // A snapshot render prunes against the pending interrupts; neither the
    // prune nor the rebuild touches the collapsed flag or the drafts.
    tray.pruneDrafts(new Set(["01"]));
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
      poolDir: "/tmp/pool",
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
            reassign: {
              eligible: true,
              reason: null,
              verify: null,
              sources: { harness: "default", model: "default", drivers: "default" },
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
            reassign: {
              eligible: true,
              reason: null,
              verify: null,
              sources: { harness: "default", model: "default", drivers: "default" },
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
    const tray = stateTray();
    tray.setNote("A", "clean the worktree first");
    tray.setNote("B", "skip the flaky test");
    // While A waits, its row still lists, so its draft stays pending.
    const waiting = projectNeedsInput(projectPool(queuedAnswerSnapshot()).cards);
    tray.pruneDrafts(new Set(waiting.map((row) => row.ticketId)));
    expect(tray.note("A")).toBe("clean the worktree first");
    expect(tray.note("B")).toBe("skip the flaky test");
    // The boundary applies the queued answer and the row disappears; the
    // draft goes with it, and the still-open row's draft stands.
    const drained = projectNeedsInput(projectPool(drainedSnapshot()).cards);
    tray.pruneDrafts(new Set(drained.map((row) => row.ticketId)));
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
