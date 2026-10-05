/**
 * The Steward's world (ADR-0030), built from outside a server process the
 * way conformance builds every world (ADR-0036): a terminal-backed git pool
 * on the executing fake herdr, whose Tickets run a stand-in TUI as `claude`,
 * and an idle opencode pane the operator opened in a worktree of their own,
 * ready to be Enlisted as the Steward.
 *
 * The stand-in TUI records its launch and stays alive until the world is
 * deleted, the way a real TUI holds its pane. It cannot read what the server
 * types into its pane (the fake runs only the first Enter as bash), so the
 * case plays the agent: `driveOutcomes` watches the calls on the herdr
 * socket, and once a prompt naming an Outcome file has been typed and
 * submitted, writes the next Outcome scripted for that Ticket, as the agent
 * in the pane would.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EnrichedSnapshot as PoolSnapshot, Interrupt, PoolConfig } from "../../../protocol/wire.ts";
import type { Case, CaseServer } from "../../harness/case.ts";
import { CHECKOUT, serverChoice } from "../../harness/server.ts";
import type { HerdrCall, HerdrProcess } from "../../harness/herdr.ts";
import { until } from "../../harness/pool-files.ts";
import type { TicketSeed, World, WorldSpec } from "../../harness/world.ts";

/** What a fresh claude TUI shows once it is up: its ready header and prompt glyph. */
export const CLAUDE_READY = "Claude Code v\n❯ ";
/** What an idle opencode pane shows: its idle footer, so a Steward there reads as waiting. */
export const OPENCODE_IDLE = "opencode\nctrl+p commands";
/** What a pane mid-Turn shows: neither harness's idle pattern. */
export const BUSY = "working...";
export const STEWARD_PANE = "pane-steward";

export const READY_01 = "<!-- state: id=01 blocked-by=none status=ready -->";
export const DONE_01 = "<!-- state: id=01 blocked-by=none status=done -->";

export const TERMINAL_CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" }, terminal: "herdr" };

/** An Outcome a scripted agent writes. */
export type ScriptedOutcome = Record<string, unknown>;

export const checkpoint = (brief: string): ScriptedOutcome => ({
  status: "checkpoint",
  summary: "paused",
  commitSha: null,
  brief,
});
export const done = (summary = "ok"): ScriptedOutcome => ({ status: "done", summary, commitSha: null });

/** The stand-in TUI: records argv and cwd under `$CONFORMANCE_STUBS/tui/<n>`, then
 *  holds the pane until the world's stubs directory is gone (or ten minutes). */
const TUI = `#!/usr/bin/env bash
dir="$CONFORMANCE_STUBS/tui"
mkdir -p "$dir"
n=$(ls "$dir" | wc -l | tr -d ' ')
n=$((n + 1))
mkdir -p "$dir/$n"
printf '%s\\0' "$(basename "$0")" "$@" > "$dir/$n/argv"
printf '%s' "$PWD" > "$dir/$n/cwd"
for _ in $(seq 1 3000); do
  [ -d "$CONFORMANCE_STUBS" ] || exit 0
  sleep 0.2
done
`;

/** One launch of the stand-in TUI. */
export interface TuiLaunch {
  argv: string[];
  cwd: string;
}

/** Every launch of the stand-in TUI so far, in order. */
export function tuiLaunches(world: World): TuiLaunch[] {
  const dir = join(world.stubs.dir, "tui");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(Number)
    .sort((a, b) => a - b)
    .filter((n) => existsSync(join(dir, String(n), "cwd")))
    .map((n) => ({
      argv: readFileSync(join(dir, String(n), "argv"), "utf8").split("\0").slice(0, -1),
      cwd: readFileSync(join(dir, String(n), "cwd"), "utf8"),
    }));
}

export interface StewardWorldSpec extends Omit<WorldSpec, "config"> {
  /** Merged over TERMINAL_CONFIG. */
  config?: Partial<PoolConfig>;
  /** Default: 01 ready, titled "Talk it through". */
  tickets?: TicketSeed[];
  /** Run against the repository before the server starts. */
  beforeBoot?: (world: World) => void;
}

export interface StewardWorld {
  world: World;
  herdr: HerdrProcess;
  /** The Steward pane's own worktree. */
  stewardDir: string;
  /** Start (or restart) the server on this world. */
  start(): Promise<CaseServer>;
}

/**
 * A terminal-backed git pool with the stand-in TUI as `claude`, its fake
 * herdr up, and an idle opencode pane in a worktree of its own seeded as
 * STEWARD_PANE. The server is not started: `start()` does that.
 */
export async function stewardWorld(t: Case, spec: StewardWorldSpec = {}): Promise<StewardWorld> {
  const world = t.world({
    ...spec,
    tickets: spec.tickets ?? [{ file: "01.md", marker: READY_01, body: "# Talk it through\n\nbody" }],
    config: { ...TERMINAL_CONFIG, ...spec.config } as PoolConfig,
  });
  const claude = join(world.stubs.bin, "claude");
  writeFileSync(claude, TUI);
  chmodSync(claude, 0o755);
  spec.beforeBoot?.(world);
  const stewardDir = join(world.root, "steward-desk");
  world.git(["worktree", "add", "-q", "-b", "steward-desk", stewardDir]);
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await herdr.control("seedAgent", {
    paneId: STEWARD_PANE,
    agent: "opencode",
    cwd: stewardDir,
    title: "Desk",
    status: "idle",
    rendered: OPENCODE_IDLE,
    tabId: "tab-steward",
  });
  return { world, herdr, stewardDir, start: () => t.start(world, { herdr }) };
}

/**
 * Play the agent in every Ticket pane: each time a prompt naming
 * `<pool>/runs/<key>.outcome.json` is typed into a pane and that pane is
 * then sent Enter, write the next Outcome scripted for the Ticket (the key
 * up to its first dot, so a verify Attempt's `01.attempt-2` is 01's). A
 * Ticket with no Outcome left gets none, and its Attempt stays at work.
 * Returns a stop function; the case's teardown stops the herdr anyway.
 */
export function driveOutcomes(herdr: HerdrProcess, scripts: Record<string, ScriptedOutcome[]>): () => void {
  const used: Record<string, number> = {};
  let seen = 0;
  const typed = new Map<string, string>();
  const step = (call: HerdrCall): void => {
    if (call.method !== "pane.send_input") return;
    const pane = String(call.params.pane_id);
    const text = typeof call.params.text === "string" ? call.params.text : "";
    const match = /outcome as JSON at (\S+?\.outcome\.json):/.exec(text);
    if (match) typed.set(pane, match[1]!);
    const keys = Array.isArray(call.params.keys) ? (call.params.keys as string[]) : [];
    const path = typed.get(pane);
    if (!keys.includes("enter") || path === undefined) return;
    typed.delete(pane);
    const ticket = basename(path, ".outcome.json").split(".")[0]!;
    const n = used[ticket] ?? 0;
    const outcome = scripts[ticket]?.[n];
    if (!outcome) return;
    used[ticket] = n + 1;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(outcome));
  };
  const timer = setInterval(() => {
    while (seen < herdr.calls.length) step(herdr.calls[seen++]!);
  }, 20);
  return () => clearInterval(timer);
}

/** The snapshot `/api/state` serves now. */
export async function snapshot(server: CaseServer): Promise<PoolSnapshot> {
  const answer = await server.http.get("/api/state");
  return answer.json<{ snapshot: PoolSnapshot }>().snapshot;
}

/** Wait until the served snapshot satisfies `done`, and hand it back. */
export function untilSnapshot(
  server: CaseServer,
  done: (snap: PoolSnapshot) => boolean,
  what: string,
  ms = 30_000,
): Promise<PoolSnapshot> {
  return until(() => snapshot(server), (snap) => snap !== null && done(snap), { what, ms });
}

/** The pending Interrupts on the snapshot. */
export function interrupts(snap: PoolSnapshot): Interrupt[] {
  return snap.state.interrupts;
}

/** Wait for an Interrupt of `kind` on `ticketId`. */
export function untilInterrupt(server: CaseServer, ticketId: string, kind: string, ms = 30_000): Promise<PoolSnapshot> {
  return untilSnapshot(
    server,
    (snap) => snap.state.interrupts.some((i) => i.ticketId === ticketId && i.kind === kind),
    `a ${kind} Interrupt on ${ticketId}`,
    ms,
  );
}

/** Everything submitted with Enter into one pane, in order: each Turn whole. */
export function turnsInto(herdr: HerdrProcess, paneId: string): string[] {
  const turns: string[] = [];
  let input = "";
  for (const call of herdr.calls) {
    if (call.method !== "pane.send_input" || call.params.pane_id !== paneId) continue;
    if (typeof call.params.text === "string") input += call.params.text;
    const keys = Array.isArray(call.params.keys) ? (call.params.keys as string[]) : [];
    if (keys.includes("enter")) {
      turns.push(input);
      input = "";
    } else if (keys.length > 0) {
      input = "";
    }
  }
  return turns;
}

/** The Turns typed into the Steward's pane that are Steward Notices. */
export function stewardNotices(herdr: HerdrProcess, paneId = STEWARD_PANE): string[] {
  return turnsInto(herdr, paneId).filter((turn) => turn.startsWith("Pool news for the Steward"));
}

/** Enlist STEWARD_PANE as the Steward; hand back its Conversation id. */
export async function enlistSteward(server: CaseServer, opening?: string, paneId = STEWARD_PANE): Promise<string> {
  const answer = await server.http.post("/api/enlist", {
    becomes: "steward",
    paneId,
    ...(opening ? { opening } : {}),
  });
  if (answer.status !== 201) throw new Error(`enlist as steward answered ${answer.status}: ${answer.text}`);
  return answer.json<{ conversationId: string }>().conversationId;
}

/** Wait until at least `count` Steward Notices have been typed. */
export async function untilNotices(herdr: HerdrProcess, count: number, ms = 30_000): Promise<string[]> {
  return until(() => stewardNotices(herdr), (turns) => turns.length >= count, {
    what: `${count} Steward Notice(s)`,
    ms,
  });
}

/**
 * The Steward's command as its teaching names it, up to `--pool`: the Bun
 * server's is this Bun running engine/steward-cli.ts from this checkout.
 * The Rust server's is its own binary's `steward` subcommand (ADR-0036's
 * one binary), an inference until that port lands.
 */
export function stewardCommandPrefix(): string {
  const choice = serverChoice();
  if (choice.kind === "rust") return `${choice.rustBin} steward`;
  return `${process.execPath} ${join(CHECKOUT, "engine", "steward-cli.ts")}`;
}
