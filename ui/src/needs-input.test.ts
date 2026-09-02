/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { NeedsInputTray, waitingStatus } from "./needs-input";
import { projectNeedsInput, type PoolSnapshot } from "./project";

describe("NeedsInputTray note drafts", () => {
  it("holds a draft per ticket id across renders", () => {
    const tray = new NeedsInputTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    // The drafts are instance state: a re-render reads them back unchanged.
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("starts empty for a ticket with no draft", () => {
    const tray = new NeedsInputTray();
    expect(tray.note("01")).toBe("");
  });

  it("prunes drafts whose interrupt resolved, keeping the still-pending ones", () => {
    const tray = new NeedsInputTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    tray.pruneDrafts(new Set(["02"]));
    expect(tray.note("01")).toBe("");
    expect(tray.note("02")).toBe("skip the flaky test");
  });

  it("prunes nothing when every draft's interrupt is still pending", () => {
    const tray = new NeedsInputTray();
    tray.setNote("01", "clean the worktree first");
    tray.setNote("02", "skip the flaky test");
    tray.pruneDrafts(new Set(["01", "02", "03"]));
    expect(tray.note("01")).toBe("clean the worktree first");
    expect(tray.note("02")).toBe("skip the flaky test");
  });
});

describe("NeedsInputTray collapse", () => {
  it("starts expanded", () => {
    const tray = new NeedsInputTray();
    expect(tray.isCollapsed).toBe(false);
  });

  it("keeps drafts across a collapse and an expand, both directions", () => {
    const tray = new NeedsInputTray();
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
    const tray = new NeedsInputTray();
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
  function queuedAnswerSnapshot(): PoolSnapshot {
    return {
      seq: 0,
      phase: "running",
      poolName: "repo/pool",
      state: {
        tickets: [
          { id: "A", title: "ticket A", blockedBy: [], status: "checkpoint" },
          { id: "B", title: "ticket B", blockedBy: [], status: "checkpoint" },
        ],
        log: [],
        outcomes: {},
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief A" },
          { ticketId: "B", kind: "checkpoint", body: "brief B" },
        ],
        queuedAnswers: [{ ticketId: "A", kind: "checkpoint" }],
        config: {},
      },
    };
  }

  function drainedSnapshot(): PoolSnapshot {
    const snap = queuedAnswerSnapshot();
    snap.state.interrupts = snap.state.interrupts.filter((i) => i.ticketId !== "A");
    snap.state.queuedAnswers = [];
    return snap;
  }

  it("marks a row with a matching queued answer as answered and waiting", () => {
    const rows = projectNeedsInput(queuedAnswerSnapshot());
    expect(waitingStatus(rows[0])).toBe("answered · waiting");
    expect(waitingStatus(rows[1])).toBeNull();
  });

  it("keeps a waiting row's draft pending until the boundary drains it", () => {
    const tray = new NeedsInputTray();
    tray.setNote("A", "clean the worktree first");
    tray.setNote("B", "skip the flaky test");
    // While A waits, its row still lists, so its draft stays pending.
    const waiting = projectNeedsInput(queuedAnswerSnapshot());
    tray.pruneDrafts(new Set(waiting.map((row) => row.ticketId)));
    expect(tray.note("A")).toBe("clean the worktree first");
    expect(tray.note("B")).toBe("skip the flaky test");
    // The boundary applies the queued answer and the row disappears; the
    // draft goes with it, and the still-open row's draft stands.
    const drained = projectNeedsInput(drainedSnapshot());
    tray.pruneDrafts(new Set(drained.map((row) => row.ticketId)));
    expect(tray.note("A")).toBe("");
    expect(tray.note("B")).toBe("skip the flaky test");
  });
});
