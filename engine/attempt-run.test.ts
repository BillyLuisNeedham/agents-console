import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_TRIES,
  PANE_FRAME_LOG_HEADING,
  awaitAttempt,
  launchAttempt,
  readAttemptResult,
  runAttempt,
  type AttemptEnv,
  type AttemptSpec,
  type PoolWorkspace,
  type ReadFailure,
} from "./attempt-run.ts";
import { validateOutcome, type OutcomeResult } from "./engine.ts";
import { ChildTracker } from "./children.ts";
import { createLiveAttempts } from "./live-attempts.ts";
import { appendEvent, readEvents } from "./events.ts";
import {
  defaultHarnessDescriptors,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";
import { makeTempDir } from "./tmp.ts";
import { stubHarness } from "./pool-fixture.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
  type ExecutingFakeHerdrOptions,
} from "./herdr-executing-fake.ts";
import {
  startFakeHerdr as startProtocolFakeHerdr,
  stopFakeHerdrs,
} from "./herdr-fake.ts";

// The `script` invocation ADR-0016's wrapper opens with, in the form the
// host's script(1) accepts (issue #58): util-linux's `-c` string form on
// Linux, BSD's file-then-words form on macOS. The fake herdr runs the
// wrapper under the host's real script, so the suite runs on both.
const SCRIPT_RECORD_PREFIX =
  process.platform === "darwin" ? "script -eqF " : "script -eqfc ";

type ValidOutcome = Extract<OutcomeResult, { ok: true }>;

// The module is driven directly: a runs directory, an Issue file for the
// driver line to reference, and a child tracker. No pool, no drive loop.
interface Rig {
  dir: string;
  runsDir: string;
  issuePath: string;
  children: ChildTracker;
}

const rigs: Rig[] = [];
const fakes: ExecutingFakeHerdr[] = [];

function makeRig(): Rig {
  const dir = makeTempDir("attempt-run-");
  mkdirSync(join(dir, "runs"));
  mkdirSync(join(dir, "issues"));
  const issuePath = join(dir, "issues", "01-t.md");
  writeFileSync(
    issuePath,
    "<!-- state: id=01 blocked-by=none status=in-progress -->\n# 01: t\n",
  );
  const rig = { dir, runsDir: join(dir, "runs"), issuePath, children: new ChildTracker() };
  rigs.push(rig);
  return rig;
}

// Every fake here holds the pool's workspace (issue #94), because every
// attempt below is a terminal-backed one and a terminal-backed attempt only
// opens its tab inside a Pool workspace: POOL_WORKSPACE is the id the
// engine's own boot resolution would have handed the spawn.
const POOL_WORKSPACE = "w1";

async function startFakeHerdr(
  options?: ExecutingFakeHerdrOptions,
): Promise<ExecutingFakeHerdr> {
  const fake = await startExecutingFakeHerdr({
    workspaces: [POOL_WORKSPACE],
    ...options,
  });
  fakes.push(fake);
  return fake;
}

// The protocol-only fake, holding the same Pool workspace.
async function startProtocolFake(
  options?: Parameters<typeof startProtocolFakeHerdr>[0],
): Promise<Awaited<ReturnType<typeof startProtocolFakeHerdr>>> {
  return startProtocolFakeHerdr({
    workspaces: [{ workspace_id: POOL_WORKSPACE }],
    ...options,
  });
}

/**
 * The Pool workspace as the engine hands one to a spawn site: a resolved id,
 * and a re-resolve whose answer the test seeds (`next`), which is how the
 * "operator closed the workspace mid-run" retry is driven. `reresolves`
 * records the stale id each re-resolve was asked about, so a test can prove
 * both how many there were and that the caller named the id it tried. A
 * re-resolve asked about an id that is no longer the current one answers
 * with the current one, the way the engine's own does for a spawn that lost
 * the race to another's re-resolve.
 */
function testPoolWorkspace(options?: {
  id?: string | null;
  next?: string | null;
}): PoolWorkspace & { reresolves: string[] } {
  let current = options?.id === undefined ? POOL_WORKSPACE : options.id;
  const workspace = {
    reresolves: [] as string[],
    id: async () => current,
    reresolve: async (staleId: string) => {
      workspace.reresolves.push(staleId);
      if (staleId !== current) return current;
      current = options?.next ?? null;
      return current;
    },
  };
  return workspace;
}

afterEach(async () => {
  while (fakes.length > 0) await fakes.pop()!.close();
  await stopFakeHerdrs();
  while (rigs.length > 0) {
    rmSync(rigs.pop()!.dir, { recursive: true, force: true });
  }
});

function envFor(
  rig: Rig,
  harnesses: Record<string, HarnessCommand>,
  herdrSocket: string,
  terminalBacked = true,
  poolWorkspace: PoolWorkspace = testPoolWorkspace(),
): AttemptEnv {
  return {
    runsDir: rig.runsDir,
    harnesses,
    herdrSocket,
    poolWorkspace,
    children: rig.children,
    liveAttempts: createLiveAttempts(),
    terminalBacked,
    // The launch half in milliseconds: the fake's shell prompt is there at
    // once, and a wrapper that runs creates its Stream file within a tick.
    launchCadence: {
      settlePollMs: 10,
      settleConfirmations: 2,
      settleTimeoutMs: 1_000,
      landedTimeoutMs: 3_000,
      landedPollMs: 20,
      dialogSettleMs: 20,
      dialogKeyGapMs: 20,
      dialogConfirmMs: 20,
    },
  };
}

// A Ticket attempt's spec, the shape runTicket hands the module.
function ticketSpec(
  rig: Rig,
  harness: string,
  overrides: Partial<AttemptSpec<ValidOutcome>> = {},
): AttemptSpec<ValidOutcome> {
  return {
    id: "01",
    issuePath: rig.issuePath,
    title: "t",
    body: "Standing instructions: implement the ticket and write the Outcome.",
    driver: "implement",
    harness,
    model: "stub-model",
    cwd: rig.dir,
    branch: null,
    attempt: 1,
    naming: { attempt: null, resolver: false },
    rotate: "exited",
    fallback: "headless",
    prompt: { kind: "driver" },
    crashSubject: "harness",
    events: { kind: "full", exitedStatus: (result) => result.outcome.status },
    ...overrides,
  };
}

async function until(
  cond: () => boolean,
  what: string,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const doneOutcome = JSON.stringify({
  status: "done",
  summary: "interactive",
  commitSha: null,
});

// The command stub, harness-agnostic: optionally waits for a trigger file,
// prints an output line, writes the outcome, then optionally holds the pane
// open the way a real TUI stays alive after the agent declares done, and
// exits with `exitCode` (0 unless the test wants a harness that dies).
function harnessStub(
  dir: string,
  opts: {
    outcome?: string;
    hold?: boolean;
    waitFor?: string;
    output?: string;
    exitCode?: number;
  } = {},
): { stubPath: string; command: HarnessCommand } {
  const stubPath = join(dir, "tui-stub.sh");
  const waitFor = opts.waitFor ?? "";
  const output = opts.output ?? "";
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'outcome="$1"; wait_for="$2"; output="$3"',
      'if [ -n "$wait_for" ]; then',
      "  for _ in $(seq 1 200); do",
      '    [ -e "$wait_for" ] && break',
      "    sleep 0.05",
      "  done",
      "fi",
      ...(output !== "" ? [`printf '%s\\n' "$output"`] : []),
      ...(opts.outcome !== undefined
        ? [`printf '%s' '${opts.outcome}' > "$outcome"`]
        : []),
      ...(opts.hold ? ["sleep 30"] : []),
      `exit ${opts.exitCode ?? 0}`,
      "",
    ].join("\n"),
  );
  return {
    stubPath,
    command: (ctx: SpawnContext) => [
      "bash",
      stubPath,
      ctx.outcomePath,
      waitFor,
      output,
    ],
  };
}

describe("readAttemptResult", () => {
  it("shares the missing-file and unparseable preamble, then defers to the validator", () => {
    const rig = makeRig();
    const path = join(rig.runsDir, "01.outcome.json");
    expect(readAttemptResult(path, validateOutcome)).toEqual({
      ok: false,
      reason: "no outcome written",
    });
    writeFileSync(path, "{not json");
    expect(readAttemptResult(path, validateOutcome)).toEqual({
      ok: false,
      reason: "outcome is not parseable JSON",
    });
    writeFileSync(path, JSON.stringify({ status: "nope" }));
    expect(readAttemptResult(path, validateOutcome)).toEqual({
      ok: false,
      reason: "outcome's status is not done or checkpoint",
    });
    writeFileSync(path, JSON.stringify({ resolved: true, note: "kept both" }));
    const validateResolution = (
      parsed: unknown,
    ): { ok: true; resolved: boolean } | ReadFailure =>
      typeof (parsed as { resolved?: unknown })?.resolved === "boolean"
        ? { ok: true, resolved: (parsed as { resolved: boolean }).resolved }
        : { ok: false, reason: "no resolved boolean" };
    expect(readAttemptResult(path, validateResolution)).toEqual({
      ok: true,
      resolved: true,
    });
  });
});

describe("headless attempts", () => {
  it("records no pane facts and never touches the socket on a headless pool", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(
      rig,
      stub.harnesses,
      // Pointing at nothing: a headless pool must never touch the socket.
      join(rig.dir, "no-daemon.sock"),
      false,
    );

    const run = await runAttempt(env, ticketSpec(rig, "stub"), validateOutcome);

    expect(run.ok).toBe(true);
    expect(run.code).toBe(0);
    expect(run.paneId).toBeNull();
    const events = readEvents(rig.runsDir, "01");
    expect(events.map((e) => e.kind)).toEqual(["spawned", "exited"]);
    const spawned = events[0];
    expect(spawned.attempt).toBe(1);
    expect(spawned.payload.pane_id).toBeUndefined();
    expect(spawned.payload.terminal_error).toBeUndefined();
    expect(typeof spawned.payload.pid).toBe("number");
    expect(spawned.payload.cwd).toBe(rig.dir);
    expect(spawned.payload.branch).toBeNull();
    expect(events[1].payload).toEqual({
      code: 0,
      status: "done",
      logTail: run.logTail,
      outcomeExists: true,
    });
  }, 15000);

  it("records only the spawn when the spec says spawned-only", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false);

    const run = await runAttempt(
      env,
      ticketSpec(rig, "stub", { events: { kind: "spawned-only" } }),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    expect(readEvents(rig.runsDir, "01").map((e) => e.kind)).toEqual(["spawned"]);
  }, 15000);

  it("rotates the well-known log and Stream file to the last exited attempt's name before a re-run", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false);
    writeFileSync(join(rig.runsDir, "01.log"), "attempt one's log\n");
    writeFileSync(join(rig.runsDir, "01.stream.jsonl"), "attempt one's stream\n");
    appendEvent(rig.runsDir, "01", {
      at: "2026-09-12T00:00:00Z",
      attempt: 1,
      kind: "exited",
      payload: { code: 0, status: "done", logTail: [], outcomeExists: true },
    });

    const run = await runAttempt(env, ticketSpec(rig, "stub", { attempt: 2 }), validateOutcome);

    expect(run.ok).toBe(true);
    expect(readFileSync(join(rig.runsDir, "01.attempt-1.log"), "utf8")).toBe(
      "attempt one's log\n",
    );
    expect(
      readFileSync(join(rig.runsDir, "01.attempt-1.stream.jsonl"), "utf8"),
    ).toBe("attempt one's stream\n");
    expect(readFileSync(join(rig.runsDir, "01.log"), "utf8")).not.toContain(
      "attempt one's log",
    );
  }, 15000);

  it("names a verify candidate's files by attempt and rotates nothing", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false);
    writeFileSync(join(rig.runsDir, "01.log"), "the solo log stays put\n");

    const run = await runAttempt(
      env,
      ticketSpec(rig, "stub", {
        attempt: 3,
        naming: { attempt: 3, resolver: false },
        rotate: "none",
      }),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    expect(run.logPath).toBe(join(rig.runsDir, "01.attempt-3.log"));
    expect(run.outcomePath).toBe(join(rig.runsDir, "01.attempt-3.outcome.json"));
    expect(readFileSync(join(rig.runsDir, "01.log"), "utf8")).toBe(
      "the solo log stays put\n",
    );
  }, 15000);

  it("names the resolver's files with the resolver suffix, the result file included", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false);

    const run = await runAttempt(
      env,
      ticketSpec(rig, "stub", {
        naming: { attempt: null, resolver: true },
        rotate: "none",
        crashSubject: "resolver",
        events: { kind: "spawned-only" },
      }),
      validateOutcome,
    );

    expect(run.logPath).toBe(join(rig.runsDir, "01.resolver.log"));
    expect(run.outcomePath).toBe(join(rig.runsDir, "01.resolver.outcome.json"));
    expect(run.exitCodePath).toBe(join(rig.runsDir, "01.resolver.exitcode"));
    expect(existsSync(run.outcomePath)).toBe(true);
  }, 15000);

  it("names the crash reason's subject from the spec", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, { "01": { outcome: null, exitCode: 2 } });
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false);

    const run = await runAttempt(
      env,
      ticketSpec(rig, "stub", { crashSubject: "resolver", events: { kind: "spawned-only" } }),
      validateOutcome,
    );

    expect(run.ok).toBe(false);
    expect(run.crashReason).toBe("resolver exited 2");
  }, 15000);

  it("throws the pool config error for an assignment the harness table cannot serve", async () => {
    const rig = makeRig();
    const env = envFor(rig, {}, join(rig.dir, "no-daemon.sock"), false);
    await expect(
      runAttempt(env, ticketSpec(rig, "ghost"), validateOutcome),
    ).rejects.toThrow(/pool config: ticket 01 names unknown harness 'ghost'/);
    await expect(
      runAttempt(env, ticketSpec(rig, ""), validateOutcome),
    ).rejects.toThrow(/pool config: ticket 01 has no harness/);
  });
});

describe("the Pool workspace (issue #94)", () => {
  it("opens the attempt's tab inside the Pool workspace", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startFakeHerdr();

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    const created = fake.requests.filter((r) => r.method === "tab.create");
    expect(created).toHaveLength(1);
    expect(created[0].params).toEqual({
      label: "01 · t",
      focus: false,
      cwd: rig.dir,
      workspace_id: POOL_WORKSPACE,
    });
    // The pane came off the tab.create answer's root pane, so the tab is the
    // spawn's first call and no listing scan follows it: the only pane.list
    // in the run is the pane-end wait's own liveness check, which comes
    // after the wrapper and its prompt.
    const beforeWrapper = fake.requests.slice(
      0,
      fake.requests.findIndex((r) => r.method === "pane.send_input"),
    );
    // The shell-settle gate's pane reads (issue #102) sit between the tab
    // and the wrapper; the tab is the only other call.
    expect(
      beforeWrapper.map((r) => r.method).filter((m) => m !== "pane.read"),
    ).toEqual(["tab.create"]);
    expect(run.paneId).toBe(`${POOL_WORKSPACE}:p1`);
  }, 15000);

  it("re-resolves once and retries the tab when the workspace is gone", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    // The daemon holds the pool's new workspace and not the one the spawn
    // starts from: the operator closed that one mid-run.
    const fake = await startFakeHerdr();
    const workspace = testPoolWorkspace({ id: "w-gone", next: POOL_WORKSPACE });

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath, true, workspace),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    expect(workspace.reresolves).toEqual(["w-gone"]);
    // Two tab.creates, the second in the re-resolved workspace, and the
    // attempt kept its pane rather than falling back to headless.
    const created = fake.requests.filter((r) => r.method === "tab.create");
    expect(created.map((r) => r.params.workspace_id)).toEqual([
      "w-gone",
      POOL_WORKSPACE,
    ]);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBe(`${POOL_WORKSPACE}:p1`);
    expect(spawned.payload.terminal_error).toBeUndefined();
  }, 15000);

  it("falls back to headless when the re-resolve cannot find one either", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startFakeHerdr();
    const workspace = testPoolWorkspace({ id: "w-gone", next: null });

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath, true, workspace),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    expect(workspace.reresolves).toEqual(["w-gone"]);
    // One refused tab, no retry to make, and the refusal itself on the log.
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(1);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(String(spawned.payload.terminal_error)).toContain("no such workspace w-gone");
    expect(typeof spawned.payload.pid).toBe("number");
  }, 15000);

  it("never sends an unplaced tab.create when the pool has no Pool workspace", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startFakeHerdr();
    const workspace = testPoolWorkspace({ id: null });

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath, true, workspace),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    // A tab with no workspace would land wherever the daemon's focus
    // happens to be, which is the scattering this pool's workspace exists
    // to stop: the attempt runs headless instead, and says so.
    expect(fake.requests.some((r) => r.method === "tab.create")).toBe(false);
    expect(workspace.reresolves).toEqual([]);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(String(spawned.payload.terminal_error)).toContain("no Pool workspace");
  }, 15000);
});

describe("the headless fallbacks (ADR-0014)", () => {
  it("falls back to headless with the error on the spawned event when the daemon is absent", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const env = envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"));

    const run = await runAttempt(env, ticketSpec(rig, "stub"), validateOutcome);

    expect(run.ok).toBe(true);
    expect(run.paneId).toBeNull();
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(spawned.payload.tab_id).toBeNull();
    expect(typeof spawned.payload.terminal_error).toBe("string");
    expect(typeof spawned.payload.pid).toBe("number");
  }, 15000);

  it("falls back to headless when the tab cannot be opened", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startProtocolFake({
      fail: { "tab.create": { code: 7, message: "no workspace" } },
    });
    const env = envFor(rig, stub.harnesses, fake.socketPath);

    const run = await runAttempt(env, ticketSpec(rig, "stub"), validateOutcome);

    expect(run.ok).toBe(true);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(spawned.payload.tab_id).toBeNull();
    expect(String(spawned.payload.terminal_error)).toContain("tab.create failed");
    expect(String(spawned.payload.terminal_error)).toContain("no workspace");
    expect(typeof spawned.payload.pid).toBe("number");
  }, 15000);

  it("falls back to headless when the wrapper cannot be sent, closing the half-started pane", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startProtocolFake({
      fail: { "pane.send_input": { code: 9, message: "pane refused input" } },
    });
    const env = envFor(rig, stub.harnesses, fake.socketPath);

    const run = await runAttempt(env, ticketSpec(rig, "stub"), validateOutcome);

    expect(run.ok).toBe(true);
    // The tab opened with its root pane, then the send failed: the event
    // must never point at the dead pane the fallback closed.
    expect(fake.requests.some((r) => r.method === "tab.create")).toBe(true);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(spawned.payload.tab_id).toBeNull();
    expect(String(spawned.payload.terminal_error)).toContain("pane refused input");
    expect(typeof spawned.payload.pid).toBe("number");
    await until(
      () => fake.requests.some((r) => r.method === "pane.close"),
      "the half-started pane's close",
    );
    expect(
      fake.requests.find((r) => r.method === "pane.close")!.params.pane_id,
    ).toBe("w1:p1");
  }, 15000);

  it("fails the launch instead of falling back when the spec forbids it", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const noTab = await startProtocolFake({
      fail: { "tab.create": { code: 7, message: "no workspace" } },
    });
    await expect(
      launchAttempt(
        envFor(rig, stub.harnesses, noTab.socketPath),
        ticketSpec(rig, "stub", { fallback: "none" }),
      ),
    ).rejects.toThrow(/^could not open a herdr tab: tab\.create failed/);
    const noSend = await startProtocolFake({
      fail: { "pane.send_input": { code: 9, message: "pane refused input" } },
    });
    await expect(
      launchAttempt(
        envFor(rig, stub.harnesses, noSend.socketPath),
        ticketSpec(rig, "stub", { fallback: "none" }),
      ),
    ).rejects.toThrow(/^could not deliver the launch command: pane\.send_input failed/);
    await expect(
      launchAttempt(
        envFor(rig, stub.harnesses, join(rig.dir, "no-daemon.sock"), false),
        ticketSpec(rig, "stub", { fallback: "none" }),
      ),
    ).rejects.toThrow(/not terminal-backed/);
    // Nothing was recorded for a launch that never got a pane.
    expect(readEvents(rig.runsDir, "01")).toEqual([]);
  }, 15000);
});

describe("terminal-backed engine mechanics (ADR-0014)", () => {
  // The fake daemon actually executes the wrapper shell a pane is sent, so
  // these tests observe the real files a pane run produces: the tee'd log,
  // the derived log from a streamed harness, and the wrapper's exit-code
  // file.

  it("wraps the harness in the script wrapper shell and reads the exit code from the file", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, {});
    const fake = await startFakeHerdr();

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );
    // The Outcome ends the attempt (ADR-0016); the wrapper's trailing
    // exit-code write lands a moment after, and closing the fake kills the
    // wrapper shell, so wait for the write before the fake goes.
    await until(
      () => existsSync(join(rig.runsDir, "01.exitcode")),
      "the wrapper's exit-code write",
    );
    await fake.close();

    expect(run.ok).toBe(true);
    const wrapper = fake.requests.find(
      (r) => r.method === "pane.send_input" && typeof r.params.text === "string",
    )!.params.text as string;
    // ADR-0016's wrapper: the interactive command wrapped in `script` (the
    // PTY that supplies the session and the typescript the log derives
    // from; `-e` makes script's exit the harness's) in the host platform's
    // form, the trailing exit-code write for crash forensics, and no `exit`,
    // so the pane stays open after the attempt completes. The
    // terminal-backed path streams to the attempt's Stream file whatever
    // the harness's stream mode.
    expect(wrapper).toContain(SCRIPT_RECORD_PREFIX);
    expect(wrapper).toContain(".stream.jsonl'");
    expect(wrapper).toMatch(/; echo \$\? > .*\.exitcode'$/);
    expect(wrapper).not.toContain("2>&1 | tee");
    expect(wrapper).not.toContain("PIPESTATUS");
    // The wrapper's promise, on the pane: the exit-code file the wrapper
    // wrote and the harness outcome it ran.
    expect(readFileSync(join(rig.runsDir, "01.exitcode"), "utf8").trim()).toBe("0");
    expect(existsSync(join(rig.runsDir, "01.log"))).toBe(true);
    const exited = readEvents(rig.runsDir, "01").find((e) => e.kind === "exited")!;
    expect(exited.payload.code).toBe(0);
    // The spawned event carries the pane and tab the attempt ran in, the
    // ids the merge-time close keys off.
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBe("w1:p1");
    expect(spawned.payload.tab_id).toBe("w1:t1");
    expect(spawned.payload.pid).toBeUndefined();
    expect(run.paneId).toBe("w1:p1");
    expect(run.tabId).toBe("w1:t1");
  }, 15000);

  it("captures the session in the script typescript Stream file and derives the ANSI-stripped log from it", async () => {
    const rig = makeRig();
    // A harness whose output carries ANSI, the way a real TUI paints. The
    // wrapper runs it under script, so the Stream file is the raw typescript
    // (both directions, ANSI included) and the follow-file tailer must strip
    // the ANSI out for the log.
    const script = join(rig.dir, "transcript-stub.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        "printf 'hello from the pane\\n'",
        "printf '\\033[32mgreen text\\033[0m\\n'",
        `printf '%s' '{"status":"done","summary":"transcript","commitSha":null}' > "$1"`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const harnesses: Record<string, HarnessCommand> = {
      transcript: (ctx: SpawnContext) => ["bash", script, ctx.outcomePath],
    };
    const fake = await startFakeHerdr();

    const run = await runAttempt(
      envFor(rig, harnesses, fake.socketPath),
      ticketSpec(rig, "transcript"),
      validateOutcome,
    );
    await fake.close();

    expect(run.ok).toBe(true);
    // The Stream file is the script typescript: the session's raw bytes,
    // including the ANSI the TUI painted and the CR a PTY line ending
    // carries.
    const stream = readFileSync(join(rig.runsDir, "01.stream.jsonl"), "utf8");
    expect(stream).toContain("hello from the pane");
    expect(stream).toContain("[32m");
    // The log is the ANSI-stripped transcript, not the raw bytes.
    const log = readFileSync(join(rig.runsDir, "01.log"), "utf8");
    expect(log).toContain("hello from the pane");
    expect(log).toContain("green text");
    expect(log).not.toContain("[");
    expect(log).not.toContain("hello from the pane\r");
  }, 15000);

  it("a non-zero pane exit is the attempt's crash, with the wrapper's code", async () => {
    const rig = makeRig();
    const stub = stubHarness(rig.dir, { "01": { outcome: null, exitCode: 3 } });
    const fake = await startFakeHerdr();

    const run = await runAttempt(
      envFor(rig, stub.harnesses, fake.socketPath),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );
    await fake.close();

    expect(run.ok).toBe(false);
    expect(run.code).toBe(3);
    expect(readFileSync(join(rig.runsDir, "01.exitcode"), "utf8").trim()).toBe("3");
    const events = readEvents(rig.runsDir, "01");
    expect(events.map((e) => e.kind)).toEqual(["spawned", "exited", "crash"]);
    const exited = events.find((e) => e.kind === "exited")!;
    expect(exited.payload).toEqual({
      code: 3,
      status: "in-progress",
      logTail: run.logTail,
      outcomeExists: false,
    });
    const crash = events.find((e) => e.kind === "crash")!;
    expect(crash.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
      logTail: run.logTail,
      outcomeExists: false,
    });
  }, 15000);

  it("waits on the exit-code file when the event subscription cannot be kept", async () => {
    const rig = makeRig();
    // The harness holds until released, so it is still running when the
    // ending wait begins and the wait has a subscription to attempt; an
    // instant harness would have its Outcome on disk before the wait
    // started, and the wait would end on it without ever subscribing.
    const release = join(rig.dir, "release");
    const { command } = harnessStub(rig.dir, { waitFor: release, outcome: doneOutcome });
    // A daemon that drops every subscription (a restart mid-wait, or one
    // too old for events.subscribe): the wrapper's exit-code file is the
    // only end signal, and the attempt must still complete.
    const fake = await startFakeHerdr({ breakSubscriptions: true });

    const running = runAttempt(
      envFor(rig, { stub: command }, fake.socketPath),
      ticketSpec(rig, "stub"),
      validateOutcome,
    );
    await until(
      () => fake.requests.some((r) => r.method === "events.subscribe"),
      "the ending wait's subscription attempt",
    );
    writeFileSync(release, "");
    const run = await running;
    await until(
      () => existsSync(join(rig.runsDir, "01.exitcode")),
      "the wrapper's exit-code write",
    );
    await fake.close();

    expect(run.ok).toBe(true);
    expect(
      fake.requests.filter((r) => r.method === "events.subscribe").length,
    ).toBeGreaterThan(0);
    const exited = readEvents(rig.runsDir, "01").find((e) => e.kind === "exited")!;
    expect(exited.payload.code).toBe(0);
  }, 15000);
});

describe("interactive terminal-backed attempts (ADR-0016)", () => {
  // The interactive tests drive the module against the fake herdr seam with
  // a KNOWN harness name whose command the test replaces with a bash script,
  // so the descriptor-driven readiness and prompt delivery run (the
  // descriptor survives the command override) while the pane actually
  // executes the stub. The fake fabricates the TUI's rendered content
  // (`rendered` carries the ready frame) and can drop typed pastes to
  // exercise the retry and fallback.
  //
  // The same seam contract runs for every known harness (claude, opencode,
  // cursor) with all per-harness behavior (ready frame, typed prompt shape,
  // echo target) coming from the descriptor table alone, so these tests pin
  // that the interactive machinery is harness-agnostic.

  const knownHarnesses = ["claude", "opencode", "cursor"] as const;

  // The ready frame each harness's TUI renders, from the descriptor's
  // prototype-validated ready pattern (the bare prompt glyph is not a ready
  // signal: the pane's own bash prompt collides with it).
  const readyFrame = (harness: string): string =>
    `${defaultHarnessDescriptors[harness].readyPattern}\n❯ `;

  // The typed prompt's leading shape, straight from the descriptor's
  // interactive shaping: claude and opencode expand a leading /driver slash
  // command, cursor takes a plain message (spawn.test.ts pins each shape).
  // The module holds no per-harness prompt code, only the descriptor table.
  // Body is a sentinel so the trailing issue-path echo line is not part of
  // the prefix a real (non-empty) prompt must start with.
  const promptPrefix = (harness: string, issuePath: string): string => {
    const shaped = defaultHarnessDescriptors[harness].promptShaping.interactive({
      driver: "implement",
      issuePath,
      body: "\0",
    });
    return shaped.slice(0, shaped.indexOf("\0"));
  };

  for (const harness of knownHarnesses) {
    describe(harness, () => {
      it("waits for readiness, types the descriptor's interactive prompt, and completes on the Outcome", async () => {
        const rig = makeRig();
        // The stub writes its Outcome and holds the pane open, so the pane
        // does not die mid-readiness the way a script that exits would.
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The fake's rendered content is the harness's ready frame; the
        // stub's outcome needs no trigger, so it is written directly.
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // The send sequence: wrapper (text and Enter in one call), then the typed driver
        // prompt text + enter. Nothing else is sent.
        expect(sends).toHaveLength(3);
        expect(sends[0].params.text as string).toContain(SCRIPT_RECORD_PREFIX);
        expect(sends[0].params.keys).toEqual(["enter"]);
        const prompt = sends[1].params.text as string;
        expect(prompt.startsWith(promptPrefix(harness, rig.issuePath))).toBe(true);
        // The issue reference rides the prompt, so it is the harness-agnostic
        // echo target the verification matched. It is also the final line, so
        // a long paste cannot scroll it out of the peeked tail.
        expect(prompt).toContain(rig.issuePath);
        expect(prompt.split("\n").at(-1)).toBe(rig.issuePath);
        expect(sends[2].params.keys).toEqual(["enter"]);
        // The readiness poll read the pane before the prompt was typed.
        expect(
          fake.requests
            .slice(0, fake.requests.indexOf(sends[1]))
            .some((r) => r.method === "pane.read"),
        ).toBe(true);
        // The spawned event records the argv the pane actually ran: the
        // interactive command (the stub), not the batch line.
        const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
        const argv = spawned.payload.argv as string[];
        expect(argv[0]).toBe("bash");
        expect(argv).toContain(join(rig.dir, "tui-stub.sh"));
        expect(argv).not.toContain("-p");
        expect(argv).not.toContain("--output-format");
      }, 20000);

      it("completes on a valid Outcome without pane exit, leaving the pane open", async () => {
        const rig = makeRig();
        const trigger = join(rig.dir, "hold-trigger");
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
          waitFor: trigger,
        });
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const running = runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        // Let the attempt spawn and reach its completion wait, then write the
        // trigger so the stub declares done while the pane stays open.
        await until(
          () => fake.requests.some((r) => r.method === "events.subscribe"),
          "the completion wait's pane-end subscription",
        );
        writeFileSync(trigger, "");
        const run = await running;

        expect(run.ok).toBe(true);
        // The pane never closed and the wrapper never finished: the exit-code
        // file the wrapper writes when the TUI eventually exits is absent, so
        // the TUI is still alive after the attempt completed.
        expect(fake.requests.filter((r) => r.method === "pane.close")).toHaveLength(0);
        expect(existsSync(join(rig.runsDir, "01.exitcode"))).toBe(false);
        const exited = readEvents(rig.runsDir, "01").find((e) => e.kind === "exited")!;
        expect(exited.payload.code).toBe(0);
        await fake.close();
      }, 20000);

      it("treats pane loss without an Outcome as a crash", async () => {
        const rig = makeRig();
        // The stub holds without writing any outcome: the attempt stays in
        // flight until the pane is lost.
        const { command } = harnessStub(rig.dir, { hold: true });
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const running = runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        // Wait until the prompt has been delivered (three send_input calls:
        // the wrapper call and the prompt pair) so the completion wait is
        // live, then lose the pane with no outcome on disk.
        await until(
          () =>
            fake.requests.filter((r) => r.method === "pane.send_input").length >= 3,
          "the typed prompt's send",
        );
        fake.endPane("w1:p1");
        const run = await running;

        expect(run.ok).toBe(false);
        const crash = readEvents(rig.runsDir, "01").find((e) => e.kind === "crash")!;
        // The pane ended with the wrapper's exit-code file never written
        // (the killed pane took the wrapper down with it): the crash names
        // the unreadable file rather than inventing an exit status.
        expect(crash.payload.reason).toContain("exit code unreadable");
        await fake.close();
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("retries a lost paste, then falls back to the file-referencing command", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The first three full-prompt pastes are lost (the prototype's
        // false-ready paste loss): the echo verification fails each time, the
        // module retries, then falls back to `/implement <promptfile>`.
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // The wrapper call, three lost full-prompt pastes with a clear before
        // each retry and before the fallback, then the fallback and Enter.
        expect(sends).toHaveLength(9);
        expect(sends[0].params.text as string).toContain(SCRIPT_RECORD_PREFIX);
        expect(sends[0].params.keys).toEqual(["enter"]);
        expect(
          (sends[1].params.text as string).startsWith(promptPrefix(harness, rig.issuePath)),
        ).toBe(true);
        expect(sends[2].params.keys).toEqual(clearKeys);
        expect(
          (sends[3].params.text as string).startsWith(promptPrefix(harness, rig.issuePath)),
        ).toBe(true);
        expect(sends[4].params.keys).toEqual(clearKeys);
        expect(
          (sends[5].params.text as string).startsWith(promptPrefix(harness, rig.issuePath)),
        ).toBe(true);
        expect(sends[6].params.keys).toEqual(clearKeys);
        const promptFile = join(rig.runsDir, "01.outcome.prompt.txt");
        expect(sends[7].params.text as string).toBe(`/implement ${promptFile}`);
        expect(sends[8].params.keys).toEqual(["enter"]);
        expect(existsSync(promptFile)).toBe(true);
        const promptFileText = readFileSync(promptFile, "utf8");
        expect(promptFileText.startsWith(`${rig.issuePath}\n\n`)).toBe(true);
        expect(promptFileText).toContain("Standing instructions");
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("falls back to the attempt's own driver, not a hardcoded one", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        // An attempt whose driver is not "implement" (grader, resolver, and
        // head-to-head spawn sites pass their own drivers) must fall back to
        // that driver's slash command, or a lost paste would invoke the
        // wrong skill.
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness, { driver: "verify" }),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(rig.runsDir, "01.outcome.prompt.txt");
        expect(sends[6].params.keys).toEqual(clearKeys);
        expect(sends[7].params.text as string).toBe(`/verify ${promptFile}`);
        expect(sends[8].params.keys).toEqual(["enter"]);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("clears the input before pasting the file-reference fallback", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(rig.runsDir, "01.outcome.prompt.txt");
        expect(sends[6].params.keys).toEqual(clearKeys);
        expect(sends[7].params.text as string).toBe(`/implement ${promptFile}`);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("fails the spawn when the fallback echo misses", async () => {
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 4,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(false);
        expect(run.crashReason).toBe("prompt never landed");
        const crash = readEvents(rig.runsDir, "01").find((e) => e.kind === "crash")!;
        expect(crash.payload.reason).toBe("prompt never landed");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends.at(-1)?.params.text as string | undefined).toContain(
          "/implement ",
        );
        const promptEnters = sends.filter(
          (s, i) =>
            i > 1 &&
            Array.isArray(s.params.keys) &&
            (s.params.keys as string[]).includes("enter"),
        );
        expect(promptEnters).toHaveLength(0);
      }, 20000);

      it("verifies the echo when the viewport wraps the issue path across bordered rows", async () => {
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The TUI draws its input as a box narrower than the pane and wraps
        // long lines inside it (issue #56: opencode split the 82-character
        // issue path at a hyphen across two bordered rows, so a substring
        // match on the viewport never saw it and the paste counted as lost).
        // The width is well under the rig's issue path, so the echo target
        // is guaranteed to wrap.
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          wrapWidth: 24,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        // The wrapped viewport never held the issue path contiguously.
        expect(rig.issuePath.length).toBeGreaterThan(24);
        // One paste, verified first time: no clear, no retry, no fallback.
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends).toHaveLength(3);
        expect(sends[1].params.text as string).toContain(rig.issuePath);
        expect(sends[2].params.keys).toEqual(["enter"]);
        expect(fake.submitted).toHaveLength(1);
        expect(fake.submitted[0].split("\n").at(-1)).toBe(rig.issuePath);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("verifies the fallback's echo when the viewport wraps the prompt-file path", async () => {
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        // Three lost pastes force the file-referencing fallback, whose echo
        // target is the prompt file's path: longer than the box, so it wraps
        // too (issue #56: the 73-character path in a 72-column box).
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
          wrapWidth: 24,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(rig.runsDir, "01.outcome.prompt.txt");
        expect(sends).toHaveLength(9);
        expect(sends[7].params.text as string).toBe(`/implement ${promptFile}`);
        expect(sends[8].params.keys).toEqual(["enter"]);
        expect(fake.submitted).toEqual([`/implement ${promptFile}`]);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("submits one clean prompt when a landed paste's echo is unseen", async () => {
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          hideInputs: 1,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(true);
        expect(fake.submitted).toHaveLength(1);
        const submitted = fake.submitted[0];
        expect(submitted.startsWith(promptPrefix(harness, rig.issuePath))).toBe(true);
        expect(submitted.split("\n").at(-1)).toBe(rig.issuePath);
        // One leading reference and one trailing echo line. A concatenated
        // retry would carry four.
        expect(submitted.split(rig.issuePath).length - 1).toBe(2);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length > 0)("fails the spawn on the first echo miss when it has no clear keys", async () => {
        const rig = makeRig();
        const { command } = harnessStub(rig.dir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 1,
        });

        const run = await runAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
          validateOutcome,
        );
        await fake.close();

        expect(run.ok).toBe(false);
        const crash = readEvents(rig.runsDir, "01").find((e) => e.kind === "crash")!;
        expect(crash.payload.reason).toBe("prompt never landed");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // The wrapper call and one paste. No retry, no fallback, no Enter on the prompt.
        expect(sends).toHaveLength(2);
        expect(sends[1].params.text as string).toContain(rig.issuePath);
        expect(fake.submitted).toEqual([]);
      }, 20000);

      it("surfaces a botched spawn (TUI never ready) as an ended launch, not an idle tab", async () => {
        const rig = makeRig();
        // The stub holds the pane the way a TUI that never paints its ready
        // frame does, and the fake never renders one; the pane then ends
        // during the readiness wait (the operator closed the tab), with no
        // exit code behind it.
        const { command } = harnessStub(rig.dir, { hold: true });
        const fake = await startFakeHerdr();

        const launching = launchAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
        );
        await until(
          () => fake.requests.filter((r) => r.method === "pane.read").length >= 2,
          "the readiness poll",
        );
        fake.endPane("w1:p1");
        const handle = await launching;
        expect(handle.kind).toBe("ended");
        const run = await awaitAttempt(handle, validateOutcome);

        expect(run.ok).toBe(false);
        expect(run.crashReason).toBe("TUI never became ready");
        // The pane was closed so the operator is not left a silently idle
        // tab; the close is fire-and-forget, so wait for the request to land.
        await until(
          () => fake.requests.some((r) => r.method === "pane.close"),
          "the botched spawn's pane close",
        );
        const closes = fake.requests.filter((r) => r.method === "pane.close");
        expect(closes.length).toBeGreaterThan(0);
        // Only the spawn was recorded: the events are the caller's.
        expect(readEvents(rig.runsDir, "01").map((e) => e.kind)).toEqual(["spawned"]);
        await fake.close();
      }, 20000);

      it("fails fast with the harness's own exit code when it dies before its TUI comes up (issue #58)", async () => {
        const rig = makeRig();
        // The harness dies on launch with a code of its own (a wrapper the
        // platform's script rejects, a binary the pane cannot find) and the
        // pane keeps its shell afterwards, the way a real herdr pane does:
        // no pane end, no ready frame, nothing for the readiness wait to see
        // but the exit-code file the wrapper wrote.
        const { command } = harnessStub(rig.dir, { exitCode: 3 });
        const fake = await startFakeHerdr({ holdPane: true });
        const started = Date.now();

        const handle = await launchAttempt(
          envFor(rig, { [harness]: command }, fake.socketPath),
          ticketSpec(rig, harness),
        );
        // The launch itself ends the attempt, at once rather than after the
        // readiness timeout (60s), and the await has nothing left to wait for.
        expect(handle.kind).toBe("ended");
        expect(handle.kind === "ended" && handle.code).toBe(3);
        const run = await awaitAttempt(handle, validateOutcome);
        const elapsed = Date.now() - started;
        await fake.close();

        expect(run.ok).toBe(false);
        expect(run.code).toBe(3);
        expect(run.crashReason).toBe("harness exited 3");
        expect(elapsed).toBeLessThan(10_000);
        // Nothing was typed into the shell the wrapper left behind: the
        // wrapper call and no more.
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends).toHaveLength(1);
        expect(fake.submitted).toEqual([]);
        // The pane stays open: it is a crashed attempt's tab (ADR-0014) and
        // holds the only record of why the harness died.
        expect(fake.requests.some((r) => r.method === "pane.close")).toBe(false);
      }, 20000);
    });
  }

  it("gives opencode a Stream file in terminal-backed mode and derives a readable log from it", async () => {
    // opencode is a raw harness headless (no structured stream), so this pins
    // the ADR-0016 rule that a terminal-backed attempt always gets a Stream
    // file (the script typescript) whatever its stream mode, and that the
    // derived log is the ANSI-stripped transcript (spec user story 15).
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, {
      outcome: doneOutcome,
      hold: true,
      output: "opencode agent working",
    });
    const fake = await startFakeHerdr({ rendered: readyFrame("opencode") });

    const run = await runAttempt(
      envFor(rig, { opencode: command }, fake.socketPath),
      ticketSpec(rig, "opencode"),
      validateOutcome,
    );
    await fake.close();

    expect(run.ok).toBe(true);
    // The Stream file is the script typescript: the session's raw bytes.
    const stream = readFileSync(join(rig.runsDir, "01.stream.jsonl"), "utf8");
    expect(stream).toContain("opencode agent working");
    // The log is the readable transcript derived from it.
    const log = readFileSync(join(rig.runsDir, "01.log"), "utf8");
    expect(log).toContain("opencode agent working");
  }, 20000);

  it("types a plain prompt verbatim, with no driver line and no file fallback (a Conversation's opening Turn)", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    const fake = await startFakeHerdr({ rendered: readyFrame("claude") });
    const body = "hello agent, let's plan the rollout\n\nSpawn teaching paragraph.";

    const handle = await launchAttempt(
      envFor(rig, { claude: command }, fake.socketPath),
      ticketSpec(rig, "claude", {
        driver: "converse",
        body,
        rotate: "none",
        fallback: "none",
        prompt: { kind: "plain", echo: "hello agent, let's plan the rollout" },
        events: { kind: "spawned-only" },
      }),
    );

    expect(handle.kind).toBe("live");
    const sends = fake.requests.filter((r) => r.method === "pane.send_input");
    // The wrapper call, then the body itself and Enter: no `/converse` line, no
    // trailing issue reference.
    expect(sends).toHaveLength(3);
    expect(sends[1].params.text).toBe(body);
    expect(sends[2].params.keys).toEqual(["enter"]);
    expect(fake.submitted).toEqual([body]);
    // The readiness wait ran before the paste.
    expect(
      fake.requests
        .slice(0, fake.requests.indexOf(sends[1]))
        .some((r) => r.method === "pane.read"),
    ).toBe(true);
    // No file-referencing fallback exists for a plain prompt.
    expect(existsSync(join(rig.runsDir, "01.outcome.prompt.txt"))).toBe(false);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.pane_id).toBe("w1:p1");
    expect(spawned.payload.tab_id).toBe("w1:t1");
    if (handle.kind === "live") {
      expect(handle.paneId).toBe("w1:p1");
      expect(handle.tailer).not.toBeNull();
      await handle.tailer!.finish();
    }
    await fake.close();
  }, 20000);

  it("types a plain prompt into a custom harness with no readiness wait, still echo verified", async () => {
    const rig = makeRig();
    const fake = await startFakeHerdr({ holdPane: true });
    const body = "hello agent";

    const handle = await launchAttempt(
      envFor(rig, { convo: () => ["sleep", "30"] }, fake.socketPath),
      ticketSpec(rig, "convo", {
        driver: "converse",
        body,
        rotate: "none",
        fallback: "none",
        prompt: { kind: "plain", echo: body },
        events: { kind: "spawned-only" },
      }),
    );

    expect(handle.kind).toBe("live");
    const sends = fake.requests.filter((r) => r.method === "pane.send_input");
    expect(sends).toHaveLength(3);
    expect(sends[1].params.text).toBe(body);
    expect(fake.submitted).toEqual([body]);
    if (handle.kind === "live") await handle.tailer?.finish();
    await fake.close();
  }, 20000);

  it("ends the launch when a plain prompt never lands, closing the pane", async () => {
    const rig = makeRig();
    // claude has no verified clear keys, so one lost paste is the failure.
    const { command } = harnessStub(rig.dir, { hold: true });
    const fake = await startFakeHerdr({ rendered: readyFrame("claude"), dropInputs: 1 });

    const handle = await launchAttempt(
      envFor(rig, { claude: command }, fake.socketPath),
      ticketSpec(rig, "claude", {
        driver: "converse",
        body: "hello agent",
        rotate: "none",
        fallback: "none",
        prompt: { kind: "plain", echo: "hello agent" },
        events: { kind: "spawned-only" },
      }),
    );

    expect(handle.kind).toBe("ended");
    const run = await awaitAttempt(handle, validateOutcome);
    expect(run.crashReason).toBe("prompt never landed");
    await until(
      () => fake.requests.some((r) => r.method === "pane.close"),
      "the botched launch's pane close",
    );
    expect(fake.submitted).toEqual([]);
    await fake.close();
  }, 20000);
});

describe("Botched launch (issue #102)", () => {
  // The claude descriptor is real (readiness waits for its ready frame), the
  // command a bash stub that holds like a TUI, and the fake renders the
  // frame once the wrapper has booted the pane. The fake's `swallowWrapper`
  // is the shell-startup race: the first N tabs lose the wrapper typed into
  // them and sit at their prompt with `script` never run.
  const harness = "claude";
  const readyFrame = `${defaultHarnessDescriptors.claude.readyPattern}2.1\n`;

  it("retries a launch whose command never ran into a fresh tab, and records only that tab as spawned", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    const fake = await startFakeHerdr({ rendered: readyFrame, swallowWrapper: 1 });

    const handle = await launchAttempt(
      envFor(rig, { [harness]: command }, fake.socketPath),
      ticketSpec(rig, harness),
    );

    expect(handle.kind).toBe("live");
    expect(handle.paneId).toBe("w1:p2");
    expect(handle.tabId).toBe("w1:t2");
    // One retry, then the spawn: the botched tab is on the log with its
    // reason, and the spawned event names the tab the launch ended up in.
    const events = readEvents(rig.runsDir, "01");
    expect(events.map((e) => e.kind)).toEqual(["launch-retried", "spawned"]);
    expect(events[0].payload).toEqual({
      try: 1,
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      reason: "launch command never ran",
    });
    expect(events[1].payload.pane_id).toBe("w1:p2");
    expect(events[1].payload.tab_id).toBe("w1:t2");
    // The botched tab was closed; the live one was not.
    await until(
      () => fake.requests.some((r) => r.method === "tab.close"),
      "the botched tab's close",
    );
    expect(
      fake.requests.filter((r) => r.method === "tab.close").map((r) => r.params.tab_id),
    ).toEqual(["w1:t1"]);
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(2);
    // Each wrapper went as one send: text and Enter together.
    const wrappers = fake.requests.filter(
      (r) =>
        r.method === "pane.send_input" &&
        typeof r.params.text === "string" &&
        (r.params.text as string).includes(SCRIPT_RECORD_PREFIX),
    );
    expect(wrappers).toHaveLength(2);
    for (const send of wrappers) expect(send.params.keys).toEqual(["enter"]);
    // The prompt went into the live pane only.
    expect(fake.submitted).toHaveLength(1);
    if (handle.kind === "live") await handle.tailer?.finish();
    await fake.close();
  }, 20000);

  it("gives up after LAUNCH_TRIES botched launches with a crash that says the command never ran", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    const fake = await startFakeHerdr({ rendered: readyFrame, swallowWrapper: LAUNCH_TRIES });
    const started = Date.now();

    const run = await runAttempt(
      envFor(rig, { [harness]: command }, fake.socketPath),
      ticketSpec(rig, harness),
      validateOutcome,
    );
    const elapsed = Date.now() - started;

    expect(run.ok).toBe(false);
    expect(run.code).toBe(-5);
    expect(run.crashReason).toBe("launch command never ran");
    // Decided by the wrapper-landed check, not the 60s readiness timeout.
    expect(elapsed).toBeLessThan(15_000);
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(LAUNCH_TRIES);
    // No harness ever ran: no Stream file, nothing typed beyond the
    // wrappers, and no grade to seek.
    expect(existsSync(join(rig.runsDir, "01.stream.jsonl"))).toBe(false);
    expect(fake.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(LAUNCH_TRIES);
    expect(fake.submitted).toEqual([]);
    const events = readEvents(rig.runsDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "launch-retried",
      "launch-retried",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(events.find((e) => e.kind === "spawned")!.payload.pane_id).toBe(`w1:p${LAUNCH_TRIES}`);
    expect(events.find((e) => e.kind === "crash")!.payload).toMatchObject({
      code: -5,
      reason: "launch command never ran",
    });
    // The botched tabs closed by the retry, the last pane by the crash
    // (fire-and-forget, so wait for them to land).
    await until(
      () =>
        fake.requests.filter((r) => r.method === "tab.close").length === LAUNCH_TRIES - 1 &&
        fake.requests.some((r) => r.method === "pane.close"),
      "the botched tabs' closes",
    );
    expect(
      fake.requests.filter((r) => r.method === "tab.close").map((r) => r.params.tab_id),
    ).toEqual(["w1:t1", "w1:t2"]);
    await fake.close();
  }, 30000);

  it("waits for the pane's shell to draw its prompt before typing the wrapper", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    // A fresh tab reads empty for its first moments, the way a real one
    // does while its shell starts: the wrapper must not be typed into it.
    const fake = await startFakeHerdr({ rendered: readyFrame, shellPromptDelayMs: 300 });
    const started = Date.now();

    const handle = await launchAttempt(
      envFor(rig, { [harness]: command }, fake.socketPath),
      ticketSpec(rig, harness),
    );

    expect(handle.kind).toBe("live");
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    // The shell was read, and read non-empty, before the first send.
    const firstSend = fake.requests.findIndex((r) => r.method === "pane.send_input");
    const readsBefore = fake.requests
      .slice(0, firstSend)
      .filter((r) => r.method === "pane.read");
    expect(readsBefore.length).toBeGreaterThanOrEqual(2);
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(1);
    expect(readEvents(rig.runsDir, "01").map((e) => e.kind)).toEqual(["spawned"]);
    if (handle.kind === "live") await handle.tailer?.finish();
    await fake.close();
  }, 20000);
});

describe("claude's Blocking dialogs on launch (issue #127)", () => {
  // The frames claude 2.1.276 paints before its prompt, read off a live
  // pane on 2026-09-22: the workspace trust dialog opens with the highlight
  // on "No, exit", so a blind enter would exit claude; the engine moves the
  // highlight, reads the pane back, and confirms only once the highlighted
  // row names the option it wants. The fake acts on no key but enter, so
  // the test moves the highlight itself when it sees the down key, exactly
  // the read-between-keys the engine relies on.
  const trustDialog = (highlighted: "No, exit" | "Yes, I trust this folder"): string =>
    [
      "Accessing workspace:",
      "/tmp/pool-worktrees/abcd1234/01",
      "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
      "a well-known open source project, or work from your team). If not, take a moment to",
      "review what's in this folder first.",
      "Claude Code'll be able to read, edit, and execute files here.",
      "Security guide",
      `${highlighted === "No, exit" ? "❯" : " "} No, exit`,
      `${highlighted === "Yes, I trust this folder" ? "❯" : " "} Yes, I trust this folder`,
      "Enter to confirm · Esc to cancel",
      "",
    ].join("\n");
  const bypassWarning = [
    "WARNING: Claude Code running in Bypass Permissions mode",
    "In Bypass Permissions mode, Claude Code will not ask for your approval before running",
    "potentially dangerous commands.",
    "❯ No, exit",
    "  Yes, I accept",
    "",
  ].join("\n");
  const claudeReady = `${defaultHarnessDescriptors.claude.readyPattern}2.1.276\n❯ `;

  // Every key send after the wrapper's own enter: the dialog answer, then
  // the typed prompt's enter.
  const keySends = (fake: ExecutingFakeHerdr): string[][] =>
    fake.requests
      .filter((r) => r.method === "pane.send_input")
      .slice(1)
      .map((r) => (Array.isArray(r.params.keys) ? (r.params.keys as string[]) : []))
      .filter((keys) => keys.length > 0);

  it("answers the workspace trust dialog by name, reading the highlight between the keys", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { outcome: doneOutcome, hold: true });
    const fake = await startFakeHerdr({ rendered: trustDialog("No, exit") });

    const running = runAttempt(
      envFor(rig, { claude: command }, fake.socketPath),
      ticketSpec(rig, "claude"),
      validateOutcome,
    );
    // The engine sends down and reads back; only then does the highlight
    // move, and only then is enter sent.
    await until(() => keySends(fake).some((k) => k.includes("down")), "the down key");
    expect(keySends(fake).some((k) => k.includes("enter"))).toBe(false);
    fake.setPaneContent("w1:p1", trustDialog("Yes, I trust this folder"));
    await until(() => keySends(fake).some((k) => k.includes("enter")), "the confirm");
    fake.setPaneContent("w1:p1", claudeReady);
    const run = await running;

    expect(run.ok).toBe(true);
    expect(run.crashReason).toBeNull();
    // One down, one confirm, then the prompt's own enter: the dialog was
    // answered exactly once, however many polls saw it.
    expect(keySends(fake)).toEqual([["down"], ["enter"], ["enter"]]);
  }, 20000);

  it("leaves the dialog unanswered when the highlight does not move, and the ending says so", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    // The highlight never moves: a build that dropped the down key, or one
    // that reordered the buttons so down landed somewhere else.
    const fake = await startFakeHerdr({ rendered: trustDialog("No, exit") });
    const started = Date.now();

    const handle = await launchAttempt(
      envFor(rig, { claude: command }, fake.socketPath),
      ticketSpec(rig, "claude"),
    );
    expect(handle.kind).toBe("ended");
    // Decided at once, not at the readiness timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    const run = await awaitAttempt(handle, validateOutcome);

    expect(run.ok).toBe(false);
    expect(run.crashReason).toBe(
      "TUI never became ready: the workspace trust dialog was on screen and the " +
        'highlight did not move to "Yes, I trust this folder", so it was left unanswered',
    );
    // Down was sent; enter never was, so claude was not told "No, exit".
    expect(keySends(fake)).toEqual([["down"]]);
    // The derived log, empty because no harness stream ever came, carries
    // the frame the engine saw, so the crash's tail and the interrupt body
    // show the dialog rather than a blank.
    expect(run.logTail[0]).toBe(PANE_FRAME_LOG_HEADING);
    expect(run.logTail.some((line) => line.includes("Quick safety check"))).toBe(true);
    expect(run.logTail.some((line) => line.includes("❯ No, exit"))).toBe(true);
    await until(
      () => fake.requests.some((r) => r.method === "pane.close"),
      "the botched launch's pane close",
    );
  }, 20000);

  it("never answers the bypass-permissions warning and ends the launch at once, naming it", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    const fake = await startFakeHerdr({ rendered: bypassWarning });
    const started = Date.now();

    const handle = await launchAttempt(
      envFor(rig, { claude: command }, fake.socketPath),
      ticketSpec(rig, "claude"),
    );
    expect(handle.kind).toBe("ended");
    expect(Date.now() - started).toBeLessThan(10_000);
    const run = await awaitAttempt(handle, validateOutcome);

    expect(run.ok).toBe(false);
    expect(run.crashReason).toBe(
      "TUI never became ready: the bypass-permissions warning was on screen, " +
        "which only the operator may answer",
    );
    // Not a key was sent at it.
    expect(keySends(fake)).toEqual([]);
    expect(run.logTail.some((line) => line.includes("Bypass Permissions mode"))).toBe(true);
  }, 20000);

  it("ignores a dialog-shaped frame on another harness", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { hold: true });
    // opencode's pane happens to show claude's words (an operator's scrollback,
    // say): the dialog table is claude's alone, so the wait keeps polling
    // for opencode's own ready frame and the pane ending is the ending.
    const fake = await startFakeHerdr({ rendered: bypassWarning });

    const launching = launchAttempt(
      envFor(rig, { opencode: command }, fake.socketPath),
      ticketSpec(rig, "opencode"),
    );
    await until(
      () => fake.requests.filter((r) => r.method === "pane.read").length >= 3,
      "the readiness poll",
    );
    fake.endPane("w1:p1");
    const handle = await launching;
    expect(handle.kind).toBe("ended");
    const run = await awaitAttempt(handle, validateOutcome);
    expect(run.crashReason).toBe("TUI never became ready");
    expect(keySends(fake)).toEqual([]);
  }, 20000);
});

describe("folder trust for the worktrees the engine makes (issue #127)", () => {
  const claudeReady = `${defaultHarnessDescriptors.claude.readyPattern}2.1.276\n❯ `;

  function configAt(rig: Rig, projects: Record<string, unknown> = {}): string {
    const path = join(rig.dir, "claude.json");
    writeFileSync(path, JSON.stringify({ numStartups: 3, projects }, null, 2));
    return path;
  }

  function poolWorktree(rig: Rig): string {
    const cwd = join(rig.dir, "pool-worktrees", "abcd1234", "01");
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  it("seeds claude's trust for a pool worktree and records the seed on the spawned event", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { outcome: doneOutcome, hold: true });
    const fake = await startFakeHerdr({ rendered: claudeReady });
    const config = configAt(rig);
    const cwd = poolWorktree(rig);

    const run = await runAttempt(
      { ...envFor(rig, { claude: command }, fake.socketPath), claudeConfigPath: config },
      ticketSpec(rig, "claude", { cwd }),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    const projects = JSON.parse(readFileSync(config, "utf8")).projects;
    expect(projects[cwd].hasTrustDialogAccepted).toBe(true);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.folder_trust).toBe("seeded");
  }, 20000);

  it("records a seed that could not land, and leaves the pane's dialog handling to the launch", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { outcome: doneOutcome, hold: true });
    const fake = await startFakeHerdr({ rendered: claudeReady });
    const missing = join(rig.dir, "no-such-claude.json");
    const cwd = poolWorktree(rig);

    const run = await runAttempt(
      { ...envFor(rig, { claude: command }, fake.socketPath), claudeConfigPath: missing },
      ticketSpec(rig, "claude", { cwd }),
      validateOutcome,
    );

    expect(run.ok).toBe(true);
    expect(existsSync(missing)).toBe(false);
    const spawned = readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!;
    expect(spawned.payload.folder_trust).toBe(`skipped: ${missing} does not exist`);
  }, 20000);

  it("never seeds the operator's own checkout, nor for another harness", async () => {
    const rig = makeRig();
    const { command } = harnessStub(rig.dir, { outcome: doneOutcome, hold: true });
    const config = configAt(rig);
    const before = readFileSync(config, "utf8");

    // claude in the pool checkout (a lone ready ticket runs there).
    let fake = await startFakeHerdr({ rendered: claudeReady });
    let run = await runAttempt(
      { ...envFor(rig, { claude: command }, fake.socketPath), claudeConfigPath: config },
      ticketSpec(rig, "claude"),
      validateOutcome,
    );
    expect(run.ok).toBe(true);
    expect(readEvents(rig.runsDir, "01").find((e) => e.kind === "spawned")!.payload.folder_trust).toBeUndefined();
    await fake.close();

    // opencode in a pool worktree: its trust is its own affair.
    fake = await startFakeHerdr({
      rendered: `${defaultHarnessDescriptors.opencode.readyPattern}\n❯ `,
    });
    run = await runAttempt(
      { ...envFor(rig, { opencode: command }, fake.socketPath), claudeConfigPath: config },
      ticketSpec(rig, "opencode", { cwd: poolWorktree(rig), attempt: 2 }),
      validateOutcome,
    );
    expect(run.ok).toBe(true);
    expect(readFileSync(config, "utf8")).toBe(before);
  }, 30000);
});
