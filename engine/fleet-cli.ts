/**
 * The fleet list command: answers "what's running". It reads the fleet
 * registry and, because reads prune (see fleet.ts), dead servers and deleted
 * pools never appear. Each live pool prints as one plain line,
 * `poolDir → http://localhost:<port>`, so the output composes with xargs and
 * friends. The command is strictly read-only: it never starts, stops, or
 * signals anything, and it never rewrites the registry.
 */

import { defaultRegistryPath, readFleetEntries } from "./fleet.ts";

/** The line printed when no console is live. */
export const NO_LIVE_CONSOLES = "no live consoles";

/**
 * The lines the command prints, in registry order: one per live pool as
 * `poolDir → http://localhost:<port>`, or the no-live-consoles line when the
 * pruned registry is empty.
 */
export function listFleet(registryPath: string): string[] {
  const entries = readFleetEntries(registryPath);
  if (entries.length === 0) return [NO_LIVE_CONSOLES];
  return entries.map(
    (entry) => `${entry.poolDir} → http://localhost:${entry.port}`,
  );
}

export function runFleetCli(registryPath: string = defaultRegistryPath()): void {
  for (const line of listFleet(registryPath)) {
    console.log(line);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const registryIndex = args.indexOf("--registry");
  const registryPath =
    registryIndex >= 0 && args[registryIndex + 1]
      ? args[registryIndex + 1]
      : defaultRegistryPath();
  runFleetCli(registryPath);
}