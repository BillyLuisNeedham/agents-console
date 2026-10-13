/**
 * Peek and the pane read register (issue #122), seen from outside the server
 * (ADR-0036): GET /api/terminal/peek answers from the engine's own last read
 * of a pane one of its loops watches (an enlisted attempt's, a
 * Conversation's), and reads herdr live, of the viewport only, for a pane no
 * loop watches (a spawned attempt's, a Held pane). Rows of the `herdr` area
 * in the Rust port inventory (docs/research/rust-port/test-inventory.md,
 * ticket C15), the area's gap on Peek, and two `enlist` rows on the reads an
 * enlisted attempt makes.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { OPENCODE_READY, OPENCODE_WAITING, type HerdrCall, type HerdrProcess } from "../harness/herdr.ts";
import { awaitPrompt, readyTicket } from "../harness/herdr-tui.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { CHECKPOINT, fakeHerdr, snapshotOf, terminalWorld, ticketAt, ticketIn, untilHeld } from "./herdr-panes-support.ts";

/** The shape of every viewport read: no line count, ANSI stripped. */
function viewportRead(paneId: string): { method: string; params: Record<string, unknown> } {
  return { method: "pane.read", params: { pane_id: paneId, source: "visible", format: "text", strip_ansi: true } };
}

/** The reads of one pane from call `from` on, as method and params. */
function readsOf(herdr: HerdrProcess, paneId: string, from = 0): { method: string; params: Record<string, unknown> }[] {
  return herdr.calls
    .slice(from)
    .filter((call: HerdrCall) => call.method === "pane.read" && call.params.pane_id === paneId)
    .map(({ method, params }) => ({ method, params }));
}

function peek(server: CaseServer, id: string) {
  return server.http.get(`/api/terminal/peek?ticket=${id}`);
}

/** Wait until a peek of `id` answers 200 with exactly `text`. */
async function untilPeekShows(server: CaseServer, id: string, text: string): Promise<void> {
  await until(
    async () => {
      const answer = await peek(server, id);
      return answer.status === 200 ? answer.json<{ text: string }>().text : null;
    },
    (got) => got === text,
    { ms: 30_000, what: `a peek of ${id} showing ${JSON.stringify(text)}` },
  );
}

/**
 * A git pool on opencode, terminal-backed, with the operator's opencode pane
 * `pane-op` waiting in a worktree of their own on feature/x.
 */
async function operatorPane(t: Case): Promise<{ world: World; herdr: HerdrProcess; server: CaseServer }> {
  const world = t.world({
    config: { defaults: { harness: "opencode", model: "m" }, terminal: "herdr" },
    tickets: [ticketAt("01", "done")],
  });
  const worktree = join(world.root, "found");
  world.git(["worktree", "add", "-q", "-b", "feature/x", worktree]);
  const herdr = await t.herdr(world, { rendered: OPENCODE_READY });
  await herdr.control("seedAgent", {
    paneId: "pane-op",
    agent: "opencode",
    cwd: worktree,
    title: "OC",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-op",
  });
  const server = await t.start(world, { herdr });
  return { world, herdr, server };
}

function enlistIt(server: CaseServer) {
  return server.http.post("/api/enlist", { becomes: "ticket", paneId: "pane-op", title: "Do the thing", spec: "" });
}

// engine/pane-reads.test.ts:5
conformance(
  "herdr",
  "pane read register (issue #122) › serves the latest recorded read per pane and nothing for a pane never recorded",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Unwatched")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    await awaitPrompt(herdr, "01");

    // A live Conversation, whose Turn loop reads its pane every tick.
    const started = await server.http.post("/api/conversations", { title: "Watched" });
    expect(started.status).toBe(201);
    const conversation = started.json<{ conversation: { id: string; paneId: string } }>().conversation;
    const frame = "Claude Code v1\nthe last frame the loop read\n❯ ";
    await herdr.control("setPaneContent", conversation.paneId, frame);
    // Two of the loop's own viewport reads after the change, and no peek
    // yet (a pane with no recorded read is read live): by the second, the
    // first one's answer is recorded.
    const loopRead = (call: HerdrCall) =>
      call.method === "pane.read" && call.params.pane_id === conversation.paneId && call.params.source === "visible";
    const first = await herdr.waitForCall(loopRead, { from: herdr.calls.length, ms: 30_000 });
    await herdr.waitForCall(loopRead, { from: herdr.calls.indexOf(first) + 1, ms: 30_000 });

    await herdr.control("fail", "pane.read", true);
    const watched = await peek(server, conversation.id);
    expect(watched.status).toBe(200);
    expect(watched.json<object>()).toEqual({ ticket: conversation.id, paneId: conversation.paneId, text: frame });
    // 01's pane has no loop, so its peek reads herdr, and herdr refuses.
    const unwatched = await peek(server, "01");
    expect(unwatched.status).toBe(502);
    expect(unwatched.json<{ error: string }>().error).toContain("pane.read refused");
  },
  { timeoutMs: 120_000 },
);

// engine/pane-reads.test.ts:20
conformance(
  "herdr",
  "pane read register (issue #122) › forgets a pane on request, and forgetting one never recorded is a no-op",
  async (t) => {
    const { world, herdr, server } = await operatorPane(t);
    expect((await enlistIt(server)).status).toBe(201);
    const frozen = "opencode\nthe loop's last frame\nctrl+p commands";
    await herdr.control("setPaneContent", "pane-op", frozen);
    await untilPeekShows(server, "enlist-1", frozen);

    // A checkpoint ends the attempt and its loop; the pane is held.
    writeFileSync(join(world.pool, "runs", "enlist-1.outcome.json"), JSON.stringify(CHECKPOINT));
    expect(await untilHeld(server, "enlist-1", 45_000)).toEqual({ attempt: 1, paneId: "pane-op" });
    // Read live now, never the frame the loop last read.
    const live = "opencode\nread live\nctrl+p commands";
    await herdr.control("setPaneContent", "pane-op", live);
    const read = await peek(server, "enlist-1");
    expect(read.json<object>()).toEqual({ ticket: "enlist-1", paneId: "pane-op", text: live });
    await herdr.control("fail", "pane.read", true);
    const refused = await peek(server, "enlist-1");
    expect(refused.status).toBe(502);
    expect(refused.json<{ error: string }>().error).toContain("pane.read refused");
  },
  { timeoutMs: 120_000 },
);

// engine/enlisted.test.ts:69
conformance(
  "enlist",
  "enlisted attempts read the viewport and record it (issue #122) › every Turn-state read is of the viewport only, and the register holds the latest one until release",
  async (t) => {
    const { herdr, server } = await operatorPane(t);
    expect((await enlistIt(server)).status).toBe(201);
    // From the claim on, the attempt's reads are its Turn-state reads. (The
    // teaching Turn typed during the claim checks its paste as every typed
    // Turn does, NOT-PORTED.md, `herdr` panes.)
    await herdr.settle();
    const from = herdr.calls.length;
    const moved = "opencode\nstill here\nctrl+p commands";
    await herdr.control("setPaneContent", "pane-op", moved);
    await untilPeekShows(server, "enlist-1", moved);

    const reads = readsOf(herdr, "pane-op", from);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads).toEqual(reads.map(() => viewportRead("pane-op")));
  },
);

// engine/enlisted.test.ts:128
conformance(
  "enlist",
  "enlisted attempts read the viewport and record it (issue #122) › a pane the daemon refuses to read is refused without an entry, and dispose forgets a live one",
  async (t) => {
    const { world, herdr, server } = await operatorPane(t);
    await herdr.control("fail", "pane.read", true);
    const refused = await enlistIt(server);
    expect(refused.status).toBe(409);
    expect(refused.json<{ reason: string }>().reason).toContain("could not be read");
    expect(existsSync(join(world.pool, "issues", "enlist-1.md"))).toBe(false);
    expect((await peek(server, "enlist-1")).status).toBe(404);

    await herdr.control("fail", "pane.read", false);
    const accepted = await enlistIt(server);
    expect(accepted.status).toBe(201);
    expect(accepted.json<object>()).toMatchObject({ ticketId: "enlist-1" });
    await untilPeekShows(server, "enlist-1", OPENCODE_WAITING);
  },
);

// gap: engine/server.ts:2246 and engine/herdr.ts:359 (Peek of a pane no Turn loop watches)
conformance(
  "herdr",
  "peek reads a pane no loop watches live, of the viewport only, and a blank one is empty text",
  async (t) => {
    const { world } = terminalWorld(t, { tickets: [readyTicket("01", "Blank")] });
    const herdr = await fakeHerdr(t, world);
    const server = await t.start(world, { herdr });
    const typed = await awaitPrompt(herdr, "01");

    // The Live attempt's pane, blank.
    await herdr.control("setPaneContent", typed.paneId, "");
    let from = herdr.calls.length;
    const live = await peek(server, "01");
    expect(live.status).toBe(200);
    expect(live.json<object>()).toEqual({ ticket: "01", paneId: typed.paneId, text: "" });
    await herdr.settle();
    expect(readsOf(herdr, typed.paneId, from)).toEqual([viewportRead(typed.paneId)]);

    // The same pane held at a checkpoint: no loop watches a Held pane either.
    writeFileSync(typed.outcomePath, JSON.stringify(CHECKPOINT));
    await untilHeld(server, "01");
    expect(ticketIn(await snapshotOf(server), "01")).toMatchObject({
      liveAttempt: null,
      heldPane: { attempt: 1, paneId: typed.paneId },
    });
    await herdr.settle();
    from = herdr.calls.length;
    const held = await peek(server, "01");
    expect(held.json<object>()).toEqual({ ticket: "01", paneId: typed.paneId, text: "" });
    await herdr.settle();
    expect(readsOf(herdr, typed.paneId, from)).toEqual([viewportRead(typed.paneId)]);
  },
);
