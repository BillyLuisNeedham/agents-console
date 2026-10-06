/**
 * Terminal-backed Attempts run to an ending from outside the server
 * (ADR-0036). The server launches an interactive harness in a fake herdr
 * pane, waits for its ready frame, types the prompt and presses Enter; it
 * never passes the prompt in argv, so the stub harness cannot learn its
 * outcome path from its arguments the way a headless launch does.
 *
 * So a case does two things here. It puts a TUI stand-in on the world's
 * PATH in place of the stub (`tuiStandIn`): a process that records its
 * launch and stays up the way a real TUI does, until the case lets it go or
 * the world is deleted. And it plays the agent (`answerPrompt`): it watches
 * the herdr socket for the typed prompt and its Enter, the way the agent
 * reads its input, and writes the outcome file the prompt names. The fake
 * herdr renders the harness's ready frame (`TUI_FRAMES`), and the paste
 * echo passes on the issue path the prompt carries.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../protocol/wire.ts";
import type { HerdrCall, HerdrProcess } from "./herdr.ts";
import { readEvents, readMarkers, until } from "./pool-files.ts";
import type { TicketSeed, World } from "./world.ts";

/** A frame each stock harness's readiness pattern matches, for the fake's `rendered`. */
export const TUI_FRAMES = {
  claude: "Claude Code v1\n❯ ",
  opencode: "Ask anything\nctrl+p commands",
  agent: "Cursor Agent\n→ Plan, search, build anything",
} as const;

/** One launch of a TUI stand-in. */
export interface TuiLaunch {
  harness: string;
  argv: string[];
  cwd: string;
}

export interface TuiStandIn {
  /** Every launch so far, in order. */
  launches(): TuiLaunch[];
  /** Let launch `n` (from 1) exit with `code`, the TUI quitting. */
  release(n: number, code?: number): void;
}

const STUB = join(import.meta.dir, "..", "fixtures", "stub-harness.sh");

/** The argv that marks a headless launch, which the stub still serves. */
const HEADLESS_FLAG = { claude: "-p", opencode: "run", agent: "-p" } as const;

/**
 * Replace the stub `harness` binary (claude, opencode or agent) on the
 * world's PATH with a TUI stand-in. Each interactive launch records its argv
 * and cwd under `<root>/tui/<harness>.<n>/` and stays up until released, the
 * world is deleted, or two minutes pass, so nothing it starts outlives its
 * case. A headless launch (a fallback when herdr refuses) still goes to the
 * stub, which finds its outcome path in its argv.
 */
export function tuiStandIn(world: World, harness: "claude" | "opencode" | "agent" = "claude"): TuiStandIn {
  const dir = join(world.root, "tui");
  mkdirSync(dir, { recursive: true });
  const script = `#!/usr/bin/env bash
if [ "\${1:-}" = ${JSON.stringify(HEADLESS_FLAG[harness])} ]; then exec bash ${JSON.stringify(STUB)} ${harness} "$@"; fi
dir=${JSON.stringify(dir)}
for _ in $(seq 1 500); do mkdir "$dir/.lock-${harness}" 2>/dev/null && break; sleep 0.01; done
n=$(( $(cat "$dir/${harness}.count" 2>/dev/null || echo 0) + 1 ))
printf '%s\\n' "$n" > "$dir/${harness}.count"
rmdir "$dir/.lock-${harness}" 2>/dev/null
call="$dir/${harness}.$n"
mkdir -p "$call"
printf '%s\\0' ${JSON.stringify(harness)} "$@" > "$call/argv"
printf '%s' "$PWD" > "$call/cwd"
end=$(( SECONDS + 120 ))
while [ -d "$dir" ] && [ ! -e "$call/release" ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
exit "$(cat "$call/release" 2>/dev/null || echo 0)"
`;
  const bin = join(world.stubs.bin, harness);
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    launches() {
      const prefix = `${harness}.`;
      return readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
        .filter((name) => existsSync(join(dir, name, "cwd")))
        .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
        .map((name) => {
          const [first = "", ...argv] = readFileSync(join(dir, name, "argv"), "utf8").split("\0").slice(0, -1);
          return { harness: first, argv, cwd: readFileSync(join(dir, name, "cwd"), "utf8") };
        });
    },
    release(n, code = 0) {
      writeFileSync(join(dir, `${harness}.${n}`, "release"), `${code}\n`);
    },
  };
}

/** The outcome path a typed prompt names, or null when it names none. */
export function promptOutcomePath(text: string): string | null {
  const match = /outcome as JSON at ([^\s:]+\.outcome\.json):/.exec(text);
  return match ? match[1]! : null;
}

export interface TypedPrompt {
  /** The pane the prompt was typed into. */
  paneId: string;
  /** The prompt as typed. */
  prompt: string;
  /** The outcome file it names. */
  outcomePath: string;
  /** Where its Enter sits in the fake's calls, for a later wait to start after. */
  at: number;
}

/**
 * Wait for the prompt of the Attempt whose outcome file is
 * `<key>.outcome.json` (`01`, `01.attempt-2`, `01-grader-1`) to be typed
 * into a pane and submitted with Enter, at or after call `from`.
 */
export async function awaitPrompt(
  herdr: HerdrProcess,
  key: string,
  options: { ms?: number; from?: number } = {},
): Promise<TypedPrompt> {
  const ms = options.ms ?? 20_000;
  const typed = await herdr.waitForCall(
    (call) => call.method === "pane.send_input" && typedOutcome(call)?.endsWith(`/${key}.outcome.json`) === true,
    { ms, from: options.from ?? 0 },
  );
  const paneId = String(typed.params.pane_id);
  const enter = await herdr.waitForCall(
    (call) =>
      call.method === "pane.send_input" &&
      call.params.pane_id === paneId &&
      Array.isArray(call.params.keys) &&
      call.params.keys.includes("enter"),
    { ms, from: herdr.calls.indexOf(typed) + 1 },
  );
  const prompt = String(typed.params.text);
  return { paneId, prompt, outcomePath: promptOutcomePath(prompt)!, at: herdr.calls.indexOf(enter) };
}

/**
 * Play the agent for the Attempt whose outcome file is `<key>.outcome.json`:
 * wait for its prompt (`awaitPrompt`), run `before` (the agent's work, or
 * something the case does to the world first), then write `outcome` (an
 * object, written as JSON, or the exact text) to the file it names.
 */
export async function answerPrompt(
  herdr: HerdrProcess,
  key: string,
  outcome: unknown,
  options: { ms?: number; from?: number; before?: (typed: TypedPrompt) => unknown } = {},
): Promise<TypedPrompt> {
  const typed = await awaitPrompt(herdr, key, options);
  await options.before?.(typed);
  writeFileSync(typed.outcomePath, typeof outcome === "string" ? outcome : JSON.stringify(outcome));
  return typed;
}

function typedOutcome(call: HerdrCall): string | null {
  return typeof call.params.text === "string" ? promptOutcomePath(call.params.text) : null;
}

/** A done outcome, the shape the prompt asks for. */
export function doneOutcome(summary = "done from the pane"): Record<string, unknown> {
  return { status: "done", summary, commitSha: null };
}

/** The whole pool log as the server holds it now (GET /api/pool-log). */
export async function poolLog(server: { http: { get(path: string): Promise<{ json<T>(): T }> } }): Promise<string[]> {
  const answer = await server.http.get("/api/pool-log?before=1000000000&limit=2000");
  return answer.json<{ lines: string[] }>().lines;
}

/** A terminal-backed pool's console.json: claude by default, in herdr panes. */
export const TERMINAL_CONFIG: PoolConfig = { defaults: { harness: "claude", model: "m" }, terminal: "herdr" };

/** A ready Ticket `<id>-t.md` whose title heading is `title`. */
export function readyTicket(id: string, title: string, blockedBy = "none"): TicketSeed {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
    body: `# ${title}\n\nticket body`,
  };
}

/** The pool's `runs/pool-workspace.json`, parsed. */
export function rememberedWorkspace(world: World): unknown {
  return JSON.parse(readFileSync(join(world.pool, "runs", "pool-workspace.json"), "utf8"));
}

/** The payloads of every `spawned` event in `runs/<id>.events.jsonl`, by attempt order. */
export function spawnedPayloads(world: World, id: string): Record<string, unknown>[] {
  return readEvents(world.pool, id)
    .filter((event) => event.kind === "spawned")
    .map((event) => event.payload);
}

/** Wait for a Ticket's state line to read `status`. */
export async function untilTicketStatus(world: World, id: string, status: string, ms = 20_000): Promise<void> {
  await until(
    () => readMarkers(world.pool)[id]?.status,
    (got) => got === status,
    { ms, what: `${id}'s state line to read status=${status}` },
  );
}
