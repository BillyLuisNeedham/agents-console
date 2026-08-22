/**
 * The fleet registry: a machine-wide JSON file recording every live console
 * server, so any of them can be found by pool directory. This module holds the
 * path default and the read side the pool lock's refusal message needs. The
 * server-side registration and the `fleet` list command build on it; hygiene
 * is entirely prune-on-read.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/**
 * Best-effort lookup of a fleet entry, used to enrich a pool-lock refusal with
 * the live server's port. An absent, corrupt, or unmatched registry yields
 * null; callers never depend on the registry existing.
 */
export function readFleetEntry(
  registryPath: string,
  poolDir: string,
  pid: number,
): FleetEntry | null {
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  for (const raw of entries) {
    if (
      raw !== null &&
      typeof raw === "object" &&
      (raw as Record<string, unknown>).poolDir === poolDir &&
      (raw as Record<string, unknown>).pid === pid
    ) {
      return raw as FleetEntry;
    }
  }
  return null;
}