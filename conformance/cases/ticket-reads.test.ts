/**
 * The per-Ticket read routes, seen from outside the server (ADR-0036): the
 * grades endpoint, the Merge queue labels on /api/state, the attempt log
 * endpoint and the activity endpoint. Ported from engine/server.test.ts.
 *
 * The engine tests read a server that never started its drive; a server
 * under test always drives, so these pools seed their Tickets done (nothing
 * runs) and the routes read the seeded runs/ files exactly as a cold server
 * would.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnrichedSnapshot,
  PoolConfig,
  TicketActivityResponse,
  TicketEvent,
  TicketGradeSummary,
  TicketLogResponse,
} from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" } };

/** engine/server.ts LOG_CHUNK_BYTES: the most one log read serves. */
const LOG_CHUNK_BYTES = 64 * 1024;
/** engine/server.ts ACTIVITY_CACHE_TTL_MS: how long an activity read is reused. */
const ACTIVITY_CACHE_TTL_MS = 1500;

const done = (id: string) => `<!-- state: id=${id} blocked-by=none status=done -->`;

/** Events as runs/<id>.events.jsonl holds them, one JSON line each. */
function jsonl(events: TicketEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

const ev = (
  attempt: number,
  kind: TicketEvent["kind"],
  payload: Record<string, unknown> = {},
  at = "t",
): TicketEvent => ({ at, attempt, kind, payload });

/**
 * The pool key a repository's branches and worktrees are namespaced by, as
 * engine/worktrees.ts poolKeyFor derives it: the first 8 hex digits of the
 * sha256 of the repository root's real path.
 */
function poolKey(repo: string): string {
  return createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 8);
}

/** engine/worktrees.ts branchFor: the branch a Ticket's work is parked on. */
function branchFor(repo: string, id: string): string {
  return `pool/${poolKey(repo)}/${id}`;
}

/** A pool of done Tickets (01 unless named) carrying the given runs/ files. */
function runsWorld(t: Case, runs: Record<string, string>, ids: string[] = ["01"]): World {
  const poolFiles: Record<string, string> = {};
  for (const [name, content] of Object.entries(runs)) poolFiles[`runs/${name}`] = content;
  return t.world({
    tickets: ids.map((id) => ({ file: `${id}-a.md`, marker: done(id) })),
    config: CONFIG,
    poolFiles,
  });
}

async function getJson<T>(server: CaseServer, path: string): Promise<{ status: number; body: T }> {
  const answer = await server.http.get(path);
  return { status: answer.status, body: answer.json<T>() };
}

// ---------------------------------------------------------------------------
// grades endpoint
// ---------------------------------------------------------------------------

type Grades = { grades: Record<string, TicketGradeSummary> };

// engine/server.test.ts:1074
conformance("verify", "grades endpoint › serves each ticket's latest grade, skipping tickets without one", async (t) => {
  const world = runsWorld(
    t,
    {
      "01.events.jsonl": jsonl([
        ev(1, "graded", { score: 4, verdict: "flag", reasons: "first" }, "2026-09-02T10:00:00.000Z"),
        ev(2, "graded", { score: 8, verdict: "pass", reasons: "second" }, "2026-09-02T11:00:00.000Z"),
      ]),
    },
    ["01", "02"],
  );
  const server = await t.start(world);

  const { status, body } = await getJson<Grades>(server, "/api/grades");
  expect(status).toBe(200);
  expect(body.grades).toEqual({
    "01": { attempt: 2, score: 8, verdict: "pass", winner: null },
  });
});

// engine/server.test.ts:1108
conformance("verify", "grades endpoint › names the selected attempt as winner while its merge is still pending", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([
      ev(1, "graded", { score: 9, verdict: "pass", reasons: "winner" }, "2026-09-02T10:00:00.000Z"),
      ev(2, "graded", { score: 5, verdict: "flag", reasons: "loser, graded last" }, "2026-09-02T11:00:00.000Z"),
      ev(1, "selected", { score: 9, margin: 4, rule: "outright" }, "2026-09-02T12:00:00.000Z"),
    ]),
  });
  const server = await t.start(world);

  const { body } = await getJson<Grades>(server, "/api/grades");
  expect(body.grades).toEqual({
    "01": { attempt: 1, score: 9, verdict: "pass", winner: 1 },
  });
});

// engine/server.test.ts:1144
conformance("verify", "grades endpoint › serves nothing when the selected winner's own grade is malformed", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([
      ev(1, "graded", { score: 9, verdict: "pass" }, "2026-09-02T10:00:00.000Z"),
      ev(2, "graded", { score: 5, verdict: "flag", reasons: "loser" }, "2026-09-02T11:00:00.000Z"),
      ev(1, "selected", { score: 9, margin: 4, rule: "outright" }, "2026-09-02T12:00:00.000Z"),
    ]),
  });
  const server = await t.start(world);

  const { body } = await getJson<Grades>(server, "/api/grades");
  expect(body.grades).toEqual({});
});

// engine/server.test.ts:1173
conformance("verify", "grades endpoint › serves the merged attempt's grade when there is no selected event", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([
      ev(1, "graded", { score: 7, verdict: "pass", reasons: "winner" }, "2026-09-02T10:00:00.000Z"),
      ev(2, "graded", { score: 3, verdict: "flag", reasons: "loser, graded last" }, "2026-09-02T11:00:00.000Z"),
      ev(1, "merged", {}, "2026-09-02T12:00:00.000Z"),
    ]),
  });
  const server = await t.start(world);

  const { body } = await getJson<Grades>(server, "/api/grades");
  expect(body.grades).toEqual({
    "01": { attempt: 1, score: 7, verdict: "pass", winner: 1 },
  });
});

// engine/server.test.ts:1209
conformance("verify", "grades endpoint › serves no grade for a graded event without reasons", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([ev(1, "graded", { score: 8, verdict: "pass" }, "2026-09-02T10:00:00.000Z")]),
  });
  const server = await t.start(world);

  const { body } = await getJson<Grades>(server, "/api/grades");
  expect(body.grades).toEqual({});
});

// engine/server.test.ts:1226
conformance("verify", "grades endpoint › skips a graded event whose payload is malformed", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([ev(1, "graded", { score: "eight" }, "2026-09-02T10:00:00.000Z")]),
  });
  const server = await t.start(world);

  const { status, body } = await getJson<Grades>(server, "/api/grades");
  expect(status).toBe(200);
  expect(body.grades).toEqual({});
});

// ---------------------------------------------------------------------------
// merge queue enrichment
// ---------------------------------------------------------------------------

/** Park pool/<key>/<id> with one commit the current branch lacks, then go back. */
function parkBranch(world: World, id: string, back = "main"): void {
  world.git(["checkout", "-q", "-b", branchFor(world.repo, id)]);
  writeFileSync(join(world.repo, `w-${id}.txt`), `work for ${id}\n`);
  world.git(["add", `w-${id}.txt`]);
  world.git(["commit", "-qm", `work ${id}`]);
  world.git(["checkout", "-q", back]);
}

type StateBody = { snapshot: EnrichedSnapshot | null };

async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot | null> {
  return (await getJson<StateBody>(server, "/api/state")).body.snapshot;
}

function ticketOf(snapshot: EnrichedSnapshot | null, id: string) {
  return snapshot?.state.tickets.find((ticket) => ticket.id === id);
}

// engine/server.test.ts:1304
conformance(
  "merges",
  "merge queue enrichment › labels a done ticket whose parked branch has not landed, and drops the label once a manual merge lands",
  async (t) => {
    const world = t.world({ tickets: [{ file: "01-a.md", marker: done("01") }], config: CONFIG });
    parkBranch(world, "01");
    const server = await t.start(world);

    // Parked and unmerged before boot, nothing raised on it: stalled.
    const first = await until(
      () => snapshotOf(server),
      (snapshot) => ticketOf(snapshot, "01")?.mergeState != null,
      { what: "01's merge label", ms: 20_000 },
    );
    expect(ticketOf(first, "01")).toMatchObject({ id: "01", status: "done", mergeState: "stalled" });

    // A manual merge, branch kept, lifts the label with no Console action.
    world.git(["merge", "--no-edit", branchFor(world.repo, "01")]);
    const after = await until(
      () => snapshotOf(server),
      (snapshot) => ticketOf(snapshot, "01")?.mergeState === null,
      { what: "the label to lift after the manual merge", ms: 20_000 },
    );
    expect(ticketOf(after, "01")).toMatchObject({ id: "01", status: "done", mergeState: null });
  },
);

// engine/server.test.ts:1343
conformance(
  "merges",
  "merge queue enrichment › reads the merge target as the working branch, so a feature branch holds a label main would clear",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: done("01") },
        { file: "02-b.md", marker: done("02") },
      ],
      config: CONFIG,
    });
    // 02 lands in main, then feature/x is cut from main before that merge.
    world.git(["checkout", "-q", "-b", branchFor(world.repo, "02")]);
    writeFileSync(join(world.repo, "w-02.txt"), "work 02\n");
    world.git(["add", "w-02.txt"]);
    world.git(["commit", "-qm", "work 02"]);
    world.git(["checkout", "-q", "main"]);
    world.git(["merge", "--no-edit", branchFor(world.repo, "02")]);
    world.git(["checkout", "-q", "-b", "feature/x", "main~1"]);
    writeFileSync(join(world.repo, "f.txt"), "feature\n");
    world.git(["add", "f.txt"]);
    world.git(["commit", "-qm", "feature"]);
    parkBranch(world, "01", "main");
    world.git(["checkout", "-q", "feature/x"]);
    const server = await t.start(world);

    const snapshot = await until(
      () => snapshotOf(server),
      (got) => (got?.state.mergeQueue.length ?? 0) >= 2,
      { what: "both Tickets on the Merge queue", ms: 20_000 },
    );
    expect(ticketOf(snapshot, "01")).toMatchObject({ status: "done", mergeState: "stalled" });
    // Merged into main but not into feature/x: the target is the working branch.
    expect(ticketOf(snapshot, "02")).toMatchObject({ status: "done", mergeState: "stalled" });
    expect(snapshot?.state.mergeQueue).toEqual([
      { ticketId: "01", state: "stalled" },
      { ticketId: "02", state: "stalled" },
    ]);
  },
);

// engine/server.test.ts:1384
conformance(
  "restart",
  "merge queue enrichment › drops the label when the ticket reopens: a restart re-derives and the re-run's merge lands",
  async (t) => {
    const world = t.world({ tickets: [{ file: "01-a.md", marker: done("01") }], config: CONFIG });
    parkBranch(world, "01");
    const first = await t.start(world);
    const before = await until(
      () => snapshotOf(first),
      (snapshot) => ticketOf(snapshot, "01")?.mergeState != null,
      { what: "01's merge label", ms: 20_000 },
    );
    expect(ticketOf(before, "01")).toMatchObject({ status: "done", mergeState: "stalled" });
    await first.stop();

    // Reopen 01 by its marker alone; the restarted server re-derives from it.
    const file = join(world.pool, "issues", "01-a.md");
    writeFileSync(file, (await Bun.file(file).text()).replace("status=done", "status=ready"));
    const second = await t.start(world);

    const worktree = join(world.repo, ".git", "pool-worktrees", poolKey(world.repo), "01");
    const after = await until(
      async () => ({ snapshot: await snapshotOf(second), worktreeGone: !(await Bun.file(join(worktree, ".git")).exists()) }),
      ({ snapshot, worktreeGone }) =>
        snapshot?.phase === "quiescent" &&
        ticketOf(snapshot, "01")?.status === "done" &&
        ticketOf(snapshot, "01")?.mergeState === null &&
        worktreeGone,
      { what: "the re-run to land its merge and settle", ms: 30_000 },
    );
    expect(ticketOf(after.snapshot, "01")).toMatchObject({ status: "done", mergeState: null });
    // The re-run reused the parked branch: its work is on main now.
    expect(world.git(["show", "main:w-01.txt"])).toBe("work for 01\n");
    expect(await Bun.file(worktree).exists()).toBe(false);
  },
  { timeoutMs: 90_000 },
);

// ---------------------------------------------------------------------------
// ticket log endpoint
// ---------------------------------------------------------------------------

const BIG = "x".repeat(LOG_CHUNK_BYTES + 16) + "\n";

// engine/server.test.ts:1473
conformance("http", "ticket log endpoint › serves an attempt's log from a byte offset with the total size", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": "0123456789abcdef\n" }));

  const { status, body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=4");
  expect(status).toBe(200);
  expect(body.offset).toBe(4);
  expect(body.content).toBe("456789abcdef\n");
  expect(body.totalSize).toBe(17);
  expect(body.nextOffset).toBe(17);
  expect(body.attempts).toEqual([
    { attempt: 1, kind: "reconstructed", logFile: "01.log", streamFile: null, current: true },
  ]);
});

// engine/server.test.ts:1504
conformance("http", "ticket log endpoint › strips ANSI escape sequences from the served content", async (t) => {
  const server = await t.start(
    runsWorld(t, { "01.log": "line \u001b[31mred\u001b[0m text\n\u001b]0;title\u0007next\n" }),
  );

  const { body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1");
  expect(body.content).toBe("line red text\nnext\n");
});

// engine/server.test.ts:1519
conformance("http", "ticket log endpoint › pages a log larger than one chunk through offsets", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": BIG }));

  const first = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=0")).body;
  expect(first.content).toHaveLength(LOG_CHUNK_BYTES);
  expect(first.nextOffset).toBe(LOG_CHUNK_BYTES);
  expect(first.totalSize).toBe(BIG.length);

  const second = (
    await getJson<TicketLogResponse>(server, `/api/log?ticket=01&attempt=1&offset=${first.nextOffset}`)
  ).body;
  expect(second.content).toBe("x".repeat(16) + "\n");
  expect(second.nextOffset).toBe(BIG.length);
});

// engine/server.test.ts:1545
conformance("http", "ticket log endpoint › does not split a multi-byte UTF-8 character across a chunk boundary", async (t) => {
  // é's two bytes straddle the first chunk's end.
  const server = await t.start(runsWorld(t, { "01.log": "a".repeat(LOG_CHUNK_BYTES - 1) + "é tail\n" }));

  const first = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=0")).body;
  expect(first.content).not.toContain("�");
  expect(first.nextOffset).toBe(LOG_CHUNK_BYTES - 1);

  const second = (
    await getJson<TicketLogResponse>(server, `/api/log?ticket=01&attempt=1&offset=${first.nextOffset}`)
  ).body;
  expect(second.content).toBe("é tail\n");
  expect(second.content).not.toContain("�");
});

// engine/server.test.ts:1572
conformance("http", "ticket log endpoint › does not split a multi-byte UTF-8 character at a range's head", async (t) => {
  // é at bytes 10 and 11; offset 11 is its continuation byte.
  const server = await t.start(runsWorld(t, { "01.log": `${"a".repeat(10)}é tail\n` }));

  const { body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=11");
  expect(body.content).toBe(" tail\n");
  expect(body.content).not.toContain("�");
  expect(body.offset).toBe(12);
  expect(body.nextOffset).toBe(18);
  expect(body.totalSize).toBe(18);
});

// engine/server.test.ts:1597
conformance("http", "ticket log endpoint › returns empty content for an offset at or past the end", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": "short\n" }));

  const { body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=100");
  expect(body.content).toBe("");
  expect(body.totalSize).toBe(6);
});

// engine/server.test.ts:1610
conformance("http", "ticket log endpoint › serves a bounded range when end is given, for load-earlier prefix reads", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": "0123456789abcdef\n" }));

  const { status, body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=4&end=10");
  expect(status).toBe(200);
  expect(body.offset).toBe(4);
  expect(body.content).toBe("456789");
  expect(body.nextOffset).toBe(10);
  expect(body.totalSize).toBe(17);
});

// engine/server.test.ts:1631
conformance("http", "ticket log endpoint › clamps a requested end to one chunk past the offset", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": BIG }));

  const { body } = await getJson<TicketLogResponse>(server, `/api/log?ticket=01&attempt=1&offset=0&end=${BIG.length}`);
  expect(body.content).toHaveLength(LOG_CHUNK_BYTES);
  expect(body.nextOffset).toBe(LOG_CHUNK_BYTES);
});

// engine/server.test.ts:1647
conformance("http", "ticket log endpoint › trims a partial UTF-8 character at a bounded range's end", async (t) => {
  // é at bytes 10 and 11: a range ending at 11 holds only its lead byte.
  const server = await t.start(runsWorld(t, { "01.log": `${"a".repeat(10)}é tail\n` }));

  const { body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1&offset=0&end=11");
  expect(body.content).toBe("a".repeat(10));
  expect(body.content).not.toContain("�");
  expect(body.nextOffset).toBe(10);
});

// engine/server.test.ts:1663
conformance("http", "ticket log endpoint › lists event-based attempts with their rotated log files and stream files", async (t) => {
  // Implement attempt 1 rotated away, resolver attempt 2 current, implement attempt 3 current.
  const server = await t.start(
    runsWorld(t, {
      "01.events.jsonl": jsonl([
        ev(1, "spawned"),
        ev(1, "exited"),
        ev(2, "resolver"),
        ev(3, "spawned"),
        ev(3, "exited"),
      ]),
      "01.attempt-1.log": "first\n",
      "01.resolver.log": "resolver\n",
      "01.log": "third\n",
      "01.attempt-1.stream.jsonl": "stream-one\n",
      "01.resolver.stream.jsonl": "stream-resolver\n",
      "01.stream.jsonl": "stream-third\n",
    }),
  );

  const { status, body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1");
  expect(status).toBe(200);
  expect(body.content).toBe("first\n");
  expect(body.attempts).toEqual([
    { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl", current: false },
    { attempt: 2, kind: "resolver", logFile: "01.resolver.log", streamFile: "01.resolver.stream.jsonl", current: true },
    { attempt: 3, kind: "implement", logFile: "01.log", streamFile: "01.stream.jsonl", current: true },
  ]);

  const third = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=3")).body;
  expect(third.content).toBe("third\n");
});

// engine/server.test.ts:1725
conformance("http", "ticket log endpoint › serves an attempt's stream file through the same byte-range path", async (t) => {
  const server = await t.start(
    runsWorld(t, {
      "01.events.jsonl": jsonl([ev(1, "spawned"), ev(1, "exited")]),
      "01.log": "derived log\n",
      "01.stream.jsonl": '{"type":"assistant"}\n',
    }),
  );

  const { status, body } = await getJson<TicketLogResponse>(
    server,
    "/api/log?ticket=01&attempt=1&offset=1&end=5&stream=1",
  );
  expect(status).toBe(200);
  expect(body.content).toBe('"typ');
  expect(body.offset).toBe(1);
  expect(body.nextOffset).toBe(5);
  expect(body.totalSize).toBe(21);
  // The derived log keeps serving under the plain request.
  const log = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=1")).body;
  expect(log.content).toBe("derived log\n");
});

// engine/server.test.ts:1757
conformance("http", "ticket log endpoint › answers 404 with a no-stream-file error for an attempt that has none", async (t) => {
  // Attempt 1 streamed; attempt 2 (current) has only the derived log.
  const server = await t.start(
    runsWorld(t, {
      "01.events.jsonl": jsonl([ev(1, "spawned"), ev(1, "exited"), ev(2, "spawned"), ev(2, "exited")]),
      "01.attempt-1.log": "one\n",
      "01.attempt-1.stream.jsonl": "stream-one\n",
      "01.log": "two\n",
    }),
  );

  const listing = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=2")).body;
  expect(listing.attempts).toEqual([
    { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl", current: false },
    { attempt: 2, kind: "implement", logFile: "01.log", streamFile: null, current: true },
  ]);
  const noStream = await getJson<{ error: string }>(server, "/api/log?ticket=01&attempt=2&stream=1");
  expect(noStream.status).toBe(404);
  expect(noStream.body.error).toBe("no stream file for attempt 2 of 01");
  const unknown = await getJson<{ error: string }>(server, "/api/log?ticket=01&attempt=99&stream=1");
  expect(unknown.status).toBe(404);
  expect(unknown.body.error).toBe("unknown attempt 99 for 01");
});

// engine/server.test.ts:1804
conformance("http", "ticket log endpoint › serves a verify fan-out's current attempt through its attempt-numbered log", async (t) => {
  // Three attempts, none ever holding the well-known log or Stream file names.
  const server = await t.start(
    runsWorld(t, {
      "01.events.jsonl": jsonl([ev(1, "spawned"), ev(2, "spawned"), ev(3, "spawned"), ev(3, "exited")]),
      "01.attempt-1.log": "first\n",
      "01.attempt-2.log": "second\n",
      "01.attempt-3.log": "third\n",
      "01.attempt-1.stream.jsonl": "stream-one\n",
      "01.attempt-2.stream.jsonl": "stream-two\n",
      "01.attempt-3.stream.jsonl": "stream-three\n",
    }),
  );

  const { status, body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=3");
  expect(status).toBe(200);
  expect(body.content).toBe("third\n");
  expect(body.attempts).toEqual([
    { attempt: 1, kind: "implement", logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl", current: false },
    { attempt: 2, kind: "implement", logFile: "01.attempt-2.log", streamFile: "01.attempt-2.stream.jsonl", current: false },
    { attempt: 3, kind: "implement", logFile: "01.attempt-3.log", streamFile: "01.attempt-3.stream.jsonl", current: true },
  ]);

  const stream = (await getJson<TicketLogResponse>(server, "/api/log?ticket=01&attempt=2&stream=1")).body;
  expect(stream.content).toBe("stream-two\n");
});

// engine/server.test.ts:1847
conformance("http", "ticket log endpoint › defaults to the latest attempt when none is named", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": "latest\n" }));

  const { body } = await getJson<TicketLogResponse>(server, "/api/log?ticket=01");
  expect(body.content).toBe("latest\n");
  expect(body.attempts).toHaveLength(1);
});

// engine/server.test.ts:1860
conformance("http", "ticket log endpoint › rejects an unknown attempt number", async (t) => {
  const server = await t.start(runsWorld(t, { "01.log": "latest\n" }));

  const answer = await server.http.get("/api/log?ticket=01&attempt=99");
  expect(answer.status).toBe(404);
});

// engine/server.test.ts:1871
conformance("http", "ticket log endpoint › rejects a ticket id the pool does not own", async (t) => {
  const server = await t.start(runsWorld(t, {}));

  const answer = await server.http.get("/api/log?ticket=zzz&attempt=1");
  expect(answer.status).toBe(404);
});

// ---------------------------------------------------------------------------
// ticket activity endpoint
// ---------------------------------------------------------------------------

const T0 = "2026-01-01T00:00:00.000Z";

/** A real git repository beside the pool, to be an attempt's recorded worktree. */
function makeGitRepo(world: World, seed: Record<string, string>): { dir: string; git(args: string[]): void } {
  const dir = join(world.root, "activity-worktree");
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]): void => {
    const run = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: world.home },
    });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pool@test"]);
  git(["config", "user.name", "pool"]);
  git(["config", "commit.gpgsign", "false"]);
  for (const [path, content] of Object.entries(seed)) writeFileSync(join(dir, path), content);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return { dir, git };
}

/** The spawned event an attempt in `repo` records. */
const spawnedIn = (repo: string): TicketEvent => ev(1, "spawned", { cwd: repo, branch: branchFor(repo, "01") }, T0);

/** Write runs/01.events.jsonl into a world already made. */
function writeEvents(world: World, events: TicketEvent[]): void {
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  writeFileSync(join(world.pool, "runs", "01.events.jsonl"), jsonl(events));
}

// engine/server.test.ts:1956
conformance("http", "ticket activity endpoint › totals a mixed staged, unstaged and untracked worktree diff", async (t) => {
  const world = runsWorld(t, {});
  const repo = makeGitRepo(world, { "tracked-a.txt": "base\n", "tracked-b.txt": "keep\n" });
  // staged: +3 -1 on tracked-a
  writeFileSync(join(repo.dir, "tracked-a.txt"), "one\ntwo\nthree\n");
  repo.git(["add", "tracked-a.txt"]);
  // unstaged: +1 on tracked-b
  writeFileSync(join(repo.dir, "tracked-b.txt"), "keep\nextra\n");
  // untracked: +4
  writeFileSync(join(repo.dir, "new-file.md"), "a\nb\nc\nd\n");
  writeEvents(world, [spawnedIn(repo.dir)]);
  const server = await t.start(world);

  const { status, body } = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
  expect(status).toBe(200);
  expect(body.ticketId).toBe("01");
  expect(body.diff).toEqual({
    added: 8,
    removed: 1,
    files: ["tracked-a.txt", "tracked-b.txt", "new-file.md"],
  });
});

// engine/server.test.ts:1984
conformance("http", "ticket activity endpoint › caps untracked files at 100 and line-counts only files under 256KB", async (t) => {
  const world = runsWorld(t, {});
  const repo = makeGitRepo(world, { "seed.txt": "seed\n" });
  for (let i = 1; i <= 101; i++) {
    writeFileSync(join(repo.dir, `u-${String(i).padStart(3, "0")}.txt`), "line\n");
  }
  // Over the per-file read cap: still a touched file, but no line counts.
  writeFileSync(join(repo.dir, "big.bin"), "x".repeat(300 * 1024));
  writeEvents(world, [spawnedIn(repo.dir)]);
  const server = await t.start(world);

  const { body } = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
  // big.bin sorts first and takes a slot, so 99 small files fit under the cap.
  expect(body.diff?.files).toHaveLength(100);
  expect(body.diff?.files).toContain("big.bin");
  expect(body.diff?.files).not.toContain("u-101.txt");
  expect(body.diff?.added).toBe(99);
  expect(body.diff?.removed).toBe(0);
});

// engine/server.test.ts:2005
conformance("http", "ticket activity endpoint › serves diff null for legacy events with no recorded cwd", async (t) => {
  const world = runsWorld(t, {
    "01.events.jsonl": jsonl([ev(1, "spawned", {}, T0), ev(1, "exited", { code: 0, status: "done" }, T0)]),
  });
  const server = await t.start(world);

  const { status, body } = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
  expect(status).toBe(200);
  expect(body.diff).toBeNull();
  expect(body.running).toBe(false);
  expect(body.lastEventAt).toBe(T0);
});

// engine/server.test.ts:2020
conformance("http", "ticket activity endpoint › serves an empty payload for a ticket with no events at all", async (t) => {
  const server = await t.start(runsWorld(t, {}));

  const { body } = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
  expect(body).toEqual({ ticketId: "01", running: false, diff: null, log: null, lastEventAt: null });
});

// engine/server.test.ts:2034
conformance("http", "ticket activity endpoint › 404s an unknown ticket id", async (t) => {
  const server = await t.start(runsWorld(t, {}));

  const answer = await server.http.get("/api/activity?ticket=zzz");
  expect(answer.status).toBe(404);
});

// engine/server.test.ts:2042
conformance(
  "http",
  "ticket activity endpoint › reports the attempt log's size and last write with the ticket's last event time",
  async (t) => {
    const world = runsWorld(t, { "01.log": "hello\n" });
    const repo = makeGitRepo(world, { "seed.txt": "seed\n" });
    utimesSync(join(world.pool, "runs", "01.log"), new Date(0), new Date(1000));
    writeEvents(world, [spawnedIn(repo.dir), ev(1, "exited", { code: 0, status: "done" }, T0)]);
    const server = await t.start(world);

    const { body } = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
    expect(body.log).toEqual({ size: 6, mtime: "1970-01-01T00:00:01.000Z" });
    expect(body.lastEventAt).toBe(T0);
    expect(body.running).toBe(false);
  },
);

// engine/server.test.ts:2061
conformance(
  "http",
  "ticket activity endpoint › reports running while the snapshot shows a live attempt, and not once it has ended",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: done("02") },
      ],
      config: CONFIG,
    });
    const sentinel = join(world.root, "release-01");
    // 01's attempt holds until the sentinel appears (the stub gives up after ten seconds).
    world.stubs.script("01", { waitFor: sentinel });
    const server = await t.start(world);

    await until(
      () => snapshotOf(server),
      (snapshot) => ticketOf(snapshot, "01")?.liveAttempt != null,
      { what: "01's attempt to be live on the snapshot", ms: 20_000 },
    );
    const live = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01");
    // 02 was done before boot and never spawned: nothing live.
    const idle = await getJson<TicketActivityResponse>(server, "/api/activity?ticket=02");
    writeFileSync(sentinel, "");
    expect(live.body.running).toBe(true);
    expect(idle.body.running).toBe(false);

    await until(
      () => snapshotOf(server),
      (snapshot) => snapshot?.phase === "quiescent" && ticketOf(snapshot, "01")?.liveAttempt === null,
      { what: "01's attempt to end and the pool to settle", ms: 20_000 },
    );
    await Bun.sleep(ACTIVITY_CACHE_TTL_MS + 50);
    expect((await getJson<TicketActivityResponse>(server, "/api/activity?ticket=01")).body.running).toBe(false);
  },
);
