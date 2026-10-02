import { describe, expect, test } from "bun:test";
import { describeSlow, slowAnswers, type Mark, type WireTrip } from "./timeline.ts";

const mark = (at: number, what: string, ms = 0, detail = ""): Mark => ({ at, what, ms, detail });

describe("slowAnswers", () => {
  const server = [
    mark(1_000.5, "got terminal.focus", 0.3, "4"),
    mark(1_001, "lag", 6.2, "heap -14.0 MB"),
    mark(1_008, "sent reply", 0, "4"),
    mark(2_000.4, "got subscribe", 0.2, "14"),
    mark(2_002.1, "sent card", 0, "14"),
    mark(5_000, "spawn", 30, "git diff"),
  ];
  const herdr = [mark(1_007.5, "herdr got", 0, "pane.focus"), mark(3_000, "herdr lag", 4)];

  test("only the trips at the limit or over, each with the server's own time and what held it", () => {
    const trips: WireTrip[] = [
      { kind: "terminal.focus", id: 4, at: 1_000, ms: 9, idealMs: 8.5 },
      { kind: "subscribe", id: "14", at: 2_000, ms: 2.5, idealMs: 2.4 },
    ];
    const slow = slowAnswers(trips, server, herdr, 5);
    expect(slow).toHaveLength(1);
    expect(slow[0]!.serverMs).toBe(7.5);
    expect(slow[0]!.toHerdrMs).toBe(7);
    expect(slow[0]!.meanwhile.map((m) => m.what)).toEqual(["lag"]);
    expect(describeSlow(slow[0]!)).toBe(
      "terminal.focus 4: 9 ms (proxy timers 0.5 ms); server 7.5 ms; to herdr 7 ms; meanwhile lag 6.2 ms (heap -14.0 MB)",
    );
  });

  test("a trip the server never marked says so, rather than borrow another's", () => {
    const slow = slowAnswers([{ kind: "subscribe", id: "99", at: 5_010, ms: 50, idealMs: 49 }], server, herdr, 45);
    expect(slow[0]!.serverMs).toBeNull();
    expect(slow[0]!.meanwhile.map((m) => m.detail)).toEqual(["git diff"]);
  });
});
