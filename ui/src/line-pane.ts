import type { LinePlanEditResponse, PlanEditFile, PlanFile } from "../../protocol/wire.ts";
import { h } from "./dom";
import type { Point } from "./geometry";
import type { LineLive } from "./line-projection";
import { PlanCanvas, type PlanSelection } from "./plan-canvas";
import { PendingEdits, addition, kept, materialize, removal } from "./plan-edits";
import { renderInspector, type FieldChange, type PlanChange } from "./plan-inspector";
import { projectPlan } from "./plan-projection";

export type EditLineHandler = (baseRev: number, edits: PlanEditFile[]) => Promise<LinePlanEditResponse>;

export interface LinePaneOptions {
  onChange: () => void;
  /** A copy dot or hold chip was tapped: the card it names. */
  onOpenCard: (card: string) => void;
  /** `line.plan.edit`: typed edits made against the rev the view drew. */
  onEditLine: EditLineHandler;
  /** "Save as": the frozen Plan, to copy into the library. */
  onSaveAs: (plan: PlanFile) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The Line view (ADR-0039): an overlay of the canvas column that draws the
 * running Line's frozen Plan with its live state, on the Plans view's canvas
 * and inspector. Whether it is open is this view's own state; it opens from
 * the canvas header's Line button and closes back to the Ticket canvas, and a
 * Line that goes away takes it down with it. The graph fits once each time
 * the view opens, and morphs on node ids between pushes.
 *
 * Edits go to core as `line.plan.edit` against the rev drawn, one batch at a
 * time. The view applies none of them: the snapshot carrying the new rev
 * redraws the Plan, and until it lands a dropped card and a committed field
 * hold where the operator left them. What queues meanwhile is sent once that
 * snapshot is in, so it is built from the Plan core holds.
 */
export class LinePane {
  private shown = false;
  private opened = 0;
  private live: LineLive | null = null;
  private generation = 0;
  private edits = new PendingEdits();
  /** The rev core applied the batch out at, until a snapshot reaches it. */
  private awaiting: number | null = null;
  private selection: PlanSelection = null;
  private refusal: string | null = null;
  private notes: string[] = [];
  private readonly canvas: PlanCanvas;

  constructor(private readonly options: LinePaneOptions) {
    this.canvas = new PlanCanvas({
      select: (selection) => this.select(selection),
      move: (id, at) => this.move(id, at),
      link: (key) => this.change({ kind: "edit", edit: { edit: "link", edge: { ...key } } }),
      add: (kind, at) => this.change(addition(kind, at)),
      remove: (selection) => this.change(removal(selection)),
      open: options.onOpenCard,
    });
  }

  open(): void {
    this.shown = true;
    this.opened += 1;
    this.options.onChange();
  }

  private close(): void {
    this.shown = false;
    this.options.onChange();
  }

  select(selection: PlanSelection): void {
    this.selection = selection;
    this.options.onChange();
  }

  change(change: PlanChange): void {
    this.edits.push(change);
    this.send();
  }

  move(id: string, at: Point): void {
    this.edits.move(id, at);
    this.send();
  }

  private commit(key: string, text: string, fromDoc: string, change: FieldChange): void {
    if (change.kind === "none" || text === fromDoc) {
      this.edits.forget(key);
      this.options.onChange();
      return;
    }
    this.edits.commit(key, text, change);
    this.send();
  }

  private dismiss(): void {
    this.refusal = null;
    this.notes = [];
    this.options.onChange();
  }

  private send(): void {
    this.refusal = null;
    this.notes = [];
    this.flush();
    this.options.onChange();
  }

  private flush(): void {
    const live = this.live;
    const batch = live && this.edits.take();
    if (!live || !batch) return;
    const generation = this.generation;
    this.options.onEditLine(live.rev, materialize(live.plan, batch)).then(
      (reply) => {
        if (generation !== this.generation) return;
        this.notes = reply.notes;
        this.awaiting = reply.rev;
        this.catchUp();
        this.options.onChange();
      },
      (err) => {
        if (generation !== this.generation) return;
        this.refusal = message(err);
        this.edits.land();
        this.flush();
        this.options.onChange();
      },
    );
  }

  /** The snapshot has reached the rev the batch out was applied at: it lands, and the next goes. */
  private catchUp(): void {
    if (this.awaiting === null || !this.live || this.live.rev < this.awaiting) return;
    this.awaiting = null;
    this.edits.land();
    this.flush();
  }

  private sync(live: LineLive | null): void {
    if (!live) {
      if (this.live || this.shown) this.reset();
      return;
    }
    this.live = live;
    this.catchUp();
    this.selection = kept(this.selection, live.plan);
  }

  private reset(): void {
    this.shown = false;
    this.live = null;
    this.generation += 1;
    this.edits = new PendingEdits();
    this.awaiting = null;
    this.selection = null;
    this.refusal = null;
    this.notes = [];
  }

  render(live: LineLive | null): HTMLElement | null {
    this.sync(live);
    if (!live || !this.shown) return null;
    const waiting = live.waitingFor.length > 0 ? `Finish waiting for ${live.waitingFor.join(", ")}` : null;
    const drops = this.edits.drops();
    const banner =
      this.refusal || this.notes.length
        ? h(
            "div",
            { class: "line-banner", key: "line-banner" },
            this.refusal ? h("div", { class: "error-inline line-refusal" }, this.refusal) : null,
            ...this.notes.map((note) => h("div", { class: "line-note" }, note)),
            h("button", { class: "btn line-dismiss", type: "button", onclick: () => this.dismiss() }, "dismiss"),
          )
        : null;
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
          {
            class: "btn line-save-as",
            type: "button",
            title: "copy this Line's Plan into the Plan library",
            onclick: () => this.options.onSaveAs(live.plan),
          },
          "Save as…",
        ),
        h(
          "button",
          { class: "btn line-close", type: "button", title: "back to the Ticket canvas", onclick: () => this.close() },
          "Tickets",
        ),
      ),
      h(
        "div",
        { class: "line-body" },
        h(
          "div",
          { class: "line-main", key: "line-main" },
          banner,
          this.canvas.render({
            fitKey: `line:${this.opened}`,
            plan: live.plan,
            problems: [],
            verdicts: live.verdicts,
            pendingDrops: drops,
            selection: this.selection,
            editable: true,
            live,
          }),
        ),
        h(
          "div",
          { class: "line-side", key: "line-side" },
          renderInspector(
            {
              plan: live.plan,
              drawing: projectPlan({ plan: live.plan, problems: [], verdicts: live.verdicts, places: drops }),
              selection: this.selection,
              text: (key, fromDoc) => this.edits.textOf(key, fromDoc),
            },
            {
              change: (change) => this.change(change),
              select: (selection) => this.select(selection),
              type: (key, text) => {
                this.edits.type(key, text);
                this.options.onChange();
              },
              commit: (key, text, fromDoc, change) => this.commit(key, text, fromDoc, change),
              blur: (key) => {
                if (this.edits.blur(key)) this.options.onChange();
              },
            },
          ),
        ),
      ),
    );
  }

  bindCanvas(root: HTMLElement): void {
    const viewport = root.querySelector(".line-pane .plan-viewport");
    if (viewport instanceof HTMLElement) this.canvas.bind(viewport);
    else this.canvas.unbind();
  }
}
