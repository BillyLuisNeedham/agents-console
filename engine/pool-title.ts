/**
 * The Pool title (issue #100): one line of free text the operator gives a
 * Pool so several running at once can be told apart. It is display-only. The
 * Pool's identity stays its directory, which never changes when the title
 * does, and no two titles are checked against each other.
 *
 * The title lives in the Pool's own `console.json` under `title`, written by
 * Boot when it creates the Pool and editable from the Settings pane. A Pool
 * with no title falls back to its directory's name wherever a title would
 * show. Nothing here ever makes a title up from the Pool's tickets or specs:
 * a title is the operator's word or it is absent.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * A title as it is kept: one line, runs of whitespace (newlines included)
 * collapsed to a single space and the ends trimmed. Empty is no title.
 */
export function normaliseTitle(value: string): string | null {
  const line = value.replace(/\s+/g, " ").trim();
  return line === "" ? null : line;
}

/** The title a parsed config carries, or null when it has none. */
export function titleOf(config: { title?: unknown } | null | undefined): string | null {
  const raw = config?.title;
  return typeof raw === "string" ? normaliseTitle(raw) : null;
}

/**
 * The title straight off disk, for the callers that hold no parsed config
 * (Boot's pick-a-pool list). A missing or unreadable file is no title rather
 * than an error: a broken config is Boot's to report when it reads the Pool
 * it is actually starting, not a reason to refuse to list the others.
 */
export function readPoolTitle(poolDir: string): string | null {
  const file = join(poolDir, "console.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return titleOf(parsed as { title?: unknown });
  } catch {
    return null;
  }
}

/**
 * The label a Pool workspace the Console created carries: the title, else
 * the directory's name, which is what every created workspace was labelled
 * before titles existed (ADR-0015).
 */
export function poolWorkspaceLabel(title: string | null, poolDir: string): string {
  return title ?? basename(poolDir);
}
