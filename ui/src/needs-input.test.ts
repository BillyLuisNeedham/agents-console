/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { NeedsInputTray } from "./needs-input";

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
