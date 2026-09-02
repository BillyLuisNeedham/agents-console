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
import { buildGraderPrompt, buildPrompt, buildResolverPrompt } from "./prompt.ts";
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

// One attempt's outcome file name. The solo path keeps the well-known name;
// a verify fan-out writes per attempt, so N parallel outcomes never collide
// and each grader can bind to one attempt's file (ticket 03).
function outcomeFileName(ticketId: string, attempt: number | null): string {
  return attempt === null
    ? `${ticketId}.outcome.json`
    : `${ticketId}.attempt-${attempt}.outcome.json`;
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
      // Grader tickets are engine-run (they are spawned the moment their
      // build ticket's fan-out completes, which the ready set can never
      // express, since the build ticket stays in-progress until selection).
      // Excluding them here keeps a stray ready grader from ever being
      // scheduled as an ordinary implement ticket.
      !parseGraderId(marker.id) &&
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

  // Two passes: ordinary tickets resolve first, then grader tickets (ids the
  // engine writes, `<build>-grader-<attempt>`) resolve from their build
  // ticket's assignment, so a stale grader file on disk never fails pool
  // start and a grader inherits its builder with zero new config.
  const assignments = new Map<string, Assignment>();
  for (const marker of markers) {
    if (parseGraderId(marker.id)) continue;
    assignments.set(
      marker.id,
      resolveAssignment(marker, config, harnesses),
    );
  }
  for (const marker of markers) {
    if (assignments.has(marker.id)) continue;
    const grader = parseGraderId(marker.id)!;
    const build = assignments.get(grader.buildId);
    assignments.set(
      marker.id,
      build
        ? resolveGraderAssignment(config, marker, build, harnesses)
        : resolveAssignment(marker, config, harnesses),
    );
  }

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
            "spawned",
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
            },
            plan,
          ).then((result) => {
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
        if (session.assignments.get(marker.id)!.verify == null) continue;
        const attempts = results
          .filter((r) => r.marker.id === marker.id)
          .map((r) => r.plan.attempt)
          .sort((a, b) => a - b);
        await runGraders(session, marker, attempts, emit);
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
    if (session.assignments.has(m.id)) continue;
    const grader = parseGraderId(m.id);
    const build = grader
      ? session.assignments.get(grader.buildId)
      : undefined;
    session.assignments.set(
      m.id,
      build
        ? resolveGraderAssignment(session.state.config, m, build, session.harnesses)
        : resolveAssignment(m, session.state.config, session.harnesses),
    );
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

// ---------------------------------------------------------------------------
// Grading (ticket 03): engine-run grader tickets
// ---------------------------------------------------------------------------

// The grader's driver name, under the same contract as the resolver's: a real
// harness invokes it as a command stub, so a pool that grades on real
// harnesses needs a `verify` command written where the harness looks for
// commands. The grading instructions travel in the prompt body regardless;
// the fakes in the engine suite never see the driver name.
const GRADER_DRIVER = "verify";

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

// A grader's harness and model resolve through the ordinary assign machinery:
// an assign entry for the grader's own id overrides field-wise, and what it
// does not override comes from the build ticket's resolved assignment rather
// than the pool defaults, so a grader can be a different agent than its
// builder with zero new config. The grader's drivers are meaningless (the
// prompt is the pool's verify skill) and a grader is never itself a verify
// ticket, so neither carries over. An unknown harness fails fast with the
// same error a ticket's would, instead of an opaque crash mid-grading.
function resolveGraderAssignment(
  config: PoolConfig,
  graderMarker: TicketMarker,
  build: Assignment,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  const assign = config.assign?.[graderMarker.id] ?? {};
  const harness = assign.harness ?? build.harness;
  if (!harnesses[harness]) {
    throw new Error(
      `pool config: ticket ${graderMarker.id} names unknown harness ` +
        `'${harness}'. Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  return {
    harness,
    model: assign.model ?? build.model,
    drivers: build.drivers,
  };
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
async function runGraders(
  session: Session,
  build: TicketMarker,
  attempts: number[],
  emit: (phase: RunPhase) => void,
): Promise<void> {
  for (const [index, attempt] of attempts.entries()) {
    writeGraderTicket(session, build, index + 1, attempt);
  }
  session.markers = loadPoolMarkers(session.issuesDir);
  const graders = attempts.map((attempt, index) => {
    const marker = session.markers.find(
      (m) => m.id === graderIdFor(build.id, index + 1),
    )!;
    const assignment = resolveGraderAssignment(
      session.state.config,
      marker,
      session.assignments.get(build.id)!,
      session.harnesses,
    );
    session.assignments.set(marker.id, assignment);
    return { marker, assignment, attempt };
  });
  session.state = applyUpdate(session.state, {
    log: [
      `ticket ${build.id}: grading ${attempts.length} ` +
        `attempt${attempts.length === 1 ? "" : "s"} with grader tickets ` +
        graders.map((g) => g.marker.id).join(", "),
    ],
  });
  for (const { marker } of graders) {
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
  await Promise.all(
    graders.map(({ marker, assignment, attempt }) =>
      runGrader(session, build, marker, attempt, assignment, emit),
    ),
  );
}

async function runGrader(
  session: Session,
  build: TicketMarker,
  grader: TicketMarker,
  attempt: number,
  assignment: Assignment,
  emit: (phase: RunPhase) => void,
): Promise<void> {
  const gid = grader.id;
  const runsDir = session.runsDir;
  // As in runTicket: the grader starts with no outcome, so a stale file
  // from a previous grading round can never pass for this round's result.
  const graderOutcomePath = join(runsDir, outcomeFileName(gid, null));
  rmSync(graderOutcomePath, { force: true });
  const logPath = join(runsDir, attemptLogName(gid, null, false));
  rotateAttemptLog(runsDir, gid, logPath, "spawned");
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
    outcomePath: graderOutcomePath,
    cwd: session.cwd,
  };
  const argv = session.harnesses[assignment.harness](ctx);
  appendEvent(runsDir, gid, {
    at: new Date().toISOString(),
    attempt: lastAttempt(runsDir, gid),
    kind: "spawned",
    payload: {},
  });
  const exitCode = await spawnToLog(argv, ctx);
  const result = readGraderResult(graderOutcomePath);
  if (exitCode !== 0) {
    recordGraderFailure(
      session,
      build,
      grader,
      attempt,
      exitCode,
      `harness exited ${exitCode}`,
      emit,
    );
    return;
  }
  if (!result.ok) {
    recordGraderFailure(session, build, grader, attempt, exitCode, result.reason, emit);
    return;
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
    payload: { code: exitCode, status: "done" },
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
}

// A grader that exited non-zero or wrote no parseable grade decides nothing:
// the crash lands on the grader ticket, its marker stays in-progress, and
// the build ticket is untouched. Re-spawning the grader, and the bound that
// stops the retries, is ticket 07's machinery.
function recordGraderFailure(
  session: Session,
  build: TicketMarker,
  grader: TicketMarker,
  attempt: number,
  exitCode: number,
  reason: string,
  emit: (phase: RunPhase) => void,
): void {
  appendEvent(session.runsDir, grader.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, grader.id),
    kind: "exited",
    payload: { code: exitCode, status: "in-progress" },
  });
  appendEvent(session.runsDir, grader.id, {
    at: new Date().toISOString(),
    attempt: lastAttempt(session.runsDir, grader.id),
    kind: "crash",
    payload: { code: exitCode, reason },
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
  return validateOutcome(parsed);
}

// The outcome contract's validator, shared by the attempt reader and the
// grader reader so the two can never disagree about what a valid outcome is.
function validateOutcome(parsed: unknown): OutcomeResult {
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
  // A verify attempt writes its attempt-numbered log directly: N parallel
  // attempts cannot share the well-known path, and the number is known at
  // scheduling time. A solo attempt keeps the well-known path plus rotation.
  const logPath = plan.verify
    ? join(env.runsDir, attemptLogName(marker.id, plan.attempt, false))
    : join(env.runsDir, attemptLogName(marker.id, null, false));
  if (!plan.verify) {
    rotateAttemptLog(env.runsDir, marker.id, logPath, "spawned");
  }
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
  // Issue's marker itself; a marker the agent rewrote is never honored. A
  // verify candidate writes no status anywhere at its exit: the ticket is
  // in-progress until the whole fan-out has exited, and grading decides what
  // happens after (tickets 03 and 04).
  const outcome = readOutcomeResult(outcomePath);
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
