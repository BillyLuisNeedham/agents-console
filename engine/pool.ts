import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnAssignRequest } from "./assignment.ts";
import { cachedByStamp } from "./stat-cache.ts";

const TICKET_STATUSES = [
  "ready",
  "in-progress",
  "done",
  "checkpoint",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface TicketMarker {
  id: string;
  file: string;
  blockedBy: string[];
  status: TicketStatus;
  /** The issue file's title: its first "# " heading, or "(untitled)". */
  title: string;
  /** The issue body after the title heading and its leading blank line. */
  spec: string;
  /**
   * Set on engine-adopted spawn tickets (ADR-0010): the id of the ticket
   * whose attempt proposed this one. The engine writes the field; the
   * -spawn- namespace is reserved for files that carry it.
   */
  spawnedBy?: string;
  /**
   * Set on engine-enlisted tickets (issue #101): the herdr pane the operator
   * picked. The engine writes the field; the `enlist-` namespace is reserved
   * for files that carry it.
   */
  enlistedFrom?: string;
  /**
   * Set on engine-adopted spawn tickets whose proposal carried an `assign`
   * (issue #116): the child's requested Assignment, persisted so every
   * resolution pass honours it, not only the run that adopted it. It ranks
   * under the operator's console.json assign entry for the id and over the
   * parent's Assignment. The engine writes the field.
   */
  spawnAssign?: SpawnAssignRequest;
}

const SPAWN_ASSIGN_FIELDS = ["harness", "model", "effort", "drivers"] as const;

// The marker carries the request as one whitespace-free token (the marker
// line is split on whitespace, and `drivers` may contain a space), so it is
// encoded JSON rather than raw. These two functions are the only codec.
export function encodeSpawnAssign(assign: SpawnAssignRequest): string {
  return encodeURIComponent(JSON.stringify(assign));
}

function decodeSpawnAssign(raw: string, file: string): SpawnAssignRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new Error(`pool load: ${file}: spawn-assign is not valid encoded JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pool load: ${file}: spawn-assign must be a JSON object`);
  }
  const a = parsed as Record<string, unknown>;
  const request: SpawnAssignRequest = {};
  for (const field of SPAWN_ASSIGN_FIELDS) {
    const value = a[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new Error(`pool load: ${file}: spawn-assign.${field} is not a string`);
    }
    request[field] = value;
  }
  return request;
}

export const MARKER_RE = /^<!--\s*state:\s*(.+?)\s*-->\s*$/;

function parseMarkerLine(
  line: string,
  file: string,
): Omit<TicketMarker, "title" | "spec"> {
  const match = MARKER_RE.exec(line);
  if (!match) {
    throw new Error(
      `pool load: ${file} has no line-1 state marker ` +
        `(expected <!-- state: id=.. blocked-by=.. status=.. -->)`,
    );
  }
  const fields = new Map<string, string>();
  for (const pair of match[1].split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) fields.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const id = fields.get("id");
  const status = fields.get("status");
  if (!id) throw new Error(`pool load: ${file}: marker is missing id=`);
  if (!status || !(TICKET_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `pool load: ${file}: marker status must be one of ${TICKET_STATUSES.join("|")}, got '${status ?? ""}'`,
    );
  }
  const blockedRaw = fields.get("blocked-by") ?? "none";
  const blockedBy =
    blockedRaw === "none" ? [] : blockedRaw.split(",").filter(Boolean);
  const spawnedBy = fields.get("spawned-by");
  const enlistedFrom = fields.get("enlisted-from");
  const spawnAssignRaw = fields.get("spawn-assign");
  return {
    id,
    file,
    blockedBy,
    status: status as TicketStatus,
    ...(spawnedBy ? { spawnedBy } : {}),
    ...(enlistedFrom ? { enlistedFrom } : {}),
    ...(spawnAssignRaw !== undefined
      ? { spawnAssign: decodeSpawnAssign(spawnAssignRaw, file) }
      : {}),
  };
}

// The issue file's heading grammar, parsed here beside the marker loading:
// the title is the first "# " heading, the spec everything after it. One
// parser owns this format, so a heading-format change breaks exactly here.
function readTitle(lines: string[]): string {
  const firstHeading = lines.find((line) => line.startsWith("# "));
  if (!firstHeading) return "(untitled)";
  return firstHeading.replace(/^#\s+/, "").trim();
}

function readSpec(lines: string[]): string {
  const headingIndex = lines.findIndex((line) => line.startsWith("# "));
  return lines.slice(headingIndex + 1).join("\n").trim();
}

export function readMarker(file: string): TicketMarker {
  const lines = readFileSync(file, "utf8").split("\n");
  const marker = parseMarkerLine(lines[0], file);
  return { ...marker, title: readTitle(lines), spec: readSpec(lines) };
}

// Every load re-reads the issues directory, and the server loads on every
// snapshot (issue #157): a file whose stamp has not moved since its last
// parse is served from that parse, a changed one is parsed afresh.
const readMarkerCached = cachedByStamp(readMarker);

export function writeMarkerStatus(file: string, status: TicketStatus): void {
  const raw = readFileSync(file, "utf8");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(newline);
  if (!MARKER_RE.test(lines[0])) {
    throw new Error(`marker write: ${file} has no line-1 state marker`);
  }
  lines[0] = lines[0].replace(/status=[a-z-]+/, `status=${status}`);
  writeFileSync(file, lines.join(newline));
}

// The engine's own id convention for adopted spawn tickets (ADR-0010):
// `<parent-id>-spawn-N`, N counting per parent across the run. The namespace
// is reserved alongside `-grader-N`: engine scheduling never treats a spawned
// ticket specially (it is ordinary), but hand-written tickets may not use it.
const SPAWN_ID_RE = /^(.+)-spawn-(\d+)$/;

export function parseSpawnId(id: string): { parent: string; n: number } | null {
  const match = SPAWN_ID_RE.exec(id);
  if (!match) return null;
  return { parent: match[1], n: Number(match[2]) };
}

// The engine's id convention for an enlisted ticket (issue #101): `enlist-N`,
// N counting per pool across the run. Reserved the same way as `-spawn-N`, so
// a hand-written ticket may not claim the namespace: an enlisted file carries
// the pane it came from as `enlisted-from=<paneId>`, and one without it fails
// the load.
const ENLIST_ID_RE = /^enlist-(\d+)$/;

/** The N of an `enlist-N` id, or null when the id is not one. Exported so the
 *  engine mints the next id from this one definition, as it does for Spawn. */
export function parseEnlistId(id: string): number | null {
  const match = ENLIST_ID_RE.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * `loadPoolMarkers`'s optional third argument: the ids of every Conversation
 * the pool knows about (engine/conversations.ts's loadConversations, called
 * by engine.ts before this so a ticket spawned mid-Conversation survives a
 * restart). A ticket's `spawned-by` may name one of these the same way it
 * names a ticket id (the Conversations ADR): Conversations spawn Tickets
 * through the same propose-and-adopt seam ADR-0010 gave Tickets, so the
 * reserved `-spawn-` namespace's parent is not always a ticket in `markers`.
 * pool.ts has no import on conversations.ts (that would cycle back through
 * engine.ts), so the caller resolves and passes the set rather than this
 * module loading it itself.
 */
export interface LoadPoolMarkersOptions {
  // The Conversations ADR: a pool that is nothing but Conversations has no
  // Tickets at all, ever, and that is not the "no Issue files yet" mistake
  // the bare throw below exists to catch (a pool directory pointed at by
  // accident, or set up wrong) — it is a legitimate empty ready set from the
  // first boot on. The caller (engine.ts's startPool) sets this once it has
  // established the pool actually has a conversations/ directory, or a
  // caller (a test, a future "start with no tickets yet" flow) asks for it
  // directly; pool.ts has no way to tell the two apart on its own since it
  // only ever sees issuesDir.
  allowEmptyIssues?: boolean;
}

export function loadPoolMarkers(
  issuesDir: string,
  knownParents?: Set<string>,
  options?: LoadPoolMarkersOptions,
): TicketMarker[] {
  const files = existsSync(issuesDir)
    ? readdirSync(issuesDir)
        .filter((file) => file.endsWith(".md"))
        .sort()
    : [];
  if (files.length === 0) {
    if (options?.allowEmptyIssues) return [];
    throw new Error(
      `pool load: no Issue files in ${issuesDir} (a Seeded Pool, which starts ` +
        "with no Tickets and grows by Enlist and Spawn, opts in by having a " +
        "conversations/ directory)",
    );
  }
  const markers = files.map((file) => readMarkerCached(join(issuesDir, file)));
  const seen = new Set<string>();
  for (const marker of markers) {
    if (seen.has(marker.id)) {
      throw new Error(`pool load: duplicate ticket id '${marker.id}'`);
    }
    seen.add(marker.id);
    // The reservation, enforced here so every reader of the pool (engine,
    // server, rehydrate) rejects the same files for the same reason: an id in
    // the engine's spawn namespace must carry the marker field the engine
    // writes and name the ticket the id already names. A hand-written file
    // without it fails the load; the engine's own files re-load cleanly.
    const spawn = parseSpawnId(marker.id);
    if (!spawn) {
      if (ENLIST_ID_RE.test(marker.id) && marker.enlistedFrom === undefined) {
        throw new Error(
          `pool load: ${marker.file}: the 'enlist-' id namespace is reserved ` +
            "for engine-enlisted tickets (issue #101); a hand-written ticket " +
            "may not use it, and an enlisted one carries " +
            "enlisted-from=<paneId> in its marker",
        );
      }
      continue;
    }
    if (marker.spawnedBy !== spawn.parent) {
      throw new Error(
        `pool load: ${marker.file}: the '-spawn-' id namespace is reserved ` +
          "for engine-adopted tickets (ADR-0010); a hand-written ticket may " +
          "not use it, and an adopted one carries spawned-by=" +
          `${spawn.parent} in its marker`,
      );
    }
    if (
      !markers.some((m) => m.id === marker.spawnedBy) &&
      !knownParents?.has(marker.spawnedBy)
    ) {
      throw new Error(
        `pool load: ${marker.file}: spawned-by '${marker.spawnedBy}' ` +
          "names no ticket or known Conversation in the pool",
      );
    }
  }
  return markers;
}
