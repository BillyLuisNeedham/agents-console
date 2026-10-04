/**
 * What the Attempt endings and logs cases (the inventory's ticket C13, area
 * `attempts`) share: Ticket seeds, stub launches held until the case lets
 * them go, the waits on an Attempt's events, the crash Interrupt body and
 * pool log line an ending writes, and the claude stream-json lines a
 * headless stub prints.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, TicketEvent } from "../../engine/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { HerdrCall, HerdrProcess } from "../harness/herdr.ts";
import { awaitPrompt, type TypedPrompt } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** A ready Ticket `<id>-t.md` titled `T<id>`. */
export function ready(id: string, blockedBy = "none"): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
    body: `# T${id}\n\nWork.`,
  };
}

/** A headless pool on the claude stub. */
export const HEADLESS = { defaults: { harness: "claude", model: "m" } };

/** A terminal-backed pool on the claude stub. */
export const TERMINAL = { defaults: { harness: "claude", model: "m" }, terminal: "herdr" as const };

/** What claude's TUI shows once it is up, for the fake herdr's `rendered`. */
export const CLAUDE_READY = "Claude Code v2.1.0\n❯ ";

/** A file in the world a case creates to let a held launch go on. */
export interface Release {
  path: string;
  release(): void;
}

/** The release file `name` at the world's root, not there until released. */
export function releaseFile(world: World, name: string): Release {
  const path = join(world.root, name);
  return { path, release: () => writeFileSync(path, "") };
}

/**
 * A stub `run` step that holds the launch until `release` exists, or until
 * the case ends when there is none: it ends at once when the world is
 * deleted, so nothing a case holds outlives it, and after five minutes in
 * a world CONFORMANCE_KEEP keeps.
 */
export function heldUntil(release?: Release): string {
  const unreleased = release ? `[ ! -e ${JSON.stringify(release.path)} ] && ` : "";
  return `end=$(( SECONDS + 300 )); while ${unreleased}[ -d "$CONFORMANCE_STUBS" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done`;
}

/** A pool file under `runs/`. */
export function runsPath(world: World, file: string): string {
  return join(world.pool, "runs", file);
}

export function readRuns(world: World, file: string): string {
  return readFileSync(runsPath(world, file), "utf8");
}

export function runsExists(world: World, file: string): boolean {
  return existsSync(runsPath(world, file));
}

export function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** Wait for a Ticket's events to hold `count` events of `kind`. */
export function waitForEvent(world: World, id: string, kind: string, ms = 30_000, count = 1): Promise<TicketEvent[]> {
  return until(
    () => eventsOf(world, id, kind),
    (found) => found.length >= count,
    { ms, what: `${id}'s ${kind} event` },
  );
}

/** Wait for a Ticket's attempt to have ended: its exited event. */
export async function waitForExit(world: World, id: string, ms = 30_000): Promise<TicketEvent> {
  return (await waitForEvent(world, id, "exited", ms))[0]!;
}

/** The snapshot GET /api/state serves now. */
export async function snapshot(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  const snap = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (!snap) throw new Error("the server has no snapshot yet");
  return snap;
}

/** The whole pool log, through GET /api/pool-log. */
export async function poolLog(server: CaseServer): Promise<string[]> {
  const answer = await server.http.get("/api/pool-log?before=1000000000&limit=100000");
  return answer.json<{ lines: string[] }>().lines;
}

/** Wait for a crash Interrupt on `id` and hand back its body. */
export async function crashBody(server: CaseServer, id: string, ms = 30_000): Promise<string> {
  const snap = await until(
    () => snapshot(server),
    (s) => s.state.interrupts.some((i) => i.ticketId === id && i.kind === "crash"),
    { ms, what: `the crash Interrupt on ${id}` },
  );
  return snap.state.interrupts.find((i) => i.ticketId === id && i.kind === "crash")!.body;
}

/**
 * The crash Interrupt body the server writes for an Attempt: the reason, the
 * log's path, the log tail when there is one, and whether the Outcome file
 * is there.
 */
export function expectedCrashBody(world: World, id: string, reason: string, tail: string[], outcomeExists: boolean): string {
  const runs = join(world.pool, "runs");
  const lines = tail.length > 0 ? `${tail.join("\n")}\n\n` : "";
  return (
    `crash: ${reason}\n${runs}/${id}.log\n\n${lines}` +
    `outcome file: ${runs}/${id}.outcome.json (${outcomeExists ? "exists" : "missing"})\n`
  );
}

/** One claude stream-json line: an assistant message with these content blocks. */
export function assistant(...content: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { content } });
}

/** An assistant text block. */
export function text(value: string): Record<string, unknown> {
  return { type: "text", text: value };
}

/** An assistant tool_use block. */
export function toolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "tool_use", name, input };
}

/**
 * The three-line sample a streamed launch prints: one assistant text, one
 * Bash tool call and one raw line, with the log lines each derives to.
 */
export const SAMPLE = {
  raw: [assistant(text("stub text")), assistant(toolUse("Bash", { command: "ls -la" })), "stub raw line"],
  derived: ["stub text", "[tool] Bash: ls -la", "stub raw line"],
};

/**
 * A terminal-backed Attempt's log lines less what util-linux's script(1)
 * writes into the typescript itself: a "Script started on" line before the
 * first output and, once the harness exits, a newline and a "Script done on"
 * line. They carry the time, and BSD's script, the Mac's, writes neither
 * under -q, so a case reads the transcript without them.
 */
export function transcriptLines(all: string[]): string[] {
  const out = [...all];
  if (out[0]?.startsWith("Script started on ")) out.shift();
  if (out.at(-1)?.startsWith("Script done on ")) {
    out.pop();
    if (out.at(-1) === "") out.pop();
  }
  return out;
}

/** An exited or crash event's payload with its log tail read as a transcript. */
export function transcriptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, logTail: transcriptLines(payload.logTail as string[]) };
}

/** The bytes of lines each ended by a newline. */
export function lines(...all: string[]): string {
  return all.map((line) => `${line}\n`).join("");
}

/** Every call of `method` the server has made so far, from index `from`. */
export function callsOf(herdr: HerdrProcess, method: string, from = 0): HerdrCall[] {
  return herdr.calls.slice(from).filter((call) => call.method === method);
}

/** The server's watch on an Attempt's ending, as the fake herdr saw it begin. */
export interface EndingWatch {
  /** The prompt the server typed and submitted into the Attempt's pane. */
  typed: TypedPrompt;
  /** The events.subscribe the watch holds; null when herdr dropped them all. */
  call: HerdrCall | null;
  /** When the case saw the watch begin: the wait, and its liveness sweep, start then. */
  at: number;
}

/** The events.subscribe calls whose connections the fake still holds open. */
export async function openSubscriptions(herdr: HerdrProcess): Promise<HerdrCall[]> {
  const open = new Set(await herdr.control<number[]>("openConnections"));
  return callsOf(herdr, "events.subscribe").filter((call) => open.has(call.connection));
}

/**
 * Wait until the server watches the Attempt of `key` (`01`) for its ending:
 * its prompt has been typed and submitted, and an events.subscribe the
 * server made is held open. The Bun server subscribes once more for the
 * launch's readiness wait and lets that one go before the prompt is typed,
 * so the open one is the ending's. With `dropped`, herdr drops every
 * subscription, so none stays open: the watch is the subscription made
 * after the prompt's Enter, or the Enter itself when none follows.
 */
export async function awaitEndingWatch(
  herdr: HerdrProcess,
  key: string,
  options: { dropped?: boolean; ms?: number } = {},
): Promise<EndingWatch> {
  const ms = options.ms ?? 30_000;
  const typed = await awaitPrompt(herdr, key, { ms });
  if (options.dropped) {
    const call = await herdr
      .waitForCall((c) => c.method === "events.subscribe", { from: typed.at + 1, ms: 5_000 })
      .catch(() => null);
    return { typed, call, at: Date.now() };
  }
  const call = await until(
    async () => (await openSubscriptions(herdr)).at(-1) ?? null,
    (found) => found !== null,
    { ms, what: `an open events.subscribe watching ${key}'s ending` },
  );
  return { typed, call, at: Date.now() };
}

/**
 * Put a bash prelude in front of a stub binary on the world's PATH, so a
 * launch can do what the scripted stub cannot (commit, resolve a merge)
 * before the stub records it and plays its script. The prelude sees the
 * launch's argv as "$@", `key` set to the Outcome file's stem when the
 * prompt names one, and `rout` set to the result file a resolver's prompt
 * names.
 */
export function prelude(world: World, binary: string, script: string): void {
  const path = join(world.stubs.bin, binary);
  const [shebang, ...rest] = readFileSync(path, "utf8").split("\n");
  const keyed = [
    'out=""; rout=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    *"outcome as JSON at "*) part="${arg#*outcome as JSON at }"; out="${part%%:*}" ;;',
    '    *"Resolve the git merge conflict"*) part="${arg#*write JSON to }"; rout="${part%%:*}" ;;',
    "  esac",
    "done",
    'key=""; [ -n "$out" ] && key="$(basename "$out" .outcome.json)"',
  ];
  writeFileSync(path, [shebang, ...keyed, script, ...rest].join("\n"));
}

/**
 * A headless pool of 01 and 02 that both change shared.txt: 02 commits
 * first, 01 waits for 02's merge and then commits its own line, so 01's
 * merge conflicts and the claude resolver runs on it. `resolver` is the
 * bash the resolver launch runs in 01's worktree after merging the target
 * in, `$rout` naming its result file; it should exit, or the stub runs on.
 */
export function conflictWorld(t: Case, resolver: string): World {
  const world = t.world({
    tickets: [ready("01"), ready("02")],
    config: { ...HEADLESS, resolver: "claude" },
    repoFiles: { "shared.txt": "base\n" },
  });
  prelude(
    world,
    "claude",
    [
      'if [ -n "$rout" ]; then',
      "  git merge main >/dev/null 2>&1",
      `  ${resolver}`,
      "fi",
      'if [ "$key" = "02" ]; then printf \'from-02\\n\' > shared.txt; git add shared.txt; git commit -qm work-02; fi',
      'if [ "$key" = "01" ]; then',
      `  for _ in $(seq 1 400); do git -C ${JSON.stringify(world.repo)} log main --format=%s | grep -qx work-02 && break; sleep 0.05; done`,
      "  printf 'from-01\\n' > shared.txt; git add shared.txt; git commit -qm work-01",
      "fi",
    ].join("\n"),
  );
  return world;
}

/** Bash that prints each line verbatim on stdout. */
export function printLines(all: string[]): string {
  return all.map((line) => `printf '%s\\n' ${shellQuote(line)}`).join("; ");
}

/** A word bash reads back as exactly `value`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What every `events.subscribe` asks herdr for: the three ways a pane ends. */
export const PANE_END_SUBSCRIPTION = {
  subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }, { type: "tab.closed" }],
};
