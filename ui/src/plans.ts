/**
 * The Plans view: the overlay of the canvas column where the operator
 * lists the Presets and the Plan library, opens one as a node graph, edits
 * it, saves it, and boots a Line on it. One store owns the view's session
 * state as a tagged union of phases, and renders the pane.
 *
 * The Console holds no Plan rule. Every change goes to core as a
 * `plans.edit` batch on the document core last answered, and the reply
 * replaces the document whole, with its problems, the notes on what the
 * edit moved on its own, and each node's verdicts. One batch is in flight
 * at a time; changes made meanwhile queue and go as the next batch on that
 * reply's document. Nothing is applied here. Two display-only overlays
 * bridge the round trip: a dropped card's place, and a text field's typed
 * text, each shown until the reply to its batch lands.
 */

import type {
  PlanBootResponse,
  PlanDraftResponse,
  PlanEditFile,
  PlanFile,
  PlanNodeKind,
  PlanProblem,
  PlanResponse,
  PlanSaveResponse,
  PlanSummary,
  PlansListResponse,
} from "../../protocol/wire.ts";
import { h } from "./dom";
import type { Point } from "./geometry";
import { PlanCanvas, type PlanSelection } from "./plan-canvas";
import { renderInspector, type PlanChange, type PlanMeta } from "./plan-inspector";
import { edgeKeyText, projectPlan } from "./plan-projection";

export type ListPlansHandler = () => Promise<PlansListResponse>;
export type GetPlanHandler = (slug: string) => Promise<PlanResponse>;
export type EditPlanHandler = (plan: PlanFile, edits: PlanEditFile[]) => Promise<PlanDraftResponse>;
export type SavePlanHandler = (slug: string, plan: PlanFile) => Promise<PlanSaveResponse>;
export type DeletePlanHandler = (slug: string) => Promise<void>;
export type BootPlanHandler = (slug: string, work: string) => Promise<PlanBootResponse>;

export interface PlansHandlers {
  onListPlans: ListPlansHandler;
  onGetPlan: GetPlanHandler;
  onEditPlan: EditPlanHandler;
  onSavePlan: SavePlanHandler;
  onDeletePlan: DeletePlanHandler;
  onBootPlan: BootPlanHandler;
}

export interface PlansOptions extends PlansHandlers {
  /** Store state changed outside a render: the composition renders again. */
  onChange: () => void;
}

/** The toolbar's inline rows, one at a time. */
type Control =
  | { kind: "none" }
  | { kind: "saving" }
  | { kind: "saveAs"; slug: string; replace: boolean; busy: boolean }
  | { kind: "delete"; busy: boolean }
  | { kind: "boot"; work: string; busy: boolean }
  | { kind: "booted"; launched: PlanBootResponse }
  /** Closing the pane, or opening another Plan, over unsaved changes. */
  | { kind: "discard"; then: "close" | { open: string } };

interface Editing {
  phase: "editing";
  /** The Plan the document came from, which decides what Save means. */
  slug: string;
  preset: boolean;
  /** Fits the canvas once per open. */
  opened: number;
  doc: PlanFile;
  problems: PlanProblem[];
  verdicts: Map<string, string[]>;
  notes: string[];
  /** Core cannot edit the file as it stands: drawn with plans.get's problems, Delete only. */
  readOnly: boolean;
  /** The document as opened or last saved, to tell unsaved changes. */
  baseline: string;
  inFlight: PlanChange[] | null;
  queued: PlanChange[];
  /** A dropped card's place, until the reply to the batch carrying its move. */
  moved: Map<string, { at: Point; by: PlanChange }>;
  /** A text field's text: typed (`by` null) or committed in a batch not yet answered. */
  fields: Map<string, { text: string; by: PlanChange | null }>;
  selection: PlanSelection;
  /** A refused edit's reason, shown in the pane's banner. */
  refusal: string | null;
  control: Control;
  /** The last control's refusal, shown on its row. */
  failure: string | null;
}

type Phase =
  | { phase: "closed" }
  | { phase: "listing"; failure: string | null }
  | { phase: "opening"; slug: string }
  | Editing;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The batch as the wire carries it, against the document it is sent with.
 * A change to a node, the Plan's fields or a cap reads what an earlier
 * change in the same batch left, so neither undoes the other.
 */
function materialize(doc: PlanFile, batch: readonly PlanChange[]): PlanEditFile[] {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const caps = new Map(doc.edges.map((edge) => [edgeKeyText(edge), edge.cap]));
  let meta: PlanMeta = {
    name: doc.name,
    author: doc.author,
    source: doc.source,
    note: doc.note,
    stewardEdits: doc.stewardEdits,
  };
  const edits: PlanEditFile[] = [];
  for (const change of batch) {
    if (change.kind === "edit") {
      if (change.edit.edit === "removeNode") nodes.delete(change.edit.id);
      edits.push(change.edit);
    } else if (change.kind === "node") {
      const node = nodes.get(change.id);
      if (!node) continue;
      const next = change.change(node);
      nodes.set(change.id, next);
      edits.push({ edit: "setNode", node: next });
    } else if (change.kind === "meta") {
      meta = change.change(meta);
      edits.push({ edit: "setMeta", ...meta });
    } else {
      const key = edgeKeyText(change.key);
      if (!caps.has(key)) continue;
      const cap = change.change(caps.get(key));
      caps.set(key, cap);
      edits.push(cap ? { edit: "setCap", ...change.key, cap } : { edit: "setCap", ...change.key });
    }
  }
  return edits;
}

export class PlansStore {
  private state: Phase = { phase: "closed" };
  private list: PlanSummary[] | null = null;
  private listFailure: string | null = null;
  /** Bumped by every open and close: a reply for an older draft is dropped. */
  private token = 0;
  private waiters: (() => void)[] = [];
  private readonly canvas: PlanCanvas;

  constructor(private readonly options: PlansOptions) {
    this.canvas = new PlanCanvas({
      select: (selection) => this.select(selection),
      move: (id, at) => this.move(id, at),
      link: (key) => this.change({ kind: "edit", edit: { edit: "link", edge: { ...key } } }),
      add: (kind, at) => this.add(kind, at),
      remove: (selection) => this.remove(selection),
    });
  }

  get isOpen(): boolean {
    return this.state.phase !== "closed";
  }

  private editing(): Editing | null {
    return this.state.phase === "editing" ? this.state : null;
  }

  get dirty(): boolean {
    const e = this.editing();
    return !!e && (JSON.stringify(e.doc) !== e.baseline || e.inFlight !== null || e.queued.length > 0);
  }

  // -------------------------------------------------------------------------
  // The pane and the list
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this.state.phase !== "closed") return;
    this.state = { phase: "listing", failure: null };
    this.onChange();
    await this.readList();
  }

  /** Close the pane; unsaved changes ask first. */
  close(): void {
    const e = this.editing();
    if (e && this.dirty && !e.readOnly) {
      e.control = { kind: "discard", then: "close" };
      this.onChange();
      return;
    }
    this.abandon();
    this.state = { phase: "closed" };
    this.onChange();
  }

  private async readList(): Promise<void> {
    const token = this.token;
    try {
      const response = await this.options.onListPlans();
      if (token !== this.token) return;
      this.list = response.plans;
      this.listFailure = null;
    } catch (err) {
      if (token !== this.token) return;
      this.listFailure = message(err);
    }
    this.onChange();
  }

  /** Open a Preset or a library Plan; over unsaved changes, ask first. */
  openPlan(slug: string): void {
    const e = this.editing();
    if (e && e.slug === slug) return;
    if (e && this.dirty && !e.readOnly) {
      e.control = { kind: "discard", then: { open: slug } };
      this.onChange();
      return;
    }
    void this.load(slug);
  }

  confirmDiscard(): void {
    const e = this.editing();
    if (e?.control.kind !== "discard") return;
    const then = e.control.then;
    this.abandon();
    if (then === "close") {
      this.state = { phase: "closed" };
      this.onChange();
    } else {
      void this.load(then.open);
    }
  }

  /** Drop an armed row and its refusal. */
  cancelControl(): void {
    const e = this.editing();
    if (!e) return;
    e.control = { kind: "none" };
    e.failure = null;
    this.onChange();
  }

  private abandon(): void {
    this.token += 1;
    this.wake(true);
  }

  // plans.get, then plans.edit with no edits, which answers the canonical
  // draft and its verdicts. A file core refuses to edit opens read-only.
  private async load(slug: string): Promise<void> {
    this.abandon();
    const token = this.token;
    this.state = { phase: "opening", slug };
    this.onChange();
    let got: PlanResponse;
    try {
      got = await this.options.onGetPlan(slug);
    } catch (err) {
      if (token !== this.token) return;
      this.state = { phase: "listing", failure: message(err) };
      this.onChange();
      return;
    }
    if (token !== this.token) return;
    let reply: PlanDraftResponse | null = null;
    let refusal: string | null = null;
    try {
      reply = await this.options.onEditPlan(got.plan, []);
    } catch (err) {
      refusal = message(err);
    }
    if (token !== this.token) return;
    const doc = reply?.plan ?? got.plan;
    this.state = {
      phase: "editing",
      slug,
      preset: got.preset,
      opened: token,
      doc,
      problems: reply?.problems ?? got.problems,
      verdicts: new Map((reply?.verdicts ?? []).map((v) => [v.id, v.verdicts])),
      notes: [],
      readOnly: reply === null,
      baseline: JSON.stringify(doc),
      inFlight: null,
      queued: [],
      moved: new Map(),
      fields: new Map(),
      selection: null,
      refusal,
      control: { kind: "none" },
      failure: null,
    };
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // The edit pipeline
  // -------------------------------------------------------------------------

  select(selection: PlanSelection): void {
    const e = this.editing();
    if (!e) return;
    e.selection = selection;
    this.onChange();
  }

  /** The one way the document changes: queue it, and send when nothing is in flight. */
  change(change: PlanChange): void {
    const e = this.editing();
    if (!e || e.readOnly) return;
    e.queued.push(change);
    e.refusal = null;
    e.notes = [];
    this.flush(e);
    this.onChange();
  }

  move(id: string, at: Point): void {
    const e = this.editing();
    if (!e || e.readOnly) return;
    const change: PlanChange = { kind: "edit", edit: { edit: "move", id, x: Math.round(at.x), y: Math.round(at.y) } };
    e.moved.set(id, { at, by: change });
    this.change(change);
  }

  add(kind: PlanNodeKind, at: Point): void {
    this.change({ kind: "edit", edit: { edit: "addNode", kind, x: Math.round(at.x), y: Math.round(at.y) } });
  }

  remove(selection: Exclude<PlanSelection, null>): void {
    this.change(
      selection.kind === "node"
        ? { kind: "edit", edit: { edit: "removeNode", id: selection.id } }
        : { kind: "edit", edit: { edit: "unlink", ...selection.key } },
    );
  }

  /** A text field's keystroke: held, not sent. */
  type(key: string, text: string): void {
    const e = this.editing();
    if (!e) return;
    e.fields.set(key, { text, by: null });
    this.onChange();
  }

  /** A text field's change: one edit, its text shown until the reply. */
  commit(key: string, text: string, fromDoc: string, change: PlanChange | null): void {
    const e = this.editing();
    if (!e) return;
    if (change === null || text === fromDoc) {
      e.fields.delete(key);
      this.onChange();
      return;
    }
    e.fields.set(key, { text, by: change });
    this.change(change);
  }

  /** A field left without a change: what was typed into it is forgotten. */
  blur(key: string): void {
    const e = this.editing();
    if (e?.fields.get(key)?.by !== null) return;
    e.fields.delete(key);
    this.onChange();
  }

  textOf(key: string, fromDoc: string): string {
    return this.editing()?.fields.get(key)?.text ?? fromDoc;
  }

  /** Resolves once nothing is queued or in flight, or the draft is let go. */
  settled(): Promise<void> {
    const e = this.editing();
    if (!e || (e.inFlight === null && e.queued.length === 0)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(always = false): void {
    const e = this.editing();
    if (!always && e && (e.inFlight !== null || e.queued.length > 0)) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private flush(e: Editing): void {
    if (e.inFlight) return;
    if (e.queued.length === 0) {
      this.wake();
      return;
    }
    const batch = e.queued.splice(0);
    e.inFlight = batch;
    const sent = e.doc;
    const token = this.token;
    this.options.onEditPlan(sent, materialize(sent, batch)).then(
      (reply) => {
        if (token !== this.token) return;
        e.doc = reply.plan;
        e.problems = reply.problems;
        e.verdicts = new Map(reply.verdicts.map((v) => [v.id, v.verdicts]));
        e.notes = reply.notes;
        if (batch.some((c) => c.kind === "edit" && c.edit.edit === "addNode")) {
          const added = reply.plan.nodes.filter((n) => !sent.nodes.some((old) => old.id === n.id) && n.kind !== "merger");
          const last = added[added.length - 1];
          if (last) e.selection = { kind: "node", id: last.id };
        }
        this.land(e, batch);
      },
      (err) => {
        if (token !== this.token) return;
        e.refusal = message(err);
        this.land(e, batch);
      },
    );
  }

  private land(e: Editing, batch: PlanChange[]): void {
    const landed = new Set(batch);
    for (const [id, held] of e.moved) if (landed.has(held.by)) e.moved.delete(id);
    for (const [key, held] of e.fields) if (held.by && landed.has(held.by)) e.fields.delete(key);
    e.inFlight = null;
    const sel = e.selection;
    if (
      (sel?.kind === "node" && !e.doc.nodes.some((n) => n.id === sel.id)) ||
      (sel?.kind === "edge" && !e.doc.edges.some((edge) => edgeKeyText(edge) === edgeKeyText(sel.key)))
    ) {
      e.selection = null;
    }
    this.flush(e);
    this.onChange();
  }

  dismissNotes(): void {
    const e = this.editing();
    if (!e) return;
    e.notes = [];
    e.refusal = null;
    this.onChange();
  }

  // -------------------------------------------------------------------------
  // Save, Save as, Delete, Boot
  // -------------------------------------------------------------------------

  /** Save a library Plan over its own slug, once the pipeline is idle. A Preset only saves as. */
  async save(): Promise<void> {
    const e = this.editing();
    if (!e || e.preset || e.readOnly || e.control.kind === "saving") return;
    const token = this.token;
    e.control = { kind: "saving" };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (token !== this.token) return;
    const doc = e.doc;
    try {
      await this.options.onSavePlan(e.slug, doc);
      if (token !== this.token) return;
      e.baseline = JSON.stringify(doc);
      e.control = { kind: "none" };
      void this.readList();
    } catch (err) {
      if (token !== this.token) return;
      e.control = { kind: "none" };
      e.failure = message(err);
    }
    this.onChange();
  }

  armSaveAs(): void {
    const e = this.editing();
    if (!e || e.readOnly) return;
    const taken = new Set((this.list ?? []).map((p) => p.slug));
    let slug = `${e.slug}-copy`;
    for (let n = 2; taken.has(slug); n++) slug = `${e.slug}-copy-${String.fromCharCode(96 + n)}`;
    e.control = { kind: "saveAs", slug, replace: false, busy: false };
    e.failure = null;
    this.onChange();
  }

  setSaveAsSlug(slug: string): void {
    const e = this.editing();
    if (e?.control.kind !== "saveAs") return;
    e.control = { ...e.control, slug, replace: false };
    e.failure = null;
    this.onChange();
  }

  /**
   * Save under the slug typed. A library slug already listed asks to
   * replace it first; core's refusals (a Preset's slug, a bad slug, an
   * invalid Plan) show on the row. Saved, the draft is that library Plan.
   */
  async confirmSaveAs(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "saveAs" || e.control.busy) return;
    const slug = e.control.slug.trim();
    const own = e.preset ? null : e.slug;
    const taken = (this.list ?? []).some((p) => !p.preset && p.slug === slug && p.slug !== own);
    if (taken && !e.control.replace) {
      e.control = { ...e.control, replace: true };
      this.onChange();
      return;
    }
    const token = this.token;
    e.control = { ...e.control, busy: true };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (token !== this.token) return;
    const doc = e.doc;
    try {
      await this.options.onSavePlan(slug, doc);
      if (token !== this.token) return;
      e.slug = slug;
      e.preset = false;
      e.baseline = JSON.stringify(doc);
      e.control = { kind: "none" };
      void this.readList();
    } catch (err) {
      if (token !== this.token) return;
      if (e.control.kind === "saveAs") e.control = { ...e.control, busy: false, replace: false };
      e.failure = message(err);
    }
    this.onChange();
  }

  armDelete(): void {
    const e = this.editing();
    if (!e || e.preset) return;
    e.control = { kind: "delete", busy: false };
    e.failure = null;
    this.onChange();
  }

  async confirmDelete(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "delete" || e.control.busy || e.preset) return;
    const token = this.token;
    e.control = { kind: "delete", busy: true };
    this.onChange();
    try {
      await this.options.onDeletePlan(e.slug);
      if (token !== this.token) return;
      this.abandon();
      this.state = { phase: "listing", failure: null };
      this.onChange();
      await this.readList();
    } catch (err) {
      if (token !== this.token) return;
      e.control = { kind: "delete", busy: false };
      e.failure = message(err);
      this.onChange();
    }
  }

  /** Boot runs the saved file, so a Line boots only from a clean, valid Plan. */
  get bootable(): boolean {
    const e = this.editing();
    return !!e && !e.readOnly && !this.dirty && e.problems.length === 0;
  }

  armBoot(): void {
    const e = this.editing();
    if (!e || !this.bootable) return;
    e.control = { kind: "boot", work: "", busy: false };
    e.failure = null;
    this.onChange();
  }

  setBootWork(work: string): void {
    const e = this.editing();
    if (e?.control.kind !== "boot") return;
    e.control = { ...e.control, work };
    e.failure = null;
    this.onChange();
  }

  /** plans.boot, once; the button is off while it is out. */
  async confirmBoot(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "boot" || e.control.busy) return;
    const work = e.control.work.trim();
    const token = this.token;
    e.control = { ...e.control, busy: true };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (token !== this.token) return;
    try {
      const launched = await this.options.onBootPlan(e.slug, work);
      if (token !== this.token) return;
      e.control = { kind: "booted", launched };
    } catch (err) {
      if (token !== this.token) return;
      if (e.control.kind === "boot") e.control = { ...e.control, busy: false };
      e.failure = message(err);
    }
    this.onChange();
  }

  private onChange(): void {
    this.options.onChange();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /** The pane, or null while it is closed. */
  render(): HTMLElement | null {
    const s = this.state;
    if (s.phase === "closed") return null;
    const e = this.editing();
    return h(
      "div",
      { class: "plans-pane", key: "plans-pane" },
      this.renderHead(e),
      e ? this.renderControl(e) : null,
      h(
        "div",
        { class: "plans-body" },
        this.renderList(),
        ...(e
          ? this.renderEditor(e)
          : [
              h(
                "div",
                { class: "plans-main plans-empty", key: "plans-main" },
                s.phase === "opening"
                  ? h("span", { class: "dim" }, `opening ${s.slug}…`)
                  : s.phase === "listing" && s.failure
                    ? h("span", { class: "error-inline" }, s.failure)
                    : h("span", { class: "dim" }, "Open a Preset or one of your Plans from the list."),
              ),
            ]),
      ),
    );
  }

  /** After the commit: bind the Plan canvas's viewport, if one is drawn. */
  bindCanvas(root: HTMLElement): void {
    const viewport = root.querySelector(".plans-pane .plan-viewport");
    if (viewport instanceof HTMLElement) this.canvas.bind(viewport);
    else this.canvas.unbind();
  }

  private renderHead(e: Editing | null): HTMLElement {
    const busy = e?.control.kind === "saving";
    const dirty = this.dirty;
    const tools: (HTMLElement | null)[] = e
      ? [
          !e.preset && !e.readOnly
            ? h(
                "button",
                {
                  class: "btn btn-primary plans-save",
                  type: "button",
                  disabled: !dirty || busy || e.problems.length > 0 ? true : null,
                  title: e.problems.length ? "fix the problems first" : `save over ${e.slug}`,
                  onclick: () => void this.save(),
                },
                busy ? "saving…" : "Save",
              )
            : null,
          !e.readOnly
            ? h("button", { class: "btn plans-save-as", type: "button", onclick: () => this.armSaveAs() }, "Save as…")
            : null,
          !e.preset
            ? h("button", { class: "btn btn-danger plans-delete", type: "button", onclick: () => this.armDelete() }, "Delete")
            : null,
          !e.readOnly
            ? h(
                "button",
                {
                  class: "btn plans-boot",
                  type: "button",
                  disabled: this.bootable ? null : true,
                  title: this.bootable
                    ? "boot a new Line on this Plan"
                    : e.problems.length
                      ? "fix the problems first"
                      : "save first: Boot runs the saved Plan",
                  onclick: () => this.armBoot(),
                },
                "Boot a Line…",
              )
            : null,
        ]
      : [];
    return h(
      "div",
      { class: "plans-head" },
      h("span", { class: "plans-title" }, "plans"),
      e
        ? h(
            "span",
            { class: "plans-doc" },
            h("span", { class: "plans-doc-name" }, e.doc.name || e.slug),
            h(
              "span",
              { class: "plans-doc-origin dim" },
              `${e.preset ? "preset" : "library"} ${e.slug}${e.readOnly ? " · read-only" : dirty ? " · unsaved" : ""}`,
            ),
          )
        : h("span", { class: "plans-doc" }),
      h("span", { class: "plans-tools" }, ...tools),
      h("button", { class: "btn plans-close", type: "button", onclick: () => this.close() }, "close"),
    );
  }

  private renderControl(e: Editing): HTMLElement | null {
    const c = e.control;
    const failure = e.failure ? h("span", { class: "error-inline plans-control-failure" }, e.failure) : null;
    const cancel = (label = "Cancel") =>
      h("button", { class: "btn", type: "button", onclick: () => this.cancelControl() }, label);
    const row = (key: string, ...kids: (Node | string | null)[]) =>
      h("div", { class: "plans-control", key: `control-${key}` }, ...kids, failure);
    switch (c.kind) {
      case "none":
      case "saving":
        return failure ? row("failure") : null;
      case "saveAs":
        return row(
          "save-as",
          h("span", { class: "dim" }, "save as"),
          h("input", {
            class: "plan-input plans-slug",
            key: "plans-slug",
            type: "text",
            value: c.slug,
            spellcheck: "false",
            oninput: (event: Event) => this.setSaveAsSlug((event.currentTarget as HTMLInputElement).value),
            onkeydown: (event: KeyboardEvent) => {
              if (event.key === "Enter") void this.confirmSaveAs();
            },
          }),
          h(
            "button",
            {
              class: "btn btn-primary plans-save-as-confirm",
              type: "button",
              disabled: c.busy || !c.slug.trim() ? true : null,
              onclick: () => void this.confirmSaveAs(),
            },
            c.busy ? "saving…" : c.replace ? `Replace ${c.slug.trim()}` : "Save",
          ),
          cancel(),
        );
      case "delete":
        return row(
          "delete",
          h("span", {}, `Delete ${e.slug} from the Plan library?`),
          h(
            "button",
            {
              class: "btn btn-danger plans-delete-confirm",
              type: "button",
              disabled: c.busy ? true : null,
              onclick: () => void this.confirmDelete(),
            },
            c.busy ? "deleting…" : "Delete",
          ),
          cancel(),
        );
      case "boot":
        return row(
          "boot",
          h("span", { class: "dim" }, `boot a Line on ${e.slug}, for`),
          h("input", {
            class: "plan-input plans-work",
            key: "plans-work",
            type: "text",
            value: c.work,
            placeholder: "an issue number or what to build",
            oninput: (event: Event) => this.setBootWork((event.currentTarget as HTMLInputElement).value),
            onkeydown: (event: KeyboardEvent) => {
              if (event.key === "Enter") void this.confirmBoot();
            },
          }),
          h(
            "button",
            {
              class: "btn btn-primary plans-boot-confirm",
              type: "button",
              disabled: c.busy || !c.work.trim() ? true : null,
              onclick: () => void this.confirmBoot(),
            },
            c.busy ? "booting…" : "Boot",
          ),
          cancel(),
        );
      case "booted":
        return row(
          "booted",
          h("span", { class: "plans-booted" }, "Boot started:"),
          h("code", { class: "plans-argv" }, ["boot", ...c.launched.argv].join(" ")),
          h("span", { class: "dim" }, `in ${c.launched.cwd}; its output goes to`),
          h("code", { class: "plans-log" }, c.launched.log),
          cancel("dismiss"),
        );
      case "discard":
        return row(
          "discard",
          h("span", {}, `Discard the unsaved changes to ${e.doc.name || e.slug}?`),
          h(
            "button",
            { class: "btn btn-danger plans-discard", type: "button", onclick: () => this.confirmDiscard() },
            "Discard",
          ),
          cancel("Keep editing"),
        );
    }
  }

  private renderList(): HTMLElement {
    const list = this.list;
    const open = this.editing()?.slug ?? (this.state.phase === "opening" ? this.state.slug : null);
    const item = (plan: PlanSummary) =>
      h(
        "button",
        {
          class:
            "plans-item" +
            (plan.slug === open ? " plans-item-on" : "") +
            (plan.problems.length ? " plans-item-broken" : ""),
          key: `plan:${plan.slug}`,
          type: "button",
          title: plan.note ?? plan.name,
          onclick: () => this.openPlan(plan.slug),
        },
        h("span", { class: "plans-item-name" }, plan.name || plan.slug),
        h(
          "span",
          { class: "plans-item-slug" },
          plan.slug,
          plan.problems.length
            ? h("span", { class: "plans-item-flag" }, ` · ${plan.problems.length} problem${plan.problems.length > 1 ? "s" : ""}`)
            : null,
        ),
        plan.source ? h("span", { class: "plans-item-source" }, plan.source) : null,
        plan.note ? h("span", { class: "plans-item-note" }, plan.note) : null,
      );
    const groups = new Map<string, PlanSummary[]>();
    for (const plan of list ?? []) {
      if (!plan.preset) continue;
      const author = plan.author ?? "unknown";
      groups.set(author, [...(groups.get(author) ?? []), plan]);
    }
    const library = (list ?? []).filter((plan) => !plan.preset);
    return h(
      "div",
      { class: "plans-list", key: "plans-list" },
      this.listFailure ? h("div", { class: "error-inline" }, this.listFailure) : null,
      list === null && !this.listFailure ? h("div", { class: "dim" }, "reading plans…") : null,
      h("div", { class: "plans-list-head" }, "Presets"),
      ...[...groups].map(([author, plans]) =>
        h(
          "div",
          { class: "plans-group", key: `group:${author}` },
          h("div", { class: "plans-group-author" }, author),
          ...plans.map(item),
        ),
      ),
      h("div", { class: "plans-list-head" }, "Your Plans"),
      ...(library.length
        ? library.map(item)
        : [h("div", { class: "plan-help", key: "plans-none" }, "None yet: Save as on a Preset starts one.")]),
    );
  }

  private renderEditor(e: Editing): HTMLElement[] {
    const moved = new Map([...e.moved].map(([id, held]) => [id, held.at]));
    const drawing = projectPlan({ plan: e.doc, problems: e.problems, verdicts: e.verdicts, places: moved });
    const banner =
      drawing.planProblems.length || e.notes.length || e.refusal
        ? h(
            "div",
            { class: "plans-banner", key: "plans-banner" },
            ...drawing.planProblems.map((p) => h("div", { class: "plan-problem" }, p)),
            e.refusal ? h("div", { class: "error-inline plans-refusal" }, e.refusal) : null,
            ...e.notes.map((note) => h("div", { class: "plans-note" }, note)),
            e.notes.length || (e.refusal && !e.readOnly)
              ? h("button", { class: "btn plans-dismiss", type: "button", onclick: () => this.dismissNotes() }, "dismiss")
              : null,
          )
        : null;
    const main = h(
      "div",
      { class: "plans-main", key: "plans-main" },
      banner,
      this.canvas.render({
        docKey: String(e.opened),
        plan: e.doc,
        problems: e.problems,
        verdicts: e.verdicts,
        moved,
        selection: e.selection,
        editable: !e.readOnly,
      }),
    );
    const inspector = e.readOnly
      ? h(
          "div",
          { class: "plan-inspector", key: "plan-inspector" },
          h("div", { class: "plan-inspector-head" }, "Read-only"),
          h(
            "div",
            { class: "plan-help" },
            "Core cannot edit this file as it stands without losing what is written in it. Fix it by hand, or delete it.",
          ),
          h("div", { class: "plan-problems" }, ...e.problems.map((p) => h("div", { class: "plan-problem" }, p.message))),
        )
      : renderInspector(
          {
            plan: e.doc,
            drawing,
            selection: e.selection,
            text: (key, fromDoc) => this.textOf(key, fromDoc),
          },
          {
            change: (change) => this.change(change),
            select: (selection) => this.select(selection),
            type: (key, text) => this.type(key, text),
            commit: (key, text, fromDoc, change) => this.commit(key, text, fromDoc, change),
            blur: (key) => this.blur(key),
          },
        );
    return [main, h("div", { class: "plans-side", key: "plans-side" }, inspector)];
  }
}
