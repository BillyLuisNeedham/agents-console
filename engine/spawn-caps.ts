/**
 * The Spawn caps (ADR-0010, made Pool settings by ADR-0029): how many
 * proposals one attempt (or one Conversation spawn.json) has honored, and
 * how many Ticket-origin Spawns one run adopts, a run being this Console
 * boot. They live in the pool's console.json as `spawnCaps`, each field
 * falling back to its default on its own, and reload at the super-step
 * boundary with the assignment slice. A proposal beyond either cap is held
 * for the operator, never dropped. Imports nothing from the engine, so the
 * prompt, the Conversation module and Pool settings can all read it.
 */

export interface SpawnCaps {
  perAttempt: number;
  perRun: number;
}

/** The caps as console.json carries them: either field may be absent. */
export type SpawnCapsConfig = Partial<SpawnCaps>;

export const DEFAULT_SPAWN_CAPS: SpawnCaps = { perAttempt: 5, perRun: 20 };

/** The caps in force under a config, field by field over the defaults. */
export function spawnCapsOf(config: { spawnCaps?: SpawnCapsConfig }): SpawnCaps {
  return {
    perAttempt: config.spawnCaps?.perAttempt ?? DEFAULT_SPAWN_CAPS.perAttempt,
    perRun: config.spawnCaps?.perRun ?? DEFAULT_SPAWN_CAPS.perRun,
  };
}

/**
 * A console.json `spawnCaps` value, checked: absent, or an object whose
 * fields, where present, are whole numbers of zero or more. A cap of 0 is a
 * pool that holds every proposal for the operator (issue #150). Boot's
 * parse and the boundary's reload share it, so a cap the reload would
 * refuse never boots.
 */
export function checkSpawnCaps(raw: unknown): SpawnCapsConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("pool config: spawnCaps must be an object");
  }
  const caps = raw as Record<string, unknown>;
  for (const field of ["perAttempt", "perRun"] as const) {
    if (caps[field] !== undefined && !isSpawnCap(caps[field])) {
      throw new Error(`pool config: spawnCaps.${field} must be a whole number, 0 or more`);
    }
  }
  return caps as SpawnCapsConfig;
}

/** A Spawn cap: a whole number, 0 (hold everything) or more. */
export function isSpawnCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
