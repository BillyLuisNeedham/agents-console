/**
 * Render coalescing (issue #157). Every store the Console holds asks for a
 * render when it changes: a snapshot, each live ticket's Vitals response,
 * each pane's peek, a log tail, a keystroke in a form. A render builds the
 * whole page and morphs it (ADR-0025), so two of them before the browser
 * paints are work nobody sees, and with N live tickets and M panes the asks
 * arrive in bursts. The loop folds every ask between two frames into the
 * one render that runs on the next animation frame.
 *
 * Nothing that needs layout runs outside a render: the post-commit steps
 * (the log pane's tail pin, the canvas's edges, a note's focus) are inside
 * it, so a render a frame later still finishes what it starts.
 */

/** Run a callback before the next paint. */
export type FrameRequest = (callback: () => void) => void;

/**
 * The browser's next animation frame, or a frame-length timer where there is
 * none (the bun tests run without a DOM). A hidden tab gets no frames, which
 * is the point: a page nobody can see renders when it is looked at again.
 */
export function nextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
  } else {
    setTimeout(callback, 16);
  }
}

export class RenderLoop {
  private readonly render: () => void;
  private readonly frame: FrameRequest;
  private pending = false;

  constructor(render: () => void, frame: FrameRequest = nextFrame) {
    this.render = render;
    this.frame = frame;
  }

  /** Ask for a render; any number of asks before the frame make one. */
  request(): void {
    if (this.pending) return;
    this.pending = true;
    this.frame(() => this.flush());
  }

  /**
   * Render now if a render was asked for and has not run. The flag drops
   * before the render, so a render that throws never wedges the loop, and an
   * ask made during the render lands in the next frame.
   */
  flush(): void {
    if (!this.pending) return;
    this.pending = false;
    this.render();
  }
}
