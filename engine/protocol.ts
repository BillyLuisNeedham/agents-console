/**
 * The Console's push protocol (issue #161, ADR-0032): the one WebSocket at
 * `/api/ws` the Console and its pool server talk over, declared once. Like
 * wire.ts it is the engine's to own and the Console's to type-import. It
 * holds shapes and constants only: the Rust port (issue #162) generates this
 * file at its flip, and a generated file carries nothing else (ADR-0036).
 * The code that works on these shapes, the snapshot diff and its apply, the
 * pool log's trim and the envelope's encode and decode, is ui/src/protocol.ts,
 * which the server and the browser both run.
 *
 * The socket carries four things. The pool snapshot: whole when the socket
 * opens, then as deltas keyed by ticket and Conversation id, every version
 * numbered by a server-side revision. The live values nothing else pushes
 * (activity, terminal peeks, grades), sent only when they change. The
 * subscribed cards' data (body, events, log tail and its appends). And
 * requests with replies, one per HTTP action or read the Console used to
 * fetch, each answered under its own id with the route's existing response
 * type or one refusal shape.
 */

import type {
  CloseFinishedTerminalsResponse,
  ConversationView,
  EnlistRequest,
  EnlistResponse,
  EnrichedSnapshot,
  EnrichedTicketState,
  HeldSpawnRequest,
  HeldSpawnResponse,
  KeepTalkingRequest,
  KeepTalkingResponse,
  MachineDefaultsRequest,
  PanesResponse,
  PendingSpawnRequest,
  PendingSpawnResponse,
  PoolSettingsRequest,
  ReassignRequest,
  ReassignResponse,
  RestartResponse,
  ResumeAction,
  SettingsResponse,
  StartConversationRequest,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
} from "./wire.ts";

/**
 * Bumped on every change to a message's shape. The server says its version
 * in `hello`; a page that was built for another one reloads itself, which is
 * how a Restart that rebuilt the UI reaches a tab left open across it.
 */
export const PROTOCOL_VERSION = 1;

/** Where the socket is served. */
export const WS_PATH = "/api/ws";

/** The server's heartbeat cadence, served in `hello`; this is its default. */
export const HEARTBEAT_MS = 20_000;

/** A socket silent for this many heartbeats is closed and reopened. */
export const SILENCE_FACTOR = 3;

/** The reconnect delays after a socket closes, the last one repeating. */
export const RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 3_000];

/** How many of `state.log`'s last lines the snapshot carries. */
export const POOL_LOG_WINDOW = 500;

/** The server's one check of activity, peeks and subscribed files. */
export const LIVE_CHECK_MS = 2_000;

/** How long the pointer rests on a card before the Console prefetches it. */
export const HOVER_DWELL_MS = 100;

/** How many hovered cards stay subscribed beside the selected one. */
export const HOVER_SUBSCRIPTIONS = 2;

/** The id of the script element the served index.html carries the first snapshot in. */
export const EMBED_ELEMENT_ID = "console-boot";

/**
 * The close the server ends a socket with after the `stopped` farewell
 * (ADR-0019): a clean close the client reads as the expected end of an
 * orderly shutdown, never as a fault.
 */
export const CLOSE_STOPPED = { code: 1000, reason: "stopped" } as const;

/** The close a client ends its own socket with when a delta does not fit
 *  the revision it holds; the reconnect brings a fresh snapshot. */
export const CLOSE_RESYNC = { code: 4001, reason: "resync" } as const;

// ---------------------------------------------------------------------------
// The snapshot as pushed
// ---------------------------------------------------------------------------

/**
 * One version of the snapshot as the socket carries it: the enriched
 * snapshot with `state.log` cut to its last POOL_LOG_WINDOW lines, the full
 * log's length beside it so the Console knows there is more to load, and
 * the revision. The revision counts every version the server pushed, which
 * `seq` cannot: enrichment (a Reassign, a settings save, a ticket file
 * landing) changes the snapshot without the engine emitting.
 */
export interface PushedSnapshot {
  rev: number;
  logTotal: number;
  snapshot: EnrichedSnapshot;
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

type TopFields = Omit<EnrichedSnapshot, "state">;
type TopKey = keyof TopFields;
type StateFields = Omit<EnrichedSnapshot["state"], "tickets" | "conversations" | "log">;

/**
 * A keyed list's change: the entities that are new or changed, whole; the
 * ids that went; and the full id order, present only when the order of ids
 * moved (an add, a removal or a reorder).
 */
export interface EntityDelta<T> {
  upsert?: T[];
  remove?: string[];
  order?: string[];
}

/** New pool log lines past the old end, or a whole new window when the log
 *  did not simply grow (a new run's log). Either way, the new total. */
export type PoolLogDelta =
  | { append: string[]; total: number }
  | { replace: string[]; total: number };

/**
 * One version to the next. `base` is the revision it applies to and `rev`
 * the one it makes. Tickets and Conversations change by id; every other
 * field is replaced whole when it changed, the top-level ones under `set`
 * (an optional one that went under `unset`) and those inside `state` under
 * `state`. A field absent from the delta is unchanged.
 */
export interface SnapshotDelta {
  base: number;
  rev: number;
  set?: Partial<TopFields>;
  unset?: TopKey[];
  state?: Partial<StateFields>;
  tickets?: EntityDelta<EnrichedTicketState>;
  conversations?: EntityDelta<ConversationView>;
  log?: PoolLogDelta;
}

// ---------------------------------------------------------------------------
// Requests and replies
// ---------------------------------------------------------------------------

/** A request with nothing to say, and a reply with nothing to add: the
 *  change it made arrives as a delta ahead of the reply. */
export type Empty = Record<string, never>;

/** POST /api/resume's body. */
export interface ResumeRequest {
  ticketId: string;
  action: ResumeAction;
  note?: string;
  /** The Candidate an `adopt` takes (ADR-0035): required with `adopt` and
   *  refused with every other action. */
  attempt?: number;
}

/** The ticket (or Conversation) whose pane "Open in herdr" focuses. */
export interface TerminalFocusRequest {
  ticketId: string;
}

/** POST /api/terminal/focus's answer: the pane it focused. */
export interface TerminalFocusResponse {
  ok: true;
  paneId: string;
}

/** POST /api/conversations/end's body. */
export interface EndConversationRequest {
  id: string;
  closing?: string;
}

/** GET /api/log's query: one byte range of an attempt's log or Stream file.
 *  `attempt` absent is the latest; `end` bounds a "load earlier" read. */
export interface LogReadRequest {
  id: string;
  attempt?: number;
  offset: number;
  end?: number;
  stream?: boolean;
}

/**
 * Which log a subscribed card's appends follow: an attempt picked by hand,
 * or null for whichever attempt is latest (a new attempt starting moves the
 * pane to it), and its derived log or its Stream file.
 */
export interface LogFollow {
  attempt: number | null;
  stream: boolean;
}

/** Point a subscribed card's log at another attempt or variant. */
export interface LogFollowRequest extends LogFollow {
  id: string;
}

/** `log.follow`'s reply: the new tail window, naming the attempt and variant
 *  it is for, since a follow of `attempt: null` resolves on the server. */
export interface LogFollowResult extends TicketLogResponse {
  attempt: number;
  stream: boolean;
}

/** GET /api/pool-log's query: up to `limit` pool log lines ending before
 *  line `before` (0-based, of the full log). */
export interface PoolLogReadRequest {
  before: number;
  limit?: number;
}

/** A run of the pool log: `lines` are lines `start`.. of a log `total` long. */
export interface PoolLogRange {
  start: number;
  lines: string[];
  total: number;
}

/**
 * Every request the socket takes, by kind: what it carries and what a
 * success answers with. Each one is an HTTP route's twin (HTTP_TWINS) and
 * runs the same function the route does; the result is the route's own
 * response type, less any snapshot it carried, since the snapshot's change
 * reaches the socket as a delta ahead of the reply.
 */
export interface Requests {
  start: { payload: Empty; result: Empty };
  resume: { payload: ResumeRequest; result: Empty };
  stop: { payload: Empty; result: { stopping: true } };
  restart: { payload: Empty; result: RestartResponse };
  keepTalking: { payload: KeepTalkingRequest; result: KeepTalkingResponse };
  "terminal.focus": { payload: TerminalFocusRequest; result: TerminalFocusResponse };
  "terminals.closeFinished": { payload: Empty; result: CloseFinishedTerminalsResponse };
  enlist: { payload: EnlistRequest; result: EnlistResponse };
  reassign: { payload: ReassignRequest; result: Omit<ReassignResponse, "snapshot"> };
  "spawns.held.adopt": { payload: HeldSpawnRequest; result: HeldSpawnResponse };
  "spawns.held.discard": { payload: HeldSpawnRequest; result: HeldSpawnResponse };
  "spawns.pending.hold": { payload: PendingSpawnRequest; result: PendingSpawnResponse };
  "spawns.pending.discard": { payload: PendingSpawnRequest; result: PendingSpawnResponse };
  "conversations.start": {
    payload: StartConversationRequest;
    result: { conversation: ConversationView };
  };
  "conversations.end": { payload: EndConversationRequest; result: Empty };
  "settings.get": { payload: Empty; result: SettingsResponse };
  "settings.pool.put": { payload: PoolSettingsRequest; result: SettingsResponse };
  "settings.machine.put": { payload: MachineDefaultsRequest; result: SettingsResponse };
  "panes.list": { payload: Empty; result: PanesResponse };
  "log.read": { payload: LogReadRequest; result: TicketLogResponse };
  "log.follow": { payload: LogFollowRequest; result: LogFollowResult };
  "poolLog.read": { payload: PoolLogReadRequest; result: PoolLogRange };
}

export type RequestKind = keyof Requests;
export type RequestPayload<K extends RequestKind> = Requests[K]["payload"];
export type RequestResult<K extends RequestKind> = Requests[K]["result"];

/**
 * Each request's HTTP twin, which stays for the Steward's command, Boot,
 * the bench and the tests. `log.follow` reads what `GET /api/log` reads,
 * and the pool log's range is a route new with this protocol.
 */
export const HTTP_TWINS: Record<RequestKind, string> = {
  start: "POST /api/start",
  resume: "POST /api/resume",
  stop: "POST /api/stop",
  restart: "POST /api/restart",
  keepTalking: "POST /api/keep-talking",
  "terminal.focus": "POST /api/terminal/focus?ticket=",
  "terminals.closeFinished": "POST /api/terminals/close-finished",
  enlist: "POST /api/enlist",
  reassign: "PUT /api/reassign",
  "spawns.held.adopt": "POST /api/spawns/held/adopt",
  "spawns.held.discard": "POST /api/spawns/held/discard",
  "spawns.pending.hold": "POST /api/spawns/pending/hold",
  "spawns.pending.discard": "POST /api/spawns/pending/discard",
  "conversations.start": "POST /api/conversations",
  "conversations.end": "POST /api/conversations/end",
  "settings.get": "GET /api/settings",
  "settings.pool.put": "PUT /api/settings/pool",
  "settings.machine.put": "PUT /api/settings/machine",
  "panes.list": "GET /api/panes",
  "log.read": "GET /api/log",
  "log.follow": "GET /api/log",
  "poolLog.read": "GET /api/pool-log",
};

/**
 * The kinds that change something. The server flushes the snapshot's
 * pending push before it replies to one, so the delta carrying the
 * action's effect is always on the socket ahead of its reply.
 */
export const ACTION_KINDS: ReadonlySet<RequestKind> = new Set<RequestKind>([
  "start",
  "resume",
  "stop",
  "restart",
  "keepTalking",
  "terminal.focus",
  "terminals.closeFinished",
  "enlist",
  "reassign",
  "spawns.held.adopt",
  "spawns.held.discard",
  "spawns.pending.hold",
  "spawns.pending.discard",
  "conversations.start",
  "conversations.end",
  "settings.pool.put",
  "settings.machine.put",
]);

/**
 * Every refusal, whichever field the HTTP route puts its reason in today
 * (`error` or `reason`): the reason to show beside the control, and the
 * status the HTTP twin would have answered with. Status 0 is the client's
 * own: the socket closed before the reply came.
 */
export interface Refusal {
  reason: string;
  status: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A card the Console wants kept current: the selected one or a hovered one. */
export interface CardSubscription {
  id: string;
  /** Absent is the latest attempt's derived log. */
  follow?: LogFollow;
}

/**
 * A subscribed card's log, pushed. A `window` replaces what the pane holds
 * (on subscribe, and when the latest attempt the card follows changes); an
 * `append` continues it from `offset`, which is the pane's last
 * `nextOffset`. `attempts` comes on every window and on an append only when
 * the card's attempt list changed.
 */
export interface LogPush {
  mode: "window" | "append";
  attempt: number;
  stream: boolean;
  content: string;
  offset: number;
  nextOffset: number;
  totalSize: number;
  attempts?: TicketLogResponse["attempts"];
}

/** A peek that could not be read: the card shows "pane unavailable". */
export interface PeekFailure {
  ticket: string;
  error: string;
}

export type ClientMessage =
  /** The first frame on every socket, and the whole of a reconnect's
   *  resubscription. */
  | { type: "hello"; protocol: number; visible: boolean; cards: CardSubscription[] }
  | { type: "visibility"; visible: boolean }
  /** Subscribe, or change a subscription's follow; idempotent. */
  | { type: "subscribe"; card: CardSubscription }
  | { type: "unsubscribe"; id: string }
  | {
      [K in RequestKind]: { type: "request"; id: number; kind: K; payload: RequestPayload<K> };
    }[RequestKind];

export type ServerMessage =
  | { type: "hello"; protocol: number; epoch: string; heartbeatMs: number }
  /** The whole snapshot, at `rev`; null before the pool has started. */
  | { type: "snapshot"; rev: number; logTotal: number; snapshot: EnrichedSnapshot | null }
  | { type: "delta"; delta: SnapshotDelta }
  /**
   * Live values that moved since this socket last heard: the changed
   * entries of activity and peeks, by ticket or Conversation id, and the
   * grades whole. Visible sockets only.
   */
  | {
      type: "live";
      activity?: Record<string, TicketActivityResponse>;
      peeks?: Record<string, TerminalPeekResponse | PeekFailure>;
      grades?: Record<string, TicketGradeSummary>;
    }
  /** A subscribed card's data: the fields present replace (or, for an
   *  `append` log, continue) what the Console holds. Its events leave out
   *  each event payload's `logTail`, which GET /api/events still serves.
   *  `error` for an id the pool does not know, or a card whose files could
   *  not be read; the card is then not held. */
  | {
      type: "card";
      id: string;
      body?: TicketBodyResponse | null;
      events?: TicketEventsResponse;
      log?: LogPush | null;
      error?: string;
    }
  /** A request's answer. `rev` is the revision the socket had been sent
   *  when the reply went out, so the action's effect is in hand. */
  | {
      [K in RequestKind]:
        | { type: "reply"; id: number; kind: K; rev: number; ok: true; result: RequestResult<K> }
        | { type: "reply"; id: number; kind: K; rev: number; ok: false; refusal: Refusal };
    }[RequestKind]
  | { type: "heartbeat" };

/** A reply to one kind of request. */
export type Reply<K extends RequestKind> = Extract<ServerMessage, { type: "reply"; kind: K }>;

// ---------------------------------------------------------------------------
// The first snapshot, embedded in the page
// ---------------------------------------------------------------------------

/**
 * What the served index.html carries so the Console paints before the
 * socket opens: the snapshot the socket's first frame will repeat, and the
 * server epoch and revision, so the Console can tell it is the same one
 * and skip the repaint.
 */
export interface EmbeddedBoot {
  protocol: number;
  epoch: string;
  rev: number;
  logTotal: number;
  snapshot: EnrichedSnapshot | null;
}

// ---------------------------------------------------------------------------
// The socket seam
// ---------------------------------------------------------------------------

// A handler property a real WebSocket's own handlers fit: its parameter is
// read bivariantly, as a method's is, so `(ev: MessageEvent) => any` is one.
type Handler<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

/**
 * The part of a browser WebSocket the Console uses. The real one satisfies
 * it; the UI tests and the bench's UI half hand the Console a fake that
 * speaks these messages, so the seam they fake is the wire itself.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}
