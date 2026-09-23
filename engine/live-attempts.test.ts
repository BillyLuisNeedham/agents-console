/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { createLiveAttempts } from "./live-attempts.ts";

const AT = "2026-09-23T10:00:00.000Z";

describe("live attempts registry", () => {
  it("registers an Attempt with its pane and clears it at the ending", () => {
    const live = createLiveAttempts();
    live.register("01", 1, { paneId: "pane-1", tabId: "tab-1", startedAt: AT });
    expect(live.isLive("01")).toBe(true);
    expect(live.records()).toEqual({ "01": { attempt: 1, paneId: "pane-1", role: "agent", startedAt: AT } });
    live.clear("01", 1);
    expect(live.isLive("01")).toBe(false);
    expect(live.records()).toEqual({});
  });

  it("carries a headless Attempt with a null pane, so the Ticket reads live without a surface", () => {
    const live = createLiveAttempts();
    live.register("01", 3, { paneId: null, tabId: null, startedAt: AT });
    expect(live.records()).toEqual({ "01": { attempt: 3, paneId: null, role: "agent", startedAt: AT } });
  });

  it("serves the highest-numbered live Attempt of a fan-out and falls back when it ends first", () => {
    const live = createLiveAttempts();
    live.register("01", 4, { paneId: "pane-4", tabId: "tab-4", startedAt: AT });
    live.register("01", 5, { paneId: "pane-5", tabId: "tab-5", startedAt: AT });
    live.register("01", 6, { paneId: "pane-6", tabId: "tab-6", startedAt: AT });
    expect(live.records()["01"]).toEqual({ attempt: 6, paneId: "pane-6", role: "agent", startedAt: AT });
    live.clear("01", 6);
    expect(live.records()["01"]).toEqual({ attempt: 5, paneId: "pane-5", role: "agent", startedAt: AT });
    live.clear("01", 4);
    expect(live.records()["01"]).toEqual({ attempt: 5, paneId: "pane-5", role: "agent", startedAt: AT });
    live.clear("01", 5);
    expect(live.records()).toEqual({});
  });

  it("leaves out the ids the caller excludes, a Conversation's pane riding its own view", () => {
    const live = createLiveAttempts();
    live.register("01", 1, { paneId: "pane-1", tabId: "tab-1", startedAt: AT });
    live.register("conv-1", 1, { paneId: "pane-c", tabId: "tab-c", startedAt: AT });
    expect(live.records((id) => id.startsWith("conv-"))).toEqual({
      "01": { attempt: 1, paneId: "pane-1", role: "agent", startedAt: AT },
    });
    expect(live.isLive("conv-1")).toBe(true);
  });

  it("carries a resolver's role and start, so a done card can say its merge is being resolved", () => {
    const live = createLiveAttempts();
    live.register("02", 3, { paneId: "pane-r", tabId: "tab-r", role: "resolver", startedAt: AT });
    expect(live.records()["02"]).toEqual({
      attempt: 3,
      paneId: "pane-r",
      role: "resolver",
      startedAt: AT,
    });
  });

  it("stamps an Attempt registered without a start with the registration time", () => {
    const live = createLiveAttempts();
    const before = Date.now();
    live.register("01", 1, { paneId: null, tabId: null });
    const startedAt = Date.parse(live.records()["01"].startedAt);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(live.records()["01"].role).toBe("agent");
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
