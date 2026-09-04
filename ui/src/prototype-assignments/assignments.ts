// PROTOTYPE (issue #35, throwaway page; this module is the liftable part):
// resolve which harness and model each ticket runs on, mirroring the engine's
// rules (engine.ts resolveAssignment / resolveEngineTicketAssignment /
// resolveSpawnedTicketAssignment): an assign entry overrides field-wise;
// grader, head-to-head, and spawned tickets inherit from their build/parent
// ticket rather than the pool defaults; everything else falls to defaults.
// Pure: no DOM, no fetch. The page around it is throwaway; this isn't.

export interface AssignmentConfig {
  defaults?: { harness?: string; model?: string; drivers?: string | string[] };
  assign?: Record<
    string,
    {
      harness?: string;
      model?: string;
      drivers?: string | string[];
      verify?: number;
    }
  >;
}

export type AssignmentSource =
  | { kind: "override" }
  | { kind: "inherited"; from: string }
  | { kind: "default" }
  | { kind: "unassigned" };

export interface ResolvedAssignment {
  ticketId: string;
  harness: string | null;
  model: string | null;
  drivers: string[];
  source: AssignmentSource;
}

function parentIdOf(id: string): string | null {
  const grader = /^(.+)-grader-\d+$/.exec(id);
  if (grader) return grader[1];
  if (id.endsWith("-head-to-head")) {
    return id.slice(0, -"-head-to-head".length);
  }
  const spawn = /^(.+)-spawn-\d+$/.exec(id);
  if (spawn) return spawn[1];
  return null;
}

export function readConfig(raw: Record<string, unknown>): AssignmentConfig {
  const defaults = (raw.defaults ?? {}) as AssignmentConfig["defaults"];
  const assign = (raw.assign ?? {}) as AssignmentConfig["assign"];
  return { defaults, assign };
}

function asDrivers(raw: string | string[] | undefined): string[] {
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function resolveOne(
  id: string,
  config: AssignmentConfig,
  ticketIds: ReadonlySet<string>,
  depth: number,
): ResolvedAssignment {
  const entry = config.assign?.[id];
  const parentId = parentIdOf(id);
  const parent =
    parentId !== null && ticketIds.has(parentId) && depth < 8
      ? resolveOne(parentId, config, ticketIds, depth + 1)
      : null;
  const fallbackHarness = parent?.harness ?? config.defaults?.harness ?? null;
  const fallbackModel = parent?.model ?? config.defaults?.model ?? null;
  const harness = entry?.harness ?? fallbackHarness;
  const model = entry?.model ?? fallbackModel;
  const source: AssignmentSource = entry
    ? { kind: "override" }
    : parent
      ? { kind: "inherited", from: parent.ticketId }
      : config.defaults && (config.defaults.harness || config.defaults.model)
        ? { kind: "default" }
        : { kind: "unassigned" };
  return {
    ticketId: id,
    harness,
    model,
    drivers: asDrivers(
      entry?.drivers ?? parent?.drivers ?? config.defaults?.drivers,
    ),
    source,
  };
}

export function resolveAssignments(
  ticketIds: string[],
  config: AssignmentConfig,
): Map<string, ResolvedAssignment> {
  const ids = new Set(ticketIds);
  const out = new Map<string, ResolvedAssignment>();
  for (const id of ticketIds) out.set(id, resolveOne(id, config, ids, 0));
  return out;
}

export function sourceLabel(source: AssignmentSource): string {
  switch (source.kind) {
    case "override":
      return "ticket override";
    case "inherited":
      return `from ${source.from}`;
    case "default":
      return "pool default";
    case "unassigned":
      return "unassigned";
  }
}

// Demo config for ?demo=1: a pool whose config has no assign block shows
// "pool default" on every card, which answers nothing. Cycle a few harnesses
// and models over the real ticket ids so every source kind appears.
export function demoConfig(ticketIds: string[]): AssignmentConfig {
  const combos = [
    { harness: "claude", model: "opus-4.6" },
    { harness: "codex", model: "gpt-5.2" },
    { harness: "gemini", model: "gemini-3-pro" },
  ];
  const assign: NonNullable<AssignmentConfig["assign"]> = {};
  ticketIds.forEach((id, i) => {
    if (i % 3 === 1) assign[id] = combos[i % combos.length];
    if (i % 5 === 4) assign[id] = { model: combos[i % combos.length].model };
  });
  return {
    defaults: { harness: "claude", model: "sonnet-4.6", drivers: ["bun"] },
    assign,
  };
}
