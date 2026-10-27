import type {
  PlanBootResponse,
  PlanDraftResponse,
  PlanEditFile,
  PlanFile,
  PlanProblem,
  PlanResponse,
  PlanSaveResponse,
  PlanSummary,
  PlansListResponse,
} from "../../protocol/wire.ts";
import { h } from "./dom";
import type { Point } from "./geometry";
import { PlanCanvas, type PlanSelection } from "./plan-canvas";
import { PendingEdits, addition, kept, materialize, removal } from "./plan-edits";
import { renderInspector, type FieldChange, type PlanChange } from "./plan-inspector";
import { projectPlan } from "./plan-projection";

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
  onChange: () => void;
}

type Control =
  | { kind: "none" }
  | { kind: "saving" }
  | { kind: "saveAs"; slug: string; replace: boolean; busy: boolean }
  | { kind: "delete"; busy: boolean }
  | { kind: "boot"; work: string; busy: boolean }
  | { kind: "booted"; launched: PlanBootResponse }
  | { kind: "discard"; then: "close" | { open: string } };

/** Where the open Plan came from: a Preset and a running Line's copy save only as a new library Plan. */
type Origin = "preset" | "library" | "line";

interface Editing {
  phase: "editing";
  slug: string;
  origin: Origin;
  opened: number;
  doc: PlanFile;
  problems: PlanProblem[];
  warnings: PlanProblem[];
  verdicts: Map<string, string[]>;
  notes: string[];
  readOnly: boolean;
  baseline: string;
  edits: PendingEdits;
  selection: PlanSelection;
  refusal: string | null;
  control: Control;
  failure: string | null;
}

type Phase =
  | { phase: "closed" }
  | { phase: "listing"; failure: string | null }
  | { phase: "opening"; slug: string }
  | Editing;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A library slug from a Plan's name, with room left for Save as's "-copy-b". */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "") || "line-plan";

export class PlansStore {
  private state: Phase = { phase: "closed" };
  private list: PlanSummary[] | null = null;
  private listFailure: string | null = null;
  private openGeneration = 0;
  private waiters: (() => void)[] = [];
  private readonly canvas: PlanCanvas;

  constructor(private readonly options: PlansOptions) {
    this.canvas = new PlanCanvas({
      select: (selection) => this.select(selection),
      move: (id, at) => this.move(id, at),
      link: (key) => this.change({ kind: "edit", edit: { edit: "link", edge: { ...key } } }),
      add: (kind, at) => this.change(addition(kind, at)),
      remove: (selection) => this.change(removal(selection)),
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
    return !!e && (JSON.stringify(e.doc) !== e.baseline || e.edits.busy);
  }

  async open(): Promise<void> {
    if (this.state.phase !== "closed") return;
    this.state = { phase: "listing", failure: null };
    this.onChange();
    await this.readList();
  }

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
    const generation = this.openGeneration;
    try {
      const response = await this.options.onListPlans();
      if (generation !== this.openGeneration) return;
      this.list = response.plans;
      this.listFailure = null;
    } catch (err) {
      if (generation !== this.openGeneration) return;
      this.listFailure = message(err);
    }
    this.onChange();
  }

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

  cancelControl(): void {
    const e = this.editing();
    if (!e) return;
    e.control = { kind: "none" };
    e.failure = null;
    this.onChange();
  }

  private abandon(): void {
    this.openGeneration += 1;
    this.wake(true);
  }

  private async load(slug: string): Promise<void> {
    this.abandon();
    const generation = this.openGeneration;
    this.state = { phase: "opening", slug };
    this.onChange();
    let got: PlanResponse;
    try {
      got = await this.options.onGetPlan(slug);
    } catch (err) {
      if (generation !== this.openGeneration) return;
      this.state = { phase: "listing", failure: message(err) };
      this.onChange();
      return;
    }
    if (generation !== this.openGeneration) return;
    await this.begin(slug, got.preset ? "preset" : "library", got.plan, got.problems, got.warnings ?? [], generation);
  }

  /**
   * "Save as" on the Line view: the running Line's frozen Plan opened as an
   * unsaved copy, Save as armed, so it reaches the library the way a Preset's
   * copy does. Unsaved edits to an open Plan are kept rather than replaced.
   */
  openCopy(plan: PlanFile): void {
    if (this.dirty) return;
    const closed = this.state.phase === "closed";
    this.abandon();
    const generation = this.openGeneration;
    const slug = slugOf(plan.name);
    this.state = { phase: "opening", slug };
    this.onChange();
    if (closed) void this.readList();
    void this.begin(slug, "line", plan, [], [], generation).then(() => {
      if (generation === this.openGeneration) this.armSaveAs();
    });
  }

  private async begin(
    slug: string,
    origin: Origin,
    plan: PlanFile,
    problems: PlanProblem[],
    warnings: PlanProblem[],
    generation: number,
  ): Promise<void> {
    const { reply, refusal } = await this.probeDraft(plan);
    if (generation !== this.openGeneration) return;
    const doc = reply?.plan ?? plan;
    this.state = {
      phase: "editing",
      slug,
      origin,
      opened: generation,
      doc,
      problems: reply?.problems ?? problems,
      warnings: reply ? (reply.warnings ?? []) : warnings,
      verdicts: new Map((reply?.verdicts ?? []).map((v) => [v.id, v.verdicts])),
      notes: [],
      readOnly: reply === null,
      baseline: JSON.stringify(doc),
      edits: new PendingEdits(),
      selection: null,
      refusal,
      control: { kind: "none" },
      failure: null,
    };
    this.onChange();
  }

  private async probeDraft(plan: PlanFile): Promise<{ reply: PlanDraftResponse | null; refusal: string | null }> {
    try {
      return { reply: await this.options.onEditPlan(plan, []), refusal: null };
    } catch (err) {
      return { reply: null, refusal: message(err) };
    }
  }

  select(selection: PlanSelection): void {
    const e = this.editing();
    if (!e) return;
    e.selection = selection;
    this.onChange();
  }

  change(change: PlanChange): void {
    const e = this.editing();
    if (!e || e.readOnly) return;
    e.edits.push(change);
    this.send(e);
  }

  move(id: string, at: Point): void {
    const e = this.editing();
    if (!e || e.readOnly) return;
    e.edits.move(id, at);
    this.send(e);
  }

  private send(e: Editing): void {
    e.refusal = null;
    e.notes = [];
    this.flush(e);
    this.onChange();
  }

  type(key: string, text: string): void {
    const e = this.editing();
    if (!e) return;
    e.edits.type(key, text);
    this.onChange();
  }

  commit(key: string, text: string, fromDoc: string, change: FieldChange): void {
    const e = this.editing();
    if (!e) return;
    if (change.kind === "none" || text === fromDoc) {
      e.edits.forget(key);
      this.onChange();
      return;
    }
    if (e.readOnly) return;
    e.edits.commit(key, text, change);
    this.send(e);
  }

  blur(key: string): void {
    if (this.editing()?.edits.blur(key)) this.onChange();
  }

  textOf(key: string, fromDoc: string): string {
    return this.editing()?.edits.textOf(key, fromDoc) ?? fromDoc;
  }

  settled(): Promise<void> {
    if (!this.editing()?.edits.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(always = false): void {
    if (!always && this.editing()?.edits.busy) return;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private flush(e: Editing): void {
    const batch = e.edits.take();
    if (!batch) {
      this.wake();
      return;
    }
    const sent = e.doc;
    const generation = this.openGeneration;
    this.options.onEditPlan(sent, materialize(sent, batch)).then(
      (reply) => {
        if (generation !== this.openGeneration) return;
        e.doc = reply.plan;
        e.problems = reply.problems;
        e.warnings = reply.warnings ?? [];
        e.verdicts = new Map(reply.verdicts.map((v) => [v.id, v.verdicts]));
        e.notes = reply.notes;
        if (batch.some((c) => c.kind === "edit" && c.edit.edit === "addNode")) {
          const added = reply.plan.nodes.filter((n) => !sent.nodes.some((old) => old.id === n.id) && n.kind !== "merger");
          const last = added[added.length - 1];
          if (last) e.selection = { kind: "node", id: last.id };
        }
        this.land(e);
      },
      (err) => {
        if (generation !== this.openGeneration) return;
        e.refusal = message(err);
        this.land(e);
      },
    );
  }

  private land(e: Editing): void {
    e.edits.land();
    e.selection = kept(e.selection, e.doc);
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

  async save(): Promise<void> {
    const e = this.editing();
    if (!e || e.origin !== "library" || e.readOnly || e.control.kind === "saving") return;
    const generation = this.openGeneration;
    e.control = { kind: "saving" };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (generation !== this.openGeneration) return;
    const doc = e.doc;
    try {
      await this.options.onSavePlan(e.slug, doc);
      if (generation !== this.openGeneration) return;
      e.baseline = JSON.stringify(doc);
      e.control = { kind: "none" };
      void this.readList();
    } catch (err) {
      if (generation !== this.openGeneration) return;
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

  async confirmSaveAs(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "saveAs" || e.control.busy) return;
    const slug = e.control.slug.trim();
    const own = e.origin === "library" ? e.slug : null;
    const taken = (this.list ?? []).some((p) => !p.preset && p.slug === slug && p.slug !== own);
    if (taken && !e.control.replace) {
      e.control = { ...e.control, replace: true };
      this.onChange();
      return;
    }
    const generation = this.openGeneration;
    e.control = { ...e.control, busy: true };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (generation !== this.openGeneration) return;
    const doc = e.doc;
    try {
      await this.options.onSavePlan(slug, doc);
      if (generation !== this.openGeneration) return;
      e.slug = slug;
      e.origin = "library";
      e.baseline = JSON.stringify(doc);
      e.control = { kind: "none" };
      void this.readList();
    } catch (err) {
      if (generation !== this.openGeneration) return;
      if (e.control.kind === "saveAs") e.control = { ...e.control, busy: false, replace: false };
      e.failure = message(err);
    }
    this.onChange();
  }

  armDelete(): void {
    const e = this.editing();
    if (!e || e.origin !== "library") return;
    e.control = { kind: "delete", busy: false };
    e.failure = null;
    this.onChange();
  }

  async confirmDelete(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "delete" || e.control.busy || e.origin !== "library") return;
    const generation = this.openGeneration;
    e.control = { kind: "delete", busy: true };
    this.onChange();
    try {
      await this.options.onDeletePlan(e.slug);
      if (generation !== this.openGeneration) return;
      this.abandon();
      this.state = { phase: "listing", failure: null };
      this.onChange();
      await this.readList();
    } catch (err) {
      if (generation !== this.openGeneration) return;
      e.control = { kind: "delete", busy: false };
      e.failure = message(err);
      this.onChange();
    }
  }

  get bootable(): boolean {
    const e = this.editing();
    return !!e && e.origin !== "line" && !e.readOnly && !this.dirty && e.problems.length === 0;
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

  async confirmBoot(): Promise<void> {
    const e = this.editing();
    if (e?.control.kind !== "boot" || e.control.busy) return;
    const work = e.control.work.trim();
    const generation = this.openGeneration;
    e.control = { ...e.control, busy: true };
    e.failure = null;
    this.onChange();
    await this.settled();
    if (generation !== this.openGeneration) return;
    try {
      const launched = await this.options.onBootPlan(e.slug, work);
      if (generation !== this.openGeneration) return;
      e.control = { kind: "booted", launched };
    } catch (err) {
      if (generation !== this.openGeneration) return;
      if (e.control.kind === "boot") e.control = { ...e.control, busy: false };
      e.failure = message(err);
    }
    this.onChange();
  }

  private onChange(): void {
    this.options.onChange();
  }

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
          e.origin === "library" && !e.readOnly
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
          e.origin === "library"
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
              e.origin === "line"
                ? "copy of the running Line · unsaved"
                : `${e.origin} ${e.slug}${e.readOnly ? " · read-only" : dirty ? " · unsaved" : ""}`,
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
    const e = this.editing();
    const open = e ? (e.origin === "line" ? null : e.slug) : this.state.phase === "opening" ? this.state.slug : null;
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
    const moved = e.edits.drops();
    const drawing = projectPlan({ plan: e.doc, problems: e.problems, warnings: e.warnings, verdicts: e.verdicts, places: moved });
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
        fitKey: String(e.opened),
        plan: e.doc,
        problems: e.problems,
        warnings: e.warnings,
        verdicts: e.verdicts,
        pendingDrops: moved,
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
          h("div", { class: "plan-warnings" }, ...e.warnings.map((w) => h("div", { class: "plan-warning" }, w.message))),
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
