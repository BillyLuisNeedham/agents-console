/**
 * Headless Attempt launch, seen from outside the server (ADR-0036): how an
 * Attempt's result is read, what a headless launch records, the fallbacks a
 * terminal-backed pool takes to headless when herdr refuses, the spawn
 * pump's teardown when a grandchild holds the harness's stdout, and the
 * Live attempt the snapshot carries while an Attempt runs.
 */

import { expect } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { anyIsoTime, expectJsonlEqual, expectParsedEqual } from "../harness/equal.ts";
import type { Http } from "../harness/http.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

/** A ready Ticket `<id>-t.md` titled `T<id>`. */
function ready(id: string, blockedBy = "none") {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
    body: `# T${id}\n\nWork.`,
  };
}

/** The batch argv's prompt element as the spawned event records it. */
function elided(world: World, id: string, driver = "implement"): string {
  return `/${driver} ${join(world.pool, "issues", `${id}-t.md`)}\n\n<prompt>`;
}

/** The headless claude argv the spawned event records for Ticket `id` on model m. */
function claudeArgv(world: World, id: string, driver = "implement"): string[] {
  return [
    "claude",
    "-p",
    elided(world, id, driver),
    "--model",
    "m",
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/**
 * Put a bash prelude in front of a stub wrapper on the world's PATH, so a
 * launch can do what the scripted stub cannot (commit, fork a grandchild,
 * resolve a merge) before the stub records it and plays its script. The
 * prelude sees the launch's argv as "$@", and `key` set to the Outcome
 * file's stem when the prompt names one.
 */
function prelude(world: World, binary: string, script: string): void {
  const path = join(world.stubs.bin, binary);
  const [shebang, ...rest] = readFileSync(path, "utf8").split("\n");
  const keyed = [
    'out=""',
    'for arg in "$@"; do',
    '  case "$arg" in *"outcome as JSON at "*) rest="${arg#*outcome as JSON at }"; out="${rest%%:*}" ;; esac',
    "done",
    'key=""; [ -n "$out" ] && key="$(basename "$out" .outcome.json)"',
  ];
  writeFileSync(path, [shebang, ...keyed, script, ...rest].join("\n"));
}

/** Kill the process whose pid a prelude wrote to `path`, if it is still there. */
function killRecorded(path: string): void {
  try {
    process.kill(Number(readFileSync(path, "utf8").trim()), "SIGKILL");
  } catch {
    // Never started, or already gone.
  }
}

async function snapshot(http: Http): Promise<EnrichedSnapshot> {
  const state = await http.get("/api/state");
  return state.json<{ snapshot: EnrichedSnapshot }>().snapshot;
}

async function ticket(http: Http, id: string): Promise<EnrichedTicketState | undefined> {
  return (await snapshot(http))?.state.tickets.find((t) => t.id === id);
}

function eventsEnded(world: World, id: string) {
  return until(
    () => readEvents(world.pool, id),
    (events) => events.some((e) => e.kind === "exited"),
    { ms: 30_000, what: `${id}'s exited event` },
  );
}

/** The one pool worktree key this world's server made. */
function worktreeKey(world: World): string {
  const keys = readdirSync(join(world.repo, ".git", "pool-worktrees"));
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

// attempt-run.test.ts:267 readAttemptResult
conformance("attempts", "a missing, unparseable or statusless Outcome is a crash with its own reason", async (t) => {
  const world = t.world({
    tickets: [ready("01"), ready("02"), ready("03")],
    config: { defaults: { harness: "claude", model: "m" } },
  });
  world.stubs.script("01", { outcome: null });
  world.stubs.script("02", { outcomeRaw: "{not json" });
  world.stubs.script("03", { outcomeRaw: JSON.stringify({ status: "nope", summary: "s", commitSha: null }) });
  const server = await t.start(world);

  const reasons: Record<string, [string, boolean]> = {
    "01": ["no outcome written", false],
    "02": ["outcome is not parseable JSON", true],
    "03": ["outcome's status is not done or checkpoint", true],
  };
  const key = await until(
    () => readdirSync(join(world.repo, ".git", "pool-worktrees"))[0],
    (found) => found !== undefined,
  );
  for (const [id, [reason, outcomeExists]] of Object.entries(reasons)) {
    await until(() => readEvents(world.pool, id), (events) => events.some((e) => e.kind === "crash"));
    const worktree = join(world.repo, ".git", "pool-worktrees", key, id);
    expectJsonlEqual(readFileSync(join(world.pool, "runs", `${id}.events.jsonl`)), [
      { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
      {
        at: anyIsoTime(),
        attempt: 1,
        kind: "spawned",
        payload: {
          argv: claudeArgv(world, id),
          cwd: worktree,
          branch: `pool/${key}/${id}`,
          commitSha: world.git(["rev-parse", "main"]).trim(),
          env: { PWD: worktree },
          harness: "claude",
          model: "m",
          pid: expect.any(Number),
        },
      },
      { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "in-progress", logTail: [], outcomeExists } },
      { at: anyIsoTime(), attempt: 1, kind: "crash", payload: { code: 0, reason, logTail: [], outcomeExists } },
    ], `runs/${id}.events.jsonl`);
  }

  const state = await until(
    () => snapshot(server.http),
    (snap) => snap?.state.interrupts.length === 3,
    { what: "three crash Interrupts" },
  );
  const runs = join(world.pool, "runs");
  expectParsedEqual(
    state.state.interrupts,
    Object.entries(reasons).map(([id, [reason, exists]]) => ({
      ticketId: id,
      kind: "crash",
      body:
        `crash: ${reason}\n${runs}/${id}.log\n\n` +
        `outcome file: ${runs}/${id}.outcome.json (${exists ? "exists" : "missing"})\n`,
    })),
    "the crash Interrupts",
  );
});

// attempt-run.test.ts:299 headless attempts
conformance("attempts", "a headless pool never calls herdr, even with a daemon on its socket", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const herdr = await t.herdr(world);
  const server = await t.start(world, { herdr });

  await eventsEnded(world, "01");
  await until(() => snapshot(server.http), (snap) => snap?.phase === "quiescent", { what: "the pool to settle" });
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    {
      at: anyIsoTime(),
      attempt: 1,
      kind: "spawned",
      // No pane_id, tab_id or terminal_error: a headless pool records no pane facts at all.
      payload: {
        argv: claudeArgv(world, "01"),
        cwd: world.repo,
        branch: null,
        commitSha: world.git(["rev-parse", "HEAD"]).trim(),
        env: { PWD: world.repo },
        harness: "claude",
        model: "m",
        pid: expect.any(Number),
      },
    },
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
  ], "runs/01.events.jsonl");
  expect(herdr.calls).toEqual([]);
});

/**
 * A pool of 01 and 02 that both change shared.txt: 02 commits first, 01
 * waits for 02's merge and then commits its own line, so 01's merge
 * conflicts and the claude resolver runs on it. `resolver` is the bash the
 * resolver launch runs in its worktree, with "$rout" its Outcome path.
 */
function conflictWorld(t: Parameters<Parameters<typeof conformance>[2]>[0], resolver: string): World {
  const world = t.world({
    tickets: [ready("01"), ready("02")],
    config: { defaults: { harness: "claude", model: "m" }, resolver: "claude" },
    repoFiles: { "shared.txt": "base\n" },
  });
  prelude(
    world,
    "claude",
    [
      'rout=""',
      'for arg in "$@"; do',
      '  case "$arg" in *"Resolve the git merge conflict"*) rest="${arg#*write JSON to }"; rout="${rest%%:*}" ;; esac',
      "done",
      'if [ -n "$rout" ]; then',
      "  git merge main >/dev/null 2>&1",
      `  ${resolver}`,
      "fi",
      'if [ "$key" = "02" ]; then printf \'from-02\\n\' > shared.txt; git add shared.txt; git commit -qm work-02; fi',
      'if [ "$key" = "01" ]; then',
      `  for _ in $(seq 1 200); do git -C ${JSON.stringify(world.repo)} log main --format=%s | grep -qx work-02 && break; sleep 0.05; done`,
      "  printf 'from-01\\n' > shared.txt; git add shared.txt; git commit -qm work-01",
      "fi",
    ].join("\n"),
  );
  return world;
}

/** 01's events through the resolver's spawn, in the shape both resolver cases share. */
function resolverEvents(world: World, key: string): unknown[] {
  const worktree = join(world.repo, ".git", "pool-worktrees", key, "01");
  const facts = { cwd: worktree, env: { PWD: worktree }, harness: "claude", model: "m", pid: expect.any(Number) };
  return [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    {
      at: anyIsoTime(),
      attempt: 1,
      kind: "spawned",
      payload: {
        ...facts,
        argv: claudeArgv(world, "01"),
        branch: `pool/${key}/01`,
        commitSha: world.git(["rev-list", "--max-parents=0", "main"]).trim(),
      },
    },
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
    { at: anyIsoTime(), attempt: 1, kind: "merge-conflict", payload: { files: ["shared.txt"] } },
    { at: anyIsoTime(), attempt: 2, kind: "resolver", payload: { files: ["shared.txt"], cwd: worktree, branch: `pool/${key}/01` } },
    {
      at: anyIsoTime(),
      attempt: 2,
      kind: "spawned",
      payload: {
        ...facts,
        argv: claudeArgv(world, "01", "resolving-merge-conflicts"),
        branch: `pool/${key}/01`,
        commitSha: world.git(["rev-parse", `pool/${key}/01`]).trim(),
      },
    },
  ];
}

// attempt-run.test.ts:332 headless attempts
conformance("attempts", "a resolver Attempt records its spawn and nothing after it", async (t) => {
  const world = conflictWorld(
    t,
    "printf 'resolved\\n' > shared.txt; git add shared.txt; " +
      "printf '{\"resolved\": true, \"note\": \"kept both\"}' > \"$rout\"; exit 0",
  );
  const server = await t.start(world);

  const state = await until(
    () => snapshot(server.http),
    (snap) => (snap?.state.interrupts.length ?? 0) > 0,
    { ms: 30_000, what: "the merge-approval Interrupt" },
  );
  const key = worktreeKey(world);
  expectParsedEqual(state.state.interrupts, [
    {
      ticketId: "01",
      kind: "merge-approval",
      body:
        "The resolver agent resolved the merge conflict for ticket 01.\nIt attempted: kept both\n" +
        `conflicted files: shared.txt\nthe resolution is staged on branch pool/${key}/01; ` +
        "approve to commit it and continue, or reject to resolve by hand.",
    },
  ], "the Interrupts");
  // The merge hold keeps the pool waiting here, so this is all the log will hold.
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), resolverEvents(world, key), "runs/01.events.jsonl");
});

// attempt-run.test.ts:420 headless attempts
conformance("attempts", "a resolver that exits non-zero is named as the crash's subject", async (t) => {
  const world = conflictWorld(t, "exit 2");
  const server = await t.start(world);

  const state = await until(
    () => snapshot(server.http),
    (snap) => (snap?.state.interrupts.length ?? 0) > 0,
    { ms: 30_000, what: "the merge-conflict Interrupt" },
  );
  const key = worktreeKey(world);
  const worktree = join(world.repo, ".git", "pool-worktrees", key, "01");
  expectParsedEqual(state.state.interrupts, [
    {
      ticketId: "01",
      kind: "merge-conflict",
      body:
        `merging pool/${key}/01 onto the working branch failed; the merge was aborted and the working branch was left clean.\n` +
        "conflicted files: shared.txt\n" +
        `the ticket's work is parked on branch pool/${key}/01, checked out at ${worktree}.\n` +
        "git said: Auto-merging shared.txt\nCONFLICT (content): Merge conflict in shared.txt\n" +
        "Automatic merge failed; fix conflicts and then commit the result.\n" +
        "resolve the conflict and resume this ticket; the merge is re-attempted on resume.\n" +
        "The resolver agent attempted: resolver exited 2",
    },
  ], "the Interrupts");
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), resolverEvents(world, key), "runs/01.events.jsonl");
});

/** The spawned event of a terminal-backed launch that fell back to headless. */
function fallbackSpawned(world: World, terminalError: string): unknown {
  return {
    at: anyIsoTime(),
    attempt: 1,
    kind: "spawned",
    payload: {
      argv: claudeArgv(world, "01"),
      cwd: world.repo,
      branch: null,
      commitSha: world.git(["rev-parse", "HEAD"]).trim(),
      env: { PWD: world.repo },
      harness: "claude",
      model: "m",
      pid: expect.any(Number),
      pane_id: null,
      tab_id: null,
      terminal_error: terminalError,
    },
  };
}

async function expectFallbackRan(world: World, terminalError: string): Promise<void> {
  await until(() => readStateLine(world.pool, "01-t.md"), (line) => line.status === "done", { what: "01 done" });
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    fallbackSpawned(world, terminalError),
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
  ], "runs/01.events.jsonl");
  // The headless batch argv ran: the stub saw -p and the prompt.
  const calls = world.stubs.calls();
  expect(calls.map((call) => [call.key, call.argv[0]])).toEqual([["01", "-p"]]);
}

// attempt-run.test.ts:559 the headless fallbacks (ADR-0014)
conformance("attempts", "a terminal-backed pool with no herdr daemon runs headless and says why", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" } });
  await t.start(world);
  await expectFallbackRan(world, "no Pool workspace: the herdr daemon could not give this pool one at boot");
});

// attempt-run.test.ts:575 the headless fallbacks (ADR-0014)
conformance("attempts", "a tab herdr will not open falls back to headless with the refusal on the spawned event", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" } });
  const herdr = await t.herdr(world, { fail: ["tab.create"] });
  await t.start(world, { herdr });
  await expectFallbackRan(world, 'tab.create failed: {"code":-32000,"message":"tab.create refused"}');
  expect(herdr.calls.some((call) => call.method === "pane.send_input")).toBe(false);
});

// attempt-run.test.ts:594 the headless fallbacks (ADR-0014)
conformance("attempts", "a wrapper herdr will not take falls back to headless and closes the half-started pane", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" } });
  const herdr = await t.herdr(world, { rendered: "Claude Code v2\n❯ ", fail: ["pane.send_input"] });
  await t.start(world, { herdr });
  await expectFallbackRan(world, 'pane.send_input failed: {"code":-32000,"message":"pane.send_input refused"}');

  // The tab opened, its root pane was sent the wrapper, refused, and closed.
  const methods = herdr.calls.map((call) => call.method);
  const tab = methods.indexOf("tab.create");
  const send = methods.indexOf("pane.send_input");
  const close = methods.indexOf("pane.close");
  expect(tab).toBeGreaterThanOrEqual(0);
  expect(send).toBeGreaterThan(tab);
  expect(close).toBeGreaterThan(send);
  expect(herdr.calls[send]!.params.pane_id).toBe("w1:p1");
  expect(herdr.calls[close]!.params).toEqual({ pane_id: "w1:p1" });
});

// engine.test.ts:3538 spawn pump teardown
conformance("attempts", "a grandchild holding the harness's stdout does not hold up the next super-step", async (t) => {
  const world = t.world({
    tickets: [ready("01"), ready("02", "01")],
    config: { defaults: { harness: "opencode", model: "m" } },
  });
  const pid = join(world.stubs.dir, "grandchild.pid");
  prelude(
    world,
    "opencode",
    `if [ "$key" = "01" ]; then ( sleep 0.3; echo "grandchild line"; exec sleep 30 ) & echo $! > ${JSON.stringify(pid)}; sleep 0.5; fi`,
  );
  const start = Date.now();
  try {
    await t.start(world);
    await until(
      () => readEvents(world.pool, "02"),
      (events) => events.some((e) => e.kind === "spawned"),
      { ms: 10_000, what: "02 to spawn within 10 s of the start" },
    );
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(readEvents(world.pool, "02")[0]).toMatchObject({ kind: "scheduled", attempt: 1 });
    expect(readFileSync(join(world.pool, "runs", "01.log"), "utf8")).toBe("grandchild line\n");
  } finally {
    killRecorded(pid);
  }
});

// pump-teardown.test.ts:118 spawn pump teardown
conformance("attempts", "an Attempt settles through the pump grace while a grandchild keeps printing", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "opencode", model: "m" } } });
  const pid = join(world.stubs.dir, "grandchild.pid");
  world.stubs.script("01", { stdout: "harness done\n" });
  prelude(
    world,
    "opencode",
    `if [ "$key" = "01" ]; then ( for i in $(seq 1 60); do echo "grandchild $i"; sleep 1; done ) & echo $! > ${JSON.stringify(pid)}; sleep 0.2; fi`,
  );
  try {
    await t.start(world);
    await until(() => readStateLine(world.pool, "01-t.md"), (line) => line.status === "done", {
      ms: 10_000,
      what: "01 done long before the grandchild's minute is up",
    });
    const events = readEvents(world.pool, "01");
    const spawned = events.find((e) => e.kind === "spawned")!;
    const exited = events.find((e) => e.kind === "exited")!;
    // The harness exits about 0.2 s in; the 2 s grace ends the wait, not the pipe.
    expect(Date.parse(exited.at) - Date.parse(spawned.at)).toBeLessThan(5_000);
    expect(exited.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
    const log = readFileSync(join(world.pool, "runs", "01.log"), "utf8").split("\n");
    expect(log).toContain("harness done");
    expect(log).toContain("grandchild 1");
  } finally {
    killRecorded(pid);
  }
});

// live-attempts.test.ts:9 live attempts registry
conformance("attempts", "a terminal-backed Attempt is live with its pane while it runs and not after", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
  });
  const release = join(world.root, "release");
  world.stubs.script("_claude", { outcome: null, waitFor: release });
  const herdr = await t.herdr(world, { rendered: "Claude Code v2\n❯ " });
  const server = await t.start(world, { herdr });

  const running = await until(
    () => ticket(server.http, "01"),
    (found) => (found?.liveAttempt ?? null) !== null,
    { ms: 20_000, what: "01's Live attempt" },
  );
  const spawned = readEvents(world.pool, "01").find((e) => e.kind === "spawned")!;
  expect(spawned.payload.pane_id).toBe("w1:p1");
  expectParsedEqual(
    running!.liveAttempt,
    { attempt: 1, paneId: "w1:p1", role: "agent", startedAt: spawned.at },
    "01's liveAttempt while it runs",
  );

  writeFileSync(release, "");
  await eventsEnded(world, "01");
  const after = await until(() => ticket(server.http, "01"), (found) => found?.liveAttempt === null, {
    what: "01's Live attempt to clear",
  });
  expect(after!.liveAttempt).toBeNull();
});

// live-attempts.test.ts:19 live attempts registry
conformance("attempts", "a headless Attempt is live with a null pane, and has no pane to peek", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const release = join(world.root, "release");
  world.stubs.script("01", { waitFor: release });
  const server = await t.start(world);

  const running = await until(
    () => ticket(server.http, "01"),
    (found) => (found?.liveAttempt ?? null) !== null,
    { ms: 20_000, what: "01's Live attempt" },
  );
  const spawned = readEvents(world.pool, "01").find((e) => e.kind === "spawned")!;
  expectParsedEqual(
    running!.liveAttempt,
    { attempt: 1, paneId: null, role: "agent", startedAt: spawned.at },
    "01's liveAttempt",
  );
  const peek = await server.http.get("/api/terminal/peek?ticket=01");
  expect(peek.status).toBe(404);
  expectParsedEqual(peek.text, { error: "no terminal-backed pane for ticket 01" }, "the peek answer");
  writeFileSync(release, "");
  await eventsEnded(world, "01");
});

// live-attempts.test.ts:25 live attempts registry
conformance("attempts", "a fan-out's Live attempt is its highest live candidate, falling back as they end", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: 3 } } },
  });
  for (const n of [1, 2, 3]) world.stubs.script(`01.attempt-${n}`, { waitFor: join(world.root, `release-${n}`) });
  const server = await t.start(world);
  const live = async () => (await ticket(server.http, "01"))?.liveAttempt ?? null;
  const startedAt = (attempt: number) =>
    readEvents(world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === attempt)!.at;

  await until(
    () => readEvents(world.pool, "01"),
    (events) => events.filter((e) => e.kind === "spawned").length === 3,
    { ms: 20_000, what: "three candidates spawned" },
  );
  const all = await until(live, (record) => record?.attempt === 3, { what: "attempt 3 live" });
  expectParsedEqual(all, { attempt: 3, paneId: null, role: "agent", startedAt: startedAt(3) }, "with all three running");

  writeFileSync(join(world.root, "release-3"), "");
  const two = await until(live, (record) => record?.attempt === 2, { what: "the fall back to attempt 2" });
  expectParsedEqual(two, { attempt: 2, paneId: null, role: "agent", startedAt: startedAt(2) }, "once 3 has ended");

  writeFileSync(join(world.root, "release-2"), "");
  await until(live, (record) => record?.attempt === 1, { what: "the fall back to attempt 1" });
  writeFileSync(join(world.root, "release-1"), "");
  await until(live, (record) => record === null, { what: "no Live attempt once every candidate ended" });
  const exits = readEvents(world.pool, "01").filter((e) => e.kind === "exited").map((e) => e.attempt);
  expect(exits).toEqual([3, 2, 1]);
});

// live-attempts.test.ts:60 live attempts registry
conformance("attempts", "an enlisted pane's Live attempt is stamped when it was registered", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-t.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
  });
  const herdr = await t.herdr(world);
  await herdr.control("seedAgent", {
    paneId: "pane-op",
    agent: "claude",
    cwd: world.repo,
    title: "op",
    status: "idle",
    rendered: "Claude Code v2\n❯ ",
    tabId: "tab-op",
  });
  const server = await t.start(world, { herdr });

  const before = Date.now();
  const answer = await server.http.post("/api/enlist", { becomes: "ticket", paneId: "pane-op", title: "Do it", spec: "spec" });
  const after = Date.now();
  expect(answer.status).toBe(201);
  expectParsedEqual(answer.text, { ticketId: "enlist-1" }, "the enlist answer");

  const enlisted = await ticket(server.http, "enlist-1");
  const record = enlisted!.liveAttempt!;
  expect({ ...record, startedAt: "" }).toEqual({ attempt: 1, paneId: "pane-op", role: "agent", startedAt: "" });
  expect(record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const stamped = Date.parse(record.startedAt);
  expect(stamped).toBeGreaterThanOrEqual(before);
  expect(stamped).toBeLessThanOrEqual(after);
});
