/**
 * Vitals store: the client side of the client-polled liveness readout
 * (ADR 0011). Polls the activity endpoint for every ticket that can hold a
 * live attempt (status in-progress, or checkpoint where a resolver may be
 * in flight, which only the response's running flag can tell), every 2s and
 * once per pool snapshot. A response that says nothing is live drops the
 * ticket from the 2s cadence until the next snapshot re-arms it, so a silent
 * pool costs no git spawns, and no polling happens at all when no candidate
 * exists. Held payloads and sparkline samples are ephemeral client memory:
 * the projection renders live or frozen Vitals from them, and nothing
 * renders before the first payload lands.
 */

import {
  projectVitals,
  pushVitalsSample,
  type EnrichedSnapshot,
  type TicketActivityResponse,
  type TicketStatus,
  type VitalsState,
} from "./project";

/** The poll cadence: one request per live ticket per interval. */
export const VITALS_POLL_MS = 2_000;

const CANDIDATE_STATUSES = new Set<TicketStatus>(["in-progress", "checkpoint"]);

export type ActivityFetch = (
  ticketId: string,
) => Promise<TicketActivityResponse>;

export interface VitalsOptions {
  fetch: ActivityFetch;
  /** Called after every state change the view should repaint. */
  onChange: () => void;
  /** The poll cadence; tests shorten or lengthen it. */
  pollMs?: number;
}

export class Vitals {
  private readonly fetchActivity: ActivityFetch;
  private readonly notify: () => void;
  private readonly pollMs: number;
  private readonly payloads = new Map<string, TicketActivityResponse>();
  private readonly samples = new Map<string, number[]>();
  /** Tickets currently on the 2s cadence: a live latest attempt. */
  private readonly active = new Set<string>();
  /** Fetches already out; a slow answer never stacks or delays the others. */
  private readonly inFlight = new Set<string>();
  private candidates = new Set<string>();
  private statuses = new Map<string, TicketStatus>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: VitalsOptions) {
    this.fetchActivity = options.fetch;
    this.notify = options.onChange;
    this.pollMs = options.pollMs ?? VITALS_POLL_MS;
    if (typeof setInterval !== "undefined") {
      this.timer = setInterval(() => this.tick(), this.pollMs);
    }
  }

  /**
   * The snapshot cadence: prune to the pool, re-derive the candidates, and
   * refetch each once. A spawn or resolver start emits a snapshot, so this is
   * also what re-arms a ticket whose last response said nothing was live.
   */
  update(snapshot: EnrichedSnapshot | null): void {
    const tickets = snapshot?.state.tickets ?? [];
    const known = new Set(tickets.map((t) => t.id));
    for (const id of [...this.payloads.keys()]) {
      if (!known.has(id)) this.payloads.delete(id);
    }
    for (const id of [...this.samples.keys()]) {
      if (!known.has(id)) this.samples.delete(id);
    }
    this.candidates = new Set(
      tickets.filter((t) => CANDIDATE_STATUSES.has(t.status)).map((t) => t.id),
    );
    this.statuses = new Map(tickets.map((t) => [t.id, t.status]));
    for (const id of [...this.active]) {
      if (!this.candidates.has(id)) this.active.delete(id);
    }
    for (const id of this.candidates) this.poll(id);
  }

  /** The per-ticket vitals input the projection renders from. */
  state(): Record<string, VitalsState> {
    const state: Record<string, VitalsState> = {};
    for (const [id, activity] of this.payloads) {
      state[id] = { activity, samples: this.samples.get(id) ?? [] };
    }
    return state;
  }

  /** Stop the poll timer (session teardown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    for (const id of this.active) this.poll(id);
    // The staleness copy ticks in wall-clock time even while the snapshot
    // stream is silent (a resolver run, a quiet agent, a pool parked at an
    // interrupt with frozen cards), so re-render whenever a candidate's
    // held payload would render as Vitals at all.
    for (const id of this.candidates) {
      const payload = this.payloads.get(id);
      const status = this.statuses.get(id);
      if (!payload || !status) continue;
      if (projectVitals({ activity: payload, samples: [] }, status, Date.now())) {
        this.notify();
        return;
      }
    }
  }

  private poll(ticketId: string): void {
    if (this.inFlight.has(ticketId)) return;
    this.inFlight.add(ticketId);
    this.fetchActivity(ticketId)
      .then((activity) => {
        this.payloads.set(ticketId, activity);
        if (activity.running && this.candidates.has(ticketId)) {
          this.active.add(ticketId);
          const diff = activity.diff;
          this.samples.set(
            ticketId,
            pushVitalsSample(
              this.samples.get(ticketId) ?? [],
              diff ? diff.added + diff.removed : 0,
            ),
          );
        } else {
          this.active.delete(ticketId);
        }
        this.notify();
      })
      .catch(() => {
        // A failed poll leaves the last payload in place; the next tick or
        // snapshot retries.
      })
      .finally(() => {
        this.inFlight.delete(ticketId);
      });
  }
}
