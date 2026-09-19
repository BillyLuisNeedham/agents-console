/**
 * Enlist: the picker for live herdr panes and the form that turns one into a
 * Ticket (issue #101), one module owning the whole session state (whether the
 * picker is open, the panes herdr reported, the in-flight read and its
 * failure, and the draft form) and rendering from the pure projections. The
 * pane read fires when the picker opens, never on the snapshot cadence: the
 * list is ephemeral, not pool state, so it gets no channel and no cache.
 *
 * Picking an eligible pane closes the picker and opens the form, title
 * prefilled from the pane's own terminal title. The form's "Blocks" tick list
 * is every ticket not yet done, projected from the snapshot; submitting sends
 * only the fields for the chosen kind (Ticket here; ticket 05 adds the
 * Becomes switch) and surfaces a refusal from the engine's 409 inline without
 * losing the draft.
 */

import { h } from "./dom";
import {
  projectEnlistPicker,
  type EnlistBlockRow,
  type EnlistPane,
  type EnlistPickerRow,
  type EnlistRequest,
  type EnlistResponse,
  type PanesResponse,
} from "./project";

export type ListPanesHandler = () => Promise<PanesResponse>;
export type EnlistHandler = (request: EnlistRequest) => Promise<EnlistResponse>;

export interface EnlistOptions {
  onListPanes: ListPanesHandler;
  onEnlist: EnlistHandler;
  /** Picker or form state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

type DraftField = "title" | "spec";

export class EnlistStore {
  private isPickerOpen = false;
  private inFlight = false;
  private listFailure: string | null = null;
  private panes: EnlistPane[] = [];
  private picked: string | null = null;
  // The in-flight read's token: closing the picker (or a later open) makes an
  // older answer stale, so it never clobbers the newer state.
  private token = 0;

  // The form's session state. Non-null formPaneId means the form is open.
  private formPaneId: string | null = null;
  private draftTitle = "";
  private draftSpec = "";
  private ticked = new Set<string>();
  private submitting = false;
  private submitError: string | null = null;

  private readonly onListPanes: ListPanesHandler;
  private readonly onEnlist: EnlistHandler;
  private readonly onChange: () => void;

  constructor(options: EnlistOptions) {
    this.onListPanes = options.onListPanes;
    this.onEnlist = options.onEnlist;
    this.onChange = options.onChange;
  }

  get isOpen(): boolean {
    return this.isPickerOpen;
  }

  get isLoading(): boolean {
    return this.inFlight;
  }

  /** The last read's failure (a headless refusal or a daemon error), or null. */
  get failure(): string | null {
    return this.listFailure;
  }

  /** The pane picked for enlist, or null before one is picked. */
  get pickedPaneId(): string | null {
    return this.picked;
  }

  /** Whether the Enlist form is showing. */
  get isFormOpen(): boolean {
    return this.formPaneId !== null;
  }

  /** The pane the open form is enlisting, or null. */
  get formPaneIdValue(): string | null {
    return this.formPaneId;
  }

  field(name: DraftField): string {
    return name === "title" ? this.draftTitle : this.draftSpec;
  }

  setField(name: DraftField, value: string): void {
    if (name === "title") this.draftTitle = value;
    else this.draftSpec = value;
  }

  isTicked(id: string): boolean {
    return this.ticked.has(id);
  }

  /** The ticked ticket ids, in the order they were ticked. */
  blocks(): string[] {
    return [...this.ticked];
  }

  get isSubmitting(): boolean {
    return this.submitting;
  }

  get submitFailure(): string | null {
    return this.submitError;
  }

  /** The picker's rows, projected from the panes last reported. */
  rows(): EnlistPickerRow[] {
    return projectEnlistPicker(this.panes);
  }

  /**
   * Open the picker and read herdr's panes. A second open while one is
   * already showing is a no-op; closing and reopening reads afresh and
   * discards any answer still in flight from before.
   */
  async openPicker(): Promise<void> {
    if (this.isPickerOpen) return;
    const token = ++this.token;
    this.isPickerOpen = true;
    this.inFlight = true;
    this.listFailure = null;
    this.panes = [];
    this.picked = null;
    this.onChange();
    try {
      const response = await this.onListPanes();
      if (token !== this.token) return;
      this.panes = response.panes;
    } catch (err) {
      if (token !== this.token) return;
      this.listFailure = err instanceof Error ? err.message : String(err);
    } finally {
      if (token === this.token) {
        this.inFlight = false;
        this.onChange();
      }
    }
  }

  closePicker(): void {
    // Any answer still out belongs to the picker that is closing.
    this.token += 1;
    this.isPickerOpen = false;
    this.inFlight = false;
    this.listFailure = null;
    this.onChange();
  }

  /**
   * Pick a pane. Only an eligible pane can be picked; picking closes the
   * picker and opens the form, prefilled from the pane's terminal title.
   */
  pick(paneId: string): void {
    const pane = this.panes.find((candidate) => candidate.paneId === paneId);
    if (!pane || !pane.eligible) return;
    this.picked = paneId;
    this.isPickerOpen = false;
    this.formPaneId = paneId;
    this.draftTitle = pane.title;
    this.draftSpec = "";
    this.ticked = new Set();
    this.submitting = false;
    this.submitError = null;
    this.onChange();
  }

  closeForm(): void {
    if (this.formPaneId === null) return;
    this.formPaneId = null;
    this.draftTitle = "";
    this.draftSpec = "";
    this.ticked = new Set();
    this.submitting = false;
    this.submitError = null;
    this.onChange();
  }

  toggleBlock(id: string): void {
    if (this.ticked.has(id)) this.ticked.delete(id);
    else this.ticked.add(id);
    this.onChange();
  }

  /** Submit the form. A refusal leaves the draft open with the reason inline. */
  async submit(): Promise<void> {
    if (this.submitting || this.formPaneId === null) return;
    const title = this.draftTitle.trim();
    if (!title) {
      this.submitError = "title is required";
      this.onChange();
      return;
    }
    this.submitting = true;
    this.submitError = null;
    this.onChange();
    try {
      await this.onEnlist({
        becomes: "ticket",
        paneId: this.formPaneId,
        title,
        spec: this.draftSpec.trim(),
        blocks: this.blocks(),
      });
      this.formPaneId = null;
      this.draftTitle = "";
      this.draftSpec = "";
      this.ticked = new Set();
    } catch (err) {
      this.submitError = err instanceof Error ? err.message : String(err);
    } finally {
      this.submitting = false;
      this.onChange();
    }
  }

  /** The picker panel or the form panel, or null while neither is open. */
  render(blocks: EnlistBlockRow[]): HTMLElement | null {
    if (this.isFormOpen) return this.renderForm(blocks);
    if (!this.isPickerOpen) return null;
    const rows = this.rows();
    const body = this.inFlight
      ? h("div", { class: "enlist-empty" }, "reading herdr…")
      : this.listFailure
        ? h("div", { class: "error-inline enlist-failure" }, this.listFailure)
        : rows.length === 0
          ? h("div", { class: "enlist-empty" }, "no live terminals")
          : h(
              "div",
              { class: "enlist-rows" },
              ...rows.map((row) => this.renderRow(row)),
            );
    return h(
      "div",
      { class: "enlist-picker" },
      h(
        "div",
        { class: "enlist-head" },
        h("span", { class: "enlist-title" }, "enlist terminal"),
        h(
          "button",
          { class: "btn enlist-close", onclick: () => this.closePicker() },
          "cancel",
        ),
      ),
      body,
    );
  }

  private renderRow(row: EnlistPickerRow): HTMLElement {
    const element = h(
      "div",
      {
        class: `enlist-row${row.eligible ? "" : " enlist-row-ineligible"}`,
        title: row.eligible ? row.title : (row.reason ?? ""),
      },
      h(
        "div",
        { class: "enlist-row-main" },
        h("span", { class: "enlist-harness" }, row.harness ?? "no harness"),
        h("span", { class: "enlist-status" }, row.status),
        h("span", { class: "enlist-row-title" }, row.title || row.paneId),
      ),
      h(
        "div",
        { class: "enlist-where dim" },
        row.branch ? `${row.directory} · ${row.branch}` : row.directory,
      ),
      row.eligible
        ? null
        : h("div", { class: "enlist-reason" }, row.reason ?? ""),
    );
    if (row.eligible) {
      element.addEventListener("click", () => this.pick(row.paneId));
    }
    return element;
  }

  private renderForm(blocks: EnlistBlockRow[]): HTMLElement {
    const field = (
      name: DraftField,
      label: string,
      input: HTMLElement,
    ): HTMLElement =>
      h(
        "label",
        { class: "enlist-field" },
        h("span", { class: "enlist-field-label" }, label),
        input,
      );

    const titleInput = h("input", {
      class: "enlist-input",
      type: "text",
      value: this.draftTitle,
    });
    titleInput.addEventListener("input", () =>
      this.setField("title", titleInput.value),
    );
    const specInput = h("textarea", { class: "enlist-input enlist-spec" });
    specInput.value = this.draftSpec;
    specInput.addEventListener("input", () =>
      this.setField("spec", specInput.value),
    );

    return h(
      "div",
      { class: "enlist-picker enlist-form" },
      h(
        "div",
        { class: "enlist-head" },
        h("span", { class: "enlist-title" }, "enlist terminal as ticket"),
        h(
          "button",
          { class: "btn enlist-close", onclick: () => this.closeForm() },
          "cancel",
        ),
      ),
      field("title", "title", titleInput),
      field("spec", "spec", specInput),
      h(
        "div",
        { class: "enlist-blocks" },
        h("div", { class: "enlist-field-label" }, "blocks"),
        blocks.length === 0
          ? h("div", { class: "enlist-empty" }, "no unfinished tickets")
          : h(
              "div",
              { class: "enlist-block-rows" },
              ...blocks.map((block) =>
                h(
                  "label",
                  { class: "enlist-block" },
                  h("input", {
                    type: "checkbox",
                    checked: this.isTicked(block.id),
                    onchange: () => this.toggleBlock(block.id),
                  }),
                  h("span", { class: "enlist-block-id" }, block.id),
                  h("span", { class: "enlist-block-title" }, block.title),
                ),
              ),
            ),
      ),
      this.submitError
        ? h("div", { class: "error-inline enlist-failure" }, this.submitError)
        : null,
      h(
        "button",
        {
          class: "btn btn-primary enlist-submit",
          disabled: this.submitting,
          onclick: () => void this.submit(),
        },
        this.submitting ? "enlisting…" : "enlist",
      ),
    );
  }
}
