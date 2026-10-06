/**
 * What the terminal-backed `attempts` cases share (ADR-0036, inventory
 * ticket C12): the pools they boot, the frames the fake herdr paints, the
 * text the server types into a pane, and the reads a case makes of the herdr
 * calls, the stub launches and the Ticket log to see a launch go right or
 * wrong. Everything here goes through the fake herdr's record or the pool's
 * files, never the engine.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, TicketEvent } from "../../protocol/wire.ts";
import type { CaseServer } from "../harness/case.ts";
import type { HerdrCall, HerdrProcess } from "../harness/herdr.ts";
import { TUI_FRAMES } from "../harness/herdr-tui.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import { ticketPrompt, typedPrompt } from "../harness/prompts.ts";
import type { TicketSeed, World } from "../harness/world.ts";

/** The harnesses a pool's Assignment can name, each with a TUI the server drives. */
export type Harness = "claude" | "opencode" | "cursor";

export const HARNESSES: readonly Harness[] = ["claude", "opencode", "cursor"];

/** The harnesses whose TUI has clear keys, so a lost paste is retried and then falls back to a file reference. */
export const RETRYING: readonly Harness[] = ["opencode", "cursor"];

/** The binary each harness runs as, the name its stub has on the world's PATH. */
export const BINARY = { claude: "claude", opencode: "opencode", cursor: "agent" } as const;

/** A frame each harness's readiness pattern matches. */
export const READY: Record<Harness, string> = {
  claude: TUI_FRAMES.claude,
  opencode: TUI_FRAMES.opencode,
  cursor: TUI_FRAMES.agent,
};

/** The keys each retrying harness clears its input with. */
export const CLEAR_KEYS: Record<Harness, string[]> = { claude: [], opencode: ["ctrl+c"], cursor: ["ctrl+c"] };

/** The argv a harness's pane runs, the TUI's, on `model` with no effort: what the spawned event records. */
export function interactiveArgv(harness: Harness, model = "m"): string[] {
  switch (harness) {
    case "claude":
      return ["claude", "--model", model, "--permission-mode", "auto"];
    case "opencode":
      return ["opencode", "--model", model, "--auto"];
    case "cursor":
      return ["agent", "--model", model, "--force", "--trust"];
  }
}

/** A terminal-backed pool's console.json: every Ticket on `harness`, model m, in herdr panes. */
export function terminalConfig(harness: Harness = "claude", extra: PoolConfig = {}): PoolConfig {
  return { defaults: { harness, model: "m" }, terminal: "herdr", ...extra };
}

/** A Ticket seed `<id>-t.md` titled `title`. */
export function ticket(id: string, title: string, blockedBy = "none"): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
    body: `# ${title}\n\nticket body`,
  };
}

/** Ticket `id`'s file, as the server names it to the agent. */
export function issuePath(world: World, id: string): string {
  return join(world.pool, "issues", `${id}-t.md`);
}

/** A file in the pool's runs directory. */
export function runsFile(world: World, name: string): string {
  return join(world.pool, "runs", name);
}

/**
 * The prompt the server types into Ticket `id`'s pane, byte for byte
 * (Decided 4): the driver line, the body, and the Ticket file alone on the
 * last line. The pools here have no AGENT.md and no blockers' Outcomes.
 */
export function promptFor(world: World, id: string, driver = "implement"): string {
  const body = ticketPrompt({ agentMd: null, runs: join(world.pool, "runs"), outcome: id });
  return typedPrompt(driver, issuePath(world, id), body);
}

/** The prompt file a lost paste falls back to, beside the Outcome. */
export function promptFile(world: World, id: string): string {
  return runsFile(world, `${id}.outcome.prompt.txt`);
}

/** What the prompt file holds: the Ticket file, a blank line, the prompt body. */
export function promptFileText(world: World, id: string): string {
  return `${issuePath(world, id)}\n\n${ticketPrompt({ agentMd: null, runs: join(world.pool, "runs"), outcome: id })}`;
}

/** One POSIX single-quoted word, as the wrapper quotes every argument. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell darwin's harness runs behind inside script's PTY (issue #136):
 * it copies the pane's size onto the PTY and execs the harness. Byte for
 * byte the word the wrapper hands BSD script.
 */
export const RESIZE_RELAY =
  'o=$1; shift; p=$$; if [ -c "$o" ]; then ' +
  "while kill -0 $p 2>/dev/null; do " +
  's=$(stty size <"$o" 2>/dev/null); ' +
  'case $s in ""|"0 "*|*" 0") ;; ' +
  '*) [ "$s" = "$(stty size </dev/tty 2>/dev/null)" ] || ' +
  'stty rows "${s% *}" columns "${s#* }" </dev/tty 2>/dev/null ;; esac; ' +
  "sleep 0.5; done </dev/null >/dev/null 2>&1 & fi; " +
  'exec "$@"';

/**
 * The wrapper the server types into Ticket `id`'s pane for `argv` (ADR-0016,
 * issue #58): the harness under the host's `script`, recording into the
 * Stream file, then its exit code echoed into the exit-code file, with no
 * `exit` after it.
 */
export function wrapperFor(world: World, id: string, argv: string[]): string {
  const stream = shellQuote(runsFile(world, `${id}.stream.jsonl`));
  const command = argv.map(shellQuote).join(" ");
  const record =
    process.platform === "darwin"
      ? `script -eqF ${stream} sh -c ${shellQuote(RESIZE_RELAY)} sh "$(tty)" ${command}`
      : `script -eqfc ${shellQuote(command)} ${stream}`;
  return `${record}; echo $? > ${shellQuote(runsFile(world, `${id}.exitcode`))}`;
}

/** Every `pane.send_input` the server has sent so far. */
export function sends(herdr: HerdrProcess): HerdrCall[] {
  return herdr.calls.filter((call) => call.method === "pane.send_input");
}

/** The keys of every key send after the wrapper's own Enter, in order. */
export function keySends(herdr: HerdrProcess): string[][] {
  return sends(herdr)
    .slice(1)
    .map((call) => (Array.isArray(call.params.keys) ? (call.params.keys as string[]) : []))
    .filter((keys) => keys.length > 0);
}

/** Wait until `runs/<id>.events.jsonl` holds an event of `kind`; the first one. */
export async function untilEvent(world: World, id: string, kind: string, ms = 30_000): Promise<TicketEvent> {
  const events = await until(
    () => readEvents(world.pool, id),
    (got) => got.some((event) => event.kind === kind),
    { ms, what: `a ${kind} event in runs/${id}.events.jsonl` },
  );
  return events.find((event) => event.kind === kind)!;
}

/** Ticket `id`'s events of `kind`, in order. */
export function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

/** The last lines of a log, as the exit facts carry them: at most 20, a final newline ending the last. */
export function logTailOf(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-20);
}

/** The heading the server writes above a pane's last frame in an otherwise empty derived log. */
export const PANE_FRAME_HEADING = "[engine] the pane showed:";

/** The derived log a launch that died on what its pane showed leaves: the heading, then the frame's lines, blank ends trimmed. */
export function paneFrameLog(frame: string): string {
  const lines = frame.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  return `${PANE_FRAME_HEADING}\n${lines.slice(-19).join("\n")}\n`;
}

/**
 * claude's workspace trust dialog as claude 2.1.276 paints it on a fresh
 * directory (issue #127), its highlight on one of the two buttons.
 */
export function trustDialog(highlighted: "No, exit" | "Yes, I trust this folder"): string {
  return [
    "Accessing workspace:",
    "/tmp/pool-worktrees/abcd1234/01",
    "Quick safety check: Is this a project you created or one you trust? (Like your own code,",
    "a well-known open source project, or work from your team). If not, take a moment to",
    "review what's in this folder first.",
    "Claude Code'll be able to read, edit, and execute files here.",
    "Security guide",
    `${highlighted === "No, exit" ? "❯" : " "} No, exit`,
    `${highlighted === "Yes, I trust this folder" ? "❯" : " "} Yes, I trust this folder`,
    "Enter to confirm · Esc to cancel",
    "",
  ].join("\n");
}

/** claude's bypass-permissions warning, which only the operator may answer. */
export const BYPASS_WARNING = [
  "WARNING: Claude Code running in Bypass Permissions mode",
  "In Bypass Permissions mode, Claude Code will not ask for your approval before running",
  "potentially dangerous commands.",
  "❯ No, exit",
  "  Yes, I accept",
  "",
].join("\n");

/** claude's managed-settings dialog, which only the operator may answer. */
export const MANAGED_SETTINGS = [
  "Managed settings require approval",
  "Your organization's managed settings would change how Claude Code runs here.",
  "❯ No, exit",
  "  Yes, I trust these settings",
  "",
].join("\n");

/** claude up and waiting, as 2.1.276 paints it. */
export const CLAUDE_READY = "Claude Code v2.1.276\n❯ ";

/** The pool log as the server holds it now. */
export async function poolLogLines(server: CaseServer): Promise<string[]> {
  const answer = await server.http.get("/api/pool-log?before=1000000000&limit=2000");
  return answer.json<{ lines: string[] }>().lines;
}

/** The Interrupts the snapshot carries now. */
export async function interruptsOf(server: CaseServer): Promise<{ ticketId: string; kind: string; body: string }[]> {
  const state = await server.http.get("/api/state");
  const answer = state.json<{ snapshot: { state: { interrupts: { ticketId: string; kind: string; body: string }[] } } | null }>();
  return answer.snapshot?.state.interrupts ?? [];
}
