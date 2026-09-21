import { describe, expect, it } from "bun:test";
import { createPaneReadRegister } from "./pane-reads.ts";

describe("pane read register (issue #122)", () => {
  it("serves the latest recorded read per pane and nothing for a pane never recorded", () => {
    const reads = createPaneReadRegister();
    expect(reads.latest("pane-1")).toBeNull();

    reads.record("pane-1", "first frame", "2026-09-21T10:00:00.000Z");
    expect(reads.latest("pane-1")).toEqual({ text: "first frame", at: "2026-09-21T10:00:00.000Z" });

    // A later read replaces the earlier one whole: the Peek shows the
    // viewport as it was last seen, never a history of it.
    reads.record("pane-1", "second frame", "2026-09-21T10:00:02.000Z");
    expect(reads.latest("pane-1")).toEqual({ text: "second frame", at: "2026-09-21T10:00:02.000Z" });
    // Panes are independent.
    expect(reads.latest("pane-2")).toBeNull();
  });

  it("forgets a pane on request, and forgetting one never recorded is a no-op", () => {
    const reads = createPaneReadRegister();
    reads.record("pane-1", "frame", "2026-09-21T10:00:00.000Z");
    reads.record("pane-2", "other", "2026-09-21T10:00:00.000Z");

    reads.forget("pane-1");
    expect(reads.latest("pane-1")).toBeNull();
    expect(reads.latest("pane-2")).not.toBeNull();

    expect(() => reads.forget("pane-never")).not.toThrow();
  });
});
