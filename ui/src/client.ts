/**
 * Pool client: the Console's single path to the pool server. The server serves
 * the built SPA, a small JSON API (get state, start, resume-with-answer), and
 * an SSE stream that pushes a full state snapshot on every change plus an SSE
 * comment heartbeat on a fixed cadence. The UI renders from those snapshots
 * only; this module is the only code that talks to the server.
 */

import type {
  GradeView,
  PoolConversationState,
  PoolSnapshot,
  StartConversationRequest,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEventsResponse,
  TicketLogResponse,
} from "./project";

const DEFAULT_BASE = "";
const STREAM_PATH = "/api/stream";

/**
 * The fallback snapshot-stream heartbeat interval. The server publishes its
 * real interval as the stream's opening frame and the silence window derives
 * from that served value; this default covers the window before that first
 * frame lands and a server old enough to never send one. Any stream frame,
 * snapshot or heartbeat, proves the connection is alive.
 */
export const STREAM_HEARTBEAT_MS = 20_000;

/** The bounded multiple of the heartbeat interval a stream may stay silent. */
export const STREAM_SILENCE_FACTOR = 3;

/** The reconnect delay after a failed or closed stream, matching the browser
 *  EventSource's default reconnection time. */
const STREAM_RETRY_MS = 3_000;

interface StreamHandlers {
  onSnapshot: (snapshot: PoolSnapshot) => void;
  onError: (message: string) => void;
}

type ResumeAction = "resume" | "approve" | "reject";

/** Split complete SSE frames (terminated by a blank line) off a buffer. */
function takeSseFrames(buffer: string): { rest: string; frames: string[] } {
  let rest = buffer;
  const frames: string[] = [];
  for (let end = rest.indexOf("\n\n"); end !== -1; end = rest.indexOf("\n\n")) {
    frames.push(rest.slice(0, end));
    rest = rest.slice(end + 2);
  }
  return { rest, frames };
}

type StreamFrame =
  | { kind: "snapshot"; snapshot: PoolSnapshot }
  | { kind: "stream-config"; heartbeatMs: number };

/**
 * What an SSE frame carries, or null for a frame that is neither a snapshot
 * nor the stream config (a heartbeat comment or any malformed frame). The
 * server opens the stream with one `event: stream-config` frame publishing
 * its heartbeat interval, then pushes exactly `event: snapshot` with a
 * single-line JSON data field, so the per-field parse is small. A config
 * frame whose interval is not a positive finite number is ignored: the
 * fallback interval keeps applying.
 */
function streamFrameFromSse(frame: string): StreamFrame | null {
  let eventType = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventType = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  try {
    const parsed = JSON.parse(data.join("\n"));
    if (eventType === "snapshot") {
      return { kind: "snapshot", snapshot: parsed as PoolSnapshot };
    }
    if (eventType === "stream-config") {
      const heartbeatMs = (parsed as { heartbeatMs?: unknown }).heartbeatMs;
      if (typeof heartbeatMs === "number" && Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
        return { kind: "stream-config", heartbeatMs };
      }
    }
    return null;
  } catch {
    return null;
  }
}

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

  async getActivity(ticketId: string): Promise<TicketActivityResponse> {
    const res = await fetch(
      `${this.base}/api/activity?ticket=${encodeURIComponent(ticketId)}`,
    );
    if (!res.ok) throw new Error(`ticket activity failed: ${res.status}`);
    return res.json();
  }

  /**
   * The latest grade per ticket, keyed by ticket id, for the card summaries.
   * Derived server-side from the same events files the Detail's timeline
   * reads. Tickets without a grade are absent. Fetched on the snapshot
   * cadence, like the selected ticket's events.
   */
  async getGrades(): Promise<Record<string, GradeView>> {
    const res = await fetch(`${this.base}/api/grades`);
    if (!res.ok) throw new Error(`pool grades failed: ${res.status}`);
    const body = await res.json();
    return body?.grades ?? {};
  }

  /**
   * The selected ticket's markdown body (the line-1 `<!-- state: ... -->`
   * marker stripped server-side) for the ticket Detail. Null when no Issue
   * file matches the id.
   */
  async getTicket(ticketId: string): Promise<TicketBodyResponse | null> {
    const res = await fetch(
      `${this.base}/api/ticket?id=${encodeURIComponent(ticketId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ticket body failed: ${res.status}`);
    return res.json();
  }

  /**
   * A byte range of an attempt's raw log, ANSI-stripped server-side. `offset`
   * is a raw byte offset; the response reports `nextOffset` (where the next
   * range starts) and `totalSize`, so the pane pages until offset reaches the
   * total. The optional `end` bounds the range, which is how "load earlier"
   * reads exactly the prefix before the bytes the pane already holds. With
   * `stream`, the same range is read from the attempt's Stream file (the raw
   * stream tee) instead of its derived log.
   */
  async getLog(
    ticketId: string,
    attempt: number,
    offset: number,
    end?: number,
    stream?: boolean,
  ): Promise<TicketLogResponse> {
    const params = new URLSearchParams({
      ticket: ticketId,
      attempt: String(attempt),
      offset: String(offset),
    });
    if (end !== undefined) params.set("end", String(end));
    if (stream) params.set("stream", "1");
    const res = await fetch(`${this.base}/api/log?${params}`);
    if (!res.ok) throw new Error(`ticket log failed: ${res.status}`);
    return res.json();
  }

  /**
   * The attempt pane's recent output as plain text for the card's read-only
   * peek (ADR-0014). Keyed by ticket id: the server resolves the pane from
   * the pool's own events and refuses panes the pool did not spawn. Any
   * failure (no pane, spawn-guard refusal, daemon error) throws; the card
   * renders "pane unavailable" and disables its focus button.
   */
  async peekTerminal(ticketId: string): Promise<TerminalPeekResponse> {
    const res = await fetch(
      `${this.base}/api/terminal/peek?ticket=${encodeURIComponent(ticketId)}`,
    );
    if (!res.ok) throw new Error(`terminal peek failed: ${res.status}`);
    return res.json();
  }

  /**
   * "Open in herdr": focus the attempt's pane, jumping the operator's herdr
   * TUI to the attempt's tab. Same ticket-keyed translation and guard as the
   * peek; a mutating call, so POST. Throws on any failure.
   */
  async focusTerminal(ticketId: string): Promise<void> {
    const res = await fetch(
      `${this.base}/api/terminal/focus?ticket=${encodeURIComponent(ticketId)}`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(`terminal focus failed: ${res.status}`);
  }

  /** Every Conversation on the pool (live, ended, and crashed), for a
   *  standalone refresh outside the snapshot stream. */
  async listConversations(): Promise<PoolConversationState[]> {
    const res = await fetch(`${this.base}/api/conversations`);
    if (!res.ok) throw new Error(`list conversations failed: ${res.status}`);
    const body = await res.json();
    return body?.conversations ?? [];
  }

  /**
   * Start a Conversation (ADR-0017). 409 with a reason when the pool is not
   * terminal-backed; the reason (or a generic message) becomes the thrown
   * Error's message, which the New Conversation form shows inline.
   */
  async startConversation(
    request: StartConversationRequest,
  ): Promise<PoolConversationState> {
    const res = await fetch(`${this.base}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const reason =
        body && typeof (body as { reason?: unknown }).reason === "string"
          ? (body as { reason: string }).reason
          : null;
      throw new Error(reason ?? `start conversation failed: ${res.status}`);
    }
    const body = await res.json();
    return body.conversation;
  }

  /**
   * End a Conversation, with an optional closing line. Returns the snapshot
   * the pool server hands back with the request (202): the Conversation may
   * still be merging or crashed-detection in flight, so the caller renders
   * from it the same way it renders any other snapshot.
   */
  async endConversation(id: string, closing?: string): Promise<PoolSnapshot> {
    const res = await fetch(`${this.base}/api/conversations/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, closing }),
    });
    if (!res.ok) throw new Error(`end conversation failed: ${res.status}`);
    const body = await res.json();
    return body.snapshot;
  }

  /**
   * Open the SSE snapshot stream, self-healing. Each change pushes a full
   * snapshot; on connect the server immediately replays the latest snapshot so
   * a client joining mid-run does not miss state, and it pushes a comment
   * heartbeat on a fixed cadence. The stream is read with fetch rather than a
   * browser EventSource because the heartbeat is a comment frame: EventSource
   * never dispatches comments, and the client needs every frame to tell a
   * half-open connection from a quiet-but-healthy pool. The server's opening
   * frame publishes its heartbeat interval and the silence window derives
   * from it (falling back to STREAM_HEARTBEAT_MS until it lands). Any frame
   * resets the silence window; a stream silent for a bounded multiple of the
   * heartbeat interval is torn down and reopened, and the replayed
   * snapshot on reconnect renders, so a half-open connection recovers with no
   * page refresh. Silence is a reconnect trigger, never the connection
   * banner's error; only a fetch failure or a stream error or close raises
   * onError, and those schedule a retry reopen the way EventSource would.
   * Returns a function that closes the stream.
   */
  stream(handlers: StreamHandlers): () => void {
    const aborted = new AbortController();
    let closed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // True while the silence watchdog is tearing down a quiet stream: the
    // cancel of the in-flight read rejects, and that rejection is the reopen
    // already in flight, not the connection banner's error.
    let reopening = false;
    // The heartbeat interval the silence window derives from: the fallback
    // until the server's opening stream-config frame serves the real value.
    let heartbeatMs = STREAM_HEARTBEAT_MS;

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const arm = (delay: number, fn: () => void): void => {
      clearTimer();
      timer = setTimeout(fn, delay);
    };

    const armSilence = (): void => {
      arm(heartbeatMs * STREAM_SILENCE_FACTOR, () => {
        reopening = true;
        void reader?.cancel().catch(() => {});
        void open();
      });
    };

    const open = async (): Promise<void> => {
      if (closed) return;
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        const res = await fetch(`${this.base}${STREAM_PATH}`, {
          signal: aborted.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`pool stream failed: ${res.status}`);
        }
        reader = res.body.getReader();
        armSilence();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // Bytes arrived: the connection is alive, reset the silence window.
          armSilence();
          buffer += decoder.decode(value, { stream: true });
          const { rest, frames } = takeSseFrames(buffer);
          buffer = rest;
          for (const frame of frames) {
            const parsed = streamFrameFromSse(frame);
            if (!parsed) continue;
            if (parsed.kind === "stream-config") {
              // The served interval replaces the fallback; re-arm so the new
              // window takes effect from this frame, not the next one.
              heartbeatMs = parsed.heartbeatMs;
              armSilence();
              continue;
            }
            try {
              handlers.onSnapshot(parsed.snapshot);
            } catch {
              // A snapshot render failure is not a stream failure; the next
              // snapshot supersedes it and the stream keeps flowing.
            }
          }
        }
      } catch (err) {
        if (closed) return;
        if (reopening) {
          reopening = false;
          return;
        }
        handlers.onError(err instanceof Error ? err.message : String(err));
        arm(STREAM_RETRY_MS, () => void open());
        return;
      }
      if (closed) return;
      if (reopening) {
        reopening = false;
        return;
      }
      // The server closed the stream: reconnect after the retry delay, the way
      // the browser EventSource reconnects on a closed connection.
      handlers.onError("pool stream disconnected");
      arm(STREAM_RETRY_MS, () => void open());
    };

    void open();

    return () => {
      closed = true;
      clearTimer();
      aborted.abort();
      void reader?.cancel().catch(() => {});
    };
  }
}

/** The slice of a page's visibility lifecycle the refetch-on-visible reads. */
export interface VisibilitySource {
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
  readonly visibilityState: string;
}

/**
 * Belt and braces over the stream's self-healing: when the page returns to
 * visible (a tab the machine slept under, or one buried for hours), refetch
 * the latest snapshot and render it. The stream's silence watchdog reopens a
 * half-open connection on the same wake, so the two paths race harmlessly to
 * the same fresh render. Returns a function that removes the listener.
 */
export function refetchStateOnVisible(
  source: VisibilitySource,
  getState: () => Promise<PoolSnapshot | null>,
  onSnapshot: (snapshot: PoolSnapshot) => void,
): () => void {
  const handler = (): void => {
    if (source.visibilityState !== "visible") return;
    void getState()
      .then((snapshot) => {
        if (snapshot) onSnapshot(snapshot);
      })
      .catch(() => {
        // The stream recovers on its own; a failed refetch leaves the last
        // snapshot in place.
      });
  };
  source.addEventListener("visibilitychange", handler);
  return () => source.removeEventListener("visibilitychange", handler);
}
