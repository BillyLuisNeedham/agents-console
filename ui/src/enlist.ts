/**
 * Enlist: the picker for live herdr panes (issue #101), one module owning the
 * picker's session state (whether it is open, the panes herdr reported, the
 * in-flight read and its failure) and rendering its rows from the pure
 * projection. The read fires when the picker opens, never on the snapshot
 * cadence: the pane list is ephemeral, not pool state, so it gets no channel
 * and no cache.
 *
 * Picking an eligible pane closes the picker for now and records the pick;
 * the enlist form hangs off that pick in ticket 03. Ineligible rows stay in
 * the list, greyed with the reason, and are not selectable.
 */

import { h } from "./dom";
import {
  projectEnlistPicker,
  type EnlistPane,
  type EnlistPickerRow,
  type PanesResponse,
} from "./project";

export type ListPanesHandler = () => Promise<PanesResponse>;

export interface EnlistOptions {
  onListPanes: ListPanesHandler;
  /** Picker state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

export class EnlistStore {
  private isPickerOpen = false;
  private inFlight = false;
  private listFailure: string | null = null;
  private panes: EnlistPane[] = [];
  private picked: string | null = null;
  // The in-flight read's token: closing the picker (or a later open) makes an
  // older answer stale, so it never clobbers the newer state.
  private token = 0;
  private readonly onListPanes: ListPanesHandler;
  private readonly onChange: () => void;

  constructor(options: EnlistOptions) {
    this.onListPanes = options.onListPanes;
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
   * picker and records the pane. The form that follows is ticket 03's.
   */
  pick(paneId: string): void {
    const pane = this.panes.find((candidate) => candidate.paneId === paneId);
    if (!pane || !pane.eligible) return;
    this.picked = paneId;
    this.isPickerOpen = false;
    this.onChange();
  }

  /** The picker panel, or null while it is closed. */
  render(): HTMLElement | null {
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
}
