import { afterEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exitCrashReason,
  exitedPhrase,
  waitForAttemptEnding,
  waitForPaneEnding,
  type EndingCadence,
  type ReadFailure,
} from "./attempt-ending.ts";
import { ChildTracker } from "./children.ts";
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

describe("waitForPaneEnding", () => {
  it("ends on the pane's own end, without waiting on a file", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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

  it("stays waiting after hang-up while the pane is still listed and no file appears", async () => {
    // A FIN settles the pane-end wait as lost. Lost is not an attempt ending:
    // the pane can still be running, and ranking the hang-up as done is what
    // parked a wait that then never looked at the file. This row is hang-up
    // with the pane still listed and no file yet, which must park until one
    // of the other observations arrives.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const path = exitCodePath();
    const ending = waitForPaneEnding(
      fake.socketPath,
      "pane-1",
      path,
      undefined,
      QUICK,
    );
    await watching(fake);
    const before = sweeps(fake);
    fake.hangUpSubscribers();
    await until("several sweeps after hang-up", () => sweeps(fake) >= before + 5);
    const stillWaiting = await Promise.race([
      ending,
      new Promise<"waiting">((resolve) =>
        setTimeout(() => resolve("waiting"), QUICK.livenessMs * 4),
      ),
    ]);
    expect(stillWaiting).toBe("waiting");
    writeFileSync(path, "0\n");
    expect(await ending).toBe("exit-code");
  });

  it("ends as a crash when the pane is gone and no file follows it", async () => {
    // Both observations failed at once: no event arrived and no file was ever
    // written. The pane leaving the daemon's listing is the only thing left
    // that can say so, and a wait that cannot say so parks instead.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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
      await waitForPaneEnding(
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
    const ending = waitForPaneEnding(
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

// ---------------------------------------------------------------------------
// The one ending decision: the headless adapter and the adopted fast path.
// Neither needs a daemon at all: the headless watch is the child's own exit,
// and an exit-code file already on disk decides before a connection opens.
// ---------------------------------------------------------------------------

// A site's validator, in miniature: the module takes any site's, so these
// tests drive their own rather than pulling the engine's Outcome one in.
type TestResult = { ok: true; status: string };

function validateTestResult(parsed: unknown): TestResult | ReadFailure {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { status?: unknown }).status === "done"
  ) {
    return { ok: true, status: "done" };
  }
  return { ok: false, reason: "status was not done" };
}

// The attempt's two files in one fresh runs directory.
function attemptPaths(): { exitCodePath: string; outcomePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "attempt-ending-"));
  runDirs.push(dir);
  return {
    exitCodePath: join(dir, "01.exitcode"),
    outcomePath: join(dir, "01.outcome.json"),
  };
}

describe("waitForAttemptEnding with a headless watch", () => {
  it("ends on the child's exit and reads the result after", async () => {
    const paths = attemptPaths();
    writeFileSync(paths.outcomePath, JSON.stringify({ status: "done" }));
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "headless", exit: Promise.resolve(0) },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
    });
    expect(decision).toEqual({
      ending: "child-exit",
      code: 0,
      result: { ok: true, status: "done" },
      crashReason: null,
    });
  });

  it("carries the child's own code and names the harness on a crash", async () => {
    const paths = attemptPaths();
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "headless", exit: Promise.resolve(3) },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
    });
    expect(decision.ending).toBe("child-exit");
    expect(decision.code).toBe(3);
    expect(decision.result).toEqual({ ok: false, reason: "no outcome written" });
    expect(decision.crashReason).toBe("harness exited 3");
  });

  it("reads a clean exit with no result as the missing-outcome crash", async () => {
    const paths = attemptPaths();
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "headless", exit: Promise.resolve(0) },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
    });
    expect(decision.code).toBe(0);
    expect(decision.crashReason).toBe("no outcome written");
  });

  it("names a shutdown stop as what it was, not as the harness's failure", async () => {
    // ADR-0017: a headless child the engine stopped exits on the signal, and
    // "exited 143" would read as the harness's own failure. The tracker's
    // flag is read after the wait resolves, so setting it before the child
    // settles is the honest ordering here.
    const paths = attemptPaths();
    const tracker = new ChildTracker();
    tracker.stopping = true;
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "headless", exit: Promise.resolve(143) },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
      tracker,
    });
    expect(decision.crashReason).toBe(
      "harness stopped by engine shutdown (exited 143)",
    );
  });
});

describe("waitForAttemptEnding's boot fast path", () => {
  // The adopted attempt's pane watch with the exit-code file already on
  // disk: the wrapper wrote it before its shell exited and the previous
  // attempt's file is removed before a wrapper is ever sent, so it can only
  // be this attempt's. The socket path connects to nothing; the decision
  // must never go near it.
  const DEAD_SOCKET = join(tmpdir(), "attempt-ending-no-such-daemon.sock");

  it("decides on the exit-code file already on disk, without a daemon", async () => {
    const paths = attemptPaths();
    writeFileSync(paths.exitCodePath, "7\n");
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "pane", socketPath: DEAD_SOCKET, paneId: "pane-1" },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
    });
    expect(decision.ending).toBe("exit-code");
    expect(decision.code).toBe(7);
    expect(decision.result).toEqual({ ok: false, reason: "no outcome written" });
    expect(decision.crashReason).toBe("harness exited 7");
  });

  it("reads an outcome written while the engine was down as the clean ending", async () => {
    const paths = attemptPaths();
    writeFileSync(paths.exitCodePath, "0\n");
    writeFileSync(paths.outcomePath, JSON.stringify({ status: "done" }));
    const decision = await waitForAttemptEnding<TestResult>({
      watch: { kind: "pane", socketPath: DEAD_SOCKET, paneId: "pane-1" },
      ...paths,
      validate: validateTestResult,
      crashSubject: "harness",
    });
    expect(decision).toEqual({
      ending: "outcome",
      code: 0,
      result: { ok: true, status: "done" },
      crashReason: null,
    });
  });
});

// The three causes of a non-zero exit read differently on purpose: a real code
// blames the harness, an unreadable one points at the pane wrapper, and a pane
// that left herdr's listing blames neither. Conflating the first two once
// reported successful attempts as `harness exited 1` (ADR-0014).
describe("exitCrashReason", () => {
  test("names the harness and its code for a real exit", () => {
    expect(exitCrashReason(3, "/runs/17.exitcode", "harness", null)).toBe(
      "harness exited 3",
    );
  });

  test("carries the subject through, so a resolver reads as one", () => {
    expect(exitCrashReason(2, "/runs/17.exitcode", "resolver", null)).toBe(
      "resolver exited 2",
    );
  });

  test("points at the unwritten file when no code arrived", () => {
    const reason = exitCrashReason(-1, "/runs/17.exitcode", "harness", null);
    expect(reason).toContain("exit code unreadable");
    expect(reason).toContain("/runs/17.exitcode");
    expect(reason).not.toContain("exited -1");
  });

  // The pane left herdr's listing and the grace window passed with no file:
  // the attempt is over and nothing it did is knowable. Reporting that as the
  // wrapper's fault reads as a harness fault, which is what sent an operator
  // looking at a harness that had never run.
  test("names the pane and the unwritten file when the pane is gone", () => {
    const reason = exitCrashReason(
      -2,
      "/runs/17.exitcode",
      "harness",
      "pane-4",
    );
    expect(reason).toContain("pane-4");
    expect(reason).toContain("/runs/17.exitcode");
    expect(reason).not.toContain("exited -2");
    // The two words that would blame something that never got the chance.
    expect(reason).not.toContain("harness exited");
    expect(reason).not.toContain("wrapper never wrote");
  });
});

// The pool log has to name the ending in passing, on the same line as the
// marker and the crash reason. Templating the number unconditionally put
// `exited -2` immediately beside a reason whose whole job is to say no exit
// status was ever observed, so one attempt read two contradictory ways on
// consecutive lines.
describe("exitedPhrase", () => {
  test("reads as the shell's own status for a real exit", () => {
    expect(exitedPhrase(3)).toBe("exited 3");
    expect(exitedPhrase(0)).toBe("exited 0");
  });

  test("says no code arrived rather than printing the sentinel", () => {
    expect(exitedPhrase(-1)).toBe("ended with no exit code");
    expect(exitedPhrase(-1)).not.toContain("-1");
  });

  test("says the pane went away rather than printing the sentinel", () => {
    expect(exitedPhrase(-2)).toBe("ended with its pane gone");
    expect(exitedPhrase(-2)).not.toContain("-2");
  });

  // Both halves of a log line come from here: the phrase and the reason it
  // sits beside must agree about whether a status was ever seen.
  test("agrees with the crash reason it sits beside", () => {
    for (const code of [-1, -2]) {
      const reason = exitCrashReason(
        code,
        "/runs/17.exitcode",
        "harness",
        "pane-4",
      );
      expect(`${exitedPhrase(code)}, crash: ${reason}`).not.toContain(
        `exited ${code}`,
      );
    }
  });
});
