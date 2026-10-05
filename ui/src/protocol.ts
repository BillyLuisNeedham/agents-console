/**
 * The Console's push protocol (issue #161, ADR-0032) as code: the pool
 * log's trim, the snapshot diff and its apply, the envelope's encode and
 * decode, and the boot snapshot embedded in the page. They are pure and
 * dependency-free, so the server and the browser run the very same
 * functions. The shapes and constants they work on are protocol/protocol.ts,
 * which the Rust port (issue #162) generates from its types and which carries
 * nothing else (ADR-0036); this file holds the code, because the Console and
 * the lag bench keep running these functions against whichever server they
 * talk to. Until the flip the TypeScript server imports them from here.
 */

import {
  EMBED_ELEMENT_ID,
  HTTP_TWINS,
  POOL_LOG_WINDOW,
  PROTOCOL_VERSION,
  type ClientMessage,
  type EmbeddedBoot,
  type EntityDelta,
  type PoolLogDelta,
  type PushedSnapshot,
  type ServerMessage,
  type SnapshotDelta,
} from "../../protocol/protocol.ts";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";

// ---------------------------------------------------------------------------
// The snapshot as pushed
// ---------------------------------------------------------------------------

/** The pool log's last `window` lines and how many there are in all. */
export function trimPoolLog(
  log: readonly string[],
  window: number = POOL_LOG_WINDOW,
): { lines: string[]; total: number } {
  const lines = log.length > window ? log.slice(log.length - window) : [...log];
  return { lines, total: log.length };
}

/** A full enriched snapshot as the socket pushes it, at revision `rev`. */
export function toPushed(full: EnrichedSnapshot, rev: number): PushedSnapshot {
  const { lines, total } = trimPoolLog(full.state.log);
  return {
    rev,
    logTotal: total,
    snapshot: { ...full, state: { ...full.state, log: lines } },
  };
}

// ---------------------------------------------------------------------------
// The delta
// ---------------------------------------------------------------------------

type TopFields = Omit<EnrichedSnapshot, "state">;
type TopKey = keyof TopFields;
type StateFields = Omit<EnrichedSnapshot["state"], "tickets" | "conversations" | "log">;

// Deep equality for wire values: plain JSON, so the encoding is the value.
// Key order is the producer's and stable, and a false "changed" costs only
// an entity resent.
function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function diffEntities<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
): EntityDelta<T> | undefined {
  const before = new Map(prev.map((entity) => [entity.id, entity]));
  const after = new Set(next.map((entity) => entity.id));
  const upsert = next.filter((entity) => {
    const old = before.get(entity.id);
    return old === undefined || !same(old, entity);
  });
  const remove = prev.filter((entity) => !after.has(entity.id)).map((entity) => entity.id);
  const moved =
    prev.length !== next.length || prev.some((entity, i) => entity.id !== next[i]!.id);
  if (upsert.length === 0 && remove.length === 0 && !moved) return undefined;
  const delta: EntityDelta<T> = {};
  if (upsert.length > 0) delta.upsert = upsert;
  if (remove.length > 0) delta.remove = remove;
  if (moved) delta.order = next.map((entity) => entity.id);
  return delta;
}

function diffLog(prev: PushedSnapshot, next: PushedSnapshot): PoolLogDelta | undefined {
  const old = prev.snapshot.state.log;
  const now = next.snapshot.state.log;
  const grown = next.logTotal - prev.logTotal;
  if (grown === 0 && same(old, now)) return undefined;
  if (grown > 0) {
    // A log that only grew: the lines the new window keeps from before must
    // be the old window's last ones. Checked line by line, so a new run's
    // log that happens to be longer is replaced, never spliced on.
    const kept = Math.max(0, now.length - grown);
    const overlap = now.slice(0, kept);
    const tail = old.slice(Math.max(0, old.length - kept));
    if (overlap.length === tail.length && overlap.every((line, i) => line === tail[i])) {
      return { append: now.slice(kept), total: next.logTotal };
    }
  }
  return { replace: [...now], total: next.logTotal };
}

/**
 * What changed from one pushed version to the next, or null when nothing
 * did (no delta is sent and the revision does not move). The delta's `rev`
 * is `next.rev`; the server numbers `next` before asking.
 */
export function diffSnapshot(prev: PushedSnapshot, next: PushedSnapshot): SnapshotDelta | null {
  const delta: SnapshotDelta = { base: prev.rev, rev: next.rev };
  let changed = false;

  const { state: prevState, ...prevTop } = prev.snapshot;
  const { state: nextState, ...nextTop } = next.snapshot;
  const set: Record<string, unknown> = {};
  const unset: TopKey[] = [];
  for (const key of new Set([...Object.keys(prevTop), ...Object.keys(nextTop)]) as Set<TopKey>) {
    if (!(key in nextTop) || nextTop[key] === undefined) {
      if (key in prevTop && prevTop[key] !== undefined) unset.push(key);
    } else if (!same(prevTop[key], nextTop[key])) {
      set[key] = nextTop[key];
    }
  }
  if (Object.keys(set).length > 0) {
    delta.set = set as Partial<TopFields>;
    changed = true;
  }
  if (unset.length > 0) {
    delta.unset = unset;
    changed = true;
  }

  const { tickets: prevTickets, conversations: prevConversations, log: _prevLog, ...prevRest } =
    prevState;
  const { tickets: nextTickets, conversations: nextConversations, log: _nextLog, ...nextRest } =
    nextState;
  const state: Record<string, unknown> = {};
  for (const key of Object.keys(nextRest) as (keyof StateFields)[]) {
    if (!same(prevRest[key], nextRest[key])) state[key] = nextRest[key];
  }
  if (Object.keys(state).length > 0) {
    delta.state = state as Partial<StateFields>;
    changed = true;
  }

  const tickets = diffEntities(prevTickets, nextTickets);
  if (tickets) {
    delta.tickets = tickets;
    changed = true;
  }
  const conversations = diffEntities(prevConversations, nextConversations);
  if (conversations) {
    delta.conversations = conversations;
    changed = true;
  }
  const log = diffLog(prev, next);
  if (log) {
    delta.log = log;
    changed = true;
  }
  return changed ? delta : null;
}

/** A delta that does not fit the version it was applied to, or a frame
 *  that is not this protocol's. The Console answers either with a resync. */
export class ProtocolError extends Error {}

function applyEntities<T extends { id: string }>(prev: T[], delta: EntityDelta<T> | undefined): T[] {
  if (!delta) return prev;
  const byId = new Map(prev.map((entity) => [entity.id, entity]));
  for (const id of delta.remove ?? []) byId.delete(id);
  const added: string[] = [];
  for (const entity of delta.upsert ?? []) {
    if (!byId.has(entity.id)) added.push(entity.id);
    byId.set(entity.id, entity);
  }
  const order = delta.order ?? [...prev.map((entity) => entity.id), ...added];
  return order.flatMap((id) => {
    const entity = byId.get(id);
    if (entity === undefined) throw new ProtocolError(`delta orders unknown id ${id}`);
    return [entity];
  });
}

/**
 * The next version from the one held and a delta. Everything the delta
 * does not name is carried over by reference: an unchanged ticket or
 * Conversation is the same object before and after, and so are `state` and
 * its lists when nothing in them moved, so the morph renderer and any
 * memoised projection see identity where nothing changed. Throws a
 * ProtocolError when the delta was made for another revision.
 */
export function applyDelta(prev: PushedSnapshot, delta: SnapshotDelta): PushedSnapshot {
  if (delta.base !== prev.rev) {
    throw new ProtocolError(`delta for revision ${delta.base} applied to ${prev.rev}`);
  }
  let snapshot = prev.snapshot;
  if (delta.set || delta.unset) {
    const top: Record<string, unknown> = { ...snapshot, ...delta.set };
    for (const key of delta.unset ?? []) delete top[key];
    snapshot = top as unknown as EnrichedSnapshot;
  }
  let logTotal = prev.logTotal;
  if (delta.state || delta.tickets || delta.conversations || delta.log) {
    const old = prev.snapshot.state;
    let log = old.log;
    if (delta.log) {
      logTotal = delta.log.total;
      log =
        "append" in delta.log
          ? trimPoolLog([...old.log, ...delta.log.append]).lines
          : [...delta.log.replace];
    }
    snapshot = {
      ...snapshot,
      state: {
        ...old,
        ...delta.state,
        tickets: applyEntities(old.tickets, delta.tickets),
        conversations: applyEntities(old.conversations, delta.conversations),
        log,
      },
    };
  }
  return { rev: delta.rev, logTotal, snapshot };
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** Every message is one JSON text frame. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

const REQUEST_KINDS = new Set<string>(Object.keys(HTTP_TWINS));

function envelope(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("frame is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("frame is not an object");
  }
  return value as Record<string, unknown>;
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new ProtocolError(what);
}

const isObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * A frame from the Console, its envelope checked: the type, and the fields
 * every message of that type carries. A request's payload is the handler's
 * to check, as the HTTP route checks its body. Throws a ProtocolError.
 */
export function decodeClientMessage(text: string): ClientMessage {
  const m = envelope(text);
  switch (m.type) {
    case "hello":
      need(typeof m.protocol === "number", "hello without protocol");
      need(typeof m.visible === "boolean", "hello without visible");
      need(
        Array.isArray(m.cards) &&
          m.cards.every((card) => isObject(card) && typeof card.id === "string"),
        "hello without cards",
      );
      break;
    case "visibility":
      need(typeof m.visible === "boolean", "visibility without visible");
      break;
    case "subscribe":
      need(isObject(m.card) && typeof (m.card as { id?: unknown }).id === "string", "subscribe without card");
      break;
    case "unsubscribe":
      need(typeof m.id === "string", "unsubscribe without id");
      break;
    case "request":
      need(isId(m.id), "request without id");
      need(typeof m.kind === "string" && REQUEST_KINDS.has(m.kind), `unknown request ${String(m.kind)}`);
      need(isObject(m.payload), "request without payload");
      break;
    default:
      throw new ProtocolError(`unknown message ${String(m.type)}`);
  }
  return m as unknown as ClientMessage;
}

/** A frame from the server, its envelope checked the same way. */
export function decodeServerMessage(text: string): ServerMessage {
  const m = envelope(text);
  switch (m.type) {
    case "hello":
      need(typeof m.protocol === "number", "hello without protocol");
      need(typeof m.epoch === "string", "hello without epoch");
      need(typeof m.heartbeatMs === "number" && m.heartbeatMs > 0, "hello without heartbeat");
      break;
    case "snapshot":
      need(isId(m.rev), "snapshot without rev");
      need(isId(m.logTotal), "snapshot without logTotal");
      need(m.snapshot === null || isObject(m.snapshot), "snapshot without snapshot");
      break;
    case "delta":
      need(
        isObject(m.delta) &&
          isId((m.delta as { base?: unknown }).base) &&
          isId((m.delta as { rev?: unknown }).rev),
        "delta without revisions",
      );
      break;
    case "live":
      break;
    case "card":
      need(typeof m.id === "string", "card without id");
      break;
    case "reply":
      need(isId(m.id), "reply without id");
      need(typeof m.kind === "string" && REQUEST_KINDS.has(m.kind), `reply to unknown ${String(m.kind)}`);
      need(isId(m.rev), "reply without rev");
      need(
        m.ok === true ||
          (m.ok === false &&
            isObject(m.refusal) &&
            typeof (m.refusal as { reason?: unknown }).reason === "string"),
        "reply without result or refusal",
      );
      break;
    case "heartbeat":
      break;
    default:
      throw new ProtocolError(`unknown message ${String(m.type)}`);
  }
  return m as unknown as ServerMessage;
}

// ---------------------------------------------------------------------------
// The first snapshot, embedded in the page
// ---------------------------------------------------------------------------

/**
 * index.html with the boot snapshot in a JSON script element ahead of
 * `</head>`. Every `<` in the JSON is escaped, so no ticket title or log
 * line can close the element early.
 */
export function embedBoot(html: string, boot: EmbeddedBoot): string {
  const json = JSON.stringify(boot).replace(/</g, "\\u003c");
  const tag = `<script id="${EMBED_ELEMENT_ID}" type="application/json">${json}</script>`;
  const at = html.indexOf("</head>");
  return at === -1 ? tag + html : html.slice(0, at) + tag + html.slice(at);
}

/** The embedded boot snapshot from the element's text, or null when there
 *  is none, it does not parse, or it was made for another protocol. */
export function readEmbeddedBoot(text: string | null | undefined): EmbeddedBoot | null {
  if (!text) return null;
  try {
    const boot = JSON.parse(text) as EmbeddedBoot;
    if (boot?.protocol !== PROTOCOL_VERSION || typeof boot.epoch !== "string") return null;
    if (!isId(boot.rev) || !isId(boot.logTotal)) return null;
    return boot;
  } catch {
    return null;
  }
}
