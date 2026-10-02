/**
 * Background polling, kept off the operator's way (issue #157). The browser
 * opens at most six HTTP/1.1 connections to the pool server and the snapshot
 * stream holds one for good, so every poll out is a connection a click
 * cannot have: an "Open in herdr" or a card's first fetches queue behind
 * Vitals and peeks until one of them answers. Two pieces keep that bounded.
 *
 * `TargetPoller` owns one store's cadence per target (a ticket's activity, a
 * pane's peek): a target never has two polls out, and the snapshot's poll is
 * throttled, so a burst of snapshots asks once and a poll that would follow
 * the last one by a hair waits for the gap instead.
 *
 * `RequestLimiter` caps how many background requests are out at once across
 * every store, queueing the rest in order, so the connections the cap leaves
 * free are always there for what the operator asked for.
 */

/** How many background polls may be out at once, across every store. */
export const BACKGROUND_REQUESTS = 2;

export interface TargetPollerOptions {
  /** One poll of a target: resolves (or rejects) once its answer landed. */
  run: (id: string) => Promise<void>;
  /** The shortest time between the starts of two snapshot polls of one target. */
  gapMs: number;
}

export class TargetPoller {
  private readonly run: (id: string) => Promise<void>;
  private readonly gapMs: number;
  private readonly inFlight = new Set<string>();
  private readonly lastStart = new Map<string, number>();
  // A poll owed to a target: a timer waiting out the gap, or null while it
  // waits for the poll already out to land.
  private readonly owed = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor(options: TargetPollerOptions) {
    this.run = options.run;
    this.gapMs = options.gapMs;
  }

  /** The cadence's poll: now, unless the target's last poll is still out. */
  poll(id: string): void {
    if (this.inFlight.has(id)) return;
    this.settleOwed(id);
    this.start(id);
  }

  /**
   * The snapshot's poll. Now, when the target was not polled inside the gap;
   * else once, when the gap is up. A poll already out owes one more after it
   * lands, since the snapshot may say something its answer predates. Asked
   * again while a poll is owed, it still polls once.
   */
  pollSoon(id: string): void {
    if (this.owed.has(id)) return;
    if (this.inFlight.has(id)) {
      this.owed.set(id, null);
      return;
    }
    const wait = (this.lastStart.get(id) ?? -Infinity) + this.gapMs - Date.now();
    if (wait <= 0) {
      this.start(id);
      return;
    }
    this.owed.set(
      id,
      setTimeout(() => {
        this.owed.delete(id);
        this.poll(id);
      }, wait),
    );
  }

  /** The target left the pool: drop what it is owed. A poll out still lands,
   *  and the store's own pruning ignores it. */
  forget(id: string): void {
    this.settleOwed(id);
    this.lastStart.delete(id);
  }

  /** Drop every owed poll (session teardown). */
  dispose(): void {
    for (const id of [...this.owed.keys()]) this.settleOwed(id);
  }

  private settleOwed(id: string): void {
    const timer = this.owed.get(id);
    if (timer) clearTimeout(timer);
    this.owed.delete(id);
  }

  private start(id: string): void {
    this.inFlight.add(id);
    this.lastStart.set(id, Date.now());
    this.run(id)
      .catch(() => {
        // The store keeps its last answer; the next poll retries.
      })
      .finally(() => {
        this.inFlight.delete(id);
        if (this.owed.get(id) === null) {
          this.owed.delete(id);
          this.pollSoon(id);
        }
      });
  }
}

/**
 * At most `max` tasks running at once; the rest wait in order. Each task's
 * own answer or failure passes straight through.
 */
export class RequestLimiter {
  private readonly max: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(max: number) {
    this.max = max;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const go = (): void => {
        this.running += 1;
        let request: Promise<T>;
        try {
          request = task();
        } catch (err) {
          request = Promise.reject(err);
        }
        request.then(resolve, reject).finally(() => {
          this.running -= 1;
          this.waiting.shift()?.();
        });
      };
      if (this.running < this.max) go();
      else this.waiting.push(go);
    });
  }
}
