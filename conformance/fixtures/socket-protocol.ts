/**
 * The Console's socket protocol (issue #161, ADR-0032) as a client reads it:
 * the envelope every server frame must have, and the delta apply that keeps
 * a client's copy of the snapshot current. ui/src/protocol.ts holds the
 * Console's own copy of these rules, which the TypeScript server runs too,
 * but conformance/ may import only types from engine/protocol.ts and
 * engine/wire.ts (ADR-0036), so the rules are restated here from what they
 * document. That is the point rather than a cost: a server whose frames
 * only its own decoder accepts, or whose deltas only its own apply rebuilds,
 * fails here, whichever language it is written in.
 */

import type {
  ClientMessage,
  EntityDelta,
  PushedSnapshot,
  RequestKind,
  ServerMessage,
  SnapshotDelta,
} from "../../engine/protocol.ts";
import type { EnrichedSnapshot } from "../../engine/wire.ts";

/** Where the server takes the socket. */
export const WS_PATH = "/api/ws";

/** The protocol version a client says in its hello. */
export const PROTOCOL_VERSION = 1;

/** How many of the pool log's last lines a pushed snapshot carries. */
export const POOL_LOG_WINDOW = 500;

/** The heartbeat interval a server announces in its hello by default (HEARTBEAT_MS in engine/protocol.ts). */
export const HEARTBEAT_MS = 20_000;

/** How often the server checks activity and peeks for its visible sockets (LIVE_CHECK_MS in engine/protocol.ts). */
export const LIVE_CHECK_MS = 2_000;

/** How the server closes every socket on an orderly stop (CLOSE_STOPPED in engine/protocol.ts). */
export const CLOSE_STOPPED = { code: 1000, reason: "stopped" };

/**
 * Every request kind the socket takes. Typed against the protocol's own
 * RequestKind, so a kind protocol.ts gains and this list lacks fails the
 * typecheck rather than a reply going unread.
 */
const REQUEST_KINDS: Record<RequestKind, true> = {
  start: true,
  resume: true,
  stop: true,
  restart: true,
  keepTalking: true,
  "terminal.focus": true,
  "terminals.closeFinished": true,
  enlist: true,
  reassign: true,
  "spawns.held.adopt": true,
  "spawns.held.discard": true,
  "spawns.pending.hold": true,
  "spawns.pending.discard": true,
  "conversations.start": true,
  "conversations.end": true,
  "settings.get": true,
  "settings.pool.put": true,
  "settings.machine.put": true,
  "panes.list": true,
  "log.read": true,
  "log.follow": true,
  "poolLog.read": true,
};

/** A frame that is not this protocol's, or a delta that does not fit. */
export class FrameError extends Error {}

/** Every message is one JSON text frame. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

function need(ok: boolean, what: string): void {
  if (!ok) throw new FrameError(what);
}

/**
 * A frame from the server, its envelope checked: the type, and the fields
 * every message of that type carries. Throws a FrameError.
 */
export function decodeServerFrame(text: string): ServerMessage {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new FrameError("frame is not JSON");
  }
  if (!isObject(m)) throw new FrameError("frame is not an object");
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
        isObject(m.delta) && isId(m.delta.base) && isId(m.delta.rev),
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
      need(
        typeof m.kind === "string" && Object.prototype.hasOwnProperty.call(REQUEST_KINDS, m.kind),
        `reply to unknown ${String(m.kind)}`,
      );
      need(isId(m.rev), "reply without rev");
      need(
        m.ok === true ||
          (m.ok === false && isObject(m.refusal) && typeof m.refusal.reason === "string"),
        "reply without result or refusal",
      );
      break;
    case "heartbeat":
      break;
    default:
      throw new FrameError(`unknown message ${String(m.type)}`);
  }
  return m as unknown as ServerMessage;
}

/** A keyed list after its delta: removals, then upserts in place or at the
 *  end, then the order. A delta that removes an id or adds one must carry
 *  the new order, so one that does not is refused rather than guessed at. */
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
  return order.map((id) => {
    const entity = byId.get(id);
    if (entity === undefined) throw new FrameError(`delta orders unknown id ${id}`);
    return entity;
  });
}

/**
 * The next version from the one held and a delta: top-level fields replaced
 * whole under `set` and dropped under `unset`, `state` fields replaced whole,
 * tickets and Conversations changed by id, the pool log appended (kept to
 * its last POOL_LOG_WINDOW lines) or replaced. Whatever the delta does not
 * name carries over. Throws a FrameError when the delta was made for another
 * revision.
 */
export function applySnapshotDelta(prev: PushedSnapshot, delta: SnapshotDelta): PushedSnapshot {
  if (delta.base !== prev.rev) {
    throw new FrameError(`delta for revision ${delta.base} applied to ${prev.rev}`);
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
      log = "append" in delta.log
        ? [...old.log, ...delta.log.append].slice(-POOL_LOG_WINDOW)
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
