/**
 * Vitals store: the Console's side of the liveness readout (ADR 0011), fed
 * by the socket (issue #161). The server checks activity for every ticket
 * that can hold a live attempt (status in-progress, or checkpoint where a
 * resolver may be in flight, or a done ticket whose live attempt the engine
 * marks a resolver, issue #129) once for every tab, and pushes in `live`
 * frames only the payloads that moved. The store holds them and the
 * sparkline samples the cards' footers project from; held payloads and
 * samples are ephemeral client memory, and nothing renders before the first
 * payload lands.
 *
 * A 2 s wall-clock tick stays, and sends nothing: it appends one sparkline
 * sample per running candidate from its held payload (the one-sample-per-
 * poll timeline the polling store kept), and it repaints only when what the
 * cards would show moved, the staleness copy or a sparkline.
 */

import {
  projectVitals,
  pushVitalsSample,
  type EnrichedSnapshot,
  type TicketActivityResponse,
  type TicketStatus,
  type VitalsState,
} from "./project";

/** The tick's cadence: one sparkline sample per live ticket per interval. */
export const VITALS_TICK_MS = 2_000;

const CANDIDATE_STATUSES = new Set<TicketStatus>(["in-progress", "checkpoint"]);

export interface VitalsOptions {
  /** Called after every state change the view should repaint. */
  onChange: () => void;
  /** The tick's cadence; tests shorten or lengthen it. */
  tickMs?: number;
}

export class Vitals {
  private readonly notify: () => void;
  private readonly payloads = new Map<string, TicketActivityResponse>();
  private readonly samples = new Map<string, number[]>();
  /** What the last tick would have shown, so a tick that changes no copy
   *  repaints nothing. */
  private shownCopy = "";
  private candidates = new Set<string>();
  private statuses = new Map<string, TicketStatus>();
  /** A live resolver's start per ticket, for the done cards it shows on. */
  private resolvers = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: VitalsOptions) {
    this.notify = options.onChange;
    if (typeof setInterval !== "undefined") {
      this.timer = setInterval(() => this.tick(), options.tickMs ?? VITALS_TICK_MS);
    }
  }

  /**
   * The snapshot cadence: prune to the pool and re-derive the candidates,
   * which the tick samples and the staleness copy is drawn for. The server
   * keeps its own candidate set; this one only decides what is shown.
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
  }

  /**
   * A `live` frame's activity: the payloads that moved since the last one,
   * by ticket id. Repaints once for the whole frame, and only when a held
   * payload actually changed.
   */
  apply(activity: Record<string, TicketActivityResponse>): void {
    let changed = false;
    for (const [id, payload] of Object.entries(activity)) {
      if (JSON.stringify(this.payloads.get(id)) === JSON.stringify(payload)) continue;
      this.payloads.set(id, payload);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The per-ticket vitals input the projection renders from. */
  state(): Record<string, VitalsState> {
    const state: Record<string, VitalsState> = {};
    for (const [id, activity] of this.payloads) {
      state[id] = { activity, samples: this.samples.get(id) ?? [] };
    }
    return state;
  }

  /** Stop the tick (session teardown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * The wall-clock tick. Each running candidate gets one sparkline sample
   * from the payload it holds; a run that did not move keeps the array it
   * had, so the sparkline drawn from it is the one already on the card. The
   * staleness copy ticks in wall-clock time even while nothing is pushed (a
   * resolver run, a quiet agent, a pool parked at an interrupt with frozen
   * cards), so the tick repaints whenever that copy or a sparkline moved,
   * and only then: a tick that would draw the same words draws nothing.
   */
  tick(now: number = Date.now()): void {
    let moved = false;
    const shown: unknown[] = [];
    for (const id of this.candidates) {
      const payload = this.payloads.get(id);
      const status = this.statuses.get(id);
      if (!payload || !status) continue;
      if (payload.running) {
        const diff = payload.diff;
        const held = this.samples.get(id) ?? [];
        const next = pushVitalsSample(held, diff ? diff.added + diff.removed : 0);
        if (next.length !== held.length || next.some((value, i) => value !== held[i])) {
          this.samples.set(id, next);
          moved = true;
        }
      }
      const resolver = this.resolvers.get(id) ?? null;
      const view = projectVitals({ activity: payload, samples: [] }, status, now, resolver);
      if (view) shown.push([id, view.mode, view.elapsed, view.staleness]);
    }
    const copy = JSON.stringify(shown);
    const copyMoved = copy !== this.shownCopy;
    this.shownCopy = copy;
    if (moved || (copyMoved && shown.length > 0)) this.notify();
  }
}
