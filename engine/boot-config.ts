/**
 * The values Boot carries between reading and writing (issue #121): the
 * prefill it assembles before it asks anything, the answers the interview
 * returns, and the two files it writes from them.
 *
 * The prefill is the whole point of Boot being a script. Four sources
 * answer the same fields, in a fixed order of authority: the Pool's own
 * config, then the chosen Setup, then Machine defaults, then detection.
 * The merge is field by field rather than whole object, so a Setup that
 * names a harness does not blank a model the pool already had.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MachineDefaults } from "./machine-defaults.ts";
import type { Detection } from "./boot-detect.ts";
import { slugify } from "./boot-pool.ts";

/** The resolver as console.json holds it: a harness name, or a pair. */
export type ResolverValue = string | { harness?: string; model?: string; effort?: string };

/** Every field Boot can prefill, all optional because any source may be silent. */
export interface Prefill {
  harness?: string;
  model?: string;
  /** Carried through, never asked: Boot's interview has no effort question. */
  effort?: string;
  drivers?: string;
  resolver?: ResolverValue;
  reviewer?: string;
  checkpoint?: string;
  /** A concrete pin; absent means the engine picks 8787 or the next free port. */
  port?: number;
  terminal?: "herdr";
  /** Whether this Pool is seeded, which only the pool's own shape suggests. */
  seeded?: boolean;
}

/**
 * The interview's output. A field left `undefined` was never asked and the
 * existing file keeps whatever it had; the two sentinels are the operator
 * saying "no value here", which removes the key.
 */
export interface BootAnswers {
  harness?: string;
  model?: string;
  effort?: string;
  drivers?: string;
  resolver?: ResolverValue;
  reviewer?: string;
  checkpoint?: string;
  /** A number pins the port; "auto" removes the pin. */
  port?: number | "auto";
  /** "herdr" backs attempts with tabs; "none" removes the key. */
  terminal?: "herdr" | "none";
  /** The Pool title (issue #100), asked only when Boot creates the Pool. */
  title?: string;
}

/**
 * The behavioural keys a Setup carries, and nothing pool-specific. A Setup
 * saved before ADR-0031 may still hold `roster` or `agents`: nothing reads
 * them, and a Setup written from a config never carries them again.
 */
export const SETUP_KEYS = [
  "defaults",
  "resolver",
  "terminal",
  "reviewer",
  "checkpoint",
] as const;

/**
 * Earlier sources win, field by field. Written as a fold rather than a
 * spread chain because a spread would let a later source's `undefined`
 * overwrite an earlier source's value.
 */
export function mergePrefill(sources: Prefill[]): Prefill {
  const out: Prefill = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === "") continue;
      if ((out as Record<string, unknown>)[key] === undefined) {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/** The pool's own console.json as a prefill, which outranks every other source. */
export function prefillFromConfig(config: Record<string, unknown>): Prefill {
  const defaults = (config.defaults ?? {}) as Record<string, unknown>;
  const out: Prefill = {};
  if (typeof defaults.harness === "string") out.harness = defaults.harness;
  if (typeof defaults.model === "string") out.model = defaults.model;
  if (typeof defaults.effort === "string") out.effort = defaults.effort;
  if (typeof defaults.drivers === "string") out.drivers = defaults.drivers;
  if (typeof config.resolver === "string" || isResolverObject(config.resolver)) {
    out.resolver = config.resolver as ResolverValue;
  }
  for (const key of ["reviewer", "checkpoint"] as const) {
    const value = config[key];
    if (typeof value === "string") out[key] = value;
  }
  if (typeof config.port === "number") out.port = config.port;
  if (config.terminal === "herdr") out.terminal = "herdr";
  return out;
}

/** A Setup file as a prefill. Same shape as a config, minus port and assign. */
export function prefillFromSetup(setup: Record<string, unknown>): Prefill {
  const out = prefillFromConfig(setup);
  delete out.port;
  return out;
}

/** Machine defaults as a prefill: the fields a machine, not a pool, settles. */
export function prefillFromMachineDefaults(defaults: MachineDefaults): Prefill {
  const out: Prefill = {};
  if (defaults.harness) out.harness = defaults.harness;
  if (defaults.model) out.model = defaults.model;
  if (defaults.effort) out.effort = defaults.effort;
  if (defaults.drivers) out.drivers = defaults.drivers;
  if (defaults.terminal) out.terminal = defaults.terminal;
  return out;
}

/**
 * Detection as the last prefill. It answers two fields and leaves the rest:
 * a herdr binary with a live socket means a terminal-backed pool is what to
 * recommend, and the pool's shape says whether it looks seeded. The port is
 * deliberately not prefilled, because no pin is the good default.
 */
export function prefillFromDetection(detection: Detection): Prefill {
  const out: Prefill = { drivers: "implement" };
  if (detection.herdr.binary && detection.herdr.socket) out.terminal = "herdr";
  if (detection.conversations) out.seeded = true;
  else if (detection.tickets > 0) out.seeded = false;
  return out;
}

/**
 * The pool config to write: the answers laid over whatever the file already
 * held. `assign` and any key Boot does not know about survive untouched,
 * because a pool's per-ticket overrides and its `selection` are the
 * operator's and no interview asked about them.
 */
export function mergeConsoleConfig(
  existing: Record<string, unknown>,
  answers: BootAnswers,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  // Keys the engine retired (ADR-0031, RETIRED_CONFIG_KEYS in engine.ts):
  // a pool that still carries them loses them here, silently.
  delete out.roster;
  delete out.agents;
  const defaults: Record<string, unknown> = {
    ...((existing.defaults ?? {}) as Record<string, unknown>),
  };
  for (const key of ["harness", "model", "effort", "drivers"] as const) {
    const value = answers[key];
    if (value !== undefined && value !== "") defaults[key] = value;
  }
  if (Object.keys(defaults).length > 0) out.defaults = defaults;
  if (answers.resolver !== undefined && answers.resolver !== "") {
    out.resolver = answers.resolver;
  }
  for (const key of ["reviewer", "checkpoint"] as const) {
    const value = answers[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  if (answers.port === "auto") delete out.port;
  else if (typeof answers.port === "number") out.port = answers.port;
  if (answers.terminal === "none") delete out.terminal;
  else if (answers.terminal === "herdr") out.terminal = "herdr";
  if (answers.title !== undefined && answers.title !== "") out.title = answers.title;
  return out;
}

/**
 * console.json as it is on disk, or `{}` when there is none. A file that is
 * there but does not parse throws rather than counting as absent: Boot
 * writes this file back, and treating a broken one as empty would quietly
 * drop the `assign` entries and the hand edits it holds.
 */
export function readConsoleConfig(poolDir: string): Record<string, unknown> {
  const file = join(poolDir, "console.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${file} does not parse as JSON (${err instanceof Error ? err.message : String(err)}); ` +
        "fix it or move it aside, then boot again",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function writeConsoleConfig(
  poolDir: string,
  config: Record<string, unknown>,
): void {
  writeFileSync(join(poolDir, "console.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** The behavioural slice of a pool config, which is what a Setup is. */
export function setupFromConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETUP_KEYS) {
    const value = config[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

export function setupsDir(home: string = homedir()): string {
  return join(home, ".agent-graphs", "setups");
}

export function setupPath(name: string, home: string = homedir()): string {
  return join(setupsDir(home), `${slugify(name)}.json`);
}

/** Setups on this machine by name, with anything unreadable left out. */
export function listSetups(home: string = homedir()): string[] {
  const dir = setupsDir(home);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

export function readSetup(
  name: string,
  home: string = homedir(),
): Record<string, unknown> | null {
  const file = setupPath(name, home);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function writeSetup(
  name: string,
  setup: Record<string, unknown>,
  home: string = homedir(),
): string {
  const file = setupPath(name, home);
  mkdirSync(setupsDir(home), { recursive: true });
  writeFileSync(file, `${JSON.stringify(setup, null, 2)}\n`);
  return file;
}

/** The marker the template puts between the engine's prose and the pool's. */
export const CONFIG_MARKER =
  "<!-- ============================================================ CONFIG -->";

export interface AgentFill {
  contextFiles: string[];
  commitPrefix: string | null;
  reviewer?: string | undefined;
  checkpoint?: string | undefined;
}

/**
 * `AGENT.md` from the template: everything above the CONFIG marker exactly
 * as the template has it, because that half is the same in every runner,
 * and a filled-in version of the half below. The last section keeps its
 * placeholder: which tickets are expected to stop is a judgement about this
 * pool's work, and a script that guessed at it would be writing fiction.
 */
export function fillAgentTemplate(template: string, fill: AgentFill): string {
  const marker = template.indexOf(CONFIG_MARKER);
  const head =
    marker >= 0
      ? template.slice(0, marker + CONFIG_MARKER.length)
      : `${template.trimEnd()}\n\n${CONFIG_MARKER}`;
  const context =
    fill.contextFiles.length > 0
      ? fill.contextFiles.map((name) => `- \`${name}\`: (what it is for)`).join("\n")
      : "- (none found beside `issues/`; name them here as they arrive)";
  const constraints: string[] = [];
  if (fill.reviewer) constraints.push(`- reviewer: ${fill.reviewer}`);
  if (fill.checkpoint) constraints.push(`- checkpoint: ${fill.checkpoint}`);
  if (constraints.length === 0) {
    constraints.push("- (secrets files, external systems, environment quirks, known-red tests)");
  }
  const prefix = fill.commitPrefix ?? "<prefix>";
  return `${head}

Boot filled this in from detection and its interview. The \`my-console-runner\` skill
improves the prose; the engine's half above the marker stays as it is.

## Read before you touch anything

In this order: your ticket, then the files this pool's context lives in.

${context}

## Commit message format

\`\`\`
${prefix}: <what changed, in the imperative>
\`\`\`

## This pool's constraints

${constraints.join("\n")}

## Which tickets are expected to stop

- (name them, so a checkpoint on those reads as correct rather than as a failure)
`;
}

/**
 * An existing `AGENT.md` with the engine's half replaced by the template's
 * (issue #155): the template up to and including its CONFIG marker, then the
 * file's own bytes after its marker, untouched. Bytes rather than a string
 * so the pool's half survives exactly as written, whatever it holds. Null
 * when either side has no marker: a hand-written `AGENT.md` has no line
 * saying where the engine's half ends, so there is nothing safe to replace.
 */
export function refreshAgentHead(existing: Buffer, template: string): Buffer | null {
  const templateMarker = template.indexOf(CONFIG_MARKER);
  const marker = existing.indexOf(CONFIG_MARKER);
  if (templateMarker < 0 || marker < 0) return null;
  return Buffer.concat([
    Buffer.from(template.slice(0, templateMarker + CONFIG_MARKER.length), "utf8"),
    existing.subarray(marker + Buffer.byteLength(CONFIG_MARKER, "utf8")),
  ]);
}

function isResolverObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
