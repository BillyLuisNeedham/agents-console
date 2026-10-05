/**
 * What the herdr pane cases share (`herdr-panes-*.test.ts`, ticket C15 of
 * the Rust port inventory, docs/research/rust-port/test-inventory.md): a
 * terminal-backed world whose claude is a TUI stand-in that stays up after
 * its Outcome (harness/herdr-tui.ts), the fake herdr drawing claude's ready
 * frame, and the reads a case makes of the snapshot's Held panes and
 * Finished terminals count.
 *
 * Some cases boot a pool over events written by hand, the way a restart
 * finds them, with the panes those events name injected into the fake
 * herdr. Such a pool has nothing of its own to make the pane survey list
 * before its cadence, fifteen seconds out, so it carries a witness: a Ticket
 * at a checkpoint over a listed pane. Holding that pane at boot asks the
 * survey for a listing at once, and the witness's Held pane on the snapshot
 * is the proof the listing has landed.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CloseFinishedTerminalsResponse,
  EnrichedSnapshot,
  EnrichedTicketState,
  TicketEvent,
  TicketEventKind,
} from "../../protocol/wire.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { HerdrOptions, HerdrProcess } from "../harness/herdr.ts";
import { callsOf, TERMINAL_CONFIG, TUI_FRAMES, tuiStandIn, type TuiStandIn } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World, WorldSpec } from "../harness/world.ts";

/** A checkpoint Outcome, the shape the prompt asks for. */
export const CHECKPOINT = { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" };

/** The phases a drive rests in until something answers it. */
const RESTING = new Set(["quiescent", "done", "stalled", "dead"]);

/** A terminal-backed world, claude in herdr panes, with the TUI stand-in for claude. */
export function terminalWorld(t: Case, spec: WorldSpec = {}): { world: World; tui: TuiStandIn } {
  const world = t.world({ config: TERMINAL_CONFIG, ...spec });
  return { world, tui: tuiStandIn(world) };
}

/** The fake herdr for a terminal world, every pane drawing claude's ready frame. */
export function fakeHerdr(t: Case, world: World, options: HerdrOptions = {}): Promise<HerdrProcess> {
  return t.herdr(world, { rendered: TUI_FRAMES.claude, ...options });
}

/** The snapshot GET /api/state serves now; throws while there is none. */
export async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const snapshot = (await server.http.get("/api/state")).json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (!snapshot) throw new Error("no snapshot yet");
  return snapshot;
}

export function ticketIn(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const ticket = snapshot.state.tickets.find((candidate) => candidate.id === id);
  if (!ticket) throw new Error(`the snapshot has no ticket ${id}`);
  return ticket;
}

/** Wait for a snapshot `done` holds of. */
export function untilSnapshot(
  server: CaseServer,
  done: (snapshot: EnrichedSnapshot) => boolean,
  what: string,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  return until(() => snapshotOf(server), done, { ms, what });
}

/**
 * The snapshot each snapshot or delta frame on a socket built, in order,
 * with the index of the frame that built it.
 */
export function builtSnapshots(client: SocketClient): { at: number; snapshot: EnrichedSnapshot }[] {
  const out: { at: number; snapshot: EnrichedSnapshot }[] = [];
  let pushed: Parameters<typeof applySnapshotDelta>[0] | null = null;
  client.frames.forEach((frame, at) => {
    if (frame.type === "snapshot") {
      pushed = frame.snapshot === null ? null : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
    } else if (frame.type === "delta" && pushed !== null) {
      pushed = applySnapshotDelta(pushed, frame.delta);
    } else return;
    if (pushed !== null) out.push({ at, snapshot: pushed.snapshot });
  });
  return out;
}

/** Wait for Ticket `id`'s Held pane on the snapshot. */
export async function untilHeld(server: CaseServer, id: string, ms = 30_000): Promise<{ attempt: number; paneId: string }> {
  const snapshot = await untilSnapshot(server, (snap) => ticketIn(snap, id).heldPane !== null, `${id}'s Held pane`, ms);
  return ticketIn(snapshot, id).heldPane!;
}

/** Wait for an Interrupt of `kind` on Ticket `id`. */
export function untilInterrupt(server: CaseServer, id: string, kind: string, ms = 30_000): Promise<EnrichedSnapshot> {
  return untilSnapshot(
    server,
    (snap) => snap.state.interrupts.some((i) => i.ticketId === id && i.kind === kind),
    `a ${kind} interrupt on ${id}`,
    ms,
  );
}

/** POST /api/terminals/close-finished, its status and body. */
export async function closeFinished(server: CaseServer): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await server.http.post("/api/terminals/close-finished");
  return { status: answer.status, body: answer.json<Record<string, unknown>>() };
}

/** POST /api/terminals/close-finished, which must answer 200; how many it closed. */
export async function closedFinished(server: CaseServer): Promise<number> {
  const answer = await closeFinished(server);
  expect(answer.status).toBe(200);
  return (answer.body as unknown as CloseFinishedTerminalsResponse).closed;
}

/**
 * The tab ids the server has asked herdr to close so far, in order, once
 * every call the fake had received is in hand: a route can answer before
 * the record of a herdr call it made reaches the case.
 */
export async function tabCloses(herdr: HerdrProcess): Promise<string[]> {
  await herdr.settle();
  return callsOf(herdr, "tab.close").map((call) => String(call.params.tab_id));
}

/**
 * Have the server publish a snapshot now: a Settings save that changes
 * nothing reloads the config of a pool at rest, and the reload emits. For
 * what the engine writes into its state without a snapshot of its own.
 */
export async function publish(server: CaseServer): Promise<void> {
  const saved = await server.http.put("/api/settings/pool", { config: {} });
  expect(saved.status).toBe(200);
}

/** POST /api/keep-talking for one Ticket. */
export function keepTalking(server: CaseServer, ticketId: string) {
  return server.http.post("/api/keep-talking", { ticketId });
}

/** The pane and tab a Ticket's attempt was spawned in, off its `spawned` event. */
export function spawnedTerminal(world: World, id: string, attempt = 1): { paneId: string; tabId: string; cwd: string } {
  const spawned = readEvents(world.pool, id).find((event) => event.kind === "spawned" && event.attempt === attempt);
  if (!spawned || typeof spawned.payload.pane_id !== "string") {
    throw new Error(`no spawned event names a pane for ${id} attempt ${attempt}`);
  }
  return {
    paneId: spawned.payload.pane_id,
    tabId: String(spawned.payload.tab_id),
    cwd: String(spawned.payload.cwd),
  };
}

/**
 * Let the TUI stand-in an Attempt of Ticket `id` runs in exit with `code`:
 * the launch whose working directory is the one the attempt's `spawned`
 * event records, the latest such launch when there are several.
 */
export function quitTui(world: World, tui: TuiStandIn, id: string, code = 0, attempt = 1): void {
  const cwd = realpathSync(spawnedTerminal(world, id, attempt).cwd);
  const launches = tui.launches();
  for (let n = launches.length; n >= 1; n--) {
    if (realpathSync(launches[n - 1]!.cwd) === cwd) {
      tui.release(n, code);
      return;
    }
  }
  throw new Error(`no TUI launch ran in ${cwd}`);
}

/** Wait for the exit-code file the wrapper writes once the TUI has exited. */
export async function untilExitCode(world: World, id: string): Promise<void> {
  await until(() => existsSync(join(world.pool, "runs", `${id}.exitcode`)), Boolean, {
    ms: 30_000,
    what: `runs/${id}.exitcode`,
  });
}

// ---------------------------------------------------------------------------
// A pool booted over events written by hand
// ---------------------------------------------------------------------------

/** One event as the server appends it, an hour old. */
export function event(attempt: number, kind: TicketEventKind, payload: Record<string, unknown> = {}): TicketEvent {
  return { at: new Date(Date.now() - 3_600_000).toISOString(), attempt, kind, payload };
}

/** Write `runs/<id>.events.jsonl` whole. */
export function writeEvents(world: World, id: string, events: TicketEvent[]): void {
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  writeFileSync(join(world.pool, "runs", `${id}.events.jsonl`), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

/** A Ticket file `<id>.md` at `status`, with extra marker fields after it. */
export function ticketAt(id: string, status: string, extra = ""): TicketSeed {
  return {
    file: `${id}.md`,
    marker: `<!-- state: id=${id} blocked-by=none status=${status}${extra ? ` ${extra}` : ""} -->`,
    body: `# Ticket ${id}\n\nbody\n\n## Brief\n\nask me`,
  };
}

/** The witness's id: a Ticket at a checkpoint whose pane the fake lists. */
const WITNESS = "09";

/** The witness's Ticket file, for a world's tickets. */
const WITNESS_TICKET: TicketSeed = ticketAt(WITNESS, "checkpoint");

/**
 * Write the witness's events (attempt 1 spawned in pane `p-witness`, tab
 * `t-witness`, and exited at a checkpoint) and list its pane on the fake,
 * as recorded. Call before the server starts.
 */
export async function plantWitness(world: World, herdr: HerdrProcess): Promise<void> {
  writeEvents(world, WITNESS, [
    event(1, "spawned", {
      argv: ["claude"],
      cwd: world.repo,
      branch: null,
      harness: "claude",
      model: "m",
      pane_id: "p-witness",
      tab_id: "t-witness",
    }),
    event(1, "exited", { code: 0, status: "checkpoint" }),
  ]);
  await herdr.control("injectPane", "p-witness", { tabId: "t-witness", cwd: world.repo });
}

/**
 * Wait until the pane survey has listed and the drive rests: the witness's
 * Held pane is on a snapshot taken at rest, so that snapshot was derived
 * from a listing, with the Pool workspace resolved.
 */
export function untilSurveyed(server: CaseServer): Promise<EnrichedSnapshot> {
  return untilSnapshot(
    server,
    (snap) => RESTING.has(snap.phase) && ticketIn(snap, WITNESS).heldPane !== null,
    "the pane survey's first listing, the witness held",
  );
}

/** A terminal world over hand-written state, with no harness launched: claude is the stub, never run. */
export function bootWorld(t: Case, spec: WorldSpec): World {
  return t.world({ config: TERMINAL_CONFIG, ...spec, tickets: [...(spec.tickets ?? []), WITNESS_TICKET] });
}
