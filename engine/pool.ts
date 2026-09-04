import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  return {
    id,
    file,
    blockedBy,
    status: status as TicketStatus,
    ...(spawnedBy ? { spawnedBy } : {}),
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

export function loadPoolMarkers(issuesDir: string): TicketMarker[] {
  const files = readdirSync(issuesDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length === 0) {
    throw new Error(`pool load: no Issue files in ${issuesDir}`);
  }
  const markers = files.map((file) => readMarker(join(issuesDir, file)));
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
    if (!spawn) continue;
    if (marker.spawnedBy !== spawn.parent) {
      throw new Error(
        `pool load: ${marker.file}: the '-spawn-' id namespace is reserved ` +
          "for engine-adopted tickets (ADR-0010); a hand-written ticket may " +
          "not use it, and an adopted one carries spawned-by=" +
          `${spawn.parent} in its marker`,
      );
    }
    if (!markers.some((m) => m.id === marker.spawnedBy)) {
      throw new Error(
        `pool load: ${marker.file}: spawned-by '${marker.spawnedBy}' ` +
          "names no ticket in the pool",
      );
    }
  }
  return markers;
}
