/**
 * The lag bench's load: what N open Console tabs ask the server for, and the
 * operator's clicks timed through the same constraint a browser puts on them.
 *
 * A browser speaks HTTP/1.1 to the pool server and holds at most six
 * connections per host for the whole browser, not per tab, and every open
 * tab's snapshot stream keeps one of them for good: two tabs on one pool
 * leave four for everything else. A click's fetch queues behind whatever
 * polls are already out. The simulated tabs share one such budget, and each
 * mirrors the real stores' request pattern (ui/src/session.ts, vitals.ts,
 * terminal.ts):
 *
 * - every snapshot: /api/grades; the selected card's /api/events and then
 *   its log tail; /api/activity for every in-progress or checkpoint Ticket;
 *   /api/terminal/peek for every pane on the snapshot (Tickets' and
 *   Conversations'), each skipped while that id's previous one is in flight;
 * - every 2 s: the same activity and peek polls, on their own timers.
 *
 * The probes then time what the operator feels: a card click (the body,
 * events, then the log pane's two reads), Open in herdr (POST
 * /api/terminal/focus), from the moment of the click to the last byte, with
 * the time spent queued for a connection broken out.
 */

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
  snapshots: number;
  snapshotBytes: number[];
  snapshotArrivals: number[];
  requests: Record<string, Timing[]>;
}

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
  readonly stats: TabStats = { snapshots: 0, snapshotBytes: [], snapshotArrivals: [], requests: {} };
  latest: WireSnapshot | null = null;
  /** The card this tab has open in the Detail: a ticket id or null. */
  selected: string | null;
  private readonly inFlight = new Set<string>();
  private readonly bodies = new Set<string>();
  private logOffset = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private abort = new AbortController();
  private recording = false;

  constructor(
    private readonly base: string,
    /** The browser's connections to this host, shared with its other tabs. */
    readonly pool: ConnectionPool,
    selected: string | null,
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
    // The stream holds one of the browser's six connections for the tab's life.
    await this.pool.acquire();
    const res = await fetch(`${this.base}/api/stream`, { signal: this.abort.signal });
    void this.readStream(res).catch(() => {});
    this.timers.push(setInterval(() => this.poll(), POLL_MS));
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.abort.abort();
    this.pool.release();
  }

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
   * A card click, as the session and log pane make it: the body once, the
   * events, then the log pane's probe of the size and its tail window. The
   * tab's selection moves too, so its later snapshot refetches follow.
   */
  async click(id: string): Promise<{ totalMs: number; queuedMs: number; requests: number }> {
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
    return timedFetch(this.pool, `${this.base}/api/terminal/focus?ticket=${id}`, { method: "POST" });
  }
}
