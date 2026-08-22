/**
 * The fleet registry: a machine-wide JSON file recording every live console
 * server, so any of them can be found by pool directory. Servers upsert their
 * own entry after binding; hygiene is entirely prune-on-read. There is no
 * server-side exit handler, because cleanup under kill -9 would be
 * unreliable, so a dead pid or a deleted pool directory only drops from view
 * on the next read.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FleetEntry {
  poolDir: string;
  port: number;
  pid: number;
  startedAt: string;
}

/** The registry's machine-wide location, outside any repo. */
export function defaultRegistryPath(): string {
  return join(homedir(), ".agent-graphs", "pools.json");
}

function isFleetEntry(value: unknown): value is FleetEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.poolDir === "string" &&
    typeof entry.port === "number" &&
    typeof entry.pid === "number" &&
    typeof entry.startedAt === "string"
  );
}

/** Read the raw registry file. A missing or corrupt file reads as empty. */
function readRegistry(registryPath: string): FleetEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFleetEntry);
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read the fleet, pruning before returning: entries whose pid is dead or
 * whose pool directory no longer exists are dropped. A missing or corrupt
 * registry reads as empty.
 */
export function readFleetEntries(registryPath: string): FleetEntry[] {
  return readRegistry(registryPath).filter(
    (entry) => pidIsLive(entry.pid) && existsSync(entry.poolDir),
  );
}

/**
 * Best-effort lookup of a fleet entry, used to enrich a pool-lock refusal with
 * the live server's port. Only live, pruned entries are candidates; an absent,
 * corrupt, or unmatched registry yields null, and callers never depend on the
 * registry existing.
 */
export function readFleetEntry(
  registryPath: string,
  poolDir: string,
  pid: number,
): FleetEntry | null {
  return (
    readFleetEntries(registryPath).find(
      (entry) => entry.poolDir === poolDir && entry.pid === pid,
    ) ?? null
  );
}

/**
 * Upsert one console's entry, keyed by pool directory: relaunching the same
 * pool replaces its old entry rather than duplicating it. A missing or corrupt
 * registry file is recreated, never an error.
 */
export function upsertFleetEntry(
  registryPath: string,
  entry: FleetEntry,
): void {
  const entries = readRegistry(registryPath).filter(
    (existing) => existing.poolDir !== entry.poolDir,
  );
  entries.push(entry);
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(entries, null, 2));
}