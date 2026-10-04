/**
 * The terminal routes, the Live attempt's pane on the snapshot, the
 * conversation routes and Keep talking (ADR-0014, issue #122, issue #139),
 * seen from outside the server (ADR-0036): a terminal-backed pool runs the
 * stub `claude` in the fake herdr's panes, and a case reads the routes, the
 * snapshot, the pool's events files and the calls on the herdr socket.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrCall, HerdrProcess } from "../harness/herdr.ts";
import type { CaseServer } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const READY_01 = "<!-- state: id=01 blocked-by=none status=ready -->";

// claude's ready pattern and idle glyph (engine/spawn.ts,
// defaultHarnessDescriptors.claude readyPattern and idlePattern): every pane
// the fake opens shows them, so a launch's readiness wait passes as soon as
// the wrapper runs and a Conversation's pane reads as waiting.
const CLAUDE_READY = "Claude Code v9.9.9\n❯ ";

const CLAUDE_DEFAULTS = { harness: "claude", model: "m" };

interface Held {
  /** Hold the launch until `release(key)`. */
  hold?: boolean;
  /** Write this JSON to `path` as the launch starts: an Outcome a TUI writes. */
  outcome?: { path: string; json: unknown };
}

/**
 * Put a gate in front of a stub binary: each launch is keyed by the base name
 * of its working directory (a Ticket's worktree is named for its id; a lone
 * Ticket runs in the checkout, `repo`; `any` matches the rest), may write an
 * Outcome and may wait for a release file before the stub proper runs. The
 * stub's own `waitFor` gives up after ten seconds; this gate holds until the
 * case releases it or its world is deleted, so a terminal-backed attempt
 * stays live for as long as a case needs it.
 */
function gate(world: World, rules: Record<string, Held>, binary = "claude"): { release(key: string): void } {
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

interface LiveAttemptView {
  attempt: number;
  paneId: string | null;
  role: string;
  startedAt: string;
}

interface TicketView {
  id: string;
  status: string;
  liveAttempt: LiveAttemptView | null;
  heldPane: { attempt: number; paneId: string } | null;
}

interface StateView {
  snapshot: {
    finishedTerminals: number;
    state: {
      tickets: TicketView[];
      conversations: { id: string; status: string }[];
      interrupts: { ticketId: string; kind: string }[];
    };
  } | null;
}

async function state(server: CaseServer): Promise<StateView> {
  return (await server.http.get("/api/state")).json<StateView>();
}

async function ticket(server: CaseServer, id: string): Promise<TicketView | undefined> {
  return (await state(server)).snapshot?.state.tickets.find((t) => t.id === id);
}

/** The pane the snapshot carries for a Ticket's Live attempt, once it does. */
async function livePane(server: CaseServer, id: string, ms = 30_000): Promise<string> {
  const view = await until(
    () => ticket(server, id),
    (t) => typeof t?.liveAttempt?.paneId === "string",
    { ms, what: `${id}'s live pane on the snapshot` },
  );
  return view!.liveAttempt!.paneId!;
}

/** Once the launch has typed its prompt and pressed Enter: from here no
 *  engine read of the pane races a case's. */
async function promptSubmitted(herdr: HerdrProcess, count = 1): Promise<void> {
  await until(
    () => herdr.control<string[]>("submitted"),
    (submitted) => submitted.length >= count,
    { ms: 30_000, what: "the launch's prompt to be submitted" },
  );
}

/**
 * A terminal-backed pool whose one Ticket, 01, runs the stub claude held
 * open in its pane, resolved once the snapshot carries the pane and the
 * prompt is in. The stub prints nothing, so what a viewport read shows is
 * what the fake renders.
 */
async function livePool(t: Parameters<Parameters<typeof conformance>[2]>[0]) {
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: READY_01 }],
    config: { defaults: CLAUDE_DEFAULTS, terminal: "herdr" },
  });
  const held = gate(world, { repo: { hold: true } });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });
  const paneId = await livePane(server, "01");
  await promptSubmitted(herdr);
  return { world, herdr, server, paneId, release: () => held.release("repo") };
}

/** The route's own reads: the viewport ones (issue #122); the launch's reads are `recent`. */
function peekReads(herdr: HerdrProcess) {
  return bare(herdr.calls.filter((call) => call.method === "pane.read" && call.params.source === "visible"));
}

/** Calls as method and params, without the connection each arrived on. */
function bare(calls: HerdrCall[]): { method: string; params: Record<string, unknown> }[] {
  return calls.map(({ method, params }) => ({ method, params }));
}

// engine/server.test.ts:2712
conformance(
  "herdr",
  "terminal endpoints › peek translates the ticket id to its live pane and reads its viewport live: no engine loop watches a spawned attempt",
  async (t) => {
    const { herdr, server, paneId } = await livePool(t);
    await herdr.control("setPaneContent", paneId, "working\nstill working");

    const peek = await server.http.get("/api/terminal/peek?ticket=01");
    expect(peek.status).toBe(200);
    expect(peek.json<object>()).toEqual({ ticket: "01", paneId, text: "working\nstill working" });
    await herdr.settle();
    expect(peekReads(herdr)).toEqual([
      {
        method: "pane.read",
        params: { pane_id: paneId, source: "visible", format: "text", strip_ansi: true },
      },
    ]);
  },
);

// engine/server.test.ts:2737
conformance("herdr", "terminal endpoints › focus calls pane.focus with the live pane id", async (t) => {
  const { herdr, server, paneId } = await livePool(t);

  const focus = await server.http.post("/api/terminal/focus?ticket=01");
  expect(focus.status).toBe(200);
  expect(focus.json<object>()).toEqual({ ok: true, paneId });
  await herdr.settle();
  expect(bare(herdr.calls.filter((call) => call.method === "pane.focus"))).toEqual([
    { method: "pane.focus", params: { pane_id: paneId } },
  ]);
});

// engine/server.test.ts:2750
conformance(
  "herdr",
  "terminal endpoints › answers a headless attempt and an unknown ticket with a clean no-pane 404",
  async (t) => {
    // A headless pool beside a live daemon: the attempt is live on the
    // snapshot with no pane.
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: READY_01 }],
      config: { defaults: CLAUDE_DEFAULTS },
    });
    gate(world, { repo: { hold: true } });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });
    const live = await until(
      () => ticket(server, "01"),
      (view) => view?.liveAttempt != null,
      { ms: 30_000, what: "01's headless attempt to be live" },
    );
    expect(live!.liveAttempt).toMatchObject({ attempt: 1, paneId: null, role: "agent" });

    for (const id of ["01", "99"]) {
      const peek = await server.http.get(`/api/terminal/peek?ticket=${id}`);
      expect(peek.status).toBe(404);
      expect(peek.json<{ error: string }>().error).toBe(`no terminal-backed pane for ticket ${id}`);
      const focus = await server.http.post(`/api/terminal/focus?ticket=${id}`);
      expect(focus.status).toBe(404);
      expect(focus.json<{ error: string }>().error).toBe(`no terminal-backed pane for ticket ${id}`);
    }
    // No-pane tickets never reach the daemon.
    await herdr.settle();
    expect(herdr.calls).toEqual([]);
  },
);

// engine/server.test.ts:2780
conformance(
  "herdr",
  "terminal endpoints › answers a finished attempt with the same 404: the pane leaves the snapshot when the attempt ends",
  async (t) => {
    const { herdr, server, release } = await livePool(t);
    release();
    await until(
      () => ticket(server, "01"),
      (view) => view !== undefined && view.liveAttempt === null,
      { ms: 30_000, what: "01's attempt to end" },
    );

    const peek = await server.http.get("/api/terminal/peek?ticket=01");
    expect(peek.status).toBe(404);
    expect(peek.json<{ error: string }>().error).toBe("no terminal-backed pane for ticket 01");
    const focus = await server.http.post("/api/terminal/focus?ticket=01");
    expect(focus.status).toBe(404);
    await herdr.settle();
    expect(peekReads(herdr)).toEqual([]);
    expect(herdr.calls.filter((call) => call.method === "pane.focus")).toEqual([]);
  },
);

// engine/server.test.ts:2795
conformance("herdr", "terminal endpoints › treats an empty read as empty text, not an error", async (t) => {
  const { herdr, server, paneId } = await livePool(t);
  // Nothing rendered: a background tab still warming up reads empty.
  await herdr.control("setPaneContent", paneId, "");

  const peek = await server.http.get("/api/terminal/peek?ticket=01");
  expect(peek.status).toBe(200);
  expect(peek.json<object>()).toEqual({ ticket: "01", paneId, text: "" });
});

// engine/server.test.ts:2805
conformance(
  "herdr",
  "terminal endpoints › freshness comes from text, not revision: a stagnant revision still serves new text",
  async (t) => {
    // The fake answers every read with revision 0.
    const { herdr, server, paneId } = await livePool(t);
    await herdr.control("setPaneContent", paneId, "first");
    const first = (await server.http.get("/api/terminal/peek?ticket=01")).json<Record<string, unknown>>();
    expect(first.text).toBe("first");
    await herdr.control("setPaneContent", paneId, "second");
    const second = (await server.http.get("/api/terminal/peek?ticket=01")).json<Record<string, unknown>>();
    expect(second.text).toBe("second");
    expect("revision" in second).toBe(false);
  },
);

// engine/server.test.ts:2820
conformance(
  "herdr",
  "terminal endpoints › a daemon failure is a clean 502, not a crash, and the only 502 there is",
  async (t) => {
    const { herdr, server } = await livePool(t);
    await herdr.control("fail", "pane.read", true);
    await herdr.control("fail", "pane.focus", true);

    const peek = await server.http.get("/api/terminal/peek?ticket=01");
    expect(peek.status).toBe(502);
    expect(peek.json<{ error: string }>().error).toContain("pane.read refused");
    const focus = await server.http.post("/api/terminal/focus?ticket=01");
    expect(focus.status).toBe(502);
    expect(focus.json<{ error: string }>().error).toContain("pane.focus refused");

    await herdr.control("fail", "pane.read", false);
    await herdr.control("fail", "pane.focus", false);
    // The server goes on answering.
    expect((await server.http.get("/api/state")).status).toBe(200);
    expect(server.exited()).toBe(false);
  },
);

// engine/server.test.ts:2836
conformance(
  "herdr",
  "terminal endpoints › peek reads no events file: it still answers after the ticket's file is deleted",
  async (t) => {
    const { world, herdr, server, paneId } = await livePool(t);
    await herdr.control("setPaneContent", paneId, "still here");
    const eventsFile = join(world.pool, "runs", "01.events.jsonl");
    expect(existsSync(eventsFile)).toBe(true);
    rmSync(eventsFile);

    const peek = await server.http.get("/api/terminal/peek?ticket=01");
    expect(peek.status).toBe(200);
    expect(peek.json<object>()).toEqual({ ticket: "01", paneId, text: "still here" });
  },
);

/** The pane id a Ticket's `spawned` event records. */
function spawnedPane(world: World, id: string): unknown {
  return (readEvents(world.pool, id).find((event) => event.kind === "spawned")?.payload as { pane_id?: unknown })
    ?.pane_id;
}

/** A Ticket's `spawned` event payload. */
function spawnedPayload(world: World, id: string): { pane_id?: unknown; terminal_error?: unknown } | undefined {
  return readEvents(world.pool, id).find((event) => event.kind === "spawned")?.payload as
    | { pane_id?: unknown; terminal_error?: unknown }
    | undefined;
}

// engine/server.test.ts:3043
conformance(
  "herdr",
  "liveAttempt enrichment (terminal-backed attempts) › exposes each terminal-backed ticket's live pane on the enriched snapshot",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: READY_01 },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
      ],
      config: { defaults: CLAUDE_DEFAULTS, terminal: "herdr" },
    });
    // Three ready Tickets run in worktrees named for their ids. 01 writes a
    // done Outcome and finishes on its own; 02 and 03 are held open, so the
    // super-step's later emits must still carry their panes.
    gate(world, {
      "01": {
        outcome: {
          path: join(world.pool, "runs", "01.outcome.json"),
          json: { status: "done", summary: "smoke", commitSha: null },
        },
      },
      "02": { hold: true },
      "03": { hold: true },
    });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });

    const tickets = await until(
      async () => (await state(server)).snapshot?.state.tickets ?? [],
      (all) =>
        typeof all.find((v) => v.id === "02")?.liveAttempt?.paneId === "string" &&
        typeof all.find((v) => v.id === "03")?.liveAttempt?.paneId === "string",
      { ms: 30_000, what: "02 and 03's live attempts to expose panes on one snapshot" },
    );
    const pane02 = tickets.find((v) => v.id === "02")!.liveAttempt!.paneId!;
    const pane03 = tickets.find((v) => v.id === "03")!.liveAttempt!.paneId!;
    expect(tickets.find((v) => v.id === "02")!.liveAttempt).toEqual({
      attempt: 1,
      paneId: pane02,
      role: "agent",
      startedAt: expect.any(String),
    });
    expect(tickets.find((v) => v.id === "03")!.liveAttempt).toEqual({
      attempt: 1,
      paneId: pane03,
      role: "agent",
      startedAt: expect.any(String),
    });
    // Every attempt opens its own tab, so each carries a distinct pane id,
    // the one its spawned event records.
    expect(pane02).not.toBe(pane03);
    expect(spawnedPane(world, "02")).toBe(pane02);
    expect(spawnedPane(world, "03")).toBe(pane03);
  },
);

// engine/server.test.ts:3122
conformance(
  "herdr",
  "liveAttempt enrichment (terminal-backed attempts) › exposes a live attempt with no pane on a headless pool, and none once it ends",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: READY_01 }],
      config: { defaults: CLAUDE_DEFAULTS },
    });
    const held = gate(world, { repo: { hold: true } });
    const server = await t.start(world);

    const live = await until(
      () => ticket(server, "01"),
      (view) => view?.liveAttempt != null,
      { ms: 30_000, what: "the headless attempt to be live on the snapshot" },
    );
    expect(live!.liveAttempt).toEqual({ attempt: 1, paneId: null, role: "agent", startedAt: expect.any(String) });

    held.release("repo");
    const ended = await until(
      () => ticket(server, "01"),
      (view) => view?.status === "done",
      { ms: 30_000, what: "01 to finish" },
    );
    expect(ended!.liveAttempt).toBeNull();
  },
);

/** A terminal-backed pool whose launch falls back to headless when the daemon refuses `method`. */
async function fallbackPool(t: Parameters<Parameters<typeof conformance>[2]>[0], method: string) {
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: READY_01 }],
    config: { defaults: CLAUDE_DEFAULTS, terminal: "herdr" },
  });
  const held = gate(world, { repo: { hold: true } });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, fail: [method] });
  const server = await t.start(world, { herdr });

  // The fallback runs headless: live on the snapshot with a null pane.
  const live = await until(
    () => ticket(server, "01"),
    (view) => view?.liveAttempt != null,
    { ms: 30_000, what: "the fallback attempt to be live on the snapshot" },
  );
  expect(live!.liveAttempt).toEqual({ attempt: 1, paneId: null, role: "agent", startedAt: expect.any(String) });

  held.release("repo");
  // The fallback still completes.
  const done = await until(
    () => ticket(server, "01"),
    (view) => view?.status === "done",
    { ms: 30_000, what: "01 to go done" },
  );
  expect(done!.liveAttempt).toBeNull();
  // The spawned event records the fallback: pane_id null and the terminal error.
  const spawned = spawnedPayload(world, "01");
  expect(spawned?.pane_id).toBeNull();
  expect(typeof spawned?.terminal_error).toBe("string");
  return { herdr };
}

// engine/server.test.ts:3151
conformance(
  "attempts",
  "liveAttempt enrichment (terminal-backed attempts) › exposes no pane when the daemon refused the tab and the attempt fell back to headless",
  async (t) => {
    await fallbackPool(t, "tab.create");
  },
);

// engine/server.test.ts:3195
conformance(
  "attempts",
  "liveAttempt enrichment (terminal-backed attempts) › exposes no pane when the tab opened but the wrapper send was refused and the attempt fell back to headless",
  async (t) => {
    const { herdr } = await fallbackPool(t, "pane.send_input");
    // The pane of the tab the daemon did open is closed: fire-and-forget on
    // the fallback path, so waited for rather than raced.
    await herdr.settle();
    expect(herdr.calls.some((call) => call.method === "tab.create")).toBe(true);
    await herdr.waitForCall((call) => call.method === "pane.close", { ms: 15_000 });
  },
);

// ---------------------------------------------------------------------------
// The conversation routes
// ---------------------------------------------------------------------------

/** A git pool (the world's) whose one Ticket is done already, so the drive
 *  settles at once; terminal-backed on claude unless `headless`. */
function convoWorld(t: Parameters<Parameters<typeof conformance>[2]>[0], headless = false): World {
  const world = t.world({
    tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
    config: { defaults: CLAUDE_DEFAULTS, ...(headless ? {} : { terminal: "herdr" as const }) },
  });
  // Every Conversation's launch holds its pane open, as a TUI would.
  gate(world, { any: { hold: true } });
  return world;
}

async function settled(server: CaseServer): Promise<void> {
  await until(
    () => server.http.get("/api/state"),
    (got) => got.json<{ snapshot: { phase: string } | null }>().snapshot?.phase === "quiescent",
    { ms: 30_000, what: "the pool to settle" },
  );
}

async function convoServer(t: Parameters<Parameters<typeof conformance>[2]>[0]) {
  const world = convoWorld(t);
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });
  await settled(server);
  return { world, herdr, server };
}

interface ConversationView {
  id: string;
  status: string;
  title: string;
  paneId: string | null;
  assignment: unknown;
}

async function startConversation(server: CaseServer, body: Record<string, unknown>): Promise<ConversationView> {
  const created = await server.http.post("/api/conversations", body);
  expect(created.status).toBe(201);
  return created.json<{ conversation: ConversationView }>().conversation;
}

/** The status on a Conversation file's marker line. */
function conversationStatus(world: World, id: string): string {
  const line = readFileSync(join(world.pool, "conversations", `${id}.md`), "utf8").split("\n", 1)[0]!;
  return /status=(\S+)/.exec(line)?.[1] ?? "";
}

// engine/server.test.ts:3857
conformance(
  "conversations",
  "conversation endpoints › refuses to start a conversation on a headless pool with a 409 naming the reason",
  async (t) => {
    const world = convoWorld(t, true);
    const server = await t.start(world);
    await settled(server);

    const res = await server.http.post("/api/conversations", { title: "A talk" });
    expect(res.status).toBe(409);
    // The Console reads the failure text off `reason`, not `error`.
    expect(res.json<{ reason: string }>().reason).toContain("not terminal-backed");
  },
);

// engine/server.test.ts:3874
conformance(
  "conversations",
  "conversation endpoints › rejects a missing title with 400 before ever touching the engine",
  async (t) => {
    const { herdr, server } = await convoServer(t);

    const res = await server.http.post("/api/conversations", { opening: "hi" });
    expect(res.status).toBe(400);
    expect(res.json<{ reason: string }>().reason).toContain("title is required");
    await herdr.settle();
    expect(herdr.calls.filter((call) => call.method === "tab.create")).toEqual([]);
  },
);

// engine/server.test.ts:3890
conformance("conversations", "conversation endpoints › ending an unknown conversation id is a 404", async (t) => {
  const { server } = await convoServer(t);

  const res = await server.http.post("/api/conversations/end", { id: "conv-nope" });
  expect(res.status).toBe(404);
  expect(res.json<{ reason: string }>().reason).toContain("no live conversation");
});

// engine/server.test.ts:3906
conformance(
  "conversations",
  "conversation endpoints › create, then end, round trip through the HTTP routes",
  async (t) => {
    const { world, server } = await convoServer(t);

    const created = await startConversation(server, { title: "Plan the rollout", opening: "hello agent" });
    expect(created.status).toBe("live");
    expect(created.title).toBe("Plan the rollout");
    expect(typeof created.paneId).toBe("string");
    expect(created.assignment).toEqual({ harness: "claude", model: "m", drivers: "implement" });
    expect(conversationStatus(world, created.id)).toBe("live");
    // Its own worktree and branch, named for its id.
    const worktrees = () => world.git(["worktree", "list", "--porcelain"]);
    const branches = () => world.git(["branch", "--list", `pool/*/${created.id}`]);
    expect(worktrees()).toContain(`/${created.id}\n`);
    expect(branches().trim()).not.toBe("");

    const ended = await server.http.post("/api/conversations/end", {
      id: created.id,
      closing: "thanks, that's everything",
    });
    expect(ended.status).toBe(202);
    expect("snapshot" in ended.json<Record<string, unknown>>()).toBe(true);
    expect(conversationStatus(world, created.id)).toBe("ended");
    expect(worktrees()).not.toContain(`/${created.id}\n`);
    expect(branches().trim()).toBe("");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:3948
conformance(
  "herdr",
  "conversation endpoints › peek and focus resolve a Conversation's recorded pane, and refuse once it never spawned",
  async (t) => {
    const { server } = await convoServer(t);
    const created = await startConversation(server, { title: "Peek me" });

    const peek = await server.http.get(`/api/terminal/peek?ticket=${created.id}`);
    expect(peek.status).toBe(200);
    expect(peek.json<{ paneId: string }>().paneId).toBe(created.paneId!);
    const focus = await server.http.post(`/api/terminal/focus?ticket=${created.id}`);
    expect(focus.status).toBe(200);
    // An id that was never a Ticket or a Conversation: the same no-pane 404.
    const unknown = await server.http.get("/api/terminal/peek?ticket=nope");
    expect(unknown.status).toBe(404);
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:3975
conformance(
  "herdr",
  "conversation endpoints › an ended Conversation answers the same no-pane 404 as a finished ticket, never a 502",
  async (t) => {
    const { server } = await convoServer(t);
    const created = await startConversation(server, { title: "End me" });
    expect((await server.http.get(`/api/terminal/peek?ticket=${created.id}`)).status).toBe(200);
    const ended = await server.http.post("/api/conversations/end", { id: created.id });
    expect(ended.status).toBe(202);

    const peek = await server.http.get(`/api/terminal/peek?ticket=${created.id}`);
    expect(peek.status).toBe(404);
    expect(peek.json<{ error: string }>().error).toBe(`no terminal-backed pane for ticket ${created.id}`);
    const focus = await server.http.post(`/api/terminal/focus?ticket=${created.id}`);
    expect(focus.status).toBe(404);
    expect(focus.json<{ error: string }>().error).toBe(`no terminal-backed pane for ticket ${created.id}`);
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:4001
conformance(
  "conversations",
  "conversation endpoints › the events endpoint accepts a Conversation id the same way it accepts a ticket id",
  async (t) => {
    const { server } = await convoServer(t);
    const created = await startConversation(server, { title: "Talk it through" });

    const events = await server.http.get(`/api/events?ticket=${created.id}`);
    expect(events.status).toBe(200);
    expect(events.json<{ events: { kind: string }[] }>().events.some((e) => e.kind === "spawned")).toBe(true);
    const unknown = await server.http.get("/api/events?ticket=nope");
    expect(unknown.status).toBe(404);
  },
  { timeoutMs: 120_000 },
);

// ---------------------------------------------------------------------------
// Keep talking and Finished terminals (issue #139)
// ---------------------------------------------------------------------------

// engine/server.test.ts:6612
conformance(
  "interrupts",
  "Keep talking and Finished terminals routes (issue #139) › serves a checkpoint's Held pane on the snapshot and the terminal routes, then continues it",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: READY_01 }],
      config: { defaults: CLAUDE_DEFAULTS, terminal: "herdr" },
    });
    // A stand-in TUI that writes a checkpoint Outcome and stays up.
    gate(world, {
      repo: {
        hold: true,
        outcome: {
          path: join(world.pool, "runs", "01.outcome.json"),
          json: { status: "checkpoint", summary: "paused", commitSha: null, brief: "talk to me" },
        },
      },
    });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    const server = await t.start(world, { herdr });

    const atCheckpoint = await until(
      () => ticket(server, "01"),
      (view) => view?.heldPane != null,
      { ms: 30_000, what: "01's Held pane on the snapshot" },
    );
    const held = atCheckpoint!.heldPane!;
    expect(held.attempt).toBe(1);
    expect(atCheckpoint!.liveAttempt).toBeNull();

    await herdr.control("setPaneContent", held.paneId, "the agent, waiting");
    const peek = await server.http.get("/api/terminal/peek?ticket=01");
    expect(peek.json<object>()).toEqual({ ticket: "01", paneId: held.paneId, text: "the agent, waiting" });
    const focus = await server.http.post("/api/terminal/focus?ticket=01");
    expect(focus.status).toBe(200);

    const missing = await server.http.post("/api/keep-talking", {});
    expect(missing.status).toBe(400);

    const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
    expect(talk.status).toBe(202);
    expect(talk.json<object>()).toEqual({ ticketId: "01", attempt: 2 });
    const continued = await until(
      () => ticket(server, "01"),
      (view) => view?.liveAttempt?.attempt === 2,
      { ms: 30_000, what: "the Continued attempt live" },
    );
    expect(continued!.liveAttempt!.paneId).toBe(held.paneId);
    expect(continued!.heldPane).toBeNull();
    expect((await state(server)).snapshot!.state.interrupts).toEqual([]);

    const again = await server.http.post("/api/keep-talking", { ticketId: "01" });
    expect(again.status).toBe(409);
    expect(again.json<{ reason: string }>().reason).toContain("not waiting at a checkpoint");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6661
conformance(
  "herdr",
  "Keep talking and Finished terminals routes (issue #139) › refuses Keep talking and the bulk close in a headless pool",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: READY_01 }],
      config: { defaults: CLAUDE_DEFAULTS },
    });
    // No script for 01: the stub writes a done Outcome and exits 0.
    const server = await t.start(world);
    await until(
      () => ticket(server, "01"),
      (view) => view?.status === "done",
      { ms: 30_000, what: "01 to go done" },
    );
    await settled(server);
    expect((await state(server)).snapshot!.finishedTerminals).toBe(0);

    const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
    expect(talk.status).toBe(409);
    const close = await server.http.post("/api/terminals/close-finished");
    expect(close.status).toBe(409);
    expect(close.json<{ reason: string }>().reason).toContain("not terminal-backed");
  },
);
