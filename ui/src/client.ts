/**
 * Pool client: the Console's single path to the pool server. The server serves
 * the built SPA, a small JSON API (get state, start, resume-with-answer), and
 * an SSE stream that pushes a full state snapshot on every change. The UI
 * renders from those snapshots only; this module is the only code that talks
 * to the server.
 */

import type { PoolSnapshot, TicketEventsResponse, TicketLogResponse } from "./project";

const DEFAULT_BASE = "";
const STREAM_PATH = "/api/stream";

interface StreamHandlers {
  onSnapshot: (snapshot: PoolSnapshot) => void;
  onError: (message: string) => void;
}

type ResumeAction = "resume" | "approve" | "reject";

export class PoolClient {
  private base: string;

  constructor(base: string = DEFAULT_BASE) {
    this.base = base;
  }

  /** The latest snapshot, or null before the server has started a run. */
  async getState(): Promise<PoolSnapshot | null> {
    const res = await fetch(`${this.base}/api/state`);
    if (!res.ok) throw new Error(`pool state failed: ${res.status}`);
    const body = await res.json();
    return body?.snapshot ?? null;
  }

  /** Start (or restart) the pool run and return the first snapshot. */
  async start(): Promise<PoolSnapshot> {
    const res = await fetch(`${this.base}/api/start`, { method: "POST" });
    if (!res.ok) throw new Error(`pool start failed: ${res.status}`);
    const body = await res.json();
    return body.snapshot;
  }

  /**
   * Answer an interrupt. `approve`/`reject` are used for the merge-approval
   * and review interrupts; plain `resume` answers every other kind. The
   * optional note is appended to the Issue file through the engine's resume
   * path (for a review reject, to the named tickets' Issues).
   */
  async answer(
    ticketId: string,
    action: ResumeAction,
    note?: string,
  ): Promise<PoolSnapshot> {
    const res = await fetch(`${this.base}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId, action, note }),
    });
    if (!res.ok) throw new Error(`pool resume failed: ${res.status}`);
    const body = await res.json();
    return body.snapshot;
  }

  /**
   * The selected ticket's parsed events, plus reconstructed attempt rows for
   * a ticket with no events file (a pre-feature pool). Fetched lazily for the
   * selected ticket and refetched when a new snapshot arrives.
   */
  async getEvents(ticketId: string): Promise<TicketEventsResponse> {
    const res = await fetch(
      `${this.base}/api/events?ticket=${encodeURIComponent(ticketId)}`,
    );
    if (!res.ok) throw new Error(`ticket events failed: ${res.status}`);
    return res.json();
  }

  /**
   * A byte range of an attempt's raw log, ANSI-stripped server-side. `offset`
   * is a raw byte offset; the response reports `nextOffset` (where the next
   * range starts) and `totalSize`, so the pane pages until offset reaches the
   * total. The optional `end` bounds the range, which is how "load earlier"
   * reads exactly the prefix before the bytes the pane already holds.
   */
  async getLog(
    ticketId: string,
    attempt: number,
    offset: number,
    end?: number,
  ): Promise<TicketLogResponse> {
    const params = new URLSearchParams({
      ticket: ticketId,
      attempt: String(attempt),
      offset: String(offset),
    });
    if (end !== undefined) params.set("end", String(end));
    const res = await fetch(`${this.base}/api/log?${params}`);
    if (!res.ok) throw new Error(`ticket log failed: ${res.status}`);
    return res.json();
  }

  /**
   * Open the SSE snapshot stream. Each change pushes a full snapshot; on
   * connect the server immediately replays the latest snapshot so a client
   * joining mid-run does not miss state. Returns a function that closes the
   * stream.
   */
  stream(handlers: StreamHandlers): () => void {
    const source = new EventSource(`${this.base}${STREAM_PATH}`);
    source.addEventListener("snapshot", (event) => {
      try {
        const snapshot = JSON.parse((event as MessageEvent).data) as PoolSnapshot;
        handlers.onSnapshot(snapshot);
      } catch {
        // ignore malformed frames; the next snapshot will supersede
      }
    });
    source.onerror = () => {
      handlers.onError("pool stream disconnected");
    };
    return () => source.close();
  }
}
