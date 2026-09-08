/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVITY_CACHE_TTL_MS,
  createPoolServer,
  currentAttemptPaneIds,
  LOG_CHUNK_BYTES,
  resolveTerminalPane,
  spawnedPaneAllowlist,
  TERMINAL_PEEK_LINES,
  terminalSpawnRefusal,
  type PoolServer,
  type PoolServerOptions,
} from "./server.ts";
import { readFleetEntries } from "./fleet.ts";
import { appendEvent, type TicketEventKind } from "./events.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";
import { branchFor, worktreePathFor } from "./worktrees.ts";

const servers: PoolServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // The pool's true quiescence before the temp dir goes away: a test that
    // ends right after an answer leaves a fresh drive running its last
    // attempt, and a directory removed under that attempt makes its
    // continuation read deleted files, the stray ENOENT that fails
    // whichever test runs next. A drive that died reports its death through
    // settled()'s rejection, and by then the work it was driving is over,
    // so the cleanup still proceeds.
    //
    // A merge-held pool (ADR-0014) never settles by design: the hold keeps
    // the drive alive, with no attempt in flight, until the merge lands. The
    // settle wait therefore races a beat, so a held pool's cleanup proceeds
    // (nothing is mid-run to read a deleted file) while a settling pool still
    // gets its full quiescence before its directory goes away.
    await Promise.race([
      server.settled().catch(() => {}),
      Bun.sleep(2000),
    ]);
    await server.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makePool(
  tickets: { file: string; marker: string }[],
  config: Partial<PoolConfig> = {},
): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-server-"));
  tempDirs.push(poolDir);
  return makePoolInto(poolDir, tickets, config);
}

/** Write a pool's issues and console.json into a directory the caller chose. */
function makePoolInto(
  poolDir: string,
  tickets: { file: string; marker: string }[],
  config: Partial<PoolConfig> = {},
): string {
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of tickets) {
    writeFileSync(join(poolDir, "issues", ticket.file), `${ticket.marker}\n\n# body\n`);
  }
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify(
      { defaults: { harness: "stub", model: "m" }, ...config } satisfies PoolConfig,
      null,
      2,
    ),
  );
  return poolDir;
}

function stubHarness(behaviour: Record<string, ("done" | "checkpoint")[]>): Record<string, HarnessCommand> {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'status="$1"',
      'printf \'{"status":"%s","summary":"smoke","commitSha":null}\' "$status" > "$2"',
      "exit 0",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const harness: HarnessCommand = (ctx) => {
    const statuses = behaviour[ctx.id] ?? ["done"];
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const status = statuses[Math.min(n, statuses.length - 1)];
    return ["bash", stubPath, status, ctx.outcomePath];
  };
  return { stub: harness };
}

// A stub harness whose blocked tickets hold their spawned script until the
// sentinel file appears, so a test can keep a super-step in flight while it
// answers an interrupt. Every other ticket takes the instant path. A
// function sentinel resolves per ticket, so two tickets can block on their
// own files and be released one at a time.
function blockingHarness(
  behaviour: Record<string, { statuses?: ("done" | "checkpoint")[]; block?: boolean }>,
  sentinel: string | ((id: string) => string),
): Record<string, HarnessCommand> {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "blocking-stub.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'status="$1"; outcome_path="$2"; gate="$3"; sentinel="$4"',
      'if [ "$gate" = "block" ]; then',
      '  while [ ! -f "$sentinel" ]; do sleep 0.02; done',
      "fi",
      'printf \'{"status":"%s","summary":"smoke","commitSha":null}\' "$status" > "$outcome_path"',
      "exit 0",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const harness: HarnessCommand = (ctx) => {
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const b = behaviour[ctx.id] ?? {};
    const statuses = b.statuses ?? (["done"] as const);
    const status = statuses[Math.min(n, statuses.length - 1)];
    const release = typeof sentinel === "function" ? sentinel(ctx.id) : sentinel;
    return [
      "bash",
      stubPath,
      status,
      ctx.outcomePath,
      b.block ? "block" : "-",
      release,
    ];
  };
  return { stub: harness };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** A temp registry path inside the pool dir, so tests never touch the real one. */
function fleetRegistry(poolDir: string): string {
  return join(poolDir, "fleet.json");
}

async function startServer(
  poolDir: string,
  harnesses: Record<string, HarnessCommand>,
  options: { herdrSocket?: string; streamHeartbeatMs?: number } = {},
): Promise<PoolServer> {
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses,
    distDir: "/nonexistent",
    registryPath: fleetRegistry(poolDir),
    ...options,
  });
  servers.push(server);
  return server;
}

describe("pool server", () => {
  it("drives a pool to the review gate and serves the enriched state", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    await server.start();
    const snapshot = await server.settled();
    expect(snapshot.phase).toBe("quiescent");
    expect(snapshot.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const statuses = Object.fromEntries(snapshot.state.tickets.map((t) => [t.id, t.status]));
    expect(statuses).toEqual({ "01": "done", "02": "done" });
    expect(snapshot.state.tickets.map((t) => t.blockedBy)).toEqual([[], ["01"]]);
    expect(snapshot.state.tickets.map((t) => t.title)).toEqual(["body", "body"]);

    // Approving the review is acknowledged immediately and ends the run once
    // the answer is processed; the server stays up with the final state
    // inspectable.
    await server.answer(REVIEW_TICKET_ID, "approve");
    const approved = await server.settled();
    expect(approved.phase).toBe("done");
    expect(approved.state.interrupts).toEqual([]);
    expect(server.latest?.phase).toBe("done");
  });

  it("carries the terminal dead phase on the snapshot when the drive dies", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    // A harness command naming a binary that does not exist kills the drive
    // inside the first super-step (Bun.spawn throws). The pool's config
    // points its default harness ("stub") at it.
    const server = await startServer(poolDir, {
      stub: () => ["definitely-not-a-real-harness-binary"],
    });

    await server.start();
    // Registered before the spawn's rejection can settle the drive: the
    // settle microtask queues behind this call's synchronous continuation.
    await expect(server.settled()).rejects.toThrow(/Executable not found/);

    // The dead phase is on the enriched snapshot the Console receives, with
    // the pool log line beside it: a dead pool can no longer masquerade as a
    // live one.
    expect(server.latest?.phase).toBe("dead");
    expect(
      server.latest?.state.log.some((line) => line.startsWith("pool dead:")),
    ).toBe(true);
  });

  it("carries the pool's display name, the last two path segments, on the enriched snapshot", async () => {
    const shapes: [string, string][] = [
      ["ai-agent-graphs-fix/tickets", "ai-agent-graphs-fix/tickets"],
      ["other-worktree/tickets", "other-worktree/tickets"],
      ["repo/.scratch/tickets", ".scratch/tickets"],
    ];
    for (const [rel, expected] of shapes) {
      const root = mkdtempSync(join(tmpdir(), "pool-name-"));
      tempDirs.push(root);
      const poolDir = makePoolInto(join(root, rel), [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ]);
      const server = await startServer(poolDir, stubHarness({}));
      const snapshot = await server.start();
      expect(snapshot.poolName).toBe(expected);
      // Let the drive settle before afterEach removes the pool dir: a drive
      // still writing attempt logs when its dir vanishes fails an unrelated
      // test with the unhandled ENOENT.
      await server.settled();
    }
  });

  it("serves each ticket's resolved assignment on the enriched snapshot", async () => {
    const poolDir = makePool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
      ],
      {
        defaults: { harness: "stub", model: "default-model" },
        assign: {
          // Full override: the record is the assign entry field-wise.
          "02": { harness: "alt", model: "override-model", drivers: "bun review" },
          // Partial (model-only): the rest comes from the pool defaults.
          "03": { model: "partial-model" },
        },
      },
    );
    const stub = stubHarness({});
    const server = await startServer(poolDir, { ...stub, alt: stub.stub! });

    await server.start();
    const snapshot = await server.settled();
    expect(snapshot.phase).toBe("quiescent");
    const byId = Object.fromEntries(
      snapshot.state.tickets.map((t) => [t.id, t]),
    );
    // Pool defaults, drivers falling back to the engine's chain default.
    expect(byId["01"]!.assignment).toEqual({
      harness: "stub",
      model: "default-model",
      drivers: "implement",
    });
    expect(byId["02"]!.assignment).toEqual({
      harness: "alt",
      model: "override-model",
      drivers: "bun review",
    });
    expect(byId["03"]!.assignment).toEqual({
      harness: "stub",
      model: "partial-model",
      drivers: "implement",
    });
  });

  it("renders an unassigned ticket with null harness and model, and dies naming the fix when it schedules", async () => {
    const poolDir = makePool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      // Empty defaults override the helper's seeded ones: the pool reads as
      // a console.json without a defaults block.
      { defaults: {} },
    );
    const server = await startServer(poolDir, stubHarness({}));

    await server.start();
    await expect(server.settled()).rejects.toThrow(
      /pool config: ticket 01 has no harness/,
    );
    // The unassigned record rode the snapshot as the pool started; the run
    // then died at the spawn the ticket cannot run, with the fix named.
    expect(server.latest?.phase).toBe("dead");
    expect(server.latest?.state.tickets[0]!.assignment).toEqual({
      harness: null,
      model: null,
      drivers: "implement",
    });
    expect(server.latest?.state.log).toContain(
      "pool dead: pool config: ticket 01 has no harness (set one in console.json assign or defaults)",
    );
  });

  it("serves get state, start, and resume over HTTP", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));

    await server.start();
    const first = await server.settled();
    expect(first.phase).toBe("quiescent");
    expect(first.state.interrupts[0]?.kind).toBe("checkpoint");
    expect(first.state.tickets[0]?.status).toBe("checkpoint");

    const stateRes = await fetch(`${server.url}/api/state`);
    const stateBody = (await stateRes.json()) as { snapshot: typeof first };
    expect(stateBody.snapshot.phase).toBe("quiescent");

    // The answer is acknowledged with 202 at acceptance. The pool is idle,
    // so processing follows synchronously and the snapshot the 202 carries
    // already shows it: no queued answer waiting, the interrupt gone.
    const resumeRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "01", action: "resume", note: "go on" }),
    });
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { snapshot: typeof first };
    expect(resumeBody.snapshot.state.queuedAnswers).toEqual([]);
    expect(
      resumeBody.snapshot.state.interrupts.some((i) => i.ticketId === "01"),
    ).toBe(false);

    const resumed = await server.settled();
    expect(resumed.phase).toBe("quiescent");
    expect(resumed.state.tickets[0]?.status).toBe("done");
    expect(resumed.state.interrupts[0]?.kind).toBe("review");

    const approveRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: REVIEW_TICKET_ID, action: "approve" }),
    });
    expect(approveRes.status).toBe(202);
    const approved = await server.settled();
    expect(approved.phase).toBe("done");
  });

  it("acknowledges a retried answer with 202 and no duplicate; a stranger answer still 400s", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));
    await server.start();
    const first = await server.settled();
    expect(first.state.interrupts[0]?.kind).toBe("checkpoint");

    const post = (body: unknown) =>
      fetch(`${server.url}/api/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const resumeRes = await post({ ticketId: "01", action: "resume", note: "go on" });
    expect(resumeRes.status).toBe(202);
    const resumed = await server.settled();
    expect(resumed.state.tickets.find((t) => t.id === "01")?.status).toBe("done");
    expect(resumed.state.interrupts[0]?.kind).toBe("review");

    // The client timed out waiting and retried the same answer. The
    // interrupt is already processed and gone, but the accepted answer is in
    // the store, so the retry is acknowledged again rather than erroring.
    const retryRes = await post({ ticketId: "01", action: "resume", note: "go on" });
    expect(retryRes.status).toBe(202);

    // No second answered event and no second queued record were written.
    const events = readFileSync(join(poolDir, "runs", "01.events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });
    expect(events.filter((e) => e.kind === "answered")).toHaveLength(1);
    const queue = JSON.parse(
      readFileSync(join(poolDir, "runs", "queued-answers.json"), "utf8"),
    ) as { answers: unknown[] };
    expect(queue.answers).toHaveLength(1);

    // Approvals are idempotent the same way, once the review gate is down.
    const approveRes = await post({ ticketId: REVIEW_TICKET_ID, action: "approve" });
    expect(approveRes.status).toBe(202);
    await server.settled();
    const approveRetry = await post({ ticketId: REVIEW_TICKET_ID, action: "approve" });
    expect(approveRetry.status).toBe(202);

    // A ticket with no pending interrupt and no accepted answer still 400s.
    const strangerRes = await post({ ticketId: "02", action: "resume" });
    expect(strangerRes.status).toBe(400);
  });

  it("answers 400 for a review reject that names no ticket, recording nothing", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    const first = await server.settled();
    expect(first.state.interrupts[0]?.kind).toBe("review");

    // A reject whose note names no ticket is genuinely invalid: the 400
    // comes back from acceptance, and no answered event or queued record is
    // written for an answer that had no effect.
    const rejectRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: REVIEW_TICKET_ID,
        action: "reject",
        note: "this is not good enough",
      }),
    });
    expect(rejectRes.status).toBe(400);
    const body = (await rejectRes.json()) as { error: string };
    expect(body.error).toMatch(/name at least one ticket/);

    const state = await fetch(`${server.url}/api/state`);
    const stateBody = (await state.json()) as { snapshot: typeof first };
    expect(stateBody.snapshot.state.interrupts[0]?.kind).toBe("review");
    expect(stateBody.snapshot.state.queuedAnswers).toEqual([]);
    expect(existsSync(join(poolDir, "runs", "queued-answers.json"))).toBe(false);
    const reviewEvents = join(poolDir, "runs", `${REVIEW_TICKET_ID}.events.jsonl`);
    if (existsSync(reviewEvents)) {
      expect(readFileSync(reviewEvents, "utf8")).not.toContain('"answered"');
    }

    // The gate still works: a reject that does name a ticket is accepted.
    const validRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: REVIEW_TICKET_ID,
        action: "reject",
        note: "redo 01",
      }),
    });
    expect(validRes.status).toBe(202);
    const rejected = await server.settled();
    expect(rejected.phase).toBe("quiescent");
    expect(rejected.state.interrupts[0]?.kind).toBe("review");
    expect(readFileSync(join(poolDir, "issues", "01-a.md"), "utf8")).toContain(
      "## Review note",
    );

    const approveRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: REVIEW_TICKET_ID, action: "approve" }),
    });
    expect(approveRes.status).toBe(202);
    await server.settled();
  });

  it("carries queued answers in the 202, /api/state, and SSE while a super-step is in flight", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
    ]);
    const sentinel = join(poolDir, "release-03");
    const server = await startServer(
      poolDir,
      blockingHarness(
        {
          "01": { statuses: ["checkpoint", "done"] },
          "03": { statuses: ["done"], block: true },
        },
        sentinel,
      ),
    );
    await server.start();
    // Super-step 1 checkpoints 01 and finishes 02; super-step 2 spawns 03 and
    // holds it open on the sentinel, with 01's interrupt pending throughout.
    await waitFor(
      () =>
        server.latest?.state.interrupts.some((i) => i.ticketId === "01") === true &&
        server.latest.state.tickets.find((t) => t.id === "03")?.status === "in-progress",
      "super-step in flight with 01's interrupt pending",
    );
    type Snap = NonNullable<PoolServer["latest"]>;

    // The 202's snapshot: the interrupt still pending, the answer visible as
    // queued against it.
    const resumeRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "01", action: "resume", note: "go on" }),
    });
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { snapshot: Snap };
    expect(
      resumeBody.snapshot.state.interrupts.some((i) => i.ticketId === "01"),
    ).toBe(true);
    expect(resumeBody.snapshot.state.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(resumeBody.snapshot.state.queuedAnswers[0]?.kind).toBe("checkpoint");

    const stateRes = await fetch(`${server.url}/api/state`);
    const stateBody = (await stateRes.json()) as { snapshot: Snap };
    expect(stateBody.snapshot.state.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);

    // An SSE client connecting now replays the latest snapshot, queue included.
    const res = await fetch(`${server.url}/api/stream`);
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let data = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !data.includes('"queuedAnswers"')) {
      const { value, done } = await reader!.read();
      if (done) break;
      data += decoder.decode(value, { stream: true });
    }
    await reader!.cancel();
    expect(data).toContain('"ticketId":"01"');

    // Processing at the boundary clears the waiting state on the snapshot
    // that follows, with no re-poll.
    writeFileSync(sentinel, "go");
    await server.settled();
    const clearedRes = await fetch(`${server.url}/api/state`);
    const cleared = (await clearedRes.json()) as { snapshot: Snap };
    expect(cleared.snapshot.state.queuedAnswers).toEqual([]);
    expect(
      cleared.snapshot.state.interrupts.some((i) => i.ticketId === "01"),
    ).toBe(false);
  }, 15000);

  it("streams the latest snapshot to an SSE client on connect", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.settled();
    await server.answer(REVIEW_TICKET_ID, "approve");
    await server.settled();

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let data = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !data.includes('"phase"')) {
      const { value, done } = await reader!.read();
      if (done) break;
      data += decoder.decode(value, { stream: true });
    }
    expect(data).toContain("event: snapshot");
    expect(data).toContain('"phase":"done"');
    await reader!.cancel();
  });

  it("keeps the stream open through more than ten seconds of a quiet pool", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));
    await server.start();
    // The pool now waits at the checkpoint interrupt: the stream goes silent.

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let data = "";
    while (!data.includes('"phase"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before the replayed snapshot");
      data += decoder.decode(value, { stream: true });
    }

    // A dropped stream rejects the pending read rather than ending cleanly.
    let closed = false;
    const nextFrame = reader.read().then(
      ({ done }) => {
        if (done) closed = true;
      },
      () => {
        closed = true;
      },
    );
    // The default ten-second timeout's close reaches the client a couple of
    // seconds late, so wait well past both.
    await Bun.sleep(14_000);
    expect(closed).toBe(false);

    // The same connection still delivers the next broadcast after the silence.
    await server.answer("01", "resume");
    const arrived = await Promise.race([
      nextFrame.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    expect(arrived).toBe(true);
    expect(closed).toBe(false);
    await reader.cancel();
    // The resume re-ran the ticket: let that drive settle before afterEach
    // removes the pool dir, or its mid-run reads fail an unrelated test with
    // the unhandled ENOENT.
    await server.settled();
  }, 25_000);

  it("pushes an SSE heartbeat comment frame on the snapshot stream", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}), {
      streamHeartbeatMs: 40,
    });
    await server.start();
    await server.settled();

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let data = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !data.includes(": heartbeat")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before a heartbeat frame");
      data += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    // The heartbeat is a comment frame: nothing but the comment line, so a
    // browser EventSource dispatches no event for it.
    const frames = data.split("\n\n");
    const heartbeat = frames.find((f) => f.includes(": heartbeat"));
    expect(heartbeat).toBe(": heartbeat");
  });
});

describe("ticket events endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves a ticket's parsed events after a run", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.settled();
    await server.answer(REVIEW_TICKET_ID, "approve");
    // Let the closing drive settle before afterEach removes the pool dir: a
    // drive still working when its dir vanishes fails an unrelated test with
    // the unhandled ENOENT.
    await server.settled();

    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { at: string; attempt: number; kind: string; payload: Record<string, unknown> }[];
      attempts: unknown[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(false);
    expect(body.attempts).toEqual([]);
    expect(body.events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(body.events[0].attempt).toBe(1);
    expect(typeof body.events[0].at).toBe("string");
    const exited = body.events.find((e) => e.kind === "exited");
    expect(exited?.payload).toEqual({
      code: 0,
      status: "done",
      logTail: [],
      outcomeExists: true,
    });
  });

  it("backfills reconstructed attempt rows for a ticket with no events file", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "first attempt output\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second attempt output\n");
    // Distinct modification times, so the reconstruction orders the attempts
    // the way they happened.
    const now = Date.now();
    utimesSync(join(runsDir, "01.log"), new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(join(runsDir, "01.attempt-2.log"), new Date(now), new Date(now));

    const server = await startServer(poolDir, stubHarness({}));
    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      attempts: { attempt: number; logFile: string; modifiedAt: string }[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.attempts).toEqual([
      {
        attempt: 1,
        logFile: "01.log",
        modifiedAt: new Date(now - 60_000).toISOString(),
      },
      {
        attempt: 2,
        logFile: "01.attempt-2.log",
        modifiedAt: new Date(now).toISOString(),
      },
    ]);
  });

  it("rejects a ticket id the pool does not own", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/events?ticket=zzz`);
    expect(res.status).toBe(404);
  });

  it("serves the ticket's spec text alongside its events", async () => {
    const poolDir = mkdtempSync(join(tmpdir(), "pool-server-"));
    tempDirs.push(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    writeFileSync(
      join(poolDir, "issues", "01-a.md"),
      `${marker}\n\n# Ticket body\n\nSpec: what to build\n\n## Details\nmore\n`,
    );
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ defaults: { harness: "stub", model: "m" } }, null, 2),
    );
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.settled();

    const res = await fetch(`${server.url}/api/events?ticket=01`);
    const body = (await res.json()) as { spec: string };
    expect(body.spec).toContain("what to build");
    expect(body.spec).not.toContain("Ticket body");
  });
});

describe("pool meta refresh", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("renders a ticket file added after boot as a card on the next snapshot", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));

    await server.start();
    const first = await server.settled();
    expect(first.state.tickets.map((t) => t.id)).toEqual(["01"]);

    // A ticket file lands after boot, the way the engine writes a Spawn
    // adoption: an ordinary issues/<id>.md with the usual line-1 marker.
    writeFileSync(
      join(poolDir, "issues", "02-late.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# body\n",
    );

    // Answering 01's checkpoint drives fresh snapshots; the enriched state
    // carries the late ticket's card without a restart.
    await server.answer("01", "resume");
    const resumed = await server.settled();
    const late = resumed.state.tickets.find((t) => t.id === "02");
    expect(late).toBeDefined();
    expect(late?.title).toBe("body");
    expect(late?.blockedBy).toEqual([]);
  });

  it("accepts a late-arriving ticket id on the events and log endpoints", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    // No start: the server serves its boot state, and the ticket file plus
    // an attempt log land afterwards. Both endpoints answer for the late id
    // the way they would for one present at boot.
    writeFileSync(
      join(poolDir, "issues", "02-late.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# body\n",
    );
    mkdirSync(join(poolDir, "runs"), { recursive: true });
    writeFileSync(join(poolDir, "runs", "02.log"), "late attempt output\n");

    const events = await fetch(`${server.url}/api/events?ticket=02`);
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as {
      events: unknown[];
      reconstructed: boolean;
      attempts: { attempt: number; logFile: string }[];
    };
    expect(eventsBody.reconstructed).toBe(true);
    expect(eventsBody.events).toEqual([]);
    expect(eventsBody.attempts.map((a) => [a.attempt, a.logFile])).toEqual([
      [1, "02.log"],
    ]);

    const log = await fetch(`${server.url}/api/log?ticket=02`);
    expect(log.status).toBe(200);
    const logBody = (await log.json()) as { content: string };
    expect(logBody.content).toContain("late attempt output");
  });
});

describe("grades endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves each ticket's latest grade, skipping tickets without one", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
    ]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 4, verdict: "flag", reasons: "first" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T11:00:00.000Z",
      attempt: 2,
      kind: "graded",
      payload: { score: 8, verdict: "pass", reasons: "second" },
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      grades: Record<
        string,
        { attempt: number; score: number; verdict: string; winner: number | null }
      >;
    };
    expect(body.grades).toEqual({
      "01": { attempt: 2, score: 8, verdict: "pass", winner: null },
    });
  });

  it("names the selected attempt as winner while its merge is still pending", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 9, verdict: "pass", reasons: "winner" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T11:00:00.000Z",
      attempt: 2,
      kind: "graded",
      payload: { score: 5, verdict: "flag", reasons: "loser, graded last" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T12:00:00.000Z",
      attempt: 1,
      kind: "selected",
      payload: { score: 9, margin: 4, rule: "outright" },
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as {
      grades: Record<
        string,
        { attempt: number; score: number; verdict: string; winner: number | null }
      >;
    };
    expect(body.grades).toEqual({
      "01": { attempt: 1, score: 9, verdict: "pass", winner: 1 },
    });
  });

  it("serves nothing when the selected winner's own grade is malformed", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 9, verdict: "pass" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T11:00:00.000Z",
      attempt: 2,
      kind: "graded",
      payload: { score: 5, verdict: "flag", reasons: "loser" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T12:00:00.000Z",
      attempt: 1,
      kind: "selected",
      payload: { score: 9, margin: 4, rule: "outright" },
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as { grades: Record<string, unknown> };
    expect(body.grades).toEqual({});
  });

  it("serves the merged attempt's grade when there is no selected event", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 7, verdict: "pass", reasons: "winner" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T11:00:00.000Z",
      attempt: 2,
      kind: "graded",
      payload: { score: 3, verdict: "flag", reasons: "loser, graded last" },
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T12:00:00.000Z",
      attempt: 1,
      kind: "merged",
      payload: {},
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as {
      grades: Record<
        string,
        { attempt: number; score: number; verdict: string; winner: number | null }
      >;
    };
    expect(body.grades).toEqual({
      "01": { attempt: 1, score: 7, verdict: "pass", winner: 1 },
    });
  });

  it("serves no grade for a graded event without reasons", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 8, verdict: "pass" },
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as { grades: Record<string, unknown> };
    expect(body.grades).toEqual({});
  });

  it("skips a graded event whose payload is malformed", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: "eight" },
    });
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as { grades: Record<string, unknown> };
    expect(body.grades).toEqual({});
  });
});

describe("merge pending enrichment", () => {
  const DONE_01 = "<!-- state: id=01 blocked-by=none status=done -->";

  interface EnrichedTicketWire {
    id: string;
    status: string;
    mergePending: boolean;
  }

  /**
   * A git repo with the pool inside. Markers come in pre-set done, so the
   * engine boots into the review gate without running anything, and the
   * caller parks branches by hand: the derivation reads only markers and
   * branch state, so a hand-made park is exactly what a conflicted merge
   * leaves behind.
   */
  function makeGitPool(
    tickets: { file: string; marker: string }[],
  ): { root: string; poolDir: string; run: (args: string[]) => void } {
    const root = mkdtempSync(join(tmpdir(), "pool-git-"));
    tempDirs.push(root);
    const poolDir = join(root, "pool");
    makePoolInto(poolDir, tickets, {});
    const run = (args: string[]): void => {
      const probe = Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (probe.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${probe.stderr.toString()}`,
        );
      }
    };
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "pool@test"]);
    run(["config", "user.name", "pool"]);
    writeFileSync(join(root, "base.txt"), "base\n");
    run(["add", "base.txt"]);
    run(["commit", "-qm", "base"]);
    return { root, poolDir, run };
  }

  /** Park pool/<id> with one commit main does not have. */
  function parkBranch(root: string, run: (args: string[]) => void, id: string): void {
    run(["checkout", "-q", "-b", branchFor(root, id)]);
    writeFileSync(join(root, `w-${id}.txt`), `work for ${id}\n`);
    run(["add", `w-${id}.txt`]);
    run(["commit", "-qm", `work ${id}`]);
    run(["checkout", "-q", "main"]);
  }

  async function ticketsOf(server: PoolServer): Promise<EnrichedTicketWire[]> {
    const res = await fetch(`${server.url}/api/state`);
    const body = (await res.json()) as {
      snapshot: { state: { tickets: EnrichedTicketWire[] } } | null;
    };
    return body.snapshot?.state.tickets ?? [];
  }

  it("labels a done ticket whose parked branch has not landed, and drops the label once it lands", async () => {
    const { root, poolDir, run } = makeGitPool([{ file: "01-a.md", marker: DONE_01 }]);
    parkBranch(root, run, "01");
    const server = await startServer(poolDir, stubHarness({}));
    // The parked branch is exactly the merge hold (ADR-0014): the engine's
    // drive pauses on it rather than settling, so the label is read from the
    // first snapshot and the serve-time re-derivation, never from a settle.
    await server.start();

    // Parked and unmerged: the emit-time enrichment carries the label.
    expect(server.latest?.state.tickets[0]).toMatchObject({
      id: "01",
      status: "done",
      mergePending: true,
    });

    // A manual CLI merge, branch kept and now an ancestor of the working
    // branch, lifts the label on the next snapshot without any Console
    // action. The ticket is still done; only the merge was pending.
    run(["merge", "--no-edit", branchFor(root, "01")]);
    expect((await ticketsOf(server))[0]).toMatchObject({
      id: "01",
      status: "done",
      mergePending: false,
    });

    // A branch that is gone reads as merged the same way: the engine
    // deletes it once its own merge lands.
    run(["checkout", "-q", "-B", branchFor(root, "01")]);
    writeFileSync(join(root, "again.txt"), "more\n");
    run(["add", "again.txt"]);
    run(["commit", "-qm", "again"]);
    run(["checkout", "-q", "main"]);
    expect((await ticketsOf(server))[0]?.mergePending).toBe(true);
    run(["branch", "-D", branchFor(root, "01")]);
    expect((await ticketsOf(server))[0]?.mergePending).toBe(false);
  });

  it("reads the merge target as the working branch, so a feature branch holds a label main would clear", async () => {
    const { root, poolDir, run } = makeGitPool([
      { file: "01-a.md", marker: DONE_01 },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=done -->" },
    ]);
    // 02 lands in main, then feature/x is cut from main BEFORE that merge:
    // the work is in main but not in the branch the pool works on.
    run(["checkout", "-q", "-b", branchFor(root, "02")]);
    writeFileSync(join(root, "w-02.txt"), "work 02\n");
    run(["add", "w-02.txt"]);
    run(["commit", "-qm", "work 02"]);
    run(["checkout", "-q", "main"]);
    run(["merge", "--no-edit", branchFor(root, "02")]);
    run(["checkout", "-q", "-b", "feature/x", "main~1"]);
    writeFileSync(join(root, "f.txt"), "feature\n");
    run(["add", "f.txt"]);
    run(["commit", "-qm", "feature"]);
    parkBranch(root, run, "01");
    run(["checkout", "-q", "feature/x"]);
    const server = await startServer(poolDir, stubHarness({}));
    // The hold stands here (both done tickets are unmerged into feature/x),
    // so the drive never settles; the labels are served from the first
    // snapshot's enrichment.
    await server.start();

    const byId = new Map(
      (await ticketsOf(server)).map((t) => [t.id, t]),
    );
    // Unmerged anywhere: pending.
    expect(byId.get("01")).toMatchObject({ status: "done", mergePending: true });
    // Merged into main but not into feature/x: still pending. The target is
    // the working branch, not main.
    expect(byId.get("02")).toMatchObject({ status: "done", mergePending: true });
  });

  it("drops the label when the ticket reopens: a restart re-derives and the re-run's merge lands", async () => {
    const { root, poolDir, run } = makeGitPool([{ file: "01-a.md", marker: DONE_01 }]);
    parkBranch(root, run, "01");
    const first = await startServer(poolDir, stubHarness({}));
    await first.start();
    expect((await ticketsOf(first))[0]).toMatchObject({
      status: "done",
      mergePending: true,
    });
    await first.close();

    // The engine reopens a ticket by writing its marker; the restarted
    // server rehydrates from that write alone, no persisted label anywhere.
    const file = join(poolDir, "issues", "01-a.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("status=done", "status=ready"));
    rmSync(join(poolDir, "runs", "server.pid"));
    const second = await startServer(poolDir, stubHarness({}));
    await second.start();
    await second.settled();

    // The re-run reused the parked branch and merged it clean, so the
    // ticket is done again with nothing pending.
    expect((await ticketsOf(second))[0]).toMatchObject({
      status: "done",
      mergePending: false,
    });
    expect(existsSync(worktreePathFor(root, "01"))).toBe(false);
  });
});

describe("ticket body endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves the ticket's body for an exact <id>.md file", async () => {
    const poolDir = makePool([{ file: "01.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.id).toBe("01");
    expect(body.body).toBe("# body\n");
  });

  it("resolves an <id>-<slug>.md file by its prefix before the first '-'", async () => {
    const poolDir = makePool([{ file: "01-ticket-body.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.id).toBe("01");
    expect(body.body).toBe("# body\n");
  });

  it("strips the line-1 state marker from the served body", async () => {
    const poolDir = mkdtempSync(join(tmpdir(), "pool-server-"));
    tempDirs.push(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    writeFileSync(
      join(poolDir, "issues", "01-a.md"),
      `${marker}\n\n# Ticket body\n\nSpec: what to build\n`,
    );
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ defaults: { harness: "stub", model: "m" } }, null, 2),
    );
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.body).not.toContain("<!--");
    expect(body.body).toBe("# Ticket body\n\nSpec: what to build\n");
  });

  it("answers 404 for an id with no Issue file", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/ticket?id=zzz`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});

describe("ticket log endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves an attempt's log from a byte offset with the total size", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "0123456789abcdef\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=4`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      offset: number;
      nextOffset: number;
      totalSize: number;
      attempts: unknown[];
    };
    expect(body.offset).toBe(4);
    expect(body.content).toBe("456789abcdef\n");
    expect(body.totalSize).toBe(17);
    expect(body.nextOffset).toBe(17);
    expect(body.attempts).toEqual([
      {
        attempt: 1,
        kind: "reconstructed",
        logFile: "01.log",
        streamFile: null,
        current: true,
      },
    ]);
  });

  it("strips ANSI escape sequences from the served content", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "01.log"),
      "line \u001b[31mred\u001b[0m text\n\u001b]0;title\u0007next\n",
    );
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("line red text\nnext\n");
  });

  it("pages a log larger than one chunk through offsets", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const big = "x".repeat(LOG_CHUNK_BYTES + 16) + "\n";
    writeFileSync(join(runsDir, "01.log"), big);
    const server = await startServer(poolDir, stubHarness({}));

    const first = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=0`);
    const firstBody = (await first.json()) as {
      content: string;
      nextOffset: number;
      totalSize: number;
    };
    expect(firstBody.content).toHaveLength(LOG_CHUNK_BYTES);
    expect(firstBody.nextOffset).toBe(LOG_CHUNK_BYTES);
    expect(firstBody.totalSize).toBe(big.length);

    const second = await fetch(
      `${server.url}/api/log?ticket=01&attempt=1&offset=${firstBody.nextOffset}`,
    );
    const secondBody = (await second.json()) as { content: string; nextOffset: number };
    expect(secondBody.content).toBe("x".repeat(16) + "\n");
    expect(secondBody.nextOffset).toBe(big.length);
  });

  it("does not split a multi-byte UTF-8 character across a chunk boundary", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // A two-byte char (é = U+00E9) whose first byte lands at the end of the
    // first chunk: the range must trim the partial lead byte, so the second
    // read brings the full char back and nothing decodes as U+FFFD.
    const lead = "a".repeat(LOG_CHUNK_BYTES - 1);
    writeFileSync(join(runsDir, "01.log"), lead + "é tail\n");
    const server = await startServer(poolDir, stubHarness({}));

    const first = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=0`);
    const firstBody = (await first.json()) as {
      content: string;
      nextOffset: number;
    };
    expect(firstBody.content).not.toContain("\uFFFD");
    expect(firstBody.nextOffset).toBe(LOG_CHUNK_BYTES - 1);

    const second = await fetch(
      `${server.url}/api/log?ticket=01&attempt=1&offset=${firstBody.nextOffset}`,
    );
    const secondBody = (await second.json()) as { content: string };
    expect(secondBody.content).toBe("é tail\n");
    expect(secondBody.content).not.toContain("\uFFFD");
  });

  it("does not split a multi-byte UTF-8 character at a range's head", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // é = U+00E9 is two bytes, at byte offsets 10 and 11. A tail-first open or
    // load-earlier read can request an offset mid-character: a range starting
    // at byte 11 (a continuation byte) must drop the partial char and report
    // the adjusted offset, so the pane head never decodes as U+FFFD.
    writeFileSync(join(runsDir, "01.log"), `${"a".repeat(10)}é tail\n`);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=11`);
    const body = (await res.json()) as {
      content: string;
      offset: number;
      nextOffset: number;
      totalSize: number;
    };
    expect(body.content).toBe(" tail\n");
    expect(body.content).not.toContain("\uFFFD");
    expect(body.offset).toBe(12);
    expect(body.nextOffset).toBe(18);
    expect(body.totalSize).toBe(18);
  });

  it("returns empty content for an offset at or past the end", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "short\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=100`);
    const body = (await res.json()) as { content: string; totalSize: number };
    expect(body.content).toBe("");
    expect(body.totalSize).toBe(6);
  });

  it("serves a bounded range when end is given, for load-earlier prefix reads", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "0123456789abcdef\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=4&end=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      offset: number;
      nextOffset: number;
      totalSize: number;
    };
    expect(body.offset).toBe(4);
    expect(body.content).toBe("456789");
    expect(body.nextOffset).toBe(10);
    expect(body.totalSize).toBe(17);
  });

  it("clamps a requested end to one chunk past the offset", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const big = "x".repeat(LOG_CHUNK_BYTES + 16) + "\n";
    writeFileSync(join(runsDir, "01.log"), big);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(
      `${server.url}/api/log?ticket=01&attempt=1&offset=0&end=${big.length}`,
    );
    const body = (await res.json()) as { content: string; nextOffset: number };
    expect(body.content).toHaveLength(LOG_CHUNK_BYTES);
    expect(body.nextOffset).toBe(LOG_CHUNK_BYTES);
  });

  it("trims a partial UTF-8 character at a bounded range's end", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // é = U+00E9 is two bytes, at byte offsets 10 and 11: a range ending at 11
    // holds only the lead byte and must trim it.
    writeFileSync(join(runsDir, "01.log"), `${"a".repeat(10)}é tail\n`);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=0&end=11`);
    const body = (await res.json()) as { content: string; nextOffset: number };
    expect(body.content).toBe("a".repeat(10));
    expect(body.content).not.toContain("\uFFFD");
    expect(body.nextOffset).toBe(10);
  });

  it("lists event-based attempts with their rotated log files and stream files", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // Implement attempt 1 rotated away, resolver attempt 2 current, implement
    // attempt 3 current.
    writeFileSync(
      join(runsDir, "01.events.jsonl"),
      [
        JSON.stringify({ at: "t", attempt: 1, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 1, kind: "exited", payload: {} }),
        JSON.stringify({ at: "t", attempt: 2, kind: "resolver", payload: {} }),
        JSON.stringify({ at: "t", attempt: 3, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 3, kind: "exited", payload: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(runsDir, "01.attempt-1.log"), "first\n");
    writeFileSync(join(runsDir, "01.resolver.log"), "resolver\n");
    writeFileSync(join(runsDir, "01.log"), "third\n");
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.resolver.stream.jsonl"), "stream-resolver\n");
    writeFileSync(join(runsDir, "01.stream.jsonl"), "stream-third\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      attempts: {
        attempt: number;
        kind: string;
        logFile: string;
        streamFile: string | null;
        current: boolean;
      }[];
    };
    // The older rotated log is readable through its attempt number.
    expect(body.content).toBe("first\n");
    expect(body.attempts).toEqual([
      {
        attempt: 1,
        kind: "implement",
        logFile: "01.attempt-1.log",
        streamFile: "01.attempt-1.stream.jsonl",
        current: false,
      },
      {
        attempt: 2,
        kind: "resolver",
        logFile: "01.resolver.log",
        streamFile: "01.resolver.stream.jsonl",
        current: true,
      },
      {
        attempt: 3,
        kind: "implement",
        logFile: "01.log",
        streamFile: "01.stream.jsonl",
        current: true,
      },
    ]);

    const third = await fetch(`${server.url}/api/log?ticket=01&attempt=3`);
    const thirdBody = (await third.json()) as { content: string };
    expect(thirdBody.content).toBe("third\n");
  });

  it("serves an attempt's stream file through the same byte-range path", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "01.events.jsonl"),
      [
        JSON.stringify({ at: "t", attempt: 1, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 1, kind: "exited", payload: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(runsDir, "01.log"), "derived log\n");
    writeFileSync(join(runsDir, "01.stream.jsonl"), '{"type":"assistant"}\n');
    const server = await startServer(poolDir, stubHarness({}));

    // The well-known Stream file belongs to the current attempt; a stream
    // request reads it through the same ANSI-stripped, byte-ranged reader
    // the derived log goes through.
    const res = await fetch(
      `${server.url}/api/log?ticket=01&attempt=1&offset=1&end=5&stream=1`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      offset: number;
      nextOffset: number;
      totalSize: number;
    };
    expect(body.content).toBe('"typ');
    expect(body.offset).toBe(1);
    expect(body.nextOffset).toBe(5);
    expect(body.totalSize).toBe(21);
    // The derived log keeps serving under the plain request.
    const log = await fetch(`${server.url}/api/log?ticket=01&attempt=1`);
    expect(((await log.json()) as { content: string }).content).toBe("derived log\n");
  });

  it("answers 404 with a no-stream-file error for an attempt that has none", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // Attempt 1 streamed, attempt 2 (current) is a raw-harness run whose
    // only file is the derived log.
    writeFileSync(
      join(runsDir, "01.events.jsonl"),
      [
        JSON.stringify({ at: "t", attempt: 1, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 1, kind: "exited", payload: {} }),
        JSON.stringify({ at: "t", attempt: 2, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 2, kind: "exited", payload: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(runsDir, "01.attempt-1.log"), "one\n");
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.log"), "two\n");
    const server = await startServer(poolDir, stubHarness({}));

    const listing = await fetch(`${server.url}/api/log?ticket=01&attempt=2`);
    const listingBody = (await listing.json()) as {
      attempts: {
        attempt: number;
        kind: string;
        logFile: string;
        streamFile: string | null;
        current: boolean;
      }[];
    };
    expect(listingBody.attempts).toEqual([
      { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl", current: false },
      { attempt: 2, kind: "implement", logFile: "01.log", streamFile: null, current: true },
    ]);
    // The attempt exists, so the error names the missing stream file rather
    // than an unknown attempt; a truly unknown attempt still 404s as before.
    const streamRes = await fetch(
      `${server.url}/api/log?ticket=01&attempt=2&stream=1`,
    );
    expect(streamRes.status).toBe(404);
    expect(((await streamRes.json()) as { error: string }).error).toBe(
      "no stream file for attempt 2 of 01",
    );
    const unknownRes = await fetch(
      `${server.url}/api/log?ticket=01&attempt=99&stream=1`,
    );
    expect(unknownRes.status).toBe(404);
    expect(((await unknownRes.json()) as { error: string }).error).toBe(
      "unknown attempt 99 for 01",
    );
  });

  it("serves a verify fan-out's current attempt through its attempt-numbered log", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // A verify fan-out: three attempts, none ever holding the well-known
    // log path.
    writeFileSync(
      join(runsDir, "01.events.jsonl"),
      [
        JSON.stringify({ at: "t", attempt: 1, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 2, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 3, kind: "spawned", payload: {} }),
        JSON.stringify({ at: "t", attempt: 3, kind: "exited", payload: {} }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(runsDir, "01.attempt-1.log"), "first\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second\n");
    writeFileSync(join(runsDir, "01.attempt-3.log"), "third\n");
    // A fan-out of streamed attempts: every attempt's Stream file is
    // attempt-numbered, the well-known name never appearing.
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.attempt-2.stream.jsonl"), "stream-two\n");
    writeFileSync(join(runsDir, "01.attempt-3.stream.jsonl"), "stream-three\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      attempts: { attempt: number; kind: string; logFile: string; streamFile: string | null; current: boolean }[];
    };
    // The current attempt reads its own attempt-numbered log: the pane must
    // not serve an empty file for a fan-out's live attempt.
    expect(body.content).toBe("third\n");
    expect(body.attempts).toEqual([
      { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl", current: false },
      { attempt: 2, kind: "implement", logFile: "01.attempt-2.log", streamFile: "01.attempt-2.stream.jsonl", current: false },
      { attempt: 3, kind: "implement", logFile: "01.attempt-3.log", streamFile: "01.attempt-3.stream.jsonl", current: true },
    ]);

    const stream = await fetch(
      `${server.url}/api/log?ticket=01&attempt=2&stream=1`,
    );
    expect(((await stream.json()) as { content: string }).content).toBe(
      "stream-two\n",
    );
  });

  it("defaults to the latest attempt when none is named", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "latest\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01`);
    const body = (await res.json()) as { content: string; attempts: unknown[] };
    expect(body.content).toBe("latest\n");
    expect(body.attempts).toHaveLength(1);
  });

  it("rejects an unknown attempt number", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "latest\n");
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=99`);
    expect(res.status).toBe(404);
  });

  it("rejects a ticket id the pool does not own", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=zzz&attempt=1`);
    expect(res.status).toBe(404);
  });
});

describe("ticket activity endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  interface ActivityBody {
    ticketId: string;
    running: boolean;
    diff: { added: number; removed: number; files: string[] } | null;
    log: { size: number; mtime: string } | null;
    lastEventAt: string | null;
  }

  /** A real temporary git repo, to be an attempt's recorded worktree. */
  function makeGitRepo(seed: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "activity-worktree-"));
    tempDirs.push(dir);
    const run = (args: string[]): void => {
      const probe = Bun.spawnSync(["git", "-C", dir, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (probe.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${probe.stderr.toString()}`,
        );
      }
    };
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "pool@test"]);
    run(["config", "user.name", "pool"]);
    for (const [path, content] of Object.entries(seed)) {
      writeFileSync(join(dir, path), content);
    }
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
    return dir;
  }

  function seedEvents(
    poolDir: string,
    ticketId: string,
    events: {
      at: string;
      attempt: number;
      kind: TicketEventKind;
      payload?: Record<string, unknown>;
    }[],
  ): void {
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    for (const event of events) {
      appendEvent(runsDir, ticketId, {
        at: event.at,
        attempt: event.attempt,
        kind: event.kind,
        payload: event.payload ?? {},
      });
    }
  }

  const T0 = "2026-01-01T00:00:00.000Z";
  const ev = (
    attempt: number,
    kind: TicketEventKind,
    payload: Record<string, unknown> = {},
  ) => ({ at: T0, attempt, kind, payload });
  const spawnedIn = (repo: string) =>
    ev(1, "spawned", { cwd: repo, branch: branchFor(repo, "01") });

  async function getActivity(
    server: PoolServer,
    id = "01",
  ): Promise<{ status: number; body: ActivityBody }> {
    const res = await fetch(`${server.url}/api/activity?ticket=${id}`);
    return { status: res.status, body: (await res.json()) as ActivityBody };
  }

  it("totals a mixed staged, unstaged and untracked worktree diff", async () => {
    const repo = makeGitRepo({
      "tracked-a.txt": "base\n",
      "tracked-b.txt": "keep\n",
    });
    const run = (args: string[]) =>
      Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    // staged: +3 −1 on tracked-a
    writeFileSync(join(repo, "tracked-a.txt"), "one\ntwo\nthree\n");
    run(["add", "tracked-a.txt"]);
    // unstaged: +1 on tracked-b
    writeFileSync(join(repo, "tracked-b.txt"), "keep\nextra\n");
    // untracked: +4
    writeFileSync(join(repo, "new-file.md"), "a\nb\nc\nd\n");
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness({}));

    const { status, body } = await getActivity(server);
    expect(status).toBe(200);
    expect(body.ticketId).toBe("01");
    expect(body.diff).toEqual({
      added: 8,
      removed: 1,
      files: ["tracked-a.txt", "tracked-b.txt", "new-file.md"],
    });
  });

  it("caps untracked files at 100 and line-counts only files under 256KB", async () => {
    const repo = makeGitRepo({ "seed.txt": "seed\n" });
    for (let i = 1; i <= 101; i++) {
      writeFileSync(join(repo, `u-${String(i).padStart(3, "0")}.txt`), "line\n");
    }
    // Over the per-file read cap: still a touched file, but no line counts.
    writeFileSync(join(repo, "big.bin"), "x".repeat(300 * 1024));
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness({}));

    const { body } = await getActivity(server);
    // big.bin sorts first, so it takes a slot and 99 small files fit under
    // the cap; u-100.txt and u-101.txt fall past it.
    expect(body.diff?.files).toHaveLength(100);
    expect(body.diff?.files).toContain("big.bin");
    expect(body.diff?.files).not.toContain("u-101.txt");
    expect(body.diff?.added).toBe(99);
    expect(body.diff?.removed).toBe(0);
  });

  it("serves diff null for legacy events with no recorded cwd", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [
      ev(1, "spawned"),
      ev(1, "exited", { code: 0, status: "done" }),
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    const { status, body } = await getActivity(server);
    expect(status).toBe(200);
    expect(body.diff).toBeNull();
    expect(body.running).toBe(false);
    expect(body.lastEventAt).toBe(T0);
  });

  it("serves an empty payload for a ticket with no events at all", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const { body } = await getActivity(server);
    expect(body).toEqual({
      ticketId: "01",
      running: false,
      diff: null,
      log: null,
      lastEventAt: null,
    });
  });

  it("404s an unknown ticket id", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/activity?ticket=zzz`);
    expect(res.status).toBe(404);
  });

  it("reports the attempt log's size and last write with the ticket's last event time", async () => {
    const repo = makeGitRepo({ "seed.txt": "seed\n" });
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "hello\n");
    utimesSync(join(runsDir, "01.log"), new Date(0), new Date(1000));
    seedEvents(poolDir, "01", [
      spawnedIn(repo),
      ev(1, "exited", { code: 0, status: "done" }),
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    const { body } = await getActivity(server);
    expect(body.log).toEqual({ size: 6, mtime: "1970-01-01T00:00:01.000Z" });
    expect(body.lastEventAt).toBe(T0);
    expect(body.running).toBe(false);
  });

  it("reports running only while the latest attempt is live", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker },
      { file: "02-b.md", marker: marker.replace("id=01", "id=02") },
      { file: "03-c.md", marker: marker.replace("id=01", "id=03") },
      { file: "04-d.md", marker: marker.replace("id=01", "id=04") },
    ]);
    // 01: an implement attempt in flight.
    seedEvents(poolDir, "01", [ev(1, "spawned")]);
    // 02: parked at a checkpoint.
    seedEvents(poolDir, "02", [
      ev(1, "spawned"),
      ev(1, "exited", { code: 0, status: "checkpoint" }),
      ev(1, "checkpoint"),
    ]);
    // 03: a conflicted merge, resolver attempt in flight.
    seedEvents(poolDir, "03", [
      ev(1, "spawned"),
      ev(1, "exited", { code: 0, status: "done" }),
      ev(1, "merge-conflict"),
      ev(2, "resolver"),
    ]);
    // 04: the same, but the human has answered the approval interrupt.
    seedEvents(poolDir, "04", [
      ev(1, "spawned"),
      ev(1, "exited", { code: 0, status: "done" }),
      ev(1, "merge-conflict"),
      ev(2, "resolver"),
      ev(2, "answered"),
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    expect((await getActivity(server, "01")).body.running).toBe(true);
    expect((await getActivity(server, "02")).body.running).toBe(false);
    expect((await getActivity(server, "03")).body.running).toBe(true);
    expect((await getActivity(server, "04")).body.running).toBe(false);
  });

  it("serves the cached payload for repeat requests inside the TTL", async () => {
    const repo = makeGitRepo({ "seed.txt": "seed\n" });
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness({}));

    const first = await getActivity(server);
    expect(first.body.diff).toEqual({ added: 0, removed: 0, files: [] });
    // A change inside the TTL is not reflected yet.
    writeFileSync(join(repo, "fresh.txt"), "one\ntwo\n");
    const second = await getActivity(server);
    expect(second.body).toEqual(first.body);
    // Once the TTL has passed, the change shows up.
    await Bun.sleep(ACTIVITY_CACHE_TTL_MS + 50);
    const third = await getActivity(server);
    expect(third.body.diff).toEqual({
      added: 2,
      removed: 0,
      files: ["fresh.txt"],
    });
  });
});

function writePidFile(poolDir: string, pid: number): void {
  mkdirSync(join(poolDir, "runs"), { recursive: true });
  writeFileSync(join(poolDir, "runs", "server.pid"), `${pid}\n`);
}

/** A real pid that has exited and been reaped, so it probes as dead. */
function deadPid(): number {
  const child = spawnSync("true");
  if (!child.pid) throw new Error("failed to spawn a child for a dead pid");
  return child.pid;
}

function makeLockedPool(): string {
  return makePool([
    { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
  ]);
}

/**
 * A pool for CLI-level tests: one ticket that is already done, so the boot
 * never spawns a real harness, with a harness name that resolves.
 */
function makeCliPool(): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-cli-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  writeFileSync(
    join(poolDir, "issues", "01-a.md"),
    "<!-- state: id=01 blocked-by=none status=done -->\n\n# body\n",
  );
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify({ defaults: { harness: "claude", model: "m" } }, null, 2),
  );
  return poolDir;
}

describe("pool lock", () => {
  it("writes its own pid on a successful boot", () => {
    const poolDir = makeLockedPool();
    const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
      `${process.pid}`,
    );
  });

  it("refuses a live lock, naming the live pid and the pool directory", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    let message = "";
    try {
      createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(process.pid));
    expect(message).toContain(poolDir);
    expect(message).not.toContain("on port");
  });

  it("names the live server's port when the registry knows it", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const registryPath = join(poolDir, "pools.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { poolDir, port: 8799, pid: process.pid, startedAt: "t" },
      ]),
    );
    expect(() =>
      createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath }),
    ).toThrow("on port 8799");
  });

  it("takes over a stale pid file on boot", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, deadPid());
    const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
      `${process.pid}`,
    );
  });

  it("takes over a pid file that is not a positive integer", () => {
    for (const bogus of ["0", "-1", "not-a-pid", ""]) {
      const poolDir = makeLockedPool();
      mkdirSync(join(poolDir, "runs"), { recursive: true });
      writeFileSync(join(poolDir, "runs", "server.pid"), bogus);
      const server = createPoolServer({ poolDir, port: 0, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
      servers.push(server);
      expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
        `${process.pid}`,
      );
    }
  });

  it("has no force override: a live lock refuses even when forced", () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const forced = {
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath: fleetRegistry(poolDir),
      force: true,
    } as unknown as PoolServerOptions;
    expect(() => createPoolServer(forced)).toThrow(/locked by live server/);
  });

  it("two near-simultaneous launches cannot both pass the lock; the loser names the winner", async () => {
    const poolDir = makeCliPool();
    const registryPath = fleetRegistry(poolDir);
    const repoDir = join(import.meta.dir, "..");
    const args = [
      "bun",
      "run",
      "engine/server.ts",
      "--pool",
      poolDir,
      "--port",
      "0",
      "--registry",
      registryPath,
    ];
    const childA = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const childB = Bun.spawn(args, { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    // Exactly one launch holds the lock and serves; the other exits non-zero
    // naming the winner's pid. The first to exit is the loser.
    const loser = await Promise.race([
      childA.exited.then(() => childA),
      childB.exited.then(() => childB),
    ]);
    const winner = loser === childA ? childB : childA;
    const exitCode = await loser.exited;
    expect(exitCode).not.toBe(0);
    const stderr = await new Response(loser.stderr).text();
    expect(stderr).toContain("locked by live server");
    expect(stderr).toContain(String(winner.pid));
    winner.kill();
    await winner.exited;
  });

  it("exits non-zero from the CLI against a live lock, naming pid and pool", async () => {
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    const repoDir = join(import.meta.dir, "..");
    const child = Bun.spawn(
      ["bun", "run", "engine/server.ts", "--pool", poolDir, "--port", "8799"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(String(process.pid));
    expect(stderr).toContain(poolDir);
  });
});

const portMarker = "<!-- state: id=01 blocked-by=none status=ready -->";

/** Bind a real socket on an ephemeral port and keep it open. */
async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("held") });
  const port = server.port;
  if (port === undefined) throw new Error("failed to bind an ephemeral port");
  return { port, release: () => server.stop(true) };
}

/** A port that is free right now, on an ephemeral range. */
async function freePort(): Promise<number> {
  const held = await holdPort();
  const port = held.port;
  await held.release();
  return port;
}

describe("pinned pool ports", () => {
  it("binds the console.json port on every launch", async () => {
    const port = await freePort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port });
    const serverA = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(serverA);
    expect(serverA.url).toBe(`http://localhost:${port}`);
    await serverA.close();
    // Relaunch the same pool: the previous server is gone, so its pid is stale
    // and the lock lets the new boot take over and bind the same pin.
    writePidFile(poolDir, deadPid());
    const serverB = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(serverB);
    expect(serverB.url).toBe(`http://localhost:${port}`);
  });

  it("a failed pinned bind clears the lock it claimed, so a retry can boot", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    // The failed boot must not leave a live-looking pid, or the retry refuses.
    expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
    await held.release();
    const server = createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${held.port}`);
  });

  it("refuses a busy console.json pin, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    await held.release();
  });

  it("refuses a busy --port pin, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    let message = "";
    try {
      createPoolServer({ poolDir, port: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    await held.release();
  });

  it("names the conflicting pool and pid on a busy pin when the registry knows the holder", async () => {
    const held = await holdPort();
    const holderPool = mkdtempSync(join(tmpdir(), "pool-holder-"));
    tempDirs.push(holderPool);
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
    const registryPath = join(poolDir, "pools.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { poolDir: holderPool, port: held.port, pid: process.pid, startedAt: "t" },
      ]),
    );
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    expect(message).toContain(holderPool);
    expect(message).toContain(String(process.pid));
    await held.release();
  });

  it("names a live holder's pool and pid when a second server boots into its pin", async () => {
    const port = await freePort();
    const holderPool = makePool([{ file: "01-a.md", marker: portMarker }], { port });
    const registryPath = fleetRegistry(holderPool);
    const holder = createPoolServer({
      poolDir: holderPool,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(holder);
    expect(holder.url).toBe(`http://localhost:${port}`);
    // The holder is a real, registered, live server. A second pool pinned to
    // the same port must fail naming the holder's pool directory and pid.
    const contenderPool = makePool([{ file: "01-a.md", marker: portMarker }], { port });
    let message = "";
    try {
      createPoolServer({
        poolDir: contenderPool,
        distDir: "/nonexistent",
        registryPath,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(port));
    expect(message).toContain(holderPool);
    expect(message).toContain(String(process.pid));
  });

  it("exits non-zero from the CLI on a busy pin, naming the holder from the registry", async () => {
    const held = await holdPort();
    const holderPool = mkdtempSync(join(tmpdir(), "pool-holder-"));
    tempDirs.push(holderPool);
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const registryPath = join(poolDir, "pools.json");
    writeFileSync(
      registryPath,
      JSON.stringify([
        { poolDir: holderPool, port: held.port, pid: process.pid, startedAt: "t" },
      ]),
    );
    const repoDir = join(import.meta.dir, "..");
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "engine/server.ts",
        "--pool",
        poolDir,
        "--port",
        String(held.port),
        "--registry",
        registryPath,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(holderPool);
    expect(stderr).toContain(String(process.pid));
    await held.release();
  });

  it("a failed launch never deletes a pid file naming another live server", async () => {
    const held = await holdPort();
    const poolDir = makeLockedPool();
    writePidFile(poolDir, process.pid);
    let message = "";
    try {
      createPoolServer({ poolDir, port: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("locked by live server");
    expect(readFileSync(join(poolDir, "runs", "server.pid"), "utf8").trim()).toBe(
      String(process.pid),
    );
    await held.release();
  });

  it("--port overrides the console.json pin for that launch", async () => {
    const configPort = await freePort();
    const flagPort = await freePort();
    expect(flagPort).not.toBe(configPort);
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }], { port: configPort });
    const server = createPoolServer({ poolDir, port: flagPort, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${flagPort}`);
  });

  it("with no pin, binds the default port when it is free", async () => {
    const port = await freePort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${port}`);
  });

  it("with no pin, hunts to the next free port when the default is busy", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).not.toBe(`http://localhost:${held.port}`);
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
    await held.release();
  });

  it("exits non-zero from the CLI when a --port pin is busy, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker: portMarker }]);
    const repoDir = join(import.meta.dir, "..");
    const child = Bun.spawn(
      ["bun", "run", "engine/server.ts", "--pool", poolDir, "--port", String(held.port)],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(String(held.port));
    await held.release();
  });
});

describe("fleet registration", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("upserts its entry in the registry after a successful bind", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    const entries = readFleetEntries(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      poolDir,
      pid: process.pid,
    });
    expect(typeof entries[0].port).toBe("number");
    expect(typeof entries[0].startedAt).toBe("string");
    expect(entries[0].port).toBe(Number(new URL(server.url).port));
  });

  it("relaunching the same pool updates the entry rather than duplicating", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    const serverA = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(serverA);
    const portA = Number(new URL(serverA.url).port);
    expect(readFleetEntries(registryPath)).toHaveLength(1);

    // Stop the first server and stale its pid, then relaunch: the pool's lock
    // passes, so the new server binds and upserts its own entry in place.
    await serverA.close();
    writePidFile(poolDir, deadPid());
    const serverB = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(serverB);
    const portB = Number(new URL(serverB.url).port);
    const entries = readFleetEntries(registryPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(process.pid);
    expect(entries[0].port).toBe(portB);
  });

  it("a corrupt registry file is recreated on write, not a boot failure", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = fleetRegistry(poolDir);
    writeFileSync(registryPath, "{ not json");
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    expect(readFleetEntries(registryPath)).toHaveLength(1);
  });

  it("an absent registry is created on write, not a boot failure", () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const registryPath = join(poolDir, "nested", "pools.json");
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath,
    });
    servers.push(server);
    expect(readFleetEntries(registryPath)).toHaveLength(1);
  });

  it("a failed bind registers nothing", async () => {
    const held = await holdPort();
    const poolDir = makePool([{ file: "01-a.md", marker }], { port: held.port });
    const registryPath = fleetRegistry(poolDir);
    let message = "";
    try {
      createPoolServer({ poolDir, distDir: "/nonexistent", registryPath });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(held.port));
    // Registration happens only after a successful bind: a failed boot must
    // never advertise a port in the registry.
    expect(readFleetEntries(registryPath)).toEqual([]);
    await held.release();
  });

  it("two servers booting different pools concurrently both end up in the registry", async () => {
    const poolA = makeCliPool();
    const poolB = makeCliPool();
    const registryPath = fleetRegistry(poolA);
    const repoDir = join(import.meta.dir, "..");
    const argsFor = (pool: string) => [
      "bun",
      "run",
      "engine/server.ts",
      "--pool",
      pool,
      "--port",
      "0",
      "--registry",
      registryPath,
    ];
    const childA = Bun.spawn(argsFor(poolA), { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    const childB = Bun.spawn(argsFor(poolB), { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    // Poll the raw registry until both pools have landed. The lock around the
    // write means the later writer reads the earlier entry, so neither boot
    // can overwrite the other.
    const deadline = Date.now() + 20_000;
    let entries: { poolDir: string; port: number; pid: number; startedAt: string }[] = [];
    while (Date.now() < deadline) {
      try {
        entries = JSON.parse(readFileSync(registryPath, "utf8")) as typeof entries;
      } catch {
        entries = [];
      }
      if (entries.length === 2) break;
      await Bun.sleep(50);
    }
    childA.kill();
    childB.kill();
    await Promise.all([childA.exited, childB.exited]);
    expect(entries.map((e) => e.poolDir).sort()).toEqual(
      [poolA, poolB].sort(),
    );
    expect(entries.map((e) => e.pid).sort()).toEqual(
      [childA.pid, childB.pid].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Terminal endpoints (peek and focus)
// ---------------------------------------------------------------------------

describe("terminal endpoints", () => {
  const fakeServers: import("node:net").Server[] = [];

  afterEach(async () => {
    while (fakeServers.length > 0) {
      const server = fakeServers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  interface TerminalFakeRequest {
    method: string;
    params: Record<string, unknown>;
  }

  interface TerminalFake {
    socketPath: string;
    requests: TerminalFakeRequest[];
    /** Per-pane recent-output text; a pane absent here reads as empty. */
    text: Record<string, string>;
    /** Methods forced to answer with a herdr-style error body. */
    fail: Record<string, unknown>;
  }

  /**
   * A fake herdr daemon for the terminal endpoints: newline-delimited
   * JSON-RPC, one request per connection. `pane.read` serves the per-pane
   * text table (revision always 0, exactly the stagnation the
   * implementation must not rely on); `pane.focus` just records. A foreign
   * pane seeded in the table stands in for a live agent session sharing
   * the daemon, which no endpoint may ever name.
   */
  function startFakeHerdr(seed?: { text?: Record<string, string> }): Promise<TerminalFake> {
    const requests: TerminalFakeRequest[] = [];
    const fake: TerminalFake = {
      socketPath: "",
      requests,
      text: { "pane-foreign": "someone else's agent\n", ...seed?.text },
      fail: {},
    };
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const newline = buf.indexOf("\n");
        if (newline < 0) return;
        const msg = JSON.parse(buf.slice(0, newline)) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        requests.push({ method: msg.method, params: msg.params });
        let response: Record<string, unknown>;
        if (msg.method in fake.fail) {
          response = { id: msg.id, error: fake.fail[msg.method] };
        } else if (msg.method === "pane.read") {
          const paneId = String(msg.params.pane_id ?? "");
          response = {
            id: msg.id,
            result: {
              read: {
                text: fake.text[paneId] ?? "",
                revision: 0,
                truncated: false,
              },
            },
          };
        } else if (msg.method === "pane.focus") {
          response = { id: msg.id, result: {} };
        } else {
          response = {
            id: msg.id,
            error: { code: -32601, message: `unknown method ${msg.method}` },
          };
        }
        socket.end(JSON.stringify(response) + "\n");
      });
    });
    fakeServers.push(server);
    const dir = mkdtempSync(join(tmpdir(), "herdr-terminal-"));
    tempDirs.push(dir);
    fake.socketPath = join(dir, "herdr.sock");
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(fake.socketPath, () => resolve(fake));
    });
  }

  /** A pool with three tickets; the caller writes the events each test needs. */
  function makeTerminalPool(): { poolDir: string; runsDir: string } {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
    ]);
    return { poolDir, runsDir: join(poolDir, "runs") };
  }

  function recordSpawned(runsDir: string, ticketId: string, attempt: number, paneId: string | null): void {
    appendEvent(runsDir, ticketId, {
      at: "2026-09-05T00:00:00Z",
      attempt,
      kind: "spawned",
      payload: { pane_id: paneId },
    });
  }

  function recordSettled(runsDir: string, ticketId: string, attempt: number, kind: "exited" | "crash" | "answered" | "merged"): void {
    appendEvent(runsDir, ticketId, {
      at: "2026-09-05T00:01:00Z",
      attempt,
      kind,
      payload: {},
    });
  }

  function startTerminalServer(poolDir: string, herdrSocket: string): PoolServer {
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath: fleetRegistry(poolDir),
      herdrSocket,
    });
    servers.push(server);
    return server;
  }

  it("peek translates the ticket id to the recorded pane id and serves its recent output", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    const fake = await startFakeHerdr({ text: { "pane-1": "working\nstill working" } });
    const server = startTerminalServer(poolDir, fake.socketPath);

    const res = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ticket: "01", paneId: "pane-1", text: "working\nstill working" });
    // The wire call is the prototype's verified peek shape. The line count is
    // at least a terminal height: a TUI fills the pane, and pane.read returns
    // only the last N rendered rows, so a small count reads empty or a footer
    // sliver (prototype/tui-prompt-paste/FINDINGS.md section 2, proven).
    expect(TERMINAL_PEEK_LINES).toBeGreaterThanOrEqual(80);
    expect(fake.requests).toEqual([
      {
        method: "pane.read",
        params: {
          pane_id: "pane-1",
          source: "recent",
          format: "text",
          strip_ansi: true,
          lines: TERMINAL_PEEK_LINES,
        },
      },
    ]);
  });

  it("focus calls pane.focus with the recorded pane id", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    const fake = await startFakeHerdr();
    const server = startTerminalServer(poolDir, fake.socketPath);

    const res = await fetch(`${server.url}/api/terminal/focus?ticket=01`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paneId: "pane-1" });
    expect(fake.requests).toEqual([
      { method: "pane.focus", params: { pane_id: "pane-1" } },
    ]);
  });

  it("never names a pane the pool did not spawn, and the guard refuses one", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    const fake = await startFakeHerdr();
    const server = startTerminalServer(poolDir, fake.socketPath);

    await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    await fetch(`${server.url}/api/terminal/focus?ticket=01`, { method: "POST" });
    // The daemon hosts a foreign live-agent pane; no request may name it.
    // This is the spawned-only guarantee end to end: the endpoints are keyed
    // by ticket id and translate only through the pool's own spawned events,
    // so there is no request that reaches herdr for an unrelated pane.
    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      expect(String(request.params.pane_id)).not.toBe("pane-foreign");
    }

    // The refusal behind the 403, at the unit seam: only pane ids the pool
    // recorded on a spawned event pass. End to end the guard cannot trip on
    // well-formed state (resolution and allowlist read the same events);
    // it exists so corrupted state still cannot point the Console at a
    // foreign pane.
    const meta = [{ id: "01" }] as Parameters<typeof spawnedPaneAllowlist>[1];
    const allowlist = spawnedPaneAllowlist(runsDir, meta);
    expect([...allowlist].sort()).toEqual(["pane-1"]);
    expect(terminalSpawnRefusal(allowlist, "pane-1")).toBeNull();
    expect(terminalSpawnRefusal(allowlist, "pane-foreign")).toContain(
      "not one this pool spawned",
    );
  });

  it("answers unknown, headless, and finished tickets with a clean no-pane 404", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    // Ticket 02 spawned headless: the recorded fallback fact is pane_id null.
    recordSpawned(runsDir, "02", 1, null);
    // Ticket 03 ran terminal-backed but its attempt has settled.
    recordSpawned(runsDir, "03", 1, "pane-3");
    recordSettled(runsDir, "03", 1, "exited");
    const fake = await startFakeHerdr();
    const server = startTerminalServer(poolDir, fake.socketPath);

    for (const ticket of ["02", "03", "99"]) {
      const peek = await fetch(`${server.url}/api/terminal/peek?ticket=${ticket}`);
      expect(peek.status).toBe(404);
      expect((await peek.json()).error).toBe(
        `no terminal-backed pane for ticket ${ticket}`,
      );
      const focus = await fetch(`${server.url}/api/terminal/focus?ticket=${ticket}`, {
        method: "POST",
      });
      expect(focus.status).toBe(404);
      expect((await focus.json()).error).toBe(
        `no terminal-backed pane for ticket ${ticket}`,
      );
    }
    // No-pane tickets never reach the daemon.
    expect(fake.requests).toEqual([]);
  });

  it("resolves the ticket's latest attempt's pane: a retry supersedes the old one", () => {
    const { runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-old");
    recordSettled(runsDir, "01", 1, "exited");
    recordSpawned(runsDir, "01", 2, "pane-new");
    expect(resolveTerminalPane(runsDir, "01")).toBe("pane-new");
    recordSettled(runsDir, "01", 2, "exited");
    expect(resolveTerminalPane(runsDir, "01")).toBeNull();
    expect(resolveTerminalPane(runsDir, "02")).toBeNull();
  });

  it("treats an empty read as empty text, not an error", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    // No text seeded: a background tab still warming up reads empty.
    const fake = await startFakeHerdr();
    const server = startTerminalServer(poolDir, fake.socketPath);

    const res = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "01", paneId: "pane-1", text: "" });
  });

  it("freshness comes from text, not revision: a stagnant revision still serves new text", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    const fake = await startFakeHerdr({ text: { "pane-1": "first" } });
    const server = startTerminalServer(poolDir, fake.socketPath);

    const first = await (await fetch(`${server.url}/api/terminal/peek?ticket=01`)).json();
    expect(first.text).toBe("first");
    fake.text["pane-1"] = "second";
    const second = await (await fetch(`${server.url}/api/terminal/peek?ticket=01`)).json();
    expect(second.text).toBe("second");
    // The response carries no revision at all: nothing downstream may rely
    // on it advancing (the fake serves revision 0 for both reads).
    expect("revision" in second).toBe(false);
  });

  it("a daemon failure is a clean 502, not a crash", async () => {
    const { poolDir, runsDir } = makeTerminalPool();
    recordSpawned(runsDir, "01", 1, "pane-1");
    const fake = await startFakeHerdr();
    fake.fail["pane.read"] = { code: -1, message: "daemon says no" };
    fake.fail["pane.focus"] = { code: -1, message: "daemon says no" };
    const server = startTerminalServer(poolDir, fake.socketPath);

    const peek = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(peek.status).toBe(502);
    expect((await peek.json()).error).toContain("daemon says no");
    const focus = await fetch(`${server.url}/api/terminal/focus?ticket=01`, {
      method: "POST",
    });
    expect(focus.status).toBe(502);
    expect((await focus.json()).error).toContain("daemon says no");
  });
});

describe("paneId enrichment (terminal-backed attempts)", () => {
  // ADR-0014: the spawned event records the attempt's pane_id; the server's
  // snapshot enrichment threads it to the card projection as paneId. These
  // tests drive real pools against a fake herdr daemon (the engine's herdr
  // socket is overridable per run, exactly as the engine tests do), never the
  // live daemon.

  const fakeHerdrServers: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    while (fakeHerdrServers.length > 0) {
      await fakeHerdrServers.pop()!.close();
    }
  });

  /**
   * A fake herdr daemon speaking the real wire shape (newline-delimited
   * JSON-RPC) and actually RUNNING what a pane is sent: the engine's wrapper
   * shell executes under bash in the pane's cwd, so the tee'd log, the
   * exit-code file, and the harness's outcome are all real, exactly as a
   * live herdr would produce them. Pane ends are pushed to events.subscribe
   * connections, the way herdr pushes subscribed events, and the connection
   * stays open after the ack — a daemon that closed it would turn every
   * terminal-backed attempt into the unbounded exit-code-file wait, which is
   * not the behavior under test. A method named in `fail` answers with a
   * herdr-style error body, the shape of a daemon refusing the call.
   */
  function startFakeHerdr(options?: { fail?: string[] }): Promise<{
    socketPath: string;
    requests: { method: string; params: Record<string, unknown> }[];
  }> {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    let minted = 0;
    const panes = new Map<string, { tabId: string; cwd: string; buffer: string }>();
    const subscribers: import("node:net").Socket[] = [];
    const connections = new Set<import("node:net").Socket>();
    const firePaneEnd = (paneId: string, event: "pane_exited" | "pane_closed"): void => {
      panes.delete(paneId);
      // herdr pushes every pane's events to every subscriber; the engine
      // filters by pane id. A subscriber whose wait already settled has
      // closed its end, so prune before broadcasting.
      for (const sub of [...subscribers]) {
        if (sub.destroyed || !sub.writable) {
          subscribers.splice(subscribers.indexOf(sub), 1);
          continue;
        }
        sub.write(
          JSON.stringify({
            event,
            data: { type: event, pane_id: paneId, workspace_id: "w1" },
          }) + "\n",
        );
      }
    };
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        if (!buf.includes("\n")) return;
        const msg = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        requests.push({ method: msg.method, params: msg.params });
        if (options?.fail?.includes(msg.method)) {
          socket.end(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: `${msg.method} refused` },
            }) + "\n",
          );
          return;
        }
        const respond = (result: unknown): void => {
          socket.end(JSON.stringify({ id: msg.id, result }) + "\n");
        };
        if (msg.method === "tab.create") {
          minted += 1;
          const tabId = `tab-${minted}`;
          panes.set(`pane-${minted}`, {
            tabId,
            cwd: String(msg.params.cwd ?? "/"),
            buffer: "",
          });
          respond({ tab: { tab_id: tabId } });
        } else if (msg.method === "pane.list") {
          respond({
            panes: [...panes.entries()].map(([paneId, pane]) => ({
              tab_id: pane.tabId,
              pane_id: paneId,
            })),
          });
        } else if (msg.method === "pane.send_input") {
          const pane = panes.get(String(msg.params.pane_id));
          if (pane) {
            if (typeof msg.params.text === "string") {
              pane.buffer += msg.params.text;
            }
            if (
              Array.isArray(msg.params.keys) &&
              msg.params.keys.includes("enter")
            ) {
              const command = pane.buffer;
              pane.buffer = "";
              const proc = Bun.spawn(["bash", "-c", command], {
                cwd: pane.cwd,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              });
              void proc.exited.then(() =>
                firePaneEnd(String(msg.params.pane_id), "pane_exited"),
              );
            }
          }
          respond({});
        } else if (msg.method === "events.subscribe") {
          // The ack answers this request; the connection then stays open and
          // receives pushed events until the teardown destroys it or the
          // subscriber's own end closes it (a settled wait releases its
          // socket, and firePaneEnd prunes closed subscribers).
          subscribers.push(socket);
          socket.on("close", () => {
            const at = subscribers.indexOf(socket);
            if (at !== -1) subscribers.splice(at, 1);
          });
          socket.write(
            JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n",
          );
        } else if (msg.method === "pane.close") {
          respond({ type: "ok" });
          firePaneEnd(String(msg.params.pane_id), "pane_closed");
        } else if (msg.method === "tab.close") {
          respond({ type: "ok" });
        } else {
          respond({});
        }
      });
    });
    fakeHerdrServers.push({
      close: () =>
        new Promise<void>((resolve) => {
          for (const sub of subscribers) sub.destroy();
          // bun's server.close() waits for every connection to drain, and a
          // request/response connection whose client already destroyed its
          // end can linger in a half-closed state that outlives the test.
          // Teardown destroys what is left instead of waiting on it.
          for (const conn of connections) conn.destroy();
          server.close(() => resolve());
        }),
    });
    const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "herdr.sock");
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, () => resolve({ socketPath, requests }));
    });
  }

  it("exposes each terminal-backed ticket's paneId on the enriched snapshot", async () => {
    const poolDir = makePool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    const fake = await startFakeHerdr();
    // A settled attempt's paneId drops from the snapshot by design (a
    // finished card's surface and polling stop), and no emit separates a
    // spawn from its exit while its siblings all run — the one emit that
    // catches attempts live is the sibling-exit emit. So the three ready
    // tickets share one super-step: 01 finishes (slowly enough that every
    // spawn below has been persisted), and its exit emit must still carry
    // 02 and 03's blocked attempts, each held open on its own sentinel
    // until the snapshot has been read.
    const release = {
      "02": join(poolDir, "release-02"),
      "03": join(poolDir, "release-03"),
    };
    const blocking = blockingHarness(
      { "02": { block: true }, "03": { block: true } },
      (id) => release[id as keyof typeof release]!,
    );
    const server = await startServer(
      poolDir,
      {
        stub: (ctx) =>
          ctx.id === "01"
            ? [
                "bash",
                "-c",
                `sleep 0.5; printf '{"status":"done","summary":"smoke","commitSha":null}' > '${ctx.outcomePath}'`,
              ]
            : blocking.stub(ctx),
      },
      {
        herdrSocket: fake.socketPath,
      },
    );

    await server.start();
    let live: { pane02: string; pane03: string } | null = null;
    await waitFor(() => {
      const tickets = server.latest?.state.tickets;
      const pane02 = tickets?.find((t) => t.id === "02")?.paneId;
      const pane03 = tickets?.find((t) => t.id === "03")?.paneId;
      live = typeof pane02 === "string" && typeof pane03 === "string" ? { pane02, pane03 } : null;
      return live !== null;
    }, "02 and 03's live attempts to expose paneIds on one snapshot");
    const { pane02, pane03 } = live!;
    // Every attempt of a terminal-backed pool opens its own named tab, so
    // each ticket's current attempt carries a distinct recovered pane id.
    expect(pane02).toMatch(/^pane-/);
    expect(pane03).toMatch(/^pane-/);
    expect(pane02).not.toBe(pane03);
    // The pane ids the enrichment serves are the ones the spawned events
    // record.
    const spawnedPane = (id: string): unknown =>
      readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; payload: { pane_id?: unknown } })
        .find((e) => e.kind === "spawned")?.payload.pane_id;
    expect(spawnedPane("02")).toBe(pane02);
    expect(spawnedPane("03")).toBe(pane03);
    // Release the held attempts and let the drive reach quiescence before
    // teardown; a merge-held pool never settles by design, so the wait
    // races the same beat the file-level cleanup uses.
    writeFileSync(release["02"], "");
    writeFileSync(release["03"], "");
    await Promise.race([
      server.settled().catch(() => {}),
      Bun.sleep(2000),
    ]);
  });

  it("exposes no paneId on a headless pool", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    await server.start();
    const snapshot = await server.settled();
    // Headless spawns record no pane facts at all, so the field is absent
    // rather than null: the card projection reads absence as "no surface".
    expect(snapshot.state.tickets[0]!.paneId).toBeUndefined();
  });

  it("exposes no paneId when the daemon refused the tab and the attempt fell back to headless", async () => {
    const poolDir = makePool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    const fake = await startFakeHerdr({ fail: ["tab.create"] });
    const server = await startServer(poolDir, stubHarness({}), {
      herdrSocket: fake.socketPath,
    });

    await server.start();
    const snapshot = await server.settled();
    // The fallback runs headless and still completes; the spawned event's
    // pane_id is null, so the enrichment exposes no paneId.
    expect(snapshot.state.tickets[0]!.status).toBe("done");
    expect(snapshot.state.tickets[0]!.paneId).toBeUndefined();
    const spawned = readFileSync(
      join(poolDir, "runs", "01.events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; payload: { pane_id?: unknown; terminal_error?: unknown } });
    const event = spawned.find((e) => e.kind === "spawned");
    expect(event?.payload.pane_id).toBeNull();
    expect(typeof event?.payload.terminal_error).toBe("string");
  });

  it("exposes no paneId when the tab opened but the wrapper send was refused and the attempt fell back to headless", async () => {
    const poolDir = makePool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    // The daemon accepts tab.create, so the attempt has a real pane; the
    // pane.send_input that would start the wrapper in it is refused, and the
    // spawn falls back to headless mid-flight.
    const fake = await startFakeHerdr({ fail: ["pane.send_input"] });
    const server = await startServer(poolDir, stubHarness({}), {
      herdrSocket: fake.socketPath,
    });

    await server.start();
    const snapshot = await server.settled();
    // The fallback runs headless and still completes; the spawned event
    // records the fallback (pane_id null + terminal_error), not the dead
    // pane id the fallback closed, so the enrichment exposes no paneId.
    expect(snapshot.state.tickets[0]!.status).toBe("done");
    expect(snapshot.state.tickets[0]!.paneId).toBeUndefined();
    // The close is fire-and-forget on the fallback path, so wait for the
    // daemon to have recorded it rather than racing the settled snapshot.
    await waitFor(
      () => fake.requests.some((r) => r.method === "pane.close"),
      "the fallback's orphaned pane close",
    );
    const spawned = readFileSync(
      join(poolDir, "runs", "01.events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; payload: { pane_id?: unknown; terminal_error?: unknown } });
    const event = spawned.find((e) => e.kind === "spawned");
    expect(event?.payload.pane_id).toBeNull();
    expect(typeof event?.payload.terminal_error).toBe("string");
  });
});

describe("currentAttemptPaneIds", () => {
  // The derivation the enrichment rides on: the ticket's latest spawned
  // event is the only source, so a string pane_id maps, and a later null
  // (the headless fallback) clears an earlier attempt's pane.

  function runsWith(events: Record<string, { attempt: number; pane_id?: unknown }[]>): string {
    const runsDir = join(mkdtempSync(join(tmpdir(), "pane-ids-")), "runs");
    tempDirs.push(join(runsDir, ".."));
    mkdirSync(runsDir, { recursive: true });
    for (const [id, list] of Object.entries(events)) {
      for (const event of list) {
        appendEvent(runsDir, id, {
          at: "2026-09-05T00:00:00Z",
          attempt: event.attempt,
          kind: "spawned",
          payload:
            event.pane_id === undefined ? {} : { pane_id: event.pane_id },
        });
      }
    }
    return runsDir;
  }

  const meta = [{ id: "01", file: "01.md", blockedBy: [], status: "ready" as const, title: "t", spec: "" }];

  it("maps the latest spawned event's string pane_id", () => {
    const runsDir = runsWith({
      "01": [
        { attempt: 1, pane_id: "pane-1" },
        { attempt: 2, pane_id: "pane-2" },
      ],
    });
    expect(currentAttemptPaneIds(runsDir, meta)).toEqual({ "01": "pane-2" });
  });

  it("omits a ticket whose latest spawn fell back to headless (pane_id null), even after a terminal-backed attempt", () => {
    const runsDir = runsWith({
      "01": [
        { attempt: 1, pane_id: "pane-1" },
        { attempt: 2, pane_id: null },
      ],
    });
    expect(currentAttemptPaneIds(runsDir, meta)).toEqual({});
  });

  it("omits headless spawns (no pane facts) and tickets with no events", () => {
    const runsDir = runsWith({
      "01": [{ attempt: 1 }],
      "02": [{ attempt: 1, pane_id: 42 }],
    });
    const two = [
      ...meta,
      { id: "02", file: "02.md", blockedBy: [], status: "ready" as const, title: "t", spec: "" },
    ];
    expect(currentAttemptPaneIds(runsDir, two)).toEqual({});
  });

  it("omits a ticket whose latest attempt has settled, so a finished card's surface and polling stop", () => {
    const runsDir = runsWith({
      "01": [
        { attempt: 1, pane_id: "pane-1" },
        { attempt: 2, pane_id: "pane-2" },
      ],
    });
    appendEvent(runsDir, "01", {
      at: "2026-09-05T00:01:00Z",
      attempt: 2,
      kind: "exited",
      payload: {},
    });
    // An earlier attempt settling changes nothing while the latest runs.
    appendEvent(runsDir, "02", {
      at: "2026-09-05T00:00:30Z",
      attempt: 1,
      kind: "exited",
      payload: {},
    });
    const two = [
      ...meta,
      { id: "02", file: "02.md", blockedBy: [], status: "ready" as const, title: "t", spec: "" },
    ];
    appendEvent(runsDir, "02", {
      at: "2026-09-05T00:02:00Z",
      attempt: 2,
      kind: "spawned",
      payload: { pane_id: "pane-2b" },
    });
    expect(currentAttemptPaneIds(runsDir, two)).toEqual({ "02": "pane-2b" });
  });
});
