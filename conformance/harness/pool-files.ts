/**
 * Readers for the files a server keeps in its pool directory: the Ticket
 * markers, the per-Ticket events JSONL, console.json and the checkpoints in
 * console.db. Each reads what is on disk now; a case that waits for a change
 * polls with `until`.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, TicketEvent } from "../../protocol/wire.ts";

/** A Ticket file's first line, its state marker, parsed. */
export interface StateLine {
  /** The line as written, byte for byte. */
  line: string;
  /** Its fields in the order written: id, blocked-by, status and the rest. */
  fields: [string, string][];
  id: string;
  status: string;
  /** The ids it waits for; empty for `blocked-by=none`. */
  blockedBy: string[];
}

const MARKER = /^<!-- state: (.*) -->$/;

/** The marker line parsed, or null when the line is not one. */
export function parseStateLine(line: string): StateLine | null {
  const match = MARKER.exec(line);
  if (!match) return null;
  const fields = match[1]!
    .split(" ")
    .filter((part) => part !== "")
    .map((part): [string, string] => {
      const eq = part.indexOf("=");
      return eq < 0 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
    });
  const field = (name: string) => fields.find(([key]) => key === name)?.[1] ?? "";
  const blocked = field("blocked-by");
  return {
    line,
    fields,
    id: field("id"),
    status: field("status"),
    blockedBy: blocked === "" || blocked === "none" ? [] : blocked.split(","),
  };
}

/** A Ticket file's bytes, by file name under `issues/`. */
export function readTicketFile(pool: string, file: string): string {
  return readFileSync(join(pool, "issues", file), "utf8");
}

/** A Ticket file's state marker, by file name under `issues/`. */
export function readStateLine(pool: string, file: string): StateLine {
  const line = readTicketFile(pool, file).split("\n", 1)[0]!;
  const parsed = parseStateLine(line);
  if (!parsed) throw new Error(`issues/${file} has no state marker on line 1: ${line}`);
  return parsed;
}

/** Every Ticket file's marker, keyed by the marker's id. */
export function readMarkers(pool: string): Record<string, StateLine & { file: string }> {
  const out: Record<string, StateLine & { file: string }> = {};
  const dir = join(pool, "issues");
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const parsed = parseStateLine(readTicketFile(pool, file).split("\n", 1)[0]!);
    if (parsed) out[parsed.id] = { ...parsed, file };
  }
  return out;
}

/** JSONL text parsed line by line; a trailing newline ends the last line. */
export function parseJsonl<T = unknown>(text: string): T[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        throw new Error(`line ${i + 1} is not JSON: ${line.slice(0, 200)}`);
      }
    });
}

/** A Ticket's or Conversation's events, `runs/<id>.events.jsonl`; empty when there is none. */
export function readEvents(pool: string, id: string): TicketEvent[] {
  const path = join(pool, "runs", `${id}.events.jsonl`);
  return existsSync(path) ? parseJsonl<TicketEvent>(readFileSync(path, "utf8")) : [];
}

/** console.json parsed, or null when the pool has none. */
export function readConsoleJson(pool: string): PoolConfig | null {
  const path = join(pool, "console.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PoolConfig) : null;
}

/** One checkpoint row of console.db, its state parsed. */
export interface Checkpoint {
  seq: number;
  at: string;
  state: unknown;
}

/** Every checkpoint in console.db in write order; empty when there is no store. */
export function readCheckpoints(pool: string): Checkpoint[] {
  const path = join(pool, "console.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("SELECT seq, at, state FROM checkpoints ORDER BY seq").all() as {
      seq: number;
      at: string;
      state: string;
    }[];
    return rows.map((row) => ({ seq: row.seq, at: row.at, state: JSON.parse(row.state) }));
  } finally {
    db.close();
  }
}

/** The last checkpoint's state, or null when there is none. */
export function latestCheckpoint(pool: string): unknown | null {
  return readCheckpoints(pool).at(-1)?.state ?? null;
}

/** Poll `read` until `done` holds of what it returns, or throw after `ms`. */
export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  options: { ms?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.ms ?? 10_000);
  for (;;) {
    let value: T | undefined;
    let failure: unknown = null;
    try {
      value = await read();
      if (done(value)) return value;
    } catch (err) {
      // A file mid-write reads as missing or torn; the next poll sees it whole.
      failure = err;
    }
    if (Date.now() >= deadline) {
      const last = failure instanceof Error ? failure.message : JSON.stringify(value)?.slice(0, 500);
      throw new Error(`timed out waiting for ${options.what ?? "a condition"}; last read: ${last}`);
    }
    await Bun.sleep(25);
  }
}
