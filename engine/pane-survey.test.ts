/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { createPaneSurvey } from "./pane-survey.ts";

describe("pane survey", () => {
  it("serves the last listing and hands every one to the engine", async () => {
    let panes = [{ paneId: "p1", tabId: "t1" }];
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
        return [{ paneId: "p1", tabId: null }];
      },
      onListing: () => listings++,
    });
    await survey.refresh();
    fail = true;
    await survey.refresh();
    expect(survey.latest()!.panes.has("p1")).toBe(true);
    expect(listings).toBe(1);
    survey.stop();
  });

  it("shares one listing between concurrent refreshes and lists on its cadence", async () => {
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
    await Promise.all([survey.refresh(), survey.refresh()]);
    expect(calls).toBe(1);
    await Bun.sleep(80);
    expect(calls).toBeGreaterThan(1);
    survey.stop();
    const stopped = calls;
    await Bun.sleep(80);
    expect(calls).toBe(stopped);
  });
});
