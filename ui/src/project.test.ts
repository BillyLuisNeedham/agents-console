/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  poolAssignmentDefaults,
  checkpointNotice,
  clampDetailWidth,
  clampNeedsInputWidth,
  clampDrawersHeight,
  bulkResumeRows,
  projectConversationsNeedsInput,
  projectConversationsTray,
  DETAIL_MAX_FRACTION,
  DETAIL_MIN_PX,
  earlierLogOffset,
  initialLogWindow,
  isTerminalBacked,
  joinStreamFiles,
  logAtBottom,
  logTailOffset,
  nextNodeSelection,
  parseStoredDetailWidth,
  parseStoredNeedsInputWidth,
  NEEDS_INPUT_MAX_FRACTION,
  NEEDS_INPUT_MIN_PX,
  phaseLabel,
  poolDisplayName,
  poolStatus,
  poolTabTitle,
  projectDetail,
  resolverFiles,
  projectDetailTabs,
  projectEnlistBlocks,
  projectEnlistForm,
  projectReassignTickets,
  projectEnlistPicker,
  ENLIST_BECOMES_HINT,
  ENLIST_STEWARD_NOTE,
  stewardAssignmentDefaults,
  stewardBudgetText,
  stewardLiveReason,
  stewardOnDuty,
  stewardOnDutyLine,
  projectLogPane,
  projectNeedsInput,
  projectHeldSpawns,
  projectPendingSpawns,
  projectPool,
  projectTimeline,
  selectLogAttempt,
  statusLabel,
  ticketBodyHtml,
  projectVitals,
  pushVitalsSample,
  VITALS_MAX_SAMPLES,
  type ConversationCardView,
  type ConversationView,
  type EnrichedSnapshot,
  type EnrichedTicketState,
  type InterruptKind,
  type NeedsInputRow,
  type QueuedAnswer,
  type TabOverride,
  type TerminalSurfaceView,
  type TicketActivityResponse,
  type HeldSpawnView,
  type PendingSpawnView,
  type TicketCardView,
  type TicketDetailView,
  type TicketEvent,
  type TicketEventKind,
  type TicketEventsResponse,
  type TicketStatus,
  type TimelineView,
  type VitalsState,
} from "./project";

// The values the folded internals carried: the utility card ids, the wire
// contract's byte window, the layout metrics, and the vitals thresholds.
// The tests pin them directly, against the public projections.
const START_CARD_ID = "START";
const REVIEW_CARD_ID = "REVIEW";
const LOG_TAIL_BYTES = 64 * 1024;
const LOG_BOTTOM_SLACK_PX = 24;
const DRAWER_MIN_VH = 15;
const DRAWER_MAX_VH = 80;
const VITALS_FRESH_MS = 10_000;
const VITALS_IDLE_MS = 60_000;
const LAYOUT = {
  centerX: 420,
  startY: 16,
  rowH: 200,
  terminalRowH: 340,
  conversationLaneH: 380,
  colGap: 320,
  reviewY: 1200,
} as const;


/** The Reassign view the wire carries per ticket (issue #126), derived so a
 *  done or in-flight fixture ticket is not claimed as reassignable. */
function reassignOf(ticket: {
  status: EnrichedTicketState["status"];
  liveAttempt: EnrichedTicketState["liveAttempt"];
}): EnrichedTicketState["reassign"] {
  const eligible = ticket.liveAttempt === null && ticket.status !== "done";
  return {
    eligible,
    reason: eligible
      ? null
      : ticket.status === "done"
        ? "a done ticket keeps the Assignment it ran on"
        : "an Attempt is in flight",
    verify: null,
    sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
  };
}

/** A Ticket's own agent live on the snapshot, as the engine registers it. */
function agentAttempt(attempt: number, paneId: string | null): EnrichedTicketState["liveAttempt"] {
  return { attempt, paneId, role: "agent", startedAt: "2026-09-23T10:00:00.000Z" };
}

function ticket(
  id: string,
  overrides: Partial<EnrichedTicketState> = {},
): EnrichedTicketState {
  const base = {
    id,
    title: `ticket ${id}`,
    blockedBy: [],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    assignment: { harness: null, model: null, drivers: "implement" },
    liveAttempt: null,
    heldPane: null,
    ...overrides,
  };
  return { ...base, reassign: base.reassign ?? reassignOf(base) };
}

function conversation(
  id: string,
  overrides: Partial<ConversationView> = {},
): ConversationView {
  return {
    id,
    title: `conversation ${id}`,
    status: "live",
    spawnedBy: null,
    assignment: { harness: null, model: null, drivers: "implement" },
    paneId: null,
    branch: null,
    turn: { state: "working", lastLine: "", idleSince: null },
    children: [],
    enlisted: false,
    ending: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Omit<Partial<EnrichedSnapshot>, "state"> & {
    state?: Partial<EnrichedSnapshot["state"]>;
  } = {},
): EnrichedSnapshot {
  return {
    seq: 0,
    phase: "running",
    poolName: "repo/pool",
    poolTitle: null,
    poolDir: "/tmp/pool",
    finishedTerminals: 0,
    spawnUsage: { spawnedThisRun: 0, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    ...overrides,
    state: {
      tickets: [],
      conversations: [],
      log: [],
      outcomes: {},
      interrupts: [],
      mergeQueue: [],
      queuedAnswers: [],
      config: {},
      ...overrides.state,
    },
  };
}

/** A full Queued answer record as the wire carries it; the projection reads
 *  only ticketId and kind. */
function queued(ticketId: string, kind: InterruptKind): QueuedAnswer {
  return { seq: 1, ticketId, kind, at: "2026-09-12T10:00:00Z", processedAt: null };
}

/** The Detail for a card of the snapshot's own derivation: the test reads
 *  the Detail off the same projected cards the canvas renders. */
function detailOf(
  snap: EnrichedSnapshot,
  cardId: string,
): ReturnType<typeof projectDetail> {
  return projectDetail(projectPool(snap).cards, cardId);
}

describe("projectPool edges", () => {
  it("draws start, blocked-by, and review edges for a small pool", () => {
    const tickets = [
      ticket("A"),
      ticket("B", { blockedBy: ["A"] }),
      ticket("C", { blockedBy: ["B"] }),
    ];
    const edges = projectPool(snapshot({ state: { tickets } })).edges;
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
    const edges = projectPool(snapshot({ state: { tickets } })).edges;
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
        outcomes: { A: { status: "done", summary: "done A", commitSha: "abc" } },
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
        outcomes: { A: { status: "done", summary: "did the thing", commitSha: "sha1" } },
        interrupts: [],
        log: [],
        config: {},
      },
    });
    const view = projectPool(snap);
    const a = view.cards.find((c) => c.id === "ticket:A");
    expect(a && a.kind === "ticket" ? a.outcome : null).toEqual({
      status: "done",
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

const INTERRUPT_KINDS: InterruptKind[] = [
  "checkpoint",
  "config",
  "crash",
  "deadlock",
  "merge-conflict",
  "merge-approval",
  "selection",
  "review",
];

describe("interrupt forms", () => {
  // One interrupted ticket per kind, read through the Needs input tray's
  // rows: the form mapping is the projection's, so the public rows pin it.
  function rows(): NeedsInputRow[] {
    return projectNeedsInput(
      projectPool(
        snapshot({
          phase: "quiescent",
          state: {
            tickets: INTERRUPT_KINDS.map((kind) => ticket(`T-${kind}`)),
            interrupts: INTERRUPT_KINDS.map((kind) => ({
              ticketId: `T-${kind}`,
              kind,
              body: `${kind} body`,
            })),
          },
        }),
      ).cards,
    );
  }

  it("gives all seven kinds a renderable, answerable form", () => {
    for (const row of rows()) {
      expect(row.interrupt.form.title.length).toBeGreaterThan(0);
      expect(row.interrupt.form.actions.length).toBeGreaterThan(0);
    }
  });

  it("resumes the human-decision kinds and gates the approval kinds", () => {
    const actions = Object.fromEntries(
      rows().map((row) => [
        row.interrupt.kind,
        row.interrupt.form.actions.map((a) => a.action),
      ]),
    );
    expect(actions).toEqual({
      checkpoint: ["resume"],
      config: ["resume"],
      crash: ["resume"],
      deadlock: ["resume"],
      "merge-conflict": ["resume"],
      "merge-approval": ["approve", "reject"],
      selection: ["resume"],
      review: ["approve", "reject"],
    });
  });

  it("titles each kind for the card and Detail", () => {
    const titles = Object.fromEntries(
      rows().map((row) => [row.interrupt.kind, row.interrupt.form.title]),
    );
    expect(titles).toEqual({
      checkpoint: "checkpoint",
      config: "pool config",
      crash: "harness crash",
      deadlock: "deadlock",
      "merge-conflict": "merge conflict",
      "merge-approval": "merge approval",
      selection: "human selection",
      review: "review",
    });
  });
});

describe("interrupt projection", () => {
  function interruptSnapshot(): EnrichedSnapshot {
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
      const card = view.cards.find((c) => c.id === `ticket:T-${kind}`);
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
    const view = projectPool(interruptSnapshot());
    for (const kind of INTERRUPT_KINDS) {
      const card = view.cards.find((c) => c.id === `ticket:T-${kind}`);
      const detail = projectDetail(view.cards, `ticket:T-${kind}`);
      expect(detail?.kind).toBe("ticket");
      if (detail?.kind === "ticket") {
        expect(detail.interrupt?.kind).toBe(kind);
        expect(detail.interrupt).toEqual(
          card?.kind === "ticket" ? card.interrupt : null,
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
  function queuedSnapshot(): EnrichedSnapshot {
    return snapshot({
      state: {
        tickets: [ticket("A"), ticket("B")],
        interrupts: [
          { ticketId: "A", kind: "checkpoint", body: "brief A" },
          { ticketId: "B", kind: "checkpoint", body: "brief B" },
        ],
        queuedAnswers: [queued("A", "checkpoint")],
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
    const detail = detailOf(queuedSnapshot(), "ticket:A");
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
        queuedAnswers: [queued("A", "checkpoint")],
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
    const rows = projectNeedsInput(projectPool(snap).cards);
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
        queuedAnswers: [queued("A", "crash")],
      },
    });
    const rows = projectNeedsInput(projectPool(snap).cards);
    expect(rows).toHaveLength(2);
    expect(rows[0].interrupt.queued).toBe(true);
    expect(rows[1].interrupt.queued).toBe(false);
  });

  it("drops a waiting row when the boundary snapshot drains the queued answer", () => {
    const waiting = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "brief" }],
        queuedAnswers: [queued("A", "checkpoint")],
      },
    });
    expect(projectNeedsInput(projectPool(waiting).cards)).toHaveLength(1);
    // The boundary applies the queued answer: the interrupt and its queued
    // record both drop, and the waiting row goes with them.
    const drained = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [],
        mergeQueue: [],
        queuedAnswers: [],
      },
    });
    expect(projectNeedsInput(projectPool(drained).cards)).toEqual([]);
  });

  it("projects the review card's interrupt as a row that selects the review card", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A")],
        interrupts: [{ ticketId: REVIEW_CARD_ID, kind: "review", body: "final review" }],
      },
    });
    const rows = projectNeedsInput(projectPool(snap).cards);
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
        // A kind this build does not know, standing in for one a newer
        // engine adds: the literal union rejects it, so the fixture casts.
        interrupts: [{ ticketId: "A", kind: "harness-gone" as InterruptKind, body: "?" }],
      },
    });
    const rows = projectNeedsInput(projectPool(snap).cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].interrupt.form.title).toBe("harness-gone");
    expect(rows[0].interrupt.form.actions.map((a) => a.action)).toEqual(["resume"]);
  });

  it("is empty with no pending interrupts", () => {
    expect(projectNeedsInput(projectPool(snapshot()).cards)).toEqual([]);
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
          { ticketId: "D", kind: "harness-gone" as InterruptKind, body: "?" },
        ],
        queuedAnswers: [queued("C", "crash")],
      },
    });
    const rows = projectNeedsInput(projectPool(snap).cards);
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
        queuedAnswers: [queued("A", "checkpoint")],
      },
    });
    expect(bulkResumeRows(projectNeedsInput(projectPool(snap).cards))).toEqual([]);
  });
});

describe("blocked-by-checkpoint notice", () => {
  function blockedSnapshot(): EnrichedSnapshot {
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
    const detail = detailOf(blockedSnapshot(), "ticket:B");
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
  function windowSnapshot(): EnrichedSnapshot {
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
    const card = view.cards.find((c) => c.id === "ticket:01");
    const sibling = view.cards.find((c) => c.id === "ticket:02");
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
    const detail = detailOf(windowSnapshot(), "ticket:01");
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
    const dependent = view.cards.find((c) => c.id === "ticket:03");
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
        queuedAnswers: [queued("01", "checkpoint")],
      },
    });
    const card = view.cards.find((c) => c.id === "ticket:01");
    const sibling = view.cards.find((c) => c.id === "ticket:02");
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
    const dependent = view.cards.find((c) => c.id === "ticket:03");
    expect(dependent?.kind).toBe("ticket");
    if (dependent?.kind === "ticket") {
      expect(dependent.blockedByCheckpoint).toEqual([]);
    }
  });
});

describe("review projection", () => {
  function reviewSnapshot(): EnrichedSnapshot {
    return snapshot({
      phase: "quiescent",
      state: {
        tickets: [ticket("A", { status: "done" }), ticket("B", { status: "done" })],
        log: [],
        outcomes: {
          A: { status: "done", summary: "did A", commitSha: "sha-a" },
          B: { status: "done", summary: "did B", commitSha: "sha-b" },
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
    const detail = detailOf(reviewSnapshot(), REVIEW_CARD_ID);
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
    const rows = projectNeedsInput(
      projectPool(
        snapshot({
          state: {
            tickets: [ticket("A")],
            interrupts: [{ ticketId: REVIEW_CARD_ID, kind: "review", body: "" }],
          },
        }),
      ).cards,
    );
    expect(rows[0].interrupt.form.notePlaceholder).toContain("name the tickets");
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
    const detail = detailOf(snap, "ticket:A");
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.status).toBe("checkpoint");
      expect(detail.blockedBy).toEqual(["X"]);
      expect(detail.interrupt?.body).toBe("the brief");
    }
  });

  it("projects a utility card", () => {
    const detail = detailOf(snapshot(), START_CARD_ID);
    expect(detail).toEqual({
      kind: "utility",
      id: START_CARD_ID,
      label: "start",
      interrupt: null,
    });
  });

  it("returns null for a card not in the pool", () => {
    expect(detailOf(snapshot(), "ticket:zzz")).toBeNull();
  });

  it("carries the Assignment and its Reassign view, so the editor prefills", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("A", {
            assignment: { harness: "claude", model: "opus", drivers: "tdd" },
            enlisted: true,
            reassign: {
              eligible: true,
              reason: null,
              verify: 2,
              sources: { harness: "pinned", model: "default", effort: "unset", drivers: "inherited" },
            },
          }),
        ],
      },
    });
    const detail = detailOf(snap, "ticket:A");
    expect(detail?.kind === "ticket" && detail.assignment).toEqual({
      harness: "claude",
      model: "opus",
      drivers: "tdd",
    });
    expect(detail?.kind === "ticket" && detail.enlisted).toBe(true);
    expect(detail?.kind === "ticket" && detail.hasLiveAttempt).toBe(false);
    expect(detail?.kind === "ticket" && detail.reassign.verify).toBe(2);
    expect(detail?.kind === "ticket" && detail.reassign.sources.harness).toBe("pinned");
  });

  it("marks a ticket with an Attempt in flight, which the editor stands aside for", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("A", {
            status: "in-progress",
            liveAttempt: agentAttempt(1, null),
          }),
        ],
      },
    });
    const detail = detailOf(snap, "ticket:A");
    expect(detail?.kind === "ticket" && detail.hasLiveAttempt).toBe(true);
    expect(detail?.kind === "ticket" && detail.reassign.eligible).toBe(false);
  });

  it("carries the grades endpoint's winner for the timeline's badge", () => {
    const snap = snapshot({ state: { tickets: [ticket("A"), ticket("B")] } });
    const grades = { A: { attempt: 2, score: 9, verdict: "pass", winner: 2 } };
    const a = projectDetail(projectPool(snap, grades).cards, "ticket:A");
    const b = projectDetail(projectPool(snap, grades).cards, "ticket:B");
    expect(a?.kind === "ticket" && a.winner).toBe(2);
    expect(b?.kind === "ticket" && b.winner).toBe(null);
  });
});

describe("projectDetailTabs", () => {
  function detail(
    status: TicketStatus,
    interrupt: TicketDetailView["interrupt"] = null,
    ticketId = "A",
  ): TicketDetailView {
    return {
      kind: "ticket",
      ticketId,
      title: `ticket ${ticketId}`,
      status,
      mergeState: null,
      resolver: null,
      blockedBy: [],
      blockedByCheckpoint: [],
      outcome: null,
      interrupt,
      winner: null,
      assignment: { harness: "claude", model: "opus", drivers: "implement" },
      enlisted: false,
      reassign: {
        eligible: status !== "done",
        reason: null,
        verify: null,
        sources: { harness: "default", model: "default", effort: "unset", drivers: "default" },
      },
      hasLiveAttempt: false,
      stewardBudget: null,
    };
  }

  const pending = (ticketId = "A"): TicketDetailView["interrupt"] => ({
    ticketId,
    kind: "checkpoint",
    body: "the brief",
    form: {
      title: "checkpoint",
      actions: [{ action: "resume", label: "resume", tone: "primary" }],
    },
    queued: false,
    keepTalking: null,
  });

  const active = (status: TicketStatus, override: TabOverride | null = null) =>
    projectDetailTabs(detail(status), override).find((tab) => tab.active)?.id;

  it("projects the fixed Spec / Progress / Outcome bar on every status", () => {
    for (const status of ["ready", "in-progress", "checkpoint", "done"] as TicketStatus[]) {
      const tabs = projectDetailTabs(detail(status), null);
      expect(tabs.map((tab) => tab.id)).toEqual(["spec", "progress", "outcome"]);
      expect(tabs.map((tab) => tab.label)).toEqual(["Spec", "Progress", "Outcome"]);
      expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    }
  });

  it("maps each pool status to its default tab", () => {
    expect(active("ready")).toBe("spec");
    expect(active("in-progress")).toBe("progress");
    expect(active("checkpoint")).toBe("progress");
    expect(active("done")).toBe("outcome");
  });

  it("maps a pending interrupt to Progress on every status, including done", () => {
    for (const status of ["ready", "in-progress", "checkpoint", "done"] as TicketStatus[]) {
      const tabs = projectDetailTabs(detail(status, pending()), null);
      expect(tabs.find((tab) => tab.active)?.id).toBe("progress");
    }
  });

  it("activates a manual choice made for this ticket, over the default and the interrupt", () => {
    expect(projectDetailTabs(detail("done"), { ticketId: "A", tab: "spec" }).find((tab) => tab.active)?.id).toBe("spec");
    expect(projectDetailTabs(detail("ready"), { ticketId: "A", tab: "outcome" }).find((tab) => tab.active)?.id).toBe("outcome");
    expect(
      projectDetailTabs(detail("checkpoint", pending()), { ticketId: "A", tab: "outcome" }).find((tab) => tab.active)?.id,
    ).toBe("outcome");
  });

  it("ignores a manual choice made for another ticket", () => {
    const override: TabOverride = { ticketId: "A", tab: "spec" };
    expect(projectDetailTabs(detail("done", null, "B"), override).find((tab) => tab.active)?.id).toBe("outcome");
    expect(projectDetailTabs(detail("in-progress", null, "B"), override).find((tab) => tab.active)?.id).toBe("progress");
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
    expect(phaseLabel("dead")).toBe("dead");
    // The farewell phase of an orderly shutdown (issue #97).
    expect(phaseLabel("stopped")).toBe("stopped");
  });
});

describe("statusLabel", () => {
  it("labels the ticket statuses", () => {
    expect(statusLabel("ready")).toBe("ready");
    expect(statusLabel("in-progress")).toBe("running");
    expect(statusLabel("done")).toBe("done");
    expect(statusLabel("checkpoint")).toBe("checkpoint");
  });

  it("names where a held ticket stands in the Merge queue (#129), never a bare merge pending", () => {
    expect(statusLabel("done", "resolving")).toBe("resolving merge conflict");
    expect(statusLabel("done", "awaiting-approval")).toBe("merge approval: needs you");
    expect(statusLabel("done", "needs-you")).toBe("merge conflict: needs you");
    expect(statusLabel("done", "queued")).toBe("merge queued");
    expect(statusLabel("done", "stalled")).toBe("merge stalled: nothing running");
    expect(statusLabel("done", null)).toBe("done");
    // Only a done ticket carries it: the engine never queues any other
    // status, and the label does not leak if one ever did.
    expect(statusLabel("ready", "queued")).toBe("ready");
  });
});

const RESOLVER_START = "2026-09-23T10:00:00.000Z";
const RESOLVER_NOW = Date.parse("2026-09-23T10:10:05.000Z");

function resolverAttempt(paneId: string | null = "w2A:pE"): EnrichedTicketState["liveAttempt"] {
  return { attempt: 3, paneId, role: "resolver", startedAt: RESOLVER_START };
}

describe("merge queue projection (#129)", () => {
  const snap = snapshot({
    phase: "running",
    state: {
      tickets: [
        ticket("02", { status: "done", mergeState: "resolving", liveAttempt: resolverAttempt() }),
        ticket("04", { status: "done", mergeState: "queued" }),
        ticket("05", { status: "done", mergeState: "queued" }),
        ticket("06", { status: "done" }),
        ticket("07", {
          status: "in-progress",
          liveAttempt: { attempt: 1, paneId: "p7", role: "agent", startedAt: RESOLVER_START },
        }),
      ],
      mergeQueue: [
        { ticketId: "02", state: "resolving" },
        { ticketId: "04", state: "queued" },
        { ticketId: "05", state: "queued" },
      ],
    },
  });
  const cardOf = (id: string): TicketCardView | undefined =>
    projectPool(snap, {}, {}, {}, RESOLVER_NOW).cards.find(
      (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === id,
    );

  it("carries the engine's state onto the card and the Detail; a plain done ticket carries none", () => {
    expect(cardOf("02")?.mergeState).toBe("resolving");
    expect(cardOf("04")?.mergeState).toBe("queued");
    expect(cardOf("06")?.mergeState).toBeNull();
    const detail = detailOf(snap, "ticket:04");
    expect(detail?.kind === "ticket" && detail.mergeState).toBe("queued");
  });

  it("marks the resolver on the card and the Detail, with its elapsed time, and never an agent", () => {
    expect(cardOf("02")?.resolver).toEqual({
      attempt: 3,
      paneId: "w2A:pE",
      startedAt: RESOLVER_START,
      elapsed: "10m 5s",
    });
    expect(cardOf("07")?.resolver).toBeNull();
    expect(cardOf("04")?.resolver).toBeNull();
    const detail = projectDetail(projectPool(snap, {}, {}, {}, RESOLVER_NOW).cards, "ticket:02");
    expect(detail?.kind === "ticket" && detail.resolver?.elapsed).toBe("10m 5s");
  });

  it("shows a done card's Vitals while its resolver runs, with the time it has been running", () => {
    const view = projectPool(snap, {}, { "02": vitalsState({ running: true }) }, {}, RESOLVER_NOW);
    const card = view.cards.find(
      (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === "02",
    );
    expect(card?.vitals?.mode).toBe("live");
    expect(card?.vitals?.elapsed).toBe("resolving 10m 5s");
  });

  it("names the head and the tickets behind it in the header line while the hold stands", () => {
    expect(projectPool(snap, {}, {}, {}, RESOLVER_NOW).mergeQueueLine).toBe(
      "merge hold: 02 resolving (10m) · 04, 05 queued",
    );
  });

  it("words the header by what the head waits on, and hides it when nothing is held", () => {
    const line = (mergeQueue: EnrichedSnapshot["state"]["mergeQueue"]) =>
      projectPool(snapshot({ state: { mergeQueue } }), {}, {}, {}, RESOLVER_NOW).mergeQueueLine;
    expect(
      line([
        { ticketId: "02", state: "awaiting-approval" },
        { ticketId: "04", state: "needs-you" },
        { ticketId: "05", state: "queued" },
      ]),
    ).toBe("merge hold: 02 awaiting approval · 04 needs you · 05 queued");
    expect(
      line([
        { ticketId: "02", state: "stalled" },
        { ticketId: "03", state: "stalled" },
      ]),
    ).toBe("merge hold: 02, 03 stalled, nothing running");
    // A resolver not yet live (the engine is launching it) has no time yet.
    expect(line([{ ticketId: "09", state: "resolving" }])).toBe("merge hold: 09 resolving");
    expect(line([])).toBeNull();
  });
});

describe("resolverFiles", () => {
  it("reads the conflicted files off the resolver event of the resolver's attempt", () => {
    const timeline = projectTimeline(
      {
        events: [
          { at: RESOLVER_START, attempt: 2, kind: "merge-conflict", payload: { files: ["a.ts"] } },
          { at: RESOLVER_START, attempt: 3, kind: "resolver", payload: { files: ["a.ts", "b.ts"], cwd: "/w", branch: "pool/02" } },
          { at: RESOLVER_START, attempt: 3, kind: "spawned", payload: {} },
        ],
        attempts: [],
        reconstructed: false,
        spec: "",
      },
      "done",
    );
    expect(resolverFiles(timeline, 3)).toEqual(["a.ts", "b.ts"]);
    expect(resolverFiles(timeline, 4)).toEqual([]);
    expect(resolverFiles(null, 3)).toEqual([]);
  });
});

describe("poolDisplayName and poolTabTitle (issue #100)", () => {
  it("names the pool by its title, falling back to the directory", () => {
    expect(poolDisplayName(snapshot({ poolTitle: "Jev as the grader" }))).toBe(
      "Jev as the grader",
    );
    expect(poolDisplayName(snapshot())).toBe("repo/pool");
  });

  it("puts the pool before its status in the browser tab", () => {
    expect(poolTabTitle("Jev as the grader", { word: "running", color: "#d29922" })).toBe(
      "Jev as the grader — running",
    );
  });
});

describe("poolStatus", () => {
  it("needs input in red when any interrupt is pending, whatever the phase", () => {
    const interrupts = [{ ticketId: "a", kind: "checkpoint" as const, body: "" }];
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
          queued("a", "checkpoint"),
          queued("b", "checkpoint"),
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
        queuedAnswers: [queued("a", "checkpoint")],
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

  it("dead in red as the terminal state, outranking pending interrupts", () => {
    expect(poolStatus(snapshot({ phase: "dead" }))).toEqual({
      word: "dead",
      color: "#f85149",
    });
    const snap = snapshot({
      phase: "dead",
      state: { interrupts: [{ ticketId: "a", kind: "checkpoint", body: "" }] },
    });
    expect(poolStatus(snap)).toEqual({ word: "dead", color: "#f85149" });
  });

  it("stopped in the idle grey, terminal like dead (issue #97)", () => {
    expect(poolStatus(snapshot({ phase: "stopped" }))).toEqual({
      word: "stopped",
      color: "#8b949e",
    });
    // Nothing can answer an interrupt once the server has stopped, so the
    // stop outranks needs input the way dead does.
    const snap = snapshot({
      phase: "stopped",
      state: { interrupts: [{ ticketId: "a", kind: "checkpoint", body: "" }] },
    });
    expect(poolStatus(snap)).toEqual({ word: "stopped", color: "#8b949e" });
  });
});

describe("projectTimeline", () => {
  function event(
    attempt: number,
    kind: TicketEventKind,
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
  });

  it("decodes each row's time label, grade, and reassignment", () => {
    const view = projectTimeline(
      response([
        event(1, "graded", { score: 8, verdict: "pass", reasons: "clean diff" }),
        event(1, "reassigned", {
          from: { harness: "claude", model: null },
          to: { harness: "kimi", model: "k3" },
        }),
        event(1, "spawned"),
        event(1, "reassigned", {
          from: { harness: "claude", model: "opus" },
          to: { harness: "claude", model: "opus", effort: "max" },
        }),
      ]),
      "done",
    );
    const [graded, reassigned, spawned, effortMoved] = view.attempts[0].events;
    // An effort is named only on a side that has one.
    expect(effortMoved.reassignment).toBe(
      "reassigned: claude / opus → claude / opus / effort max",
    );
    expect(graded.grade).toEqual({ score: 8, verdict: "pass", reasons: "clean diff" });
    expect(graded.timeLabel.length).toBeGreaterThan(0);
    expect(reassigned.reassignment).toBe(
      "reassigned: claude / unassigned → kimi / k3",
    );
    expect(spawned.grade).toBeNull();
    expect(spawned.reassignment).toBeNull();
  });

  it("words the Held spawn events as one line each (issue #149)", () => {
    const view = projectTimeline(
      response([
        event(1, "spawn-held", {
          held: [
            { id: "held-1", title: "Fix the login test", reason: "per-run" },
            { id: "held-2", title: "Write the docs", reason: "per-run" },
          ],
        }),
        event(1, "spawn-held", {
          held: [{ id: "held-3", title: "Old one", reason: "per-attempt" }],
          recovered: true,
        }),
        event(1, "spawn-adopted", {
          adopted: ["03-spawn-1"],
          fromHeld: "held-1",
          blocks: { "03-spawn-1": ["04", "05"] },
        }),
        event(1, "spawn-adopted", { adopted: ["03-spawn-2", "03-spawn-3"] }),
        event(1, "spawn-adopted", { adopted: [], truncated: 1 }),
        event(1, "spawn-discarded", { id: "held-2", title: "Write the docs" }),
        event(1, "spawn-rejected", {
          title: "Fix the login test",
          reason: "blocker 09 is gone",
          fromHeld: "held-1",
        }),
        event(1, "spawn-rejected", { reason: "no title", index: 2 }),
        event(1, "spawned"),
      ]),
      "done",
    );
    expect(view.attempts[0].events.map((e) => e.spawn)).toEqual([
      "2 spawns held (per-run cap): 'Fix the login test', 'Write the docs'",
      "1 spawn held (per-attempt cap, recovered at boot): 'Old one'",
      "adopted 03-spawn-1 from held-1 · 03-spawn-1 blocks 04, 05",
      "adopted 03-spawn-2, 03-spawn-3",
      "adopted none · 1 truncated by the cap",
      "held spawn 'Write the docs' discarded",
      "adopting held spawn 'Fix the login test' refused: blocker 09 is gone; still held",
      null,
      null,
    ]);
  });

  it("words the Pending spawn events and the new hold reasons (issue #150)", () => {
    const view = projectTimeline(
      response([
        event(1, "spawn-pending", {
          pending: [
            { id: "proposal-1", title: "Fix the login test" },
            { id: "proposal-2", title: "Write the docs" },
          ],
        }),
        event(1, "spawn-held", {
          held: [{ id: "proposal-3", title: "Again", reason: "overlaps", overlaps: ["02", "proposal-1"] }],
        }),
        event(1, "spawn-held", {
          held: [{ id: "proposal-2", title: "Write the docs", reason: "operator" }],
        }),
        event(1, "spawn-held", {
          held: [
            {
              id: "proposal-6",
              title: "Late",
              reason: "refused",
              refusal: "blocks names done tickets: 04",
            },
          ],
        }),
        event(1, "spawn-held", {
          held: [
            { id: "proposal-7", title: "Maybe", reason: "overlaps", overlaps: ["99"], unknownOverlaps: ["99"] },
          ],
        }),
        event(1, "spawn-adopted", {
          adopted: ["03-spawn-1"],
          fromPending: ["proposal-1"],
          blocks: { "03-spawn-1": ["04"] },
        }),
        event(1, "spawn-discarded", { id: "proposal-4", title: "Stale", pending: true }),
        event(1, "spawn-rejected", {
          title: "Late",
          reason: "blockedBy names tickets outside the pool: 09",
          fromPending: "proposal-5",
        }),
      ]),
      "done",
    );
    expect(view.attempts[0].events.map((e) => e.spawn)).toEqual([
      "2 spawns pending for the next boundary: 'Fix the login test', 'Write the docs'",
      "1 spawn held (overlaps 02, proposal-1): 'Again'",
      "1 spawn held (held by operator): 'Write the docs'",
      "1 spawn held (refused at landing: blocks names done tickets: 04): 'Late'",
      "1 spawn held (overlaps 99 (99 not in the pool)): 'Maybe'",
      "landed 03-spawn-1 from proposal-1 · 03-spawn-1 blocks 04",
      "pending spawn 'Stale' discarded",
      "pending spawn 'Late' rejected at the boundary: blockedBy names tickets outside the pool: 09",
    ]);
  });

  it("names both caps when one boundary held spawns under each", () => {
    const view = projectTimeline(
      response([
        event(1, "spawn-held", {
          held: [
            { id: "held-1", title: "A", reason: "per-attempt" },
            { id: "held-2", title: "B", reason: "per-run" },
          ],
        }),
        event(1, "spawn-held", { held: "nonsense" }),
      ]),
      "done",
    );
    const [both, torn] = view.attempts[0].events;
    expect(both.spawn).toBe("2 spawns held (per-attempt cap, per-run cap): 'A', 'B'");
    expect(torn.spawn).toBeNull();
  });

  it("carries a Jev Grade's provenance through to the Detail's grade", () => {
    const view = projectTimeline(
      response([
        event(1, "graded", {
          score: 9.4,
          verdict: "pass",
          reasons: "ticket fit: all criteria met.",
          rubric: "jev-grader-rubric/2026-09-20.1",
          model: "jev-latest",
          evidenceBudget: "base",
        }),
      ]),
      "done",
    );
    const [graded] = view.attempts[0].events;
    expect(graded.grade).toEqual({
      score: 9.4,
      verdict: "pass",
      reasons: "ticket fit: all criteria met.",
      rubric: "jev-grader-rubric/2026-09-20.1",
      model: "jev-latest",
      evidenceBudget: "base",
    });
    // A mistyped provenance field is left off, never a torn-grade failure.
    const partial = projectTimeline(
      response([
        event(1, "graded", {
          score: 8,
          verdict: "flag",
          reasons: "reasons",
          rubric: 42,
          evidenceBudget: "huge",
        }),
      ]),
      "done",
    );
    expect(partial.attempts[0].events[0]!.grade).toEqual({
      score: 8,
      verdict: "flag",
      reasons: "reasons",
    });
  });

  it("still decodes an agent Grade with no provenance", () => {
    const view = projectTimeline(
      response([
        event(1, "graded", { score: 8, verdict: "pass", reasons: "clean diff" }),
      ]),
      "done",
    );
    const [graded] = view.attempts[0].events;
    expect(graded.grade).toEqual({ score: 8, verdict: "pass", reasons: "clean diff" });
  });

  it("leaves a torn payload undecoded, so the plain event row still shows", () => {
    const view = projectTimeline(
      response([
        event(1, "graded", { score: "eight" }),
        event(1, "reassigned", { from: 42 }),
      ]),
      "done",
    );
    const [graded, reassigned] = view.attempts[0].events;
    expect(graded.grade).toBeNull();
    expect(reassigned.reassignment).toBeNull();
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
      streamFile: null,
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

describe("joinStreamFiles", () => {
  function eventRow(attempt: number): TicketEvent {
    return { at: "2026-01-01T00:00:00.000Z", attempt, kind: "spawned", payload: {} };
  }

  it("joins each attempt's stream file from the listing by attempt number", () => {
    const timeline = projectTimeline(
      {
        events: [eventRow(1), eventRow(2), eventRow(3)],
        attempts: [],
        reconstructed: false,
        spec: "the spec",
      },
      "done",
    );
    const joined = joinStreamFiles(timeline, [
      { attempt: 1, streamFile: "01.attempt-1.stream.jsonl" },
      { attempt: 2, streamFile: null },
      { attempt: 3, streamFile: "01.stream.jsonl" },
    ]);
    expect(joined.attempts.map((a) => a.streamFile)).toEqual([
      "01.attempt-1.stream.jsonl",
      null,
      "01.stream.jsonl",
    ]);
    // The join touches nothing else: numbers, events and running stay put.
    expect(joined.attempts.map((a) => a.number)).toEqual([1, 2, 3]);
  });

  it("surfaces no link for a non-streamed attempt: null in, null out", () => {
    const timeline = projectTimeline(
      { events: [eventRow(1)], attempts: [], reconstructed: false, spec: "s" },
      "done",
    );
    const joined = joinStreamFiles(timeline, [
      { attempt: 1, streamFile: null },
    ]);
    expect(joined.attempts[0].streamFile).toBeNull();
  });

  it("leaves rows the listing does not mention unlinked until it lands", () => {
    const timeline = projectTimeline(
      { events: [eventRow(1), eventRow(2)], attempts: [], reconstructed: false, spec: "s" },
      "done",
    );
    const joined = joinStreamFiles(timeline, [
      { attempt: 2, streamFile: "02.stream.jsonl" },
    ]);
    expect(joined.attempts[0].streamFile).toBeNull();
    expect(joined.attempts[1].streamFile).toBe("02.stream.jsonl");
  });

  it("keeps the timeline as it is while the pane has answered nothing", () => {
    const timeline = projectTimeline(
      { events: [eventRow(1)], attempts: [], reconstructed: false, spec: "s" },
      "done",
    );
    expect(joinStreamFiles(timeline, null)).toEqual(timeline);
  });

  it("keeps a reconstructed row's log file while nulling its stream link", () => {
    const timeline = projectTimeline(
      {
        events: [],
        attempts: [
          { attempt: 1, logFile: "01.log", modifiedAt: "2026-01-01T00:00:00.000Z" },
        ],
        reconstructed: true,
        spec: "the spec",
      },
      "done",
    );
    const joined = joinStreamFiles(timeline, [
      { attempt: 1, streamFile: null },
    ]);
    expect(joined.attempts[0]).toEqual({
      number: 1,
      events: [],
      reconstructed: true,
      running: false,
      logFile: "01.log",
      streamFile: null,
    });
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
      streamFile: null,
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
      { content: "the log", stream: false, firstOffset: 0, offset: 50, totalSize: 100 },
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
      { content: "all", stream: false, firstOffset: 0, offset: 100, totalSize: 100 },
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
      { content: "all", stream: false, firstOffset: 0, offset: 3, totalSize: 3 },
      null,
    );
    expect(atHead?.hasEarlier).toBe(false);
    const midFile = projectLogPane(
      timeline,
      null,
      { content: "tail", stream: false, firstOffset: LOG_TAIL_BYTES, offset: LOG_TAIL_BYTES + 4, totalSize: LOG_TAIL_BYTES + 4 },
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

describe("clampNeedsInputWidth (issue #147)", () => {
  it("never narrows below the tray's original 300px", () => {
    expect(NEEDS_INPUT_MIN_PX).toBe(300);
    expect(clampNeedsInputWidth(120, 900)).toBe(300);
  });

  it("clamps above the canvas column fraction", () => {
    expect(clampNeedsInputWidth(2000, 900)).toBe(900);
  });

  it("passes values inside the range through unchanged", () => {
    expect(clampNeedsInputWidth(480, 900)).toBe(480);
  });

  it("tracks the column bound when the column is too narrow to hold the minimum", () => {
    expect(clampNeedsInputWidth(480, 200)).toBe(200);
  });

  it("keeps the maximum at a fraction of the canvas column", () => {
    expect(NEEDS_INPUT_MAX_FRACTION).toBeCloseTo(0.6);
    expect(clampNeedsInputWidth(100000, Math.round(1200 * NEEDS_INPUT_MAX_FRACTION))).toBe(720);
  });
});

describe("parseStoredNeedsInputWidth (issue #147)", () => {
  it("round-trips a stored width string through a reload", () => {
    expect(parseStoredNeedsInputWidth("480", 900)).toBe(480);
  });

  it("falls back to the default minimum when nothing is stored", () => {
    expect(parseStoredNeedsInputWidth(null, 900)).toBe(NEEDS_INPUT_MIN_PX);
  });

  it("falls back to the minimum for a non-numeric or non-finite stored value", () => {
    expect(parseStoredNeedsInputWidth("wide", 900)).toBe(NEEDS_INPUT_MIN_PX);
    expect(parseStoredNeedsInputWidth("Infinity", 900)).toBe(NEEDS_INPUT_MIN_PX);
  });

  it("clamps a stored width that is out of range on reload", () => {
    expect(parseStoredNeedsInputWidth("10", 900)).toBe(NEEDS_INPUT_MIN_PX);
    expect(parseStoredNeedsInputWidth("5000", 900)).toBe(900);
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
  function flightSnapshot(): EnrichedSnapshot {
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
    const cases: [string, TicketStatus][] = [
      ["R", "ready"],
      ["P", "in-progress"],
      ["C", "checkpoint"],
      ["D", "done"],
    ];
    for (const [id, status] of cases) {
      const selected = nextNodeSelection(null, `ticket:${id}`);
      const detail = selected ? detailOf(snap, selected) : null;
      expect(detail?.kind).toBe("ticket");
      if (detail?.kind === "ticket") expect(detail.status).toBe(status);
    }
  });

  it("keeps a pending interrupt answerable from the Detail's form", () => {
    const detail = detailOf(flightSnapshot(), "ticket:C");
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.interrupt?.body).toBe("the brief");
      expect(detail.interrupt?.form.actions.map((a) => a.action)).toEqual(["resume"]);
    }
  });

  it("keeps the Detail across a snapshot that changes the card's status", () => {
    const selected = nextNodeSelection(null, "ticket:P");
    const next = snapshot({
      state: {
        tickets: [ticket("P", { status: "done" })],
        log: [],
        outcomes: { P: { status: "done", summary: "did P", commitSha: "sha-p" } },
        interrupts: [],
        config: {},
      },
    });
    const detail = selected ? detailOf(next, selected) : null;
    expect(detail?.kind).toBe("ticket");
    if (detail?.kind === "ticket") {
      expect(detail.status).toBe("done");
      expect(detail.outcome?.summary).toBe("did P");
    }
  });

  it("closes the Detail gracefully when the selected card has left the pool", () => {
    const selected = nextNodeSelection(null, "ticket:R");
    expect(selected && detailOf(flightSnapshot(), selected)).not.toBeNull();
    const gone = snapshot({
      state: {
        tickets: [ticket("P")],
        log: [],
        outcomes: {},
        interrupts: [],
        config: {},
      },
    });
    expect(selected && detailOf(gone, selected)).toBeNull();
  });
});

// -------------------------------------------------------------------------
// Vitals: the card footer's liveness readout
// -------------------------------------------------------------------------

const VITALS_NOW = Date.parse("2026-09-04T12:00:00.000Z");

function activity(
  overrides: Partial<TicketActivityResponse> = {},
): TicketActivityResponse {
  return {
    ticketId: "01",
    running: true,
    diff: { added: 128, removed: 34, files: ["a", "b", "c", "d", "e", "f"] },
    log: { size: 4096, mtime: new Date(VITALS_NOW - 12_000).toISOString() },
    lastEventAt: new Date(VITALS_NOW - 4_000).toISOString(),
    ...overrides,
  };
}

function vitalsState(
  overrides: Partial<TicketActivityResponse> = {},
  samples: number[] = [],
): VitalsState {
  return { activity: activity(overrides), samples };
}

describe("projectVitals", () => {
  it("is hidden before the first payload arrives, whatever the status", () => {
    for (const status of ["ready", "in-progress", "checkpoint", "done"] as TicketStatus[]) {
      expect(projectVitals(null, status, VITALS_NOW)).toBeNull();
    }
  });

  it("is hidden for done and ready tickets even with a payload", () => {
    expect(projectVitals(vitalsState(), "done", VITALS_NOW)).toBeNull();
    expect(projectVitals(vitalsState(), "ready", VITALS_NOW)).toBeNull();
  });

  it("is live for a running attempt, on in-progress and checkpoint alike", () => {
    expect(projectVitals(vitalsState(), "in-progress", VITALS_NOW)?.mode).toBe("live");
    // A checkpoint with a resolver in flight reports running on the wire.
    expect(projectVitals(vitalsState(), "checkpoint", VITALS_NOW)?.mode).toBe("live");
  });

  it("is frozen for a checkpoint whose latest response says nothing is live", () => {
    const view = projectVitals(vitalsState({ running: false }), "checkpoint", VITALS_NOW);
    expect(view?.mode).toBe("frozen");
    expect(view?.diff).toEqual({ added: 128, removed: 34, fileCount: 6 });
  });

  it("is hidden for an in-progress ticket that is not running (a crashed attempt)", () => {
    expect(
      projectVitals(vitalsState({ running: false }), "in-progress", VITALS_NOW),
    ).toBeNull();
  });

  it("shows diff totals, or the no-changes state for an empty diff", () => {
    const view = projectVitals(vitalsState(), "in-progress", VITALS_NOW);
    expect(view?.diff).toEqual({ added: 128, removed: 34, fileCount: 6 });
    expect(
      projectVitals(vitalsState({ diff: null }), "in-progress", VITALS_NOW)?.diff,
    ).toBeNull();
    expect(
      projectVitals(
        vitalsState({ diff: { added: 0, removed: 0, files: [] } }),
        "in-progress",
        VITALS_NOW,
      )?.diff,
    ).toBeNull();
  });

  it("anchors staleness to the newest of the last engine event and the log write", () => {
    // The event is newest in the default fixture.
    expect(projectVitals(vitalsState(), "in-progress", VITALS_NOW)?.staleness).toEqual({
      kind: "changed",
      fresh: true,
      copy: "changed 4s ago",
    });
    // The log write overtakes it.
    const logNewest = vitalsState({
      log: { size: 4096, mtime: new Date(VITALS_NOW - 2_000).toISOString() },
    });
    expect(projectVitals(logNewest, "in-progress", VITALS_NOW)?.staleness).toEqual({
      kind: "output",
      fresh: true,
      copy: "output 2s ago",
    });
  });

  it("marks the readout fresh only under the 10s threshold", () => {
    const freshAt = (age: number): boolean | undefined =>
      projectVitals(
        vitalsState({ lastEventAt: new Date(VITALS_NOW - age).toISOString(), log: null }),
        "in-progress",
        VITALS_NOW,
      )?.staleness?.fresh;
    expect(freshAt(VITALS_FRESH_MS - 1)).toBe(true);
    expect(freshAt(VITALS_FRESH_MS)).toBe(false);
  });

  it("switches to idle past the 60s threshold", () => {
    const staleAt = (age: number) =>
      projectVitals(
        vitalsState({ lastEventAt: new Date(VITALS_NOW - age).toISOString(), log: null }),
        "in-progress",
        VITALS_NOW,
      )?.staleness;
    expect(staleAt(VITALS_IDLE_MS)).toEqual({
      kind: "changed",
      fresh: false,
      copy: "changed 1m 0s ago",
    });
    expect(staleAt(VITALS_IDLE_MS + 1)).toEqual({
      kind: "idle",
      fresh: false,
      copy: "idle 1m 0s",
    });
    expect(staleAt(125_000)).toEqual({ kind: "idle", fresh: false, copy: "idle 2m 5s" });
  });

  it("serves paused copy on a frozen card and never idles it", () => {
    const frozen = (age: number): VitalsState =>
      vitalsState({
        running: false,
        lastEventAt: new Date(VITALS_NOW - age).toISOString(),
        log: null,
      });
    expect(projectVitals(frozen(180_000), "checkpoint", VITALS_NOW)?.staleness).toEqual({
      kind: "changed",
      fresh: false,
      copy: "paused · changed 3m 0s ago",
    });
    expect(projectVitals(frozen(600_000), "checkpoint", VITALS_NOW)?.staleness?.copy).toBe(
      "paused · changed 10m 0s ago",
    );
  });

  it("drops an unparseable anchor and hides the readout when none is usable", () => {
    expect(
      projectVitals(vitalsState({ lastEventAt: "not-a-date" }), "in-progress", VITALS_NOW)
        ?.staleness?.kind,
    ).toBe("output");
    expect(
      projectVitals(vitalsState({ lastEventAt: null, log: null }), "in-progress", VITALS_NOW)
        ?.staleness,
    ).toBeNull();
  });
});

describe("pushVitalsSample", () => {
  it("pushes one sample per poll and caps at the last 40", () => {
    let samples: number[] = [];
    for (let total = 1; total <= VITALS_MAX_SAMPLES + 5; total += 1) {
      samples = pushVitalsSample(samples, total);
    }
    expect(samples).toHaveLength(VITALS_MAX_SAMPLES);
    expect(samples[0]).toBe(6);
    expect(samples[VITALS_MAX_SAMPLES - 1]).toBe(VITALS_MAX_SAMPLES + 5);
  });
});

describe("projectPool vitals", () => {
  it("rides the card view model: live on a running card, frozen on a parked checkpoint, absent elsewhere", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("01", { status: "in-progress" }),
          ticket("02", { status: "checkpoint" }),
          ticket("03", { status: "done" }),
          ticket("04"),
        ],
      },
    });
    const vitals: Record<string, VitalsState> = {
      "01": vitalsState({}, [10, 20]),
      "02": vitalsState({ running: false }, [5]),
    };
    const view = projectPool(snap, {}, vitals, {}, VITALS_NOW);
    const cardOf = (id: string) =>
      view.cards.find(
        (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === id,
      );
    expect(cardOf("01")?.vitals?.mode).toBe("live");
    expect(cardOf("01")?.vitals?.samples).toEqual([10, 20]);
    expect(cardOf("02")?.vitals?.mode).toBe("frozen");
    // Done and never-polled cards carry no footer at all: no empty flash.
    expect(cardOf("03")?.vitals).toBeNull();
    expect(cardOf("04")?.vitals).toBeNull();
  });
});

describe("projectPool enlisted attempt", () => {
  it("shows an enlisted card as found, live, with the found directory's diff", () => {
    const snap = snapshot({
      state: {
        tickets: [
          ticket("enlist-1", {
            status: "in-progress",
            enlisted: true,
            liveAttempt: agentAttempt(1, "pane-op"),
            assignment: { harness: "opencode", model: null, drivers: "implement" },
          }),
        ],
      },
    });
    const view = projectPool(
      snap,
      {},
      { "enlist-1": vitalsState({}, [12, 20]) },
      {},
      VITALS_NOW,
    );
    const card = view.cards.find(
      (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === "enlist-1",
    );
    expect(card?.enlisted).toBe(true);
    // "As found": the harness herdr reported, no model.
    expect(card?.assignment).toEqual({
      harness: "opencode",
      model: null,
      drivers: "implement",
    });
    expect(card?.paneId).toBe("pane-op");
    expect(card?.vitals?.mode).toBe("live");
    expect(card?.vitals?.diff).toEqual({ added: 128, removed: 34, fileCount: 6 });
    expect(card?.vitals?.samples).toEqual([12, 20]);
  });

  it("projects an enlisted attempt's lifecycle events into the timeline", () => {
    const view = projectTimeline(
      {
        events: [
          { at: "2026-01-01T00:00:00.000Z", attempt: 1, kind: "scheduled", payload: {} },
          { at: "2026-01-01T00:00:01.000Z", attempt: 1, kind: "spawned", payload: { pane_id: "pane-op" } },
          { at: "2026-01-01T00:00:02.000Z", attempt: 1, kind: "exited", payload: { code: 0, status: "done" } },
          { at: "2026-01-01T00:00:03.000Z", attempt: 1, kind: "merged", payload: {} },
        ],
        attempts: [],
        reconstructed: false,
        spec: "the spec",
      },
      "done",
    );
    expect(view.attempts).toHaveLength(1);
    expect(view.attempts[0].events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "merged",
    ]);
  });
});

describe("projectPool paneId", () => {
  it("carries paneId to the card for terminal-backed attempts and null for headless ones", () => {
    const snap = snapshot({
      state: {
        tickets: [
          // The enriched snapshot serves paneId only on terminal-backed
          // attempts; headless tickets lack the field entirely.
          ticket("01", { status: "in-progress", liveAttempt: agentAttempt(1, "pane-7") }),
          ticket("02", { status: "in-progress" }),
        ],
      },
    });
    const view = projectPool(snap, {}, {}, {}, VITALS_NOW);
    const cardOf = (id: string) =>
      view.cards.find(
        (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === id,
      );
    expect(cardOf("01")?.paneId).toBe("pane-7");
    expect(cardOf("02")?.paneId).toBeNull();
  });
});

describe("projectPool terminal surface", () => {
  const terminalSnap = (tickets: EnrichedTicketState[]) =>
    snapshot({ state: { tickets } });
  const cardOf = (view: ReturnType<typeof projectPool>, id: string) =>
    view.cards.find(
      (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === id,
    );

  it("gives a terminal-backed card the surface, pending before the first peek", () => {
    const snap = terminalSnap([
      // The enriched snapshot serves paneId only on terminal-backed running
      // attempts; the surface appears with it.
      ticket("01", { status: "in-progress", liveAttempt: agentAttempt(1, "pane-7") }),
      ticket("02", { status: "in-progress" }),
    ]);
    const view = projectPool(snap, {}, {}, {});
    expect(cardOf(view, "01")?.terminal).toEqual({
      paneId: "pane-7",
      status: "pending",
      text: "",
      justFocused: false,
    });
    // Headless cards never show the surface.
    expect(cardOf(view, "02")?.terminal).toBeNull();
  });

  it("threads the store's peek text and focus confirmation into the surface", () => {
    const snap = terminalSnap([
      ticket("01", { status: "in-progress", liveAttempt: agentAttempt(1, "pane-7") }),
    ]);
    const terminal: Record<string, TerminalSurfaceView> = {
      "01": { paneId: "pane-7", status: "live", text: "output", justFocused: true },
    };
    const view = projectPool(snap, {}, {}, terminal);
    expect(cardOf(view, "01")?.terminal).toEqual({
      paneId: "pane-7",
      status: "live",
      text: "output",
      justFocused: true,
    });
  });

  it("keeps finished and headless cards untouched even with a stale store entry", () => {
    const snap = terminalSnap([
      // A finished attempt no longer carries a paneId, so the surface is
      // gone even though the store still holds the entry.
      ticket("01", { status: "done" }),
      ticket("02", { status: "in-progress" }),
    ]);
    const terminal: Record<string, TerminalSurfaceView> = {
      "01": { paneId: "pane-7", status: "live", text: "output", justFocused: false },
    };
    const view = projectPool(snap, {}, {}, terminal);
    expect(cardOf(view, "01")?.terminal).toBeNull();
    expect(cardOf(view, "02")?.terminal).toBeNull();
  });
});

describe("Held pane and Keep talking (issue #139)", () => {
  // A ticket waiting at a checkpoint whose Terminal-backed attempt's pane is
  // still alive: no Live attempt (the attempt is over), a Held pane instead.
  const heldTicket = (id: string, attempt = 2, paneId = "pane-9") =>
    ticket(id, { status: "checkpoint", heldPane: { attempt, paneId } });
  const cardOf = (view: ReturnType<typeof projectPool>, id: string) =>
    view.cards.find(
      (c): c is TicketCardView => c.kind === "ticket" && c.ticketId === id,
    );
  const checkpointOn = (id: string) => ({ ticketId: id, kind: "checkpoint" as const, body: "brief" });

  it("gives a Held pane the card's terminal surface and pane id, as a running attempt's", () => {
    const view = projectPool(
      snapshot({
        state: { tickets: [heldTicket("A")], interrupts: [checkpointOn("A")] },
      }),
    );
    expect(cardOf(view, "A")?.paneId).toBe("pane-9");
    expect(cardOf(view, "A")?.terminal).toEqual({
      paneId: "pane-9",
      status: "pending",
      text: "",
      justFocused: false,
    });
  });

  it("gives a Held pane's row the terminal pitch, so the surface fits", () => {
    const tickets = [heldTicket("A"), ticket("B", { blockedBy: ["A"] })];
    const view = projectPool(snapshot({ state: { tickets } }));
    const rowY = (id: string) => view.cards.find((c) => c.id === id)!.y;
    expect(rowY("ticket:B") - rowY("ticket:A")).toBe(LAYOUT.terminalRowH);
  });

  it("offers Keep talking on a checkpoint with a Held pane, beside the unchanged resume form", () => {
    const view = projectPool(
      snapshot({
        state: { tickets: [heldTicket("A")], interrupts: [checkpointOn("A")] },
      }),
    );
    const interrupt = cardOf(view, "A")?.interrupt;
    expect(interrupt?.keepTalking).toEqual({ requesting: false, failure: null });
    // Not an answer: the form's actions (and so "resume all") stay Resume alone.
    expect(interrupt?.form.actions.map((a) => a.action)).toEqual(["resume"]);
  });

  it("offers it on no other interrupt kind, even with a Held pane", () => {
    const kinds = INTERRUPT_KINDS.filter((kind) => kind !== "checkpoint");
    const view = projectPool(
      snapshot({
        state: {
          tickets: kinds.map((kind) => heldTicket(`T-${kind}`)),
          interrupts: kinds.map((kind) => ({ ticketId: `T-${kind}`, kind, body: "" })),
        },
      }),
    );
    for (const kind of kinds) {
      expect(cardOf(view, `T-${kind}`)?.interrupt?.keepTalking).toBeNull();
    }
  });

  it("does not offer it on a checkpoint whose pane is headless or gone", () => {
    const view = projectPool(
      snapshot({
        state: {
          tickets: [ticket("A", { status: "checkpoint" })],
          interrupts: [checkpointOn("A")],
        },
      }),
    );
    expect(cardOf(view, "A")?.interrupt?.keepTalking).toBeNull();
    expect(cardOf(view, "A")?.terminal).toBeNull();
  });

  it("withdraws it once the checkpoint's answer is queued", () => {
    const view = projectPool(
      snapshot({
        state: {
          tickets: [heldTicket("A")],
          interrupts: [checkpointOn("A")],
          queuedAnswers: [
            { seq: 1, ticketId: "A", kind: "checkpoint", at: "2026-09-12T10:00:00Z", processedAt: null },
          ],
        },
      }),
    );
    expect(cardOf(view, "A")?.interrupt?.keepTalking).toBeNull();
  });

  it("carries the same offer into the Detail and the Needs input row", () => {
    const view = projectPool(
      snapshot({
        state: { tickets: [heldTicket("A")], interrupts: [checkpointOn("A")] },
      }),
    );
    const detail = projectDetail(view.cards, "ticket:A");
    const [row] = projectNeedsInput(view.cards);
    expect(detail?.kind === "ticket" ? detail.interrupt?.keepTalking : undefined).toEqual({
      requesting: false,
      failure: null,
    });
    expect(row?.interrupt.keepTalking).toEqual({ requesting: false, failure: null });
  });

  it("threads the session's mark for this Held pane, and ignores one left from an earlier checkpoint", () => {
    const snap = snapshot({
      state: {
        tickets: [heldTicket("A", 2), heldTicket("B", 3)],
        interrupts: [checkpointOn("A"), checkpointOn("B")],
      },
    });
    const view = projectPool(snap, {}, {}, {}, VITALS_NOW, {}, {
      A: { attempt: 2, requesting: false, failure: "the pane is gone" },
      // Asked of attempt 1's pane; B now holds attempt 3's.
      B: { attempt: 1, requesting: true, failure: null },
    });
    expect(cardOf(view, "A")?.interrupt?.keepTalking).toEqual({
      requesting: false,
      failure: "the pane is gone",
    });
    expect(cardOf(view, "B")?.interrupt?.keepTalking).toEqual({
      requesting: false,
      failure: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Conversations (issue #60)
// ---------------------------------------------------------------------------

describe("conversation idle age", () => {
  const now = Date.parse("2026-09-10T12:00:00.000Z");

  // The card's idle age readout, projected from the Turn's idleSince.
  function idleAge(idleSince: string | null): string | null {
    const view = projectPool(
      snapshot({
        state: {
          conversations: [
            conversation("conv-1", {
              turn: { state: "waiting", lastLine: "", idleSince },
            }),
          ],
        },
      }),
      {},
      {},
      {},
      now,
    );
    const card = view.cards.find((c) => c.id === "conversation:conv-1");
    return card?.kind === "conversation" ? card.idleAge : null;
  }

  it("is null while there is no idleSince (still working)", () => {
    expect(idleAge(null)).toBeNull();
  });

  it("is null for an unparseable timestamp", () => {
    expect(idleAge("not a date")).toBeNull();
  });

  it("renders seconds, minutes, and hours+minutes at the right scale", () => {
    expect(idleAge(new Date(now - 45_000).toISOString())).toBe("45s");
    expect(idleAge(new Date(now - 4 * 60_000).toISOString())).toBe("4m");
    expect(idleAge(new Date(now - (72 * 60_000)).toISOString())).toBe("1h 12m");
  });
});

describe("projectPool with Conversations", () => {
  it("lists Conversations right after START, ahead of every ticket", () => {
    const snap = snapshot({
      state: {
        tickets: [ticket("A")],
        conversations: [conversation("conv-1"), conversation("conv-2")],
      },
    });
    const view = projectPool(snap);
    expect(view.cards.map((c) => c.id)).toEqual([
      START_CARD_ID,
      "conversation:conv-1",
      "conversation:conv-2",
      "ticket:A",
      REVIEW_CARD_ID,
    ]);
  });

  it("projects a Conversation card's facts, terminal surface, and End view", () => {
    const snap = snapshot({
      state: {
        tickets: [],
        conversations: [
          conversation("conv-1", {
            title: "plan the migration",
            paneId: "pane-9",
            branch: "conv/conv-1",
            spawnedBy: null,
            turn: { state: "waiting", lastLine: "what next?", idleSince: null },
          }),
        ],
      },
    });
    const terminal = {
      "conv-1": { paneId: "pane-9", status: "live" as const, text: "hi", justFocused: false },
    };
    const endings = { "conv-1": { ending: true, failure: null } };
    const view = projectPool(snap, {}, {}, terminal, Date.now(), endings);
    const card = view.cards.find(
      (c): c is ConversationCardView => c.kind === "conversation",
    );
    expect(card?.conversationId).toBe("conv-1");
    expect(card?.title).toBe("plan the migration");
    expect(card?.branch).toBe("conv/conv-1");
    expect(card?.turn).toEqual({ state: "waiting", lastLine: "what next?", idleSince: null });
    expect(card?.terminal).toEqual({
      paneId: "pane-9",
      status: "live",
      text: "hi",
      justFocused: false,
    });
    expect(card?.endView).toEqual({ ending: true, failure: null });
  });

  it("keeps ticket rows untouched with no Conversations (backward-compatible snapshot)", () => {
    const snap = snapshot({ state: { tickets: [ticket("A")] } });
    const view = projectPool(snap);
    expect(view.cards.map((c) => c.id)).toEqual([START_CARD_ID, "ticket:A", REVIEW_CARD_ID]);
  });
});

describe("layout: a row's pitch fits its tallest card", () => {
  const rowY = (view: ReturnType<typeof projectPool>, id: string) =>
    view.cards.find((c) => c.id === id)!.y;

  it("keeps the plain row grid for headless tickets (#70)", () => {
    const tickets = [ticket("A"), ticket("B", { blockedBy: ["A"] }), ticket("C", { blockedBy: ["B"] })];
    const view = projectPool(snapshot({ state: { tickets } }));
    expect(rowY(view, "ticket:B") - rowY(view, "ticket:A")).toBe(LAYOUT.rowH);
    expect(rowY(view, "ticket:C") - rowY(view, "ticket:B")).toBe(LAYOUT.rowH);
    expect(rowY(view, REVIEW_CARD_ID)).toBe(LAYOUT.reviewY);
  });

  it("gives a row the terminal pitch while any ticket in it runs a pane-backed attempt", () => {
    const tickets = [
      ticket("A", { status: "in-progress", liveAttempt: agentAttempt(1, "w17:p2") }),
      ticket("A2"),
      ticket("B", { blockedBy: ["A"] }),
      ticket("C", { blockedBy: ["B"] }),
    ];
    const view = projectPool(snapshot({ state: { tickets } }));
    // The depth-0 row holds the pane-backed ticket, so the row below starts
    // a terminal pitch further down; the headless rows below keep rowH.
    expect(rowY(view, "ticket:A2")).toBe(rowY(view, "ticket:A"));
    expect(rowY(view, "ticket:B") - rowY(view, "ticket:A")).toBe(LAYOUT.terminalRowH);
    expect(rowY(view, "ticket:C") - rowY(view, "ticket:B")).toBe(LAYOUT.rowH);
    expect(LAYOUT.terminalRowH).toBeGreaterThan(LAYOUT.rowH);
  });

  it("settles a row back to the plain pitch once its attempt ends", () => {
    const running = projectPool(
      snapshot({
        state: {
          tickets: [ticket("A", { status: "in-progress", liveAttempt: agentAttempt(1, "w17:p2") }), ticket("B", { blockedBy: ["A"] })],
        },
      }),
    );
    const done = projectPool(
      snapshot({
        state: { tickets: [ticket("A", { status: "done" }), ticket("B", { blockedBy: ["A"] })] },
      }),
    );
    expect(rowY(running, "ticket:B") - rowY(running, "ticket:A")).toBe(LAYOUT.terminalRowH);
    expect(rowY(done, "ticket:B") - rowY(done, "ticket:A")).toBe(LAYOUT.rowH);
  });

  it("keeps REVIEW below the last row when tall rows push past its fixed spot", () => {
    const chain: EnrichedTicketState[] = [];
    for (let i = 0; i < 4; i++) {
      chain.push(
        ticket(`T${i}`, {
          status: "in-progress",
          liveAttempt: {
            attempt: 1,
            paneId: `w1:p${i}`,
            role: "agent",
            startedAt: "2026-09-23T10:00:00.000Z",
          },
          blockedBy: i === 0 ? [] : [`T${i - 1}`],
        }),
      );
    }
    const view = projectPool(
      snapshot({ state: { tickets: chain, conversations: [conversation("conv-1")] } }),
    );
    const lastY = rowY(view, "ticket:T3");
    expect(lastY).toBeGreaterThan(LAYOUT.reviewY - LAYOUT.terminalRowH);
    expect(rowY(view, REVIEW_CARD_ID)).toBe(lastY + LAYOUT.terminalRowH);
  });
});

describe("layout: the Conversations lane shifts ticket rows down", () => {
  it("pushes every ticket row down by one lane's worth of height when Conversations exist", () => {
    const without = projectPool(snapshot({ state: { tickets: [ticket("A")] } }));
    const withConvo = projectPool(
      snapshot({
        state: { tickets: [ticket("A")], conversations: [conversation("conv-1")] },
      }),
    );
    const startY = without.cards.find((c) => c.id === START_CARD_ID)!.y;
    const laneY = withConvo.cards.find((c) => c.id === "conversation:conv-1")!.y;
    const ticketYWithout = without.cards.find((c) => c.id === "ticket:A")!.y;
    const ticketYWith = withConvo.cards.find((c) => c.id === "ticket:A")!.y;
    // The lane sits one row below START; every ticket row shifts down by the
    // lane's own height, which is the tall pitch a live Conversation card
    // (terminal peek, End row) needs, not the plain ticket row height.
    expect(laneY - startY).toBe(LAYOUT.rowH);
    expect(ticketYWith - ticketYWithout).toBe(LAYOUT.conversationLaneH);
    expect(ticketYWith - laneY).toBe(LAYOUT.conversationLaneH);
    expect(LAYOUT.conversationLaneH).toBeGreaterThan(LAYOUT.rowH);
  });

  it("lays out multiple Conversations as one centered row, like a ticket depth", () => {
    const view = projectPool(
      snapshot({
        state: {
          tickets: [],
          conversations: [conversation("conv-1"), conversation("conv-2")],
        },
      }),
    );
    const a = view.cards.find((c) => c.id === "conversation:conv-1")!;
    const b = view.cards.find((c) => c.id === "conversation:conv-2")!;
    expect(a.y).toBe(b.y);
    expect(a.x).not.toBe(b.x);
  });
});

describe("projectPool conversation edges", () => {
  it("draws an edge from a Conversation to each spawned ticket and conversation", () => {
    const view = projectPool(
      snapshot({
        state: {
          tickets: [ticket("A")],
          conversations: [
            conversation("conv-1", { children: ["A", "conv-2"] }),
            conversation("conv-2"),
          ],
        },
      }),
    );
    expect(view.edges).toContainEqual({
      source: "conversation:conv-1",
      target: "ticket:A",
    });
    expect(view.edges).toContainEqual({
      source: "conversation:conv-1",
      target: "conversation:conv-2",
    });
  });

  it("drops a child id that names neither a live ticket nor a live conversation", () => {
    const view = projectPool(
      snapshot({
        state: {
          conversations: [conversation("conv-1", { children: ["ghost"] })],
        },
      }),
    );
    expect(view.edges).toEqual([]);
  });

  it("draws no conversation edges with no Conversations", () => {
    const view = projectPool(snapshot({ state: { tickets: [ticket("A")] } }));
    expect(view.edges.some((e) => e.source.startsWith("conversation:"))).toBe(false);
  });
});

describe("projectConversationsTray", () => {
  const now = Date.parse("2026-09-10T12:00:00.000Z");

  it("sorts waiting-on-you Conversations before working ones", () => {
    const rows = projectConversationsTray(
      [
        conversation("conv-1", { turn: { state: "working", lastLine: "", idleSince: null } }),
        conversation("conv-2", {
          turn: { state: "waiting", lastLine: "", idleSince: new Date(now - 1000).toISOString() },
        }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["conv-2", "conv-1"]);
  });

  it("among waiting Conversations, sorts longest idle first", () => {
    const rows = projectConversationsTray(
      [
        conversation("conv-1", {
          turn: { state: "waiting", lastLine: "", idleSince: new Date(now - 1_000).toISOString() },
        }),
        conversation("conv-2", {
          turn: { state: "waiting", lastLine: "", idleSince: new Date(now - 60_000).toISOString() },
        }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["conv-2", "conv-1"]);
  });

  it("excludes ended and crashed Conversations", () => {
    const rows = projectConversationsTray([
      conversation("conv-1", { status: "ended" }),
      conversation("conv-2", { status: "crashed" }),
      conversation("conv-3", { status: "live" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["conv-3"]);
  });
});

describe("projectConversationsNeedsInput", () => {
  it("includes only live Conversations whose Turn state is waiting", () => {
    const snap = snapshot({
      state: {
        tickets: [],
        conversations: [
          conversation("conv-1", {
            title: "plan the migration",
            turn: { state: "waiting", lastLine: "", idleSince: null },
          }),
          conversation("conv-2", { turn: { state: "working", lastLine: "", idleSince: null } }),
          conversation("conv-3", {
            status: "ended",
            turn: { state: "waiting", lastLine: "", idleSince: null },
          }),
        ],
      },
    });
    const rows = projectConversationsNeedsInput(snap);
    expect(rows).toEqual([
      {
        cardId: "conversation:conv-1",
        conversationId: "conv-1",
        label: "conv-1",
        title: "plan the migration",
      },
    ]);
  });

  it("is empty with no Conversations", () => {
    expect(projectConversationsNeedsInput(snapshot())).toEqual([]);
  });
});

describe("projectDetail for a Conversation card", () => {
  it("carries the same facts as the card, at full size", () => {
    const snap = snapshot({
      state: {
        tickets: [],
        conversations: [
          conversation("conv-1", {
            title: "plan the migration",
            branch: "conv/conv-1",
            spawnedBy: "conv-0",
            turn: { state: "waiting", lastLine: "what next?", idleSince: null },
          }),
        ],
      },
    });
    const detail = detailOf(snap, "conversation:conv-1");
    expect(detail).toEqual({
      kind: "conversation",
      conversationId: "conv-1",
      title: "plan the migration",
      status: "live",
      spawnedBy: "conv-0",
      assignment: { harness: null, model: null, drivers: "implement" },
      paneId: null,
      branch: "conv/conv-1",
      turn: { state: "waiting", lastLine: "what next?", idleSince: null },
      idleAge: null,
      terminal: null,
      endView: { ending: false, failure: null },
      steward: false,
      delivery: null,
    });
  });
});

describe("poolAssignmentDefaults", () => {
  it("reads the pool's Assignment defaults from config.defaults", () => {
    expect(
      poolAssignmentDefaults({
        defaults: { harness: "claude", model: "opus", effort: "high", drivers: "implement" },
        terminal: "herdr",
      }),
    ).toEqual({ harness: "claude", model: "opus", effort: "high", drivers: "implement" });
  });

  it("returns nothing when the pool sets no defaults", () => {
    expect(poolAssignmentDefaults({})).toEqual({});
    expect(poolAssignmentDefaults({ harness: "claude" })).toEqual({});
  });
});

describe("isTerminalBacked", () => {
  it("is true only when the pool config says terminal: herdr", () => {
    expect(isTerminalBacked({ terminal: "herdr" })).toBe(true);
    expect(isTerminalBacked({})).toBe(false);
    expect(isTerminalBacked({ terminal: "tmux" })).toBe(false);
  });
});

describe("projectEnlistPicker", () => {
  it("keeps ineligible panes as rows, with their reason, and puts eligible ones first", () => {
    const rows = projectEnlistPicker([
      {
        paneId: "pane-out",
        harness: "claude",
        status: "idle",
        title: "✳ Claude Code",
        directory: "/other",
        branch: null,
        eligible: false,
        reason: "not a checkout of this pool's repository",
      },
      {
        paneId: "pane-work",
        harness: "opencode",
        status: "working",
        title: "OC | doing work",
        directory: "/repo/worktree",
        branch: "feature/x",
        eligible: true,
        reason: null,
      },
      {
        paneId: "pane-gemini",
        harness: "gemini",
        status: "idle",
        title: "gemini",
        directory: "/repo",
        branch: "main",
        eligible: false,
        reason: "no harness the engine knows",
      },
    ]);
    // Eligible first, then the ineligible by harness (claude before gemini).
    expect(rows.map((r) => r.paneId)).toEqual([
      "pane-work",
      "pane-out",
      "pane-gemini",
    ]);
    expect(rows[0]).toEqual({
      paneId: "pane-work",
      harness: "opencode",
      status: "working",
      title: "OC | doing work",
      directory: "/repo/worktree",
      branch: "feature/x",
      eligible: true,
      reason: null,
    });
    // Every ineligible row keeps its reason; none is dropped.
    expect(rows.slice(1).every((r) => !r.eligible && r.reason !== null)).toBe(true);
  });

  it("renders a missing directory and branch as empty strings", () => {
    const rows = projectEnlistPicker([
      {
        paneId: "pane-bare",
        harness: null,
        status: "unknown",
        title: "",
        directory: null,
        branch: null,
        eligible: false,
        reason: "no harness the engine knows",
      },
    ]);
    expect(rows[0]!.directory).toBe("");
    expect(rows[0]!.branch).toBe("");
    expect(rows[0]!.harness).toBeNull();
  });

  it("is empty when herdr reports no panes", () => {
    expect(projectEnlistPicker([])).toEqual([]);
  });
});

describe("projectReassignTickets", () => {
  const sources = {
    harness: "pinned" as const,
    model: "default" as const,
    effort: "unset" as const,
    drivers: "default" as const,
  };

  it("lists only the tickets the engine says can be reassigned, in pool order", () => {
    const rows = projectReassignTickets([
      ticket("01", { status: "ready" }),
      ticket("02", { status: "done" }),
      ticket("03", {
        status: "in-progress",
        liveAttempt: agentAttempt(1, null),
      }),
      ticket("04", { status: "checkpoint" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["01", "04"]);
  });

  it("carries the Assignment, its provenance, the verify count and the caveat", () => {
    const rows = projectReassignTickets([
      ticket("01", {
        title: "wire the reassign route",
        assignment: { harness: "claude", model: "opus", drivers: "tdd" },
        enlisted: true,
        reassign: {
          eligible: true,
          reason: "enlisted: the write waits for the engine",
          verify: 2,
          sources,
        },
      }),
    ]);
    expect(rows[0]).toEqual({
      id: "01",
      title: "wire the reassign route",
      status: "ready",
      assignment: { harness: "claude", model: "opus", drivers: "tdd" },
      sources,
      verify: 2,
      enlisted: true,
      reason: "enlisted: the write waits for the engine",
    });
  });

  it("lists nothing for a pool with no reassignable ticket", () => {
    expect(projectReassignTickets([ticket("01", { status: "done" })])).toEqual([]);
  });
});

describe("projectEnlistBlocks", () => {
  it("lists every ticket not yet done, in pool order", () => {
    const rows = projectEnlistBlocks([
      ticket("01", { status: "ready" }),
      ticket("02", { status: "done" }),
      ticket("03", { status: "checkpoint" }),
      ticket("04", { status: "in-progress" }),
    ]);
    expect(rows).toEqual([
      { id: "01", title: "ticket 01" },
      { id: "03", title: "ticket 03" },
      { id: "04", title: "ticket 04" },
    ]);
  });

  it("is empty when every ticket is done", () => {
    expect(projectEnlistBlocks([ticket("01", { status: "done" })])).toEqual([]);
  });
});

describe("enlisted card marker", () => {
  it("carries the enlisted flag onto the ticket card", () => {
    const view = projectPool(
      snapshot({
        state: {
          tickets: [
            ticket("enlist-1", {
              enlisted: true,
              assignment: { harness: "opencode", model: null, drivers: "implement" },
            }),
          ],
        },
      }),
    );
    const card = view.cards.find(
      (c) => c.kind === "ticket" && c.ticketId === "enlist-1",
    );
    expect(card?.kind).toBe("ticket");
    if (card?.kind === "ticket") {
      expect(card.enlisted).toBe(true);
      expect(card.assignment).toEqual({
        harness: "opencode",
        model: null,
        drivers: "implement",
      });
    }
  });

  it("carries the enlisted flag onto the Conversation card", () => {
    const view = projectPool(
      snapshot({
        state: {
          conversations: [
            conversation("conv-1", {
              enlisted: true,
              assignment: { harness: "opencode", model: null, drivers: "implement" },
            }),
          ],
        },
      }),
    );
    const card = view.cards.find(
      (c) => c.kind === "conversation" && c.conversationId === "conv-1",
    );
    expect(card?.kind).toBe("conversation");
    if (card?.kind === "conversation") {
      expect(card.enlisted).toBe(true);
      expect(card.assignment).toEqual({
        harness: "opencode",
        model: null,
        drivers: "implement",
      });
    }
  });
});

describe("projectEnlistForm", () => {
  it("Ticket mode shows the spec and the Blocks list, with no note", () => {
    const view = projectEnlistForm("ticket");
    expect(view.showsSpec).toBe(true);
    expect(view.showsBlocks).toBe(true);
    expect(view.showsOpening).toBe(false);
    expect(view.note).toBeNull();
    expect(ENLIST_BECOMES_HINT).toContain("Ticket");
    expect(ENLIST_BECOMES_HINT).toContain("Conversation");
  });

  it("Conversation mode shows the opening Turn and the greyed note instead of Blocks", () => {
    const view = projectEnlistForm("conversation");
    expect(view.showsSpec).toBe(false);
    expect(view.showsBlocks).toBe(false);
    expect(view.showsOpening).toBe(true);
    expect(view.note).toContain("cannot block");
    expect(view.note).toContain("Ticket");
  });
});

describe("a Conversation the engine says is ending (issue #140)", () => {
  it("shows its End disabled even with no End sent from this tab", () => {
    const view = projectPool(
      snapshot({ state: { conversations: [conversation("conv-1", { ending: true, paneId: null })] } }),
    );
    const card = view.cards.find((c) => c.kind === "conversation");
    expect(card?.kind === "conversation" && card.endView.ending).toBe(true);
    expect(card?.kind === "conversation" && card.terminal).toBe(null);
  });
});

/** A Pending spawn as the wire carries it (issue #150). */
function pendingSpawn(overrides: Partial<PendingSpawnView> = {}): PendingSpawnView {
  return {
    id: "proposal-1",
    parentId: "04",
    origin: "ticket",
    kind: "ticket",
    title: "Write the migration guide",
    body: "Document every renamed flag.",
    blockedBy: [],
    blocks: null,
    overlaps: [],
    at: "2026-09-29T10:10:00Z",
    ...overrides,
  };
}

/** A Held spawn as the wire carries it (issue #149). */
function heldSpawn(overrides: Partial<HeldSpawnView> = {}): HeldSpawnView {
  return {
    id: "held-1",
    parentId: "03",
    origin: "ticket",
    kind: "ticket",
    title: "Fix the flaky login test",
    body: "The login test fails one run in five.",
    blockedBy: [],
    blocks: null,
    overlaps: [],
    unknownOverlaps: [],
    reason: "per-run",
    at: "2026-09-29T10:00:00Z",
    adopting: false,
    ...overrides,
  };
}

describe("the Spawn caps header line (issue #149)", () => {
  const line = (overrides: Parameters<typeof snapshot>[0]) =>
    projectPool(snapshot(overrides)).spawnLine;

  it("shows this run's count against the run cap and the per-attempt cap", () => {
    expect(line({ spawnUsage: { spawnedThisRun: 3, perAttempt: 5, perRun: 20 } })).toEqual({
      text: "Spawns 3/20 this run · 5 per attempt",
      warn: false,
    });
  });

  it("warns once the run is at its cap", () => {
    expect(line({ spawnUsage: { spawnedThisRun: 20, perAttempt: 5, perRun: 20 } })).toEqual({
      text: "Spawns 20/20 this run · 5 per attempt",
      warn: true,
    });
    // A cap lowered under the count is over it, and still a warning.
    expect(line({ spawnUsage: { spawnedThisRun: 12, perAttempt: 5, perRun: 10 } })?.warn).toBe(
      true,
    );
  });

  it("warns and counts the Held spawns while any wait on the operator", () => {
    expect(
      line({
        spawnUsage: { spawnedThisRun: 1, perAttempt: 2, perRun: 20 },
        heldSpawns: [heldSpawn(), heldSpawn({ id: "held-2" })],
      }),
    ).toEqual({ text: "Spawns 1/20 this run · 2 per attempt · 2 held", warn: true });
  });
});

describe("the Spawn caps header line with Pending spawns (issue #150)", () => {
  it("counts the Pending spawns before the held ones, without a warning of their own", () => {
    const view = projectPool(
      snapshot({
        spawnUsage: { spawnedThisRun: 1, perAttempt: 5, perRun: 20 },
        pendingSpawns: [pendingSpawn(), pendingSpawn({ id: "proposal-2" })],
      }),
    );
    expect(view.spawnLine).toEqual({
      text: "Spawns 1/20 this run · 5 per attempt · 2 pending",
      warn: false,
    });
    expect(
      projectPool(
        snapshot({ pendingSpawns: [pendingSpawn()], heldSpawns: [heldSpawn()] }),
      ).spawnLine.text,
    ).toBe("Spawns 0/20 this run · 5 per attempt · 1 pending · 1 held");
  });
});

describe("projectPendingSpawns and the hold reasons (issue #150)", () => {
  const NOW = Date.parse("2026-09-29T10:12:00Z");

  it("words a Pending spawn as the list shows it", () => {
    const [row] = projectPendingSpawns([pendingSpawn({ overlaps: ["02"] })], NOW);
    expect(row).toEqual({
      id: "proposal-1",
      title: "Write the migration guide",
      kind: "ticket",
      parent: "from 04",
      waited: "2m ago",
      at: "2026-09-29T10:10:00Z",
      blockedBy: null,
      blocks: null,
      overlaps: "overlaps 02",
      body: "Document every renamed flag.",
    });
  });

  it("says a spawn was held for overlapping named work, or by the operator", () => {
    const [overlapping, operator] = projectHeldSpawns(
      [
        heldSpawn({ reason: "overlaps", overlaps: ["02", "proposal-1"] }),
        heldSpawn({ id: "proposal-4", reason: "operator" }),
      ],
      NOW,
    );
    expect(overlapping?.reason).toBe("overlaps 02, proposal-1");
    expect(operator?.reason).toBe("held by operator");
  });

  it("notes the overlaps ids the pool never knew, and a spawn refused at landing", () => {
    const [unknown, refused] = projectHeldSpawns(
      [
        heldSpawn({ reason: "overlaps", overlaps: ["02", "99"], unknownOverlaps: ["99"] }),
        heldSpawn({
          id: "proposal-5",
          reason: "refused",
          adoptError: "blocks names done tickets, which have no next attempt to hold: 02",
        }),
      ],
      NOW,
    );
    expect(unknown?.reason).toBe("overlaps 02, 99 (99 not in the pool)");
    expect(refused?.reason).toBe("refused at landing");
    expect(refused?.adoptError).toBe(
      "blocks names done tickets, which have no next attempt to hold: 02",
    );
  });
});

describe("faded cards for Pending and Held spawns (issue #150)", () => {
  const snap = () =>
    snapshot({
      state: { tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] })] },
      pendingSpawns: [pendingSpawn({ parentId: "01", blockedBy: ["01"], blocks: ["02"] })],
      heldSpawns: [heldSpawn({ id: "proposal-2", parentId: "02", reason: "operator" })],
    });

  it("draws one faded card per proposal under its own key, saying when it lands or why it is held", () => {
    const spawns = projectPool(snap()).cards.filter((c) => c.kind === "spawn");
    expect(
      spawns.map((c) => c.kind === "spawn" && [c.id, c.state, c.label, c.title, c.parentCardId]),
    ).toEqual([
      ["spawn:proposal-1", "pending", "lands next boundary", "Write the migration guide", "ticket:01"],
      ["spawn:proposal-2", "held", "held · held by operator", "Fix the flaky login test", "ticket:02"],
    ]);
  });

  it("draws dashed edges from the parent and to what a spawn would block", () => {
    const edges = projectPool(snap()).edges.filter((e) => e.proposed);
    expect(edges).toEqual([
      { source: "ticket:01", target: "spawn:proposal-1", proposed: true },
      { source: "spawn:proposal-1", target: "ticket:02", proposed: true },
      { source: "ticket:02", target: "spawn:proposal-2", proposed: true },
    ]);
  });

  // The ticket it lands as sits about where the faded card was: the same
  // row, from the same blockedBy.
  it("places a faded card in the row its ticket will take", () => {
    const cards = projectPool(snap()).cards;
    const at = (id: string) => cards.find((c) => c.id === id)!;
    expect(at("spawn:proposal-1").y).toBe(at("ticket:02").y);
    expect(at("spawn:proposal-2").y).toBe(at("ticket:01").y);
    const landed = projectPool(
      snapshot({
        state: {
          tickets: [
            ticket("01"),
            ticket("02", { blockedBy: ["01"] }),
            ticket("01-spawn-1", { blockedBy: ["01"] }),
          ],
        },
      }),
    ).cards;
    expect(landed.find((c) => c.id === "ticket:01-spawn-1")!.y).toBe(at("spawn:proposal-1").y);
  });

  // Review of issue #150: a faded card must never move a real one.
  it("leaves every real card where it was when faded cards appear", () => {
    const base = snapshot({
      state: {
        tickets: [ticket("01"), ticket("02"), ticket("03", { blockedBy: ["01"] })],
        conversations: [conversation("conv-1")],
      },
    });
    const withSpawns = snapshot({
      ...base,
      state: base.state,
      pendingSpawns: [
        pendingSpawn({ parentId: "01" }),
        pendingSpawn({ id: "proposal-2", parentId: "01", blockedBy: ["03"] }),
        pendingSpawn({ id: "proposal-3", parentId: "conv-1", kind: "conversation", origin: "conversation" }),
      ],
      heldSpawns: [heldSpawn({ id: "proposal-4", parentId: "01", blockedBy: ["01"] })],
    });
    const where = (snap: EnrichedSnapshot) =>
      Object.fromEntries(
        projectPool(snap)
          .cards.filter((c) => c.kind !== "spawn")
          .map((c) => [c.id, [c.x, c.y]]),
      );
    const before = where(base);
    const after = where(withSpawns);
    for (const id of Object.keys(before).filter((id) => id !== "REVIEW")) {
      expect(after[id]).toEqual(before[id]);
    }
    const cards = projectPool(withSpawns).cards;
    const at = (id: string) => cards.find((c) => c.id === id)!;
    // Each faded card sits after the real cards of its row.
    expect(at("spawn:proposal-1").y).toBe(at("ticket:01").y);
    expect(at("spawn:proposal-1").x).toBeGreaterThan(at("ticket:02").x);
    expect(at("spawn:proposal-4").y).toBe(at("ticket:03").y);
    expect(at("spawn:proposal-4").x).toBeGreaterThan(at("ticket:03").x);
    expect(at("spawn:proposal-2").y).toBeGreaterThan(at("ticket:03").y);
    // One that lands as a Conversation joins the lane, after its cards.
    expect(at("spawn:proposal-3").y).toBe(at("conversation:conv-1").y);
    expect(at("spawn:proposal-3").x).toBeGreaterThan(at("conversation:conv-1").x);
  });

  it("puts a Conversation's faded card beside START when there is no lane, moving no ticket", () => {
    const base = snapshot({ state: { tickets: [ticket("01")] } });
    const withSpawn = snapshot({
      state: base.state,
      pendingSpawns: [pendingSpawn({ parentId: "01", kind: "conversation" })],
    });
    const cards = projectPool(withSpawn).cards;
    const at = (id: string) => cards.find((c) => c.id === id)!;
    const ticketBefore = projectPool(base).cards.find((c) => c.id === "ticket:01")!;
    expect([at("ticket:01").x, at("ticket:01").y]).toEqual([ticketBefore.x, ticketBefore.y]);
    expect(at("spawn:proposal-1").y).toBe(at("START").y);
    expect(at("spawn:proposal-1").x).toBeGreaterThan(at("START").x);
  });

  it("opens a Detail with the whole proposal and the row its decisions act on", () => {
    const view = projectPool(snap());
    const detail = projectDetail(view.cards, "spawn:proposal-1", {
      pending: view.pendingSpawns,
      held: view.heldSpawns,
    });
    expect(detail).toMatchObject({
      kind: "spawn",
      proposalId: "proposal-1",
      state: "pending",
      label: "lands next boundary",
      title: "Write the migration guide",
      parentId: "01",
      body: "Document every renamed flag.",
      blockedBy: ["01"],
      blocks: ["02"],
      overlaps: [],
      row: { id: "proposal-1" },
    });
    // A spawn that has since landed or gone has no Detail to show.
    expect(projectDetail(view.cards, "spawn:proposal-1")).toBeNull();
  });

  it("never offers a faded card to the Needs input tray", () => {
    expect(projectNeedsInput(projectPool(snap()).cards)).toEqual([]);
  });
});

describe("projectHeldSpawns (issue #149)", () => {
  const NOW = Date.parse("2026-09-29T10:12:00Z");

  it("words which cap held each spawn and how long it has waited, oldest first", () => {
    const rows = projectHeldSpawns(
      [heldSpawn(), heldSpawn({ id: "held-2", reason: "per-attempt", at: "2026-09-29T10:11:30Z" })],
      NOW,
    );
    expect(rows.map((row) => [row.id, row.reason, row.waited])).toEqual([
      ["held-1", "per-run cap", "12m ago"],
      ["held-2", "per-attempt cap", "30s ago"],
    ]);
    expect(rows[0]).toMatchObject({
      title: "Fix the flaky login test",
      parent: "from 03",
      body: "The login test fails one run in five.",
      adopting: false,
    });
  });

  it("says what an adopted spawn would wait on and what it would block", () => {
    const [waits, all, none] = projectHeldSpawns(
      [
        heldSpawn({ blockedBy: ["01", "02"], blocks: ["04", "05"] }),
        heldSpawn({ id: "held-2", blocks: "all" }),
        heldSpawn({ id: "held-3" }),
      ],
      NOW,
    );
    expect(waits?.blockedBy).toBe("waits on 01, 02");
    expect(waits?.blocks).toBe("blocks 04, 05");
    expect(all?.blocks).toBe("blocks every ticket not yet started");
    expect(none?.blockedBy).toBeNull();
    expect(none?.blocks).toBeNull();
  });

  it("names a Conversation proposal and a Conversation parent as such", () => {
    const [row] = projectHeldSpawns(
      [heldSpawn({ kind: "conversation", origin: "conversation", parentId: "c-1" })],
      NOW,
    );
    expect(row?.parent).toBe("from Conversation c-1");
    expect(row?.kind).toBe("conversation");
  });

  it("marks one whose Adopt is on its way to the boundary", () => {
    expect(projectHeldSpawns([heldSpawn({ adopting: true })], NOW)[0]?.adopting).toBe(true);
  });

  it("carries why the boundary refused the last Adopt, and null before any refusal", () => {
    const [refused, fresh] = projectHeldSpawns(
      [heldSpawn({ adoptError: "blocker 09 is gone" }), heldSpawn({ id: "held-2" })],
      NOW,
    );
    expect(refused?.adoptError).toBe("blocker 09 is gone");
    expect(fresh?.adoptError).toBeNull();
  });
});

describe("the Steward (ADR-0030)", () => {
  const steward = (overrides: Partial<ConversationView> = {}): ConversationView =>
    conversation("conv-3", { title: "Steward", role: "steward", ...overrides });

  it("finds the live Steward, and none among ordinary or ended Conversations", () => {
    expect(stewardOnDuty([conversation("conv-1"), steward()])).toEqual({
      conversationId: "conv-3",
      cardId: "conversation:conv-3",
      title: "Steward",
      delivery: null,
    });
    expect(stewardOnDuty([conversation("conv-1")])).toBeNull();
    expect(stewardOnDuty([steward({ status: "ended" })])).toBeNull();
    expect(stewardOnDuty([steward({ status: "crashed" })])).toBeNull();
  });

  it("still counts a Steward whose End is under way, as the engine's refusal does", () => {
    expect(stewardOnDuty([steward({ ending: true })])?.conversationId).toBe("conv-3");
  });

  it("names the Steward on duty in the header and in the reason Start Steward is disabled", () => {
    const onDuty = stewardOnDuty([steward()])!;
    expect(stewardOnDutyLine(onDuty)).toBe("Steward on duty · conv-3");
    expect(stewardLiveReason(onDuty)).toContain("conv-3");
  });

  it("marks the Steward's card, Detail and tray row, and puts it on the pool view", () => {
    const snap = snapshot({ state: { conversations: [conversation("conv-1"), steward()] } });
    const view = projectPool(snap);
    const cards = view.cards.filter(
      (card): card is ConversationCardView => card.kind === "conversation",
    );
    expect(cards.map((card) => [card.conversationId, card.steward])).toEqual([
      ["conv-1", false],
      ["conv-3", true],
    ]);
    expect(view.steward?.cardId).toBe("conversation:conv-3");
    const detail = detailOf(snap, "conversation:conv-3");
    expect(detail?.kind === "conversation" && detail.steward).toBe(true);
    const rows = projectConversationsTray(snap.state.conversations);
    expect(rows.find((row) => row.id === "conv-3")?.steward).toBe(true);
    expect(rows.find((row) => row.id === "conv-1")?.steward).toBe(false);
  });

  it("leaves a waiting Steward out of Needs input: it waits on Notices, not on the operator", () => {
    const waiting = { state: "waiting" as const, lastLine: "", idleSince: null };
    const snap = snapshot({
      state: {
        conversations: [conversation("conv-1", { turn: waiting }), steward({ turn: waiting })],
      },
    });
    expect(projectConversationsNeedsInput(snap).map((row) => row.conversationId)).toEqual([
      "conv-1",
    ]);
  });

  it("has no Steward on the pool view when none is live", () => {
    expect(projectPool(snapshot()).steward).toBeNull();
  });

  it("reads the Steward's Assignment from its Pool settings entry ahead of the pool defaults", () => {
    const config = {
      defaults: { harness: "claude", model: "sonnet", drivers: "implement" },
      steward: { budget: 3, assign: { model: "opus", effort: "high" } },
    };
    expect(stewardAssignmentDefaults(config)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
      drivers: "implement",
    });
    expect(stewardAssignmentDefaults({ defaults: { harness: "claude" } })).toEqual({
      harness: "claude",
    });
  });

  it("carries a Steward note on the ticket's interrupt to the card, Detail and Needs input row", () => {
    const note = { text: "rebase onto main, then resume", at: "2026-10-01T02:00:00Z", conversation: "conv-3" };
    const snap = snapshot({
      state: {
        tickets: [ticket("A", { status: "checkpoint" })],
        interrupts: [{ ticketId: "A", kind: "checkpoint", body: "stuck", stewardNote: note }],
      },
    });
    const rows = projectNeedsInput(projectPool(snap).cards);
    expect(rows[0].interrupt.stewardNote).toEqual(note);
    const detail = detailOf(snap, "ticket:A");
    expect(detail?.kind === "ticket" && detail.interrupt?.stewardNote).toEqual(note);
  });

  describe("the Steward budget on a ticket's Detail", () => {
    const budgetOf = (snap: EnrichedSnapshot, id = "A") => {
      const detail = detailOf(snap, `ticket:${id}`);
      return detail?.kind === "ticket" ? detail.stewardBudget : undefined;
    };

    it("is used and left once the Steward has answered the ticket", () => {
      const snap = snapshot({
        stewardBudget: { budget: 5, used: { A: 2 } },
        state: { tickets: [ticket("A"), ticket("B")] },
      });
      expect(budgetOf(snap)).toEqual({ used: 2, budget: 5, remaining: 3 });
      expect(budgetOf(snap, "B")).toBeNull();
    });

    it("is absent with no budget on the snapshot, and never reads below zero left", () => {
      expect(budgetOf(snapshot({ state: { tickets: [ticket("A")] } }))).toBeNull();
      const over = snapshot({
        stewardBudget: { budget: 2, used: { A: 3 } },
        state: { tickets: [ticket("A")] },
      });
      expect(budgetOf(over)).toEqual({ used: 3, budget: 2, remaining: 0 });
    });

    it("reads as one line", () => {
      expect(stewardBudgetText({ used: 2, budget: 5, remaining: 3 })).toBe(
        "Steward budget · 2 of 5 used · 3 left",
      );
    });
  });

  describe("the Ticket log", () => {
    function event(kind: TicketEventKind, payload: Record<string, unknown>): TicketEvent {
      return { at: "2026-10-01T02:00:00.000Z", attempt: 1, kind, payload };
    }
    function stewardLines(events: TicketEvent[]): (string | null)[] {
      const view = projectTimeline(
        { events, attempts: [], reconstructed: false, spec: "the spec" },
        "checkpoint",
      );
      return view.attempts[0].events.map((e) => e.steward);
    }
    const by = { by: "steward", conversation: "conv-3" };

    it("reads the Steward's answers as its own, with the note", () => {
      expect(
        stewardLines([
          event("answered", { kind: "checkpoint", ...by, note: "tests pass now, carry on" }),
          event("answered", { kind: "merge-approval", ...by, action: "approve" }),
          event("answered", { kind: "checkpoint", action: "keep-talking", ...by, message: "run the linter first" }),
        ]),
      ).toEqual([
        "the Steward answered checkpoint: resume · tests pass now, carry on",
        "the Steward answered merge approval: approve",
        "the Steward kept talking: run the linter first",
      ]);
    });

    it("leaves the operator's answers as they were", () => {
      expect(stewardLines([event("answered", { kind: "checkpoint" })])).toEqual([null]);
      expect(
        stewardLines([event("answered", { kind: "checkpoint", action: "keep-talking" })]),
      ).toEqual([null]);
    });

    it("shows a Steward note as left for the operator", () => {
      expect(
        stewardLines([
          event("steward-note", { kind: "checkpoint", note: "needs a product call", ...by }),
        ]),
      ).toEqual(["Steward left this for you: needs a product call"]);
    });

    it("reads the Steward's Reassign and its own End", () => {
      expect(
        stewardLines([
          event("reassign-requested", { fields: { model: "opus", effort: null }, ...by }),
          event("end-requested", { closing: "the super-step is done", ...by }),
          event("end-requested", { closing: null }),
        ]),
      ).toEqual([
        "the Steward reassigned: model opus · effort cleared",
        "the Steward ended itself: the super-step is done",
        null,
      ]);
    });

    it("marks a Held spawn the Steward adopted or discarded as its decision", () => {
      const view = projectTimeline(
        {
          events: [
            event("spawn-adopted", { adopted: ["A-spawn-1"], fromHeld: "held-1", ...by }),
            event("spawn-discarded", { id: "held-2", title: "Fix the test", ...by }),
            event("spawn-discarded", { id: "held-3", title: "Fix the docs" }),
          ],
          attempts: [],
          reconstructed: false,
          spec: "",
        },
        "checkpoint",
      );
      expect(view.attempts[0].events.map((e) => e.spawn)).toEqual([
        "adopted A-spawn-1 from held-1 · by the Steward",
        "held spawn 'Fix the test' discarded · by the Steward",
        "held spawn 'Fix the docs' discarded",
      ]);
    });
  });

  it("offers Steward as an Enlist kind: standing orders, an optional title, no Blocks", () => {
    expect(projectEnlistForm("steward")).toEqual({
      showsSpec: false,
      showsBlocks: false,
      showsOpening: true,
      openingLabel: "standing orders (optional)",
      requiresTitle: false,
      note: ENLIST_STEWARD_NOTE,
    });
    expect(projectEnlistForm("conversation").requiresTitle).toBe(true);
    expect(ENLIST_BECOMES_HINT).toContain("Steward");
  });
});

describe("a Conversation whose Notices are not landing", () => {
  const delivery = {
    failingSince: "2026-10-01T02:05:00.000Z",
    lastError: "the Turn never echoed: Teach auto mode? (y/n)",
  };
  const since = new Date(delivery.failingSince).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  it("warns on its card, its tray row and its Detail, the error carried along", () => {
    const snap = snapshot({
      state: { conversations: [conversation("conv-1", { delivery }), conversation("conv-2")] },
    });
    const cards = projectPool(snap).cards.filter(
      (card): card is ConversationCardView => card.kind === "conversation",
    );
    const warning = {
      text: `Notices not reaching this pane since ${since}: something in the pane is in the way`,
      lastError: delivery.lastError,
    };
    expect(cards.map((card) => card.delivery)).toEqual([warning, null]);
    const rows = projectConversationsTray(snap.state.conversations);
    expect(rows.find((row) => row.id === "conv-1")?.delivery).toEqual(warning);
    expect(rows.find((row) => row.id === "conv-2")?.delivery).toBeNull();
    const detail = detailOf(snap, "conversation:conv-1");
    expect(detail?.kind === "conversation" && detail.delivery).toEqual(warning);
  });

  it("drops the time it cannot read rather than printing nonsense", () => {
    const snap = snapshot({
      state: {
        conversations: [conversation("conv-1", { delivery: { ...delivery, failingSince: "?" } })],
      },
    });
    const rows = projectConversationsTray(snap.state.conversations);
    expect(rows[0].delivery?.text).toBe(
      "Notices not reaching this pane: something in the pane is in the way",
    );
  });

  it("makes the Steward on duty read as blind in the header", () => {
    const blind = stewardOnDuty([conversation("conv-3", { role: "steward", delivery })])!;
    expect(blind.delivery?.lastError).toBe(delivery.lastError);
    expect(stewardOnDutyLine(blind)).toBe("Steward on duty · conv-3 · Notices not landing");
    const fine = stewardOnDuty([conversation("conv-3", { role: "steward" })])!;
    expect(stewardOnDutyLine(fine)).toBe("Steward on duty · conv-3");
  });
});
