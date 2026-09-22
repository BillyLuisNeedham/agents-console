/**
 * Pool settings (issue #121): the slice of one Pool's `console.json` the
 * Console's Settings pane edits, and the only writer of that file inside the
 * server. CONTEXT.md calls the concept Pool settings; the file itself stays
 * the source of truth, exactly as ADR-0018 left it, so editing it by hand
 * and editing it from the pane are the same act.
 *
 * Two rules shape everything below. First, a write is a patch, never a
 * replacement: `assign` belongs to the Tickets rather than to the pane, and
 * a key this module has never heard of belongs to whoever put it there, so
 * both survive a save untouched. Second, only some of what the pane edits
 * takes effect without a Restart: `defaults`, `assign` and `resolver` reload
 * at the next super-step boundary (ADR-0018), and BOOT_ONLY_KEYS is the rest,
 * which the running process froze at boot and the Console badges as such.
 *
 * `reviewer` and `checkpoint` are prose the setup skill already writes here
 * and the engine has never read: agents meet them through AGENT.md. They are
 * settings all the same, so the pane edits them and this module carries them
 * through validation like any other key.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, type PoolConfig } from "./engine.ts";
import type { MachineDefaults } from "./machine-defaults.ts";

/**
 * The keys the Settings pane owns. A patch may carry any subset; anything
 * else in a patch body is ignored rather than written, so a stale tab cannot
 * smuggle `assign` through the pane.
 */
export const POOL_SETTINGS_KEYS = [
  "defaults",
  "resolver",
  "terminal",
  "port",
  "selection",
  "roster",
  "agents",
  "reviewer",
  "checkpoint",
] as const satisfies readonly (keyof PoolConfig)[];

export type PoolSettingsKey = (typeof POOL_SETTINGS_KEYS)[number];

/**
 * The settings a saved edit does not reach until the next Restart. ADR-0018
 * reloads only the assignment slice at a boundary; roster, agents, selection,
 * terminal and port stay as this process read them at boot, and terminal and
 * port in particular must never move under a live run.
 */
export const BOOT_ONLY_KEYS = [
  "roster",
  "agents",
  "selection",
  "terminal",
  "port",
] as const satisfies readonly PoolSettingsKey[];

/** Where a pool keeps its config. */
export function poolSettingsPath(poolDir: string): string {
  return join(poolDir, "console.json");
}

/**
 * The file as it is on disk, parsed but not filtered: `assign`, the boot-only
 * keys and anything unknown all come back, because the pane shows what is
 * there and a save has to preserve what it did not touch. An absent file is
 * `{}`, the same "no config" the engine reads. A malformed one throws with
 * the path in the message: the server booted off this file, so a parse
 * failure here means it was edited into a broken state since, and saying so
 * beats serving an empty config the next save would write over.
 */
export function readPoolSettings(poolDir: string): {
  path: string;
  config: PoolConfig;
} {
  return { path: poolSettingsPath(poolDir), config: readConfig(poolDir) };
}

export interface WritePoolSettingsOptions {
  /** The harness names this pool knows, for validating `defaults.harness` and
   *  the resolver's. Empty skips the check, which is what a caller with no
   *  harness table wants rather than a refusal of every harness. */
  harnesses: string[];
}

/**
 * Merge a patch over the pool's config and write the result atomically.
 *
 * A key absent from the patch is left exactly as it was. A key present with
 * `null`, `undefined` or `""` is removed, which is how the pane clears a
 * pinned port back to "any free port" or drops `terminal` back to headless.
 * `defaults` is replaced whole when present (its empty fields dropped, and an
 * all-empty object removing the key) rather than merged field by field: the
 * pane shows all three fields at once, so a field the operator emptied is an
 * instruction, not an omission.
 *
 * Validation is readConfig's, plus the checks readConfig has no table for:
 * a port in range, a harness the pool actually knows, an `agents` string that
 * really is a JSON object. Every failure is a plain Error naming the field,
 * which the route turns into a 400.
 */
export function writePoolSettings(
  poolDir: string,
  patch: Record<string, unknown>,
  options: WritePoolSettingsOptions,
): PoolConfig {
  const path = poolSettingsPath(poolDir);
  const existing = readPoolSettings(poolDir).config;
  const next: Record<string, unknown> = { ...existing };

  for (const key of POOL_SETTINGS_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    const resolved = normaliseKey(key, value, options.harnesses);
    if (resolved === undefined) delete next[key];
    else next[key] = resolved;
  }

  const config = next as PoolConfig;
  // Written whole through a rename so a reader (the engine's own Config
  // reload, at a boundary that may land mid-write) never sees half a file.
  mkdirSync(poolDir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, path);
  return config;
}

// One key's value, validated: `undefined` means remove the key. Empty is
// always a removal, whatever the key's shape, so the pane's "clear this
// field" is one gesture rather than a per-key convention.
function normaliseKey(
  key: PoolSettingsKey,
  value: unknown,
  harnesses: string[],
): unknown {
  if (value === null || value === undefined) return undefined;
  switch (key) {
    case "defaults":
      return normaliseDefaults(value, harnesses);
    case "resolver":
      return normaliseResolver(value, harnesses);
    case "port":
      return normalisePort(value);
    case "terminal":
      return normaliseTerminal(value);
    case "selection":
      return normaliseSelection(value);
    case "agents":
      return normaliseAgents(value);
    case "roster":
    case "reviewer":
    case "checkpoint":
      return normaliseProse(key, value);
  }
}

function normaliseProse(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    throw new Error(`pool settings: ${key} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normaliseDefaults(
  value: unknown,
  harnesses: string[],
): PoolConfig["defaults"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pool settings: defaults must be an object");
  }
  const raw = value as Record<string, unknown>;
  const out: { harness?: string; model?: string; drivers?: string } = {};
  for (const field of ["harness", "model", "drivers"] as const) {
    const entry = raw[field];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "string") {
      throw new Error(`pool settings: defaults.${field} must be a string`);
    }
    if (entry.trim()) out[field] = entry.trim();
  }
  if (out.harness) requireKnownHarness("defaults.harness", out.harness, harnesses);
  return Object.keys(out).length === 0 ? undefined : out;
}

// The resolver takes three shapes (engine.ts's resolveResolver): a harness
// name, the opt-out "none", or { harness, model } when the resolver runs on a
// harness whose model names the defaults' harness would not recognise. An
// empty string is the pane clearing the key, not the opt-out; "none" is the
// opt-out and is kept verbatim.
function normaliseResolver(
  value: unknown,
  harnesses: string[],
): PoolConfig["resolver"] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (trimmed !== "none") requireKnownHarness("resolver", trimmed, harnesses);
    return trimmed;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      'pool settings: resolver must be a harness name, "none", or { harness, model }',
    );
  }
  const raw = value as Record<string, unknown>;
  const out: { harness?: string; model?: string } = {};
  for (const field of ["harness", "model"] as const) {
    const entry = raw[field];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "string") {
      throw new Error(`pool settings: resolver.${field} must be a string`);
    }
    if (entry.trim()) out[field] = entry.trim();
  }
  if (out.harness && out.harness !== "none") {
    requireKnownHarness("resolver.harness", out.harness, harnesses);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// A pinned port, or nothing. Port 0 is not a pin (ports.ts) and would read as
// "any free port" written down as a pin, so the pane clears the key instead.
// A numeric string is accepted because the pane's field is a text input and
// "8790" is plainly a port; anything else is refused by name.
function normalisePort(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`pool settings: port must be an integer 1-65535, got ${value}`);
    }
    return checkedPort(Number(trimmed));
  }
  if (typeof value !== "number") {
    throw new Error("pool settings: port must be an integer 1-65535");
  }
  return checkedPort(value);
}

function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`pool settings: port must be an integer 1-65535, got ${port}`);
  }
  return port;
}

function normaliseTerminal(value: unknown): "herdr" | undefined {
  if (value === "") return undefined;
  if (value !== "herdr") {
    throw new Error(
      `pool settings: terminal must be "herdr" (got ${JSON.stringify(value)})`,
    );
  }
  return "herdr";
}

function normaliseSelection(value: unknown): "auto" | "human" | undefined {
  if (value === "") return undefined;
  if (value !== "auto" && value !== "human") {
    throw new Error(
      `pool settings: selection must be "auto" or "human" (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

// `agents` is the roster as a JSON string, handed to claude's --agents flag
// verbatim. A string that is not a JSON object reaches the harness as a flag
// value it rejects at launch, hours after the save, so it is refused here.
function normaliseAgents(value: unknown): string | undefined {
  if (typeof value !== "string") {
    throw new Error("pool settings: agents must be a string");
  }
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `pool settings: agents must be a JSON object (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("pool settings: agents must be a JSON object");
  }
  return trimmed;
}

function requireKnownHarness(field: string, harness: string, harnesses: string[]): void {
  if (harnesses.length === 0) return;
  if (harnesses.includes(harness)) return;
  throw new Error(
    `pool settings: ${field} names unknown harness '${harness}'. ` +
      `Known: ${[...harnesses].sort().join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Wire shapes (GET /api/settings, PUT /api/settings/pool, /api/settings/machine)
// ---------------------------------------------------------------------------

/** The Pool's half of the Settings payload. `effective` is what THIS process
 *  booted with, so the Console can badge a boot-only key whose saved value no
 *  longer matches what is running. */
export interface PoolSettingsView {
  path: string;
  config: PoolConfig;
  bootOnly: string[];
  effective: {
    port: number;
    terminal: "herdr" | null;
    /** The boot-only keys whose saved value is not what is running, so the
     *  badge survives a reload and catches a hand edit, not only a save made
     *  in this tab. A subset of `bootOnly`. */
    stale: string[];
  };
}

/** The machine's half: `defaults` is what is in force (the legacy runner
 *  files filled in), `own` is only the JSON file's own fields, which is what
 *  the pane edits and writes back. */
export interface MachineDefaultsView {
  path: string;
  defaults: MachineDefaults;
  own: MachineDefaults;
}

export interface SettingsResponse {
  pool: PoolSettingsView;
  machine: MachineDefaultsView;
  /** The harness names this pool knows, sorted, for the pane's pickers. */
  harnesses: string[];
}

/** PUT /api/settings/pool. The patch is a partial PoolConfig; a key set to
 *  null or "" removes it. */
export interface PoolSettingsRequest {
  config: Record<string, unknown>;
}

/** PUT /api/settings/machine. The defaults are written whole. */
export interface MachineDefaultsRequest {
  defaults: MachineDefaults;
}

/** POST /api/restart's acknowledgement: the port the relaunched Console will
 *  listen on, so the tab knows where to reconnect when it moved. */
export interface RestartResponse {
  ok: true;
  port: number;
}
