/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { CopyTone, LiveCopy } from "./line-projection";
import { copyRoom, copyRow, fitSummary } from "./plan-live";

const copy = (i: number, tone: CopyTone, selected = false): LiveCopy => ({
  id: `build-1.${i}`,
  card: `ticket:build-1.${i}`,
  tone,
  selected,
});

const copies = (n: number, tone: CopyTone = "running"): LiveCopy[] =>
  Array.from({ length: n }, (_, i) => copy(i + 1, tone));

const ids = (list: readonly LiveCopy[]) => list.map((c) => c.id);

describe("copyRoom", () => {
  it("fits fourteen dots on a row with no hold, and fewer beside one", () => {
    expect(copyRoom(null)).toBe(14);
    expect(copyRoom({ id: "implement-1" })).toBeLessThan(14);
    expect(copyRoom({ id: "implement-1" })).toBeGreaterThan(copyRoom({ id: "a-hold-id-too-long-to-show-whole-on-a-card" }));
  });
});

describe("fitSummary", () => {
  it("keeps the pass number while the whole summary fits", () => {
    expect(fitSummary(["pass 2 · 2 running · 3 queued", "2 running · 3 queued"])).toBe("pass 2 · 2 running · 3 queued");
  });

  it("drops the pass number from a summary too long for the card", () => {
    expect(fitSummary(["pass 1 · 31 running · 3 queued", "31 running · 3 queued"])).toBe("31 running · 3 queued");
  });

  it("falls back to the shortest wording when none fits", () => {
    expect(fitSummary(["pass 12 · 1234567 running · 1234567 queued", "1234567 running · 1234567 queued"])).toBe(
      "1234567 running · 1234567 queued",
    );
  });
});

describe("copyRow", () => {
  it("draws every copy and every queued dot when they fit", () => {
    const all = [copy(1, "done"), copy(2, "running"), copy(3, "pending")];
    expect(copyRow(all, 3, 14)).toEqual({ dots: all, done: 0, queued: 3, more: null });
  });

  it("folds the done copies into a count when the row is full, and keeps the active ones whole", () => {
    const all = [...copies(11, "done"), ...copies(4).map((c, i) => ({ ...c, id: `r${i}`, card: `ticket:r${i}` }))];
    const row = copyRow(all, 0, 14);
    expect(row.done).toBe(11);
    expect(ids(row.dots)).toEqual(["r0", "r1", "r2", "r3"]);
    expect(row.more).toBeNull();
  });

  it("drops the queued dots that do not fit beside the pill and the active copies", () => {
    const all = [...copies(6, "done"), ...copies(8).map((c, i) => ({ ...c, id: `r${i}` }))];
    const row = copyRow(all, 5, 14);
    expect(row.done).toBe(6);
    expect(row.dots).toHaveLength(8);
    expect(row.queued).toBe(14 - 2 - 8);
    expect(row.more).toBeNull();
  });

  it("keeps the checkpoint and the selected copy of 64 running ones in view", () => {
    const all = copies(64);
    all[58] = copy(59, "checkpoint");
    all[40] = copy(41, "running", true);
    const row = copyRow(all, 0, 14);
    expect(ids(row.dots)).toContain("build-1.59");
    expect(ids(row.dots)).toContain("build-1.41");
    expect(row.dots.length + row.more!.count).toBe(64);
    expect(ids(row.dots)).toEqual([...ids(row.dots)].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1])));
    expect(row.more!.next.id).toBe("build-1.42");
  });

  it("opens the first hidden copy when nothing is selected, and wraps past the last", () => {
    const all = copies(64);
    const row = copyRow(all, 0, 14);
    expect(row.more!.next.id).toBe(ids(all).find((id) => !ids(row.dots).includes(id))!);
    all[63] = copy(64, "running", true);
    expect(copyRow(all, 0, 14).more!.next.id).toBe("build-1.11");
  });

  it("walks every hidden active copy when the button is tapped from each selection in turn", () => {
    const base = [...copies(20, "done"), ...copies(44).map((c, i) => ({ ...c, id: `r${i}`, card: `ticket:r${i}` }))];
    base[50] = { ...base[50]!, tone: "checkpoint" };
    const reached = new Set<string>();
    let selected: string | null = null;
    for (let tap = 0; tap < 80; tap++) {
      const view = base.map((c) => ({ ...c, selected: c.id === selected }));
      const row = copyRow(view, 0, 14);
      for (const dot of row.dots) reached.add(dot.id);
      if (!row.more) break;
      selected = row.more.next.id;
      reached.add(selected);
    }
    expect([...reached].sort()).toEqual(base.filter((c) => c.tone !== "done").map((c) => c.id).sort());
  });
});
