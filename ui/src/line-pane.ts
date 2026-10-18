import { h } from "./dom";
import type { LineLive } from "./line-projection";
import { PlanCanvas, liveEvents } from "./plan-canvas";

export interface LinePaneOptions {
  onChange: () => void;
  /** A copy dot or hold chip was tapped: the card it names. */
  onOpenCard: (card: string) => void;
}

/**
 * The Line view (ADR-0039): an overlay of the canvas column that draws the
 * running Line's frozen Plan with its live state, on the Plans view's canvas
 * in read-only mode. Whether it is open is this view's own state; it opens
 * from the canvas header's Line button and closes back to the Ticket canvas,
 * and a Line that goes away takes it down with it. The graph refits when the
 * Plan copy changes (`rev`), and morphs on node ids between pushes.
 */
export class LinePane {
  private shown = false;
  private readonly canvas: PlanCanvas;

  constructor(private readonly options: LinePaneOptions) {
    this.canvas = new PlanCanvas(liveEvents(options.onOpenCard));
  }

  open(): void {
    this.shown = true;
    this.options.onChange();
  }

  private close(): void {
    this.shown = false;
    this.options.onChange();
  }

  render(live: LineLive | null): HTMLElement | null {
    if (!live) this.shown = false;
    if (!live || !this.shown) return null;
    const waiting = live.waitingFor.length > 0 ? `Finish waiting for ${live.waitingFor.join(", ")}` : null;
    return h(
      "div",
      { class: "line-pane", key: "line-pane" },
      h(
        "div",
        { class: "line-head" },
        h("span", { class: "line-headline", title: live.headline }, live.headline),
        waiting ? h("span", { class: "line-waiting", title: waiting }, waiting) : null,
        h(
          "button",
          { class: "btn line-close", type: "button", title: "back to the Ticket canvas", onclick: () => this.close() },
          "Tickets",
        ),
      ),
      this.canvas.render({
        fitKey: `line:${live.rev}`,
        plan: live.plan,
        problems: [],
        verdicts: live.verdicts,
        pendingDrops: new Map(),
        selection: null,
        editable: false,
        live,
      }),
    );
  }

  bindCanvas(root: HTMLElement): void {
    const viewport = root.querySelector(".line-pane .plan-viewport");
    if (viewport instanceof HTMLElement) this.canvas.bind(viewport);
    else this.canvas.unbind();
  }
}
