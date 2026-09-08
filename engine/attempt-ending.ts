/**
 * The **Attempt ending** for a terminal-backed attempt (ADR-0014, fifth
 * amendment): the one place that decides an attempt is over.
 *
 * Two observations say so, and they are raced rather than ranked, because
 * each is blind to what the other sees. herdr's pane end is prompt and covers
 * an attempt that never wrote anything (an operator who closed the tab, a
 * pane the host killed), but it travels down a subscription the daemon can
 * drop without saying so. The exit-code file the pane wrapper writes before
 * its shell exits covers exactly that, because it does not depend on the
 * daemon at all, but it never appears for a pane that was killed. Ranking
 * them either way leaves a single point of failure: subscription-first is
 * what parked a finished 98-minute attempt for two hours with a `0` sitting
 * on disk the whole time, and file-first would park on the closed tab.
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

import { existsSync } from "node:fs";
import { listPaneIds, waitForPaneEnd } from "./herdr.ts";

/**
 * How an attempt's ending was observed.
 * - "pane-end": herdr reported the pane exited or closed.
 * - "exit-code": the wrapper's exit-code file appeared, whatever the daemon
 *   was doing at the time.
 * - "pane-gone": the pane left herdr's listing and no exit-code file followed
 *   it within the grace window. The attempt is over and its exit code is
 *   unreadable; the caller's existing crash path is the right ending.
 * - "released": the caller released the wait before either observation
 *   landed. Not an ending of the attempt, an ending of the watching.
 */
export type AttemptEnding =
  | "pane-end"
  | "exit-code"
  | "pane-gone"
  | "released";

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
 * Wait for the attempt in `paneId` to end, and say how that was observed.
 *
 * An exit-code file already on disk ends it immediately, without opening a
 * connection at all: the wrapper writes that file before its shell exits, and
 * a previous attempt's file is removed before a wrapper is ever sent, so its
 * presence can only mean this attempt has finished. That is the boot-time
 * adopted-attempt fast path, and it costs nothing to give it to every caller.
 *
 * Otherwise all three observations run together and the first one home wins.
 * A lost subscription is not an ending: it says only that herdr has stopped
 * talking, and the other two carry the wait from there, which is precisely
 * the case this exists for. The wait is never re-subscribed, and it is never
 * bounded by the clock.
 *
 * Whichever observations lose are released here, as the wait settles, so a
 * pool that runs for days leaks neither a subscription nor a timer per
 * attempt. `releaseSignal` is the caller's own way out, for a caller that has
 * given up on the attempt or found its ending elsewhere; the two are
 * independent on purpose, so neither the caller nor this module depends on
 * the other remembering.
 */
export async function waitForAttemptEnding(
  socketPath: string,
  paneId: string,
  exitCodePath: string,
  releaseSignal?: AbortSignal,
  cadence: EndingCadence = DEFAULT_CADENCE,
): Promise<AttemptEnding> {
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
): Promise<AttemptEnding> {
  const end = await waitForPaneEnd(socketPath, paneId, release);
  if (end === "lost") return never();
  return "pane-end";
}

// The observation that does not depend on the daemon.
async function exitCodeFileAppeared(
  exitCodePath: string,
  cadence: EndingCadence,
  release: AbortSignal,
): Promise<AttemptEnding> {
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
): Promise<AttemptEnding> {
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
): Promise<AttemptEnding> {
  return new Promise<AttemptEnding>((resolve) => {
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
