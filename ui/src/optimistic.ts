/**
 * Optimistic presses (issue #161): what the snapshot will say once the
 * engine has done what the operator just asked, drawn the moment they ask.
 * The server sends the delta carrying an action's effect ahead of the
 * action's reply, so an overlay only has to stand until the reply: by then
 * the confirmed state is in hand, and dropping the overlay changes nothing
 * on screen. A refusal drops it too, and the screen rolls back to the
 * snapshot as it stands.
 *
 * Each overlay is a pure function from one snapshot to the one the press
 * expects, copying only what it touches, so every ticket and Conversation
 * it leaves alone keeps its identity for the morph and the memoised
 * projections.
 */

import type {
  ConversationView,
  EnrichedSnapshot,
  HeldSpawnView,
  QueuedAnswer,
  ResumeAction,
} from "./project";

/** A snapshot as the press expects the engine to leave it. */
export type Overlay = (snapshot: EnrichedSnapshot) => EnrichedSnapshot;

/**
 * An answer to a ticket's interrupt: the answer queued, as the engine
 * records an accepted one, so the Detail and the Needs input row grey out
 * as "answered · waiting" and their actions disable. An interrupt already
 * answered, or gone, is left alone.
 */
export function answered(
  ticketId: string,
  action: ResumeAction,
  note?: string,
  attempt?: number,
): Overlay {
  const at = new Date().toISOString();
  return (snapshot) => {
    const interrupt = snapshot.state.interrupts.find((i) => i.ticketId === ticketId);
    if (!interrupt) return snapshot;
    const queued = snapshot.state.queuedAnswers.some(
      (answer) => answer.ticketId === ticketId && answer.kind === interrupt.kind,
    );
    if (queued) return snapshot;
    const answer: QueuedAnswer = {
      seq: 0,
      ticketId,
      kind: interrupt.kind,
      ...(action === "approve" ? { approve: true } : action === "reject" ? { approve: false } : {}),
      // A Close (issue #154) shows as closing from the press, as the
      // engine's queued answer will.
      ...(action === "close" ? { action: "close" as const } : {}),
      // An Adopt (ADR-0035) queues with the Candidate it takes, as the
      // engine's queued answer will.
      ...(action === "adopt" ? { action: "adopt" as const } : {}),
      ...(action === "adopt" && attempt !== undefined ? { attempt } : {}),
      ...(note ? { note } : {}),
      at,
      processedAt: null,
    };
    return {
      ...snapshot,
      state: { ...snapshot.state, queuedAnswers: [...snapshot.state.queuedAnswers, answer] },
    };
  };
}

/** A Conversation's End: it shows as the engine's ending until it goes. */
export function endingConversation(id: string): Overlay {
  return (snapshot) => {
    const conversations = mapOne(snapshot.state.conversations, id, (c): ConversationView =>
      c.ending ? c : { ...c, ending: true },
    );
    return conversations === snapshot.state.conversations
      ? snapshot
      : { ...snapshot, state: { ...snapshot.state, conversations } };
  };
}

/** A Held spawn's Adopt: it shows as the engine's adopting until it lands. */
export function adoptingSpawn(id: string): Overlay {
  return (snapshot) => {
    const heldSpawns = mapOne(snapshot.heldSpawns, id, (s): HeldSpawnView =>
      s.adopting ? s : { ...s, adopting: true, adoptError: undefined },
    );
    return heldSpawns === snapshot.heldSpawns ? snapshot : { ...snapshot, heldSpawns };
  };
}

/** A Discard, of a Pending or a Held spawn: it is gone from its list. */
export function discardedSpawn(id: string): Overlay {
  return (snapshot) => {
    const pendingSpawns = snapshot.pendingSpawns.filter((s) => s.id !== id);
    const heldSpawns = snapshot.heldSpawns.filter((s) => s.id !== id);
    if (
      pendingSpawns.length === snapshot.pendingSpawns.length &&
      heldSpawns.length === snapshot.heldSpawns.length
    ) {
      return snapshot;
    }
    return { ...snapshot, pendingSpawns, heldSpawns };
  };
}

/**
 * A Pending spawn's Hold: it leaves the pending list and waits at the end
 * of the held one, held by the operator, under the same id.
 */
export function heldSpawn(id: string): Overlay {
  return (snapshot) => {
    const spawn = snapshot.pendingSpawns.find((s) => s.id === id);
    if (!spawn) return snapshot;
    const held: HeldSpawnView = {
      ...spawn,
      reason: "operator",
      adopting: false,
      unknownOverlaps: [],
    };
    return {
      ...snapshot,
      pendingSpawns: snapshot.pendingSpawns.filter((s) => s.id !== id),
      heldSpawns: [...snapshot.heldSpawns, held],
    };
  };
}

/** Every overlay in turn, oldest press first. */
export function applyOverlays(
  snapshot: EnrichedSnapshot,
  overlays: Iterable<Overlay>,
): EnrichedSnapshot {
  let shown = snapshot;
  for (const overlay of overlays) shown = overlay(shown);
  return shown;
}

// The list with one entity replaced, or the same list when the id is not
// in it or the change made nothing new.
function mapOne<T extends { id: string }>(list: T[], id: string, change: (item: T) => T): T[] {
  const at = list.findIndex((item) => item.id === id);
  if (at === -1) return list;
  const next = change(list[at]!);
  if (next === list[at]) return list;
  const copy = [...list];
  copy[at] = next;
  return copy;
}
