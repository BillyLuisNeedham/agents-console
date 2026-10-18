//! The wire shapes (CONTEXT.md: Wire shape): every message between engine and Console, declared once.
//! This is protocol/wire.ts (once engine/wire.ts) and every type it re-exports from the engine's other modules: the Ticket
//! events, the Conversation view, the Interrupt and Outcome, the Assignment views, the Spawn and Merge
//! queue views, the enlist, Steward, Settings and Reassign bodies, and the response envelopes the
//! server assembles (the enriched snapshot, the per-ticket reads, the terminal peek).

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::json::{True, Unchecked};

// ---------------------------------------------------------------------------
// Ticket events (events.ts)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One line of a Ticket's events file, as GET /api/events serves it.
    pub struct TicketEvent {
        pub at: String,
        pub attempt: u64,
        pub kind: TicketEventKind,
        pub payload: Map<String, Value>,
    }
}

wire_enum! {
    /// What a Ticket event records.
    pub enum TicketEventKind {
        Scheduled = "scheduled",
        Spawned = "spawned",
        /// A terminal-backed launch whose wrapper never ran (issue #102's Botched
        /// launch): the tab it was typed into, closed, and the reason; the launch
        /// went on into a fresh tab, and only the tab it ended up in is `spawned`.
        LaunchRetried = "launch-retried",
        Exited = "exited",
        Merged = "merged",
        MergeConflict = "merge-conflict",
        /// A merge git refused before starting (#92): untracked files in the pool
        /// checkout that differ from the branch's version stood in its way.
        /// Nothing conflicted and no resolver runs; the operator clears the way.
        MergeBlocked = "merge-blocked",
        Resolver = "resolver",
        Graded = "graded",
        Selected = "selected",
        GraderRespawn = "grader-respawn",
        Checkpoint = "checkpoint",
        Crash = "crash",
        Deadlock = "deadlock",
        DeadlockCleared = "deadlock-cleared",
        Answered = "answered",
        /// A queued answer on a Line hold the Line refused as it drained (ADR-0039):
        /// the Finish gained a blocker since it was accepted. Its reason; the
        /// Interrupt stays.
        AnswerRefused = "answer-refused",
        ReviewReject = "review-reject",
        SpawnAdopted = "spawn-adopted",
        SpawnRejected = "spawn-rejected",
        /// Proposals within the caps, taken from the attempt and waiting for the
        /// next Tick to land (issue #150): each one's proposal id and title.
        SpawnPending = "spawn-pending",
        /// Proposals held for the operator rather than landed (ADR-0029, issue
        /// #150): each one's proposal id, title and reason, a cap that had no room
        /// (`per-attempt`, `per-run`), the agent's own `overlaps` mark (with the
        /// ids it named); `recovered` when boot held proposals a pre-ADR cap had
        /// truncated. An older pool's operator Hold reads as `operator`.
        SpawnHeld = "spawn-held",
        /// A Held spawn the operator discarded (ADR-0029, issue #150), by id and
        /// title. An older pool's Discard of a Pending spawn carries `pending`.
        SpawnDiscarded = "spawn-discarded",
        Reassigned = "reassigned",
        /// The ticket file's two copies (the pool's file of record and the
        /// worktree seed the agent committed) changed the same lines differently,
        /// so the reconcile at merge left conflict markers in the file of record.
        TicketFileConflict = "ticket-file-conflict",
        /// An operator-ended Conversation's closing record (the Conversations ADR,
        /// docs/adr/0018-conversations-beside-tickets.md): merged, ended with no
        /// commits, or ended with its branch parked on a rejected merge-approval.
        Ended = "ended",
        /// A Turn the engine typed into a waiting parent Conversation reporting
        /// something it spawned finishing.
        Notice = "notice",
        /// A Notice that never delivered (the parent ended or crashed first, or
        /// the queue was still non-empty at End), logged on the child's own file
        /// instead.
        NoticeDropped = "notice-dropped",
        /// The ticket's solo branch is checked out in a directory the engine does
        /// not own (issue #101: the checkout an enlist moved onto its created pool
        /// branch), so no worktree could be opened and the ticket waits as a
        /// checkpoint until the branch is free.
        BranchHeld = "branch-held",
        /// The ticket was about to schedule with no harness or model (issue #118:
        /// a spawn off an enlisted Conversation, or a pool with no defaults), so
        /// it waits as a config interrupt instead of a launch that would throw.
        Unassigned = "unassigned",
        /// A tab the engine closed by rule (a merge, a role's end, a Conversation's
        /// end, a Resume's fresh launch, the operator's bulk close) that herdr
        /// refused to close (issue #139): the close stays best-effort, and this is
        /// the record that it failed and why, where a silent catch used to be.
        TabCloseFailed = "tab-close-failed",
        /// The engine closed the tab of a checkpointed Attempt before a Resume's
        /// fresh launch (issue #139): recorded so the close happens once and a
        /// later Resume never reaches back for a tab it already closed.
        TabClosed = "tab-closed",
        /// An enlisted pane the pool let go (issue #139): an abandoned adoption
        /// left it exactly as found and handed the Ticket back to ordinary
        /// attempts, so a restart must not take the pane back as the Ticket's.
        LetGo = "let-go",
        /// The operator asked a Conversation to End (issue #140): recorded before
        /// the End moves anything, so an engine that stops mid-End leaves the next
        /// boot the fact that this was an ending, not a crash.
        EndRequested = "end-requested",
        /// The Steward (ADR-0030) left a pending Interrupt to the operator: the
        /// Interrupt's kind and the Steward note, its recommendation, with `by`
        /// and the Steward's `conversation`. Never counts against its budget.
        StewardNote = "steward-note",
        /// The Steward wrote this Ticket's assign entry (ADR-0030): the fields it
        /// set or cleared, with `by` and `conversation`. The engine's own
        /// `reassigned` follows at the next Config reload, as for the operator's.
        ReassignRequested = "reassign-requested",
    }
}

// ---------------------------------------------------------------------------
// Conversations (conversations.ts)
// ---------------------------------------------------------------------------

wire_enum! {
    /// Where a Conversation stands.
    pub enum ConversationStatus {
        Live = "live",
        Ended = "ended",
        Crashed = "crashed",
    }
}

wire_enum! {
    /// Which side of its Turn a Conversation is on.
    pub enum TurnSide {
        Working = "working",
        Waiting = "waiting",
    }
}

wire_enum! {
    /// The roles a Conversation may carry. Absent is an ordinary Conversation.
    pub enum ConversationRole {
        Steward = "steward",
    }
}

wire_struct! {
    /// A Conversation as the snapshot carries it (conversations.ts's viewOf).
    pub struct ConversationView {
        pub id: String,
        pub title: String,
        pub status: ConversationStatus,
        pub spawned_by: Option<String>,
        pub assignment: AssignmentView,
        pub pane_id: Option<String>,
        pub branch: Option<String>,
        pub turn: ConversationTurn,
        pub children: Vec<String>,
        /// Enlisted from a live herdr pane (issue #101): the card reads "as found"
        /// where a started Conversation names its model.
        pub enlisted: bool,
        /// Its End is under way (issue #140): the talk is over and its tab closed
        /// or closing, the merge still to land. The Console shows it ending with
        /// End disabled, and `paneId` is null so nothing peeks or focuses a pane
        /// that is going.
        pub ending: bool,
        /// The Steward (ADR-0030): present only on a Conversation in that role.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub role: Option<ConversationRole>,
        /// The Line's Conversation node this is a pass of (ADR-0039), its id the
        /// pass's (`grill-1`): present only on a Conversation the Line opened.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub node: Option<String>,
        /// Notices are not reaching this pane: present from the first failed
        /// delivery until one lands. The Turn state may still read waiting, since
        /// a Blocking dialog in the pane looks idle while it swallows every Turn,
        /// and the engine answers no dialog but Folder trust; the operator has to
        /// look at the pane.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub delivery: Option<NoticeDelivery>,
    }
}

wire_struct! {
    @inline
    /// A Conversation's Turn state: its side, the pane's last line, and since when it has waited.
    pub struct ConversationTurn {
        pub state: TurnSide,
        pub last_line: String,
        pub idle_since: Option<String>,
    }
}

wire_struct! {
    /// A Conversation whose Notices keep failing to land (ADR-0030's live e2e):
    /// since when, and why the last try failed. Turn state can read "waiting"
    /// while something in the pane (a Blocking dialog the engine never answers)
    /// swallows every Turn, so the failure is shown rather than retried
    /// invisibly. Cleared by the first Notice that lands.
    pub struct NoticeDelivery {
        pub failing_since: String,
        pub last_error: String,
    }
}

wire_struct! {
    /// POST /api/conversations's body: start a Conversation.
    pub struct StartConversationRequest {
        pub title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub opening: Option<String>,
        /// Start it as the Steward (ADR-0030): `opening` is then the operator's
        /// standing orders, and its Assignment comes from the Steward entry of
        /// the Pool settings ahead of the pool defaults.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub role: Option<ConversationRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub assign: Option<ConversationAssign>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub spawned_by: Option<String>,
        /// Spawn adoption precomputes a collision-free id shared across a parent's
        /// ticket-spawn and Conversation-spawn counters and passes it here, used
        /// verbatim. Absent for every operator-started Conversation, whose id the
        /// engine mints.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub id: Option<String>,
    }
}

wire_struct! {
    @inline
    /// The Assignment a Conversation start asks for, each field optional.
    pub struct ConversationAssign {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
    }
}

// ---------------------------------------------------------------------------
// The engine's run, Interrupts, Outcomes and Grades (engine.ts)
// ---------------------------------------------------------------------------

wire_enum! {
    /// The two Evidence budgets a Jev Grade can record.
    pub enum EvidenceBudget {
        Base = "base",
        Widened = "widened",
    }
}

wire_struct! {
    /// One assessment of one attempt (the Grade in CONTEXT.md): the score, the
    /// verdict, and short reasons, landed on the graded attempt's record. An agent
    /// grader carries it in its Outcome JSON under a `grade` key; a Jev-graded
    /// Grade is composed in engine code (ADR-0023). The three provenance fields a
    /// Jev Grade adds are optional: an agent-graded Grade has none.
    pub struct Grade {
        #[serde(with = "crate::json::js_number")]
        pub score: f64,
        pub verdict: GradeVerdict,
        pub reasons: String,
        /// The rubric version that composed it, e.g. `jev-grader-rubric/2026-09-20.1`.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub rubric: Option<String>,
        /// The model the API reported it answered with.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        /// Which Evidence budget the Grade came from: the base one or the widening re-ask.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub evidence_budget: Option<EvidenceBudget>,
    }
}

wire_enum! {
    @inline
    /// A Grade's verdict.
    pub enum GradeVerdict {
        Pass = "pass",
        Flag = "flag",
    }
}

wire_struct! {
    /// A question the run puts to the operator. The Conversation module raises
    /// its own merge interrupts in this shape too.
    pub struct Interrupt {
        pub ticket_id: String,
        pub kind: InterruptKind,
        pub body: String,
        /// A selection interrupt's candidate attempt numbers, riding so the answer
        /// is validated against the exact fan-out the grades came from, including
        /// after a restart (a superseded round's graded attempts would otherwise
        /// pass for candidates).
        #[serde(skip_serializing_if = "Option::is_none")]
        pub candidates: Option<Vec<u64>>,
        /// The Steward note on it (ADR-0030), on the snapshot's copy only: the
        /// Steward left this Interrupt to the operator with this recommendation.
        /// Never persisted with the Interrupt; steward.ts's store keeps it.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub steward_note: Option<StewardNote>,
        /// A Ticket's merge-conflict Interrupt, on the snapshot's copy only: how
        /// many other Tickets have started since it was raised (ADR-0040),
        /// derived from their events and absent while none has.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub started_since: Option<u64>,
    }
}

wire_enum! {
    /// What an Interrupt asks.
    pub enum InterruptKind {
        Checkpoint = "checkpoint",
        Config = "config",
        Crash = "crash",
        Deadlock = "deadlock",
        MergeConflict = "merge-conflict",
        MergeApproval = "merge-approval",
        Persistence = "persistence",
        Review = "review",
        Selection = "selection",
    }
}

wire_struct! {
    /// The attempt's result, written by the agent as JSON at the outcome path its
    /// prompt names and read by the engine at attempt exit.
    pub struct Outcome {
        pub status: OutcomeStatus,
        pub summary: String,
        pub commit_sha: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub brief: Option<String>,
        /// Follow-up ticket proposals (ADR-0010): the agent proposes in its Outcome,
        /// the engine writes the pool at a Tick. Three states:
        /// absent, the attempt proposed nothing; present and empty, the key was
        /// there and nothing survived schema validation; populated, the
        /// well-formed proposals riding to a Tick.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub spawn: Option<Vec<SpawnProposal>>,
        /// A Line Ticket's typed verdict (ADR-0037, ADR-0039), kept as the agent
        /// wrote it: Prove's ProveVerdict, Review's ReviewVerdict, Decide's
        /// choice, or the Finish Ticket's PR url. Absent when the Outcome carried none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub verdict: Option<Value>,
    }
}

wire_enum! {
    /// The attempt's ending: the engine, not the agent, writes it to the canonical
    /// Issue's line-1 marker (ADR-0005).
    pub enum OutcomeStatus {
        Done = "done",
        Checkpoint = "checkpoint",
    }
}

wire_struct! {
    /// One follow-up ticket an attempt proposes in its Outcome's optional spawn
    /// array (ADR-0010). The agent never proposes an id, a status or a marker:
    /// the engine assigns the id, writes the ticket file and owns the marker.
    pub struct SpawnProposal {
        pub title: String,
        pub body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub blocked_by: Option<Vec<String>>,
        /// What the proposal becomes. Absent means "ticket", ADR-0010's original
        /// shape; "conversation" starts a child Conversation instead of writing a
        /// ticket file.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub kind: Option<SpawnKind>,
        /// The child's Assignment, when the proposer wants something other than
        /// its own. Absent inherits. A ticket child keeps it on its marker as
        /// spawn-assign (issue #116), ranked under the operator's assign entry.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub assign: Option<SpawnAssignRequest>,
        /// Set by validation when the proposal's assign named a verify, which no
        /// proposal may set (grading is the operator's call, issue #116): the
        /// proposal lands without it, and the engine logs that once and strips
        /// this flag before the proposal is stored.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub verify_ignored: Option<True>,
        /// The tickets the Spawn blocks once adopted (ADR-0029): named ids, or
        /// "all" for every ticket not yet started at that moment.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub blocks: Option<SpawnBlocks>,
        /// The pool work the proposing agent read in the Spawn ledger and judged
        /// this proposal to overlap (issue #150): Tickets, Conversations, or
        /// Pending or Held spawns, by id. A proposal that names any is held for
        /// the operator to decide instead of landing.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub overlaps: Option<Vec<String>>,
    }
}

wire_enum! {
    @inline
    /// What a Spawn proposal becomes, or where it came from: a Ticket or a Conversation.
    pub enum SpawnKind {
        Ticket = "ticket",
        Conversation = "conversation",
    }
}

wire_enum! {
    @inline
    /// The word a Spawn's `blocks` uses for every ticket not yet started.
    pub enum AllTickets {
        All = "all",
    }
}

wire_union! {
    @inline
    /// The tickets a Spawn blocks: named ids, or "all" for every ticket not yet started.
    #[serde(untagged)]
    pub enum SpawnBlocks {
        Ids(Vec<String>),
        All(AllTickets),
    }
}

wire_struct! {
    /// A Spawn proposal's Assignment request (issue #116): the fields a proposal's
    /// `assign` may set, persisted on the spawned Ticket's marker. Never verify:
    /// whether a Ticket is graded stays the operator's call.
    pub struct SpawnAssignRequest {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
    }
}

wire_enum! {
    /// The phases a run reports. `dead` is terminal and distinct from the closing
    /// gate's done/quiescent/stalled: it is emitted only when an error the drive
    /// truly cannot continue from has killed the loop. `stopped` is the other
    /// terminal phase and the only one the drive never emits: the shutdown emits
    /// it once, as the farewell frame, after the children are stopped and the
    /// store closed (issue #97), so a Console tab can tell an orderly stop from a
    /// dead drive and from a lost connection.
    pub enum RunPhase {
        Running = "running",
        Done = "done",
        Quiescent = "quiescent",
        Stalled = "stalled",
        Dead = "dead",
        Stopped = "stopped",
    }
}

wire_struct! {
    /// What the Console shows of the Spawn caps: `spawnedThisRun` of `perRun`
    /// this run, and `perAttempt` per attempt.
    pub struct SpawnUsage {
        pub spawned_this_run: u64,
        pub per_attempt: u64,
        pub per_run: u64,
    }
}

wire_struct! {
    /// The pool's console.json as the engine reads it.
    pub struct PoolConfig {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub defaults: Option<AssignmentDefaults>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub assign: Option<IndexMap<String, TicketAssignment>>,
        /// The merge resolver: a harness name (the model is inherited from
        /// defaults), "none" to opt out, or { harness, model, effort } when the
        /// resolver runs on a harness other than the defaults', whose model names
        /// (and effort words) would not be recognised there.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub resolver: Option<ResolverConfig>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub port: Option<u64>,
        /// The Spawn caps (ADR-0029): absent fields take the defaults, 5 per
        /// attempt and 20 per run.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub spawn_caps: Option<SpawnCapsConfig>,
        /// How many Ticket Attempts the engine runs at once (ADR-0040), a whole
        /// number of 1 or more; absent falls back to the Machine default, and
        /// absent there means no bound.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub max_live: Option<u64>,
        /// Who picks the winner of a verify fan-out: the engine's arithmetic rule
        /// (default) or the human, via a selection interrupt carrying the grades.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub selection: Option<SelectionMode>,
        /// Terminal backing for every attempt (ADR-0014, ADR-0015): "herdr" opens a
        /// named herdr tab per attempt and records its pane id on the spawned
        /// event. Absent means headless.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub terminal: Option<TerminalKind>,
        /// Prose the setup skill writes here and the engine never reads: agents meet
        /// it through the pool's AGENT.md. Declared so the Settings pane (issue
        /// #121) edits it as a Pool setting rather than as an unknown key.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub reviewer: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub checkpoint: Option<String>,
        /// The Pool title (issue #100): one line the operator gives the pool so
        /// several can be told apart. Display-only: the directory stays the pool's
        /// identity.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        /// The Steward entry (ADR-0030): the Steward budget, 5 unless set, and the
        /// Steward's Assignment, ahead of the pool defaults.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub steward: Option<StewardConfig>,
        /// The Line base (issue #193): the branch Boot's Line mode cut the Line
        /// from and the commit it was cut at. The Line copies it into its places
        /// when it begins.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub line_base: Option<LineBase>,
    }
}

wire_struct! {
    /// The Line base (issue #193): the branch a Line was cut from, as Boot
    /// resolved it (`experiment/x` or `origin/experiment/x`), and the full SHA
    /// of the commit it was cut at. Chosen once, it never changes.
    #[derive(Eq)]
    pub struct LineBase {
        #[serde(rename = "ref")]
        pub base_ref: String,
        pub commit: String,
    }
}

wire_struct! {
    /// The pool defaults' Assignment fields: console.json `defaults`.
    pub struct AssignmentDefaults {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
    }
}

wire_struct! {
    /// One Ticket's console.json `assign` entry.
    pub struct TicketAssignment {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub verify: Option<u64>,
    }
}

wire_union! {
    @inline
    /// The merge resolver's console.json entry: a harness name (or "none"), or a whole Assignment.
    #[serde(untagged)]
    pub enum ResolverConfig {
        Harness(String),
        Assignment(ResolverAssignment),
    }
}

wire_struct! {
    @inline
    /// The resolver's own Assignment, for a harness other than the defaults'.
    pub struct ResolverAssignment {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
    }
}

wire_struct! {
    /// The Spawn caps as console.json carries them: either field may be absent.
    pub struct SpawnCapsConfig {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub per_attempt: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub per_run: Option<u64>,
    }
}

wire_enum! {
    @inline
    /// Who picks the winner of a verify fan-out.
    pub enum SelectionMode {
        Auto = "auto",
        Human = "human",
    }
}

wire_enum! {
    @inline
    /// The terminal backing: herdr is the only one.
    pub enum TerminalKind {
        Herdr = "herdr",
    }
}

// ---------------------------------------------------------------------------
// Tickets, Assignments and live Attempts
// ---------------------------------------------------------------------------

wire_enum! {
    /// A Ticket's status, as its line-1 marker records it.
    pub enum TicketStatus {
        Ready = "ready",
        InProgress = "in-progress",
        Done = "done",
        Checkpoint = "checkpoint",
        Closed = "closed",
    }
}

wire_struct! {
    /// One resolved Assignment on the wire (ADR-0013): the engine's record with
    /// no verify (Verify keeps its own surfaces) and the engine's empty string
    /// rendered as null for an unassigned field. The UI renders this record
    /// verbatim; nothing re-derives it.
    pub struct AssignmentView {
        pub harness: Option<String>,
        pub model: Option<String>,
        /// Present only when some layer sets one; absent, the harness runs on its
        /// own default.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        /// Present beside an effort only: whether the harness, in the mode it
        /// launches in, can take it. False renders the effort as not applied.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort_applied: Option<bool>,
        pub drivers: String,
    }
}

wire_enum! {
    /// What a live Attempt is doing for its Ticket (issue #129): the Ticket's own
    /// work, or a resolver staging the resolution of its conflicted merge. A
    /// done card with a live resolver is a merge being resolved, not a Ticket
    /// re-running, and the Console says so only because the engine says so here.
    pub enum AttemptRole {
        Agent = "agent",
        Resolver = "resolver",
    }
}

wire_struct! {
    /// One live Attempt as the snapshot carries it; `tabId` stays engine-side.
    pub struct LiveAttemptRecord {
        pub attempt: u64,
        /// The herdr pane the Attempt runs in; null when headless.
        pub pane_id: Option<String>,
        pub role: AttemptRole,
        /// When the engine registered the Attempt live (ISO): the Console ticks
        /// the elapsed time from it client-side, so no emit is spent on a clock.
        pub started_at: String,
    }
}

wire_struct! {
    /// A Held pane as the snapshot carries it; the rest stays engine-side.
    pub struct HeldPaneRecord {
        /// The checkpointed Attempt whose pane this is.
        pub attempt: u64,
        pub pane_id: String,
    }
}

// ---------------------------------------------------------------------------
// Spawn proposals (spawn-proposals.ts)
// ---------------------------------------------------------------------------

wire_enum! {
    /// Why a proposal is held: which cap had no room (the attempt's, or a
    /// spawn.json's, own; or the run's), the proposing agent's own `overlaps`
    /// mark (the ids ride on the proposal), a Pending spawn a Tick refused to
    /// land because the pool moved after it was taken (the reason rides as
    /// `adoptError`), a Pending spawn whose named `blocks` reached a Ticket
    /// that had already started (ADR-0040), or an older pool's operator Hold
    /// of a Pending spawn.
    pub enum HeldSpawnReason {
        PerAttempt = "per-attempt",
        PerRun = "per-run",
        Overlaps = "overlaps",
        Operator = "operator",
        Refused = "refused",
        /// Proposed from inside a Line (ADR-0037): anything that lands merges
        /// into the Line's branch, so only the operator lands it.
        Line = "line",
        Started = "started",
    }
}

wire_struct! {
    /// One Pending spawn as the Console shows it: a proposal within the caps
    /// that lands at the next Tick. A Tick lands it as soon as its Attempt
    /// exits, so it is seen across a restart or while a stopping drive waits.
    pub struct PendingSpawnView {
        pub id: String,
        pub parent_id: String,
        pub origin: SpawnKind,
        /// What landing it starts: a Ticket, or a Conversation.
        pub kind: SpawnKind,
        pub title: String,
        pub body: String,
        pub blocked_by: Vec<String>,
        /// The tickets it would block once it lands, "all" for every ticket not
        /// yet started at that moment, or null when it blocks none.
        pub blocks: Option<SpawnBlocks>,
        /// The pool work the proposing agent said it overlaps: Tickets,
        /// Conversations, or other proposals, by id. Empty when it named none.
        pub overlaps: Vec<String>,
        pub at: String,
    }
}

wire_struct! {
    /// One held spawn as the Console shows it.
    pub struct HeldSpawnView {
        pub id: String,
        pub parent_id: String,
        pub origin: SpawnKind,
        /// What landing it starts: a Ticket, or a Conversation.
        pub kind: SpawnKind,
        pub title: String,
        pub body: String,
        pub blocked_by: Vec<String>,
        /// The tickets it would block once it lands, "all" for every ticket not
        /// yet started at that moment, or null when it blocks none.
        pub blocks: Option<SpawnBlocks>,
        /// The pool work the proposing agent said it overlaps: Tickets,
        /// Conversations, or other proposals, by id. Empty when it named none.
        pub overlaps: Vec<String>,
        pub at: String,
        pub reason: HeldSpawnReason,
        /// The ids an "overlaps" hold named that the pool never knew; empty when
        /// every one was known.
        pub unknown_overlaps: Vec<String>,
        /// An Adopt is on its way to a Tick: the spawn is still held until
        /// the engine writes it, so a restart before then loses nothing.
        pub adopting: bool,
        /// Why a Tick refused to land it (a blocker gone, a blocks target
        /// finished while it waited): the spawn stayed held, or, for "refused",
        /// was held instead of landing. Absent until a refusal, and cleared by
        /// the next Adopt.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub adopt_error: Option<String>,
    }
}

// ---------------------------------------------------------------------------
// The Merge queue (merge-hold.ts) and Queued answers (queued-answers.ts)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One held ticket in the Merge queue, as the snapshot carries it.
    pub struct MergeQueueEntry {
        pub ticket_id: String,
        pub state: MergeQueueState,
    }
}

wire_enum! {
    /// Where one held ticket's merge stands (CONTEXT.md: Merge queue). The first
    /// three are a head, a merge that is moving: a resolver on it (or the engine
    /// launching one), or the operator's answer awaited at a merge-approval or a
    /// merge-conflict interrupt. `queued` is behind the engine's own work, with
    /// nothing running on its behalf. `stalled` is held with none of those: no
    /// resolver, no interrupt, and no merge the engine has taken on and not yet
    /// finished with (issue #87's case, named here, not fixed).
    pub enum MergeQueueState {
        Resolving = "resolving",
        AwaitingApproval = "awaiting-approval",
        NeedsYou = "needs-you",
        Queued = "queued",
        Stalled = "stalled",
    }
}

wire_struct! {
    /// An accepted answer waiting for processing at the next Tick (a Queued answer).
    pub struct QueuedAnswer {
        pub ticket_id: String,
        /// The interrupt identity: the kind of interrupt this answer addresses.
        pub kind: InterruptKind,
        /// The answer payload: true approve, false reject, absent resume.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub approve: Option<bool>,
        /// A Close (issue #154): the ticket is dropped without merging. An Adopt
        /// (ADR-0035): one finished Candidate of a paused verify round is taken as
        /// the Winner. Absent on every other answer, so a file written before
        /// either existed reads as it always did.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub action: Option<QueuedAnswerAction>,
        /// The Candidate an Adopt takes; present only with `action: "adopt"`.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attempt: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        /// The Steward gave it (ADR-0030); absent is the operator's.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub by: Option<AnswerBy>,
        pub at: String,
        pub seq: u64,
        pub processed_at: Option<String>,
    }
}

wire_enum! {
    @inline
    /// A Queued answer's action beyond resume, approve and reject.
    pub enum QueuedAnswerAction {
        Close = "close",
        Adopt = "adopt",
    }
}

wire_enum! {
    /// Who gave an answer, as the Ticket log records it. An `answered` event with
    /// no `by` is the operator's: every answer written before the Steward existed
    /// reads that way unchanged.
    pub enum AnswerBy {
        Operator = "operator",
        Steward = "steward",
    }
}

// ---------------------------------------------------------------------------
// Enlist (enlist.ts)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One live herdr pane, as the picker lists it.
    pub struct EnlistPane {
        pub pane_id: String,
        /// herdr's agent label: the harness, or null when none is bound.
        pub harness: Option<String>,
        /// herdr's agent status: idle, working, blocked, done or unknown.
        pub status: String,
        /// The pane's terminal title.
        pub title: String,
        /// The pane's working directory, or null when herdr reports none.
        pub directory: Option<String>,
        /// The branch checked out in `directory`, resolved by the engine; null
        /// when the directory is not a checkout.
        pub branch: Option<String>,
        pub eligible: bool,
        /// Why the pane cannot be enlisted; null when it can.
        pub reason: Option<String>,
    }
}

wire_struct! {
    /// The panes response envelope: every pane `agent.list` reports, eligible or
    /// not, with the reason beside the ineligible ones.
    pub struct PanesResponse {
        pub panes: Vec<EnlistPane>,
    }
}

wire_union! {
    /// The enlist request body (issue #101), declared once here so the server
    /// route and the Console type-import the same shape. `becomes` is fixed at
    /// enlist time, and one of the arms is chosen from it: a Ticket, a
    /// Conversation, or a Conversation as the Steward (ADR-0030). The engine
    /// re-judges the pane at submit rather than trusting a picker read that may
    /// be stale. The branch is never on the wire: the engine resolves the found
    /// directory's branch with git and applies the branch rule itself.
    #[serde(untagged)]
    pub enum EnlistRequest {
        Ticket(EnlistTicketRequest),
        Conversation(EnlistConversationWireRequest),
        Steward(EnlistStewardWireRequest),
    }
}

wire_enum! {
    @inline
    /// The enlist arm that makes a Ticket.
    pub enum BecomesTicket {
        Ticket = "ticket",
    }
}

wire_enum! {
    @inline
    /// The enlist arm that makes a Conversation.
    pub enum BecomesConversation {
        Conversation = "conversation",
    }
}

wire_enum! {
    @inline
    /// The enlist arm that makes the Steward.
    pub enum BecomesSteward {
        Steward = "steward",
    }
}

wire_struct! {
    /// Enlist a pane as a Ticket.
    pub struct EnlistTicketRequest {
        pub becomes: BecomesTicket,
        pub pane_id: String,
        pub title: String,
        pub spec: String,
        /// The unfinished tickets that must wait on the enlisted one.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub blocks: Option<Vec<String>>,
    }
}

wire_struct! {
    /// Enlist a pane as a Conversation.
    pub struct EnlistConversationWireRequest {
        pub becomes: BecomesConversation,
        pub pane_id: String,
        pub title: String,
        /// The optional first Turn, typed after the teaching Turn.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub opening: Option<String>,
    }
}

wire_struct! {
    /// Enlist as the Steward (ADR-0030): a Conversation in that role, refused
    /// while a Steward is already on duty. The opening, when given, is the
    /// operator's standing orders, typed after the Steward's teaching Turn.
    pub struct EnlistStewardWireRequest {
        pub becomes: BecomesSteward,
        pub pane_id: String,
        /// Optional: "Steward" when blank.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub opening: Option<String>,
    }
}

wire_union! {
    /// The enlist answer: the minted id, a 201 on success.
    #[serde(untagged)]
    pub enum EnlistResponse {
        Ticket(EnlistedTicket),
        Conversation(EnlistedConversation),
    }
}

wire_struct! {
    @inline
    /// The Ticket an enlist minted.
    pub struct EnlistedTicket {
        pub ticket_id: String,
    }
}

wire_struct! {
    @inline
    /// The Conversation an enlist minted.
    pub struct EnlistedConversation {
        pub conversation_id: String,
    }
}

// ---------------------------------------------------------------------------
// The Steward (steward.ts, ADR-0030): its role on a Conversation, its note on an
// Interrupt, its budget on the snapshot, who answered on a Ticket log event, the
// Pool settings entry, and the bodies its command sends.
// ---------------------------------------------------------------------------

wire_struct! {
    /// The answer every Steward write route gives: what was done, in one line.
    pub struct StewardActionResponse {
        pub ok: True,
        pub message: String,
    }
}

wire_struct! {
    /// POST /api/steward/answer: the operator's answer path, as the Steward's.
    pub struct StewardAnswerRequest {
        pub conversation: String,
        pub ticket_id: String,
        pub action: StewardAnswerAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
    }
}

wire_enum! {
    @inline
    /// The answers the Steward may give.
    pub enum StewardAnswerAction {
        Resume = "resume",
        Approve = "approve",
        Reject = "reject",
        Close = "close",
    }
}

wire_struct! {
    /// The Steward's Assignment fields, each optional, layered ahead of the pool defaults.
    pub struct StewardAssign {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
    }
}

wire_struct! {
    /// The budget as the snapshot carries it: the Pool's, and what the Steward
    /// has used per Ticket (only Tickets it has answered since the operator
    /// last did).
    pub struct StewardBudgetView {
        pub budget: u64,
        pub used: IndexMap<String, u64>,
    }
}

wire_struct! {
    /// console.json `steward`: the Steward budget, the Steward's Assignment, and whether it may Close.
    pub struct StewardConfig {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub budget: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub assign: Option<StewardAssign>,
        /// "Steward may Close checkpoints" (issue #154, ADR-0033): off unless true.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub may_close: Option<bool>,
        /// Whether the Steward may Adopt or Discard a Held spawn proposed from
        /// inside a Line (ADR-0037): off unless true.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub may_adopt_line_spawns: Option<bool>,
    }
}

wire_struct! {
    /// POST /api/steward/end: the Steward ends itself, closing line included.
    pub struct StewardEndRequest {
        pub conversation: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub closing: Option<String>,
    }
}

wire_struct! {
    /// POST /api/steward/held: Adopt or Discard a Held spawn.
    pub struct StewardHeldRequest {
        pub conversation: String,
        pub action: StewardHeldAction,
        pub id: String,
    }
}

wire_enum! {
    @inline
    /// What the Steward does with a Held spawn.
    pub enum StewardHeldAction {
        Adopt = "adopt",
        Discard = "discard",
    }
}

wire_struct! {
    /// POST /api/steward/keep-talking: Keep talking, then the message typed after the teaching Turn.
    pub struct StewardKeepTalkingRequest {
        pub conversation: String,
        pub ticket_id: String,
        pub message: String,
    }
}

wire_struct! {
    /// POST /api/steward/leave: leave a pending Interrupt to the operator with a Steward note.
    pub struct StewardLeaveRequest {
        pub conversation: String,
        pub ticket_id: String,
        pub note: String,
    }
}

wire_struct! {
    /// A Steward note as the snapshot's interrupt carries it.
    pub struct StewardNote {
        pub text: String,
        pub at: String,
        /// The Steward that wrote it.
        pub conversation: String,
    }
}

wire_struct! {
    /// POST /api/steward/reassign: Reassign's own body (ReassignRequest), as the Steward's.
    pub struct StewardReassignRequest {
        pub tickets: Vec<String>,
        pub fields: ReassignFields,
        pub conversation: String,
    }
}

wire_struct! {
    /// One pending Interrupt as the Steward's state read shows it.
    pub struct StewardStateInterrupt {
        pub ticket_id: String,
        pub title: Option<String>,
        pub kind: String,
        /// Whether the Steward may answer it at all (not review, persistence or a Conversation's).
        pub answerable: bool,
        pub keep_talking: bool,
        /// An answer is already queued for it.
        pub queued: bool,
        /// The Steward's own note, when it left the Interrupt.
        pub note: Option<String>,
        pub used: u64,
        pub remaining: u64,
    }
}

wire_struct! {
    /// GET /api/steward/state?conversation=<id>: a compact read of what the Steward stewards.
    pub struct StewardStateResponse {
        pub steward: String,
        pub budget: u64,
        /// "Steward may Close checkpoints", read live from the pool settings.
        pub may_close: bool,
        /// `steward.mayAdoptLineSpawns`, read live from the pool settings.
        pub may_adopt_line_spawns: bool,
        pub phase: String,
        pub interrupts: Vec<StewardStateInterrupt>,
        pub merge_queue: Vec<StewardStateMerge>,
        pub pending_spawns: Vec<StewardStatePending>,
        pub held_spawns: Vec<StewardStateHeld>,
        /// The Spawn ledger, for the whole pool's state in one file.
        pub ledger: String,
    }
}

wire_struct! {
    @inline
    /// One Merge queue entry in the Steward's state read.
    pub struct StewardStateMerge {
        pub ticket_id: String,
        pub state: String,
    }
}

wire_struct! {
    @inline
    /// One Pending spawn in the Steward's state read.
    pub struct StewardStatePending {
        pub id: String,
        pub parent_id: String,
        pub title: String,
    }
}

wire_struct! {
    @inline
    /// One Held spawn in the Steward's state read.
    pub struct StewardStateHeld {
        pub id: String,
        pub parent_id: String,
        pub title: String,
        pub reason: String,
    }
}

// ---------------------------------------------------------------------------
// The Settings pane (pool-settings.ts, machine-defaults.ts, issue #121): the Pool
// settings payload, the two write bodies, and the Machine defaults shape.
// ---------------------------------------------------------------------------

wire_struct! {
    /// PUT /api/settings/machine. The defaults are written whole.
    pub struct MachineDefaultsRequest {
        pub defaults: MachineDefaults,
    }
}

wire_struct! {
    /// The machine's half: `defaults` is what is in force (the legacy runner
    /// files filled in), `own` is only the JSON file's own fields, which is what
    /// the pane edits and writes back.
    pub struct MachineDefaultsView {
        pub path: String,
        pub defaults: MachineDefaults,
        pub own: MachineDefaults,
    }
}

wire_struct! {
    /// The Machine defaults file: what every new pool starts with.
    pub struct MachineDefaults {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        /// The harness's own effort word (CONTEXT.md: Effort), passed through verbatim.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub drivers: Option<String>,
        /// The agent-console checkout Boot runs the engine from.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub engine: Option<String>,
        /// Terminal backing every new pool starts with; the only legal value is "herdr".
        #[serde(skip_serializing_if = "Option::is_none")]
        pub terminal: Option<TerminalKind>,
        /// The machine's maxLive, under every pool's own; read afresh at each Tick.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub max_live: Option<u64>,
    }
}

wire_struct! {
    /// PUT /api/settings/pool. The patch is a partial PoolConfig; a key set to
    /// null or "" removes it.
    pub struct PoolSettingsRequest {
        pub config: Map<String, Value>,
    }
}

wire_struct! {
    /// The Pool's half of the Settings payload. `effective` is what THIS process
    /// booted with, so the Console can badge a boot-only key whose saved value no
    /// longer matches what is running.
    pub struct PoolSettingsView {
        pub path: String,
        /// The pool's console.json as parsed, unknown keys included, `{}` when absent.
        pub config: Unchecked<PoolConfig>,
        pub boot_only: Vec<String>,
        pub effective: EffectiveSettings,
    }
}

wire_struct! {
    @inline
    /// The boot-only settings this process runs with.
    pub struct EffectiveSettings {
        pub port: u64,
        pub terminal: Option<TerminalKind>,
        /// The boot-only keys whose saved value is not what is running, so the
        /// badge survives a reload and catches a hand edit, not only a save made
        /// in this tab. A subset of `bootOnly`.
        pub stale: Vec<String>,
    }
}

wire_struct! {
    /// POST /api/restart's acknowledgement: the port the relaunched Console will
    /// listen on, so the tab knows where to reconnect when it moved.
    pub struct RestartResponse {
        pub ok: True,
        /// console.json's own `port` as written when it is set and not 0, else the
        /// bound port: unchecked, as the TypeScript re-reads it.
        pub port: Unchecked<u64>,
    }
}

wire_struct! {
    /// The Settings pane's payload: GET /api/settings and both PUTs answer with it.
    pub struct SettingsResponse {
        pub pool: PoolSettingsView,
        pub machine: MachineDefaultsView,
        /// The harness names this pool knows, sorted, for the pane's pickers.
        pub harnesses: Vec<String>,
    }
}

// ---------------------------------------------------------------------------
// Reassign (reassign.ts, assignment.ts, issue #126)
// ---------------------------------------------------------------------------

wire_enum! {
    /// Where one resolved field came from (Reassign, issue #126): the unit's own
    /// request layer (a Ticket's `assign` entry, so the Console calls it pinned),
    /// a spawned Ticket's requested Assignment (its proposal's `assign`, issue
    /// #116), what it inherits from its parent or build ticket, the pool
    /// defaults, or nowhere at all.
    pub enum AssignmentSource {
        Pinned = "pinned",
        Requested = "requested",
        Inherited = "inherited",
        Default = "default",
        Unset = "unset",
    }
}

wire_struct! {
    /// Where each field of a ticket's Assignment came from.
    pub struct AssignmentSources {
        pub harness: AssignmentSource,
        pub model: AssignmentSource,
        pub effort: AssignmentSource,
        pub drivers: AssignmentSource,
    }
}

wire_struct! {
    /// The write body (PUT /api/reassign). `tickets` names the ids to change;
    /// `fields` is tri-state per field: a key absent leaves that field alone,
    /// a value sets it, and null clears the ticket's own entry for it so the
    /// ticket follows its parent or the pool defaults again. `verify` is an
    /// integer >= 1 or null to clear.
    pub struct ReassignRequest {
        pub tickets: Vec<String>,
        pub fields: ReassignFields,
    }
}

wire_struct! {
    @inline
    /// The fields a Reassign sets (a value), clears (null) or leaves alone (absent).
    pub struct ReassignFields {
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub harness: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub model: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub effort: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub drivers: Option<Option<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]
        pub verify: Option<Option<u64>>,
    }
}

wire_struct! {
    /// The write's answer. A refused write (unknown ticket, unknown harness,
    /// bad verify, or a ticket that would end up unassigned) is a 400 with
    /// `{ error }` naming the ticket and nothing is written. Otherwise every
    /// named ticket that is still eligible is written in one atomic file
    /// replace and listed in `applied`; a ticket that stopped being eligible
    /// between listing and saving is left alone and listed in `skipped` with
    /// its reason. `snapshot` is the fresh enriched snapshot after the write, so
    /// the Console pushes it through setSnapshot and the cards show the new
    /// Assignment at once.
    pub struct ReassignResponse {
        pub applied: Vec<String>,
        pub skipped: Vec<ReassignSkipped>,
        pub snapshot: Box<EnrichedSnapshot>,
    }
}

wire_struct! {
    @inline
    /// A ticket a Reassign left alone, and why.
    pub struct ReassignSkipped {
        pub id: String,
        pub reason: String,
    }
}

wire_struct! {
    /// The per-ticket Reassign view the snapshot carries on every ordinary
    /// ticket (grader and head-to-head tickets are never reassignable and carry
    /// `eligible: false` with a reason). `eligible` is the server's judgement
    /// that a write would take effect at the next Tick: no Attempt in
    /// flight and not done. `reason` explains a false `eligible` in one line
    /// for the Detail pane. `verify` is the ticket's own verify count, which
    /// has no default and so is pinned or absent. `sources` explains the
    /// Assignment the card shows.
    pub struct TicketReassignView {
        pub eligible: bool,
        pub reason: Option<String>,
        pub verify: Option<u64>,
        pub sources: AssignmentSources,
    }
}

// ---------------------------------------------------------------------------
// Resume (POST /api/resume)
// ---------------------------------------------------------------------------

wire_enum! {
    /// The action a resume request carries (POST /api/resume): `approve` and
    /// `reject` answer the review gate and merge-approval interrupts; `close`
    /// drops a ticket at a checkpoint, merge-conflict or deadlock Interrupt
    /// without merging it (issue #154); `adopt` takes one finished Candidate of
    /// a paused verify round as the Winner, named by the request's `attempt`
    /// (ADR-0035); plain `resume` answers every other kind. Declared once here;
    /// the server's answer path and the Console's client and interrupt forms all
    /// use it.
    pub enum ResumeAction {
        Resume = "resume",
        Approve = "approve",
        Reject = "reject",
        Close = "close",
        Adopt = "adopt",
    }
}

// ---------------------------------------------------------------------------
// The snapshot (GET /api/state, POST /api/start and /api/resume, the socket)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One ticket as the enriched snapshot carries it.
    pub struct EnrichedTicketState {
        pub id: String,
        pub title: String,
        pub blocked_by: Vec<String>,
        pub status: TicketStatus,
        /// Where the ticket stands in the Merge queue (issue #129): null unless
        /// it is done and its branch has not landed in the merge target
        /// (ADR-0014). A lookup into the snapshot's Merge queue, the engine's one
        /// derivation; every UI surface reads this field and never git.
        pub merge_state: Option<MergeQueueState>,
        /// The ticket's resolved Assignment record (ADR-0013), served verbatim.
        pub assignment: AssignmentView,
        /// The ticket's Live attempt (ADR-0014): the attempt number and, for a
        /// terminal-backed attempt, its herdr pane, served verbatim from the
        /// engine's snapshot while the attempt runs; null once it has ended, so a
        /// finished card's terminal surface and its polling stop, and null for a
        /// ticket with nothing running. A headless attempt is live with a null
        /// pane. Its role says whether it is the Ticket's own agent or a resolver
        /// on the Ticket's conflicted merge (issue #129).
        pub live_attempt: Option<LiveAttemptRecord>,
        /// The ticket's Held pane (issue #139): while it waits at a checkpoint
        /// Interrupt whose Terminal-backed attempt's pane is still alive in herdr,
        /// that attempt's number and pane, so the card and the Detail keep peek,
        /// focus and attach for it and offer Keep talking. Null once the Interrupt
        /// is answered or the pane is gone, for a headless attempt, and for every
        /// ticket not at a checkpoint. Never set together with `liveAttempt`.
        pub held_pane: Option<HeldPaneRecord>,
        /// The ticket was enlisted from a live herdr pane (issue #101): its
        /// Assignment was recorded as found, so the card reads "as found" where a
        /// spawned ticket names a model. Derived by the server from the marker's
        /// durable `enlisted-from` field.
        pub enlisted: bool,
        /// Reassign (issue #126): whether a write to this ticket's assign entry
        /// would take effect at the next Tick, why not when it would not, the
        /// ticket's own verify count, and where each field of `assignment` came
        /// from. For a ticket with no Attempt in flight, `assignment` is resolved
        /// from the config file as it stands now, so a Reassign shows on the card
        /// at once rather than at the next Tick; an in-flight ticket keeps
        /// the engine's frozen record.
        pub reassign: TicketReassignView,
        /// The Plan node a Line's Ticket belongs to (ADR-0039), from the marker's
        /// durable `node` field; absent on every other Ticket.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub node: Option<String>,
    }
}

wire_struct! {
    /// The pool's state as the Console sees it: the engine's snapshot enriched by the server.
    pub struct EnrichedSnapshot {
        pub seq: u64,
        pub phase: RunPhase,
        /// The pool's display name: the last two path segments of the pool directory.
        pub pool_name: String,
        /// The Pool title (issue #100) from the pool's config as it stands now, or
        /// null when it has none; the Console shows it ahead of `poolName`, which
        /// it falls back to. Display-only: the directory stays the identity.
        pub pool_title: Option<String>,
        /// The pool directory the server was launched on, verbatim: what a
        /// relaunch after a Console stop (issue #97) passes to `--pool`.
        pub pool_dir: String,
        /// Finished terminals (issue #139): how many herdr tabs this pool opened
        /// are still open over an Attempt or a Conversation that has ended, none
        /// of them a Live attempt's, a Held pane's, an enlisted pane or a live
        /// Conversation's. The pool header offers to close them when it is not 0;
        /// the engine never closes them on its own.
        pub finished_terminals: u64,
        /// The Spawn caps in force and this run's count (issue #149), from the
        /// engine's snapshot verbatim: "Spawns `spawnedThisRun`/`perRun` this run"
        /// and "`perAttempt` per attempt". A run is this Console boot.
        pub spawn_usage: SpawnUsage,
        /// The Pending spawns (issue #150), oldest first, from the engine's
        /// snapshot verbatim: proposals within the caps that land at the next
        /// Tick.
        pub pending_spawns: Vec<PendingSpawnView>,
        /// The Held spawns (issue #149, ADR-0029, widened by issue #150), oldest
        /// first, from the engine's snapshot verbatim: the proposals a Spawn cap
        /// had no room for, the agent marked as overlapping, or the operator held
        /// back, each waiting for the operator to Adopt it (past the caps) or
        /// Discard it.
        pub held_spawns: Vec<HeldSpawnView>,
        /// The Steward budget (ADR-0030), from the engine's snapshot verbatim: the
        /// Pool's budget per Ticket, and what the Steward has used on each Ticket
        /// it answered since the operator last did (absent from `used` is 0).
        /// Remaining is `budget - used`. Always sent; optional only so a fixture
        /// written before the Steward still types.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub steward_budget: Option<StewardBudgetView>,
        /// The pool's Line (ADR-0039): its frozen Plan with live state, absent in
        /// a pool that runs no Line.
        #[serde(skip_serializing_if = "Option::is_none")]
        pub line: Option<LineGraphView>,
        pub state: SnapshotState,
    }
}

wire_struct! {
    @inline
    /// The run's lists: tickets, Conversations, the pool log, and what waits on the operator.
    pub struct SnapshotState {
        pub tickets: Vec<EnrichedTicketState>,
        /// Every Conversation the pool knows about (issue #60), passed through
        /// from the engine's own snapshot verbatim: conversationViewOf already
        /// builds the wire shape the UI wants, so there is nothing to enrich.
        pub conversations: Vec<ConversationView>,
        pub log: Vec<String>,
        pub outcomes: IndexMap<String, Outcome>,
        pub interrupts: Vec<Interrupt>,
        /// The Merge queue (issue #129): every held ticket, head first, in the
        /// order the engine works through them. Empty when no hold stands.
        pub merge_queue: Vec<MergeQueueEntry>,
        /// Accepted answers still waiting for processing (the Queued answers).
        pub queued_answers: Vec<QueuedAnswer>,
        pub config: Map<String, Value>,
    }
}

// ---------------------------------------------------------------------------
// Ticket events (GET /api/events)
// ---------------------------------------------------------------------------

wire_struct! {
    /// An attempt rebuilt from its log file, for a ticket with no events file.
    pub struct ReconstructedAttempt {
        pub attempt: u64,
        pub log_file: String,
        pub modified_at: String,
    }
}

wire_struct! {
    /// GET /api/events's answer.
    pub struct TicketEventsResponse {
        pub events: Vec<TicketEvent>,
        pub attempts: Vec<ReconstructedAttempt>,
        pub reconstructed: bool,
        /// The ticket's spec text: the issue file body after the title heading.
        pub spec: String,
    }
}

// ---------------------------------------------------------------------------
// Ticket log (GET /api/log)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One attempt a ticket's log can be read for.
    pub struct LogAttemptInfo {
        pub attempt: u64,
        pub kind: LogAttemptKind,
        pub current: bool,
        pub log_file: String,
        /// The attempt's Stream file (the raw stream tee, ADR-0012), named by the
        /// events module's contract the same way `logFile` is. Null when the
        /// attempt has no Stream file on disk: a raw harness (opencode), a
        /// pre-streaming attempt, or a reconstructed row.
        pub stream_file: Option<String>,
    }
}

wire_enum! {
    @inline
    /// What an attempt row of the log is.
    pub enum LogAttemptKind {
        Implement = "implement",
        Resolver = "resolver",
        Reconstructed = "reconstructed",
    }
}

wire_struct! {
    /// GET /api/log's answer: one byte range of an attempt's log or Stream file.
    pub struct TicketLogResponse {
        pub content: String,
        pub offset: u64,
        pub next_offset: u64,
        pub total_size: u64,
        pub attempts: Vec<LogAttemptInfo>,
    }
}

// ---------------------------------------------------------------------------
// Ticket activity (GET /api/activity)
// ---------------------------------------------------------------------------

wire_struct! {
    /// GET /api/activity's answer, and the socket's live activity value.
    pub struct TicketActivityResponse {
        pub ticket_id: String,
        pub running: bool,
        pub diff: Option<ActivityDiff>,
        pub log: Option<ActivityLog>,
        pub last_event_at: Option<String>,
    }
}

wire_struct! {
    @inline
    /// The ticket's worktree diff against its base.
    pub struct ActivityDiff {
        pub added: u64,
        pub removed: u64,
        pub files: Vec<String>,
    }
}

wire_struct! {
    @inline
    /// The latest attempt log's size and last change.
    pub struct ActivityLog {
        pub size: u64,
        pub mtime: String,
    }
}

// ---------------------------------------------------------------------------
// Grades (GET /api/grades)
// ---------------------------------------------------------------------------

wire_struct! {
    /// One ticket's latest grade, as the card summaries show it: the score and
    /// verdict with the graded attempt's number, plus the winning attempt's
    /// number once Selection has named one. Derived at read time from the same
    /// events files the Detail's timeline reads, so a card and the Detail never
    /// disagree. Reasons stay in the events payload; the card is a summary.
    pub struct TicketGradeSummary {
        pub attempt: u64,
        #[serde(with = "crate::json::js_number")]
        pub score: f64,
        pub verdict: String,
        /// The attempt Selection named, or the merged attempt on a ticket graded
        /// before the selection machinery. Null until either event lands. The
        /// Detail's winner badge reads this field, so both surfaces share the one
        /// derivation.
        pub winner: Option<u64>,
    }
}

// ---------------------------------------------------------------------------
// Ticket body (GET /api/ticket)
// ---------------------------------------------------------------------------

wire_struct! {
    /// GET /api/ticket's answer.
    pub struct TicketBodyResponse {
        pub id: String,
        /// The Issue file's markdown with the line-1 state marker stripped.
        pub body: String,
    }
}

// ---------------------------------------------------------------------------
// Keep talking (POST /api/keep-talking)
// ---------------------------------------------------------------------------

wire_struct! {
    /// Keep talking (issue #139): continue a ticket's checkpointed Attempt in its
    /// Held pane. Not a resume action: it is never queued for a Tick
    /// (ADR-0004's exception, as Enlist is), so it has its own route.
    pub struct KeepTalkingRequest {
        pub ticket_id: String,
    }
}

wire_struct! {
    /// The Continued attempt's number, once the engine has claimed the pane. A
    /// refusal is the 409 `reason` envelope the enlist route answers with.
    pub struct KeepTalkingResponse {
        pub ticket_id: String,
        pub attempt: u64,
    }
}

// ---------------------------------------------------------------------------
// Close finished terminals (POST /api/terminals/close-finished)
// ---------------------------------------------------------------------------

wire_struct! {
    /// How many Finished terminals the bulk close closed.
    pub struct CloseFinishedTerminalsResponse {
        pub closed: u64,
    }
}

// ---------------------------------------------------------------------------
// Held spawns (POST /api/spawns/held/adopt, /api/spawns/held/discard)
// ---------------------------------------------------------------------------

wire_struct! {
    /// Adopt or Discard one Held spawn (issue #149, ADR-0029), by its id. Adopt
    /// answers 202 once the adoption is queued (written at once on an idle pool,
    /// at the next Tick otherwise); Discard answers 200 once it is gone. A
    /// refusal is the 409 `reason` envelope the keep-talking route answers with.
    pub struct HeldSpawnRequest {
        pub id: String,
    }
}

wire_struct! {
    /// The Held spawn an Adopt or Discard acted on.
    pub struct HeldSpawnResponse {
        pub id: String,
    }
}

// ---------------------------------------------------------------------------
// Terminal peek (GET /api/terminal/peek)
// ---------------------------------------------------------------------------

wire_struct! {
    /// The peek endpoint's answer for one ticket: the pane's viewport as plain
    /// text (ANSI stripped herdr-side), the engine's own last read of it when a
    /// loop of the engine's watches the pane and a live viewport read otherwise
    /// (issue #122). The UI keys every terminal call by ticket id; the server
    /// resolves and guards the pane, and which of the two served it is not the
    /// UI's concern.
    pub struct TerminalPeekResponse {
        pub ticket: String,
        pub pane_id: String,
        pub text: String,
    }
}

// ---------------------------------------------------------------------------
// A Line's verdicts and its verbs (ADR-0037, ADR-0039): POST /api/line, POST /api/line/start, GET /api/line
// ---------------------------------------------------------------------------

wire_enum! {
    /// Prove's verdict: the merged work runs end to end, or it does not.
    pub enum ProveResult {
        Pass = "pass",
        Fail = "fail",
    }
}

wire_struct! {
    /// The `verdict` a Prove Ticket's Outcome carries.
    pub struct ProveVerdict {
        pub prove: ProveResult,
        /// Where the evidence is: a path the operator can open.
        pub evidence: String,
    }
}

wire_enum! {
    /// How much a Review finding matters. Decide must account for every must.
    pub enum FindingSeverity {
        Must = "must",
        Should = "should",
        Nit = "nit",
    }
}

wire_struct! {
    /// One Review finding.
    pub struct ReviewFinding {
        pub severity: FindingSeverity,
        pub title: String,
        pub detail: String,
    }
}

wire_struct! {
    /// The `verdict` a Review Ticket's Outcome carries: its findings, possibly none.
    pub struct ReviewVerdict {
        pub findings: Vec<ReviewFinding>,
    }
}

wire_struct! {
    /// One finding Decide fixes in another round or drops, and why.
    pub struct DecideItem {
        pub title: String,
        pub reason: String,
    }
}

wire_union! {
    /// The Plan a Line runs, as `POST /api/line` names it: a Preset or library slug, or a Plan file.
    #[serde(untagged)]
    pub enum LinePlanSource {
        Slug(String),
        File(Unchecked<PlanFile>),
    }
}

wire_struct! {
    /// POST /api/line's body, sent once by Boot: the Plan to freeze and exactly one of the Line's
    /// work or the path of a Line brief in the pool checkout. Answers 202 with the Line, or the 409
    /// `reason` envelope when the Plan is invalid or not runnable yet, or a Line exists.
    pub struct LineBeginRequest {
        pub plan: LinePlanSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub work: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub brief: Option<String>,
    }
}

wire_struct! {
    /// GET /api/line: the pool's Line as the engine runs it, null when the pool has none.
    pub struct LineResponse {
        pub line: Option<LineGraphView>,
    }
}

// ---------------------------------------------------------------------------
// Plans (ADR-0039)
// ---------------------------------------------------------------------------

wire_struct! {
    /// A Plan file: `~/.agent-graphs/plans/<slug>.json`, a compiled-in Preset, or a Line's frozen
    /// copy. The engine's `ac_core::plan` is the only reader that decides whether one is valid.
    #[serde(deny_unknown_fields)]
    pub struct PlanFile {
        /// The format tag, 1.
        pub horde: u32,
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub author: Option<String>,
        /// The author's own file the flow comes from. Every Preset has one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        /// The Steward may edit a Line running this Plan. Off unless set.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub steward_edits: Option<bool>,
        pub nodes: Vec<PlanNodeFile>,
        pub edges: Vec<PlanEdgeFile>,
    }
}

wire_union! {
    /// One node of a Plan file, told apart by `kind`. Agent, Prove, Review and Decide are Ticket
    /// nodes, and the kind fixes the verdicts their edges may route.
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum PlanNodeFile {
        Conversation(PlanConversationNode),
        Agent(PlanTicketNode),
        Prove(PlanTicketNode),
        Review(PlanTicketNode),
        Decide(PlanTicketNode),
        Merger(PlanMergerNode),
        Gate(PlanGateNode),
        Finish(PlanFinishNode),
    }
}

wire_struct! {
    @inline
    /// Opens a Conversation per pass.
    #[serde(deny_unknown_fields)]
    pub struct PlanConversationNode {
        pub id: String,
        pub title: String,
        pub x: i32,
        pub y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub skill: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub assign: Option<PlanAssign>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
    }
}

wire_struct! {
    @inline
    /// Writes a Ticket per pass, or one per item.
    #[serde(deny_unknown_fields)]
    pub struct PlanTicketNode {
        pub id: String,
        pub title: String,
        pub x: i32,
        pub y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub skill: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub assign: Option<PlanAssign>,
        /// Absent, one copy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub copies: Option<PlanCopies>,
        /// Taught to return `items` in its Outcome.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub makes_items: Option<bool>,
        /// Absent, the operator.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub checkpoint: Option<PlanCheckpoint>,
        /// Absent, hold.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub spawns: Option<PlanSpawns>,
        /// Added to every Ticket body this node writes.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
    }
}

wire_struct! {
    @inline
    /// The fan-in of one per-item Ticket node. Runs no agent.
    #[serde(deny_unknown_fields)]
    pub struct PlanMergerNode {
        pub id: String,
        pub title: String,
        pub x: i32,
        pub y: i32,
        /// The per-item Ticket node this Merger folds.
        pub of: String,
        /// Absent, a resolver on the pool's own resolver settings.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub conflict: Option<PlanConflict>,
    }
}

wire_struct! {
    @inline
    /// Opened by the operator, the Steward, or at once.
    #[serde(deny_unknown_fields)]
    pub struct PlanGateNode {
        pub id: String,
        pub title: String,
        pub x: i32,
        pub y: i32,
        /// Absent, the operator.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub open: Option<PlanOpener>,
        /// Absent, any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub join: Option<PlanJoin>,
    }
}

wire_struct! {
    @inline
    /// The one Finish: its hold, then the Finish Ticket that carries out its act.
    #[serde(deny_unknown_fields)]
    pub struct PlanFinishNode {
        pub id: String,
        pub title: String,
        pub x: i32,
        pub y: i32,
        /// Absent, none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub act: Option<PlanFinishAct>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub assign: Option<PlanAssign>,
    }
}

wire_struct! {
    /// A node's harness, model and effort. An absent field falls through to the pool defaults.
    #[serde(deny_unknown_fields)]
    pub struct PlanAssign {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub harness: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub effort: Option<String>,
    }
}

wire_union! {
    /// One copy per pass, or one per item under a cap.
    #[serde(untagged)]
    pub enum PlanCopies {
        One(PlanOneCopy),
        PerItem(PlanPerItem),
    }
}

wire_enum! {
    @inline
    pub enum PlanOneCopy {
        One = "one",
    }
}

wire_struct! {
    @inline
    #[serde(deny_unknown_fields)]
    pub struct PlanPerItem {
        pub per_item: PlanCap,
    }
}

wire_union! {
    /// At most this many copies live at once, or every item at once.
    #[serde(untagged)]
    pub enum PlanCap {
        At(u32),
        All(AllItems),
    }
}

wire_enum! {
    @inline
    pub enum AllItems {
        All = "all",
    }
}

wire_enum! {
    /// Who answers a checkpoint a node's Tickets raise.
    pub enum PlanCheckpoint {
        Operator = "operator",
        Steward = "steward",
    }
}

wire_enum! {
    /// What happens to the Spawns a node's Tickets propose: held for the operator, or landed under
    /// the Spawn caps.
    pub enum PlanSpawns {
        Hold = "hold",
        Land = "land",
    }
}

wire_union! {
    /// A merge conflict on a copy: a resolver on this Assignment, or a wait for the operator.
    #[serde(untagged)]
    pub enum PlanConflict {
        Wait(PlanWait),
        Resolver(PlanResolver),
    }
}

wire_enum! {
    @inline
    pub enum PlanWait {
        Wait = "wait",
    }
}

wire_struct! {
    @inline
    #[serde(deny_unknown_fields)]
    pub struct PlanResolver {
        pub resolver: PlanAssign,
    }
}

wire_enum! {
    /// Who opens a Gate. `auto` opens it at once, with no hold.
    pub enum PlanOpener {
        Operator = "operator",
        Steward = "steward",
        Auto = "auto",
    }
}

wire_enum! {
    /// A Gate opens on a handoff from any incoming edge, or waits for all of them.
    pub enum PlanJoin {
        Any = "any",
        All = "all",
    }
}

wire_union! {
    /// What the Finish does once approved: one of the named acts, or free text the Finish Ticket's
    /// agent carries out.
    #[serde(untagged)]
    pub enum PlanFinishAct {
        Named(PlanNamedAct),
        Other(PlanOtherAct),
    }
}

wire_enum! {
    @inline
    pub enum PlanNamedAct {
        None = "none",
        DraftPr = "draft-pr",
        Pr = "pr",
        FastForward = "fast-forward",
    }
}

wire_struct! {
    @inline
    #[serde(deny_unknown_fields)]
    pub struct PlanOtherAct {
        pub other: String,
    }
}

wire_struct! {
    /// An edge: `from`'s verdict `on` goes to `to`. `(from, on, to)` is unique in a Plan.
    #[serde(deny_unknown_fields)]
    pub struct PlanEdgeFile {
        pub from: String,
        pub on: String,
        pub to: String,
        /// Present on a capped loop edge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cap: Option<PlanLoopCap>,
    }
}

wire_struct! {
    /// A loop edge's limit.
    #[serde(deny_unknown_fields)]
    pub struct PlanLoopCap {
        pub max: u32,
        /// The Steward may buy one more pass once the loop is spent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub steward_extra: Option<bool>,
        /// Absent, a loop hold for the operator.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub when_spent: Option<PlanWhenSpent>,
    }
}

wire_union! {
    /// A spent loop raises a hold, or hands on to another node instead.
    #[serde(untagged)]
    pub enum PlanWhenSpent {
        Hold(PlanHold),
        To(PlanSpentTo),
    }
}

wire_enum! {
    @inline
    pub enum PlanHold {
        Hold = "hold",
    }
}

wire_struct! {
    @inline
    #[serde(deny_unknown_fields)]
    pub struct PlanSpentTo {
        pub to: String,
    }
}

wire_struct! {
    /// One thing wrong with a Plan, on what the editor marks.
    pub struct PlanProblem {
        pub at: PlanProblemAt,
        pub message: String,
    }
}

wire_union! {
    /// What a problem is on: the Plan as a whole, one node, or one edge.
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum PlanProblemAt {
        Plan(PlanAtPlan),
        Node(PlanAtNode),
        Edge(PlanAtEdge),
    }
}

wire_struct! {
    @inline
    pub struct PlanAtPlan {}
}

wire_struct! {
    @inline
    pub struct PlanAtNode {
        pub id: String,
    }
}

wire_struct! {
    @inline
    pub struct PlanAtEdge {
        pub from: String,
        pub on: String,
        pub to: String,
    }
}

wire_struct! {
    /// A Plan as `plans.list` names it: a Preset, or a file in the Plan library with whatever is
    /// wrong with it.
    pub struct PlanSummary {
        pub slug: String,
        pub preset: bool,
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub author: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        pub problems: Vec<PlanProblem>,
    }
}

wire_struct! {
    /// GET /api/plans: the Presets, then the Plan library by slug.
    pub struct PlansListResponse {
        pub plans: Vec<PlanSummary>,
    }
}

wire_struct! {
    /// A Plan named by its slug: the socket form of a /api/plans/<slug> path.
    pub struct PlanSlugRequest {
        pub slug: String,
    }
}

wire_struct! {
    /// GET /api/plans/<slug>: the Plan's file as it stands, and what is wrong with it.
    pub struct PlanResponse {
        pub slug: String,
        pub preset: bool,
        pub plan: Unchecked<PlanFile>,
        pub problems: Vec<PlanProblem>,
    }
}

wire_struct! {
    /// POST /api/plans/validate's body: a draft Plan, checked whole.
    pub struct PlanValidateRequest {
        pub plan: Unchecked<PlanFile>,
    }
}

wire_struct! {
    /// Every problem with the draft, none when it is valid.
    pub struct PlanValidateResponse {
        pub problems: Vec<PlanProblem>,
    }
}

wire_struct! {
    /// PUT /api/plans/<slug>: the body is `plan`; the socket form carries `slug` beside it.
    pub struct PlanSaveRequest {
        pub slug: String,
        pub plan: Unchecked<PlanFile>,
    }
}

wire_struct! {
    /// The Plan as saved, in its canonical form.
    pub struct PlanSaveResponse {
        pub slug: String,
        pub plan: PlanFile,
    }
}

// ---------------------------------------------------------------------------
// A Line running a Plan (ADR-0039): line.json and the live graph
// ---------------------------------------------------------------------------

wire_struct! {
    /// `line.json` in the pool directory: the frozen Plan, its rev, where the Line lives, and what
    /// the run has absorbed. `ac_core::line::run` is the only reader that decides whether one is
    /// valid; a file without `horde` is from before Plans and is refused.
    pub struct LineFile {
        /// The format tag, 1.
        pub horde: u32,
        pub plan: PlanFile,
        /// Bumped by every applied plan edit.
        pub rev: u64,
        pub places: LinePlacesFile,
        pub run: LineRunFile,
    }
}

wire_struct! {
    /// Where a Line lives: its branch, the Line base it was cut from, the spec and `pushBase` the
    /// Line brief set, and the work Boot was given.
    pub struct LinePlacesFile {
        pub branch: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub base: Option<LineBase>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub spec: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        pub push_base: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub work: Option<String>,
    }
}

wire_enum! {
    /// Where a running Line stands. `acting` means the Finish was approved and its Finish Ticket is
    /// owed or running.
    pub enum LineRunStatus {
        Running = "running",
        Finishing = "finishing",
        Acting = "acting",
        Done = "done",
        Closed = "closed",
    }
}

wire_struct! {
    /// The run state a Line has absorbed. Ticket statuses and merged-ness are never stored here.
    pub struct LineRunFile {
        pub status: LineRunStatus,
        /// The Finish Ticket while `acting`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub act: Option<String>,
        pub nodes: Vec<LineNodeRunFile>,
        pub edges: Vec<LineEdgeRunFile>,
        /// Every done Ticket the run absorbed, in the order it settled.
        pub settled: Vec<String>,
    }
}

wire_struct! {
    /// One item of work: from an Outcome's `items` or a Line brief's.
    pub struct LineItem {
        pub title: String,
        pub body: String,
    }
}

wire_struct! {
    /// What travels along an edge.
    pub struct LineHandoffFile {
        /// Absent for what the Line started with.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub from: Option<String>,
        pub verdict: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub items: Vec<LineItem>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub after: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub notes: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub halted: Option<String>,
    }
}

wire_struct! {
    /// An edge named by its unique `(from, on, to)`.
    pub struct LineEdgeKey {
        pub from: String,
        pub on: String,
        pub to: String,
    }
}

wire_struct! {
    /// A `join: all` Gate's arrival on one incoming edge.
    pub struct LineArrivalFile {
        pub edge: LineEdgeKey,
        pub handoff: LineHandoffFile,
    }
}

wire_struct! {
    /// One node's run state.
    pub struct LineNodeRunFile {
        pub id: String,
        pub passes: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub current: Option<LinePassFile>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub inbox: Vec<LineHandoffFile>,
        /// Handoffs on verdicts with no out edge, one per verdict.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub parked: Vec<LineHandoffFile>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub arrived: Vec<LineArrivalFile>,
    }
}

wire_struct! {
    /// A node's live pass.
    pub struct LinePassFile {
        pub n: u32,
        pub input: LineHandoffFile,
        pub work: LinePassWorkFile,
        /// A Decide pass's Prove and Review Tickets, fixed when the pass started.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub reads: Vec<String>,
    }
}

wire_union! {
    /// What a pass runs, told apart by `kind`.
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum LinePassWorkFile {
        Tickets(LineTicketsWork),
        Conversation(LineConversationWork),
        Hold(LineHoldWork),
        Finish(LineFinishWork),
    }
}

wire_struct! {
    @inline
    /// A Ticket node's copies, and the items queued past its cap.
    pub struct LineTicketsWork {
        pub copies: Vec<LineCopyFile>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub queue: Vec<LineItem>,
        pub cap: PlanCap,
        pub next_seq: u32,
    }
}

wire_struct! {
    @inline
    pub struct LineConversationWork {
        pub id: String,
    }
}

wire_struct! {
    @inline
    /// An operator or Steward Gate's unanswered hold.
    pub struct LineHoldWork {
        pub ticket: String,
    }
}

wire_struct! {
    @inline
    /// The Finish has its handoff; `hold` once the Finish hold is written.
    pub struct LineFinishWork {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub hold: Option<String>,
    }
}

wire_struct! {
    /// One copy of a pass.
    pub struct LineCopyFile {
        pub ticket: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item: Option<LineItem>,
        pub freed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub settled: Option<LineSettledFile>,
    }
}

wire_struct! {
    /// A copy's verdict, once it is done and merged or closed.
    pub struct LineSettledFile {
        pub verdict: String,
        pub done: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pub items: Vec<LineItem>,
    }
}

wire_struct! {
    /// One loop edge's counts. `traversals` never resets, so a loop hold's id is never reused.
    pub struct LineEdgeRunFile {
        pub edge: LineEdgeKey,
        pub count: u32,
        pub traversals: u32,
        pub bought: u32,
        pub steward_used: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub held: Option<LineHeldFile>,
    }
}

wire_struct! {
    /// A spent loop's handoff, waiting on its hold Ticket.
    pub struct LineHeldFile {
        pub ticket: String,
        pub handoff: LineHandoffFile,
    }
}

wire_struct! {
    /// The Console's live Line graph (`Snapshot.line`, GET /api/line): the frozen Plan with what
    /// the run holds on each node and loop edge. Ticket statuses join from the snapshot's tickets.
    pub struct LineGraphView {
        pub plan: PlanFile,
        pub rev: u64,
        pub status: LineRunStatus,
        /// What the Finish waits for, as the refusal names it.
        pub waiting_for: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub act: Option<String>,
        pub nodes: Vec<LineNodeView>,
        pub edges: Vec<LineEdgeView>,
    }
}

wire_struct! {
    /// One node of the live graph, every Plan node listed.
    pub struct LineNodeView {
        pub id: String,
        pub passes: u32,
        /// The live pass, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pass: Option<u32>,
        /// The live pass's copies, or its Conversation.
        pub tickets: Vec<String>,
        pub queued: u32,
        pub inbox: u32,
        /// Verdicts with no out edge, waiting for one.
        pub parked: Vec<String>,
        /// A `join: all` Gate's arrivals so far.
        pub arrived: Vec<LineEdgeKey>,
        /// A Gate's or the Finish's hold Ticket.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub hold: Option<String>,
    }
}

wire_struct! {
    /// One capped loop edge of the live graph.
    pub struct LineEdgeView {
        pub edge: LineEdgeKey,
        pub count: u32,
        pub max: u32,
        pub bought: u32,
        /// The spent loop's hold Ticket.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub hold: Option<String>,
    }
}
