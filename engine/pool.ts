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
  return { id, file, blockedBy, status: status as TicketStatus };
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
  }
  return markers;
}
