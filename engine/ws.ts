/**
 * The Console's socket, server side (issue #161, ADR-0032): the one
 * WebSocket at `/api/ws` every tab holds, and everything the server pushes
 * down it. protocol.ts declares the messages; this module decides when each
 * one goes, and keeps the work a push takes to once per server rather than
 * once per tab.
 *
 * Four things go out. The snapshot: whole when a socket opens, then one
 * delta per coalesced change, diffed against the one version every socket
 * was last sent and serialised once for all of them. The live values
 * (activity, peeks, grades): one check for every tab on a 2 s timer that
 * runs only while a tab is visible, sending only what moved. The subscribed
 * cards' data: body, events and log window on subscribe, then what changed,
 * found by fs.watch on runs/ and issues/ with the live check's stat of the
 * same files as the backstop for an event the watch missed. And the replies
 * to requests, each one after the delta that carries its effect. Ahead of
 * all of it, the served page carries the version a socket would open with,
 * so the Console paints before it connects.
 *
 * Everything that reads the pool comes in through PushSources, which
 * server.ts builds from the functions its HTTP routes run, so a request on
 * the socket and its HTTP twin cannot answer differently.
 */

import { type FSWatcher, type Stats, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import {
  ACTION_KINDS,
  CLOSE_STOPPED,
  HTTP_TWINS,
  LIVE_CHECK_MS,
  PROTOCOL_VERSION,
  decodeClientMessage,
  diffSnapshot,
  embedBoot,
  encodeMessage,
  toPushed,
  type CardSubscription,
  type ClientMessage,
  type EmbeddedBoot,
  type LogFollow,
  type LogFollowResult,
  type LogPush,
  type PeekFailure,
  type PushedSnapshot,
  type RequestKind,
  type RequestResult,
  type ServerMessage,
} from "./protocol.ts";
import type {
  EnrichedSnapshot,
  LogAttemptInfo,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// Requests: the one answer a route and its socket twin share
// ---------------------------------------------------------------------------

/**
 * What a request came to, in the one shape both of its callers read. The
 * HTTP route answers `result` with `status`, or `{[field]: reason}` with
 * `status`, exactly as it always has: some routes say `error` and some say
 * `reason`, and that stays theirs. The socket replies with `result`, or
 * with the refusal `{reason, status}` (protocol.ts's Refusal).
 */
export type RequestAnswer<T> =
  | { ok: true; status: number; result: T }
  | { ok: false; status: number; field: "error" | "reason"; reason: string };

export function answered<T>(result: T, status = 200): RequestAnswer<T> {
  return { ok: true, status, result };
}

export function refused(
  status: number,
  field: "error" | "reason",
  reason: unknown,
): RequestAnswer<never> {
  return {
    ok: false,
    status,
    field,
    reason: reason instanceof Error ? reason.message : String(reason),
  };
}

/**
 * An answer less the snapshot its HTTP route carries: on the socket the
 * snapshot's change arrives as a delta ahead of the reply, so the reply
 * never repeats it.
 */
export function withoutSnapshot<T extends object>(
  answer: RequestAnswer<T>,
): RequestAnswer<Omit<T, "snapshot">> {
  if (!answer.ok) return answer;
  const { snapshot: _snapshot, ...result } = answer.result as T & { snapshot?: unknown };
  return { ok: true, status: answer.status, result };
}

/** Every request kind but `log.follow`, which moves this socket's own
 *  subscription and so is answered here. */
export type HandledKind = Exclude<RequestKind, "log.follow">;

/** Each kind's function, as server.ts runs it for the socket. The payload
 *  is the HTTP route's body (or query) as the Console sent it, checked by
 *  the function the way the route checks its body. */
export type RequestHandlers = {
  [K in HandledKind]: (
    payload: Record<string, unknown>,
  ) => Promise<RequestAnswer<RequestResult<K>>>;
};

/** GET /api/log's query. `offset: "tail"` reads the file's last window,
 *  which is the read `log.follow` answers with. */
export interface LogQuery {
  id: string;
  attempt?: number;
  offset: number | "tail";
  end?: number;
  stream: boolean;
}

/** One byte range of a log file, as server.ts's readLogRange reads it. */
export interface LogRange {
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
}

/**
 * The pool as the socket reads it: server.ts's own reads, the ones its
 * routes answer from, handed over so nothing here reads the pool a second
 * way. Everything a card check calls is synchronous, so a card's state is
 * never caught between a read and the frame it makes.
 */
export interface PushSources {
  /** The enriched snapshot as of the engine's last emit. */
  current(): EnrichedSnapshot | null;
  runsDir: string;
  issuesDir: string;
  /** The ticket's Issue file, or null (a Conversation has none). */
  bodyFile(id: string): string | null;
  body(id: string): TicketBodyResponse | null;
  events(id: string): TicketEventsResponse;
  attempts(id: string): LogAttemptInfo[];
  /** A byte range from `from`, or the file's last window. */
  readLog(path: string, from: number | "tail"): LogRange;
  /** GET /api/log's function. */
  log(query: LogQuery): RequestAnswer<TicketLogResponse>;
  activity(id: string): Promise<TicketActivityResponse>;
  /** GET /api/terminal/peek's function. */
  peek(id: string): Promise<RequestAnswer<TerminalPeekResponse>>;
  grades(): Record<string, TicketGradeSummary>;
  request(kind: HandledKind, payload: Record<string, unknown>): Promise<RequestAnswer<unknown>>;
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

/** One socket's own state: whether its tab is visible, and its cards. */
export interface SocketState {
  visible: boolean;
  cards: Map<string, CardSub>;
  /** Cleared on close, so an answer that lands after it goes nowhere. */
  open: boolean;
}

type Socket = Bun.ServerWebSocket<SocketState>;

/** A card one socket holds: what its log follows and what it was sent. */
interface CardSub {
  follow: LogFollow;
  /** The log the socket's pane holds: which file, and how far it has. A
   *  file's inode is 0 while it does not exist yet. */
  log: { attempt: number; stream: boolean; ino: number; offset: number } | null;
  /** The attempt list as this socket last got it, as JSON. */
  attempts: string | null;
}

/** What every subscriber of one card shares: its body and events as they
 *  were last sent, read and serialised once for all of them. A signature
 *  is null until its file has been read without an error. */
interface CardWatch {
  id: string;
  subscribers: Set<Socket>;
  bodySig: string | null;
  bodyJson: string;
  eventsSig: string | null;
  /** As card frames carry them (cardEvents). */
  eventsJson: string;
}

export interface PushHubOptions {
  heartbeatMs: number;
  /** The snapshot push's coalescing window; 0 pushes every emit at once. */
  coalesceMs: number;
  /** The window a card check, a live check run early, and a grades
   *  re-read gather their triggers in. */
  checkMs: number;
}

export interface PushHub {
  /** Bun.serve's `websocket` handler. */
  websocket: Bun.WebSocketHandler<SocketState>;
  /** The state a socket upgraded at WS_PATH starts with: visible, and
   *  holding no card until its hello says otherwise. */
  socketState(): SocketState;
  /** An engine emit landed (or a write rebuilt the last one): push it at
   *  the end of the coalescing window. */
  schedule(): void;
  /** Push whatever is waiting, now. */
  flush(): void;
  /**
   * The served index.html with the first snapshot in it, after a flush, so
   * the Console paints before any script runs or the socket opens; null
   * when there is no such file. Never cached by the browser: the snapshot
   * in it is of this moment.
   */
  page(indexFile: string): Response | null;
  /** The stop's farewell: flush, so the `stopped` delta goes, then close
   *  every socket with CLOSE_STOPPED. */
  closeSockets(): void;
  /** Stop every timer and watch. */
  close(): void;
}

/**
 * The most a log pane holds while it follows the tail (the Console's
 * LOG_PANE_MAX_CHARS). A socket that fell further behind than this, hidden
 * or not, gets a fresh window instead of the appends.
 */
const LOG_PANE_MAX_BYTES = 256 * 1024;

/** The appends one check sends a socket at most; past them a window would
 *  have been cheaper, and the gap rule above sends one. */
const APPENDS_PER_CHECK = 8;

/** How many peeks the live check has in flight at once: reads over the
 *  herdr daemon's socket, which cost the loop next to nothing. */
const LIVE_READS = 4;

/**
 * How many activity reads the live check has in flight at once. Each one
 * starts git (the worktree's diff), and Bun starts a child on the event
 * loop's own thread: a burst of them was one stall of 10 ms and more that
 * every request and frame waited behind. One at a time, with a turn of the
 * loop before each, nothing waits behind more than one start.
 */
const ACTIVITY_READS = 1;

/** A turn of the event loop: whatever arrived meanwhile is answered first. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The most cards one socket holds. The Console holds the selected one and
 *  two hovered; the rest of a hello past this is dropped unread. */
const CARDS_PER_SOCKET = 32;

/** The largest frame a client may send: a hello with every card it may
 *  hold is a few kilobytes. */
const CLIENT_FRAME_MAX_BYTES = 64 * 1024;

/** The events file's name (events.ts's eventsFile). */
const EVENTS_SUFFIX = ".events.jsonl";

const HEARTBEAT_FRAME = encodeMessage({ type: "heartbeat" });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statOf(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// A file's identity and size for change detection. Not the stat cache's
// stamp: that one goes null for two seconds after every write, which reads
// as "unchanged" to a comparison, and the events file is written that often.
// The events file only grows, and an Issue file is rewritten whole.
function sigOf(path: string): string {
  const stat = statOf(path);
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "absent";
}

/**
 * A card's events as its frames carry them: each event's `logTail` left
 * out. It is the attempt's last log lines, which the card's own log
 * already shows and the Console never reads, and over a run it grows an
 * events file to megabytes. GET /api/events serves it as ever.
 */
function cardEvents(events: TicketEventsResponse): TicketEventsResponse {
  return {
    ...events,
    events: events.events.map((event) => {
      if (event.payload === null || typeof event.payload !== "object" || !("logTail" in event.payload)) {
        return event;
      }
      const { logTail: _logTail, ...payload } = event.payload;
      return { ...event, payload };
    }),
  };
}

function followOf(value: unknown): LogFollow {
  const follow = (typeof value === "object" && value !== null ? value : {}) as Partial<LogFollow>;
  return {
    attempt: typeof follow.attempt === "number" ? follow.attempt : null,
    stream: follow.stream === true,
  };
}

// The log a follow reads: the attempt picked, or the latest when none was
// (GET /api/log's own default), and its derived log or Stream file. Null
// while the card has no attempt, or the attempt no Stream file.
function targetOf(
  follow: LogFollow,
  attempts: LogAttemptInfo[],
): { attempt: number; stream: boolean; file: string } | null {
  const info =
    follow.attempt === null ? attempts.at(-1) : attempts.find((a) => a.attempt === follow.attempt);
  if (!info) return null;
  const file = follow.stream ? info.streamFile : info.logFile;
  return file === null ? null : { attempt: info.attempt, stream: follow.stream, file };
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await each(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The ids the live check reads: each vitals candidate (a ticket in progress
// or at a checkpoint, or one a resolver works on) keyed by what decides
// whether it is still running, and each terminal-backed pane by the id the
// Console keys it under.
function liveTargets(snapshot: EnrichedSnapshot | null): {
  candidates: Map<string, string>;
  panes: Map<string, string>;
} {
  const candidates = new Map<string, string>();
  const panes = new Map<string, string>();
  for (const ticket of snapshot?.state.tickets ?? []) {
    if (
      ticket.status === "in-progress" ||
      ticket.status === "checkpoint" ||
      ticket.liveAttempt?.role === "resolver"
    ) {
      candidates.set(ticket.id, JSON.stringify([ticket.status, ticket.liveAttempt]));
    }
    const pane = ticket.liveAttempt?.paneId ?? ticket.heldPane?.paneId ?? null;
    if (pane) panes.set(ticket.id, pane);
  }
  for (const conversation of snapshot?.state.conversations ?? []) {
    if (conversation.paneId) panes.set(conversation.id, conversation.paneId);
  }
  return { candidates, panes };
}

export function createPushHub(sources: PushSources, options: PushHubOptions): PushHub {
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const helloFrame = encodeMessage({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    epoch,
    heartbeatMs: options.heartbeatMs,
  });
  const sockets = new Set<Socket>();
  let visibleCount = 0;
  let closed = false;

  // ---------------------------------------------------------------------
  // The snapshot push
  // ---------------------------------------------------------------------

  // The version every socket was last sent, and the enriched snapshot it
  // was made from: one for the whole server, so every socket is at the
  // same revision and every delta is computed and serialised once.
  let lastPushed: PushedSnapshot | null = null;
  let pushedFrom: EnrichedSnapshot | null = null;
  let snapshotText: { of: PushedSnapshot | null; text: string } | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  function send(ws: Socket, text: string): void {
    if (ws.data.open) ws.sendText(text);
  }

  function broadcast(text: string): void {
    for (const ws of sockets) send(ws, text);
  }

  function snapshotFrame(): string {
    if (snapshotText?.of !== lastPushed) {
      snapshotText = {
        of: lastPushed,
        text: encodeMessage(
          lastPushed
            ? {
                type: "snapshot",
                rev: lastPushed.rev,
                logTotal: lastPushed.logTotal,
                snapshot: lastPushed.snapshot,
              }
            : { type: "snapshot", rev: 0, logTotal: 0, snapshot: null },
        ),
      };
    }
    return snapshotText!.text;
  }

  // The window's end. The snapshot is brought up to date even with no tab
  // open, so the ids the ticket routes accept and the Pool title the run is
  // told follow the engine without waiting for a reader, and the next page
  // load or socket starts from it.
  function flush(): void {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
    const full = sources.current();
    if (full === null || full === pushedFrom) return;
    pushedFrom = full;
    if (lastPushed === null) {
      // The first version since the process started goes whole: the
      // sockets hold the null snapshot of revision 0.
      lastPushed = toPushed(full, 1);
      broadcast(snapshotFrame());
    } else {
      const next = toPushed(full, lastPushed.rev + 1);
      const delta = diffSnapshot(lastPushed, next);
      if (delta === null) return;
      lastPushed = next;
      broadcast(encodeMessage({ type: "delta", delta }));
    }
    pushed();
  }

  // A flush no caller can take the error from: an enrichment that fails is
  // reported, and the next emit or request tries again.
  function flushQuietly(): void {
    try {
      flush();
    } catch (err) {
      console.error(`snapshot push: ${errorText(err)}`);
    }
  }

  function schedule(): void {
    if (options.coalesceMs <= 0) flush();
    else if (sendTimer === null) sendTimer = setTimeout(flushQuietly, options.coalesceMs);
  }

  function rev(): number {
    return lastPushed?.rev ?? 0;
  }

  // ---------------------------------------------------------------------
  // The live check
  // ---------------------------------------------------------------------

  // The values the live frames were made from, each with its JSON, so a
  // check sends only what moved and a socket turning visible gets the lot.
  const activity = new Map<string, { json: string; value: TicketActivityResponse }>();
  const peeks = new Map<string, { json: string; value: TerminalPeekResponse | PeekFailure }>();
  let grades: { json: string; value: Record<string, TicketGradeSummary> } = { json: "{}", value: {} };
  let wholeLive: string | null | undefined;
  // Candidates whose last activity said nothing was running, each under the
  // key it said it for: skipped until a push moves its status or its live
  // attempt (the rule the Console's vitals polling kept before).
  const parked = new Map<string, string>();
  // The candidate and pane sets as the last push left them, so a push that
  // adds one runs a check at once instead of 2 s later.
  let liveKey = "";
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let liveSoon: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  let checkAgain = false;

  function wholeLiveFrame(): string | null {
    if (wholeLive === undefined) {
      const frame: Extract<ServerMessage, { type: "live" }> = { type: "live" };
      if (activity.size > 0) {
        frame.activity = Object.fromEntries([...activity].map(([id, { value }]) => [id, value]));
      }
      if (peeks.size > 0) {
        frame.peeks = Object.fromEntries([...peeks].map(([id, { value }]) => [id, value]));
      }
      if (grades.json !== "{}") frame.grades = grades.value;
      wholeLive = Object.keys(frame).length > 1 ? encodeMessage(frame) : null;
    }
    return wholeLive;
  }

  function pushed(): void {
    const { candidates, panes } = liveTargets(lastPushed!.snapshot);
    const key = JSON.stringify([[...candidates], [...panes]]);
    if (key === liveKey) return;
    liveKey = key;
    if (visibleCount > 0) checkLiveSoon();
  }

  function checkLiveSoon(): void {
    if (closed || liveSoon !== null) return;
    liveSoon = setTimeout(() => {
      liveSoon = null;
      void checkLive();
    }, options.checkMs);
  }

  // One check at a time: one asked for while another runs is run once more
  // when it ends.
  async function checkLive(): Promise<void> {
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      do {
        checkAgain = false;
        await liveCheck();
      } while (checkAgain && !closed);
    } catch (err) {
      console.error(`live check: ${errorText(err)}`);
    } finally {
      checking = false;
    }
  }

  async function liveCheck(): Promise<void> {
    if (closed || visibleCount === 0) return;
    // The backstop for a watch event that never came (FSEvents coalesces):
    // a missed one costs at most this check's interval.
    for (const card of watches.values()) checkCardQuietly(card);

    const { candidates, panes } = liveTargets(lastPushed?.snapshot ?? null);
    const due = [...candidates].filter(([id, key]) => parked.get(id) !== key).map(([id]) => id);
    const paneIds = [...panes.keys()];
    const [activities, peeked] = await Promise.all([
      mapLimit(due, ACTIVITY_READS, async (id) => {
        await nextTurn();
        return sources.activity(id).catch(() => null);
      }),
      mapLimit(paneIds, LIVE_READS, async (id): Promise<TerminalPeekResponse | PeekFailure> => {
        try {
          const answer = await sources.peek(id);
          return answer.ok ? answer.result : { ticket: id, error: answer.reason };
        } catch (err) {
          return { ticket: id, error: errorText(err) };
        }
      }),
    ]);
    if (closed) return;

    const frame: Extract<ServerMessage, { type: "live" }> = { type: "live" };
    activities.forEach((value, i) => {
      const id = due[i]!;
      // A read that failed keeps the last value; the next check retries.
      if (value === null) return;
      if (value.running) parked.delete(id);
      else parked.set(id, candidates.get(id)!);
      const json = JSON.stringify(value);
      if (activity.get(id)?.json === json) return;
      activity.set(id, { json, value });
      (frame.activity ??= {})[id] = value;
    });
    peeked.forEach((value, i) => {
      const id = paneIds[i]!;
      const json = JSON.stringify(value);
      if (peeks.get(id)?.json === json) return;
      peeks.set(id, { json, value });
      (frame.peeks ??= {})[id] = value;
    });
    // Ids that left the candidate or pane sets are forgotten, so one that
    // comes back is read and sent afresh.
    for (const id of [...activity.keys()]) if (!candidates.has(id)) activity.delete(id);
    for (const id of [...parked.keys()]) if (!candidates.has(id)) parked.delete(id);
    for (const id of [...peeks.keys()]) if (!panes.has(id)) peeks.delete(id);
    wholeLive = undefined;

    const gradesMoved = readGrades();
    if (gradesMoved) frame.grades = grades.value;
    if (frame.activity || frame.peeks || frame.grades) {
      const text = encodeMessage(frame);
      // Grades go to hidden tabs too: they are rare and cheap, and the tab
      // comes back current.
      const hiddenText = gradesMoved ? encodeMessage({ type: "live", grades: grades.value }) : null;
      for (const ws of sockets) {
        if (ws.data.visible) send(ws, text);
        else if (hiddenText !== null) send(ws, hiddenText);
      }
    }
  }

  // Re-derives the grades; true when they moved since they were last sent.
  function readGrades(): boolean {
    const value = sources.grades();
    const json = JSON.stringify(value);
    if (json === grades.json) return false;
    grades = { json, value };
    wholeLive = undefined;
    return true;
  }

  // An events file changed: the grades may have, and they go to every tab.
  let gradesSoon: ReturnType<typeof setTimeout> | null = null;
  function checkGradesSoon(): void {
    if (closed || gradesSoon !== null) return;
    gradesSoon = setTimeout(() => {
      gradesSoon = null;
      try {
        if (readGrades()) broadcast(encodeMessage({ type: "live", grades: grades.value }));
      } catch (err) {
        console.error(`grades: ${errorText(err)}`);
      }
    }, options.checkMs);
  }

  function visibleChanged(): void {
    if (visibleCount > 0 && liveTimer === null && !closed) {
      liveTimer = setInterval(() => void checkLive(), LIVE_CHECK_MS);
    } else if (visibleCount === 0 && liveTimer !== null) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------

  const watches = new Map<string, CardWatch>();
  const dirty = new Set<string>();
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  let watchers: FSWatcher[] = [];

  // The ids the pushed snapshot holds, gathered once per version. A card is
  // one the Console found there, so that is the whole check: an id the pool
  // does not know costs a lookup, never a read of the disk.
  let knownIds: { of: PushedSnapshot | null; ids: Set<string> } | null = null;
  function known(id: string): boolean {
    if (knownIds?.of !== lastPushed) {
      const state = lastPushed?.snapshot.state;
      knownIds = {
        of: lastPushed,
        ids: new Set([
          ...(state?.tickets ?? []).map((ticket) => ticket.id),
          ...(state?.conversations ?? []).map((conversation) => conversation.id),
        ]),
      };
    }
    return knownIds.ids.has(id);
  }

  // Re-reads a card's body and events when their files moved, and sends
  // every subscriber what changed in one frame. The events carry the
  // ticket's spec, which is the Issue file's, so a body that moved re-reads
  // them too. Both are read before either is kept, so a read that throws
  // leaves the card as it was and the next check reads it again.
  function refreshCard(card: CardWatch): void {
    const bodyFile = sources.bodyFile(card.id);
    const bodySig = bodyFile === null ? "none" : `${bodyFile}:${sigOf(bodyFile)}`;
    const eventsSig = sigOf(join(sources.runsDir, `${card.id}${EVENTS_SUFFIX}`));
    const bodyMoved = bodySig !== card.bodySig;
    if (!bodyMoved && eventsSig === card.eventsSig) return;
    const bodyJson = bodyMoved ? JSON.stringify(sources.body(card.id)) : card.bodyJson;
    const eventsJson = JSON.stringify(cardEvents(sources.events(card.id)));
    const fields: string[] = [];
    if (bodyJson !== card.bodyJson) fields.push(`"body":${bodyJson}`);
    if (eventsJson !== card.eventsJson) fields.push(`"events":${eventsJson}`);
    Object.assign(card, { bodySig, bodyJson, eventsSig, eventsJson });
    if (fields.length > 0 && card.subscribers.size > 0) {
      const text = `{"type":"card","id":${JSON.stringify(card.id)},${fields.join(",")}}`;
      for (const ws of card.subscribers) send(ws, text);
    }
  }

  type Attempts = { list: LogAttemptInfo[]; json: string };
  // What one check read, by path: subscribers that follow the same file
  // share one stat, and those at the same place in it share one read.
  interface CheckMemo {
    stats: Map<string, Stats | null>;
    frames: Map<string, { texts: string[]; ino: number; next: number }>;
  }
  const newMemo = (): CheckMemo => ({ stats: new Map(), frames: new Map() });

  function attemptsOf(id: string): Attempts {
    const list = sources.attempts(id);
    return { list, json: JSON.stringify(list) };
  }

  // A log window: the last LOG_CHUNK_BYTES of the followed file, which is
  // what the log pane's open read before (an absent file is an empty one).
  function windowOf(
    target: NonNullable<ReturnType<typeof targetOf>>,
    attempts: Attempts,
  ): LogPush {
    return {
      mode: "window",
      attempt: target.attempt,
      stream: target.stream,
      ...sources.readLog(join(sources.runsDir, target.file), "tail"),
      attempts: attempts.list,
    };
  }

  // Brings one socket's log for one card up to date: appends from where it
  // is, or a window when it follows another attempt now, the file was
  // replaced or shrank, or more was missed than the pane would keep.
  function pushLog(ws: Socket, id: string, sub: CardSub, attempts: Attempts, memo: CheckMemo): void {
    const target = targetOf(sub.follow, attempts.list);
    if (target === null) return;
    const path = join(sources.runsDir, target.file);
    if (!memo.stats.has(path)) memo.stats.set(path, statOf(path));
    const stat = memo.stats.get(path) ?? null;
    const ino = stat?.ino ?? 0;
    const size = stat?.size ?? 0;
    const held = sub.log;
    const continues =
      held !== null &&
      held.attempt === target.attempt &&
      held.stream === target.stream &&
      (held.ino === ino || held.ino === 0) &&
      size >= held.offset &&
      size - held.offset <= LOG_PANE_MAX_BYTES;
    if (!continues) {
      const key = `window:${path}`;
      let made = memo.frames.get(key);
      if (!made) {
        const push = windowOf(target, attempts);
        made = { texts: [encodeMessage({ type: "card", id, log: push })], ino, next: push.nextOffset };
        memo.frames.set(key, made);
      }
      for (const text of made.texts) send(ws, text);
      sub.log = { attempt: target.attempt, stream: target.stream, ino: made.ino, offset: made.next };
      sub.attempts = attempts.json;
      return;
    }
    held.ino = ino;
    const withAttempts = sub.attempts !== attempts.json;
    if (size === held.offset && !withAttempts) return;
    const key = `append:${path}:${held.offset}:${withAttempts}`;
    let made = memo.frames.get(key);
    if (!made) {
      made = { ...appendsOf(id, target, path, held.offset, withAttempts ? attempts.list : undefined), ino };
      memo.frames.set(key, made);
    }
    for (const text of made.texts) send(ws, text);
    held.offset = made.next;
    sub.attempts = attempts.json;
  }

  // The bytes past `from`, in LOG_CHUNK_BYTES appends. An attempt list that
  // changed rides the first one, which is sent even with no new bytes so
  // the list still arrives.
  function appendsOf(
    id: string,
    target: NonNullable<ReturnType<typeof targetOf>>,
    path: string,
    from: number,
    attempts: LogAttemptInfo[] | undefined,
  ): { texts: string[]; next: number } {
    const texts: string[] = [];
    let offset = from;
    let carry = attempts;
    for (let i = 0; i < APPENDS_PER_CHECK; i++) {
      const range = sources.readLog(path, offset);
      const moved = range.nextOffset > offset;
      if (!moved && carry === undefined) break;
      const log: LogPush = {
        mode: "append",
        attempt: target.attempt,
        stream: target.stream,
        ...range,
        ...(carry !== undefined ? { attempts: carry } : {}),
      };
      texts.push(encodeMessage({ type: "card", id, log }));
      carry = undefined;
      // A char or an escape sequence still arriving whole stops the read
      // short of the end; the next check brings it.
      if (!moved) break;
      offset = range.nextOffset;
      if (offset >= range.totalSize) break;
    }
    return { texts, next: offset };
  }

  // One card's check: its body and events for every subscriber, and its
  // log for every visible one. No append goes to a hidden tab; it catches
  // up when it is visible again.
  function checkCard(card: CardWatch): void {
    refreshCard(card);
    let attempts: Attempts | null = null;
    const memo = newMemo();
    for (const ws of card.subscribers) {
      if (!ws.data.visible) continue;
      const sub = ws.data.cards.get(card.id);
      if (!sub) continue;
      attempts ??= attemptsOf(card.id);
      pushLog(ws, card.id, sub, attempts, memo);
    }
  }

  // A check that cannot read a card's files is reported, and the next one
  // tries again: one card's trouble never stops the others' checks.
  function checkCardQuietly(card: CardWatch): void {
    try {
      checkCard(card);
    } catch (err) {
      console.error(`card ${card.id}: ${errorText(err)}`);
    }
  }

  function checkCardSoon(id: string): void {
    if (!watches.has(id)) return;
    dirty.add(id);
    if (closed || cardTimer !== null) return;
    cardTimer = setTimeout(() => {
      cardTimer = null;
      const ids = [...dirty];
      dirty.clear();
      for (const id of ids) {
        const card = watches.get(id);
        if (card) checkCardQuietly(card);
      }
    }, options.checkMs);
  }

  function refuseCard(ws: Socket, id: string, error: string): void {
    send(ws, encodeMessage({ type: "card", id, error }));
  }

  function subscribe(ws: Socket, subscription: CardSubscription): void {
    const id = subscription.id;
    if (!known(id)) {
      unsubscribe(ws, id);
      refuseCard(ws, id, `unknown ticket ${id}`);
      return;
    }
    if (!ws.data.cards.has(id) && ws.data.cards.size >= CARDS_PER_SOCKET) {
      refuseCard(ws, id, `a socket holds at most ${CARDS_PER_SOCKET} cards`);
      return;
    }
    const held = watches.get(id);
    const card: CardWatch = held ?? {
      id,
      subscribers: new Set(),
      bodySig: null,
      bodyJson: "",
      eventsSig: null,
      eventsJson: "",
    };
    const sub: CardSub = { follow: followOf(subscription.follow), log: null, attempts: null };
    let log: LogPush | null = null;
    try {
      // Anything that moved since the card was last read goes to the
      // sockets already holding it, before this one joins them.
      refreshCard(card);
      const attempts = attemptsOf(id);
      const target = targetOf(sub.follow, attempts.list);
      if (target !== null) {
        const ino = statOf(join(sources.runsDir, target.file))?.ino ?? 0;
        log = windowOf(target, attempts);
        sub.log = { attempt: target.attempt, stream: target.stream, ino, offset: log.nextOffset };
        sub.attempts = attempts.json;
      }
    } catch (err) {
      // Nothing is kept of a card whose files could not be read: the tab
      // is told, and its next subscribe reads the card afresh.
      unsubscribe(ws, id);
      refuseCard(ws, id, `card ${id} could not be read: ${errorText(err)}`);
      return;
    }
    if (!held) watches.set(id, card);
    ws.data.cards.set(id, sub);
    card.subscribers.add(ws);
    // The three in one frame, so they paint in one render. Spliced from the
    // JSON already made, in encodeMessage's own key order, so a large
    // events list is serialised once per change, not once per subscribe.
    send(
      ws,
      `{"type":"card","id":${JSON.stringify(id)},"body":${card.bodyJson},` +
        `"events":${card.eventsJson},"log":${JSON.stringify(log)}}`,
    );
  }

  function unsubscribe(ws: Socket, id: string): void {
    ws.data.cards.delete(id);
    const card = watches.get(id);
    if (!card) return;
    card.subscribers.delete(ws);
    if (card.subscribers.size === 0) {
      watches.delete(id);
      dirty.delete(id);
    }
  }

  // `log.follow`: point the card's appends at another attempt or variant,
  // answering with that file's tail window, which is GET /api/log's read,
  // named by the attempt and variant it was read from: a follow of the
  // latest attempt learns here which one that is. A frame already on the
  // wire may still name the old one; the Console drops an append that does
  // not match its pane.
  function follow(ws: Socket, payload: Record<string, unknown>): RequestAnswer<LogFollowResult> {
    const id = typeof payload.id === "string" ? payload.id : "";
    const wanted = followOf(payload);
    const read = sources.log({
      id,
      ...(wanted.attempt !== null ? { attempt: wanted.attempt } : {}),
      offset: "tail",
      stream: wanted.stream,
    });
    // The follow moves even when there is nothing to read yet: the window
    // comes with the first check that finds the file.
    const sub = ws.data.cards.get(id);
    if (sub) {
      sub.follow = wanted;
      sub.log = null;
      sub.attempts = null;
    }
    if (!read.ok) return read;
    // The read resolves the attempt and its file exactly as targetOf does,
    // so a read that answered has a target.
    const target = targetOf(wanted, read.result.attempts)!;
    if (sub) {
      sub.log = {
        attempt: target.attempt,
        stream: target.stream,
        ino: statOf(join(sources.runsDir, target.file))?.ino ?? 0,
        offset: read.result.nextOffset,
      };
      sub.attempts = JSON.stringify(read.result.attempts);
    }
    return {
      ...read,
      result: { ...read.result, attempt: target.attempt, stream: target.stream },
    };
  }

  // The runs and issues directories, watched while any socket is open: the
  // runs one also moves the grades, which every tab gets. Non-recursive, so
  // it behaves alike under inotify and FSEvents; an event that names no
  // file checks every card.
  function watchFiles(): void {
    if (watchers.length > 0) return;
    const onRuns = (name: string | null): void => {
      if (name === null || name.endsWith(EVENTS_SUFFIX)) checkGradesSoon();
      for (const id of watches.keys()) {
        if (name === null || name.startsWith(`${id}.`)) checkCardSoon(id);
      }
    };
    const onIssues = (name: string | null): void => {
      for (const id of watches.keys()) {
        if (name === null || name === `${id}.md` || name.startsWith(`${id}-`)) checkCardSoon(id);
      }
    };
    for (const [dir, onName] of [
      [sources.runsDir, onRuns],
      [sources.issuesDir, onIssues],
    ] as const) {
      try {
        const watcher = watch(dir, { persistent: false }, (_event, name) => {
          onName(name === null ? null : String(name));
        });
        // A directory removed under the watch ends it quietly; the backstop
        // stat in the live check carries on without it.
        watcher.on("error", () => {});
        watchers.push(watcher);
      } catch {
        // Not watchable here: the live check's stat still finds changes.
      }
    }
  }

  function unwatchFiles(): void {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  }

  // ---------------------------------------------------------------------
  // Sockets
  // ---------------------------------------------------------------------

  let heartbeat: ReturnType<typeof setInterval> | null = null;

  function setVisible(ws: Socket, visible: boolean): void {
    if (ws.data.visible === visible) return;
    ws.data.visible = visible;
    visibleCount += visible ? 1 : -1;
    visibleChanged();
    if (!visible) return;
    // Back in view: the live values as they stand, each card's log from
    // where the tab left it, then a fresh check.
    const whole = wholeLiveFrame();
    if (whole !== null) send(ws, whole);
    for (const [id, sub] of ws.data.cards) {
      if (!watches.has(id)) continue;
      try {
        pushLog(ws, id, sub, attemptsOf(id), newMemo());
      } catch (err) {
        console.error(`card ${id}: ${errorText(err)}`);
      }
    }
    checkLiveSoon();
  }

  function hello(ws: Socket, visible: boolean, cards: CardSubscription[]): void {
    // The hello's cards are the whole of what the tab holds, up to the cap.
    const held = cards.slice(0, CARDS_PER_SOCKET);
    const wanted = new Set(held.map((card) => card.id));
    for (const id of [...ws.data.cards.keys()]) if (!wanted.has(id)) unsubscribe(ws, id);
    setVisible(ws, visible);
    // Each card on its own: one that cannot be read leaves the rest held.
    for (const card of held) {
      try {
        subscribe(ws, card);
      } catch (err) {
        console.error(`socket: card ${card.id}: ${errorText(err)}`);
      }
    }
  }

  function reply(ws: Socket, id: number, kind: RequestKind, answer: RequestAnswer<unknown>): void {
    send(
      ws,
      encodeMessage(
        (answer.ok
          ? { type: "reply", id, kind, rev: rev(), ok: true, result: answer.result }
          : {
              type: "reply",
              id,
              kind,
              rev: rev(),
              ok: false,
              refusal: { reason: answer.reason, status: answer.status },
            }) as ServerMessage,
      ),
    );
  }

  async function request(
    ws: Socket,
    id: number,
    kind: RequestKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let answer: RequestAnswer<unknown>;
    try {
      answer = kind === "log.follow" ? follow(ws, payload) : await sources.request(kind, payload);
    } catch (err) {
      answer = refused(500, "error", err);
    }
    // An action's effect goes out as a delta ahead of its reply, so the
    // reply finds the confirmed state already in the tab's hands.
    if (ACTION_KINDS.has(kind)) flushQuietly();
    reply(ws, id, kind, answer);
  }

  // A frame that is not this protocol's is logged and dropped; a request
  // that can still be answered is refused, so its press does not hang.
  function undecodable(ws: Socket, raw: string, err: unknown): void {
    console.error(`socket: dropped a frame: ${errorText(err)}`);
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const { type, id, kind } = frame as Record<string, unknown>;
    if (
      type === "request" &&
      Number.isSafeInteger(id) &&
      (id as number) >= 0 &&
      typeof kind === "string" &&
      Object.hasOwn(HTTP_TWINS, kind)
    ) {
      reply(ws, id as number, kind as RequestKind, refused(400, "error", err));
    }
  }

  function message(ws: Socket, raw: string | Buffer): void {
    if (typeof raw !== "string") {
      console.error("socket: dropped a binary frame");
      return;
    }
    let decoded: ClientMessage;
    try {
      decoded = decodeClientMessage(raw);
    } catch (err) {
      undecodable(ws, raw, err);
      return;
    }
    try {
      switch (decoded.type) {
        case "hello":
          hello(ws, decoded.visible, decoded.cards);
          break;
        case "visibility":
          setVisible(ws, decoded.visible);
          break;
        case "subscribe":
          subscribe(ws, decoded.card);
          break;
        case "unsubscribe":
          unsubscribe(ws, decoded.id);
          break;
        case "request":
          void request(ws, decoded.id, decoded.kind, decoded.payload as Record<string, unknown>);
          break;
      }
    } catch (err) {
      // A read that failed under a subscribe (a file torn mid-write): the
      // socket stays up, and the backstop check retries the card.
      console.error(`socket: ${decoded.type}: ${errorText(err)}`);
    }
  }

  function open(ws: Socket): void {
    // Anything waiting goes to the sockets already open first, so this one
    // starts from the version they are all at.
    flushQuietly();
    send(ws, helloFrame);
    send(ws, snapshotFrame());
    if (closed) {
      // Opened in a stop's last moments: the farewell, and the same close.
      ws.close(CLOSE_STOPPED.code, CLOSE_STOPPED.reason);
      return;
    }
    sockets.add(ws);
    if (sockets.size === 1) {
      heartbeat = setInterval(() => broadcast(HEARTBEAT_FRAME), options.heartbeatMs);
      watchFiles();
    }
    // Visible until its hello says otherwise.
    visibleCount += 1;
    visibleChanged();
    const whole = wholeLiveFrame();
    if (whole !== null) send(ws, whole);
    checkLiveSoon();
  }

  function socketClosed(ws: Socket): void {
    ws.data.open = false;
    if (!sockets.delete(ws)) return;
    for (const id of [...ws.data.cards.keys()]) unsubscribe(ws, id);
    if (ws.data.visible) {
      visibleCount -= 1;
      visibleChanged();
    }
    if (sockets.size === 0) {
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      unwatchFiles();
    }
  }

  // The page is read once per build (its mtime) and made once per
  // revision, so a reload costs a stat while nothing moved.
  let html: { mtimeMs: number; text: string } | null = null;
  let made: { mtimeMs: number; rev: number; text: string } | null = null;
  function page(indexFile: string): Response | null {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(indexFile).mtimeMs;
    } catch {
      return null;
    }
    if (html?.mtimeMs !== mtimeMs) html = { mtimeMs, text: readFileSync(indexFile, "utf8") };
    flushQuietly();
    if (made?.mtimeMs !== mtimeMs || made.rev !== rev()) {
      const boot: EmbeddedBoot = {
        protocol: PROTOCOL_VERSION,
        epoch,
        rev: rev(),
        logTotal: lastPushed?.logTotal ?? 0,
        snapshot: lastPushed?.snapshot ?? null,
      };
      made = { mtimeMs, rev: boot.rev, text: embedBoot(html.text, boot) };
    }
    return new Response(made.text, {
      headers: { "content-type": "text/html", "cache-control": "no-store" },
    });
  }

  function dispose(): void {
    closed = true;
    for (const timer of [sendTimer, liveSoon, cardTimer, gradesSoon]) {
      if (timer !== null) clearTimeout(timer);
    }
    sendTimer = liveSoon = cardTimer = gradesSoon = null;
    if (liveTimer !== null) clearInterval(liveTimer);
    if (heartbeat !== null) clearInterval(heartbeat);
    liveTimer = heartbeat = null;
    unwatchFiles();
  }

  return {
    websocket: {
      // Bun's defaults, said out loud: a socket silent for two minutes,
      // pongs included, is reaped, and the server pings on its own, which
      // every browser answers without the page's help.
      idleTimeout: 120,
      sendPings: true,
      maxPayloadLength: CLIENT_FRAME_MAX_BYTES,
      // A tab too far behind to take more is closed rather than sent a
      // stream with frames missing: the reconnect brings it a fresh
      // snapshot, where a dropped frame would leave a press waiting.
      closeOnBackpressureLimit: true,
      open,
      message,
      close: socketClosed,
    },
    socketState: () => ({ visible: true, cards: new Map(), open: true }),
    schedule,
    flush,
    page,
    closeSockets() {
      flushQuietly();
      dispose();
      for (const ws of [...sockets]) ws.close(CLOSE_STOPPED.code, CLOSE_STOPPED.reason);
    },
    close: dispose,
  };
}
