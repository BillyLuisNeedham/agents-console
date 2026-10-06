/**
 * What the Turn state and Notice cases share (`conversations-turns-*.test.ts`
 * and `conversations-notices-*.test.ts`, ticket C17 of the Rust port
 * inventory, docs/research/rust-port/test-inventory.md): a terminal-backed
 * git pool whose claude and opencode are TUI stand-ins that hold their panes
 * (harness/herdr-tui.ts), the fake herdr drawing a busy claude frame in
 * every pane, and the reads a case makes of what the server publishes and
 * types.
 *
 * A Conversation's Turn state is read from its pane every two seconds, one
 * viewport read (`source: "visible"`) per tick, and nothing else reads a
 * pane that way. So a case changes what the pane shows with the fake's
 * `setPaneContent`, counts the server's viewport reads of it from then on,
 * and watches the socket for what the server publishes: every change to a
 * Conversation's Turn the server publishes arrives there as a frame, in
 * order, and a read that changes nothing on the wire publishes nothing.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationView, EnrichedSnapshot, PoolConfig, TicketEvent } from "../../protocol/wire.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { HerdrCall, HerdrOptions, HerdrProcess } from "../harness/herdr.ts";
import { TERMINAL_CONFIG, tuiStandIn } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** claude up and mid-Turn: its ready header and no idle `❯`, so the Turn reads working. */
export const BUSY = "Claude Code v1\n✢ Working…";

/** claude up and waiting on the operator: its ready header and its idle `❯`. */
export const IDLE = "Claude Code v1\n❯ ";

const DONE_01: TicketSeed = { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" };

/** A spawn proposal's body: over the twenty-character floor. */
export const BODY = "A follow-up with well over twenty characters of intent to work from.";

/** A Turn as the wire shows it. */
export type Turn = ConversationView["turn"];

export interface Talk {
  world: World;
  herdr: HerdrProcess;
  server: CaseServer;
  /** A socket opened before anything ran: every snapshot the server pushed since boot. */
  socket: SocketClient;
}

/**
 * A terminal-backed git pool whose only Ticket is done, claude and opencode
 * TUI stand-ins, every pane drawing `rendered` (BUSY unless given), its
 * server up and a socket on it. `config` merges over claude/m in herdr panes.
 */
export async function startTalk(
  t: Case,
  options: { config?: Partial<PoolConfig>; herdr?: HerdrOptions } = {},
): Promise<Talk> {
  const world = t.world({ tickets: [DONE_01], config: { ...TERMINAL_CONFIG, ...options.config } as PoolConfig });
  tuiStandIn(world, "claude");
  tuiStandIn(world, "opencode");
  const herdr = await t.herdr(world, { rendered: BUSY, ...options.herdr });
  const server = await t.start(world, { herdr });
  const socket = await t.socket(server, { visible: false });
  return { world, herdr, server, socket };
}

/** POST /api/conversations, which must answer 201; the new Conversation's view. */
export async function startConversation(
  server: CaseServer,
  body: { title: string; opening?: string; assign?: Record<string, string> },
): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", body);
  expect(answer.status, answer.text).toBe(201);
  return answer.json<{ conversation: ConversationView }>().conversation;
}

/** The snapshot GET /api/state serves now. */
export async function state(server: CaseServer): Promise<EnrichedSnapshot> {
  const snapshot = (await server.http.get("/api/state")).json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snapshot === null) throw new Error("GET /api/state served no snapshot");
  return snapshot;
}

/** A Conversation's view on a snapshot. */
export function viewIn(snapshot: EnrichedSnapshot, id: string): ConversationView {
  const view = snapshot.state.conversations.find((c) => c.id === id);
  if (!view) throw new Error(`the snapshot has no Conversation ${id}`);
  return view;
}

// ---------------------------------------------------------------------------
// The pane and its reads.
// ---------------------------------------------------------------------------

/**
 * Make the pane show `text` from now on, and hand back where the fake's
 * calls stand: every viewport read at or after that index was answered with
 * `text`. The control's round trip brings in every call the fake took
 * before it.
 */
export async function show(herdr: HerdrProcess, paneId: string, text: string): Promise<number> {
  await herdr.control("setPaneContent", paneId, text);
  return herdr.calls.length;
}

function isViewportRead(call: HerdrCall, paneId: string): boolean {
  return call.method === "pane.read" && call.params.pane_id === paneId && call.params.source === "visible";
}

/** The Turn-state reads of a pane at or after call `from`. */
export function viewportReads(herdr: HerdrProcess, paneId: string, from = 0): HerdrCall[] {
  return herdr.calls.slice(from).filter((call) => isViewportRead(call, paneId));
}

/** Wait until the pane has had `count` Turn-state reads at or after call `from`; hand them back. */
export function untilReads(herdr: HerdrProcess, paneId: string, from: number, count: number, ms = 30_000): Promise<HerdrCall[]> {
  return until(() => viewportReads(herdr, paneId, from), (reads) => reads.length >= count, {
    ms,
    what: `${count} Turn-state reads of ${paneId}`,
  });
}

// ---------------------------------------------------------------------------
// What the server publishes.
// ---------------------------------------------------------------------------

/** One Turn a frame on the socket carried for a Conversation. */
export interface PushedTurn {
  /** The frame's index in the socket's frames. */
  frame: number;
  /** When the frame arrived. */
  at: number;
  turn: Turn;
}

/** Conversation `id`'s view as each snapshot or delta frame on the socket left it, with the frame's index. */
export function pushedViews(socket: SocketClient, id: string): { frame: number; at: number; view: ConversationView }[] {
  const out: { frame: number; at: number; view: ConversationView }[] = [];
  let pushed: Parameters<typeof applySnapshotDelta>[0] | null = null;
  socket.frames.forEach((frame, index) => {
    if (frame.type === "snapshot") {
      pushed = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && pushed !== null) {
      pushed = applySnapshotDelta(pushed, frame.delta);
    } else return;
    const view = pushed?.snapshot.state.conversations.find((c) => c.id === id);
    if (view) out.push({ frame: index, at: socket.times[index]!, view });
  });
  return out;
}

/**
 * Every Turn the socket's frames carried for Conversation `id`, in order,
 * one per frame that changed it: a delta that changed another field of the
 * view, or nothing of it, adds none.
 */
export function pushedTurns(socket: SocketClient, id: string): PushedTurn[] {
  const out: PushedTurn[] = [];
  let last: string | null = null;
  for (const { frame, at, view } of pushedViews(socket, id)) {
    const key = JSON.stringify(view.turn);
    if (key === last) continue;
    last = key;
    out.push({ frame, at, turn: view.turn });
  }
  return out;
}

/** Wait for a Turn pushed for `id` at or after frame `from` that `match` holds of. */
export function untilPushedTurn(
  socket: SocketClient,
  id: string,
  match: (turn: Turn) => boolean,
  options: { from?: number; ms?: number; what?: string } = {},
): Promise<PushedTurn> {
  const from = options.from ?? 0;
  return until(
    () => pushedTurns(socket, id).find((pushed) => pushed.frame >= from && match(pushed.turn)),
    (found) => found !== undefined,
    { ms: options.ms ?? 30_000, what: options.what ?? `a Turn pushed for ${id}` },
  ) as Promise<PushedTurn>;
}

/** The Turns pushed for `id` at or after frame `from`. */
export function pushedSince(socket: SocketClient, id: string, from: number): Turn[] {
  return pushedTurns(socket, id)
    .filter((pushed) => pushed.frame >= from)
    .map((pushed) => pushed.turn);
}

/** An ISO time the server wrote, as milliseconds. */
export function ms(iso: string | null): number {
  if (iso === null) throw new Error("no time");
  return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// What the server types.
// ---------------------------------------------------------------------------

/**
 * Each Turn submitted with Enter into one pane, in order: the last text typed
 * before that Enter. The server types a Turn as one paste, and types it
 * again whole when a paste did not land (herdr refused it, or the pane
 * dropped it), so an earlier paste never joins the Turn it was retried as.
 */
export function turnsInto(herdr: HerdrProcess, paneId: string): string[] {
  const turns: string[] = [];
  let input: string | null = null;
  for (const call of herdr.calls) {
    if (call.method !== "pane.send_input" || call.params.pane_id !== paneId) continue;
    if (typeof call.params.text === "string") input = call.params.text;
    const keys = Array.isArray(call.params.keys) ? (call.params.keys as string[]) : [];
    if (keys.includes("enter") && input !== null) {
      turns.push(input);
      input = null;
    }
  }
  return turns;
}

/**
 * What a started Conversation's pane is typed at launch, before any Notice:
 * the wrapper that starts its harness, then its teaching Turn.
 */
export const LAUNCH_TURNS = 2;

/** Wait until `count` Notices have been typed into a started Conversation's pane; hand back the Notices. */
export async function untilNoticesInto(herdr: HerdrProcess, paneId: string, count: number): Promise<string[]> {
  return (await untilTurnsInto(herdr, paneId, LAUNCH_TURNS + count)).slice(LAUNCH_TURNS);
}

/** Wait until `count` Turns have been submitted into the pane; hand them all back. */
export function untilTurnsInto(herdr: HerdrProcess, paneId: string, count: number, ms = 30_000): Promise<string[]> {
  return until(() => turnsInto(herdr, paneId), (turns) => turns.length >= count, {
    ms,
    what: `${count} Turns submitted into ${paneId}`,
  });
}

// ---------------------------------------------------------------------------
// Spawned work.
// ---------------------------------------------------------------------------

/** Write `runs/<id>.spawn.json` proposing `spawn`. */
export function proposeSpawns(world: World, id: string, spawn: unknown[]): void {
  writeFileSync(join(world.pool, "runs", `${id}.spawn.json`), JSON.stringify({ spawn }));
}

/** What a Ticket's first Attempt was given, from its `spawned` event. */
export interface Spawned {
  pane_id: string;
  cwd: string;
  branch: string;
}

export function untilSpawned(world: World, id: string, ms = 30_000): Promise<Spawned> {
  return until(
    () => readEvents(world.pool, id).find((e) => e.kind === "spawned")?.payload as Spawned | undefined,
    (payload) => payload !== undefined,
    { ms, what: `${id}'s spawned event` },
  ) as Promise<Spawned>;
}

/** Wait for a Ticket's or Conversation's log to hold an event `match` holds of; hand it back. */
export function untilEvent(
  world: World,
  id: string,
  match: (event: TicketEvent) => boolean,
  what: string,
  ms = 30_000,
): Promise<TicketEvent> {
  return until(
    () => readEvents(world.pool, id).find(match),
    (found) => found !== undefined,
    { ms, what },
  ) as Promise<TicketEvent>;
}

/** The `notice` events in a log. */
export function noticesIn(world: World, id: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((e) => e.kind === "notice");
}

/** A checkpoint Outcome carrying `brief`. */
export function checkpointOutcome(brief: string): Record<string, unknown> {
  return { status: "checkpoint", summary: "paused", commitSha: null, brief };
}

// ---------------------------------------------------------------------------
// The Notice texts, as the Bun server writes them (engine/notices.ts).
// ---------------------------------------------------------------------------

/** A spawned Ticket that ended done or at a checkpoint. */
export function ticketEndedText(parts: {
  id: string;
  title: string;
  outcome: "done" | "checkpoint";
  brief?: string;
  branch: string;
  diff: string;
}): string {
  const lines = [`Ticket ${parts.id} ("${parts.title}") ended: ${parts.outcome}.`];
  if (parts.outcome === "checkpoint") lines.push(`Brief: ${parts.brief}`);
  lines.push(`Branch: ${parts.branch}`);
  lines.push(`Diff:\n${parts.diff}`);
  return lines.join("\n");
}

/** A spawned Ticket closed at an Interrupt; `note` already trimmed, or absent. */
export function ticketClosedText(id: string, title: string, note?: string): string {
  const head = `Ticket ${id} ("${title}") was closed: its work was not merged.`;
  return note ? `${head}\nClose note: ${note}` : head;
}

/** A spawned Conversation the operator ended; `closing` already trimmed, or absent. */
export function conversationEndedText(branch: string, closing?: string): string {
  const lines = ["A Conversation you spawned was ended by the operator.", `Branch: ${branch}`];
  if (closing) lines.push(`Closing note: ${closing}`);
  return lines.join("\n");
}
