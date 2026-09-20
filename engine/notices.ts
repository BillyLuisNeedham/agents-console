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
   */
  kind:
    | "ticket-ended"
    | "conversation-ended"
    | "enlist-teaching"
    | "opening-turn";
  text: string;
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

export function conversationEndedNoticeText(params: {
  branch: string;
  closing?: string;
}): string {
  const lines = ["A Conversation you spawned was ended by the operator."];
  lines.push(`Branch: ${params.branch}`);
  if (params.closing?.trim()) lines.push(`Closing note: ${params.closing.trim()}`);
  return lines.join("\n");
}
