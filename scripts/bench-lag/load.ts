/**
 * The lag bench's load: what N open Console tabs ask the server for, and the
 * operator's clicks timed through the same constraint a browser puts on them.
 * A tab speaks whichever protocol the server under test does
 * (detectProtocol): the push protocol over one WebSocket (issue #161,
 * ADR-0032), or, on a checkout from before it, the SSE stream and polls.
 *
 * Over the push protocol each tab holds one socket, says hello as visible
 * with its selected card subscribed, and sends nothing else on its own: the
 * server checks activity, peeks and grades once for every tab and pushes
 * what moved. A card click is an unsubscribe of the card it leaves and a
 * subscribe of the new one, timed to the new card's first `card` frame; Open
 * in herdr is a `terminal.focus` request, timed to its reply. The socket
 * takes no HTTP connection.
 *
 * Over the old protocol a browser speaks HTTP/1.1 to the pool server and
 * holds at most six connections per host for the whole browser, not per
 * tab, and every open tab's snapshot stream keeps one of them for good: two
 * tabs on one pool leave four for everything else. A click's fetch queues
 * behind whatever polls are already out. The simulated tabs share one such
 * budget, and each mirrors the old stores' request pattern
 * (ui/src/session.ts, vitals.ts, terminal.ts):
 *
 * - every snapshot: /api/grades; the selected card's /api/events and then
 *   its log tail; /api/activity for every in-progress or checkpoint Ticket;
 *   /api/terminal/peek for every pane on the snapshot (Tickets' and
 *   Conversations'), each skipped while that id's previous one is in flight;
 * - every 2 s: the same activity and peek polls, on their own timers.
 *
 * The probes then time what the operator feels there: a card click (the
 * body, events, then the log pane's two reads), Open in herdr (POST
 * /api/terminal/focus), from the moment of the click to the last byte, with
 * the time spent queued for a connection broken out.
 */

import {
  PROTOCOL_VERSION,
  WS_PATH,
  type ClientMessage,
  type ServerMessage,
} from "../../engine/protocol.ts";
import { decodeServerMessage, encodeMessage } from "../../ui/src/protocol.ts";

/** What a server under test speaks to its Console. */
export type Protocol = "ws" | "sse";

/** The server's socket URL, from its http base. */
export function socketUrl(base: string): string {
  return base.replace(/^http/, "ws") + WS_PATH;
}

/**
 * Which protocol the server at `base` speaks: the push protocol when a
 * socket at WS_PATH opens and says hello, the SSE stream when /api/stream
 * answers as one. Asked of the running server, not read off the checkout,
 * so a checkout part way through the change is measured as what it serves.
 */
export async function detectProtocol(base: string, timeoutMs = 5_000): Promise<Protocol> {
  const hello = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(socketUrl(base));
    let settled = false;
    // The first word counts: Bun runs onclose inside close(), so settle before it.
    const done = (said: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(said);
      socket.close();
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.onmessage = (event) => {
      try {
        done(decodeServerMessage(String(event.data)).type === "hello");
      } catch {
        done(false);
      }
    };
    socket.onerror = () => done(false);
    socket.onclose = () => done(false);
  });
  if (hello) return "ws";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const res = await fetch(`${base}/api/stream`, { signal: abort.signal }).catch(() => null);
  clearTimeout(timer);
  abort.abort();
  if (res?.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) return "sse";
  throw new Error(`${base} serves neither a socket at ${WS_PATH} nor an SSE stream at /api/stream`);
}

export interface Timing {
  /** Waiting for one of the tab's connections. */
  queuedMs: number;
  /** From the request leaving to its last byte. */
  serverMs: number;
  totalMs: number;
  status: number;
  bytes: number;
  /** The body, when the caller asked to read it. */
  text?: string;
}

/** A browser origin's connection budget, FIFO. */
export class ConnectionPool {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.free = size;
  }
  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
  get queued(): number {
    return this.waiters.length;
  }
}

/**
 * A simulated network round trip for the tabs' requests, in ms: the browser
 * on another machine (a laptop over Tailscale, say) holds each connection a
 * round trip longer than loopback does, which is what makes a six-connection
 * budget queue. Zero, loopback, unless the bench's --rtt sets it. The
 * responsiveness probe never pays it.
 */
let simulatedRttMs = 0;
export function setSimulatedRtt(ms: number): void {
  simulatedRttMs = ms;
}

export async function timedFetch(
  pool: ConnectionPool | null,
  url: string,
  init?: RequestInit,
  keepText = false,
): Promise<Timing> {
  const t0 = performance.now();
  if (pool) await pool.acquire();
  const t1 = performance.now();
  const halfTrip = pool && simulatedRttMs > 0 ? simulatedRttMs / 2 : 0;
  try {
    if (halfTrip) await Bun.sleep(halfTrip);
    const res = await fetch(url, init);
    const body = await res.arrayBuffer();
    if (halfTrip) await Bun.sleep(halfTrip);
    const t2 = performance.now();
    return {
      queuedMs: t1 - t0,
      serverMs: t2 - t1,
      totalMs: t2 - t0,
      status: res.status,
      bytes: body.byteLength,
      ...(keepText ? { text: new TextDecoder().decode(body) } : {}),
    };
  } catch {
    const t2 = performance.now();
    return { queuedMs: t1 - t0, serverMs: t2 - t1, totalMs: t2 - t0, status: 0, bytes: 0 };
  } finally {
    pool?.release();
  }
}

/** The slice of a snapshot the load reads. */
interface WireSnapshot {
  seq?: number;
  state: {
    tickets: {
      id: string;
      status: string;
      liveAttempt?: { attempt: number; paneId: string | null; role?: string } | null;
    }[];
    conversations?: { id: string; paneId: string | null }[];
  };
}

export interface TabStats {
  /** Snapshots: each SSE snapshot event, or each socket `snapshot` and `delta` frame. */
  snapshots: number;
  snapshotBytes: number[];
  snapshotArrivals: number[];
  requests: Record<string, Timing[]>;
  /** Every frame the tab's socket took, by type (none over SSE). */
  frames: Record<string, { count: number; bytes: number }>;
  /** Clicks and Open in herdrs the socket never answered within ANSWER_TIMEOUT_MS. */
  unanswered: number;
}

/** How long a socket tab waits for a card frame or a reply before giving up on it. */
const ANSWER_TIMEOUT_MS = 10_000;

const POLL_MS = 2_000;
/** The log pane's first window: the last 64 KiB (ui/src/project.ts). */
const LOG_TAIL_BYTES = 64 * 1024;

function logField(t: Timing, field: "totalSize" | "nextOffset"): number | null {
  try {
    const value = (JSON.parse(t.text ?? "") as Record<string, unknown>)[field];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}
/** Chromium's and Firefox's HTTP/1.1 limit per host, shared by every tab. */
export const CONNECTIONS_PER_HOST = 6;

/** One open Console tab. */
export class Tab {
  readonly stats: TabStats = {
    snapshots: 0,
    snapshotBytes: [],
    snapshotArrivals: [],
    requests: {},
    frames: {},
    unanswered: 0,
  };
  latest: WireSnapshot | null = null;
  /** The card this tab has open in the Detail: a ticket id or null. */
  selected: string | null;
  private readonly inFlight = new Set<string>();
  private readonly bodies = new Set<string>();
  private logOffset = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private abort = new AbortController();
  private recording = false;
  // The push protocol's socket, its request numbers and who waits on what.
  private socket: WebSocket | null = null;
  private nextRequest = 1;
  private readonly replies = new Map<number, (reply: Extract<ServerMessage, { type: "reply" }>) => void>();
  private readonly cardWaiters = new Map<string, (() => void)[]>();

  constructor(
    private readonly base: string,
    /** The browser's connections to this host, shared with its other tabs. */
    readonly pool: ConnectionPool,
    selected: string | null,
    /** What the server speaks; a socket tab takes none of the HTTP connections. */
    readonly protocol: Protocol = "sse",
  ) {
    this.selected = selected;
  }

  record(on: boolean): void {
    this.recording = on;
  }

  private note(kind: string, t: Timing): void {
    if (!this.recording) return;
    (this.stats.requests[kind] ??= []).push(t);
  }

  /** A request that skips while the same key's previous one is out. */
  private once(key: string, kind: string, path: string): void {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void timedFetch(this.pool, this.base + path).then((t) => {
      this.inFlight.delete(key);
      this.note(kind, t);
    });
  }

  async open(): Promise<void> {
    if (this.protocol === "ws") return this.openSocket();
    // The stream holds one of the browser's six connections for the tab's life.
    await this.pool.acquire();
    const res = await fetch(`${this.base}/api/stream`, { signal: this.abort.signal });
    void this.readStream(res).catch(() => {});
    this.timers.push(setInterval(() => this.poll(), POLL_MS));
  }

  close(): void {
    if (this.protocol === "ws") {
      this.socket?.close();
      return;
    }
    for (const t of this.timers) clearInterval(t);
    this.abort.abort();
    this.pool.release();
  }

  // --- the push protocol --------------------------------------------------------

  /** One socket for the tab's life, visible, with its selected card subscribed. */
  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl(this.base));
      this.socket = socket;
      socket.onopen = () => {
        this.send({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          visible: true,
          cards: this.selected ? [{ id: this.selected }] : [],
        });
        resolve();
      };
      socket.onerror = () => reject(new Error(`could not open ${socketUrl(this.base)}`));
      socket.onmessage = (event) => this.onFrame(String(event.data));
    });
  }

  private send(message: ClientMessage): void {
    this.socket?.send(encodeMessage(message));
  }

  private onFrame(text: string): void {
    const message = decodeServerMessage(text);
    const bytes = Buffer.byteLength(text);
    if (this.recording) {
      const tally = (this.stats.frames[message.type] ??= { count: 0, bytes: 0 });
      tally.count++;
      tally.bytes += bytes;
      if (message.type === "snapshot" || message.type === "delta") {
        this.stats.snapshots++;
        this.stats.snapshotBytes.push(bytes);
        this.stats.snapshotArrivals.push(performance.now());
      }
    }
    if (message.type === "card") {
      for (const wake of this.cardWaiters.get(message.id)?.splice(0) ?? []) wake();
    } else if (message.type === "reply") {
      this.replies.get(message.id)?.(message);
      this.replies.delete(message.id);
    }
  }

  /** Resolves true on the next `card` frame for `id`, false after ANSWER_TIMEOUT_MS. */
  private nextCard(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ANSWER_TIMEOUT_MS);
      (this.cardWaiters.get(id) ?? this.cardWaiters.set(id, []).get(id)!).push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** A click over the socket: leave the old card, subscribe the new one, until its first frame. */
  private async clickOverSocket(id: string): Promise<{ totalMs: number; queuedMs: number; requests: number }> {
    const previous = this.selected;
    this.selected = id;
    const t0 = performance.now();
    const halfTrip = simulatedRttMs / 2;
    if (halfTrip) await Bun.sleep(halfTrip);
    const arrived = this.nextCard(id);
    if (previous !== null) this.send({ type: "unsubscribe", id: previous });
    this.send({ type: "subscribe", card: { id } });
    if (!(await arrived)) this.stats.unanswered++;
    if (halfTrip) await Bun.sleep(halfTrip);
    return { totalMs: performance.now() - t0, queuedMs: 0, requests: 1 };
  }

  /** Open in herdr over the socket: a terminal.focus request, until its reply. */
  private async focusOverSocket(id: string): Promise<Timing> {
    const t0 = performance.now();
    const halfTrip = simulatedRttMs / 2;
    if (halfTrip) await Bun.sleep(halfTrip);
    const n = this.nextRequest++;
    const reply = new Promise<Extract<ServerMessage, { type: "reply" }> | null>((resolve) => {
      const timer = setTimeout(() => {
        this.replies.delete(n);
        resolve(null);
      }, ANSWER_TIMEOUT_MS);
      this.replies.set(n, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.send({ type: "request", id: n, kind: "terminal.focus", payload: { ticketId: id } });
    const answer = await reply;
    if (!answer) this.stats.unanswered++;
    if (halfTrip) await Bun.sleep(halfTrip);
    const totalMs = performance.now() - t0;
    return {
      queuedMs: 0,
      serverMs: totalMs,
      totalMs,
      status: answer === null ? 0 : answer.ok ? 200 : answer.refusal.status,
      bytes: 0,
    };
  }

  // --- the SSE stream and polls ------------------------------------------------

  private async readStream(res: Response): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!frame.startsWith("event: snapshot")) continue;
        const data = frame.slice(frame.indexOf("data: ") + 6);
        this.onSnapshot(JSON.parse(data) as WireSnapshot, data.length);
      }
    }
  }

  private onSnapshot(snapshot: WireSnapshot, bytes: number): void {
    this.latest = snapshot;
    if (this.recording) {
      this.stats.snapshots++;
      this.stats.snapshotBytes.push(bytes);
      this.stats.snapshotArrivals.push(performance.now());
    }
    this.once("grades", "grades", "/api/grades");
    if (this.selected) this.followSelected(this.selected);
    this.poll();
  }

  /** The 2 s polls, also run on every snapshot. */
  private poll(): void {
    const snap = this.latest;
    if (!snap) return;
    for (const t of snap.state.tickets) {
      if (t.status === "in-progress" || t.status === "checkpoint" || t.liveAttempt?.role === "resolver") {
        this.once(`activity:${t.id}`, "activity", `/api/activity?ticket=${encodeURIComponent(t.id)}`);
      }
      if (t.liveAttempt?.paneId) {
        this.once(`peek:${t.id}`, "peek", `/api/terminal/peek?ticket=${encodeURIComponent(t.id)}`);
      }
    }
    for (const c of snap.state.conversations ?? []) {
      if (c.paneId) this.once(`peek:${c.id}`, "peek", `/api/terminal/peek?ticket=${encodeURIComponent(c.id)}`);
    }
  }

  /** A snapshot's refetch of the open card: events, then the log tail from where it stopped. */
  private followSelected(id: string): void {
    const key = `follow:${id}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void (async () => {
      this.note("events", await timedFetch(this.pool, `${this.base}/api/events?ticket=${id}`));
      const attempt = this.attemptOf(id);
      if (attempt !== null) {
        const offset = this.logOffset.get(id) ?? 0;
        const t = await timedFetch(this.pool, this.logUrl(id, attempt, offset), undefined, true);
        this.note("log", t);
        this.noteOffset(id, t);
      }
    })().finally(() => this.inFlight.delete(key));
  }

  private logUrl(id: string, attempt: number, offset: number): string {
    return `${this.base}/api/log?ticket=${encodeURIComponent(id)}&attempt=${attempt}&offset=${offset}`;
  }

  private noteOffset(id: string, t: Timing): void {
    const next = logField(t, "nextOffset");
    if (next !== null) this.logOffset.set(id, next);
  }

  attemptOf(id: string): number | null {
    const t = this.latest?.state.tickets.find((x) => x.id === id);
    return t?.liveAttempt?.attempt ?? (t && t.status !== "ready" ? 1 : null);
  }

  /**
   * A card click. Over the socket, a subscribe (clickOverSocket). Over SSE,
   * as the old session and log pane made it: the body once, the events,
   * then the log pane's probe of the size and its tail window. The tab's
   * selection moves too, so its later snapshot refetches follow.
   */
  async click(id: string): Promise<{ totalMs: number; queuedMs: number; requests: number }> {
    if (this.protocol === "ws") return this.clickOverSocket(id);
    this.selected = id;
    const t0 = performance.now();
    let queued = 0;
    let requests = 0;
    // The session fetches a ticket's body on its first selection only.
    const body = this.bodies.has(id)
      ? null
      : timedFetch(this.pool, `${this.base}/api/ticket?id=${id}`);
    this.bodies.add(id);
    const events = await timedFetch(this.pool, `${this.base}/api/events?ticket=${id}`);
    queued += events.queuedMs;
    requests++;
    const attempt = this.attemptOf(id);
    if (attempt !== null) {
      const probe = await timedFetch(this.pool, this.logUrl(id, attempt, Number.MAX_SAFE_INTEGER), undefined, true);
      const total = logField(probe, "totalSize") ?? 0;
      const tail = await timedFetch(this.pool, this.logUrl(id, attempt, Math.max(0, total - LOG_TAIL_BYTES)), undefined, true);
      this.noteOffset(id, tail);
      queued += probe.queuedMs + tail.queuedMs;
      requests += 2;
    }
    if (body) {
      queued += (await body).queuedMs;
      requests++;
    }
    return { totalMs: performance.now() - t0, queuedMs: queued, requests };
  }

  /** Open in herdr. */
  focus(id: string): Promise<Timing> {
    if (this.protocol === "ws") return this.focusOverSocket(id);
    return timedFetch(this.pool, `${this.base}/api/terminal/focus?ticket=${id}`, { method: "POST" });
  }
}
