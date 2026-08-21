/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  clampDrawersHeight,
  DRAWER_MAX_VH,
  DRAWER_MIN_VH,
  edgePath,
  interruptForm,
  isTicketCardId,
  layoutStorageKey,
  mergeLayout,
  nextNodeSelection,
  parseStoredLayout,
  phaseLabel,
  projectDetail,
  projectLog,
  projectPool,
  projectPoolEdges,
  REVIEW_CARD_ID,
  START_CARD_ID,
  strokeWidthForZoom,
  ticketCardId,
  ticketDepth,
  zoomAtCursor,
  type PoolSnapshot,
  type PoolStatus,
  type PoolTicketState,
} from "./project";

function ticket(
  id: string,
  overrides: Partial<PoolTicketState> = {},
): PoolTicketState {
  return {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready",
    ...overrides,
  };
}

function snapshot(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    seq: 0,
    phase: "running",
    state: {
      tickets: [],
      log: [],
      outcomes: {},
      interrupts: [],
      config: {},
    },
    ...overrides,
  };
}

describe("ticketCardId / isTicketCardId / layoutStorageKey", () => {
  it("prefixes ticket ids and leaves utility ids alone", () => {
    expect(ticketCardId("01")).toBe("ticket:01");
    expect(isTicketCardId("ticket:01")).toBe(true);
    expect(isTicketCardId(START_CARD_ID)).toBe(false);
    expect(isTicketCardId(REVIEW_CARD_ID)).toBe(false);
  });

  it("keys stored positions by the card id alone (one pool per server)", () => {
    expect(layoutStorageKey("ticket:01")).toBe("ticket:01");
    expect(layoutStorageKey(START_CARD_ID)).toBe(START_CARD_ID);
  });
});

describe("ticketDepth", () => {
  const tickets = [
    ticket("A"),
    ticket("B", { blockedBy: ["A"] }),
    ticket("C", { blockedBy: ["B"] }),
    ticket("D", { blockedBy: ["A", "C"] }),
  ];

  it("is 0 for a leaf and grows with the longest blocker chain", () => {
    expect(ticketDepth("A", tickets)).toBe(0);
    expect(ticketDepth("B", tickets)).toBe(1);
    expect(ticketDepth("C", tickets)).toBe(2);
    expect(ticketDepth("D", tickets)).toBe(3);
  });

  it("returns 0 for an unknown ticket", () => {
    expect(ticketDepth("zzz", tickets)).toBe(0);
  });
});

describe("projectPoolEdges", () => {
  it("draws start, blocked-by, and review edges for a small pool", () => {
    const tickets = [
      ticket("A"),
      ticket("B", { blockedBy: ["A"] }),
      ticket("C", { blockedBy: ["B"] }),
    ];
    const edges = projectPoolEdges(tickets);
    expect(edges).toEqual([
      { source: START_CARD_ID, target: "ticket:A" },
      { source: "ticket:A", target: REVIEW_CARD_ID },
      { source: "ticket:A", target: "ticket:B" },
      { source: "ticket:B", target: REVIEW_CARD_ID },
      { source: "ticket:B", target: "ticket:C" },
      { source: "ticket:C", target: REVIEW_CARD_ID },
    ]);
  });

  it("starts every blockerless ticket and links every blocked-by edge", () => {
    const tickets = [
      ticket("A"),
      ticket("B"),
      ticket("C", { blockedBy: ["A", "B"] }),
    ];
    const edges = projectPoolEdges(tickets);
    const starts = edges.filter((e) => e.source === START_CARD_ID);
    expect(starts.map((e) => e.target).sort()).toEqual(["ticket:A", "ticket:B"]);
    expect(edges).toContainEqual({ source: "ticket:A", target: "ticket:C" });
    expect(edges).toContainEqual({ source: "ticket:B", target: "ticket:C" });
  });
});

describe("projectPool", () => {
  it("renders start, each ticket, and review as cards with statuses and edges", () => {
    const snap = snapshot({
      seq: 3,
      phase: "quiescent",
      state: {
        tickets: [
          ticket("A", { status: "done" }),
          ticket("B", { status: "in-progress", blockedBy: ["A"] }),
          ticket("C", { status: "checkpoint", blockedBy: ["B"] }),
          ticket("D", { status: "ready", blockedBy: ["B"] }),
        ],
        log: ["super-step 1: A"],
        outcomes: { A: { summary: "done A", commitSha: "abc" } },
        interrupts: [{ ticketId: "C", kind: "checkpoint", body: "brief" }],
        config: {},
      },
    });
    const view = projectPool(snap);
    expect(view.seq).toBe(3);
    expect(view.phase).toBe("quiescent");
    expect(view.cards.map((c) => c.id)).toEqual([
      START_CARD_ID,
      "ticket:A",
      "ticket:B",
      "ticket:C",
      "ticket:D",
      REVIEW_CARD_ID,
    ]);
    const a = view.cards.find((c) => c.id === "ticket:A");
    expect(a && a.kind === "ticket" ? a.status : null).toBe("done");
    const b = view.cards.find((c) => c.id === "ticket:B");
    expect(b && b.kind === "ticket" ? b.status : null).toBe("in-progress");
    const c = view.cards.find((c) => c.id === "ticket:C");
    expect(c && c.kind === "ticket" ? c.status : null).toBe("checkpoint");
    expect(c && c.kind === "ticket" ? c.interrupt?.kind : null).toBe("checkpoint");
    const d = view.cards.find((c) => c.id === "ticket:D");
    expect(d && d.kind === "ticket" ? d.status : null).toBe("ready");
    expect(view.log).toEqual(["super-step 1: A"]);
  });

  it("attaches the outcome to a done ticket", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A", { status: "done" })],
        outcomes: { A: { summary: "did the thing", commitSha: "sha1" } },
        interrupts: [],
        log: [],
        config: {},
      },
    });
    const view = projectPool(snap);
    const a = view.cards.find((c) => c.id === "ticket:A");
    expect(a && a.kind === "ticket" ? a.outcome : null).toEqual({
      summary: "did the thing",
      commitSha: "sha1",
    });
  });

  it("stays empty for an empty pool", () => {
    const view = projectPool(snapshot());
    expect(view.cards.map((c) => c.id)).toEqual([START_CARD_ID, REVIEW_CARD_ID]);
    expect(view.edges).toEqual([]);
  });
});

const INTERRUPT_KINDS = [
  "checkpoint",
  "crash",
  "deadlock",
  "merge-conflict",
  "merge-approval",
  "review",
];

describe("interruptForm", () => {
  it("gives all six interrupt kinds a renderable, answerable form", () => {
    for (const kind of INTERRUPT_KINDS) {
      const form = interruptForm({ ticketId: "A", kind, body: "body" });
      expect(form.title.length).toBeGreaterThan(0);
      expect(form.actions.length).toBeGreaterThan(0);
    }
  });

  it("resumes the human-decision kinds and gates the approval kinds", () => {
    const actions = (kind: string) =>
      interruptForm({ ticketId: "A", kind, body: "" }).actions.map((a) => a.action);
    expect(actions("checkpoint")).toEqual(["resume"]);
    expect(actions("crash")).toEqual(["resume"]);
    expect(actions("deadlock")).toEqual(["resume"]);
    expect(actions("merge-conflict")).toEqual(["resume"]);
    expect(actions("merge-approval")).toEqual(["approve", "reject"]);
    expect(actions("review")).toEqual(["approve", "reject"]);
  });

  it("titles each kind for the card and Detail", () => {
    const titles = Object.fromEntries(
      INTERRUPT_KINDS.map((kind) => [
        kind,
        interruptForm({ ticketId: "A", kind, body: "" }).title,
      ]),
    );
    expect(titles).toEqual({
      checkpoint: "checkpoint",
      crash: "harness crash",
      deadlock: "deadlock",
      "merge-conflict": "merge conflict",
      "merge-approval": "merge approval",
      review: "review",
    });
  });

  it("falls back to a resume form for an unknown kind", () => {
    const form = interruptForm({ ticketId: "A", kind: "future-kind", body: "" });
    expect(form.title).toBe("future-kind");
    expect(form.actions.map((a) => a.action)).toEqual(["resume"]);
  });
});

describe("interrupt projection", () => {
  function interruptSnapshot(): PoolSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: INTERRUPT_KINDS.map((kind) => ticket(`T-${kind}`)),
        log: [],
        outcomes: {},
        interrupts: INTERRUPT_KINDS.map((kind) => ({
          ticketId: `T-${kind}`,
          kind,
          body: `${kind} body`,
        })),
        config: {},
      },
    });
  }

  it("carries each interrupt kind onto its card with a form", () => {
    const view = projectPool(interruptSnapshot());
    for (const kind of INTERRUPT_KINDS) {
      const card = view.cards.find((c) => c.id === ticketCardId(`T-${kind}`));
      expect(card?.kind).toBe("ticket");
      if (card?.kind === "ticket") {
        expect(card.interrupt?.kind).toBe(kind);
        expect(card.interrupt?.body).toBe(`${kind} body`);
        expect(card.interrupt?.form.title.length).toBeGreaterThan(0);
        expect(card.interrupt?.form.actions.length).toBeGreaterThan(0);
      }
    }
  });

  it("carries the same interrupt and form into the Detail", () => {
    const snap = interruptSnapshot();
    for (const kind of INTERRUPT_KINDS) {
      const detail = projectDetail(snap, ticketCardId(`T-${kind}`));
      expect(detail?.kind).toBe("ticket");
      if (detail?.kind === "ticket") {
        expect(detail.interrupt?.kind).toBe(kind);
        expect(detail.interrupt?.form).toEqual(
          interruptForm({ ticketId: `T-${kind}`, kind, body: `${kind} body` }),
        );
      }
    }
  });

  it("keeps an interrupt visible on a done ticket (a pending merge)", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A", { status: "done" })],
        log: [],
        outcomes: {},
        interrupts: [{ ticketId: "A", kind: "merge-approval", body: "resolution" }],
        config: {},
      },
    });
    const card = projectPool(snap).cards.find((c) => c.id === "ticket:A");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.status).toBe("done");
      expect(card.interrupt?.form.actions.map((a) => a.action)).toEqual([
        "approve",
        "reject",
      ]);
    }
  });
});

describe("review projection", () => {
  function reviewSnapshot(): PoolSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "done" }), ticket("B", { status: "done" })],
        log: [],
        outcomes: {
          A: { summary: "did A", commitSha: "sha-a" },
          B: { summary: "did B", commitSha: "sha-b" },
        },
        interrupts: [
          {
            ticketId: REVIEW_CARD_ID,
            kind: "review",
            body: "every ticket is done.\n- A: did A\n- B: did B",
          },
        ],
        config: {},
      },
    });
  }

  it("hangs the review interrupt on the review utility card with its form", () => {
    const view = projectPool(reviewSnapshot());
    const card = view.cards.find((c) => c.id === REVIEW_CARD_ID);
    expect(card?.kind).toBe("utility");
    if (card?.kind === "utility") {
      expect(card.interrupt?.kind).toBe("review");
      expect(card.interrupt?.body).toContain("every ticket is done");
      expect(card.interrupt?.form.title).toBe("review");
      expect(card.interrupt?.form.actions.map((a) => a.action)).toEqual([
        "approve",
        "reject",
      ]);
    }
    const start = view.cards.find((c) => c.id === START_CARD_ID);
    expect(start?.kind === "utility" ? start.interrupt : "x").toBeNull();
    const a = view.cards.find((c) => c.id === "ticket:A");
    expect(a?.kind === "ticket" ? a.interrupt : "x").toBeNull();
  });

  it("carries the review interrupt into the review card's Detail", () => {
    const detail = projectDetail(reviewSnapshot(), REVIEW_CARD_ID);
    expect(detail?.kind).toBe("utility");
    if (detail?.kind === "utility") {
      expect(detail.label).toBe("review");
      expect(detail.interrupt?.kind).toBe("review");
      expect(detail.interrupt?.form.actions.map((a) => a.action)).toEqual([
        "approve",
        "reject",
      ]);
    }
  });

  it("tells the reviewer a reject note names the tickets to send back", () => {
    const form = interruptForm({ ticketId: REVIEW_CARD_ID, kind: "review", body: "" });
    expect(form.notePlaceholder).toContain("name the tickets");
  });
});

describe("projectDetail", () => {
  it("projects a ticket's status, blockers, outcome and interrupt", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A", { status: "checkpoint", blockedBy: ["X"] })],
        outcomes: {},
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "the brief" }],
        log: [],
        config: {},
      },
    });
    const detail = projectDetail(snap, "ticket:A");
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.status).toBe("checkpoint");
      expect(detail.blockedBy).toEqual(["X"]);
      expect(detail.interrupt?.body).toBe("the brief");
    }
  });

  it("projects a utility card", () => {
    const detail = projectDetail(snapshot(), START_CARD_ID);
    expect(detail).toEqual({
      kind: "utility",
      id: START_CARD_ID,
      label: "start",
      interrupt: null,
    });
  });

  it("returns null for a card not in the pool", () => {
    expect(projectDetail(snapshot(), "ticket:zzz")).toBeNull();
  });
});

describe("phaseLabel", () => {
  it("labels the phases", () => {
    expect(phaseLabel("running")).toBe("running");
    expect(phaseLabel("quiescent")).toBe("waiting on you");
    expect(phaseLabel("done")).toBe("done");
    expect(phaseLabel("stalled")).toBe("stalled");
  });
});

describe("projectLog", () => {
  it("extracts string log lines and drops the rest", () => {
    expect(projectLog({ log: ["a", 42, "b"] })).toEqual(["a", "b"]);
  });

  it("is empty without a log", () => {
    expect(projectLog({})).toEqual([]);
    expect(projectLog(null)).toEqual([]);
  });
});

describe("layout", () => {
  it("places leaves above their dependents and review at the bottom", () => {
    const tickets = [ticket("A"), ticket("B", { blockedBy: ["A"] })];
    const view = projectPool(snapshot({ state: { tickets, log: [], outcomes: {}, interrupts: [], config: {} } }));
    const pos = (id: string) => view.cards.find((c) => c.id === id);
    expect(pos("ticket:A")?.y).toBeLessThan(pos("ticket:B")?.y ?? 0);
    expect(pos("ticket:B")?.y).toBeLessThan(pos(REVIEW_CARD_ID)?.y ?? 0);
    expect(pos(START_CARD_ID)?.y).toBeLessThan(pos("ticket:A")?.y ?? 0);
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

describe("clampDrawersHeight", () => {
  it("clamps below the minimum and above the maximum", () => {
    expect(clampDrawersHeight(0)).toBe(DRAWER_MIN_VH);
    expect(clampDrawersHeight(100)).toBe(DRAWER_MAX_VH);
  });

  it("passes values inside the range through unchanged", () => {
    expect(clampDrawersHeight(32)).toBe(32);
  });
});

describe("nextNodeSelection", () => {
  it("selects, swaps, and clears", () => {
    expect(nextNodeSelection(null, "ticket:A")).toBe("ticket:A");
    expect(nextNodeSelection("ticket:A", "ticket:B")).toBe("ticket:B");
    expect(nextNodeSelection("ticket:A", "ticket:A")).toBeNull();
  });

  it("treats ticket and utility cards alike", () => {
    expect(nextNodeSelection(null, START_CARD_ID)).toBe(START_CARD_ID);
    expect(nextNodeSelection("ticket:A", REVIEW_CARD_ID)).toBe(REVIEW_CARD_ID);
    expect(nextNodeSelection(START_CARD_ID, START_CARD_ID)).toBeNull();
  });
});

describe("a card click opens the Detail", () => {
  function flightSnapshot(): PoolSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: [
          ticket("R", { status: "ready" }),
          ticket("P", { status: "in-progress", blockedBy: ["R"] }),
          ticket("C", { status: "checkpoint", blockedBy: ["P"] }),
          ticket("D", { status: "done", blockedBy: ["P"] }),
        ],
        log: [],
        outcomes: {},
        interrupts: [{ ticketId: "C", kind: "checkpoint", body: "the brief" }],
        config: {},
      },
    });
  }

  it("opens a ticket Detail for a card of any status", () => {
    const snap = flightSnapshot();
    const cases: [string, PoolStatus][] = [
      ["R", "ready"],
      ["P", "in-progress"],
      ["C", "checkpoint"],
      ["D", "done"],
    ];
    for (const [id, status] of cases) {
      const selected = nextNodeSelection(null, ticketCardId(id));
      const detail = selected ? projectDetail(snap, selected) : null;
      expect(detail?.kind).toBe("ticket");
      if (detail?.kind === "ticket") expect(detail.status).toBe(status);
    }
  });

  it("keeps a pending interrupt answerable from the Detail's form", () => {
    const detail = projectDetail(flightSnapshot(), ticketCardId("C"));
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.interrupt?.body).toBe("the brief");
      expect(detail.interrupt?.form.actions.map((a) => a.action)).toEqual(["resume"]);
    }
  });

  it("keeps the Detail across a snapshot that changes the card's status", () => {
    const selected = nextNodeSelection(null, ticketCardId("P"));
    const next = snapshot({
      state: {
        tickets: [ticket("P", { status: "done" })],
        log: [],
        outcomes: { P: { summary: "did P", commitSha: "sha-p" } },
        interrupts: [],
        config: {},
      },
    });
    const detail = selected ? projectDetail(next, selected) : null;
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.status).toBe("done");
      expect(detail.outcome?.summary).toBe("did P");
    }
  });

  it("closes the Detail gracefully when the selected card has left the pool", () => {
    const selected = nextNodeSelection(null, ticketCardId("R"));
    expect(selected && projectDetail(flightSnapshot(), selected)).not.toBeNull();
    const gone = snapshot({
      state: {
        tickets: [ticket("P")],
        log: [],
        outcomes: {},
        interrupts: [],
        config: {},
      },
    });
    expect(selected && projectDetail(gone, selected)).toBeNull();
  });
});
