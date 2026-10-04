/**
 * Enlisting a live herdr pane (issue #101), seen from outside the server
 * (ADR-0036): GET /api/panes, POST /api/enlist as a Ticket or a
 * Conversation, and what an enlisted Conversation does afterwards. The
 * operator's panes are the fake herdr's seeded agents; what the server does
 * with them shows as calls on the herdr socket, text typed into the panes,
 * the pool's files and the repository's branches.
 *
 * The engine tests these port shortened the enlisted and Conversation pane
 * polls (2 s in production) and the enlist teaching wait (60 s); here they
 * run at their real lengths.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrCall, HerdrProcess } from "../harness/herdr.ts";
import type { HttpAnswer } from "../harness/http.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

// What an opencode TUI shows mid-turn and at rest: its idle pattern is the
// footer's `ctrl+p commands` (engine/spawn.ts's opencode descriptor).
const OPENCODE_WORKING = "opencode\nworking on it";
const OPENCODE_WAITING = "opencode\nctrl+p commands";
// claude's ready frame: the descriptor's readyPattern `Claude Code v` and its
// idle `❯` (engine/spawn.ts).
const CLAUDE_READY = "Claude Code v1\n❯ ";
// The line every Conversation teaching Turn carries (engine/prompt.ts).
const CONVERSATION_TEACHING = "You can start follow-up work";
// The enlisted and Conversation pane polls (engine/enlisted.ts
// ENLISTED_POLL_MS, engine/conversations.ts CONVERSATION_POLL_MS).
const PANE_POLL_MS = 2_000;
// How long an enlist waits for a working pane (engine/pane-session.ts
// READINESS_TIMEOUT_MS), and so the bound of the cases that run it out.
const TEACHING_WAIT_MS = 60_000;

/** A terminal-backed pool on the stubbed claude, its Tickets as given. */
function terminalWorld(t: Case, tickets: TicketSeed[], config: PoolConfig = {}): World {
  return t.world({
    tickets,
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr", ...config },
  });
}

const done01: TicketSeed = { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" };

/** The enlist-as-Ticket pool: 01 checkpointed (offered, never scheduled) and
 *  02 done (never offered), so no attempt opens a tab under the case. */
const ticketPoolTickets: TicketSeed[] = [
  { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=checkpoint -->" },
  { file: "02.md", marker: "<!-- state: id=02 blocked-by=none status=done -->" },
];

interface PaneSeed {
  paneId: string;
  agent: string | null;
  cwd: string;
  title: string;
  status: string;
  rendered?: string;
  tabId?: string;
  sessionId?: string;
}

function seedAgent(fake: HerdrProcess, seed: PaneSeed): Promise<unknown> {
  return fake.control("seedAgent", seed);
}

function submitted(fake: HerdrProcess): Promise<string[]> {
  return fake.control<string[]>("submitted");
}

function enlist(server: CaseServer, body: Record<string, unknown>): Promise<HttpAnswer> {
  return server.http.post("/api/enlist", body);
}

interface ConversationOnSnapshot {
  id: string;
  status: string;
  paneId: string | null;
  enlisted: boolean;
  branch: string | null;
  assignment: unknown;
}

interface TicketOnSnapshot {
  id: string;
  enlisted: boolean;
  liveAttempt: { paneId: string | null } | null;
}

interface Snapshot {
  state: { tickets: TicketOnSnapshot[]; conversations: ConversationOnSnapshot[]; log: string[] };
}

async function snapshot(server: CaseServer): Promise<Snapshot> {
  return (await server.http.get("/api/state")).json<{ snapshot: Snapshot }>().snapshot;
}

async function conversation(server: CaseServer, id = "conv-1"): Promise<ConversationOnSnapshot | undefined> {
  return (await snapshot(server)).state.conversations.find((c) => c.id === id);
}

/** A linked worktree of the repository on a new branch: the as-found arm. */
function worktreeOn(world: World, branch: string): string {
  const dir = join(world.root, `wt-${branch.replace(/\//g, "-")}`);
  world.git(["worktree", "add", "-q", "-b", branch, dir]);
  return dir;
}

function commitIn(world: World, dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  world.git(["-C", dir, "add", "-A"]);
  world.git(["-C", dir, "commit", "-qm", `add ${file}`]);
}

function currentBranch(world: World, dir: string): string {
  return world.git(["-C", dir, "branch", "--show-current"]).trim();
}

function head(world: World, dir: string): string {
  return world.git(["-C", dir, "rev-parse", "HEAD"]).trim();
}

/** Whether a literal ref resolves. */
function refExists(world: World, ref: string): boolean {
  try {
    world.git(["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** The pool branch the server made for an id, `pool/<pool key>/<id>`, or
 *  "" when there is none. The key is the server's own; the shape is all a
 *  case needs to find it. */
function poolBranch(world: World, id: string): string {
  return world.git(["branch", "--list", `pool/*/${id}`, "--format=%(refname:short)"]).trim();
}

/** The Conversation record's status, off its marker line. */
function recordStatus(world: World, id = "conv-1"): string {
  const line = readFileSync(join(world.pool, "conversations", `${id}.md`), "utf8").split("\n", 1)[0]!;
  return /\bstatus=(\S+)/.exec(line)?.[1] ?? "";
}

function spawnedEvent(world: World, id: string): Record<string, unknown> {
  const spawned = readEvents(world.pool, id).find((event) => event.kind === "spawned");
  if (!spawned) throw new Error(`runs/${id}.events.jsonl has no spawned event`);
  return spawned.payload as Record<string, unknown>;
}

const isCall = (method: string, paneId?: string) => (call: HerdrCall): boolean =>
  call.method === method && (paneId === undefined || call.params.pane_id === paneId);

function paneReads(fake: HerdrProcess, paneId: string, from = 0): HerdrCall[] {
  return fake.calls.slice(from).filter(isCall("pane.read", paneId));
}

/**
 * Two peeks either side of a change to the pane's render, with no pane.read
 * between them: each try starts right after one of the engine's own poll
 * reads, so the next is a poll interval away, and a try a poll read lands in
 * anyway is run again. A peek that read herdr itself would put a pane.read
 * in every try, so the case fails rather than retrying forever.
 */
async function peekTwiceAcrossAChange(
  server: CaseServer,
  fake: HerdrProcess,
  paneId: string,
  key: string,
): Promise<{ first: { paneId: string; text: string }; second: { paneId: string; text: string } }> {
  for (let attempt = 1; ; attempt++) {
    const before = fake.calls.length;
    await fake.waitForCall(isCall("pane.read", paneId), { from: before, ms: PANE_POLL_MS * 5 });
    // The poll read's reply reaches the engine a moment after the request.
    await Bun.sleep(100);
    const mark = fake.calls.length;
    const first = (await server.http.get(`/api/terminal/peek?ticket=${key}`)).json<{ paneId: string; text: string }>();
    await fake.control("setPaneContent", paneId, `opencode\nsomething new ${attempt}\nctrl+p commands`);
    const second = (await server.http.get(`/api/terminal/peek?ticket=${key}`)).json<{ paneId: string; text: string }>();
    if (paneReads(fake, paneId, mark).length === 0) return { first, second };
    if (attempt >= 4) {
      throw new Error(`a pane.read of ${paneId} landed between two peeks in every one of ${attempt} tries`);
    }
  }
}

// ---------------------------------------------------------------------------
// enlist panes endpoint
// ---------------------------------------------------------------------------

// engine/server.test.ts:4089
conformance(
  "enlist",
  "enlist panes endpoint › lists every pane herdr reports, with the reason beside the ineligible ones",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const outside = join(world.root, "outside");
    mkdirSync(outside);
    const fake = await t.herdr(world);
    await seedAgent(fake, { paneId: "pane-free", agent: "claude", cwd: world.repo, title: "✳ Claude Code", status: "idle" });
    await seedAgent(fake, { paneId: "pane-unknown", agent: "gemini", cwd: world.repo, title: "gemini tui", status: "working" });
    await seedAgent(fake, { paneId: "pane-outside", agent: "claude", cwd: outside, title: "elsewhere", status: "idle" });
    const server = await t.start(world, { herdr: fake });

    const res = await server.http.get("/api/panes");
    expect(res.status).toBe(200);
    const panes = res.json<{ panes: { paneId: string }[] }>().panes;
    const byId = (id: string) => panes.find((p) => p.paneId === id);
    expect(byId("pane-free")).toMatchObject({
      paneId: "pane-free",
      harness: "claude",
      status: "idle",
      title: "✳ Claude Code",
      directory: world.repo,
      branch: "main",
      eligible: true,
      reason: null,
    });
    expect(byId("pane-unknown")).toMatchObject({
      harness: "gemini",
      eligible: false,
      reason: "no harness the engine knows",
    });
    expect(byId("pane-outside")).toMatchObject({
      harness: "claude",
      directory: outside,
      branch: null,
      eligible: false,
      reason: "not a checkout of this pool's repository",
    });
    expect(panes).toHaveLength(3);
  },
);

// engine/server.test.ts:4158
conformance("enlist", "enlist panes endpoint › reports a pane a live attempt holds as already in the pool", async (t) => {
  const world = terminalWorld(t, [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" }]);
  // The terminal-backed launch runs the stub as `claude` with no outcome
  // file on its argv; held open until the case releases it.
  const release = join(world.root, "release-01");
  world.stubs.script("_claude", { waitFor: release });
  const fake = await t.herdr(world);
  const server = await t.start(world, { herdr: fake });

  const live = await until(
    () => snapshot(server),
    (snap) => typeof snap.state.tickets.find((tk) => tk.id === "01")?.liveAttempt?.paneId === "string",
    { what: "01's live pane on the snapshot", ms: 20_000 },
  );
  const paneId = live.state.tickets.find((tk) => tk.id === "01")!.liveAttempt!.paneId!;
  await fake.waitForCall(isCall("pane.report_agent", paneId), { ms: 20_000 });

  const res = await server.http.get("/api/panes");
  expect(res.status).toBe(200);
  const pane = res.json<{ panes: { paneId: string }[] }>().panes.find((p) => p.paneId === paneId);
  expect(pane).toMatchObject({ paneId, eligible: false, reason: "already in the pool" });

  writeFileSync(release, "");
});

// engine/server.test.ts:4199
conformance("enlist", "enlist panes endpoint › refuses a headless pool with a 409 naming the reason", async (t) => {
  const world = t.world({ tickets: [done01], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);

  const res = await server.http.get("/api/panes");
  expect(res.status).toBe(409);
  expect(res.json<{ reason: string }>().reason).toContain("terminal-backed");
});

// engine/server.test.ts:4211
conformance("enlist", "enlist panes endpoint › a daemon failure is a clean 502, not a crash", async (t) => {
  const world = terminalWorld(t, [done01]);
  const fake = await t.herdr(world, { fail: ["agent.list"] });
  const server = await t.start(world, { herdr: fake });

  const res = await server.http.get("/api/panes");
  expect(res.status).toBe(502);
  expect(res.json<{ error: string }>().error).toContain("agent.list refused");
  // Still serving.
  expect((await server.http.get("/api/state")).status).toBe(200);
});

// ---------------------------------------------------------------------------
// enlist a pane as a ticket
// ---------------------------------------------------------------------------

// engine/server.test.ts:4317
conformance(
  "enlist",
  "enlist a pane as a ticket › writes the ticket in progress with provenance, registers the pane, and claims it",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    const worktree = worktreeOn(world, "feature/x");
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-op",
      agent: "opencode",
      cwd: worktree,
      title: "OC | doing work",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-op",
      sessionId: "sess-9",
    });
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, {
      becomes: "ticket",
      paneId: "pane-op",
      title: "Do the thing",
      spec: "the spec body",
      blocks: ["01"],
    });
    expect(res.status).toBe(201);
    expect(res.json<unknown>()).toEqual({ ticketId: "enlist-1" });

    const ticketFile = readFileSync(join(world.pool, "issues", "enlist-1.md"), "utf8");
    expect(ticketFile).toContain(
      "<!-- state: id=enlist-1 blocked-by=none status=in-progress enlisted-from=pane-op -->",
    );
    expect(ticketFile).toContain("# enlist-1: Do the thing");
    expect(ticketFile).toContain("the spec body");
    expect(ticketFile).toContain("pane-op");
    expect(ticketFile).toContain(worktree);
    expect(ticketFile).toContain("feature/x");
    expect(ticketFile).toContain("session sess-9");

    expect(readStateLine(world.pool, "01.md").blockedBy).toEqual(["enlist-1"]);
    expect(readStateLine(world.pool, "02.md").blockedBy).toEqual([]);

    const spawned = spawnedEvent(world, "enlist-1");
    expect(spawned.pane_id).toBe("pane-op");
    expect(spawned.branch).toBe("feature/x");
    expect(spawned.branch_rule).toBe("as-found");

    await fake.settle();
    expect(fake.calls.some(isCall("tab.create"))).toBe(false);
    expect(fake.calls.some(isCall("pane.report_agent", "pane-op"))).toBe(true);
    expect(
      fake.calls.some(
        (c) => c.method === "tab.rename" && c.params.tab_id === "tab-op" && c.params.label === "enlist-1 · Do the thing",
      ),
    ).toBe(true);

    await until(
      () => snapshot(server),
      (snap) =>
        snap.state.tickets.some(
          (tk) => tk.id === "enlist-1" && tk.liveAttempt?.paneId === "pane-op" && tk.enlisted === true,
        ),
      { what: "the enlisted card on the snapshot" },
    );
    const peek = await server.http.get("/api/terminal/peek?ticket=enlist-1");
    expect(peek.status).toBe(200);
    expect(peek.json<{ paneId: string }>().paneId).toBe("pane-op");
    const focus = await server.http.post("/api/terminal/focus?ticket=enlist-1");
    expect(focus.status).toBe(200);
    expect(focus.json<unknown>()).toEqual({ ok: true, paneId: "pane-op" });

    expect((await submitted(fake)).some((text) => text.includes("Ticket enlist-1"))).toBe(true);
  },
);

// engine/server.test.ts:4433
conformance(
  "herdr",
  "enlist a pane as a ticket › peek serves the engine's own viewport read of an enlisted pane and never reads it a second time (issue #122)",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    const worktree = worktreeOn(world, "feature/x");
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-op",
      agent: "opencode",
      cwd: worktree,
      title: "OC | doing work",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-op",
    });
    const server = await t.start(world, { herdr: fake });
    const res = await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Do the thing", spec: "the spec body" });
    expect(res.status).toBe(201);
    await until(
      () => snapshot(server),
      (snap) => snap.state.tickets.some((tk) => tk.id === "enlist-1" && tk.liveAttempt?.paneId === "pane-op"),
      { what: "the enlisted card on the snapshot" },
    );

    // The pane moves on between the peeks; the second shows the engine's
    // last read of it, not a fresh one, and herdr was not asked.
    const { first, second } = await peekTwiceAcrossAChange(server, fake, "pane-op", "enlist-1");
    expect(first.paneId).toBe("pane-op");
    expect(first.text).toContain("ctrl+p commands");
    expect(second.text).toBe(first.text);

    // The engine's Turn-state reads of the pane are viewport reads with no
    // line count.
    const turnReads = paneReads(fake, "pane-op").filter((c) => c.params.source === "visible");
    expect(turnReads.length).toBeGreaterThan(0);
    for (const read of turnReads) expect("lines" in read.params).toBe(false);
  },
);

// engine/server.test.ts:4495
conformance(
  "enlist",
  "enlist a pane as a ticket › refuses a becomes the wire type does not declare, rather than defaulting to a Ticket",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-op",
      agent: "opencode",
      cwd: world.repo,
      title: "OC",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-op",
    });
    const server = await t.start(world, { herdr: fake });

    for (const becomes of [undefined, "", "Ticket", "conversaton"]) {
      const res = await enlist(server, {
        ...(becomes === undefined ? {} : { becomes }),
        paneId: "pane-op",
        title: "Should not land",
        spec: "",
      });
      expect(res.status).toBe(400);
      expect(res.json<{ reason: string }>().reason).toContain("becomes");
    }
    expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
  },
);

// engine/server.test.ts:4528
conformance("enlist", "enlist a pane as a ticket › refuses the same pane twice as already in the pool", async (t) => {
  const world = terminalWorld(t, ticketPoolTickets);
  const fake = await t.herdr(world);
  await seedAgent(fake, {
    paneId: "pane-op",
    agent: "opencode",
    cwd: world.repo,
    title: "OC",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-op",
  });
  const server = await t.start(world, { herdr: fake });

  const first = await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "First", spec: "" });
  expect(first.status).toBe(201);
  const second = await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Second", spec: "" });
  expect(second.status).toBe(409);
  expect(second.json<{ reason: string }>().reason).toContain("already in the pool");
  expect(existsSync(join(world.pool, "issues", "enlist-2.md"))).toBe(false);
});

// engine/server.test.ts:4566
conformance(
  "enlist",
  "enlist a pane as a ticket › creates the pool branch in place when the pane sits on the merge target",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    writeFileSync(join(world.repo, "dirty.txt"), "uncommitted\n");
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-main",
      agent: "opencode",
      cwd: world.repo,
      title: "OC on main",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-main",
    });
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" });
    expect(res.status).toBe(201);

    const branch = poolBranch(world, "enlist-1");
    expect(branch).not.toBe("");
    expect(currentBranch(world, world.repo)).toBe(branch);
    expect(readFileSync(join(world.repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    expect(spawnedEvent(world, "enlist-1").branch_rule).toBe("created");
    await until(
      () => snapshot(server),
      (snap) => snap.state.log.some((line) => line.includes("created at HEAD")),
      { what: "the pool log's created-at-HEAD line" },
    );
  },
);

// engine/server.test.ts:4612
conformance("enlist", "enlist a pane as a ticket › refuses a pane that is gone and leaves nothing behind", async (t) => {
  const world = terminalWorld(t, ticketPoolTickets);
  const fake = await t.herdr(world);
  const server = await t.start(world, { herdr: fake });

  const res = await enlist(server, { becomes: "ticket", paneId: "pane-ghost", title: "Nope", spec: "", blocks: ["01"] });
  expect(res.status).toBe(409);
  expect(res.json<{ reason: string }>().reason).toContain("pane pane-ghost is gone");
  expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
  expect(readStateLine(world.pool, "01.md").blockedBy).toEqual([]);
  expect(poolBranch(world, "enlist-1")).toBe("");
});

// engine/server.test.ts:4637
conformance("enlist", "enlist a pane as a ticket › unwinds completely when the teaching Turn never lands", async (t) => {
  const world = terminalWorld(t, ticketPoolTickets);
  writeFileSync(join(world.repo, "dirty.txt"), "uncommitted\n");
  const fake = await t.herdr(world);
  // claude's descriptor has no clear keys, so a dropped paste is one failed
  // echo, not three.
  await seedAgent(fake, {
    paneId: "pane-main",
    agent: "claude",
    cwd: world.repo,
    title: "✳ Claude Code",
    status: "idle",
    rendered: CLAUDE_READY,
    tabId: "tab-main",
  });
  // Every paste vanishes, so the echo never confirms.
  await fake.control("dropPaneInput", "pane-main", 10);
  const server = await t.start(world, { herdr: fake });

  const res = await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "Never taught", spec: "", blocks: ["01"] });
  expect(res.status).toBe(409);
  expect(res.json<{ reason: string }>().reason).toContain("could not be delivered");

  expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
  expect(readStateLine(world.pool, "01.md").blockedBy).toEqual([]);
  expect(poolBranch(world, "enlist-1")).toBe("");
  expect(currentBranch(world, world.repo)).toBe("main");
  expect(readFileSync(join(world.repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
  await fake.waitForCall(isCall("pane.release_agent", "pane-main"));
});

// engine/server.test.ts:4688
conformance(
  "enlist",
  "enlist a pane as a ticket › queues the teaching while the pane is working and types it once waiting",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-busy",
      agent: "opencode",
      cwd: world.repo,
      title: "OC busy",
      status: "working",
      rendered: OPENCODE_WORKING,
      tabId: "tab-busy",
    });
    const server = await t.start(world, { herdr: fake });

    const pending = enlist(server, { becomes: "ticket", paneId: "pane-busy", title: "Queued teaching", spec: "" });
    // Long enough for the claim to read the working pane more than once.
    await Bun.sleep(PANE_POLL_MS * 2);
    expect((await submitted(fake)).some((text) => text.includes("Ticket enlist-1"))).toBe(false);
    expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);

    await fake.control("setPaneContent", "pane-busy", OPENCODE_WAITING);
    const res = await pending;
    expect(res.status).toBe(201);
    expect((await submitted(fake)).some((text) => text.includes("Ticket enlist-1"))).toBe(true);
    expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(true);
  },
);

// engine/server.test.ts:4727
conformance(
  "enlist",
  "enlist a pane as a ticket › refuses a pane still working past the teaching wait and leaves nothing behind",
  async (t) => {
    const world = terminalWorld(t, ticketPoolTickets);
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-busy",
      agent: "opencode",
      cwd: world.repo,
      title: "OC busy",
      status: "working",
      rendered: OPENCODE_WORKING,
      tabId: "tab-busy",
    });
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-busy", title: "Never taught", spec: "", blocks: ["01"] });
    expect(res.status).toBe(409);
    expect(res.json<{ reason: string }>().reason).toContain("still working");
    expect((await submitted(fake)).some((text) => text.includes("Ticket enlist-1"))).toBe(false);
    expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
    expect(readStateLine(world.pool, "01.md").blockedBy).toEqual([]);
    expect(poolBranch(world, "enlist-1")).toBe("");
    expect(currentBranch(world, world.repo)).toBe("main");
    await fake.settle();
    expect(fake.calls.some(isCall("tab.rename"))).toBe(false);
    expect(fake.calls.some(isCall("pane.report_agent"))).toBe(false);
  },
  { timeoutMs: TEACHING_WAIT_MS + 60_000 },
);

// engine/server.test.ts:4774
conformance(
  "enlist",
  "enlist a pane as a ticket › creates the issues/ directory when enlisting a Ticket into a Seeded Pool that has none yet",
  async (t) => {
    const world = t.world({
      config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude " +
          "model=m drivers=implement -->\n\n# Talk\n\n\n",
      },
    });
    // A Seeded Pool has no issues/ directory at all, not an empty one.
    rmSync(join(world.pool, "issues"), { recursive: true, force: true });
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-main",
      agent: "opencode",
      cwd: world.repo,
      title: "OC on main",
      status: "idle",
      rendered: OPENCODE_WAITING,
      tabId: "tab-main",
    });
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "First ticket ever", spec: "the spec body" });
    expect(res.status).toBe(201);
    expect(res.json<unknown>()).toEqual({ ticketId: "enlist-1" });
    const ticketFile = readFileSync(join(world.pool, "issues", "enlist-1.md"), "utf8");
    expect(ticketFile).toContain(
      "<!-- state: id=enlist-1 blocked-by=none status=in-progress enlisted-from=pane-main -->",
    );
    expect(ticketFile).toContain("# enlist-1: First ticket ever");
  },
);

// ---------------------------------------------------------------------------
// enlist a pane as a conversation
// ---------------------------------------------------------------------------

/** The operator's opencode pane in a worktree on `feature/talk`, waiting. */
function talkPane(cwd: string, sessionId?: string): PaneSeed {
  return {
    paneId: "pane-conv",
    agent: "opencode",
    cwd,
    title: "OC | talk",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-conv",
    ...(sessionId ? { sessionId } : {}),
  };
}

/** The operator's opencode pane in the pool checkout itself, on main. */
function mainPane(world: World): PaneSeed {
  return {
    paneId: "pane-main",
    agent: "opencode",
    cwd: world.repo,
    title: "OC on main",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-main",
  };
}

async function endConversation(server: CaseServer, world: World): Promise<void> {
  const end = await server.http.post("/api/conversations/end", { id: "conv-1" });
  expect(end.status).toBe(202);
  await until(() => recordStatus(world), (status) => status === "ended", { what: "the ended Conversation", ms: 20_000 });
}

// engine/server.test.ts:4926
conformance(
  "enlist",
  "enlist a pane as a conversation › writes the Conversation live as found, claims the pane, and types the teaching then the opening",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const worktree = worktreeOn(world, "feature/talk");
    const fake = await t.herdr(world);
    await seedAgent(fake, talkPane(worktree, "sess-c"));
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk", opening: "hello agent" });
    expect(res.status).toBe(201);
    expect(res.json<unknown>()).toEqual({ conversationId: "conv-1" });

    const file = readFileSync(join(world.pool, "conversations", "conv-1.md"), "utf8");
    expect(file).toContain("id=conv-1 status=live");
    expect(file).toContain("pane=pane-conv");
    expect(file).toContain(`directory=${encodeURIComponent(worktree)}`);
    expect(file).toContain(`branch=${encodeURIComponent("feature/talk")}`);
    expect(file).toContain("session=sess-c");
    expect(file).toContain("# A talk");
    expect(file).toContain("hello agent");

    await fake.settle();
    expect(fake.calls.some(isCall("tab.create"))).toBe(false);
    expect(fake.calls.some(isCall("pane.report_agent", "pane-conv"))).toBe(true);
    const rename = fake.calls.find((c) => c.method === "tab.rename" && c.params.tab_id === "tab-conv");
    expect(rename?.params.label).toBe("conv-1 · A talk");

    const snap = await until(
      () => snapshot(server),
      (s) => {
        const c = s.state.conversations.find((cv) => cv.id === "conv-1");
        return c?.status === "live" && c.paneId === "pane-conv" && c.enlisted === true;
      },
      { what: "the enlisted Conversation on the snapshot" },
    );
    const c = snap.state.conversations.find((cv) => cv.id === "conv-1")!;
    expect(c.assignment).toEqual({ harness: "opencode", model: null, drivers: "implement" });
    expect(c.branch).toBe("feature/talk");

    const peek = await server.http.get("/api/terminal/peek?ticket=conv-1");
    expect(peek.status).toBe(200);
    expect(peek.json<{ paneId: string }>().paneId).toBe("pane-conv");

    // The teaching Turn, then the opening Turn, both typed.
    const typed = await until(
      () => submitted(fake),
      (texts) => texts.some((text) => text.includes(CONVERSATION_TEACHING)) && texts.includes("hello agent"),
      { what: "the teaching and opening Turns typed", ms: 20_000 },
    );
    const teachingAt = typed.findIndex((text) => text.includes(CONVERSATION_TEACHING));
    const openingAt = typed.findIndex((text) => text === "hello agent");
    expect(teachingAt).toBeGreaterThanOrEqual(0);
    expect(openingAt).toBeGreaterThan(teachingAt);
  },
);

// engine/server.test.ts:5003
conformance(
  "herdr",
  "enlist a pane as a conversation › peek serves the engine's own viewport read of an enlisted Conversation's pane, and forgets it at End (issue #122)",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const worktree = worktreeOn(world, "feature/talk");
    const fake = await t.herdr(world);
    await seedAgent(fake, talkPane(worktree));
    const server = await t.start(world, { herdr: fake });
    const res = await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk" });
    expect(res.status).toBe(201);
    await until(() => conversation(server), (c) => c?.paneId === "pane-conv", { what: "the enlisted Conversation on the snapshot" });

    const { first, second } = await peekTwiceAcrossAChange(server, fake, "pane-conv", "conv-1");
    expect(first.paneId).toBe("pane-conv");
    expect(first.text).toContain("ctrl+p commands");
    expect(second.text).toBe(first.text);
    const turnReads = paneReads(fake, "pane-conv").filter((c) => c.params.source === "visible");
    expect(turnReads.length).toBeGreaterThan(0);
    for (const read of turnReads) expect("lines" in read.params).toBe(false);

    // End: the pane leaves the view, so the route answers no-pane, and it
    // reads nothing to say so.
    await endConversation(server, world);
    const mark = fake.calls.length;
    const ended = await server.http.get("/api/terminal/peek?ticket=conv-1");
    expect(ended.status).toBe(404);
    expect(paneReads(fake, "pane-conv", mark)).toHaveLength(0);
  },
);

// engine/server.test.ts:5058
conformance(
  "enlist",
  "enlist a pane as a conversation › queues the teaching and opening while the pane is working and types them once waiting",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const worktree = worktreeOn(world, "feature/talk");
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-busy",
      agent: "opencode",
      cwd: worktree,
      title: "OC busy",
      status: "working",
      rendered: OPENCODE_WORKING,
      tabId: "tab-busy",
    });
    const server = await t.start(world, { herdr: fake });

    const pending = enlist(server, { becomes: "conversation", paneId: "pane-busy", title: "Queued talk", opening: "hello turn" });
    await Bun.sleep(PANE_POLL_MS * 2);
    expect((await submitted(fake)).some((text) => text.includes(CONVERSATION_TEACHING))).toBe(false);
    expect(await conversation(server)).toBeUndefined();

    await fake.control("setPaneContent", "pane-busy", OPENCODE_WAITING);
    const res = await pending;
    expect(res.status).toBe(201);
    await until(
      () => submitted(fake),
      (texts) => texts.some((text) => text.includes(CONVERSATION_TEACHING)),
      { what: "the queued teaching Turn", ms: 20_000 },
    );
    await until(() => submitted(fake), (texts) => texts.includes("hello turn"), {
      what: "the queued opening Turn",
      ms: 20_000,
    });
  },
);

// engine/server.test.ts:5102
conformance(
  "enlist",
  "enlist a pane as a conversation › refuses a pane still working past the teaching wait, with no record and no branch",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-busy",
      agent: "opencode",
      cwd: world.repo,
      title: "OC busy",
      status: "working",
      rendered: OPENCODE_WORKING,
      tabId: "tab-busy",
    });
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "conversation", paneId: "pane-busy", title: "Never taught", opening: "hello turn" });
    expect(res.status).toBe(409);
    expect(res.json<{ reason: string }>().reason).toContain("still working");
    expect(await submitted(fake)).toHaveLength(0);
    expect(await conversation(server)).toBeUndefined();
    expect(existsSync(join(world.pool, "conversations", "conv-1.md"))).toBe(false);
    expect(poolBranch(world, "conv-1")).toBe("");
    expect(currentBranch(world, world.repo)).toBe("main");
    await fake.settle();
    expect(fake.calls.some(isCall("tab.rename"))).toBe(false);
    expect(fake.calls.some(isCall("pane.report_agent"))).toBe(false);
  },
  { timeoutMs: TEACHING_WAIT_MS + 60_000 },
);

// engine/server.test.ts:5139
conformance(
  "enlist",
  "enlist a pane as a conversation › End merges the found branch and leaves the tab and directory alone",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const worktree = worktreeOn(world, "feature/talk");
    commitIn(world, worktree, "talk.txt", "talk work\n");
    const fake = await t.herdr(world);
    await seedAgent(fake, talkPane(worktree));
    const server = await t.start(world, { herdr: fake });
    expect((await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk" })).status).toBe(201);

    await endConversation(server, world);

    // The found branch merged onto the pool's working branch.
    expect(existsSync(join(world.repo, "talk.txt"))).toBe(true);
    // The found directory and branch survive, and the operator's tab stays.
    expect(existsSync(worktree)).toBe(true);
    expect(currentBranch(world, worktree)).toBe("feature/talk");
    expect(refExists(world, "feature/talk")).toBe(true);
    await fake.settle();
    expect(fake.calls.some((c) => c.method === "tab.close" && c.params.tab_id === "tab-conv")).toBe(false);
    await fake.waitForCall(isCall("pane.release_agent", "pane-conv"));
  },
);

// engine/server.test.ts:5193
conformance(
  "enlist",
  "enlist a pane as a conversation › End merges onto the merge target, not into the checkout an enlisted agent works in",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const target = currentBranch(world, world.repo);
    const worktree = worktreeOn(world, "feature/talk");
    commitIn(world, worktree, "talk.txt", "talk work\n");
    const fake = await t.herdr(world);
    // An enlisted Ticket holds the pool checkout on its created pool branch,
    // with uncommitted work.
    await seedAgent(fake, mainPane(world));
    await seedAgent(fake, talkPane(worktree));
    const server = await t.start(world, { herdr: fake });
    expect((await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" })).status).toBe(201);
    const created = poolBranch(world, "enlist-1");
    expect(created).not.toBe("");
    expect(currentBranch(world, world.repo)).toBe(created);
    writeFileSync(join(world.repo, "wip.txt"), "uncommitted\n");
    const headBefore = head(world, world.repo);

    expect((await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk" })).status).toBe(201);
    await endConversation(server, world);

    // The found branch landed on the merge target...
    expect(world.git(["show", `${target}:talk.txt`])).toBe("talk work\n");
    // ...and the enlisted agent's checkout was neither moved nor written.
    expect(currentBranch(world, world.repo)).toBe(created);
    expect(head(world, world.repo)).toBe(headBefore);
    expect(existsSync(join(world.repo, "talk.txt"))).toBe(false);
    expect(readFileSync(join(world.repo, "wip.txt"), "utf8")).toBe("uncommitted\n");
  },
);

// engine/server.test.ts:5260
conformance(
  "enlist",
  "enlist a pane as a conversation › a started Conversation forks from the merge target, not from the checkout an enlisted agent works in",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const target = currentBranch(world, world.repo);
    // The started Conversation runs the stubbed claude, held open in its
    // pane, and the fake renders claude's ready frame on every new pane so
    // the launch types its teaching and goes live.
    world.stubs.script("_claude", { waitFor: join(world.root, "release-claude") });
    const fake = await t.herdr(world, { rendered: CLAUDE_READY });
    await seedAgent(fake, mainPane(world));
    const server = await t.start(world, { herdr: fake });
    expect((await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" })).status).toBe(201);
    const enlistBranch = poolBranch(world, "enlist-1");
    expect(enlistBranch).not.toBe("");
    expect(currentBranch(world, world.repo)).toBe(enlistBranch);
    // The enlisted agent commits on its created pool branch.
    commitIn(world, world.repo, "agent.txt", "agent work\n");
    const agentSha = head(world, world.repo);
    const targetSha = world.git(["rev-parse", target]).trim();
    expect(agentSha).not.toBe(targetSha);

    const started = await server.http.post("/api/conversations", { title: "Started" });
    expect(started.status).toBe(201);
    const commitSha = spawnedEvent(world, "conv-1").commitSha;
    expect(commitSha).toBe(targetSha);
    expect(commitSha).not.toBe(agentSha);
    const convBranch = poolBranch(world, "conv-1");
    expect(convBranch).not.toBe("");
    const ancestor = Bun.spawnSync(["git", "-C", world.repo, "merge-base", "--is-ancestor", agentSha, convBranch], {
      env: world.env(""),
    });
    expect(ancestor.exitCode).toBe(1);
    expect(currentBranch(world, world.repo)).toBe(enlistBranch);

    writeFileSync(join(world.root, "release-claude"), "");
  },
);

// engine/server.test.ts:5316
conformance(
  "enlist",
  "enlist a pane as a conversation › a pane going records the Conversation crashed with the branch kept",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    const worktree = worktreeOn(world, "feature/talk");
    commitIn(world, worktree, "talk.txt", "talk work\n");
    const fake = await t.herdr(world);
    await seedAgent(fake, talkPane(worktree));
    const server = await t.start(world, { herdr: fake });
    expect((await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk" })).status).toBe(201);

    await fake.control("endPane", "pane-conv");
    await until(() => recordStatus(world), (status) => status === "crashed", { what: "the crashed Conversation", ms: 20_000 });
    expect(refExists(world, "feature/talk")).toBe(true);
    expect(existsSync(worktree)).toBe(true);
    await fake.settle();
    expect(fake.calls.some((c) => c.method === "tab.close" && c.params.tab_id === "tab-conv")).toBe(false);
  },
);

// engine/server.test.ts:5352
conformance("restart", "enlist a pane as a conversation › re-adopts a live enlisted Conversation after a server restart", async (t) => {
  const world = terminalWorld(t, [done01]);
  const worktree = worktreeOn(world, "feature/talk");
  const fake = await t.herdr(world);
  await seedAgent(fake, talkPane(worktree));

  const first = await t.start(world, { herdr: fake });
  expect((await enlist(first, { becomes: "conversation", paneId: "pane-conv", title: "A talk" })).status).toBe(201);
  // An orderly stop releases the pool lock; the record stays live.
  await first.stop();

  const second = await t.start(world, { herdr: fake });
  await until(
    () => conversation(second),
    (c) => c?.status === "live" && c.paneId === "pane-conv" && c.enlisted === true,
    { what: "the re-adopted Conversation", ms: 20_000 },
  );
  expect(recordStatus(world)).toBe("live");
});

// engine/server.test.ts:5397
conformance(
  "conversations",
  "enlist a pane as a conversation › Spawns a ticket and receives the Notice when that ticket ends",
  async (t) => {
    // The child's id is deterministic (conv-1's first spawn is
    // conv-1-spawn-1), so the pool's static assign puts it on claude.
    const world = terminalWorld(t, [done01], { assign: { "conv-1-spawn-1": { harness: "claude", model: "m" } } });
    const worktree = worktreeOn(world, "feature/talk");
    // The child runs in a herdr tab as the stubbed claude, held open; the
    // fake renders claude's ready frame on every new pane, so its prompt is
    // typed. The case then plays the harness and checkpoints, which reaches
    // the parent as a Notice whether or not the child got a branch.
    world.stubs.script("_claude", { waitFor: join(world.root, "release-claude") });
    const fake = await t.herdr(world, { rendered: CLAUDE_READY });
    await seedAgent(fake, talkPane(worktree));
    const server = await t.start(world, { herdr: fake });
    expect((await enlist(server, { becomes: "conversation", paneId: "pane-conv", title: "A talk" })).status).toBe(201);

    mkdirSync(join(world.pool, "runs"), { recursive: true });
    writeFileSync(
      join(world.pool, "runs", "conv-1.spawn.json"),
      JSON.stringify({ spawn: [{ title: "Child work", body: "a body carrying more than twenty characters of intent" }] }),
    );
    await until(() => existsSync(join(world.pool, "issues", "conv-1-spawn-1.md")), (found) => found, {
      what: "the spawned ticket file",
      ms: 20_000,
    });

    // The child's prompt, typed into its own pane, names its outcome file.
    const prompt = await until(
      () => submitted(fake),
      (texts) => texts.some((text) => text.includes("conv-1-spawn-1.md") && text.includes("outcome as JSON at ")),
      { what: "the child's prompt typed", ms: 30_000 },
    );
    const outcomeText = prompt.find((text) => text.includes("conv-1-spawn-1.md") && text.includes("outcome as JSON at "))!;
    const outcome = /outcome as JSON at ([^:\s]+):/.exec(outcomeText)?.[1];
    expect(outcome).toBe(join(world.pool, "runs", "conv-1-spawn-1.outcome.json"));
    writeFileSync(
      outcome!,
      JSON.stringify({ status: "checkpoint", summary: "summary-conv-1-spawn-1", commitSha: null, brief: "Needs your input." }),
    );

    // The Notice is typed into the enlisted pane.
    await fake.waitForCall(
      (c) => isCall("pane.send_input", "pane-conv")(c) && String(c.params.text ?? "").includes("conv-1-spawn-1"),
      { ms: 30_000 },
    );
    writeFileSync(join(world.root, "release-claude"), "");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:5456
conformance(
  "enlist",
  "enlist a pane as a conversation › creates the pool branch in place when the pane sits on the merge target",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    writeFileSync(join(world.repo, "dirty.txt"), "uncommitted\n");
    const fake = await t.herdr(world);
    await seedAgent(fake, mainPane(world));
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "conversation", paneId: "pane-main", title: "On main" });
    expect(res.status).toBe(201);

    const branch = poolBranch(world, "conv-1");
    expect(branch).not.toBe("");
    expect(refExists(world, branch)).toBe(true);
    expect(currentBranch(world, world.repo)).toBe(branch);
    expect(readFileSync(join(world.repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    const record = readFileSync(join(world.pool, "conversations", "conv-1.md"), "utf8").split("\n", 1)[0]!;
    expect(record).toContain(` branch=${encodeURIComponent(branch)} `);
    expect(spawnedEvent(world, "conv-1").branch_rule).toBe("created");
  },
);

// engine/server.test.ts:5496
conformance(
  "enlist",
  "enlist a pane as a conversation › a failed enlist in Conversation mode leaves no file and no branch",
  async (t) => {
    const world = terminalWorld(t, [done01]);
    writeFileSync(join(world.repo, "dirty.txt"), "uncommitted\n");
    const fake = await t.herdr(world);
    await seedAgent(fake, {
      paneId: "pane-main",
      agent: "claude",
      cwd: world.repo,
      title: "✳ Claude Code",
      status: "idle",
      rendered: CLAUDE_READY,
      tabId: "tab-main",
    });
    await fake.control("dropPaneInput", "pane-main", 10);
    const server = await t.start(world, { herdr: fake });

    const res = await enlist(server, { becomes: "conversation", paneId: "pane-main", title: "Never taught", opening: "hello" });
    expect(res.status).toBe(409);
    expect(res.json<{ reason: string }>().reason).toContain("could not be delivered");

    expect(existsSync(join(world.pool, "conversations", "conv-1.md"))).toBe(false);
    expect(poolBranch(world, "conv-1")).toBe("");
    expect(currentBranch(world, world.repo)).toBe("main");
    expect(readFileSync(join(world.repo, "dirty.txt"), "utf8")).toBe("uncommitted\n");
    await fake.waitForCall(isCall("pane.release_agent", "pane-main"));
  },
);
