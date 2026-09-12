/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  edgePath,
  flowNeighbourhood,
  layoutStorageKey,
  mergeLayout,
  parseStoredLayout,
  strokeWidthForZoom,
  zoomAtCursor,
  type TopologyEdge,
} from "./geometry";

describe("layoutStorageKey", () => {
  it("keys stored positions by the card id alone (one pool per server)", () => {
    expect(layoutStorageKey("ticket:01")).toBe("ticket:01");
    expect(layoutStorageKey("START")).toBe("START");
  });
});

describe("mergeLayout", () => {
  const defaults = {
    "ticket:A": { x: 100, y: 200 },
    "ticket:B": { x: 300, y: 400 },
  };

  it("overrides defaults with stored positions and drops unknown ids", () => {
    expect(
      mergeLayout(defaults, { "ticket:A": { x: 1, y: 2 }, leftover: { x: 3, y: 4 } }),
    ).toEqual({
      "ticket:A": { x: 1, y: 2 },
      "ticket:B": { x: 300, y: 400 },
    });
  });

  it("returns defaults when nothing is stored", () => {
    expect(mergeLayout(defaults, {})).toEqual(defaults);
  });
});

describe("parseStoredLayout", () => {
  it("keeps finite x/y pairs and drops anything else", () => {
    expect(
      parseStoredLayout({
        "ticket:A": { x: 10, y: 20 },
        "ticket:B": { x: "no", y: 1 },
        START: { x: 1 },
      }),
    ).toEqual({ "ticket:A": { x: 10, y: 20 } });
  });

  it("returns empty for non-objects", () => {
    expect(parseStoredLayout(null)).toEqual({});
    expect(parseStoredLayout("nope")).toEqual({});
    expect(parseStoredLayout([{ x: 1, y: 2 }])).toEqual({});
  });
});

describe("edgePath", () => {
  const source = { x: 300, y: 196, w: 280, h: 80 };
  const target = { x: 300, y: 376, w: 280, h: 80 };

  it("routes downward elbows through a mid-Y horizontal", () => {
    expect(edgePath(source, target, "ortho")).toEqual({
      d: "M 440 276 L 440 326 L 440 326 L 440 376",
      lx: 446,
      ly: 326,
    });
  });

  it("draws a straight segment between the facing edges", () => {
    expect(edgePath(source, target, "straight")).toEqual({
      d: "M 440 276 L 440 376",
      lx: 446,
      ly: 326,
    });
  });

  it("leaves the top of the source when the target sits above", () => {
    expect(edgePath(target, source, "ortho").d).toBe(
      "M 440 376 L 440 326 L 440 326 L 440 276",
    );
  });
});

describe("zoomAtCursor", () => {
  it("keeps the world point under the cursor stationary", () => {
    expect(zoomAtCursor({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 100 }, 2)).toEqual({
      x: -100,
      y: -100,
      zoom: 2,
    });
  });

  it("clamps at the zoom ceiling and does not shift the view", () => {
    expect(zoomAtCursor({ x: 8, y: 8, zoom: 2.5 }, { x: 40, y: 40 }, 2)).toEqual({
      x: 8,
      y: 8,
      zoom: 2.5,
    });
  });
});

describe("strokeWidthForZoom", () => {
  it("keeps a 1.5px stroke visually constant", () => {
    expect(strokeWidthForZoom(2)).toBe(0.75);
    expect(strokeWidthForZoom(0.5)).toBe(3);
  });
});

describe("flowNeighbourhood", () => {
  // The edge shape of a three-ticket chain, as the pool projection emits it:
  // start into the blockerless ticket, blocked-by edges, and review out of
  // every ticket.
  const edges: TopologyEdge[] = [
    { source: "START", target: "ticket:A" },
    { source: "ticket:A", target: "REVIEW" },
    { source: "ticket:A", target: "ticket:B" },
    { source: "ticket:B", target: "REVIEW" },
    { source: "ticket:B", target: "ticket:C" },
    { source: "ticket:C", target: "REVIEW" },
  ];

  it("returns the one-hop inflow and outflow of the selection", () => {
    expect(flowNeighbourhood(edges, "ticket:B")).toEqual({
      inflow: ["ticket:A"],
      outflow: ["REVIEW", "ticket:C"],
    });
  });

  it("is one hop only: no transitive dependency cone", () => {
    const hood = flowNeighbourhood(edges, "ticket:C");
    expect(hood.inflow).toEqual(["ticket:B"]);
    expect(hood.inflow).not.toContain("ticket:A");
    expect(hood.inflow).not.toContain("START");
  });

  it("lets start flow into a blockerless ticket and review out of every ticket", () => {
    const hood = flowNeighbourhood(edges, "ticket:A");
    expect(hood.inflow).toEqual(["START"]);
    expect(hood.outflow).toEqual(["REVIEW", "ticket:B"]);
  });

  it("lights the utility cards' own neighbourhoods", () => {
    expect(flowNeighbourhood(edges, "START")).toEqual({
      inflow: [],
      outflow: ["ticket:A"],
    });
    expect(flowNeighbourhood(edges, "REVIEW")).toEqual({
      inflow: ["ticket:A", "ticket:B", "ticket:C"],
      outflow: [],
    });
  });

  it("is empty for a cleared selection or an unknown card", () => {
    expect(flowNeighbourhood(edges, null)).toEqual({ inflow: [], outflow: [] });
    expect(flowNeighbourhood(edges, "ticket:zzz")).toEqual({ inflow: [], outflow: [] });
  });
});
