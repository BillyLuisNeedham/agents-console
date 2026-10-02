/**
 * Vitals store: the client side of the client-polled liveness readout
 * (ADR 0011). Polls the activity endpoint for every ticket that can hold a
 * live attempt (status in-progress, or checkpoint where a resolver may be
 * in flight, which only the response's running flag can tell, or a done
 * ticket whose live attempt the engine marks a resolver, issue #129), every 2s and
 * once per pool snapshot, the snapshot's poll throttled so a burst of
 * snapshots asks once (issue #157). A response that says nothing is live drops the
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
import { TargetPoller } from "./poll";

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
  /** The per-ticket cadence: one fetch out per ticket, so a slow answer
   *  never stacks or delays the others, and the snapshot's refetch throttled. */
  private readonly poller: TargetPoller;
  /** What the last tick would have shown, so a tick that changes no copy
   *  repaints nothing. */
  private shownCopy = "";
  private candidates = new Set<string>();
  private statuses = new Map<string, TicketStatus>();
  /** A live resolver's start per ticket, for the done cards it shows on. */
  private resolvers = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: VitalsOptions) {
    this.fetchActivity = options.fetch;
    this.notify = options.onChange;
    this.pollMs = options.pollMs ?? VITALS_POLL_MS;
    this.poller = new TargetPoller({
      run: (ticketId) => this.load(ticketId),
      gapMs: this.pollMs / 2,
    });
    if (typeof setInterval !== "undefined") {
      this.timer = setInterval(() => this.tick(), this.pollMs);
    }
  }

  /**
   * The snapshot cadence: prune to the pool, re-derive the candidates, and
   * refetch each once. A spawn or resolver start emits a snapshot, so this is
   * also what re-arms a ticket whose last response said nothing was live.
   * A ticket polled inside the last half interval is refetched when the
   * half is up rather than now, and one with a fetch out gets one more after
   * it lands, so a burst of snapshots never stacks fetches.
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
    this.resolvers = new Map(
      tickets.flatMap((t) =>
        t.liveAttempt?.role === "resolver" ? [[t.id, t.liveAttempt.startedAt] as const] : [],
      ),
    );
    this.candidates = new Set(
      tickets
        .filter((t) => CANDIDATE_STATUSES.has(t.status) || this.resolvers.has(t.id))
        .map((t) => t.id),
    );
    this.statuses = new Map(tickets.map((t) => [t.id, t.status]));
    for (const id of [...this.active]) {
      if (!this.candidates.has(id)) this.active.delete(id);
    }
    for (const id of known) {
      if (!this.candidates.has(id)) this.poller.forget(id);
    }
    for (const id of this.candidates) this.poller.pollSoon(id);
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
    this.poller.dispose();
  }

  private tick(): void {
    for (const id of this.active) this.poller.poll(id);
    // The staleness copy ticks in wall-clock time even while the snapshot
    // stream is silent (a resolver run, a quiet agent, a pool parked at an
    // interrupt with frozen cards), so a tick re-renders whenever the copy
    // the candidates' held payloads would show has moved since the last
    // tick, and only then: a tick that would draw the same words draws
    // nothing.
    const now = Date.now();
    const shown: unknown[] = [];
    for (const id of this.candidates) {
      const payload = this.payloads.get(id);
      const status = this.statuses.get(id);
      if (!payload || !status) continue;
      const resolver = this.resolvers.get(id) ?? null;
      const view = projectVitals({ activity: payload, samples: [] }, status, now, resolver);
      if (view) shown.push([id, view.mode, view.elapsed, view.staleness]);
    }
    const copy = JSON.stringify(shown);
    if (copy === this.shownCopy) return;
    this.shownCopy = copy;
    if (shown.length > 0) this.notify();
  }

  /**
   * One activity fetch and its answer. A failed fetch leaves the last
   * payload in place and the next tick or snapshot retries. The view
   * repaints only when the answer moved something it shows: the payload, or
   * the sparkline, which stops moving once it holds a full run of one
   * unchanged total.
   */
  private async load(ticketId: string): Promise<void> {
    const activity = await this.fetchActivity(ticketId);
    const changed =
      JSON.stringify(this.payloads.get(ticketId)) !== JSON.stringify(activity);
    this.payloads.set(ticketId, activity);
    let moved = false;
    if (activity.running && this.candidates.has(ticketId)) {
      this.active.add(ticketId);
      const diff = activity.diff;
      const held = this.samples.get(ticketId) ?? [];
      const next = pushVitalsSample(held, diff ? diff.added + diff.removed : 0);
      moved = next.length !== held.length || next.some((value, i) => value !== held[i]);
      // A run that did not move keeps the array it had, so the sparkline
      // drawn from it is the one already on the card.
      if (moved) this.samples.set(ticketId, next);
    } else {
      this.active.delete(ticketId);
    }
    if (changed || moved) this.notify();
  }
}
