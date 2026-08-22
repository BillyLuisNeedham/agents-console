/**
 * The fleet registry: a machine-wide JSON file recording every live console
 * server, so any of them can be found by pool directory. Servers upsert their
 * own entry after binding; hygiene is entirely prune-on-read. There is no
 * server-side exit handler, because cleanup under kill -9 would be
 * unreliable, so a dead pid or a deleted pool directory only drops from view
 * on the next read.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 * Best-effort lookup of a fleet entry by port, used to name the holder on a
 * busy pinned port. Only live, pruned entries are candidates; an absent,
 * corrupt, or unmatched registry yields null, and callers never depend on the
 * registry existing.
 */
export function readFleetEntryByPort(
  registryPath: string,
  port: number,
): FleetEntry | null {
  return (
    readFleetEntries(registryPath).find((entry) => entry.port === port) ?? null
  );
}

/** The pid named in a lock file, or null when it is empty or unreadable. */
function readLockPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** How long a registry write waits on a foreign lock before giving up. */
export const FLEET_LOCK_TIMEOUT_MS = 10_000;

/**
 * Upsert one console's entry, keyed by pool directory: relaunching the same
 * pool replaces its old entry rather than duplicating it. A missing or corrupt
 * registry file is recreated, never an error.
 *
 * Writes are serialized with a lock file, so two servers booting different
 * pools at the same moment cannot lose one entry, and the registry itself is
 * replaced by rename so a reader never sees a half-written file. The lock is
 * claimed with O_EXCL; a lock whose holder pid is dead is a crashed writer's
 * and is cleared, while a live holder is waited on up to FLEET_LOCK_TIMEOUT_MS.
 */
export function upsertFleetEntry(
  registryPath: string,
  entry: FleetEntry,
): void {
  const lockPath = `${registryPath}.lock`;
  mkdirSync(dirname(registryPath), { recursive: true });
  const deadline = Date.now() + FLEET_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLockPid(lockPath);
      if (holder !== null) {
        if (pidIsLive(holder)) {
          if (Date.now() > deadline) {
            throw new Error(
              `fleet registry: lock ${lockPath} is held by live pid ${holder}`,
            );
          }
          Bun.sleepSync(10);
          continue;
        }
        // The holder's process is gone: a crashed writer. Clear its lock.
        rmSync(lockPath, { force: true });
        continue;
      }
      // Empty or unreadable: a writer is mid-claim, its pid appears within
      // microseconds. A lock still empty past the deadline is a crashed
      // writer's, so clear it and retry.
      if (Date.now() > deadline) {
        rmSync(lockPath, { force: true });
        continue;
      }
      Bun.sleepSync(10);
      continue;
    }
    try {
      const entries = readRegistry(registryPath).filter(
        (existing) => existing.poolDir !== entry.poolDir,
      );
      entries.push(entry);
      const tempPath = `${registryPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(entries, null, 2));
      renameSync(tempPath, registryPath);
      return;
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
}
