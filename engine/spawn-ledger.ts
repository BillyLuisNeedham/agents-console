/**
 * The Spawn ledger (issue #150, CONTEXT.md: Spawn ledger): one file in the
 * pool, `runs/spawn-ledger.md`, listing the work the pool has and the work
 * on its way: every Ticket and Conversation, every Pending spawn and every
 * Held spawn. Agents are taught its path and read it before they propose a
 * Spawn, so a second agent does not propose what the first already did, and
 * a proposal that still overlaps something there says so (`overlaps`) and is
 * held for the operator. The prompts carry the path, never the contents
 * (issue #84: prompts stay short, and a file can be current when the agent
 * reads it, where an inlined copy is as old as the prompt).
 *
 * The engine rewrites it whole, through a rename, whenever what it lists
 * changes; it is derived, never read back. Markdown, because an agent reads
 * a table at a glance and nothing parses it.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeldSpawn, HeldSpawnReason, PendingSpawn } from "./spawn-proposals.ts";

export function spawnLedgerPath(runsDir: string): string {
  return join(runsDir, "spawn-ledger.md");
}

export interface SpawnLedgerInput {
  tickets: { id: string; title: string; status: string }[];
  conversations: { id: string; title: string; status: string }[];
  pending: PendingSpawn[];
  held: HeldSpawn[];
}

// How much of a proposal's body the ledger shows: enough to tell two
// proposals apart, not the whole brief.
const SUMMARY_CHARS = 160;

/** A table cell: one line, and no pipe to split the row. */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function summary(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return cell(flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat);
}

/** Why a Held spawn waits, in the words the Console uses. */
export function heldReasonText(reason: HeldSpawnReason, overlaps: string[] = []): string {
  switch (reason) {
    case "per-attempt":
      return "per-attempt cap";
    case "per-run":
      return "per-run cap";
    case "overlaps":
      return `overlaps ${overlaps.join(", ")}`;
    case "operator":
      return "held by operator";
  }
}

/** A Spawn's file heads its title with its id ("07-spawn-1: Fix"); the
 *  ledger's id column already says that. */
function ticketTitle(id: string, title: string): string {
  return title.startsWith(`${id}: `) ? title.slice(id.length + 2) : title;
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_(none)_"];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

export function renderSpawnLedger(input: SpawnLedgerInput): string {
  const kind = (p: PendingSpawn | HeldSpawn) => p.proposal.kind ?? "ticket";
  return [
    "# Spawn ledger",
    "",
    "The work this pool has and the work on its way, rewritten by the engine " +
      "whenever it changes. Read it before you propose a Spawn. Do not propose " +
      "work listed here again. If a proposal still overlaps something listed, " +
      'name those ids in its "overlaps" and the operator decides whether it ' +
      "lands. Never edit this file.",
    "",
    "## Tickets",
    "",
    ...table(
      ["id", "status", "title"],
      input.tickets.map((t) => [cell(t.id), t.status, cell(ticketTitle(t.id, t.title))]),
    ),
    "",
    "## Conversations",
    "",
    ...table(
      ["id", "status", "title"],
      input.conversations.map((c) => [cell(c.id), c.status, cell(c.title)]),
    ),
    "",
    "## Pending spawns",
    "",
    "Proposals that land at the next super-step boundary.",
    "",
    ...table(
      ["id", "parent", "kind", "title", "summary"],
      input.pending.map((p) => [p.id, cell(p.parentId), kind(p), cell(p.proposal.title), summary(p.proposal.body)]),
    ),
    "",
    "## Held spawns",
    "",
    "Proposals waiting for the operator to adopt or discard them.",
    "",
    ...table(
      ["id", "parent", "kind", "reason", "title", "summary"],
      input.held.map((h) => [
        h.id,
        cell(h.parentId),
        kind(h),
        cell(heldReasonText(h.reason, h.proposal.overlaps)),
        cell(h.proposal.title),
        summary(h.proposal.body),
      ]),
    ),
    "",
  ].join("\n");
}

/** Replace the ledger whole, through a rename, so a reader never sees half. */
export function writeSpawnLedger(runsDir: string, text: string): void {
  mkdirSync(runsDir, { recursive: true });
  const path = spawnLedgerPath(runsDir);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
