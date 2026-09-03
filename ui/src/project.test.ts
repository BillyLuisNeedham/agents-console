/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  checkpointNotice,
  clampDetailWidth,
  clampDrawersHeight,
  bulkResumeRows,
  DETAIL_MAX_FRACTION,
  DETAIL_MIN_PX,
  DRAWER_MAX_VH,
  DRAWER_MIN_VH,
  earlierLogOffset,
  edgePath,
  flowNeighbourhood,
  initialLogWindow,
  interruptForm,
  isTicketCardId,
  layoutStorageKey,
  LOG_BOTTOM_SLACK_PX,
  LOG_TAIL_BYTES,
  logAtBottom,
  logTailOffset,
  mergeLayout,
  nextNodeSelection,
  parseStoredDetailWidth,
  parseStoredLayout,
  phaseLabel,
  poolStatus,
  projectDetail,
  projectDetailTab,
  projectDetailTabs,
  projectLog,
  projectLogPane,
  projectNeedsInput,
  projectPool,
  projectPoolEdges,
  projectTimeline,
  REVIEW_CARD_ID,
  selectLogAttempt,
  START_CARD_ID,
  statusLabel,
  strokeWidthForZoom,
  ticketCardId,
  ticketBodyHtml,
  ticketDepth,
  zoomAtCursor,
  type PoolSnapshot,
  type PoolStatus,
  type PoolTicketState,
  type TabOverride,
  type TicketDetailView,
  type TicketEvent,
  type TicketEventsResponse,
  type TimelineView,
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

function snapshot(
  overrides: Omit<Partial<PoolSnapshot>, "state"> & {
    state?: Partial<PoolSnapshot["state"]>;
  } = {},
): PoolSnapshot {
  return {
    seq: 0,
    phase: "running",
    poolName: "repo/pool",
    ...overrides,
    state: {
      tickets: [],
      log: [],
      outcomes: {},
      interrupts: [],
      queuedAnswers: [],
      config: {},
      ...overrides.state,
    },
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
  it("carries each ticket's latest grade, and null for ungraded tickets", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A"), ticket("B")],
      },
    });
    const view = projectPool(snap, {
      A: { attempt: 2, score: 7, verdict: "pass", winner: 2 },
    });
    const a = view.cards.find((c) => c.id === "ticket:A");
    const b = view.cards.find((c) => c.id === "ticket:B");
    expect(a?.kind === "ticket" && a.grade).toEqual({
      attempt: 2,
      score: 7,
      verdict: "pass",
      winner: 2,
    });
    expect(b?.kind === "ticket" && b.grade).toBe(null);
  });

  it("renders no grade when no grades map is passed", () => {
    const snap = snapshot({ state: { tickets: [ticket("A")] } });
    const view = projectPool(snap);
    const a = view.cards.find((c) => c.id === "ticket:A");
    expect(a?.kind === "ticket" && a.grade).toBe(null);
  });

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
  "selection",
  "review",
];

describe("interruptForm", () => {
  it("gives all seven interrupt kinds a renderable, answerable form", () => {
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
    expect(actions("selection")).toEqual(["resume"]);
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
      selection: "human selection",
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

describe("queued-answer waiting state", () => {
  function queuedSnapshot(): PoolSnapshot {
    return snapshot({
      state: {
        tickets: [ticket("A"), ticket("B")],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief A" },
          { ticketId: "B", kind: "checkpoint", body: "brief B" },
        ],
        queuedAnswers: [{ ticketId: "A", kind: "checkpoint" }],
      },
    });
  }

  it("projects the waiting state onto the card of the answered ticket only", () => {
    const view = projectPool(queuedSnapshot());
    const answered = view.cards.find((c) => c.id === "ticket:A");
    const unanswered = view.cards.find((c) => c.id === "ticket:B");
    expect(answered?.kind).toBe("ticket");
    expect(unanswered?.kind).toBe("ticket");
    if (answered?.kind === "ticket" && unanswered?.kind === "ticket") {
      // The interrupt stays pending on both; the queued flag carries the
      // "my click landed and is waiting" distinction.
      expect(answered.interrupt?.queued).toBe(true);
      expect(unanswered.interrupt?.queued).toBe(false);
    }
  });

  it("mirrors the waiting state in the Detail", () => {
    const detail = projectDetail(queuedSnapshot(), "ticket:A");
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.interrupt?.queued).toBe(true);
      expect(detail.interrupt?.kind).toBe("checkpoint");
    }
  });

  it("clears the waiting state on the snapshot where the answer is processed", () => {
    const processed = snapshot({
      state: {
        tickets: [ticket("A", { status: "in-progress" }), ticket("B")],
        interrupts: [{ ticketId: "B", kind: "checkpoint", body: "brief B" }],
      },
    });
    const card = projectPool(processed).cards.find((c) => c.id === "ticket:A");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.interrupt).toBeNull();
    }
    const other = projectPool(processed).cards.find((c) => c.id === "ticket:B");
    expect(other?.kind).toBe("ticket");
    if (other?.kind === "ticket") {
      expect(other.interrupt?.queued).toBe(false);
    }
  });

  it("matches the queued answer to its interrupt kind, not just the ticket", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: "A", kind: "merge-approval", body: "resolution" }],
        queuedAnswers: [{ ticketId: "A", kind: "checkpoint" }],
      },
    });
    const card = projectPool(snap).cards.find((c) => c.id === "ticket:A");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.interrupt?.queued).toBe(false);
    }
  });
});

describe("projectNeedsInput", () => {
  it("lists one row per interrupted card in card order, with kinds and forms", () => {
    const snap = snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "checkpoint" }), ticket("B")],
        interrupts: [
          { ticketId: "B", kind: "merge-approval", body: "resolution" },
          { ticketId: "A", kind: "checkpoint", body: "brief" },
        ],
      },
    });
    const rows = projectNeedsInput(snap);
    // Card order, not interrupt order: the tray and the canvas agree.
    expect(rows.map((r) => r.cardId)).toEqual(["ticket:A", "ticket:B"]);
    expect(rows.map((r) => r.ticketId)).toEqual(["A", "B"]);
    expect(rows.map((r) => r.label)).toEqual(["A", "B"]);
    expect(rows.map((r) => r.title)).toEqual(["ticket A", "ticket B"]);
    expect(rows[0].interrupt.kind).toBe("checkpoint");
    expect(rows[0].interrupt.form.actions.map((a) => a.action)).toEqual(["resume"]);
    expect(rows[1].interrupt.kind).toBe("merge-approval");
    expect(rows[1].interrupt.form.actions.map((a) => a.action)).toEqual([
      "approve",
      "reject",
    ]);
  });

  it("lists an answered interrupt too, with its queued flag set", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A"), ticket("B")],
        interrupts: [
          { ticketId: "A", kind: "crash", body: "log path" },
          { ticketId: "B", kind: "checkpoint", body: "brief" },
        ],
        queuedAnswers: [{ ticketId: "A", kind: "crash" }],
      },
    });
    const rows = projectNeedsInput(snap);
    expect(rows).toHaveLength(2);
    expect(rows[0].interrupt.queued).toBe(true);
    expect(rows[1].interrupt.queued).toBe(false);
  });

  it("drops a waiting row when the boundary snapshot drains the queued answer", () => {
    const waiting = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
        queuedAnswers: [{ ticketId: "A", kind: "checkpoint" }],
      },
    });
    expect(projectNeedsInput(waiting)).toHaveLength(1);
    // The boundary applies the queued answer: the interrupt and its queued
    // record both drop, and the waiting row goes with them.
    const drained = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [],
        queuedAnswers: [],
      },
    });
    expect(projectNeedsInput(drained)).toEqual([]);
  });

  it("projects the review card's interrupt as a row that selects the review card", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: REVIEW_CARD_ID, kind: "review", body: "final review" }],
      },
    });
    const rows = projectNeedsInput(snap);
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(REVIEW_CARD_ID);
    expect(rows[0].ticketId).toBe(REVIEW_CARD_ID);
    expect(rows[0].label).toBe("review");
    expect(rows[0].title).toBeNull();
    expect(rows[0].interrupt.form.actions.map((a) => a.action)).toEqual([
      "approve",
      "reject",
    ]);
  });

  it("falls back to a plain resume row for an unknown interrupt kind", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: "A", kind: "harness-gone", body: "?" }],
      },
    });
    const rows = projectNeedsInput(snap);
    expect(rows).toHaveLength(1);
    expect(rows[0].interrupt.form.title).toBe("harness-gone");
    expect(rows[0].interrupt.form.actions.map((a) => a.action)).toEqual(["resume"]);
  });

  it("is empty with no pending interrupts", () => {
    expect(projectNeedsInput(snapshot())).toEqual([]);
  });
});

describe("bulkResumeRows", () => {
  it("keeps only the open resume-kind rows, in row order", () => {
    const snap = snapshot({
      phase: "quiescent",
      state: {
        tickets: [
          ticket("A", { status: "checkpoint" }),
          ticket("B"),
          ticket("C"),
          ticket("D"),
        ],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief" },
          { ticketId: "B", kind: "merge-approval", body: "resolution" },
          { ticketId: "C", kind: "crash", body: "log path" },
          { ticketId: "D", kind: "harness-gone", body: "?" },
        ],
        queuedAnswers: [{ ticketId: "C", kind: "crash" }],
      },
    });
    const rows = projectNeedsInput(snap);
    // The review row answers individually, the queued crash row already
    // stands answered, and the unknown kind falls back to a plain resume
    // form, so it bulk-fires with the checkpoint.
    expect(bulkResumeRows(rows).map((r) => r.ticketId)).toEqual(["A", "D"]);
  });

  it("is empty when every row is queued or answered individually", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A"), ticket("B")],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief" },
          { ticketId: "B", kind: "review", body: "final review" },
        ],
        queuedAnswers: [{ ticketId: "A", kind: "checkpoint" }],
      },
    });
    expect(bulkResumeRows(projectNeedsInput(snap))).toEqual([]);
  });
});

describe("blocked-by-checkpoint notice", () => {
  function blockedSnapshot(): PoolSnapshot {
    return snapshot({
      state: {
        tickets: [
          ticket("A", { status: "checkpoint" }),
          ticket("B", { blockedBy: ["A"] }),
          ticket("C", { blockedBy: ["B"] }),
        ],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief A" }],
      },
    });
  }

  it("projects the notice onto the dependent's card, named by blocker", () => {
    const view = projectPool(blockedSnapshot());
    const dependent = view.cards.find((c) => c.id === "ticket:B");
    expect(dependent?.kind).toBe("ticket");
    if (dependent?.kind === "ticket") {
      expect(dependent.blockedByCheckpoint).toEqual(["A"]);
      expect(checkpointNotice(dependent.blockedByCheckpoint)).toBe(
        "blocked by checkpoint on ticket A (waiting on you)",
      );
    }
  });

  it("does not project onto the checkpointed ticket itself or a transitively blocked ticket", () => {
    const view = projectPool(blockedSnapshot());
    const blocker = view.cards.find((c) => c.id === "ticket:A");
    const transitive = view.cards.find((c) => c.id === "ticket:C");
    expect(blocker?.kind).toBe("ticket");
    expect(transitive?.kind).toBe("ticket");
    if (blocker?.kind === "ticket") {
      expect(blocker.blockedByCheckpoint).toEqual([]);
    }
    if (transitive?.kind === "ticket") {
      // C's blocker B is merely ready, not checkpointed: no notice.
      expect(transitive.blockedByCheckpoint).toEqual([]);
    }
  });

  it("mirrors the notice in the dependent's Detail", () => {
    const detail = projectDetail(blockedSnapshot(), "ticket:B");
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.blockedByCheckpoint).toEqual(["A"]);
      expect(checkpointNotice(detail.blockedByCheckpoint)).toBe(
        "blocked by checkpoint on ticket A (waiting on you)",
      );
    }
  });

  it("names every checkpointed blocker when there are several", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("A", { status: "checkpoint" }),
          ticket("B", { status: "checkpoint" }),
          ticket("C", { blockedBy: ["A", "B"] }),
        ],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief A" },
          { ticketId: "B", kind: "crash", body: "crashed" },
        ],
      },
    });
    const card = projectPool(snap).cards.find((c) => c.id === "ticket:C");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(checkpointNotice(card.blockedByCheckpoint)).toBe(
        "blocked by checkpoint on tickets A, B (waiting on you)",
      );
    }
  });

  it("clears once the blocker completes and the dependent is schedulable", () => {
    const cleared = snapshot({
      state: {
        tickets: [ticket("A", { status: "done" }), ticket("B", { blockedBy: ["A"] })],
      },
    });
    const card = projectPool(cleared).cards.find((c) => c.id === "ticket:B");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.blockedByCheckpoint).toEqual([]);
    }
  });

  it("stays silent while the dependent is no longer waiting", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("A", { status: "checkpoint" }),
          ticket("B", { blockedBy: ["A"], status: "in-progress" }),
        ],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief A" }],
      },
    });
    const card = projectPool(snap).cards.find((c) => c.id === "ticket:B");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.blockedByCheckpoint).toEqual([]);
    }
  });

  it("needs the blocker's interrupt pending, not just its checkpoint status", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("A", { status: "checkpoint" }),
          ticket("B", { blockedBy: ["A"] }),
        ],
      },
    });
    const card = projectPool(snap).cards.find((c) => c.id === "ticket:B");
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.blockedByCheckpoint).toEqual([]);
    }
  });
});

describe("checkpoint visible at attempt exit", () => {
  function windowSnapshot(): PoolSnapshot {
    return snapshot({
      phase: "running",
      state: {
        tickets: [
          ticket("01", { status: "checkpoint" }),
          ticket("02", { status: "in-progress" }),
          ticket("03", { blockedBy: ["01"] }),
        ],
        interrupts: [{ ticketId: "01", kind: "checkpoint", body: "pick a name" }],
      },
    });
  }

  it("projects the full needs-human look on the checkpointed card while the sibling runs", () => {
    const view = projectPool(windowSnapshot());
    const card = view.cards.find((c) => c.id === ticketCardId("01"));
    const sibling = view.cards.find((c) => c.id === ticketCardId("02"));
    expect(card?.kind).toBe("ticket");
    expect(sibling?.kind).toBe("ticket");
    if (card?.kind === "ticket" && sibling?.kind === "ticket") {
      expect(card.status).toBe("checkpoint");
      expect(card.interrupt?.kind).toBe("checkpoint");
      expect(card.interrupt?.body).toBe("pick a name");
      expect(card.interrupt?.form.actions.map((a) => a.action)).toEqual(["resume"]);
      expect(sibling.status).toBe("in-progress");
      expect(sibling.interrupt).toBeNull();
    }
  });

  it("offers the interrupt form in the Detail and reports needs input during the window", () => {
    const detail = projectDetail(windowSnapshot(), ticketCardId("01"));
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.interrupt?.form.title).toBe("checkpoint");
      expect(detail.interrupt?.form.actions.map((a) => a.action)).toEqual([
        "resume",
      ]);
    }
    expect(poolStatus(windowSnapshot())).toEqual({
      word: "needs input",
      color: "#f85149",
    });
  });

  it("shows the blocked-by-checkpoint notice on the dependent during the window", () => {
    const view = projectPool(windowSnapshot());
    const dependent = view.cards.find((c) => c.id === ticketCardId("03"));
    expect(dependent?.kind).toBe("ticket");
    if (dependent?.kind === "ticket") {
      expect(dependent.blockedByCheckpoint).toEqual(["01"]);
      expect(checkpointNotice(dependent.blockedByCheckpoint)).toBe(
        "blocked by checkpoint on ticket 01 (waiting on you)",
      );
    }
  });

  it("shows the queued answer's waiting state on the checkpointed card during the window", () => {
    const snap = windowSnapshot();
    const view = projectPool({
      ...snap,
      state: {
        ...snap.state,
        queuedAnswers: [{ ticketId: "01", kind: "checkpoint" }],
      },
    });
    const card = view.cards.find((c) => c.id === ticketCardId("01"));
    const sibling = view.cards.find((c) => c.id === ticketCardId("02"));
    expect(card?.kind).toBe("ticket");
    expect(sibling?.kind).toBe("ticket");
    if (card?.kind === "ticket" && sibling?.kind === "ticket") {
      expect(card.interrupt?.queued).toBe(true);
      expect(card.interrupt?.kind).toBe("checkpoint");
      expect(sibling.status).toBe("in-progress");
    }
  });

  it("clears the dependent's blocked-by-checkpoint notice once the blocker resolves", () => {
    const resolved = snapshot({
      phase: "running",
      state: {
        tickets: [
          ticket("01", { status: "done" }),
          ticket("02", { status: "in-progress" }),
          ticket("03", { blockedBy: ["01"] }),
        ],
      },
    });
    const view = projectPool(resolved);
    const dependent = view.cards.find((c) => c.id === ticketCardId("03"));
    expect(dependent?.kind).toBe("ticket");
    if (dependent?.kind === "ticket") {
      expect(dependent.blockedByCheckpoint).toEqual([]);
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

  it("carries the grades endpoint's winner for the timeline's badge", () => {
    const snap = snapshot({ state: { tickets: [ticket("A"), ticket("B")] } });
    const grades = { A: { attempt: 2, score: 9, verdict: "pass", winner: 2 } };
    const a = projectDetail(snap, "ticket:A", grades);
    const b = projectDetail(snap, "ticket:B", grades);
    expect(a?.kind === "ticket" && a.winner).toBe(2);
    expect(b?.kind === "ticket" && b.winner).toBe(null);
  });
});

describe("projectDetailTab", () => {
  function detail(
    status: PoolStatus,
    interrupt: TicketDetailView["interrupt"] = null,
    ticketId = "A",
  ): TicketDetailView {
    return {
      kind: "ticket",
      ticketId,
      title: `ticket ${ticketId}`,
      status,
      blockedBy: [],
      blockedByCheckpoint: [],
      outcome: null,
      interrupt,
      winner: null,
    };
  }

  const pending = (ticketId = "A"): TicketDetailView["interrupt"] => ({
    ticketId,
    kind: "checkpoint",
    body: "the brief",
    form: interruptForm({ ticketId, kind: "checkpoint", body: "the brief" }),
    queued: false,
  });

  it("maps each pool status to its default tab", () => {
    expect(projectDetailTab(detail("ready"), null)).toBe("spec");
    expect(projectDetailTab(detail("in-progress"), null)).toBe("progress");
    expect(projectDetailTab(detail("checkpoint"), null)).toBe("progress");
    expect(projectDetailTab(detail("done"), null)).toBe("outcome");
  });

  it("maps a pending interrupt to Progress on every status, including done", () => {
    for (const status of ["ready", "in-progress", "checkpoint", "done"] as PoolStatus[]) {
      expect(projectDetailTab(detail(status, pending()), null)).toBe("progress");
    }
  });

  it("lets a manual tab choice override the default for the current ticket", () => {
    const override: TabOverride = { ticketId: "A", tab: "spec" };
    expect(projectDetailTab(detail("done"), override)).toBe("spec");
    expect(projectDetailTab(detail("ready"), { ticketId: "A", tab: "outcome" })).toBe("outcome");
  });

  it("lets a manual choice override the interrupt-driven Progress tab", () => {
    const override: TabOverride = { ticketId: "A", tab: "outcome" };
    expect(projectDetailTab(detail("checkpoint", pending()), override)).toBe("outcome");
  });

  it("resets the override when the selected ticket changes", () => {
    const override: TabOverride = { ticketId: "A", tab: "spec" };
    expect(projectDetailTab(detail("done", null, "B"), override)).toBe("outcome");
    expect(projectDetailTab(detail("in-progress", null, "B"), override)).toBe("progress");
  });
});

describe("projectDetailTabs", () => {
  function detail(
    status: PoolStatus,
    interrupt: TicketDetailView["interrupt"] = null,
    ticketId = "A",
  ): TicketDetailView {
    return {
      kind: "ticket",
      ticketId,
      title: `ticket ${ticketId}`,
      status,
      blockedBy: [],
      blockedByCheckpoint: [],
      outcome: null,
      interrupt,
      winner: null,
    };
  }

  const pending = (ticketId = "A"): TicketDetailView["interrupt"] => ({
    ticketId,
    kind: "checkpoint",
    body: "the brief",
    form: interruptForm({ ticketId, kind: "checkpoint", body: "the brief" }),
    queued: false,
  });

  it("projects the fixed Spec / Progress / Outcome bar on every status", () => {
    for (const status of ["ready", "in-progress", "checkpoint", "done"] as PoolStatus[]) {
      const tabs = projectDetailTabs(detail(status), null);
      expect(tabs.map((tab) => tab.id)).toEqual(["spec", "progress", "outcome"]);
      expect(tabs.map((tab) => tab.label)).toEqual(["Spec", "Progress", "Outcome"]);
      expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    }
  });

  it("activates the tab the default projection chooses", () => {
    const tabs = projectDetailTabs(detail("done"), null);
    expect(tabs.find((tab) => tab.active)?.id).toBe("outcome");
  });

  it("activates a manual choice made for this ticket", () => {
    const tabs = projectDetailTabs(detail("done"), { ticketId: "A", tab: "spec" });
    expect(tabs.find((tab) => tab.active)?.id).toBe("spec");
  });

  it("puts the interrupt dot on the Progress tab only while one is pending", () => {
    const tabs = projectDetailTabs(detail("in-progress", pending()), null);
    expect(tabs.find((tab) => tab.id === "progress")?.interruptDot).toBe(true);
    expect(tabs.find((tab) => tab.id === "spec")?.interruptDot).toBe(false);
    expect(tabs.find((tab) => tab.id === "outcome")?.interruptDot).toBe(false);
    const quiet = projectDetailTabs(detail("in-progress"), null);
    expect(quiet.every((tab) => !tab.interruptDot)).toBe(true);
  });
});

describe("ticketBodyHtml", () => {
  it("renders headings, lists and code blocks as HTML", () => {
    const html = ticketBodyHtml("# Title\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders inline code and paragraphs", () => {
    const html = ticketBodyHtml("some prose with `code` inside");
    expect(html).toContain("<p>");
    expect(html).toContain("<code>code</code>");
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

describe("statusLabel", () => {
  it("labels the ticket statuses", () => {
    expect(statusLabel("ready")).toBe("ready");
    expect(statusLabel("in-progress")).toBe("running");
    expect(statusLabel("done")).toBe("done");
    expect(statusLabel("checkpoint")).toBe("checkpoint");
  });
});

describe("poolStatus", () => {
  it("needs input in red when any interrupt is pending, whatever the phase", () => {
    const interrupts = [{ ticketId: "a", kind: "checkpoint", body: "" }];
    for (const phase of ["running", "done", "quiescent", "stalled"] as const) {
      expect(poolStatus(snapshot({ phase, state: { ...snapshot().state, interrupts } }))).toEqual({
        word: "needs input",
        color: "#f85149",
      });
    }
  });

  it("needs input when stalled with no interrupts", () => {
    expect(poolStatus(snapshot({ phase: "stalled" }))).toEqual({
      word: "needs input",
      color: "#f85149",
    });
  });

  it("stays out of needs input while every pending interrupt has a queued answer", () => {
    const snap = snapshot({
      phase: "running",
      state: {
        interrupts: [
          { ticketId: "a", kind: "checkpoint", body: "" },
          { ticketId: "b", kind: "checkpoint", body: "" },
        ],
        queuedAnswers: [
          { ticketId: "a", kind: "checkpoint" },
          { ticketId: "b", kind: "checkpoint" },
        ],
      },
    });
    expect(poolStatus(snap)).toEqual({ word: "running", color: "#d29922" });

    const oneWaiting = snapshot({
      phase: "running",
      state: {
        interrupts: [
          { ticketId: "a", kind: "checkpoint", body: "" },
          { ticketId: "b", kind: "checkpoint", body: "" },
        ],
        queuedAnswers: [{ ticketId: "a", kind: "checkpoint" }],
      },
    });
    expect(poolStatus(oneWaiting)).toEqual({
      word: "needs input",
      color: "#f85149",
    });
  });

  it("running in amber while the phase is running", () => {
    expect(poolStatus(snapshot({ phase: "running" }))).toEqual({
      word: "running",
      color: "#d29922",
    });
  });

  it("complete in green when the phase is done", () => {
    expect(poolStatus(snapshot({ phase: "done" }))).toEqual({
      word: "complete",
      color: "#3fb950",
    });
  });

  it("idle in grey for anything else", () => {
    expect(poolStatus(snapshot({ phase: "quiescent" }))).toEqual({
      word: "idle",
      color: "#8b949e",
    });
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

describe("projectTimeline", () => {
  function event(
    attempt: number,
    kind: string,
    payload: Record<string, unknown> = {},
  ): TicketEvent {
    return { at: "2026-01-01T00:00:00.000Z", attempt, kind, payload };
  }

  function response(events: TicketEvent[]): TicketEventsResponse {
    return { events, attempts: [], reconstructed: false, spec: "the spec" };
  }

  it("groups events into one row per attempt and marks the running attempt", () => {
    const view = projectTimeline(
      response([
        event(1, "scheduled"),
        event(1, "spawned"),
        event(2, "scheduled"),
        event(2, "spawned"),
      ]),
      "in-progress",
    );
    expect(view.reconstructed).toBe(false);
    expect(view.attempts.map((a) => a.number)).toEqual([1, 2]);
    expect(view.attempts[0].running).toBe(false);
    expect(view.attempts[1].running).toBe(true);
    expect(view.attempts[1].events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
    ]);
  });

  it("keeps each attempt's events in recorded order", () => {
    const view = projectTimeline(
      response([
        event(1, "scheduled"),
        event(1, "spawned"),
        event(1, "exited", { code: 0, status: "checkpoint" }),
        event(1, "checkpoint"),
      ]),
      "checkpoint",
    );
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0].events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
    ]);
    expect(view.attempts[0].events[2].payload).toEqual({
      code: 0,
      status: "checkpoint",
    });
  });

  it("marks no attempt running when the ticket is not in-progress", () => {
    const view = projectTimeline(
      response([
        event(1, "scheduled"),
        event(1, "spawned"),
        event(1, "exited"),
      ]),
      "done",
    );
    expect(view.attempts[0].running).toBe(false);
  });

  it("does not mark a crashed attempt running", () => {
    const view = projectTimeline(
      response([
        event(1, "scheduled"),
        event(1, "spawned"),
        event(1, "exited"),
        event(1, "crash"),
      ]),
      "in-progress",
    );
    expect(view.attempts[0].running).toBe(false);
  });

  it("reconstructs one row per log file with the reconstructed flag", () => {
    const view = projectTimeline(
      {
        events: [],
        attempts: [
          { attempt: 1, logFile: "01.log", modifiedAt: "2026-01-01T00:00:00.000Z" },
          { attempt: 2, logFile: "01.attempt-2.log", modifiedAt: "2026-01-01T00:00:01.000Z" },
        ],
        reconstructed: true,
        spec: "the spec",
      },
      "in-progress",
    );
    expect(view.reconstructed).toBe(true);
    expect(view.attempts).toHaveLength(2);
    expect(view.attempts[0]).toEqual({
      number: 1,
      events: [],
      reconstructed: true,
      running: false,
      logFile: "01.log",
    });
    // The current attempt of an in-progress reconstructed ticket is the
    // newest log row.
    expect(view.attempts[1].running).toBe(true);
  });

  it("is empty for a ticket with no events and no log files", () => {
    const view = projectTimeline(
      { events: [], attempts: [], reconstructed: true, spec: "the spec" },
      "ready",
    );
    expect(view.attempts).toEqual([]);
    expect(view.reconstructed).toBe(true);
  });
});

function timelineView(attempts: { number: number; running: boolean }[]): TimelineView {
  return {
    attempts: attempts.map(({ number, running }) => ({
      number,
      events: [],
      reconstructed: false,
      running,
      logFile: null,
    })),
    reconstructed: false,
  };
}

describe("selectLogAttempt", () => {
  it("prefers the running attempt, then the latest, then null", () => {
    const timeline = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
      { number: 3, running: false },
    ]);
    expect(selectLogAttempt(timeline, null)).toBe(2);
    expect(selectLogAttempt(timeline, 1)).toBe(1);
    expect(selectLogAttempt(timeline, 3)).toBe(3);
    expect(selectLogAttempt(timelineView([]), null)).toBeNull();
  });
});

describe("projectLogPane", () => {
  it("projects a never-run pane with no selected attempt when the timeline is empty", () => {
    const pane = projectLogPane(timelineView([]), null, null, null);
    expect(pane).not.toBeNull();
    expect(pane?.neverRun).toBe(true);
    expect(pane?.selectedAttempt).toBeNull();
    expect(pane?.content).toBe("");
  });

  it("projects the selected attempt and its fetched content", () => {
    const pane = projectLogPane(
      timelineView([
        { number: 1, running: false },
        { number: 2, running: true },
      ]),
      null,
      { content: "the log", firstOffset: 0, offset: 50, totalSize: 100 },
      null,
    );
    expect(pane).not.toBeNull();
    expect(pane?.neverRun).toBe(false);
    expect(pane?.selectedAttempt).toBe(2);
    expect(pane?.content).toBe("the log");
    expect(pane?.offset).toBe(50);
    expect(pane?.totalSize).toBe(100);
    expect(pane?.hasMore).toBe(true);
  });

  it("marks the pane complete when the offset reaches the total size", () => {
    const pane = projectLogPane(
      timelineView([{ number: 1, running: false }]),
      null,
      { content: "all", firstOffset: 0, offset: 100, totalSize: 100 },
      null,
    );
    expect(pane?.hasMore).toBe(false);
  });

  it("keeps a clicked attempt selected over the running attempt", () => {
    const pane = projectLogPane(
      timelineView([
        { number: 1, running: true },
        { number: 2, running: false },
      ]),
      2,
      null,
      null,
    );
    expect(pane?.selectedAttempt).toBe(2);
    expect(pane?.content).toBe("");
  });

  it("carries a fetch error into the pane", () => {
    const pane = projectLogPane(
      timelineView([{ number: 1, running: false }]),
      1,
      null,
      "log fetch failed",
    );
    expect(pane?.error).toBe("log fetch failed");
  });

  it("projects null while the timeline has not loaded", () => {
    const pane = projectLogPane(null, null, null, null);
    expect(pane).toBeNull();
  });

  it("offers load-earlier only when older bytes exist before the held window", () => {
    const timeline = timelineView([{ number: 1, running: false }]);
    const atHead = projectLogPane(
      timeline,
      null,
      { content: "all", firstOffset: 0, offset: 3, totalSize: 3 },
      null,
    );
    expect(atHead?.hasEarlier).toBe(false);
    const midFile = projectLogPane(
      timeline,
      null,
      { content: "tail", firstOffset: LOG_TAIL_BYTES, offset: LOG_TAIL_BYTES + 4, totalSize: LOG_TAIL_BYTES + 4 },
      null,
    );
    expect(midFile?.firstOffset).toBe(LOG_TAIL_BYTES);
    expect(midFile?.hasEarlier).toBe(true);
  });
});

describe("log tailing decisions", () => {
  it("opens a long log tail-first at its last window", () => {
    expect(initialLogWindow(LOG_TAIL_BYTES * 3 + 10)).toBe(LOG_TAIL_BYTES * 2 + 10);
  });

  it("opens a log of one window or less from the head", () => {
    expect(initialLogWindow(100)).toBe(0);
    expect(initialLogWindow(LOG_TAIL_BYTES)).toBe(0);
    expect(initialLogWindow(0)).toBe(0);
  });

  it("tails from the last read offset until caught up, then stops requesting", () => {
    expect(logTailOffset(50, 100)).toBe(50);
    expect(logTailOffset(100, 100)).toBeNull();
    expect(logTailOffset(0, 0)).toBeNull();
  });

  it("steps load-earlier one window back from the oldest held byte, stopping at the head", () => {
    expect(earlierLogOffset(LOG_TAIL_BYTES * 2)).toBe(LOG_TAIL_BYTES);
    expect(earlierLogOffset(10)).toBe(0);
    expect(earlierLogOffset(0)).toBeNull();
  });

  it("counts the pane as at the tail only within the bottom slack", () => {
    const scrollHeight = 1000;
    const clientHeight = 200;
    const atBottom = scrollHeight - clientHeight;
    expect(logAtBottom(atBottom, clientHeight, scrollHeight)).toBe(true);
    expect(logAtBottom(atBottom - LOG_BOTTOM_SLACK_PX, clientHeight, scrollHeight)).toBe(true);
    expect(logAtBottom(atBottom - LOG_BOTTOM_SLACK_PX - 1, clientHeight, scrollHeight)).toBe(false);
    expect(logAtBottom(0, clientHeight, scrollHeight)).toBe(false);
  });
});

describe("attempt-stay on a running ticket", () => {
  it("keeps a clicked older attempt when a new attempt starts running", () => {
    const after = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
    ]);
    expect(selectLogAttempt(after, 1)).toBe(1);
  });

  it("follows the newly running attempt when no attempt was clicked", () => {
    const before = timelineView([{ number: 1, running: true }]);
    expect(selectLogAttempt(before, null)).toBe(1);
    const after = timelineView([
      { number: 1, running: false },
      { number: 2, running: true },
    ]);
    expect(selectLogAttempt(after, null)).toBe(2);
  });

  it("stays on the latest attempt while no attempt is running", () => {
    const waiting = timelineView([
      { number: 1, running: false },
      { number: 2, running: false },
    ]);
    expect(selectLogAttempt(waiting, null)).toBe(2);
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

describe("clampDetailWidth", () => {
  it("clamps below the readable minimum", () => {
    expect(clampDetailWidth(100, 1600)).toBe(DETAIL_MIN_PX);
  });

  it("clamps above the window fraction (about 80vw)", () => {
    expect(clampDetailWidth(2000, 1600)).toBe(1600);
  });

  it("passes values inside the range through unchanged", () => {
    expect(clampDetailWidth(600, 1600)).toBe(600);
  });

  it("tracks the window bound when the window is too narrow to hold the minimum", () => {
    expect(clampDetailWidth(600, 200)).toBe(200);
  });

  it("keeps the maximum at about 80% of the window", () => {
    expect(DETAIL_MAX_FRACTION).toBeCloseTo(0.8);
    expect(clampDetailWidth(100000, Math.round(1440 * DETAIL_MAX_FRACTION))).toBe(1152);
  });
});

describe("parseStoredDetailWidth", () => {
  it("round-trips a stored width string through a reload", () => {
    // The write path stores String(detailWidth) under one global key; the
    // read path parses it back and clamps to the current window. A stored
    // 600 on a reload with the same window comes back as 600.
    const maxPx = Math.round(1440 * DETAIL_MAX_FRACTION);
    expect(parseStoredDetailWidth("600", maxPx)).toBe(600);
  });

  it("falls back to the minimum when nothing is stored", () => {
    expect(parseStoredDetailWidth(null, 1600)).toBe(DETAIL_MIN_PX);
  });

  it("falls back to the minimum for a non-numeric or non-finite stored value", () => {
    expect(parseStoredDetailWidth("abc", 1600)).toBe(DETAIL_MIN_PX);
    expect(parseStoredDetailWidth("Infinity", 1600)).toBe(DETAIL_MIN_PX);
  });

  it("clamps a stored width that is out of range on reload", () => {
    expect(parseStoredDetailWidth("10", 1600)).toBe(DETAIL_MIN_PX);
    expect(parseStoredDetailWidth("5000", 1600)).toBe(1600);
  });

  it("tracks the window bound on a narrow window", () => {
    expect(parseStoredDetailWidth("600", 200)).toBe(200);
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

describe("flowNeighbourhood", () => {
  const edges = projectPoolEdges([
    ticket("A"),
    ticket("B", { blockedBy: ["A"] }),
    ticket("C", { blockedBy: ["B"] }),
  ]);

  it("returns the one-hop inflow and outflow of the selection", () => {
    expect(flowNeighbourhood(edges, "ticket:B")).toEqual({
      inflow: ["ticket:A"],
      outflow: [REVIEW_CARD_ID, "ticket:C"],
    });
  });

  it("is one hop only: no transitive dependency cone", () => {
    const hood = flowNeighbourhood(edges, "ticket:C");
    expect(hood.inflow).toEqual(["ticket:B"]);
    expect(hood.inflow).not.toContain("ticket:A");
    expect(hood.inflow).not.toContain(START_CARD_ID);
  });

  it("lets start flow into a blockerless ticket and review out of every ticket", () => {
    const hood = flowNeighbourhood(edges, "ticket:A");
    expect(hood.inflow).toEqual([START_CARD_ID]);
    expect(hood.outflow).toEqual([REVIEW_CARD_ID, "ticket:B"]);
  });

  it("lights the utility cards' own neighbourhoods", () => {
    expect(flowNeighbourhood(edges, START_CARD_ID)).toEqual({
      inflow: [],
      outflow: ["ticket:A"],
    });
    expect(flowNeighbourhood(edges, REVIEW_CARD_ID)).toEqual({
      inflow: ["ticket:A", "ticket:B", "ticket:C"],
      outflow: [],
    });
  });

  it("is empty for a cleared selection or an unknown card", () => {
    expect(flowNeighbourhood(edges, null)).toEqual({ inflow: [], outflow: [] });
    expect(flowNeighbourhood(edges, "ticket:zzz")).toEqual({ inflow: [], outflow: [] });
  });

  it("re-derives from the edges of each live snapshot", () => {
    const first = projectPoolEdges([ticket("A")]);
    expect(flowNeighbourhood(first, "ticket:A").outflow).toEqual([REVIEW_CARD_ID]);
    const next = projectPoolEdges([ticket("A"), ticket("B", { blockedBy: ["A"] })]);
    expect(flowNeighbourhood(next, "ticket:A").outflow).toEqual([
      REVIEW_CARD_ID,
      "ticket:B",
    ]);
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
