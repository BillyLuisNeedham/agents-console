/**
 * The Jev grader's Evidence builder (ADR-0023, REPORT.md section 2): a pure
 * function from strings to the named Evidence object and its notes, so these
 * cases need no git and no files on disk. What is pinned here is the trimming
 * the Grade's `evidenceBudget` later points at.
 */

import { describe, expect, it } from "bun:test";
import {
  buildEvidence,
  DIFF_FLOOR_CHARS,
  dropGeneratedDiffs,
  EVIDENCE_CAP_CHARS,
  stripAnsi,
  tailToLineBoundary,
} from "./jev-evidence.ts";

const base = {
  ticket: "# ticket\n\nDo the thing.",
  summary: "I did the thing and all tests pass.",
  diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
  diffReason: null,
  log: "ran the tests\nall good\n",
};

describe("stripAnsi", () => {
  it("removes CSI colour, erase and OSC sequences", () => {
    const raw = "\u001b[31mred\u001b[0m\n\u001b[2Kcleared\n\u001b]0;title\u0007text\n";
    expect(stripAnsi(raw)).toBe("red\ncleared\ntext\n");
  });
});

describe("tailToLineBoundary", () => {
  it("keeps the whole text under the budget", () => {
    expect(tailToLineBoundary("a\nb\n", 100)).toBe("a\nb\n");
  });

  it("keeps the last N characters, cut forward to a line start", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
    const text = lines.join("\n") + "\n";
    const tail = tailToLineBoundary(text, 500);
    expect(tail.length).toBeLessThanOrEqual(500);
    // Every line in the tail is whole: the partial first line was dropped.
    expect(tail.startsWith("line ")).toBe(true);
    expect(tail.split("\n").every((line) => line === "" || line.startsWith("line "))).toBe(true);
  });
});

describe("dropGeneratedDiffs", () => {
  const diff =
    "diff --git a/bun.lock b/bun.lock\n" +
    "--- a/bun.lock\n" +
    "+++ b/bun.lock\n" +
    "@@ -1 +1 @@\n" +
    "-old\n" +
    "+new\n" +
    "diff --git a/src/app.ts b/src/app.ts\n" +
    "--- a/src/app.ts\n" +
    "+++ b/src/app.ts\n" +
    "@@ -1 +1 @@\n" +
    "-before\n" +
    "+after\n";

  it("drops lockfiles whole and keeps the source hunks", () => {
    const kept = dropGeneratedDiffs(diff);
    expect(kept).toContain("src/app.ts");
    expect(kept).not.toContain("bun.lock");
  });

  it("drops snapshot files and generated output too", () => {
    const snapshots =
      "diff --git a/src/__snapshots__/x.snap b/src/__snapshots__/x.snap\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/dist/bundle.min.js b/dist/bundle.min.js\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/src/code.ts b/src/code.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const kept = dropGeneratedDiffs(snapshots);
    expect(kept).toContain("src/code.ts");
    expect(kept).not.toContain("__snapshots__");
    expect(kept).not.toContain("bundle.min.js");
  });
});

describe("buildEvidence", () => {
  it("names the claim field and carries the ticket, summary and diff", () => {
    const built = buildEvidence(base);
    expect(built.evidence.ticket).toBe(base.ticket);
    expect(built.evidence.agent_summary_claim).toBe(base.summary);
    expect(built.evidence.diff).toContain("src/app.ts");
    expect(built.diffNote).toBe("changed lines only, no context lines");
    expect(built.logNote).toBe("the whole log");
    expect(built.trimmed).toBe(false);
  });

  it("strips ANSI from the log before it is measured or sent", () => {
    const built = buildEvidence({ ...base, log: "\u001b[31mboom\u001b[0m\n" });
    expect(built.evidence.log).toBe("boom\n");
    expect(built.logNote).toBe("the whole log");
  });

  it("keeps the last 20,000 characters of a large log, at a line boundary", () => {
    const line = `${"y".repeat(49)}\n`;
    const raw = "HEADER\n" + line.repeat(700);
    const built = buildEvidence({ ...base, log: raw });
    const log = String(built.evidence.log);
    expect(log.length).toBeLessThanOrEqual(20_000);
    expect(log.startsWith("y")).toBe(true);
    expect(log).not.toContain("HEADER");
    expect(built.logTrimmed).toBe(true);
    expect(built.trimmed).toBe(true);
    expect(built.logNote).toBe(
      `the log was trimmed to its last ${log.length} characters of ${raw.length}`,
    );
  });

  it("says why when there is no diff, and treats that as untrimmed", () => {
    const built = buildEvidence({
      ...base,
      diff: "",
      diffReason: "no attempt branch pool/x/01.attempt-1",
    });
    expect(built.evidence.diff).toBe("");
    expect(built.diffNote).toBe("no diff: no attempt branch pool/x/01.attempt-1");
    expect(built.diffTrimmed).toBe(false);
  });

  it("caps the stringified Evidence at 100,000 characters and never cuts the diff below the floor", () => {
    const built = buildEvidence({
      ticket: "t".repeat(20_000),
      summary: "s".repeat(4_000),
      diff: "d".repeat(300_000),
      diffReason: null,
      // A log that cannot shrink enough to matter: the diff does the work.
      log: "l".repeat(200_000),
    });
    expect(JSON.stringify(built.evidence).length).toBeLessThanOrEqual(EVIDENCE_CAP_CHARS);
    expect(String(built.evidence.diff).length).toBeGreaterThanOrEqual(DIFF_FLOOR_CHARS);
    expect(built.diffTrimmed).toBe(true);
    expect(built.diffNote).toContain("the diff was cut after its first");
    expect(built.trimmed).toBe(true);
  });

  it("stays under the cap with a ticket at its ceiling and a huge log", () => {
    // A ticket at its own 20,000 ceiling plus a base log tail: the whole
    // object must stay under the cap, and any shrink respects the 4,000 floor.
    const built = buildEvidence({
      ticket: "t".repeat(20_000),
      summary: "s".repeat(4_000),
      diff: "",
      diffReason: "the pool does not run in git",
      log: "z".repeat(300_000),
    });
    expect(JSON.stringify(built.evidence).length).toBeLessThanOrEqual(EVIDENCE_CAP_CHARS);
    expect(String(built.evidence.log).length).toBeGreaterThanOrEqual(4_000);
    expect(built.logNote).toContain("the log was trimmed to its last");
  });

  it("takes the wider log tail on the widening budget", () => {
    const raw = "w".repeat(50_000) + "\n";
    const baseBuilt = buildEvidence({ ...base, log: raw });
    const wideBuilt = buildEvidence({ ...base, log: raw, widened: true });
    expect(String(baseBuilt.evidence.log).length).toBeLessThanOrEqual(20_000);
    expect(String(wideBuilt.evidence.log).length).toBeGreaterThan(20_000);
    // The note names the diff the widening budget actually carries: the base
    // budget is `-U0` changed lines, the widened one has context lines.
    expect(baseBuilt.diffNote).toBe("changed lines only, no context lines");
    expect(wideBuilt.diffNote).toBe("the full diff, with context lines");
    expect(wideBuilt.evidence.diff_note).toBe("the full diff, with context lines");
  });
});
