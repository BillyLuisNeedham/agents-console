/**
 * What the restart cases for Conversations and panes share (ticket C06 of the
 * Rust port's inventory, docs/research/rust-port/test-inventory.md): a
 * terminal-backed git pool whose Conversations run in panes of one fake
 * herdr, kept alive across every server the case starts, as a live daemon
 * outlives a Restart; a Conversation started on the first server and left
 * talking when it stops; and the reads a case makes of a Conversation's
 * record, events and view. Everything goes through HTTP, the pool's files
 * and the calls on the fake herdr's socket.
 *
 * A stop leaves a started Conversation's tab and TUI running (issue #140),
 * so its stub, held in the pane, is still there for the next server to find.
 * What happened while no server ran is done to the fake or the files between
 * the two, and the next server is the next leg (`startLeg`).
 */

import { expect } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, EnrichedSnapshot, TicketEvent } from "../../protocol/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import { ticketWorktree } from "../harness/git-pool.ts";
import { callsOf, CLAUDE_READY, type HerdrCall, type HerdrOptions, type HerdrProcess } from "../harness/herdr.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { snapshotOf, startLeg } from "./restart-support.ts";

/** Long enough for any case; the stub ends early once its world is gone. */
const HOLD_SECONDS = 150;

/** Ticket 01, done: a pool whose only work is its Conversations. */
export const DONE_01: TicketSeed = { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" };

/** The fake herdr's options: every pane draws claude's ready frame and idle prompt. */
export const HERDR: HerdrOptions = { rendered: CLAUDE_READY };

/**
 * A terminal-backed git pool on claude, Ticket 01 done, whose stub TUIs hold
 * their panes. A terminal-backed launch names no outcome file in its argv,
 * so a Conversation's launch is keyed by its binary's name.
 */
export function conversationWorld(t: Case, tickets: TicketSeed[] = [DONE_01]): World {
  const world = t.world({ tickets, config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" } });
  world.stubs.script("_claude", { hold: HOLD_SECONDS });
  return world;
}

/** A started Conversation as the first server left it. */
export interface Started {
  world: World;
  herdr: HerdrProcess;
  id: string;
  paneId: string;
  tabId: string;
  /** The terminal id herdr reported for its pane, as its spawned event records it. */
  terminalId: string;
  branch: string;
  worktree: string;
}

/**
 * Start Conversation conv-1 on the first server (leg 0), wait until it is
 * live in its pane, and stop the server: the tab and the stub TUI stay as
 * they were. The case does what happens while no server runs, then starts
 * the next with `reboot`.
 */
export async function startedThenStopped(t: Case, world = conversationWorld(t)): Promise<Started> {
  const herdr = await t.herdr(world, HERDR);
  const first = await startLeg(t, world, 0, { herdr });
  const started = await first.http.post("/api/conversations", { title: "Across a restart" });
  expect(started.status, started.text).toBe(201);
  const view = started.json<{ conversation: ConversationView }>().conversation;
  expect(view).toMatchObject({ id: "conv-1", status: "live" });
  const spawned = readEvents(world.pool, view.id).find((event) => event.kind === "spawned");
  if (!spawned) throw new Error("conv-1 has no spawned event");
  await first.stop();
  await herdr.settle();
  // The stop left the tab as it was.
  expect(callsOf(herdr, "tab.close")).toEqual([]);
  const { path, branch } = ticketWorktree(world.repo, view.id);
  return {
    world,
    herdr,
    id: view.id,
    paneId: String(spawned.payload.pane_id),
    tabId: String(spawned.payload.tab_id),
    terminalId: String(spawned.payload.terminal_id),
    branch,
    worktree: path,
  };
}

/** Start the next server on the pool (leg `n`, the second by default) on the same fake herdr. */
export function reboot(t: Case, started: Started, n = 1): Promise<CaseServer> {
  return startLeg(t, started.world, n, { herdr: started.herdr });
}

/** Every herdr call naming one tab, from index `from` on, once the fake's record is complete. */
export async function callsOnTab(herdr: HerdrProcess, tabId: string, from = 0): Promise<string[]> {
  await herdr.settle();
  return herdr.calls.slice(from).filter((call) => call.params.tab_id === tabId).map((call) => call.method);
}

/** Every herdr call naming one pane, from index `from` on, once the fake's record is complete. */
export async function callsOnPane(herdr: HerdrProcess, paneId: string, from = 0): Promise<string[]> {
  await herdr.settle();
  return herdr.calls.slice(from).filter((call) => call.params.pane_id === paneId).map((call) => call.method);
}

function recordPath(world: World, id: string): string {
  return join(world.pool, "conversations", `${id}.md`);
}

/** A Conversation record's file, byte for byte. */
export function recordText(world: World, id = "conv-1"): string {
  return readFileSync(recordPath(world, id), "utf8");
}

/** The status on a Conversation record's marker line; "" while there is no record. */
export function recordStatus(world: World, id = "conv-1"): string {
  const path = recordPath(world, id);
  if (!existsSync(path)) return "";
  return /status=([a-z]+)/.exec(readFileSync(path, "utf8").split("\n", 1)[0]!)?.[1] ?? "";
}

/** Wait for a Conversation record's marker line to read `status`. */
export async function untilRecord(world: World, status: string, id = "conv-1", ms = 30_000): Promise<void> {
  await until(() => recordStatus(world, id), (got) => got === status, {
    what: `${id}'s record to read status=${status}`,
    ms,
  });
}

/** A Conversation's events as their kinds, in order. */
export function kindsOf(world: World, id = "conv-1"): string[] {
  return readEvents(world.pool, id).map((event) => event.kind);
}

/** A Conversation's events of one kind. */
export function eventsOf(world: World, kind: string, id = "conv-1"): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** Wait for a Conversation's events to hold one of `kind`, and hand them all back. */
export function untilEvent(world: World, kind: string, id = "conv-1", ms = 30_000): Promise<TicketEvent[]> {
  return until(() => readEvents(world.pool, id), (events) => events.some((event) => event.kind === kind), {
    what: `a ${kind} event for ${id}`,
    ms,
  });
}

/** Append one event to a Conversation's events file, as the engine appends one. */
export function appendEvent(world: World, kind: string, payload: Record<string, unknown> = {}, id = "conv-1"): void {
  const event = { at: new Date().toISOString(), attempt: 1, kind, payload };
  appendFileSync(join(world.pool, "runs", `${id}.events.jsonl`), `${JSON.stringify(event)}\n`);
}

/** A Conversation's view on a snapshot. */
export function conversationIn(snapshot: EnrichedSnapshot, id = "conv-1"): ConversationView {
  const found = snapshot.state.conversations.find((each) => each.id === id);
  if (!found) throw new Error(`the snapshot has no Conversation ${id}`);
  return found;
}

/** The Conversation's view as GET /api/state serves it now. */
export async function viewNow(server: CaseServer, id = "conv-1"): Promise<ConversationView> {
  return conversationIn(await snapshotOf(server), id);
}

/** The snapshot's Finished terminals count now. */
export async function finishedNow(server: CaseServer): Promise<number> {
  return (await snapshotOf(server)).finishedTerminals;
}

/** POST /api/conversations/end, which must answer 202. */
export async function endConversation(server: CaseServer, id = "conv-1"): Promise<void> {
  const answer = await server.http.post("/api/conversations/end", { id });
  expect(answer.status, answer.text).toBe(202);
}

/** POST /api/terminals/close-finished, which must answer 200; how many it closed. */
export async function closeFinished(server: CaseServer): Promise<number> {
  const answer = await server.http.post("/api/terminals/close-finished");
  expect(answer.status, answer.text).toBe(200);
  return answer.json<{ closed: number }>().closed;
}

/** The pool log line a boot re-adoption of a started Conversation writes. */
export function readoptedLine(id: string, paneId: string): string {
  return `conversation ${id}: re-adopted at boot from live pane ${paneId}`;
}
