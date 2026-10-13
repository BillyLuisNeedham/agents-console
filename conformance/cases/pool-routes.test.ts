/**
 * The pool server's own routes and its socket, seen from outside the server
 * (ADR-0036): booting, the enriched snapshot on /api/state, answers on
 * /api/resume, the socket's opening, heartbeat and pushes, and the ticket
 * events and body endpoints. Ported from engine/server.test.ts's "pool
 * server", "snapshot push coalescing", "ticket events endpoint", "pool meta
 * refresh" and "ticket body endpoint" blocks; what cannot be reached from
 * outside is in conformance/NOT-PORTED.pool-routes.md.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, TicketBodyResponse, TicketEventsResponse, TicketLogResponse } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import { CHECKOUT, freePort, serverArgv, serverChoice } from "../harness/server.ts";
import type { World } from "../harness/world.ts";
import { PROTOCOL_VERSION } from "../fixtures/socket-protocol.ts";

/** The review gate's Ticket id (REVIEW_TICKET_ID in engine/engine.ts). */
const REVIEW = "REVIEW";
/** How the server closes its sockets on a Stop (CLOSE_STOPPED in protocol/protocol.ts). */
const CLOSE_STOPPED = { code: 1000, reason: "stopped" };
/** The socket heartbeat interval a server publishes by default (engine/server.ts). */
const HEARTBEAT_MS = 20_000;
/** The pool's defaults, the stub harness on a model: STUB_DEFAULTS's counterpart. */
const DEFAULTS = { defaults: { harness: "claude", model: "m" } };

function marker(id: string, status: string, blockedBy = "none", extra = ""): string {
  return `<!-- state: id=${id} blocked-by=${blockedBy} status=${status}${extra} -->`;
}

/** /api/state's snapshot; null before the pool started. */
async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot | null> {
  return (await server.http.get("/api/state")).json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
}

const RESTING = new Set(["quiescent", "done", "dead", "stopped"]);

/**
 * The snapshot once the drive rests (no super-step in flight) and `done`
 * holds of it: the outside view of the engine test's `server.settled()`.
 */
async function settled(
  server: CaseServer,
  done: (snapshot: EnrichedSnapshot) => boolean = () => true,
  what = "the pool to settle",
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return (await until(
    () => snapshotOf(server),
    (snapshot) => snapshot !== null && RESTING.has(snapshot.phase) && done(snapshot),
    { what, ms },
  ))!;
}

function statusOf(snapshot: EnrichedSnapshot, id: string): string | undefined {
  return snapshot.state.tickets.find((ticket) => ticket.id === id)?.status;
}

function resume(server: CaseServer, body: Record<string, unknown>) {
  return server.http.post("/api/resume", body);
}

async function refusal(server: CaseServer, body: Record<string, unknown>): Promise<[number, string]> {
  const answer = await resume(server, body);
  return [answer.status, answer.json<{ error: string }>().error];
}

/**
 * Run the chosen server on a pool expecting it to refuse at boot: its exit
 * code and both streams, once it exits (killed and failed after `ms`).
 */
async function refusedBoot(world: World, ms = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(serverArgv(serverChoice(), world.pool, await freePort()), {
    cwd: CHECKOUT,
    env: world.env(`${world.root}/no-herdr.sock`),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await proc.exited;
    throw new Error(`the server was still running ${ms} ms after a boot it should have refused`);
  }
  return {
    code: proc.exitCode ?? -1,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

// ---------------------------------------------------------------------------
// pool server
// ---------------------------------------------------------------------------

// engine/server.test.ts:182
conformance(
  "conversations",
  "pool server › boots a Conversation-only pool: empty issues/ beside a conversations/ directory",
  async (t) => {
    const world = t.world({ config: DEFAULTS });
    mkdirSync(join(world.pool, "conversations"), { recursive: true });
    const server = await t.start(world);

    // Zero Tickets settles at the review gate, the engine's behaviour for a
    // Ticket-less pool; what matters is that the server got that far.
    const snapshot = await settled(server);
    expect(["quiescent", "done"]).toContain(snapshot.phase);
    expect(snapshot.state.tickets).toEqual([]);
    expect(server.exited()).toBe(false);
  },
);

// engine/server.test.ts:197
conformance(
  "conversations",
  "pool server › still refuses a pool with an empty issues/ and no conversations/ directory, naming the opt-in",
  async (t) => {
    const world = t.world({ config: DEFAULTS });
    const run = await refusedBoot(world);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/no Issue files.*conversations\/ directory/);
  },
);

// engine/server.test.ts:213
conformance(
  "conversations",
  "pool server › loads a Ticket whose spawned-by names a Conversation into the served meta",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "conv-1-spawn-1.md", marker: marker("conv-1-spawn-1", "done", "none", " spawned-by=conv-1") }],
      config: DEFAULTS,
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude " +
          "model=m drivers=implement -->\n\n# Talk\n\n\n",
      },
    });
    const server = await t.start(world);

    const snapshot = await settled(server);
    expect(snapshot.state.tickets.map((ticket) => ticket.id)).toEqual(["conv-1-spawn-1"]);
  },
);

// engine/server.test.ts:232
conformance("http", "pool server › drives a pool to the review gate and serves the enriched state", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-a.md", marker: marker("01", "ready") },
      { file: "02-b.md", marker: marker("02", "ready", "01") },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);

  const snapshot = await settled(server, (s) => s.state.interrupts.length > 0);
  expect(snapshot.phase).toBe("quiescent");
  expect(snapshot.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
  expect(Object.fromEntries(snapshot.state.tickets.map((ticket) => [ticket.id, ticket.status]))).toEqual({
    "01": "done",
    "02": "done",
  });
  expect(snapshot.state.tickets.map((ticket) => ticket.blockedBy)).toEqual([[], ["01"]]);
  expect(snapshot.state.tickets.map((ticket) => ticket.title)).toEqual(["body", "body"]);

  // Approving the review ends the run; the server stays up with the final
  // state inspectable.
  expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
  const approved = await settled(server, (s) => s.phase === "done", "the run to end");
  expect(approved.state.interrupts).toEqual([]);
  expect(server.exited()).toBe(false);
});

// engine/server.test.ts:258
conformance("server", "pool server › carries the terminal dead phase on the snapshot when the drive dies", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: marker("01", "ready") }],
    config: DEFAULTS,
  });
  // The pool's harness is claude, and no claude is on the server's PATH:
  // the launch inside the first super-step fails and kills the drive.
  const path = world.env("").PATH!.split(":").filter((dir) => dir !== world.stubs.bin).join(":");
  if (Bun.which("claude", { PATH: path }) !== null) {
    throw new Error(`a claude outside the stubs is on ${path}; this case needs none`);
  }
  const server = await t.start(world, { env: { PATH: path } });

  // The dead phase is on the snapshot the Console receives, with the pool
  // log line beside it, and the server keeps serving.
  const snapshot = await settled(server, (s) => s.phase === "dead", "the drive to die");
  expect(snapshot.state.log.some((line) => line.startsWith("pool dead:"))).toBe(true);
  expect(server.exited()).toBe(false);
  expect((await server.http.get("/api/state")).status).toBe(200);
});

// engine/server.test.ts:283
conformance(
  "http",
  "pool server › carries the pool's display name, the last two path segments, on the enriched snapshot",
  async (t) => {
    const world = t.world({ poolName: "tickets", tickets: [{ file: "01-a.md", marker: marker("01", "done") }], config: DEFAULTS });
    const shapes: [string, string][] = [
      [join(world.root, "ai-agent-graphs-fix", "tickets"), "ai-agent-graphs-fix/tickets"],
      [join(world.root, "other-worktree", "tickets"), "other-worktree/tickets"],
      [world.pool, ".scratch/tickets"],
    ];
    for (const [pool, expected] of shapes) {
      if (pool !== world.pool) {
        mkdirSync(join(pool, "issues"), { recursive: true });
        writeFileSync(join(pool, "issues", "01-a.md"), `${marker("01", "done")}\n\n# body\n`);
        writeFileSync(join(pool, "console.json"), JSON.stringify(DEFAULTS, null, 2));
      }
      const server = await t.start({ ...world, pool });
      const snapshot = await settled(server);
      expect(snapshot.poolName).toBe(expected);
      await server.stop();
    }
  },
);

// engine/server.test.ts:305
conformance("config", "pool server › serves each ticket's resolved assignment on the enriched snapshot", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-a.md", marker: marker("01", "ready") },
      { file: "02-b.md", marker: marker("02", "ready") },
      { file: "03-c.md", marker: marker("03", "ready") },
    ],
    config: {
      defaults: { harness: "claude", model: "default-model" },
      assign: {
        // Full override: the record is the assign entry field-wise.
        "02": { harness: "opencode", model: "override-model", drivers: "bun review" },
        // Partial (model-only): the rest comes from the pool defaults.
        "03": { model: "partial-model" },
      },
    },
  });
  const server = await t.start(world);

  const snapshot = await settled(server, (s) => s.state.interrupts.length > 0);
  expect(snapshot.phase).toBe("quiescent");
  const byId = Object.fromEntries(snapshot.state.tickets.map((ticket) => [ticket.id, ticket]));
  expect(byId["01"]!.assignment).toEqual({ harness: "claude", model: "default-model", drivers: "implement" });
  expect(byId["02"]!.assignment).toEqual({ harness: "opencode", model: "override-model", drivers: "bun review" });
  expect(byId["03"]!.assignment).toEqual({ harness: "claude", model: "partial-model", drivers: "implement" });
});

// engine/server.test.ts:349
conformance(
  "interrupts",
  "pool server › renders an unassigned ticket with null harness and model, and holds it as a config interrupt naming the fix",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: marker("01", "ready") }],
      // A console.json without a defaults block.
      config: { defaults: {} },
    });
    const server = await t.start(world);

    // The run paused the one ticket with the fix named, and stayed alive.
    const first = await settled(server, (s) => s.state.interrupts.length > 0);
    expect(first.phase).toBe("quiescent");
    expect(first.state.tickets[0]!.assignment).toEqual({ harness: null, model: null, drivers: "implement" });
    expect(first.state.tickets[0]!.status).toBe("checkpoint");
    expect(first.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "config"]]);
    expect(first.state.interrupts[0]!.body).toStartWith("ticket 01 has no harness: set one in console.json");
  },
);

// engine/server.test.ts:378
conformance("interrupts", "pool server › serves get state, start, and resume over HTTP", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);

  const first = await settled(server, (s) => s.state.interrupts.length > 0);
  expect(first.phase).toBe("quiescent");
  expect(first.state.interrupts[0]?.kind).toBe("checkpoint");
  expect(first.state.tickets[0]?.status).toBe("checkpoint");

  // The answer is acknowledged with 202 at acceptance. The pool is idle, so
  // processing follows at once and the snapshot the 202 carries shows it:
  // no queued answer waiting, the interrupt gone.
  const resumed = await resume(server, { ticketId: "01", action: "resume", note: "go on" });
  expect(resumed.status).toBe(202);
  const body = resumed.json<{ snapshot: EnrichedSnapshot }>();
  expect(body.snapshot.state.queuedAnswers).toEqual([]);
  expect(body.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);

  const after = await settled(server, (s) => s.state.interrupts.length > 0, "01 to run again");
  expect(after.phase).toBe("quiescent");
  expect(after.state.tickets[0]?.status).toBe("done");
  expect(after.state.interrupts[0]?.kind).toBe("review");

  expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
  await settled(server, (s) => s.phase === "done", "the run to end");
});

// engine/server.test.ts:424
conformance(
  "interrupts",
  "pool server › acknowledges a retried answer with 202 and no duplicate; a stranger answer still 400s",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: marker("01", "ready") },
        { file: "02-b.md", marker: marker("02", "ready") },
      ],
      config: DEFAULTS,
    });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const server = await t.start(world);
    const first = await settled(server, (s) => s.state.interrupts.length > 0 && statusOf(s, "02") === "done");
    expect(first.state.interrupts[0]?.kind).toBe("checkpoint");

    expect((await resume(server, { ticketId: "01", action: "resume", note: "go on" })).status).toBe(202);
    const resumed = await settled(server, (s) => s.state.interrupts.some((i) => i.kind === "review"));
    expect(statusOf(resumed, "01")).toBe("done");
    expect(resumed.state.interrupts[0]?.kind).toBe("review");

    // The client timed out waiting and retried the same answer: the accepted
    // answer is in the store, so the retry is acknowledged again.
    expect((await resume(server, { ticketId: "01", action: "resume", note: "go on" })).status).toBe(202);

    // No second answered event and no second queued record were written.
    expect(readEvents(world.pool, "01").filter((event) => event.kind === "answered")).toHaveLength(1);
    const queue = JSON.parse(readFileSync(join(world.pool, "runs", "queued-answers.json"), "utf8")) as {
      answers: unknown[];
    };
    expect(queue.answers).toHaveLength(1);

    // Approvals are idempotent the same way, once the review gate is down.
    expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
    await settled(server, (s) => s.phase === "done", "the run to end");
    expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);

    // A ticket with no pending interrupt and no accepted answer still 400s.
    expect((await resume(server, { ticketId: "02", action: "resume" })).status).toBe(400);
  },
);

// engine/server.test.ts:476
conformance(
  "scheduling",
  "pool server › answers 400 for a review reject that names no ticket, recording nothing",
  async (t) => {
    const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
    const server = await t.start(world);
    const first = await settled(server, (s) => s.state.interrupts.length > 0);
    expect(first.state.interrupts[0]?.kind).toBe("review");

    // A reject whose note names no ticket is invalid: the 400 comes back from
    // acceptance, and nothing is written for an answer that had no effect.
    const rejected = await resume(server, { ticketId: REVIEW, action: "reject", note: "this is not good enough" });
    expect(rejected.status).toBe(400);
    expect(rejected.json<{ error: string }>().error).toMatch(/name at least one ticket/);

    const state = (await snapshotOf(server))!;
    expect(state.state.interrupts[0]?.kind).toBe("review");
    expect(state.state.queuedAnswers).toEqual([]);
    expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);
    expect(readEvents(world.pool, REVIEW).filter((event) => event.kind === "answered")).toEqual([]);

    // The gate still works: a reject that does name a ticket is accepted,
    // re-runs 01 back to the gate and leaves the note in its file.
    const valid = await resume(server, { ticketId: REVIEW, action: "reject", note: "redo 01" });
    expect(valid.status).toBe(202);
    await until(
      () => readFileSync(join(world.pool, "issues", "01-a.md"), "utf8"),
      (text) => text.includes("## Review note"),
      { what: "the review note in 01's file" },
    );
    const again = await settled(
      server,
      (s) => s.state.interrupts[0]?.kind === "review" && world.stubs.calls().filter((c) => c.key === "01").length === 2,
      "01 to run again and reach the gate",
    );
    expect(again.phase).toBe("quiescent");
    expect(readFileSync(join(world.pool, "issues", "01-a.md"), "utf8")).toContain("## Review note");

    expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
    await settled(server, (s) => s.phase === "done", "the run to end");
  },
);

// engine/server.test.ts:538
conformance(
  "interrupts",
  "pool server › takes close on a checkpoint, refuses it on a crash, and answers 400 for an unknown action (issue #154)",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: marker("01", "ready") },
        { file: "02-b.md", marker: marker("02", "ready") },
      ],
      config: DEFAULTS,
    });
    world.stubs.script("01", { status: "checkpoint" });
    // Exits 0 with no Outcome: a crash.
    world.stubs.script("02", { status: "keep" });
    const server = await t.start(world);
    const first = await settled(server, (s) => s.state.interrupts.length === 2);
    expect(first.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([
      ["01", "checkpoint"],
      ["02", "crash"],
    ]);

    // An action the server does not know is never quietly a resume.
    const unknown = await refusal(server, { ticketId: "01", action: "discard" });
    expect(unknown[0]).toBe(400);
    expect(unknown[1]).toContain('unknown action "discard"');
    const crash = await refusal(server, { ticketId: "02", action: "close" });
    expect(crash[0]).toBe(400);
    expect(crash[1]).toContain("got crash for 02");
    expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);

    expect((await resume(server, { ticketId: "01", action: "close", note: "not needed now" })).status).toBe(202);
    const closed = await settled(server, (s) => statusOf(s, "01") === "closed", "01 to close");
    expect(closed.state.interrupts.map((i) => i.ticketId)).toEqual(["02"]);
    // A retried Close is acknowledged again; a Resume after it is not.
    expect((await resume(server, { ticketId: "01", action: "close", note: "not needed now" })).status).toBe(202);
    expect((await resume(server, { ticketId: "01", action: "resume" })).status).toBe(400);
  },
);

// engine/server.test.ts:579
conformance(
  "verify",
  "pool server › takes adopt with the candidate's attempt and refuses an attempt it cannot use (ADR-0035)",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: marker("01", "ready") },
        { file: "02-b.md", marker: marker("02", "ready") },
      ],
      config: { ...DEFAULTS, assign: { "01": { verify: 2 } } },
    });
    // 01's round: attempt 1 checkpoints, attempt 2 finishes (graded pass).
    world.stubs.script("01.attempt-1", { status: "checkpoint" });
    world.stubs.script("02", { status: "checkpoint" });
    const server = await t.start(world);
    const first = await settled(server, (s) => s.state.interrupts.length === 2, "both checkpoints", 60_000);
    expect(
      first.state.interrupts
        .map((i) => [i.ticketId, i.kind, i.candidates])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["01", "checkpoint", [2]],
      ["02", "checkpoint", undefined],
    ]);

    expect(await refusal(server, { ticketId: "01", action: "adopt" })).toEqual([
      400,
      "answer: adopt needs the attempt number of the candidate to take for 01",
    ]);
    expect(await refusal(server, { ticketId: "01", action: "adopt", attempt: "2" })).toEqual([
      400,
      'attempt must be a whole attempt number, got "2"',
    ]);
    expect(await refusal(server, { ticketId: "01", action: "resume", attempt: 2 })).toEqual([
      400,
      "answer: an attempt only goes with adopt, not resume, for 01",
    ]);
    expect(await refusal(server, { ticketId: "01", action: "adopt", attempt: 1 })).toEqual([
      400,
      "answer: adopt must name one of the finished candidates (2); got attempt 1 for 01",
    ]);
    expect(await refusal(server, { ticketId: "02", action: "adopt", attempt: 1 })).toEqual([
      400,
      "answer: 02's checkpoint names no finished candidate to adopt; resume or close it",
    ]);
    expect(existsSync(join(world.pool, "runs", "queued-answers.json"))).toBe(false);

    const adopt = await resume(server, { ticketId: "01", action: "adopt", attempt: 2, note: "the finished one" });
    expect(adopt.status).toBe(202);
    const adopted = await settled(server, (s) => statusOf(s, "01") === "done", "01 to take its candidate", 60_000);
    expect(adopted.state.interrupts.map((i) => i.ticketId)).toEqual(["02"]);
    // A retried Adopt of the same Candidate is acknowledged again.
    expect(
      (await resume(server, { ticketId: "01", action: "adopt", attempt: 2, note: "the finished one" })).status,
    ).toBe(202);
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:644
conformance(
  "interrupts",
  "pool server › refuses close on the review gate and on a config interrupt (issue #154)",
  async (t) => {
    const reviewWorld = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
    const review = await t.start(reviewWorld);
    expect((await settled(review, (s) => s.state.interrupts.length > 0)).state.interrupts[0]?.kind).toBe("review");
    expect((await resume(review, { ticketId: REVIEW, action: "close" })).status).toBe(400);

    const configWorld = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: { defaults: {} } });
    const config = await t.start(configWorld);
    expect((await settled(config, (s) => s.state.interrupts.length > 0)).state.interrupts[0]?.kind).toBe("config");
    const onConfig = await refusal(config, { ticketId: "01", action: "close" });
    expect(onConfig[0]).toBe(400);
    expect(onConfig[1]).toContain("got config for 01");
  },
);

// engine/server.test.ts:674
conformance(
  "interrupts",
  "pool server › carries queued answers in the 202, /api/state, and the socket while a super-step is in flight",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: marker("01", "ready") },
        { file: "02-b.md", marker: marker("02", "ready") },
        { file: "03-c.md", marker: marker("03", "ready", "02") },
      ],
      config: DEFAULTS,
    });
    const sentinel = join(world.root, "release-03");
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    // Holds super-step 2 open until the sentinel appears (the stub gives up
    // after ten seconds, well past what this case needs).
    world.stubs.script("03", { waitFor: sentinel });
    const server = await t.start(world);

    // Super-step 1 checkpoints 01 and finishes 02; super-step 2 runs 03 and
    // holds it open, with 01's interrupt pending throughout.
    await until(
      () => snapshotOf(server),
      (s) =>
        s !== null &&
        s.state.interrupts.some((i) => i.ticketId === "01") &&
        statusOf(s, "03") === "in-progress",
      { what: "a super-step in flight with 01's interrupt pending", ms: 30_000 },
    );

    // The 202's snapshot: the interrupt still pending, the answer queued.
    const resumed = await resume(server, { ticketId: "01", action: "resume", note: "go on" });
    expect(resumed.status).toBe(202);
    const body = resumed.json<{ snapshot: EnrichedSnapshot }>();
    expect(body.snapshot.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);
    expect(body.snapshot.state.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(body.snapshot.state.queuedAnswers[0]?.kind).toBe("checkpoint");

    // A Close behind the queued Resume would lose at the drain unseen, so it
    // is refused as a conflict with the queue.
    expect(await refusal(server, { ticketId: "01", action: "close" })).toEqual([
      409,
      "answer: ticket 01 already has an answer queued",
    ]);

    expect((await snapshotOf(server))!.state.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);

    // A socket opening now starts from the latest snapshot, queue included.
    const client = await t.socket(server);
    await client.waitFor((frame) => frame.type === "snapshot");
    expect(client.pushed?.snapshot.state.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    client.close();

    // Processing at the boundary clears the waiting state.
    writeFileSync(sentinel, "go");
    const cleared = await settled(
      server,
      (s) => statusOf(s, "03") === "done" && s.state.queuedAnswers.length === 0,
      "the boundary to process the answer",
    );
    expect(cleared.state.queuedAnswers).toEqual([]);
    expect(cleared.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);
  },
);

// engine/server.test.ts:752
conformance("protocol", "pool server › sends the latest snapshot to a socket on connect", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  const server = await t.start(world);
  await settled(server, (s) => s.state.interrupts.length > 0);
  expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
  await settled(server, (s) => s.phase === "done", "the run to end");

  const client = await t.socket(server);
  const opening = await client.waitFor((frame) => frame.type === "snapshot");
  expect(client.frames[0]?.type).toBe("hello");
  expect(opening).toMatchObject({ type: "snapshot", snapshot: { phase: "done" } });
});

// engine/server.test.ts:768
conformance(
  "protocol",
  "pool server › keeps the socket open through more than ten seconds of a quiet pool",
  async (t) => {
    const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
    world.stubs.script("01", { statuses: ["checkpoint", "done"] });
    const server = await t.start(world);
    // The pool waits at the checkpoint interrupt: nothing more is pushed.
    await settled(server, (s) => s.state.interrupts.length > 0);

    const client = await t.socket(server);
    await client.waitFor((frame) => frame.type === "snapshot" && frame.snapshot !== null);
    let closed = false;
    void client.closed.then(() => {
      closed = true;
    });
    // HTTP's default ten-second idle timeout would have cut a request by now,
    // its close reaching the client a couple of seconds late.
    await Bun.sleep(14_000);
    expect(closed).toBe(false);

    // The same socket still delivers the next change after the silence.
    const from = client.frames.length;
    expect((await resume(server, { ticketId: "01", action: "resume" })).status).toBe(202);
    await client.waitFor((frame) => frame.type === "delta", { from, ms: 10_000, what: "the delta after the silence" });
    expect(closed).toBe(false);
    await settled(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), "01 to run again");
  },
  { timeoutMs: 90_000 },
);

// engine/server.test.ts:804
conformance(
  "protocol",
  "pool server › sends a heartbeat frame on the socket",
  async (t) => {
    const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
    const server = await t.start(world);
    await settled(server, (s) => s.state.interrupts.length > 0);

    // The default interval is the real wait (no knob, by decision).
    const client = await t.socket(server);
    const beat = await client.waitFor((frame) => frame.type === "heartbeat", {
      ms: HEARTBEAT_MS + 15_000,
      what: "a heartbeat",
    });
    expect(beat).toEqual({ type: "heartbeat" });
  },
  { timeoutMs: 90_000 },
);

// engine/server.test.ts:822
conformance("protocol", "pool server › opens the socket with a hello publishing the heartbeat interval", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  const server = await t.start(world);
  await settled(server, (s) => s.state.interrupts.length > 0);

  const client = await t.socket(server);
  const hello = await client.waitFor((frame) => frame.type === "hello");
  // The first frame, ahead of the snapshot.
  expect(client.frames[0]).toBe(hello);
  expect(hello).toMatchObject({ protocol: PROTOCOL_VERSION, heartbeatMs: HEARTBEAT_MS });
});

// ---------------------------------------------------------------------------
// snapshot push coalescing
// ---------------------------------------------------------------------------

// engine/server.test.ts:861
conformance(
  "protocol",
  "snapshot push coalescing › pushes a burst of emits as one frame carrying the latest",
  async (t) => {
    // Against the default window (by decision, no knob). 01 is held until the
    // socket is open, so the socket sees the whole burst its exit sets off.
    const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
    const release = join(world.root, "release-01");
    world.stubs.script("01", { waitFor: release });
    const server = await t.start(world);
    await until(
      () => snapshotOf(server),
      (s) => s !== null && statusOf(s, "01") === "in-progress",
      { what: "01 to be in flight" },
    );
    const client = await t.socket(server);
    await client.sync();
    const from = client.seqs.at(-1)!;
    const start = client.seqs.length - 1;

    writeFileSync(release, "go");
    // A route reads the engine's last emit at once.
    const final = await settled(server, (s) => s.state.interrupts.length > 0);
    await client.waitFor(() => client.seqs.at(-1) === final.seq, { what: "the socket to reach the last emit" });
    // Fewer frames than emits, in order, and the last is the run's last emit.
    const seqs = client.seqs.slice(start);
    expect(seqs[0]).toBe(from);
    expect(seqs.length).toBeLessThan(final.seq - from + 1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.at(-1)).toBe(final.seq);
  },
);

// engine/server.test.ts:884
conformance("protocol", "snapshot push coalescing › pushes a waiting snapshot before the sockets close", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  const server = await t.start(world);
  await settled(server, (s) => s.state.interrupts.length > 0);
  expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
  await settled(server, (s) => s.phase === "done", "the run to end");

  const client = await t.socket(server);
  await client.sync();
  const stop = await server.http.post("/api/stop");
  expect(stop.status).toBe(202);
  expect(await client.closed).toEqual(CLOSE_STOPPED);
  expect(client.pushed?.snapshot.phase).toBe("stopped");
  await until(() => server.exited(), (gone) => gone, { what: "the server to exit" });
});

// ---------------------------------------------------------------------------
// ticket events endpoint
// ---------------------------------------------------------------------------

// engine/server.test.ts:906
conformance("http", "ticket events endpoint › serves a ticket's parsed events after a run", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  const server = await t.start(world);
  await settled(server, (s) => s.state.interrupts.length > 0);
  expect((await resume(server, { ticketId: REVIEW, action: "approve" })).status).toBe(202);
  await settled(server, (s) => s.phase === "done", "the run to end");

  const answer = await server.http.get("/api/events?ticket=01");
  expect(answer.status).toBe(200);
  const body = answer.json<TicketEventsResponse>();
  expect(body.reconstructed).toBe(false);
  expect(body.attempts).toEqual([]);
  expect(body.events.map((event) => event.kind)).toEqual(["scheduled", "spawned", "exited"]);
  expect(body.events[0]!.attempt).toBe(1);
  expect(typeof body.events[0]!.at).toBe("string");
  expect(body.events.find((event) => event.kind === "exited")?.payload).toEqual({
    code: 0,
    status: "done",
    logTail: [],
    outcomeExists: true,
  });
});

// engine/server.test.ts:942
conformance("http", "ticket events endpoint › backfills reconstructed attempt rows for a ticket with no events file", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: marker("01", "done") }],
    config: DEFAULTS,
    poolFiles: { "runs/01.log": "first attempt output\n", "runs/01.attempt-2.log": "second attempt output\n" },
  });
  // Distinct modification times, so the reconstruction orders the attempts
  // the way they happened.
  const now = Date.now();
  utimesSync(join(world.pool, "runs", "01.log"), new Date(now - 60_000), new Date(now - 60_000));
  utimesSync(join(world.pool, "runs", "01.attempt-2.log"), new Date(now), new Date(now));
  const server = await t.start(world);

  const answer = await server.http.get("/api/events?ticket=01");
  expect(answer.status).toBe(200);
  const body = answer.json<TicketEventsResponse>();
  expect(body.reconstructed).toBe(true);
  expect(body.events).toEqual([]);
  expect(body.attempts).toEqual([
    { attempt: 1, logFile: "01.log", modifiedAt: new Date(now - 60_000).toISOString() },
    { attempt: 2, logFile: "01.attempt-2.log", modifiedAt: new Date(now).toISOString() },
  ]);
});

// engine/server.test.ts:978
conformance("http", "ticket events endpoint › rejects a ticket id the pool does not own", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  const server = await t.start(world);
  expect((await server.http.get("/api/events?ticket=zzz")).status).toBe(404);
});

// engine/server.test.ts:986
conformance("http", "ticket events endpoint › serves the ticket's spec text alongside its events", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-a.md",
        content: `${marker("01", "ready")}\n\n# Ticket body\n\nSpec: what to build\n\n## Details\nmore\n`,
      },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  await settled(server, (s) => s.state.interrupts.length > 0);

  const body = (await server.http.get("/api/events?ticket=01")).json<TicketEventsResponse>();
  expect(body.spec).toContain("what to build");
  expect(body.spec).not.toContain("Ticket body");
});

// ---------------------------------------------------------------------------
// pool meta refresh
// ---------------------------------------------------------------------------

// engine/server.test.ts:1012
conformance("http", "pool meta refresh › renders a ticket file added after boot as a card on the next snapshot", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "ready") }], config: DEFAULTS });
  world.stubs.script("01", { statuses: ["checkpoint", "done"] });
  const server = await t.start(world);
  const first = await settled(server, (s) => s.state.interrupts.length > 0);
  expect(first.state.tickets.map((ticket) => ticket.id)).toEqual(["01"]);

  // A ticket file lands after boot, the way the engine writes a Spawn
  // adoption: an ordinary issues/<id>.md with the usual line-1 marker.
  writeFileSync(join(world.pool, "issues", "02-late.md"), `${marker("02", "ready")}\n\n# body\n`);

  // Answering 01's checkpoint drives fresh snapshots, which carry the late
  // ticket's card without a restart.
  expect((await resume(server, { ticketId: "01", action: "resume" })).status).toBe(202);
  const resumed = await settled(
    server,
    (s) => statusOf(s, "01") === "done" && s.state.tickets.some((ticket) => ticket.id === "02"),
    "the late ticket's card",
  );
  const late = resumed.state.tickets.find((ticket) => ticket.id === "02");
  expect(late?.title).toBe("body");
  expect(late?.blockedBy).toEqual([]);
});

// engine/server.test.ts:1037
conformance("http", "pool meta refresh › accepts a late-arriving ticket id on the events and log endpoints", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "done") }], config: DEFAULTS });
  const server = await t.start(world);
  await settled(server);

  // The ticket file and an attempt log land after boot; both endpoints
  // answer for the late id the way they would for one present at boot.
  writeFileSync(join(world.pool, "issues", "02-late.md"), `${marker("02", "done")}\n\n# body\n`);
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  writeFileSync(join(world.pool, "runs", "02.log"), "late attempt output\n");

  const events = await server.http.get("/api/events?ticket=02");
  expect(events.status).toBe(200);
  const eventsBody = events.json<TicketEventsResponse>();
  expect(eventsBody.reconstructed).toBe(true);
  expect(eventsBody.events).toEqual([]);
  expect(eventsBody.attempts.map((a) => [a.attempt, a.logFile])).toEqual([[1, "02.log"]]);

  const log = await server.http.get("/api/log?ticket=02");
  expect(log.status).toBe(200);
  expect(log.json<TicketLogResponse>().content).toContain("late attempt output");
});

// ---------------------------------------------------------------------------
// ticket body endpoint
// ---------------------------------------------------------------------------

// engine/server.test.ts:1417
conformance("http", "ticket body endpoint › serves the ticket's body for an exact <id>.md file", async (t) => {
  const world = t.world({ tickets: [{ file: "01.md", marker: marker("01", "done") }], config: DEFAULTS });
  const server = await t.start(world);
  const answer = await server.http.get("/api/ticket?id=01");
  expect(answer.status).toBe(200);
  expect(answer.json<TicketBodyResponse>()).toEqual({ id: "01", body: "# body\n" });
});

// engine/server.test.ts:1428
conformance("http", "ticket body endpoint › resolves an <id>-<slug>.md file by its prefix before the first '-'", async (t) => {
  const world = t.world({ tickets: [{ file: "01-ticket-body.md", marker: marker("01", "done") }], config: DEFAULTS });
  const server = await t.start(world);
  const answer = await server.http.get("/api/ticket?id=01");
  expect(answer.status).toBe(200);
  expect(answer.json<TicketBodyResponse>()).toEqual({ id: "01", body: "# body\n" });
});

// engine/server.test.ts:1439
conformance("http", "ticket body endpoint › strips the line-1 state marker from the served body", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-a.md", content: `${marker("01", "done")}\n\n# Ticket body\n\nSpec: what to build\n` }],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  const body = (await server.http.get("/api/ticket?id=01")).json<TicketBodyResponse>();
  expect(body.body).not.toContain("<!--");
  expect(body.body).toBe("# Ticket body\n\nSpec: what to build\n");
});

// engine/server.test.ts:1459
conformance("http", "ticket body endpoint › answers 404 for an id with no Issue file", async (t) => {
  const world = t.world({ tickets: [{ file: "01-a.md", marker: marker("01", "done") }], config: DEFAULTS });
  const server = await t.start(world);
  const answer = await server.http.get("/api/ticket?id=zzz");
  expect(answer.status).toBe(404);
  expect(answer.json<{ error: string }>()).toEqual({ error: "not found" });
});

// The gap at engine/server.ts:958 (NOT-PORTED.md, http): the Ticket's own file answers, whatever order the
// directory lists it and an adopted 01-spawn-1.md in. The own file is written first and named to sort after
// the child, so a sorted listing and tmpfs's newest-first one both list the child first.
conformance("http", "ticket body endpoint › serves the file whose state line names the id beside an adopted spawn", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-task.md", content: `${marker("01", "done")}\n\n# Own body\n` },
      { file: "01-spawn-1.md", content: `${marker("01-spawn-1", "done", "none", " spawned-by=01")}\n\n# Spawned child\n` },
    ],
    config: DEFAULTS,
  });
  const server = await t.start(world);
  expect((await server.http.get("/api/ticket?id=01")).json<TicketBodyResponse>()).toEqual({ id: "01", body: "# Own body\n" });
  expect((await server.http.get("/api/ticket?id=01-spawn-1")).json<TicketBodyResponse>()).toEqual({
    id: "01-spawn-1",
    body: "# Spawned child\n",
  });
});

// The same gap, whatever the listing order: an adopted spawn's file never answers for the id its name starts
// with, even when no other file does. A pool whose only file is 01-spawn-1.md does not load, its spawned-by
// naming no Ticket, so the spawn here is a Conversation's, and conv-1-spawn-1.md starts with `conv-`.
conformance("http", "ticket body endpoint › answers 404 for an id whose only prefixed file is an adopted spawn", async (t) => {
  const world = t.world({
    tickets: [
      { file: "conv-1-spawn-1.md", content: `${marker("conv-1-spawn-1", "done", "none", " spawned-by=conv-1")}\n\n# Spawned child\n` },
    ],
    config: DEFAULTS,
    poolFiles: {
      "conversations/conv-1.md":
        "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude " +
        "model=m drivers=implement -->\n\n# Talk\n\n\n",
    },
  });
  const server = await t.start(world);
  const answer = await server.http.get("/api/ticket?id=conv");
  expect(answer.status).toBe(404);
  expect(answer.json<{ error: string }>()).toEqual({ error: "not found" });
});
