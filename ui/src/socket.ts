/**
 * The Console's one connection to its pool server (issue #161, ADR-0032): a
 * WebSocket at WS_PATH. The server pushes the snapshot over it, whole when
 * the socket opens and then as deltas, along with the live values (activity,
 * peeks, grades) and the subscribed cards' data; every action and read the
 * Console asks for goes the other way as a request answered under its own
 * id. This module is the only code that talks to the server, the restart
 * probe aside, which runs against a port with no socket yet.
 *
 * The socket comes from an injected factory: the browser's WebSocket in the
 * page, a fake that speaks the protocol in the tests and in the bench's UI
 * half, so the seam they fake is the wire itself. It self-heals: a socket
 * silent for SILENCE_FACTOR heartbeats is dropped and reopened at once, a
 * closed one reopens after RECONNECT_DELAYS_MS, and every open re-sends the
 * subscriptions whole in its `hello` and gets a fresh snapshot, never a
 * replay.
 */

import {
  CLOSE_RESYNC,
  CLOSE_STOPPED,
  HEARTBEAT_MS,
  PROTOCOL_VERSION,
  RECONNECT_DELAYS_MS,
  SILENCE_FACTOR,
  type CardSubscription,
  type ClientMessage,
  type EmbeddedBoot,
  type LogFollow,
  type LogFollowResult,
  type PushedSnapshot,
  type Refusal,
  type RequestKind,
  type RequestPayload,
  type RequestResult,
  type ServerMessage,
  type SnapshotDelta,
  type SocketLike,
} from "../../protocol/protocol.ts";
import { applyDelta, decodeServerMessage, encodeMessage, ProtocolError } from "./protocol";

/** A `live` frame: the activity, peeks and grades that moved. */
export type LiveMessage = Extract<ServerMessage, { type: "live" }>;

/** A `card` frame: a subscribed card's body, events or log. */
export type CardMessage = Extract<ServerMessage, { type: "card" }>;

/**
 * A request the server refused, or one the socket lost. The message is the
 * refusal's reason, so a control that shows `err.message` beside itself
 * shows the engine's own words; `status` is what the HTTP twin answers, 0
 * for the client's own "the socket went before the reply came".
 */
export class RequestRefused extends Error {
  readonly status: number;

  constructor(refusal: Refusal) {
    super(refusal.reason);
    this.name = "RequestRefused";
    this.status = refusal.status;
  }
}

/** The refusal every request still out gets when its socket goes. */
export const CONNECTION_LOST: Refusal = {
  reason: "connection lost before the server answered",
  status: 0,
};

/** The refusal a request gets while there is no socket to send it on. */
export const NOT_CONNECTED: Refusal = {
  reason: "not connected to the pool server",
  status: 0,
};

/** The connection came up (a snapshot is in hand), or went down. A down
 *  that is the server's `stopped` farewell close says so. */
export type ConnectionChange =
  | { up: true }
  | { up: false; reason: string; stopped: boolean };

export interface ConsoleSocketOptions {
  /** Open a socket to the pool server's WS_PATH. */
  open: () => SocketLike;
  /**
   * A new version of the snapshot, or null before the pool has started.
   * `delta` is the change that made it, null for a whole snapshot. Not
   * called for a whole snapshot the Console already holds (the same epoch
   * and revision), so nothing re-renders for it.
   */
  onSnapshot: (pushed: PushedSnapshot | null, delta: SnapshotDelta | null) => void;
  onLive: (live: LiveMessage) => void;
  onCard: (card: CardMessage) => void;
  onConnection: (change: ConnectionChange) => void;
  /** The server speaks another protocol version. The socket has stopped
   *  for good; the page reloads, or says it should. */
  onVersionMismatch: () => void;
  /** Whether the page is visible when the socket first opens. */
  visible?: boolean;
  /** The reconnect delays, the last one repeating; tests shorten them. */
  reconnectDelaysMs?: readonly number[];
  /** How long a socket must stay up before the delays start over; tests
   *  shorten it. */
  stableMs?: number;
}

/** How long a socket must stay up before the reconnect delays start over:
 *  a server that greets and then drops every socket still backs off. */
export const STABLE_SOCKET_MS = 5_000;

/** A socket silent this many heartbeats when the page wakes (shown again,
 *  or back online) is taken for half open and replaced at once. */
export const WAKE_SILENCE_FACTOR = 1.5;

interface Outstanding {
  resolve: (result: never) => void;
  reject: (err: RequestRefused) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class ConsoleSocket {
  private readonly options: ConsoleSocketOptions;
  private readonly delays: readonly number[];
  private readonly stableMs: number;
  private socket: SocketLike | null = null;
  // The socket's own state: its `onopen` came (our hello went, and frames
  // may follow it), its `hello` came (a server of our version), the epoch
  // that hello named, and when its last frame landed.
  private opened = false;
  private greeted = false;
  private socketEpoch: string | null = null;
  private lastFrameAt = 0;
  // The snapshot held and the server epoch it came from: the embedded one,
  // then whatever the sockets pushed. A rev means something only within
  // its epoch.
  private pushed: PushedSnapshot | null = null;
  private epoch: string | null = null;
  private heartbeatMs = HEARTBEAT_MS;
  // Request ids count up from 1 on each socket.
  private nextId = 1;
  private readonly outstanding = new Map<number, Outstanding>();
  // Requests asked for while the socket was still connecting: they go out
  // right behind the hello, or are refused if the socket never opens.
  private waiting: { id: number; message: ClientMessage }[] = [];
  private readonly cards = new Map<string, CardSubscription>();
  private visible: boolean;
  private retries = 0;
  private silence: Timer | null = null;
  private retry: Timer | null = null;
  // Starts the delays over once a greeted socket has stayed up long enough.
  private stable: Timer | null = null;
  // Set once the socket is done for good: disposed, or a server of another
  // protocol version.
  private finished = false;

  constructor(options: ConsoleSocketOptions) {
    this.options = options;
    this.delays = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
    this.stableMs = options.stableMs ?? STABLE_SOCKET_MS;
    this.visible = options.visible ?? true;
  }

  /** The snapshot held, as last pushed (or embedded). */
  get snapshot(): PushedSnapshot | null {
    return this.pushed;
  }

  /** Whether a socket is open and greeted, so a request would go now. */
  get connected(): boolean {
    return this.opened && this.greeted;
  }

  /**
   * Hold the snapshot the served page embedded: the Console paints it
   * before the socket opens, and the socket's first snapshot, when it is
   * the same epoch and revision, is taken as the one already painted.
   */
  adopt(boot: EmbeddedBoot): void {
    this.epoch = boot.epoch;
    this.pushed = boot.snapshot
      ? { rev: boot.rev, logTotal: boot.logTotal, snapshot: boot.snapshot }
      : null;
  }

  /** Open the socket; from here it keeps itself open. */
  start(): void {
    if (this.finished || this.socket) return;
    this.connect();
  }

  /** Close for good: no reconnect, every request still out refused. */
  dispose(): void {
    this.finished = true;
    this.clearTimers();
    this.drop(CLOSE_STOPPED.code, "disposed");
  }

  /**
   * Send a request and resolve with its result, or reject with a
   * RequestRefused carrying the refusal. A request asked for while the
   * socket is connecting goes out right behind our hello; one asked for
   * with no socket at all (between a close and the reopen) is refused at
   * once, never held for a later socket, since an action may not be
   * idempotent.
   */
  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<RequestResult<K>> {
    if (this.finished || !this.socket) {
      return Promise.reject(new RequestRefused(NOT_CONNECTED));
    }
    const id = this.nextId++;
    const message = { type: "request", id, kind, payload } as ClientMessage;
    return new Promise<RequestResult<K>>((resolve, reject) => {
      this.outstanding.set(id, { resolve: resolve as (result: never) => void, reject });
      if (this.opened) this.send(message);
      else this.waiting.push({ id, message });
    });
  }

  /**
   * Subscribe a card, or change its follow: kept in the set every hello
   * carries, and sent now when the socket is open. The server reads frames
   * in order behind our hello, so one sent before its own hello lands is
   * as good as one sent after.
   */
  subscribe(card: CardSubscription): void {
    this.cards.set(card.id, card);
    if (this.opened) this.send({ type: "subscribe", card });
  }

  /** Stop a card's pushes. An id not subscribed sends nothing. */
  unsubscribe(id: string): void {
    if (!this.cards.delete(id)) return;
    if (this.opened) this.send({ type: "unsubscribe", id });
  }

  /**
   * Point a subscribed card's log at another attempt or variant: the
   * follow the next hello carries, and a `log.follow` request whose reply
   * is the new tail window.
   */
  follow(id: string, follow: LogFollow): Promise<LogFollowResult> {
    if (this.cards.has(id)) this.cards.set(id, { id, follow });
    return this.request("log.follow", { id, ...follow });
  }

  /** The page was shown or hidden: a hidden page gets no live values. A
   *  page shown again checks its socket is still alive (`wake`). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.wake();
    if (this.opened) this.send({ type: "visibility", visible });
  }

  /**
   * The page woke: shown again, or back online. After a sleep or a network
   * change the socket may be half open, with nothing arriving and presses
   * hanging until the silence watchdog fires up to a minute later; one that
   * has heard nothing for WAKE_SILENCE_FACTOR heartbeats is replaced now.
   * With no socket (waiting out a reconnect delay), the reopen happens now.
   */
  wake(): void {
    if (this.finished) return;
    if (!this.socket) {
      if (this.retry !== null) {
        clearTimeout(this.retry);
        this.connect();
      }
      return;
    }
    if (!this.opened) return;
    if (Date.now() - this.lastFrameAt <= WAKE_SILENCE_FACTOR * this.heartbeatMs) return;
    this.drop(4000, "silent");
    this.connect();
  }

  // -------------------------------------------------------------------------
  // The socket's lifecycle
  // -------------------------------------------------------------------------

  private connect(): void {
    this.retry = null;
    if (this.finished) return;
    let socket: SocketLike;
    try {
      socket = this.options.open();
    } catch (err) {
      this.lost(err instanceof Error ? err.message : String(err), false);
      return;
    }
    this.socket = socket;
    this.opened = false;
    this.greeted = false;
    this.socketEpoch = null;
    this.nextId = 1;
    // Before the server's hello names its heartbeat, the default bounds a
    // socket that never opens as much as one that went quiet.
    this.heartbeatMs = HEARTBEAT_MS;
    this.armSilence();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.lastFrameAt = Date.now();
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        visible: this.visible,
        cards: [...this.cards.values()],
      });
      // What was asked for while the socket connected goes right behind.
      for (const { message: waiting } of this.waiting) this.send(waiting);
      this.waiting = [];
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastFrameAt = Date.now();
      this.armSilence();
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = decodeServerMessage(event.data);
      } catch (err) {
        console.warn("console socket: dropped a frame", err);
        return;
      }
      this.receive(message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      const stopped = event.code === CLOSE_STOPPED.code && event.reason === CLOSE_STOPPED.reason;
      this.socket = null;
      this.lost(event.reason || `pool socket closed (${event.code})`, stopped);
    };
    // An error is always followed by a close, which does the work.
    socket.onerror = () => {};
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        if (message.protocol !== PROTOCOL_VERSION) {
          this.finished = true;
          this.clearTimers();
          this.drop(CLOSE_STOPPED.code, "protocol mismatch");
          this.options.onVersionMismatch();
          return;
        }
        this.greeted = true;
        this.socketEpoch = message.epoch;
        this.heartbeatMs = message.heartbeatMs;
        this.armSilence();
        // The delays start over only once this socket has stayed up: a
        // server that greets and then drops every socket still backs off.
        if (this.stable !== null) clearTimeout(this.stable);
        this.stable = setTimeout(() => {
          this.stable = null;
          this.retries = 0;
        }, this.stableMs);
        return;
      case "snapshot": {
        const same =
          message.snapshot !== null &&
          this.pushed !== null &&
          this.epoch === this.socketEpoch &&
          this.pushed.rev === message.rev;
        this.epoch = this.socketEpoch;
        if (!same) {
          this.pushed = message.snapshot
            ? { rev: message.rev, logTotal: message.logTotal, snapshot: message.snapshot }
            : null;
          this.guard(() => this.options.onSnapshot(this.pushed, null));
        }
        this.guard(() => this.options.onConnection({ up: true }));
        return;
      }
      case "delta": {
        let next: PushedSnapshot;
        try {
          if (!this.pushed) throw new ProtocolError("delta with no snapshot held");
          next = applyDelta(this.pushed, message.delta);
        } catch (err) {
          // A delta that does not fit: start over from a fresh snapshot.
          console.warn("console socket: resync", err);
          this.resync();
          return;
        }
        this.pushed = next;
        this.guard(() => this.options.onSnapshot(next, message.delta));
        return;
      }
      case "live":
        this.guard(() => this.options.onLive(message));
        return;
      case "card":
        this.guard(() => this.options.onCard(message));
        return;
      case "reply": {
        const pending = this.outstanding.get(message.id);
        if (!pending) return;
        this.outstanding.delete(message.id);
        if (message.ok) pending.resolve(message.result as never);
        else pending.reject(new RequestRefused(message.refusal));
        return;
      }
      case "heartbeat":
        return;
    }
  }

  // A store failing on a frame is not a socket failure: the next frame
  // supersedes it and the socket keeps flowing.
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error("console socket: a frame's handler failed", err);
    }
  }

  private send(message: ClientMessage): void {
    try {
      this.socket?.send(encodeMessage(message));
    } catch {
      // A socket closing under the send: its close does the work.
    }
  }

  private armSilence(): void {
    if (this.silence !== null) clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      this.silence = null;
      // A silent socket may be half open, where a close would wait on a
      // handshake that never comes, so it is let go of and replaced now.
      this.drop(4000, "silent");
      this.connect();
    }, this.heartbeatMs * SILENCE_FACTOR);
  }

  // The held snapshot no longer fits the deltas: close with the resync
  // code (the server logs why) and reopen for a fresh snapshot, after the
  // same delays a close waits out, so a server that keeps sending deltas
  // that do not fit is not hammered with sockets.
  private resync(): void {
    this.drop(CLOSE_RESYNC.code, CLOSE_RESYNC.reason);
    this.reconnectLater();
  }

  /** Let go of the current socket, refusing whatever is still out on it. */
  private drop(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.opened = false;
    this.greeted = false;
    for (const timer of [this.silence, this.stable]) if (timer !== null) clearTimeout(timer);
    this.silence = null;
    this.stable = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // already closed
      }
    }
    this.refuseOutstanding();
  }

  /** The socket closed: refuse what is out, say so, and reopen after the delay. */
  private lost(reason: string, stopped: boolean): void {
    this.opened = false;
    this.greeted = false;
    for (const timer of [this.silence, this.stable]) if (timer !== null) clearTimeout(timer);
    this.silence = null;
    this.stable = null;
    this.refuseOutstanding();
    if (this.finished) return;
    this.guard(() => this.options.onConnection({ up: false, reason, stopped }));
    this.reconnectLater();
  }

  /** Reopen after the next of the reconnect delays. */
  private reconnectLater(): void {
    if (this.finished) return;
    const delay = this.delays[Math.min(this.retries, this.delays.length - 1)] ?? 0;
    this.retries += 1;
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private refuseOutstanding(): void {
    const out = [...this.outstanding.values()];
    this.outstanding.clear();
    this.waiting = [];
    for (const pending of out) pending.reject(new RequestRefused(CONNECTION_LOST));
  }

  private clearTimers(): void {
    for (const timer of [this.silence, this.retry, this.stable]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.silence = null;
    this.retry = null;
    this.stable = null;
  }
}

// ---------------------------------------------------------------------------
// The version reload
// ---------------------------------------------------------------------------

/** The sessionStorage key the version reload's loop guard stamps. */
export const VERSION_RELOAD_KEY = "console-version-reload";

/** How recent a version reload must be for another to count as a loop. */
export const VERSION_RELOAD_GUARD_MS = 10_000;

/** The banner a page shows instead of reloading again. */
export const VERSION_BANNER = "Console was updated: reload the page";

/** The slice of sessionStorage the guard uses. */
export interface StampStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The server speaks another protocol version: reload, so the page picks up
 * the UI built for it, unless this tab already reloaded for that reason in
 * the last 10 s, when reloading again would only loop (a server still
 * serving old bytes). Returns whether it reloaded; false means the caller
 * shows VERSION_BANNER. The stamp goes in sessionStorage, or, where that is
 * missing or throws (a private window, blocked site data), in the fallback
 * (the window's name, which survives a reload too); a page that can stamp
 * neither does not reload, since nothing would stop it looping.
 */
export function reloadForVersion(
  storage: StampStore | null,
  now: number,
  reload: () => void,
  fallback: StampStore | null = null,
): boolean {
  let last = Number.NaN;
  for (const store of [storage, fallback]) {
    try {
      const stamp = store?.getItem(VERSION_RELOAD_KEY);
      if (stamp) {
        last = Number(stamp);
        break;
      }
    } catch {
      // this store cannot be read: try the next
    }
  }
  if (Number.isFinite(last) && now - last >= 0 && now - last < VERSION_RELOAD_GUARD_MS) {
    return false;
  }
  let stamped = false;
  for (const store of [storage, fallback]) {
    if (!store || stamped) continue;
    try {
      store.setItem(VERSION_RELOAD_KEY, String(now));
      stamped = true;
    } catch {
      // this store cannot be written: try the next
    }
  }
  if (!stamped) return false;
  reload();
  return true;
}

/**
 * A stamp store over a window's name: the version reload's guard where
 * sessionStorage is out of reach. A window's name outlives a reload of the
 * page in it, and the Console uses it for nothing else.
 */
export function windowNameStore(win: { name: string }): StampStore {
  return {
    getItem: (key) => {
      const prefix = `${key}=`;
      return win.name.startsWith(prefix) ? win.name.slice(prefix.length) : null;
    },
    setItem: (key, value) => {
      win.name = `${key}=${value}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/** The slice of a page's visibility lifecycle the socket follows. */
export interface VisibilitySource {
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
  readonly visibilityState: string;
}

/**
 * Tell the server whenever the page is shown or hidden: a hidden page gets
 * no live values and no log appends, and catches up when it is shown again.
 * Returns a function that removes the listener.
 */
export function followVisibility(source: VisibilitySource, socket: ConsoleSocket): () => void {
  const handler = (): void => socket.setVisible(source.visibilityState === "visible");
  source.addEventListener("visibilitychange", handler);
  return () => source.removeEventListener("visibilitychange", handler);
}
