//! The Console's push protocol (issue #161, ADR-0032): the one WebSocket at `/api/ws` the Console and
//! its pool server talk over (engine/protocol.ts). It holds shapes and constants only.
//!
//! The socket carries four things. The pool snapshot: whole when the socket opens, then as deltas
//! keyed by ticket and Conversation id, every version numbered by a server-side revision. The live
//! values nothing else pushes (activity, terminal peeks, grades), sent only when they change. The
//! subscribed cards' data (body, events, log tail and its appends). And requests with replies, one
//! per HTTP action or read the Console used to fetch, each answered under its own id with the route's
//! existing response type or one refusal shape.

use indexmap::IndexMap;
use serde::de::Error as _;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::json::True;
use crate::ts::{Decl, DeclBody, Ts, TsDecl, TsField, TsType};
use crate::wire::*;

/// Bumped on every change to a message's shape. The server says its version
/// in `hello`; a page that was built for another one reloads itself, which is
/// how a Restart that rebuilt the UI reaches a tab left open across it.
pub const PROTOCOL_VERSION: u64 = 1;

/// Where the socket is served.
pub const WS_PATH: &str = "/api/ws";

/// The server's heartbeat cadence, served in `hello`; this is its default.
pub const HEARTBEAT_MS: u64 = 20_000;

/// A socket silent for this many heartbeats is closed and reopened.
pub const SILENCE_FACTOR: u64 = 3;

/// The reconnect delays after a socket closes, the last one repeating.
pub const RECONNECT_DELAYS_MS: &[u64] = &[250, 500, 1_000, 2_000, 3_000];

/// How many of `state.log`'s last lines the snapshot carries.
pub const POOL_LOG_WINDOW: usize = 500;

/// The server's one check of activity, peeks and subscribed files.
pub const LIVE_CHECK_MS: u64 = 2_000;

/// How long the pointer rests on a card before the Console prefetches it.
pub const HOVER_DWELL_MS: u64 = 100;

/// How many hovered cards stay subscribed beside the selected one.
pub const HOVER_SUBSCRIPTIONS: u64 = 2;

/// The id of the script element the served index.html carries the first snapshot in.
pub const EMBED_ELEMENT_ID: &str = "console-boot";

/// A WebSocket close: its code and reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CloseFrame {
    pub code: u16,
    pub reason: &'static str,
}

/// The close the server ends a socket with after the `stopped` farewell
/// (ADR-0019): a clean close the client reads as the expected end of an
/// orderly shutdown, never as a fault.
pub const CLOSE_STOPPED: CloseFrame = CloseFrame {
    code: 1000,
    reason: "stopped",
};

/// The close a client ends its own socket with when a delta does not fit
/// the revision it holds; the reconnect brings a fresh snapshot.
pub const CLOSE_RESYNC: CloseFrame = CloseFrame {
    code: 4001,
    reason: "resync",
};

// ---------------------------------------------------------------------------
// The snapshot as pushed
// ---------------------------------------------------------------------------

wire_struct! {
    /// One version of the snapshot as the socket carries it: the enriched
    /// snapshot with `state.log` cut to its last POOL_LOG_WINDOW lines, the full
    /// log's length beside it so the Console knows there is more to load, and
    /// the revision. The revision counts every version the server pushed, which
    /// `seq` cannot: enrichment (a Reassign, a settings save, a ticket file
    /// landing) changes the snapshot without the engine emitting.
    pub struct PushedSnapshot {
        pub rev: u64,
        pub log_total: u64,
        pub snapshot: EnrichedSnapshot,
    }
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

/// A keyed list's change: the entities that are new or changed, whole; the
/// ids that went; and the full id order, present only when the order of ids
/// moved (an add, a removal or a reorder).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityDelta<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upsert: Option<Vec<T>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}

impl<T> Default for EntityDelta<T> {
    fn default() -> Self {
        EntityDelta {
            upsert: None,
            remove: None,
            order: None,
        }
    }
}

const ENTITY_DELTA_DOCS: &[&str] = &[
    " A keyed list's change: the entities that are new or changed, whole; the",
    " ids that went; and the full id order, present only when the order of ids",
    " moved (an add, a removal or a reorder).",
];

impl<T: Ts> Ts for EntityDelta<T> {
    fn ts() -> TsType {
        TsType::Generic("EntityDelta", vec![T::ts()])
    }
}

/// The generic declaration, `EntityDelta<T>`.
pub struct EntityDeltaDecl;

impl TsDecl for EntityDeltaDecl {
    fn decl() -> Decl {
        let field = |name: &str, ty: TsType| TsField {
            name: name.to_string(),
            docs: Vec::new(),
            optional: true,
            ty,
        };
        Decl {
            name: "EntityDelta".to_string(),
            docs: ENTITY_DELTA_DOCS.to_vec(),
            body: DeclBody::Interface {
                generics: vec!["T"],
                fields: vec![
                    field("upsert", TsType::Array(Box::new(TsType::Name("T")))),
                    field("remove", <Vec<String>>::ts()),
                    field("order", <Vec<String>>::ts()),
                ],
            },
        }
    }
}

/// New pool log lines past the old end, or a whole new window when the log
/// did not simply grow (a new run's log). Either way, the new total.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PoolLogDelta {
    Append(PoolLogAppend),
    Replace(PoolLogReplace),
}

impl Ts for PoolLogDelta {
    fn ts() -> TsType {
        TsType::Name("PoolLogDelta")
    }
}

impl TsDecl for PoolLogDelta {
    fn decl() -> Decl {
        Decl {
            name: "PoolLogDelta".to_string(),
            docs: vec![
                " New pool log lines past the old end, or a whole new window when the log",
                " did not simply grow (a new run's log). Either way, the new total.",
            ],
            body: DeclBody::Alias {
                generics: Vec::new(),
                ty: TsType::Union(vec![PoolLogAppend::ts(), PoolLogReplace::ts()]),
            },
        }
    }
}

wire_struct! {
    @inline
    /// Pool log lines past the old end.
    pub struct PoolLogAppend {
        pub append: Vec<String>,
        pub total: u64,
    }
}

wire_struct! {
    @inline
    /// A whole new pool log window.
    pub struct PoolLogReplace {
        pub replace: Vec<String>,
        pub total: u64,
    }
}

wire_struct! {
    /// One version to the next. `base` is the revision it applies to and `rev`
    /// the one it makes. Tickets and Conversations change by id; every other
    /// field is replaced whole when it changed, the top-level ones under `set`
    /// (an optional one that went under `unset`) and those inside `state` under
    /// `state`. A field absent from the delta is unchanged.
    pub struct SnapshotDelta {
        pub base: u64,
        pub rev: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub set: Option<SnapshotTopPatch>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub unset: Option<Vec<SnapshotTopKey>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub state: Option<SnapshotStatePatch>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub tickets: Option<EntityDelta<EnrichedTicketState>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub conversations: Option<EntityDelta<ConversationView>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub log: Option<PoolLogDelta>,
    }
}

wire_struct! {
    @inline
    /// The snapshot's top-level fields that changed, each whole (`Partial<TopFields>`).
    pub struct SnapshotTopPatch {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub seq: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub phase: Option<RunPhase>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub pool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub pool_title: Option<Option<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub pool_dir: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub finished_terminals: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub spawn_usage: Option<SpawnUsage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub pending_spawns: Option<Vec<PendingSpawnView>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub held_spawns: Option<Vec<HeldSpawnView>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub steward_budget: Option<StewardBudgetView>,
    }
}

wire_enum! {
    @inline
    /// A top-level field of the snapshot, by its JSON name (`keyof TopFields`).
    pub enum SnapshotTopKey {
        Seq = "seq",
        Phase = "phase",
        PoolName = "poolName",
        PoolTitle = "poolTitle",
        PoolDir = "poolDir",
        FinishedTerminals = "finishedTerminals",
        SpawnUsage = "spawnUsage",
        PendingSpawns = "pendingSpawns",
        HeldSpawns = "heldSpawns",
        StewardBudget = "stewardBudget",
    }
}

wire_struct! {
    @inline
    /// The fields inside the snapshot's `state` that changed, each whole (`Partial<StateFields>`):
    /// every one but the tickets, the Conversations and the log, which change by their own deltas.
    pub struct SnapshotStatePatch {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub outcomes: Option<IndexMap<String, Outcome>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub interrupts: Option<Vec<Interrupt>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub merge_queue: Option<Vec<MergeQueueEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub queued_answers: Option<Vec<QueuedAnswer>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub config: Option<Map<String, Value>>,
    }
}

// ---------------------------------------------------------------------------
// Requests and replies
// ---------------------------------------------------------------------------

/// A request with nothing to say, and a reply with nothing to add: the
/// change it made arrives as a delta ahead of the reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Empty {}

impl Ts for Empty {
    fn ts() -> TsType {
        TsType::Name("Empty")
    }
}

impl TsDecl for Empty {
    fn decl() -> Decl {
        Decl {
            name: "Empty".to_string(),
            docs: vec![
                " A request with nothing to say, and a reply with nothing to add: the",
                " change it made arrives as a delta ahead of the reply.",
            ],
            body: DeclBody::Alias {
                generics: Vec::new(),
                ty: TsType::Raw("Record<string, never>".to_string()),
            },
        }
    }
}

wire_struct! {
    /// POST /api/resume's body.
    pub struct ResumeRequest {
        pub ticket_id: String,
        pub action: ResumeAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        /// The Candidate an `adopt` takes (ADR-0035): required with `adopt` and
        /// refused with every other action.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attempt: Option<u64>,
    }
}

wire_struct! {
    /// The ticket (or Conversation) whose pane "Open in herdr" focuses.
    pub struct TerminalFocusRequest {
        pub ticket_id: String,
    }
}

wire_struct! {
    /// POST /api/terminal/focus's answer: the pane it focused.
    pub struct TerminalFocusResponse {
        pub ok: True,
        pub pane_id: String,
    }
}

wire_struct! {
    /// POST /api/conversations/end's body.
    pub struct EndConversationRequest {
        pub id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub closing: Option<String>,
    }
}

wire_struct! {
    /// GET /api/log's query: one byte range of an attempt's log or Stream file.
    /// `attempt` absent is the latest; `end` bounds a "load earlier" read.
    pub struct LogReadRequest {
        pub id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attempt: Option<u64>,
        pub offset: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub end: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub stream: Option<bool>,
    }
}

wire_struct! {
    /// Which log a subscribed card's appends follow: an attempt picked by hand,
    /// or null for whichever attempt is latest (a new attempt starting moves the
    /// pane to it), and its derived log or its Stream file.
    pub struct LogFollow {
        pub attempt: Option<u64>,
        pub stream: bool,
    }
}

wire_struct! {
    /// Point a subscribed card's log at another attempt or variant.
    pub struct LogFollowRequest {
        pub id: String,
        pub attempt: Option<u64>,
        pub stream: bool,
    }
}

wire_struct! {
    /// `log.follow`'s reply: the new tail window, naming the attempt and variant
    /// it is for, since a follow of `attempt: null` resolves on the server.
    pub struct LogFollowResult {
        pub content: String,
        pub offset: u64,
        pub next_offset: u64,
        pub total_size: u64,
        pub attempts: Vec<LogAttemptInfo>,
        pub attempt: u64,
        pub stream: bool,
    }
}

wire_struct! {
    /// GET /api/pool-log's query: up to `limit` pool log lines ending before
    /// line `before` (0-based, of the full log).
    pub struct PoolLogReadRequest {
        pub before: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub limit: Option<u64>,
    }
}

wire_struct! {
    /// A run of the pool log: `lines` are lines `start`.. of a log `total` long.
    pub struct PoolLogRange {
        pub start: u64,
        pub lines: Vec<String>,
        pub total: u64,
    }
}

wire_struct! {
    @inline
    /// `stop`'s result: the stop is under way.
    pub struct StopResult {
        pub stopping: True,
    }
}

wire_struct! {
    @inline
    /// `conversations.start`'s result: the Conversation it started.
    pub struct ConversationStarted {
        pub conversation: ConversationView,
    }
}

wire_struct! {
    @inline
    /// `reassign`'s result: PUT /api/reassign's answer less its snapshot, which
    /// reaches the socket as a delta ahead of the reply.
    pub struct ReassignResult {
        pub applied: Vec<String>,
        pub skipped: Vec<ReassignSkipped>,
    }
}

/// Declares the Requests table once: the request kinds, each one's HTTP twin, whether it is an
/// action, and its payload and result types.
macro_rules! requests {
    ($( $variant:ident = $kind:literal, $twin:literal, $action:literal, $payload:ty => $result:ty; )*) => {
        wire_enum! {
            /// Every request the socket takes, by kind (`keyof Requests`).
            pub enum RequestKind {
                $($variant = $kind,)*
            }
        }

        impl RequestKind {
            /// The request's HTTP twin, which stays for the Steward's command, Boot,
            /// the bench and the tests. `log.follow` reads what `GET /api/log` reads,
            /// and the pool log's range is a route new with this protocol.
            pub fn http_twin(self) -> &'static str {
                match self {
                    $(RequestKind::$variant => $twin,)*
                }
            }

            /// Whether the kind changes something (ACTION_KINDS). The server flushes
            /// the snapshot's pending push before it replies to one, so the delta
            /// carrying the action's effect is always on the socket ahead of its
            /// reply.
            pub fn is_action(self) -> bool {
                match self {
                    $(RequestKind::$variant => $action,)*
                }
            }

            /// Each kind's payload and result, as the TypeScript `Requests` table writes them.
            pub fn ts_table() -> Vec<(&'static str, TsType, TsType)> {
                vec![$(($kind, <$payload as Ts>::ts(), <$result as Ts>::ts()),)*]
            }
        }

        /// A request as the socket takes it: its kind and its payload.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "kind", content = "payload")]
        pub enum Request {
            $(#[serde(rename = $kind)] $variant($payload),)*
        }

        impl Request {
            pub fn kind(&self) -> RequestKind {
                match self {
                    $(Request::$variant(_) => RequestKind::$variant,)*
                }
            }
        }

        /// A request's successful answer: the route's own response type, less any
        /// snapshot it carried.
        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(untagged)]
        pub enum RequestResult {
            $($variant($result),)*
        }

        impl RequestResult {
            pub fn kind(&self) -> RequestKind {
                match self {
                    $(RequestResult::$variant(_) => RequestKind::$variant,)*
                }
            }

            /// The result of a `kind` request, read from its JSON.
            pub fn from_value(kind: RequestKind, value: Value) -> serde_json::Result<RequestResult> {
                match kind {
                    $(RequestKind::$variant => serde_json::from_value(value).map(RequestResult::$variant),)*
                }
            }
        }
    };
}

requests! {
    Start = "start", "POST /api/start", true, Empty => Empty;
    Resume = "resume", "POST /api/resume", true, ResumeRequest => Empty;
    Stop = "stop", "POST /api/stop", true, Empty => StopResult;
    Restart = "restart", "POST /api/restart", true, Empty => RestartResponse;
    KeepTalking = "keepTalking", "POST /api/keep-talking", true, KeepTalkingRequest => KeepTalkingResponse;
    TerminalFocus = "terminal.focus", "POST /api/terminal/focus?ticket=", true,
        TerminalFocusRequest => TerminalFocusResponse;
    TerminalsCloseFinished = "terminals.closeFinished", "POST /api/terminals/close-finished", true,
        Empty => CloseFinishedTerminalsResponse;
    Enlist = "enlist", "POST /api/enlist", true, EnlistRequest => EnlistResponse;
    Reassign = "reassign", "PUT /api/reassign", true, ReassignRequest => ReassignResult;
    SpawnsHeldAdopt = "spawns.held.adopt", "POST /api/spawns/held/adopt", true,
        HeldSpawnRequest => HeldSpawnResponse;
    SpawnsHeldDiscard = "spawns.held.discard", "POST /api/spawns/held/discard", true,
        HeldSpawnRequest => HeldSpawnResponse;
    SpawnsPendingHold = "spawns.pending.hold", "POST /api/spawns/pending/hold", true,
        PendingSpawnRequest => PendingSpawnResponse;
    SpawnsPendingDiscard = "spawns.pending.discard", "POST /api/spawns/pending/discard", true,
        PendingSpawnRequest => PendingSpawnResponse;
    ConversationsStart = "conversations.start", "POST /api/conversations", true,
        StartConversationRequest => ConversationStarted;
    ConversationsEnd = "conversations.end", "POST /api/conversations/end", true,
        EndConversationRequest => Empty;
    SettingsGet = "settings.get", "GET /api/settings", false, Empty => SettingsResponse;
    SettingsPoolPut = "settings.pool.put", "PUT /api/settings/pool", true,
        PoolSettingsRequest => SettingsResponse;
    SettingsMachinePut = "settings.machine.put", "PUT /api/settings/machine", true,
        MachineDefaultsRequest => SettingsResponse;
    PanesList = "panes.list", "GET /api/panes", false, Empty => PanesResponse;
    LogRead = "log.read", "GET /api/log", false, LogReadRequest => TicketLogResponse;
    LogFollow = "log.follow", "GET /api/log", false, LogFollowRequest => LogFollowResult;
    PoolLogRead = "poolLog.read", "GET /api/pool-log", false, PoolLogReadRequest => PoolLogRange;
}

wire_struct! {
    /// Every refusal, whichever field the HTTP route puts its reason in today
    /// (`error` or `reason`): the reason to show beside the control, and the
    /// status the HTTP twin would have answered with. Status 0 is the client's
    /// own: the socket closed before the reply came.
    pub struct Refusal {
        pub reason: String,
        pub status: u16,
    }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

wire_struct! {
    /// A card the Console wants kept current: the selected one or a hovered one.
    pub struct CardSubscription {
        pub id: String,
        /// Absent is the latest attempt's derived log.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub follow: Option<LogFollow>,
    }
}

wire_struct! {
    /// A subscribed card's log, pushed. A `window` replaces what the pane holds
    /// (on subscribe, and when the latest attempt the card follows changes); an
    /// `append` continues it from `offset`, which is the pane's last
    /// `nextOffset`. `attempts` comes on every window and on an append only when
    /// the card's attempt list changed.
    pub struct LogPush {
        pub mode: LogPushMode,
        pub attempt: u64,
        pub stream: bool,
        pub content: String,
        pub offset: u64,
        pub next_offset: u64,
        pub total_size: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attempts: Option<Vec<LogAttemptInfo>>,
    }
}

wire_enum! {
    @inline
    /// Whether a log push replaces the pane's text or continues it.
    pub enum LogPushMode {
        Window = "window",
        Append = "append",
    }
}

wire_struct! {
    /// A peek that could not be read: the card shows "pane unavailable".
    pub struct PeekFailure {
        pub ticket: String,
        pub error: String,
    }
}

/// One card's terminal peek on the live frame: the viewport, or why it could not be read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PeekResult {
    Peek(TerminalPeekResponse),
    Failure(PeekFailure),
}

impl Ts for PeekResult {
    fn ts() -> TsType {
        TsType::Union(vec![TerminalPeekResponse::ts(), PeekFailure::ts()])
    }
}

/// A frame from the Console.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMessage {
    Hello(ClientHello),
    Visibility(Visibility),
    Subscribe(Subscribe),
    Unsubscribe(Unsubscribe),
    Request(RequestFrame),
}

wire_struct! {
    @inline
    /// The first frame on every socket, and the whole of a reconnect's
    /// resubscription.
    pub struct ClientHello {
        pub protocol: u64,
        pub visible: bool,
        pub cards: Vec<CardSubscription>,
    }
}

wire_struct! {
    @inline
    /// The page was shown or hidden.
    pub struct Visibility {
        pub visible: bool,
    }
}

wire_struct! {
    @inline
    /// Subscribe, or change a subscription's follow; idempotent.
    pub struct Subscribe {
        pub card: CardSubscription,
    }
}

wire_struct! {
    @inline
    /// Stop keeping a card current.
    pub struct Unsubscribe {
        pub id: String,
    }
}

/// A request frame: its id, under which the reply answers, and the request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestFrame {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

impl Ts for ClientMessage {
    fn ts() -> TsType {
        TsType::Name("ClientMessage")
    }
}

/// The arm of a `type`-tagged union: the tag first, then the arm's own fields.
fn tagged(tag: &'static str, fields: Vec<TsField>) -> TsType {
    let mut all = vec![TsField {
        name: "type".to_string(),
        docs: Vec::new(),
        optional: false,
        ty: TsType::Lit(tag),
    }];
    all.extend(fields);
    TsType::Object(all)
}

const REQUEST_ARM: &str = "{
      [K in RequestKind]: { type: \"request\"; id: number; kind: K; payload: RequestPayload<K> };
    }[RequestKind]";

impl TsDecl for ClientMessage {
    fn decl() -> Decl {
        Decl {
            name: "ClientMessage".to_string(),
            docs: vec![" A frame from the Console."],
            body: DeclBody::Alias {
                generics: Vec::new(),
                ty: TsType::DocUnion(vec![
                    (
                        ClientHello::ts_docs(),
                        tagged("hello", ClientHello::ts_fields()),
                    ),
                    (Vec::new(), tagged("visibility", Visibility::ts_fields())),
                    (
                        Subscribe::ts_docs(),
                        tagged("subscribe", Subscribe::ts_fields()),
                    ),
                    (Vec::new(), tagged("unsubscribe", Unsubscribe::ts_fields())),
                    (Vec::new(), TsType::Raw(REQUEST_ARM.to_string())),
                ]),
            },
        }
    }
}

/// A frame from the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMessage {
    Hello(ServerHello),
    Snapshot(SnapshotFrame),
    Delta(DeltaFrame),
    Live(LiveFrame),
    Card(CardFrame),
    Reply(Reply),
    Heartbeat,
}

wire_struct! {
    @inline
    /// The server's first frame: its protocol, its epoch and its heartbeat cadence.
    pub struct ServerHello {
        pub protocol: u64,
        pub epoch: String,
        pub heartbeat_ms: u64,
    }
}

wire_struct! {
    @inline
    /// The whole snapshot, at `rev`; null before the pool has started.
    pub struct SnapshotFrame {
        pub rev: u64,
        pub log_total: u64,
        pub snapshot: Option<EnrichedSnapshot>,
    }
}

wire_struct! {
    @inline
    /// One version of the snapshot to the next.
    pub struct DeltaFrame {
        pub delta: SnapshotDelta,
    }
}

wire_struct! {
    @inline
    /// Live values that moved since this socket last heard: the changed
    /// entries of activity and peeks, by ticket or Conversation id, and the
    /// grades whole. Visible sockets only.
    pub struct LiveFrame {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub activity: Option<IndexMap<String, TicketActivityResponse>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub peeks: Option<IndexMap<String, PeekResult>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub grades: Option<IndexMap<String, TicketGradeSummary>>,
    }
}

wire_struct! {
    @inline
    /// A subscribed card's data: the fields present replace (or, for an
    /// `append` log, continue) what the Console holds. Its events leave out
    /// each event payload's `logTail`, which GET /api/events still serves.
    /// `error` for an id the pool does not know, or a card whose files could
    /// not be read; the card is then not held.
    pub struct CardFrame {
        pub id: String,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub body: Option<Option<TicketBodyResponse>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub events: Option<TicketEventsResponse>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub log: Option<Option<LogPush>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
    }
}

/// A request's answer. `rev` is the revision the socket had been sent when
/// the reply went out, so the action's effect is in hand. On the wire:
/// `{type: "reply", id, kind, rev, ok: true, result}` or `{..., ok: false, refusal}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub id: u64,
    pub kind: RequestKind,
    pub rev: u64,
    /// The result, whose kind is `kind`, or the refusal.
    pub outcome: Result<RequestResult, Refusal>,
}

impl Serialize for Reply {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut reply = serializer.serialize_struct("Reply", 5)?;
        reply.serialize_field("id", &self.id)?;
        reply.serialize_field("kind", &self.kind)?;
        reply.serialize_field("rev", &self.rev)?;
        match &self.outcome {
            Ok(result) => {
                reply.serialize_field("ok", &true)?;
                reply.serialize_field("result", result)?;
            }
            Err(refusal) => {
                reply.serialize_field("ok", &false)?;
                reply.serialize_field("refusal", refusal)?;
            }
        }
        reply.end()
    }
}

impl<'de> Deserialize<'de> for Reply {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            id: u64,
            kind: RequestKind,
            rev: u64,
            ok: bool,
            result: Option<Value>,
            refusal: Option<Refusal>,
        }
        let raw = Raw::deserialize(deserializer)?;
        let outcome = if raw.ok {
            let result = raw
                .result
                .ok_or_else(|| D::Error::missing_field("result"))?;
            Ok(RequestResult::from_value(raw.kind, result).map_err(D::Error::custom)?)
        } else {
            Err(raw
                .refusal
                .ok_or_else(|| D::Error::missing_field("refusal"))?)
        };
        Ok(Reply {
            id: raw.id,
            kind: raw.kind,
            rev: raw.rev,
            outcome,
        })
    }
}

const REPLY_ARM: &str = "{
      [K in RequestKind]:
        | { type: \"reply\"; id: number; kind: K; rev: number; ok: true; result: RequestResult<K> }
        | { type: \"reply\"; id: number; kind: K; rev: number; ok: false; refusal: Refusal };
    }[RequestKind]";

impl Ts for ServerMessage {
    fn ts() -> TsType {
        TsType::Name("ServerMessage")
    }
}

impl TsDecl for ServerMessage {
    fn decl() -> Decl {
        Decl {
            name: "ServerMessage".to_string(),
            docs: vec![" A frame from the server."],
            body: DeclBody::Alias {
                generics: Vec::new(),
                ty: TsType::DocUnion(vec![
                    (Vec::new(), tagged("hello", ServerHello::ts_fields())),
                    (
                        SnapshotFrame::ts_docs(),
                        tagged("snapshot", SnapshotFrame::ts_fields()),
                    ),
                    (Vec::new(), tagged("delta", DeltaFrame::ts_fields())),
                    (LiveFrame::ts_docs(), tagged("live", LiveFrame::ts_fields())),
                    (CardFrame::ts_docs(), tagged("card", CardFrame::ts_fields())),
                    (
                        vec![
                            " A request's answer. `rev` is the revision the socket had been sent",
                            " when the reply went out, so the action's effect is in hand.",
                        ],
                        TsType::Raw(REPLY_ARM.to_string()),
                    ),
                    (Vec::new(), tagged("heartbeat", Vec::new())),
                ]),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// The first snapshot, embedded in the page
// ---------------------------------------------------------------------------

wire_struct! {
    /// What the served index.html carries so the Console paints before the
    /// socket opens: the snapshot the socket's first frame will repeat, and the
    /// server epoch and revision, so the Console can tell it is the same one
    /// and skip the repaint.
    pub struct EmbeddedBoot {
        pub protocol: u64,
        pub epoch: String,
        pub rev: u64,
        pub log_total: u64,
        pub snapshot: Option<EnrichedSnapshot>,
    }
}
