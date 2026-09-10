/**
 * Notices (the Conversations ADR, docs/adr/0017-conversations-beside-
 * tickets.md; CONTEXT.md: Notice): the Turn the engine types into a parent
 * Conversation when something it spawned ends. Owns the queue, the text a
 * Notice carries, delivery (typed into the pane once the parent is next
 * `waiting`), and dropping (the parent gone, or still queued at the
 * parent's own End). Also owns turn-state polling (engine/turn-state.ts is
 * the pure derivation; this module is the per-Conversation tick that reads
 * a pane, calls it, and acts on the result) and a Conversation's own
 * mid-run Spawn proposals, since both ride the same 2s tick per live
 * Conversation.
 *
 * Wires itself into conversations.ts's two hooks (setConversationEndedHook,
 * setConversationPoller) as a side effect of being imported, so engine.ts
 * needs nothing beyond importing what it calls directly from here (the
 * notify-at-ticket-ending functions) for the wiring to take effect — the
 * same "simplest hook that keeps A and B from needing to import each
 * other's modules" reasoning conversations.ts's own header gives for those
 * two setters.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  lastAttempt,
  type TicketEventKind,
} from "./events.ts";
import {
  loadConversations,
  readConversation,
  setConversationEndedHook,
  setConversationPoller,
  type ConversationRuntime,
} from "./conversations.ts";
import { typeVerified, INTERACTIVE_PANE_READ_LINES } from "./pane-session.ts";
import { peekPane } from "./herdr.ts";
import { defaultHarnessDescriptors, idlePatternFor } from "./spawn.ts";
import { branchFor, currentBranch, git } from "./worktrees.ts";
import { deriveTurnState } from "./turn-state.ts";
import {
  adoptSpawnProposals,
  kickProcessing,
  validateSpawnProposals,
  type Session,
  emitSnapshot,
} from "./engine.ts";

// ---------------------------------------------------------------------------
// The Notice itself.
// ---------------------------------------------------------------------------

export interface Notice {
  to: string;
  from: string;
  kind: "ticket-ended" | "conversation-ended";
  text: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function conversationsDirOf(session: Session): string {
  // Mirrors conversations.ts's private conversationsDir(poolDir): that
  // function is not exported (nothing outside conversations.ts needed the
  // path before now), and the join itself is a one-liner not worth adding a
  // cross-module export for.
  return join(session.poolDir, "conversations");
}

function spawnedByOf(session: Session, conversationId: string): string | undefined {
  return loadConversations(conversationsDirOf(session)).find((r) => r.id === conversationId)
    ?.spawnedBy;
}

function logDropped(session: Session, notice: Notice, reason: string): void {
  appendEvent(session.runsDir, notice.from, {
    at: nowIso(),
    attempt: lastAttempt(session.runsDir, notice.from),
    kind: "notice-dropped" as TicketEventKind,
    payload: { to: notice.to, kind: notice.kind, reason, text: notice.text },
  });
}

/**
 * Queue one Notice for delivery, or drop it at once. Void by design (the
 * plan's contract): queueing is synchronous bookkeeping on the runtime; a
 * delivery that becomes possible immediately (the parent is already
 * `waiting`) is kicked off in the background rather than awaited here, so no
 * caller of enqueueNotice needs to become async just to raise one.
 */
export function enqueueNotice(session: Session, notice: Notice): void {
  const runtime = session.conversations.get(notice.to);
  if (!runtime || runtime.ending) {
    // Orphaned: the parent never existed this run, already ended, crashed,
    // or is mid-End (its tab is already closing). Dropped and logged on the
    // CHILD's own file — the spec's wording is explicit that this lands on
    // "the child's ticket log", never the parent's, since the parent may
    // have nothing worth writing to by the time this fires.
    logDropped(
      session,
      notice,
      runtime ? "parent conversation is ending" : "parent conversation is not live",
    );
    return;
  }
  runtime.notices.push(notice);
  if (runtime.turn.state === "waiting") {
    void deliverQueuedNotices(session, notice.to);
  }
}

// ---------------------------------------------------------------------------
// Text builders.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Notify-at-ticket-ending: engine.ts's hooks call these where a spawned
// Ticket's ending becomes final.
// ---------------------------------------------------------------------------

interface TicketLike {
  id: string;
  title: string;
  spawnedBy?: string;
}

// Whether `id` names a Conversation the pool has ever recorded, live or not.
// Distinct from `session.conversations.has(id)` (live only): a ticket's
// spawned-by can name a Conversation that has since ended or crashed, and
// that case must still reach enqueueNotice so its Notice is dropped and
// *logged*, not silently skipped — only a spawned-by that names an ordinary
// Ticket (not a Conversation at all) should build nothing.
function isKnownConversation(session: Session, id: string): boolean {
  return loadConversations(conversationsDirOf(session)).some((r) => r.id === id);
}

/**
 * A spawned Ticket reached `done` (its merge landed): if its `spawned-by`
 * names any Conversation the pool has recorded, enqueue a Notice —
 * enqueueNotice itself decides delivery vs. drop from there (the parent may
 * no longer be live). `diffRange` is a git range (`<sha-before>..HEAD`)
 * computed by the caller before the merge removed the ticket's branch — null
 * when the range could not be captured (a headless pool, or a fast path
 * that skipped it), in which case the diff reads as unavailable rather than
 * guessing.
 */
export function notifyConversationOfTicketDone(
  session: Session,
  marker: TicketLike,
  branch: string,
  diffRange: string | null,
): void {
  if (!marker.spawnedBy || !isKnownConversation(session, marker.spawnedBy)) return;
  const diffStat = diffRange ? diffStatSummary(session.cwd, diffRange) : "(diff unavailable)";
  const text = ticketEndedNoticeText({
    id: marker.id,
    title: marker.title,
    outcome: "done",
    branch,
    diffStat,
  });
  enqueueNotice(session, { to: marker.spawnedBy, from: marker.id, kind: "ticket-ended", text });
}

/**
 * A spawned Ticket checkpointed: if its `spawned-by` names any Conversation
 * the pool has recorded, enqueue a Notice (same "known, not just live" rule
 * as notifyConversationOfTicketDone above). Called from raiseCheckpoint
 * (engine.ts), the one function both checkpoint-raising call sites (attempt
 * exit, and the adoption recovery path) already go through, so this needs
 * no second hook. The branch still exists in a git pool (a checkpoint never
 * merges), so the diff is a live three-dot range against the pool's current
 * working branch; a headless pool has neither, and the Notice still goes
 * out (to be delivered or dropped) with placeholders for both.
 */
export function notifyConversationOfCheckpoint(
  session: Session,
  marker: TicketLike,
  brief: string,
): void {
  if (!marker.spawnedBy || !isKnownConversation(session, marker.spawnedBy)) return;
  const branch = session.git ? branchFor(session.cwd, marker.id) : "(no git checkout)";
  const diffStat = session.git
    ? diffStatSummary(session.cwd, `${currentBranch(session.cwd)}...${branch}`)
    : "(no git checkout)";
  const text = ticketEndedNoticeText({
    id: marker.id,
    title: marker.title,
    outcome: "checkpoint",
    brief,
    branch,
    diffStat,
  });
  enqueueNotice(session, { to: marker.spawnedBy, from: marker.id, kind: "ticket-ended", text });
}

// ---------------------------------------------------------------------------
// Delivery: typed into the pane once the parent Conversation is `waiting`.
// ---------------------------------------------------------------------------

function harnessDescriptorFor(runtime: ConversationRuntime) {
  const rec = readConversation(runtime.file);
  return defaultHarnessDescriptors[rec.harness];
}

/**
 * Drain a Conversation's queued Notices by typing each as its own Turn
 * (typeVerified + Enter — typeVerified sends the Enter itself once the echo
 * confirms). Claims the whole queue up front (a synchronous splice, before
 * any await), so a concurrent trigger — the poller's own waiting check
 * racing an enqueueNotice that fired mid-tick — can never double-deliver. A
 * delivery that fails to echo (typeVerified resolves false) stops the drain
 * and puts the undelivered remainder back at the front of the queue for the
 * next trigger to retry, rather than skipping ahead or losing it.
 */
export async function deliverQueuedNotices(session: Session, id: string): Promise<void> {
  const runtime = session.conversations.get(id);
  if (!runtime || runtime.ending || !runtime.paneId || runtime.notices.length === 0) return;
  const descriptor = harnessDescriptorFor(runtime);
  const queue = runtime.notices.splice(0);
  for (let i = 0; i < queue.length; i++) {
    const notice = queue[i];
    const echoTargets = [descriptor?.echoPattern, notice.text].filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    const delivered = await typeVerified(
      session.herdrSocket,
      runtime.paneId,
      notice.text,
      echoTargets,
      descriptor?.clearKeys ?? [],
    );
    const payload = { kind: notice.kind, delivered };
    appendEvent(session.runsDir, notice.from, {
      at: nowIso(),
      attempt: lastAttempt(session.runsDir, notice.from),
      kind: "notice" as TicketEventKind,
      payload: { ...payload, to: notice.to },
    });
    appendEvent(session.runsDir, id, {
      at: nowIso(),
      attempt: lastAttempt(session.runsDir, id),
      kind: "notice" as TicketEventKind,
      payload: { ...payload, from: notice.from },
    });
    if (!delivered) {
      runtime.notices.unshift(...queue.slice(i));
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Ending: drop what never delivered, and tell this Conversation's own
// parent, if it has one.
// ---------------------------------------------------------------------------

function onConversationEnded(
  session: Session,
  id: string,
  info: { branch: string; closing?: string; crashed: boolean },
): void {
  // Reordered in conversations.ts (finishConversationEnd / markConversation-
  // Crashed) so this hook fires while the runtime is still in
  // session.conversations: without that, runtime.notices would already be
  // gone by the time this ran.
  const runtime = session.conversations.get(id);
  for (const notice of runtime?.notices ?? []) {
    logDropped(session, notice, "parent conversation ended before delivery");
  }
  const parentId = spawnedByOf(session, id);
  if (!parentId) return;
  const text = conversationEndedNoticeText({ branch: info.branch, closing: info.closing });
  enqueueNotice(session, { to: parentId, from: id, kind: "conversation-ended", text });
}

setConversationEndedHook(onConversationEnded);

// ---------------------------------------------------------------------------
// Polling: turn state (engine/turn-state.ts) and this Conversation's own
// mid-run Spawn proposal file, one tick per live Conversation.
// ---------------------------------------------------------------------------

const CONVERSATION_POLL_MS = 2_000;

function spawnProposalPath(session: Session, id: string): string {
  return join(session.runsDir, `${id}.spawn.json`);
}

/**
 * Read `runs/<id>.spawn.json`, consume it (rm, whether it parsed or not: a
 * malformed file left in place would be re-read and re-rejected forever),
 * validate its `spawn` array with engine.ts's own validator so a
 * Conversation's proposals are held to exactly the same shape a Ticket's
 * outcome.spawn is, and hand the survivors to the adoption boundary. Rejected
 * entries are logged the same way an outcome's are (spawn-rejected on this
 * Conversation's own file, since it is both proposer and parent here).
 */
function pollSpawnProposals(session: Session, id: string): void {
  const path = spawnProposalPath(session, id);
  if (!existsSync(path)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    rmSync(path, { force: true });
    return;
  }
  rmSync(path, { force: true });
  const spawnField = (raw as { spawn?: unknown } | null)?.spawn;
  const { proposals, rejections } = validateSpawnProposals(spawnField);
  for (const rejection of rejections) {
    appendEvent(session.runsDir, id, {
      at: nowIso(),
      attempt: lastAttempt(session.runsDir, id),
      kind: "spawn-rejected" as TicketEventKind,
      payload: { index: rejection.index, reason: rejection.reason },
    });
  }
  if (proposals.length === 0) return;
  session.pendingSpawns.push({ parentId: id, proposals, origin: "conversation" });
  // Idle: adopt (write the files / start the child Conversations) and kick a
  // drive at once, since nothing else will reach the boundary that does
  // this. In flight: leave it queued — the driving super-step's own
  // adoptSpawnProposals call at its next boundary picks it up, and adopting
  // here too would mutate session.markers/session.state concurrently with
  // that in-flight work.
  if (!session.driving) {
    adoptSpawnProposals(session);
    kickProcessing(session);
  }
}

function tickConversation(session: Session, runtime: ConversationRuntime, id: string): void {
  if (runtime.ending || !runtime.paneId) return;
  // A single tick's failure (a transient read error, a record momentarily
  // unreadable) must never take the poller down for every other live
  // Conversation, nor stop this one's own future ticks: swallow and let the
  // next tick try again, the same tolerance peekPane's own callers already
  // apply to a daemon blip.
  let descriptor;
  try {
    descriptor = harnessDescriptorFor(runtime);
  } catch {
    return;
  }
  const idlePattern = descriptor ? idlePatternFor(descriptor) : "";
  void peekPane(session.herdrSocket, runtime.paneId, INTERACTIVE_PANE_READ_LINES)
    .catch(() => null)
    .then((text) => {
      try {
        // The runtime may have ended while this read was in flight (the tab
        // closes as soon as End is called, well before the pane's fate is
        // known); re-fetch rather than trusting the closure's reference.
        const live = session.conversations.get(id);
        if (text === null || !live || live.ending) return;
        const derived = deriveTurnState(
          { text: live.turn.lastText, state: live.turn.state, stableReads: live.turn.stableReads },
          text,
          idlePattern,
        );
        const wasWorking = live.turn.state !== "waiting";
        live.turn.lastText = text;
        live.turn.stableReads = derived.stableReads;
        live.turn.lastLine = derived.lastLine;
        live.turn.state = derived.state;
        if (derived.state === "waiting" && wasWorking) {
          live.turn.idleSince = nowIso();
        } else if (derived.state === "working") {
          live.turn.idleSince = null;
        }
        if (derived.changed) {
          emitSnapshot(session, session.settledPhase ?? "running");
        }
        if (derived.state === "waiting" && live.notices.length > 0) {
          void deliverQueuedNotices(session, id);
        }
        pollSpawnProposals(session, id);
      } catch {
        // See above: one tick's failure is not fatal.
      }
    });
}

/**
 * Start one Conversation's poller: a 2s tick reading its pane, deriving turn
 * state, and polling its spawn-proposal file, stopping the moment its
 * runtime leaves session.conversations (ended, crashed — there is no other
 * signal to watch for "left live" than the runtime's own absence, since
 * ConversationRuntime carries no status field of its own). Also seeds
 * session.assignments with this Conversation's own resolved Assignment under
 * its id, so a Ticket it spawns whose spawned-by names it resolves through
 * resolveUnseenAssignments (engine.ts) the same way a grader or spawned
 * ticket inherits from its own parent.
 */
function onConversationStarted(session: Session, id: string): void {
  const runtime = session.conversations.get(id);
  if (runtime && !session.assignments.has(id)) {
    const rec = readConversation(runtime.file);
    session.assignments.set(id, { harness: rec.harness, model: rec.model, drivers: rec.drivers });
  }
  const timer = setInterval(() => {
    const live = session.conversations.get(id);
    if (!live) {
      clearInterval(timer);
      return;
    }
    tickConversation(session, live, id);
  }, CONVERSATION_POLL_MS);
}

setConversationPoller(onConversationStarted);
