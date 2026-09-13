/**
 * The **Attempt-ending** module (ADR-0014, fifth amendment; ADR-0016;
 * ADR-0017): the one place that decides an Attempt is over, for every way an
 * Attempt can run. `waitForAttemptEnding` is that decision: a fresh headless
 * child's exit, a fresh terminal-backed attempt's raced forms, and a
 * boot-adopted attempt all come in through the one interface and come out as
 * one result: how it ended, the exit code, and the site's validated result
 * or the crash reason. Its only consumers are the Attempt-run module
 * (`attempt-run.ts`) for fresh attempts and the boot reconcile's adopted
 * finalize; nothing else in the engine asks how an attempt ended.
 *
 * For a terminal-backed attempt, two observations say so, and they are raced
 * rather than ranked, because each is blind to what the other sees. herdr's
 * pane end is prompt and covers an attempt that never wrote anything (an
 * operator who closed the tab, a pane the host killed), but it travels down
 * a subscription the daemon can drop without saying so. The exit-code file
 * the pane wrapper writes before its shell exits covers exactly that,
 * because it does not depend on the daemon at all, but it never appears for
 * a pane that was killed. Ranking them either way leaves a single point of
 * failure: subscription-first is what parked a finished 98-minute attempt
 * for two hours with a `0` sitting on disk the whole time, and file-first
 * would park on the closed tab.
 *
 * A third observation closes the case where both of those fail. On a slow
 * cadence the wait re-checks herdr's pane listing; a pane that has left it
 * with no exit-code file behind it, after a short grace window for the
 * wrapper's last write, is a genuine crash and is reported as one. That is
 * what stands in for a deadline: liveness, not duration, because a real
 * review attempt legitimately runs for ninety-eight minutes and any ceiling
 * tight enough to catch a fault would kill it.
 *
 * The race lives here rather than in `herdr.ts` because it needs to know
 * where the pane wrapper writes, and `herdr.ts` speaks herdr's protocol and
 * nothing else.
 */

import { existsSync, readFileSync } from "node:fs";
import { listPaneIds, waitForPaneEnd } from "./herdr.ts";
import type { ChildTracker } from "./children.ts";

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * What the wait watches. A pane watch serves a fresh terminal-backed attempt
 * and a boot-adopted one alike, both being a pane the engine waits on; a
 * headless watch is the fresh headless child's exit, already in flight. The
 * two adapters are what make the seam real: the ending decision below never
 * knows which it is looking at past this union.
 */
export type AttemptWatch =
  | { kind: "pane"; socketPath: string; paneId: string }
  | { kind: "headless"; exit: Promise<number> };

/**
 * How an attempt's ending was observed.
 * - "outcome": a valid result file appeared (ADR-0016: the attempt ends on a
 *   valid result without requiring pane exit), or was already there when the
 *   ending landed.
 * - "child-exit": the headless child exited; the code is its own.
 * - "pane-end": herdr reported the pane exited or closed.
 * - "exit-code": the wrapper's exit-code file appeared, whatever the daemon
 *   was doing at the time.
 * - "pane-gone": the pane left herdr's listing and no exit-code file followed
 *   it within the grace window. The attempt is over and its exit code is
 *   unreadable; the caller's existing crash path is the right ending.
 */
export type AttemptEnding =
  | "outcome"
  | "child-exit"
  | "pane-end"
  | "exit-code"
  | "pane-gone";

/**
 * How a pane's ending was observed, for the one caller that watches a pane
 * without an attempt's result file (a Conversation's crash watch). The first
 * four are the attempt endings above; "released" is not an ending of the
 * attempt at all but an ending of the watching: the caller released the wait
 * before any observation landed.
 */
export type PaneEnding =
  | "pane-end"
  | "exit-code"
  | "pane-gone"
  | "released";

/** A result file that could not be read as a valid result, with the reason the crash event carries. */
export interface ReadFailure {
  ok: false;
  reason: string;
}

/** A site's result validator: the parsed JSON to a valid result or a failure. */
export type ResultValidator<R extends { ok: true }> = (
  parsed: unknown,
) => R | ReadFailure;

/**
 * The one decision an ending produces: how it ended, the exit code (a real
 * one, or one of the engine's negative sentinels below), the site's validated
 * result or the read failure, and the crash reason, null on a clean ending
 * (code 0 with a valid result), so a consumer's `ok` is simply
 * `crashReason === null`.
 */
export interface AttemptEndingDecision<R extends { ok: true }> {
  ending: AttemptEnding;
  code: number;
  result: R | ReadFailure;
  crashReason: string | null;
}

/**
 * What `waitForAttemptEnding` takes: plain fields, with no coupling to the
 * Attempt-run module's handle (the `pane-session.ts` precedent). `tracker`
 * is optional because only a fresh headless attempt can be stopped by
 * engine shutdown (ADR-0017); the shutdown-stop naming reads `stopping`
 * after the wait resolves, not at call time. `cadence` is the test override
 * for the pane race's slow paths.
 */
export interface AttemptEndingWait<R extends { ok: true }> {
  watch: AttemptWatch;
  exitCodePath: string;
  outcomePath: string;
  validate: ResultValidator<R>;
  crashSubject: string;
  tracker?: ChildTracker;
  cadence?: EndingCadence;
}

/**
 * Wait for an Attempt to end, and decide how it ended.
 *
 * A headless watch resolves on the child's exit and reads the result after.
 * A pane watch races the three-form pane race against the result-file poll
 * (ADR-0016: a TUI deliberately stays alive after the agent declares done,
 * so a valid result ends the attempt without requiring pane exit), and the
 * loser is released so one attempt costs the pool no subscription and no
 * timer once it is over. An exit-code file already on disk ends it
 * immediately, without opening a connection at all: the wrapper writes that
 * file before its shell exits, and a previous attempt's file is removed
 * before a wrapper is ever sent, so its presence can only mean this attempt
 * has finished. That is the boot-time adopted-attempt fast path, and it
 * costs nothing to give it to every caller.
 *
 * Neither consumer releases the wait, so the function takes no release
 * signal; "released" stays a pane-race-level concept. Consumers keep owning
 * the log tail, `outcomeExists`, and the tailer drain ordering.
 */
export async function waitForAttemptEnding<R extends { ok: true }>(
  wait: AttemptEndingWait<R>,
): Promise<AttemptEndingDecision<R>> {
  const { watch, exitCodePath, outcomePath, validate, crashSubject } = wait;
  const paneId = watch.kind === "pane" ? watch.paneId : null;
  let ending: AttemptEnding;
  let code: number;
  if (watch.kind === "headless") {
    // The headless adapter: the child's exit is the ending, and the result
    // read below decides whether it was a clean one.
    code = await watch.exit;
    ending = "child-exit";
  } else {
    const release = new AbortController();
    let observed: "outcome" | PaneEnding;
    try {
      observed = await Promise.race([
        waitForPaneEnding(
          watch.socketPath,
          watch.paneId,
          exitCodePath,
          release.signal,
          wait.cadence,
        ),
        outcomeCompleted(outcomePath, validate, release.signal),
      ]);
    } finally {
      release.abort();
    }
    // The result may have been written a moment before the ending landed;
    // confirm before reading the ending as a crash.
    if (observed === "outcome" || readAttemptResult(outcomePath, validate).ok) {
      ending = "outcome";
      code = 0;
    } else if (observed === "pane-gone") {
      // A pane that left the listing has already been given the race's grace
      // window to write its file and did not, so there is nothing to read and
      // nothing to wait for: reading anyway buys only the retry's two seconds
      // and then the wrong words, blaming a wrapper that never got to run.
      ending = "pane-gone";
      code = EXIT_CODE_PANE_GONE;
    } else if (observed === "released") {
      // Unreachable: "released" is settled only by the release signal, which
      // is this wait's own loser cleanup, aborted above after the race had
      // already settled. Withdraw rather than misreport an ending.
      return never();
    } else {
      // The exit-code file is written before the shell exits, so it is
      // already there in the normal case; the retry only covers a daemon
      // that reaps the pane ahead of the wrapper's last write.
      ending = observed;
      code = await readExitCode(exitCodePath);
    }
  }
  const result = readAttemptResult(outcomePath, validate);
  let crashReason: string | null = null;
  if (code !== 0) {
    crashReason = attemptCrashReason(
      wait.tracker,
      code,
      exitCodePath,
      crashSubject,
      paneId,
    );
  } else if (!result.ok) {
    crashReason = result.reason;
  }
  return { ending, code, result, crashReason };
}

// ---------------------------------------------------------------------------
// The result reader
// ---------------------------------------------------------------------------

/**
 * The one result reader (ADR-0005: the result file is the only ending
 * signal). The preamble is shared by every site, a missing file and an
 * unparseable one having the same two reasons everywhere; what a valid
 * result looks like is the site's validator, so an Outcome, a resolution, a
 * grade and a verdict read through the one path without agreeing on shape.
 */
export function readAttemptResult<R extends { ok: true }>(
  path: string,
  validate: ResultValidator<R>,
): R | ReadFailure {
  if (!existsSync(path)) return { ok: false, reason: "no outcome written" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, reason: "outcome is not parseable JSON" };
  }
  return validate(parsed);
}

// The result half of the pane watch's completion race: resolves once a valid
// result holds, polling at the completion cadence. Once the race is lost it
// stops polling and never settles, collected with the race.
const ATTEMPT_COMPLETE_POLL_MS = 250;

async function outcomeCompleted<R extends { ok: true }>(
  outcomePath: string,
  validate: ResultValidator<R>,
  release: AbortSignal,
): Promise<"outcome"> {
  while (!release.aborted) {
    if (readAttemptResult(outcomePath, validate).ok) return "outcome";
    await sleep(ATTEMPT_COMPLETE_POLL_MS, release);
  }
  return never();
}

// ---------------------------------------------------------------------------
// The pane race
// ---------------------------------------------------------------------------

/**
 * How often the engine looks at a pane's files. The follow-file tailer polls
 * the tee'd Stream file at this cadence, and the ending's watch on the
 * exit-code file rides the same one deliberately: it is the same directory,
 * already being stat'd this often, so the watch costs nothing new. `fs.watch`
 * was rejected for a file that appears exactly once and would have brought
 * platform-dependent behaviour with it.
 */
export const PANE_TAIL_POLL_MS = 250;

/** How often the wait re-checks that the pane is still in herdr's listing. */
const PANE_LIVENESS_MS = 30_000;

/**
 * How long the exit-code file gets to appear after the pane has left the
 * listing. The daemon can reap a pane just ahead of the wrapper's final
 * write, which is the same ordering `readExitCode`'s retry already assumes.
 */
const EXIT_CODE_GRACE_MS = 10_000;

/**
 * The cadences, overridable so a test can drive the slow paths in
 * milliseconds instead of minutes. Callers in the engine pass none.
 */
export interface EndingCadence {
  pollMs: number;
  livenessMs: number;
  graceMs: number;
}

const DEFAULT_CADENCE: EndingCadence = {
  pollMs: PANE_TAIL_POLL_MS,
  livenessMs: PANE_LIVENESS_MS,
  graceMs: EXIT_CODE_GRACE_MS,
};

/**
 * The three-form pane race on its own, exported for the one caller that
 * watches a pane with no result file in play: a Conversation's crash watch
 * (conversations.ts), which also passes its own release signal. Every
 * attempt-ending caller goes through `waitForAttemptEnding` above.
 *
 * An exit-code file already on disk ends it immediately, without opening a
 * connection at all. Otherwise all three observations run together and the
 * first one home wins. A lost subscription is not an ending: it says only
 * that herdr has stopped talking, and the other two carry the wait from
 * there, which is precisely the case this exists for. The wait is never
 * re-subscribed, and it is never bounded by the clock.
 *
 * Whichever observations lose are released here, as the wait settles, so a
 * pool that runs for days leaks neither a subscription nor a timer per
 * attempt. `releaseSignal` is the caller's own way out, for a caller that has
 * given up on the attempt or found its ending elsewhere; the two are
 * independent on purpose, so neither the caller nor this module depends on
 * the other remembering.
 */
export async function waitForPaneEnding(
  socketPath: string,
  paneId: string,
  exitCodePath: string,
  releaseSignal?: AbortSignal,
  cadence: EndingCadence = DEFAULT_CADENCE,
): Promise<PaneEnding> {
  if (existsSync(exitCodePath)) return "exit-code";
  if (releaseSignal?.aborted) return "released";
  const release = new AbortController();
  try {
    return await Promise.race([
      paneReportedItsEnd(socketPath, paneId, release.signal),
      exitCodeFileAppeared(exitCodePath, cadence, release.signal),
      paneLeftTheListing(socketPath, paneId, exitCodePath, cadence, release.signal),
      callerReleased(releaseSignal, release.signal),
    ]);
  } finally {
    release.abort();
  }
}

// herdr's own report. "lost" is the daemon going quiet, not the attempt
// ending, so it withdraws from the race rather than settling it.
async function paneReportedItsEnd(
  socketPath: string,
  paneId: string,
  release: AbortSignal,
): Promise<PaneEnding> {
  const end = await waitForPaneEnd(socketPath, paneId, release);
  if (end === "lost") return never();
  return "pane-end";
}

// The observation that does not depend on the daemon.
async function exitCodeFileAppeared(
  exitCodePath: string,
  cadence: EndingCadence,
  release: AbortSignal,
): Promise<PaneEnding> {
  for (;;) {
    await sleep(cadence.pollMs, release);
    if (release.aborted) return never();
    if (existsSync(exitCodePath)) return "exit-code";
  }
}

// The backstop for both of the others failing at once: a pane that has left
// herdr's listing without an event and without a file. A listing the daemon
// cannot answer says nothing about the pane, so the wait rides it out the way
// the pool rides out a daemon restart, rather than calling a live attempt
// crashed on the strength of an unreachable socket.
async function paneLeftTheListing(
  socketPath: string,
  paneId: string,
  exitCodePath: string,
  cadence: EndingCadence,
  release: AbortSignal,
): Promise<PaneEnding> {
  for (;;) {
    await sleep(cadence.livenessMs, release);
    if (release.aborted) return never();
    let live: string[];
    try {
      live = await listPaneIds(socketPath);
    } catch {
      // The listing says nothing about the pane, so ride it out the way the
      // pool rides out a daemon restart and look again next sweep.
      if (release.aborted) return never();
      continue;
    }
    if (release.aborted) return never();
    if (live.includes(paneId)) continue;
    const graceEnds = Date.now() + cadence.graceMs;
    for (;;) {
      if (existsSync(exitCodePath)) return "exit-code";
      if (Date.now() >= graceEnds) return "pane-gone";
      await sleep(cadence.pollMs, release);
      if (release.aborted) return never();
    }
  }
}

// The caller's way out, kept off the caller's signal once the wait settles so
// a signal that outlives one attempt does not collect listeners.
function callerReleased(
  releaseSignal: AbortSignal | undefined,
  release: AbortSignal,
): Promise<PaneEnding> {
  return new Promise<PaneEnding>((resolve) => {
    if (!releaseSignal) return;
    const onAbort = (): void => resolve("released");
    releaseSignal.addEventListener("abort", onAbort, { once: true });
    release.addEventListener(
      "abort",
      () => releaseSignal.removeEventListener("abort", onAbort),
      { once: true },
    );
  });
}

// A sleep whose timer dies with the race, so the loser leaves nothing ticking.
// A signal that is already aborted schedules no timer at all: `abort` fires
// once and never again, so a listener added afterwards would never run and the
// timer would burn its full cadence after the ending was already recorded.
function sleep(ms: number, release: AbortSignal): Promise<void> {
  if (release.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      release.removeEventListener("abort", done);
      resolve();
    }
    release.addEventListener("abort", done, { once: true });
  });
}

// An observation that has withdrawn: it never settles the race, and it is
// collected with the race once some other observation wins.
function never(): Promise<never> {
  return new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Exit codes and crash reasons
// ---------------------------------------------------------------------------

// No exit code ever arrived: the wrapper's file was missing or unparseable
// after every retry. A shell exit status is 0-255, so a negative can never
// collide with a real one, which is what makes it usable as the signal.
export const EXIT_CODE_UNREADABLE = -1;

// The pane left herdr's listing and the race's grace window passed with no
// file behind it: the attempt is over and its exit status is not recoverable
// from anywhere. Its own value for the same reason as EXIT_CODE_UNREADABLE,
// and distinct from it because the two want different words: nothing here is
// the wrapper's doing.
export const EXIT_CODE_PANE_GONE = -2;

// The engine's own negative "exit codes" for a botched interactive spawn,
// mapped to human reasons by exitCrashReason. They are deliberately not
// codes a harness can exit with, and stay clear of EXIT_CODE_UNREADABLE and
// EXIT_CODE_PANE_GONE, the race's own sentinels. Produced by the Attempt-run
// module's prompt delivery, which is the launch half, not an ending.
export const SPAWN_INTERACTIVE_READY_FAILED = -3;
export const SPAWN_INTERACTIVE_PROMPT_FAILED = -4;

// The crash reason for a non-zero exit, whose causes want different words. A
// real code came from the harness; EXIT_CODE_UNREADABLE means the harness's
// fate is unknown and the pane wrapper is the thing to look at;
// EXIT_CODE_PANE_GONE means the pane itself went away, which is neither of
// their faults and is why it names the pane instead; the SPAWN_INTERACTIVE
// codes are the engine's own botched interactive spawn, where the harness
// never ran at all. The distinction is worth a helper: an unparseable file
// reported itself as `exited 1` on attempts that had in fact succeeded, and
// read as a harness fault until the file itself was inspected (ADR-0014's
// amendment). `paneId` is not optional so that a new crash site has to say
// whether it has a pane at all; a headless attempt has none and can never
// end this way.
export function exitCrashReason(
  code: number,
  exitCodePath: string,
  subject: string,
  paneId: string | null,
): string {
  if (code === SPAWN_INTERACTIVE_READY_FAILED) {
    return "TUI never became ready";
  }
  if (code === SPAWN_INTERACTIVE_PROMPT_FAILED) {
    return "prompt never landed";
  }
  if (code === EXIT_CODE_UNREADABLE) {
    return (
      `${subject} exit code unreadable: the pane wrapper never wrote a ` +
      `usable ${exitCodePath}`
    );
  }
  if (code === EXIT_CODE_PANE_GONE) {
    return (
      `${subject} pane gone: ${paneId ?? "the pane"} left herdr's listing ` +
      `and no exit code was written to ${exitCodePath}`
    );
  }
  return `${subject} exited ${code}`;
}

// The crash reason for an attempt's non-zero exit, naming a shutdown stop
// as what it was (ADR-0017): a headless child the engine stopped exits on
// the signal, and "exited 143" would read as the harness's own failure.
// Terminal-backed attempts are never stopped, and the negative sentinels
// are the engine's own codes, so both keep the ordinary reason. The tracker
// is optional: only a fresh headless attempt has one, and `stopping` is
// read here, after the wait has resolved, not at the call site.
export function attemptCrashReason(
  children: ChildTracker | undefined,
  code: number,
  exitCodePath: string,
  subject: string,
  paneId: string | null,
): string {
  if (children?.stopping && paneId === null && code > 0) {
    return `${subject} stopped by engine shutdown (exited ${code})`;
  }
  return exitCrashReason(code, exitCodePath, subject, paneId);
}

// How the pool log names the ending in passing, where the line is about the
// marker and the code is one clause of it. A real code is the shell's own
// status and reads as one; a sentinel is not a status at all, so it says what
// happened instead of printing a number no shell produced. Templating it
// unconditionally put `exited -2` on the same line as a crash reason whose
// whole purpose is to report that no exit status was ever observed, which
// described one attempt two contradictory ways in a single breath.
export function exitedPhrase(code: number): string {
  if (code === EXIT_CODE_UNREADABLE) return "ended with no exit code";
  if (code === EXIT_CODE_PANE_GONE) return "ended with its pane gone";
  if (code === SPAWN_INTERACTIVE_READY_FAILED) {
    return "ended before its TUI became ready";
  }
  if (code === SPAWN_INTERACTIVE_PROMPT_FAILED) {
    return "ended before its prompt landed";
  }
  return `exited ${code}`;
}

// Read the wrapper-written exit code, retrying briefly for a reaping race,
// and translating a missing or malformed file into EXIT_CODE_UNREADABLE: the
// attempt still ended (pane killed, daemon lost) and the crash path is the
// right ending, but it says which happened. Also the launch half's read when
// a harness exited before its TUI came up (the Attempt-run module's prompt
// delivery), the one non-ending caller.
export async function readExitCode(path: string): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (Number.isFinite(parsed)) return parsed;
    } catch {
      // not there yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return EXIT_CODE_UNREADABLE;
}
