/**
 * Machine defaults (issue #121): the per-machine harness, model, effort,
 * drivers, terminal and engine path a new Pool inherits when nothing more specific
 * says otherwise. One JSON file under `~/.agent-graphs/`, edited from the
 * Console's Settings pane and read by Boot and by the engine's resolver
 * fallback.
 *
 * Two older files carried slices of this before: `~/.issue-runner`
 * (`harness=..` / `model=..`, two lines) and `~/.console-runner`
 * (`engine=<path>`, read only by the skill). Both stay readable as a
 * fallback so a machine that never wrote the new file behaves as before;
 * a field present in the new file always wins, field by field.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MachineDefaults {
  harness?: string;
  model?: string;
  /** The harness's own effort word (CONTEXT.md: Effort), passed through verbatim. */
  effort?: string;
  drivers?: string;
  /** Terminal backing every new pool starts with; the only legal value is "herdr". */
  terminal?: "herdr";
  /** The agent-console checkout Boot runs the engine from. */
  engine?: string;
}

export const MACHINE_DEFAULTS_KEYS = [
  "harness",
  "model",
  "effort",
  "drivers",
  "terminal",
  "engine",
] as const satisfies readonly (keyof MachineDefaults)[];

/** Where the file lives unless a caller injects a path (tests do). */
export function defaultMachineDefaultsPath(home: string = homedir()): string {
  return join(home, ".agent-graphs", "defaults.json");
}

export interface MachineDefaultsPaths {
  /** The JSON file of record. */
  file: string;
  /** Legacy `harness=` / `model=` file; read only when the field is absent above. */
  issueRunner: string;
  /** Legacy `engine=` file; read only when `engine` is absent above. */
  consoleRunner: string;
}

export function defaultMachineDefaultsPaths(home: string = homedir()): MachineDefaultsPaths {
  return {
    file: defaultMachineDefaultsPath(home),
    issueRunner: join(home, ".issue-runner"),
    consoleRunner: join(home, ".console-runner"),
  };
}

/**
 * The defaults in force: the JSON file's fields, with each missing field
 * filled from the legacy file that used to hold it. An unreadable or
 * malformed JSON file counts as absent rather than failing the caller: the
 * defaults are a convenience, never a gate.
 */
export function readMachineDefaults(
  paths: MachineDefaultsPaths = defaultMachineDefaultsPaths(),
): MachineDefaults {
  const own = readMachineDefaultsFile(paths.file);
  const runner = readKeyValueFile(paths.issueRunner);
  const console = readKeyValueFile(paths.consoleRunner);
  const merged: MachineDefaults = { ...own };
  if (!merged.harness && runner.get("harness")) merged.harness = runner.get("harness");
  if (!merged.model && runner.get("model")) merged.model = runner.get("model");
  if (!merged.engine && console.get("engine")) merged.engine = console.get("engine");
  return merged;
}

/** Only the JSON file's own fields, no legacy fallback; `{}` when absent. */
export function readMachineDefaultsFile(file: string): MachineDefaults {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  return sanitizeMachineDefaults(parsed);
}

/**
 * Validate and write the file, creating `~/.agent-graphs/` when missing.
 * Written whole, via a rename, so a reader never sees half a file. Empty
 * strings drop the field rather than storing "no value" as a value.
 */
export function writeMachineDefaults(
  defaults: MachineDefaults,
  file: string = defaultMachineDefaultsPath(),
): MachineDefaults {
  const clean = validateMachineDefaults(defaults);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
  renameSync(tmp, file);
  return clean;
}

/**
 * The fields the file may hold, each trimmed; anything else is dropped. An
 * illegal `terminal` throws, matching how the pool config rejects it.
 */
export function validateMachineDefaults(input: unknown): MachineDefaults {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: MachineDefaults = {};
  for (const key of ["harness", "model", "effort", "drivers", "engine"] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new Error(`machine defaults: ${key} must be a string`);
    }
    if (value.trim()) out[key] = value.trim();
  }
  const terminal = raw.terminal;
  if (terminal !== undefined && terminal !== null && terminal !== "") {
    if (terminal !== "herdr") {
      throw new Error(`machine defaults: terminal must be "herdr" (got ${JSON.stringify(terminal)})`);
    }
    out.terminal = "herdr";
  }
  return out;
}

// A read never throws on a bad value: the field is skipped instead.
function sanitizeMachineDefaults(parsed: unknown): MachineDefaults {
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const out: MachineDefaults = {};
  for (const key of ["harness", "model", "effort", "drivers", "engine"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  if (raw.terminal === "herdr") out.terminal = "herdr";
  return out;
}

function readKeyValueFile(path: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (!existsSync(path)) return fields;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fields;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return fields;
}
