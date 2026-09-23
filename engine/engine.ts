import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  defaultMachineDefaultsPaths,
  readMachineDefaults,
  type MachineDefaultsPaths,
} from "./machine-defaults.ts";
import {
  appendEvent,
  attemptExitCodeName,
  attemptLogName,
  attemptOutcomeName,
  lastAttempt,
  nextAttempt,
  readEvents,
  ticketSeedName,
} from "./events.ts";
import {
  type CheckpointStore,
  SqliteCheckpointStore,
} from "./checkpoints.ts";
import { QueuedAnswerStore, type QueuedAnswer } from "./queued-answers.ts";
import {
  MARKER_RE,
  loadPoolMarkers,
  parseEnlistId,
  parseSpawnId,
  readMarker,
  writeMarkerStatus,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { buildEnlistTeaching, buildGraderPrompt, buildHeadToHeadPrompt, buildPrompt, buildResolverPrompt } from "./prompt.ts";
import {
  defaultHarnesses,
  engineEnvSet,
  spawnEnv,
  type HarnessCommand,
} from "./spawn.ts";
import {
  HERDR_SOCKET_DEFAULT,
  closePane,
  closeTab,
  listPaneIds,
  releasePaneAgent,
  resolvePoolWorkspace,
  workspaceExists,
} from "./herdr.ts";
import {
  attemptStreamPath,
  readLogTail,
  releaseAttemptAgent,
  reportAttemptAgent,
  rotateAttemptLog,
  runAttempt,
  startPaneStreamTail,
  type AttemptEnv,
  type PoolWorkspace,
} from "./attempt-run.ts";
import {
  EXIT_CODE_PANE_GONE,
  EXIT_CODE_UNREADABLE,
  exitedPhrase,
  readAttemptResult,
  waitForAttemptEnding,
  type AttemptEndingDecision,
  type ReadFailure,
} from "./attempt-ending.ts";
import {
  createConversations,
  loadConversations,
  nextConversationId,
  type ConversationHost,
  type ConversationModule,
  type ConversationView,
  type StartConversationRequest,
} from "./conversations.ts";
import {
  assignmentViewOf,
  DEFAULT_DRIVERS,
  resolveAssignment,
  resolveAssignmentSources,
  type Assignment,
  type AssignmentSources,
  type AssignmentView,
} from "./assignment.ts";
import {
  createEnlistedAttempts,
  waitForEnlistedEnding,
  type EnlistedAttempts,
  type EnlistedEnding,
  type EnlistedHost,
} from "./enlisted.ts";
import {
  findEnlistablePane,
  type EnlistConversationWireRequest,
  type EnlistRequest,
  type EnlistResponse,
  type EnlistTicketRequest,
} from "./enlist.ts";
import { ChildTracker, orphanIsLive, stopOrphan } from "./children.ts";
import { createLiveAttempts, type LiveAttemptRecord, type LiveAttempts } from "./live-attempts.ts";
import { createPaneReadRegister, type PaneRead, type PaneReadRegister } from "./pane-reads.ts";
import {
  createMergeHoldWatch,
  createMergeLine,
  deriveMergeHold,
  gitMergeHoldProbe,
  type HoldHost,
  type MergeHoldWatch,
  type MergeLine,
  type MergeQueueEntry,
  throughMergeHold,
} from "./merge-hold.ts";
import {
  branchCheckedOutAt,
  branchExists,
  branchFor,
  checkoutNewBranch,
  closeMergeCheckout,
  commitMerge,
  commitShaAt,
  attemptBranches,
  blockedMergeExplanation,
  currentBranch,
  discardWorktree,
  git,
  gitAvailable,
  mergeBranch,
  openMergeCheckout,
  prepareWorktree,
  removeStaleMergeCheckout,
  removeWorktree,
  worktreePathFor,
  type MergeResult,
  type WorktreeInfo,
} from "./worktrees.ts";

export type { HarnessCommand } from "./spawn.ts";
// Re-exported so engine.test.ts's existing import (`from "./engine.ts"`)
// keeps working now that the wrapper-shape logic lives in pane-session.ts.
export { interactiveWrapper } from "./pane-session.ts";
import type { LaunchCadence } from "./pane-session.ts";
import { createJev, JEV_MODEL, type Jev, type JevCause, type JevNotice } from "./jev.ts";
import { buildEvidence } from "./jev-evidence.ts";
import { compose, QUESTIONS, RUBRIC_VERSION, THRESHOLDS } from "./jev-rubric.ts";
export type {
  ConversationRecord,
  ConversationStatus,
  ConversationView,
  StartConversationRequest,
} from "./conversations.ts";
export type { TurnSide, TurnState } from "./turn-state.ts";
export type {
  Assignment,
  AssignmentSource,
  AssignmentSources,
  AssignmentView,
} from "./assignment.ts";

// The attempt's result, written by the agent as JSON at the outcome path its
// prompt names and read by the engine at attempt exit. `status` is the
// attempt's ending: the engine, not the agent, writes it to the canonical
// Issue's line-1 marker (ADR-0005). Marker statuses written by the agent are
// not honored anywhere.
export type OutcomeStatus = "done" | "checkpoint";

// One follow-up ticket an attempt proposes in its Outcome's optional spawn
// array (ADR-0010). The agent never proposes an id, a status or a marker:
// the engine assigns the id, writes the ticket file and owns the marker.
export interface SpawnProposal {
  title: string;
  body: string;
  blockedBy?: string[];
  // The Conversations ADR's extension: what the proposal becomes. Absent
  // means "ticket", ADR-0010's original and only shape, so an ordinary
  // attempt's outcome.spawn entries need no change. "conversation" starts a
  // child Conversation instead of writing a ticket file (adoptSpawnProposals
  // below); a Ticket's own outcome may propose one too, not only a
  // Conversation's spawn.json (the seam is shared).
  kind?: "ticket" | "conversation";
  // The child's Assignment, when the proposer wants something other than
  // its own. Absent inherits: resolveSpawnedTicketAssignment for a ticket,
  // conversations.ts's resolveConversationAssignment for a Conversation.
  // An unknown assign.harness drops the whole proposal at adoption time
  // (adoptSpawnProposals), the same disposition an unknown blockedBy id
  // gets, since neither can be checked here where no Session exists yet.
  assign?: { harness?: string; model?: string; drivers?: string };
}

// One spawn entry the schema rejected: where it sat in the array and why.
// Rejection is per proposal (ADR-0010): a malformed proposal never fails the
// attempt, it is dropped and the reason is logged.
export interface SpawnRejection {
  // Absent when the spawn key itself is malformed rather than one entry.
  index?: number;
  reason: string;
}

// Caps (ADR-0010): at most 5 proposals honored per attempt and 20 per run.
// Overflow truncates and logs (the adoption event carries the count), never
// an error. Engine constants by spec; no config surface.
const SPAWN_MAX_PER_ATTEMPT = 5;
const SPAWN_MAX_PER_RUN = 20;

// One attempt's surviving proposals, buffered between the moment an outcome
// becomes the ticket's (a solo attempt's exit, a lone attempt's completion, a
// selection's winner) and the boundary that adopts them. `origin` is the
// Conversations ADR's addition: "conversation" is a Conversation's own
// spawn.json batch (engine/notices.ts's poller), which bypasses the per-run
// cap (spec: "no run-wide cap for Conversation Spawns") but keeps the
// per-proposal cap; every ticket-outcome push stays "ticket".
export interface PendingSpawn {
  parentId: string;
  proposals: SpawnProposal[];
  origin: "ticket" | "conversation";
}

export interface Outcome {
  status: OutcomeStatus;
  summary: string;
  commitSha: string | null;
  brief?: string;
  // Follow-up ticket proposals (ADR-0010): the agent proposes in its Outcome,
  // the engine writes the pool at the super-step boundary. Three states:
  // absent, the attempt proposed nothing, exactly as before this key existed;
  // present and empty, the key was there and nothing survived schema
  // validation; populated, the well-formed proposals riding to the boundary.
  spawn?: SpawnProposal[];
}

interface TicketAssignment {
  harness?: string;
  model?: string;
  drivers?: string;
  verify?: number;
}

export interface PoolConfig {
  defaults?: { harness?: string; model?: string; drivers?: string };
  assign?: Record<string, TicketAssignment>;
  roster?: string;
  agents?: string;
  // The merge resolver: a harness name (the model is inherited from
  // defaults), "none" to opt out, or { harness, model } when the resolver
  // runs on a harness other than the defaults', whose model names would not
  // be recognised there.
  resolver?: string | { harness?: string; model?: string };
  port?: number;
  // Who picks the winner of a verify fan-out: the engine's arithmetic rule
  // (default) or the human, via a selection interrupt carrying the grades.
  selection?: "auto" | "human";
  // Terminal backing for every attempt (ADR-0014, ADR-0015): "herdr" opens a
  // named herdr tab per attempt and records its pane id on the spawned
  // event. Absent means headless, exactly as before.
  terminal?: "herdr";
  // Prose the setup skill writes here and the engine never reads: agents meet
  // both through the pool's AGENT.md. Declared so the Console's Settings pane
  // (issue #121) edits them as Pool settings rather than as unknown keys it
  // has to carry blind.
  reviewer?: string;
  checkpoint?: string;
}

export type InterruptKind =
  | "checkpoint"
  | "config"
  | "crash"
  | "deadlock"
  | "merge-conflict"
  | "merge-approval"
  | "persistence"
  | "review"
  | "selection";

// The final Review interrupt is not a ticket's: it belongs to the run, and it
// carries this id so the Console can hang it on the review utility card (the
// projection's REVIEW_CARD_ID is the same string by contract).
export const REVIEW_TICKET_ID = "REVIEW";

// The persistence interrupt is run-level too: it belongs to no ticket, and it
// is raised when the checkpoint store keeps failing at a boundary. Answering
// it retries persistence and continues the run; the store never closes while
// it waits.
export const PERSISTENCE_TICKET_ID = "PERSISTENCE";

// The Conversation module raises its own merge interrupts in this shape
// too (conversations.ts, through its host).
export interface Interrupt {
  ticketId: string;
  kind: InterruptKind;
  body: string;
  // A selection interrupt's candidate attempt numbers, riding so the answer
  // is validated against the exact fan-out the grades came from, including
  // after a restart (a superseded round's graded attempts would otherwise
  // pass for candidates).
  candidates?: number[];
}

interface PoolState {
  tickets: Record<string, TicketStatus>;
  log: string[];
  outcomes: Record<string, Outcome>;
  config: PoolConfig;
  interrupts: Interrupt[];
  // True once the final Review interrupt is approved. Persisted with the
  // checkpoint so a server restart after approval comes up done instead of
  // re-raising the gate.
  reviewApproved: boolean;
}

interface PoolUpdate {
  tickets?: Record<string, TicketStatus>;
  log?: string[];
  outcomes?: Record<string, Outcome>;
  interrupts?: Interrupt[];
  reviewApproved?: boolean;
  // The sanctioned way to replace the assignment slice of the live config
  // (ADR-0018), applied at the super-step boundary only. Every other channel
  // is additive/merged; config is a wholesale replacement, matching how a
  // reload always replaces defaults/assign/resolver whole rather than
  // merging field-wise with the previous reload.
  config?: PoolConfig;
}

// The phases a run reports. `dead` is terminal and distinct from the closing
// gate's done/quiescent/stalled: it is emitted only by reportDriveDeath, when
// an error the drive truly cannot continue from has killed the loop. If the
// phase was emitted the drive reported its own death; if it wasn't, the drive
// is lying. `stopped` is the other terminal phase and the only one the drive
// never emits: shutdownSession emits it once, as the farewell frame, after
// the children are stopped and the store closed (issue #97). It says "this
// server is going away on purpose", so a Console tab can tell an orderly
// stop from a dead drive (which carries an errors.jsonl entry) and from a
// lost connection (which carries no frame at all).
export type RunPhase =
  | "running"
  | "done"
  | "quiescent"
  | "stalled"
  | "dead"
  | "stopped";

export interface PoolSnapshot {
  seq: number;
  phase: RunPhase;
  state: PoolState;
  // The queued-answer store's pending records at emit time, merged in as the
  // snapshot is built. The store stays outside PoolState (ADR-0004); the
  // snapshot is where the two meet, so every emitted frame carries the
  // answered-and-waiting state with no change to super-step merge semantics.
  queuedAnswers: QueuedAnswer[];
  // One resolved Assignment record per ticket (ADR-0013): the engine's single
  // derivation travels with the state it belongs to, so the server and the UI
  // render it without re-deriving.
  assignments: Record<string, AssignmentView>;
  // Every Conversation the pool knows about (conversations.ts), live or not:
  // the second collection beside tickets (the Conversations ADR).
  conversations: ConversationView[];
  // The Live attempt per ticket (live-attempts.ts): the highest-numbered
  // Attempt still running and, for a Terminal-backed attempt, its pane. Read
  // from the registry at emit, never persisted; the server and the terminal
  // routes take the pane from here and never from the events files.
  liveAttempts: Record<string, LiveAttemptRecord>;
  // The Merge hold (ADR-0014, merge-hold.ts): the done-but-unmerged ticket
  // ids, derived fresh at every emit from the statuses and branch state and
  // never persisted or checkpointed, so the server's card labels are this
  // one derivation and spawn no git of their own.
  mergeHold: string[];
  // The Merge queue (issue #129, merge-hold.ts): the same ids in the order
  // the engine works through them, head first, each named by where its
  // merge stands. Derived beside the hold at every emit, never persisted.
  mergeQueue: MergeQueueEntry[];
}

interface RunOptions {
  poolDir: string;
  harnesses?: Record<string, HarnessCommand>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
  /** The legacy `~/.issue-runner` file, still the fallback for a harness or
   *  model the Machine defaults file does not carry. Tests point it at a
   *  temp file. */
  issueRunnerPath?: string;
  /** The Machine defaults file (issue #121), which wins field by field over
   *  the legacy one above. Tests point it at a temp file so the resolver's
   *  fallback never reads the developer's own. */
  machineDefaultsPath?: string;
  // The checkpoint store seam: tests substitute a store whose write throws
  // on demand to prove a persist failure retries, then interrupts, and never
  // closes the store. Defaults to the real sqlite store.
  store?: CheckpointStore;
  // The herdr daemon socket for terminal-backed attempts. Tests point this
  // at a fake socket; the default is the daemon's path on this machine.
  herdrSocket?: string;
  // The launch half's timings (pane-session.ts), for a test that drives a
  // Botched launch in milliseconds. Production leaves it unset.
  launchCadence?: Partial<LaunchCadence>;
  // How often an enlisted attempt (issue #101) re-reads its pane for Turn
  // state. Production leaves it unset (2 s); a test shortens it so a queued
  // teaching Turn is delivered without a real-time wait.
  enlistPollMs?: number;
  // How often a live Conversation's tick re-reads its pane for Turn state.
  // Production leaves it unset (2 s); tests shorten it so an enlisted
  // Conversation's teaching, opening and Notice Turns land without a
  // real-time wait.
  conversationPollMs?: number;
  // How long an enlist (either arm) waits for a working pane to reach
  // waiting before refusing, so the teaching Turn is never left queued
  // against an agent that is never taught. Production leaves it unset (a
  // Launch's readiness bound); tests shorten it.
  enlistTeachingWaitMs?: number;
  // The herdr workspace the server was launched in (issue #94), the second
  // candidate for the Pool workspace after the id this pool remembers. It
  // reaches the engine as an option and never as an environment read: the
  // CLI boundary is the only thing below which process.env is consulted.
  herdrWorkspace?: string;
  // The Conversations ADR: force-allow an empty issues/ (no Tickets at
  // all) even when the pool has no conversations/ directory yet either —
  // startPool already infers this on its own once a conversations/
  // directory exists (see loadPoolTickets), so this is only for a caller
  // that wants a Ticket-less pool to boot before its first Conversation has
  // ever started and before the directory exists (a test).
  allowEmptyIssues?: boolean;
  // Jev, the judgement model (ADR-0020, jev.ts): built at the CLI boundary
  // from TYPESAFE_API_KEY and passed in, so the engine never sees a key.
  // Absent, the pool gets the unconfigured port and every call site takes
  // its heuristic path, exactly as before Jev existed. Tests inject a fake.
  jev?: Jev;
}

// The live run handle. `startPool` returns it from the very first super-step,
// with the drive proceeding in the background, so an answer is accepted at any
// moment (ADR-0004). `resume`/`approve`/`reject` accept the answer
// synchronously and resolve at the settle after it is processed; `accept` is
// the same acceptance without the wait, for callers (the server) that
// acknowledge and move on. The field getters read the session live, so they
// are only meaningful once `settled` has resolved; on a merge-hold pause
// (ADR-0014) the pool never settles until the merge is answered, and the live
// getters, the snapshots stream above all, are the observation of the held
// state.
export interface PoolRun {
  phase: Exclude<RunPhase, "running">;
  final: PoolState;
  snapshots: PoolSnapshot[];
  interrupts: Interrupt[];
  resume: (ticketId: string, note?: string) => Promise<PoolRun>;
  approve: (ticketId: string, note?: string) => Promise<PoolRun>;
  reject: (ticketId: string, note?: string) => Promise<PoolRun>;
  accept: (ticketId: string, note?: string, approve?: boolean) => void;
  settled: Promise<PoolRun>;
  close: () => void;
  /**
   * Stop the run's headless attempts (ADR-0017): TERM to each child's
   * process group, a grace, then KILL; wait for the drive to join the
   * super-step (bounded, since a terminal-backed attempt is not stopped);
   * then close the store. The engine itself does not exit here; the server's
   * signal handler does, after this resolves.
   */
  shutdown: (graceMs?: number) => Promise<void>;
  /** Start a Conversation (conversations.ts); throws when the pool is not terminal-backed. */
  startConversation: (req: StartConversationRequest) => Promise<ConversationView>;
  /** End a Conversation the operator is done with (conversations.ts). */
  endConversation: (id: string, closing?: string) => Promise<void>;
  /** Enlist a live herdr pane as a Ticket or a Conversation (issue #101). */
  enlist: (req: EnlistRequest) => Promise<EnlistResponse>;
  /**
   * The engine's last viewport read of a pane one of its loops watches (an
   * enlisted attempt's or a Conversation's; pane-reads.ts), or null for a
   * pane no loop watches. The server's peek route serves a recorded read
   * rather than reading the pane a second time (issue #122).
   */
  paneRead: (paneId: string) => PaneRead | null;
}

const reduceTickets = (
  current: PoolState["tickets"],
  update: NonNullable<PoolUpdate["tickets"]>,
): PoolState["tickets"] => ({ ...current, ...update });

const reduceLog = (
  current: PoolState["log"],
  update: NonNullable<PoolUpdate["log"]>,
): PoolState["log"] => [...current, ...update];

const reduceOutcomes = (
  current: PoolState["outcomes"],
  update: NonNullable<PoolUpdate["outcomes"]>,
): PoolState["outcomes"] => ({ ...current, ...update });

const reduceInterrupts = (
  _current: PoolState["interrupts"],
  update: NonNullable<PoolUpdate["interrupts"]>,
): PoolState["interrupts"] => update;

function applyUpdate(state: PoolState, update: PoolUpdate): PoolState {
  return {
    tickets: update.tickets
      ? reduceTickets(state.tickets, update.tickets)
      : state.tickets,
    log: update.log ? reduceLog(state.log, update.log) : state.log,
    outcomes: update.outcomes
      ? reduceOutcomes(state.outcomes, update.outcomes)
      : state.outcomes,
    interrupts: update.interrupts
      ? reduceInterrupts(state.interrupts, update.interrupts)
      : state.interrupts,
    config: update.config ?? state.config,
    reviewApproved: update.reviewApproved ?? state.reviewApproved,
  };
}

// ADR-0014's merge hold, derived on demand and never persisted: the ids of
// tickets whose status is done but whose branch has not landed in the merge
// target, the pool checkout's working branch, main or a feature branch
// alike. While the list is non-empty the entry point below withholds every
// proposal and the pool pauses; it empties the moment a merge lands (an
// approved one, or a manual CLI merge the next derivation simply observes)
// or a rejection reopens the ticket so it no longer counts as done. Derived
// from the in-memory statuses and branch state alone, including at startup
// after rehydrate, so a restart re-derives the hold with no persisted flag.
// A git-less pool has no branches, so nothing ever holds there. Engine-run
// tickets (graders, the head-to-head judge) are excluded explicitly: they
// reach done in the main checkout without a branch, so there is never a
// merge to await for them. A vanished ordinary-ticket branch — a human
// merging by hand outside the engine — still reads as landed, the
// operator-trust reading ADR-0014 owns.
function mergeHold(session: Session): string[] {
  if (!session.git) return [];
  const base = gitMergeHoldProbe(session.cwd);
  // An enlisted ticket's branch is not `pool/<pool>/<id>`: it is the branch
  // the pane was found on (or the pool branch created in place), recorded in
  // `enlistedWork`. The hold must read that branch, or an as-found done ticket
  // would look already-landed and the pool would schedule its blocked tickets
  // before its merge.
  return deriveMergeHold(
    session.state.tickets,
    (id) => engineTicketBuildId(id) !== null,
    {
      ...base,
      // The captured target (ticket 04-spawn-1) outranks the live checkout
      // read: an enlist that moved the pool's own checkout onto its created
      // pool branch would otherwise make that branch the target and read the
      // done ticket as already landed.
      currentBranch: () => session.mergeTarget ?? base.currentBranch(),
      branchFor: (id) => session.enlistedWork.get(id)?.branch ?? base.branchFor(id),
    },
  );
}

// The checkout a ticket's branch lives in: the pool worktree for an ordinary
// ticket, the found directory for an enlisted one (issue #101). The merge
// paths read it so the resolver, an approval and a conflict body all name the
// right place without the enlisted attempt ever owning a pool worktree.
function ticketWorktree(
  session: Session,
  marker: TicketMarker,
  attempt?: number,
): WorktreeInfo {
  const work = session.enlistedWork.get(marker.id);
  if (work) return { path: work.directory, branch: work.branch };
  return {
    path: worktreePathFor(session.cwd, marker.id, attempt),
    branch: branchFor(session.cwd, marker.id, attempt),
  };
}

// What the wait-and-recompute rule (merge-hold.ts) needs of a session: the
// hold derived fresh, the queued-answer drain, the log line that says the
// pool paused and why, and the snapshot emit. Built once per wait site from
// the whole Session; nothing else about the session reaches the rule.
function holdHost(
  session: Session,
  emit: (phase: RunPhase) => void,
): HoldHost {
  return {
    derive: () => mergeHold(session),
    drain: () => {
      const pendingBefore = session.answers.pending().length;
      drainAnswers(session);
      return session.answers.pending().length !== pendingBefore;
    },
    engaged: (hold) => {
      session.state = applyUpdate(session.state, {
        log: [
          `merge hold (ADR-0014): pool paused; awaiting the merge of ` +
            `${hold.join(", ")}`,
        ],
      });
    },
    emit: () => emit("running"),
  };
}

// The ready set's one home (ticket 01, the seam ADR-0014's merge hold stands
// on): the single entry point every scheduling flow computes its spawn set
// through. A flow proposes the tickets it intends to spawn and spawns only
// what the entry point hands back. The main scheduling loop proposes the
// pool's markers and schedules the ready set that returns: ordinary tickets
// whose marker is ready and whose blockers are all done. Grader tickets and
// the head-to-head ticket are engine-run (they are spawned at the grading or
// selection point of their build ticket's fan-out, which the ready rule can
// never express, since the build ticket stays in-progress until selection),
// so a pool-wide proposal never schedules them as ordinary implement
// tickets, however stale and ready their card. The verify flow proposes the
// grader tickets a round is about to run, and the selection run proposes the
// head-to-head ticket it is about to spawn; those proposals are all engine
// ids, already cleared by their own flow's context. The merge hold
// (ADR-0014) is the one rule that governs every proposal alike, engine-run
// or pool-wide, and this function is the only place it lives: while any done
// ticket's branch is unmerged, nothing is handed back. The hold is derived
// once and handed back alongside the ready set, so the pool-wide caller
// reading this entry point directly cannot mistake a hold that lifted
// between two derivations for a stop; every flow computes through the one
// wait-and-recompute rule (merge-hold.ts), the boundary with the whole
// boundary as its recompute and the engine-run flows through
// engineSpawnSet below.
function readySet(
  session: Session,
  candidates: TicketMarker[],
): { ready: TicketMarker[]; hold: string[] } {
  // The hold withholds every proposal alike, before any clearing: an
  // engine-run flow's proposal is all judges, cleared where proposed, but
  // the pool-wide pause outranks the flow's context.
  const hold = mergeHold(session);
  if (hold.length > 0) return { ready: [], hold };
  // An engine-run flow's proposal is all judges, cleared where proposed.
  if (candidates.every((marker) => engineTicketBuildId(marker.id))) {
    return { ready: candidates, hold };
  }
  const tickets = session.state.tickets;
  return {
    ready: candidates.filter(
      (marker) =>
        !engineTicketBuildId(marker.id) &&
        tickets[marker.id] === "ready" &&
        marker.blockedBy.every((id) => tickets[id] === "done"),
    ),
    hold,
  };
}

// The engine-run flows' spawn set, the three sites that share it being
// grading's initial round, its re-spawn rounds and the head-to-head judge.
// The recompute is readySet over the flow's proposal; an all-engine proposal
// returns empty for no reason but the hold, so the rule's re-wait on a held
// recompute is what keeps a judge spawn from ever destructuring an empty
// set. The pool-wide caller (the super-step boundary) uses the same rule
// with a different recompute: an empty set there can mean nothing ready,
// which is a stop, not a pause, so it reads the ready set and the hold
// apart.
async function engineSpawnSet(
  session: Session,
  emit: (phase: RunPhase) => void,
  candidates: TicketMarker[],
): Promise<TicketMarker[]> {
  return throughMergeHold(holdHost(session, emit), () => {
    const { ready, hold } = readySet(session, candidates);
    return { value: ready, hold };
  });
}

interface SettleWaiter {
  resolve: (run: PoolRun) => void;
  reject: (error: unknown) => void;
}

interface Session {
  poolDir: string;
  issuesDir: string;
  runsDir: string;
  cwd: string;
  git: boolean;
  harnesses: Record<string, HarnessCommand>;
  assignments: Map<string, Assignment>;
  markers: TicketMarker[];
  state: PoolState;
  snapshots: PoolSnapshot[];
  store: CheckpointStore;
  storeOpen: boolean;
  superStep: number;
  answers: QueuedAnswerStore;
  // True while a drive loop is in flight (between super-step boundaries
  // included). Acceptance consults it: in flight the answer waits for the
  // boundary drain; idle it is processed immediately and a fresh drive kicks.
  driving: boolean;
  settledPhase: Exclude<RunPhase, "running"> | null;
  settleWaiters: SettleWaiter[];
  answerWaiters: Map<number, { resolve: () => void; reject: (e: unknown) => void }[]>;
  // Null only until startPool assigns it just after rehydrate, before the
  // drive starts; every read goes through handleOf, which guards that.
  handle: PoolRun | null;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
  /** Where the Machine defaults live (issue #121): the JSON file of record
   *  plus the two legacy runner files behind it. The resolver's harness and
   *  model fallback reads through these. */
  machineDefaults: MachineDefaultsPaths;
  // Where terminal-backed attempts reach the herdr daemon (ADR-0014).
  herdrSocket: string;
  // The launch half's timings, when a test overrides them (RunOptions).
  launchCadence?: Partial<LaunchCadence>;
  // The Pool workspace (issue #94): where every tab this pool opens lands.
  poolWorkspace: PoolWorkspaceState;
  // Spawn proposals awaiting the boundary (ADR-0010), pushed where an outcome
  // becomes the ticket's and drained by adoptSpawnProposals.
  pendingSpawns: PendingSpawn[];
  // Spawn tickets adopted so far this run, bounding the per-run cap. Seeded
  // from the markers at start, so a resumed run continues the same count.
  spawnedThisRun: number;
  // Terminal-backed boot reconciliation (ADR-0014): set at startPool to the
  // reconciliation running against herdr, awaited by the drive loop before
  // its first scheduling so a ticket about to be re-adopted from a live pane
  // is never re-spawned as a duplicate.
  terminalReconcile: Promise<void>;
  // Attempts re-adopted at boot, keyed by ticket id: the orphaned spawned
  // event's pane proved live, so the ticket stayed in-progress and a
  // background finalize waits on the pane's end instead.
  adopted: Map<string, AdoptedAttempt>;
  // The merge serialization chain: every mergeTicket call, from the drive
  // loop or from an adopted attempt's finalize, chains onto this so two
  // merges never run their git work concurrently on the main checkout.
  mergeChain: Promise<void>;
  // The Merge queue's in-memory line (merge-hold.ts): the order merges were
  // taken onto the chain above, which of them the engine is still working,
  // and the one it is resolving now. Never persisted: a restart finds held
  // tickets with no place in the line, which is what they then are.
  mergeLine: MergeLine;
  // ADR-0018's config reload: the raw console.json text last considered at a
  // super-step boundary, whether it was accepted, rejected, or found
  // unchanged. Comparing against this (not against the last *accepted* text)
  // is what makes an unchanged file a true no-op and keeps the same bad
  // content from logging twice. Null means no file was there. Seeded at
  // startPool to the boot read, so the first boundary is a no-op unless the
  // file changed since boot.
  lastConfigText: string | null;
  // Jev (ADR-0020) and the pool-log subscription on it, released at close.
  jev: Jev;
  jevUnsubscribe: () => void;
  // The headless children of this engine process (ADR-0017), tracked from
  // spawn to exit so a shutdown can stop every one of them.
  children: ChildTracker;
  // Headless orphans rehydrate found still alive from a previous engine
  // process, stopped by reapHeadlessOrphans before the first scheduling.
  orphans: HeadlessOrphan[];
  // The Conversation module (the Conversations ADR, docs/adr/0018-
  // conversations-beside-tickets.md; conversations.ts): owns every live
  // Conversation, reached through the operations it exposes and reaching
  // back into this Session only through the host conversationHostOf builds.
  conversations: ConversationModule;
  // The Live attempts registry (live-attempts.ts): every Attempt between its
  // launch and its ending, kept by the Attempt-run module, boot adoption and
  // the Conversation module; read here only when a snapshot is emitted.
  liveAttempts: LiveAttempts;
  // The Merge hold watch (merge-hold.ts): re-derives the hold while the last
  // emitted set is non-empty, so a merge done by hand reaches the snapshot.
  holdWatch: MergeHoldWatch;
  // Enlisted attempts (issue #101, engine/enlisted.ts): the runtime behind
  // every pane the operator enlisted, owning its Turn state and the Turns the
  // engine types into it. Built once at startPool, reached through the
  // operations it exposes.
  enlisted: EnlistedAttempts;
  // The pane read register (issue #122, pane-reads.ts): the last viewport
  // read of every pane the enlisted and Conversation ticks watch, written by
  // those ticks and read by the handle's paneRead for the server's peek
  // route, so a pane an operator sits in is read once per tick.
  paneReads: PaneReadRegister;
  // The found work of every enlisted ticket (issue #101, ticket 04): the
  // branch and directory the pane was enlisted from. Kept engine-side because
  // the enlisted ticket has no pool worktree and no `pool/<pool>/<id>` branch
  // to resolve, so the merge hold and the merge paths must read these two
  // facts instead. Seeded at enlist and, after a restart, from the enlist
  // `spawned` event.
  enlistedWork: Map<string, { branch: string; directory: string }>;
  // The branch this pool merges into, captured when an enlist moves the pool's
  // own checkout (issue #101, ticket 04-spawn-1): the branch rule checks the
  // created pool branch out in the found directory, and when that directory is
  // the pool's own checkout the live read (`currentBranch(session.cwd)`) would
  // name the pool branch as the target, making the done merge a no-op. Null
  // until an enlist moves the checkout, which keeps every other pool reading
  // its target live exactly as before. Once captured, the pool checkout is
  // the operator's for the rest of the pool's life: merges run in the
  // engine's own merge checkout (`withMergeCheckout`) and every ticket gets a
  // worktree (`planTicket`), so nothing the engine does moves or writes the
  // checkout an enlisted agent works in.
  mergeTarget: string | null;
  // How often an enlisted attempt's tick re-reads its pane (RunOptions).
  enlistPollMs?: number;
}

// One terminal-backed attempt re-adopted at boot (ADR-0014). `abandoned` is
// set when the human answered the adoption interrupt: the pane is being
// closed (an enlisted one let go, ADR-0021) and the finalize must record
// nothing further.
interface AdoptedAttempt {
  paneId: string;
  attempt: number;
  abandoned: boolean;
}

// The Conversation module's view of this Session (conversations.ts's
// ConversationHost): every engine operation a Conversation may call, and the
// only way the module reaches the Session. The four Session records a
// Conversation touches (the merge chain, the spawn queue, the assignment
// table, the interrupt list) each sit behind one operation here. Bound late
// (see startPool): the session does not exist when the module is built.
function conversationHostOf(sessionOf: () => Session): ConversationHost {
  return {
    publish: () => {
      const session = sessionOf();
      emitSnapshot(session, session.settledPhase ?? "running");
    },
    raiseInterrupt: (interrupt) => raiseInterrupt(sessionOf(), interrupt),
    clearInterrupt: (interrupt, log) => clearInterrupt(sessionOf(), interrupt, log),
    resolveConflict: (marker, result, attempt) =>
      handleMergeConflict(sessionOf(), marker, result, attempt),
    closeAttemptTabs: (id) => closeAttemptTabs(sessionOf(), id),
    chainMerge: (work) => {
      const session = sessionOf();
      const next = session.mergeChain.then(() => work());
      // The chain itself never rejects (a failed merge must not wedge the
      // next caller's), while the caller sees `work`'s own outcome.
      session.mergeChain = next.catch(() => {});
      return next;
    },
    mergeTargetBranch: () => mergeTargetBranch(sessionOf()),
    mergeIntoTarget: (branch) => {
      const session = sessionOf();
      try {
        return withMergeCheckout(session, (cwd) => mergeBranch(cwd, branch));
      } catch (err) {
        return {
          ok: false,
          reason: "blocked",
          conflicted: [],
          blocked: [],
          cleared: [],
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
    adoptSpawns: (parentId, raw, onRejected) => {
      const session = sessionOf();
      const { proposals, rejections } = validateSpawnProposals(raw);
      onRejected(rejections);
      if (proposals.length > 0) {
        session.pendingSpawns.push({ parentId, proposals, origin: "conversation" });
        // Idle: adopt (write the files / start the child Conversations) and
        // kick a drive at once, since nothing else will reach the boundary
        // that does this. In flight: leave it queued — the driving
        // super-step's own adoptSpawnProposals call at its next boundary
        // picks it up, and adopting here too would mutate session.markers
        // and session.state concurrently with that in-flight work.
        if (!session.driving) {
          adoptSpawnProposals(session);
          kickProcessing(session);
        }
      }
    },
    recordAssignment: (id, assignment) => {
      const session = sessionOf();
      if (!session.assignments.has(id)) session.assignments.set(id, assignment);
    },
    markers: () => sessionOf().markers,
    config: () => sessionOf().state.config,
  };
}

// The Enlisted attempts module's view of this Session (engine/enlisted.ts's
// EnlistedHost), bound late for the same reason the Conversation host is: the
// session does not exist when the module is built.
function enlistedHostOf(sessionOf: () => Session): EnlistedHost {
  return {
    publish: () => {
      const session = sessionOf();
      emitSnapshot(session, session.settledPhase ?? "running");
    },
    ended: (id, ending) => endEnlistedAttempt(sessionOf(), id, ending),
    trailingExit: (id) => recordEnlistedTrailingExit(sessionOf(), id),
  };
}

export function startPool(options: RunOptions): PoolRun {
  const poolDir = canonicalDir(options.poolDir);
  const issuesDir = join(poolDir, "issues");
  const runsDir = join(poolDir, "runs");
  const markers = loadPoolTickets(poolDir, options.allowEmptyIssues);
  mkdirSync(runsDir, { recursive: true });

  const config = readConfig(poolDir);
  // The reload's baseline (ADR-0018): the exact bytes readConfig just parsed,
  // so the first boundary reload is a no-op unless the file changes after
  // boot, matching every later boundary's unchanged-file no-op.
  const lastConfigText = readOptional(join(poolDir, "console.json"));
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const cwd = repoRootOf(poolDir);
  const git = gitAvailable(cwd);
  // A merge checkout a dead engine left behind holds the merge target
  // (issue #101): dropped at boot, so a crash mid-merge never keeps the
  // operator off the target until the pool's next merge.
  if (git) removeStaleMergeCheckout(cwd);
  const children = new ChildTracker();
  const herdrSocket = options.herdrSocket ?? HERDR_SOCKET_DEFAULT;

  // Assignment resolution for every marker on disk: ordinary tickets resolve
  // from the config, engine-written ones (grader, head-to-head, spawned)
  // inherit from the ticket they belong to, and spawn chains resolve however
  // deep they nest. Conversation ids are seeded first (the Conversations
  // ADR): a Ticket spawned mid-Conversation in a prior run has its
  // spawned-by name a Conversation, not another ticket, and
  // resolveUnseenAssignments below needs that id already resolvable the same
  // way it needs a grader's build ticket resolved before the grader.
  // A Conversation seeds with whatever it has: an enlisted one names no model
  // (as found), and its spawns take that one field from the pool defaults.
  const assignments = new Map<string, Assignment>();
  for (const rec of loadConversations(join(poolDir, "conversations"))) {
    if (!rec.harness) continue;
    assignments.set(rec.id, { harness: rec.harness, model: rec.model, drivers: rec.drivers });
  }
  resolveUnseenAssignments(markers, assignments, config, harnesses);

  // The Conversation module's host closes over the session, which does not
  // exist until the literal below is built; the host is only ever called
  // once startPool has returned, so the reference is bound late on purpose.
  let session: Session;
  // A pane becoming reachable, or ceasing to be, is worth a snapshot of its
  // own: the drive's next emit may be a whole super-step away.
  const liveAttempts = createLiveAttempts(() =>
    emitSnapshot(session, session.settledPhase ?? "running"),
  );
  // One register for both modules: the peek route resolves a pane by id and
  // does not care which loop watches it.
  const paneReads = createPaneReadRegister();
  const enlisted = createEnlistedAttempts(
    {
      herdrSocket,
      paneReads,
      ...(options.enlistPollMs !== undefined ? { pollMs: options.enlistPollMs } : {}),
      ...(options.enlistTeachingWaitMs !== undefined
        ? { teachingWaitMs: options.enlistTeachingWaitMs }
        : {}),
    },
    enlistedHostOf(() => session),
  );
  const conversations = createConversations(
    {
      ...attemptEnvFrom(
        config,
        harnesses,
        runsDir,
        herdrSocket,
        // Bound late for the same reason the host below is: the session
        // whose Pool workspace this reads does not exist yet, and a
        // Conversation started after boot must read the resolved id.
        poolWorkspaceFor(() => session),
        children,
        liveAttempts,
        options.launchCadence,
      ),
      poolDir,
      cwd,
      git,
      paneReads,
      ...(options.conversationPollMs !== undefined
        ? { pollMs: options.conversationPollMs }
        : {}),
      ...(options.enlistTeachingWaitMs !== undefined
        ? { teachingWaitMs: options.enlistTeachingWaitMs }
        : {}),
    },
    conversationHostOf(() => session),
  );
  session = {
    poolDir,
    issuesDir,
    runsDir,
    cwd,
    git,
    harnesses,
    assignments,
    markers,
    state: {
      tickets: Object.fromEntries(markers.map((m) => [m.id, m.status])),
      log: [],
      outcomes: {},
      config,
      interrupts: [],
      reviewApproved: false,
    },
    snapshots: [],
    store: options.store ?? new SqliteCheckpointStore(poolDir),
    storeOpen: true,
    superStep: 0,
    answers: new QueuedAnswerStore(runsDir),
    driving: false,
    settledPhase: null,
    settleWaiters: [],
    answerWaiters: new Map(),
    handle: null,
    onSnapshot: options.onSnapshot,
    machineDefaults: {
      ...defaultMachineDefaultsPaths(),
      ...(options.machineDefaultsPath !== undefined
        ? { file: options.machineDefaultsPath }
        : {}),
      ...(options.issueRunnerPath !== undefined
        ? { issueRunner: options.issueRunnerPath }
        : {}),
    },
    herdrSocket,
    ...(options.launchCadence ? { launchCadence: options.launchCadence } : {}),
    poolWorkspace: {
      // Replaced below by the boot resolution itself, so anything reading
      // through poolWorkspaceFor before then waits for the real answer.
      ready: Promise.resolve(),
      id: null,
      launch: options.herdrWorkspace ?? null,
      reresolving: null,
    },
    pendingSpawns: [],
    spawnedThisRun: markers.filter((m) => m.spawnedBy !== undefined).length,
    terminalReconcile: Promise.resolve(),
    adopted: new Map(),
    mergeChain: Promise.resolve(),
    mergeLine: createMergeLine(),
    lastConfigText,
    jev: options.jev ?? createJev(),
    jevUnsubscribe: () => {},
    children,
    orphans: [],
    liveAttempts,
    enlisted,
    paneReads,
    enlistedWork: new Map(),
    mergeTarget: null,
    ...(options.enlistPollMs !== undefined ? { enlistPollMs: options.enlistPollMs } : {}),
    holdWatch: createMergeHoldWatch({
      derive: () => mergeHold(session),
      onChange: () => emitSnapshot(session, session.settledPhase ?? "running"),
    }),
    conversations,
  };

  seedEnlistedWork(session);
  rehydrate(session);
  // Jev (ADR-0020): one boot line saying which path is live, then one line
  // per fallback cause as the port's own dedupe announces them, never one
  // per call. The subscription is released with the store at close.
  session.jevUnsubscribe = session.jev.subscribe((notice) => {
    session.state = applyUpdate(session.state, { log: [jevNoticeLine(notice)] });
  });
  session.state = applyUpdate(session.state, {
    log: [
      session.jev.configured
        ? `Jev configured (${JEV_MODEL})`
        : "Jev not configured, heuristics only",
    ],
  });
  // Conversations do not resume (the Conversations ADR): any recorded live
  // at boot has an unknown pane fate and no runtime entry will ever track
  // it again, so it crashes now rather than sitting unreachable.
  session.conversations.crashStaleAtBoot();
  // The Pool workspace comes first (issue #94): reconciliation scopes its
  // pane listing to it, and every spawn opens its tab in it, so it is
  // resolved before either can run. `ready` is the resolution itself, so a
  // Conversation started off the handle the moment startPool returns waits
  // on it rather than racing it.
  session.poolWorkspace.ready = resolvePoolWorkspaceForSession(session);
  // Boot reconciliation, awaited by the drive before its first scheduling:
  // terminal-backed orphans are re-adopted or crashed (ADR-0014), headless
  // orphans are stopped (ADR-0017), so no ticket is ever spawned into a
  // worktree its previous attempt is still writing.
  session.terminalReconcile = session.poolWorkspace.ready
    .then(() =>
      Promise.all([
        reconcileTerminalAttempts(session),
        reapHeadlessOrphans(session),
        // An enlisted Conversation's pane is the operator's and still in
        // herdr's listing (issue #101): re-adopt its runtime, or crash it
        // when the pane has gone. Runs beside the attempt reconcile; both
        // are best-effort against the daemon.
        session.conversations.adoptEnlistedAtBoot(),
      ]),
    )
    .then(() => undefined);
  const handle = makeHandle(session);
  session.handle = handle;
  startDrive(session);
  return handle;
}

// The handle exists from just after rehydrate onward; settle paths only run
// once the drive is going, so the guard never fires in practice.
function handleOf(session: Session): PoolRun {
  if (!session.handle) throw new Error("pool handle not initialised");
  return session.handle;
}

// runPool keeps the original await-to-settle contract: it resolves with the
// handle once the drive first goes quiescent, done, or stalled. Callers that
// need the handle during the first drive (the server) use startPool.
export async function runPool(options: RunOptions): Promise<PoolRun> {
  return startPool(options).settled;
}

function makeHandle(session: Session): PoolRun {
  const answer = (
    ticketId: string,
    note: string | undefined,
    approve: boolean | undefined,
  ): Promise<PoolRun> => {
    let record: QueuedAnswer;
    try {
      record = acceptAnswer(session, ticketId, note, approve);
    } catch (error) {
      return Promise.reject(error);
    }
    // A retry of an answer that was already processed: acceptance recorded
    // nothing new, so there is no drain to wait for.
    if (record.processedAt !== null) return nextSettle(session);
    // The waiter registers before the kick: an idle kick drains
    // synchronously, and a drain that settles a waiter which does not exist
    // yet hangs the promise forever. Several answers can share one queued
    // record (an idempotent retry returns it), so each seq holds a list.
    const processed = new Promise<void>((resolve, reject) => {
      const waiters = session.answerWaiters.get(record.seq) ?? [];
      waiters.push({ resolve, reject });
      session.answerWaiters.set(record.seq, waiters);
    });
    kickProcessing(session);
    return processed.then(() => nextSettle(session));
  };
  const handle: PoolRun = {
    get phase() {
      return session.settledPhase!;
    },
    get final() {
      return session.state;
    },
    get snapshots() {
      return session.snapshots;
    },
    get interrupts() {
      return session.state.interrupts;
    },
    resume: (ticketId, note) => answer(ticketId, note, undefined),
    approve: (ticketId, note) => answer(ticketId, note, true),
    reject: (ticketId, note) => answer(ticketId, note, false),
    accept: (ticketId, note, approve) => {
      acceptAnswer(session, ticketId, note, approve);
      kickProcessing(session);
    },
    get settled() {
      return nextSettle(session);
    },
    close: () => closeStore(session),
    shutdown: (graceMs) => shutdownSession(session, graceMs),
    startConversation: (req) => session.conversations.start(req),
    endConversation: (id, closing) => session.conversations.end(id, closing),
    // The `becomes` the operator fixed at enlist time chooses the arm.
    enlist: (req) =>
      req.becomes === "conversation"
        ? enlistConversation(session, req)
        : enlistTicket(session, req),
    paneRead: (paneId) => session.paneReads.latest(paneId),
  };
  return handle;
}

// How long shutdown waits for the drive to join its super-step after the
// children are stopped. Bounded because a terminal-backed attempt is left
// running (its pane outlives the engine and boot re-adopts it, ADR-0014), so
// a super-step holding one never joins, and a merge hold polls forever.
const SHUTDOWN_SETTLE_WAIT_MS = 3_000;

// Shutdown (ADR-0017): stop every headless child, let the drive join the
// super-step it was in (each stopped attempt's exit handling records the
// stop on its ticket log, and the loop raises no crash interrupts and
// schedules nothing once stopping), then close the store. A ticket whose
// attempt was stopped is left in-progress with no interrupt, which is
// exactly what the next boot resets to ready. The last thing out is the
// farewell: one `stopped` snapshot carrying the final state (issue #97), so
// every Console tab on the stream learns the server left on purpose rather
// than watching its connection drop. Emitting is best-effort: a farewell
// that throws must never hold up the lock release behind it.
async function shutdownSession(
  session: Session,
  graceMs?: number,
): Promise<void> {
  session.children.stopping = true;
  await session.children.stopAll(graceMs);
  if (session.driving) {
    await Promise.race([
      nextSettle(session).then(
        () => undefined,
        () => undefined,
      ),
      Bun.sleep(SHUTDOWN_SETTLE_WAIT_MS),
    ]);
  }
  session.conversations.dispose();
  session.enlisted.dispose();
  closeStore(session);
  try {
    emitSnapshot(session, "stopped");
  } catch {
    // The farewell is a courtesy to the stream; the stop is already done.
  }
}

function nextSettle(session: Session): Promise<PoolRun> {
  if (!session.driving) return Promise.resolve(handleOf(session));
  return new Promise<PoolRun>((resolve, reject) => {
    session.settleWaiters.push({ resolve, reject });
  });
}

// The drive loop's endgame, reached exactly once per loop: waiters for the
// next settle are flushed with the handle (or the loop's fatal error, which
// also fails every answer still waiting on processing).
function settleDrive(
  session: Session,
  phase: Exclude<RunPhase, "running"> | null,
  error: unknown,
): void {
  session.driving = false;
  if (phase !== null) session.settledPhase = phase;
  const waiters = session.settleWaiters.splice(0);
  for (const waiter of waiters) {
    if (error) waiter.reject(error);
    else waiter.resolve(handleOf(session));
  }
  if (error) {
    for (const [, waiters] of session.answerWaiters) {
      for (const waiter of waiters) waiter.reject(error);
    }
    session.answerWaiters.clear();
  }
}

function startDrive(session: Session): void {
  session.driving = true;
  // The entry point is the single handler of the loop's rejection: every
  // drive death, from anywhere in the loop or the closing gate, reports
  // through reportDriveDeath. Nothing is swallowed here.
  driveLoop(session).catch((error) => reportDriveDeath(session, error));
}

// The durable record of a drive death, and the pool log line the Console's
// log drawer shows. One shared mechanism, one call site: the entry point's
// catch above is the only handler of the loop's rejection, so no failure
// path can forget to log. A boundary persist failure never arrives here;
// the retry seam (persistWithRetry) handles those first and interrupts
// instead. A persist failure from the answer drain (drainAnswers) can, and
// reports itself like any other error that kills the drive.
const ERRORS_LOG_NAME = "errors.jsonl";

function reportDriveDeath(session: Session, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // The durable record is guarded on its own: the disk may be exactly what
  // is failing, and a report that cannot land must never prevent the dead
  // phase or the settle below.
  try {
    mkdirSync(session.runsDir, { recursive: true });
    appendFileSync(
      join(session.runsDir, ERRORS_LOG_NAME),
      `${JSON.stringify({
        at: new Date().toISOString(),
        error: message,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })}\n`,
    );
  } catch {
    // The error log is best-effort; the pool log and the dead phase below
    // are the report the Console actually shows.
  }
  try {
    session.state = applyUpdate(session.state, {
      log: [`pool dead: ${message}`],
    });
    // Death is the one non-persist error the store closes on: the drive
    // truly cannot continue from it. Restart-from-disk stays the escape
    // hatch, exactly as for a killed process.
    closeStore(session);
    emitSnapshot(session, "dead");
  } catch {
    // Reporting is best-effort: a report that throws must never prevent the
    // settle below, or a dead drive would hang every waiter forever.
  }
  settleDrive(session, "dead", error);
}

// One emit point for every snapshot the run produces: the drive loop's
// lifecycle emits, the acceptance emit (a new queued answer while a
// super-step is in flight), and the terminal dead emit from
// reportDriveDeath. Each carries the store's pending answers at emit
// time, and every markProcessed is followed by an emit, so the merged queue
// in the snapshot stream never goes stale.
export function emitSnapshot(session: Session, phase: RunPhase): void {
  // The hold is derived fresh here and nowhere persisted (ADR-0014); the
  // watch notes what went out so a merge done by hand can move it.
  const hold = mergeHold(session);
  const liveAttempts = session.liveAttempts.records((id) => session.conversations.isLive(id));
  const snapshot: PoolSnapshot = {
    seq: session.snapshots.length,
    phase,
    state: session.state,
    queuedAnswers: session.answers.pending(),
    assignments: Object.fromEntries(
      [...session.assignments].map(([id, a]) => [id, assignmentViewOf(a)]),
    ),
    conversations: session.conversations.views(),
    // A Conversation's pane rides its own view above.
    liveAttempts,
    mergeHold: hold,
    mergeQueue: session.mergeLine.queue(
      hold,
      new Set(
        Object.entries(liveAttempts)
          .filter(([, live]) => live.role === "resolver")
          .map(([id]) => id),
      ),
      session.state.interrupts,
    ),
  };
  session.snapshots.push(snapshot);
  session.holdWatch.emitted(hold);
  session.onSnapshot?.(snapshot);
}

// One super-step per turn of the loop: the boundary decides whether there is
// a next super-step, the plan numbers and records it, the run fans it out
// and joins it, and the close settles the drive once the boundary finds
// nothing to run or the run says stop. Each phase takes the whole Session:
// the plan, the run and the close read and write most of it, and the hold
// wait, the one piece with a narrow need, is behind its own host.
async function driveLoop(session: Session): Promise<void> {
  const emit = (phase: RunPhase) => emitSnapshot(session, phase);

  emit("running");
  // Boot reconciliation lands before the first scheduling: a ticket whose
  // orphaned terminal attempt proved live is in-progress again by now and
  // can never enter the ready set as a duplicate spawn.
  await session.terminalReconcile;
  for (;;) {
    const next = await superStepBoundary(session, emit);
    if (next.kind === "close") break;
    const step = planSuperStep(session, emit, next.ready);
    if ((await runSuperStep(session, emit, step)) === "stop") break;
  }
  await closeDrive(session, emit);
}

type BoundaryOutcome =
  | { kind: "run"; ready: TicketMarker[] }
  | { kind: "close" };

// The super-step boundary: everything a super-step in flight must not do,
// then the ready set. Its recompute is the whole boundary, run through the
// one wait-and-recompute rule (merge-hold.ts): while ADR-0014's merge hold
// stands the boundary waits, and once the hold lifts (an approved merge, an
// observed manual merge, a rejection that reopens the ticket) the whole
// boundary runs again, so the reload, the drain and the adoption all see
// whatever lifted it. An empty ready set with nothing held is the close,
// not a pause.
async function superStepBoundary(
  session: Session,
  emit: (phase: RunPhase) => void,
): Promise<BoundaryOutcome> {
  const ready = await throughMergeHold(holdHost(session, emit), () => {
    reconcileDeadlocks(session);
    // Config reload (ADR-0018): the assignment slice of console.json
    // re-reads here, before the answer drain and spawn adoption below, so
    // both see the reloaded config for whatever they schedule this
    // super-step.
    reloadConfigAtBoundary(session);
    // Answers accepted while the previous super-step was in flight are
    // applied now, in submission order, after that super-step's join and
    // persistence and before this one's scheduling. Processing never
    // spawns; the scheduling does. The drain persists the answered state
    // itself, so a resume is on disk before this super-step schedules, not
    // only at its closing persist.
    drainAnswers(session);
    // Spawn adoption (ADR-0010) rides the same boundary: proposals
    // established by the previous super-step's outcomes, or by the answer
    // drain just now, are written into the pool here, before the ready
    // check below, so adopted tickets schedule like any other and a pool
    // whose last outcome spawns never reports itself done early.
    adoptSpawnProposals(session);
    // The super-step's spawn set routes through the one entry point
    // (ticket 01): the loop schedules the ready set it hands back, and
    // ADR-0014's merge hold (ticket 02) is the one rule that can withhold
    // it.
    const { ready, hold } = readySet(session, session.markers);
    return { value: ready, hold };
  });
  return ready.length === 0 ? { kind: "close" } : { kind: "run", ready };
}

interface SuperStepPlan {
  ready: TicketMarker[];
  planned: { marker: TicketMarker; plan: TicketPlan }[];
  // The state every attempt of this super-step spawns against: fixed at
  // the plan, so a sibling's exit mid-step never changes what a later
  // spawn reads.
  snapshot: PoolState;
}

// The plan: the super-step gets its number, every attempt its number, the
// markers their in-progress status on disk, and every attempt its scheduled
// event, all before any spawn.
function planSuperStep(
  session: Session,
  emit: (phase: RunPhase) => void,
  ready: TicketMarker[],
): SuperStepPlan {
  // A ticket whose branch is checked out in a directory the engine does not
  // own cannot be given a worktree (git allows a branch in one worktree at a
  // time): the enlist branch rule's created pool branch lives in the
  // operator's checkout, and a re-run after that pane went or was let go
  // would reach `prepareWorktree`'s throw and kill the drive. It waits as a
  // checkpoint instead, until the checkout is off the branch. A step with
  // nothing left to plan is no super-step: no number, no log line.
  const held = ready.filter((marker) => {
    const missing = missingAssignmentField(session, marker);
    if (missing !== null) {
      checkpointUnassigned(session, marker, missing);
      return true;
    }
    const at = heldBranchDirectory(session, marker);
    if (at === null) return false;
    checkpointHeldBranch(session, marker, at);
    return true;
  });
  ready = ready.filter((marker) => !held.includes(marker));
  if (ready.length === 0) {
    emit("running");
    return { ready, planned: [], snapshot: session.state };
  }
  session.superStep += 1;
  // Every attempt this super-step spawns is numbered before any spawn,
  // so a verify fan-out cannot race the events counter: attempts run
  // base..base+N-1 off one nextAttempt read per ticket.
  const planned = ready.flatMap((marker) => {
    // Verify is ignored for an enlisted ticket (issue #101): its one attempt
    // is already in flight, and a re-run as an ordinary attempt is always a
    // solo one. `marker.enlistedFrom` is the durable marker of an enlist, so
    // this holds across a restart with no extra state.
    const verify =
      marker.enlistedFrom !== undefined
        ? undefined
        : session.assignments.get(marker.id)!.verify;
    if (verify != null) {
      // A verify ticket's attempts write attempt-numbered logs, but a
      // pre-verify solo attempt's well-known log must still rotate
      // before the fan-out spawns, so the history survives.
      rotateAttemptLog(
        session.runsDir,
        marker.id,
        join(session.runsDir, attemptLogName(marker.id, null, false)),
        "exited",
      );
    }
    const base = nextAttempt(session.runsDir, marker.id);
    return Array.from({ length: verify ?? 1 }, (_, i) => ({
      marker,
      plan: planTicket(
        session,
        marker,
        ready.length,
        base + i,
        verify != null,
      ),
    }));
  });
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      ready.map((marker) => [marker.id, "in-progress" as const]),
    ),
    log: [
      `super-step ${session.superStep}: ${ready.map((m) => m.id).join(", ")}`,
    ],
  });
  writeMarkers(session);
  for (const { marker, plan } of planned) {
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: plan.attempt,
      kind: "scheduled",
      payload: {},
    });
  }
  emit("running");
  const snapshot = session.state;
  return { ready, planned, snapshot };
}

// Where a ticket's solo branch is checked out, when that is somewhere other
// than the ticket's own pool worktree: the operator's checkout after a
// created-branch enlist (issue #101). Null when the branch is free, absent,
// or in the engine's own worktree; a verify fan-out runs on attempt
// branches and is never held by the solo one.
function heldBranchDirectory(session: Session, marker: TicketMarker): string | null {
  if (!session.git) return null;
  const verify =
    marker.enlistedFrom !== undefined
      ? undefined
      : session.assignments.get(marker.id)?.verify;
  if (verify != null) return null;
  if (!branchExists(session.cwd, marker.id)) return null;
  const at = branchCheckedOutAt(session.cwd, branchFor(session.cwd, marker.id));
  if (at === null || at === worktreePathFor(session.cwd, marker.id)) return null;
  return at;
}

function checkpointHeldBranch(session: Session, marker: TicketMarker, at: string): void {
  const branch = branchFor(session.cwd, marker.id);
  const attempt = lastAttempt(session.runsDir, marker.id);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "branch-held",
    payload: { branch, directory: at },
  });
  writeMarkerStatus(marker.file, "checkpoint");
  marker.status = "checkpoint";
  landCheckpointBrief(
    marker.file,
    `This ticket's branch ${branch} is checked out in ${at} (the checkout an ` +
      "enlist moved onto it, or a worktree made by hand), so the engine " +
      "cannot open a worktree to run the ticket while it is there. The work " +
      "on the branch is kept. Check another branch out in that directory " +
      "and answer resume: the run then continues on the parked branch as an " +
      "ordinary engine-launched attempt.",
  );
  raiseCheckpoint(session, marker, attempt);
  session.state = applyUpdate(session.state, {
    tickets: { [marker.id]: "checkpoint" },
    log: [
      `ticket ${marker.id}: branch ${branch} is checked out in ${at}; ` +
        "checkpoint raised instead of a re-run",
    ],
  });
}

// The Assignment field a ticket about to schedule has no value for, or null
// when it would launch. An unassigned ticket (no defaults, no assign entry,
// a parent with nothing to hand down) renders on the canvas as unassigned
// (ADR-0013) and is caught here, before its marker flips, rather than at
// launch where the throw would kill the drive (issue #118).
function missingAssignmentField(
  session: Session,
  marker: TicketMarker,
): "harness" | "model" | null {
  const assignment = session.assignments.get(marker.id);
  if (!assignment?.harness) return "harness";
  if (!assignment.model) return "model";
  return null;
}

// A pool-config gap is the operator's to fill, so it pauses the one ticket
// as a config interrupt instead of ending the run: the operator sets the
// field in console.json and answers resume; the marker returns to ready,
// the next super-step boundary's config reload (ADR-0018) re-resolves the
// Assignment, and the ticket schedules. Resuming with the file unchanged
// raises the same interrupt again, naming the same gap.
function checkpointUnassigned(
  session: Session,
  marker: TicketMarker,
  missing: "harness" | "model",
): void {
  const attempt = lastAttempt(session.runsDir, marker.id);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "unassigned",
    payload: { missing },
  });
  writeMarkerStatus(marker.file, "checkpoint");
  marker.status = "checkpoint";
  const body =
    `ticket ${marker.id} has no ${missing}: set one in console.json ` +
    `(an assign entry for ${marker.id}, or defaults.${missing}) and answer ` +
    "resume. The pool reloads console.json at the next super-step boundary " +
    "and schedules the ticket on what it finds.";
  landCheckpointBrief(marker.file, body);
  raiseInterrupt(session, { ticketId: marker.id, kind: "config", body });
  session.state = applyUpdate(session.state, {
    tickets: { [marker.id]: "checkpoint" },
    log: [`ticket ${marker.id}: no ${missing}; config interrupt raised instead of a launch`],
  });
}

// The run: the fan-out, the serialised merge chain, the boundary join, the
// merge outcomes, the crash interrupts, grading and selection, and the
// boundary persist. "stop" ends the drive at the close without another
// boundary: the shutdown gate (ADR-0017) and an exhausted persist both say
// it.
async function runSuperStep(
  session: Session,
  emit: (phase: RunPhase) => void,
  { ready, planned, snapshot }: SuperStepPlan,
): Promise<"continue" | "stop"> {
  // Merges land in completion order: each ticket's merge chains onto a
  // serialized queue the moment the ticket finishes, while its siblings
  // are still running. The queue starts from the session-wide merge chain
  // so a boot-adopted terminal attempt's finalize merge (ADR-0014), which
  // runs outside the drive loop, never runs its git work concurrently
  // with this step's merges on the main checkout.
  const merges: {
    marker: TicketMarker;
    result: MergeResult;
    attempt: number;
    // The working branch's tip just before this merge ran (the
    // Conversations ADR): captured so a ticket-ended Notice's diff summary
    // can be computed after the fact, once mergeTicket has already removed
    // the ticket's own branch. Empty in a headless pool (git unavailable).
    beforeSha: string;
  }[] = [];
  let mergeQueue: Promise<void> = session.mergeChain;
  const results = await Promise.all(
    planned.map(({ marker, plan }) =>
      runTicket(
        marker,
        snapshot,
        session.assignments.get(marker.id)!,
        {
          ...attemptEnvOf(session, snapshot.config),
          poolDir: session.poolDir,
          issuesDir: session.issuesDir,
        },
        plan,
      ).then((result) => {
        // The attempt's surviving proposals ride to the boundary's
        // adoption buffer (ADR-0010). A verify candidate carries none:
        // its proposals ride or die with selection.
        if (result.spawnProposals && result.spawnProposals.length > 0) {
          session.pendingSpawns.push({
            parentId: marker.id,
            proposals: result.spawnProposals,
            origin: "ticket",
          });
        }
        if (plan.verify) {
          // A verify candidate never merges and never writes the
          // ticket's status, at its exit or before its siblings exit:
          // the fan-out proceeds only once every attempt has exited
          // (grading and selection are later tickets). Only the pool
          // log moves, so the Console sees each attempt's exit live.
          session.state = applyUpdate(session.state, result.update);
          result.joinedAtExit = true;
          emit("running");
          return result;
        }
        if (result.plan.worktree && result.status === "done") {
          // Its place in the Merge queue is the order it joins the chain,
          // which is also the order the conflict loop below resolves in.
          session.mergeLine.taken(marker.id);
          mergeQueue = mergeQueue.then(() => {
            // Captured just before the merge, inside the serialized chain:
            // HEAD may have moved since this ticket's attempt exited (an
            // earlier sibling's merge in the same super-step), so this is
            // the range mergeTicket is actually about to add, not
            // whatever HEAD was when the outer async callback started.
            const beforeSha = mergeTargetSha(session);
            merges.push({
              marker,
              result: mergeTicket(session, marker, result.plan.worktree!),
              attempt: result.plan.attempt,
              beforeSha,
            });
          });
          // Publish the tail at every extension, not once after the await:
          // an adopted terminal attempt's finalize merge (ADR-0014) chains
          // onto session.mergeChain from outside the drive loop and must
          // never see a stale, already-settled tail.
          session.mergeChain = mergeQueue.catch(() => {});
        }
        if (result.status === "in-progress") {
          // A crashed attempt was recorded at exit (the crash event
          // landed in runTicket); push a snapshot now so the Console
          // shows the crash within seconds, not when the slowest
          // sibling's super-step ends.
          emit("running");
        } else {
          // A terminal result (done or checkpoint) lands in state the
          // moment the attempt exits, so its true status word shows on
          // the card and in the snapshot stream while its siblings still
          // run. The boundary join skips it (joinedAtExit), so applying
          // the same update twice is a no-op; anything genuinely computed
          // across results stays there. A checkpoint's interrupt is
          // raised here too, so the card turns red and the interrupt is
          // answerable while a sibling still runs; an answer accepted
          // then is queued and processed at the next boundary
          // (ADR-0004), so raising the interrupt processes nothing.
          session.state = applyUpdate(session.state, result.update);
          result.joinedAtExit = true;
          if (result.status === "checkpoint") {
            raiseCheckpoint(session, result.marker, result.plan.attempt);
          }
          emit("running");
        }
        return result;
      }),
    ),
  );
  await mergeQueue;

  let joined = session.state;
  for (const result of results) {
    // A terminal result (done or checkpoint) was joined at attempt exit;
    // the boundary only folds in what remains, so the same update is
    // never applied twice and the state join stays coherent.
    if (result.joinedAtExit) continue;
    joined = applyUpdate(joined, result.update);
  }
  session.state = joined;
  for (const merge of merges) {
    if (merge.result.ok) {
      session.mergeLine.settled(merge.marker.id);
      appendEvent(session.runsDir, merge.marker.id, {
        at: new Date().toISOString(),
        attempt: merge.attempt,
        kind: "merged",
        payload: mergedPayload(merge.result),
      });
      closeAttemptTab(session, merge.marker.id, merge.attempt);
      session.conversations.ticketEnded(
        merge.marker,
        branchFor(session.cwd, merge.marker.id),
        merge.beforeSha ? `${merge.beforeSha}..${mergeTargetRef(session)}` : null,
      );
      session.state = applyUpdate(session.state, {
        log: [
          `ticket ${merge.marker.id}: merged ${branchFor(session.cwd, merge.marker.id)} ` +
            "onto the working branch" +
            (merge.result.detail.endsWith("is gone")
              ? ` (${merge.result.detail})`
              : ""),
        ],
      });
    } else {
      await handleMergeConflict(
        session,
        merge.marker,
        merge.result,
        merge.attempt,
      );
    }
  }
  if (session.children.stopping) {
    // Shutdown (ADR-0017): this super-step joined after its headless
    // attempts were stopped. Each stop is on its ticket's log already; no
    // crash interrupt is raised for them, so the next boot resets those
    // tickets to ready instead of waiting on a human, and nothing more is
    // scheduled or graded.
    session.state = applyUpdate(session.state, {
      log: [
        "engine shutdown: super-step joined; no crash interrupts raised " +
          "and nothing more scheduled",
      ],
    });
    return "stop";
  }
  for (const result of results) {
    if (result.status === "in-progress") {
      // The crash event and the marker update landed at attempt exit;
      // only the crash interrupt waits for the boundary here. A
      // checkpoint's interrupt was already raised at exit, so the
      // at-exit path is the only writer of its interrupt. The body quotes
      // the log path, the tail and the outcome fact (ADR-0012), so the
      // Needs-input surface explains the dead attempt by itself.
      raiseInterrupt(session, {
        ticketId: result.marker.id,
        kind: "crash",
        // An in-progress result is a crash, and every crash path records
        // its reason; the fallback only satisfies the type.
        body: crashInterruptBody({ ...result, crashReason: result.crashReason ?? "crashed" }),
      });
    }
  }
  // The fan-out is complete once every attempt has exited; this line is
  // the gate's record. Nothing has merged and no status was written: the
  // ticket stays in-progress for grading (ticket 03) to take over.
  for (const marker of ready) {
    if (session.assignments.get(marker.id)!.verify == null) continue;
    const attempts = results.filter((r) => r.marker.id === marker.id);
    const tally = (status: TicketStatus) =>
      attempts.filter((r) => r.status === status).length;
    session.state = applyUpdate(session.state, {
      log: [
        `ticket ${marker.id}: verify fan-out complete: ` +
          `${attempts.length} attempts exited ` +
          `(${tally("done")} done, ${tally("checkpoint")} checkpoint, ` +
          `${tally("in-progress")} crash); no merge and no status ` +
          "write until grading",
      ],
    });
  }
  // Grading (ticket 03): once every attempt of a verify ticket has
  // exited, the engine writes one grader ticket per attempt into the
  // pool and runs them through the ordinary assign machinery. Grader
  // tickets are real tickets on disk with the build ticket as their
  // blocker, but the main loop never schedules them from the ready set:
  // the build ticket stays in-progress until selection has chosen a
  // winner, so the engine runs the graders itself here, the way it runs
  // the merge resolver, and writes their statuses itself. Their spawn
  // set still routes through the one entry point (ticket 01), so the
  // merge hold (ticket 02) pauses it with everything else.
  for (const marker of ready) {
    const assignment = session.assignments.get(marker.id)!;
    if (assignment.verify == null) continue;
    const attempts = results
      .filter((r) => r.marker.id === marker.id)
      .map((r) => r.plan.attempt)
      .sort((a, b) => a - b);
    // The grading path switch (ADR-0023): with a Jev key the round is graded
    // in code, every Attempt over its own Evidence, and no grader tickets are
    // written. Without a key, or when any ask falls back, the grader tickets
    // run exactly as before; never both in one round. The fallback's cause
    // reaches the pool log once through the port's own notice board; the
    // line here names the attempt and the switch.
    let grades: Map<number, Grade>;
    if (session.jev.configured) {
      const jevGrading = await runJevGraders(session, marker, attempts);
      if (jevGrading.ok) {
        grades = jevGrading.grades;
        // Named before the per-attempt lines, so the pool log reads in
        // order; it is written only once the whole round has an answer,
        // because a fallback means the round was never Jev's.
        session.state = applyUpdate(session.state, {
          log: [
            `ticket ${marker.id}: grading ${attempts.length} ` +
              `attempt${attempts.length === 1 ? "" : "s"} with Jev`,
          ],
        });
        for (const attempt of attempts) {
          const grade = grades.get(attempt);
          if (grade) recordJevGrade(session, marker, attempt, grade, emit);
        }
      } else {
        session.state = applyUpdate(session.state, {
          log: [
            `ticket ${marker.id}: Jev could not grade attempt ` +
              `${jevGrading.attempt} (${jevGrading.cause}: ` +
              `${jevGrading.detail}); falling back to grader tickets`,
          ],
        });
        grades = await runGraders(session, marker, attempts, emit);
      }
    } else {
      grades = await runGraders(session, marker, attempts, emit);
    }
    // Lone-attempt resolution (ticket 05): with one attempt and one
    // grade there is nothing to select between, so the grade decides
    // at the ticket: flag → checkpoint, pass → done.
    if (assignment.verify === 1 && attempts.length === 1) {
      resolveLoneAttempt(
        session,
        marker,
        results.find((r) => r.marker.id === marker.id)!,
        grades.get(attempts[0]) ?? null,
        emit,
      );
      continue;
    }
    // Winner selection (ticket 04): with more than one graded candidate
    // and every attempt done, the engine picks the best and merges only
    // that attempt's branch. A round with a crashed or paused attempt
    // grades but decides nothing: the crash or checkpoint interrupt owns
    // the ticket and the re-round after the human answers selects
    // afresh. A grader without a usable grade is equally undecided
    // (ticket 07's re-spawn supplies it). With the pool's selection set
    // to human (ticket 08), the same completed fan-out raises the
    // selection interrupt instead and the answer picks the winner.
    const round = results.filter((r) => r.marker.id === marker.id);
    if (
      round.every((r) => r.status === "done") &&
      attempts.every((attempt) => grades.has(attempt))
    ) {
      if (selectionMode(session.state.config) === "human") {
        raiseSelectionInterrupt(session, marker, attempts, grades, emit);
      } else {
        await selectAndMergeWinner(session, marker, attempts, grades, emit);
      }
    }
  }
  // The boundary persist: a failed write retries with backoff, and the
  // drive carries on once a write lands. If retries are exhausted the
  // persistence interrupt is raised and the loop stops scheduling, the
  // store still open: the closing gate (closeDrive) settles quiescent and
  // the run waits for a human instead of dying (issue #26).
  if (!(await persistWithRetry(session))) return "stop";
  emit("running");
  return "continue";
}

// The close: the review gate, the phase decision, the final persist and the
// settle.
async function closeDrive(
  session: Session,
  emit: (phase: RunPhase) => void,
): Promise<void> {
  const pending = session.markers
    .map((m) => m.id)
    .filter((id) => session.state.tickets[id] !== "done");
  // The closing gate: every ticket done and nothing else waiting on the human
  // raises the final Review interrupt. The dedupe in raiseInterrupt keeps it
  // to exactly one; an approval recorded in state holds it down for good.
  if (
    pending.length === 0 &&
    session.state.interrupts.length === 0 &&
    !session.state.reviewApproved
  ) {
    raiseInterrupt(session, reviewInterrupt(session));
    await persistWithRetry(session);
  }
  let phase: Exclude<RunPhase, "running">;
  if (session.state.interrupts.length > 0) {
    // An interrupt can outlive its ticket's done: a conflicted merge leaves
    // the ticket done and the interrupt pending.
    phase = "quiescent";
  } else if (pending.length === 0) {
    phase = "done";
  } else {
    phase = "stalled";
  }
  session.state = applyUpdate(session.state, {
    log: [
      phase === "done"
        ? "pool done: every ticket reached done"
        : phase === "quiescent"
          ? `pool quiescent: interrupts pending for ${session.state.interrupts
              .map((i) => i.ticketId)
              .join(", ")}`
          : `pool stalled: ${pending.join(", ")} cannot run`,
    ],
  });
  // The final persist decides the store's fate: if it still fails after
  // retries the run waits quiescent for a human, the store open, instead of
  // closing it or reporting a phase the pending interrupt contradicts.
  if (!(await persistWithRetry(session))) phase = "quiescent";
  emit(phase);
  if (phase !== "quiescent") closeStore(session);
  settleDrive(session, phase, null);
}

const ENGINE_BRIEF_HEADING = "## Brief, written by the engine";

const ENGINE_RESET_NOTE =
  `\n---\n\n${ENGINE_BRIEF_HEADING}\n\n` +
  "The engine process stopped while this ticket was in-progress (killed, " +
  "crashed, or the machine restarted). No agent from that process was " +
  "found still running at this boot, so the work is part done at best " +
  "and the agent left no brief. The ticket is back to ready; read the " +
  "working tree before it runs again.\n";

// The note for a ticket whose previous attempt was found still running at
// boot (ADR-0017): the engine stops it before scheduling anything, so the
// next attempt never shares the worktree with it.
function engineOrphanNote(orphans: { attempt: number; pid: number }[]): string {
  const who = orphans
    .map((o) => `attempt ${o.attempt} (pid ${o.pid})`)
    .join(" and ");
  return (
    `\n---\n\n${ENGINE_BRIEF_HEADING}\n\n` +
    "The engine process stopped while this ticket was in-progress, and at " +
    `the next boot ${who} was found still running in the working tree. ` +
    "The engine stopped it before scheduling anything, so the work is part " +
    "done at best and the agent left no brief. The ticket is back to ready; " +
    "read the working tree before it runs again.\n"
  );
}

// The found work of every enlisted ticket, recovered from the enlist
// `spawned` event after a restart (issue #101, ticket 04). The event carries
// the branch and the directory the pane was enlisted from, which is all the
// merge hold and the merge paths need; nothing else about the enlist is
// persisted. A marker with no such event (pre-ticket-04 data) is left out and
// falls back to the pool's own branch naming.
function seedEnlistedWork(session: Session): void {
  // A Conversation-arm enlist captures the merge target exactly as the
  // Ticket arm does and has no marker: its own `spawned` event is the record,
  // read here so a restart does not silently hand the pool checkout back to
  // the engine while the enlisted agent still works in it.
  for (const rec of loadConversations(join(session.poolDir, "conversations"))) {
    if (rec.enlisted === undefined) continue;
    const spawned = enlistSpawnedEvent(session, rec.id);
    if (spawned && typeof spawned.payload.merge_target === "string") {
      session.mergeTarget = spawned.payload.merge_target;
    }
  }
  for (const marker of session.markers) {
    if (marker.enlistedFrom === undefined) continue;
    const spawned = enlistSpawnedEvent(session, marker.id);
    if (!spawned) continue;
    session.enlistedWork.set(marker.id, {
      branch: spawned.payload.branch as string,
      directory: spawned.payload.cwd as string,
    });
    // The Assignment as found, for an attempt still in flight: the harness
    // herdr named at enlist is what boot re-adoption registers the runtime
    // under and what the ending releases the agent identity with. A ticket
    // past its enlisted attempt keeps the config's resolution, which is
    // what any re-run launches with. Events written before the harness was
    // recorded leave the config's resolution in place.
    if (marker.status === "in-progress" && typeof spawned.payload.harness === "string") {
      session.assignments.set(marker.id, {
        harness: spawned.payload.harness,
        model: "",
        drivers: DEFAULT_DRIVERS,
      });
    }
    // The merge target an enlist captured when it moved the pool's own
    // checkout (ticket 04-spawn-1): recovered from every enlisted marker,
    // done ones included, because the checkout stays on the created pool
    // branch for the rest of the pool's life and every later merge in this
    // pool runs against the captured target (`withMergeCheckout`).
    if (typeof spawned.payload.merge_target === "string") {
      session.mergeTarget = spawned.payload.merge_target;
    }
  }
}

// The enlist `spawned` event of an enlisted Ticket or Conversation: the one
// carrying the found directory and branch.
function enlistSpawnedEvent(session: Session, id: string) {
  return readEvents(session.runsDir, id)
    .filter(
      (event) =>
        event.kind === "spawned" &&
        typeof event.payload.cwd === "string" &&
        typeof event.payload.branch === "string",
    )
    .pop();
}

// Rehydration: the last checkpoint restores the run's channels, but the
// line-1 markers are the truth for ticket statuses and win on any
// disagreement. An in-progress marker with no pending interrupt means the
// agent holding it died with the last process, so it goes back to ready
// with a note on the Issue, matching run.sh's interrupt semantics. A
// stored interrupt whose marker says done or ready (a human answered or
// reset it on disk) is stale and clears. A checkpoint marker with no
// stored interrupt (a pool run.sh halted) re-raises its interrupt from
// the Brief. Outcome files on disk win over the checkpoint, so a ticket
// that finished before a mid-super-step kill still passes its outcome
// downstream.
function rehydrate(session: Session): void {
  const stored = session.store.latest() as Partial<PoolState> | null;
  const log: string[] = [];
  if (stored) {
    session.state = {
      tickets: session.state.tickets,
      log: Array.isArray(stored.log) ? stored.log : [],
      outcomes: stored.outcomes ?? {},
      config: session.state.config,
      interrupts: Array.isArray(stored.interrupts) ? stored.interrupts : [],
      reviewApproved: stored.reviewApproved === true,
    };
    log.push(
      `rehydrated from checkpoint: ${session.state.interrupts.length} ` +
        `interrupt(s), ${Object.keys(session.state.outcomes).length} ` +
        "outcome(s) restored",
    );
  }
  const interrupted = new Set(session.state.interrupts.map((i) => i.ticketId));
  for (const marker of session.markers) {
    if (marker.status === "in-progress" && !interrupted.has(marker.id)) {
      // A headless attempt of the previous engine process may still be
      // running (ADR-0017): its spawned event's pid proves it. The note says
      // which it was; reapHeadlessOrphans stops it before the first
      // scheduling. A terminal-backed attempt records no pid and keeps the
      // plain note, which reconcileTerminalAttempts strips on re-adoption.
      const orphans = headlessOrphans(session, marker.id);
      writeMarkerStatus(marker.file, "ready");
      appendFileSync(
        marker.file,
        orphans.length > 0 ? engineOrphanNote(orphans) : ENGINE_RESET_NOTE,
      );
      marker.status = "ready";
      if (orphans.length > 0) {
        for (const orphan of orphans) {
          session.orphans.push({ marker, ...orphan });
        }
        log.push(
          `ticket ${marker.id}: marker was in-progress and ` +
            orphans
              .map((o) => `attempt ${o.attempt} (pid ${o.pid})`)
              .join(", ") +
            " is still running from the previous engine process; stopping " +
            "it before scheduling, ticket back to ready",
        );
      } else {
        log.push(
          `ticket ${marker.id}: marker was in-progress with no live agent; ` +
            "back to ready",
        );
      }
    }
  }
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      session.markers.map((marker) => [marker.id, marker.status]),
    ),
  });
  // An approval only stands while every marker on disk is done: a human who
  // reset tickets between runs gets a fresh Review when they finish again.
  if (
    session.markers.some((marker) => marker.status !== "done") &&
    (session.state.reviewApproved ||
      session.state.interrupts.some((i) => i.kind === "review"))
  ) {
    session.state = applyUpdate(session.state, {
      interrupts: session.state.interrupts.filter((i) => i.kind !== "review"),
      reviewApproved: false,
    });
    log.push(
      "review gate cleared: markers on disk are not all done, so a fresh " +
        "Review will be raised when they finish",
    );
  }
  const stale = session.state.interrupts.filter((i) => {
    if (i.kind === "merge-conflict" || i.kind === "merge-approval") return false;
    const status = session.state.tickets[i.ticketId];
    return status === "done" || status === "ready";
  });
  if (stale.length > 0) {
    session.state = applyUpdate(session.state, {
      interrupts: session.state.interrupts.filter((i) => !stale.includes(i)),
      log: stale.map(
        (i) =>
          `interrupt cleared for ${i.ticketId} (${i.kind}): marker says ` +
          session.state.tickets[i.ticketId],
      ),
    });
  }
  for (const marker of session.markers) {
    if (
      marker.status === "checkpoint" &&
      !session.state.interrupts.some((i) => i.ticketId === marker.id)
    ) {
      raiseCheckpoint(
        session,
        marker,
        lastAttempt(session.runsDir, marker.id),
      );
    }
  }
  const recovered: Record<string, Outcome> = {};
  for (const marker of session.markers) {
    if (marker.status !== "done") continue;
    const read = readAttemptResult(
      join(session.runsDir, attemptOutcomeName(marker.id, null, false)),
      validateOutcome,
    );
    if (read.ok) recovered[marker.id] = read.outcome;
  }
  if (Object.keys(recovered).length > 0) {
    session.state = applyUpdate(session.state, { outcomes: recovered });
  }
  if (log.length > 0) {
    session.state = applyUpdate(session.state, { log });
  }
}

// ---------------------------------------------------------------------------
// Headless boot reconciliation (ADR-0017)
// ---------------------------------------------------------------------------

interface HeadlessOrphan {
  marker: TicketMarker;
  attempt: number;
  pid: number;
  cwd: string;
}

// The headless attempts a previous engine process spawned and never saw
// exit, still alive: every spawned event carrying a pid (headless spawns
// record one; terminal-backed spawns record a pane id instead) with no
// exited or crash event for the same attempt after it, whose pid is live in
// the attempt's spawn cwd. A live pid working elsewhere is a reused pid, not
// an orphan. A verify fan-out can leave several per ticket.
function headlessOrphans(
  session: Session,
  ticketId: string,
): Omit<HeadlessOrphan, "marker">[] {
  const events = readEvents(session.runsDir, ticketId);
  const found: Omit<HeadlessOrphan, "marker">[] = [];
  events.forEach((event, i) => {
    if (event.kind !== "spawned") return;
    const pid = event.payload.pid;
    const cwd = event.payload.cwd;
    if (typeof pid !== "number" || typeof cwd !== "string") return;
    const ended = events.some(
      (other, j) =>
        j > i &&
        other.attempt === event.attempt &&
        (other.kind === "exited" || other.kind === "crash"),
    );
    if (ended) return;
    if (!orphanIsLive(pid, cwd)) return;
    found.push({ attempt: event.attempt, pid, cwd });
  });
  return found;
}

/**
 * Stop the headless orphans rehydrate found (ADR-0017), each with the same
 * TERM-grace-KILL a shutdown uses, and record the crash on the ticket's log
 * so the attempt no longer reads as running. Awaited by the drive before its
 * first scheduling, so the re-run never lands in a worktree the orphan is
 * still writing. Never rejects: an orphan that survives even KILL (not ours
 * to signal) is logged and the pool carries on as it did before this existed.
 */
async function reapHeadlessOrphans(session: Session): Promise<void> {
  const orphans = session.orphans.splice(0);
  if (orphans.length === 0) return;
  await Promise.all(
    orphans.map(async (orphan) => {
      let gone = false;
      try {
        gone = await stopOrphan(orphan.pid);
      } catch {
        gone = false;
      }
      const id = orphan.marker.id;
      appendEvent(session.runsDir, id, {
        at: new Date().toISOString(),
        attempt: orphan.attempt,
        kind: "crash",
        payload: {
          code: null,
          reason: gone
            ? `orphan attempt (pid ${orphan.pid}) from a previous engine ` +
              "process was still running at boot; stopped by the engine"
            : `orphan attempt (pid ${orphan.pid}) from a previous engine ` +
              "process was still running at boot and survived the engine's stop",
          logTail: [],
          outcomeExists: existsSync(
            join(session.runsDir, attemptOutcomeName(id, null, false)),
          ),
          pid: orphan.pid,
        },
      });
      session.state = applyUpdate(session.state, {
        log: [
          `ticket ${id}: orphan attempt ${orphan.attempt} (pid ${orphan.pid}) ` +
            (gone ? "stopped at boot" : "could not be stopped at boot"),
        ],
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Terminal-backed boot reconciliation (ADR-0014)
// ---------------------------------------------------------------------------

// A terminal attempt herdr recorded on a `spawned` event but never saw exit:
// the newest spawned event carrying a pane id with no exited or crash event
// for the same attempt after it. Attempt numbers are unique per ticket, so
// "no exit event with that attempt number after the spawn" is exact.
function terminalOrphan(
  session: Session,
  ticketId: string,
): { attempt: number; paneId: string } | null {
  const events = readEvents(session.runsDir, ticketId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      event.kind !== "spawned" ||
      typeof event.payload.pane_id !== "string"
    ) {
      continue;
    }
    const exited = events.some(
      (other, j) =>
        j > i &&
        other.attempt === event.attempt &&
        (other.kind === "exited" || other.kind === "crash"),
    );
    if (!exited) return { attempt: event.attempt, paneId: event.payload.pane_id };
  }
  return null;
}

// Whether an orphaned terminal attempt can be re-adopted, or must keep the
// headless orphan fate. Only ordinary solo implement attempts qualify:
// engine-run tickets (graders, head-to-head) and verify candidates belong to
// machinery that cannot be re-entered at boot, and a resolver attempt belongs
// to the merge-conflict flow, which re-runs its resolver on answer.
function terminalAdoptable(
  session: Session,
  ticketId: string,
  attempt: number,
): boolean {
  if (engineTicketBuildId(ticketId)) return false;
  if (session.assignments.get(ticketId)?.verify != null) return false;
  return !readEvents(session.runsDir, ticketId).some(
    (event) => event.kind === "resolver" && event.attempt === attempt,
  );
}

// ---------------------------------------------------------------------------
// The Pool workspace (issue #94)
// ---------------------------------------------------------------------------

/**
 * The per-pool runtime file that remembers the Pool workspace:
 * `runs/pool-workspace.json`, `{ "workspace_id": "wT" }`. A runtime fact of
 * this engine's own, never pool configuration, so it lives beside the other
 * runs artifacts and never in console.json: the operator neither writes it
 * nor reviews it, and a pool copied elsewhere must not drag another
 * machine's workspace id along in a file under version control.
 */
const POOL_WORKSPACE_FILE = "pool-workspace.json";

/**
 * The session's knowledge of its Pool workspace. `ready` settles once boot
 * resolution has decided (whatever it decided), so a spawn that races the
 * boot RPC waits for it instead of opening its tab elsewhere; `id` is null
 * until then, and stays null when no workspace could be had at all.
 */
interface PoolWorkspaceState {
  ready: Promise<void>;
  id: string | null;
  /** The workspace the server was launched in (HERDR_WORKSPACE_ID), or null. */
  launch: string | null;
  /** A re-resolve in flight, shared by every spawn that raced into the same refusal. */
  reresolving: Promise<string | null> | null;
}

function readRememberedPoolWorkspace(runsDir: string): string | null {
  try {
    const raw = readOptional(join(runsDir, POOL_WORKSPACE_FILE));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { workspace_id?: unknown };
    return typeof parsed.workspace_id === "string" && parsed.workspace_id !== ""
      ? parsed.workspace_id
      : null;
  } catch {
    // Unreadable, torn, or holding something that is not an id: the pool
    // simply forgets where its tabs were and resolves afresh, the same
    // tolerance the queued-answer store gives its own file. Nothing here is
    // worth failing a boot over.
    return null;
  }
}

// Written tmp + rename, the way every runtime file the engine rewrites is
// (queued-answers.json, the fleet registry): a crash mid-write leaves the
// previous id, never half of one.
function rememberPoolWorkspace(runsDir: string, workspaceId: string): void {
  const path = join(runsDir, POOL_WORKSPACE_FILE);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ workspace_id: workspaceId })}\n`);
  renameSync(temp, path);
}

/**
 * Remember the resolved id, and carry on if that cannot be written. The file
 * is a convenience for the *next* boot; this run already has its workspace,
 * and an unwritable runs directory must not throw away a resolution that
 * worked — the failure costs the operator one re-created workspace at the
 * next restart, while treating it as fatal would cost them every tab of this
 * run.
 */
function persistPoolWorkspace(session: Session, workspaceId: string): void {
  try {
    rememberPoolWorkspace(session.runsDir, workspaceId);
  } catch (err) {
    session.state = applyUpdate(session.state, {
      log: [
        `Pool workspace ${workspaceId} could not be remembered for the next ` +
          `boot (${err instanceof Error ? err.message : String(err)}); ` +
          "this run's tabs are unaffected",
      ],
    });
  }
}

/**
 * Resolve the Pool workspace at boot (issue #94), before reconciliation so
 * the pane listing can be scoped to it, and before the drive's first
 * scheduling so no attempt ever races it. Only a terminal-backed pool has
 * one: a headless pool opens no tabs at all.
 *
 * A failure of all three steps (no remembered workspace, no launch
 * workspace, and a daemon that will not create one) is logged and the pool
 * boots anyway with no Pool workspace: each spawn then takes the per-attempt
 * headless fallback ADR-0014 already promised, rather than the whole pool
 * refusing to start over a terminal convenience.
 */
async function resolvePoolWorkspaceForSession(session: Session): Promise<void> {
  if (!attemptEnvOf(session).terminalBacked) return;
  const remembered = readRememberedPoolWorkspace(session.runsDir);
  try {
    const { workspaceId, origin } = await resolvePoolWorkspace(
      session.herdrSocket,
      {
        remembered,
        launch: session.poolWorkspace.launch,
        label: basename(session.poolDir),
        cwd: session.cwd,
      },
    );
    session.poolWorkspace.id = workspaceId;
    persistPoolWorkspace(session, workspaceId);
    if (origin === "created") {
      session.state = applyUpdate(session.state, {
        log: [`Pool workspace ${workspaceId} created for this pool's tabs`],
      });
    }
  } catch (err) {
    session.poolWorkspace.id = null;
    session.state = applyUpdate(session.state, {
      log: [
        "no Pool workspace could be resolved " +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          "attempts fall back to headless",
      ],
    });
  }
}

/**
 * Re-resolve the Pool workspace after a `tab.create` the daemon refused,
 * given the id that spawn tried. Three guards stand before any workspace is
 * ever created, because the cost of getting this wrong is a second Pool
 * workspace for one pool, which is exactly the scattering the first one
 * exists to prevent:
 *
 * 1. The id has already moved on: another spawn's re-resolve finished while
 *    this one was failing, so the answer is simply where the pool's tabs go
 *    now, and no RPC is needed at all.
 * 2. A re-resolve is in flight: every spawn that raced into the same refusal
 *    joins it rather than starting its own.
 * 3. The stale id is still there: a `tab.create` can be refused for reasons
 *    that have nothing to do with the workspace (a daemon blip, a bad cwd),
 *    and `workspace.get` is what tells those apart from a workspace the
 *    operator closed. Still there means the refusal was transient: the same
 *    workspace comes back and the caller's retry goes to the same place.
 *
 * Only past all three does the workspace count as gone, and the resolution
 * runs without the remembered id (it is the one that just failed): the launch
 * workspace if that still exists, otherwise a fresh one, persisted and noted
 * on the pool log.
 */
function reresolvePoolWorkspace(
  session: Session,
  staleId: string,
): Promise<string | null> {
  if (session.poolWorkspace.id !== staleId) {
    return Promise.resolve(session.poolWorkspace.id);
  }
  if (session.poolWorkspace.reresolving !== null) {
    return session.poolWorkspace.reresolving;
  }
  const attempt = (async (): Promise<string | null> => {
    if (await workspaceExists(session.herdrSocket, staleId)) {
      return staleId;
    }
    const { workspaceId } = await resolvePoolWorkspace(session.herdrSocket, {
      remembered: null,
      launch: session.poolWorkspace.launch,
      label: basename(session.poolDir),
      cwd: session.cwd,
    });
    session.poolWorkspace.id = workspaceId;
    persistPoolWorkspace(session, workspaceId);
    session.state = applyUpdate(session.state, {
      log: [
        `Pool workspace ${staleId} is gone; the pool's tabs now open in ` +
          `${workspaceId}`,
      ],
    });
    return workspaceId;
  })()
    .catch((err: unknown) => {
      session.state = applyUpdate(session.state, {
        log: [
          "the Pool workspace could not be re-resolved after a refused tab " +
            `(${err instanceof Error ? err.message : String(err)}); ` +
            "this attempt falls back to headless",
        ],
      });
      return null;
    })
    .finally(() => {
      session.poolWorkspace.reresolving = null;
    });
  session.poolWorkspace.reresolving = attempt;
  return attempt;
}

/**
 * The Pool workspace as the Attempt-run module reads it (ADR-0014's pattern:
 * one place decides, every spawn site reads the env). Bound late, like the
 * Conversation host: the Conversation module's environment is built before
 * the session literal exists, and both halves must read the live id, not a
 * copy taken before boot resolution ran.
 */
function poolWorkspaceFor(sessionOf: () => Session): PoolWorkspace {
  return {
    id: async () => {
      const session = sessionOf();
      await session.poolWorkspace.ready;
      return session.poolWorkspace.id;
    },
    reresolve: (staleId) => reresolvePoolWorkspace(sessionOf(), staleId),
  };
}

/**
 * Boot reconciliation for terminal-backed pools (ADR-0014), run at startPool
 * and awaited by the drive loop before its first scheduling. Every orphan of
 * the engine process that died is checked against herdr's live pane list: a
 * live pane re-adopts the attempt (the ticket returns to in-progress, an
 * interrupt records the wait, and a background finalize records the
 * attempt's real ending), a missing pane crashes it (a crash event; the
 * ticket rehydrate already reset to ready re-runs it). A ticket that was
 * mid-adoption when the engine died again is re-entered the same way: its
 * marker stayed in-progress with the adoption checkpoint interrupt up. Never
 * rejects: reconciliation is advisory boot work, and a daemon that cannot be
 * asked changes nothing about the pool's ordinary recovery.
 */
async function reconcileTerminalAttempts(session: Session): Promise<void> {
  if (!attemptEnvOf(session).terminalBacked) return;
  let live: string[];
  try {
    // Scoped to the Pool workspace when there is one (issue #94): this
    // pool's orphans can only be in this pool's workspace, so a host full
    // of other panes is no longer part of the answer. A workspace that was
    // just created holds none, which is correct rather than merely cheap;
    // with no Pool workspace at all the listing stays daemon-wide.
    live = await listPaneIds(
      session.herdrSocket,
      session.poolWorkspace.id ?? undefined,
    );
  } catch {
    session.state = applyUpdate(session.state, {
      log: ["terminal reconciliation skipped: herdr daemon unreachable"],
    });
    return;
  }
  const livePanes = new Set(live);
  // An enlisted pane is the one orphan the scoped listing cannot answer for
  // (issue #101): the operator opened its tab in their own workspace and the
  // engine promises never to move it into the Pool workspace, so it is absent
  // from `live` whether it is alive or gone. Asking a workspace-scoped
  // question about it would read every live enlisted attempt as pane-gone and
  // checkpoint working tickets on every restart. The daemon-wide listing is
  // the only honest answer, fetched once and only when an enlisted marker
  // needs it, the way the Conversation arm's boot adoption already asks.
  let enlistedPanes: Set<string> | null = null;
  const enlistedPaneIsLive = async (paneId: string): Promise<boolean> => {
    if (enlistedPanes === null) {
      try {
        enlistedPanes = new Set(await listPaneIds(session.herdrSocket));
      } catch {
        // A listing the daemon cannot answer says nothing about the pane, so
        // it is treated as live and its ending stays with the Outcome race
        // rather than being called gone on a failed question.
        return true;
      }
    }
    return enlistedPanes.has(paneId);
  };
  const log: string[] = [];
  for (const marker of session.markers) {
    const orphan = terminalOrphan(session, marker.id);
    if (!orphan) continue;
    // A parked checkpoint interrupt on an in-progress marker is the adoption
    // pattern from a previous boot: an ordinary checkpoint always writes its
    // marker to "checkpoint" before raising, an adopted attempt stays
    // in-progress while it waits.
    const midAdoption =
      marker.status === "in-progress" &&
      session.state.interrupts.some(
        (i) => i.ticketId === marker.id && i.kind === "checkpoint",
      );
    if (marker.status !== "ready" && !midAdoption) continue;
    if (!terminalAdoptable(session, marker.id, orphan.attempt)) {
      log.push(
        `ticket ${marker.id}: orphaned terminal attempt ${orphan.attempt} ` +
          "kept the headless orphan fate (engine-run or verify attempt)",
      );
      // Not adopted, so nothing in this engine will ever release the agent
      // identity the dead one reported for that pane (issue #94): a live
      // pane would otherwise sit in herdr's sidebar as an agent at work
      // that no engine is watching. Best-effort, like every release.
      releaseOrphanAgent(session, marker.id, orphan.paneId);
      continue;
    }
    // The enlisted pane is asked for daemon-wide; every other orphan's pane
    // can only be in the Pool workspace, so the scoped answer stands.
    const paneIsLive =
      marker.enlistedFrom !== undefined
        ? await enlistedPaneIsLive(orphan.paneId)
        : livePanes.has(orphan.paneId);
    if (!paneIsLive) {
      // An enlisted pane that went while the engine was down (issue #101):
      // the attempt is over and its Outcome either landed or did not. Either
      // way this is the enlisted ending, not the generic crash.
      if (marker.enlistedFrom !== undefined) {
        stripEngineResetNote(marker.file);
        endEnlistedAttempt(session, marker.id, "pane-gone", orphan.attempt);
        log.push(
          `ticket ${marker.id}: enlisted pane ${orphan.paneId} is gone at ` +
            "boot; the attempt is checkpointed with its branch kept",
        );
        continue;
      }
      // The attempt's pane is gone: the attempt crashed. The ready ticket
      // re-runs; a mid-adoption ticket loses its interrupt and joins it.
      appendEvent(session.runsDir, marker.id, {
        at: new Date().toISOString(),
        attempt: orphan.attempt,
        kind: "crash",
        payload: {
          code: null,
          reason: "attempt pane gone at boot reconciliation",
          logTail: [],
          outcomeExists: existsSync(
            join(session.runsDir, attemptOutcomeName(marker.id, null, false)),
          ),
        },
      });
      if (midAdoption) {
        session.state = applyUpdate(session.state, {
          interrupts: session.state.interrupts.filter(
            (i) => i.ticketId !== marker.id,
          ),
        });
        writeMarkerStatus(marker.file, "ready");
        marker.status = "ready";
        session.state = applyUpdate(session.state, {
          tickets: { [marker.id]: "ready" },
        });
      }
      log.push(
        `ticket ${marker.id}: attempt ${orphan.attempt}'s pane is gone at ` +
          "boot; the attempt crashed and the ticket re-runs",
      );
      // The pane left this pool's workspace, which is not proof it left the
      // daemon: it may still be alive somewhere the listing no longer
      // covers, carrying the dead engine's "working" binding. The release
      // is best-effort, and for a pane that really is gone it is a no-op.
      releaseOrphanAgent(session, marker.id, orphan.paneId);
      continue;
    }
    adoptTerminalAttempt(session, marker, orphan, midAdoption, log);
  }
  if (log.length > 0) {
    session.state = applyUpdate(session.state, { log });
  }
}

/**
 * Drop the agent identity a dead engine reported for an orphan's pane
 * (issue #94), for every orphan this boot does not adopt: the binding is
 * keyed by (pane, source) and nothing else in this engine will ever release
 * it, so without this a pane the pool has washed its hands of stays in
 * herdr's agent sidebar as work in progress. Best-effort and silent, like
 * the tab closes; skipped when the ticket's Assignment does not name a
 * harness, since the agent name is half the key.
 */
function releaseOrphanAgent(
  session: Session,
  ticketId: string,
  paneId: string,
): void {
  const harness = session.assignments.get(ticketId)?.harness;
  if (!harness) return;
  void releasePaneAgent(session.herdrSocket, paneId, harness.toLowerCase()).catch(
    () => {},
  );
}

// Re-adopt one live orphan (ADR-0014). A fresh adoption undoes rehydrate's
// reset for this ticket (marker back to in-progress, the reset note stripped,
// it was appended this boot) and raises the interrupt that keeps the pool
// honest about the wait. A mid-adoption restart keeps the interrupt it
// already has and only re-registers the wait.
function adoptTerminalAttempt(
  session: Session,
  marker: TicketMarker,
  orphan: { attempt: number; paneId: string },
  midAdoption: boolean,
  log: string[],
): void {
  const enlisted = marker.enlistedFrom !== undefined;
  if (!midAdoption) {
    writeMarkerStatus(marker.file, "in-progress");
    stripEngineResetNote(marker.file);
    marker.status = "in-progress";
    session.state = applyUpdate(session.state, {
      tickets: { [marker.id]: "in-progress" },
    });
    raiseInterrupt(session, {
      ticketId: marker.id,
      kind: "checkpoint",
      body: enlisted
        ? enlistedAdoptionBody(session, marker, orphan)
        : `The engine restarted while this ticket's terminal-backed attempt ` +
          `${orphan.attempt} was still running in herdr pane ${orphan.paneId}. ` +
          "The pane proved live at boot, so the engine re-adopted the attempt " +
          "and is waiting on the pane's exit; the attempt's real outcome will " +
          "be recorded then. Answering this interrupt abandons the attempt " +
          "(the pane is closed) and re-runs the ticket.",
    });
  }
  session.adopted.set(marker.id, {
    paneId: orphan.paneId,
    attempt: orphan.attempt,
    abandoned: false,
  });
  session.liveAttempts.register(marker.id, orphan.attempt, {
    paneId: orphan.paneId,
    tabId: null,
  });
  if (enlisted) {
    // An enlisted pane gets its runtime back, not only an ending wait: the
    // runtime's tick is what reports working or blocked to herdr's sidebar
    // as the Turn state moves (spec, story 19), and its watch is the same
    // ending race a live enlist has.
    log.push(
      `ticket ${marker.id}: enlisted attempt ${orphan.attempt} re-adopted ` +
        `from live pane ${orphan.paneId}; watching its Turn state and ` +
        "waiting on its ending",
    );
    void readoptEnlistedRuntime(session, marker, orphan).catch(() => {});
    return;
  }
  // The pane survived an engine that did not, and herdr forgot the agent
  // identity the dead engine reported for it (issue #94): report it again,
  // so a restarted pool's re-adopted attempts are back in the agent list
  // beside its fresh ones.
  const harness = session.assignments.get(marker.id)?.harness;
  if (harness) {
    reportAttemptAgent(
      attemptEnvOf(session),
      orphan.paneId,
      { id: marker.id, title: marker.title, harness },
      "working",
    );
  }
  log.push(
    `ticket ${marker.id}: attempt ${orphan.attempt} re-adopted from live ` +
      `pane ${orphan.paneId}; waiting on its exit`,
  );
  void finalizeAdoptedAttempt(session, marker.id).catch(() => {});
}

// The adoption interrupt for an enlisted pane (issue #101): the pane is the
// operator's, so answering lets it go rather than closing it (ADR-0021).
function enlistedAdoptionBody(
  session: Session,
  marker: TicketMarker,
  orphan: { attempt: number; paneId: string },
): string {
  const branch = session.enlistedWork.get(marker.id)?.branch ?? "";
  return (
    `The engine restarted while enlisted attempt ${orphan.attempt} was still ` +
    `running in herdr pane ${orphan.paneId}, the terminal you opened. The ` +
    "pane proved live at boot, so the engine re-adopted the attempt and is " +
    "watching the pane for its Outcome; the attempt's real outcome will be " +
    "recorded then. Answering this interrupt lets the pane go: it is left " +
    "exactly as found, never closed, and the ticket re-runs as an ordinary " +
    "engine-launched attempt." +
    createdBranchNote(session, marker.id, branch)
  );
}

/**
 * Register the enlisted runtime for a re-adopted pane (issue #101). The pane
 * was taught before the restart, so no teaching Turn is queued; the harness
 * and the found work come from the enlist `spawned` event `seedEnlistedWork`
 * restored. The claim reports the pane's current Turn state, so the sidebar
 * reads blocked or working as the pane is, not the one state a one-shot
 * report at boot would pin it to. A pane the runtime cannot claim (it could
 * not be read, or an event from before the harness was recorded) falls back
 * to the ending-only wait, logged, so the attempt is still recorded when it
 * ends. An answer that let the pane go while the claim was in flight wins:
 * the runtime is released again rather than left ticking.
 */
async function readoptEnlistedRuntime(
  session: Session,
  marker: TicketMarker,
  orphan: { attempt: number; paneId: string },
): Promise<void> {
  const work = session.enlistedWork.get(marker.id);
  const harness = session.assignments.get(marker.id)?.harness;
  const registration =
    work && harness
      ? await session.enlisted.register({
          id: marker.id,
          paneId: orphan.paneId,
          tabId: null,
          harness,
          title: marker.title,
          branch: work.branch,
          directory: work.directory,
          outcomePath: join(session.runsDir, attemptOutcomeName(marker.id, null, false)),
          teaching: null,
        })
      : { ok: false as const, reason: "no found work or harness on record" };
  if (!session.adopted.has(marker.id)) {
    // Let go while the claim was in flight: the claim reported the identity
    // after the answer released it, so release it again with the runtime.
    session.enlisted.release(marker.id);
    if (harness) {
      void releasePaneAgent(session.herdrSocket, orphan.paneId, harness.toLowerCase()).catch(
        () => {},
      );
    }
    return;
  }
  if (registration.ok) return;
  // The ending-only wait reports nothing, so the identity is reported once
  // here, as every re-adopted attempt's is (issue #94).
  if (harness) {
    reportAttemptAgent(
      attemptEnvOf(session),
      orphan.paneId,
      { id: marker.id, title: marker.title, harness },
      "working",
    );
  }
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${marker.id}: re-adopted pane ${orphan.paneId} could not be ` +
        `claimed (${registration.reason}); waiting on its ending only`,
    ],
  });
  void finalizeAdoptedEnlisted(session, marker.id).catch(() => {});
}

/**
 * The enlisted attempt's ending-only boot finalize (issue #101, ticket 04):
 * the fallback for a re-adopted pane whose runtime could not be re-registered
 * (`readoptEnlistedRuntime`), so its ending is still recorded. There is no
 * wrapper and so no exit-code file, so the wait is the enlisted module's
 * two-form race, Outcome against pane gone, rather than the generic
 * `waitForAttemptEnding`.
 */
async function finalizeAdoptedEnlisted(
  session: Session,
  ticketId: string,
): Promise<void> {
  const adopted = session.adopted.get(ticketId);
  if (!adopted) return;
  const outcomePath = join(session.runsDir, attemptOutcomeName(ticketId, null, false));
  let ending: EnlistedEnding;
  try {
    ending = await waitForEnlistedEnding(
      session.herdrSocket,
      adopted.paneId,
      outcomePath,
      new AbortController().signal,
      session.enlistPollMs,
    );
  } catch {
    return;
  }
  if (adopted.abandoned) return;
  const current = session.adopted.get(ticketId);
  if (!current || current.abandoned) return;
  session.adopted.delete(ticketId);
  endEnlistedAttempt(session, ticketId, ending, adopted.attempt);
}

// Remove the note rehydrate appended this boot: it is a known constant and
// is the file's tail, having just been appended by this process.
function stripEngineResetNote(issueFile: string): void {
  const text = readFileSync(issueFile, "utf8");
  if (!text.endsWith(ENGINE_RESET_NOTE)) return;
  writeFileSync(
    issueFile,
    text.slice(0, text.length - ENGINE_RESET_NOTE.length),
  );
}

// Answering the adoption interrupt abandons the re-adopted attempt: the pane
// is closed, the finalize records nothing, and the generic answer handling
// re-runs the ticket from its reset marker. An enlisted pane is the
// operator's and is never closed (ADR-0021): the pool lets it go instead,
// releasing the runtime and the agent identity it had claimed, and drops the
// as-found record so the re-run is an ordinary engine-launched attempt with
// a real Assignment in a pool worktree, never a fresh attempt launched into
// the operator's own checkout with no model. Exactly what the pane-gone
// checkpoint does, for the same re-run.
function abandonAdoption(session: Session, ticketId: string): void {
  const adopted = session.adopted.get(ticketId);
  if (!adopted) return;
  adopted.abandoned = true;
  session.adopted.delete(ticketId);
  session.liveAttempts.clear(ticketId, adopted.attempt);
  const marker = session.markers.find((candidate) => candidate.id === ticketId);
  if (marker?.enlistedFrom !== undefined) {
    session.enlisted.release(ticketId);
    const harness = session.assignments.get(ticketId)?.harness;
    if (harness) {
      void releasePaneAgent(session.herdrSocket, adopted.paneId, harness.toLowerCase()).catch(
        () => {},
      );
    }
    session.enlistedWork.delete(ticketId);
    session.assignments.set(ticketId, reRunAssignment(session, marker));
    session.state = applyUpdate(session.state, {
      log: [
        `ticket ${ticketId}: adoption abandoned (interrupt answered); enlisted ` +
          `pane ${adopted.paneId} left as found and the ticket re-runs as an ` +
          "ordinary attempt",
      ],
    });
    return;
  }
  void closePane(session.herdrSocket, adopted.paneId).catch(() => {});
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${ticketId}: adoption abandoned (interrupt answered); pane ` +
        `${adopted.paneId} closed and the ticket re-runs`,
    ],
  });
}

/**
 * The adopted attempt's background ending (ADR-0014, amended by ADR-0016):
 * waits for the attempt's Outcome, or the pane's loss without one, then
 * records the attempt's exit exactly the way runTicket's tail would: the
 * exited event on every ending, the crash event and interrupt on a bad
 * exit, the marker status and checkpoint Brief on a clean one, and a done
 * ticket's merge chained onto the session merge chain so it never runs its
 * git work concurrently with the drive's merges. The finalize never
 * rejects: it is advisory bookkeeping alongside the drive.
 */
async function finalizeAdoptedAttempt(
  session: Session,
  ticketId: string,
): Promise<void> {
  const adopted = session.adopted.get(ticketId);
  if (!adopted) return;
  const marker = session.markers.find((m) => m.id === ticketId);
  if (!marker) return;
  const attempt = adopted.attempt;
  const assignment = session.assignments.get(ticketId);
  // Adopted attempts are terminal-backed by definition (they have a pane);
  // their Stream file is the `script` typescript the killed engine's pane
  // kept writing, so deriving it whole reproduces the log exactly, and a
  // fresh tailer is correct even though the pre-kill engine already derived
  // part of it.
  const streamPath = attemptStreamPath(
    session.runsDir,
    ticketId,
    assignment?.harness ?? "",
    null,
    false,
    true,
  );
  const logPath = join(session.runsDir, attemptLogName(ticketId, null, false));
  const exitCodePath = join(
    session.runsDir,
    attemptExitCodeName(ticketId, null, false),
  );
  const outcomePath = join(session.runsDir, attemptOutcomeName(ticketId, null, false));
  const tailer = streamPath ? startPaneStreamTail(streamPath, logPath) : null;
  let decision;
  try {
    // The adopted attempt's ending is the Attempt-ending module's one
    // decision, exactly as a live terminal-backed spawn's: a pane watch
    // (pane end against the exit-code file, pane loss without an Outcome
    // the crash signal) raced against the result-file poll, because the TUI
    // deliberately stays alive after the agent declares done (ADR-0016). An
    // exit-code file written while the engine was down resolves
    // immediately, without opening a connection.
    decision = await waitForAttemptEnding({
      watch: { kind: "pane", socketPath: session.herdrSocket, paneId: adopted.paneId },
      exitCodePath,
      outcomePath,
      validate: validateOutcome,
      crashSubject: "harness",
    });
  } finally {
    // Drained ahead of the log-tail read below, so the exit facts are
    // complete; also drained on an abandoned wait, whose return skips the
    // record but never the drain.
    if (tailer) await tailer.finish().catch(() => {});
  }
  // The adopted Attempt is over: its pane leaves herdr's agent list the way
  // a freshly launched attempt's does at its own ending (issue #94). Before
  // the abandonment checks, because an abandoned adoption closed the pane
  // and the identity must go either way.
  if (assignment?.harness) {
    releaseAttemptAgent(session.herdrSocket, adopted.paneId, assignment.harness);
  }
  // Abandoned while waiting (the human answered): the answer path owns
  // the ticket now and this finalize records nothing further.
  if (adopted.abandoned) return;
  // The answer path may have abandoned the attempt while the ending was
  // being read; the map entry is the ownership record, so a missing or
  // flagged entry means the answer path owns the ticket from here.
  const current = session.adopted.get(ticketId);
  if (!current || current.abandoned) return;
  // Ownership passes to the recorded exit: from here a later answer is
  // ordinary interrupt handling, never an abandonment.
  session.adopted.delete(ticketId);
  session.liveAttempts.clear(ticketId, attempt);
  recordAdoptedExit(session, marker, attempt, decision, logPath, outcomePath);
}

// Record one adopted attempt's exit (ADR-0014): the mirror of runTicket's
// exit tail, without the spawn-time parts. Consumes the Attempt-ending
// module's decision (the code, the already-read Outcome and the crash
// reason) rather than re-reading and re-deriving them its own way; what
// stays here is genuinely its own: the marker status write, the checkpoint
// Brief, the interrupt and the merge chaining. Mutates session state and
// emits, exactly the paths the drive's own exit handling uses.
function recordAdoptedExit(
  session: Session,
  marker: TicketMarker,
  attempt: number,
  decision: AttemptEndingDecision<Extract<OutcomeResult, { ok: true }>>,
  logPath: string,
  outcomePath: string,
): void {
  const ticketId = marker.id;
  const { code, result: outcome, crashReason } = decision;
  const outcomeExists = existsSync(outcomePath);
  const logTail = readLogTail(logPath);
  let status: TicketStatus = "in-progress";
  if (crashReason === null && outcome.ok) {
    status = outcome.outcome.status;
  }
  appendEvent(session.runsDir, ticketId, {
    at: new Date().toISOString(),
    attempt,
    kind: "exited",
    payload: { code, status, logTail, outcomeExists },
  });
  if (crashReason !== null) {
    appendEvent(session.runsDir, ticketId, {
      at: new Date().toISOString(),
      attempt,
      kind: "crash",
      payload: { code, reason: crashReason, logTail, outcomeExists },
    });
  } else {
    writeMarkerStatus(marker.file, status);
    marker.status = status;
    if (status === "checkpoint") {
      landCheckpointBrief(marker.file, outcome.ok ? outcome.outcome.brief : undefined);
    }
  }
  const log: string[] = [
    `ticket ${ticketId}: adopted attempt ${attempt} ${exitedPhrase(code)}, ` +
      `marker ${status}` +
      (crashReason !== null ? `, crash: ${crashReason}` : ""),
  ];
  const update: PoolUpdate = {
    tickets: { [ticketId]: status },
    interrupts: session.state.interrupts.filter(
      (i) => i.ticketId !== ticketId,
    ),
    log,
    ...(outcome.ok ? { outcomes: { [ticketId]: outcome.outcome } } : {}),
  };
  session.state = applyUpdate(session.state, update);
  if (crashReason !== null) {
    raiseInterrupt(session, {
      ticketId,
      kind: "crash",
      body: crashInterruptBody({ crashReason, logPath, logTail, outcomePath, outcomeExists }),
    });
  } else if (status === "checkpoint") {
    raiseCheckpoint(session, marker, attempt);
  }
  if (status === "done" && branchExists(session.cwd, branchFor(session.cwd, ticketId))) {
    // The merge chains onto the session merge chain: the drive's merges
    // wait for it and it waits for them, so two git merges never run
    // concurrently on the main checkout. The kick below runs only once the
    // chain settles, so a resumed drive's closing gate can never raise the
    // Review interrupt ahead of this merge landing.
    const worktree: WorktreeInfo = {
      path: worktreePathFor(session.cwd, ticketId),
      branch: branchFor(session.cwd, ticketId),
    };
    session.mergeLine.taken(ticketId);
    const next = session.mergeChain.then(async () => {
      // Captured inside the serialized chain, right before the merge: HEAD
      // may have moved since this ticket's attempt was adopted (another
      // merge landing first), and mergeTicket removes this branch on
      // success, so the range for a done-Notice's diff summary has to be
      // taken here or not at all.
      const beforeSha = mergeTargetSha(session);
      const merge = mergeTicket(session, marker, worktree);
      if (merge.ok) {
        session.mergeLine.settled(ticketId);
        appendEvent(session.runsDir, ticketId, {
          at: new Date().toISOString(),
          attempt,
          kind: "merged",
          payload: mergedPayload(merge),
        });
        closeAttemptTab(session, ticketId, attempt);
        session.conversations.ticketEnded(
          marker,
          branchFor(session.cwd, ticketId),
          beforeSha ? `${beforeSha}..${mergeTargetRef(session)}` : null,
        );
        session.state = applyUpdate(session.state, {
          log: [
            `ticket ${ticketId}: adopted attempt ${attempt} merged ` +
              `${branchFor(session.cwd, ticketId)} onto the working branch`,
          ],
        });
      } else {
        await handleMergeConflict(session, marker, merge, attempt);
      }
    });
    session.mergeChain = next.catch(() => {});
    void next.then(
      () => finishAdoptedFinalize(session),
      () => finishAdoptedFinalize(session),
    );
  } else {
    finishAdoptedFinalize(session);
  }
}

// The adopted finalize's last step, after its merge chain has settled: emit
// the new state, persist it, and kick a drive pass when the run had already
// settled (it was waiting quiescent on the adoption interrupt), so the
// closing gate, the ready set, and any queued answers see the attempt's
// real ending. The kick is a no-op while a drive is in flight; its boundary
// machinery picks the state up instead.
function finishAdoptedFinalize(session: Session): void {
  emitSnapshot(session, session.driving ? "running" : "quiescent");
  try {
    persist(session);
  } catch {
    // The next boundary persist (or the persistence interrupt machinery)
    // owns store failures; the finalize's record must not die on one.
  }
  kickProcessing(session);
}

// ---------------------------------------------------------------------------
// The enlisted attempt's ending (issue #101, ticket 04)
// ---------------------------------------------------------------------------

// The Assignment a ticket that stopped being an enlisted attempt runs on: the
// ordinary pool assignment for its id, with verify stripped (an enlisted id
// never fans out, `planSuperStep` says so too). Used where a pane-gone
// checkpoint hands the ticket back to the ordinary engine-launched path.
function reRunAssignment(session: Session, marker: TicketMarker): Assignment {
  const resolved = resolveTicketAssignment(marker, session.state.config, session.harnesses);
  const { verify: _verify, ...ordinary } = resolved;
  return ordinary;
}

// The Brief a pane that went before its Outcome leaves behind: what happened
// and the promise the engine keeps, that the found branch is still there.
// The operator answers and the ticket re-runs as an ordinary engine-launched
// attempt, which is exactly what the generic answer path below does.
function paneGoneBrief(session: Session, ticketId: string, branch: string): string {
  return (
    "The herdr pane this enlisted attempt was running in went away before " +
    "the agent wrote an Outcome, so the attempt is over and the engine did " +
    `not re-run it blind. The found branch ${branch} and the checkout it ` +
    "lives in were left exactly where they were. Answer resume to re-run " +
    "this ticket as an ordinary engine-launched attempt, or leave it parked " +
    "and finish the work by hand." +
    createdBranchNote(session, ticketId, branch)
  );
}

// The re-run of a created-branch enlist (spec story 11) needs the branch
// free: a Brief that offers the re-run says so up front.
function createdBranchNote(session: Session, ticketId: string, branch: string): string {
  const work = session.enlistedWork.get(ticketId);
  if (!work || work.branch !== branch || branch !== branchFor(session.cwd, ticketId)) {
    return "";
  }
  return (
    ` The enlist created ${branch} in that checkout, and a re-run needs the ` +
    "branch free: check another branch out there first, or the re-run waits " +
    "as a checkpoint until you do."
  );
}

// Whether an exit was already recorded for this attempt, so a second
// observation of the ending (a race between the runtime's watch and a moved
// pane, or a boot reconcile after a live ending) records nothing twice.
function enlistedAttemptEnded(
  session: Session,
  ticketId: string,
  attempt: number,
): boolean {
  return readEvents(session.runsDir, ticketId).some(
    (event) =>
      event.attempt === attempt &&
      (event.kind === "exited" || event.kind === "crash"),
  );
}

/**
 * Record an enlisted attempt's ending (issue #101, ticket 04). The two
 * observations the runtime races (an Outcome on disk, the pane found gone)
 * both land here; boot re-adoption lands here too, through
 * `finalizeAdoptedEnlisted`. There is no wrapper, so no exit code and no
 * Stream file: the log gets the lifecycle events only.
 *
 * A valid Outcome writes its own status, raising the ordinary checkpoint or
 * chaining the ordinary merge. A pane that went first is a checkpoint whose
 * Brief names the branch it kept, never a crash, and never a re-run: the
 * operator decides. The engine never closes the tab and never removes the
 * found directory or branch.
 */
function endEnlistedAttempt(
  session: Session,
  ticketId: string,
  ending: EnlistedEnding,
  attemptHint?: number,
): void {
  const marker = session.markers.find((candidate) => candidate.id === ticketId);
  if (!marker) return;
  if (marker.status === "done") return;
  // A re-adopted pane's ending arrives through its runtime: the adoption is
  // over with it, so a later answer to a stale interrupt abandons nothing.
  session.adopted.delete(ticketId);
  const live = session.liveAttempts.records()[ticketId];
  const attempt =
    attemptHint ?? live?.attempt ?? lastAttempt(session.runsDir, ticketId);
  if (enlistedAttemptEnded(session, ticketId, attempt)) {
    session.liveAttempts.clear(ticketId, attempt);
    return;
  }
  const outcomePath = join(session.runsDir, attemptOutcomeName(ticketId, null, false));
  const outcome = readAttemptResult(outcomePath, validateOutcome);
  const work = session.enlistedWork.get(ticketId);
  const branch = work?.branch ?? branchFor(session.cwd, ticketId);
  const paneId = live?.paneId ?? null;

  session.liveAttempts.clear(ticketId, attempt);
  // The agent identity goes at the ending, the way it goes at every other
  // ending (issue #94); the tab stays, because it was the operator's before
  // it was the pool's. Best-effort, silent.
  const harness = session.assignments.get(ticketId)?.harness;
  if (paneId !== null && harness) {
    void releasePaneAgent(session.herdrSocket, paneId, harness.toLowerCase()).catch(
      () => {},
    );
  }

  let status: TicketStatus = "in-progress";
  let code = 0;
  let crashReason: string | null = null;
  let brief: string | undefined;
  if (ending === "outcome") {
    if (outcome.ok) {
      status = outcome.outcome.status;
      brief = outcome.outcome.brief;
    } else {
      // The file was there but the validator refused it: a genuine crash,
      // the same ending an ordinary attempt's unreadable Outcome gets.
      crashReason = outcome.reason;
      code = EXIT_CODE_UNREADABLE;
    }
  } else {
    status = "checkpoint";
    code = EXIT_CODE_PANE_GONE;
    brief = paneGoneBrief(session, ticketId, branch);
    // The pane went before an Outcome, so the next Attempt is an ordinary
    // engine-launched one (the spec's answer path). It needs a real
    // Assignment and the pool's own branch naming, so the as-found record is
    // dropped here: the found branch and directory are still kept, they are
    // simply no longer the ticket's working branch.
    session.enlistedWork.delete(ticketId);
    session.assignments.set(ticketId, reRunAssignment(session, marker));
  }
  const outcomeExists = existsSync(outcomePath);
  appendEvent(session.runsDir, ticketId, {
    at: new Date().toISOString(),
    attempt,
    kind: "exited",
    payload: { code, status, logTail: [], outcomeExists },
  });
  const clearedInterrupts = session.state.interrupts.filter(
    (i) => i.ticketId !== ticketId,
  );
  if (crashReason !== null) {
    appendEvent(session.runsDir, ticketId, {
      at: new Date().toISOString(),
      attempt,
      kind: "crash",
      payload: { code, reason: crashReason, logTail: [], outcomeExists },
    });
    session.state = applyUpdate(session.state, {
      interrupts: clearedInterrupts,
      log: [
        `ticket ${ticketId}: enlisted attempt ${attempt} ` +
          `${exitedPhrase(code)}, crash: ${crashReason}`,
      ],
    });
    raiseInterrupt(session, {
      ticketId,
      kind: "crash",
      body: crashInterruptBody({ crashReason, logPath: "", logTail: [], outcomePath, outcomeExists }),
    });
    finishAdoptedFinalize(session);
    return;
  }

  writeMarkerStatus(marker.file, status);
  marker.status = status;
  if (status === "checkpoint") {
    landCheckpointBrief(marker.file, brief);
  }
  session.state = applyUpdate(session.state, {
    tickets: { [ticketId]: status },
    interrupts: clearedInterrupts,
    log: [
      `ticket ${ticketId}: enlisted attempt ${attempt} ` +
        `${exitedPhrase(code)}, marker ${status}`,
    ],
    ...(outcome.ok ? { outcomes: { [ticketId]: outcome.outcome } } : {}),
  });
  if (status === "checkpoint") {
    raiseCheckpoint(session, marker, attempt);
  }
  if (status === "done") {
    if (outcome.ok && outcome.outcome.spawn?.length) {
      session.pendingSpawns.push({
        parentId: ticketId,
        proposals: outcome.outcome.spawn,
        origin: "ticket",
      });
    }
    chainEnlistedMerge(session, marker, attempt, branch);
    return;
  }
  finishAdoptedFinalize(session);
}

// Merge a done enlisted ticket's found branch, chained onto the session merge
// chain so its git work never runs concurrently with the drive's merges
// (ADR-0014's adopted-finalize reasoning). On success the found directory and
// branch are left alone, unlike an ordinary ticket's merge; on a conflict the
// existing merge-conflict machinery takes over in the found checkout.
function chainEnlistedMerge(
  session: Session,
  marker: TicketMarker,
  attempt: number,
  branch: string,
): void {
  session.mergeLine.taken(marker.id);
  const next = session.mergeChain.then(async () => {
    const merge = mergeWithIssueAside(session, marker, branch);
    if (merge.ok) {
      session.mergeLine.settled(marker.id);
      appendEvent(session.runsDir, marker.id, {
        at: new Date().toISOString(),
        attempt,
        kind: "merged",
        payload: mergedPayload(merge),
      });
      session.state = applyUpdate(session.state, {
        log: [
          `ticket ${marker.id}: enlisted attempt ${attempt} merged ` +
            `${branch} onto the working branch`,
        ],
      });
      return;
    }
    await handleMergeConflict(session, marker, merge, attempt);
  });
  session.mergeChain = next.catch(() => {});
  void next.then(
    () => finishAdoptedFinalize(session),
    () => finishAdoptedFinalize(session),
  );
}

// The pane left herdr's listing after the Outcome had already ended the
// attempt (spec, user story 28): a trailing exit. Tidying the tab after a
// finished ticket changes nothing about the ticket, it is only recorded on
// the pool log so the run's account is complete.
function recordEnlistedTrailingExit(session: Session, ticketId: string): void {
  const marker = session.markers.find((candidate) => candidate.id === ticketId);
  if (!marker || marker.status === "in-progress") return;
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${ticketId}: herdr pane left after its outcome (trailing exit); ` +
        "the ticket is unchanged",
    ],
  });
  emitSnapshot(session, session.driving ? "running" : "quiescent");
}

// Markers dual-write: every checkpoint write is preceded by bringing the
// line-1 markers on disk into agreement with state, so the pool directory is
// always inspectable and the markers stay the shared truth.
function writeMarkers(session: Session): void {
  for (const marker of session.markers) {
    const status = session.state.tickets[marker.id];
    if (status && status !== marker.status) {
      writeMarkerStatus(marker.file, status);
      marker.status = status;
    }
  }
}

function persist(session: Session): void {
  writeMarkers(session);
  session.store.write(session.state);
}

// A persist failure retries with a short backoff a small bounded number of
// times: on success the drive continues normally, and on exhaustion the pool
// raises the run-level persistence interrupt and waits for a human with the
// store still open. A persist failure never closes the checkpoint store, and
// a boundary persist failure never reaches the drive's death path, so a
// transient database hiccup at a boundary can no longer kill the drive the
// way issue #26's stall did.
const PERSIST_RETRY_BACKOFF_MS = [50, 100, 200];

async function persistWithRetry(session: Session): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      persist(session);
      return true;
    } catch (error) {
      if (attempt >= PERSIST_RETRY_BACKOFF_MS.length) {
        raiseInterrupt(session, persistenceInterrupt(error));
        return false;
      }
      await Bun.sleep(PERSIST_RETRY_BACKOFF_MS[attempt]);
    }
  }
}

function persistenceInterrupt(error: unknown): Interrupt {
  return {
    ticketId: PERSISTENCE_TICKET_ID,
    kind: "persistence",
    body:
      "persistence is failing: the checkpoint store failed to write after " +
      `${PERSIST_RETRY_BACKOFF_MS.length + 1} attempts with backoff.\n` +
      `last error: ${error instanceof Error ? error.message : String(error)}\n` +
      "the store remains open. answer this interrupt once the store is " +
      "healthy to retry persistence and continue the run.",
  };
}

function jevNoticeLine(notice: JevNotice): string {
  return notice.kind === "recovered"
    ? "Jev answering again"
    : `Jev unavailable (${notice.cause}: ${notice.detail}); heuristics until it answers`;
}

function closeStore(session: Session): void {
  // A closed or dead drive stops the hold watch too: nothing emits for it.
  session.holdWatch.stop();
  session.jevUnsubscribe();
  if (!session.storeOpen) return;
  session.storeOpen = false;
  session.store.close();
}

// Acceptance (ADR-0004): the answer is recorded and acknowledged, nothing
// else. The `answered` event lands in the ticket log first, then the
// queued-answer record in its own persisted store. Acceptance never mutates
// state and never spawns an attempt, so it is safe mid-super-step. Processing
// is the caller's follow-up (kickProcessing), so a waiter can be registered
// between the two.
//
// Acceptance is idempotent so a client that timed out and retried is safe:
// an answer matching one already queued (same ticket, same interrupt kind,
// same payload) is acknowledged by returning the existing record, writing no
// second event or record. An answer whose interrupt is already gone is
// acknowledged the same way when the store holds its matching acceptance;
// with no pending interrupt and no matching accepted answer it errors, as
// before the split.
function acceptAnswer(
  session: Session,
  ticketId: string,
  note: string | undefined,
  approve: boolean | undefined,
): QueuedAnswer {
  const interrupt = session.state.interrupts.find(
    (i) => i.ticketId === ticketId,
  );
  if (!interrupt) {
    const prior = session.answers.latestFor(ticketId, approve);
    if (prior) return prior;
    throw new Error(`resume: no pending interrupt for ticket ${ticketId}`);
  }
  if (interrupt.kind === "review" && approve === undefined) {
    throw new Error(
      "answer: use approve() or reject() for the final review interrupt",
    );
  }
  if (interrupt.kind === "merge-approval" && approve === undefined) {
    throw new Error(
      `answer: use approve() or reject() for the merge-approval interrupt ` +
        `on ticket ${ticketId}`,
    );
  }
  const duplicate = session.answers
    .pending()
    .find(
      (a) =>
        a.ticketId === ticketId &&
        a.kind === interrupt.kind &&
        a.approve === approve,
    );
  if (duplicate) return duplicate;
  // A reject that names no ticket is genuinely invalid, so it fails here at
  // acceptance (a 400 for the caller) rather than queueing an answer that
  // would fail at processing with nobody listening. The duplicate check runs
  // first so a retry of an already-accepted reject is still acknowledged.
  if (interrupt.kind === "review" && approve === false) {
    const named = namedReviewTickets(session.markers, note);
    if (named.length === 0) throw new Error(reviewRejectUnnamedError(session.markers));
  }
  // A selection answer that names no candidate fails the same way: rejected
  // at the seam with the valid attempts named, nothing queued, nothing merged.
  if (interrupt.kind === "selection") {
    const named = parseSelectionAnswer(note);
    if (named === null || !interrupt.candidates?.includes(named)) {
      throw new Error(selectionAnswerError(interrupt, note));
    }
  }
  appendEvent(session.runsDir, ticketId, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, ticketId),
    kind: "answered",
    payload: { kind: interrupt.kind },
  });
  const record = session.answers.enqueue({
    ticketId,
    kind: interrupt.kind,
    ...(approve !== undefined ? { approve } : {}),
    ...(note !== undefined ? { note } : {}),
    at: new Date().toISOString(),
  });
  // Mid-flight acceptance is the one moment the queue changes without an
  // emit of its own, so push one: the answered-and-waiting state broadcasts
  // now rather than at the next boundary. Idle acceptance skips this, as the
  // synchronous drain and the fresh drive's first emit follow in the same
  // tick and would only flash the waiting state.
  if (session.driving) emitSnapshot(session, "running");
  return record;
}

// The processing kick, every answer path's second step. Idle: the drain
// applies the answer right away (the behaviour before the split) and a fresh
// drive starts, spawning whatever the answer made ready. In flight: the
// queued record waits for the drive loop's boundary drain. The kick is
// separate from acceptance so the answer path's waiter exists before an idle
// drain can settle it.
// The Conversation host's spawn adoption drives an idle engine the same way
// an answer's acceptance does (the Conversations ADR: a Conversation's
// spawn.json is adopted outside the drive loop's own boundary when nothing
// else will reach one).
function kickProcessing(session: Session): void {
  if (session.driving) return;
  drainAnswers(session);
  startDrive(session);
}

// The boundary drain: every queued answer is applied in submission order.
// A answer that fails processing (a review reject naming no ticket, a stale
// record whose interrupt is gone) rejects its own waiter and is consumed; it
// never takes the drive down with it. A processed answer persists the
// resulting state itself, before its record is marked processed and before
// the next super-step is scheduled, so the answer's state change is durable
// from the moment it is processed and never rests in memory only across a
// super-step.
function drainAnswers(session: Session): void {
  for (const record of session.answers.pending()) {
    const waiters = session.answerWaiters.get(record.seq) ?? [];
    session.answerWaiters.delete(record.seq);
    try {
      processAnswer(session, record);
    } catch (error) {
      session.answers.markProcessed(record.seq);
      for (const waiter of waiters) waiter.reject(error);
      continue;
    }
    // The persist precedes markProcessed, so a record marked processed
    // implies its state change is already on disk. A kill between the two
    // leaves the record pending: a restart replays it onto the rehydrated
    // state, where it either re-applies or stale-consumes. A persist failure
    // leaves the record pending the same way and propagates like any other
    // persist failure; the retry policy lives at the persist seam. The
    // failure still rejects this record's waiters before propagating: the
    // state change happened, the run is going down, and an answerer left
    // waiting on a promise nobody will ever settle hangs the client.
    try {
      persist(session);
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
      throw error;
    }
    session.answers.markProcessed(record.seq);
    for (const waiter of waiters) waiter.resolve();
  }
}

// Processing: apply one accepted answer to state and the markers. Everything
// the old answer path did except the `answered` event (written at acceptance)
// and the drive kick (the caller's: the boundary's loop continues, the idle
// path starts a fresh drive after the drain).
function processAnswer(session: Session, record: QueuedAnswer): void {
  // The match is on ticketId alone even though the queued record also knows
  // its kind: a ticket holds one pending interrupt at a time, and a record
  // only drains while that interrupt is still up, so the kind cannot differ.
  const interrupt = session.state.interrupts.find(
    (i) => i.ticketId === record.ticketId,
  );
  if (!interrupt) {
    throw new Error(`resume: no pending interrupt for ticket ${record.ticketId}`);
  }
  session.markers = loadPoolTickets(session.poolDir);
  resolveUnseenAssignments(
    session.markers,
    session.assignments,
    session.state.config,
    session.harnesses,
  );
  if (interrupt.kind === "review") {
    if (record.approve) {
      approveReview(session, interrupt, record.note);
    } else {
      rejectReview(session, interrupt, record.note);
    }
    return;
  }
  // The persistence interrupt belongs to the run, not a ticket: answering it
  // only clears it, and the resumed drive's next boundary write is the
  // retry. There is no Issue file to find for it.
  if (interrupt.kind === "persistence") {
    session.state = applyUpdate(session.state, {
      interrupts: session.state.interrupts.filter((i) => i !== interrupt),
      log: [
        `interrupt answered for ${PERSISTENCE_TICKET_ID} (persistence): ` +
          "the drive retries the checkpoint write",
      ],
    });
    return;
  }
  // A Conversation id never appears in session.markers (it has no Issue
  // file), so its merge-conflict / merge-approval answers are routed here,
  // before the marker lookup below would throw on it.
  if (
    (interrupt.kind === "merge-conflict" || interrupt.kind === "merge-approval") &&
    session.conversations.isLive(record.ticketId)
  ) {
    session.conversations.answerMerge(record.ticketId, interrupt, record.approve);
    return;
  }
  const marker = session.markers.find((m) => m.id === record.ticketId);
  if (!marker) {
    throw new Error(
      `resume: ticket ${record.ticketId} has no Issue file in ${session.issuesDir}`,
    );
  }
  if (interrupt.kind === "merge-conflict") {
    resumeMerge(session, marker, interrupt, record.note);
    return;
  }
  if (interrupt.kind === "merge-approval") {
    if (record.approve) {
      approveMerge(session, marker, interrupt, record.note);
    } else {
      rejectMerge(session, marker, interrupt, record.note);
    }
    return;
  }
  if (interrupt.kind === "selection") {
    processSelectionAnswer(session, marker, interrupt, record.note);
    return;
  }
  // Answering an adoption checkpoint interrupt abandons the re-adopted
  // attempt (ADR-0014): the pane is closed (an enlisted one is let go,
  // ADR-0021), the finalize records nothing, and the generic handling below
  // re-runs the ticket.
  if (session.adopted.has(record.ticketId)) {
    abandonAdoption(session, record.ticketId);
  }
  if (marker.status !== "done") {
    writeMarkerStatus(marker.file, "ready");
    marker.status = "ready";
  }
  if (record.note && record.note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${record.note.trim()}\n`);
  }
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      session.markers.map((m) => [m.id, m.status]),
    ),
    interrupts: session.state.interrupts.filter(
      (i) => i.ticketId !== record.ticketId,
    ),
    log: [
      `interrupt answered for ${record.ticketId} (${interrupt.kind}): ` +
        (marker.status === "done" ? "already done on disk" : "resumed"),
    ],
  });
}

// The branch this pool merges into, as a ref: the target an enlist captured
// when it moved the pool's own checkout (issue #101), else that checkout's
// HEAD, which is what every pool read before enlist existed.
function mergeTargetRef(session: Session): string {
  return session.mergeTarget ?? "HEAD";
}

// The same, as a branch name, for the branch rule and the resolver's prompt.
function mergeTargetBranch(session: Session): string {
  return session.mergeTarget ?? currentBranch(session.cwd);
}

// The merge target's commit, captured just before a merge for the range a
// done-Notice's diff summary covers. Resolved by ref, so it is right from any
// checkout of the repository, whichever one the merge then runs in.
function mergeTargetSha(session: Session): string {
  return session.git ? git(session.cwd, ["rev-parse", mergeTargetRef(session)]).out : "";
}

// Run one merge in a checkout that holds the merge target (issue #101,
// ADR-0021). Ordinarily that is the pool's own checkout, whose HEAD is the
// target. Once an enlist has moved that checkout onto a created pool branch,
// an enlisted agent is working there and the engine never moves it back: the
// merge runs in a short-lived linked worktree on the target instead, removed
// as soon as the merge has landed or failed. Git allows a branch in one
// worktree at a time, and the target is free to be checked out there
// precisely because the enlist moved the pool checkout off it. Should the
// checkout be found back on the target (the operator moved it by hand), the
// merge runs in place, as it always did.
function withMergeCheckout<T>(session: Session, body: (cwd: string) => T): T {
  if (
    session.mergeTarget === null ||
    currentBranch(session.cwd) === session.mergeTarget
  ) {
    return body(session.cwd);
  }
  const cwd = openMergeCheckout(session.cwd, session.mergeTarget);
  try {
    return body(cwd);
  } finally {
    closeMergeCheckout(session.cwd, cwd);
  }
}

// The dual-write and the agent's own edits to the canonical Issue file leave
// it dirty on the working branch and git refuses a merge that would touch a
// dirty file, so the Issue steps aside for the merge. It used to come
// straight back over whatever the merge wrote, which threw away every note
// and tick an agent had committed to its worktree copy instead of the pool's
// (issue #92): the merge commit kept them, the file the next agent reads did
// not. Now the two copies are reconciled: a three-way merge of the pool copy
// and the branch's copy against the seed the worktree was planned from, so
// an addition on either side survives and an identical addition on both
// merges clean. Line 1 is the engine's marker and always comes from the
// pool copy. Lines both sides changed differently stay in the file as
// conflict markers, recorded on the ticket log, never silently dropped.
function mergeWithIssueAside(
  session: Session,
  marker: TicketMarker,
  branch: string,
): MergeResult {
  // The pool's file of record, read before the merge: "ours" for the
  // reconcile whichever checkout the merge runs in.
  const ours = readFileSync(marker.file, "utf8");
  let merged: { result: MergeResult; theirs: string | null };
  try {
    merged = withMergeCheckout(session, (cwd) =>
      cwd === session.cwd
        ? mergeInPlace(session, marker, branch)
        : mergeInCheckout(session, cwd, marker, branch),
    );
  } catch (err) {
    // The merge checkout could not be opened: nothing merged, and the
    // conflict machinery surfaces the reason as a blocked merge the
    // operator can clear and resume.
    return {
      ok: false,
      reason: "blocked",
      conflicted: [],
      blocked: [],
      cleared: [],
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const { result, theirs } = merged;
  if (!result.ok || theirs === null) {
    // Aborted, or the branch never touched the ticket file: the pool copy
    // is the whole story.
    return result;
  }
  const reconciled = reconcileTicketFile(session, marker, branch, ours, theirs);
  writeFileSync(marker.file, reconciled.content);
  if (reconciled.conflicted) {
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "ticket-file-conflict",
      payload: {
        file: relative(session.cwd, marker.file),
        branch,
      },
    });
    session.state = applyUpdate(session.state, {
      log: [
        `${marker.id}: the pool's ticket file and the branch's copy changed ` +
          `the same lines; conflict markers left in ` +
          `${relative(session.cwd, marker.file)}`,
      ],
    });
  }
  return result;
}

// The merge in the pool's own checkout: the pool copy of the ticket file
// steps aside (git refuses a merge that would touch a dirty file) and comes
// back untouched when the branch never wrote it; when the branch did, the
// merge's write is "theirs" and the caller reconciles over it.
function mergeInPlace(
  session: Session,
  marker: TicketMarker,
  branch: string,
): { result: MergeResult; theirs: string | null } {
  const aside = `${marker.file}.pool-aside`;
  renameSync(marker.file, aside);
  const result = mergeBranch(session.cwd, branch);
  if (!result.ok || !existsSync(marker.file)) {
    renameSync(aside, marker.file);
    return { result, theirs: null };
  }
  const theirs = readFileSync(marker.file, "utf8");
  rmSync(aside, { force: true });
  return { result, theirs };
}

// The merge in the engine's merge checkout (issue #101): the pool copy is
// not in the way there, so nothing steps aside. The branch's copy of the
// ticket file is "theirs" only when the merge changed it, the same reading
// the in-place merge takes from the file it wrote.
function mergeInCheckout(
  session: Session,
  cwd: string,
  marker: TicketMarker,
  branch: string,
): { result: MergeResult; theirs: string | null } {
  const copy = join(cwd, relative(session.cwd, marker.file));
  const before = existsSync(copy) ? readFileSync(copy, "utf8") : null;
  const result = mergeBranch(cwd, branch);
  if (!result.ok || !existsSync(copy)) return { result, theirs: null };
  const after = readFileSync(copy, "utf8");
  return { result, theirs: after === before ? null : after };
}

// Splits a ticket file at its marker line: the state line the engine owns,
// and everything after it that the work adds to.
function splitMarkerLine(content: string): { line1: string; body: string } {
  const nl = content.indexOf("\n");
  return nl === -1
    ? { line1: content, body: "" }
    : { line1: content.slice(0, nl), body: content.slice(nl + 1) };
}

// The base for the reconcile: the seed planTicket kept when the branch's
// worktree was planned, or, for a worktree this engine never seeded (an
// adopted attempt from before seeds were kept), the file as committed at the
// merge base. With no base at all the pool copy stands in as the base, so the
// branch's edits land and nothing conflicts.
function ticketSeedFor(
  session: Session,
  marker: TicketMarker,
  branch: string,
  ours: string,
): string {
  const attempt = /\.attempt-(\d+)$/.exec(branch);
  const seedPath = join(
    session.runsDir,
    ticketSeedName(marker.id, attempt ? Number(attempt[1]) : null),
  );
  if (existsSync(seedPath)) return readFileSync(seedPath, "utf8");
  const base = git(session.cwd, ["merge-base", mergeTargetRef(session), branch]);
  if (base.ok) {
    const shown = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        session.cwd,
        "show",
        `${base.out}:${relative(session.cwd, marker.file)}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (shown.exitCode === 0) return shown.stdout.toString();
  }
  return ours;
}

// The three-way body merge behind mergeWithIssueAside, through
// `git merge-file`, whose exit status is the conflict count (negative on
// error, which is treated as a whole-file conflict rather than a silent
// pick of one side).
function reconcileTicketFile(
  session: Session,
  marker: TicketMarker,
  branch: string,
  ours: string,
  theirs: string,
): { content: string; conflicted: boolean } {
  if (ours === theirs) return { content: ours, conflicted: false };
  const seed = ticketSeedFor(session, marker, branch, ours);
  const mine = splitMarkerLine(ours);
  const base = splitMarkerLine(seed);
  const other = splitMarkerLine(theirs);
  if (mine.body === other.body) {
    return { content: `${mine.line1}\n${mine.body}`, conflicted: false };
  }
  const scratch = join(session.runsDir, `${marker.id}.reconcile`);
  mkdirSync(scratch, { recursive: true });
  const paths = { ours: join(scratch, "pool"), base: join(scratch, "seed"), theirs: join(scratch, "branch") };
  writeFileSync(paths.ours, mine.body);
  writeFileSync(paths.base, base.body);
  writeFileSync(paths.theirs, other.body);
  const merged = Bun.spawnSync({
    cmd: [
      "git",
      "merge-file",
      "-p",
      "-L",
      "pool (file of record)",
      "-L",
      "seed",
      "-L",
      `branch ${branch}`,
      paths.ours,
      paths.base,
      paths.theirs,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(scratch, { recursive: true, force: true });
  if (merged.exitCode < 0 || merged.exitCode > 127) {
    return {
      content:
        `${mine.line1}\n<<<<<<< pool (file of record)\n${mine.body}` +
        `=======\n${other.body}>>>>>>> branch ${branch}\n`,
      conflicted: true,
    };
  }
  return {
    content: `${mine.line1}\n${merged.stdout.toString()}`,
    conflicted: merged.exitCode > 0,
  };
}

// Resuming a merge-conflict interrupt re-attempts the merge. A human who
// resolved it by hand in the main checkout sees "Already up to date" and a
// deleted branch counts as resolved; a fresh conflict refreshes the
// interrupt and the pool stays quiescent. The ticket itself stays done: the
// work was finished, only the merge was pending.
function resumeMerge(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note?: string,
): void {
  const worktree: WorktreeInfo = ticketWorktree(session, marker);
  const branch = worktree.branch;
  const beforeSha = mergeTargetSha(session);
  const result = mergeWithIssueAside(session, marker, branch);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  if (!result.ok) {
    recordFailedMerge(session, marker.id, lastAttempt(session.runsDir, marker.id), result);
    session.state = applyUpdate(session.state, {
      interrupts: [
        ...session.state.interrupts.filter((i) => i !== interrupt),
        mergeConflictInterrupt(session, marker, result),
      ],
      log: [
        `merge re-attempt for ${marker.id} ` +
          (result.reason === "blocked" ? "is still blocked" : "still conflicts"),
      ],
    });
    return;
  }
  removeMergeWorktree(session, marker, worktree);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, marker.id),
    kind: "merged",
    payload: mergedPayload(result),
  });
  if (!session.enlistedWork.has(marker.id)) closeAttemptTabs(session, marker.id);
  session.conversations.ticketEnded(marker, branch, beforeSha ? `${beforeSha}..${mergeTargetRef(session)}` : null);
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `interrupt answered for ${marker.id} (merge-conflict): merge landed` +
        (result.detail.endsWith("is gone") ? ` (${result.detail})` : ""),
    ],
  });
}

// The driver name must match a command stub under each harness's commands
// directory (~/.config/opencode/command, ~/.claude/commands); the stub that
// exists on both is resolving-merge-conflicts. A bare "resolve" matched
// nothing on opencode, so every conflict there took the manual path.
const RESOLVER_DRIVER = "resolving-merge-conflicts";

interface ResolverSpec {
  harness: string;
  model: string;
}

interface ResolverAttempt {
  resolved: boolean;
  note: string;
}

// The resolver agent for a conflicting merge: the harness comes from
// console.json's resolver= key, falling back to the Machine defaults, with
// the model resolved the same way. An explicit "none" (or empty) resolver
// opts out of the resolver, so the conflict takes the manual path; an explicit
// resolver that names an unknown harness fails fast, matching how a ticket's
// unknown harness is rejected. No configured resolver at all also means the
// manual path. The object form { harness, model } pins the resolver's own
// model: a model name belongs to one harness, so a resolver on a different
// harness than the defaults' must not inherit the defaults' model.
function resolveResolver(session: Session): ResolverSpec | null {
  const config = session.state.config;
  const spec =
    typeof config.resolver === "string" || config.resolver == null
      ? { harness: config.resolver, model: undefined }
      : config.resolver;
  const explicit = spec.harness?.trim();
  if (explicit === "" || explicit === "none") return null;
  let harness = explicit;
  let model = spec.model?.trim() || config.defaults?.model;
  if (!harness || !model) {
    // The Machine defaults (issue #121), with the legacy `~/.issue-runner`
    // file filled in behind them field by field: a machine that never wrote
    // the new file resolves exactly as it always did.
    const machine = readMachineDefaults(session.machineDefaults);
    if (!harness) harness = machine.harness;
    if (!model) model = machine.model;
  }
  if (!harness || !model) return null;
  if (!session.harnesses[harness]) {
    if (explicit) {
      throw new Error(
        `pool config: resolver names unknown harness '${explicit}'. ` +
          `Known: ${Object.keys(session.harnesses).sort().join(", ")}`,
      );
    }
    return null;
  }
  return { harness, model };
}

// The resolver's result: a `resolved` boolean and an optional note. Not an
// Outcome (no status, no summary): the resolver's ending is an approval or a
// manual-merge interrupt, never a ticket status. The Attempt-run module's
// reader supplies the missing-file and unparseable preamble.
function validateResolution(
  parsed: unknown,
): { ok: true; resolved: boolean; note?: string } | ReadFailure {
  const result = parsed as { resolved?: unknown; note?: unknown } | null;
  if (typeof result?.resolved !== "boolean") {
    return { ok: false, reason: "resolver outcome has no resolved boolean" };
  }
  return {
    ok: true,
    resolved: result.resolved,
    ...(typeof result.note === "string" ? { note: result.note } : {}),
  };
}

// A conflict hands the conflicted state to the resolver agent: the resolver
// reproduces the conflict in the parked worktree, stages a resolution without
// committing, and the engine routes the result. A resolved attempt becomes an
// approval interrupt (authority stays with the human); a failed or absent one
// takes the manual path with the failure noted. The Conversation host
// reuses it verbatim for a Conversation's conflicted End, with a
// TicketMarker-shaped record synthesized from the Conversation's id, file
// and branch: the function reads only `marker.id` (for
// worktreePathFor/branchFor) and `marker.file`/`marker.title` (surfaced in
// the resolver's prompt), never the pool's own markers array.
async function handleMergeConflict(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attempt: number,
): Promise<void> {
  // However the handling ends (an interrupt raised on every path, or a
  // throw), the engine is finished with this merge: the Merge queue reads
  // the interrupt from here on, or a stall if there is none.
  try {
    await routeMergeConflict(session, marker, result, attempt);
  } finally {
    session.mergeLine.settled(marker.id);
  }
}

async function routeMergeConflict(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attempt: number,
): Promise<void> {
  recordFailedMerge(session, marker.id, attempt, result);
  // A blocked merge never started (#92): there is no conflicted state for
  // a resolver to reproduce (it would only report "already up to date"),
  // so it goes straight to the operator, who clears the files in the way
  // and resumes.
  if (result.reason === "blocked") {
    raiseInterrupt(session, mergeConflictInterrupt(session, marker, result));
    return;
  }
  const worktree: WorktreeInfo = ticketWorktree(session, marker);
  const resolver = resolveResolver(session);
  if (!resolver) {
    raiseInterrupt(
      session,
      manualMergeInterrupt(
        session,
        marker,
        result,
        "no resolver harness available (set console.json resolver= or a " +
          "~/.issue-runner default)",
      ),
    );
    return;
  }
  // The head of the Merge queue is resolving from here, before the resolver
  // is live: a terminal launch takes seconds, and a card reading queued (or
  // stalled) through them would be the blindness issue #129 names.
  session.mergeLine.resolving(marker.id);
  emitSnapshot(session, session.settledPhase ?? "running");
  const resolverAttempt = await runResolver(
    session,
    marker,
    worktree,
    resolver,
    result,
  );
  if (resolverAttempt.resolved) {
    raiseInterrupt(
      session,
      approvalInterrupt(session, marker, result, resolverAttempt.note),
    );
  } else {
    // Discard whatever the resolver left in the worktree, restoring the
    // parked branch, before taking the manual path.
    git(worktree.path, ["merge", "--abort"]);
    raiseInterrupt(
      session,
      manualMergeInterrupt(session, marker, result, resolverAttempt.note),
    );
  }
}

async function runResolver(
  session: Session,
  marker: TicketMarker,
  worktree: WorktreeInfo,
  resolver: ResolverSpec,
  result: MergeResult,
): Promise<ResolverAttempt> {
  // The resolver's files carry the resolver suffix, the result included,
  // all named through the events module (ADR-0003). The resolver event
  // below is this run's attempt bump, and it is also what the resolver
  // log's rotation keys on, so the well-known log rotates here, before the
  // event lands, or the previous run's log would take this run's number.
  const attempt = nextAttempt(session.runsDir, marker.id);
  rotateAttemptLog(
    session.runsDir,
    marker.id,
    join(session.runsDir, attemptLogName(marker.id, null, true)),
    "resolver",
  );
  const outcomePath = join(
    session.runsDir,
    attemptOutcomeName(marker.id, null, true),
  );
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "resolver",
    payload: { files: result.conflicted, cwd: worktree.path, branch: worktree.branch },
  });
  const prompt = buildResolverPrompt({
    id: marker.id,
    worktree: worktree.path,
    branch: worktree.branch,
    workingBranch: mergeTargetBranch(session),
    files: result.conflicted,
    outcomePath,
  });
  // The resolver's run is the Attempt-run module's (ADR-0014): every spawn
  // site shares one code path, and a terminal-backed pool opens the
  // resolver its own named tab too. The resolver event above stays the
  // run's own record; it records no exited or crash event, as before.
  const run = await runAttempt(
    attemptEnvOf(session),
    {
      id: marker.id,
      issuePath: marker.file,
      title: marker.title,
      body: prompt,
      driver: RESOLVER_DRIVER,
      harness: resolver.harness,
      model: resolver.model,
      cwd: worktree.path,
      branch: worktree.branch,
      attempt,
      naming: { attempt: null, resolver: true },
      rotate: "none",
      fallback: "headless",
      prompt: { kind: "driver" },
      crashSubject: "resolver",
      events: { kind: "spawned-only" },
    },
    validateResolution,
  );
  if (run.ok && run.result.resolved) {
    return { resolved: true, note: run.result.note || "(resolver gave no note)" };
  }
  const note = !run.ok && run.code !== 0
    ? run.crashReason
    : run.result.ok
      ? run.result.note || "resolver reported no resolution"
      : "resolver produced no resolution";
  return { resolved: false, note };
}

function approvalInterrupt(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attemptNote: string,
): Interrupt {
  return {
    ticketId: marker.id,
    kind: "merge-approval",
    body:
      `The resolver agent resolved the merge conflict for ticket ${marker.id}.\n` +
      `It attempted: ${attemptNote}\n` +
      `conflicted files: ${result.conflicted.join(", ") || "(none listed)"}\n` +
      `the resolution is staged on branch ${ticketWorktree(session, marker).branch}; approve to ` +
      "commit it and continue, or reject to resolve by hand.",
  };
}

// Approving commits the resolver's staged resolution (an in-progress merge in
// the worktree becomes a merge commit on the branch, so the follow-up merge
// fast-forwards), then the pool continues automatically.
function approveMerge(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note?: string,
): void {
  const worktree: WorktreeInfo = ticketWorktree(session, marker);
  commitMerge(worktree);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  const beforeSha = mergeTargetSha(session);
  const result = mergeWithIssueAside(session, marker, worktree.branch);
  if (!result.ok) {
    recordFailedMerge(session, marker.id, lastAttempt(session.runsDir, marker.id), result);
    session.state = applyUpdate(session.state, {
      interrupts: [
        ...session.state.interrupts.filter((i) => i !== interrupt),
        manualMergeInterrupt(
          session,
          marker,
          result,
          "the resolver's resolution did not merge cleanly on approval",
        ),
      ],
      log: [
        `merge after resolver approval for ${marker.id} ` +
          (result.reason === "blocked" ? "is blocked" : "still conflicts"),
      ],
    });
    return;
  }
  removeMergeWorktree(session, marker, worktree);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, marker.id),
    kind: "merged",
    payload: mergedPayload(result),
  });
  if (!session.enlistedWork.has(marker.id)) closeAttemptTabs(session, marker.id);
  session.conversations.ticketEnded(
    marker,
    worktree.branch,
    beforeSha ? `${beforeSha}..${mergeTargetRef(session)}` : null,
  );
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `interrupt answered for ${marker.id} (merge-approval): resolver ` +
        "resolution committed",
    ],
  });
}

// Rejecting the resolver's staged resolution abandons the merge and reopens
// the ticket (ADR-0014): the staged work is discarded, the parked branch is
// restored for the re-run to reuse the way a review-reject re-run does, and
// the ticket no longer counts as done, which is what lifts the merge hold.
// The rejection note rides along as a durable resume note on the Issue.
function rejectMerge(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note?: string,
): void {
  const worktree: WorktreeInfo = ticketWorktree(session, marker);
  git(worktree.path, ["merge", "--abort"]);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  writeMarkerStatus(marker.file, "ready");
  marker.status = "ready";
  session.state = applyUpdate(session.state, {
    tickets: { [marker.id]: "ready" as const },
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `merge-approval rejected for ${marker.id}: staged resolution ` +
        "discarded, ticket reopened for a re-run",
    ],
  });
}

// ---------------------------------------------------------------------------
// Grading (ticket 03): engine-run grader tickets
// ---------------------------------------------------------------------------

// The grader's driver name, under the same contract as the resolver's: a real
// harness invokes it as a command stub, so a pool that grades on real
// harnesses needs a `verify` command written where the harness looks for
// commands. The grading instructions travel in the prompt body regardless;
// the fakes in the engine suite never see the driver name.
const GRADER_DRIVER = "verify";

// The head-to-head judge's driver name, same contract as the grader's
// (ticket 06).
const HEAD_TO_HEAD_DRIVER = "head-to-head";

// One assessment of one attempt (the Grade in CONTEXT.md): the score, the
// verdict, and short reasons, landed on the graded attempt's record. An agent
// grader carries it in its Outcome JSON under a `grade` key; a Jev-graded
// Grade is composed in engine code (ADR-0023). This is the wire shape the
// Console type-imports (wire.ts), so the three provenance fields a Jev Grade
// adds are declared here once and are optional: an agent-graded Grade has
// none and validates exactly as before.
export interface Grade {
  score: number;
  verdict: "pass" | "flag";
  reasons: string;
  /** The rubric version that composed it, e.g. `jev-grader-rubric/2026-09-20.1`. */
  rubric?: string;
  /** The model the API reported it answered with. */
  model?: string;
  /** Which Evidence budget the Grade came from: the base one or the widening re-ask. */
  evidenceBudget?: EvidenceBudget;
}

/** The two Evidence budgets a Jev Grade can record. */
export type EvidenceBudget = "base" | "widened";

// The attempt log handed to a grader is capped at roughly 20k tokens, at the
// usual ~4 characters per token.
const GRADER_TRIM_CHARS = 80_000;

// Grader ticket ids are the engine's own convention: `<build>-grader-<N>`,
// N one-based positions in the build ticket's fan-out, deterministic so a
// re-round rewrites the same file (rebinding it to the round's new attempt)
// and a console.json assign entry can name a grader before it exists. A
// human ticket literally named like this would be mistaken for a grader; the
// convention is engine-owned, so pools do not write such ids.
function graderIdFor(buildId: string, index: number): string {
  return `${buildId}-grader-${index}`;
}

function parseGraderId(id: string): { buildId: string; attempt: number } | null {
  const match = /^(.+)-grader-(\d+)$/.exec(id);
  if (!match) return null;
  return { buildId: match[1], attempt: Number(match[2]) };
}

// The head-to-head ticket id is the engine's convention too: exactly one per
// build ticket, `<build>-head-to-head`, deterministic so a re-round rewrites
// the same file (rebinding it to the round's top two) and a console.json
// assign entry can name it before it exists. Same engine-owned convention
// note as the grader ids: pools do not write such ids (ticket 06).
function headToHeadIdFor(buildId: string): string {
  return `${buildId}-head-to-head`;
}

function parseHeadToHeadId(id: string): string | null {
  return id.endsWith("-head-to-head")
    ? id.slice(0, -"-head-to-head".length)
    : null;
}

// The build ticket behind an engine-written ticket id, grader or head-to-head;
// null for an ordinary ticket the pool's own directory defines. Exported for
// Reassign (issue #126), which must never offer an engine-owned ticket to the
// operator: the one place the two id conventions are decoded, rather than the
// Console keeping its own copy of the regexes.
export function engineTicketBuildId(id: string): string | null {
  return parseGraderId(id)?.buildId ?? parseHeadToHeadId(id);
}

// An engine-run ticket's harness and model resolve through the ordinary
// assign machinery (this covers grader tickets and the head-to-head ticket):
// an assign entry for the ticket's own id overrides field-wise, and what it
// does not override comes from the build ticket's resolved assignment rather
// than the pool defaults, so an engine-run judge can be a different agent
// than its builder with zero new config. The drivers are meaningless (the
// prompt is engine-built) and an engine-run judge is never itself a verify
// ticket, so neither carries over. An unknown harness fails fast with the
// same error a ticket's would, instead of an opaque crash mid-judgment.
function resolveEngineTicketAssignment(
  config: PoolConfig,
  ticketMarker: TicketMarker,
  build: Assignment,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  const assign = config.assign?.[ticketMarker.id];
  return resolveAssignment({
    subject: `pool config: ticket ${ticketMarker.id}`,
    // Only harness and model may be overridden: the drivers stay the build's.
    request: assign ? { harness: assign.harness, model: assign.model } : undefined,
    inherited: build,
    defaults: config.defaults,
    strict: false,
    verify: false,
    harnesses,
  });
}

// A spawned ticket's assignment (ADR-0010): the ordinary assign machinery
// with the proposing ticket standing in ahead of the pool defaults. An assign
// entry for the spawned id overrides field-wise, everything else inherits
// the parent, so a discovery chain runs on its parent's harness with zero
// new config; a field the parent leaves empty (an enlisted Conversation
// names no model, issue #118) falls through to the defaults. verify is
// honored like any ordinary ticket's (a spawned ticket is ordinary in every
// way): an operator may set verify on a spawned id before it schedules.
function resolveSpawnedTicketAssignment(
  config: PoolConfig,
  marker: TicketMarker,
  parent: Assignment,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  return resolveAssignment({
    subject: `pool config: ticket ${marker.id}`,
    request: config.assign?.[marker.id],
    inherited: parent,
    defaults: config.defaults,
    strict: false,
    verify: true,
    harnesses,
  });
}

// The shared resolution pass (ADR-0010, ADR-0018): resolves every marker id
// not already present in `assignments`, so the caller decides what counts as
// already resolved. At boot (resolveUnseenAssignments below) that is nothing,
// starting from an empty map. At a config reload (resolveBoundaryAssignments
// below) it is every in-flight id, seeded with its frozen Assignment so an
// Attempt already running never sees its Assignment move. Ordinary tickets
// resolve from the config; grader and head-to-head ids resolve from their
// build ticket's assignment (a stale engine card on disk never fails pool
// start, and an engine-run judge inherits its builder with zero new config);
// spawned ids resolve from their spawned-by parent, iterating until the map
// stops growing so a spawn chain (01-spawn-1-spawn-1) resolves however deep
// it nests, and a not-yet-resolved parent (in-flight and frozen, or simply
// later in file order) is waited for rather than treated as absent. Every
// resolution in the pass reads the same `config`, so a build ticket frozen by
// an in-flight Attempt hands its graders the pre-reload Assignment, exactly
// as a ticket resolved this pass hands its spawns the post-reload one.
// loadPoolMarkers guarantees a spawned id's parent exists, so only a forged
// spawned-by cycle (or every id in a cycle being simultaneously in-flight,
// which cannot happen) can leave an id unresolved, and that fails here with a
// clear error instead of an undefined crash later.
function resolveAssignmentsInto(
  markers: TicketMarker[],
  assignments: Map<string, Assignment>,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
  // Reassign (issue #126) wants to tell the operator which layer supplied
  // each field. It is filled here rather than by a second pass of its own so
  // the dispatch below (grader, spawned, enlisted, ordinary) is written once
  // and a provenance answer can never disagree with the value beside it.
  sources?: Map<string, AssignmentSources>,
): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const marker of markers) {
      if (assignments.has(marker.id)) continue;
      const graderBuild = engineTicketBuildId(marker.id);
      if (graderBuild) {
        const build = assignments.get(graderBuild);
        // The build not resolved yet is not the build absent: a grader whose
        // build ticket is in the pool waits for a later sweep and inherits
        // from it, whatever the file order; only a stale card whose build is
        // gone from the pool resolves as an ordinary ticket, as before.
        if (!build && markers.some((m) => m.id === graderBuild)) continue;
        assignments.set(
          marker.id,
          build
            ? resolveEngineTicketAssignment(config, marker, build, harnesses)
            : resolveTicketAssignment(marker, config, harnesses),
        );
        const assign = config.assign?.[marker.id];
        sources?.set(
          marker.id,
          resolveAssignmentSources({
            // The same narrowed request the engine resolver takes: a judge
            // may override harness and model, never the build's drivers.
            request: build
              ? assign
                ? { harness: assign.harness, model: assign.model }
                : undefined
              : assign,
            ...(build ? { inherited: build } : {}),
            ...(config.defaults ? { defaults: config.defaults } : {}),
          }),
        );
        progressed = true;
        continue;
      }
      if (marker.spawnedBy) {
        const parent = assignments.get(marker.spawnedBy);
        if (!parent) continue;
        assignments.set(
          marker.id,
          resolveSpawnedTicketAssignment(config, marker, parent, harnesses),
        );
        sources?.set(
          marker.id,
          resolveAssignmentSources({
            request: config.assign?.[marker.id],
            inherited: parent,
            ...(config.defaults ? { defaults: config.defaults } : {}),
          }),
        );
        progressed = true;
        continue;
      }
      if (marker.enlistedFrom !== undefined) {
        // An enlisted ticket's Assignment is as found (issue #101): the
        // harness comes from the pool config after a restart (the as-found
        // facts live only in the ticket file's prose), model unknown and
        // drivers default, and verify is stripped so the ticket still
        // re-adopts at boot and never fans out.
        const resolved = resolveTicketAssignment(marker, config, harnesses);
        assignments.set(marker.id, {
          harness: resolved.harness,
          model: "",
          drivers: DEFAULT_DRIVERS,
        });
        // Only the harness came through the config; the other two are the
        // as-found rule above, so no layer of the file supplied them.
        sources?.set(marker.id, {
          harness: resolveAssignmentSources({
            request: config.assign?.[marker.id],
            ...(config.defaults ? { defaults: config.defaults } : {}),
          }).harness,
          model: "unset",
          drivers: "default",
        });
        progressed = true;
        continue;
      }
      assignments.set(marker.id, resolveTicketAssignment(marker, config, harnesses));
      sources?.set(
        marker.id,
        resolveAssignmentSources({
          request: config.assign?.[marker.id],
          ...(config.defaults ? { defaults: config.defaults } : {}),
        }),
      );
      progressed = true;
    }
  }
  const unresolved = markers.filter((m) => !assignments.has(m.id));
  if (unresolved.length > 0) {
    throw new Error(
      `pool config: cannot resolve assignments for ` +
        `${unresolved.map((m) => m.id).join(", ")} (a spawned-by cycle?)`,
    );
  }
}

/**
 * Every ticket's Assignment as a given config resolves it, with the layer
 * each field came from beside it (Reassign, issue #126). The same pass the
 * engine runs at boot and at a Config reload, over a config the caller
 * supplies rather than the session's: the Console resolves the file as it
 * stands now so a saved Reassign shows on the card before the next boundary,
 * and dry-runs a proposed file before writing it.
 *
 * `seed` is what reloadConfigAtBoundary seeds its own dry run with: the
 * frozen record of every ticket the reload will not re-resolve. A seeded id
 * is left exactly as given and its children inherit from it, so the Console
 * shows what the engine will use rather than what the file alone would say.
 * A seeded id gets no `sources` entry, because no layer of the file supplied
 * it.
 *
 * Throws exactly what the engine's own reload would: an unknown harness or an
 * invalid verify anywhere in the pool rejects the whole resolution, which is
 * the point of dry-running it.
 */
export function resolvePoolAssignments(
  markers: TicketMarker[],
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
  seed?: ReadonlyMap<string, Assignment>,
): { assignments: Map<string, Assignment>; sources: Map<string, AssignmentSources> } {
  const assignments = new Map<string, Assignment>(seed ?? []);
  const sources = new Map<string, AssignmentSources>();
  resolveAssignmentsInto(markers, assignments, config, harnesses, sources);
  return { assignments, sources };
}

// Resolution for marker ids the assignment map does not know yet, run once
// at pool start against an empty map.
function resolveUnseenAssignments(
  markers: TicketMarker[],
  assignments: Map<string, Assignment>,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
): void {
  resolveAssignmentsInto(markers, assignments, config, harnesses);
}

// ---------------------------------------------------------------------------
// Config reload (ADR-0018)
// ---------------------------------------------------------------------------

// The three keys the reload touches. Everything else on PoolConfig
// (roster, agents, selection, terminal, port) stays exactly as it was at
// boot, whatever the file says, for the life of the run.
const CONFIG_SLICE_KEYS = ["defaults", "assign", "resolver"] as const;

// Parses only the assignment slice out of a console.json body: defaults,
// assign, resolver. Deliberately does not validate selection or terminal
// (readConfig's job, boot-only) — an edit to a field the reload never
// touches must never block an otherwise-good defaults/assign/resolver edit.
function parseConfigSlice(
  raw: string,
  poolDir: string,
): Pick<PoolConfig, "defaults" | "assign" | "resolver"> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `pool config: ${join(poolDir, "console.json")} must be a JSON object`,
    );
  }
  return {
    defaults: parsed.defaults,
    assign: parsed.assign,
    resolver: parsed.resolver,
  };
}

// Which of the three slice keys actually changed, by value: a file rewritten
// byte-for-byte differently but with the same defaults/assign/resolver (say,
// only its port changed) reloads nothing and logs nothing.
function changedSliceKeys(previous: PoolConfig, next: PoolConfig): string[] {
  return CONFIG_SLICE_KEYS.filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
  );
}

// The wire-shaped record a `reassigned` event's from/to carries: AssignmentView
// plus verify, since a ticket's reassignment forensics are incomplete without
// it even though verify sits outside the Assignment concept proper.
function assignmentEventPayload(
  assignment: Assignment,
): { harness: string | null; model: string | null; drivers: string; verify?: number } {
  return {
    ...assignmentViewOf(assignment),
    ...(assignment.verify != null ? { verify: assignment.verify } : {}),
  };
}

function logConfigReloadRejected(session: Session, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  session.state = applyUpdate(session.state, {
    log: [`config reload rejected: ${message}`],
  });
}

// The super-step boundary's config reload (ADR-0018): re-reads console.json,
// and when its assignment slice (defaults, assign, resolver) changed, dry-run
// resolves every reassignable ticket before committing anything. "Reassignable"
// is every marker except a ticket with an Attempt in flight across the
// boundary — today that is only a terminal-backed attempt re-adopted at boot
// (session.adopted): the drive loop always awaits a super-step's ordinary
// attempts in full before looping back here, so nothing else can still be
// running at this seam. A done ticket is reassignable too, by the letter of
// ADR-0018: it simply resolves to whatever the new config would have given
// it, the same as any other not-in-flight ticket, which is what lets a
// grader, head-to-head, or spawned ticket adopted after it finished inherit
// the post-reload value rather than the value frozen at its own now-past
// run. A parse failure or a resolution failure (unknown harness, bad verify)
// rejects the whole reload atomically: the previous config stands, and one
// pool-log line names the cause. The same raw file content is never logged
// twice, whether it was accepted, rejected, or simply unchanged:
// session.lastConfigText tracks the last text considered at any boundary, so
// an unchanged file costs nothing beyond the one read.
function reloadConfigAtBoundary(session: Session): void {
  const raw = readOptional(join(session.poolDir, "console.json"));
  if (raw === session.lastConfigText) return;
  session.lastConfigText = raw;

  let slice: Pick<PoolConfig, "defaults" | "assign" | "resolver">;
  try {
    slice = raw === null ? {} : parseConfigSlice(raw, session.poolDir);
  } catch (error) {
    logConfigReloadRejected(session, error);
    return;
  }

  const candidate: PoolConfig = {
    ...session.state.config,
    defaults: slice.defaults,
    assign: slice.assign,
    resolver: slice.resolver,
  };
  const changed = changedSliceKeys(session.state.config, candidate);
  if (changed.length === 0) return;

  // The dry run: seed every in-flight ticket's frozen Assignment so the pass
  // never recomputes it, then resolve everything else fresh against the
  // candidate. A throw here (unknown harness, bad verify, a forged
  // spawned-by cycle) leaves session.assignments and session.state.config
  // untouched — the candidate map is scratch until this call returns clean.
  const resolved = new Map<string, Assignment>();
  for (const id of [...session.adopted.keys(), ...session.enlistedWork.keys()]) {
    const frozen = session.assignments.get(id);
    if (frozen) resolved.set(id, frozen);
  }
  try {
    resolveAssignmentsInto(session.markers, resolved, candidate, session.harnesses);
  } catch (error) {
    logConfigReloadRejected(session, error);
    return;
  }

  // Accepted: commit the candidate config and the freshly resolved
  // assignments together, then record a `reassigned` event on every ticket
  // whose resolved Assignment (harness/model/drivers — the Assignment
  // proper, not verify) moved. In-flight tickets were seeded from their own
  // prior entry above, so `before` and `after` are always identical there
  // and nothing is ever logged for them.
  const previous = session.assignments;
  session.assignments = resolved;
  session.state = applyUpdate(session.state, {
    config: candidate,
    log: [`config reloaded: ${changed.join(", ")}`],
  });
  for (const marker of session.markers) {
    const before = previous.get(marker.id);
    const after = resolved.get(marker.id);
    if (!before || !after) continue;
    if (
      before.harness === after.harness &&
      before.model === after.model &&
      before.drivers === after.drivers
    ) {
      continue;
    }
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      // lastAttempt, not nextAttempt: a reassigned event tags the ticket's
      // current state, the way spawn-adopted and spawn-rejected already do,
      // rather than reserving an attempt slot no real run will ever fill —
      // that would shift every later attempt number the moment a boundary
      // reloads with nothing ready to run yet.
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "reassigned",
      payload: {
        from: assignmentEventPayload(before),
        to: assignmentEventPayload(after),
      },
    });
  }
}

// The grader's outcome: the standard contract plus a validated grade.
// Anything that is not a valid grade is unusable rather than a low score or
// a silent pass, so a broken grader can never decide the build ticket's
// fate (the re-spawn that follows is ticket 07's machinery). A checkpoint
// outcome is unusable too: the grader's contract is one done outcome
// carrying its grade, and the engine never honors a grader's pause. The
// Attempt-run module's reader supplies the missing-file and unparseable
// preamble; this validates one parse.
function validateGrade(
  parsed: unknown,
): { ok: true; outcome: Outcome; grade: Grade } | ReadFailure {
  const base = validateOutcome(parsed);
  if (!base.ok) return base;
  if (base.outcome.status !== "done") {
    return { ok: false, reason: "grader outcome is a checkpoint, not a grade" };
  }
  const grade = (
    parsed as {
      grade?: {
        score?: unknown;
        verdict?: unknown;
        reasons?: unknown;
        rubric?: unknown;
        model?: unknown;
        evidenceBudget?: unknown;
      };
    }
  )?.grade;
  if (typeof grade !== "object" || grade === null) {
    return { ok: false, reason: "outcome carries no grade object" };
  }
  if (
    typeof grade.score !== "number" ||
    !Number.isFinite(grade.score) ||
    grade.score < 0 ||
    grade.score > 10
  ) {
    return { ok: false, reason: "grade has no score in 0..10" };
  }
  if (grade.verdict !== "pass" && grade.verdict !== "flag") {
    return { ok: false, reason: "grade verdict is not pass or flag" };
  }
  if (typeof grade.reasons !== "string") {
    return { ok: false, reason: "grade has no reasons string" };
  }
  // Provenance (ADR-0023) is optional: an agent grader writes none and the
  // Grade validates unchanged. When a Jev Grade does carry the three fields,
  // they pass through so the graded event keeps them.
  const valid: Grade = {
    score: grade.score,
    verdict: grade.verdict,
    reasons: grade.reasons,
  };
  if (typeof grade.rubric === "string") valid.rubric = grade.rubric;
  if (typeof grade.model === "string") valid.model = grade.model;
  if (grade.evidenceBudget === "base" || grade.evidenceBudget === "widened") {
    valid.evidenceBudget = grade.evidenceBudget;
  }
  return { ok: true, outcome: base.outcome, grade: valid };
}

// The attempt log's tail, capped at about 20k tokens, so a huge log cannot
// blow the grader's window. A trimmed copy opens with a notice naming the
// cut, so the grader can say in its reasons that the log it saw was
// trimmed; a log within the budget passes through whole.
function trimTail(text: string): string {
  if (text.length <= GRADER_TRIM_CHARS) return text;
  let tail = text.slice(-GRADER_TRIM_CHARS);
  const newline = tail.indexOf("\n");
  if (newline > -1 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return (
    `[log trimmed to the last ~20k tokens; ${tail.length} of ` +
    `${text.length} characters shown]\n${tail}`
  );
}

// The attempt's work as a diff: the attempt branch against the commit it was
// cut from, so sibling merges onto the working branch during the fan-out
// never leak into one attempt's grade.
function attemptDiff(
  session: Session,
  buildId: string,
  attempt: number,
): string {
  if (!session.git) return "(no diff: the pool does not run in git)\n";
  const branch = branchFor(session.cwd, buildId, attempt);
  if (!branchExists(session.cwd, buildId, attempt)) {
    return `(no diff: no attempt branch ${branch})\n`;
  }
  const base = git(session.cwd, ["merge-base", "HEAD", branch]);
  if (!base.ok) {
    return "(no diff: no common ancestor with the attempt branch)\n";
  }
  const diff = git(session.cwd, ["diff", `${base.out}..${branch}`]);
  if (!diff.ok) return "(no diff: git diff failed)\n";
  return diff.out;
}

// The Attempt diff split into its text and why there is none, the shape the
// Evidence builder wants: `-U0` changed lines on the base budget, context
// lines on the widening re-ask (ADR-0023). The full-context variant exists
// only for that re-ask; the grader tickets keep their own `attemptDiff`.
function attemptDiffParts(
  session: Session,
  buildId: string,
  attempt: number,
  noContext: boolean,
): { diff: string; reason: string | null } {
  if (!session.git) return { diff: "", reason: "the pool does not run in git" };
  const branch = branchFor(session.cwd, buildId, attempt);
  if (!branchExists(session.cwd, buildId, attempt)) {
    return { diff: "", reason: `no attempt branch ${branch}` };
  }
  const base = git(session.cwd, ["merge-base", "HEAD", branch]);
  if (!base.ok) {
    return { diff: "", reason: "no common ancestor with the attempt branch" };
  }
  const args = ["diff", ...(noContext ? ["-U0"] : []), `${base.out}..${branch}`];
  const diff = git(session.cwd, args);
  if (!diff.ok) return { diff: "", reason: "git diff failed" };
  return { diff: diff.out, reason: null };
}

// The attempt's Outcome summary, the agent's claim about its own work, read
// from the attempt-numbered outcome file. Never the whole outcome: only the
// summary is Evidence.
function attemptOutcomeSummary(
  session: Session,
  buildId: string,
  attempt: number,
): string {
  const raw = readOptional(
    join(session.runsDir, attemptOutcomeName(buildId, attempt, false)),
  );
  if (raw === null) return "";
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown };
    return typeof parsed?.summary === "string" ? parsed.summary : "";
  } catch {
    return "";
  }
}

// One Attempt's Evidence at one budget (ADR-0023, REPORT.md section 2): the
// Ticket text, the summary claim, the changed-lines or full-context diff, and
// the ANSI-stripped log tail, all through the pure builder.
function buildAttemptEvidence(
  session: Session,
  build: TicketMarker,
  attempt: number,
  widened: boolean,
): ReturnType<typeof buildEvidence> {
  const { diff, reason } = attemptDiffParts(session, build.id, attempt, !widened);
  return buildEvidence({
    ticket: readOptional(build.file) ?? "",
    summary: attemptOutcomeSummary(session, build.id, attempt),
    diff,
    diffReason: reason,
    log:
      readOptional(
        join(session.runsDir, attemptLogName(build.id, attempt, false)),
      ) ?? "(no attempt log was recorded)\n",
    widened,
  });
}

// The graded event's payload: the Grade plus whichever provenance fields it
// carries. An agent-graded Grade has none, so its payload is byte-for-byte
// the three fields it always was.
function gradedPayload(grade: Grade): Record<string, unknown> {
  return {
    score: grade.score,
    verdict: grade.verdict,
    reasons: grade.reasons,
    ...(grade.rubric !== undefined ? { rubric: grade.rubric } : {}),
    ...(grade.model !== undefined ? { model: grade.model } : {}),
    ...(grade.evidenceBudget !== undefined
      ? { evidenceBudget: grade.evidenceBudget }
      : {}),
  };
}

// The Jev grading path (ADR-0023): grade every Attempt of one verify round in
// code, over its own Evidence, with no grader ticket. One round is graded by
// one instrument: any ask that cannot be answered, for any cause, abandons
// the whole round (no grade is recorded) and the caller runs the grader
// agents instead. Returns the composed Grades by attempt number.
type JevGrading =
  | { ok: true; grades: Map<number, Grade> }
  | { ok: false; attempt: number; cause: JevCause; detail: string };

async function runJevGraders(
  session: Session,
  build: TicketMarker,
  attempts: number[],
): Promise<JevGrading> {
  const grades = new Map<number, Grade>();
  for (const attempt of attempts) {
    const base = buildAttemptEvidence(session, build, attempt, false);
    let result = await session.jev.ask(base.evidence, QUESTIONS);
    if (!result.ok) {
      return { ok: false, attempt, cause: result.cause, detail: result.detail };
    }
    let model = result.model;
    let budget: EvidenceBudget = "base";
    // Low ticket-fit confidence on trimmed Evidence widens once, then accepts
    // whatever comes back (ADR-0023): the grade is marked low-confidence and
    // flagged, never handed to a second instrument.
    if (
      result.answers.ticket_fit.confidence < THRESHOLDS.lowConfidence &&
      base.trimmed
    ) {
      const widened = buildAttemptEvidence(session, build, attempt, true);
      result = await session.jev.ask(widened.evidence, QUESTIONS);
      if (!result.ok) {
        return { ok: false, attempt, cause: result.cause, detail: result.detail };
      }
      model = result.model;
      budget = "widened";
    }
    const composed = compose(result.answers);
    grades.set(attempt, {
      score: composed.score10,
      verdict: composed.verdict,
      reasons: composed.reasons,
      rubric: RUBRIC_VERSION,
      model,
      evidenceBudget: budget,
    });
  }
  return { ok: true, grades };
}

// Record one Jev-composed Grade exactly where a grader ticket's Grade lands:
// the graded event on the build ticket's file, carrying the composed score,
// verdict, reasons and provenance. No grader ticket exists to write a status
// for; the build ticket stays in-progress until selection decides.
function recordJevGrade(
  session: Session,
  build: TicketMarker,
  attempt: number,
  grade: Grade,
  emit: (phase: RunPhase) => void,
): void {
  appendEvent(session.runsDir, build.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "graded",
    payload: gradedPayload(grade),
  });
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${build.id}: attempt ${attempt} graded: score ${grade.score}, ` +
        `verdict ${grade.verdict} (Jev ${grade.rubric ?? RUBRIC_VERSION}, ` +
        `${grade.evidenceBudget ?? "base"} evidence)`,
    ],
  });
  emit("running");
}

// The grader ticket file: a real ticket in the pool's directory, with the
// ordinary blocking edge from its build ticket, so it renders as a node card
// and its assignment is editable like any ticket's. The engine rewrites it
// every time the build's fan-out completes, so a re-round after a resume
// rebinds the same card to the round's new attempt instead of grading a
// stale one; the superseded round's grade stays on the build ticket's
// events, keyed by the attempt it graded.
function writeGraderTicket(
  session: Session,
  build: TicketMarker,
  index: number,
  attempt: number,
): void {
  const gid = graderIdFor(build.id, index);
  const outcomePath = join(session.runsDir, attemptOutcomeName(build.id, attempt, false));
  const diffPath = join(session.runsDir, `${gid}.diff.patch`);
  const logPath = join(session.runsDir, `${gid}.trim.log`);
  const body =
    `<!-- state: id=${gid} blocked-by=${build.id} status=ready -->

# ${gid}: grade attempt ${attempt} of ticket ${build.id}

**Grader for:** ticket ${build.id}, attempt ${attempt}.

**Bound artifacts:** ticket file \`${build.file}\`; outcome \`${outcomePath}\`; diff \`${diffPath}\`; trimmed log \`${logPath}\`.

The engine wrote this ticket when every attempt of ticket ${build.id} had ` +
    `exited, and runs it through the pool's ordinary assign machinery: an ` +
    "`assign` entry for this id in console.json overrides the build " +
    `ticket's harness and model. Its prompt is the pool's verify skill ` +
    `parameterized with the artifacts above, and the grade travels in this ` +
    `ticket's outcome JSON. Graders write no status, raise no interrupts, ` +
    `and merge nothing.
`;
  writeFileSync(join(session.issuesDir, `${gid}.md`), body);
}

// Grading one verify ticket's exited fan-out: write the grader tickets,
// then run them all through their resolved assignments. Each grader's exit
// applies its own state update and emits, the way a verify attempt's exit
// does, so the Console watches the grades land while a slow grader runs.
// A grader whose run produced no usable grade is re-spawned for the same
// attempt (ticket 07): re-spawn rounds follow the initial one, in parallel
// per round, until every grader has graded or the bound is exhausted and a
// crash interrupt hands the build ticket to the human. Returns the usable
// grades by attempt number; a grader that never graded leaves its attempt
// unmapped (the lone-attempt resolution and the selection must never decide
// on a grade that does not exist).
async function runGraders(
  session: Session,
  build: TicketMarker,
  attempts: number[],
  emit: (phase: RunPhase) => void,
): Promise<Map<number, Grade>> {
  for (const [index, attempt] of attempts.entries()) {
    writeGraderTicket(session, build, index + 1, attempt);
  }
  session.markers = loadPoolTickets(session.poolDir);
  const buildAssignment = session.assignments.get(build.id)!;
  let pending: PendingGrader[] = attempts.map((attempt, index) => {
    const marker = session.markers.find(
      (m) => m.id === graderIdFor(build.id, index + 1),
    )!;
    const assignment = resolveEngineTicketAssignment(
      session.state.config,
      marker,
      buildAssignment,
      session.harnesses,
    );
    session.assignments.set(marker.id, assignment);
    return { marker, assignment, attempt, lastReason: "" };
  });
  // The verify flow's spawn set routes through the one entry point
  // (ticket 01) via the shared engine-run helper: the round runs the graders
  // it hands back, and ADR-0014's merge hold (ticket 02) is the one rule
  // that can withhold them. The helper waits the hold out (draining queued
  // answers, so an approval lifts the hold mid-wait) and recomputes, and an
  // empty recompute is the hold re-engaged, so it loops: the round never
  // runs on an empty set.
  const spawnable = await engineSpawnSet(
    session,
    emit,
    pending.map((g) => g.marker),
  );
  pending = pending.filter((g) =>
    spawnable.some((m) => m.id === g.marker.id),
  );
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${build.id}: grading ${attempts.length} ` +
        `attempt${attempts.length === 1 ? "" : "s"} with grader tickets ` +
        pending.map((g) => g.marker.id).join(", "),
    ],
  });
  for (const { marker } of pending) {
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: nextAttempt(session.runsDir, marker.id),
      kind: "scheduled",
      payload: {},
    });
    session.state = applyUpdate(session.state, {
      tickets: { [marker.id]: "in-progress" as const },
    });
    writeMarkerStatus(marker.file, "in-progress");
    marker.status = "in-progress";
  }
  emit("running");
  const grades = new Map<number, Grade>();
  for (let round = 0; ; round++) {
    const results = await Promise.all(
      pending.map((g) =>
        runGrader(session, build, g.marker, g.attempt, g.assignment, emit),
      ),
    );
    const stillPending: PendingGrader[] = [];
    for (const [i, g] of pending.entries()) {
      const result = results[i]!;
      if (result.ok) grades.set(g.attempt, result.grade);
      else stillPending.push({ ...g, lastReason: result.reason });
    }
    pending = stillPending;
    if (pending.length === 0) return grades;
    if (round >= GRADER_RESPAWN_LIMIT) {
      raiseGraderExhausted(session, build, pending, emit);
      return grades;
    }
    const respawn = round + 1;
    // The re-spawn round's spawn set routes through the one entry point
    // (ticket 01) via the shared engine-run helper, like the initial one:
    // only the graders it hands back run again, and an empty recompute is
    // the merge hold (ticket 02) re-engaged, so the helper waits it out and
    // recomputes instead of handing the round an empty set.
    const respawnable = await engineSpawnSet(
      session,
      emit,
      pending.map((g) => g.marker),
    );
    pending = pending
      .filter((g) => respawnable.some((m) => m.id === g.marker.id))
      .map(({ marker, attempt, lastReason }) => {
        // The re-spawn resolves its assignment fresh, so an operator's
        // mid-run edit to console.json lands on the very next grader run.
        const assignment = resolveEngineTicketAssignment(
          session.state.config,
          marker,
          buildAssignment,
          session.harnesses,
        );
        session.assignments.set(marker.id, assignment);
        // The re-spawn marker and the schedule it opens share one attempt
        // number: they are one lifecycle moment, and the fresh run's spawned
        // event reads its attempt back from here.
        const attemptNo = nextAttempt(session.runsDir, marker.id);
        appendEvent(session.runsDir, marker.id, {
          at: new Date().toISOString(),
          attempt: attemptNo,
          kind: "grader-respawn",
          payload: {
            build: build.id,
            gradedAttempt: attempt,
            reason: lastReason,
            respawn,
          },
        });
        appendEvent(session.runsDir, marker.id, {
          at: new Date().toISOString(),
          attempt: attemptNo,
          kind: "scheduled",
          payload: {},
        });
        session.state = applyUpdate(session.state, {
          log: [
            `ticket ${build.id}: re-spawning grader ${marker.id} for attempt ` +
              `${attempt} (respawn ${respawn} of ${GRADER_RESPAWN_LIMIT})`,
          ],
        });
        return { marker, assignment, attempt, lastReason };
      });
    emit("running");
  }
}

// One grader awaiting a usable grade, carried across re-spawn rounds with
// the reason its last run failed (the re-spawn event and the exhaustion
// interrupt both name it).
interface PendingGrader {
  marker: TicketMarker;
  assignment: Assignment;
  attempt: number;
  lastReason: string;
}

// One grader run's ending: a usable grade, or the reason the run decided
// nothing (a dead harness, an unparseable outcome, a pause). The reason is
// the same string the crash event and the pool log carry, and it rides the
// re-spawn event so the ticket log shows why the fresh run exists.
type GraderRun = { ok: true; grade: Grade } | { ok: false; reason: string };

// The re-spawn bound: a crashed grader is re-spawned at most this many times
// per fan-out round before the engine gives up on it. It stands in for the
// crash-retry an ordinary ticket's human drives (crash interrupt, resume):
// two automatic re-spawns absorb a transient harness failure, while a
// systematically broken grader stops the run instead of looping forever.
// The bound is per round: the fresh fan-out a resume starts grants it anew.
const GRADER_RESPAWN_LIMIT = 2;

// Every re-spawn also crashed: stop retrying and raise a crash interrupt on
// the build ticket, so the broken grader surfaces to the human. The build
// ticket's marker keeps the in-progress the fan-out gave it; answering the
// interrupt with resume sends the ticket through a fresh fan-out round,
// whose grader cards are rewritten and whose bound starts over.
function raiseGraderExhausted(
  session: Session,
  build: TicketMarker,
  exhausted: PendingGrader[],
  emit: (phase: RunPhase) => void,
): void {
  const runs = GRADER_RESPAWN_LIMIT + 1;
  raiseInterrupt(session, {
    ticketId: build.id,
    kind: "crash",
    body: exhausted
      .map(
        ({ marker, attempt, lastReason }) =>
          `grader ${marker.id} gave no usable grade for attempt ${attempt} ` +
          `after ${runs} runs (last crash: ${lastReason}); grader log: ` +
          join(session.runsDir, attemptLogName(marker.id, null, false)),
      )
      .join("\n"),
  });
  session.state = applyUpdate(session.state, {
    log: exhausted.map(
      ({ marker, attempt }) =>
        `ticket ${build.id}: grader ${marker.id} gave no usable grade for ` +
        `attempt ${attempt} after ${runs} runs; crash interrupt raised for ` +
        "the build ticket",
    ),
  });
  emit("running");
}

async function runGrader(
  session: Session,
  build: TicketMarker,
  grader: TicketMarker,
  attempt: number,
  assignment: Assignment,
  emit: (phase: RunPhase) => void,
): Promise<GraderRun> {
  const gid = grader.id;
  const runsDir = session.runsDir;
  const graderOutcomePath = join(runsDir, attemptOutcomeName(gid, null, false));
  const attemptOutcomePath = join(
    runsDir,
    attemptOutcomeName(build.id, attempt, false),
  );
  const diffPath = join(runsDir, `${gid}.diff.patch`);
  const trimPath = join(runsDir, `${gid}.trim.log`);
  writeFileSync(diffPath, attemptDiff(session, build.id, attempt));
  writeFileSync(
    trimPath,
    trimTail(
      readOptional(join(runsDir, attemptLogName(build.id, attempt, false))) ??
        "(no attempt log was recorded)\n",
    ),
  );
  // Read fresh at every grading round, like AGENT.md at every spawn: an
  // operator's mid-run edit lands in the very next grader's prompt.
  const skill = readOptional(join(session.poolDir, "verify.md"));
  const prompt = buildGraderPrompt({
    buildId: build.id,
    attempt,
    skill,
    ticketPath: build.file,
    outcomePath: attemptOutcomePath,
    diffPath,
    logPath: trimPath,
    graderOutcomePath,
  });
  // The grader ticket's own attempt number for this round: the scheduled
  // event runGraders appended bumped lastAttempt to this round's number, so
  // the value read here (before this round's spawned append) is the one the
  // events and the verdict-landed tab close both key off.
  const graderAttempt = lastAttempt(runsDir, gid);
  // The grader's run is the Attempt-run module's (ADR-0014): the exited
  // status on a usable grade is done, and the crash reason on the failure
  // path is the run's (a dead harness, or the grade the validator refused).
  const run = await runAttempt(
    attemptEnvOf(session),
    {
      id: gid,
      issuePath: grader.file,
      title: grader.title,
      body: prompt,
      driver: GRADER_DRIVER,
      harness: assignment.harness,
      model: assignment.model,
      cwd: session.cwd,
      branch: null,
      attempt: graderAttempt,
      naming: { attempt: null, resolver: false },
      rotate: "exited",
      fallback: "headless",
      prompt: { kind: "driver" },
      crashSubject: "harness",
      events: { kind: "full", exitedStatus: () => "done" },
    },
    validateGrade,
  );
  if (!run.ok) {
    recordGraderFailure(session, build, grader, attempt, graderAttempt, run.crashReason, emit);
    return { ok: false, reason: run.crashReason };
  }
  // A usable grade: the engine writes the grader's done status (ADR-0005:
  // the engine owns every status write) and copies the grade into the
  // graded attempt's record, a graded event on the build ticket's file.
  writeMarkerStatus(grader.file, "done");
  grader.status = "done";
  appendEvent(runsDir, build.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "graded",
    payload: {
      score: run.result.grade.score,
      verdict: run.result.grade.verdict,
      reasons: run.result.grade.reasons,
    },
  });
  // The grader's tab never merges, so its role ends the moment the verdict
  // lands; the grade lives in the events and the log files, and a re-spawn
  // round opens a fresh tab.
  closeAttemptTab(session, gid, graderAttempt);
  session.state = applyUpdate(session.state, {
    tickets: { [gid]: "done" },
    outcomes: { [gid]: run.result.outcome },
    log: [
      `ticket ${build.id}: attempt ${attempt} graded: score ` +
        `${run.result.grade.score}, verdict ${run.result.grade.verdict} ` +
        `(grader ${gid})`,
    ],
  });
  emit("running");
  return { ok: true, grade: run.result.grade };
}

// A grader that exited non-zero or wrote no parseable grade decides nothing:
// the crash lands on the grader ticket (the run recorded its exited and
// crash events), its marker stays in-progress, and the build ticket is
// untouched. The re-spawn rounds that follow, and the bound that stops
// them, are runGraders' (ticket 07).
function recordGraderFailure(
  session: Session,
  build: TicketMarker,
  grader: TicketMarker,
  attempt: number,
  graderAttempt: number,
  reason: string,
  emit: (phase: RunPhase) => void,
): void {
  // Whatever marker status the grader agent wrote for itself, the engine
  // owns the write: a grader without a usable grade is never done.
  if (readMarker(grader.file).status !== "in-progress") {
    writeMarkerStatus(grader.file, "in-progress");
  }
  // The failed round's tab is dead: the pane already exited and the re-spawn
  // opens a fresh tab, so the verdict-less close is the failure path's too.
  // The round's own attempt number comes from the caller, not a re-read:
  // the run's exited and crash appends keyed off the same number, and a
  // later round's events would shift the close onto the wrong tab.
  closeAttemptTab(session, grader.id, graderAttempt);
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${build.id}: grader ${grader.id} produced no usable grade ` +
        `for attempt ${attempt}: ${reason}`,
    ],
  });
  emit("running");
}

// Lone-attempt resolution (ticket 05): a verify: 1 ticket's grade decides at
// the ticket instead of at Review, the earliest payoff of verification. A
// flag verdict raises the checkpoint interrupt whose Brief is the grader's
// complaint; a pass verdict marks the ticket done exactly as an unverified
// ticket is today: the attempt branch merges through the existing merge path
// and the engine writes the done status (ADR-0005). An attempt that paused or
// crashed made no done-claim for the grade to verify: the agent's own
// checkpoint takes today's checkpoint path, a crash stays with its crash
// interrupt, and a missing grade leaves the ticket untouched for the grader
// re-spawn (ticket 07). Selection for verify: N with N > 1 is not this
// function's business (ticket 04).
function resolveLoneAttempt(
  session: Session,
  marker: TicketMarker,
  result: TicketResult,
  grade: Grade | null,
  emit: (phase: RunPhase) => void,
): void {
  const attempt = result.plan.attempt;
  // A crashed attempt decided nothing; the crash interrupt raised at the
  // boundary owns the ticket and a resume re-runs it.
  if (result.status === "in-progress") return;
  const outcome = readAttemptResult(
    join(session.runsDir, attemptOutcomeName(marker.id, attempt, false)),
    validateOutcome,
  );
  if (result.status === "checkpoint") {
    // The attempt paused, so there is no done-claim and the agent's own
    // brief travels, exactly as an unverified ticket's checkpoint does
    // today; the grade lands as context only and never overrides a pause.
    checkpointLoneAttempt(
      session,
      marker,
      attempt,
      outcome.ok ? outcome.outcome.brief : undefined,
      `ticket ${marker.id}: attempt ${attempt} checkpointed; its grade is ` +
        "context only and the attempt's own brief travels",
      emit,
    );
    if (outcome.ok) {
      session.state = applyUpdate(session.state, {
        outcomes: { [marker.id]: outcome.outcome },
      });
      if (outcome.outcome.spawn?.length) {
        session.pendingSpawns.push({
          parentId: marker.id,
          proposals: outcome.outcome.spawn,
          origin: "ticket",
        });
      }
    }
    return;
  }
  if (!grade) return;
  if (grade.verdict === "flag") {
    checkpointLoneAttempt(
      session,
      marker,
      attempt,
      gradeComplaint(grade),
      `ticket ${marker.id}: attempt ${attempt}'s grade was flagged; ` +
        "checkpoint raised with the grader's complaint as the Brief",
      emit,
    );
    return;
  }
  completeLoneAttempt(session, marker, result, outcome, emit);
}

// The engine-side checkpoint for a lone attempt: the engine writes the
// checkpoint status itself (ADR-0005), lands the Brief in the canonical
// Issue, and raises the interrupt through the same path an attempt's own
// checkpoint uses, so the resume flow and the re-raise after a restart are
// the existing ones.
function checkpointLoneAttempt(
  session: Session,
  marker: TicketMarker,
  attempt: number,
  brief: string | undefined,
  logLine: string,
  emit: (phase: RunPhase) => void,
): void {
  writeMarkerStatus(marker.file, "checkpoint");
  marker.status = "checkpoint";
  landCheckpointBrief(marker.file, brief);
  raiseCheckpoint(session, marker, attempt);
  session.state = applyUpdate(session.state, {
    tickets: { [marker.id]: "checkpoint" },
    log: [logLine],
  });
  emit("running");
}

// The pass verdict: the ticket is done exactly as an unverified ticket is
// today. The attempt's branch merges through the existing merge path (the
// same mergeTicket the drive loop calls for a solo merge), the merged event
// lands on the ticket's log, and the attempt's outcome becomes the ticket's
// outcome for downstream prompts.
function completeLoneAttempt(
  session: Session,
  marker: TicketMarker,
  result: TicketResult,
  outcome: OutcomeResult,
  emit: (phase: RunPhase) => void,
): void {
  const attempt = result.plan.attempt;
  const update: PoolUpdate = {
    log: [
      `ticket ${marker.id}: attempt ${attempt} passed grading; ticket done`,
    ],
  };
  // Captured before mergeTicket runs (it removes the worktree and its
  // branch on success), the same reasoning as the drive loop's own merges:
  // a verify ticket spawned by a Conversation still gets a done-Notice with
  // a real diff summary, not just the fan-out's un-verified sibling.
  const beforeSha = mergeTargetSha(session);
  if (session.git) {
    const worktree = result.plan.worktree ?? {
      path: worktreePathFor(session.cwd, marker.id, attempt),
      branch: branchFor(session.cwd, marker.id, attempt),
    };
    const merge = mergeTicket(session, marker, worktree);
    if (!merge.ok) {
      // The conflict machinery re-attempts the solo branch on resume, and a
      // lone attempt has none, so the conflict surfaces as a checkpoint
      // instead: the Brief names the conflicted files and the parked
      // attempt branch, and resume re-runs the ticket from the moved HEAD.
      checkpointLoneAttempt(
        session,
        marker,
        attempt,
        mergeConflictComplaint(session, marker.id, attempt, merge),
        `ticket ${marker.id}: attempt ${attempt} passed grading but its ` +
          (merge.reason === "blocked" ? "merge was blocked" : "merge conflicted") +
          "; checkpoint raised for the human",
        emit,
      );
      return;
    }
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt,
      kind: "merged",
      payload: mergedPayload(merge),
    });
    closeAttemptTab(session, marker.id, attempt);
    session.conversations.ticketEnded(
      marker,
      branchFor(session.cwd, marker.id, attempt),
      beforeSha ? `${beforeSha}..${mergeTargetRef(session)}` : null,
    );
    update.log = [
      `ticket ${marker.id}: attempt ${attempt} passed grading; merged ` +
        `${branchFor(session.cwd, marker.id, attempt)} onto the working branch`,
    ];
  }
  writeMarkerStatus(marker.file, "done");
  marker.status = "done";
  if (outcome.ok) {
    update.outcomes = { [marker.id]: outcome.outcome };
    if (outcome.outcome.spawn?.length) {
      session.pendingSpawns.push({
        parentId: marker.id,
        proposals: outcome.outcome.spawn,
        origin: "ticket",
      });
    }
  }
  session.state = applyUpdate(session.state, {
    tickets: { [marker.id]: "done" },
    ...update,
  });
  emit("running");
}

// The checkpoint Brief for a flagged lone attempt: the grade's verdict and
// reasons, so the human reads the grader's complaint without opening the log.
function gradeComplaint(grade: Grade): string {
  return (
    `The attempt claimed done, but its grader flagged the work: ` +
    `score ${grade.score}/10, verdict ${grade.verdict}.\n\n` +
    `${grade.reasons.trim()}\n\n` +
    "Answering resume resets the ticket to ready; the next round runs a " +
    "fresh attempt and grades it again."
  );
}

// The checkpoint Brief for a lone attempt whose passing merge conflicted.
function mergeConflictComplaint(
  session: Session,
  buildId: string,
  attempt: number,
  result: MergeResult,
): string {
  const branch = branchFor(session.cwd, buildId, attempt);
  if (result.reason === "blocked") {
    return (
      `The attempt passed grading, but merging ${branch} onto the working ` +
      `branch was blocked: ${blockedMergeExplanation(session.cwd, result)}` +
      `The work is parked on ${branch}. Clear the files by hand and merge ` +
      "the branch yourself, or answer resume to re-run the ticket from the " +
      "current HEAD."
    );
  }
  const files =
    result.conflicted.length > 0
      ? result.conflicted.join(", ")
      : "(no unmerged paths listed)";
  return (
    `The attempt passed grading, but merging ${branch} onto the working ` +
    `branch conflicted: ${files}. The work is parked on ${branch} and the ` +
    "working branch was left clean. Resolve the conflict by hand, or " +
    "answer resume to re-run the ticket from the current HEAD."
  );
}

// ---------------------------------------------------------------------------
// Selection (ticket 04): the engine picks the best graded attempt
// ---------------------------------------------------------------------------

// One selection of one verify fan-out: which attempt won, at what score, by
// what margin over the runner-up (null when there is only one candidate),
// and under which rule: outright when the margin clears two points, the
// deterministic fallback otherwise, until the head-to-head ticket takes the
// tight band over.
interface Selection {
  attempt: number;
  score: number;
  margin: number | null;
  rule: "outright" | "fallback";
}

// The spread between two Grade scores, to the one decimal a composed Jev
// score carries (ADR-0023). Plain subtraction puts 8.2 - 6.2 just under 2,
// inside the head-to-head band, and prints float noise into the pool log.
function scoreGap(a: number, b: number): number {
  return Math.round(Math.abs(a - b) * 10) / 10;
}

// The total order the spec fixes: highest score wins, an exact tie goes to
// the earlier attempt. Nothing else breaks it, so the same grades always
// select the same attempt.
function selectWinner(
  candidates: { attempt: number; grade: Grade }[],
): Selection {
  const ranked = [...candidates].sort(
    (a, b) => b.grade.score - a.grade.score || a.attempt - b.attempt,
  );
  const winner = ranked[0];
  const margin =
    ranked.length > 1 ? scoreGap(winner.grade.score, ranked[1].grade.score) : null;
  return {
    attempt: winner.attempt,
    score: winner.grade.score,
    margin,
    rule: margin === null || margin >= 2 ? "outright" : "fallback",
  };
}

// Selecting and merging the winner of a completed, fully graded fan-out:
// every attempt exited done and every grader returned a usable grade. A
// margin of two points or more takes the top score outright; a tighter
// spread calls the head-to-head ticket (ticket 06), whose pick decides
// between the top two, falling back to the deterministic order on a tie or
// an unusable outcome. Completing the selection (the shared tail below)
// does the rest.
async function selectAndMergeWinner(
  session: Session,
  marker: TicketMarker,
  attempts: number[],
  grades: Map<number, Grade>,
  emit: (phase: RunPhase) => void,
): Promise<void> {
  const ranked = attempts
    .map((attempt) => ({ attempt, grade: grades.get(attempt)! }))
    .sort((a, b) => b.grade.score - a.grade.score || a.attempt - b.attempt);
  const selection = selectWinner(ranked);
  let picked: {
    attempt: number;
    score: number | null;
    margin: number | null;
    rule: "outright" | "fallback" | "human" | "head-to-head";
  } = selection;
  let why =
    `selected attempt ${selection.attempt} (score ${selection.score}` +
    (selection.margin === null ? "" : `, margin ${selection.margin}`) +
    `): ${
      selection.rule === "outright"
        ? "takes it outright"
        : "below the outright margin; highest score, then earlier attempt"
    }`;
  if (selection.rule === "fallback") {
    // The tight band (ticket 06): separate grading calls are uncalibrated,
    // so the engine does not trust a one-point spread on its own. One
    // head-to-head ticket sees the top two side by side and names the
    // winner; a tie or an unusable outcome leaves the deterministic order
    // standing.
    const verdict = await runHeadToHead(
      session,
      marker,
      ranked[0],
      ranked[1],
      emit,
    );
    if (verdict.kind === "pick") {
      picked = {
        attempt: verdict.attempt,
        score: grades.get(verdict.attempt)!.score,
        margin: scoreGap(ranked[0].grade.score, ranked[1].grade.score),
        rule: "head-to-head",
      };
      why =
        `selected attempt ${picked.attempt} (score ${picked.score}, ` +
        `margin ${picked.margin}): the head-to-head ticket ` +
        `${headToHeadIdFor(marker.id)} picked it`;
    } else {
      why =
        `selected attempt ${selection.attempt} (score ${selection.score}, ` +
        `margin ${selection.margin}): ` +
        (verdict.kind === "tie"
          ? `the head-to-head ticket ${headToHeadIdFor(marker.id)} ` +
            "could not separate them; "
          : `the head-to-head ticket ${headToHeadIdFor(marker.id)} gave ` +
            `no usable pick (${verdict.reason}); `) +
        "highest score, then earlier attempt";
    }
  }
  // A superseded head-to-head card closes with the selection: a review
  // reject resets its marker to ready with its build ticket's, and a
  // re-round whose grades then decide outright never rewrites it, so
  // without this the run could never pass Review's all-done check.
  if (selection.rule === "outright") {
    closeSupersededHeadToHead(session, marker.id);
  }
  completeSelection(
    session,
    marker,
    picked.attempt,
    { score: picked.score, margin: picked.margin, rule: picked.rule },
    why,
    emit,
  );
}

// The pool's selection mode: auto unless the config says human. The key's
// absence is the default, exactly as the spec fixes it.
function selectionMode(config: PoolConfig): "auto" | "human" {
  return config.selection === "human" ? "human" : "auto";
}

// The selection point with the human as judge (ticket 08): the interrupt
// carries every candidate's grade, and the answer names the attempt whose
// branch merges. The ticket stays in-progress with every attempt branch
// parked; the candidates ride on the interrupt so the answer is validated
// against the exact fan-out the grades came from, restarts included (a
// superseded round's graded attempts would otherwise pass for candidates).
function raiseSelectionInterrupt(
  session: Session,
  marker: TicketMarker,
  attempts: number[],
  grades: Map<number, Grade>,
  emit: (phase: RunPhase) => void,
): void {
  raiseInterrupt(session, {
    ticketId: marker.id,
    kind: "selection",
    body: selectionInterruptBody(attempts, grades),
    candidates: attempts,
  });
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${marker.id}: selection interrupt raised with ` +
        `${attempts.length} candidates' grades (selection: human)`,
    ],
  });
  emit("running");
}

// The selection interrupt's body: one line per candidate with its score,
// verdict and the grader's reasons, so the human judges over the same
// artifacts the auto rule would.
function selectionInterruptBody(
  attempts: number[],
  grades: Map<number, Grade>,
): string {
  return (
    `verify fan-out complete: ${attempts.length} graded attempts, and the ` +
    "pool's selection is yours.\n\n" +
    attempts
      .map((attempt) => {
        const grade = grades.get(attempt)!;
        return (
          `- attempt ${attempt}: score ${grade.score}/10, ` +
          `verdict ${grade.verdict}\n` +
          `  ${grade.reasons.trim().replaceAll("\n", "\n  ")}`
        );
      })
      .join("\n") +
    "\n\nAnswer with the number of the attempt to merge; the rest are " +
    "discarded with their logs, outcomes and grades kept."
  );
}

// The answer's attempt number: the first integer in the note, so "2",
// "attempt 2" and "merge attempt-2 please" all name attempt 2.
function parseSelectionAnswer(note: string | undefined): number | null {
  const match = /(\d+)/.exec(note?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

function selectionAnswerError(
  interrupt: Interrupt,
  note: string | undefined,
): string {
  return (
    `selection answer must name one of the candidate attempts ` +
    `(${(interrupt.candidates ?? []).join(", ")}); got ${JSON.stringify(note ?? "")}`
  );
}

// Processing a selection answer (ticket 08): the note names the winning
// attempt, the engine merges that attempt's branch through the existing
// merge path and completes the selection exactly as the auto rule would.
// An answer naming no candidate is rejected here too, not merged (the
// acceptance-time check guards the live caller; this one guards a record
// accepted before the check existed).
function processSelectionAnswer(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note: string | undefined,
): void {
  const attempt = parseSelectionAnswer(note);
  if (attempt === null || !interrupt.candidates?.includes(attempt)) {
    throw new Error(selectionAnswerError(interrupt, note));
  }
  // The selection interrupt has served its purpose; the merge or the
  // checkpoint it leads to owns the ticket from here.
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `interrupt answered for ${marker.id} (selection): attempt ` +
        `${attempt} to merge`,
    ],
  });
  completeSelection(
    session,
    marker,
    attempt,
    { score: null, margin: null, rule: "human" },
    `human selected attempt ${attempt}`,
    () => {},
  );
}

// Completing a selection, however it was made: the selected event records
// which attempt won and under which rule, the winner's branch merges through
// the existing merge path (the same mergeTicket a solo merge uses), the
// engine writes the done status (ADR-0005), and every other attempt branch
// of the ticket, this round's losers and any superseded round's alike, is
// discarded. The losers' logs, outcomes and grades live in runs/ and the
// ticket's events, which no discard touches. A conflicted merge parks the
// winner's branch and checkpoints for the human, the way a lone attempt's
// conflicted merge does: the conflict machinery re-attempts the well-known
// solo branch, which a selected attempt does not have.
function completeSelection(
  session: Session,
  marker: TicketMarker,
  attempt: number,
  picked: {
    score: number | null;
    margin: number | null;
    rule: "outright" | "fallback" | "human" | "head-to-head";
  },
  why: string,
  emit: (phase: RunPhase) => void,
): void {
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "selected",
    payload: picked,
  });
  session.state = applyUpdate(session.state, {
    log: [`ticket ${marker.id}: ${why}`],
  });
  let mergedNote = "";
  if (session.git) {
    const worktree = {
      path: worktreePathFor(session.cwd, marker.id, attempt),
      branch: branchFor(session.cwd, marker.id, attempt),
    };
    const merge = mergeTicket(session, marker, worktree);
    if (!merge.ok) {
      discardLosers(session, marker.id, attempt);
      checkpointLoneAttempt(
        session,
        marker,
        attempt,
        mergeConflictComplaint(session, marker.id, attempt, merge),
        `ticket ${marker.id}: attempt ${attempt} selected but its merge ` +
          (merge.reason === "blocked" ? "was blocked" : "conflicted") +
          "; checkpoint raised for the human",
        emit,
      );
      return;
    }
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt,
      kind: "merged",
      payload: mergedPayload(merge),
    });
    closeAttemptTab(session, marker.id, attempt);
    mergedNote = ` merged ${branchFor(session.cwd, marker.id, attempt)} onto the working branch`;
  } else {
    mergedNote =
      " (the pool does not run in git; the selected work is already in the checkout)";
  }
  writeMarkerStatus(marker.file, "done");
  marker.status = "done";
  const discarded = discardLosers(session, marker.id, attempt);
  const update: PoolUpdate = {
    tickets: { [marker.id]: "done" },
    log: [
      `ticket ${marker.id}: attempt ${attempt} selected` +
        mergedNote +
        (discarded.length > 0
          ? `; discarded losing attempts ${discarded.join(", ")} ` +
            "(their logs, outcomes and grades are kept)"
          : ""),
    ],
  };
  // The winner's outcome becomes the ticket's, the way a solo done attempt's
  // does, so downstream prompts read what was actually selected. Its spawn
  // proposals ride to the boundary's adoption buffer with it.
  const outcome = readAttemptResult(
    join(session.runsDir, attemptOutcomeName(marker.id, attempt, false)),
    validateOutcome,
  );
  if (outcome.ok) {
    update.outcomes = { [marker.id]: outcome.outcome };
    if (outcome.outcome.spawn?.length) {
      session.pendingSpawns.push({
        parentId: marker.id,
        proposals: outcome.outcome.spawn,
        origin: "ticket",
      });
    }
  }
  session.state = applyUpdate(session.state, update);
  emit("running");
}

// Every attempt branch of the build ticket except the winner's goes: this
// round's losers and any superseded round's alike, and each discarded
// attempt's terminal tab with it, because a loser's tab never merges: its
// role ends exactly here. Returns the attempt numbers discarded, so the
// pool log can name them.
function discardLosers(
  session: Session,
  buildId: string,
  keep: number,
): number[] {
  if (!session.git) return [];
  const losers = attemptBranches(session.cwd, buildId).filter((a) => a !== keep);
  for (const attempt of losers) {
    discardWorktree(session.cwd, {
      path: worktreePathFor(session.cwd, buildId, attempt),
      branch: branchFor(session.cwd, buildId, attempt),
    });
    closeAttemptTab(session, buildId, attempt);
  }
  return losers;
}

// ---------------------------------------------------------------------------
// Head-to-head (ticket 06): one compare ticket for a tight grade spread
// ---------------------------------------------------------------------------

// One side of the comparison: the attempt, the grade it received, and the
// artifact paths the head-to-head ticket binds.
interface HeadToHeadSide {
  attempt: number;
  grade: Grade;
  outcomePath: string;
  diffPath: string;
  logPath: string;
}

// What the head-to-head run decided: the attempt it picked, a declared tie,
// or the reason it decided nothing (a dead harness, an unparseable outcome,
// a pause). A tie and an unusable outcome lead to the same deterministic
// fallback; the reason only tells the log which one fired.
type HeadToHeadVerdict =
  | { kind: "pick"; attempt: number; outcome: Outcome }
  | { kind: "tie"; outcome: Outcome }
  | { kind: "unusable"; reason: string };

// The head-to-head's outcome: the standard contract plus a `winner` naming
// exactly one of the two candidate attempt numbers, or the string "tie" when
// the judge genuinely cannot separate them. Anything else is unusable rather
// than a guess: the deterministic fallback owns the decision then. The
// Attempt-run module's reader supplies the missing-file and unparseable
// preamble; this validates one parse.
type UsableVerdict = Exclude<HeadToHeadVerdict, { kind: "unusable" }>;

function validateVerdict(
  parsed: unknown,
  candidates: [number, number],
): { ok: true; verdict: UsableVerdict } | ReadFailure {
  const base = validateOutcome(parsed);
  if (!base.ok) return base;
  if (base.outcome.status !== "done") {
    return {
      ok: false,
      reason: "head-to-head outcome is a checkpoint, not a pick",
    };
  }
  const winner = (parsed as { winner?: unknown })?.winner;
  if (winner === "tie") return { ok: true, verdict: { kind: "tie", outcome: base.outcome } };
  const pick =
    typeof winner === "number" && Number.isInteger(winner)
      ? winner
      : typeof winner === "string" && /^\d+$/.test(winner)
        ? Number(winner)
        : null;
  if (pick === null || !candidates.includes(pick)) {
    return {
      ok: false,
      reason: "outcome names no winner among the two attempts",
    };
  }
  return { ok: true, verdict: { kind: "pick", attempt: pick, outcome: base.outcome } };
}

// The head-to-head ticket file: a real ticket in the pool's directory with
// the ordinary blocking edge from its build ticket, so it renders as a node
// card and its assignment is editable like any ticket's. The engine rewrites
// it every time the tight band is reached, rebinding the same card to the
// round's top two instead of accumulating one per round.
function writeHeadToHeadTicket(
  session: Session,
  build: TicketMarker,
  sides: [HeadToHeadSide, HeadToHeadSide],
): void {
  const h2hId = headToHeadIdFor(build.id);
  const [top, runnerUp] = sides;
  const bind = (label: string, s: HeadToHeadSide): string =>
    `${label} attempt ${s.attempt} (graded ${s.grade.score}/10): outcome ` +
    `\`${s.outcomePath}\`; diff \`${s.diffPath}\`; trimmed log \`${s.logPath}\``;
  const body =
    `<!-- state: id=${h2hId} blocked-by=${build.id} status=ready -->\n\n` +
    `# ${h2hId}: pick between attempts ${top.attempt} and ` +
    `${runnerUp.attempt} of ticket ${build.id}\n\n` +
    `**Head-to-head for:** ticket ${build.id}. Attempts ${top.attempt} and ` +
    `${runnerUp.attempt} graded ${top.grade.score} and ` +
    `${runnerUp.grade.score}, inside the two-point outright margin, so the ` +
    "pairwise call decides.\n\n" +
    `**Bound artifacts:** ticket file \`${build.file}\`; ` +
    `${bind("first", top)}; ${bind("second", runnerUp)}.\n\n` +
    `The engine wrote this ticket when selection found the top two grades ` +
    "too close to call from separate graders, and runs it through the " +
    "pool's ordinary assign machinery: an `assign` entry for this id in " +
    "console.json overrides the build ticket's harness and model. Its " +
    "prompt lays both attempts' artifacts side by side, and its outcome " +
    'JSON carries `"winner"`, the number of the attempt it picks, or ' +
    '`"tie"`. It writes no status, raises no interrupts, and merges ' +
    "nothing.\n";
  writeFileSync(join(session.issuesDir, `${h2hId}.md`), body);
}

// Running the head-to-head for a tight spread: write the compare ticket,
// resolve its assignment through the ordinary machinery, spawn it, and read
// the pick. Unlike a grader there is no re-spawn: an unusable outcome falls
// back to the deterministic order by contract, so a dead judge can never
// stall the run. The card still closes done either way (the engine owns the
// status write): its lifecycle is over once its outcome has been consumed,
// and an open card would hold Review's all-done check shut forever.
async function runHeadToHead(
  session: Session,
  build: TicketMarker,
  top: { attempt: number; grade: Grade },
  runnerUp: { attempt: number; grade: Grade },
  emit: (phase: RunPhase) => void,
): Promise<HeadToHeadVerdict> {
  const h2hId = headToHeadIdFor(build.id);
  const runsDir = session.runsDir;
  const sides = [top, runnerUp].map((side): HeadToHeadSide => {
    const attempt = side.attempt;
    return {
      attempt,
      grade: side.grade,
      outcomePath: join(runsDir, attemptOutcomeName(build.id, attempt, false)),
      diffPath: join(runsDir, `${h2hId}.attempt-${attempt}.diff.patch`),
      logPath: join(runsDir, `${h2hId}.attempt-${attempt}.trim.log`),
    };
  });
  writeHeadToHeadTicket(session, build, [sides[0], sides[1]]);
  session.markers = loadPoolTickets(session.poolDir);
  const h2h = session.markers.find((m) => m.id === h2hId)!;
  // The selection run's spawn set routes through the one entry point
  // (ticket 01) via the shared engine-run helper: the run spawns the judge
  // it hands back, and ADR-0014's merge hold (ticket 02) is the one rule
  // that can withhold it. The helper waits the hold out (draining queued
  // answers, so an approval lifts the hold mid-wait) and recomputes, and an
  // empty recompute is the hold re-engaged, so it loops: the judge the run
  // destructures is never undefined, whatever lands between the wait and
  // the recompute.
  const [judge] = await engineSpawnSet(session, emit, [h2h]);
  const assignment = resolveEngineTicketAssignment(
    session.state.config,
    judge,
    session.assignments.get(build.id)!,
    session.harnesses,
  );
  session.assignments.set(h2hId, assignment);
  appendEvent(runsDir, h2hId, {
    at: new Date().toISOString(),
    attempt: nextAttempt(runsDir, h2hId),
    kind: "scheduled",
    payload: {},
  });
  session.state = applyUpdate(session.state, {
    tickets: { [h2hId]: "in-progress" as const },
    log: [
      `ticket ${build.id}: margin ` +
        `${scoreGap(top.grade.score, runnerUp.grade.score)} is below the outright ` +
        `band; spawning head-to-head ${h2hId} between attempts ` +
        `${top.attempt} and ${runnerUp.attempt}`,
    ],
  });
  writeMarkerStatus(judge.file, "in-progress");
  judge.status = "in-progress";
  emit("running");
  const h2hOutcomePath = join(runsDir, attemptOutcomeName(h2hId, null, false));
  for (const side of sides) {
    writeFileSync(side.diffPath, attemptDiff(session, build.id, side.attempt));
    writeFileSync(
      side.logPath,
      trimTail(
        readOptional(
          join(runsDir, attemptLogName(build.id, side.attempt, false)),
        ) ?? "(no attempt log was recorded)\n",
      ),
    );
  }
  // Read fresh at every run, like the verify skill at every grader spawn: an
  // operator's mid-run edit lands in the very next judge's prompt.
  const skill = readOptional(join(session.poolDir, "verify.md"));
  const parts = (s: HeadToHeadSide) => ({
    attempt: s.attempt,
    outcomePath: s.outcomePath,
    diffPath: s.diffPath,
    logPath: s.logPath,
    score: s.grade.score,
    verdict: s.grade.verdict,
    reasons: s.grade.reasons,
  });
  const prompt = buildHeadToHeadPrompt({
    buildId: build.id,
    ticketPath: build.file,
    skill,
    top: parts(sides[0]),
    runnerUp: parts(sides[1]),
    outcomePath: h2hOutcomePath,
  });
  // This round's attempt number for the head-to-head ticket: the scheduled
  // append above bumped lastAttempt to it, so the value read here (before
  // the spawned append) is the one the events and the tab close key off.
  const h2hAttempt = lastAttempt(runsDir, h2hId);
  // The judge's run is the Attempt-run module's (ADR-0014): the exited
  // status on a usable pick is done, and the exit facts ride the run.
  const run = await runAttempt(
    attemptEnvOf(session),
    {
      id: h2hId,
      issuePath: judge.file,
      title: h2h.title,
      body: prompt,
      driver: HEAD_TO_HEAD_DRIVER,
      harness: assignment.harness,
      model: assignment.model,
      cwd: session.cwd,
      branch: null,
      attempt: h2hAttempt,
      naming: { attempt: null, resolver: false },
      rotate: "exited",
      fallback: "headless",
      prompt: { kind: "driver" },
      crashSubject: "harness",
      events: { kind: "full", exitedStatus: () => "done" },
    },
    (parsed) => validateVerdict(parsed, [top.attempt, runnerUp.attempt]),
  );
  const verdict: HeadToHeadVerdict = run.ok
    ? run.result.verdict
    : { kind: "unusable", reason: run.crashReason };
  writeMarkerStatus(judge.file, "done");
  judge.status = "done";
  // The judge's tab never merges: its role ends the moment the verdict is
  // consumed and the card goes done, on a usable pick and an unusable one
  // alike.
  closeAttemptTab(session, h2hId, h2hAttempt);
  const update: PoolUpdate = {
    tickets: { [h2hId]: "done" as const },
    log: [
      verdict.kind === "pick"
        ? `ticket ${build.id}: head-to-head ${h2hId} picked attempt ` +
          `${verdict.attempt}`
        : verdict.kind === "tie"
          ? `ticket ${build.id}: head-to-head ${h2hId} tied`
          : `ticket ${build.id}: head-to-head ${h2hId} gave no usable ` +
            `pick: ${verdict.reason}`,
    ],
  };
  if (verdict.kind !== "unusable") {
    update.outcomes = { [h2hId]: verdict.outcome };
  }
  session.state = applyUpdate(session.state, update);
  emit("running");
  return verdict;
}

// Closing a superseded head-to-head card: a review reject resets its marker
// to ready along with its build ticket's, and an engine crash mid-judge
// leaves it behind for rehydrate to reset; a re-round whose grades then
// decide outright never rewrites the card, so without this the run could
// never pass Review's all-done check. The engine owns the write, and the
// card's own ticket log already holds the round it judged.
function closeSupersededHeadToHead(session: Session, buildId: string): void {
  const h2hId = headToHeadIdFor(buildId);
  const file = join(session.issuesDir, `${h2hId}.md`);
  if (!existsSync(file)) return;
  if (readMarker(file).status === "done") return;
  writeMarkerStatus(file, "done");
  const marker = session.markers.find((m) => m.id === h2hId);
  if (marker) marker.status = "done";
  session.state = applyUpdate(session.state, {
    tickets: { [h2hId]: "done" as const },
    log: [
      `ticket ${buildId}: closed superseded head-to-head card ${h2hId} ` +
        "(this round's selection did not need it)",
    ],
  });
}

// The final Review: the run's closing gate, raised once every ticket is done
// and no other interrupt is pending. The body is the run's outcome list, so
// the judgment happens over what actually happened, not a ticket count.
function reviewInterrupt(session: Session): Interrupt {
  const lines = session.markers.map(
    (marker) =>
      `- ${marker.id}: ${session.state.outcomes[marker.id]?.summary ?? "(no outcome recorded)"}`,
  );
  return {
    ticketId: REVIEW_TICKET_ID,
    kind: "review",
    body:
      "every ticket is done.\n" +
      lines.join("\n") +
      "\napprove to end the run, or reject with a note naming the tickets to " +
      "send back; their downstream tickets return to ready with them.",
  };
}

// Approving ends the run: the gate lifts for good (reviewApproved persists
// through checkpoints, so a restart comes up done) and the pool's final state
// stays inspectable through the server. The approval only stands if the
// markers reloaded from disk are all done; a marker a human reset behind the
// engine's back sends the pool around to a fresh Review instead.
function approveReview(
  session: Session,
  interrupt: Interrupt,
  note?: string,
): void {
  const allDone = session.markers.every((m) => m.status === "done");
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      session.markers.map((m) => [m.id, m.status]),
    ),
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      allDone
        ? "review approved: the run is complete" +
          (note?.trim() ? ` (${note.trim()})` : "")
        : "review approved, but markers on disk are not all done: the run " +
          "continues to a fresh review",
    ],
    reviewApproved: allDone,
  });
}

// A ticket id counts as named when it appears in the note delimited by
// non-id characters, so "redo 03 and 05" names 03 and 05 without matching
// the 03 inside 033.
function namesTicket(note: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(
    note,
  );
}

// The ticket ids a review reject's note names. Shared by acceptance (which
// rejects an unnamed reject outright) and processing (which keeps the same
// guard for a record accepted before this check existed).
function namedReviewTickets(
  markers: TicketMarker[],
  note: string | undefined,
): string[] {
  const text = note?.trim() ?? "";
  return markers.filter((marker) => namesTicket(text, marker.id)).map((m) => m.id);
}

function reviewRejectUnnamedError(markers: TicketMarker[]): string {
  return (
    "review reject: name at least one ticket in the note " +
    `(known: ${markers.map((m) => m.id).join(", ")})`
  );
}

// Rejecting sends the named tickets back to ready with the note appended to
// their Issue files, and invalidates their downstream tickets to ready too:
// anything built on rejected work runs again. Outcomes for the reset tickets
// are dropped from the channel and from disk, so downstream prompts are never
// fed a superseded summary. The run then continues until every ticket is done
// again and a fresh Review is raised.
function rejectReview(
  session: Session,
  interrupt: Interrupt,
  note?: string,
): void {
  const named = namedReviewTickets(session.markers, note);
  if (named.length === 0) {
    throw new Error(reviewRejectUnnamedError(session.markers));
  }
  const reset = new Set(named);
  let grew = true;
  while (grew) {
    grew = false;
    for (const marker of session.markers) {
      if (!reset.has(marker.id) && marker.blockedBy.some((b) => reset.has(b))) {
        reset.add(marker.id);
        grew = true;
      }
    }
  }
  for (const marker of session.markers) {
    if (!reset.has(marker.id)) continue;
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "review-reject",
      payload: {},
    });
    writeMarkerStatus(marker.file, "ready");
    marker.status = "ready";
    if (named.includes(marker.id)) {
      appendFileSync(marker.file, `\n## Review note\n\n${note?.trim() ?? ""}\n`);
    }
    rmSync(join(session.runsDir, attemptOutcomeName(marker.id, null, false)), {
      force: true,
    });
  }
  const outcomes = { ...session.state.outcomes };
  for (const id of reset) delete outcomes[id];
  const downstream = [...reset].filter((id) => !named.includes(id));
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      session.markers.map((m) => [m.id, m.status]),
    ),
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `review rejected: ${named.join(", ")} back to ready` +
        (downstream.length > 0
          ? `; downstream ${downstream.join(", ")} also reset`
          : ""),
    ],
  });
  // The outcomes channel is a keyed merge, so removals go around the reducer.
  session.state = { ...session.state, outcomes };
}

// Every interrupt is raised here, a Conversation's merge interrupts (through
// its host) the same way a ticket's.
function raiseInterrupt(session: Session, interrupt: Interrupt): void {
  if (
    session.state.interrupts.some(
      (i) => i.ticketId === interrupt.ticketId && i.kind === interrupt.kind,
    )
  ) {
    return;
  }
  session.state = applyUpdate(session.state, {
    interrupts: [...session.state.interrupts, interrupt],
    log: [
      `interrupt raised for ${interrupt.ticketId} (${interrupt.kind})` +
        (interrupt.kind === "deadlock" ? `: ${interrupt.body}` : ""),
    ],
  });
}

// The minimal write the Conversation host needs to resolve one of its own
// interrupts: drop the interrupt and add one log line, exactly what every
// ticket-side approve/reject/resume does inline.
function clearInterrupt(session: Session, interrupt: Interrupt, log: string): void {
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [log],
  });
}

function reconcileDeadlocks(session: Session): void {
  const { markers, state } = session;
  const resumable = new Set(
    state.interrupts
      .filter((i) => i.kind !== "deadlock")
      .map((i) => i.ticketId),
  );
  const deadlocked = new Set(
    state.interrupts
      .filter((i) => i.kind === "deadlock")
      .map((i) => i.ticketId),
  );
  const canComplete = (id: string, visiting: Set<string>): boolean => {
    const status = state.tickets[id];
    if (status === "done" || status === "in-progress") return true;
    if (resumable.has(id)) return true;
    if (deadlocked.has(id)) return false;
    if (visiting.has(id)) return false;
    const marker = markers.find((m) => m.id === id);
    if (!marker) return false;
    visiting.add(id);
    const ok = marker.blockedBy.every((b) => canComplete(b, visiting));
    visiting.delete(id);
    return ok;
  };

  const cleared = state.interrupts.filter(
    (i) => i.kind === "deadlock" && canComplete(i.ticketId, new Set()),
  );
  const raised = markers.filter(
    (marker) =>
      state.tickets[marker.id] !== "done" &&
      !resumable.has(marker.id) &&
      !deadlocked.has(marker.id) &&
      !canComplete(marker.id, new Set()),
  );
  if (cleared.length === 0 && raised.length === 0) return;

  let interrupts = state.interrupts.filter(
    (i) => !cleared.some((c) => c.ticketId === i.ticketId && c.kind === i.kind),
  );
  const log: string[] = [];
  for (const interrupt of cleared) {
    appendEvent(session.runsDir, interrupt.ticketId, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, interrupt.ticketId),
      kind: "deadlock-cleared",
      payload: {},
    });
    log.push(
      `interrupt cleared for ${interrupt.ticketId} (deadlock): blockers can complete again`,
    );
  }
  for (const marker of raised) {
    const blocking = marker.blockedBy.filter(
      (id) => !canComplete(id, new Set()),
    );
    const interrupt: Interrupt = {
      ticketId: marker.id,
      kind: "deadlock",
      body: `blockers can never complete: ${blocking.join(", ")}`,
    };
    interrupts = [...interrupts, interrupt];
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "deadlock",
      payload: { blockers: blocking },
    });
    log.push(`interrupt raised for ${marker.id} (deadlock): ${interrupt.body}`);
  }
  session.state = applyUpdate(session.state, { interrupts, log });
}

function checkpointInterrupt(marker: TicketMarker): Interrupt {
  return {
    ticketId: marker.id,
    kind: "checkpoint",
    body: extractBrief(marker.file),
  };
}

// Raise a checkpoint's interrupt and record its checkpoint event. Shared by
// the at-exit path (attempt exit) and the recovery path (interrupts rebuilt
// from markers on reload); the attempt is passed in so the at-exit caller can
// use the exact attempt while the recovery caller reads it back from the log.
function raiseCheckpoint(
  session: Session,
  marker: TicketMarker,
  attempt: number,
): void {
  const interrupt = checkpointInterrupt(marker);
  raiseInterrupt(session, interrupt);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "checkpoint",
    payload: {},
  });
  // The Conversations ADR: every raiseCheckpoint call site (attempt exit,
  // the lone-attempt and grade-flag paths, the adoption-recovery rebuild)
  // funnels through here, so one hook covers all of them without a second
  // call site to remember. interrupt.body is the same extractBrief(marker
  // .file) read the interrupt itself carries; reused rather than re-read.
  session.conversations.ticketCheckpointed(marker, interrupt.body);
}

// "## Brief" and "## Brief, written by the engine" both head a Brief
// section; "## Briefing" would not be one.
const BRIEF_HEADING = /^## Brief(?![a-zA-Z])/;

function extractBrief(issueFile: string): string {
  const lines = readFileSync(issueFile, "utf8").split("\n");
  const start = lines.findIndex((line) => BRIEF_HEADING.test(line));
  if (start === -1) return "(no Brief section in the Issue file)";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

const ENGINE_CHECKPOINT_PLACEHOLDER =
  "The agent signalled a checkpoint but wrote no brief, so what the " +
  "attempt completed is only in the ticket log. Answer the interrupt to " +
  "point the next attempt.";

// On a checkpoint the Brief travels in the outcome JSON (ADR-0005) and the
// engine lands it in the canonical Issue, so the interrupt raised at exit
// and its re-raise after a restart both read it from the one place. Every
// checkpoint replaces the Brief section outright: the section always
// mirrors the latest attempt, so a stale brief can never masquerade as the
// current one, and extractBrief reads the first. A checkpoint without a
// brief gets the engine's placeholder in its place: the pause was
// intentional, so it is never a crash, and the interrupt still has a body.
function landCheckpointBrief(
  issueFile: string,
  brief: string | undefined,
): void {
  const trimmed = brief?.trim() ?? "";
  const stripped = stripBriefSections(readFileSync(issueFile, "utf8")).replace(
    /\n+$/,
    "",
  );
  const section = trimmed
    ? `## Brief\n\n${trimmed}`
    : `${ENGINE_BRIEF_HEADING}\n\n${ENGINE_CHECKPOINT_PLACEHOLDER}`;
  writeFileSync(issueFile, `${stripped}\n\n---\n\n${section}\n`);
}

// Remove every Brief section (heading to the next "## " heading or the end
// of the file), plus the "---" separator an engine append put before it, so
// a re-landed Brief does not pile up behind a stale one.
function stripBriefSections(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (BRIEF_HEADING.test(line)) {
      skipping = true;
      while (kept.length > 0 && kept[kept.length - 1].trim() === "") {
        kept.pop();
      }
      if (kept[kept.length - 1]?.trim() === "---") kept.pop();
      continue;
    }
    if (skipping && line.startsWith("## ")) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

interface TicketEnv extends AttemptEnv {
  poolDir: string;
  issuesDir: string;
}

/**
 * The Attempt-run module's environment (ADR-0014): the one place the pool's
 * terminal setting is decided. The drive loop passes the super-step's frozen
 * config so every attempt of one step reads the same setting (ADR-0018's
 * boundary reload); the other spawn sites read the live one, and startPool
 * builds the Conversation module's once from the boot config.
 */
function attemptEnvFrom(
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
  runsDir: string,
  herdrSocket: string,
  poolWorkspace: PoolWorkspace,
  children: ChildTracker,
  liveAttempts: LiveAttempts,
  launchCadence?: Partial<LaunchCadence>,
): AttemptEnv {
  return {
    runsDir,
    harnesses,
    herdrSocket,
    poolWorkspace,
    children,
    liveAttempts,
    terminalBacked: config.terminal === "herdr",
    agents: config.agents,
    ...(launchCadence ? { launchCadence } : {}),
  };
}

function attemptEnvOf(session: Session, config: PoolConfig = session.state.config): AttemptEnv {
  return attemptEnvFrom(
    config,
    session.harnesses,
    session.runsDir,
    session.herdrSocket,
    poolWorkspaceFor(() => session),
    session.children,
    session.liveAttempts,
    session.launchCadence,
  );
}

interface TicketPlan {
  cwd: string;
  worktree?: WorktreeInfo;
  attempt: number;
  // True when the attempt is one candidate of a verify fan-out: it runs on
  // its own attempt branch and its exit never writes the ticket's status.
  verify: boolean;
}

interface TicketResult {
  marker: TicketMarker;
  status: TicketStatus;
  logPath: string;
  exitCode: number;
  plan: TicketPlan;
  update: PoolUpdate;
  // True when the drive loop applied this result's update to state at
  // attempt exit (a terminal done/checkpoint); the boundary join skips it so
  // the same update is never applied twice.
  joinedAtExit: boolean;
  // The attempt's schema-valid spawn proposals (ADR-0010), riding to the
  // boundary's adoption buffer. A verify candidate carries none: its
  // proposals ride or die with selection.
  spawnProposals?: SpawnProposal[];
  // The exit facts (ADR-0012): the attempt log's tail and the outcome-file
  // existence, computed at exit so the crash interrupt body the boundary
  // raises freezes them at raise time exactly as the persisted events do.
  logTail: string[];
  outcomePath: string;
  outcomeExists: boolean;
  // The crash reason the crash event recorded, null on a clean exit; the
  // interrupt body leads with it (issue #127).
  crashReason: string | null;
}

/**
 * Close the attempt's herdr tab. For a merging attempt the trigger is the
 * ticket's merge (ADR-0014: exited panes persist until merge, then the
 * engine closes them); for attempts that never merge (graders, the
 * head-to-head judge, losing verify candidates) the trigger is the moment
 * their role ends: the verdict landing or the selection discarding them.
 * The tab id rides the attempt's spawned event, so no state is threaded
 * through the merge or grading paths and no config is consulted: a missing
 * id (headless pool, headless fallback) leaves nothing to close. Best-effort and non-blocking:
 * closing a terminal must never fail or delay the engine, and a daemon that
 * has gone away, or that already reaped the exited tab (verified live:
 * herdr closes a tab whose shell ends), changes nothing about the ticket.
 */
/**
 * Was this ticket enlisted from a pane the operator opened (issue #101)? The
 * marker's `enlisted-from` is the durable answer and outlives the attempt,
 * unlike `session.enlistedWork`, which is dropped at a pane-gone checkpoint.
 * Every tab close asks it, because the tab named in an enlisted ticket's
 * `spawned` event is the operator's own and closing it is the one thing the
 * engine promised never to do.
 */
function wasEnlisted(session: Session, ticketId: string): boolean {
  return session.markers.some(
    (marker) => marker.id === ticketId && marker.enlistedFrom !== undefined,
  );
}

function closeAttemptTab(
  session: Session,
  ticketId: string,
  attempt: number,
): void {
  if (wasEnlisted(session, ticketId)) return;
  const spawned = readEvents(session.runsDir, ticketId).find(
    (event) =>
      event.kind === "spawned" &&
      event.attempt === attempt &&
      typeof event.payload.tab_id === "string",
  );
  if (!spawned || typeof spawned.payload.tab_id !== "string") return;
  const tabId = spawned.payload.tab_id;
  void closeTab(session.herdrSocket, tabId).catch(() => {});
}

/**
 * Close every herdr tab the ticket ever opened (ADR-0014), not just one
 * attempt's: the merge-conflict merge paths (resumeMerge, approveMerge)
 * cannot know which attempt's branch they are merging — the resolver is the
 * latest attempt, the merged work an earlier one — and by merge time every
 * tab the ticket opened is done. The Conversation host closes every tab a
 * Conversation's own launch and any resolver run (handleMergeConflict)
 * opened under its id the same way, the same reasoning applying: ending
 * time cannot know whether a resolver ran.
 */
function closeAttemptTabs(session: Session, ticketId: string): void {
  if (wasEnlisted(session, ticketId)) return;
  for (const spawned of readEvents(session.runsDir, ticketId)) {
    if (
      spawned.kind !== "spawned" ||
      typeof spawned.payload.tab_id !== "string"
    ) {
      continue;
    }
    void closeTab(session.herdrSocket, spawned.payload.tab_id).catch(() => {});
  }
}

/** The exit facts a crash interrupt body quotes (ADR-0012), frozen at raise time. */
interface CrashFacts {
  crashReason: string;
  logPath: string;
  logTail: string[];
  outcomePath: string;
  outcomeExists: boolean;
}

/**
 * The crash interrupt body (ADR-0012): the crash reason, the log path, a
 * blank line, the tail the crash event carries, and the outcome-file line,
 * so the Needs-input surface answers "what happened" without the operator
 * opening files. The reason leads (issue #127): it is the one line that
 * says why, and until it was here a launch that died on a dialog read as
 * a bare log path over an empty tail. The body persists with the pool
 * state, so the tail freezes at raise time; accepted and desired.
 */
function crashInterruptBody(result: CrashFacts): string {
  const tail = result.logTail.join("\n");
  return (
    `crash: ${result.crashReason}\n` +
    `${result.logPath}\n\n` +
    (tail ? `${tail}\n\n` : "") +
    `outcome file: ${result.outcomePath} ` +
    `(${result.outcomeExists ? "exists" : "missing"})\n`
  );
}

// Where an attempt runs. A multi-ticket super-step gives every ticket its own
// worktree branched from the same HEAD, so parallel harnesses never share a
// checkout. A ticket with a parked branch (checkpoint, crash or conflicted
// merge left it behind) always reuses its worktree, even alone, so it keeps
// the work it already did. A verify attempt always gets its own attempt
// branch and worktree, even alone in its round: grading diffs the attempt's
// commit and selection merges one attempt's branch, so a candidate never
// shares the main checkout. Anything else runs in the main checkout. The main
// checkout's Issue file is the file of record: the spawn prompt hands the
// agent its absolute path for reading and notes, and the engine writes the
// final status to it at attempt exit. The worktree gets a seed copy as
// context, and the same seed is kept under runs/ so that whatever the agent
// adds to the worktree copy and commits is carried into the file of record
// when the branch merges (mergeWithIssueAside), never discarded.
function planTicket(
  session: Session,
  marker: TicketMarker,
  readyCount: number,
  attempt: number,
  verify: boolean,
): TicketPlan {
  if (!session.git) return { cwd: session.cwd, attempt, verify };
  // A lone ready ticket runs in the pool checkout itself, except once an
  // enlist has moved that checkout onto a created pool branch (issue #101):
  // an enlisted agent works there, its HEAD is not the merge target, and an
  // attempt launched into it would commit onto the operator's branch beside
  // the operator's agent. Every ticket gets a worktree from then on.
  if (
    !verify &&
    readyCount < 2 &&
    !branchExists(session.cwd, marker.id) &&
    session.mergeTarget === null
  ) {
    return { cwd: session.cwd, attempt, verify };
  }
  const worktree = prepareWorktree(
    session.cwd,
    marker.id,
    verify ? attempt : undefined,
    mergeTargetRef(session),
  );
  const seedCopy = join(worktree.path, relative(session.cwd, marker.file));
  mkdirSync(dirname(seedCopy), { recursive: true });
  copyFileSync(marker.file, seedCopy);
  mkdirSync(session.runsDir, { recursive: true });
  copyFileSync(
    marker.file,
    join(session.runsDir, ticketSeedName(marker.id, verify ? attempt : null)),
  );
  return { cwd: worktree.path, worktree, attempt, verify };
}

// The engine owns the final status write (ADR-0005): the attempt's outcome
// JSON is the only ending signal, and anything that is not exit code 0 with a
// valid outcome is a crash. The crash reason distinguishes the classes in the
// ticket log: a dead harness, an agent that never wrote its outcome, an
// outcome that does not parse, and an outcome whose status is invalid. The
// reading itself is the Attempt-ending module's (readAttemptResult); this is
// the Outcome's validator.
export type OutcomeResult =
  | { ok: true; outcome: Outcome; spawnRejections?: SpawnRejection[] }
  | ReadFailure;

// A proposal's body must carry enough intent for a fresh agent to work from;
// anything thinner is a note, not a ticket. The prompt teaching names the
// same floor so the two cannot drift apart silently; prompt.test.ts pins the
// match against this exported constant.
export const SPAWN_BODY_MIN_CHARS = 20;

// Per-proposal spawn validation (ADR-0010, extended by the Conversations
// ADR's kind/assign): the well-formed entries come back as proposals, the
// malformed ones as rejections carrying their index and a reason. The
// outcome itself stays valid either way; the boundary decides what gets
// adopted and what gets logged. A Conversation's spawn.json batches come
// through the host to exactly this shape rather than a hand-rolled second
// copy.
function validateSpawnProposals(
  raw: unknown,
): { proposals: SpawnProposal[]; rejections: SpawnRejection[] } {
  if (raw === undefined) return { proposals: [], rejections: [] };
  if (!Array.isArray(raw)) {
    return {
      proposals: [],
      rejections: [{ reason: "spawn is not an array" }],
    };
  }
  const proposals: SpawnProposal[] = [];
  const rejections: SpawnRejection[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejections.push({ index, reason: "spawn entry is not an object" });
      return;
    }
    const proposal = entry as Record<string, unknown>;
    if (typeof proposal.title !== "string" || proposal.title.trim() === "") {
      rejections.push({ index, reason: "proposal has no title" });
      return;
    }
    if (
      typeof proposal.body !== "string" ||
      proposal.body.trim().length < SPAWN_BODY_MIN_CHARS
    ) {
      rejections.push({
        index,
        reason: `proposal body is missing or thin (needs ${SPAWN_BODY_MIN_CHARS}+ characters)`,
      });
      return;
    }
    const blockedBy = proposal.blockedBy;
    if (
      blockedBy !== undefined &&
      (!Array.isArray(blockedBy) ||
        blockedBy.some((id) => typeof id !== "string" || id.trim() === ""))
    ) {
      rejections.push({
        index,
        reason: "proposal's blockedBy is not a list of strings",
      });
      return;
    }
    const kindRaw = proposal.kind;
    if (kindRaw !== undefined && kindRaw !== "ticket" && kindRaw !== "conversation") {
      rejections.push({
        index,
        reason: `proposal's kind must be "ticket" or "conversation", got '${String(kindRaw)}'`,
      });
      return;
    }
    const assignRaw = proposal.assign;
    let assign: SpawnProposal["assign"];
    if (assignRaw !== undefined) {
      if (typeof assignRaw !== "object" || assignRaw === null || Array.isArray(assignRaw)) {
        rejections.push({ index, reason: "proposal's assign is not an object" });
        return;
      }
      const a = assignRaw as Record<string, unknown>;
      const badField = (["harness", "model", "drivers"] as const).find(
        (field) => a[field] !== undefined && typeof a[field] !== "string",
      );
      if (badField) {
        rejections.push({ index, reason: `proposal's assign.${badField} is not a string` });
        return;
      }
      assign = {
        ...(typeof a.harness === "string" ? { harness: a.harness } : {}),
        ...(typeof a.model === "string" ? { model: a.model } : {}),
        ...(typeof a.drivers === "string" ? { drivers: a.drivers } : {}),
      };
    }
    proposals.push({
      title: proposal.title,
      body: proposal.body,
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      ...(kindRaw !== undefined ? { kind: kindRaw as "ticket" | "conversation" } : {}),
      ...(assign !== undefined ? { assign } : {}),
    });
  });
  return { proposals, rejections };
}

// The outcome contract's validator, shared by the attempt reader and the
// grader reader so the two can never disagree about what a valid outcome is.
// Spawn proposals are validated per proposal (ADR-0010): malformed entries
// come back as spawnRejections and the attempt's own status stands.
export function validateOutcome(parsed: unknown): OutcomeResult {
  const outcome = parsed as Partial<Outcome> | null;
  if (outcome?.status !== "done" && outcome?.status !== "checkpoint") {
    return { ok: false, reason: "outcome's status is not done or checkpoint" };
  }
  if (typeof outcome.summary !== "string") {
    return { ok: false, reason: "outcome has no summary string" };
  }
  const spawn = validateSpawnProposals(outcome.spawn);
  return {
    ok: true,
    outcome: {
      status: outcome.status,
      summary: outcome.summary,
      commitSha: typeof outcome.commitSha === "string" ? outcome.commitSha : null,
      ...(typeof outcome.brief === "string" ? { brief: outcome.brief } : {}),
      ...(outcome.spawn !== undefined ? { spawn: spawn.proposals } : {}),
    },
    ...(spawn.rejections.length > 0
      ? { spawnRejections: spawn.rejections }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Spawn adoption (ADR-0010): the engine writes proposed tickets at the
// super-step boundary
// ---------------------------------------------------------------------------

// The spawned ticket file: an ordinary ticket with the engine-assigned id,
// the ordinary blocking edge, and spawned-by naming the ticket whose attempt
// proposed it. The marker field is what loadPoolMarkers requires for the
// reserved namespace; the body line is the provenance the Detail shows.
function writeSpawnTicket(
  session: Session,
  parentId: string,
  id: string,
  proposal: SpawnProposal,
): void {
  const blockedBy =
    proposal.blockedBy && proposal.blockedBy.length > 0
      ? proposal.blockedBy.join(",")
      : "none";
  const body =
    `<!-- state: id=${id} blocked-by=${blockedBy} status=ready spawned-by=${parentId} -->\n\n` +
    `# ${id}: ${proposal.title.trim()}\n\n` +
    `**Spawned by** ticket ${parentId} (ADR-0010): the engine wrote this ` +
    "ticket at the super-step boundary from the attempt's Outcome proposal, " +
    "engine-assigned id included. It is ordinary from here on: it " +
    "schedules, verifies, and may itself spawn, and the operator can edit " +
    "or kill it before it schedules.\n\n" +
    `${proposal.body.trim()}\n`;
  writeFileSync(join(session.issuesDir, `${id}.md`), body);
}

// The Enlist form's "Blocks" tick list writes here (spec: "Blocks is written
// onto the other tickets"): one ticket id added to another ticket's line-1
// marker. The marker edit is the whole write -- only the blocked-by token on
// line one changes, every other byte of the Ticket file is preserved -- and
// the refreshed markers come back so the caller schedules from what is now on
// disk, the same point spawn adoption re-reads the pool. A done ticket
// refuses: blocked-by gates the ticket's next Attempt, and a done ticket has
// none. The engine's second pool write beside writeSpawnTicket; only the
// engine writes the pool (ADR-0010).
export type AddBlockerResult =
  | { ok: true; changed: boolean; markers: TicketMarker[] }
  | { ok: false; reason: string };

const BLOCKED_BY_FIELD_RE = /blocked-by=\S*/;

export function addBlockerToTicket(
  poolDir: string,
  ticketId: string,
  blockerId: string,
): AddBlockerResult {
  const markers = loadPoolTickets(poolDir);
  const target = markers.find((marker) => marker.id === ticketId);
  if (!target) {
    return { ok: false, reason: `ticket ${ticketId} is not in the pool` };
  }
  if (target.status === "done") {
    return {
      ok: false,
      reason: `ticket ${ticketId} is done; blocked-by cannot be added to it`,
    };
  }
  if (target.blockedBy.includes(blockerId)) {
    return { ok: true, changed: false, markers };
  }
  const raw = readFileSync(target.file, "utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(newline);
  if (!MARKER_RE.test(lines[0])) {
    throw new Error(`marker write: ${target.file} has no line-1 state marker`);
  }
  if (!BLOCKED_BY_FIELD_RE.test(lines[0])) {
    throw new Error(`marker write: ${target.file} has no blocked-by= field`);
  }
  const blockedBy = [...target.blockedBy, blockerId].join(",");
  lines[0] = lines[0].replace(BLOCKED_BY_FIELD_RE, `blocked-by=${blockedBy}`);
  writeFileSync(target.file, lines.join(newline));
  return { ok: true, changed: true, markers: loadPoolTickets(poolDir) };
}

// ---------------------------------------------------------------------------
// Enlist (issue #101, docs/specs/2026-09-19-enlist-herdr-terminal.md)
// ---------------------------------------------------------------------------

// The next operator-enlisted id: `enlist-N`, N one past the highest already in
// the pool. The namespace is reserved (pool.ts) and hand-written tickets may
// not use it. Derived from the markers on every enlist, so a restart continues
// the same sequence.
function nextEnlistId(markers: TicketMarker[]): string {
  let max = 0;
  for (const marker of markers) {
    const n = parseEnlistId(marker.id);
    if (n !== null) max = Math.max(max, n);
  }
  return `enlist-${max + 1}`;
}

// The pane ids a live attempt or a live Conversation already holds: the same
// "already in the pool" judgement the picker route builds, from the engine's
// own registries rather than the last snapshot.
function registeredPanesOf(session: Session): Set<string> {
  const panes = new Set<string>();
  for (const record of Object.values(
    session.liveAttempts.records((id) => session.conversations.isLive(id)),
  )) {
    if (record.paneId) panes.add(record.paneId);
  }
  for (const view of session.conversations.views()) {
    if (view.paneId) panes.add(view.paneId);
  }
  return panes;
}

// The enlisted ticket file, written as writeSpawnTicket writes a Spawn: a
// line-1 marker in progress from the first moment (the attempt is already
// running), an empty blocked-by, the operator's title and spec, and a
// provenance paragraph naming the pane, directory, branch and harness session
// it was enlisted from. `enlisted-from` is the marker field the reserved
// `enlist-` namespace requires.
function writeEnlistTicket(
  session: Session,
  id: string,
  fields: {
    title: string;
    spec: string;
    paneId: string;
    harness: string;
    sessionId: string | null;
    directory: string;
    branch: string;
    branchRule: "created" | "as-found";
  },
): void {
  const sessionNote = fields.sessionId ? `, session ${fields.sessionId}` : "";
  const branchNote =
    fields.branchRule === "created"
      ? `The pool branch ${fields.branch} was created at that HEAD and ` +
        "checked out there, so uncommitted changes came with it."
      : `The branch was used as found; nothing in the checkout moved.`;
  const body =
    `<!-- state: id=${id} blocked-by=none status=in-progress ` +
    `enlisted-from=${fields.paneId} -->\n\n` +
    `# ${id}: ${fields.title.trim()}\n\n` +
    `**Enlisted** (issue #101) from herdr pane ${fields.paneId} ` +
    `(harness ${fields.harness}${sessionNote}) in ${fields.directory}, on ` +
    `branch ${fields.branch}. ${branchNote}\n\n` +
    `${fields.spec.trim()}\n`;
  // A Seeded Pool (one that opts in via conversations/, per pool.ts) may
  // boot with no issues/ directory on disk at all; Enlist-as-Ticket is how
  // such a pool gets its first Ticket, so the directory has to be made here
  // rather than assumed.
  mkdirSync(session.issuesDir, { recursive: true });
  writeFileSync(join(session.issuesDir, `${id}.md`), body);
}

/**
 * Apply the branch rule (spec "Branch rule") to the pane an enlist picked,
 * the one piece both arms share. A checkout on the merge target gets a fresh
 * `pool/<pool>/<id>` at HEAD, checked out in place so uncommitted changes
 * come along; any other branch is used as found. Returns the branch the
 * enlisted unit runs on, which rule applied, and whether the engine created
 * one (so a failed enlist knows to remove what it made).
 */
function applyEnlistBranchRule(
  session: Session,
  pane: { branch: string; directory: string },
  id: string,
): {
  branch: string;
  rule: "created" | "as-found";
  created: boolean;
  /** Whether this enlist captured the pool's merge target (see below). */
  captured: boolean;
} {
  const poolBranch = branchFor(session.cwd, id);
  // Against the merge target, not the live checkout: an earlier enlist may
  // have moved the pool's own checkout onto its created pool branch, and a
  // pane on the target is still on the target.
  if (pane.branch !== mergeTargetBranch(session)) {
    return { branch: pane.branch, rule: "as-found", created: false, captured: false };
  }
  const probe = checkoutNewBranch(pane.directory, poolBranch);
  if (!probe.ok) {
    throw new Error(
      `enlist: could not create branch ${poolBranch} in ${pane.directory} ` +
        `(${probe.err || probe.out})`,
    );
  }
  // The checkout has moved onto a branch the engine created, so the branch
  // it was on is the pool's merge target from here on (ticket 04-spawn-1),
  // and the checkout is the operator's for the rest of the pool's life: the
  // engine merges in its own merge checkout and gives every ticket a
  // worktree (`withMergeCheckout`, `planTicket`). Only a move in the pool's
  // own checkout needs capturing: a linked worktree on the merge target
  // leaves `session.cwd` where it is, and its merge already lands into the
  // live branch. Compare top levels, not directories: a pane open in a
  // subdirectory moves the whole checkout too. Captured after the move, so
  // a move that failed captures nothing.
  const paneTop = git(pane.directory, ["rev-parse", "--show-toplevel"]).out;
  const cwdTop = git(session.cwd, ["rev-parse", "--show-toplevel"]).out;
  const captured = paneTop !== "" && paneTop === cwdTop && session.mergeTarget === null;
  if (captured) session.mergeTarget = pane.branch;
  return { branch: poolBranch, rule: "created", created: true, captured };
}

/**
 * Enlist a live herdr pane as a Conversation (issue #101): re-judge the
 * picked pane, apply the branch rule, then let the Conversation module claim
 * the pane and register the runtime the way `start` does after its launch,
 * skipping the launch. The id is minted here (conv-N, as a started
 * Conversation) before the branch rule names the pool branch, and passed
 * through. Nothing is written before the claim; a claim that fails unwinds
 * the branch the engine may have created, so a failed enlist leaves no file
 * and no branch.
 */
async function enlistConversation(
  session: Session,
  req: EnlistConversationWireRequest,
): Promise<EnlistResponse> {
  const title = (req.title ?? "").trim();
  if (!title) throw new Error("enlist: title is required");
  if (!session.git) {
    throw new Error(
      "enlist: the pool has no git checkout, so it cannot give the Conversation a branch",
    );
  }
  if (!attemptEnvOf(session).terminalBacked) {
    throw new Error(
      'enlist: the pool is not terminal-backed (set console.json "terminal": "herdr")',
    );
  }

  const found = await findEnlistablePane({
    socketPath: session.herdrSocket,
    poolDir: session.poolDir,
    paneId: req.paneId,
    registeredPanes: registeredPanesOf(session),
  });
  if (!found.ok) throw new Error(`enlist: ${found.reason}`);
  const pane = found.pane;

  // The Conversation id is minted before the branch rule, because the branch
  // it creates is named for it (as the Ticket arm's is for the enlist id).
  const existing = loadConversations(join(session.poolDir, "conversations"));
  const id = nextConversationId(
    existing,
    new Set(session.conversations.reservedIds()),
  );

  const rule = applyEnlistBranchRule(session, pane, id);
  const branchRule = rule.rule;
  const usedBranch = rule.branch;
  const branchCreated = rule.created;
  const capturedTarget = rule.captured;

  const result = await session.conversations.enlist({
    id,
    paneId: pane.paneId,
    tabId: pane.tabId,
    harness: pane.harness,
    title,
    ...(req.opening ? { opening: req.opening } : {}),
    directory: pane.directory,
    branch: usedBranch,
    sessionId: pane.sessionId,
  });
  if (!result.ok) {
    if (branchCreated) removeEnlistedBranch(pane.directory, pane.branch, usedBranch);
    if (capturedTarget) session.mergeTarget = null;
    throw new Error(`enlist: ${result.reason}`);
  }

  // The lifecycle trail, in the same shape a terminal-backed Ticket's events
  // file has: the pre-existing pane id, the found branch and which branch
  // rule applied. Written after the claim, so a failure above leaves none.
  appendEvent(session.runsDir, id, {
    at: new Date().toISOString(),
    attempt: 1,
    kind: "scheduled",
    payload: {},
  });
  appendEvent(session.runsDir, id, {
    at: new Date().toISOString(),
    attempt: 1,
    kind: "spawned",
    payload: {
      argv: [],
      cwd: pane.directory,
      branch: usedBranch,
      commitSha: commitShaAt(pane.directory),
      env: engineEnvSet(spawnEnv(pane.directory)),
      pane_id: pane.paneId,
      tab_id: pane.tabId,
      harness: pane.harness.toLowerCase(),
      branch_rule: branchRule,
      merge_target: session.mergeTarget,
    },
  });
  session.state = applyUpdate(session.state, {
    log: [
      branchRule === "created"
        ? `conversation ${id}: enlisted from pane ${pane.paneId}; branch ` +
          `${usedBranch} created at HEAD and checked out in ${pane.directory}`
        : `conversation ${id}: enlisted from pane ${pane.paneId}; branch ` +
          `${pane.branch} used as found in ${pane.directory}`,
    ],
  });
  // The module published before the log line was written: emit once more so
  // the stream carries it now rather than at the next unrelated tick.
  emitSnapshot(session, session.settledPhase ?? "running");
  return { conversationId: id };
}

/**
 * Enlist a live herdr pane as a Ticket (issue #101), the one-shot
 * orchestration behind `POST /api/enlist`: re-judge the picked pane against
 * herdr, apply the branch rule, register the runtime and claim the pane, then
 * write the pool (the ticket file, the "Blocks" edits, the events, the marker,
 * the Live attempt). Every failure before the runtime is claimed throws
 * before anything is written; a claim that fails unwinds the checkout it may
 * have branched, and a write that fails after the claim unwinds everything
 * (file, edits, branch, registration, agent identity), so a failed enlist
 * leaves nothing behind.
 */
export async function enlistTicket(
  session: Session,
  req: EnlistTicketRequest,
): Promise<EnlistResponse> {
  const title = (req.title ?? "").trim();
  if (!title) throw new Error("enlist: title is required");
  if (!session.git) {
    throw new Error("enlist: the pool has no git checkout, so it cannot give the ticket a branch");
  }
  if (!attemptEnvOf(session).terminalBacked) {
    throw new Error(
      'enlist: the pool is not terminal-backed (set console.json "terminal": "herdr")',
    );
  }

  const found = await findEnlistablePane({
    socketPath: session.herdrSocket,
    poolDir: session.poolDir,
    paneId: req.paneId,
    registeredPanes: registeredPanesOf(session),
  });
  if (!found.ok) throw new Error(`enlist: ${found.reason}`);
  const pane = found.pane;

  // Every ticked ticket is validated before any write, so a bad "Blocks"
  // entry fails the whole enlist rather than leaving half the edits applied.
  const blocks = [...new Set(req.blocks ?? [])];
  for (const blockerId of blocks) {
    const target = session.markers.find((marker) => marker.id === blockerId);
    if (!target) {
      throw new Error(`enlist: ticket ${blockerId} is not in the pool`);
    }
    if (target.status === "done") {
      throw new Error(
        `enlist: ticket ${blockerId} is done; a done ticket cannot wait on anything`,
      );
    }
  }

  const id = nextEnlistId(session.markers);
  const rule = applyEnlistBranchRule(session, pane, id);
  const branchRule = rule.rule;
  const usedBranch = rule.branch;
  const branchCreated = rule.created;
  const capturedTarget = rule.captured;

  const issuePath = join(session.issuesDir, `${id}.md`);
  const outcomePath = join(session.runsDir, attemptOutcomeName(id, null, false));
  const teaching = buildEnlistTeaching({
    id,
    issuePath,
    outcomePath,
    branch: usedBranch,
  });

  // The claim: report the agent identity, relabel the operator's tab and type
  // the teaching Turn (queued when the pane is working). A teaching Turn that
  // cannot be delivered is the one claim failure that unwinds.
  const registration = await session.enlisted.register({
    id,
    paneId: pane.paneId,
    tabId: pane.tabId,
    harness: pane.harness,
    title,
    branch: usedBranch,
    directory: pane.directory,
    outcomePath,
    teaching,
  });
  if (!registration.ok) {
    if (branchCreated) removeEnlistedBranch(pane.directory, pane.branch, usedBranch);
    if (capturedTarget) session.mergeTarget = null;
    throw new Error(`enlist: ${registration.reason}`);
  }

  // From here the runtime is live; every failure unwinds it completely.
  const restoredFiles: { file: string; original: string }[] = [];
  const restoredBlockers: { id: string; blockedBy: string[] }[] = [];
  try {
    writeEnlistTicket(session, id, {
      title,
      spec: req.spec ?? "",
      paneId: pane.paneId,
      harness: pane.harness,
      sessionId: pane.sessionId,
      directory: pane.directory,
      branch: usedBranch,
      branchRule,
    });

    appendEvent(session.runsDir, id, {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "scheduled",
      payload: {},
    });
    appendEvent(session.runsDir, id, {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: {
        argv: [],
        cwd: pane.directory,
        branch: usedBranch,
        commitSha: commitShaAt(pane.directory),
        env: engineEnvSet(spawnEnv(pane.directory)),
        pane_id: pane.paneId,
        tab_id: pane.tabId,
        harness: pane.harness.toLowerCase(),
        branch_rule: branchRule,
        merge_target: session.mergeTarget,
      },
    });

    for (const blockerId of blocks) {
      const target = session.markers.find((marker) => marker.id === blockerId)!;
      restoredFiles.push({
        file: target.file,
        original: readFileSync(target.file, "utf8"),
      });
      restoredBlockers.push({ id: target.id, blockedBy: [...target.blockedBy] });
      const result = addBlockerToTicket(session.poolDir, blockerId, id);
      if (!result.ok) {
        throw new Error(
          `enlist: could not add ${id} to ${blockerId}'s blocked-by ` +
            `(${result.reason})`,
        );
      }
      // Keep the in-memory marker in step with the file: the next super-step
      // boundary's ready set reads it, and the ticked ticket must be gated.
      if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
    }

    const marker: TicketMarker = {
      id,
      file: issuePath,
      blockedBy: [],
      status: "in-progress",
      title,
      spec: (req.spec ?? "").trim(),
      enlistedFrom: pane.paneId,
    };
    session.markers.push(marker);
    session.state = applyUpdate(session.state, {
      tickets: { [id]: "in-progress" },
      log: [
        branchRule === "created"
          ? `ticket ${id}: enlisted from pane ${pane.paneId}; branch ` +
            `${usedBranch} created at HEAD and checked out in ${pane.directory}`
          : `ticket ${id}: enlisted from pane ${pane.paneId}; branch ` +
            `${pane.branch} used as found in ${pane.directory}`,
      ],
    });
    // The Assignment as found: the harness herdr named, model and drivers
    // unknown (the card reads "as found" where the model would be). Recorded
    // now so a config reload never reassigns an attempt already in flight.
    session.assignments.set(id, {
      harness: pane.harness.toLowerCase(),
      model: "",
      drivers: DEFAULT_DRIVERS,
    });
    // The found work, for the merge hold and the merge paths: an enlisted
    // ticket has no `pool/<pool>/<id>` branch, so they read this instead.
    session.enlistedWork.set(id, {
      branch: usedBranch,
      directory: pane.directory,
    });
    // Verify is ignored for an enlisted Ticket (spec "Verify is ignored"):
    // there is nothing to run N of, because the one attempt is already in
    // flight. Logged once here, at enlist.
    const configuredVerify = session.state.config.assign?.[id]?.verify;
    if (configuredVerify != null) {
      session.state = applyUpdate(session.state, {
        log: [
          `ticket ${id}: verify: ${configuredVerify} ignored; an enlisted ` +
            "ticket runs ungraded",
        ],
      });
    }
    // Registration is the allowlist peek and focus read (spec): the moment
    // this lands, the card's pane resolves and a snapshot goes out.
    session.liveAttempts.register(id, 1, {
      paneId: pane.paneId,
      tabId: pane.tabId,
    });
  } catch (err) {
    unwindEnlist(session, id, {
      restoredFiles,
      restoredBlockers,
      branchCreated,
      capturedTarget,
      directory: pane.directory,
      foundBranch: pane.branch,
      poolBranch: usedBranch,
      paneId: pane.paneId,
      harness: pane.harness,
    });
    throw err;
  }

  return { ticketId: id };
}

// Undo a failed enlist (spec "Failed enlist leaves nothing"): stop the
// runtime, drop the ticket file and its events, restore every edited marker
// byte for byte, remove the marker from the session, release the pane's agent
// identity, and remove the branch the enlist created. Every step is
// best-effort so one failure cannot block the rest of the unwind. The found
// branch and directory are never touched.
function unwindEnlist(
  session: Session,
  id: string,
  state: {
    restoredFiles: { file: string; original: string }[];
    restoredBlockers: { id: string; blockedBy: string[] }[];
    branchCreated: boolean;
    capturedTarget: boolean;
    directory: string;
    foundBranch: string;
    poolBranch: string;
    paneId: string;
    harness: string;
  },
): void {
  try {
    session.enlisted.release(id);
  } catch {
    // Best-effort.
  }
  session.liveAttempts.clear(id, 1);
  session.markers = session.markers.filter((marker) => marker.id !== id);
  const tickets = { ...session.state.tickets };
  delete tickets[id];
  session.state = { ...session.state, tickets };
  session.assignments.delete(id);
  session.enlistedWork.delete(id);
  // A failed enlist that had moved the pool checkout moves it back below, so
  // the live branch read is right again and the captured target must go
  // with it, or every later merge would run against a stale target.
  if (state.capturedTarget) session.mergeTarget = null;
  try {
    rmSync(join(session.issuesDir, `${id}.md`), { force: true });
    rmSync(join(session.runsDir, `${id}.events.jsonl`), { force: true });
  } catch {
    // Best-effort.
  }
  for (const restored of state.restoredFiles) {
    try {
      writeFileSync(restored.file, restored.original);
    } catch {
      // Best-effort.
    }
  }
  for (const restored of state.restoredBlockers) {
    const marker = session.markers.find((candidate) => candidate.id === restored.id);
    if (marker) marker.blockedBy = restored.blockedBy;
  }
  // The identity the enlist reported goes with the failed attempt, the way
  // it goes at every other ending (issue #94): best-effort, silent.
  void releasePaneAgent(
    session.herdrSocket,
    state.paneId,
    state.harness.toLowerCase(),
  ).catch(() => {});
  if (state.branchCreated) {
    removeEnlistedBranch(state.directory, state.foundBranch, state.poolBranch);
  }
}

// Put a checkout back on the branch it was found on and delete the pool
// branch the enlist created there. Only the branch the engine made is
// removed; the found branch is never deleted (spec: the engine never removes
// the directory or deletes the found branch).
function removeEnlistedBranch(
  directory: string,
  foundBranch: string,
  poolBranch: string,
): void {
  git(directory, ["checkout", foundBranch]);
  git(directory, ["branch", "-D", poolBranch]);
}

// The highest spawn number already adopted per parent, so a parent whose
// attempts propose across the whole run numbers continuously. Derived from
// the markers on every adoption, so a restart continues the same sequence.
function spawnCounters(markers: TicketMarker[]): Map<string, number> {
  const counters = new Map<string, number>();
  for (const marker of markers) {
    const spawn = parseSpawnId(marker.id);
    if (!spawn) continue;
    counters.set(spawn.parent, Math.max(counters.get(spawn.parent) ?? 0, spawn.n));
  }
  return counters;
}

// The Conversations ADR's extension: a parent's ticket-spawns and
// Conversation-spawns share one `<parent>-spawn-N` namespace (both are
// "what this parent spawned"), so the counter that hands out the next N must
// see both kinds of existing child or the two could mint the same id (a
// ticket `x-spawn-1` already on disk, a Conversation `x-spawn-1` about to be
// created from a separate proposal). parseSpawnId's regex is id-shape-only,
// so it works unchanged on a Conversation's own `<parent>-spawn-N` id.
function combinedSpawnCounters(session: Session): Map<string, number> {
  const counters = spawnCounters(session.markers);
  for (const rec of loadConversations(join(session.poolDir, "conversations"))) {
    const spawn = parseSpawnId(rec.id);
    if (!spawn) continue;
    counters.set(spawn.parent, Math.max(counters.get(spawn.parent) ?? 0, spawn.n));
  }
  // A kind:"conversation" proposal already adopted this tick (or a still
  // in-flight one from an earlier adoptSpawnProposals call) may not have
  // its record on disk yet — the module writes it well after opening the
  // herdr tab, and start is never awaited here — so an id the module holds
  // reserved counts the same as an on-disk one, or a second call could mint
  // the same `<parent>-spawn-N` before the first's write ever lands.
  for (const reserved of session.conversations.reservedIds()) {
    const spawn = parseSpawnId(reserved);
    if (!spawn) continue;
    counters.set(spawn.parent, Math.max(counters.get(spawn.parent) ?? 0, spawn.n));
  }
  return counters;
}

// The ids of every Conversation the pool has ever recorded (live, ended, or
// crashed): the Conversations ADR's "known parent" set threaded through
// loadPoolMarkers so a Ticket whose spawned-by names a Conversation survives
// the reload the way one whose spawned-by names a Ticket always has, and
// through adoptSpawnProposals's blockedBy check so a proposal blocked on a
// Conversation is rejected with a reason naming that specifically, not
// folded into "names tickets outside the pool".
function knownConversationIds(poolDir: string): Set<string> {
  return new Set(loadConversations(join(poolDir, "conversations")).map((r) => r.id));
}

/**
 * The pool's Tickets as every reader loads them: startPool, each boundary
 * reload, and the server's pre-flight and per-snapshot meta (issue #71,
 * where the server's own bare loadPoolMarkers call refused the empty issues/
 * startPool would have accepted, so a Conversation-only pool could never
 * boot through the one entry point an operator has). Two rules ride along
 * with the parse, and they belong to every load or none:
 *
 * - The pool's recorded Conversations are the known parents, so a Ticket a
 *   Conversation spawned survives the load the way one a Ticket spawned
 *   always has (see knownConversationIds).
 * - A pool with a conversations/ directory (even an empty one — the
 *   operator creates it to say "this pool hosts Conversations", and the
 *   first Conversation ever started there creates it too) has proven it is
 *   not the "accidental empty pool" mistake loadPoolMarkers's bare throw
 *   exists to catch, so an empty issues/ loads as zero Tickets. That also
 *   keeps a boundary reload from throwing on a Conversation-only pool whose
 *   Conversations have only ever spawned more Conversations. The
 *   `allowEmptyIssues` flag covers the one case that can't infer itself: a
 *   caller that wants a Ticket-less pool to boot before its first
 *   Conversation has ever started and before the directory exists (a test).
 */
export function loadPoolTickets(poolDir: string, allowEmptyIssues = false): TicketMarker[] {
  return loadPoolMarkers(join(poolDir, "issues"), knownConversationIds(poolDir), {
    allowEmptyIssues: allowEmptyIssues || existsSync(join(poolDir, "conversations")),
  });
}

// The boundary's spawn adoption (ADR-0010, extended by the Conversations
// ADR): every buffered proposal is validated against the pool as the
// boundary found it, the accepted ones are written as ordinary ticket files
// or started as Conversations, and the pool's markers and assignments
// reload so the drive loop schedules the ticket ones like any other. Every
// aspect of that stays per proposal, never per batch: a dropped proposal
// logs its reason on the proposing parent's log (a spawn-rejected event) and
// the parent's own result stands. The per-proposal cap (5) always applies;
// the per-run cap (20) is skipped for a Conversation's own spawn.json batch
// (spec: "no run-wide cap for Conversation Spawns" — a Ticket's outcome.spawn
// still counts against it, `origin: "ticket"`, whatever kind its entries
// request). Writing the files is the commit point; a crash after them but
// before the reload leaves the adopted tickets in the pool for the next
// start, ids stable. The Conversation host calls this directly when the
// engine is idle (nothing else would reach this boundary for it otherwise).
function adoptSpawnProposals(session: Session): void {
  if (session.pendingSpawns.length === 0) return;
  const pending = session.pendingSpawns.splice(0);
  // Membership validates against the markers as the boundary found them, so
  // a proposal naming another proposal's future id drops as unknown: the
  // agent never proposes ids and cannot know one.
  const knownIds = new Set(session.markers.map((m) => m.id));
  const knownConvIds = knownConversationIds(session.poolDir);
  const counters = combinedSpawnCounters(session);
  const log: string[] = [];
  let wrote = false;

  for (const { parentId, proposals, origin } of pending) {
    const accepted: SpawnProposal[] = [];
    for (const proposal of proposals) {
      const conversationBlockers = (proposal.blockedBy ?? []).filter((id) =>
        knownConvIds.has(id),
      );
      const unknownTickets = (proposal.blockedBy ?? []).filter(
        (id) => !knownIds.has(id) && !knownConvIds.has(id),
      );
      if (conversationBlockers.length > 0 || unknownTickets.length > 0) {
        const reasons: string[] = [];
        if (conversationBlockers.length > 0) {
          reasons.push(
            `blockedBy names Conversations, which cannot block a ticket: ` +
              conversationBlockers.join(", "),
          );
        }
        if (unknownTickets.length > 0) {
          reasons.push(
            `blockedBy names tickets outside the pool: ${unknownTickets.join(", ")}`,
          );
        }
        const reason = reasons.join("; ");
        appendEvent(session.runsDir, parentId, {
          at: new Date().toISOString(),
          attempt: lastAttempt(session.runsDir, parentId),
          kind: "spawn-rejected",
          payload: { title: proposal.title, reason },
        });
        log.push(
          `ticket ${parentId}: spawn proposal '${proposal.title}' ` +
            `rejected: ${reason}`,
        );
        continue;
      }
      if (proposal.assign?.harness && !session.harnesses[proposal.assign.harness]) {
        const reason = `assign.harness names unknown harness '${proposal.assign.harness}'`;
        appendEvent(session.runsDir, parentId, {
          at: new Date().toISOString(),
          attempt: lastAttempt(session.runsDir, parentId),
          kind: "spawn-rejected",
          payload: { title: proposal.title, reason },
        });
        log.push(
          `ticket ${parentId}: spawn proposal '${proposal.title}' ` +
            `rejected: ${reason}`,
        );
        continue;
      }
      accepted.push(proposal);
    }
    // The per-proposal cap honors the first five survivors, always. The
    // per-run cap truncates whatever the run has no room left for, but only
    // for a Ticket's own outcome.spawn: a Conversation's spawn.json has none.
    let truncated = 0;
    let honored = accepted.slice(0, SPAWN_MAX_PER_ATTEMPT);
    truncated += accepted.length - honored.length;
    if (origin !== "conversation") {
      const room = Math.max(0, SPAWN_MAX_PER_RUN - session.spawnedThisRun);
      if (honored.length > room) {
        truncated += honored.length - room;
        honored = honored.slice(0, room);
      }
    }
    const adopted: string[] = [];
    for (const proposal of honored) {
      const n = (counters.get(parentId) ?? 0) + 1;
      counters.set(parentId, n);
      const id = `${parentId}-spawn-${n}`;
      if (proposal.kind === "conversation") {
        // Fire-and-forget: startConversation opens a herdr tab and waits up
        // to 60s for the TUI's ready frame (pane-session.ts's
        // READINESS_TIMEOUT_MS), and this boundary is synchronous by
        // ADR-0010's own contract (write-then-reload, never awaited). A
        // launch failure is logged on the proposing parent, the same
        // disposition a malformed proposal gets; the child Conversation
        // itself joins the module's views (or is recorded crashed) once its
        // own launch settles, same as an operator-started one racing the
        // snapshot stream. The module holds the id reserved until then, so
        // a second adoptSpawnProposals call before this Conversation's own
        // record hits disk cannot mint it again (combinedSpawnCounters).
        void session.conversations
          .start({
            id,
            title: proposal.title.trim(),
            opening: proposal.body,
            assign: proposal.assign,
            spawnedBy: parentId,
          })
          .catch((err) => {
            appendEvent(session.runsDir, parentId, {
              at: new Date().toISOString(),
              attempt: lastAttempt(session.runsDir, parentId),
              kind: "spawn-rejected",
              payload: {
                title: proposal.title,
                reason: `conversation start failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            });
          });
      } else {
        writeSpawnTicket(session, parentId, id, proposal);
        wrote = true;
      }
      adopted.push(id);
      if (origin !== "conversation") session.spawnedThisRun += 1;
    }
    if (adopted.length > 0 || truncated > 0) {
      appendEvent(session.runsDir, parentId, {
        at: new Date().toISOString(),
        attempt: lastAttempt(session.runsDir, parentId),
        kind: "spawn-adopted",
        payload: { adopted, truncated },
      });
    }
    if (adopted.length > 0) {
      log.push(
        `ticket ${parentId}: adopted spawn tickets ${adopted.join(", ")}` +
          (truncated > 0
            ? `; ${truncated} proposal${truncated === 1 ? "" : "s"} ` +
              "truncated at the caps (5 per attempt, 20 per run)"
            : ""),
      );
    } else if (truncated > 0) {
      log.push(
        `ticket ${parentId}: ${truncated} proposal${truncated === 1 ? "" : "s"} ` +
          "truncated at the caps (5 per attempt, 20 per run)",
      );
    }
  }

  if (log.length > 0) {
    session.state = applyUpdate(session.state, { log });
  }
  if (!wrote) return;
  // The adopted files join the pool the way answer processing brings a
  // hand-written ticket in: markers reload, unseen ids resolve their
  // assignments (parent inheritance), and the tickets channel folds them in
  // at their on-disk statuses.
  session.markers = loadPoolTickets(session.poolDir);
  resolveUnseenAssignments(
    session.markers,
    session.assignments,
    session.state.config,
    session.harnesses,
  );
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(session.markers.map((m) => [m.id, m.status])),
  });
}

// Merging one finished ticket's branch onto the pool's working branch.
function mergeTicket(
  session: Session,
  marker: TicketMarker,
  worktree: WorktreeInfo,
): MergeResult {
  const result = mergeWithIssueAside(session, marker, worktree.branch);
  if (result.ok) removeMergeWorktree(session, marker, worktree);
  return result;
}

// Remove a merge's worktree, except for an enlisted ticket (issue #101): its
// checkout is the operator's found directory and its branch is the found
// branch, and the engine's standing promise is to leave both alone at merge
// and at every other time. The guard lives here, on the one path to
// `removeWorktree`'s `worktree remove --force` and `branch -d`, rather than
// at each caller: an enlisted ticket reaches the other merge paths only by
// being unreachable there today, and an unreachability argument is not what
// a promise this load-bearing should rest on. `enlistedFrom` is the durable
// half of the test because `enlistedWork` is dropped at a pane-gone
// checkpoint, while the marker remembers the pane for the ticket's life.
function removeMergeWorktree(
  session: Session,
  marker: TicketMarker,
  worktree: WorktreeInfo,
): void {
  if (marker.enlistedFrom !== undefined || session.enlistedWork.has(marker.id)) {
    return;
  }
  removeWorktree(session.cwd, worktree);
}

// The lifecycle event a failed merge records: merge-blocked names the files
// in the way of a merge git refused to start (#92), merge-conflict the
// unmerged paths of one it started.
function recordFailedMerge(
  session: Session,
  ticketId: string,
  attempt: number,
  result: MergeResult,
): void {
  appendEvent(session.runsDir, ticketId, {
    at: new Date().toISOString(),
    attempt,
    kind: result.reason === "blocked" ? "merge-blocked" : "merge-conflict",
    payload: {
      files: result.reason === "blocked" ? result.blocked : result.conflicted,
    },
  });
}

// The merged event's payload: the untracked pool copies the merge deleted
// because they matched the branch's version byte for byte (#92), when any.
function mergedPayload(result: MergeResult): Record<string, unknown> {
  return result.cleared.length > 0 ? { cleared: result.cleared } : {};
}

// The interrupt for a merge that did not land, in either of its shapes: a
// conflict git started and the engine aborted, or a merge git refused
// before starting because untracked pool files stood in its way (#92).
// Both keep the merge-conflict kind (resume re-attempts the merge); only
// the body differs, and a blocked one never claims anything conflicted.
function mergeConflictInterrupt(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
): Interrupt {
  const worktree = ticketWorktree(session, marker);
  const branch = worktree.branch;
  const parked =
    `the ticket's work is parked on branch ${branch}, checked out at ` +
    `${worktree.path}.\n` +
    (result.detail ? `git said: ${result.detail}\n` : "");
  if (result.reason === "blocked") {
    return {
      ticketId: marker.id,
      kind: "merge-conflict",
      body:
        `merging ${branch} onto the working branch was blocked: ` +
        blockedMergeExplanation(session.cwd, result) +
        parked,
    };
  }
  const files =
    result.conflicted.length > 0
      ? result.conflicted.join(", ")
      : "(no unmerged paths listed)";
  return {
    ticketId: marker.id,
    kind: "merge-conflict",
    body:
      `merging ${branch} onto the working branch failed; the merge was ` +
      "aborted and the working branch was left clean.\n" +
      `conflicted files: ${files}\n` +
      parked +
      "resolve the conflict and resume this ticket; the merge is " +
      "re-attempted on resume.",
  };
}

// The manual-resolution interrupt: the resolver path's merge-conflict, with
// what the resolver tried noted for the human. A blocked merge never
// reached a resolver's resolution, so its body stands alone.
function manualMergeInterrupt(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attemptNote: string,
): Interrupt {
  const base = mergeConflictInterrupt(session, marker, result);
  if (result.reason === "blocked") return base;
  return {
    ...base,
    body: `${base.body}\nThe resolver agent attempted: ${attemptNote}`,
  };
}

async function runTicket(
  marker: TicketMarker,
  snapshot: PoolState,
  assignment: Assignment,
  env: TicketEnv,
  plan: TicketPlan,
): Promise<TicketResult> {
  const [driver, ...chain] = assignment.drivers.split(/\s+/).filter(Boolean);
  // A verify attempt writes its attempt-numbered files directly: N parallel
  // attempts cannot share the well-known paths, and the number is known at
  // scheduling time. A solo attempt keeps the well-known paths plus rotation.
  const naming = { attempt: plan.verify ? plan.attempt : null, resolver: false };
  const outcomePath = join(
    env.runsDir,
    attemptOutcomeName(marker.id, naming.attempt, false),
  );

  const upstream = marker.blockedBy.flatMap((id) => {
    const outcome = snapshot.outcomes[id];
    return outcome ? [{ id, outcome }] : [];
  });

  // AGENT.md is read at every spawn, never cached on the session, so an
  // operator's mid-run edit lands in the very next attempt's prompt.
  const agentMd = readOptional(join(env.poolDir, "AGENT.md")) ?? "";

  const prompt = buildPrompt({
    chain,
    agentMd,
    roster: snapshot.config.roster ?? "",
    upstream,
    outcomePath,
  });

  // The attempt itself is the Attempt-run module's (ADR-0014): spawn,
  // ending, result, and the exited and crash events on the ticket log. The
  // exited status on a clean exit is the Outcome's own (done or checkpoint).
  const run = await runAttempt(
    env,
    {
      id: marker.id,
      issuePath: marker.file,
      title: marker.title,
      body: prompt,
      driver,
      harness: assignment.harness,
      model: assignment.model,
      cwd: plan.cwd,
      branch: plan.worktree?.branch ?? null,
      attempt: plan.attempt,
      naming,
      rotate: plan.verify ? "none" : "exited",
      fallback: "headless",
      prompt: { kind: "driver" },
      crashSubject: "harness",
      events: {
        kind: "full",
        exitedStatus: (result) => result.outcome.status,
        // Malformed spawn entries were dropped per proposal at validation
        // (ADR-0010); each reason lands on the ticket's log at the exit that
        // produced it, ahead of the exited event, for verify candidates and
        // solo attempts alike.
        resultEvents: (result) =>
          (result.spawnRejections ?? []).map((rejection) => ({
            kind: "spawn-rejected" as const,
            payload: {
              reason: rejection.reason,
              ...(rejection.index !== undefined ? { index: rejection.index } : {}),
            },
          })),
      },
    },
    validateOutcome,
  );
  // The ending comes from the outcome JSON alone (ADR-0005). On a clean exit
  // with a valid outcome the engine writes the final status to the canonical
  // Issue's marker itself; a marker the agent rewrote is never honored. A
  // verify candidate writes no status anywhere at its exit: the ticket is
  // in-progress until the whole fan-out has exited, and grading decides what
  // happens after (tickets 03 and 04).
  let status: TicketStatus = "in-progress";
  if (run.ok) {
    status = run.result.outcome.status;
    if (!plan.verify) {
      writeMarkerStatus(marker.file, status);
      if (status === "checkpoint") {
        // Before the return: the drive loop raises the checkpoint's interrupt
        // from the Issue's Brief section the moment this attempt exits.
        landCheckpointBrief(marker.file, run.result.outcome.brief);
      }
    }
  } else if (!plan.verify && readMarker(marker.file).status !== "in-progress") {
    writeMarkerStatus(marker.file, "in-progress");
  }

  return {
    marker,
    status,
    logPath: run.logPath,
    exitCode: run.code,
    plan,
    joinedAtExit: false,
    logTail: run.logTail,
    outcomePath: run.outcomePath,
    outcomeExists: run.outcomeExists,
    crashReason: run.crashReason,
    spawnProposals:
      run.ok && !plan.verify ? (run.result.outcome.spawn ?? []) : undefined,
    update: {
      // A verify candidate moves only the pool log: the tickets and outcomes
      // channels are keyed by ticket id, and N attempts of one ticket would
      // clobber each other there and write a status the fan-out must not
      // write. The events file and the per-attempt files are the record.
      ...(plan.verify ? {} : { tickets: { [marker.id]: status } }),
      log: [
        plan.verify
          ? `ticket ${marker.id}: attempt ${plan.attempt} ` +
            `${exitedPhrase(run.code)} (${status})` +
            (run.crashReason !== null ? `, crash: ${run.crashReason}` : "")
          : `ticket ${marker.id}: ${exitedPhrase(run.code)}, marker ${status}` +
            (run.crashReason !== null ? `, crash: ${run.crashReason}` : ""),
      ],
      ...(run.result.ok && !plan.verify
        ? { outcomes: { [marker.id]: run.result.outcome } }
        : {}),
    },
  };
}

// An ordinary ticket's Assignment: its assign entry over the pool defaults.
// Resolution is lenient: a ticket with no assign entry and no defaults
// resolves to empty harness and model (nulls on the wire), so the
// misconfiguration renders on the canvas instead of failing pool load. The
// pool config error for it fires at the spawn sites, in harnessCommandFor;
// only a named-but-unknown harness still fails here, at load, as it always
// has.
export function resolveTicketAssignment(
  marker: TicketMarker,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  return resolveAssignment({
    subject: `pool config: ticket ${marker.id}`,
    request: config.assign?.[marker.id],
    defaults: config.defaults,
    strict: false,
    verify: true,
    harnesses,
  });
}

/**
 * The pool's config loader, the single parser of console.json. The server
 * consumes the same parsed config it hands the engine, so the file is read
 * and validated exactly once.
 */
export function readConfig(poolDir: string): PoolConfig {
  return parseConfig(readOptional(join(poolDir, "console.json")), poolDir);
}

/**
 * The same parse, over text the caller already has. The Console reads the
 * file itself to key a cache on its exact bytes (issue #126), and parsing
 * that same text here is what keeps the cache key and the parsed config from
 * ever describing two different reads of the file.
 */
export function parseConfig(raw: string | null, poolDir: string): PoolConfig {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pool config: ${join(poolDir, "console.json")} must be a JSON object`);
  }
  if (
    parsed.selection !== undefined &&
    parsed.selection !== "auto" &&
    parsed.selection !== "human"
  ) {
    throw new Error(`pool config: selection must be "auto" or "human"`);
  }
  if (parsed.terminal !== undefined && parsed.terminal !== "herdr") {
    throw new Error(`pool config: terminal must be "herdr"`);
  }
  return parsed as PoolConfig;
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * A directory in its canonical spelling, symlinks resolved. The pool
 * directory reaches the engine however the caller spelled it, while
 * `git rev-parse --show-toplevel` always answers with the physical path, so
 * on any pool behind a symlink (a symlinked repos dir, /tmp on macOS, a
 * network mount alias) the two disagree and every path derived by relating
 * one to the other — the seed copy `planTicket` writes into an attempt
 * worktree above all — lands outside the tree it was meant for. Resolved
 * once where the pool dir enters, so the derivation sites downstream all
 * share a single spelling rather than each defending itself.
 */
export function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    // Nothing on disk to resolve yet: hand back what we were given and let
    // the caller's own read fail with its own message.
    return dir;
  }
}

export function repoRootOf(poolDir: string): string {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", poolDir, "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode === 0) {
    const root = probe.stdout.toString().trim();
    if (root) return canonicalDir(root);
  }
  return canonicalDir(poolDir);
}
