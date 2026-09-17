/**
 * The Attempt-run module (ADR-0014, amended): the one code path every spawn
 * site in the engine runs an Attempt through. A Ticket attempt, the merge
 * resolver, a grader, the head-to-head judge and a Conversation each hand
 * this module a parameter list (`AttemptSpec`) and the pool facts it needs
 * (`AttemptEnv`), and the module owns everything the five sites used to
 * repeat: clearing the stale result, naming and rotating the attempt's
 * files through the events module (ADR-0003), building the one
 * `SpawnContext`, deciding terminal-backed once, opening the herdr tab or
 * spawning headless, recording the `spawned` event, tailing the Stream file
 * into the derived log (ADR-0012, ADR-0016), waiting for readiness and
 * delivering the prompt, waiting on the Attempt ending (attempt-ending.ts
 * decides how the attempt ended, with what code, result and crash reason),
 * and recording `exited` and `crash` on the Ticket log.
 *
 * The seam is split in two so a Conversation, which never ends on a result
 * file, can use the launch half alone: `launchAttempt` runs from the stale
 * result clear to the delivered prompt and returns a handle, `awaitAttempt`
 * takes the handle to the exit facts, and `runAttempt` is both plus the log
 * events. What stays with the callers is deliberate: marker status writes
 * (three role rules under ADR-0005), tab close (per-role triggers), and the
 * role's own events.
 */

import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import {
  appendEvent,
  attemptExitCodeName,
  attemptLogName,
  attemptOutcomeName,
  attemptStreamName,
  lastAttemptOfKind,
  type AttemptLogName,
  type TicketEventKind,
} from "./events.ts";
import type { TicketStatus } from "./pool.ts";
import {
  defaultHarnessDescriptors,
  elidePromptArgv,
  engineEnvSet,
  harnessCommandFor,
  harnessStreamMode,
  interactiveHarnessCommand,
  spawnEnv,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";
import {
  attemptTabLabel,
  closePane,
  closeTab,
  openAttemptTab,
  paneSendInput,
  releasePaneAgent,
  reportPaneAgent,
  type PaneAgentState,
} from "./herdr.ts";
import {
  PANE_TAIL_POLL_MS,
  SPAWN_INTERACTIVE_PROMPT_FAILED,
  SPAWN_INTERACTIVE_READY_FAILED,
  SPAWN_INTERACTIVE_WRAPPER_LOST,
  attemptCrashReason,
  readAttemptResult,
  readExitCode,
  waitForAttemptEnding,
  type ReadFailure,
  type ResultValidator,
} from "./attempt-ending.ts";

// The result reader and its types live in the Attempt-ending module (the
// result file is the ending signal, ADR-0005); re-exported here because this
// module's callers and tests have always imported them from the Attempt-run
// module.
export { readAttemptResult };
export type { ReadFailure, ResultValidator };
import {
  DEFAULT_LAUNCH_CADENCE,
  sendWrapperToPane,
  typeVerified,
  waitForReadiness,
  waitForShellSettled,
  waitForWrapperLanded,
  type LaunchCadence,
} from "./pane-session.ts";
import type { ChildTracker } from "./children.ts";
import type { LiveAttempts } from "./live-attempts.ts";
import {
  StreamLineBuffer,
  TranscriptLineBuffer,
  deriveStreamLine,
} from "./streamlog.ts";
import { commitShaAt } from "./worktrees.ts";

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * The Pool workspace (issue #94) as a spawn site reads it: the engine
 * resolves it once at boot and every site reads it from here, the ADR-0014
 * pattern the terminal flag and the socket already follow. `id` is async
 * because boot resolution is an RPC: a spawn that races it waits for it
 * rather than opening its tab somewhere else. A null id means no Pool
 * workspace could be had at all, and the attempt falls back to headless
 * without ever sending an unplaced `tab.create`.
 */
export interface PoolWorkspace {
  /** The Pool workspace's id once boot resolution has settled; null when none could be resolved. */
  id(): Promise<string | null>;
  /**
   * Re-resolve after a refused `tab.create`, naming the id that spawn tried.
   * The id is what lets the engine tell the cases apart: a workspace the
   * operator closed mid-run is replaced (and the new id persisted), a
   * workspace that is still there hands back the same id because the
   * refusal was transient, and a spawn that lost the race to another's
   * re-resolve simply gets wherever the pool's tabs go now — so two
   * concurrent refusals can never mint two Pool workspaces. Null when no
   * workspace could be had at all. Callers retry the tab.create once.
   */
  reresolve(staleId: string): Promise<string | null>;
}

/**
 * The pool facts an Attempt runs against, modelled on the narrowed
 * environment `runTicket` already took instead of the whole session.
 * `terminalBacked` is the one place the pool's terminal setting is decided
 * (ADR-0014): every site reads the flag, none of them the config.
 */
export interface AttemptEnv {
  runsDir: string;
  harnesses: Record<string, HarnessCommand>;
  herdrSocket: string;
  /** Where this pool's tabs open (issue #94); unused by a headless pool. */
  poolWorkspace: PoolWorkspace;
  children: ChildTracker;
  /**
   * The Live attempts registry: the launch registers the Attempt once its
   * `spawned` event is recorded, and the run clears it where the ending is
   * recorded (a launch-only caller clears its own).
   */
  liveAttempts: LiveAttempts;
  terminalBacked: boolean;
  agents?: string;
  /**
   * The launch half's timings (pane-session.ts), for a test that drives a
   * botched launch in milliseconds; the engine leaves it unset.
   */
  launchCadence?: Partial<LaunchCadence>;
}

// How many times a terminal-backed launch opens a fresh tab before giving
// up on a wrapper that never runs (issue #102): the shell-startup race is
// per-spawn and intermittent, so a second tab almost always lands, and a
// third bounds the cost of one that does not.
export const LAUNCH_TRIES = 3;

/**
 * What genuinely varies between the five spawn sites. `R` is the shape of a
 * valid result as the site's validator returns it; it appears only in the
 * `exited` status rule, so a launch-only caller can leave it defaulted.
 */
export interface AttemptSpec<R extends { ok: true } = { ok: true }> {
  /** The Ticket (or Conversation) id the log and the files are keyed by. */
  id: string;
  /** The canonical Issue file the driver line hands the agent. */
  issuePath: string;
  /** The tab label's title. */
  title: string;
  /** The prompt body. */
  body: string;
  driver: string;
  harness: string;
  model: string;
  /** Where the harness runs. */
  cwd: string;
  /** The branch fact the `spawned` event records; null in the main checkout. */
  branch: string | null;
  /** The attempt number the events key off; the caller allocates it. */
  attempt: number;
  /** The free variables of the attempt's file names (events module). */
  naming: AttemptLogName;
  /**
   * Whether the well-known log rotates before this run writes it, keyed on
   * the last exited attempt. A verify candidate writes an attempt-numbered
   * log directly and never rotates; the resolver rotates before it appends
   * the `resolver` event its rotation keys on, so it rotates at its own
   * site and passes "none" here; a Conversation has exactly one attempt.
   */
  rotate: "exited" | "none";
  /**
   * What happens when the pool is terminal-backed and the tab cannot be
   * opened or the wrapper cannot be sent: "headless" runs the batch command
   * with the error on the `spawned` event (ADR-0014); "none" fails the
   * launch, for a Conversation that is a TUI or nothing (ADR-0018).
   */
  fallback: "headless" | "none";
  /**
   * How the prompt reaches a terminal-backed pane: "driver" is the
   * descriptor's interactive shaping (the `/driver <issue>` line, echo
   * verified on the issue reference, with the file-referencing fallback);
   * "plain" types the body verbatim, echo verified on `echo`, with no driver
   * line and no fallback (a Conversation's opening Turn).
   */
  prompt: { kind: "driver" } | { kind: "plain"; echo: string };
  /** The subject a crash reason names: "harness exited 3", "resolver exited 3". */
  crashSubject: "harness" | "resolver";
  /**
   * Which events the run appends to the Ticket log: "full" records
   * `spawned`, `exited` and `crash`, with `exitedStatus` giving the exited
   * event's status on a clean exit with a valid result (in-progress on any
   * crash), and `resultEvents` naming the events a valid result itself
   * carries (a ticket Outcome's rejected spawn proposals), appended before
   * `exited` so the log reads in the order the attempt produced them;
   * "spawned-only" records the spawn and nothing after, the resolver's and
   * a Conversation's contract.
   */
  events:
    | {
        kind: "full";
        exitedStatus: (result: R) => TicketStatus;
        resultEvents?: (result: R) => Array<{ kind: TicketEventKind; payload: Record<string, unknown> }>;
      }
    | { kind: "spawned-only" };
}

/** The follow-file tailer deriving a pane's log from its Stream file. */
export interface PaneTailer {
  finish: () => Promise<void>;
}

interface AttemptHandleBase {
  env: AttemptEnv;
  spec: AttemptSpec<any>;
  ctx: SpawnContext;
  /** The pane the attempt runs in; null when headless (pool or fallback). */
  paneId: string | null;
  tabId: string | null;
}

/**
 * A launched Attempt: `live` once the harness is running and its prompt has
 * landed (or it runs headless), `ended` when the harness died before its
 * TUI came up (with its own exit code, the pane kept) or the launch was
 * botched (the engine's negative code, the pane closed). An ended handle
 * carries no tailer: the launch drained it, so the derived log is complete.
 */
export type AttemptHandle =
  | (AttemptHandleBase & {
      kind: "live";
      /** The headless child's pid (ADR-0017); absent in a pane. */
      pid?: number;
      /** The headless child's exit, already in flight; null in a pane. */
      headlessExit: Promise<number> | null;
      tailer: PaneTailer | null;
    })
  | (AttemptHandleBase & { kind: "ended"; code: number });

/** The exit facts every site reads (ADR-0012), plus the result. */
export interface AttemptFacts {
  code: number;
  logTail: string[];
  outcomeExists: boolean;
  paneId: string | null;
  tabId: string | null;
  logPath: string;
  outcomePath: string;
  exitCodePath: string;
}

/**
 * One Attempt's ending: `ok` exactly when the harness exited 0 and the
 * result file validated; otherwise the crash reason by today's rule (a
 * non-zero code wins over the file's contents; else the validator's
 * reason). The result rides on the crash branch too, because a valid
 * Outcome beside a non-zero code is still a fact a site records.
 */
export type AttemptRun<R extends { ok: true }> = AttemptFacts &
  (
    | { ok: true; result: R; crashReason: null }
    | { ok: false; result: R | ReadFailure; crashReason: string }
  );

// ---------------------------------------------------------------------------
// Naming and the result reader
// ---------------------------------------------------------------------------

/**
 * One attempt's Stream file path (ADR-0012, amended by ADR-0016 for the
 * terminal-backed path), or null when headless and the harness is raw: the
 * file's mode follows the pool. A terminal-backed attempt always gets a
 * Stream file, the `script` typescript capturing the whole session,
 * whatever the harness's stream mode, because the derived log comes from
 * it. A headless attempt's Stream file is the harness's structured stream,
 * which only stream-mode harnesses (claude, cursor) produce; raw harnesses
 * keep the old passthrough log. Verify attempts write attempt-numbered
 * Stream files directly, exactly as their logs do, so N parallel attempts
 * never share a path.
 */
export function attemptStreamPath(
  runsDir: string,
  ticketId: string,
  harness: string,
  attempt: number | null,
  resolver: boolean,
  terminal: boolean,
): string | null {
  if (terminal || harnessStreamMode(harness) === "stream") {
    return join(runsDir, attemptStreamName(ticketId, attempt, resolver));
  }
  return null;
}

/**
 * Attempt rotation on re-run (ADR 0002): before a new attempt writes, an
 * existing well-known log moves to its attempt-numbered name so a re-run
 * never destroys the ticket's history, and its Stream file rotates with it
 * (ADR-0012). The number is the attempt the events file recorded for the run
 * that wrote the file: the last exited implement (or engine-run) attempt for
 * the base log, the last resolver run for the resolver log. Implement logs
 * key on "exited" rather than "spawned" because a resolver run records a
 * spawned event of its own (ADR-0012) and never an exited one, so "exited"
 * still names exactly the run that wrote the file. A pre-feature log
 * (written before events existed) rotates to attempt-0. The names come from
 * the events module's naming contract.
 */
export function rotateAttemptLog(
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

// The exit facts' log tail (ADR-0012): the last ~20 lines of the attempt's
// log, so the events file alone shows how the attempt ended. A missing or
// unreadable log reads as no lines, never as an error: the fact is the
// empty tail.
const LOG_TAIL_LINES = 20;

export function readLogTail(logPath: string): string[] {
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

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

/**
 * Launch one Attempt: from the stale result clear to the delivered prompt.
 * Throws only for a pool config error (an assignment the harness table
 * cannot serve) or, with `fallback: "none"`, a terminal that could not be
 * had: the error names which half failed (`could not open a herdr tab` or
 * `could not deliver the launch command`) so the caller can prefix its own
 * contract's words.
 */
export async function launchAttempt<R extends { ok: true }>(
  env: AttemptEnv,
  spec: AttemptSpec<R>,
): Promise<AttemptHandle> {
  const { id, naming } = spec;
  const logPath = join(
    env.runsDir,
    attemptLogName(id, naming.attempt, naming.resolver),
  );
  if (spec.rotate === "exited") {
    rotateAttemptLog(env.runsDir, id, logPath, "exited");
  }
  const outcomePath = join(
    env.runsDir,
    attemptOutcomeName(id, naming.attempt, naming.resolver),
  );
  // Every attempt starts with no result: a file a previous attempt left
  // behind would be read as this attempt's result, honoring a stale status.
  rmSync(outcomePath, { force: true });
  const ctx: SpawnContext = {
    id,
    issuePath: spec.issuePath,
    body: spec.body,
    driver: spec.driver,
    harness: spec.harness,
    model: spec.model,
    agents: env.agents,
    logPath,
    streamPath: attemptStreamPath(
      env.runsDir,
      id,
      spec.harness,
      naming.attempt,
      naming.resolver,
      env.terminalBacked,
    ),
    outcomePath,
    exitCodePath: join(
      env.runsDir,
      attemptExitCodeName(id, naming.attempt, naming.resolver),
    ),
    cwd: spec.cwd,
  };
  const command = harnessCommandFor(env.harnesses, spec, id);
  const batchArgv = (): string[] => command(ctx);
  const recordSpawned = (
    argv: string[],
    terminal: AttemptTerminal | undefined,
    terminalError?: string,
    pid?: number,
  ): void => {
    appendEvent(env.runsDir, id, {
      at: new Date().toISOString(),
      attempt: spec.attempt,
      kind: "spawned",
      payload: spawnedPayload(argv, ctx, spec.branch, terminal, terminalError, pid),
    });
    // Live from the moment the spawn is on the log, with the pane the event
    // records: a fallback that nulled the event's pane_id is headless here
    // too, so the registry can never point at the pane the fallback closed.
    const headlessRun = terminal === undefined || terminalError !== undefined;
    env.liveAttempts.register(id, spec.attempt, {
      paneId: headlessRun ? null : terminal.paneId,
      tabId: headlessRun ? null : terminal.tabId,
    });
  };
  const headless = (
    terminal: AttemptTerminal | undefined,
    terminalError?: string,
  ): AttemptHandle => {
    // A headless spawn records once the child exists, so the event carries
    // its pid (ADR-0017); the callback runs before the first byte is pumped.
    const argv = batchArgv();
    let pid: number | undefined;
    const headlessExit = spawnToLog(argv, ctx, env.children, (spawnedPid) => {
      pid = spawnedPid;
      recordSpawned(argv, terminal, terminalError, spawnedPid);
    });
    return {
      kind: "live",
      env,
      spec,
      ctx,
      paneId: null,
      tabId: null,
      ...(pid !== undefined ? { pid } : {}),
      headlessExit,
      tailer: null,
    };
  };

  if (!env.terminalBacked) {
    if (spec.fallback === "none") {
      throw new Error("the pool is not terminal-backed");
    }
    return headless(undefined);
  }
  // A terminal-backed attempt opens its own named herdr tab before the
  // spawn is recorded, so the spawned event can carry the pane id the tab
  // came back with (ADR-0014, ADR-0015); the event is recorded once the wrapper send's
  // outcome is known, so a mid-flight fallback records pane_id null plus
  // terminal_error instead of the dead pane.
  //
  // The launch is tried into up to LAUNCH_TRIES fresh tabs (issue #96,
  // issue #102): a tab's shell is given time to settle before the wrapper
  // is typed, and `script` then has a short window to prove the wrapper ran
  // by creating the Stream file. A wrapper that never ran is a Botched
  // launch — the shell-startup race swallowed it — and is retried into a new
  // tab, the botched one closed and a `launch-retried` event recording it;
  // nothing is graded, and the `spawned` event names only the tab the launch
  // ended up in, so tab close and boot re-adoption never chase a tab the
  // retry already closed. The tries exhausted, the launch ends with the
  // engine's own code, as a readiness timeout always has.
  const cadence: LaunchCadence = { ...DEFAULT_LAUNCH_CADENCE, ...env.launchCadence };
  const interactiveArgv = interactiveHarnessCommand(env.harnesses, spec.harness)(ctx);
  let terminal: AttemptTerminal & { paneId: string; tabId: string };
  let landed: boolean;
  for (let attempt = 1; ; attempt++) {
    const opened = await openAttemptTerminal(env, id, spec.title, spec.cwd);
    if (opened.paneId === null || opened.tabId === null) {
      if (spec.fallback === "none") {
        throw new Error(`could not open a herdr tab: ${opened.error}`);
      }
      return headless(opened);
    }
    terminal = { paneId: opened.paneId, tabId: opened.tabId };
    await waitForShellSettled(env.herdrSocket, terminal.paneId, cadence);
    const terminalError = await sendWrapperToPane(
      env.herdrSocket,
      terminal.paneId,
      interactiveArgv,
      ctx,
    );
    if (terminalError !== undefined) {
      if (spec.fallback === "none") {
        throw new Error(`could not deliver the launch command: ${terminalError}`);
      }
      return headless(terminal, terminalError);
    }
    landed = ctx.streamPath
      ? await waitForWrapperLanded(ctx.streamPath, ctx.exitCodePath, cadence)
      : true;
    if (landed || attempt >= LAUNCH_TRIES) break;
    appendEvent(env.runsDir, id, {
      at: new Date().toISOString(),
      attempt: spec.attempt,
      kind: "launch-retried",
      payload: {
        try: attempt,
        pane_id: terminal.paneId,
        tab_id: terminal.tabId,
        reason: "launch command never ran",
      },
    });
    void closeTab(env.herdrSocket, terminal.tabId).catch(() => {});
  }
  recordSpawned(interactiveArgv, terminal);
  if (!landed) {
    // Every try was botched: the launch is over before any harness ran.
    // The pane is closed the way a readiness timeout's is, so the operator
    // is not left a silently idle tab; there is no transcript to drain.
    void closePane(env.herdrSocket, terminal.paneId).catch(() => {});
    return {
      kind: "ended",
      env,
      spec,
      ctx,
      paneId: terminal.paneId,
      tabId: terminal.tabId,
      code: SPAWN_INTERACTIVE_WRAPPER_LOST,
    };
  }
  // The wrapper is in the pane, so the pane is this attempt's agent: assert
  // the identity so herdr lists it in the operator's agent sidebar beside
  // the agents it detected itself (issue #94). A Ticket attempt has no Turn
  // state, so it is "working" from here until its ending releases it; a
  // Conversation's tick flips it as its Turn does.
  reportAttemptAgent(env, terminal.paneId, spec, "working");
  // The session half of a terminal-backed spawn (ADR-0016): the tailer on
  // the attempt's typescript Stream file, then prompt delivery (readiness
  // wait, typed prompt, echo verification, retry, file-reference fallback).
  // A botched delivery closes the pane so the operator is not left a
  // silently idle tab and ends with the engine's negative code. A harness
  // that exited on its own before the TUI came up ends with its code and
  // keeps its pane, the way every crashed attempt's tab stays open
  // (ADR-0014): the pane shows why it died, and when `script` itself
  // refused to run (issue #58) the pane is the only place that shows it,
  // the Stream file having never been created. The tailer always drains the
  // transcript it has so the crash log carries what the pane showed.
  const tailer = ctx.streamPath
    ? startPaneStreamTail(ctx.streamPath, ctx.logPath)
    : null;
  const failure = await deliverPrompt(env.herdrSocket, terminal.paneId, ctx, spec.prompt);
  if (failure !== undefined) {
    if (isBotchedSpawnCode(failure)) {
      void closePane(env.herdrSocket, terminal.paneId).catch(() => {});
    }
    if (tailer) await tailer.finish().catch(() => {});
    return {
      kind: "ended",
      env,
      spec,
      ctx,
      paneId: terminal.paneId,
      tabId: terminal.tabId,
      code: failure,
    };
  }
  return {
    kind: "live",
    env,
    spec,
    ctx,
    paneId: terminal.paneId,
    tabId: terminal.tabId,
    headlessExit: null,
    tailer,
  };
}

/**
 * Wait for a launched Attempt's ending and read its result. The wait itself
 * is the Attempt-ending module's one decision: a live pane goes in as a pane
 * watch (the three-form race against the result-file poll, ADR-0016), a
 * headless child as its exit, and an ended handle skips the wait, its
 * launch having already decided the ending. The tailer, if any, is drained
 * before the log tail is read, so the exit facts are complete.
 */
export async function awaitAttempt<R extends { ok: true }>(
  handle: AttemptHandle,
  validate: ResultValidator<R>,
): Promise<AttemptRun<R>> {
  const { env, spec, ctx } = handle;
  let code: number;
  let result: R | ReadFailure;
  let crashReason: string | null;
  if (handle.kind === "ended") {
    code = handle.code;
    result = readAttemptResult(ctx.outcomePath, validate);
    crashReason =
      code !== 0
        ? attemptCrashReason(env.children, code, ctx.exitCodePath, spec.crashSubject, handle.paneId)
        : result.ok
          ? null
          : result.reason;
  } else {
    let decision;
    try {
      decision = await waitForAttemptEnding<R>({
        watch:
          handle.headlessExit !== null
            ? { kind: "headless", exit: handle.headlessExit }
            : {
                kind: "pane",
                socketPath: env.herdrSocket,
                paneId: handle.paneId!,
              },
        exitCodePath: ctx.exitCodePath,
        outcomePath: ctx.outcomePath,
        validate,
        crashSubject: spec.crashSubject,
        tracker: env.children,
      });
    } finally {
      if (handle.tailer) await handle.tailer.finish().catch(() => {});
    }
    ({ code, result, crashReason } = decision);
  }
  // The Attempt is over, so its pane is no longer an agent at work: the
  // identity the launch reported is released here (issue #94), where every
  // ending of a spawn-site attempt converges, whatever the pane's own fate
  // (a crashed attempt keeps its tab until merge, and must still leave the
  // agent list). A Conversation never reaches here — its endings are its
  // own, and release there.
  if (handle.paneId !== null) {
    releaseAttemptAgent(env.herdrSocket, handle.paneId, spec.harness);
  }
  // The exit facts (ADR-0012), computed the moment the attempt exits: the
  // log is closed by now, so the tail is complete, and the result file's
  // existence is the fact that distinguishes "agent never wrote its
  // outcome" from "outcome was invalid".
  const facts: AttemptFacts = {
    code,
    logTail: readLogTail(ctx.logPath),
    outcomeExists: existsSync(ctx.outcomePath),
    paneId: handle.paneId,
    tabId: handle.tabId,
    logPath: ctx.logPath,
    outcomePath: ctx.outcomePath,
    exitCodePath: ctx.exitCodePath,
  };
  if (code !== 0 || !result.ok) {
    return { ...facts, ok: false, result, crashReason: crashReason! };
  }
  return { ...facts, ok: true, result, crashReason: null };
}

/**
 * One Attempt end to end: launch, await, and (with full events) the
 * `exited` event on every ending and the `crash` event on a bad one, with
 * the payloads the Ticket log has always carried. A crash is recorded the
 * moment the attempt exits, not at the end of the super-step, so the log
 * stops masquerading a dead attempt as running work; the crash interrupt
 * itself is still the caller's, raised at its own boundary.
 */
export async function runAttempt<R extends { ok: true }>(
  env: AttemptEnv,
  spec: AttemptSpec<R>,
  validate: ResultValidator<R>,
): Promise<AttemptRun<R>> {
  const handle = await launchAttempt(env, spec);
  const run = await awaitAttempt(handle, validate);
  if (spec.events.kind === "full") {
    const status: TicketStatus = run.ok
      ? spec.events.exitedStatus(run.result)
      : "in-progress";
    const { code, logTail, outcomeExists } = run;
    for (const event of run.ok ? (spec.events.resultEvents?.(run.result) ?? []) : []) {
      appendEvent(env.runsDir, spec.id, {
        at: new Date().toISOString(),
        attempt: spec.attempt,
        ...event,
      });
    }
    appendEvent(env.runsDir, spec.id, {
      at: new Date().toISOString(),
      attempt: spec.attempt,
      kind: "exited",
      payload: { code, status, logTail, outcomeExists },
    });
    if (!run.ok) {
      appendEvent(env.runsDir, spec.id, {
        at: new Date().toISOString(),
        attempt: spec.attempt,
        kind: "crash",
        payload: { code, reason: run.crashReason, logTail, outcomeExists },
      });
    }
  }
  // The Attempt ending is recorded (or, for a spawned-only run, decided):
  // the Live attempt leaves the registry at the same moment.
  env.liveAttempts.clear(spec.id, spec.attempt);
  return run;
}

// ---------------------------------------------------------------------------
// The terminal half: tab, wrapper, spawned payload
// ---------------------------------------------------------------------------

/**
 * The terminal facts a terminal-backed spawn adds to the `spawned` event's
 * payload (ADR-0014, ADR-0015): the root pane id the attempt's named tab
 * came back with and the tab id that pane lives in (the tab id is what merge
 * cleanup closes the terminal by), and, when the tab could not be opened, the
 * error that stopped it. Both ids are null on that fallback path: the attempt
 * runs headless and the ticket log carries why.
 */
interface AttemptTerminal {
  paneId: string | null;
  tabId: string | null;
  error?: string;
}

/**
 * Open the attempt's named herdr tab for a terminal-backed spawn, in the
 * Pool workspace (issue #94). Never throws: herdr is optional (ADR-0014), so
 * a missing or misbehaving daemon falls the spawn back to headless and the
 * failure lands on the spawned event, where the ticket log shows it.
 *
 * A refused `tab.create` is read as a Pool workspace that is gone — the
 * operator closed it mid-run — and costs the spawn one re-resolve and one
 * retry: whatever else the refusal was, re-resolving is cheap and the retry
 * is the only thing that saves the attempt from running headless. A second
 * refusal is the fallback, exactly as before. A pool with no Pool workspace
 * at all never sends an unplaced `tab.create`: that is a terminal error for
 * this attempt and nothing more.
 */
async function openAttemptTerminal(
  env: AttemptEnv,
  id: string,
  title: string,
  cwd: string,
): Promise<AttemptTerminal> {
  const label = attemptTabLabel(id, title);
  try {
    const workspaceId = await env.poolWorkspace.id();
    if (workspaceId === null) {
      throw new Error(
        "no Pool workspace: the herdr daemon could not give this pool one at boot",
      );
    }
    try {
      const tab = await openAttemptTab(env.herdrSocket, label, cwd, workspaceId);
      return { paneId: tab.paneId, tabId: tab.tabId };
    } catch (refused) {
      // The refused id goes back with the question: the engine answers with
      // the same workspace when it is still there (a transient refusal),
      // with the one another spawn's re-resolve already moved to, or with a
      // fresh one when this workspace is genuinely gone.
      const retryId = await env.poolWorkspace.reresolve(workspaceId);
      if (retryId === null) throw refused;
      const tab = await openAttemptTab(env.herdrSocket, label, cwd, retryId);
      return { paneId: tab.paneId, tabId: tab.tabId };
    }
  } catch (err) {
    return {
      paneId: null,
      tabId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Report this attempt's agent identity on its pane (issue #94), so herdr
 * lists it in the operator's agent sidebar: the harness the Assignment
 * resolved as the agent name, the attempt's tab label as the message.
 * Fire-and-forget and swallowing, exactly as the tab closes are: a daemon
 * that will not take the report changes nothing about the attempt, and the
 * sidebar is a convenience, never a dependency.
 */
export function reportAttemptAgent(
  env: AttemptEnv,
  paneId: string,
  spec: { id: string; title: string; harness: string },
  state: PaneAgentState,
): void {
  void reportPaneAgent(
    env.herdrSocket,
    paneId,
    spec.harness.toLowerCase(),
    state,
    attemptTabLabel(spec.id, spec.title),
  ).catch(() => {});
}

/**
 * Release this attempt's agent identity at its ending (issue #94), the other
 * half of `reportAttemptAgent`. Fire-and-forget for the same reasons.
 */
export function releaseAttemptAgent(
  socketPath: string,
  paneId: string,
  harness: string,
): void {
  void releasePaneAgent(socketPath, paneId, harness.toLowerCase()).catch(
    () => {},
  );
}

/**
 * The `spawned` event's payload (ADR-0012): the facts that would have
 * diagnosed a wrong-commit or wrong-place spawn from one line. The argv
 * carries the prompt body elided; the commit SHA resolves from the spawn cwd
 * at spawn time (null when git is unavailable or the cwd is not a checkout);
 * env is the keys the engine set on the child environment beyond the
 * inherited parent's, with their values. Terminal-backed spawns add pane_id
 * (and terminal_error on a headless fallback, whenever it happened: the tab
 * refusing to open or the wrapper refusing to send), per ADR-0014 and
 * ADR-0015. A headless spawn adds the child's pid (ADR-0017): the record
 * boot reconciliation checks for an orphan of a dead engine process.
 */
function spawnedPayload(
  argv: string[],
  ctx: SpawnContext,
  branch: string | null,
  terminal?: AttemptTerminal,
  terminalError?: string,
  pid?: number,
): Record<string, unknown> {
  return {
    argv: elidePromptArgv(argv, ctx.body),
    cwd: ctx.cwd,
    branch,
    commitSha: commitShaAt(ctx.cwd),
    env: engineEnvSet(spawnEnv(ctx.cwd)),
    ...(pid !== undefined ? { pid } : {}),
    ...(terminal
      ? {
          // A mid-flight fallback (the wrapper could not be sent to the pane)
          // nulls both ids and carries its own error, exactly the shape of
          // the tab.create fallback: the attempt runs headless, and the log
          // must never point at the dead pane the fallback closed.
          pane_id: terminalError !== undefined ? null : terminal.paneId,
          tab_id: terminalError !== undefined ? null : terminal.tabId,
          ...(terminal.error !== undefined || terminalError !== undefined
            ? { terminal_error: terminalError ?? terminal.error }
            : {}),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Prompt delivery
// ---------------------------------------------------------------------------

// Whether a spawn's code is one of the engine's own (the Attempt-ending
// module's SPAWN_INTERACTIVE sentinels): the harness never ran (or never
// took its prompt), as opposed to a code the harness exited with.
function isBotchedSpawnCode(code: number): boolean {
  return (
    code === SPAWN_INTERACTIVE_READY_FAILED ||
    code === SPAWN_INTERACTIVE_PROMPT_FAILED ||
    code === SPAWN_INTERACTIVE_WRAPPER_LOST
  );
}

/**
 * The prompt delivery half of a terminal-backed spawn (ADR-0016): wait for
 * the harness's ready frame, type the prompt, verify the echo, retry on a
 * lost paste, and (for a driver prompt) fall back to a short
 * file-referencing command when full-prompt pasting fails. Resolves
 * `undefined` once the prompt is in; a botched delivery resolves with the
 * engine's negative code; a harness that exited before its TUI came up
 * resolves with its own code. A custom harness (no descriptor) declares no
 * TUI: a driver prompt types nothing (its command runs as-is under the
 * script wrapper and its result or pane end decides the attempt), and a
 * plain prompt skips the readiness wait but is still typed, the operator's
 * words being the point.
 */
async function deliverPrompt(
  socketPath: string,
  paneId: string,
  ctx: SpawnContext,
  prompt: AttemptSpec["prompt"],
): Promise<number | undefined> {
  try {
    return await deliverPromptInner(socketPath, paneId, ctx, prompt);
  } catch {
    // A send failed mid-delivery (the daemon died after the wrapper was
    // sent): the prompt never landed. One attempt's terminal trouble must
    // never take the drive down, so this surfaces as the botched-spawn
    // failure rather than a throw.
    return SPAWN_INTERACTIVE_PROMPT_FAILED;
  }
}

async function deliverPromptInner(
  socketPath: string,
  paneId: string,
  ctx: SpawnContext,
  prompt: AttemptSpec["prompt"],
): Promise<number | undefined> {
  const descriptor = defaultHarnessDescriptors[ctx.harness];
  if (!descriptor && prompt.kind === "driver") return undefined;
  if (descriptor) {
    const readiness = await waitForReadiness(
      socketPath,
      paneId,
      ctx.harness,
      descriptor.readyPattern,
      ctx.exitCodePath,
    );
    // The harness exited before its TUI came up: the wrapper's exit-code
    // file holds its code, and that code, not a botched-spawn sentinel, is
    // the attempt's ending, exactly as a headless spawn that died on launch
    // reports (a 0 with no result lands on the missing-outcome path).
    if (readiness === "exited") return readExitCode(ctx.exitCodePath);
    if (readiness !== "ready") return SPAWN_INTERACTIVE_READY_FAILED;
  }
  const clearKeys = descriptor?.clearKeys ?? [];
  if (prompt.kind === "plain") {
    const echoTargets = [descriptor?.echoPattern, prompt.echo].filter(
      (target): target is string => typeof target === "string" && target.length > 0,
    );
    if (await typeVerified(socketPath, paneId, ctx.body, echoTargets, clearKeys)) {
      return undefined;
    }
    return SPAWN_INTERACTIVE_PROMPT_FAILED;
  }
  const shaped = descriptor!.promptShaping.interactive(ctx);
  // The fallback's prompt file, written by the engine so the path is known
  // to both sides; named from the result path so N parallel attempts never
  // share one. It carries the issue reference the primary prompt's driver
  // line would have carried, then the body, so the agent the fallback
  // reaches still starts on the right ticket.
  const promptFile = ctx.outcomePath.replace(/\.json$/, ".prompt.txt");
  writeFileSync(promptFile, `${ctx.issuePath}\n\n${ctx.body}`);
  const echoTargets = [
    descriptor!.echoPattern,
    // The issue reference rides every known TUI's prompt, so it is the
    // harness-agnostic echo signal (claude and cursor also collapse the
    // paste to their echoPattern marker).
    ctx.issuePath,
  ].filter((target): target is string => typeof target === "string");
  // A harness with no verified clear sequence cannot safely re-paste: a
  // false-negative echo would concatenate. One attempt, then a loud fail.
  // Clear keys are not sent before the first paste: opencode's ctrl+c
  // exits on empty input (prototype/tui-clear-input/FINDINGS.md). The
  // retry-with-clear loop and its echo verification are pane-session.ts's
  // typeVerified.
  if (await typeVerified(socketPath, paneId, shaped, echoTargets, clearKeys)) {
    return undefined;
  }
  if (clearKeys.length === 0) return SPAWN_INTERACTIVE_PROMPT_FAILED;
  // Full-prompt pasting failed: the file-referencing fallback, short enough
  // to survive any input-buffer cap (prototype finding, all three harnesses).
  // The command carries the attempt's own driver, so a grader, resolver, or
  // head-to-head judge falls back to its own skill, not the ticket driver's.
  // One un-retried attempt: the pane was just cleared, so typeVerified needs
  // no clear keys of its own here.
  const fallback = `/${ctx.driver} ${promptFile}`;
  await paneSendInput(socketPath, paneId, { keys: clearKeys });
  if (await typeVerified(socketPath, paneId, fallback, [promptFile], [])) {
    return undefined;
  }
  return SPAWN_INTERACTIVE_PROMPT_FAILED;
}

// ---------------------------------------------------------------------------
// The Stream file: the pane tailer and the headless pump
// ---------------------------------------------------------------------------

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

// The teardown write streams get at spawn end: end() on a stream an error
// already destroyed throws ERR_STREAM_DESTROYED, so the destroyed check
// skips it, and end's own write failure is recorded through onError rather
// than thrown. Shared by the headless spawn's pumps and the terminal-backed
// spawn's follow-file tailer.
function endWriteStream(
  stream: WriteStream,
  onError: (error: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.destroyed) {
      resolve();
      return;
    }
    try {
      stream.end((error: Error | null | undefined) => {
        if (error) onError(error);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * The follow-file tailer (ADR-0014, amended by ADR-0016): reads the pane's
 * `script` typescript Stream file as it grows and derives the attempt log
 * from it line by line, stripping the ANSI and control noise so the log is
 * the readable transcript of the whole session, operator input included
 * (TranscriptLineBuffer). Terminal-backed attempts never derive stream-json
 * here; the headless pump in `spawnToLog` keeps the ADR-0012 JSONL
 * derivation. Polls by positioned reads; `finish` drains the tail, flushes
 * the line buffer, and ends the log stream. Exported for the boot-adopted
 * attempt's finalize (engine.ts), which tails a pane it never launched.
 */
export function startPaneStreamTail(
  streamPath: string,
  logPath: string,
): PaneTailer {
  const log = createWriteStream(logPath);
  let streamError: unknown = null;
  log.on("error", (error) => {
    if (streamError === null) streamError = error;
  });
  const writeDerivedLine = async (line: string): Promise<void> => {
    if (log.destroyed) return;
    if (!log.write(`${line}\n`)) await drainWait(log);
  };
  let buffer = new TranscriptLineBuffer();
  let offset = 0;
  let fd: number | null = null;
  let stepping = false;
  const chunk = new Uint8Array(64 * 1024);
  // One poll step: open the file once script has created it, then read
  // everything new since the last offset through the line buffer.
  // Concurrent ticks are skipped, never interleaved: a step awaits its log
  // writes under backpressure, and two steps running at once could write
  // the derived log out of order.
  const step = async (): Promise<void> => {
    if (stepping) return;
    stepping = true;
    try {
      if (fd === null) {
        try {
          fd = openSync(streamPath, "r");
        } catch {
          return; // script has not created the file yet
        }
        offset = 0;
        buffer = new TranscriptLineBuffer();
      }
      let size: number;
      try {
        size = fstatSync(fd).size;
      } catch {
        return;
      }
      if (size < offset) {
        // The file was replaced (a re-run truncated it): re-read from scratch.
        offset = 0;
        buffer = new TranscriptLineBuffer();
      }
      while (offset < size) {
        let read: number;
        try {
          read = readSync(fd, chunk, 0, chunk.length, offset);
        } catch {
          return;
        }
        if (read <= 0) return;
        offset += read;
        for (const line of buffer.push(chunk.subarray(0, read))) {
          await writeDerivedLine(line);
        }
      }
    } finally {
      stepping = false;
    }
  };
  const timer = setInterval(() => {
    void step().catch(() => {});
  }, PANE_TAIL_POLL_MS);
  const finish = async (): Promise<void> => {
    clearInterval(timer);
    await step().catch(() => {});
    for (const line of buffer.flush()) await writeDerivedLine(line);
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    }
    await endWriteStream(log, (error) => {
      if (streamError === null) streamError = error;
    });
    // A log the engine cannot write is a real failure, same as the headless
    // spawn's rethrow.
    if (streamError !== null) throw streamError;
  };
  return { finish };
}

async function spawnToLog(
  argv: string[],
  ctx: SpawnContext,
  children: ChildTracker,
  onSpawn?: (pid: number) => void,
): Promise<number> {
  // The child env comes from spawnEnv, the same builder the spawned event's
  // env facts derive from, so the event cannot drift from what the child
  // actually ran under (ADR-0012). The child leads its own process group
  // (ADR-0017): a stop signals the group, so the harness's own children go
  // with it instead of surviving as the orphans an untrapped kill left.
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    env: spawnEnv(ctx.cwd),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  children.track({ pid: proc.pid, exited: proc.exited });
  onSpawn?.(proc.pid);
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
  // The teardown the pumps can never reject, shared with the terminal-backed
  // tailer: end() on a stream an error already destroyed throws
  // ERR_STREAM_DESTROYED, so the destroyed check skips it, and end's own
  // write failure is recorded rather than thrown, leaving the boundary below
  // as the spawn's only rejection path.
  await endWriteStream(log, noteStreamError);
  if (tee) await endWriteStream(tee, noteStreamError);
  // The spawn still fails on a genuine write failure, exactly as a
  // rejecting pump did before the boundary existed; the destruction itself
  // is not one.
  if (streamError !== null) throw streamError;
  return exitCode;
}
