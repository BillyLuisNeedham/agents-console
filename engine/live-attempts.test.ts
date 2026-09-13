/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { createLiveAttempts } from "./live-attempts.ts";

describe("live attempts registry", () => {
  it("registers an Attempt with its pane and clears it at the ending", () => {
    const live = createLiveAttempts();
    live.register("01", 1, { paneId: "pane-1", tabId: "tab-1" });
    expect(live.isLive("01")).toBe(true);
    expect(live.records()).toEqual({ "01": { attempt: 1, paneId: "pane-1" } });
    live.clear("01", 1);
    expect(live.isLive("01")).toBe(false);
    expect(live.records()).toEqual({});
  });

  it("carries a headless Attempt with a null pane, so the Ticket reads live without a surface", () => {
    const live = createLiveAttempts();
    live.register("01", 3, { paneId: null, tabId: null });
    expect(live.records()).toEqual({ "01": { attempt: 3, paneId: null } });
  });

  it("serves the highest-numbered live Attempt of a fan-out and falls back when it ends first", () => {
    const live = createLiveAttempts();
    live.register("01", 4, { paneId: "pane-4", tabId: "tab-4" });
    live.register("01", 5, { paneId: "pane-5", tabId: "tab-5" });
    live.register("01", 6, { paneId: "pane-6", tabId: "tab-6" });
    expect(live.records()["01"]).toEqual({ attempt: 6, paneId: "pane-6" });
    live.clear("01", 6);
    expect(live.records()["01"]).toEqual({ attempt: 5, paneId: "pane-5" });
    live.clear("01", 4);
    expect(live.records()["01"]).toEqual({ attempt: 5, paneId: "pane-5" });
    live.clear("01", 5);
    expect(live.records()).toEqual({});
  });

  it("leaves out the ids the caller excludes, a Conversation's pane riding its own view", () => {
    const live = createLiveAttempts();
    live.register("01", 1, { paneId: "pane-1", tabId: "tab-1" });
    live.register("conv-1", 1, { paneId: "pane-c", tabId: "tab-c" });
    expect(live.records((id) => id.startsWith("conv-"))).toEqual({
      "01": { attempt: 1, paneId: "pane-1" },
    });
    expect(live.isLive("conv-1")).toBe(true);
  });

  it("notifies on every change and stays quiet on a clear that changes nothing", () => {
    let changes = 0;
    const live = createLiveAttempts(() => {
      changes += 1;
    });
    live.register("01", 1, { paneId: null, tabId: null });
    expect(changes).toBe(1);
    live.clear("01", 2);
    live.clear("02", 1);
    expect(changes).toBe(1);
    live.clear("01", 1);
    expect(changes).toBe(2);
  });
});
