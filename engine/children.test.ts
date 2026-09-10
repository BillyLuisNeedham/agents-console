import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChildTracker,
  orphanIsLive,
  processIsLive,
  stopOrphan,
} from "./children.ts";

function sleeper(cwd: string, script = "sleep 60 & wait") {
  return Bun.spawn(["bash", "-c", script], {
    cwd,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

// A child that ignores TERM, and says so once its trap is armed: a TERM
// that lands before the trap would end it politely and prove nothing.
function stubbornSleeper(): { proc: ReturnType<typeof sleeper>; ready: Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "stubborn-"));
  const marker = join(dir, "armed");
  const proc = sleeper(
    process.cwd(),
    `trap '' TERM; : > "${marker}"; while :; do sleep 1; done`,
  );
  const ready = eventually(() => existsSync(marker)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
  return { proc, ready };
}

async function eventually(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error("eventually: timed out");
    await Bun.sleep(25);
  }
}

describe("ChildTracker", () => {
  it("stopAll terminates every tracked group and drops them as they exit", async () => {
    const tracker = new ChildTracker();
    const a = sleeper(process.cwd());
    const b = sleeper(process.cwd());
    tracker.track({ pid: a.pid, exited: a.exited });
    tracker.track({ pid: b.pid, exited: b.exited });
    expect(tracker.size).toBe(2);

    await tracker.stopAll(1_000);

    expect(await a.exited).toBe(143);
    expect(await b.exited).toBe(143);
    expect(tracker.size).toBe(0);
    expect(tracker.stopping).toBe(true);
  });

  it("stopAll falls through to KILL when a child ignores TERM", async () => {
    const tracker = new ChildTracker();
    const { proc: stubborn, ready } = stubbornSleeper();
    await ready;
    tracker.track({ pid: stubborn.pid, exited: stubborn.exited });

    const started = Date.now();
    await tracker.stopAll(300);

    expect(await stubborn.exited).toBe(137);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(processIsLive(stubborn.pid)).toBe(false);
  });

  it("a child tracked after stopping began is stopped on arrival", async () => {
    const tracker = new ChildTracker();
    await tracker.stopAll(100);
    const late = sleeper(process.cwd());
    tracker.track({ pid: late.pid, exited: late.exited });
    expect(await late.exited).toBe(143);
  });
});

describe("orphan liveness", () => {
  it("is live only when the pid is alive and working in the recorded cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orphan-"));
    try {
      const wt = join(dir, "wt");
      mkdirSync(wt);
      const orphan = sleeper(wt);
      try {
        expect(orphanIsLive(orphan.pid, wt)).toBe(true);
        // Alive elsewhere: a reused pid, never an orphan of this worktree.
        expect(orphanIsLive(orphan.pid, dir)).toBe(false);
        expect(orphanIsLive(process.pid, wt)).toBe(false);
        // A worktree that no longer exists has nothing of ours in it.
        expect(orphanIsLive(orphan.pid, join(dir, "gone"))).toBe(false);
      } finally {
        process.kill(-orphan.pid, "SIGKILL");
        await orphan.exited;
      }
      expect(orphanIsLive(orphan.pid, wt)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopOrphan stops a group that is not our child, TERM first, KILL when ignored", async () => {
    const polite = sleeper(process.cwd());
    expect(await stopOrphan(polite.pid, 1_000)).toBe(true);
    await eventually(() => !processIsLive(polite.pid));

    const { proc: stubborn, ready } = stubbornSleeper();
    await ready;
    expect(await stopOrphan(stubborn.pid, 300)).toBe(true);
    expect(processIsLive(stubborn.pid)).toBe(false);
    expect(await stubborn.exited).toBe(137);
  });
});
