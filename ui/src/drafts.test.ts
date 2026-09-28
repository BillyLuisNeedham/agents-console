/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { DraftAnswers } from "./drafts";

describe("DraftAnswers (issue #147)", () => {
  it("holds a draft per ticket id", () => {
    const drafts = new DraftAnswers();
    drafts.set("01", "clean the worktree first");
    drafts.set("02", "skip the flaky test");
    expect(drafts.get("01")).toBe("clean the worktree first");
    expect(drafts.get("02")).toBe("skip the flaky test");
  });

  it("starts empty for a ticket with no draft", () => {
    expect(new DraftAnswers().get("01")).toBe("");
  });

  it("prunes drafts whose interrupt resolved, keeping the still-pending ones", () => {
    const drafts = new DraftAnswers();
    drafts.set("01", "clean the worktree first");
    drafts.set("02", "skip the flaky test");
    drafts.prune(new Set(["02"]));
    expect(drafts.get("01")).toBe("");
    expect(drafts.get("02")).toBe("skip the flaky test");
  });

  it("prunes nothing when every draft's interrupt is still pending", () => {
    const drafts = new DraftAnswers();
    drafts.set("01", "clean the worktree first");
    drafts.set("02", "skip the flaky test");
    drafts.prune(new Set(["01", "02", "03"]));
    expect(drafts.get("01")).toBe("clean the worktree first");
    expect(drafts.get("02")).toBe("skip the flaky test");
  });
});
