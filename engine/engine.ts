import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  appendEvent,
  attemptLogName,
  attemptStreamName,
  lastAttempt,
  lastAttemptOfKind,
  nextAttempt,
  type TicketEventKind,
} from "./events.ts";
import {
  type CheckpointStore,
  SqliteCheckpointStore,
} from "./checkpoints.ts";
import { QueuedAnswerStore, type QueuedAnswer } from "./queued-answers.ts";
import {
  loadPoolMarkers,
  parseSpawnId,
  readMarker,
  writeMarkerStatus,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { buildGraderPrompt, buildHeadToHeadPrompt, buildPrompt, buildResolverPrompt } from "./prompt.ts";
import {
  defaultHarnesses,
  elidePromptArgv,
  engineEnvSet,
  harnessStreamMode,
  spawnEnv,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";
import {
  HERDR_SOCKET_DEFAULT,
  attemptTabLabel,
  openAttemptTab,
} from "./herdr.ts";
import { StreamLineBuffer, deriveStreamLine } from "./streamlog.ts";
import {
  branchExists,
  branchFor,
  commitMerge,
  attemptBranches,
  currentBranch,
  commitShaAt,
  discardWorktree,
  git,
  gitAvailable,
  mergeBranch,
  prepareWorktree,
  removeWorktree,
  worktreePathFor,
  type MergeResult,
  type WorktreeInfo,
} from "./worktrees.ts";

export type { HarnessCommand } from "./spawn.ts";

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
// selection's winner) and the boundary that adopts them.
interface PendingSpawn {
  parentId: string;
  proposals: SpawnProposal[];
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

// One attempt's outcome file name. The solo path keeps the well-known name;
// a verify fan-out writes per attempt, so N parallel outcomes never collide
// and each grader can bind to one attempt's file (ticket 03).
function outcomeFileName(ticketId: string, attempt: number | null): string {
  return attempt === null
    ? `${ticketId}.outcome.json`
    : `${ticketId}.attempt-${attempt}.outcome.json`;
}

// One attempt's Stream file path (ADR-0012), or null for a raw harness:
// stream mode is keyed by harness name, not by spawn site, so opencode and
// any custom harness keep the raw-passthrough log and write no Stream file.
// Verify attempts write attempt-numbered Stream files directly, exactly as
// their logs do, so N parallel attempts never share a path.
function attemptStreamPath(
  runsDir: string,
  ticketId: string,
  harness: string,
  attempt: number | null,
  resolver: boolean,
): string | null {
  return harnessStreamMode(harness) === "stream"
    ? join(runsDir, attemptStreamName(ticketId, attempt, resolver))
    : null;
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
}

export type InterruptKind =
  | "checkpoint"
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

interface Interrupt {
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
}

// The phases a run reports. `dead` is terminal and distinct from the closing
// gate's done/quiescent/stalled: it is emitted only by reportDriveDeath, when
// an error the drive truly cannot continue from has killed the loop. If the
// phase was emitted the drive reported its own death; if it wasn't, the drive
// is lying.
export type RunPhase = "running" | "done" | "quiescent" | "stalled" | "dead";

/**
 * One ticket's resolved Assignment on the wire (ADR-0013): the engine's
 * resolved record with no verify (Verify keeps its own surfaces) and the
 * engine's empty string rendered as null for an unassigned field. The UI
 * renders this record verbatim; nothing re-derives it.
 */
export interface AssignmentView {
  harness: string | null;
  model: string | null;
  drivers: string;
}

// The record an unassigned ticket resolves to (ADR-0013): what
// assignmentViewOf returns for a ticket with no assign entry and no pool
// defaults. Exported so the server's mid-flight fallback for a meta id the
// engine has not resolved yet quotes this record instead of restating it.
export const UNASSIGNED_ASSIGNMENT_VIEW: AssignmentView = {
  harness: null,
  model: null,
  drivers: "implement",
};

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
}

interface RunOptions {
  poolDir: string;
  harnesses?: Record<string, HarnessCommand>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
  issueRunnerPath?: string;
  // The checkpoint store seam: tests substitute a store whose write throws
  // on demand to prove a persist failure retries, then interrupts, and never
  // closes the store. Defaults to the real sqlite store.
  store?: CheckpointStore;
  // The herdr daemon socket for terminal-backed attempts. Tests point this
  // at a fake socket; the default is the daemon's path on this machine.
  herdrSocket?: string;
}

// The live run handle. `startPool` returns it from the very first super-step,
// with the drive proceeding in the background, so an answer is accepted at any
// moment (ADR-0004). `resume`/`approve`/`reject` accept the answer
// synchronously and resolve at the settle after it is processed; `accept` is
// the same acceptance without the wait, for callers (the server) that
// acknowledge and move on. The field getters read the session live, so they
// are only meaningful once `settled` has resolved.
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
    config: state.config,
    reviewApproved: update.reviewApproved ?? state.reviewApproved,
  };
}

function readyTickets(
  markers: TicketMarker[],
  tickets: PoolState["tickets"],
): TicketMarker[] {
  return markers.filter(
    (marker) =>
      // Grader tickets and the head-to-head ticket are engine-run (they are
      // spawned at the grading or selection point of their build ticket's
      // fan-out, which the ready set can never express, since the build
      // ticket stays in-progress until selection). Excluding them here keeps
      // a stray ready engine card from ever being scheduled as an ordinary
      // implement ticket.
      !engineTicketBuildId(marker.id) &&
      tickets[marker.id] === "ready" &&
      marker.blockedBy.every((id) => tickets[id] === "done"),
  );
}

interface Assignment {
  harness: string;
  model: string;
  drivers: string;
  verify?: number;
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
  issueRunnerPath: string;
  // Where terminal-backed attempts reach the herdr daemon (ADR-0014).
  herdrSocket: string;
  resolverAttempts: Map<string, { files: string[]; note: string }>;
  // Spawn proposals awaiting the boundary (ADR-0010), pushed where an outcome
  // becomes the ticket's and drained by adoptSpawnProposals.
  pendingSpawns: PendingSpawn[];
  // Spawn tickets adopted so far this run, bounding the per-run cap. Seeded
  // from the markers at start, so a resumed run continues the same count.
  spawnedThisRun: number;
}

export function startPool(options: RunOptions): PoolRun {
  const poolDir = options.poolDir;
  const issuesDir = join(poolDir, "issues");
  const runsDir = join(poolDir, "runs");
  const markers = loadPoolMarkers(issuesDir);
  mkdirSync(runsDir, { recursive: true });

  const config = readConfig(poolDir);
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const cwd = repoRootOf(poolDir);

  // Assignment resolution for every marker on disk: ordinary tickets resolve
  // from the config, engine-written ones (grader, head-to-head, spawned)
  // inherit from the ticket they belong to, and spawn chains resolve however
  // deep they nest.
  const assignments = new Map<string, Assignment>();
  resolveUnseenAssignments(markers, assignments, config, harnesses);

  const session: Session = {
    poolDir,
    issuesDir,
    runsDir,
    cwd,
    git: gitAvailable(cwd),
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
    issueRunnerPath: options.issueRunnerPath ?? join(homedir(), ".issue-runner"),
    herdrSocket: options.herdrSocket ?? HERDR_SOCKET_DEFAULT,
    resolverAttempts: new Map(),
    pendingSpawns: [],
    spawnedThisRun: markers.filter((m) => m.spawnedBy !== undefined).length,
  };

  rehydrate(session);
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
  };
  return handle;
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

// The wire view of a resolved Assignment (ADR-0013): the empty string the
// engine uses for an unassigned field reads as null, and verify stays off
// the wire.
function assignmentViewOf(assignment: Assignment): AssignmentView {
  return {
    harness: assignment.harness || null,
    model: assignment.model || null,
    drivers: assignment.drivers,
  };
}

// One emit point for every snapshot the run produces: the drive loop's
// lifecycle emits, the acceptance emit (a new queued answer while a
// super-step is in flight), and the terminal dead emit from
// reportDriveDeath. Each carries the store's pending answers at emit
// time, and every markProcessed is followed by an emit, so the merged queue
// in the snapshot stream never goes stale.
function emitSnapshot(session: Session, phase: RunPhase): void {
  const snapshot: PoolSnapshot = {
    seq: session.snapshots.length,
    phase,
    state: session.state,
    queuedAnswers: session.answers.pending(),
    assignments: Object.fromEntries(
      [...session.assignments].map(([id, a]) => [id, assignmentViewOf(a)]),
    ),
  };
  session.snapshots.push(snapshot);
  session.onSnapshot?.(snapshot);
}

async function driveLoop(session: Session): Promise<void> {
  const emit = (phase: RunPhase) => emitSnapshot(session, phase);

  emit("running");
  for (;;) {
    reconcileDeadlocks(session);
    // The super-step boundary: answers accepted while the previous
    // super-step was in flight are applied now, in submission order, after
    // that super-step's join and persistence and before this one's
    // scheduling. Processing never spawns; the scheduling below does. The
    // drain persists the answered state itself, so a resume is on disk
    // before this super-step schedules, not only at its closing persist.
    drainAnswers(session);
    // Spawn adoption (ADR-0010) rides the same boundary: proposals
    // established by the previous super-step's outcomes, or by the answer
    // drain just now, are written into the pool here, before the ready
    // check below, so adopted tickets schedule like any other and a pool
    // whose last outcome spawns never reports itself done early.
    adoptSpawnProposals(session);
    const ready = readyTickets(session.markers, session.state.tickets);
    if (ready.length === 0) break;
    session.superStep += 1;
    // Every attempt this super-step spawns is numbered before any spawn,
    // so a verify fan-out cannot race the events counter: attempts run
    // base..base+N-1 off one nextAttempt read per ticket.
    const planned = ready.flatMap((marker) => {
      const verify = session.assignments.get(marker.id)!.verify;
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

    // Merges land in completion order: each ticket's merge chains onto a
    // serialized queue the moment the ticket finishes, while its siblings
    // are still running.
    const merges: {
      marker: TicketMarker;
      result: MergeResult;
      attempt: number;
    }[] = [];
    let mergeQueue: Promise<void> = Promise.resolve();
    const results = await Promise.all(
      planned.map(({ marker, plan }) =>
        runTicket(
          marker,
          snapshot,
          session.assignments.get(marker.id)!,
          {
            poolDir: session.poolDir,
            runsDir: session.runsDir,
            issuesDir: session.issuesDir,
            harnesses: session.harnesses,
            herdrSocket: session.herdrSocket,
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
            mergeQueue = mergeQueue.then(() => {
              merges.push({
                marker,
                result: mergeTicket(session, marker, result.plan.worktree!),
                attempt: result.plan.attempt,
              });
            });
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
        appendEvent(session.runsDir, merge.marker.id, {
          at: new Date().toISOString(),
          attempt: merge.attempt,
          kind: "merged",
          payload: {},
        });
        session.state = applyUpdate(session.state, {
          log: [
            `ticket ${merge.marker.id}: merged ${branchFor(merge.marker.id)} ` +
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
          body: crashInterruptBody(result),
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
    // blocker, but they are never scheduled by the ready set: the build
    // ticket stays in-progress until selection has chosen a winner, so
    // the engine runs the graders itself here, the way it runs the merge
    // resolver, and writes their statuses itself.
    for (const marker of ready) {
      const assignment = session.assignments.get(marker.id)!;
      if (assignment.verify == null) continue;
      const attempts = results
        .filter((r) => r.marker.id === marker.id)
        .map((r) => r.plan.attempt)
        .sort((a, b) => a - b);
      const grades = await runGraders(session, marker, attempts, emit);
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
    // store still open: the closing gate below settles quiescent and the
    // run waits for a human instead of dying (issue #26).
    if (!(await persistWithRetry(session))) break;
    emit("running");
  }

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
  "crashed, or the machine restarted), so the work is part done at best " +
  "and the agent left no brief. The ticket is back to ready; read the " +
  "working tree before it runs again.\n";

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
      writeMarkerStatus(marker.file, "ready");
      appendFileSync(marker.file, ENGINE_RESET_NOTE);
      marker.status = "ready";
      log.push(
        `ticket ${marker.id}: marker was in-progress with no live agent; ` +
          "back to ready",
      );
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
    const read = readOutcomeResult(
      join(session.runsDir, outcomeFileName(marker.id, null)),
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

function closeStore(session: Session): void {
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
    // persist failure; the retry policy lives at the persist seam.
    persist(session);
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
  session.markers = loadPoolMarkers(session.issuesDir);
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

// The dual-write and the agent's own edits to the canonical Issue file leave
// it dirty on the working branch and git refuses a merge that would touch a
// dirty file, so the Issue steps aside for the merge and comes straight
// back: its content is the file of record and never travels through the
// ticket's branch.
function mergeWithIssueAside(
  session: Session,
  marker: TicketMarker,
  branch: string,
): MergeResult {
  const aside = `${marker.file}.pool-aside`;
  renameSync(marker.file, aside);
  const result = mergeBranch(session.cwd, branch);
  renameSync(aside, marker.file);
  return result;
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
  const branch = branchFor(marker.id);
  const worktree: WorktreeInfo = {
    path: worktreePathFor(session.cwd, marker.id),
    branch,
  };
  const result = mergeWithIssueAside(session, marker, branch);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  if (!result.ok) {
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "merge-conflict",
      payload: { files: result.conflicted },
    });
    session.state = applyUpdate(session.state, {
      interrupts: [
        ...session.state.interrupts.filter((i) => i !== interrupt),
        mergeConflictInterrupt(session, marker, result),
      ],
      log: [`merge re-attempt for ${marker.id} still conflicts`],
    });
    return;
  }
  removeWorktree(session.cwd, worktree);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, marker.id),
    kind: "merged",
    payload: {},
  });
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
// console.json's resolver= key, falling back to the ~/.issue-runner default,
// with the model resolved the same way. An explicit "none" (or empty) resolver
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
    const runner = readIssueRunner(session.issueRunnerPath);
    if (!harness) harness = runner?.harness;
    if (!model) model = runner?.model;
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

function readIssueRunner(
  path: string,
): { harness?: string; model?: string } | null {
  if (!existsSync(path)) return null;
  const fields = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return { harness: fields.get("harness"), model: fields.get("model") };
}

function readResolverResult(
  path: string,
): { resolved: boolean; note?: string } | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.resolved !== "boolean") return null;
    return {
      resolved: parsed.resolved,
      note: typeof parsed.note === "string" ? parsed.note : undefined,
    };
  } catch {
    return null;
  }
}

// A conflict hands the conflicted state to the resolver agent: the resolver
// reproduces the conflict in the parked worktree, stages a resolution without
// committing, and the engine routes the result. A resolved attempt becomes an
// approval interrupt (authority stays with the human); a failed or absent one
// takes the manual path with the failure noted.
async function handleMergeConflict(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attempt: number,
): Promise<void> {
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "merge-conflict",
    payload: { files: result.conflicted },
  });
  const worktree: WorktreeInfo = {
    path: worktreePathFor(session.cwd, marker.id),
    branch: branchFor(marker.id),
  };
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
  const resolverAttempt = await runResolver(
    session,
    marker,
    worktree,
    resolver,
    result,
  );
  session.resolverAttempts.set(marker.id, {
    files: result.conflicted,
    note: resolverAttempt.note,
  });
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
  const outcomePath = join(session.runsDir, `${marker.id}.resolver.json`);
  // As in runTicket: the resolver starts with no outcome, so a stale file
  // from a previous resolver run can never pass for this run's result.
  rmSync(outcomePath, { force: true });
  const logPath = join(session.runsDir, attemptLogName(marker.id, null, true));
  rotateAttemptLog(session.runsDir, marker.id, logPath, "resolver");
  const streamPath = attemptStreamPath(
    session.runsDir,
    marker.id,
    resolver.harness,
    null,
    true,
  );
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: nextAttempt(session.runsDir, marker.id),
    kind: "resolver",
    payload: { files: result.conflicted, cwd: worktree.path, branch: worktree.branch },
  });
  const prompt = buildResolverPrompt({
    id: marker.id,
    worktree: worktree.path,
    branch: worktree.branch,
    workingBranch: currentBranch(session.cwd),
    files: result.conflicted,
    outcomePath,
  });
  const ctx: SpawnContext = {
    id: marker.id,
    issuePath: marker.file,
    body: prompt,
    driver: RESOLVER_DRIVER,
    harness: resolver.harness,
    model: resolver.model,
    agents: session.state.config.agents,
    logPath,
    streamPath,
    outcomePath,
    cwd: worktree.path,
  };
  const argv = session.harnesses[resolver.harness](ctx);
  // The resolver's spawn carries the same facts as every other spawn site
  // (ADR-0012); the resolver event above stays the run's own record.
  // Terminal-backed pools open the resolver its own named tab too: every
  // spawn site shares one code path (ADR-0014).
  const terminal =
    session.state.config.terminal === "herdr"
      ? await openAttemptTerminal(
          session.herdrSocket,
          marker.id,
          marker.title,
          ctx.cwd,
        )
      : undefined;
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, marker.id),
    kind: "spawned",
    payload: spawnedPayload(argv, ctx, worktree.branch, terminal),
  });
  const exitCode = await spawnToLog(argv, ctx);
  const outcome = readResolverResult(outcomePath);
  if (exitCode === 0 && outcome?.resolved) {
    return { resolved: true, note: outcome.note || "(resolver gave no note)" };
  }
  const reason =
    exitCode !== 0
      ? `resolver exited ${exitCode}`
      : outcome
        ? outcome.note || "resolver reported no resolution"
        : "resolver produced no resolution";
  return { resolved: false, note: reason };
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
      `the resolution is staged on branch ${branchFor(marker.id)}; approve to ` +
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
  const worktree: WorktreeInfo = {
    path: worktreePathFor(session.cwd, marker.id),
    branch: branchFor(marker.id),
  };
  commitMerge(worktree);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  const result = mergeWithIssueAside(session, marker, worktree.branch);
  if (!result.ok) {
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: lastAttempt(session.runsDir, marker.id),
      kind: "merge-conflict",
      payload: { files: result.conflicted },
    });
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
      log: [`merge after resolver approval for ${marker.id} still conflicts`],
    });
    return;
  }
  removeWorktree(session.cwd, worktree);
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, marker.id),
    kind: "merged",
    payload: {},
  });
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `interrupt answered for ${marker.id} (merge-approval): resolver ` +
        "resolution committed",
    ],
  });
}

// Rejecting discards the resolver's staged resolution (the parked branch is
// restored) and converts the approval into a manual-resolution interrupt
// carrying the conflicted state plus the agent's attempt, for Billy to resolve.
function rejectMerge(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note?: string,
): void {
  const worktree: WorktreeInfo = {
    path: worktreePathFor(session.cwd, marker.id),
    branch: branchFor(marker.id),
  };
  const attempt = session.resolverAttempts.get(marker.id);
  git(worktree.path, ["merge", "--abort"]);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  const result: MergeResult = {
    ok: false,
    conflicted: attempt?.files ?? [],
    detail: "",
  };
  const base = mergeConflictInterrupt(session, marker, result);
  // In the normal flow the in-memory attempt record carries the note; after a
  // restart the recorded approval interrupt (which holds the same note) stands
  // in, so the agent's attempt is not lost.
  const body = attempt
    ? manualMergeInterrupt(
        session,
        marker,
        result,
        `${attempt.note} (resolution rejected by the human)`,
      ).body
    : `${base.body}\nThe resolver's rejected resolution said: ${interrupt.body}`;
  session.state = applyUpdate(session.state, {
    interrupts: [
      ...session.state.interrupts.filter((i) => i !== interrupt),
      { ...base, body },
    ],
    log: [
      `merge-approval rejected for ${marker.id}: converted to manual resolution`,
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

// One grader's assessment of one attempt (the Grade in CONTEXT.md): the
// score, the verdict, and short reasons, carried in the grader's Outcome
// JSON under a `grade` key and copied by the engine into the graded
// attempt's record.
interface Grade {
  score: number;
  verdict: "pass" | "flag";
  reasons: string;
}

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
// null for an ordinary ticket the pool's own directory defines.
function engineTicketBuildId(id: string): string | null {
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
  const assign = config.assign?.[ticketMarker.id] ?? {};
  const harness = assign.harness ?? build.harness;
  if (harness && !harnesses[harness]) {
    throw new Error(
      `pool config: ticket ${ticketMarker.id} names unknown harness ` +
        `'${harness}'. Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  return {
    harness,
    model: assign.model ?? build.model,
    drivers: build.drivers,
  };
}

// A spawned ticket's assignment (ADR-0010): the ordinary assign machinery
// with the proposing ticket standing in for the pool defaults. An assign
// entry for the spawned id overrides field-wise, everything else inherits
// the parent, so a discovery chain runs on its parent's harness with zero
// new config. verify is honored like any ordinary ticket's (a spawned
// ticket is ordinary in every way): an operator may set verify on a spawned
// id before it schedules.
function resolveSpawnedTicketAssignment(
  config: PoolConfig,
  marker: TicketMarker,
  parent: Assignment,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  const assign = config.assign?.[marker.id] ?? {};
  const harness = assign.harness ?? parent.harness;
  if (harness && !harnesses[harness]) {
    throw new Error(
      `pool config: ticket ${marker.id} names unknown harness ` +
        `'${harness}'. Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  let verify: number | undefined;
  if (assign.verify != null) {
    if (!Number.isInteger(assign.verify) || assign.verify < 1) {
      throw new Error(
        `pool config: ticket ${marker.id} has invalid verify ` +
          `${JSON.stringify(assign.verify)} (must be an integer >= 1)`,
      );
    }
    verify = assign.verify;
  }
  return {
    harness,
    model: assign.model ?? parent.model,
    drivers: assign.drivers ?? parent.drivers,
    verify,
  };
}

// Resolution for marker ids the assignment map does not know yet: ordinary
// tickets resolve from the config; grader and head-to-head ids resolve from
// their build ticket's assignment (a stale engine card on disk never fails
// pool start, and an engine-run judge inherits its builder with zero new
// config); spawned ids resolve from their spawned-by parent, iterating until
// the map stops growing so a spawn chain (01-spawn-1-spawn-1) resolves
// however deep it nests. loadPoolMarkers guarantees a spawned id's parent
// exists, so only a forged spawned-by cycle can leave an id unresolved, and
// that fails here with a clear error instead of an undefined crash later.
function resolveUnseenAssignments(
  markers: TicketMarker[],
  assignments: Map<string, Assignment>,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
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
            : resolveAssignment(marker, config, harnesses),
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
        progressed = true;
        continue;
      }
      assignments.set(marker.id, resolveAssignment(marker, config, harnesses));
      progressed = true;
    }
  }
  const unresolved = markers.filter((m) => !assignments.has(m.id));
  if (unresolved.length > 0) {
    throw new Error(
      `pool load: cannot resolve assignments for ` +
        `${unresolved.map((m) => m.id).join(", ")} (a spawned-by cycle?)`,
    );
  }
}

// The harness command for an assignment at its point of use: a spawn site.
// Resolution is total (an unassigned ticket resolves to empty harness and
// model and renders nulls on the wire), so the pool config error for it
// fires here, at the spawn that cannot run, instead of at pool load: the
// misconfiguration renders on the canvas first, and the run dies naming the
// ticket and the fix.
function harnessCommandFor(
  harnesses: Record<string, HarnessCommand>,
  assignment: Assignment,
  ticketId: string,
): HarnessCommand {
  if (!assignment.harness || !assignment.model) {
    throw new Error(
      `pool config: ticket ${ticketId} has no ` +
        `${assignment.harness ? "model" : "harness"} ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  const command = harnesses[assignment.harness];
  if (!command) {
    throw new Error(
      `pool config: ticket ${ticketId} names unknown harness '${assignment.harness}'. ` +
        `Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  return command;
}

// The grader's outcome: the standard contract plus a validated grade.
// Anything that is not a valid grade is unusable rather than a low score or
// a silent pass, so a broken grader can never decide the build ticket's
// fate (the re-spawn that follows is ticket 07's machinery). A checkpoint
// outcome is unusable too: the grader's contract is one done outcome
// carrying its grade, and the engine never honors a grader's pause.
function readGraderResult(
  path: string,
): { ok: true; outcome: Outcome; grade: Grade } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: "no outcome written" };
  let parsed: {
    grade?: { score?: unknown; verdict?: unknown; reasons?: unknown };
  };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "outcome is not parseable JSON" };
  }
  // The standard outcome validation, run against the one parse this reader
  // already holds.
  const base = validateOutcome(parsed);
  if (!base.ok) return base;
  if (base.outcome.status !== "done") {
    return { ok: false, reason: "grader outcome is a checkpoint, not a grade" };
  }
  const grade = parsed?.grade;
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
  return {
    ok: true,
    outcome: base.outcome,
    grade: { score: grade.score, verdict: grade.verdict, reasons: grade.reasons },
  };
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
  const branch = branchFor(buildId, attempt);
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
  const outcomePath = join(session.runsDir, outcomeFileName(build.id, attempt));
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
  session.markers = loadPoolMarkers(session.issuesDir);
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
    pending = pending.map(({ marker, attempt, lastReason }) => {
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
  // As in runTicket: the grader starts with no outcome, so a stale file
  // from a previous grading round can never pass for this round's result.
  const graderOutcomePath = join(runsDir, outcomeFileName(gid, null));
  rmSync(graderOutcomePath, { force: true });
  const logPath = join(runsDir, attemptLogName(gid, null, false));
  rotateAttemptLog(runsDir, gid, logPath, "exited");
  const streamPath = attemptStreamPath(
    runsDir,
    gid,
    assignment.harness,
    null,
    false,
  );
  const attemptOutcomePath = join(runsDir, outcomeFileName(build.id, attempt));
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
  const ctx: SpawnContext = {
    id: gid,
    issuePath: grader.file,
    body: prompt,
    driver: GRADER_DRIVER,
    harness: assignment.harness,
    model: assignment.model,
    agents: session.state.config.agents,
    logPath,
    streamPath,
    outcomePath: graderOutcomePath,
    cwd: session.cwd,
  };
  const argv = harnessCommandFor(session.harnesses, assignment, gid)(ctx);
  const terminal =
    session.state.config.terminal === "herdr"
      ? await openAttemptTerminal(
          session.herdrSocket,
          grader.id,
          grader.title,
          ctx.cwd,
        )
      : undefined;
  appendEvent(runsDir, gid, {
    at: new Date().toISOString(),
    attempt: lastAttempt(runsDir, gid),
    kind: "spawned",
    payload: spawnedPayload(argv, ctx, null, terminal),
  });
  const exitCode = await spawnToLog(argv, ctx);
  // The grader's exit facts (ADR-0012), on the grade path and the crash
  // path alike: the log tail and whether the grader wrote an outcome at all.
  const logTail = readLogTail(logPath);
  const outcomeExists = existsSync(graderOutcomePath);
  const result = readGraderResult(graderOutcomePath);
  if (exitCode !== 0) {
    const reason = `harness exited ${exitCode}`;
    recordGraderFailure(
      session,
      build,
      grader,
      attempt,
      exitCode,
      reason,
      logTail,
      outcomeExists,
      emit,
    );
    return { ok: false, reason };
  }
  if (!result.ok) {
    recordGraderFailure(
      session,
      build,
      grader,
      attempt,
      exitCode,
      result.reason,
      logTail,
      outcomeExists,
      emit,
    );
    return { ok: false, reason: result.reason };
  }
  // A usable grade: the engine writes the grader's done status (ADR-0005:
  // the engine owns every status write) and copies the grade into the
  // graded attempt's record, a graded event on the build ticket's file.
  writeMarkerStatus(grader.file, "done");
  grader.status = "done";
  appendEvent(runsDir, gid, {
    at: new Date().toISOString(),
    attempt: lastAttempt(runsDir, gid),
    kind: "exited",
    payload: { code: exitCode, status: "done", logTail, outcomeExists },
  });
  appendEvent(runsDir, build.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "graded",
    payload: {
      score: result.grade.score,
      verdict: result.grade.verdict,
      reasons: result.grade.reasons,
    },
  });
  session.state = applyUpdate(session.state, {
    tickets: { [gid]: "done" },
    outcomes: { [gid]: result.outcome },
    log: [
      `ticket ${build.id}: attempt ${attempt} graded: score ` +
        `${result.grade.score}, verdict ${result.grade.verdict} ` +
        `(grader ${gid})`,
    ],
  });
  emit("running");
  return { ok: true, grade: result.grade };
}

// A grader that exited non-zero or wrote no parseable grade decides nothing:
// the crash lands on the grader ticket, its marker stays in-progress, and
// the build ticket is untouched. The re-spawn rounds that follow, and the
// bound that stops them, are runGraders' (ticket 07).
function recordGraderFailure(
  session: Session,
  build: TicketMarker,
  grader: TicketMarker,
  attempt: number,
  exitCode: number,
  reason: string,
  logTail: string[],
  outcomeExists: boolean,
  emit: (phase: RunPhase) => void,
): void {
  appendEvent(session.runsDir, grader.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, grader.id),
    kind: "exited",
    payload: { code: exitCode, status: "in-progress", logTail, outcomeExists },
  });
  appendEvent(session.runsDir, grader.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, grader.id),
    kind: "crash",
    payload: { code: exitCode, reason, logTail, outcomeExists },
  });
  // Whatever marker status the grader agent wrote for itself, the engine
  // owns the write: a grader without a usable grade is never done.
  if (readMarker(grader.file).status !== "in-progress") {
    writeMarkerStatus(grader.file, "in-progress");
  }
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
  const outcome = readOutcomeResult(
    join(session.runsDir, outcomeFileName(marker.id, attempt)),
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
  if (session.git) {
    const worktree = result.plan.worktree ?? {
      path: worktreePathFor(session.cwd, marker.id, attempt),
      branch: branchFor(marker.id, attempt),
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
        mergeConflictComplaint(marker.id, attempt, merge),
        `ticket ${marker.id}: attempt ${attempt} passed grading but its ` +
          "merge conflicted; checkpoint raised for the human",
        emit,
      );
      return;
    }
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt,
      kind: "merged",
      payload: {},
    });
    update.log = [
      `ticket ${marker.id}: attempt ${attempt} passed grading; merged ` +
        `${branchFor(marker.id, attempt)} onto the working branch`,
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
  buildId: string,
  attempt: number,
  result: MergeResult,
): string {
  const branch = branchFor(buildId, attempt);
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
    ranked.length > 1 ? winner.grade.score - ranked[1].grade.score : null;
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
        margin: Math.abs(ranked[0].grade.score - ranked[1].grade.score),
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
      branch: branchFor(marker.id, attempt),
    };
    const merge = mergeTicket(session, marker, worktree);
    if (!merge.ok) {
      discardLosers(session, marker.id, attempt);
      checkpointLoneAttempt(
        session,
        marker,
        attempt,
        mergeConflictComplaint(marker.id, attempt, merge),
        `ticket ${marker.id}: attempt ${attempt} selected but its merge ` +
          "conflicted; checkpoint raised for the human",
        emit,
      );
      return;
    }
    appendEvent(session.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt,
      kind: "merged",
      payload: {},
    });
    mergedNote = ` merged ${branchFor(marker.id, attempt)} onto the working branch`;
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
  const outcome = readOutcomeResult(
    join(session.runsDir, outcomeFileName(marker.id, attempt)),
  );
  if (outcome.ok) {
    update.outcomes = { [marker.id]: outcome.outcome };
    if (outcome.outcome.spawn?.length) {
      session.pendingSpawns.push({
        parentId: marker.id,
        proposals: outcome.outcome.spawn,
      });
    }
  }
  session.state = applyUpdate(session.state, update);
  emit("running");
}

// Every attempt branch of the build ticket except the winner's goes: this
// round's losers and any superseded round's alike. Returns the attempt
// numbers discarded, so the pool log can name them.
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
      branch: branchFor(buildId, attempt),
    });
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
// than a guess: the deterministic fallback owns the decision then.
function readHeadToHeadVerdict(
  path: string,
  candidates: [number, number],
): HeadToHeadVerdict {
  if (!existsSync(path)) return { kind: "unusable", reason: "no outcome written" };
  let parsed: { winner?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { kind: "unusable", reason: "outcome is not parseable JSON" };
  }
  const base = validateOutcome(parsed);
  if (!base.ok) return { kind: "unusable", reason: base.reason };
  if (base.outcome.status !== "done") {
    return {
      kind: "unusable",
      reason: "head-to-head outcome is a checkpoint, not a pick",
    };
  }
  if (parsed?.winner === "tie") return { kind: "tie", outcome: base.outcome };
  const winner = parsed?.winner;
  const pick =
    typeof winner === "number" && Number.isInteger(winner)
      ? winner
      : typeof winner === "string" && /^\d+$/.test(winner)
        ? Number(winner)
        : null;
  if (pick === null || !candidates.includes(pick)) {
    return {
      kind: "unusable",
      reason: "outcome names no winner among the two attempts",
    };
  }
  return { kind: "pick", attempt: pick, outcome: base.outcome };
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
      outcomePath: join(runsDir, outcomeFileName(build.id, attempt)),
      diffPath: join(runsDir, `${h2hId}.attempt-${attempt}.diff.patch`),
      logPath: join(runsDir, `${h2hId}.attempt-${attempt}.trim.log`),
    };
  });
  writeHeadToHeadTicket(session, build, [sides[0], sides[1]]);
  session.markers = loadPoolMarkers(session.issuesDir);
  const h2h = session.markers.find((m) => m.id === h2hId)!;
  const assignment = resolveEngineTicketAssignment(
    session.state.config,
    h2h,
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
        `${top.grade.score - runnerUp.grade.score} is below the outright ` +
        `band; spawning head-to-head ${h2hId} between attempts ` +
        `${top.attempt} and ${runnerUp.attempt}`,
    ],
  });
  writeMarkerStatus(h2h.file, "in-progress");
  h2h.status = "in-progress";
  emit("running");
  // As in runGrader: the judge starts with no outcome, so a stale file from
  // a previous round can never pass for this round's pick.
  const h2hOutcomePath = join(runsDir, outcomeFileName(h2hId, null));
  rmSync(h2hOutcomePath, { force: true });
  const logPath = join(runsDir, attemptLogName(h2hId, null, false));
  rotateAttemptLog(runsDir, h2hId, logPath, "exited");
  const streamPath = attemptStreamPath(
    runsDir,
    h2hId,
    assignment.harness,
    null,
    false,
  );
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
  const ctx: SpawnContext = {
    id: h2hId,
    issuePath: h2h.file,
    body: prompt,
    driver: HEAD_TO_HEAD_DRIVER,
    harness: assignment.harness,
    model: assignment.model,
    agents: session.state.config.agents,
    logPath,
    streamPath,
    outcomePath: h2hOutcomePath,
    cwd: session.cwd,
  };
  const argv = harnessCommandFor(session.harnesses, assignment, h2hId)(ctx);
  const terminal =
    session.state.config.terminal === "herdr"
      ? await openAttemptTerminal(
          session.herdrSocket,
          h2h.id,
          h2h.title,
          ctx.cwd,
        )
      : undefined;
  appendEvent(runsDir, h2hId, {
    at: new Date().toISOString(),
    attempt: lastAttempt(runsDir, h2hId),
    kind: "spawned",
    payload: spawnedPayload(argv, ctx, null, terminal),
  });
  const exitCode = await spawnToLog(argv, ctx);
  // The judge's exit facts (ADR-0012): the log tail and whether an outcome
  // file exists, on the pick path and the unusable path alike.
  const logTail = readLogTail(logPath);
  const outcomeExists = existsSync(h2hOutcomePath);
  let verdict = readHeadToHeadVerdict(h2hOutcomePath, [
    top.attempt,
    runnerUp.attempt,
  ]);
  if (exitCode !== 0) {
    verdict = { kind: "unusable", reason: `harness exited ${exitCode}` };
  }
  appendEvent(runsDir, h2hId, {
    at: new Date().toISOString(),
    attempt: lastAttempt(runsDir, h2hId),
    kind: "exited",
    payload: {
      code: exitCode,
      status: verdict.kind === "unusable" ? "in-progress" : "done",
      logTail,
      outcomeExists,
    },
  });
  if (verdict.kind === "unusable") {
    appendEvent(runsDir, h2hId, {
      at: new Date().toISOString(),
      attempt: lastAttempt(runsDir, h2hId),
      kind: "crash",
      payload: {
        code: exitCode,
        reason: verdict.reason,
        logTail,
        outcomeExists,
      },
    });
  }
  writeMarkerStatus(h2h.file, "done");
  h2h.status = "done";
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
    rmSync(join(session.runsDir, outcomeFileName(marker.id, null)), {
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
  raiseInterrupt(session, checkpointInterrupt(marker));
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt,
    kind: "checkpoint",
    payload: {},
  });
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

interface TicketEnv {
  poolDir: string;
  runsDir: string;
  issuesDir: string;
  harnesses: Record<string, HarnessCommand>;
  herdrSocket: string;
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
}

// The exit facts' log tail (ADR-0012): the last ~20 lines of the attempt's
// log, so the events file alone shows how the attempt ended. A missing or
// unreadable log reads as no lines, never as an error: the fact is the
// empty tail.
const LOG_TAIL_LINES = 20;

function readLogTail(logPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  // A trailing newline ends the file, it does not open an empty line.
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-LOG_TAIL_LINES);
}

/**
 * The terminal facts a terminal-backed spawn adds to the `spawned` event's
 * payload (ADR-0014, ADR-0015): the pane id the attempt's named tab was
 * recovered to, and, when the tab could not be opened, the error that
 * stopped it. pane_id is null on that fallback path: the attempt runs
 * headless and the ticket log carries why.
 */
interface AttemptTerminal {
  paneId: string | null;
  error?: string;
}

/**
 * Open the attempt's named herdr tab for a terminal-backed spawn. Never
 * throws: herdr is optional (ADR-0014), so a missing or misbehaving daemon
 * falls the spawn back to headless and the failure lands on the spawned
 * event, where the ticket log shows it.
 */
async function openAttemptTerminal(
  socketPath: string,
  id: string,
  title: string,
  cwd: string,
): Promise<AttemptTerminal> {
  try {
    const tab = await openAttemptTab(
      socketPath,
      attemptTabLabel(id, title),
      cwd,
    );
    return { paneId: tab.paneId };
  } catch (err) {
    return {
      paneId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The `spawned` event's payload (ADR-0012): the facts that would have
 * diagnosed a wrong-commit or wrong-place spawn from one line. The argv
 * carries the prompt body elided; the commit SHA resolves from the spawn cwd
 * at spawn time (null when git is unavailable or the cwd is not a checkout);
 * env is the keys the engine set on the child environment beyond the
 * inherited parent's, with their values. Terminal-backed spawns add pane_id
 * (and terminal_error on the headless fallback), per ADR-0014 and ADR-0015.
 */
function spawnedPayload(
  argv: string[],
  ctx: SpawnContext,
  branch: string | null,
  terminal?: AttemptTerminal,
): Record<string, unknown> {
  return {
    argv: elidePromptArgv(argv, ctx.body),
    cwd: ctx.cwd,
    branch,
    commitSha: commitShaAt(ctx.cwd),
    env: engineEnvSet(spawnEnv(ctx.cwd)),
    ...(terminal
      ? {
          pane_id: terminal.paneId,
          ...(terminal.error !== undefined
            ? { terminal_error: terminal.error }
            : {}),
        }
      : {}),
  };
}

/**
 * The crash interrupt body (ADR-0012): the log path, a blank line, the tail
 * the crash event carries, and the outcome-file line, so the Needs-input
 * surface answers "what happened" without the operator opening files. The
 * body persists with the pool state, so the tail freezes at raise time;
 * accepted and desired.
 */
function crashInterruptBody(result: TicketResult): string {
  const tail = result.logTail.join("\n");
  return (
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
// checkout's Issue file is the single canonical copy: the spawn prompt hands
// the agent its absolute path for reading and notes, and the engine writes
// the final status to it at attempt exit. The worktree gets a seed copy as
// context only; the merge already discards worktree Issue edits.
function planTicket(
  session: Session,
  marker: TicketMarker,
  readyCount: number,
  attempt: number,
  verify: boolean,
): TicketPlan {
  if (!session.git) return { cwd: session.cwd, attempt, verify };
  if (
    !verify &&
    readyCount < 2 &&
    !branchExists(session.cwd, marker.id)
  ) {
    return { cwd: session.cwd, attempt, verify };
  }
  const worktree = prepareWorktree(
    session.cwd,
    marker.id,
    verify ? attempt : undefined,
  );
  const seedCopy = join(worktree.path, relative(session.cwd, marker.file));
  mkdirSync(dirname(seedCopy), { recursive: true });
  copyFileSync(marker.file, seedCopy);
  return { cwd: worktree.path, worktree, attempt, verify };
}

// The engine owns the final status write (ADR-0005): the attempt's outcome
// JSON is the only ending signal, and anything that is not exit code 0 with a
// valid outcome is a crash. The crash reason distinguishes the classes in the
// ticket log: a dead harness, an agent that never wrote its outcome, an
// outcome that does not parse, and an outcome whose status is invalid.
export type OutcomeResult =
  | { ok: true; outcome: Outcome; spawnRejections?: SpawnRejection[] }
  | { ok: false; reason: string };

function readOutcomeResult(path: string): OutcomeResult {
  if (!existsSync(path)) return { ok: false, reason: "no outcome written" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "outcome is not parseable JSON" };
  }
  return validateOutcome(parsed);
}

// A proposal's body must carry enough intent for a fresh agent to work from;
// anything thinner is a note, not a ticket. The prompt teaching names the
// same floor so the two cannot drift apart silently; prompt.test.ts pins the
// match against this exported constant.
export const SPAWN_BODY_MIN_CHARS = 20;

// Per-proposal spawn validation (ADR-0010): the well-formed entries come back
// as proposals, the malformed ones as rejections carrying their index and a
// reason. The outcome itself stays valid either way; the boundary decides
// what gets adopted and what gets logged.
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
    proposals.push({
      title: proposal.title,
      body: proposal.body,
      ...(blockedBy !== undefined ? { blockedBy } : {}),
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

// The boundary's spawn adoption (ADR-0010): every buffered proposal is
// validated against the pool as the boundary found it, the accepted ones are
// written as ordinary ticket files, and the pool's markers and assignments
// reload so the drive loop schedules them like any other ticket. Validation
// is per proposal, never per attempt: a dropped proposal logs its reason on
// the proposing ticket's log (a spawn-rejected event) and the attempt's own
// result stands. The caps bound the blast radius (5 per attempt, 20 per
// run): overflow truncates and logs, never fails. Writing the files is the
// commit point; a crash after them but before the reload leaves the adopted
// tickets in the pool for the next start, ids stable.
function adoptSpawnProposals(session: Session): void {
  if (session.pendingSpawns.length === 0) return;
  const pending = session.pendingSpawns.splice(0);
  // Membership validates against the markers as the boundary found them, so
  // a proposal naming another proposal's future id drops as unknown: the
  // agent never proposes ids and cannot know one.
  const knownIds = new Set(session.markers.map((m) => m.id));
  const counters = spawnCounters(session.markers);
  const log: string[] = [];
  let wrote = false;

  for (const { parentId, proposals } of pending) {
    const accepted: SpawnProposal[] = [];
    for (const proposal of proposals) {
      const unknown = (proposal.blockedBy ?? []).filter(
        (id) => !knownIds.has(id),
      );
      if (unknown.length > 0) {
        const reason =
          `blockedBy names tickets outside the pool: ${unknown.join(", ")}`;
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
    // The per-attempt cap honors the first five survivors; the per-run cap
    // truncates whatever the run has no room left for.
    let truncated = 0;
    let honored = accepted.slice(0, SPAWN_MAX_PER_ATTEMPT);
    truncated += accepted.length - honored.length;
    const room = Math.max(0, SPAWN_MAX_PER_RUN - session.spawnedThisRun);
    if (honored.length > room) {
      truncated += honored.length - room;
      honored = honored.slice(0, room);
    }
    const adopted: string[] = [];
    for (const proposal of honored) {
      const n = (counters.get(parentId) ?? 0) + 1;
      counters.set(parentId, n);
      const id = `${parentId}-spawn-${n}`;
      writeSpawnTicket(session, parentId, id, proposal);
      adopted.push(id);
      session.spawnedThisRun += 1;
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
      wrote = true;
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
  session.markers = loadPoolMarkers(session.issuesDir);
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
  if (result.ok) removeWorktree(session.cwd, worktree);
  return result;
}

function mergeConflictInterrupt(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
): Interrupt {
  const branch = branchFor(marker.id);
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
      `the ticket's work is parked on branch ${branch}, checked out at ` +
      `${worktreePathFor(session.cwd, marker.id)}.\n` +
      (result.detail ? `git said: ${result.detail}\n` : "") +
      "resolve the conflict and resume this ticket; the merge is " +
      "re-attempted on resume.",
  };
}

// The manual-resolution interrupt: the resolver path's merge-conflict, with
// what the resolver tried noted for the human.
function manualMergeInterrupt(
  session: Session,
  marker: TicketMarker,
  result: MergeResult,
  attemptNote: string,
): Interrupt {
  const base = mergeConflictInterrupt(session, marker, result);
  return {
    ...base,
    body: `${base.body}\nThe resolver agent attempted: ${attemptNote}`,
  };
}

// Attempt rotation on re-run (ADR 0002): before a new attempt writes, an
// existing well-known log moves to its attempt-numbered name so a re-run
// never destroys the ticket's history, and its Stream file rotates with it
// (ADR-0012). The number is the attempt the events file recorded for the run
// that wrote the file: the last exited implement (or engine-run) attempt for
// the base log, the last resolver run for the resolver log. Implement logs
// key on "exited" rather than "spawned" because a resolver run now records a
// spawned event of its own (ADR-0012) and never an exited one, so "exited"
// still names exactly the run that wrote the file. A pre-feature log
// (written before events existed) rotates to attempt-0. The names come from
// the events module's naming contract.
function rotateAttemptLog(
  runsDir: string,
  ticketId: string,
  wellKnownPath: string,
  kind: TicketEventKind,
): void {
  const resolver = kind === "resolver";
  const attempt = lastAttemptOfKind(runsDir, ticketId, kind);
  if (existsSync(wellKnownPath)) {
    renameSync(
      wellKnownPath,
      join(runsDir, attemptLogName(ticketId, attempt, resolver)),
    );
  }
  // The Stream file was written by the run that wrote the log, so it
  // rotates under the same attempt number. Rotated independently of the
  // log: a stream-only leftover (a run that died before any log line
  // derived) must still rotate.
  const wellKnownStream = join(
    runsDir,
    attemptStreamName(ticketId, null, resolver),
  );
  if (existsSync(wellKnownStream)) {
    renameSync(
      wellKnownStream,
      join(runsDir, attemptStreamName(ticketId, attempt, resolver)),
    );
  }
}

async function runTicket(
  marker: TicketMarker,
  snapshot: PoolState,
  assignment: Assignment,
  env: TicketEnv,
  plan: TicketPlan,
): Promise<TicketResult> {
  const [driver, ...chain] = assignment.drivers.split(/\s+/).filter(Boolean);
  // A verify attempt writes its attempt-numbered log directly: N parallel
  // attempts cannot share the well-known path, and the number is known at
  // scheduling time. A solo attempt keeps the well-known path plus rotation.
  const logPath = plan.verify
    ? join(env.runsDir, attemptLogName(marker.id, plan.attempt, false))
    : join(env.runsDir, attemptLogName(marker.id, null, false));
  if (!plan.verify) {
    rotateAttemptLog(env.runsDir, marker.id, logPath, "exited");
  }
  const streamPath = attemptStreamPath(
    env.runsDir,
    marker.id,
    assignment.harness,
    plan.verify ? plan.attempt : null,
    false,
  );
  const outcomePath = join(
    env.runsDir,
    outcomeFileName(marker.id, plan.verify ? plan.attempt : null),
  );
  // Every attempt starts with no outcome: a file a previous attempt left
  // behind would be read as this attempt's result, honoring a stale status.
  rmSync(outcomePath, { force: true });

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

  const ctx: SpawnContext = {
    id: marker.id,
    issuePath: marker.file,
    body: prompt,
    driver,
    harness: assignment.harness,
    model: assignment.model,
    agents: snapshot.config.agents,
    logPath,
    streamPath,
    outcomePath,
    cwd: plan.cwd,
  };
  const argv = harnessCommandFor(env.harnesses, assignment, marker.id)(ctx);
  // A terminal-backed attempt opens its own named herdr tab before the
  // spawn is recorded, so the spawned event can carry the recovered pane id
  // (ADR-0014, ADR-0015). Headless spawns record no pane facts at all.
  const terminal =
    snapshot.config.terminal === "herdr"
      ? await openAttemptTerminal(
          env.herdrSocket,
          marker.id,
          marker.title,
          plan.cwd,
        )
      : undefined;
  appendEvent(env.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: plan.attempt,
    kind: "spawned",
    payload: spawnedPayload(argv, ctx, plan.worktree?.branch ?? null, terminal),
  });
  const exitCode = await spawnToLog(argv, ctx);

  // The ending comes from the outcome JSON alone (ADR-0005). On a clean exit
  // with a valid outcome the engine writes the final status to the canonical
  // Issue's marker itself; a marker the agent rewrote is never honored. A
  // verify candidate writes no status anywhere at its exit: the ticket is
  // in-progress until the whole fan-out has exited, and grading decides what
  // happens after (tickets 03 and 04).
  const outcome = readOutcomeResult(outcomePath);
  // Malformed spawn entries were dropped per proposal at validation
  // (ADR-0010); each reason lands on the ticket's log here, at the exit that
  // produced it, for verify candidates and solo attempts alike.
  for (const rejection of outcome.ok ? (outcome.spawnRejections ?? []) : []) {
    appendEvent(env.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: plan.attempt,
      kind: "spawn-rejected",
      payload: {
        reason: rejection.reason,
        ...(rejection.index !== undefined ? { index: rejection.index } : {}),
      },
    });
  }
  let status: TicketStatus = "in-progress";
  let crashReason: string | null = null;
  if (exitCode !== 0) {
    crashReason = `harness exited ${exitCode}`;
  } else if (!outcome.ok) {
    crashReason = outcome.reason;
  } else {
    status = outcome.outcome.status;
    if (!plan.verify) {
      writeMarkerStatus(marker.file, status);
      if (status === "checkpoint") {
        // Before the return: the drive loop raises the checkpoint's interrupt
        // from the Issue's Brief section the moment this attempt exits.
        landCheckpointBrief(marker.file, outcome.outcome.brief);
      }
    }
  }
  if (
    crashReason !== null &&
    !plan.verify &&
    readMarker(marker.file).status !== "in-progress"
  ) {
    writeMarkerStatus(marker.file, "in-progress");
  }
  // The exit facts (ADR-0012), computed the moment the attempt exits: the
  // log is closed by now, so the tail is complete, and the outcome file's
  // existence is the fact that distinguishes "agent never wrote its
  // outcome" from "outcome was invalid".
  const logTail = readLogTail(logPath);
  const outcomeExists = existsSync(outcomePath);
  appendEvent(env.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: plan.attempt,
    kind: "exited",
    payload: { code: exitCode, status, logTail, outcomeExists },
  });
  // A crash is recorded the moment the attempt exits (the marker has already
  // been corrected), not at the end of the super-step, so the ticket log
  // stops masquerading a dead attempt as running work. The payload carries
  // the exit code, the reason, and the same log tail and outcome fact the
  // exited event carries, so the log alone distinguishes a dead harness from
  // an agent that never wrote its outcome from an outcome that was invalid.
  // Per-ticket event appends are concurrency-safe against siblings still in
  // flight. The crash interrupt itself is still raised at the super-step
  // boundary.
  if (crashReason !== null) {
    appendEvent(env.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: plan.attempt,
      kind: "crash",
      payload: { code: exitCode, reason: crashReason, logTail, outcomeExists },
    });
  }

  return {
    marker,
    status,
    logPath,
    exitCode,
    plan,
    joinedAtExit: false,
    logTail,
    outcomePath,
    outcomeExists,
    spawnProposals:
      outcome.ok && !plan.verify && crashReason === null
        ? (outcome.outcome.spawn ?? [])
        : undefined,
    update: {
      // A verify candidate moves only the pool log: the tickets and outcomes
      // channels are keyed by ticket id, and N attempts of one ticket would
      // clobber each other there and write a status the fan-out must not
      // write. The events file and the per-attempt files are the record.
      ...(plan.verify ? {} : { tickets: { [marker.id]: status } }),
      log: [
        plan.verify
          ? `ticket ${marker.id}: attempt ${plan.attempt} exited ${exitCode} ` +
            `(${status})` +
            (crashReason !== null ? `, crash: ${crashReason}` : "")
          : `ticket ${marker.id}: exited ${exitCode}, marker ${status}` +
            (crashReason !== null ? `, crash: ${crashReason}` : ""),
      ],
      ...(outcome.ok && !plan.verify
        ? { outcomes: { [marker.id]: outcome.outcome } }
        : {}),
    },
  };
}

// Once the harness child has exited, its stdout/stderr pumps get this long to
// drain whatever is still in flight before the streams are torn down. A
// grandchild that inherits the child's pipe and outlives it holds the write
// end open, so EOF never arrives and an unbounded pump would park the drive
// forever on a child that is already gone.
const SPAWN_PUMP_GRACE_MS = 2_000;

// A drain wait that cannot reject: a write stream an error is destroying
// never drains, and that failure is recorded by the stream's error
// listener, never by the pump's wait.
function drainWait(stream: WriteStream): Promise<unknown> {
  return once(stream, "drain").catch(() => {});
}

async function spawnToLog(
  argv: string[],
  ctx: SpawnContext,
): Promise<number> {
  // The child env comes from spawnEnv, the same builder the spawned event's
  // env facts derive from, so the event cannot drift from what the child
  // actually ran under (ADR-0012).
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: spawnEnv(ctx.cwd),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // A streamed harness (ADR-0012) also tees every stdout chunk verbatim to
  // the attempt's Stream file, live as bytes arrive; both files open at
  // spawn, so a tail on either shows activity from the first chunk.
  const tee = ctx.streamPath ? createWriteStream(ctx.streamPath) : null;
  // Both streams land in one log writer in arrival order, and land live,
  // matching run.sh's `2>&1 | tee`: a log can be tailed while the harness
  // is still running, and a crash log reads in the order the output
  // happened. Stream mode writes derived lines instead of raw bytes
  // (assistant text verbatim, one `[tool] Name: summary` line per tool
  // call); raw mode writes the chunk itself, exactly as before.
  const log = createWriteStream(ctx.logPath);
  // A failing write stream errors and destroys itself, and an unlistened
  // 'error' event escapes as an unhandled failure far from its cause. Both
  // streams report into one first-error capture here: the spawn fails on it
  // after teardown (a log the engine cannot write is a real failure, and
  // still kills the spawn), while the destruction itself can no longer
  // reject the teardown, because every writer and the end calls below check
  // the streams first.
  let streamError: unknown = null;
  const noteStreamError = (error: unknown): void => {
    if (streamError === null) streamError = error;
  };
  log.on("error", noteStreamError);
  if (tee) tee.on("error", noteStreamError);
  const exited = proc.exited;
  const writeDerivedLine = async (line: string): Promise<void> => {
    const text = deriveStreamLine(line) ?? line;
    if (text === "") return;
    if (log.destroyed) return;
    if (!log.write(`${text}\n`)) await drainWait(log);
  };
  // Each pump reads through an explicit reader so the child-exit grace can
  // cancel the read from outside: the for-await loop used before locks the
  // stream against exactly that teardown. A pump that drains before the
  // grace expires (the normal case: the pipe closes with the child) clears
  // its own timer, so clean spawns are untouched by the bound.
  //
  // In stream mode stdout carries the structured stream: its chunks tee
  // verbatim to the Stream file and derive the log line by line. stderr
  // feeds the same deriver without teeing, so plain-text diagnostics pass
  // through to the log. Raw mode writes the chunk itself, exactly as
  // before. Per-stream buffers: a partial line from one stream never merges
  // with the other's.
  type PumpMode = "stream" | "diagnostics" | "raw";
  const pump = (stream: ReadableStream<Uint8Array>, mode: PumpMode) => {
    const reader = stream.getReader();
    const buffer = mode === "raw" ? null : new StreamLineBuffer();
    // One error boundary for the whole pump: a pump failure settles this
    // promise instead of rejecting it, so both pumps always settle before
    // the teardown below runs, and a stream destroyed mid-write can never
    // reject the spawn through a multiplexed Promise.all whose sibling pump
    // is still unwinding. Every failure is recorded through the same
    // first-error capture the streams' error listeners feed, so a genuine
    // failure still fails the spawn at the rethrow after teardown; the
    // destruction itself is never a rejection, because a destroyed writer
    // fails writes silently and the end calls below skip it.
    const reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            for (const line of buffer?.flush() ?? []) await writeDerivedLine(line);
            return;
          }
          if (mode === "stream" && tee && !tee.destroyed && !tee.write(value)) {
            await drainWait(tee);
          }
          if (buffer) {
            for (const line of buffer.push(value)) await writeDerivedLine(line);
          } else if (!log.destroyed && !log.write(value)) {
            await drainWait(log);
          }
        }
      } catch (error) {
        noteStreamError(error);
      }
    })();
    void exited
      .then(() => {
        const timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
        }, SPAWN_PUMP_GRACE_MS);
        void reading.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      })
      .catch(() => {});
    return reading;
  };
  const [exitCode] = await Promise.all([
    exited,
    pump(proc.stdout, tee ? "stream" : "raw"),
    pump(proc.stderr, tee ? "diagnostics" : "raw"),
  ]);
  // The teardown the pumps can never reject: end() on a stream an error
  // already destroyed throws ERR_STREAM_DESTROYED, so the destroyed check
  // skips it, and end's own write failure is recorded rather than thrown,
  // leaving the boundary below as the spawn's only rejection path.
  const endStream = (stream: WriteStream): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stream.destroyed) {
        resolve();
        return;
      }
      try {
        stream.end((error: Error | null | undefined) => {
          if (error) noteStreamError(error);
          resolve();
        });
      } catch {
        resolve();
      }
    });
  await endStream(log);
  if (tee) await endStream(tee);
  // The spawn still fails on a genuine write failure, exactly as a
  // rejecting pump did before the boundary existed; the destruction itself
  // is not one.
  if (streamError !== null) throw streamError;
  return exitCode;
}

export function resolveAssignment(
  marker: TicketMarker,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  const assign = config.assign?.[marker.id] ?? {};
  const harness = assign.harness ?? config.defaults?.harness ?? "";
  const model = assign.model ?? config.defaults?.model ?? "";
  const drivers =
    assign.drivers ?? config.defaults?.drivers ?? "implement";
  // Resolution is total: a ticket with no assign entry and no defaults
  // resolves to empty harness and model (nulls on the wire), so the
  // misconfiguration renders on the canvas instead of failing pool load.
  // The pool config error for it fires at the spawn sites, in
  // harnessCommandFor; only a named-but-unknown harness still fails here,
  // at load, as it always has.
  if (harness && !harnesses[harness]) {
    throw new Error(
      `pool config: ticket ${marker.id} names unknown harness '${harness}'. ` +
        `Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  let verify: number | undefined;
  if (assign.verify != null) {
    if (!Number.isInteger(assign.verify) || assign.verify < 1) {
      throw new Error(
        `pool config: ticket ${marker.id} has invalid verify ` +
          `${JSON.stringify(assign.verify)} (must be an integer >= 1)`,
      );
    }
    verify = assign.verify;
  }
  return { harness, model, drivers, verify };
}

/**
 * The pool's config loader, the single parser of console.json. The server
 * consumes the same parsed config it hands the engine, so the file is read
 * and validated exactly once.
 */
export function readConfig(poolDir: string): PoolConfig {
  const raw = readOptional(join(poolDir, "console.json"));
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

function repoRootOf(poolDir: string): string {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", poolDir, "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode === 0) {
    const root = probe.stdout.toString().trim();
    if (root) return root;
  }
  return poolDir;
}
