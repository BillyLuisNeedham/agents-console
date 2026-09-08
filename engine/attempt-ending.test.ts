import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAttemptEnding, type EndingCadence } from "./attempt-ending.ts";
import {
  startFakeHerdr,
  stopFakeHerdrs,
  until,
  type FakeHerdr,
  type FakePane,
} from "./herdr-fake.ts";

const runDirs: string[] = [];

afterEach(async () => {
  await stopFakeHerdrs();
  while (runDirs.length > 0) {
    rmSync(runDirs.pop()!, { recursive: true, force: true });
  }
});

// The attempt's pane, live in the daemon's listing until a test says
// otherwise.
const LIVE_PANE: FakePane = { tab_id: "tab-1", pane_id: "pane-1" };

// The real cadences are 250ms, 30s and 10s; the same waits in milliseconds
// here, so a test that has to outlast a liveness sweep and a grace window
// still finishes in a blink.
const QUICK: EndingCadence = { pollMs: 5, livenessMs: 10, graceMs: 30 };

// Where the pane wrapper would write its exit code.
function exitCodePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "attempt-ending-"));
  runDirs.push(dir);
  return join(dir, "01.exitcode");
}

// How many times the wait has asked the daemon for its pane listing.
function sweeps(fake: FakeHerdr): number {
  return fake.requests.filter((r) => r.method === "pane.list").length;
}

// The wait has a subscription up and has been past the daemon at least once,
// so from here only what the test does next can end it.
async function watching(fake: FakeHerdr): Promise<void> {
  await until("the subscriber connect", () => fake.subscribers === 1);
  await until("the liveness check", () =>
    fake.requests.some((r) => r.method === "pane.list"),
  );
}

describe("waitForAttemptEnding", () => {
  it("ends on the pane's own end, without waiting on a file", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await watching(fake);
    // No file is ever written here: an operator who closes a tab, or a pane
    // the host kills, produces exactly this and nothing else, which is why
    // the file cannot be the primary observation.
    fake.pushEvent("pane_exited", { pane_id: "pane-1" });
    expect(await ending).toBe("pane-end");
  });

  it("ends on the exit-code file while the subscription is healthy and silent", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await watching(fake);
    // The daemon says nothing and stays connected: a subscription that is
    // healthy as far as anyone can tell is still not evidence the attempt is
    // running, and the file is evidence that it is not.
    writeFileSync(path, "0\n");
    expect(await ending).toBe("exit-code");
    // The subscription lost the race, so it is gone: one dead connection per
    // attempt is what a pool measured in days cannot afford.
    await until("the subscriber go", () => fake.subscribers === 0);
  });

  it("ends on the exit-code file after the daemon hangs up on the subscriber", async () => {
    // Ticket 19 of the run-digest pool, end to end. The daemon dropped the
    // subscription with a plain FIN, the attempt finished and wrote `0`, and
    // the engine waited two hours over a card that read `running`.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await watching(fake);
    fake.hangUpSubscribers();
    writeFileSync(path, "0\n");
    expect(await ending).toBe("exit-code");
  });

  it("ends as a crash when the pane is gone and no file follows it", async () => {
    // Both observations failed at once: no event arrived and no file was ever
    // written. The pane leaving the daemon's listing is the only thing left
    // that can say so, and a wait that cannot say so parks instead.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      exitCodePath(),
      undefined,
      QUICK,
    );
    await watching(fake);
    fake.removePane("pane-1");
    expect(await ending).toBe("pane-gone");
  });

  it("records the real exit code when the file lands inside the grace window", async () => {
    // The daemon reaps the pane just ahead of the wrapper's final write, which
    // is the ordering the exit-code read's own retry already assumes. Settling
    // the moment the pane leaves the listing would call this attempt a crash
    // and throw away the exit code it was in the middle of writing.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      // A grace window with room to spare, so the file can land well after
      // the sweep has seen the pane go and still be inside the window on a
      // loaded machine. Nothing waits it out: the wait settles the moment the
      // file appears, so the window's size costs the test nothing.
      { pollMs: 5, livenessMs: 10, graceMs: 5_000 },
    );
    await watching(fake);
    const before = sweeps(fake);
    fake.removePane("pane-1");
    // Only once a sweep has answered without the pane is the wait inside its
    // grace window; writing the file before that would prove nothing.
    await until("a sweep without the pane", () => sweeps(fake) > before);
    writeFileSync(path, "7\n");
    expect(await ending).toBe("exit-code");
  });

  it("leaves a healthy long attempt waiting however many sweeps pass", async () => {
    // The liveness sweep is what stands in for a deadline, so it must never
    // become one: a real review attempt runs for ninety-eight minutes with its
    // pane listed and nothing else to show, and every sweep must simply look
    // and say nothing.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await until("several sweeps", () => sweeps(fake) >= 5);
    // Five sweeps in, with the pane still listed, the wait is still waiting.
    const stillWaiting = await Promise.race([
      ending,
      new Promise<"waiting">((resolve) =>
        setTimeout(() => resolve("waiting"), QUICK.livenessMs * 4),
      ),
    ]);
    expect(stillWaiting).toBe("waiting");
    // And it is still the wait it was: the attempt's own ending still ends it.
    writeFileSync(path, "0\n");
    expect(await ending).toBe("exit-code");
  });

  it("rides out a daemon that cannot answer for the pane at all", async () => {
    // A listing the daemon errors on says nothing about the pane, so it must
    // never be read as the pane being gone: that would crash a live attempt on
    // the strength of an unreachable socket.
    const fake = await startFakeHerdr({
      foreignPanes: [LIVE_PANE],
      fail: { "pane.list": { code: -1, message: "no listing today" } },
    });
    const path = exitCodePath();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await until("the subscriber connect", () => fake.subscribers === 1);
    await until(
      "the listing refused twice",
      () => fake.requests.filter((r) => r.method === "pane.list").length >= 2,
    );
    writeFileSync(path, "0\n");
    expect(await ending).toBe("exit-code");
  });

  it("ends immediately on a file that is already there", async () => {
    // The boot-time adopted attempt that finished while the engine was down:
    // the wrapper writes the file before its shell exits, and the previous
    // attempt's file is removed before a wrapper is sent, so a file present
    // now can only be this attempt's.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    writeFileSync(path, "0\n");
    expect(
      await waitForAttemptEnding(
        fake.socketPath,
        "pane-1",
        path,
        undefined,
        QUICK,
      ),
    ).toBe("exit-code");
    // It never went near the daemon, so there was nothing to wait on.
    expect(fake.subscribers).toBe(0);
  });

  it("ends when the caller releases it", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const release = new AbortController();
    const ending = waitForAttemptEnding(
      fake.socketPath,
      "pane-1",
      exitCodePath(),
      release.signal,
      QUICK,
    );
    await watching(fake);
    release.abort();
    expect(await ending).toBe("released");
    await until("the subscriber go", () => fake.subscribers === 0);
  });
});
