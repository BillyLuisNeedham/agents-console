import { describe, expect, test } from "bun:test";
import {
  cardFrameAfter,
  countFrames,
  focusRoundTrip,
  prefetchedAt,
  speaksSocket,
  subscribedAt,
  summarizeE2e,
  type ProbeClick,
  type ProbeFocus,
  type ProbeReport,
  type ProbeSocket,
  type SocketFrame,
} from "./e2e.ts";

const sockets: ProbeSocket[] = [
  { url: "ws://127.0.0.1:1/api/ws", opened: 0, closed: 500 },
  { url: "ws://127.0.0.1:1/api/ws", opened: 600, closed: null },
];

const out = (socket: number, at: number, rest: Partial<SocketFrame>): SocketFrame => ({
  socket,
  dir: "out",
  at,
  bytes: 40,
  type: "?",
  ...rest,
});
const inn = (socket: number, at: number, rest: Partial<SocketFrame>): SocketFrame => ({
  socket,
  dir: "in",
  at,
  bytes: 400,
  type: "?",
  ...rest,
});

const frames: SocketFrame[] = [
  inn(0, 1, { type: "hello" }),
  inn(0, 2, { type: "snapshot" }),
  out(0, 3, { type: "hello", cards: ["07"] }),
  inn(0, 20, { type: "card", id: "07" }),
  out(0, 100, { type: "subscribe", id: "03" }),
  inn(0, 140, { type: "card", id: "03" }),
  out(0, 200, { type: "unsubscribe", id: "07" }),
  out(0, 300, { type: "request", id: 1, kind: "terminal.focus", ticket: "13" }),
  inn(0, 340, { type: "delta" }),
  inn(0, 341, { type: "reply", id: 1, kind: "terminal.focus", ok: true }),
  // The socket closed at 500 and the page reopened it: its hello carries the subscriptions again.
  inn(1, 601, { type: "hello" }),
  out(1, 602, { type: "hello", cards: ["03"] }),
  inn(1, 650, { type: "card", id: "03" }),
  inn(1, 700, { type: "heartbeat" }),
];

describe("the page's subscriptions, replayed", () => {
  test("hello, subscribe and unsubscribe decide what is held at a moment", () => {
    expect(subscribedAt(frames, sockets, "07", 10)).toBe(true);
    expect(subscribedAt(frames, sockets, "03", 50)).toBe(false);
    expect(subscribedAt(frames, sockets, "03", 150)).toBe(true);
    expect(subscribedAt(frames, sockets, "07", 250)).toBe(false);
  });

  test("a closed socket holds nothing, and the reopened one holds what its hello says", () => {
    expect(subscribedAt(frames, sockets, "03", 550)).toBe(false);
    expect(subscribedAt(frames, sockets, "03", 610)).toBe(true);
    expect(subscribedAt(frames, sockets, "07", 610)).toBe(false);
  });

  test("a prefetch has landed once the card frame came in after the subscription began", () => {
    expect(prefetchedAt(frames, sockets, "03", 120)).toBe(false);
    expect(prefetchedAt(frames, sockets, "03", 150)).toBe(true);
    // The reopened socket's own card frame has not come in yet at 620.
    expect(prefetchedAt(frames, sockets, "03", 620)).toBe(false);
    expect(prefetchedAt(frames, sockets, "03", 660)).toBe(true);
  });
});

describe("round trips on the socket", () => {
  test("a card press is answered by the first card frame for that id after it", () => {
    expect(cardFrameAfter(frames, "03", 100)?.at).toBe(140);
    expect(cardFrameAfter(frames, "03", 141)?.at).toBe(650);
    expect(cardFrameAfter(frames, "99", 0)).toBeNull();
  });

  test("an Open in herdr is its focus request and the reply carrying its number", () => {
    const trip = focusRoundTrip(frames, "13", 250);
    expect(trip?.request.at).toBe(300);
    expect(trip?.reply?.at).toBe(341);
    expect(focusRoundTrip(frames, "13", 301)).toBeNull();
  });

  test("frames are counted by direction and type, requests and replies by kind", () => {
    const counted = countFrames(frames, 0, 400);
    expect(counted.sent["request terminal.focus"]).toEqual({ count: 1, bytes: 40 });
    expect(counted.received["reply terminal.focus"]).toEqual({ count: 1, bytes: 400 });
    expect(counted.received.card).toEqual({ count: 2, bytes: 800 });
    expect(counted.sent.hello?.count).toBe(1);
    expect(countFrames(frames, 600, 800).received.heartbeat?.count).toBe(1);
  });

  test("a page speaks the socket when it opened one at the protocol's path", () => {
    expect(speaksSocket({ sockets })).toBe(true);
    expect(speaksSocket({ sockets: [] })).toBe(false);
    expect(speaksSocket({ sockets: [{ url: "ws://x/other", opened: 0, closed: null }] })).toBe(false);
  });
});

// --- the summary's gate samples ---------------------------------------------------

const click = (over: Partial<ProbeClick>): ProbeClick => ({
  id: "01",
  how: "cold",
  t0: 1_000,
  released: 1_001,
  pressFrame: 60,
  inputDelayMs: 0.2,
  tab: "progress",
  shellMs: 1,
  shellPaintedMs: 15,
  shellFrames: 1,
  dataMs: 10,
  dataPaintedMs: 16,
  dataFrames: 1,
  missed: false,
  ...over,
});

const focus = (over: Partial<ProbeFocus>): ProbeFocus => ({
  id: "13",
  t0: 2_000,
  released: 2_001,
  pressFrame: 120,
  inputDelayMs: 0.1,
  feedbackPaintedMs: 14,
  feedbackFrames: 1,
  confirmedMs: 3,
  confirmedPaintedMs: 16,
  missed: false,
  ...over,
});

function report(over: Partial<ProbeReport>): ProbeReport {
  const frameTimes = Array.from({ length: 1_200 }, (_, i) => 500 + i * (1000 / 60));
  return {
    origin: 0,
    window: [500, 10_500],
    idle: [11_000, 21_000],
    longTaskApi: true,
    resources: [],
    fetches: [],
    sockets: [{ url: "ws://127.0.0.1:1/api/ws", opened: 100, closed: null }],
    socketFrames: [],
    longTasks: [],
    longFrames: [],
    frames: frameTimes.map((at) => ({ at, mutated: false })),
    batches: [],
    cardsShown: [
      { cards: 0, paintedAt: 90 },
      { cards: 20, paintedAt: 180 },
    ],
    clicks: [],
    focuses: [],
    domNodes: 500,
    cards: 25,
    ...over,
  };
}

const metrics = { before: {}, after: {} };
const options = (over: Partial<Parameters<typeof summarizeE2e>[2]> = {}) => ({
  rttMs: 0,
  unreachable: { cold: 0, hover: 0, focus: 0 },
  tickets: 20,
  hoverMs: 300,
  ...over,
});

describe("summarizeE2e's gate samples", () => {
  test("every press is a sample, and a press that missed or could not be made is an empty one", () => {
    const r = report({
      clicks: [
        click({ id: "01" }),
        click({ id: "02", how: "hover", dataFrames: 1 }),
        click({ id: "03", missed: true, t0: null }),
        click({ id: "04", tab: "outcome", dataPaintedMs: 15 }),
      ],
      focuses: [focus({}), focus({ missed: true, t0: null })],
      socketFrames: [
        out(0, 2_002, { type: "request", id: 1, kind: "terminal.focus", ticket: "13" }),
        inn(0, 2_004, { type: "reply", id: 1, kind: "terminal.focus", ok: true }),
      ],
    });
    const result = summarizeE2e([r], metrics, options({ unreachable: { cold: 1, hover: 0, focus: 1 } }));
    const g = result.gateInputs;
    // Three clicks pressed, one missed and one unreachable; one focus pressed, one missed and one unreachable.
    expect(g.shellFrames).toEqual([1, 1, 1, null, null]);
    expect(g.feedbackFrames).toEqual([1, 1, 1, 1, null, null, null, null]);
    // Outcome brings no data, so only the Progress cold click is judged, then the missed and unreachable cold ones.
    expect(g.coldDataMs).toEqual([16, null, null]);
    expect(g.hoverDataFrames).toEqual([1]);
    expect(g.focusAnsweredMs).toEqual([3, null, null]);
    expect(result.focus.answeredVia).toEqual({ socket: 1, http: 0 });
    expect(g.usableMs).toEqual([180]);
    expect(g.frames[0]!.over).toBe(0);
    expect(result.protocol).toBe("ws");
  });

  test("a cold click on a card the page already held is no cold measurement", () => {
    const r = report({
      clicks: [click({ id: "07", t0: 1_000 })],
      socketFrames: [out(0, 200, { type: "hello", cards: ["07"] })],
    });
    const result = summarizeE2e([r], metrics, options());
    expect(result.click.notCold).toBe(1);
    expect(result.gateInputs.coldDataMs).toEqual([null]);
  });

  test("an old page's Open in herdr is answered when its POST's last byte lands", () => {
    const r = report({
      sockets: [],
      focuses: [focus({})],
      resources: [{ path: "/api/terminal/focus?ticket=13", start: 2_002, requestStart: 2_002.5, responseEnd: 2_006 }],
    });
    const result = summarizeE2e([r], metrics, options());
    expect(result.protocol).toBe("sse");
    expect(result.ws).toBeNull();
    expect(result.click.cold.cardFrameMs).toBeNull();
    expect(result.gateInputs.focusAnsweredMs).toEqual([5]);
    expect(result.focus.answeredVia).toEqual({ socket: 0, http: 1 });
  });

  test("the idle window counts what each tab started in it, and nothing from before", () => {
    const r = report({
      resources: [
        { path: "/api/activity?ticket=13", start: 5_000, requestStart: 5_000, responseEnd: 5_010 },
        { path: "/api/activity?ticket=13", start: 12_000, requestStart: 12_000, responseEnd: 12_010 },
      ],
      fetches: [{ path: "/api/terminal/peek?ticket=13", at: 13_000 }],
      socketFrames: [out(0, 9_000, { type: "subscribe", id: "05" }), out(0, 15_000, { type: "visibility" }), inn(0, 16_000, { type: "heartbeat" })],
    });
    const result = summarizeE2e([r], metrics, options());
    expect(result.gateInputs.idle).toEqual([{ ms: 10_000, resources: 1, fetches: 1, socketFramesSent: 1 }]);
    expect(result.idle.received.heartbeat?.count).toBe(1);
  });

  test("a tab that never painted every Ticket's card has no start time", () => {
    const r = report({ cardsShown: [{ cards: 12, paintedAt: 100 }] });
    expect(summarizeE2e([r], metrics, options()).gateInputs.usableMs).toEqual([null]);
  });
});
