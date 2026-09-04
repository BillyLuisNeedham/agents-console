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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPoolServer,
  LOG_CHUNK_BYTES,
  type PoolServer,
  type PoolServerOptions,
} from "./server.ts";
import { readFleetEntries } from "./fleet.ts";
import { appendEvent } from "./events.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";

const servers: PoolServer[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.close();
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
// answers an interrupt. Every other ticket takes the instant path.
function blockingHarness(
  behaviour: Record<string, { statuses?: ("done" | "checkpoint")[]; block?: boolean }>,
  sentinel: string,
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
    return [
      "bash",
      stubPath,
      status,
      ctx.outcomePath,
      b.block ? "block" : "-",
      sentinel,
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

async function startServer(poolDir: string, harnesses: Record<string, HarnessCommand>): Promise<PoolServer> {
  const server = createPoolServer({
    poolDir,
    port: 0,
    harnesses,
    distDir: "/nonexistent",
    registryPath: fleetRegistry(poolDir),
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
    reader!.cancel();
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
    reader!.cancel();
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
    reader.cancel();
  }, 25_000);
});

describe("ticket events endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves a ticket's parsed events after a run", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.settled();
    await server.answer(REVIEW_TICKET_ID, "approve");

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
    expect(exited?.payload).toEqual({ code: 0, status: "done" });
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
      { attempt: 1, kind: "reconstructed", logFile: "01.log", current: true },
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

  it("lists event-based attempts with their rotated log files", async () => {
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
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      attempts: { attempt: number; kind: string; logFile: string; current: boolean }[];
    };
    // The older rotated log is readable through its attempt number.
    expect(body.content).toBe("first\n");
    expect(body.attempts).toEqual([
      { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", current: false },
      { attempt: 2, kind: "resolver", logFile: "01.resolver.log", current: true },
      { attempt: 3, kind: "implement", logFile: "01.log", current: true },
    ]);

    const third = await fetch(`${server.url}/api/log?ticket=01&attempt=3`);
    const thirdBody = (await third.json()) as { content: string };
    expect(thirdBody.content).toBe("third\n");
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
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/log?ticket=01&attempt=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      attempts: { attempt: number; kind: string; logFile: string; current: boolean }[];
    };
    // The current attempt reads its own attempt-numbered log: the pane must
    // not serve an empty file for a fan-out's live attempt.
    expect(body.content).toBe("third\n");
    expect(body.attempts).toEqual([
      { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", current: false },
      { attempt: 2, kind: "implement", logFile: "01.attempt-2.log", current: false },
      { attempt: 3, kind: "implement", logFile: "01.attempt-3.log", current: true },
    ]);
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
