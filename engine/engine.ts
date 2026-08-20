import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { once } from "node:events";
import { dirname, join, relative } from "node:path";
import { CheckpointStore } from "./checkpoints.ts";
import {
  loadPoolMarkers,
  readMarker,
  writeMarkerStatus,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { buildPrompt } from "./prompt.ts";
import {
  defaultHarnesses,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";
import {
  branchExists,
  branchFor,
  gitAvailable,
  mergeBranch,
  prepareWorktree,
  removeWorktree,
  worktreePathFor,
  type MergeResult,
  type WorktreeInfo,
} from "./worktrees.ts";

export type { TicketStatus } from "./pool.ts";
export type { HarnessCommand, SpawnContext } from "./spawn.ts";

export interface Outcome {
  summary: string;
  commitSha: string | null;
}

export interface TicketAssignment {
  harness?: string;
  model?: string;
  drivers?: string;
}

export interface PoolConfig {
  defaults?: { harness?: string; model?: string; drivers?: string };
  assign?: Record<string, TicketAssignment>;
  roster?: string;
  agents?: string;
}

export type InterruptKind = "checkpoint" | "crash" | "deadlock" | "merge-conflict";

export interface Interrupt {
  ticketId: string;
  kind: InterruptKind;
  body: string;
}

export interface PoolState {
  tickets: Record<string, TicketStatus>;
  log: string[];
  outcomes: Record<string, Outcome>;
  config: PoolConfig;
  interrupts: Interrupt[];
}

export interface PoolUpdate {
  tickets?: Record<string, TicketStatus>;
  log?: string[];
  outcomes?: Record<string, Outcome>;
  interrupts?: Interrupt[];
}

export type RunPhase = "running" | "done" | "quiescent" | "stalled";

export interface PoolSnapshot {
  seq: number;
  phase: RunPhase;
  state: PoolState;
}

export interface RunOptions {
  poolDir: string;
  harnesses?: Record<string, HarnessCommand>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
}

export interface PoolRun {
  phase: Exclude<RunPhase, "running">;
  final: PoolState;
  snapshots: PoolSnapshot[];
  interrupts: Interrupt[];
  resume: (ticketId: string, note?: string) => Promise<PoolRun>;
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
  };
}

export function readyTickets(
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
}

interface Session {
  poolDir: string;
  issuesDir: string;
  runsDir: string;
  agentMd: string;
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
  resumeChain: Promise<PoolRun | null>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
}

export async function runPool(options: RunOptions): Promise<PoolRun> {
  const poolDir = options.poolDir;
  const issuesDir = join(poolDir, "issues");
  const runsDir = join(poolDir, "runs");
  const markers = loadPoolMarkers(issuesDir);
  mkdirSync(runsDir, { recursive: true });

  const config = readConfig(poolDir);
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const agentMd = readOptional(join(poolDir, "AGENT.md")) ?? "";
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
    agentMd,
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
    },
    snapshots: [],
    store: new CheckpointStore(poolDir),
    storeOpen: true,
    superStep: 0,
    resumeChain: Promise.resolve(null),
    onSnapshot: options.onSnapshot,
  };

  rehydrate(session);
  return drive(session);
}

async function drive(session: Session): Promise<PoolRun> {
  const emit = (phase: RunPhase) => {
    const snapshot: PoolSnapshot = {
      seq: session.snapshots.length,
      phase,
      state: session.state,
    };
    session.snapshots.push(snapshot);
    session.onSnapshot?.(snapshot);
  };

  emit("running");
  try {
    for (;;) {
      reconcileDeadlocks(session);
      const ready = readyTickets(session.markers, session.state.tickets);
      if (ready.length === 0) break;
      session.superStep += 1;
      session.state = applyUpdate(session.state, {
        tickets: Object.fromEntries(
          ready.map((marker) => [marker.id, "in-progress" as const]),
        ),
        log: [
          `super-step ${session.superStep}: ${ready.map((m) => m.id).join(", ")}`,
        ],
      });
      writeMarkers(session);
      emit("running");
      const snapshot = session.state;

      const plans = new Map(
        ready.map((marker) => [marker.id, planTicket(session, marker, ready.length)]),
      );

      // Merges land in completion order: each ticket's merge chains onto a
      // serialized queue the moment the ticket finishes, while its siblings
      // are still running.
      const merges: { marker: TicketMarker; result: MergeResult }[] = [];
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
              agentMd: session.agentMd,
              harnesses: session.harnesses,
            },
            plans.get(marker.id)!,
          ).then((result) => {
            if (result.plan.worktree && result.status === "done") {
              mergeQueue = mergeQueue.then(() => {
                merges.push({
                  marker,
                  result: mergeTicket(session, marker, result.plan.worktree!),
                });
              });
            }
            return result;
          }),
        ),
      );
      await mergeQueue;

      let joined = snapshot;
      for (const { update } of results) {
        joined = applyUpdate(joined, update);
      }
      session.state = joined;
      for (const merge of merges) {
        if (merge.result.ok) {
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
          raiseInterrupt(
            session,
            mergeConflictInterrupt(session, merge.marker, merge.result),
          );
        }
      }
      for (const { marker, status, logPath } of results) {
        if (status === "checkpoint") {
          raiseInterrupt(session, checkpointInterrupt(marker));
        } else if (status === "in-progress") {
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
    throw error;
  }

  const pending = session.markers
    .map((m) => m.id)
    .filter((id) => session.state.tickets[id] !== "done");
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
  return {
    phase,
    final: session.state,
    snapshots: session.snapshots,
    interrupts: session.state.interrupts,
    resume: (ticketId, note) => enqueueResume(session, ticketId, note),
    close: () => closeStore(session),
  };
}

const ENGINE_RESET_NOTE =
  "\n---\n\n## Brief, written by the engine\n\n" +
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
  const stale = session.state.interrupts.filter((i) => {
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
      raiseInterrupt(session, checkpointInterrupt(marker));
    }
  }
  const recovered: Record<string, Outcome> = {};
  for (const marker of session.markers) {
    if (marker.status !== "done") continue;
    const outcome = readOutcome(
      join(session.runsDir, `${marker.id}.outcome.json`),
    );
    if (outcome) recovered[marker.id] = outcome;
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

function enqueueResume(
  session: Session,
  ticketId: string,
  note?: string,
): Promise<PoolRun> {
  const queued = session.resumeChain.then(() =>
    resumeTicket(session, ticketId, note),
  );
  session.resumeChain = queued.catch(() => null);
  return queued;
}

async function resumeTicket(
  session: Session,
  ticketId: string,
  note?: string,
): Promise<PoolRun> {
  const interrupt = session.state.interrupts.find(
    (i) => i.ticketId === ticketId,
  );
  if (!interrupt) {
    throw new Error(`resume: no pending interrupt for ticket ${ticketId}`);
  }
  session.markers = loadPoolMarkers(session.issuesDir);
  const marker = session.markers.find((m) => m.id === ticketId);
  if (!marker) {
    throw new Error(
      `resume: ticket ${ticketId} has no Issue file in ${session.issuesDir}`,
    );
  }
  for (const m of session.markers) {
    if (!session.assignments.has(m.id)) {
      session.assignments.set(
        m.id,
        resolveAssignment(m, session.state.config, session.harnesses),
      );
    }
  }
  if (interrupt.kind === "merge-conflict") {
    return resumeMerge(session, marker, interrupt, note);
  }
  if (marker.status !== "done") {
    writeMarkerStatus(marker.file, "ready");
    marker.status = "ready";
  }
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  session.state = applyUpdate(session.state, {
    tickets: Object.fromEntries(
      session.markers.map((m) => [m.id, m.status]),
    ),
    interrupts: session.state.interrupts.filter(
      (i) => i.ticketId !== ticketId,
    ),
    log: [
      `interrupt answered for ${ticketId} (${interrupt.kind}): ` +
        (marker.status === "done" ? "already done on disk" : "resumed"),
    ],
  });
  return drive(session);
}

// Resuming a merge-conflict interrupt re-attempts the merge. A human who
// resolved it by hand in the main checkout sees "Already up to date" and a
// deleted branch counts as resolved; a fresh conflict refreshes the
// interrupt and the pool stays quiescent. The ticket itself stays done: the
// work was finished, only the merge was pending.
async function resumeMerge(
  session: Session,
  marker: TicketMarker,
  interrupt: Interrupt,
  note?: string,
): Promise<PoolRun> {
  const branch = branchFor(marker.id);
  const worktree: WorktreeInfo = {
    path: worktreePathFor(session.cwd, marker.id),
    branch,
  };
  const aside = `${marker.file}.pool-aside`;
  renameSync(marker.file, aside);
  const result = mergeBranch(session.cwd, branch);
  renameSync(aside, marker.file);
  if (note && note.trim()) {
    appendFileSync(marker.file, `\n## Resume note\n\n${note.trim()}\n`);
  }
  if (!result.ok) {
    session.state = applyUpdate(session.state, {
      interrupts: [
        ...session.state.interrupts.filter((i) => i !== interrupt),
        mergeConflictInterrupt(session, marker, result),
      ],
      log: [`merge re-attempt for ${marker.id} still conflicts`],
    });
    return drive(session);
  }
  removeWorktree(session.cwd, worktree);
  session.state = applyUpdate(session.state, {
    interrupts: session.state.interrupts.filter((i) => i !== interrupt),
    log: [
      `interrupt answered for ${marker.id} (merge-conflict): merge landed` +
        (result.detail.endsWith("is gone") ? ` (${result.detail})` : ""),
    ],
  });
  return drive(session);
}

function raiseInterrupt(session: Session, interrupt: Interrupt): void {  if (
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
  const log: string[] = cleared.map(
    (i) => `interrupt cleared for ${i.ticketId} (deadlock): blockers can complete again`,
  );
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

function extractBrief(issueFile: string): string {
  const lines = readFileSync(issueFile, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Brief"));
  if (start === -1) return "(no Brief section in the Issue file)";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

interface TicketEnv {
  poolDir: string;
  runsDir: string;
  issuesDir: string;
  agentMd: string;
  harnesses: Record<string, HarnessCommand>;
}

interface TicketPlan {
  cwd: string;
  issuePath: string;
  worktree?: WorktreeInfo;
}

interface TicketResult {
  marker: TicketMarker;
  status: TicketStatus;
  logPath: string;
  plan: TicketPlan;
  update: PoolUpdate;
}

// Where a ticket runs. A multi-ticket super-step gives every ticket its own
// worktree branched from the same HEAD, so parallel harnesses never share a
// checkout. A ticket with a parked branch (checkpoint, crash or conflicted
// merge left it behind) always reuses its worktree, even alone, so it keeps
// the work it already did. Anything else runs in the main checkout. The main
// checkout's Issue file is the truth and is copied into the worktree at
// spawn, which is how a resume note reaches the agent.
function planTicket(
  session: Session,
  marker: TicketMarker,
  readyCount: number,
): TicketPlan {
  if (!session.git) return { cwd: session.cwd, issuePath: marker.file };
  const parked = branchExists(session.cwd, marker.id);
  if (readyCount < 2 && !parked) {
    return { cwd: session.cwd, issuePath: marker.file };
  }
  const worktree = prepareWorktree(session.cwd, marker.id);
  const issuePath = join(worktree.path, relative(session.cwd, marker.file));
  mkdirSync(dirname(issuePath), { recursive: true });
  copyFileSync(marker.file, issuePath);
  return { cwd: worktree.path, issuePath, worktree };
}

// Marker read-back. In a worktree the agent edited its own copy; a finished
// ticket's Issue content mirrors back to the main checkout so the dual-write
// and any Brief stay inspectable there. A marker left at ready or
// in-progress means the agent died; the main marker keeps the super-step's
// in-progress, matching the no-worktree crash path.
function readBack(marker: TicketMarker, plan: TicketPlan): TicketStatus {
  if (!plan.worktree) return readMarker(marker.file).status;
  const status = readMarker(plan.issuePath).status;
  if (status === "done" || status === "checkpoint") {
    copyFileSync(plan.issuePath, marker.file);
    return status;
  }
  return "in-progress";
}

// Merging one finished ticket's branch onto the pool's working branch. The
// dual-write leaves the Issue file dirty on the working branch and git
// refuses a merge that would touch a dirty file, so the Issue steps aside
// for the merge and comes straight back: its content already matches the
// worktree copy, whether or not the agent committed it.
function mergeTicket(
  session: Session,
  marker: TicketMarker,
  worktree: WorktreeInfo,
): MergeResult {
  const aside = `${marker.file}.pool-aside`;
  renameSync(marker.file, aside);
  const result = mergeBranch(session.cwd, worktree.branch);
  renameSync(aside, marker.file);
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

async function runTicket(
  marker: TicketMarker,
  snapshot: PoolState,
  assignment: Assignment,
  env: TicketEnv,
  plan: TicketPlan,
): Promise<TicketResult> {
  const [driver, ...chain] = assignment.drivers.split(/\s+/).filter(Boolean);
  const logPath = join(env.runsDir, `${marker.id}.log`);
  const outcomePath = join(env.runsDir, `${marker.id}.outcome.json`);
  const issueRel = relative(plan.cwd, plan.issuePath);

  const upstream = marker.blockedBy.flatMap((id) => {
    const outcome = snapshot.outcomes[id];
    return outcome ? [{ id, outcome }] : [];
  });

  const prompt = buildPrompt({
    driver,
    chain,
    issueRel,
    agentMd: env.agentMd,
    roster: snapshot.config.roster ?? "",
    upstream,
    outcomePath,
  });

  const ctx: SpawnContext = {
    id: marker.id,
    issuePath: plan.issuePath,
    issueRel,
    prompt,
    driver,
    harness: assignment.harness,
    model: assignment.model,
    agents: snapshot.config.agents,
    logPath,
    outcomePath,
    cwd: plan.cwd,
  };
  const argv = env.harnesses[assignment.harness](ctx);
  const exitCode = await spawnToLog(argv, ctx);

  const status = readBack(marker, plan);
  const outcome = readOutcome(outcomePath);

  return {
    marker,
    status,
    logPath,
    plan,
    update: {
      tickets: { [marker.id]: status },
      log: [
        `ticket ${marker.id}: exited ${exitCode}, marker ${status}` +
          (outcome ? "" : ", no outcome recorded"),
      ],
      ...(outcome ? { outcomes: { [marker.id]: outcome } } : {}),
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
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: { ...process.env },
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

function readOutcome(path: string): Outcome | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.summary !== "string") return null;
    return {
      summary: parsed.summary,
      commitSha: typeof parsed.commitSha === "string" ? parsed.commitSha : null,
    };
  } catch {
    return null;
  }
}

function resolveAssignment(
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
  return { harness, model, drivers };
}

function readConfig(poolDir: string): PoolConfig {
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
