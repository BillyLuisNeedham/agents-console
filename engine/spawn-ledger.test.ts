/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { heldReasonText, renderSpawnLedger } from "./spawn-ledger.ts";

const proposal = (title: string, body = "A body long enough to stand.") => ({ title, body });

describe("the Spawn ledger (issue #150)", () => {
  it("lists every section, saying none rather than leaving one out", () => {
    const text = renderSpawnLedger({ tickets: [], conversations: [], pending: [], held: [] });
    for (const heading of ["## Tickets", "## Conversations", "## Pending spawns", "## Held spawns"]) {
      expect(text).toContain(`${heading}\n\n`);
    }
    expect(text.match(/_\(none\)_/g)).toHaveLength(4);
    expect(text).toContain("Never edit this file.");
  });

  it("names each piece of work by the id an overlaps mark would use", () => {
    const text = renderSpawnLedger({
      tickets: [
        { id: "07", title: "Build the parser", status: "in-progress" },
        { id: "07-spawn-1", title: "07-spawn-1: Fix the lexer", status: "ready" },
      ],
      conversations: [{ id: "conv-1", title: "Plan | the release", status: "waiting" }],
      pending: [
        { id: "proposal-3", parentId: "07", origin: "ticket", proposal: proposal("Docs"), at: "t" },
      ],
      held: [
        {
          id: "proposal-4",
          parentId: "conv-1",
          origin: "conversation",
          proposal: { ...proposal("Talk it over"), kind: "conversation", overlaps: ["07", "proposal-3"] },
          reason: "overlaps",
          at: "t",
        },
      ],
    });
    expect(text).toContain("| 07 | in-progress | Build the parser |");
    expect(text).toContain("| 07-spawn-1 | ready | Fix the lexer |");
    expect(text).toContain("| conv-1 | waiting | Plan \\| the release |");
    expect(text).toContain("| proposal-3 | 07 | ticket | Docs | A body long enough to stand. |");
    expect(text).toContain(
      "| proposal-4 | conv-1 | conversation | overlaps 07, proposal-3 | Talk it over |",
    );
  });

  it("keeps a proposal's summary to one short line", () => {
    const body = `First line\nsecond line ${"x".repeat(300)}`;
    const text = renderSpawnLedger({
      tickets: [],
      conversations: [],
      pending: [{ id: "proposal-1", parentId: "01", origin: "ticket", proposal: proposal("Long", body), at: "t" }],
      held: [],
    });
    const row = text.split("\n").find((line) => line.startsWith("| proposal-1"))!;
    expect(row).toContain("First line second line");
    expect(row).toContain("…");
    expect(row.length).toBeLessThan(220);
  });

  it("words each hold reason the way the Console does", () => {
    expect(heldReasonText("per-attempt")).toBe("per-attempt cap");
    expect(heldReasonText("per-run")).toBe("per-run cap");
    expect(heldReasonText("overlaps", ["02"])).toBe("overlaps 02");
    expect(heldReasonText("operator")).toBe("held by operator");
  });
});
