/**
 * Notices (the Conversations ADR, docs/adr/0018-conversations-beside-
 * tickets.md; CONTEXT.md: Notice): the Turn the engine types into a parent
 * Conversation when something it spawned ends. This file is the Notice
 * itself and the text it carries; the queue, delivery and dropping live
 * with the Conversation that owns them (engine/conversations.ts). Imports
 * nothing from the engine, so the text is trivial to test alone.
 */

import { git } from "./worktrees.ts";

export interface Notice {
  to: string;
  from: string;
  /**
   * "ticket-ended" and "conversation-ended" are the two things a spawned
   * child reports back. "enlist-teaching" and "opening-turn" are the Turns an
   * enlisted Conversation starts with (issue #101): the operator's opening
   * Turn and the Spawn teaching travel the same queue-then-deliver path as a
   * Notice, so both land only while the pane is waiting.
   * "steward-interrupt" and "steward-merge-stall" are what a Steward is told
   * about (ADR-0030): a pending Ticket Interrupt, and a stalled Merge queue
   * head; "steward-merged" and "steward-pool" only inform it: a Ticket that
   * merged, and the pool reaching Review. `from` names the Ticket, so its
   * log records the telling (the Steward itself for the pool's own).
   */
  kind:
    | "ticket-ended"
    | "conversation-ended"
    | "enlist-teaching"
    | "opening-turn"
    | "steward-interrupt"
    | "steward-merge-stall"
    | "steward-merged"
    | "steward-pool";
  text: string;
  /** A Steward Notice's item key (steward.ts's StewardItem): delivery checks
   *  the item is still pending, and types its current text. */
  key?: string;
}

/**
 * A Conversation whose Notices keep failing to land (ADR-0030's live e2e):
 * since when, and why the last try failed. Turn state can read "waiting"
 * while something in the pane (a Blocking dialog the engine never answers)
 * swallows every Turn, so the failure is shown rather than retried
 * invisibly. Cleared by the first Notice that lands.
 */
export interface NoticeDelivery {
  failingSince: string;
  lastError: string;
}

export function diffStatSummary(cwd: string, range: string): string {
  const probe = git(cwd, ["diff", "--stat", range]);
  const out = probe.ok ? probe.out.trim() : "";
  return out || "(no changes)";
}

export function ticketEndedNoticeText(params: {
  id: string;
  title: string;
  outcome: "done" | "checkpoint";
  brief?: string;
  branch: string;
  diffStat: string;
}): string {
  const lines = [`Ticket ${params.id} ("${params.title}") ended: ${params.outcome}.`];
  if (params.outcome === "checkpoint") {
    lines.push(`Brief: ${(params.brief ?? "").trim() || "(none written)"}`);
  }
  lines.push(`Branch: ${params.branch}`);
  lines.push(`Diff:\n${params.diffStat}`);
  return lines.join("\n");
}

// A spawned Ticket closed at an Interrupt (issue #154): it ended without
// merging, so there is no branch or diff to report, only that it was
// dropped and the note it was dropped with.
export function ticketClosedNoticeText(params: {
  id: string;
  title: string;
  note?: string;
}): string {
  const lines = [`Ticket ${params.id} ("${params.title}") was closed: its work was not merged.`];
  if (params.note?.trim()) lines.push(`Close note: ${params.note.trim()}`);
  return lines.join("\n");
}

export function conversationEndedNoticeText(params: {
  branch: string;
  closing?: string;
}): string {
  const lines = ["A Conversation you spawned was ended by the operator."];
  lines.push(`Branch: ${params.branch}`);
  if (params.closing?.trim()) lines.push(`Closing note: ${params.closing.trim()}`);
  return lines.join("\n");
}
