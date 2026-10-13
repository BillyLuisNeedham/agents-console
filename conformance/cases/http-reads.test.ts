/**
 * The read routes over files a person or another process changes under the
 * server, seen from outside it (ADR-0036): the snapshot re-read after a Ticket
 * file is rewritten in place, a draft Ticket file the server cannot read yet,
 * the activity endpoint's worktree when the last Attempt recorded none or it
 * is gone, and the log endpoint at an escape still arriving and with empty
 * parameters. The first case is engine/stat-cache.test.ts:65; the rest are
 * the inventory's gaps beside engine/server.ts.
 *
 * A pool at rest emits nothing, so a hand edit reaches GET /api/state only
 * once something rebuilds the snapshot. These cases ask for it the way the
 * config cases do (rebuiltSnapshot): a Reassign naming only a done Ticket,
 * which writes nothing and rebuilds the snapshot from the files as they stand.
 */

import { expect } from "bun:test";
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent, TicketLogResponse } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import type { World } from "../harness/world.ts";
import { doneTicket, rebuiltSnapshot, ticketOf } from "./config-support.ts";
import { CLAUDE, REVIEW, interruptFor } from "./protocol-support.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

/** Events as runs/<id>.events.jsonl holds them, one JSON line each. */
function jsonl(events: TicketEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

/** A git repository beside the pool, one commit in, to be an Attempt's recorded worktree. */
function gitRepo(world: World, name: string): string {
  const dir = join(world.root, name);
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
  writeFileSync(join(dir, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return dir;
}

// engine/stat-cache.test.ts:65
conformance(
  "http",
  "file stamps › sees a same-size rewrite in place even with its modification time put back",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: "# Alpha" }],
      config: CLAUDE,
    });
    // Quiet an hour, so the server's read of it is one a stamp vouches for.
    const file = join(world.pool, "issues", "01-a.md");
    const quiet = new Date(Date.now() - 3_600_000);
    utimesSync(file, quiet, quiet);
    const server = await t.start(world);
    await interruptFor(server, REVIEW);
    expect(ticketOf(await rebuiltSnapshot(server, "01"), "01").title).toBe("Alpha");

    // The same size, in place, and its modification time put back: only the
    // change time, which nothing can set back, says the file moved.
    const before = statSync(file);
    writeFileSync(file, "<!-- state: id=01 blocked-by=none status=done -->\n\n# Omega\n");
    utimesSync(file, quiet, quiet);
    const after = statSync(file);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, before.mtimeMs]);

    expect(ticketOf(await rebuiltSnapshot(server, "01"), "01").title).toBe("Omega");
  },
);

// The gap at engine/server.ts:1244-1256
conformance("http", "pool meta refresh › keeps the last good Tickets while a Ticket file without a state line sits in issues/", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE });
  const server = await t.start(world);
  const rested = await interruptFor(server, REVIEW);
  const events = await server.http.get("/api/events?ticket=01");
  expect(events.status).toBe(200);

  // A draft the pool cannot load: no line-1 state line.
  writeFileSync(join(world.pool, "issues", "03-draft.md"), "# A draft\n\nNot a Ticket yet.\n");

  const again = await server.http.get("/api/events?ticket=01");
  expect(again.status).toBe(200);
  expectParsedEqual(again.text, events.text, "GET /api/events?ticket=01");
  const rebuilt = await rebuiltSnapshot(server, "01");
  expect(rebuilt.state.tickets).toEqual(rested.state.tickets);
});

// The gap at engine/server.ts:836-846
conformance("http", "ticket activity endpoint › reads the diff of the last Attempt that recorded a worktree", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE });
  const worktree = gitRepo(world, "attempt-1-worktree");
  writeFileSync(join(worktree, "notes.md"), "one\ntwo\n");
  // Attempt 2 recorded no worktree, as an event from before cwd was recorded.
  const events: TicketEvent[] = [
    { at: T0, attempt: 1, kind: "spawned", payload: { cwd: worktree } },
    { at: T1, attempt: 1, kind: "exited", payload: { code: 0, status: "checkpoint" } },
    { at: T2, attempt: 2, kind: "spawned", payload: {} },
  ];
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  writeFileSync(join(world.pool, "runs", "01.events.jsonl"), jsonl(events));
  const server = await t.start(world);
  await interruptFor(server, REVIEW);

  const res = await server.http.get("/api/activity?ticket=01");
  expect(res.status).toBe(200);
  expectParsedEqual(
    res.text,
    { ticketId: "01", running: false, diff: { added: 2, removed: 0, files: ["notes.md"] }, log: null, lastEventAt: T2 },
    "GET /api/activity?ticket=01",
  );
});

// The gap at engine/server.ts:851-852
conformance("http", "ticket activity endpoint › serves diff null for a recorded worktree that is gone, and the last event's time", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE });
  const events: TicketEvent[] = [
    { at: T0, attempt: 1, kind: "spawned", payload: { cwd: join(world.root, "removed-worktree") } },
    { at: T1, attempt: 1, kind: "exited", payload: { code: 0, status: "done" } },
  ];
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  writeFileSync(join(world.pool, "runs", "01.events.jsonl"), jsonl(events));
  const server = await t.start(world);
  await interruptFor(server, REVIEW);

  const res = await server.http.get("/api/activity?ticket=01");
  expect(res.status).toBe(200);
  expectParsedEqual(
    res.text,
    { ticketId: "01", running: false, diff: null, log: null, lastEventAt: T1 },
    "GET /api/activity?ticket=01",
  );
});

// The gap at engine/server.ts:596-609 and 654-660
conformance("http", "ticket log endpoint › stops a read at an escape sequence still arriving, and serves it whole once it ends", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01")],
    config: CLAUDE,
    poolFiles: { "runs/01.log": "ok \x1b[31" },
  });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);

  const first = await server.http.get("/api/log?ticket=01&attempt=1");
  expect(first.status).toBe(200);
  // Held at the ESC: the sequence has no final byte yet.
  expect(first.json<TicketLogResponse>()).toMatchObject({ content: "ok ", offset: 0, nextOffset: 3, totalSize: 7 });

  appendFileSync(join(world.pool, "runs", "01.log"), "mred\n");
  const second = await server.http.get("/api/log?ticket=01&attempt=1&offset=3");
  expect(second.status).toBe(200);
  expect(second.json<TicketLogResponse>()).toMatchObject({ content: "red\n", offset: 3, nextOffset: 12, totalSize: 12 });
});

// The gap at engine/server.ts:2431-2448
conformance("http", "ticket log endpoint › reads an empty parameter as one not given", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: CLAUDE, poolFiles: { "runs/01.log": "latest\n" } });
  const server = await t.start(world);
  await interruptFor(server, REVIEW);

  const plain = await server.http.get("/api/log?ticket=01");
  const empty = await server.http.get("/api/log?ticket=01&attempt=&offset=&end=");
  expect([plain.status, empty.status]).toEqual([200, 200]);
  expect(plain.json<TicketLogResponse>()).toMatchObject({ content: "latest\n", offset: 0, nextOffset: 7, totalSize: 7 });
  expectParsedEqual(empty.text, plain.text, "the read with empty parameters");
});
