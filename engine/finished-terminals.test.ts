/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "./events.ts";
import { finishedTerminals, openedTabs, type OpenedTab } from "./finished-terminals.ts";
import type { PaneListing } from "./pane-survey.ts";
import { makeTempDir } from "./tmp.ts";

const AT = "2026-09-25T10:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listing(panes: [string, string | null][]): PaneListing {
  return {
    panes: new Map(panes),
    tabs: new Set(panes.flatMap(([, tab]) => (tab === null ? [] : [tab]))),
  };
}

describe("finished terminals", () => {
  it("reads every tab the owners' spawned events name, once each", () => {
    const runsDir = join(makeTempDir("runs-"));
    dirs.push(runsDir);
    appendEvent(runsDir, "01", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "p1", tab_id: "t1" } });
    appendEvent(runsDir, "01", { at: AT, attempt: 2, kind: "spawned", payload: { pane_id: "p1", tab_id: "t1", continued: true } });
    appendEvent(runsDir, "01", { at: AT, attempt: 3, kind: "spawned", payload: { pid: 7 } });
    appendEvent(runsDir, "conv-1", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "pc", tab_id: "tc" } });
    appendEvent(runsDir, "enlist-1", { at: AT, attempt: 1, kind: "spawned", payload: { pane_id: "pe", tab_id: "te" } });
    expect(openedTabs(runsDir, ["01", "conv-1"])).toEqual([
      { owner: "01", tabId: "t1", paneId: "p1" },
      { owner: "conv-1", tabId: "tc", paneId: "pc" },
    ]);
  });

  it("counts the tabs herdr still lists whose panes nothing is using", () => {
    const opened: OpenedTab[] = [
      { owner: "01", tabId: "t1", paneId: "p1" }, // crashed, still open
      { owner: "02", tabId: "t2", paneId: "p2" }, // a Live attempt's
      { owner: "03", tabId: "t3", paneId: "p3" }, // a Held pane's
      { owner: "04", tabId: "t4", paneId: "p4" }, // closed already
      { owner: "05", tabId: "t5", paneId: "p5" }, // the operator split a busy pane into it
    ];
    const listed = listing([
      ["p1", "t1"],
      ["p2", "t2"],
      ["p3", "t3"],
      ["p5", "t5"],
      ["p5b", "t5"],
    ]);
    const busy = new Set(["p2", "p3", "p5b"]);
    expect(finishedTerminals(opened, listed, busy).map((tab) => tab.tabId)).toEqual(["t1"]);
  });

  it("falls back to the root pane when the daemon reports no tab ids", () => {
    const opened: OpenedTab[] = [{ owner: "01", tabId: "t1", paneId: "p1" }];
    expect(finishedTerminals(opened, listing([["p1", null]]), new Set())).toHaveLength(1);
    expect(finishedTerminals(opened, listing([]), new Set())).toHaveLength(0);
  });
});
