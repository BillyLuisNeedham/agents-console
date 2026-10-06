/**
 * The Held and Pending spawn routes (issue #149, issue #150, ADR-0029) and
 * the Steward's routes and command (ADR-0030), seen from outside the server
 * (ADR-0036): the snapshot on /api/state, the routes' answers, the pool's
 * files, and the steward command run as its own process.
 */

import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeldSpawnView, PendingSpawnView } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readConsoleJson, readEvents, until } from "../harness/pool-files.ts";
import { serverChoice } from "../harness/server.ts";
import type { World } from "../harness/world.ts";

const BODY = "A body long enough to stand as a ticket.";
const READY = (id: string) => `<!-- state: id=${id} blocked-by=none status=ready -->`;
const DEFAULTS = { harness: "claude", model: "m" };

/**
 * Put a gate in front of a stub binary: each launch is keyed by the base name
 * of its working directory (a Ticket's worktree is named for its id; a lone
 * Ticket runs in the checkout, `repo`), may write an Outcome and may wait for
 * a release file before the stub proper runs. The stub's own `waitFor` gives
 * up after ten seconds; this gate holds until the case releases it or its
 * world is deleted.
 */
function gate(
  world: World,
  rules: Record<string, { hold?: boolean; outcome?: { path: string; json: unknown } }>,
  binary = "claude",
): { release(key: string): void } {
  const held = join(world.root, "held");
  mkdirSync(held, { recursive: true });
  for (const [key, rule] of Object.entries(rules)) {
    writeFileSync(join(held, `${key}.rule`), "");
    if (rule.hold) writeFileSync(join(held, `${key}.hold`), "");
    if (rule.outcome) {
      writeFileSync(join(held, `${key}.outcome`), JSON.stringify(rule.outcome.json));
      writeFileSync(join(held, `${key}.outcome-path`), rule.outcome.path);
    }
  }
  const wrapper = join(world.stubs.bin, binary);
  const exec = readFileSync(wrapper, "utf8")
    .split("\n")
    .find((line) => line.startsWith("exec "));
  if (!exec) throw new Error(`no exec line in ${wrapper}`);
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `held=${JSON.stringify(held)}`,
      'key="$(basename "$PWD")"',
      '[ -f "$held/$key.rule" ] || key=any',
      'if [ -f "$held/$key.outcome-path" ]; then',
      '  cat "$held/$key.outcome" > "$(cat "$held/$key.outcome-path")"',
      "fi",
      'if [ -f "$held/$key.hold" ]; then',
      "  for _ in $(seq 1 2400); do",
      '    [ -e "$held/$key.release" ] && break',
      '    [ -d "$held" ] || exit 0',
      "    sleep 0.05",
      "  done",
      "fi",
      exec,
      "",
    ].join("\n"),
  );
  return { release: (key) => writeFileSync(join(held, `${key}.release`), "") };
}

interface Snapshot {
  phase: string;
  heldSpawns: HeldSpawnView[];
  pendingSpawns: PendingSpawnView[];
  spawnUsage: unknown;
  stewardBudget: unknown;
  state: {
    tickets: { id: string; status: string }[];
    conversations: { id: string; status: string }[];
    interrupts: { ticketId: string; kind: string; stewardNote?: { text: string } }[];
  };
}

async function snapshot(server: CaseServer): Promise<Snapshot> {
  const got = (await server.http.get("/api/state")).json<{ snapshot: Snapshot | null }>();
  if (!got.snapshot) throw new Error("no snapshot yet");
  return got.snapshot;
}

/** The pool at rest: quiescent, with `also` holding of the snapshot. */
function settled(server: CaseServer, also: (s: Snapshot) => boolean = () => true, what = "the pool to settle"): Promise<Snapshot> {
  return until(() => snapshot(server), (s) => s.phase === "quiescent" && also(s), { ms: 30_000, what });
}

/** A pool whose one Ticket proposes two follow-ups under a per-attempt cap
 *  of one, so the second is held once the pool settles. */
async function startRig(t: Case): Promise<CaseServer> {
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: READY("01") }],
    config: { defaults: DEFAULTS, spawnCaps: { perAttempt: 1 } },
  });
  world.stubs.script("01", {
    spawn: [
      { title: "Adopted", body: BODY },
      { title: "Held", body: BODY },
    ],
  });
  const server = await t.start(world);
  await settled(server, (s) => s.heldSpawns.length === 1, "the pool to settle with a held spawn");
  return server;
}

/** A pool whose Ticket 01 proposes two follow-ups while 02, in the same
 *  super-step, is held open: both wait as Pending spawns until 02 is
 *  released. */
async function startPendingRig(t: Case): Promise<{ server: CaseServer; release: () => void }> {
  const world = t.world({
    tickets: [
      { file: "01-a.md", marker: READY("01") },
      { file: "02-b.md", marker: READY("02") },
    ],
    config: { defaults: DEFAULTS },
  });
  world.stubs.script("01", {
    spawn: [
      { title: "Keep back", body: BODY },
      { title: "Drop", body: BODY },
    ],
  });
  // Two ready Tickets run in worktrees named for their ids.
  const held = gate(world, { "02": { hold: true } });
  const server = await t.start(world);
  await until(() => snapshot(server), (s) => s.pendingSpawns.length >= 2, {
    ms: 30_000,
    what: "the pending spawns",
  });
  return { server, release: () => held.release("02") };
}

// engine/spawn-routes.test.ts:69
conformance("spawns", "held spawns on the snapshot › carries every held spawn and the Spawn usage", async (t) => {
  const server = await startRig(t);
  const s = await snapshot(server);
  expect(s.heldSpawns).toEqual([
    {
      id: "proposal-2",
      parentId: "01",
      origin: "ticket",
      kind: "ticket",
      title: "Held",
      body: BODY,
      blockedBy: [],
      blocks: null,
      overlaps: [],
      reason: "per-attempt",
      unknownOverlaps: [],
      at: expect.any(String),
      adopting: false,
    },
  ]);
  expect(s.spawnUsage).toEqual({ spawnedThisRun: 1, perAttempt: 1, perRun: 20 });
});

// engine/spawn-routes.test.ts:97
conformance(
  "spawns",
  "POST /api/spawns/held/adopt › adopts a held spawn past the caps and the next snapshot shows its ticket",
  async (t) => {
    const server = await startRig(t);

    const res = await server.http.post("/api/spawns/held/adopt", { id: "proposal-2" });
    expect(res.status).toBe(202);
    expect(res.json<object>()).toEqual({ id: "proposal-2" });
    const after = await settled(
      server,
      (s) => s.heldSpawns.length === 0 && s.state.tickets.some((ticket) => ticket.id === "01-spawn-2"),
      "the adopted spawn's Ticket",
    );
    expect(after.heldSpawns).toEqual([]);
    expect(after.state.tickets.map((ticket) => ticket.id)).toContain("01-spawn-2");
  },
);

// engine/spawn-routes.test.ts:109
conformance(
  "spawns",
  "POST /api/spawns/held/adopt › answers a 409 with the reason for an id the pool does not hold",
  async (t) => {
    const server = await startRig(t);
    const res = await server.http.post("/api/spawns/held/adopt", { id: "proposal-7" });
    expect(res.status).toBe(409);
    expect(res.json<{ reason: string }>().reason).toBe("no held spawn proposal-7");
  },
);

// engine/spawn-routes.test.ts:116
conformance("spawns", "POST /api/spawns/held/adopt › answers a 400 for a body with no id", async (t) => {
  const server = await startRig(t);
  const res = await server.http.post("/api/spawns/held/adopt", {});
  expect(res.status).toBe(400);
  expect(res.json<{ reason: string }>().reason).toBe("id is required");
});

// engine/spawn-routes.test.ts:125
conformance("spawns", "POST /api/spawns/held/discard › discards a held spawn and the snapshot drops it", async (t) => {
  const server = await startRig(t);

  const res = await server.http.post("/api/spawns/held/discard", { id: "proposal-2" });
  expect(res.status).toBe(200);
  expect(res.json<object>()).toEqual({ id: "proposal-2" });
  expect((await snapshot(server)).heldSpawns).toEqual([]);

  const again = await server.http.post("/api/spawns/held/discard", { id: "proposal-2" });
  expect(again.status).toBe(409);
});

// engine/spawn-routes.test.ts:177
conformance(
  "spawns",
  "pending spawns on the snapshot › carries every Pending spawn until the boundary lands it",
  async (t) => {
    const { server, release } = await startPendingRig(t);
    expect((await snapshot(server)).pendingSpawns).toEqual([
      {
        id: "proposal-1",
        parentId: "01",
        origin: "ticket",
        kind: "ticket",
        title: "Keep back",
        body: BODY,
        blockedBy: [],
        blocks: null,
        overlaps: [],
        at: expect.any(String),
      },
      expect.objectContaining({ id: "proposal-2", title: "Drop" }),
    ]);
    release();
    const after = await settled(
      server,
      (s) => s.state.tickets.some((ticket) => ticket.id === "01-spawn-2"),
      "the boundary to land the spawns",
    );
    expect(after.pendingSpawns).toEqual([]);
    expect(after.state.tickets.map((ticket) => ticket.id)).toContain("01-spawn-2");
  },
);

// engine/spawn-routes.test.ts:202
conformance(
  "spawns",
  "POST /api/spawns/pending/hold and /discard › holds one and discards another before the boundary, and refuses both once it has landed",
  async (t) => {
    const { server, release } = await startPendingRig(t);

    const hold = await server.http.post("/api/spawns/pending/hold", { id: "proposal-1" });
    expect(hold.status).toBe(200);
    expect(hold.json<object>()).toEqual({ id: "proposal-1" });
    expect((await snapshot(server)).heldSpawns.map((h) => [h.id, h.reason])).toEqual([["proposal-1", "operator"]]);

    const again = await server.http.post("/api/spawns/pending/hold", { id: "proposal-1" });
    expect(again.status).toBe(409);
    expect(again.json<{ reason: string }>().reason).toBe("spawn proposal-1 is already held");

    const discard = await server.http.post("/api/spawns/pending/discard", { id: "proposal-2" });
    expect(discard.status).toBe(200);
    expect((await snapshot(server)).pendingSpawns).toEqual([]);

    release();
    // 02 done, and the boundary has passed with nothing to land.
    const after = await settled(
      server,
      (s) => s.state.tickets.find((ticket) => ticket.id === "02")?.status === "done",
      "02 to finish and the pool to settle",
    );
    expect(after.state.tickets.map((ticket) => ticket.id)).not.toContain("01-spawn-1");
    expect(after.heldSpawns.map((h) => h.id)).toEqual(["proposal-1"]);
  },
);

// engine/spawn-routes.test.ts:228
conformance(
  "spawns",
  "POST /api/spawns/pending/hold and /discard › answers a 409 for a spawn that has already landed",
  async (t) => {
    const { server, release } = await startPendingRig(t);
    release();
    await settled(
      server,
      (s) => s.state.tickets.some((ticket) => ticket.id === "01-spawn-1"),
      "the boundary to land the spawns",
    );

    const res = await server.http.post("/api/spawns/pending/discard", { id: "proposal-1" });
    expect(res.status).toBe(409);
    expect(res.json<{ reason: string }>().reason).toBe(
      "no pending spawn proposal-1: it has landed or been discarded",
    );
  },
);

// engine/spawn-routes.test.ts:240
conformance("spawns", "POST /api/spawns/pending/hold and /discard › answers a 400 for a body with no id", async (t) => {
  const server = await startRig(t);
  const res = await server.http.post("/api/spawns/pending/hold", {});
  expect(res.status).toBe(400);
  expect(res.json<{ reason: string }>().reason).toBe("id is required");
});

// ---------------------------------------------------------------------------
// The Steward's routes and command
// ---------------------------------------------------------------------------

// claude's ready pattern (engine/spawn.ts, defaultHarnessDescriptors.claude
// readyPattern), so a terminal-backed launch's readiness wait passes.
const CLAUDE_READY = "Claude Code v9.9.9\n❯ ";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The steward command as its own process, in the world's environment, so
 *  it finds the server through the fleet registry under the world's HOME. */
async function steward(world: World, args: string[]): Promise<Run> {
  const proc = Bun.spawn([serverChoice().rustBin, "steward", ...args], {
    cwd: world.repo,
    env: world.env(join(world.root, "no-herdr.sock")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// engine/steward-routes.test.ts:50
conformance(
  "cli",
  "the Steward's routes and command › enlists a Steward once, then reads, reassigns, leaves and ends through the command",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by= status=ready -->", body: "# Talk\n\nbody" }],
      config: { defaults: DEFAULTS, terminal: "herdr" },
    });
    const desk = join(world.root, "desk");
    world.git(["worktree", "add", "-q", "-b", "desk", desk]);
    // 01's TUI writes a checkpoint Outcome and stays up.
    gate(world, {
      repo: {
        hold: true,
        outcome: {
          path: join(world.pool, "runs", "01.outcome.json"),
          json: { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" },
        },
      },
    });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    await herdr.control("seedAgent", {
      paneId: "pane-desk",
      agent: "opencode",
      cwd: desk,
      status: "idle",
      rendered: "opencode\nctrl+p commands",
      tabId: "tab-desk",
    });
    const server = await t.start(world, { herdr });
    await until(
      () => snapshot(server),
      (s) => s.state.interrupts.some((i) => i.kind === "checkpoint"),
      { ms: 30_000, what: "the checkpoint" },
    );

    const enlisted = await server.http.post("/api/enlist", { becomes: "steward", paneId: "pane-desk" });
    expect(enlisted.status).toBe(201);
    const id = enlisted.json<{ conversationId: string }>().conversationId;
    // The teaching names this server's URL.
    await until(
      () => herdr.control<string[]>("submitted"),
      (submitted) => submitted.some((text) => text.includes(`--url ${server.url}`)),
      { ms: 90_000, what: "the teaching" },
    );

    const second = await server.http.post("/api/conversations", { role: "steward" });
    expect(second.status).toBe(409);
    expect(second.json<{ reason: string }>().reason).toContain("a Steward is already on duty");

    const cli = (...args: string[]) => steward(world, ["--pool", world.pool, "--as", id, ...args]);

    const read = await cli("state");
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(`Steward ${id}; budget 5 per Ticket`);
    expect(read.stdout).toContain('01 "Talk": checkpoint (pane alive, budget 5 of 5 left)');
    expect(read.stdout).toContain("Close off (the operator's)");

    // Issue #154: Close is the operator's while the pool has not let the
    // Steward Close; the command prints the engine's refusal.
    const close = await cli("close", "01", "superseded");
    expect(close.code).toBe(1);
    expect(close.stderr.trim().split("\n").at(-1)).toBe(
      "steward: Close is off for this pool; the operator turns on Steward may Close checkpoints in Settings",
    );

    // ADR-0035: Adopt is the operator's; the route refuses it with the reason.
    const adopt = await server.http.post("/api/steward/answer", {
      conversation: id,
      ticketId: "01",
      action: "adopt",
      attempt: 2,
    });
    expect(adopt.status).toBe(400);
    expect(adopt.json<{ reason: string }>().reason).toBe(
      "adopting a candidate is the operator's: leave 01 with a note naming the one you recommend",
    );

    const stranger = await steward(world, ["--pool", world.pool, "--as", "conv-9", "answer", "01", "resume"]);
    expect(stranger.code).toBe(1);
    expect(stranger.stderr.trim().split("\n").at(-1)).toBe(`steward: conv-9 is not the Steward on duty (${id} is)`);

    const malformed = await server.http.post("/api/steward/answer", { conversation: id, ticketId: "01" });
    expect(malformed.status).toBe(400);

    expect((await cli("reassign", "01", "model=judge")).code).toBe(0);
    expect(readConsoleJson(world.pool)?.assign?.["01"]).toEqual({ model: "judge" });
    expect(readEvents(world.pool, "01").find((e) => e.kind === "reassign-requested")?.payload).toEqual({
      fields: { model: "judge" },
      by: "steward",
      conversation: id,
    });

    const leave = await cli("leave", "01", "Recommend", "resume", "on", "judge.");
    expect(leave.code).toBe(0);
    expect(leave.stdout.trim().split("\n").at(-1)).toBe("left 01 to the operator with your note");
    const noted = await until(
      () => snapshot(server),
      (s) => s.state.interrupts.some((i) => i.stewardNote?.text === "Recommend resume on judge."),
      { ms: 30_000, what: "the note on the snapshot" },
    );
    expect(noted.stewardBudget).toEqual({ budget: 5, used: {} });

    expect((await cli("end", "Done", "for", "tonight.")).code).toBe(0);
    await until(
      () => snapshot(server),
      (s) => s.state.conversations.some((c) => c.id === id && c.status === "ended"),
      { ms: 30_000, what: "the Steward ended" },
    );
    expect(readEvents(world.pool, id).find((e) => e.kind === "ended")?.payload).toMatchObject({
      closing: "Done for tonight.",
      by: "steward",
    });
  },
  { timeoutMs: 240_000 },
);
