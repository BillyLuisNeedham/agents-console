/**
 * Pool client: the Console's single path to the pool server. The server serves
 * the built SPA, a small JSON API (get state, start, resume-with-answer, stop), and
 * an SSE stream that pushes a full state snapshot on every change plus an SSE
 * comment heartbeat on a fixed cadence. The UI renders from those snapshots
 * only; this module is the only code that talks to the server.
 */

import type {
  CloseFinishedTerminalsResponse,
  ConversationView,
  EnlistRequest,
  EnlistResponse,
  EnrichedSnapshot,
  HeldSpawnRequest,
  HeldSpawnResponse,
  PendingSpawnRequest,
  PendingSpawnResponse,
  KeepTalkingRequest,
  KeepTalkingResponse,
  PanesResponse,
  ReassignRequest,
  ReassignResponse,
  ResumeAction,
  StartConversationRequest,
  TerminalPeekResponse,
  TicketActivityResponse,
  TicketBodyResponse,
  TicketEventsResponse,
  TicketGradeSummary,
  TicketLogResponse,
} from "../../engine/wire.ts";
import type {
  MachineDefaults,
  PoolConfigPatch,
  RestartResponse,
  SettingsResponse,
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
  onSnapshot: (snapshot: EnrichedSnapshot) => void;
  onError: (message: string) => void;
}

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
  | { kind: "snapshot"; snapshot: EnrichedSnapshot }
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
      return { kind: "snapshot", snapshot: parsed as EnrichedSnapshot };
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
  async getState(): Promise<EnrichedSnapshot | null> {
    const res = await fetch(`${this.base}/api/state`);
    if (!res.ok) throw new Error(`pool state failed: ${res.status}`);
    const body = await res.json();
    return body?.snapshot ?? null;
  }

  /** Start (or restart) the pool run and return the first snapshot. */
  async start(): Promise<EnrichedSnapshot> {
    const res = await fetch(`${this.base}/api/start`, { method: "POST" });
    if (!res.ok) throw new Error(`pool start failed: ${res.status}`);
    const body = await res.json();
    return body.snapshot;
  }

  /**
   * Stop this pool's server (issue #97). The server answers 202 the moment it
   * accepts, before the shutdown itself begins, so this resolving means only
   * that the stop landed; the tab learns it finished from the farewell
   * `stopped` snapshot on the stream. A refusal (the pool is running, or was
   * never started) carries its reason in the JSON body's `error`, and that
   * reason becomes the thrown Error's message so the Stop control can show it
   * inline.
   */
  async stop(): Promise<void> {
    const res = await fetch(`${this.base}/api/stop`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const error =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      throw new Error(error ?? `pool stop failed: ${res.status}`);
    }
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
  ): Promise<EnrichedSnapshot> {
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
   * selected ticket and refetched when a new snapshot arrives; `signal`
   * aborts it once the operator has clicked away.
   */
  async getEvents(ticketId: string, signal?: AbortSignal): Promise<TicketEventsResponse> {
    const res = await fetch(
      `${this.base}/api/events?ticket=${encodeURIComponent(ticketId)}`,
      { signal },
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
  async getGrades(): Promise<Record<string, TicketGradeSummary>> {
    const res = await fetch(`${this.base}/api/grades`);
    if (!res.ok) throw new Error(`pool grades failed: ${res.status}`);
    const body = await res.json();
    return body?.grades ?? {};
  }

  /**
   * The selected ticket's markdown body (the line-1 `<!-- state: ... -->`
   * marker stripped server-side) for the ticket Detail. Null when no Issue
   * file matches the id. `signal` aborts it once the operator has clicked
   * away.
   */
  async getTicket(ticketId: string, signal?: AbortSignal): Promise<TicketBodyResponse | null> {
    const res = await fetch(
      `${this.base}/api/ticket?id=${encodeURIComponent(ticketId)}`,
      { signal },
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
   * stream tee) instead of its derived log. `signal` aborts it once the pane
   * has moved to another window.
   */
  async getLog(
    ticketId: string,
    attempt: number,
    offset: number,
    end?: number,
    stream?: boolean,
    signal?: AbortSignal,
  ): Promise<TicketLogResponse> {
    const params = new URLSearchParams({
      ticket: ticketId,
      attempt: String(attempt),
      offset: String(offset),
    });
    if (end !== undefined) params.set("end", String(end));
    if (stream) params.set("stream", "1");
    const res = await fetch(`${this.base}/api/log?${params}`, { signal });
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

  /**
   * The live herdr panes an enlist could take in (issue #101), fetched when
   * the picker opens rather than through the snapshot: the list is ephemeral
   * and not pool state. Each pane carries the engine's verdict and, when it
   * is ineligible, the reason beside it. A headless pool refuses with a 409
   * `reason`; a daemon failure is a 502 `error`.
   */
  async listPanes(): Promise<PanesResponse> {
    const res = await fetch(`${this.base}/api/panes`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const reason =
        body && typeof (body as { reason?: unknown }).reason === "string"
          ? (body as { reason: string }).reason
          : null;
      const error =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      throw new Error(reason ?? error ?? `list panes failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Start a Conversation (ADR-0018). 409 with a reason when the pool is not
   * terminal-backed; the reason (or a generic message) becomes the thrown
   * Error's message, which the New Conversation form shows inline.
   */
  async startConversation(
    request: StartConversationRequest,
  ): Promise<ConversationView> {
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
  async endConversation(id: string, closing?: string): Promise<EnrichedSnapshot> {
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
   * Enlist a live herdr pane as a Ticket (issue #101). 409 with a reason
   * when the engine refuses (the pane is gone, already in the pool, a branch
   * could not be made, the teaching Turn never landed); the reason becomes
   * the thrown Error's message, which the Enlist form shows inline.
   */
  async enlist(request: EnlistRequest): Promise<EnlistResponse> {
    const res = await fetch(`${this.base}/api/enlist`, {
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
      throw new Error(reason ?? `enlist failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Keep talking (issue #139): continue a ticket's checkpointed Attempt in
   * its Held pane as a Continued attempt. Not an answer, so not the resume
   * route: nothing waits for the boundary. 202 with the Continued attempt's
   * number once the engine has claimed the pane; the engine's refusal (the
   * pane is gone, the checkpoint was answered, the ticket is not at one) is
   * a 409 and a malformed body a 400, both carrying `reason`, which becomes
   * the thrown Error's message for the button to show beside itself.
   */
  async keepTalking(ticketId: string): Promise<KeepTalkingResponse> {
    const request: KeepTalkingRequest = { ticketId };
    const res = await fetch(`${this.base}/api/keep-talking`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error((await refusalReason(res)) ?? `keep talking failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Close every Finished terminal the pool opened (issue #139): the herdr
   * tabs still open over an Attempt or a Conversation that has ended. The
   * engine never closes them on its own; this is the pool header's bulk
   * close, answering 200 with how many it closed. A pool that is not
   * Terminal-backed refuses with a 409 `reason`, shown beside the control.
   */
  async closeFinishedTerminals(): Promise<CloseFinishedTerminalsResponse> {
    const res = await fetch(`${this.base}/api/terminals/close-finished`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(
        (await refusalReason(res)) ?? `close finished terminals failed: ${res.status}`,
      );
    }
    return res.json();
  }

  /**
   * Adopt a Held spawn (issue #149, ADR-0029): take a proposal a Spawn cap
   * held into the pool past both caps. 202 once the adoption is queued; the
   * spawn stays on the snapshot, marked adopting, until the engine writes
   * it. A refusal (no such spawn, one the pool would reject, a finished
   * pool) is a 409 `reason`, shown beside the spawn's buttons.
   */
  async adoptHeldSpawn(id: string): Promise<HeldSpawnResponse> {
    return this.decideHeldSpawn("adopt", id);
  }

  /** Discard a Held spawn for good (issue #149): 200 once it is gone. */
  async discardHeldSpawn(id: string): Promise<HeldSpawnResponse> {
    return this.decideHeldSpawn("discard", id);
  }

  private async decideHeldSpawn(
    decision: "adopt" | "discard",
    id: string,
  ): Promise<HeldSpawnResponse> {
    const request: HeldSpawnRequest = { id };
    const res = await fetch(`${this.base}/api/spawns/held/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(
        (await refusalReason(res)) ?? `${decision} held spawn failed: ${res.status}`,
      );
    }
    return res.json();
  }

  /**
   * Hold a Pending spawn back from the boundary (issue #150): it becomes a
   * Held spawn, held by the operator, under the same id. 200 once it is
   * held; one that has already landed is a 409 `reason`.
   */
  async holdPendingSpawn(id: string): Promise<PendingSpawnResponse> {
    return this.decidePendingSpawn("hold", id);
  }

  /** Discard a Pending spawn before it lands (issue #150): 200 once gone. */
  async discardPendingSpawn(id: string): Promise<PendingSpawnResponse> {
    return this.decidePendingSpawn("discard", id);
  }

  private async decidePendingSpawn(
    decision: "hold" | "discard",
    id: string,
  ): Promise<PendingSpawnResponse> {
    const request: PendingSpawnRequest = { id };
    const res = await fetch(`${this.base}/api/spawns/pending/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(
        (await refusalReason(res)) ?? `${decision} pending spawn failed: ${res.status}`,
      );
    }
    return res.json();
  }

  /**
   * The Settings pane's read (ADR-0026): the pool's own config, the machine
   * defaults (merged and as the file holds them), and the harnesses the pane
   * offers. Fetched when the pane opens, never through the snapshot: settings
   * are files on disk, not pool state.
   */
  async getSettings(): Promise<SettingsResponse> {
    const res = await fetch(`${this.base}/api/settings`);
    if (!res.ok) throw new Error(`settings failed: ${res.status}`);
    return res.json();
  }

  /**
   * Write a patch of the pool's config. A key sent as null or "" is removed
   * from the file. A rejected patch answers 400 with its reason in `error`,
   * and that reason becomes the thrown Error's message so the pane can show
   * it inline beside Save, the way a refused stop shows beside its button.
   * The response is the same payload the read serves, so the pane re-seeds
   * from what is now on disk rather than from what it sent.
   */
  async savePoolSettings(config: PoolConfigPatch): Promise<SettingsResponse> {
    return this.putJson("/api/settings/pool", { config }, "settings save failed");
  }

  /** Write the machine defaults file. Same shapes and refusal as above. */
  async saveMachineDefaults(defaults: MachineDefaults): Promise<SettingsResponse> {
    return this.putJson("/api/settings/machine", { defaults }, "settings save failed");
  }

  /**
   * Reassign (issue #126): rewrite the `assign` entries of the named tickets,
   * field by field. A key absent from `fields` leaves that field alone, a
   * value sets it, and null clears it so the ticket follows its parent or the
   * pool defaults again. A refused write (a ticket that would end unassigned,
   * an unknown harness or ticket, a bad verify) answers 400 with its reason in
   * `error`, which becomes the thrown Error's message so the editor can show
   * it inline; nothing is written in that case. The answer carries the fresh
   * snapshot, which the caller pushes through setSnapshot so the cards show
   * the new Assignment at once.
   */
  async reassign(request: ReassignRequest): Promise<ReassignResponse> {
    return this.putJson("/api/reassign", request, "reassign failed");
  }

  /**
   * The shared write: PUT JSON, and on a refusal pull `error` out of the JSON
   * body and throw it as the Error's message, so the control that asked for
   * the write can show the engine's own reason beside itself rather than on
   * the global banner.
   */
  private async putJson<T>(
    path: string,
    body: unknown,
    fallback: string,
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const error =
        payload && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : null;
      throw new Error(error ?? `${fallback}: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Restart this pool's server (ADR-0026). The server answers 202 with the
   * port the relaunched server will use, then sends its farewell `stopped`
   * snapshot and exits; a Boot script brings it back within a few seconds,
   * longer when the UI build is stale and Boot rebuilds it. Resolving means
   * only that the restart was accepted; the tab learns the rest from the
   * farewell and from polling the port this answers with. A refusal carries
   * its reason in `error`, shown inline beside the control.
   */
  async restart(): Promise<RestartResponse> {
    const res = await fetch(`${this.base}/api/restart`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const error =
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      throw new Error(error ?? `pool restart failed: ${res.status}`);
    }
    return res.json();
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

/**
 * A refusal's `reason`, the envelope the enlist and Keep talking routes
 * answer a 409 or 400 with; null when the body is not JSON or carries none,
 * so the caller falls back to a generic message with the status.
 */
async function refusalReason(res: Response): Promise<string | null> {
  const body = await res.json().catch(() => null);
  return body && typeof (body as { reason?: unknown }).reason === "string"
    ? (body as { reason: string }).reason
    : null;
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
  getState: () => Promise<EnrichedSnapshot | null>,
  onSnapshot: (snapshot: EnrichedSnapshot) => void,
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
