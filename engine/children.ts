/**
 * The engine's headless children (ADR-0017): every harness spawnToLog runs
 * headless is tracked here from spawn to exit, so a shutdown can stop them
 * all, and the liveness checks boot reconciliation uses to tell an orphan
 * from a previous engine process apart from a reused pid.
 *
 * Each child runs in its own process group (Bun's `detached`, a setsid), so
 * one signal to the group reaches the harness and everything it forked: a
 * harness's tool calls run as grandchildren, and a kill that reached only
 * the harness would leave those behind exactly as the untrapped SIGTERM did.
 */

import { readlinkSync, realpathSync } from "node:fs";

/** How long a stopped child gets to exit on TERM before KILL follows. */
export const CHILD_STOP_GRACE_MS = 5_000;

/** The poll cadence while waiting on a process that is not our child. */
const ORPHAN_POLL_MS = 50;

interface TrackedChild {
  pid: number;
  exited: Promise<unknown>;
}

export class ChildTracker {
  private readonly live = new Set<TrackedChild>();
  /**
   * True once a shutdown has begun. A child that lands after this is stopped
   * on arrival, so a super-step mid-spawn cannot fork past the shutdown.
   */
  stopping = false;

  /** Register a spawned child; it drops off when its exit promise settles. */
  track(child: TrackedChild): void {
    this.live.add(child);
    void child.exited.then(
      () => this.live.delete(child),
      () => this.live.delete(child),
    );
    if (this.stopping) signalGroup(child.pid, "SIGTERM");
  }

  get size(): number {
    return this.live.size;
  }

  get pids(): number[] {
    return [...this.live].map((child) => child.pid);
  }

  /**
   * Stop every tracked child: TERM to each group, wait up to the grace for
   * all to exit, then KILL whatever remains and wait for those. Resolves once
   * every child tracked at the call has exited (or a KILL was sent to each
   * survivor and its exit observed).
   */
  async stopAll(graceMs = CHILD_STOP_GRACE_MS): Promise<void> {
    this.stopping = true;
    const children = [...this.live];
    if (children.length === 0) return;
    for (const child of children) signalGroup(child.pid, "SIGTERM");
    const allExited = Promise.all(children.map((child) => child.exited.catch(() => {})));
    const onTime = await Promise.race([
      allExited.then(() => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    if (onTime) return;
    for (const child of this.live) signalGroup(child.pid, "SIGKILL");
    await allExited;
  }
}

/** Signal a whole process group; a group already gone is not an error. */
export function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    // A group we cannot signal (EPERM) or a pid that never led one: fall
    // back to the process itself, so a harness that changed its own group
    // still receives the stop.
    try {
      process.kill(pid, signal);
    } catch {
      // gone, or not ours to signal
    }
  }
}

/** Whether a pid names a live process. EPERM means alive but not ours. */
export function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The working directory of a live process, or null when the platform cannot
 * say (no procfs) or the process is gone or not ours to read.
 */
export function processCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Whether a pid recorded on an attempt's spawned event is that attempt's
 * harness still running: live, and working in the attempt's worktree. A live
 * pid whose cwd is elsewhere is a reused pid, not an orphan; one whose cwd
 * cannot be read (no procfs) is trusted on liveness alone, the same bet the
 * pool lock makes on `server.pid`.
 */
export function orphanIsLive(pid: number, cwd: string): boolean {
  if (!processIsLive(pid)) return false;
  const actual = processCwd(pid);
  if (actual === null) return true;
  let expected = cwd;
  try {
    expected = realpathSync(cwd);
  } catch {
    // The worktree itself is gone: nothing running there is ours.
    return false;
  }
  return actual === expected;
}

/**
 * Stop an orphan that is not our child: TERM to its group, poll liveness up
 * to the grace, then KILL and poll once more. Resolves true once the pid is
 * gone, false if it survived even the KILL (not ours to signal).
 */
export async function stopOrphan(
  pid: number,
  graceMs = CHILD_STOP_GRACE_MS,
): Promise<boolean> {
  signalGroup(pid, "SIGTERM");
  if (await goneWithin(pid, graceMs)) return true;
  signalGroup(pid, "SIGKILL");
  return goneWithin(pid, graceMs);
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (processIsLive(pid)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(ORPHAN_POLL_MS);
  }
  return true;
}
