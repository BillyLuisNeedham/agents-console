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
} from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  appendEvent,
  attemptLogName,
  lastAttempt,
  lastAttemptOfKind,
  nextAttempt,
  type TicketEventKind,
} from "./events.ts";
import { CheckpointStore } from "./checkpoints.ts";
import { QueuedAnswerStore, type QueuedAnswer } from "./queued-answers.ts";
import {
  loadPoolMarkers,
  readMarker,
  writeMarkerStatus,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { buildPrompt, buildResolverPrompt } from "./prompt.ts";
import {
  defaultHarnesses,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";
import {
  branchExists,
  branchFor,
  commitMerge,
  currentBranch,
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

export interface Outcome {
  status: OutcomeStatus;
  summary: string;
  commitSha: string | null;
  brief?: string;
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
  resolver?: string;
  port?: number;
}

export type InterruptKind =
  | "checkpoint"
  | "crash"
  | "deadlock"
  | "merge-conflict"
  | "merge-approval"
  | "review";

// The final Review interrupt is not a ticket's: it belongs to the run, and it
// carries this id so the Console can hang it on the review utility card (the
// projection's REVIEW_CARD_ID is the same string by contract).
export const REVIEW_TICKET_ID = "REVIEW";

interface Interrupt {
  ticketId: string;
  kind: InterruptKind;
  body: string;
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

export type RunPhase = "running" | "done" | "quiescent" | "stalled";

export interface PoolSnapshot {
  seq: number;
  phase: RunPhase;
  state: PoolState;
  // The queued-answer store's pending records at emit time, merged in as the
  // snapshot is built. The store stays outside PoolState (ADR-0004); the
  // snapshot is where the two meet, so every emitted frame carries the
  // answered-and-waiting state with no change to super-step merge semantics.
  queuedAnswers: QueuedAnswer[];
}

interface RunOptions {
  poolDir: string;
  harnesses?: Record<string, HarnessCommand>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
  issueRunnerPath?: string;
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
  resolverAttempts: Map<string, { files: string[]; note: string }>;
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

  const assignments = new Map(
    markers.map((marker) => [
      marker.id,
      resolveAssignment(marker, config, harnesses),
    ]),
  );

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
    store: new CheckpointStore(poolDir),
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
    resolverAttempts: new Map(),
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
  // The loop's own settle path routes any fatal error to every waiter, so
  // the rejection is already observed; nothing further can consume it here.
  driveLoop(session).catch(() => {});
}

// One emit point for every snapshot the run produces: the drive loop's
// lifecycle emits and the acceptance emit (a new queued answer while a
// super-step is in flight). Each carries the store's pending answers at emit
// time, and every markProcessed is followed by an emit, so the merged queue
// in the snapshot stream never goes stale.
function emitSnapshot(session: Session, phase: RunPhase): void {
  const snapshot: PoolSnapshot = {
    seq: session.snapshots.length,
    phase,
    state: session.state,
    queuedAnswers: session.answers.pending(),
  };
  session.snapshots.push(snapshot);
  session.onSnapshot?.(snapshot);
}

async function driveLoop(session: Session): Promise<void> {
  const emit = (phase: RunPhase) => emitSnapshot(session, phase);

  emit("running");
  try {
    for (;;) {
      reconcileDeadlocks(session);
      // The super-step boundary: answers accepted while the previous
      // super-step was in flight are applied now, in submission order, after
      // that super-step's join and persistence and before this one's
      // scheduling. Processing never spawns; the scheduling below does.
      drainAnswers(session);
      const ready = readyTickets(session.markers, session.state.tickets);
      if (ready.length === 0) break;
      session.superStep += 1;
      const scheduledAttempts = new Map(
        ready.map((marker) => [
          marker.id,
          nextAttempt(session.runsDir, marker.id),
        ]),
      );
      session.state = applyUpdate(session.state, {
        tickets: Object.fromEntries(
          ready.map((marker) => [marker.id, "in-progress" as const]),
        ),
        log: [
          `super-step ${session.superStep}: ${ready.map((m) => m.id).join(", ")}`,
        ],
      });
      writeMarkers(session);
      for (const marker of ready) {
        appendEvent(session.runsDir, marker.id, {
          at: new Date().toISOString(),
          attempt: scheduledAttempts.get(marker.id)!,
          kind: "scheduled",
          payload: {},
        });
      }
      emit("running");
      const snapshot = session.state;

      const plans = new Map(
        ready.map((marker) => [
          marker.id,
          planTicket(
            session,
            marker,
            ready.length,
            scheduledAttempts.get(marker.id)!,
          ),
        ]),
      );

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
        ready.map((marker) =>
          runTicket(
            marker,
            snapshot,
            session.assignments.get(marker.id)!,
            {
              poolDir: session.poolDir,
              runsDir: session.runsDir,
              issuesDir: session.issuesDir,
              harnesses: session.harnesses,
            },
            plans.get(marker.id)!,
          ).then((result) => {
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
      for (const { marker, status, logPath } of results) {
        if (status === "in-progress") {
          // The crash event and the marker update landed at attempt exit;
          // only the crash interrupt waits for the boundary here. A
          // checkpoint's interrupt was already raised at exit, so the
          // at-exit path is the only writer of its interrupt.
          raiseInterrupt(session, {
            ticketId: marker.id,
            kind: "crash",
            body: logPath,
          });
        }
      }
      persist(session);
      emit("running");
    }
  } catch (error) {
    closeStore(session);
    settleDrive(session, null, error);
    throw error;
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
    persist(session);
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
  persist(session);
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
      join(session.runsDir, `${marker.id}.outcome.json`),
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
// always inspectable by run.sh and the markers stay the shared truth.
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
// never takes the drive down with it.
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
  for (const m of session.markers) {
    if (!session.assignments.has(m.id)) {
      session.assignments.set(
        m.id,
        resolveAssignment(m, session.state.config, session.harnesses),
      );
    }
  }
  if (interrupt.kind === "review") {
    if (record.approve) {
      approveReview(session, interrupt, record.note);
    } else {
      rejectReview(session, interrupt, record.note);
    }
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
// manual path.
function resolveResolver(session: Session): ResolverSpec | null {
  const config = session.state.config;
  const explicit = config.resolver?.trim();
  if (explicit === "" || explicit === "none") return null;
  let harness = explicit;
  let model = config.defaults?.model;
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
  appendEvent(session.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: nextAttempt(session.runsDir, marker.id),
    kind: "resolver",
    payload: { files: result.conflicted },
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
    outcomePath,
    cwd: worktree.path,
  };
  const argv = session.harnesses[resolver.harness](ctx);
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
    rmSync(join(session.runsDir, `${marker.id}.outcome.json`), {
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
}

interface TicketPlan {
  cwd: string;
  worktree?: WorktreeInfo;
  attempt: number;
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
}

// Where a ticket runs. A multi-ticket super-step gives every ticket its own
// worktree branched from the same HEAD, so parallel harnesses never share a
// checkout. A ticket with a parked branch (checkpoint, crash or conflicted
// merge left it behind) always reuses its worktree, even alone, so it keeps
// the work it already did. Anything else runs in the main checkout. The main
// checkout's Issue file is the single canonical copy: the spawn prompt hands
// the agent its absolute path for reading and notes, and the engine writes
// the final status to it at attempt exit. The worktree gets a seed copy as
// context only; the merge already discards worktree Issue edits.
function planTicket(
  session: Session,
  marker: TicketMarker,
  readyCount: number,
  attempt: number,
): TicketPlan {
  if (!session.git) return { cwd: session.cwd, attempt };
  const parked = branchExists(session.cwd, marker.id);
  if (readyCount < 2 && !parked) {
    return { cwd: session.cwd, attempt };
  }
  const worktree = prepareWorktree(session.cwd, marker.id);
  const seedCopy = join(worktree.path, relative(session.cwd, marker.file));
  mkdirSync(dirname(seedCopy), { recursive: true });
  copyFileSync(marker.file, seedCopy);
  return { cwd: worktree.path, worktree, attempt };
}

// The engine owns the final status write (ADR-0005): the attempt's outcome
// JSON is the only ending signal, and anything that is not exit code 0 with a
// valid outcome is a crash. The crash reason distinguishes the classes in the
// ticket log: a dead harness, an agent that never wrote its outcome, an
// outcome that does not parse, and an outcome whose status is invalid.
type OutcomeResult =
  | { ok: true; outcome: Outcome }
  | { ok: false; reason: string };

function readOutcomeResult(path: string): OutcomeResult {
  if (!existsSync(path)) return { ok: false, reason: "no outcome written" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "outcome is not parseable JSON" };
  }
  const outcome = parsed as Partial<Outcome> | null;
  if (outcome?.status !== "done" && outcome?.status !== "checkpoint") {
    return { ok: false, reason: "outcome's status is not done or checkpoint" };
  }
  if (typeof outcome.summary !== "string") {
    return { ok: false, reason: "outcome has no summary string" };
  }
  return {
    ok: true,
    outcome: {
      status: outcome.status,
      summary: outcome.summary,
      commitSha: typeof outcome.commitSha === "string" ? outcome.commitSha : null,
      ...(typeof outcome.brief === "string" ? { brief: outcome.brief } : {}),
    },
  };
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
// existing well-known raw log moves to its attempt-numbered name so a re-run
// never destroys the ticket's history. The number is the attempt the events
// file recorded for the run that wrote the file: the last implement spawn for
// the base log, the last resolver run for the resolver log. A pre-feature
// log (written before events existed) rotates to attempt-0. The names come
// from the events module's naming contract.
function rotateAttemptLog(
  runsDir: string,
  ticketId: string,
  wellKnownPath: string,
  kind: TicketEventKind,
): void {
  if (!existsSync(wellKnownPath)) return;
  const attempt = lastAttemptOfKind(runsDir, ticketId, kind);
  renameSync(
    wellKnownPath,
    join(runsDir, attemptLogName(ticketId, attempt, kind === "resolver")),
  );
}

async function runTicket(
  marker: TicketMarker,
  snapshot: PoolState,
  assignment: Assignment,
  env: TicketEnv,
  plan: TicketPlan,
): Promise<TicketResult> {
  const [driver, ...chain] = assignment.drivers.split(/\s+/).filter(Boolean);
  const logPath = join(env.runsDir, attemptLogName(marker.id, null, false));
  rotateAttemptLog(env.runsDir, marker.id, logPath, "spawned");
  const outcomePath = join(env.runsDir, `${marker.id}.outcome.json`);
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
    outcomePath,
    cwd: plan.cwd,
  };
  const argv = env.harnesses[assignment.harness](ctx);
  appendEvent(env.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: plan.attempt,
    kind: "spawned",
    payload: {},
  });
  const exitCode = await spawnToLog(argv, ctx);

  // The ending comes from the outcome JSON alone (ADR-0005). On a clean exit
  // with a valid outcome the engine writes the final status to the canonical
  // Issue's marker itself; a marker the agent rewrote is never honored.
  const outcome = readOutcomeResult(outcomePath);
  let status: TicketStatus = "in-progress";
  let crashReason: string | null = null;
  if (exitCode !== 0) {
    crashReason = `harness exited ${exitCode}`;
  } else if (!outcome.ok) {
    crashReason = outcome.reason;
  } else {
    status = outcome.outcome.status;
    writeMarkerStatus(marker.file, status);
    if (status === "checkpoint") {
      // Before the return: the drive loop raises the checkpoint's interrupt
      // from the Issue's Brief section the moment this attempt exits.
      landCheckpointBrief(marker.file, outcome.outcome.brief);
    }
  }
  if (crashReason !== null && readMarker(marker.file).status !== "in-progress") {
    writeMarkerStatus(marker.file, "in-progress");
  }
  appendEvent(env.runsDir, marker.id, {
    at: new Date().toISOString(),
    attempt: plan.attempt,
    kind: "exited",
    payload: { code: exitCode, status },
  });
  // A crash is recorded the moment the attempt exits (the marker has already
  // been corrected), not at the end of the super-step, so the ticket log
  // stops masquerading a dead attempt as running work. The payload carries
  // the exit code and the reason, so the log distinguishes a dead harness
  // from an agent that never wrote its outcome. Per-ticket event appends are
  // concurrency-safe against siblings still in flight. The crash interrupt
  // itself is still raised at the super-step boundary.
  if (crashReason !== null) {
    appendEvent(env.runsDir, marker.id, {
      at: new Date().toISOString(),
      attempt: plan.attempt,
      kind: "crash",
      payload: { code: exitCode, reason: crashReason },
    });
  }

  return {
    marker,
    status,
    logPath,
    exitCode,
    plan,
    joinedAtExit: false,
    update: {
      tickets: { [marker.id]: status },
      log: [
        `ticket ${marker.id}: exited ${exitCode}, marker ${status}` +
          (crashReason !== null ? `, crash: ${crashReason}` : ""),
      ],
      ...(outcome.ok ? { outcomes: { [marker.id]: outcome.outcome } } : {}),
    },
  };
}

async function spawnToLog(
  argv: string[],
  ctx: SpawnContext,
): Promise<number> {
  // env is passed explicitly: Bun resolves argv[0] against a cached PATH
  // unless an env is given, and the parent environment at spawn time is
  // what the child should inherit.
  //
  // PWD is forced to the spawn cwd: Bun passes env verbatim, so the
  // server's stale PWD (the checkout it was launched from) would otherwise
  // win, and opencode roots its project in PWD before cwd.
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: { ...process.env, PWD: ctx.cwd },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Both streams land in one log writer in arrival order, and land live,
  // matching run.sh's `2>&1 | tee`: a log can be tailed while the harness
  // is still running, and a crash log reads in the order the output
  // happened.
  const log = createWriteStream(ctx.logPath);
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      if (!log.write(chunk)) {
        await once(log, "drain");
      }
    }
  };
  const [exitCode] = await Promise.all([
    proc.exited,
    pump(proc.stdout),
    pump(proc.stderr),
  ]);
  await new Promise<void>((resolve, reject) => {
    log.end((error: Error | null | undefined) =>
      error ? reject(error) : resolve(),
    );
  });
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
  if (!harness) {
    throw new Error(
      `pool config: ticket ${marker.id} has no harness ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  if (!model) {
    throw new Error(
      `pool config: ticket ${marker.id} has no model ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  if (!harnesses[harness]) {
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
