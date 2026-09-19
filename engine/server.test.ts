/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  ACTIVITY_CACHE_TTL_MS,
  createPoolServer,
  LOG_CHUNK_BYTES,
  TERMINAL_MIN_BUN_VERSION,
  TERMINAL_PEEK_LINES,
  terminalRuntimeRefusal,
  type PoolServer,
  type PoolServerOptions,
} from "./server.ts";
import { readFleetEntries } from "./fleet.ts";
import { appendEvent, type TicketEventKind } from "./events.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";
import { branchExists, branchFor, worktreePathFor } from "./worktrees.ts";
import { readConversation } from "./conversations.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
  type ExecutingFakeHerdrOptions,
} from "./herdr-executing-fake.ts";
import { makeTempDir } from "./tmp.ts";
import {
  STUB_DEFAULTS,
  cleanupPools,
  makePool,
  registerTempDir,
  settleOrBeat,
  stubHarness,
} from "./pool-fixture.ts";

const servers: PoolServer[] = [];

afterEach(async () => {
  await cleanupPools(servers);
});

/** This suite's pools always carry a console.json with the stub defaults;
 *  the fixture's makePool writes one only when handed a config. */
function makeServerPool(
  tickets: { file: string; marker: string }[],
  config: Partial<PoolConfig> = {},
): string {
  return makePool({ tickets, config: { ...STUB_DEFAULTS, ...config } });
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

// A stub harness whose blocked tickets hold their spawned script until the
// sentinel file appears, so a test can keep a super-step in flight while it
// answers an interrupt. Every other ticket takes the instant path. A
// function sentinel resolves per ticket, so two tickets can block on their
// own files and be released one at a time.
function blockingHarness(
  poolDir: string,
  behaviour: Record<string, { statuses?: ("done" | "checkpoint")[]; block?: boolean }>,
  sentinel: string | ((id: string) => string),
): Record<string, HarnessCommand> {
  const stubPath = join(poolDir, "blocking-stub.sh");
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
  options: {
    herdrSocket?: string;
    streamHeartbeatMs?: number;
    onStopRequested?: () => void;
  } = {},
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
  // Issue #71: the server's own pre-flight meta load refused an empty
  // issues/ that startPool would have accepted, so a Conversation-only pool
  // exited 1 at "pool load: no Issue files" before the engine ever ran.
  it("boots a Conversation-only pool: empty issues/ beside a conversations/ directory", async () => {
    const poolDir = makeServerPool([]);
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const first = await server.start();
    expect(first.state.tickets).toEqual([]);
    // Zero Tickets settles at the review gate ("every ticket is done"), the
    // engine's existing behaviour for a Ticket-less pool (conversations.test.ts
    // accepts the same); what matters here is that the server got that far.
    const snapshot = await server.settled();
    expect(["quiescent", "done"]).toContain(snapshot.phase);
    expect(snapshot.state.tickets).toEqual([]);
  });

  it("still refuses a pool with an empty issues/ and no conversations/ directory, naming the opt-in", () => {
    const poolDir = makeServerPool([]);
    expect(() =>
      createPoolServer({
        poolDir,
        port: 0,
        harnesses: stubHarness(poolDir, {}).harnesses,
        distDir: "/nonexistent",
        registryPath: fleetRegistry(poolDir),
      }),
    ).toThrow(/no Issue files.*conversations\/ directory/);
  });

  // The same shared load carries the pool's Conversations as known parents:
  // before it, a Ticket a Conversation had spawned failed the server's own
  // parse ("spawned-by names no ticket") and never reached the Console.
  it("loads a Ticket whose spawned-by names a Conversation into the served meta", async () => {
    const poolDir = makeServerPool([
      {
        file: "conv-1-spawn-1.md",
        marker: "<!-- state: id=conv-1-spawn-1 blocked-by=none status=done spawned-by=conv-1 -->",
      },
    ]);
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    writeFileSync(
      join(poolDir, "conversations", "conv-1.md"),
      "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=stub " +
        "model=m drivers=implement -->\n\n# Talk\n\n\n",
    );
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const snapshot = await server.start();
    expect(snapshot.state.tickets.map((t) => t.id)).toEqual(["conv-1-spawn-1"]);
  });

  it("drives a pool to the review gate and serves the enriched state", async () => {
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([
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
      const root = makeTempDir("pool-name-");
      registerTempDir(root);
      const poolDir = makePoolInto(join(root, rel), [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ]);
      const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
      const snapshot = await server.start();
      expect(snapshot.poolName).toBe(expected);
      // Let the drive settle before afterEach removes the pool dir: a drive
      // still writing attempt logs when its dir vanishes fails an unrelated
      // test with the unhandled ENOENT.
      await server.settled();
    }
  });

  it("serves each ticket's resolved assignment on the enriched snapshot", async () => {
    const poolDir = makeServerPool(
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
    const stub = stubHarness(poolDir, {}).harnesses;
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
    const poolDir = makeServerPool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      // Empty defaults override the helper's seeded ones: the pool reads as
      // a console.json without a defaults block.
      { defaults: {} },
    );
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses);

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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses);
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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
    ]);
    const sentinel = join(poolDir, "release-03");
    const server = await startServer(
      poolDir,
      blockingHarness(
        poolDir,
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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses);
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
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses, {
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

  it("opens the snapshot stream with a frame publishing the heartbeat interval", async () => {
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses, {
      streamHeartbeatMs: 40,
    });
    await server.start();
    await server.settled();

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    // The opening frame carries the configured interval, ahead of the
    // replayed snapshot, so the client's silence window derives from it.
    const firstFrame = new TextDecoder().decode(value).split("\n\n")[0];
    expect(firstFrame).toBe('event: stream-config\ndata: {"heartbeatMs":40}');
  });
});

describe("ticket events endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves a ticket's parsed events after a run", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "first attempt output\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second attempt output\n");
    // Distinct modification times, so the reconstruction orders the attempts
    // the way they happened.
    const now = Date.now();
    utimesSync(join(runsDir, "01.log"), new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(join(runsDir, "01.attempt-2.log"), new Date(now), new Date(now));

    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/events?ticket=zzz`);
    expect(res.status).toBe(404);
  });

  it("serves the ticket's spec text alongside its events", async () => {
    const poolDir = makeTempDir("pool-server-");
    registerTempDir(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    writeFileSync(
      join(poolDir, "issues", "01-a.md"),
      `${marker}\n\n# Ticket body\n\nSpec: what to build\n\n## Details\nmore\n`,
    );
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ defaults: { harness: "stub", model: "m" } }, null, 2),
    );
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, { "01": { statuses: ["checkpoint", "done"] } }).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([
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
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as { grades: Record<string, unknown> };
    expect(body.grades).toEqual({});
  });

  it("serves the merged attempt's grade when there is no selected event", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: 8, verdict: "pass" },
    });
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/grades`);
    const body = (await res.json()) as { grades: Record<string, unknown> };
    expect(body.grades).toEqual({});
  });

  it("skips a graded event whose payload is malformed", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", {
      at: "2026-09-02T10:00:00.000Z",
      attempt: 1,
      kind: "graded",
      payload: { score: "eight" },
    });
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
  function makeRepoWithPool(
    tickets: { file: string; marker: string }[],
  ): { root: string; poolDir: string; run: (args: string[]) => void } {
    const root = makeTempDir("pool-git-");
    registerTempDir(root);
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

  it("labels a done ticket whose parked branch has not landed, and drops the label once a manual merge lands", async () => {
    const { root, poolDir, run } = makeRepoWithPool([{ file: "01-a.md", marker: DONE_01 }]);
    parkBranch(root, run, "01");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    // The parked branch is exactly the merge hold (ADR-0014): the engine's
    // drive pauses on it rather than settling, so the label is read from the
    // first snapshot's hold set, never from a settle.
    await server.start();

    // Parked and unmerged: the snapshot's hold set carries the label.
    expect(server.latest?.state.tickets[0]).toMatchObject({
      id: "01",
      status: "done",
      mergePending: true,
    });

    // A manual CLI merge, branch kept and now an ancestor of the working
    // branch, raises no snapshot of its own: the engine's hold watch (and
    // the held drive's own poll) notice it and emit, so the label lifts
    // without any Console action and the replay surface serves that emit
    // as it is. The ticket is still done; only the merge was pending.
    run(["merge", "--no-edit", branchFor(root, "01")]);
    let tickets: EnrichedTicketWire[] = [];
    await waitFor(() => {
      tickets = server.latest?.state.tickets ?? [];
      return tickets[0]?.mergePending === false;
    }, "the hold to lift on the snapshot after the manual merge");
    expect((await ticketsOf(server))[0]).toMatchObject({
      id: "01",
      status: "done",
      mergePending: false,
    });
    // The gone-branch reading (a deleted branch is landed) is pinned in
    // merge-hold.test.ts, on the one derivation this label comes from.
  });

  it("reads the merge target as the working branch, so a feature branch holds a label main would clear", async () => {
    const { root, poolDir, run } = makeRepoWithPool([
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
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const { root, poolDir, run } = makeRepoWithPool([{ file: "01-a.md", marker: DONE_01 }]);
    parkBranch(root, run, "01");
    const first = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const second = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
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
    const poolDir = makeServerPool([{ file: "01.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.id).toBe("01");
    expect(body.body).toBe("# body\n");
  });

  it("resolves an <id>-<slug>.md file by its prefix before the first '-'", async () => {
    const poolDir = makeServerPool([{ file: "01-ticket-body.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.id).toBe("01");
    expect(body.body).toBe("# body\n");
  });

  it("strips the line-1 state marker from the served body", async () => {
    const poolDir = makeTempDir("pool-server-");
    registerTempDir(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    writeFileSync(
      join(poolDir, "issues", "01-a.md"),
      `${marker}\n\n# Ticket body\n\nSpec: what to build\n`,
    );
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify({ defaults: { harness: "stub", model: "m" } }, null, 2),
    );
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/ticket?id=01`);
    const body = (await res.json()) as { id: string; body: string };
    expect(body.body).not.toContain("<!--");
    expect(body.body).toBe("# Ticket body\n\nSpec: what to build\n");
  });

  it("answers 404 for an id with no Issue file", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/ticket?id=zzz`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});

describe("ticket log endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves an attempt's log from a byte offset with the total size", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "0123456789abcdef\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "01.log"),
      "line \u001b[31mred\u001b[0m text\n\u001b]0;title\u0007next\n",
    );
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("line red text\nnext\n");
  });

  it("pages a log larger than one chunk through offsets", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const big = "x".repeat(LOG_CHUNK_BYTES + 16) + "\n";
    writeFileSync(join(runsDir, "01.log"), big);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // A two-byte char (é = U+00E9) whose first byte lands at the end of the
    // first chunk: the range must trim the partial lead byte, so the second
    // read brings the full char back and nothing decodes as U+FFFD.
    const lead = "a".repeat(LOG_CHUNK_BYTES - 1);
    writeFileSync(join(runsDir, "01.log"), lead + "é tail\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // é = U+00E9 is two bytes, at byte offsets 10 and 11. A tail-first open or
    // load-earlier read can request an offset mid-character: a range starting
    // at byte 11 (a continuation byte) must drop the partial char and report
    // the adjusted offset, so the pane head never decodes as U+FFFD.
    writeFileSync(join(runsDir, "01.log"), `${"a".repeat(10)}é tail\n`);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "short\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=100`);
    const body = (await res.json()) as { content: string; totalSize: number };
    expect(body.content).toBe("");
    expect(body.totalSize).toBe(6);
  });

  it("serves a bounded range when end is given, for load-earlier prefix reads", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "0123456789abcdef\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    const big = "x".repeat(LOG_CHUNK_BYTES + 16) + "\n";
    writeFileSync(join(runsDir, "01.log"), big);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(
      `${server.url}/api/log?ticket=01&attempt=1&offset=0&end=${big.length}`,
    );
    const body = (await res.json()) as { content: string; nextOffset: number };
    expect(body.content).toHaveLength(LOG_CHUNK_BYTES);
    expect(body.nextOffset).toBe(LOG_CHUNK_BYTES);
  });

  it("trims a partial UTF-8 character at a bounded range's end", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // é = U+00E9 is two bytes, at byte offsets 10 and 11: a range ending at 11
    // holds only the lead byte and must trim it.
    writeFileSync(join(runsDir, "01.log"), `${"a".repeat(10)}é tail\n`);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1&offset=0&end=11`);
    const body = (await res.json()) as { content: string; nextOffset: number };
    expect(body.content).toBe("a".repeat(10));
    expect(body.content).not.toContain("\uFFFD");
    expect(body.nextOffset).toBe(10);
  });

  it("lists event-based attempts with their rotated log files and stream files", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // Implement attempt 1 rotated away, resolver attempt 2 current, implement
    // attempt 3 current.
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "exited", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 2, kind: "resolver", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 3, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 3, kind: "exited", payload: {} });
    writeFileSync(join(runsDir, "01.attempt-1.log"), "first\n");
    writeFileSync(join(runsDir, "01.resolver.log"), "resolver\n");
    writeFileSync(join(runsDir, "01.log"), "third\n");
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.resolver.stream.jsonl"), "stream-resolver\n");
    writeFileSync(join(runsDir, "01.stream.jsonl"), "stream-third\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "exited", payload: {} });
    writeFileSync(join(runsDir, "01.log"), "derived log\n");
    writeFileSync(join(runsDir, "01.stream.jsonl"), '{"type":"assistant"}\n');
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // Attempt 1 streamed, attempt 2 (current) is a raw-harness run whose
    // only file is the derived log.
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "exited", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 2, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 2, kind: "exited", payload: {} });
    writeFileSync(join(runsDir, "01.attempt-1.log"), "one\n");
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.log"), "two\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    // A verify fan-out: three attempts, none ever holding the well-known
    // log path.
    appendEvent(runsDir, "01", { at: "t", attempt: 1, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 2, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 3, kind: "spawned", payload: {} });
    appendEvent(runsDir, "01", { at: "t", attempt: 3, kind: "exited", payload: {} });
    writeFileSync(join(runsDir, "01.attempt-1.log"), "first\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second\n");
    writeFileSync(join(runsDir, "01.attempt-3.log"), "third\n");
    // A fan-out of streamed attempts: every attempt's Stream file is
    // attempt-numbered, the well-known name never appearing.
    writeFileSync(join(runsDir, "01.attempt-1.stream.jsonl"), "stream-one\n");
    writeFileSync(join(runsDir, "01.attempt-2.stream.jsonl"), "stream-two\n");
    writeFileSync(join(runsDir, "01.attempt-3.stream.jsonl"), "stream-three\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "latest\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/log?ticket=01`);
    const body = (await res.json()) as { content: string; attempts: unknown[] };
    expect(body.content).toBe("latest\n");
    expect(body.attempts).toHaveLength(1);
  });

  it("rejects an unknown attempt number", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "latest\n");
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=99`);
    expect(res.status).toBe(404);
  });

  it("rejects a ticket id the pool does not own", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const dir = makeTempDir("activity-worktree-");
    registerTempDir(dir);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [
      ev(1, "spawned"),
      ev(1, "exited", { code: 0, status: "done" }),
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const { status, body } = await getActivity(server);
    expect(status).toBe(200);
    expect(body.diff).toBeNull();
    expect(body.running).toBe(false);
    expect(body.lastEventAt).toBe(T0);
  });

  it("serves an empty payload for a ticket with no events at all", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/activity?ticket=zzz`);
    expect(res.status).toBe(404);
  });

  it("reports the attempt log's size and last write with the ticket's last event time", async () => {
    const repo = makeGitRepo({ "seed.txt": "seed\n" });
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "hello\n");
    utimesSync(join(runsDir, "01.log"), new Date(0), new Date(1000));
    seedEvents(poolDir, "01", [
      spawnedIn(repo),
      ev(1, "exited", { code: 0, status: "done" }),
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const { body } = await getActivity(server);
    expect(body.log).toEqual({ size: 6, mtime: "1970-01-01T00:00:01.000Z" });
    expect(body.lastEventAt).toBe(T0);
    expect(body.running).toBe(false);
  });

  it("reports running while the snapshot shows a live attempt, and not once it has ended", async () => {
    // `running` is read from the last snapshot's Live attempt, never from
    // the events file: a real attempt held open, then released.
    const poolDir = makeServerPool([
      { file: "01-a.md", marker },
      { file: "02-b.md", marker: marker.replace("id=01", "id=02").replace("status=ready", "status=done") },
    ]);
    const sentinel = join(poolDir, "release-01");
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
    );
    await server.start();
    await waitFor(
      () => server.latest?.state.tickets.find((t) => t.id === "01")?.liveAttempt != null,
      "01's attempt to be live on the snapshot",
    );
    expect((await getActivity(server, "01")).body.running).toBe(true);
    // 02 was done before boot and never spawned: nothing live.
    expect((await getActivity(server, "02")).body.running).toBe(false);

    writeFileSync(sentinel, "");
    await server.settled();
    expect(server.latest?.state.tickets.find((t) => t.id === "01")?.liveAttempt).toBeNull();
    await Bun.sleep(ACTIVITY_CACHE_TTL_MS + 50);
    expect((await getActivity(server, "01")).body.running).toBe(false);
  });

  it("serves the cached payload for repeat requests inside the TTL", async () => {
    const repo = makeGitRepo({ "seed.txt": "seed\n" });
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
    seedEvents(poolDir, "01", [spawnedIn(repo)]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

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
  return makeServerPool([
    { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
  ]);
}

/**
 * A pool for CLI-level tests: one ticket that is already done, so the boot
 * never spawns a real harness, with a harness name that resolves.
 */
function makeCliPool(): string {
  const poolDir = makeTempDir("pool-cli-");
  registerTempDir(poolDir);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port });
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }]);
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
    const holderPool = makeTempDir("pool-holder-");
    registerTempDir(holderPool);
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port: held.port });
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
    const holderPool = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port });
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
    const contenderPool = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port });
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
    const holderPool = makeTempDir("pool-holder-");
    registerTempDir(holderPool);
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }], { port: configPort });
    const server = createPoolServer({ poolDir, port: flagPort, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${flagPort}`);
  });

  it("with no pin, binds the default port when it is free", async () => {
    const port = await freePort();
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).toBe(`http://localhost:${port}`);
  });

  it("with no pin, hunts to the next free port when the default is busy", async () => {
    const held = await holdPort();
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }]);
    const server = createPoolServer({ poolDir, defaultPort: held.port, distDir: "/nonexistent", registryPath: fleetRegistry(poolDir) });
    servers.push(server);
    expect(server.url).not.toBe(`http://localhost:${held.port}`);
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
    await held.release();
  });

  it("exits non-zero from the CLI when a --port pin is busy, naming the port", async () => {
    const held = await holdPort();
    const poolDir = makeServerPool([{ file: "01-a.md", marker: portMarker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }]);
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
    const poolDir = makeServerPool([{ file: "01-a.md", marker }], { port: held.port });
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
  // Both endpoints read the pane from the last snapshot's Live attempt
  // (ADR-0014, ticket 05 of #54): every case here runs a real
  // terminal-backed pool against the executing fake daemon and reaches the
  // pane the engine itself registered, never one seeded by hand.

  const fakes: ExecutingFakeHerdr[] = [];

  afterEach(async () => {
    while (fakes.length > 0) await fakes.pop()!.close();
  });

  async function fakeHerdr(options?: ExecutingFakeHerdrOptions): Promise<ExecutingFakeHerdr> {
    const fake = await startExecutingFakeHerdr(options);
    fakes.push(fake);
    return fake;
  }

  const READY_01 = "<!-- state: id=01 blocked-by=none status=ready -->";

  function liveAttemptOf(server: PoolServer, id: string): { attempt: number; paneId: string | null } | null | undefined {
    return server.latest?.state.tickets.find((t) => t.id === id)?.liveAttempt;
  }

  /**
   * A terminal-backed pool whose one ticket runs an attempt held open until
   * released, resolved once the snapshot carries its pane. The stub harness
   * has no interactive descriptor, so the engine types nothing into the
   * pane after the wrapper: what pane.read shows is exactly what the fake
   * renders, and no engine read races the endpoint's.
   */
  async function livePool(): Promise<{
    server: PoolServer;
    fake: ExecutingFakeHerdr;
    poolDir: string;
    paneId: string;
    release: () => void;
  }> {
    const poolDir = makeServerPool([{ file: "01-a.md", marker: READY_01 }], { terminal: "herdr" });
    const sentinel = join(poolDir, "release-01");
    const fake = await fakeHerdr();
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
      { herdrSocket: fake.socketPath },
    );
    await server.start();
    await waitFor(
      () => typeof liveAttemptOf(server, "01")?.paneId === "string",
      "01's live pane on the snapshot",
    );
    return {
      server,
      fake,
      poolDir,
      paneId: liveAttemptOf(server, "01")!.paneId!,
      release: () => writeFileSync(sentinel, ""),
    };
  }

  const peekReads = (fake: ExecutingFakeHerdr) =>
    fake.requests.filter((r) => r.method === "pane.read" && r.params.lines === TERMINAL_PEEK_LINES);

  it("peek translates the ticket id to its live pane and serves the pane's recent output", async () => {
    const { server, fake, paneId, release } = await livePool();
    fake.setPaneContent(paneId, "working\nstill working");

    const res = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "01", paneId, text: "working\nstill working" });
    // The wire call is the prototype's verified peek shape. The line count is
    // at least a terminal height: a TUI fills the pane, and pane.read returns
    // only the last N rendered rows, so a small count reads empty or a footer
    // sliver (prototype/tui-prompt-paste/FINDINGS.md section 2, proven).
    expect(TERMINAL_PEEK_LINES).toBeGreaterThanOrEqual(80);
    expect(peekReads(fake)).toEqual([
      {
        method: "pane.read",
        params: {
          pane_id: paneId,
          source: "recent",
          format: "text",
          strip_ansi: true,
          lines: TERMINAL_PEEK_LINES,
        },
      },
    ]);
    release();
    await settleOrBeat(server);
  });

  it("focus calls pane.focus with the live pane id", async () => {
    const { server, fake, paneId, release } = await livePool();

    const res = await fetch(`${server.url}/api/terminal/focus?ticket=01`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paneId });
    expect(fake.requests.filter((r) => r.method === "pane.focus")).toEqual([
      { method: "pane.focus", params: { pane_id: paneId } },
    ]);
    release();
    await settleOrBeat(server);
  });

  it("answers a headless attempt and an unknown ticket with a clean no-pane 404", async () => {
    // A headless pool: the attempt is live on the snapshot with no pane.
    const poolDir = makeServerPool([{ file: "01-a.md", marker: READY_01 }]);
    const sentinel = join(poolDir, "release-01");
    const fake = await fakeHerdr();
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
      { herdrSocket: fake.socketPath },
    );
    await server.start();
    await waitFor(() => liveAttemptOf(server, "01") != null, "01's headless attempt to be live");
    expect(liveAttemptOf(server, "01")).toEqual({ attempt: 1, paneId: null });

    for (const ticket of ["01", "99"]) {
      const peek = await fetch(`${server.url}/api/terminal/peek?ticket=${ticket}`);
      expect(peek.status).toBe(404);
      expect((await peek.json()).error).toBe(`no terminal-backed pane for ticket ${ticket}`);
      const focus = await fetch(`${server.url}/api/terminal/focus?ticket=${ticket}`, {
        method: "POST",
      });
      expect(focus.status).toBe(404);
      expect((await focus.json()).error).toBe(`no terminal-backed pane for ticket ${ticket}`);
    }
    // No-pane tickets never reach the daemon.
    expect(fake.requests).toEqual([]);
    writeFileSync(sentinel, "");
    await settleOrBeat(server);
  });

  it("answers a finished attempt with the same 404: the pane leaves the snapshot when the attempt ends", async () => {
    const { server, fake, release } = await livePool();
    release();
    await server.settled();
    expect(liveAttemptOf(server, "01")).toBeNull();

    const peek = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(peek.status).toBe(404);
    expect((await peek.json()).error).toBe("no terminal-backed pane for ticket 01");
    const focus = await fetch(`${server.url}/api/terminal/focus?ticket=01`, { method: "POST" });
    expect(focus.status).toBe(404);
    expect(peekReads(fake)).toEqual([]);
    expect(fake.requests.filter((r) => r.method === "pane.focus")).toEqual([]);
  });

  it("treats an empty read as empty text, not an error", async () => {
    const { server, paneId, release } = await livePool();
    // Nothing rendered: a background tab still warming up reads empty.
    const res = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "01", paneId, text: "" });
    release();
    await settleOrBeat(server);
  });

  it("freshness comes from text, not revision: a stagnant revision still serves new text", async () => {
    const { server, fake, paneId, release } = await livePool();
    fake.setPaneContent(paneId, "first");
    const first = await (await fetch(`${server.url}/api/terminal/peek?ticket=01`)).json();
    expect(first.text).toBe("first");
    fake.setPaneContent(paneId, "second");
    const second = await (await fetch(`${server.url}/api/terminal/peek?ticket=01`)).json();
    expect(second.text).toBe("second");
    // The response carries no revision at all: nothing downstream may rely
    // on it advancing (the fake serves revision 0 for both reads).
    expect("revision" in second).toBe(false);
    release();
    await settleOrBeat(server);
  });

  it("a daemon failure is a clean 502, not a crash, and the only 502 there is", async () => {
    const { server, fake, release } = await livePool();
    fake.fail.add("pane.read");
    fake.fail.add("pane.focus");

    const peek = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(peek.status).toBe(502);
    expect((await peek.json()).error).toContain("pane.read refused");
    const focus = await fetch(`${server.url}/api/terminal/focus?ticket=01`, { method: "POST" });
    expect(focus.status).toBe(502);
    expect((await focus.json()).error).toContain("pane.focus refused");
    fake.fail.clear();
    release();
    await settleOrBeat(server);
  });

  it("peek reads no events file: it still answers after the ticket's file is deleted", async () => {
    const { server, fake, poolDir, paneId, release } = await livePool();
    fake.setPaneContent(paneId, "still here");
    // The events file was the old derivation's only source; the pane now
    // rides the snapshot, so the file's loss changes nothing for the
    // endpoint (the attempt's own exit later appends to a fresh file).
    const eventsFile = join(poolDir, "runs", "01.events.jsonl");
    expect(existsSync(eventsFile)).toBe(true);
    rmSync(eventsFile);

    const res = await fetch(`${server.url}/api/terminal/peek?ticket=01`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "01", paneId, text: "still here" });
    release();
    await settleOrBeat(server);
  });
});

describe("liveAttempt enrichment (terminal-backed attempts)", () => {
  // ADR-0014: the engine registers each Attempt's pane the moment its
  // spawned event is recorded, and the snapshot's liveAttempts carries it
  // to the enriched ticket as `liveAttempt`; the server threads it through
  // verbatim. These tests drive real pools against a fake herdr daemon (the
  // engine's herdr socket is overridable per run, exactly as the engine
  // tests do), never the live daemon.

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
    let mintedWorkspaces = 0;
    const panes = new Map<string, { tabId: string; cwd: string; buffer: string }>();
    const subscribers: import("node:net").Socket[] = [];
    const connections = new Set<import("node:net").Socket>();
    const firePaneEnd = (paneId: string, event: "pane_exited" | "pane_closed"): void => {
      panes.delete(paneId);
      broadcast(event, { pane_id: paneId, workspace_id: "w1" });
    };
    // herdr pushes every event to every subscriber; the engine filters. A
    // subscriber whose wait already settled has closed its end, so prune
    // before broadcasting.
    const broadcast = (event: string, data: Record<string, unknown>): void => {
      for (const sub of [...subscribers]) {
        if (sub.destroyed || !sub.writable) {
          subscribers.splice(subscribers.indexOf(sub), 1);
          continue;
        }
        sub.write(JSON.stringify({ event, data: { type: event, ...data } }) + "\n");
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
          // herdr protocol 20 answers with the root pane (issue #94).
          respond({
            type: "tab_created",
            tab: { tab_id: tabId },
            root_pane: { pane_id: `pane-${minted}`, tab_id: tabId },
          });
        } else if (msg.method === "workspace.get") {
          // The Pool workspace (issue #94): this fake never loses one.
          respond({ workspace: { workspace_id: String(msg.params.workspace_id ?? "") } });
        } else if (msg.method === "workspace.create") {
          mintedWorkspaces += 1;
          respond({ workspace: { workspace_id: `w${mintedWorkspaces}` } });
        } else if (msg.method === "pane.list") {
          respond({
            panes: [...panes.entries()].map(([paneId, pane]) => ({
              tab_id: pane.tabId,
              pane_id: paneId,
            })),
          });
        } else if (msg.method === "pane.read") {
          // A pane at its shell prompt, so the engine's shell-settle gate
          // (issue #102) sees a shell that has drawn it.
          const pane = panes.get(String(msg.params.pane_id));
          respond({
            read: { text: pane ? `$ ${pane.buffer}` : "", revision: 0, truncated: false },
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
          // A closed tab takes its panes silently (verified herdr 0.8.2,
          // issue #61): they leave the listing and one `tab_closed` goes
          // out, with no `pane_closed` for any of them.
          const tabId = String(msg.params.tab_id ?? "");
          for (const [paneId, pane] of [...panes.entries()]) {
            if (pane.tabId === tabId) panes.delete(paneId);
          }
          respond({ type: "ok" });
          broadcast("tab_closed", { tab_id: tabId, workspace_id: "w1" });
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
    const dir = makeTempDir("herdr-fake-");
    registerTempDir(dir);
    const socketPath = join(dir, "herdr.sock");
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, () => resolve({ socketPath, requests }));
    });
  }

  it("exposes each terminal-backed ticket's live pane on the enriched snapshot", async () => {
    const poolDir = makeServerPool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    const fake = await startFakeHerdr();
    // A finished attempt's record leaves the snapshot by design (a finished
    // card's surface and polling stop), so 02 and 03 are held open on their
    // own sentinels until the snapshot has been read; 01 finishes on its
    // own, so the super-step's later emits must still carry the other two.
    const release = {
      "02": join(poolDir, "release-02"),
      "03": join(poolDir, "release-03"),
    };
    const blocking = blockingHarness(
      poolDir,
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
      const pane02 = tickets?.find((t) => t.id === "02")?.liveAttempt?.paneId;
      const pane03 = tickets?.find((t) => t.id === "03")?.liveAttempt?.paneId;
      live = typeof pane02 === "string" && typeof pane03 === "string" ? { pane02, pane03 } : null;
      return live !== null;
    }, "02 and 03's live attempts to expose panes on one snapshot");
    const { pane02, pane03 } = live!;
    expect(server.latest?.state.tickets.find((t) => t.id === "02")?.liveAttempt).toEqual({
      attempt: 1,
      paneId: pane02,
    });
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
    // races the same beat the fixture's cleanup uses.
    writeFileSync(release["02"], "");
    writeFileSync(release["03"], "");
    await settleOrBeat(server);
  });

  it("exposes a live attempt with no pane on a headless pool, and none once it ends", async () => {
    const poolDir = makeServerPool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const sentinel = join(poolDir, "release-01");
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
    );

    await server.start();
    // A headless attempt is live with a null pane: the card projection
    // reads the null as "no surface" while the attempt still counts as
    // running.
    await waitFor(
      () => server.latest?.state.tickets[0]?.liveAttempt != null,
      "the headless attempt to be live on the snapshot",
    );
    expect(server.latest?.state.tickets[0]!.liveAttempt).toEqual({ attempt: 1, paneId: null });
    writeFileSync(sentinel, "");
    const snapshot = await server.settled();
    expect(snapshot.state.tickets[0]!.liveAttempt).toBeNull();
  });

  it("exposes no pane when the daemon refused the tab and the attempt fell back to headless", async () => {
    const poolDir = makeServerPool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    const sentinel = join(poolDir, "release-01");
    const fake = await startFakeHerdr({ fail: ["tab.create"] });
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
      { herdrSocket: fake.socketPath },
    );

    await server.start();
    // The fallback runs headless: live on the snapshot with a null pane.
    await waitFor(
      () => server.latest?.state.tickets[0]?.liveAttempt != null,
      "the fallback attempt to be live on the snapshot",
    );
    expect(server.latest?.state.tickets[0]!.liveAttempt).toEqual({ attempt: 1, paneId: null });
    writeFileSync(sentinel, "");
    const snapshot = await server.settled();
    // The fallback still completes; the spawned event's pane_id is null.
    expect(snapshot.state.tickets[0]!.status).toBe("done");
    expect(snapshot.state.tickets[0]!.liveAttempt).toBeNull();
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

  it("exposes no pane when the tab opened but the wrapper send was refused and the attempt fell back to headless", async () => {
    const poolDir = makeServerPool(
      [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      { terminal: "herdr" },
    );
    const sentinel = join(poolDir, "release-01");
    // The daemon accepts tab.create, so the attempt has a real pane; the
    // pane.send_input that would start the wrapper in it is refused, and the
    // spawn falls back to headless mid-flight.
    const fake = await startFakeHerdr({ fail: ["pane.send_input"] });
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
      { herdrSocket: fake.socketPath },
    );

    await server.start();
    // The fallback runs headless: live with a null pane, never the dead
    // pane id the fallback closed.
    await waitFor(
      () => server.latest?.state.tickets[0]?.liveAttempt != null,
      "the fallback attempt to be live on the snapshot",
    );
    expect(server.latest?.state.tickets[0]!.liveAttempt).toEqual({ attempt: 1, paneId: null });
    writeFileSync(sentinel, "");
    const snapshot = await server.settled();
    // The fallback still completes; the spawned event records the fallback
    // (pane_id null + terminal_error), not the dead pane id.
    expect(snapshot.state.tickets[0]!.status).toBe("done");
    expect(snapshot.state.tickets[0]!.liveAttempt).toBeNull();
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


describe("terminalRuntimeRefusal", () => {
  // Issue #61: Bun 1.2.13 segfaulted inside its event loop a few hundred
  // milliseconds into a terminal-backed boot, with the same pool booting
  // clean headless. The terminal path refuses the runtime with a line of
  // its own; headless pools are never refused, being the workaround.
  it("refuses a terminal-backed pool on a Bun below the floor", () => {
    const refusal = terminalRuntimeRefusal({ terminal: "herdr" }, "1.2.13");
    expect(refusal).toContain("Bun 1.2.13");
    expect(refusal).toContain(TERMINAL_MIN_BUN_VERSION);
    expect(refusal).toContain("issue #61");
    expect(refusal).toContain("headless");
  });

  it("boots a terminal-backed pool on the floor and above", () => {
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, TERMINAL_MIN_BUN_VERSION)).toBeNull();
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, "1.3.14")).toBeNull();
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, "1.4.2")).toBeNull();
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, "2.0.0")).toBeNull();
  });

  it("never refuses a headless pool", () => {
    expect(terminalRuntimeRefusal({}, "1.2.13")).toBeNull();
    expect(terminalRuntimeRefusal({ port: 8787 }, "1.0.0")).toBeNull();
  });

  it("never refuses on a version it cannot read", () => {
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, "")).toBeNull();
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, "canary")).toBeNull();
  });

  it("boots on this test run's own Bun", () => {
    expect(terminalRuntimeRefusal({ terminal: "herdr" }, Bun.version)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stopping a finished pool from the Console (issue #97). The Console's stop
// button is the only way to retire a pool that has nothing left to do, so the
// route has to be narrow (a finished pool only), idempotent (a stale tab must
// not stop twice), and it has to say goodbye: the farewell `stopped` snapshot
// is how a tab tells an orderly stop from a dropped connection.
// ---------------------------------------------------------------------------

/** Read the snapshot stream until its replayed snapshot has arrived. */
async function readOpeningFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('"phase"')) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before its replayed snapshot");
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** Read a snapshot stream to its end, reporting how it ended: `clean` is the
 *  orderly end-of-stream a Console stop owes its clients, `error` the thrown
 *  read of a socket cut from under them. */
async function drainStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms = 10_000,
): Promise<{ text: string; ended: "clean" | "error" | "timeout" }> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { text, ended: "timeout" };
    const step = await Promise.race([
      reader.read().then(
        (r) =>
          r.done
            ? ({ kind: "clean" } as const)
            : ({ kind: "chunk", value: r.value } as const),
        () => ({ kind: "error" }) as const,
      ),
      Bun.sleep(left).then(() => ({ kind: "timeout" }) as const),
    ]);
    if (step.kind === "chunk") {
      text += decoder.decode(step.value, { stream: true });
      continue;
    }
    return { text, ended: step.kind };
  }
}

/** Every complete snapshot frame in a stream's raw text. */
function snapshotFrames(text: string): { phase: string; poolDir: string }[] {
  const prefix = "event: snapshot\ndata: ";
  const frames: { phase: string; poolDir: string }[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.startsWith(prefix)) continue;
    try {
      frames.push(JSON.parse(frame.slice(prefix.length)));
    } catch {
      // A frame the read boundary cut in half; the rest arrives next read.
    }
  }
  return frames;
}

describe("stop from the Console (#97)", () => {
  const ready = "<!-- state: id=01 blocked-by=none status=ready -->";

  /** Drive a pool all the way through its review gate, so `latest.phase` is
   *  `done` and the stop route will accept. */
  async function finishedServer(
    options: Parameters<typeof startServer>[2] = {},
  ): Promise<{ poolDir: string; server: PoolServer }> {
    const poolDir = makeServerPool([{ file: "01-a.md", marker: ready }]);
    const server = await startServer(
      poolDir,
      stubHarness(poolDir, {}).harnesses,
      options,
    );
    await server.start();
    await server.settled();
    await server.answer(REVIEW_TICKET_ID, "approve");
    await server.settled();
    await waitFor(() => server.latest?.phase === "done", "the pool to finish");
    return { poolDir, server };
  }

  // A pool the operator never started has no run to stop, and the refusal
  // says so rather than tearing down a server that has done nothing.
  it("refuses a stop before the pool has started and keeps serving", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker: ready }]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);

    const res = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("not started");

    // The refusal is a refusal, not a stop: the server is still there.
    const state = await fetch(`${server.url}/api/state`);
    expect(state.status).toBe(200);
    expect((await state.json()) as { snapshot: unknown }).toEqual({ snapshot: null });
  });

  // A running pool has an attempt mid-flight, so a stale tab's stop is
  // refused by phase and the attempt is left alone to finish.
  it("refuses a stop while the pool is running and lets the attempt finish", async () => {
    const poolDir = makeServerPool([{ file: "01-a.md", marker: ready }]);
    const sentinel = join(poolDir, "go");
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
    );
    await server.start();
    await waitFor(
      () => server.latest?.phase === "running",
      "the pool to be running with 01's attempt in flight",
    );

    const res = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(res.status).toBe(409);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("not done");
    expect(error).toContain("running");

    // Nothing was torn down: the server still serves and the held attempt is
    // still the one in flight.
    const state = await fetch(`${server.url}/api/state`);
    expect(state.status).toBe(200);
    expect(server.latest?.phase).toBe("running");

    // Release the sentinel so the attempt ends and the drive settles, rather
    // than leaving a live harness for the teardown to race.
    writeFileSync(sentinel, "go");
    const settled = await server.settled();
    expect(settled.state.tickets.map((t) => t.status)).toEqual(["done"]);
  }, 20_000);

  // The whole orderly stop, end to end: the 202, the farewell frame, the
  // clean end of stream, the closed port, the released lock.
  it("stops a finished pool: 202, a `stopped` farewell, then a closed stream and port", async () => {
    const { poolDir, server } = await finishedServer();
    expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(true);

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const opening = await readOpeningFrames(reader);
    expect(opening).toContain('"phase":"done"');

    const stop = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(stop.status).toBe(202);
    expect(await stop.json()).toEqual({ stopping: true });

    // The farewell arrives on the open stream, and the stream then ends of
    // its own accord: a tab learns the server left on purpose.
    const { text, ended } = await drainStream(reader);
    expect(text).toContain('"phase":"stopped"');
    expect(ended).toBe("clean");

    // The farewell names the pool dir a relaunch would pass to --pool.
    const farewell = snapshotFrames(text).at(-1);
    expect(farewell?.phase).toBe("stopped");
    expect(farewell?.poolDir).toBe(poolDir);

    // The end of the stream is not the end of the stop: the streams are
    // closed first and serving stops behind a short drain, so joining the
    // in-flight stop (shutdown is latched, so this starts no second one) is
    // what makes the two assertions below exact rather than racy.
    await server.shutdown();

    // Serving has stopped and the pool lock is released, so a relaunch on
    // this pool neither hits a live port nor trips over a stale lock.
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
    expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
  }, 20_000);

  // A stale tab posting twice, or two tabs posting at once, must not start a
  // second teardown; the second POST is acknowledged the same way.
  it("acknowledges a repeat stop without starting a second one", async () => {
    const { poolDir, server } = await finishedServer();

    const first = await fetch(`${server.url}/api/stop`, { method: "POST" });
    const second = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ stopping: true });

    // One stop ran, and joining it is enough: a second POST that had started
    // its own would leave this waiting on a stop that never latched.
    await server.shutdown();
    expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
    await expect(fetch(`${server.url}/api/state`)).rejects.toThrow();
  }, 20_000);

  // The CLI hands the route its own stop-then-exit, because a server that
  // shut itself down in place would leave the process running with nothing
  // to serve. With the option given, the route accepts and hands over: the
  // callback owns the stop, and the server is still up when it returns.
  it("hands a stop to onStopRequested exactly once and does not shut itself down", async () => {
    let calls = 0;
    const { server } = await finishedServer({
      onStopRequested: () => {
        calls += 1;
      },
    });

    const first = await fetch(`${server.url}/api/stop`, { method: "POST" });
    const second = await fetch(`${server.url}/api/stop`, { method: "POST" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    await waitFor(() => calls > 0, "the stop callback to fire");
    // Both POSTs have long since been answered: nothing more is coming.
    await Bun.sleep(100);
    expect(calls).toBe(1);

    // The callback owns the stop, so this server is untouched.
    const state = await fetch(`${server.url}/api/state`);
    expect(state.status).toBe(200);
    expect(server.latest?.phase).toBe("done");
  }, 20_000);
});

/** waitFor, for a condition that has to be fetched over HTTP. */
async function waitUntil(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The port a spawned CLI bound, read from the fleet registry it was handed. */
async function waitForCliPort(registryPath: string, pid: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const entry = readFleetEntries(registryPath).find((e) => e.pid === pid);
    if (entry) return entry.port;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for the server's fleet entry");
}

// The CLI's shutdown (ADR-0017, issue #65): a SIGTERM to the real server
// process stops its headless attempts before it exits and releases the pool
// lock, so a relaunch neither races the attempt in its worktree nor trips
// over a stale lock.
describe("server shutdown on signal", () => {
  it("SIGTERM stops the running attempt and its grandchildren, releases server.pid, and exits 0", async () => {
    const poolDir = makeServerPool(
      [{ file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" }],
      { defaults: { harness: "claude", model: "stub-model" } },
    );
    // A fake `claude` ahead of the real one on PATH: the CLI only knows the
    // default harnesses, and the child inherits the server's environment.
    const bin = join(poolDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "claude"),
      ["#!/usr/bin/env bash", "sleep 60 &", `echo $! > "${poolDir}/grandchild.pid"`, "wait", ""].join("\n"),
    );
    spawnSync("chmod", ["+x", join(bin, "claude")]);
    const events = join(poolDir, "runs", "01.events.jsonl");
    const server = Bun.spawn(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "server.ts"),
        "--pool",
        poolDir,
        "--port",
        "0",
        "--registry",
        join(poolDir, "fleet.json"),
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const live = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let pid = 0;
    let grandchild = 0;
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (existsSync(events) && existsSync(join(poolDir, "grandchild.pid"))) {
          const spawned = readFileSync(events, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; payload: { pid?: number } })
            .find((e) => e.kind === "spawned");
          const g = readFileSync(join(poolDir, "grandchild.pid"), "utf8").trim();
          if (spawned?.payload.pid && g !== "") {
            pid = spawned.payload.pid;
            grandchild = Number(g);
            break;
          }
        }
        await Bun.sleep(50);
      }
      expect(pid).toBeGreaterThan(0);
      expect(live(pid)).toBe(true);
      expect(live(grandchild)).toBe(true);
      expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(true);

      // A Console tab watching this pool when the signal lands (issue #97):
      // the stream it holds must end with the farewell, not with a reset
      // socket, so the tab can say the server left on purpose.
      const port = await waitForCliPort(join(poolDir, "fleet.json"), server.pid);
      const stream = await fetch(`http://localhost:${port}/api/stream`);
      const reader = stream.body!.getReader();
      await readOpeningFrames(reader);

      server.kill("SIGTERM");
      const code = await server.exited;

      expect(code).toBe(0);
      expect(live(pid)).toBe(false);
      expect(live(grandchild)).toBe(false);
      expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
      const farewell = await drainStream(reader);
      expect(farewell.text).toContain('"phase":"stopped"');
      expect(farewell.ended).toBe("clean");
      const stdout = await new Response(server.stdout).text();
      expect(stdout).toContain("SIGTERM: stopping attempts, then exiting");
      const recorded = readFileSync(events, "utf8");
      expect(recorded).toContain("harness stopped by engine shutdown (exited 143)");
    } finally {
      server.kill("SIGKILL");
      for (const p of [pid, grandchild]) {
        if (p > 0) {
          try {
            process.kill(-p, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    }
  });

  // Issue #97: the Console's stop button has to take the real process out,
  // not just its run. In-process, `POST /api/stop` shuts the server down
  // where it stands; under the CLI the route hands the same stop-then-exit
  // the signal handler takes, so the process is gone afterwards and the pool
  // is free for a relaunch. Nothing here spawns a harness: the pool's only
  // ticket is already done, so the run goes straight to its review gate and
  // the gate is answered over HTTP.
  it("POST /api/stop exits the CLI process once the pool is done, and refuses before it", async () => {
    const poolDir = makeServerPool(
      [{ file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
      { defaults: { harness: "claude", model: "stub-model" } },
    );
    const cli = Bun.spawn(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "server.ts"),
        "--pool",
        poolDir,
        "--port",
        "0",
        "--registry",
        join(poolDir, "fleet.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const port = await waitForCliPort(join(poolDir, "fleet.json"), cli.pid);
      const url = `http://localhost:${port}`;
      type Served = { phase: string; state: { interrupts: { kind: string }[] } };
      const snapshot = async (): Promise<Served | null> => {
        const res = await fetch(`${url}/api/state`);
        return ((await res.json()) as { snapshot: Served | null }).snapshot;
      };
      await waitUntil(
        async () =>
          (await snapshot())?.state.interrupts.some((i) => i.kind === "review") ??
          false,
        "the pool to reach its review gate",
      );

      // Held at the review gate, the pool is not done: the stop is refused
      // and the process stays up.
      const early = await fetch(`${url}/api/stop`, { method: "POST" });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { error: string }).error).toContain("not done");
      expect((await snapshot())?.phase).not.toBe("stopped");

      const approve = await fetch(`${url}/api/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: REVIEW_TICKET_ID, action: "approve" }),
      });
      expect(approve.status).toBe(202);
      await waitUntil(
        async () => (await snapshot())?.phase === "done",
        "the pool to finish",
      );

      const stream = await fetch(`${url}/api/stream`);
      const reader = stream.body!.getReader();
      await readOpeningFrames(reader);

      const stop = await fetch(`${url}/api/stop`, { method: "POST" });
      expect(stop.status).toBe(202);
      expect(await stop.json()).toEqual({ stopping: true });

      const farewell = await drainStream(reader);
      expect(farewell.text).toContain('"phase":"stopped"');
      expect(farewell.ended).toBe("clean");

      // The process is the thing that had to go: it exits 0, says why, and
      // leaves the pool unlocked for a relaunch.
      expect(await cli.exited).toBe(0);
      const stdout = await new Response(cli.stdout).text();
      expect(stdout).toContain(
        "stop requested from the Console: stopping attempts, then exiting",
      );
      expect(existsSync(join(poolDir, "runs", "server.pid"))).toBe(false);
    } finally {
      cli.kill("SIGKILL");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Conversations (issue #60): /api/conversations, /api/conversations/end, and
// the terminal/events/log endpoints accepting a Conversation id.
// ---------------------------------------------------------------------------

describe("conversation endpoints", () => {
  const fakeServers: import("node:net").Server[] = [];

  afterEach(async () => {
    while (fakeServers.length > 0) {
      const server = fakeServers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** A git-backed pool (Conversations need their own worktree and branch),
   *  with one already-done ticket so loadPoolMarkers never sees an empty
   *  issues/ directory. `terminal: herdr` unless overridden. */
  function makeConvoPool(config: Partial<PoolConfig> = {}): string {
    const poolDir = makeServerPool(
      [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
      { terminal: "herdr", defaults: { harness: "convo", model: "m" }, ...config },
    );
    const git = (args: string[]) => spawnSync("git", args, { cwd: poolDir, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "pool@test"]);
    git(["config", "user.name", "pool"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    return poolDir;
  }

  // A conversational "harness" with no defaultHarnessDescriptors entry (`cat`,
  // which just holds the pane open reading stdin): startConversation's
  // readiness wait is skipped entirely, the same trick conversations.test.ts
  // uses, so these tests exercise the HTTP routes without depending on any
  // harness's ready pattern.
  const convoHarnesses: Record<string, HarnessCommand> = { convo: () => ["cat"] };

  /**
   * A herdr fake that actually runs what a pane is sent, in the style of
   * conversations.test.ts's startFakeHerdr: real enough for
   * startConversation's full launch (tab.create, the wrapper's paste +
   * Enter, pane.read, pane.close, tab.close) to complete and record a real
   * pane id, which is what the terminal and list/create/end routes need to
   * be exercised for real rather than against hand-seeded events.
   */
  function startLaunchFakeHerdr(): Promise<{ socketPath: string; close: () => Promise<void> }> {
    let minted = 0;
    let mintedWorkspaces = 0;
    interface FakePane {
      tabId: string;
      cwd: string;
      alive: boolean;
      buffer: string;
      booted: boolean;
      inputArea: string;
      proc?: ReturnType<typeof Bun.spawn>;
    }
    const panes = new Map<string, FakePane>();
    const procs: ReturnType<typeof Bun.spawn>[] = [];
    const connections = new Set<import("node:net").Socket>();
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
        const respond = (result: unknown): void => {
          socket.end(JSON.stringify({ id: msg.id, result }) + "\n");
        };
        if (msg.method === "tab.create") {
          minted += 1;
          const tabId = `tab-${minted}`;
          const paneId = `pane-${minted}`;
          panes.set(paneId, {
            tabId,
            cwd: String(msg.params.cwd ?? "/"),
            alive: true,
            buffer: "",
            booted: false,
            inputArea: "",
          });
          // herdr protocol 20 answers with the root pane (issue #94).
          respond({
            type: "tab_created",
            tab: { tab_id: tabId },
            root_pane: { pane_id: paneId, tab_id: tabId },
          });
        } else if (msg.method === "workspace.get") {
          // The Pool workspace (issue #94): this fake never loses one.
          respond({ workspace: { workspace_id: String(msg.params.workspace_id ?? "") } });
        } else if (msg.method === "workspace.create") {
          mintedWorkspaces += 1;
          respond({ workspace: { workspace_id: `w${mintedWorkspaces}` } });
        } else if (msg.method === "pane.list") {
          respond({
            panes: [...panes.entries()]
              .filter(([, p]) => p.alive)
              .map(([id, p]) => ({ tab_id: p.tabId, pane_id: id })),
          });
        } else if (msg.method === "pane.read") {
          // Before the wrapper runs the pane shows its shell prompt, so the
          // engine's shell-settle gate (issue #102) sees a settled shell.
          const pane = panes.get(String(msg.params.pane_id));
          const visible = pane ? (pane.booted ? pane.inputArea : `$ ${pane.buffer}`) : "";
          respond({ read: { text: visible, revision: 0, truncated: false } });
        } else if (msg.method === "pane.send_input") {
          const pane = panes.get(String(msg.params.pane_id));
          if (pane) {
            if (typeof msg.params.text === "string") {
              if (!pane.booted) pane.buffer += msg.params.text;
              else pane.inputArea += msg.params.text;
            }
            if (Array.isArray(msg.params.keys) && msg.params.keys.includes("enter")) {
              if (pane.booted) {
                pane.inputArea = "";
              } else {
                const command = pane.buffer;
                pane.buffer = "";
                pane.booted = true;
                const proc = Bun.spawn(["bash", "-c", command], {
                  cwd: pane.cwd,
                  // "pipe", never written to or closed, so the `cat`
                  // harness blocks instead of exiting at once on EOF: the
                  // pane must stay alive until a test ends it, rather than
                  // dying inside the launch's own window.
                  stdin: "pipe",
                  stdout: "ignore",
                  stderr: "ignore",
                });
                pane.proc = proc;
                procs.push(proc);
              }
            }
          }
          respond({});
        } else if (msg.method === "events.subscribe") {
          socket.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
        } else if (msg.method === "pane.close") {
          const paneId = String(msg.params.pane_id ?? "");
          const pane = panes.get(paneId);
          if (pane) {
            pane.alive = false;
            pane.proc?.kill();
          }
          respond({ type: "ok" });
        } else if (msg.method === "tab.close") {
          const tabId = String(msg.params.tab_id ?? "");
          for (const pane of panes.values()) {
            if (pane.tabId !== tabId) continue;
            pane.alive = false;
            pane.proc?.kill();
          }
          respond({ type: "ok" });
        } else {
          respond({});
        }
      });
    });
    fakeServers.push(server);
    const dir = makeTempDir("conv-server-herdr-");
    registerTempDir(dir);
    const socketPath = join(dir, "herdr.sock");
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, () =>
        resolve({
          socketPath,
          close: () =>
            new Promise<void>((res) => {
              for (const proc of procs) proc.kill();
              for (const conn of connections) conn.destroy();
              server.close(() => res());
            }),
        }),
      );
    });
  }

  function startConvoServer(poolDir: string, herdrSocket: string): PoolServer {
    const server = createPoolServer({
      poolDir,
      port: 0,
      distDir: "/nonexistent",
      registryPath: fleetRegistry(poolDir),
      herdrSocket,
      harnesses: convoHarnesses,
    });
    servers.push(server);
    return server;
  }

  it("refuses to start a conversation on a headless pool with a 409 naming the reason", async () => {
    const poolDir = makeConvoPool({ terminal: undefined });
    const server = await startServer(poolDir, convoHarnesses);
    await server.start();

    const res = await fetch(`${server.url}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A talk" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    // The Console's client (ui/src/client.ts startConversation) reads the
    // failure text off `reason`, not `error`.
    expect(body.reason).toContain("not terminal-backed");
  });

  it("rejects a missing title with 400 before ever touching the engine", async () => {
    const poolDir = makeConvoPool();
    const server = await startServer(poolDir, convoHarnesses);
    await server.start();

    const res = await fetch(`${server.url}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opening: "hi" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toContain("title is required");
  });

  it("ending an unknown conversation id is a 404", async () => {
    const poolDir = makeConvoPool();
    const server = await startServer(poolDir, convoHarnesses);
    await server.start();

    const res = await fetch(`${server.url}/api/conversations/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "conv-nope" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toContain("no live conversation");
  });

  it("create, then end, round trip through the HTTP routes", async () => {
    const poolDir = makeConvoPool();
    const fake = await startLaunchFakeHerdr();
    const server = startConvoServer(poolDir, fake.socketPath);
    await server.start();
    await server.settled();

    const createRes = await fetch(`${server.url}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Plan the rollout", opening: "hello agent" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()).conversation;
    expect(created.status).toBe("live");
    expect(created.title).toBe("Plan the rollout");
    expect(typeof created.paneId).toBe("string");
    expect(created.assignment).toEqual({ harness: "convo", model: "m", drivers: "implement" });

    // Confirmed on disk, the same proof conversations.test.ts uses: the
    // route really drove the engine's startConversation, not a stub.
    expect(readConversation(join(poolDir, "conversations", `${created.id}.md`)).status).toBe(
      "live",
    );

    const endRes = await fetch(`${server.url}/api/conversations/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: created.id, closing: "thanks, that's everything" }),
    });
    expect(endRes.status).toBe(202);
    expect("snapshot" in (await endRes.json())).toBe(true);

    expect(readConversation(join(poolDir, "conversations", `${created.id}.md`)).status).toBe(
      "ended",
    );
    expect(existsSync(worktreePathFor(poolDir, created.id))).toBe(false);
    expect(branchExists(poolDir, created.id)).toBe(false);

    await fake.close();
  });

  it("peek and focus resolve a Conversation's recorded pane, and refuse once it never spawned", async () => {
    const poolDir = makeConvoPool();
    const fake = await startLaunchFakeHerdr();
    const server = startConvoServer(poolDir, fake.socketPath);
    await server.start();
    await server.settled();

    const created = await server.startConversation({ title: "Peek me" });

    const peek = await fetch(`${server.url}/api/terminal/peek?ticket=${created.id}`);
    expect(peek.status).toBe(200);
    expect((await peek.json()).paneId).toBe(created.paneId);

    const focus = await fetch(`${server.url}/api/terminal/focus?ticket=${created.id}`, {
      method: "POST",
    });
    expect(focus.status).toBe(200);

    // An unknown id (never a ticket, never a Conversation) is the same
    // clean no-pane 404 as a headless or finished ticket.
    const unknown = await fetch(`${server.url}/api/terminal/peek?ticket=nope`);
    expect(unknown.status).toBe(404);

    await server.endConversation(created.id);
    await fake.close();
  });

  it("an ended Conversation answers the same no-pane 404 as a finished ticket, never a 502", async () => {
    const poolDir = makeConvoPool();
    const fake = await startLaunchFakeHerdr();
    const server = startConvoServer(poolDir, fake.socketPath);
    await server.start();
    await server.settled();

    const created = await server.startConversation({ title: "End me" });
    expect((await fetch(`${server.url}/api/terminal/peek?ticket=${created.id}`)).status).toBe(200);
    await server.endConversation(created.id);

    // The End's own emit carries the view with its pane gone; the endpoints
    // read that snapshot and nothing else, so the daemon is never asked
    // about a pane that no longer exists.
    const peek = await fetch(`${server.url}/api/terminal/peek?ticket=${created.id}`);
    expect(peek.status).toBe(404);
    expect((await peek.json()).error).toBe(`no terminal-backed pane for ticket ${created.id}`);
    const focus = await fetch(`${server.url}/api/terminal/focus?ticket=${created.id}`, {
      method: "POST",
    });
    expect(focus.status).toBe(404);
    expect((await focus.json()).error).toBe(`no terminal-backed pane for ticket ${created.id}`);

    await fake.close();
  });

  it("the events endpoint accepts a Conversation id the same way it accepts a ticket id", async () => {
    const poolDir = makeConvoPool();
    const fake = await startLaunchFakeHerdr();
    const server = startConvoServer(poolDir, fake.socketPath);
    await server.start();
    await server.settled();

    const created = await server.startConversation({ title: "Talk it through" });

    const res = await fetch(`${server.url}/api/events?ticket=${created.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.some((e: { kind: string }) => e.kind === "spawned")).toBe(true);

    const unknown = await fetch(`${server.url}/api/events?ticket=nope`);
    expect(unknown.status).toBe(404);

    await server.endConversation(created.id);
    await fake.close();
  });

  it("PoolServer exposes startConversation/endConversation directly, guarded before the pool starts", async () => {
    const poolDir = makeConvoPool();
    const fake = await startLaunchFakeHerdr();
    const server = startConvoServer(poolDir, fake.socketPath);

    await expect(server.startConversation({ title: "Too early" })).rejects.toThrow(
      "pool not started",
    );
    await expect(server.endConversation("conv-1")).rejects.toThrow("pool not started");

    await server.start();
    await server.settled();
    const created = await server.startConversation({ title: "Direct call" });
    expect(created.status).toBe("live");
    await server.endConversation(created.id, "done via direct call");
    expect(readConversation(join(poolDir, "conversations", `${created.id}.md`)).status).toBe(
      "ended",
    );

    await fake.close();
  });
});

// ---------------------------------------------------------------------------
// Enlist panes endpoint (issue #101): GET /api/panes. The shared executing
// fake is the one herdr definition this suite drives; the route reads
// agent.list through it, never a fourth inline fake.
// ---------------------------------------------------------------------------

describe("enlist panes endpoint", () => {
  const fakes: ExecutingFakeHerdr[] = [];

  afterEach(async () => {
    while (fakes.length > 0) await fakes.pop()!.close();
  });

  async function fakeHerdr(
    options?: ExecutingFakeHerdrOptions,
  ): Promise<ExecutingFakeHerdr> {
    const fake = await startExecutingFakeHerdr(options);
    fakes.push(fake);
    return fake;
  }

  /** A git-backed, terminal-backed pool with one ticket, done by default, so
   *  no attempt runs unless the marker says ready. */
  function makeGitTerminalPool(marker?: string): string {
    const poolDir = makeServerPool(
      [
        {
          file: "01.md",
          marker:
            marker ?? "<!-- state: id=01 blocked-by=none status=done -->",
        },
      ],
      { terminal: "herdr" },
    );
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: poolDir, stdio: "ignore" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "pool@test"]);
    git(["config", "user.name", "pool"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    return poolDir;
  }

  it("lists every pane herdr reports, with the reason beside the ineligible ones", async () => {
    const poolDir = makeGitTerminalPool();
    const outside = makeTempDir("outside-repo-");
    registerTempDir(outside);
    const fake = await fakeHerdr();
    fake.seedAgent({
      paneId: "pane-free",
      agent: "claude",
      cwd: poolDir,
      title: "✳ Claude Code",
      status: "idle",
    });
    fake.seedAgent({
      paneId: "pane-unknown",
      agent: "gemini",
      cwd: poolDir,
      title: "gemini tui",
      status: "working",
    });
    fake.seedAgent({
      paneId: "pane-outside",
      agent: "claude",
      cwd: outside,
      title: "elsewhere",
      status: "idle",
    });
    const server = await startServer(
      poolDir,
      stubHarness(poolDir, {}).harnesses,
      { herdrSocket: fake.socketPath },
    );
    await server.start();

    const res = await fetch(`${server.url}/api/panes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = (id: string) =>
      body.panes.find((p: { paneId: string }) => p.paneId === id);

    // Eligible: a known harness, a checkout of this pool's repo, no owner.
    // The branch is resolved by the engine with git in the pane's directory.
    expect(byId("pane-free")).toMatchObject({
      paneId: "pane-free",
      harness: "claude",
      status: "idle",
      title: "✳ Claude Code",
      directory: poolDir,
      branch: "main",
      eligible: true,
      reason: null,
    });
    // An unknown harness stays in the list, greyed with the reason.
    expect(byId("pane-unknown")).toMatchObject({
      harness: "gemini",
      eligible: false,
      reason: "no harness the engine knows",
    });
    // A directory outside this pool's repository.
    expect(byId("pane-outside")).toMatchObject({
      harness: "claude",
      directory: outside,
      branch: null,
      eligible: false,
      reason: "not a checkout of this pool's repository",
    });
    // Ineligible panes are returned, never dropped.
    expect(body.panes).toHaveLength(3);
  });

  it("reports a pane a live attempt holds as already in the pool", async () => {
    const poolDir = makeGitTerminalPool(
      "<!-- state: id=01 blocked-by=none status=ready -->",
    );
    const sentinel = join(poolDir, "release-01");
    const fake = await fakeHerdr();
    const server = await startServer(
      poolDir,
      blockingHarness(poolDir, { "01": { block: true } }, sentinel),
      { herdrSocket: fake.socketPath },
    );
    await server.start();
    await waitFor(
      () =>
        typeof server.latest?.state.tickets.find((t) => t.id === "01")
          ?.liveAttempt?.paneId === "string",
      "01's live pane on the snapshot",
    );
    const paneId = server.latest!.state.tickets.find((t) => t.id === "01")!
      .liveAttempt!.paneId!;
    // The engine reports the pane's agent after the wrapper lands; the fake
    // binds it, so the pane appears in agent.list as the engine's own.
    await waitFor(
      () => fake.requests.some((r) => r.method === "pane.report_agent"),
      "the attempt's agent report",
    );

    const res = await fetch(`${server.url}/api/panes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const pane = body.panes.find((p: { paneId: string }) => p.paneId === paneId);
    expect(pane).toMatchObject({
      paneId,
      eligible: false,
      reason: "already in the pool",
    });

    writeFileSync(sentinel, "");
    await settleOrBeat(server);
  });

  it("refuses a headless pool with a 409 naming the reason", async () => {
    const poolDir = makeServerPool([
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const server = await startServer(poolDir, stubHarness(poolDir, {}).harnesses);
    await server.start();

    const res = await fetch(`${server.url}/api/panes`);
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toContain("terminal-backed");
  });

  it("a daemon failure is a clean 502, not a crash", async () => {
    const poolDir = makeGitTerminalPool();
    const fake = await fakeHerdr();
    fake.fail.add("agent.list");
    const server = await startServer(
      poolDir,
      stubHarness(poolDir, {}).harnesses,
      { herdrSocket: fake.socketPath },
    );
    await server.start();

    const res = await fetch(`${server.url}/api/panes`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("agent.list refused");
  });
});
