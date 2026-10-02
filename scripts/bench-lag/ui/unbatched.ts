/**
 * The bench page's stand-in for ui/src/frame.ts and ui/src/poll.ts in a
 * checkout from before issue #157, which has neither: its main.ts renders on
 * every store change at once and sends every background poll uncapped. The
 * page imports `@bench/frame` and `@bench/poll`, and vite.config.ts points
 * each at the checkout's own module when it has one and here when it does
 * not, so the page wires every checkout the way that checkout's main.ts does.
 */

/** A render per ask, in the asker's task. */
export class RenderLoop {
  private readonly render: () => void;

  constructor(render: () => void) {
    this.render = render;
  }

  request(): void {
    this.render();
  }

  flush(): void {}
}

/** No cap. */
export const BACKGROUND_REQUESTS = Number.POSITIVE_INFINITY;

/** Every task at once. */
export class RequestLimiter {
  constructor(_max: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return task();
  }
}
