/**
 * The Evidence builder for the Jev grader (ADR-0023,
 * docs/adr/0023-jev-grades-attempts-engine-owned-rubric.md; the bench is
 * docs/research/jev-grader-bench/REPORT.md section 2).
 *
 * One named JSON object per Attempt: the Ticket text, the agent's summary
 * under a field that says "claim", the changed lines of the diff, and the
 * tail of the ANSI-stripped log. Every part is trimmed, because Jev's window
 * is 32k tokens of Evidence plus the longest question and accuracy falls as
 * unrelated content grows. The function is pure: strings in, the Evidence
 * object plus its two notes out, so it tests without git or files on disk.
 *
 * The budget is enforced on the stringified object, at 100,000 characters
 * (about 29k tokens at the measured 3.5 characters per token), leaving room
 * for the longest question. The diff is head-cut to whatever the cap leaves
 * after the other fields, never below 2,000 characters; when even that does
 * not fit (a huge Ticket), the log tail shrinks by 15% steps to a 4,000
 * character floor. The engine keeps the raw log and full-context diff aside
 * so the one widening re-ask (low ticket-fit confidence on trimmed Evidence)
 * can rebuild with a wider tail and the diff's context lines.
 */

import type { Evidence } from "./jev.ts";

/** The stringified Evidence cap, before the longest question is added. */
export const EVIDENCE_CAP_CHARS = 100_000;
/** The Ticket text kept, from the front: title, goal and criteria come first. */
export const TICKET_CHARS = 20_000;
/** The agent summary kept, from the front. */
export const SUMMARY_CHARS = 4_000;
/** The log tail kept on the base budget. */
export const LOG_TAIL_CHARS = 20_000;
/** The log tail the one widening re-ask may use. */
export const LOG_WIDENED_TAIL_CHARS = 80_000;
/** The diff is never cut below this many characters. */
export const DIFF_FLOOR_CHARS = 2_000;
/** The floor the log shrinks to when the other fields alone fill the cap. */
export const LOG_FLOOR_CHARS = 4_000;

export interface EvidenceInput {
  /** The Ticket file text, whole. */
  ticket: string;
  /** The Outcome summary verbatim: a claim, not evidence. */
  summary: string;
  /**
   * The Attempt diff. Empty when `diffReason` is set (there was no diff to
   * read); changed lines only (`git diff -U0`) on the base budget, with
   * context lines on the widened one.
   */
  diff: string;
  /** Why there is no diff, when there is none, in `attemptDiff`'s wording. */
  diffReason: string | null;
  /** The Attempt log, raw (ANSI escapes are stripped here). */
  log: string;
  /** True for the one widening re-ask: an 80,000-character tail. */
  widened?: boolean;
}

export interface BuiltEvidence {
  evidence: Evidence;
  diffNote: string;
  logNote: string;
  /**
   * The Evidence was trimmed: the diff cut, or the log tail shorter than the
   * log. This is what gates the widening re-ask, never the Ticket's own cap.
   */
  trimmed: boolean;
  diffTrimmed: boolean;
  logTrimmed: boolean;
  /** The log tail the base budget would have kept, for `logWasTrimmed`. */
  baseLogChars: number;
}

/** Strip ANSI escape sequences: OSC, CSI, and the short single-character forms. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/**
 * The last `max` characters, cut forward to a line boundary so the tail
 * starts at the beginning of a line. Forward, not back: an incomplete first
 * line is dropped rather than shown torn.
 */
export function tailToLineBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  let tail = text.slice(-max);
  const newline = tail.indexOf("\n");
  if (newline > -1 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return tail;
}

/**
 * The file paths whose diff is pure noise to a grader: lockfiles, snapshots
 * and generated output. Dropped whole, hunk and header lines together, so a
 * diff the grader reads is the work, not the machinery around it.
 */
const DROPPED_FILE = [
  /(^|\/)bun\.lockb?$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.generated\./,
  /(^|\/)node_modules\//,
];

function isDroppedDiffPath(header: string): boolean {
  // `diff --git a/<path> b/<path>`: the `b/` side names the file after change.
  const match = / b\/(.+)$/.exec(header);
  const path = (match?.[1] ?? header).trim();
  return DROPPED_FILE.some((pattern) => pattern.test(path));
}

/** Drop each file's diff section whose path is lockfile, snapshot or generated. */
export function dropGeneratedDiffs(diff: string): string {
  if (!diff) return diff;
  const lines = diff.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      dropping = isDroppedDiffPath(line);
      if (dropping) continue;
    }
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

function diffNoteFor(
  reason: string | null,
  shown: number,
  total: number,
  widened: boolean,
): string {
  if (reason !== null) return `no diff: ${reason}`;
  // The note names the diff the grader actually reads: `-U0` changed lines on
  // the base budget, context lines on the widening re-ask (ADR-0023).
  const base = widened ? "the full diff, with context lines" : "changed lines only, no context lines";
  if (shown < total) return `${base}; the diff was cut after its first ${shown} characters of ${total}`;
  return base;
}

function logNoteFor(shown: number, total: number): string {
  if (shown >= total) return "the whole log";
  return `the log was trimmed to its last ${shown} characters of ${total}`;
}

function serializedSize(
  ticket: string,
  summary: string,
  diff: string,
  diffNote: string,
  log: string,
  logNote: string,
): number {
  return JSON.stringify({
    ticket,
    agent_summary_claim: summary,
    diff,
    diff_note: diffNote,
    log,
    log_note: logNote,
  }).length;
}

/**
 * Build one Attempt's Evidence under a cap. Deterministic and total: any
 * input yields an Evidence object, with the notes saying exactly what was
 * trimmed, so the Grade can always record which budget it came from.
 */
export function buildEvidence(input: EvidenceInput): BuiltEvidence {
  const ticket = input.ticket.slice(0, TICKET_CHARS);
  const summary = input.summary.slice(0, SUMMARY_CHARS);
  const stripped = stripAnsi(input.log);
  const rawDiff = input.diffReason !== null ? "" : dropGeneratedDiffs(input.diff);
  const widened = input.widened === true;

  let logBudget = widened ? LOG_WIDENED_TAIL_CHARS : LOG_TAIL_CHARS;
  let log = tailToLineBoundary(stripped, logBudget);

  // The diff gets whatever the cap leaves after the other fields, notes
  // included, but never less than the floor. A little slack covers the note
  // growing when the diff turns out to be cut.
  const fixedSize = serializedSize(
    ticket,
    summary,
    "",
    diffNoteFor(input.diffReason, 0, rawDiff.length, widened),
    log,
    logNoteFor(log.length, stripped.length),
  );
  let diffCap = Math.max(DIFF_FLOOR_CHARS, EVIDENCE_CAP_CHARS - fixedSize - 256);
  let diff = rawDiff.length > diffCap ? rawDiff.slice(0, diffCap) : rawDiff;

  // Then, if the whole object still overruns (a Ticket near its own cap plus
  // a floor diff), shrink the log tail by 15% steps, never below the floor.
  for (let pass = 0; pass < 40; pass++) {
    const size = serializedSize(
      ticket,
      summary,
      diff,
      diffNoteFor(input.diffReason, diff.length, rawDiff.length, widened),
      log,
      logNoteFor(log.length, stripped.length),
    );
    if (size <= EVIDENCE_CAP_CHARS) break;
    if (log.length <= LOG_FLOOR_CHARS) break;
    const next = Math.max(LOG_FLOOR_CHARS, Math.floor(log.length * 0.85));
    if (next >= log.length) break;
    logBudget = next;
    log = tailToLineBoundary(stripped, logBudget);
  }

  const diffTrimmed = diff.length < rawDiff.length;
  const logTrimmed = log.length < stripped.length;
  const diffNote = diffNoteFor(input.diffReason, diff.length, rawDiff.length, widened);
  const logNote = logNoteFor(log.length, stripped.length);
  return {
    evidence: {
      ticket,
      agent_summary_claim: summary,
      diff,
      diff_note: diffNote,
      log,
      log_note: logNote,
    },
    diffNote,
    logNote,
    trimmed: diffTrimmed || logTrimmed,
    diffTrimmed,
    logTrimmed,
    baseLogChars: tailToLineBoundary(stripped, LOG_TAIL_CHARS).length,
  };
}
