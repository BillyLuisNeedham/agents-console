/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { createPaneSurvey, listedAsRecorded } from "./pane-survey.ts";

const pane = (paneId: string, tabId: string | null = null) => ({ paneId, tabId, workspaceId: null, cwd: null, terminalId: null });

describe("pane survey", () => {
  it("serves the last listing and hands every one to the engine", async () => {
    let panes = [pane("p1", "t1")];
    let listings = 0;
    const survey = createPaneSurvey({ list: async () => panes, onListing: () => listings++ });
    expect(survey.latest()).toBeNull();
    await survey.refresh();
    expect([...survey.latest()!.panes.keys()]).toEqual(["p1"]);
    expect([...survey.latest()!.tabs]).toEqual(["t1"]);
    expect(listings).toBe(1);
    panes = [];
    await survey.refresh();
    expect(survey.latest()!.panes.size).toBe(0);
    expect(listings).toBe(2);
    survey.stop();
  });

  it("keeps the last good listing when the daemon cannot answer, and says nothing", async () => {
    let fail = false;
    let listings = 0;
    const survey = createPaneSurvey({
      list: async () => {
        if (fail) throw new Error("daemon down");
        return [pane("p1")];
      },
      onListing: () => listings++,
    });
    expect(await survey.refresh()).toBe(true);
    fail = true;
    expect(await survey.refresh()).toBe(false);
    expect(survey.latest()!.panes.has("p1")).toBe(true);
    expect(listings).toBe(1);
    survey.stop();
  });

  it("queues one listing behind the one in flight for every caller, and lists on its cadence", async () => {
    let calls = 0;
    const survey = createPaneSurvey({
      list: async () => {
        calls += 1;
        await Bun.sleep(10);
        return [];
      },
      onListing: () => {},
      intervalMs: 30,
    });
    await Promise.all([survey.refresh(), survey.refresh(), survey.refresh()]);
    expect(calls).toBe(2);
    await Bun.sleep(80);
    expect(calls).toBeGreaterThan(1);
    survey.stop();
    const stopped = calls;
    await Bun.sleep(80);
    expect(calls).toBe(stopped);
  });

  it("answers a refresh made during a listing with one that began after it (review item 7)", async () => {
    let calls = 0;
    let panes = [pane("p1")];
    const survey = createPaneSurvey({
      list: async () => {
        calls += 1;
        const snapshot = panes;
        await Bun.sleep(20);
        return snapshot;
      },
      onListing: () => {},
    });
    const first = survey.refresh();
    await Bun.sleep(5);
    // The pane closes while the first listing is out: a caller that asks now
    // must not be answered by the listing that began before.
    panes = [];
    const [a, b] = [survey.refresh(), survey.refresh()];
    await Promise.all([first, a, b]);
    expect(calls).toBe(2);
    expect(survey.latest()!.panes.size).toBe(0);
    survey.stop();
  });
});

describe("listedAsRecorded", () => {
  const listing = (
    listed: {
      paneId: string;
      tabId: string | null;
      workspaceId: string | null;
      cwd: string | null;
      terminalId: string | null;
    }[],
  ) => ({
    panes: new Map(listed.map((p) => [p.paneId, p])),
    tabs: new Set(listed.flatMap((p) => (p.tabId ? [p.tabId] : []))),
  });
  it("holds a pane only as it was recorded", () => {
    const recorded = { paneId: "p1", tabId: "t1", cwd: "/w" };
    const as = (
      p: Partial<{ tabId: string | null; workspaceId: string | null; cwd: string | null; terminalId: string | null }>,
    ) => listing([{ paneId: "p1", tabId: null, workspaceId: null, cwd: null, terminalId: null, ...p }]);
    expect(listedAsRecorded(as({ tabId: "t1", workspaceId: "w1", cwd: "/w" }), recorded, "w1")).toBe(true);
    expect(listedAsRecorded(as({}), recorded, "w1")).toBe(true);
    expect(listedAsRecorded(as({ tabId: "t2" }), recorded, null)).toBe(false);
    expect(listedAsRecorded(as({ workspaceId: "w2" }), recorded, "w1")).toBe(false);
    expect(listedAsRecorded(as({ workspaceId: "w2" }), recorded, null)).toBe(true);
    expect(listedAsRecorded(as({ cwd: "/x" }), recorded, null)).toBe(false);
    expect(listedAsRecorded(listing([]), recorded, null)).toBe(false);
  });

  it("requires herdr's terminal id to match where both sides carry one", () => {
    const recorded = { paneId: "p1", tabId: "t1", cwd: null, terminalId: "term_65b1" };
    const as = (terminalId: string | null) =>
      listing([{ paneId: "p1", tabId: "t1", workspaceId: null, cwd: null, terminalId }]);
    expect(listedAsRecorded(as("term_65b1"), recorded, null)).toBe(true);
    // The short ids were reused by a later terminal: not ours.
    expect(listedAsRecorded(as("term_ffff"), recorded, null)).toBe(false);
    // A daemon that reports none, and a record from before one was kept,
    // fall back to the other checks.
    expect(listedAsRecorded(as(null), recorded, null)).toBe(true);
    expect(listedAsRecorded(as("term_ffff"), { ...recorded, terminalId: null }, null)).toBe(true);
  });
});
