/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { appendEvent } from "./events.ts";
import { finishedTerminals, openedTabs, tabRecordedClosed, type OpenedTab } from "./finished-terminals.ts";
import type { ListedPane, PaneListing } from "./pane-survey.ts";
import { makeTempDir } from "./tmp.ts";

const AT = "2026-09-25T10:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listing(panes: Partial<ListedPane>[]): PaneListing {
  const full: ListedPane[] = panes.map((pane) => ({
    paneId: pane.paneId!,
    tabId: pane.tabId ?? null,
    workspaceId: pane.workspaceId ?? null,
    cwd: pane.cwd ?? null,
    terminalId: pane.terminalId ?? null,
  }));
  return {
    panes: new Map(full.map((pane) => [pane.paneId, pane])),
    tabs: new Set(full.flatMap((pane) => (pane.tabId === null ? [] : [pane.tabId]))),
  };
}

const none = { panes: new Set<string>(), tabs: new Set<string>() };

function tab(owner: string, n: number, cwd: string | null = null, terminalId: string | null = null): OpenedTab {
  return { owner, tabId: `t${n}`, paneId: `p${n}`, cwd, terminalId };
}

describe("finished terminals", () => {
  it("reads every tab the owners' spawned events name, once each", () => {
    const runsDir = makeTempDir("runs-");
    dirs.push(runsDir);
    appendEvent(runsDir, "01", { at: AT, attempt: 1, kind: "spawned", payload: { cwd: "/w", pane_id: "p1", tab_id: "t1", terminal_id: "term_a" } });
    appendEvent(runsDir, "01", { at: AT, attempt: 2, kind: "spawned", payload: { cwd: "/w", pane_id: "p1", tab_id: "t1", continued: true } });
    appendEvent(runsDir, "01", { at: AT, attempt: 3, kind: "spawned", payload: { pid: 7 } });
    appendEvent(runsDir, "conv-1", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "pc", tab_id: "tc" } });
    appendEvent(runsDir, "enlist-1", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "pe", tab_id: "te" } });
    expect(openedTabs(runsDir, ["01", "conv-1"])).toEqual([
      { owner: "01", tabId: "t1", paneId: "p1", cwd: "/w", terminalId: null },
      { owner: "conv-1", tabId: "tc", paneId: "pc", cwd: null, terminalId: null },
    ]);
  });

  it("counts the tabs herdr still lists whose panes nothing is using", () => {
    const opened = [tab("01", 1), tab("02", 2), tab("03", 3), tab("04", 4), tab("05", 5)];
    const listed = listing([
      { paneId: "p1", tabId: "t1" }, // crashed, still open
      { paneId: "p2", tabId: "t2" }, // a Live attempt's
      { paneId: "p3", tabId: "t3" }, // a Held pane's
      // p4 closed already
      { paneId: "p5", tabId: "t5" }, // the operator split a busy pane into t5
      { paneId: "p5b", tabId: "t5" },
    ]);
    const off = { panes: new Set(["p2", "p3", "p5b"]), tabs: new Set<string>() };
    expect(finishedTerminals(opened, listed, off, null).map((t) => t.tabId)).toEqual(["t1"]);
  });

  it("never counts a tab someone enlisted from, whoever opened it (review item 2)", () => {
    // A done ticket's still-open tab whose agent the operator then enlisted
    // as a new Ticket: the tab is theirs now.
    const opened = [tab("01", 1)];
    const listed = listing([{ paneId: "p1", tabId: "t1" }]);
    expect(finishedTerminals(opened, listed, { panes: new Set(), tabs: new Set(["t1"]) }, null)).toEqual([]);
    expect(finishedTerminals(opened, listed, { panes: new Set(["p1"]), tabs: new Set() }, null)).toEqual([]);
  });

  it("never counts a tab herdr lists differently from how it was recorded (review item 4)", () => {
    const opened = [tab("01", 1, "/pool/wt/01")];
    // Recorded pane now sits in another tab: an id reused by a new pane.
    expect(finishedTerminals(opened, listing([{ paneId: "p1", tabId: "t9" }]), none, null)).toEqual([]);
    // Outside the Pool workspace.
    expect(
      finishedTerminals(opened, listing([{ paneId: "p1", tabId: "t1", workspaceId: "w-other" }]), none, "w1"),
    ).toEqual([]);
    // In another directory.
    expect(
      finishedTerminals(opened, listing([{ paneId: "p1", tabId: "t1", cwd: "/elsewhere" }]), none, null),
    ).toEqual([]);
    // As recorded, fields the daemon does not report are not held against it.
    expect(
      finishedTerminals(
        opened,
        listing([{ paneId: "p1", tabId: "t1", workspaceId: "w1", cwd: "/pool/wt/01/" }]),
        none,
        "w1",
      ),
    ).toHaveLength(1);
    expect(finishedTerminals(opened, listing([{ paneId: "p1" }]), none, "w1")).toHaveLength(1);
    expect(finishedTerminals(opened, listing([]), none, null)).toHaveLength(0);
  });

  it("never counts a tab whose terminal herdr now names differently (terminal_id)", () => {
    const opened = [tab("01", 1, null, "term_65b1")];
    // Same pane and tab ids, another terminal behind them: not ours.
    expect(
      finishedTerminals(opened, listing([{ paneId: "p1", tabId: "t1", terminalId: "term_ffff" }]), none, null),
    ).toEqual([]);
    expect(
      finishedTerminals(opened, listing([{ paneId: "p1", tabId: "t1", terminalId: "term_65b1" }]), none, null),
    ).toHaveLength(1);
    // A record from before herdr gave terminal ids falls back to the other checks.
    expect(
      finishedTerminals([tab("01", 1)], listing([{ paneId: "p1", tabId: "t1", terminalId: "term_ffff" }]), none, null),
    ).toHaveLength(1);
  });

  it("knows a tab closed by its terminal id when one was recorded, by its tab id otherwise (R7)", () => {
    const closed = (payload: Record<string, unknown>) => [
      { at: AT, attempt: 1, kind: "tab-closed" as const, payload },
    ];
    // The same short tab id, reused by a later terminal: not the one closed.
    expect(tabRecordedClosed(closed({ tab_id: "t1", terminal_id: "term_a" }), "t1", "term_b")).toBe(false);
    expect(tabRecordedClosed(closed({ tab_id: "t1", terminal_id: "term_a" }), "t9", "term_a")).toBe(true);
    // Records without terminal ids fall back to the tab id.
    expect(tabRecordedClosed(closed({ tab_id: "t1" }), "t1", "term_b")).toBe(true);
    expect(tabRecordedClosed(closed({ tab_id: "t1", terminal_id: "term_a" }), "t1", null)).toBe(true);
    expect(tabRecordedClosed([], "t1", null)).toBe(false);
  });

  it("leaves out a tab its owner's events record closed", () => {
    const runsDir = makeTempDir("runs-");
    dirs.push(runsDir);
    appendEvent(runsDir, "01", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "p1", tab_id: "t1", terminal_id: "term_a" } });
    appendEvent(runsDir, "01", { at: AT, attempt: 2, kind: "spawned", payload: { pane_id: "p2", tab_id: "t2" } });
    appendEvent(runsDir, "01", { at: AT, attempt: 1, kind: "tab-closed", payload: { tab_id: "t1", terminal_id: "term_a" } });
    expect(openedTabs(runsDir, ["01"]).map((tab) => tab.tabId)).toEqual(["t2"]);
  });
});
