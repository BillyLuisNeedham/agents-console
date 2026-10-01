/**
 * The Steward's command (ADR-0030): a thin CLI over the pool server's
 * /api/steward/ routes, which is how a Steward answers on the operator's
 * path from inside its pane. Its teaching names the exact invocation:
 *
 *   bun engine/steward-cli.ts --pool <pool-dir> [--url <console-url>] --as <conversation> <verb> ...
 *
 * Verbs:
 *   answer <ticket> resume|approve|reject [note]
 *   keep-talking <ticket> <message>
 *   leave <ticket> <note>
 *   held adopt|discard <proposal-id>
 *   reassign <ticket> field=value...     (harness, model, effort, drivers, verify; field= clears)
 *   state
 *   end [closing line]
 *
 * A note, message or closing line given as "-" is read from standard input.
 * The Console is reached at --url when it answers there, and otherwise found
 * again by pool directory in the fleet registry, since a Restart may have
 * moved its port. Every route checks the conversation id against the live
 * Steward; the engine holds every rule, and this file only carries words.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRegistryPath, readFleetEntries } from "./fleet.ts";
import type { StewardStateResponse } from "./steward.ts";

/** One HTTP call the command makes. */
export interface StewardCall {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface StewardArgs {
  pool: string | null;
  url: string | null;
  conversation: string | null;
  registry: string | null;
  verb: string | null;
  rest: string[];
}

const OPTIONS = { "--pool": "pool", "--url": "url", "--as": "conversation", "--registry": "registry" } as const;

export const STEWARD_USAGE = [
  "usage: bun steward-cli.ts --pool <pool-dir> [--url <console-url>] --as <conversation> <verb> ...",
  "  answer <ticket> resume|approve|reject [note]",
  "  keep-talking <ticket> <message>",
  "  leave <ticket> <note>",
  "  held adopt|discard <proposal-id>",
  "  reassign <ticket> field=value...   (harness, model, effort, drivers, verify; field= clears)",
  "  state",
  "  end [closing line]",
  'A note, message or closing line of "-" is read from standard input.',
].join("\n");

/** The options (anywhere on the line) and the verb with its words. */
export function parseStewardArgs(argv: readonly string[]): StewardArgs {
  const out: StewardArgs = { pool: null, url: null, conversation: null, registry: null, verb: null, rest: [] };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const key = OPTIONS[argv[i] as keyof typeof OPTIONS];
    if (key !== undefined && i + 1 < argv.length) {
      out[key] = argv[i + 1]!;
      i += 1;
      continue;
    }
    words.push(argv[i]!);
  }
  out.verb = words[0] ?? null;
  out.rest = words.slice(1);
  return out;
}

class UsageError extends Error {}

// The free text after the verb's fixed words: joined with spaces, so an
// agent need not quote it, or read whole from standard input for "-".
function freeText(words: readonly string[], stdin: () => string): string {
  if (words.length === 1 && words[0] === "-") return stdin().trim();
  return words.join(" ").trim();
}

/** The call one verb makes, or a UsageError naming what is missing. */
export function stewardCall(
  conversation: string,
  verb: string,
  words: readonly string[],
  stdin: () => string,
): StewardCall {
  const post = (path: string, body: Record<string, unknown>): StewardCall => ({
    method: "POST",
    path,
    body: { conversation, ...body },
  });
  switch (verb) {
    case "answer": {
      const [ticketId, action, ...note] = words;
      if (!ticketId || (action !== "resume" && action !== "approve" && action !== "reject")) {
        throw new UsageError("answer <ticket> resume|approve|reject [note]");
      }
      const text = freeText(note, stdin);
      return post("/api/steward/answer", { ticketId, action, ...(text ? { note: text } : {}) });
    }
    case "keep-talking": {
      const [ticketId, ...message] = words;
      const text = freeText(message, stdin);
      if (!ticketId || !text) throw new UsageError("keep-talking <ticket> <message>");
      return post("/api/steward/keep-talking", { ticketId, message: text });
    }
    case "leave": {
      const [ticketId, ...note] = words;
      const text = freeText(note, stdin);
      if (!ticketId || !text) throw new UsageError("leave <ticket> <note>");
      return post("/api/steward/leave", { ticketId, note: text });
    }
    case "held": {
      const [action, id] = words;
      if ((action !== "adopt" && action !== "discard") || !id) {
        throw new UsageError("held adopt|discard <proposal-id>");
      }
      return post("/api/steward/held", { action, id });
    }
    case "reassign": {
      const [ticketId, ...pairs] = words;
      if (!ticketId || pairs.length === 0) throw new UsageError("reassign <ticket> field=value...");
      const fields: Record<string, string | number | null> = {};
      for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new UsageError(`reassign: '${pair}' is not field=value`);
        const field = pair.slice(0, eq);
        const value = pair.slice(eq + 1).trim();
        if (field === "verify") {
          if (value === "") {
            fields.verify = null;
          } else {
            // NaN would reach the route as null and clear verify instead.
            const count = Number(value);
            if (!Number.isInteger(count)) throw new UsageError(`reassign: verify=${value} is not a whole number`);
            fields.verify = count;
          }
        } else {
          fields[field] = value === "" ? null : value;
        }
      }
      return post("/api/steward/reassign", { tickets: [ticketId], fields });
    }
    case "state":
      return {
        method: "GET",
        path: `/api/steward/state?conversation=${encodeURIComponent(conversation)}`,
      };
    case "end": {
      const text = freeText(words, stdin);
      return post("/api/steward/end", text ? { closing: text } : {});
    }
    default:
      throw new UsageError(`unknown verb '${verb}'`);
  }
}

// Whether two spellings name one directory.
function sameDir(a: string, b: string): boolean {
  const canonical = (dir: string): string => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  return canonical(a) === canonical(b);
}

/** Where the Console may answer, in the order to try: --url, then the pool's fleet entry. */
export function stewardConsoleUrls(args: {
  url: string | null;
  pool: string | null;
  registry: string;
}): string[] {
  const urls: string[] = [];
  if (args.url) urls.push(args.url.replace(/\/+$/, ""));
  if (args.pool) {
    const entry = readFleetEntries(args.registry).find((e) => sameDir(e.poolDir, args.pool!));
    if (entry) {
      const found = `http://localhost:${entry.port}`;
      if (!urls.includes(found)) urls.push(found);
    }
  }
  return urls;
}

/** The state read, compact: one line per pending Interrupt, then the queue and the spawns. */
export function formatStewardState(state: StewardStateResponse): string {
  const lines = [`Steward ${state.steward}; budget ${state.budget} per Ticket; pool ${state.phase}.`];
  if (state.interrupts.length === 0) lines.push("Interrupts: none pending.");
  else lines.push("Interrupts:");
  for (const i of state.interrupts) {
    const title = i.title ? ` "${i.title}"` : "";
    const flags = [
      !i.answerable ? "not yours" : null,
      i.queued ? "answer queued" : null,
      i.keepTalking ? "pane alive" : null,
      i.answerable ? `budget ${i.remaining} of ${state.budget} left` : null,
    ].filter((flag): flag is string => flag !== null);
    lines.push(`  ${i.ticketId}${title}: ${i.kind} (${flags.join(", ")})`);
    if (i.note) lines.push(`    your note: ${i.note}`);
  }
  lines.push(
    state.mergeQueue.length === 0
      ? "Merge queue: empty."
      : `Merge queue: ${state.mergeQueue.map((e) => `${e.ticketId} ${e.state}`).join(", ")}.`,
  );
  lines.push(
    state.pendingSpawns.length === 0
      ? "Pending spawns: none."
      : `Pending spawns: ${state.pendingSpawns.map((s) => `${s.id} (${s.parentId}) "${s.title}"`).join("; ")}.`,
  );
  lines.push(
    state.heldSpawns.length === 0
      ? "Held spawns: none."
      : `Held spawns: ${state.heldSpawns
          .map((s) => `${s.id} (${s.parentId}, ${s.reason}) "${s.title}"`)
          .join("; ")}.`,
  );
  lines.push(`Spawn ledger: ${state.ledger}`);
  return lines.join("\n");
}

/** Run the command; resolves the exit code, printing through `out` and `err`. */
export async function runStewardCli(
  argv: readonly string[],
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    stdin: () => string;
    fetch?: typeof fetch;
    registry?: string;
  },
): Promise<number> {
  const args = parseStewardArgs(argv);
  if (!args.conversation || !args.verb || (!args.pool && !args.url)) {
    io.err(STEWARD_USAGE);
    return 2;
  }
  let call: StewardCall;
  try {
    call = stewardCall(args.conversation, args.verb, args.rest, io.stdin);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`steward: ${err.message}\n${STEWARD_USAGE}`);
    return 2;
  }
  const urls = stewardConsoleUrls({
    url: args.url,
    pool: args.pool,
    registry: args.registry ?? io.registry ?? defaultRegistryPath(),
  });
  if (urls.length === 0) {
    io.err(`steward: no live Console found for pool ${args.pool}`);
    return 1;
  }
  const doFetch = io.fetch ?? fetch;
  let lastError = "";
  for (const base of urls) {
    let response: Response;
    try {
      response = await doFetch(`${base}${call.path}`, {
        method: call.method,
        ...(call.body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(call.body) }
          : {}),
      });
    } catch (err) {
      // Nothing answered there: the next place the Console may be.
      lastError = `${base}: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      io.err(`steward: ${String(payload.reason ?? payload.error ?? `HTTP ${response.status}`)}`);
      return 1;
    }
    io.out(
      args.verb === "state"
        ? formatStewardState(payload as unknown as StewardStateResponse)
        : String(payload.message ?? "done"),
    );
    return 0;
  }
  io.err(`steward: the Console did not answer (${lastError})`);
  return 1;
}

if (import.meta.main) {
  const code = await runStewardCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    stdin: () => readFileSync(0, "utf8"),
  });
  process.exit(code);
}
