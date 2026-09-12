/**
 * Stale-answer guard: one keyed-generation mechanism for the bug class where
 * a slow fetch answers after the UI has moved on. Each key counts up a
 * generation; `begin` starts a new one and hands back its token, and an
 * answer lands only while `isCurrent` still sees that token as the key's
 * generation. A newer `begin` on the same key invalidates every older token,
 * so a superseded fetch's answer is dropped rather than clobbering the newer
 * view.
 */
export class StaleGuard {
  private readonly generations = new Map<string, number>();

  /** Start a key's next generation, invalidating every earlier token. */
  begin(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  /** True while the token is still the key's current generation. */
  isCurrent(key: string, token: number): boolean {
    return this.generations.get(key) === token;
  }
}
