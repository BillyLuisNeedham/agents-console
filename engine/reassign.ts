/**
 * Reassign (issue #126): the operator changing a Ticket's Assignment from
 * the Console by writing that Ticket's `assign` entry in `console.json`,
 * one Ticket from its Detail or many from the Pool settings. The engine
 * picks the write up at its next Config reload (ADR-0018), the same seam a
 * hand edit uses; nothing here touches the engine's scheduling.
 *
 * This module owns the wire types (re-exported from wire.ts), the
 * per-ticket eligibility and provenance the snapshot carries, and the
 * validated, atomic write of `assign` entries. It is the only writer of
 * `assign` inside the server, as pool-settings.ts is of the settings keys.
 */

import {
  assignmentViewOf,
  type Assignment,
  type AssignmentSource,
  type AssignmentSources,
  type AssignmentView,
} from "./assignment.ts";
import {
  engineTicketBuildId,
  resolvePoolAssignments,
  type HarnessCommand,
  type PoolConfig,
} from "./engine.ts";
import {
  readPoolSettings,
  requireKnownHarness,
  writeConfigAtomically,
} from "./pool-settings.ts";
import type { TicketMarker, TicketStatus } from "./pool.ts";
import { effortApplies, poolHarnessMode } from "./spawn.ts";

/** Where a resolved Assignment field came from, field by field: the
 *  ticket's own assign entry (pinned), its parent or build ticket
 *  (inherited), the pool defaults (default), or nowhere (unset). Declared
 *  in assignment.ts, beside the resolver whose layers it names. */
export type { AssignmentSource, AssignmentSources };

/**
 * The per-ticket Reassign view the snapshot carries on every ordinary
 * ticket (grader and head-to-head tickets are never reassignable and carry
 * `eligible: false` with a reason). `eligible` is the server's judgement
 * that a write would take effect at the next boundary: no Attempt in
 * flight and not done. `reason` explains a false `eligible` in one line
 * for the Detail pane. `verify` is the ticket's own verify count, which
 * has no default and so is pinned or absent. `sources` explains the
 * Assignment the card shows.
 */
export interface TicketReassignView {
  eligible: boolean;
  reason: string | null;
  verify: number | null;
  sources: AssignmentSources;
}

/**
 * The write body (PUT /api/reassign). `tickets` names the ids to change;
 * `fields` is tri-state per field: a key absent leaves that field alone,
 * a value sets it, and null clears the ticket's own entry for it so the
 * ticket follows its parent or the pool defaults again. `verify` is an
 * integer >= 1 or null to clear.
 */
export interface ReassignRequest {
  tickets: string[];
  fields: {
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
    drivers?: string | null;
    verify?: number | null;
  };
}

/**
 * The write's answer. A refused write (unknown ticket, unknown harness,
 * bad verify, or a ticket that would end up unassigned) is a 400 with
 * `{ error }` naming the ticket and nothing is written. Otherwise every
 * named ticket that is still eligible is written in one atomic file
 * replace and listed in `applied`; a ticket that stopped being eligible
 * between listing and saving is left alone and listed in `skipped` with
 * its reason. `snapshot` is the fresh enriched snapshot after the write, so
 * the Console pushes it through setSnapshot and the cards show the new
 * Assignment at once.
 */
export interface ReassignResponse {
  applied: string[];
  skipped: { id: string; reason: string }[];
  snapshot: import("./wire.ts").EnrichedSnapshot;
}

export type { AssignmentView };

/**
 * A console.json the server could not read at all, as opposed to a request
 * it refused. The route answers 500 for this one and 400 for every other
 * throw, matching GET /api/settings: the server booted off this file, so a
 * parse failure means it was edited into a broken state since, and that is
 * the server's problem to report rather than the operator's request to
 * blame.
 */
export class ConfigUnreadableError extends Error {}

/**
 * A request this module refused: an id the pool does not own, a harness it
 * does not know, a bad verify, a field an enlisted ticket cannot take, or a
 * write that would leave a ticket unassigned. The route answers 400 for
 * these and 500 for everything else, so an EACCES on the file or a pool that
 * never started is never reported back as the operator's mistake.
 */
export class ReassignRefusal extends Error {}

// The engine's `assign` entry, as this module reads and writes it. Declared
// here rather than exported from engine.ts because this is the only writer:
// engine.ts parses these fields, and nothing else builds one.
interface AssignEntry {
  harness?: string;
  model?: string;
  effort?: string;
  drivers?: string;
  verify?: number;
}

const ASSIGNMENT_FIELDS = ["harness", "model", "effort", "drivers"] as const;

// The view a ticket the resolver never reached gets: no layer answered for
// it, so nothing about its Assignment is this module's to explain.
const NO_SOURCES: AssignmentSources = {
  harness: "unset",
  model: "unset",
  effort: "unset",
  drivers: "unset",
};

/** One ticket's Reassign row: the wire view, plus the Assignment resolved
 *  from the config file as it stands now. `assignment` is null for a ticket
 *  that is not eligible, because there the engine's own frozen record is the
 *  truth and the file may already say something the run has not taken up. */
export interface TicketReassignEntry {
  reassign: TicketReassignView;
  assignment: AssignmentView | null;
}

export interface ReassignViewsInput {
  markers: TicketMarker[];
  /** The pool config as it is on disk now, or null when it would not parse. */
  config: PoolConfig | null;
  /** Why `config` is null, for the reason every ticket then carries. */
  configError: string | null;
  harnesses: Record<string, HarnessCommand>;
  /** The ticket ids with an Attempt in flight, from the engine's snapshot. */
  liveAttempts: ReadonlySet<string>;
  statuses: Readonly<Record<string, TicketStatus>>;
  /**
   * The engine's own resolved Assignment per ticket, from the same snapshot.
   * Not decoration: the engine's Config reload seeds every frozen ticket with
   * its existing record before resolving the rest (ADR-0018), so a child of a
   * frozen parent inherits the frozen value, not the file's. Resolving from
   * an empty map here would show the operator a value the engine will not
   * use.
   */
  engineAssignments: Readonly<Record<string, AssignmentView>>;
}

/**
 * The tickets the engine's next reload will NOT re-resolve, seeded with what
 * it holds for them now, exactly as reloadConfigAtBoundary seeds its own dry
 * run. In-flight is the server's view of the engine's adopted set; an
 * enlisted ticket is frozen for as long as the engine holds the pane it came
 * from, which the server cannot see the end of, so it is treated as frozen
 * throughout.
 */
function frozenSeed(
  markers: TicketMarker[],
  liveAttempts: ReadonlySet<string>,
  engineAssignments: Readonly<Record<string, AssignmentView>>,
  options: { enlisted: boolean },
): Map<string, Assignment> {
  const seed = new Map<string, Assignment>();
  for (const marker of markers) {
    const frozen = liveAttempts.has(marker.id) ||
      (options.enlisted && marker.enlistedFrom !== undefined);
    if (!frozen) continue;
    const view = engineAssignments[marker.id];
    if (!view) continue;
    // The wire renders an unassigned field as null; the resolver's own
    // record spells it as the empty string.
    seed.set(marker.id, {
      harness: view.harness ?? "",
      model: view.model ?? "",
      ...(view.effort ? { effort: view.effort } : {}),
      drivers: view.drivers,
    });
  }
  return seed;
}

/**
 * Every ticket's Reassign row, from the config file rather than from the
 * engine's session: a saved Reassign shows on the card at once instead of at
 * the next boundary. Pure, so the eligibility rules table-test without a
 * server.
 *
 * A config that will not parse or will not resolve makes every ticket
 * ineligible with that error as the reason. The engine rejects a Config
 * reload whole for the same failures (ADR-0018), so the pool is already
 * running on the last good config; offering a Reassign on top of a file in
 * that state would write into something the engine is refusing.
 */
export function reassignViews(
  input: ReassignViewsInput,
): Map<string, TicketReassignEntry> {
  const { markers, config, liveAttempts, statuses } = input;
  let resolved: ReturnType<typeof resolvePoolAssignments> | null = null;
  let failure = input.configError;
  if (config && failure === null) {
    try {
      resolved = resolvePoolAssignments(
        markers,
        config,
        input.harnesses,
        frozenSeed(markers, liveAttempts, input.engineAssignments, { enlisted: true }),
      );
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
  }

  const views = new Map<string, TicketReassignEntry>();
  for (const marker of markers) {
    const sources = resolved?.sources.get(marker.id) ?? NO_SOURCES;
    const judgement = failure
      ? { eligible: false, reason: `the pool config does not resolve: ${failure}` }
      : eligibilityOf(marker, liveAttempts, statuses[marker.id] ?? "ready");
    // An enlisted ticket's verify is stripped by the engine (issue #101), so
    // whatever the file says it is not this ticket's verify count and the
    // Detail must not offer it as one.
    const verify =
      marker.enlistedFrom !== undefined ? null : verifyOf(config?.assign?.[marker.id]);
    const assignment = resolved?.assignments.get(marker.id);
    const mode = poolHarnessMode(config?.terminal);
    views.set(marker.id, {
      reassign: { ...judgement, verify, sources },
      assignment:
        judgement.eligible && assignment
          ? assignmentViewOf(
              assignment,
              effortApplies(input.harnesses, assignment.harness, mode),
            )
          : null,
    });
  }
  return views;
}

/**
 * Whether a write to this ticket's assign entry would reach the run, and
 * the one line the Detail shows when it would not.
 *
 * Grader and head-to-head tickets are the engine's own (engineTicketBuildId):
 * they take their harness and model from the build ticket, so reassigning the
 * builder is how an operator moves them. An Attempt in flight froze its
 * Assignment at spawn (ADR-0018) and a done ticket will not run again, so
 * neither has anything to pick a write up with.
 *
 * Enlisted is a note rather than a refusal, but a narrow one: the engine
 * records an enlisted ticket's Assignment as found (issue #101), keeping only
 * the harness from the config and forcing model, effort, drivers and verify
 * itself, so the harness is the one field a Reassign can move. The ticket also stays
 * frozen while the engine holds the pane it was enlisted from, which can
 * outlive the attempt, so even that save lands in the file and waits.
 */
function eligibilityOf(
  marker: TicketMarker,
  liveAttempts: ReadonlySet<string>,
  status: TicketStatus,
): { eligible: boolean; reason: string | null } {
  if (engineTicketBuildId(marker.id) !== null) {
    return {
      eligible: false,
      reason: "the engine runs this one and assigns it from its build ticket",
    };
  }
  if (liveAttempts.has(marker.id)) {
    return { eligible: false, reason: "an Attempt is running" };
  }
  if (status === "done" || status === "closed") return { eligible: false, reason: status };
  if (marker.enlistedFrom !== undefined) {
    return {
      eligible: true,
      reason:
        "enlisted: only the harness can change, and it waits until the engine releases it",
    };
  }
  return { eligible: true, reason: null };
}

// A verify the file actually carries. Anything else reads as absent here;
// the resolver is what refuses a malformed one, and it refuses the pool.
function verifyOf(entry: AssignEntry | undefined): number | null {
  const verify = entry?.verify;
  return typeof verify === "number" && Number.isInteger(verify) && verify >= 1
    ? verify
    : null;
}

export interface ReassignContext {
  markers: TicketMarker[];
  harnesses: Record<string, HarnessCommand>;
  liveAttempts: ReadonlySet<string>;
  statuses: Readonly<Record<string, TicketStatus>>;
  /** The engine's resolved Assignment per ticket, for the frozen seed the
   *  dry run shares with the engine's own reload. */
  engineAssignments: Readonly<Record<string, AssignmentView>>;
}

export interface ReassignOutcome {
  applied: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Write the named tickets' `assign` entries, or refuse the whole request.
 *
 * Validation comes first and covers the request as a whole: an id the pool
 * does not own, a harness this pool does not know, a verify that is not an
 * integer >= 1, and a dry run of the resulting config that would leave a
 * named ticket with no harness or model. Any of those throws naming the
 * ticket and writes nothing, because a half-applied bulk Reassign is worse
 * than a refused one: the operator would have to work out which rows landed.
 *
 * A ticket that stopped being eligible between the listing and the save (its
 * Attempt started in between) is not a refusal, it is a race the operator did
 * not lose anything to: it is left alone and named in `skipped`.
 *
 * The write itself is one atomic replace of the whole file, read fresh from
 * disk rather than from the snapshot's config, merging only the named
 * entries' named fields. Every other entry, and every key outside `assign`,
 * rides through untouched.
 */
export function writeReassign(
  poolDir: string,
  request: ReassignRequest,
  context: ReassignContext,
): ReassignOutcome {
  const ids = requestedIds(request);
  const fields = normaliseFields(request.fields, Object.keys(context.harnesses));

  let config: PoolConfig;
  try {
    config = readPoolSettings(poolDir).config;
  } catch (err) {
    throw new ConfigUnreadableError(err instanceof Error ? err.message : String(err));
  }

  const views = reassignViews({
    markers: context.markers,
    config,
    configError: null,
    harnesses: context.harnesses,
    liveAttempts: context.liveAttempts,
    statuses: context.statuses,
    engineAssignments: context.engineAssignments,
  });

  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const view = views.get(id);
    if (!view) throw new ReassignRefusal(`reassign: unknown ticket '${id}'`);
    if (view.reassign.eligible) applied.push(id);
    else skipped.push({ id, reason: view.reassign.reason ?? "not reassignable" });
  }
  refuseEnlistedFields(applied, fields, context.markers);
  if (applied.length === 0) return { applied, skipped };

  const next = mergedConfig(config, applied, fields);
  dryRun(next, applied, context);
  writeConfigAtomically(poolDir, next);
  return { applied, skipped };
}

// The harness is the only field an enlisted ticket can take (issue #101):
// the engine records its Assignment as found, forcing model, effort, drivers
// and verify itself whatever the file says (an enlisted pane runs as found,
// so effort never applies to it). A write of any of those would sit in
// console.json looking applied and change nothing, so it is refused here
// rather than accepted and quietly ignored.
function refuseEnlistedFields(
  ids: string[],
  fields: ReassignRequest["fields"],
  markers: TicketMarker[],
): void {
  const forced = (["model", "effort", "drivers", "verify"] as const).filter((f) => f in fields);
  if (forced.length === 0) return;
  const enlisted = new Set(
    markers.filter((m) => m.enlistedFrom !== undefined).map((m) => m.id),
  );
  for (const id of ids) {
    if (!enlisted.has(id)) continue;
    throw new ReassignRefusal(
      `reassign: ticket '${id}' is enlisted: only harness can be reassigned ` +
        `(this request names ${forced.join(", ")})`,
    );
  }
}

// The ids the body named, checked for shape here so the route's type guard
// stays a type guard and every caller of this module gets the same refusal.
function requestedIds(request: ReassignRequest): string[] {
  const ids = request?.tickets;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id === "")) {
    throw new ReassignRefusal("reassign: tickets must be an array of ticket ids");
  }
  if (ids.length === 0) throw new ReassignRefusal("reassign: name at least one ticket");
  return [...new Set(ids)];
}

// The tri-state fields, validated. A key absent stays absent (leave the
// field alone); null and the empty string are both a clear, the same way an
// empty value clears a Pool setting; a named harness must be one this pool
// knows, since a reassign onto a harness that is not there would fail the
// engine's next reload and take the whole pool's reassignment with it.
function normaliseFields(
  raw: ReassignRequest["fields"],
  harnesses: string[],
): ReassignRequest["fields"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ReassignRefusal("reassign: fields must be an object");
  }
  const out: ReassignRequest["fields"] = {};
  for (const field of ASSIGNMENT_FIELDS) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value === null || value === undefined) {
      out[field] = null;
      continue;
    }
    if (typeof value !== "string") {
      throw new ReassignRefusal(`reassign: ${field} must be a string or null`);
    }
    const trimmed = value.trim();
    out[field] = trimmed === "" ? null : trimmed;
  }
  if (out.harness) {
    try {
      requireKnownHarness("reassign: harness", out.harness, harnesses);
    } catch (err) {
      throw new ReassignRefusal(err instanceof Error ? err.message : String(err));
    }
  }
  if ("verify" in raw) {
    const verify = raw.verify;
    if (verify === null || verify === undefined) out.verify = null;
    else if (!Number.isInteger(verify) || (verify as number) < 1) {
      throw new ReassignRefusal(
        `reassign: verify must be an integer >= 1 or null (got ${JSON.stringify(verify)})`,
      );
    } else out.verify = verify;
  }
  return out;
}

// The config the write will put on disk: the file as read, with only the
// named tickets' entries merged. An entry left with no fields is removed
// rather than left as `{}`, and an `assign` map left with no entries goes
// with it, the same way the Settings pane drops an all-empty `defaults`.
function mergedConfig(
  config: PoolConfig,
  ids: string[],
  fields: ReassignRequest["fields"],
): PoolConfig {
  const assign: Record<string, AssignEntry> = { ...(config.assign ?? {}) };
  for (const id of ids) {
    const entry: AssignEntry = { ...(assign[id] ?? {}) };
    for (const field of ASSIGNMENT_FIELDS) {
      if (!(field in fields)) continue;
      const value = fields[field];
      if (value === null) delete entry[field];
      else entry[field] = value;
    }
    if ("verify" in fields) {
      if (fields.verify === null) delete entry.verify;
      else entry.verify = fields.verify!;
    }
    if (Object.keys(entry).length === 0) delete assign[id];
    else assign[id] = entry;
  }
  const next: PoolConfig = { ...config };
  if (Object.keys(assign).length === 0) delete next.assign;
  else next.assign = assign;
  return next;
}

// The proposed file, resolved before it is written: the engine rejects a
// Config reload whole when any ticket fails to resolve (ADR-0018), so a
// write that would not resolve does not fail this one ticket, it stops every
// ticket in the pool from being reassigned until someone hand-edits the file.
// Cheaper to refuse it here, naming the ticket.
function dryRun(config: PoolConfig, ids: string[], context: ReassignContext): void {
  // Seeded with the in-flight records the engine will hold onto, so a child
  // of a frozen parent is checked against what it will actually inherit. The
  // enlisted are deliberately left out of this seed: a named enlisted ticket
  // is exactly the one whose new harness has to be checked against how the
  // engine will resolve it once it lets the ticket go.
  const resolved = resolvePoolAssignments(
    context.markers,
    config,
    context.harnesses,
    frozenSeed(context.markers, context.liveAttempts, context.engineAssignments, {
      enlisted: false,
    }),
  );
  const enlisted = new Set(
    context.markers.filter((m) => m.enlistedFrom !== undefined).map((m) => m.id),
  );
  for (const id of ids) {
    const assignment = resolved.assignments.get(id);
    if (!assignment) continue;
    if (!assignment.harness) {
      throw new ReassignRefusal(
        `reassign: ticket '${id}' would be left with no harness ` +
          "(set one, or leave the field alone so it follows the pool defaults)",
      );
    }
    // An enlisted ticket's model is empty by the as-found rule (issue #101),
    // never by anything a Reassign did, so it is not evidence of a bad write.
    if (!assignment.model && !enlisted.has(id)) {
      throw new ReassignRefusal(
        `reassign: ticket '${id}' would be left with no model ` +
          "(set one, or leave the field alone so it follows the pool defaults)",
      );
    }
  }
}
