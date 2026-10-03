/**
 * Reassign (CONTEXT.md: Reassign; issue #126): the operator rewriting a
 * Ticket's assign entry from the Console, one Ticket from its Detail or many
 * at once from the Pool settings. One module owns the whole session state:
 * the per-ticket drafts the Detail editor renders from, the harness list both
 * surfaces pick from, the bulk dialog's tick set and its tri-state form, and
 * every save state, so a refused write keeps the draft and says why beside
 * the control rather than on the global banner.
 *
 * Nothing here decides what an Assignment is or who may be reassigned: the
 * engine resolves both and the snapshot carries them field by field, so the
 * pills, the eligibility and the reasons are read, never derived. The write
 * answers with a fresh snapshot, which the composition pushes through
 * setSnapshot; the engine picks the file up at its next Config reload
 * (ADR-0018), the same seam a hand edit uses.
 *
 * The Detail's editor is deliberately the smaller of the two. Emptying a
 * field there is how a Ticket stops being pinned, the way an emptied Settings
 * field travels as null; the bulk dialog, which has no per-ticket baseline to
 * compare against, spells the same three intents out as leave / set / clear.
 */

import { h } from "./dom";
import { effortInput, effortValue } from "./effort";
import type { GetSettingsHandler, SaveState } from "./settings";
import type {
  AssignmentSource,
  AssignmentView,
  ReassignRequest,
  ReassignResponse,
  ReassignTicketRow,
} from "./project";

/** The Reassign write: what it applied and skipped. The new Assignment
 *  itself arrives as a delta, ahead of the reply (issue #161). */
export type ReassignHandler = (
  request: ReassignRequest,
) => Promise<Omit<ReassignResponse, "snapshot">>;

export interface ReassignOptions {
  /** The harness list both surfaces offer, read from the settings endpoint
   *  the Settings pane already reads: harnesses are not pool state. */
  onGetSettings: GetSettingsHandler;
  onReassign: ReassignHandler;
  /** Store state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

/** The five `assign` keys a Reassign writes. */
export type ReassignField = "harness" | "model" | "effort" | "drivers" | "verify";

export const REASSIGN_FIELDS: readonly ReassignField[] = [
  "harness",
  "model",
  "effort",
  "drivers",
  "verify",
];

/** One ticket's Detail draft: the text in each of the five fields. */
export type ReassignDraft = Record<ReassignField, string>;

/** What a ticket's draft is seeded from and compared against: the Assignment
 *  in force plus the ticket's own verify count. */
export interface ReassignSeed {
  assignment: AssignmentView;
  verify: number | null;
  /**
   * An enlisted ticket runs whatever the pane it was taken from is already
   * running, so the engine fixes its model, effort, drivers and verify by
   * the as-found rule and refuses a write to any of them. Only its harness can
   * be reassigned, and the editor offers only that.
   */
  harnessOnly?: boolean;
}

/** What the Console tells the operator when a write would reach an enlisted
 *  ticket's fixed fields. The engine refuses the same write in its own
 *  words; this is the Console declining to ask. */
export const ENLISTED_HARNESS_ONLY = "enlisted: only harness can be reassigned";

/** The bulk dialog's per-field intent: leave it alone, set it to a value, or
 *  clear the ticket's own entry for it. */
export type ReassignMode = "leave" | "set" | "clear";

export type BulkDraft = Record<ReassignField, { mode: ReassignMode; value: string }>;

/** The result line a finished apply shows: what landed and what did not. */
export interface ReassignResult {
  applied: number;
  skipped: { id: string; reason: string }[];
}

const EMPTY_BULK_DRAFT: BulkDraft = {
  harness: { mode: "leave", value: "" },
  model: { mode: "leave", value: "" },
  effort: { mode: "leave", value: "" },
  drivers: { mode: "leave", value: "" },
  verify: { mode: "leave", value: "" },
};

/** The draft a ticket's Assignment seeds: every field prefilled with the
 *  value in force, whether that value is pinned or inherited. */
export function draftFrom(seed: ReassignSeed): ReassignDraft {
  return {
    harness: seed.assignment.harness ?? "",
    model: seed.assignment.model ?? "",
    effort: seed.assignment.effort ?? "",
    drivers: seed.assignment.drivers ?? "",
    verify: seed.verify === null ? "" : String(seed.verify),
  };
}

/**
 * What is wrong with a verify field, or null when it is sendable. Blank is
 * always fine: it means the ticket carries no verify count of its own.
 */
export function validateVerify(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    return "verify must be a whole number of 1 or more, or blank";
  }
  return null;
}

/**
 * The write body one ticket's edited draft sends. A field the operator left
 * as they found it is absent, so the write leaves it alone; an emptied field
 * travels as null so the ticket follows its parent or the pool defaults
 * again, the way an emptied Settings field removes its key; anything else
 * travels as its value. Comparing against the seed is what makes a field the
 * operator never touched stay unpinned: showing an inherited value is not
 * the same as choosing it.
 */
export function ticketFieldsFrom(
  draft: ReassignDraft,
  seed: ReassignSeed,
): ReassignRequest["fields"] {
  const baseline = draftFrom(seed);
  const fields: ReassignRequest["fields"] = {};
  const harness = draft.harness.trim();
  if (harness !== baseline.harness.trim()) fields.harness = harness || null;
  // An enlisted ticket's other fields are the engine's to fix, so a draft
  // that still holds an edit to one (the ticket was enlisted after the
  // editor opened) never travels.
  if (seed.harnessOnly) return fields;
  for (const name of ["model", "effort", "drivers"] as const) {
    const value = draft[name].trim();
    if (value === baseline[name].trim()) continue;
    fields[name] = value || null;
  }
  const verify = draft.verify.trim();
  if (verify !== baseline.verify.trim()) {
    fields.verify = verify ? Number(verify) : null;
  }
  return fields;
}

/**
 * The write body the bulk form sends. `leave` keeps the key out, `clear`
 * sends null, `set` sends the value. Spelled out rather than inferred
 * because the dialog edits many tickets at once and has no single baseline
 * an emptied field could mean "clear" against.
 */
export function bulkFieldsFrom(draft: BulkDraft): ReassignRequest["fields"] {
  const fields: ReassignRequest["fields"] = {};
  for (const name of REASSIGN_FIELDS) {
    const field = draft[name];
    if (field.mode === "leave") continue;
    if (field.mode === "clear") {
      fields[name] = null;
      continue;
    }
    if (name === "verify") fields.verify = Number(field.value.trim());
    else fields[name] = field.value.trim();
  }
  return fields;
}

/**
 * What is wrong with the bulk form, or null when it is sendable. A form with
 * every field on `leave` would write nothing, and a `set` with nothing in it
 * would ask the engine to unassign the ticket, so both fail here rather than
 * travelling to be refused.
 */
export function validateBulkDraft(draft: BulkDraft): string | null {
  if (REASSIGN_FIELDS.every((name) => draft[name].mode === "leave")) {
    return "nothing to change: every field is set to leave";
  }
  for (const name of REASSIGN_FIELDS) {
    const field = draft[name];
    if (field.mode !== "set") continue;
    if (!field.value.trim()) return `${name} is set but has no value`;
    if (name === "verify") {
      const invalid = validateVerify(field.value);
      if (invalid) return invalid;
    }
  }
  return null;
}

/** The result line a finished apply prints, reasons and all. */
export function resultLine(result: ReassignResult): string {
  const applied = `applied ${result.applied}`;
  if (result.skipped.length === 0) return applied;
  const reasons = result.skipped
    .map((skip) => `${skip.id}: ${skip.reason}`)
    .join("; ");
  return `${applied}, skipped ${result.skipped.length} (${reasons})`;
}

export class ReassignStore {
  // The Detail editor's drafts, keyed by ticket id, so a snapshot re-render
  // never wipes a field being typed. A draft is dropped when its save lands
  // (the fresh snapshot is the new baseline) and pruned when its ticket stops
  // being reassignable.
  private readonly drafts = new Map<string, ReassignDraft>();
  private readonly saveStates = new Map<string, SaveState>();
  private readonly saveErrors = new Map<string, string>();
  // Tickets whose write is out. Their draft and save state are the in-flight
  // save's to settle, so a prune between the send and the answer leaves them
  // alone rather than dropping the "saving…" the operator is watching.
  private readonly inFlight = new Set<string>();

  // The harness list, read once from the settings endpoint when a Reassign
  // surface first needs it. A failed read leaves the list empty and the
  // selects fall back to the value each ticket already holds, so the pane
  // still works.
  private harnessList: string[] = [];
  private harnessesAsked = false;

  private dialogOpen = false;
  // Ticked is held as its complement: every listed ticket starts ticked, so
  // a ticket that appears while the dialog is open is ticked too.
  private unticked = new Set<string>();
  private bulk: BulkDraft = cloneBulk(EMPTY_BULK_DRAFT);
  private applying = false;
  private applyError: string | null = null;
  private applyResult: ReassignResult | null = null;

  private readonly onGetSettings: GetSettingsHandler;
  private readonly onReassign: ReassignHandler;
  private readonly onChange: () => void;

  constructor(options: ReassignOptions) {
    this.onGetSettings = options.onGetSettings;
    this.onReassign = options.onReassign;
    this.onChange = options.onChange;
  }

  // -------------------------------------------------------------------------
  // Harnesses
  // -------------------------------------------------------------------------

  /** The harness names the selects offer; empty until the read lands. */
  get harnesses(): string[] {
    return this.harnessList;
  }

  /**
   * Read the harness list, once per session. Fired when a Reassign surface
   * first renders rather than on the snapshot cadence: the harness table is a
   * file on disk, not pool state.
   */
  ensureHarnesses(): void {
    if (this.harnessesAsked) return;
    this.harnessesAsked = true;
    void this.onGetSettings()
      .then((response) => {
        this.harnessList = response.harnesses;
        this.onChange();
      })
      .catch(() => {
        // The selects fall back to the value each ticket already holds; a
        // missing harness list is not worth an error surface of its own.
      });
  }

  // -------------------------------------------------------------------------
  // One ticket, from its Detail
  // -------------------------------------------------------------------------

  /** The ticket's draft, seeded from the Assignment in force on first touch. */
  draftFor(ticketId: string, seed: ReassignSeed): ReassignDraft {
    const held = this.drafts.get(ticketId);
    if (held) return held;
    const fresh = draftFrom(seed);
    this.drafts.set(ticketId, fresh);
    return fresh;
  }

  field(ticketId: string, name: ReassignField, seed: ReassignSeed): string {
    return this.draftFor(ticketId, seed)[name];
  }

  setField(
    ticketId: string,
    name: ReassignField,
    value: string,
    seed: ReassignSeed,
  ): void {
    const draft = this.draftFor(ticketId, seed);
    if (draft[name] === value) return;
    draft[name] = value;
    // A fresh edit retires the last save's verdict: "saved" belongs to what
    // is on disk, and this draft no longer is.
    if (this.saveStates.get(ticketId) === "saved") this.saveStates.delete(ticketId);
    this.saveErrors.delete(ticketId);
    this.onChange();
  }

  /** Empty a field, which is how a Ticket stops being pinned on it. */
  clearField(ticketId: string, name: ReassignField, seed: ReassignSeed): void {
    this.setField(ticketId, name, "", seed);
  }

  /** Whether the draft would write anything: the Save button's enable. */
  isDirty(ticketId: string, seed: ReassignSeed): boolean {
    const draft = this.drafts.get(ticketId);
    if (!draft) return false;
    return Object.keys(ticketFieldsFrom(draft, seed)).length > 0;
  }

  saveState(ticketId: string): SaveState {
    return this.saveStates.get(ticketId) ?? "idle";
  }

  saveFailure(ticketId: string): string | null {
    return this.saveErrors.get(ticketId) ?? null;
  }

  /**
   * Save one ticket's draft. A draft that cannot be sent fails on the spot
   * with its reason inline and nothing leaves the page; a refusal from the
   * engine leaves the draft as it stands with the reason beside Save. On a
   * write that landed the draft is dropped, so the next render re-seeds it
   * from the snapshot the answer pushed rather than from what was sent. A
   * ticket the engine skipped is not a save: it keeps its draft and shows
   * the engine's reason.
   */
  async save(ticketId: string, seed: ReassignSeed): Promise<void> {
    if (this.saveState(ticketId) === "saving") return;
    const draft = this.draftFor(ticketId, seed);
    const invalid = validateVerify(draft.verify);
    if (invalid) {
      this.saveErrors.set(ticketId, invalid);
      this.saveStates.delete(ticketId);
      this.onChange();
      return;
    }
    const fields = ticketFieldsFrom(draft, seed);
    if (Object.keys(fields).length === 0) return;
    // What went out, held so the answer can tell an untouched draft from one
    // the operator kept typing into while the write was in flight: dropping
    // the draft on a save that no longer matches it would eat those keystrokes.
    const sent = { ...draft };
    this.saveStates.set(ticketId, "saving");
    this.saveErrors.delete(ticketId);
    this.inFlight.add(ticketId);
    this.onChange();
    try {
      const response = await this.onReassign({ tickets: [ticketId], fields });
      const skipped = response.skipped.find((skip) => skip.id === ticketId);
      if (skipped) {
        this.saveStates.delete(ticketId);
        this.saveErrors.set(ticketId, skipped.reason);
      } else {
        const live = this.drafts.get(ticketId);
        if (live && sameDraft(live, sent)) this.drafts.delete(ticketId);
        this.saveStates.set(ticketId, "saved");
      }
    } catch (err) {
      this.saveStates.delete(ticketId);
      this.saveErrors.set(ticketId, err instanceof Error ? err.message : String(err));
    }
    this.inFlight.delete(ticketId);
    this.onChange();
  }

  /** Drop drafts whose ticket stopped being reassignable or left the pool. A
   *  ticket with a write in flight keeps its draft and its save state until
   *  that write answers. */
  pruneDrafts(reassignableIds: ReadonlySet<string>): void {
    const keep = (id: string): boolean =>
      reassignableIds.has(id) || this.inFlight.has(id);
    for (const id of [...this.drafts.keys()]) {
      if (!keep(id)) this.drafts.delete(id);
    }
    for (const id of [...this.saveStates.keys()]) {
      if (!keep(id)) this.saveStates.delete(id);
    }
    for (const id of [...this.saveErrors.keys()]) {
      if (!keep(id)) this.saveErrors.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Many tickets, from the Settings pane
  // -------------------------------------------------------------------------

  get isDialogOpen(): boolean {
    return this.dialogOpen;
  }

  openDialog(): void {
    if (this.dialogOpen) return;
    this.dialogOpen = true;
    this.unticked = new Set();
    this.bulk = cloneBulk(EMPTY_BULK_DRAFT);
    this.applying = false;
    this.applyError = null;
    this.applyResult = null;
    this.ensureHarnesses();
    this.onChange();
  }

  closeDialog(): void {
    if (!this.dialogOpen) return;
    this.dialogOpen = false;
    this.onChange();
  }

  isTicked(id: string): boolean {
    return !this.unticked.has(id);
  }

  toggleTicked(id: string): void {
    if (this.unticked.has(id)) this.unticked.delete(id);
    else this.unticked.add(id);
    this.retireResult();
    this.onChange();
  }

  /** The select-all / select-none toggle, over the rows now listed. */
  setAllTicked(rows: ReassignTicketRow[], ticked: boolean): void {
    this.unticked = ticked ? new Set() : new Set(rows.map((row) => row.id));
    this.retireResult();
    this.onChange();
  }

  /** The ticked ids among the rows now listed, in list order. */
  tickedIds(rows: ReassignTicketRow[]): string[] {
    return rows.filter((row) => this.isTicked(row.id)).map((row) => row.id);
  }

  bulkField(name: ReassignField): { mode: ReassignMode; value: string } {
    return this.bulk[name];
  }

  setBulkMode(name: ReassignField, mode: ReassignMode): void {
    if (this.bulk[name].mode === mode) return;
    this.bulk[name] = { mode, value: mode === "set" ? this.bulk[name].value : "" };
    this.retireResult();
    this.onChange();
  }

  setBulkValue(name: ReassignField, value: string): void {
    if (this.bulk[name].value === value) return;
    // Typing into a field is choosing to set it, so the mode follows rather
    // than leaving a typed value that would never travel.
    this.bulk[name] = { mode: "set", value };
    this.retireResult();
    this.onChange();
  }

  get isApplying(): boolean {
    return this.applying;
  }

  get failure(): string | null {
    return this.applyError;
  }

  get result(): ReassignResult | null {
    return this.applyResult;
  }

  /**
   * Apply the form to every ticked ticket. A form that cannot be sent fails
   * on the spot and nothing leaves the page; a refused write keeps the whole
   * draft, tick set and all, with the engine's reason inline. A write that
   * landed leaves the form as it stands with its result line, so a second
   * apply over a different tick set takes one click.
   */
  async apply(rows: ReassignTicketRow[]): Promise<void> {
    if (this.applying) return;
    const tickets = this.tickedIds(rows);
    if (tickets.length === 0) {
      this.applyError = "no tickets ticked";
      this.applyResult = null;
      this.onChange();
      return;
    }
    const invalid = validateBulkDraft(this.bulk);
    if (invalid) {
      this.applyError = invalid;
      this.applyResult = null;
      this.onChange();
      return;
    }
    const fields = bulkFieldsFrom(this.bulk);
    // An enlisted ticket's model, effort, drivers and verify are the engine's to fix,
    // and it refuses the whole write rather than part of it. So a form that
    // touches any of them leaves the enlisted tickets out here and says so on
    // the result line, which keeps one Apply one request.
    const enlisted = new Set(
      rows.filter((row) => row.enlisted).map((row) => row.id),
    );
    const touchesFixed = Object.keys(fields).some((key) => key !== "harness");
    const declined = touchesFixed
      ? tickets
          .filter((id) => enlisted.has(id))
          .map((id) => ({ id, reason: ENLISTED_HARNESS_ONLY }))
      : [];
    const send = tickets.filter((id) => !touchesFixed || !enlisted.has(id));
    if (send.length === 0) {
      this.applyResult = { applied: 0, skipped: declined };
      this.onChange();
      return;
    }
    this.applying = true;
    this.applyError = null;
    this.applyResult = null;
    this.onChange();
    try {
      const response = await this.onReassign({ tickets: send, fields });
      this.applyResult = {
        applied: response.applied.length,
        skipped: [...declined, ...response.skipped],
      };
    } catch (err) {
      this.applyError = err instanceof Error ? err.message : String(err);
    }
    this.applying = false;
    this.onChange();
  }

  /** A changed tick or field retires the last apply's verdict: the counts
   *  belong to what was sent, and this form no longer is. */
  private retireResult(): void {
    this.applyResult = null;
    this.applyError = null;
  }

  // -------------------------------------------------------------------------
  // Render: the bulk dialog, a third absolute pane beside Settings and Enlist
  // -------------------------------------------------------------------------

  /** The dialog, or null while it is closed. */
  render(rows: ReassignTicketRow[]): HTMLElement | null {
    if (!this.dialogOpen) return null;
    return h(
      "div",
      { class: "reassign-dialog", key: "reassign-dialog" },
      h(
        "div",
        { class: "reassign-head" },
        h("span", { class: "reassign-title" }, "reassign tickets"),
        h(
          "button",
          {
            class: "btn reassign-close",
            type: "button",
            onclick: () => this.closeDialog(),
          },
          "close",
        ),
      ),
      this.renderRows(rows),
      this.renderForm(rows),
    );
  }

  private renderRows(rows: ReassignTicketRow[]): HTMLElement {
    if (rows.length === 0) {
      return h(
        "div",
        { class: "reassign-empty", key: "reassign-empty" },
        "no ticket can be reassigned right now",
      );
    }
    const all = rows.every((row) => this.isTicked(row.id));
    return h(
      "div",
      { class: "reassign-list", key: "reassign-list" },
      h(
        "div",
        { class: "reassign-list-head" },
        h(
          "button",
          {
            class: "btn reassign-all",
            type: "button",
            onclick: () => this.setAllTicked(rows, !all),
          },
          all ? "select none" : "select all",
        ),
        h(
          "span",
          { class: "dim reassign-count" },
          `${this.tickedIds(rows).length} of ${rows.length} ticked`,
        ),
      ),
      h(
        "div",
        { class: "reassign-rows", key: "reassign-rows" },
        ...rows.map((row) => this.renderRow(row)),
      ),
    );
  }

  private renderRow(row: ReassignTicketRow): HTMLElement {
    return h(
      "label",
      { class: "reassign-row", key: row.id },
      h("input", {
        class: "reassign-tick",
        key: `${row.id}-tick`,
        type: "checkbox",
        checked: this.isTicked(row.id),
        onchange: () => this.toggleTicked(row.id),
      }),
      h(
        "div",
        { class: "reassign-row-body" },
        h(
          "div",
          { class: "reassign-row-head" },
          h("span", { class: "reassign-row-id" }, row.id),
          h("span", { class: "reassign-row-title" }, row.title),
          row.enlisted
            ? h(
                "span",
                {
                  class: "settings-badge reassign-harness-only",
                  title:
                    "this ticket runs as it was found: only its harness can be reassigned",
                },
                "harness only",
              )
            : null,
        ),
        h(
          "div",
          { class: "reassign-row-fields" },
          fieldPill("harness", row.assignment.harness, row.sources.harness),
          fieldPill("model", row.assignment.model, row.sources.model),
          fieldPill(
            "effort",
            effortValue(row.assignment),
            row.sources.effort,
            "(harness default)",
          ),
          fieldPill("drivers", row.assignment.drivers, row.sources.drivers),
          fieldPill(
            "verify",
            row.verify === null ? null : String(row.verify),
            row.verify === null ? "unset" : "pinned",
          ),
        ),
        row.reason ? h("div", { class: "dim reassign-row-note" }, row.reason) : null,
      ),
    );
  }

  private renderForm(rows: ReassignTicketRow[]): HTMLElement {
    const result = this.applyResult;
    return h(
      "div",
      { class: "reassign-form", key: "reassign-form" },
      h(
        "div",
        { class: "dim reassign-form-note" },
        "leave keeps a field as each ticket has it; set pins the same value on every ticked ticket; clear drops the ticket's own entry so it follows its Spawn request, its parent or the pool defaults again",
      ),
      this.renderBulkField("harness", "harness"),
      this.renderBulkField("model", "model"),
      this.renderBulkField("effort", "effort"),
      this.renderBulkField("drivers", "drivers"),
      this.renderBulkField("verify", "verify"),
      h(
        "div",
        { class: "reassign-apply-row", key: "reassign-apply-row" },
        h(
          "button",
          {
            class: "btn btn-primary reassign-apply",
            type: "button",
            disabled: this.applying,
            onclick: () => void this.apply(rows),
          },
          this.applying ? "applying…" : "Apply",
        ),
        result
          ? h("span", { class: "reassign-result" }, resultLine(result))
          : null,
        this.applyError
          ? h("span", { class: "error-inline reassign-failure" }, this.applyError)
          : null,
      ),
    );
  }

  private renderBulkField(name: ReassignField, label: string): HTMLElement {
    const field = this.bulk[name];
    const mode = (value: ReassignMode, text: string): HTMLElement =>
      h(
        "button",
        {
          class:
            `btn reassign-mode reassign-mode-${value}` +
            (field.mode === value ? " active" : ""),
          type: "button",
          "aria-pressed": field.mode === value ? "true" : "false",
          onclick: () => this.setBulkMode(name, value),
        },
        text,
      );
    return h(
      "div",
      { class: "reassign-field", key: `reassign-field-${name}` },
      h("span", { class: "reassign-field-label" }, label),
      h(
        "div",
        { class: "reassign-modes" },
        mode("leave", "leave"),
        mode("set", "set"),
        mode("clear", "clear"),
      ),
      field.mode === "set"
        ? name === "harness"
          ? harnessSelect(
              `reassign-bulk-harness`,
              this.harnessList,
              field.value,
              (value) => this.setBulkValue("harness", value),
            )
          : name === "effort"
            ? effortInput({
                key: "reassign-bulk-effort",
                class: "settings-input reassign-input",
                // Every ticked ticket may run a different harness, so the
                // words are suggested only when the form sets one for all.
                harness: this.bulk.harness.mode === "set" ? this.bulk.harness.value : null,
                value: field.value,
                onInput: (value) => this.setBulkValue("effort", value),
              })
            : h("input", {
              class: "settings-input reassign-input",
              key: `reassign-bulk-${name}`,
              type: name === "verify" ? "number" : "text",
              min: name === "verify" ? "1" : null,
              value: field.value,
              oninput: (event: Event) =>
                this.setBulkValue(name, (event.currentTarget as HTMLInputElement).value),
            })
        : null,
    );
  }
}

function sameDraft(a: ReassignDraft, b: ReassignDraft): boolean {
  return REASSIGN_FIELDS.every((name) => a[name] === b[name]);
}

function cloneBulk(draft: BulkDraft): BulkDraft {
  return {
    harness: { ...draft.harness },
    model: { ...draft.model },
    effort: { ...draft.effort },
    drivers: { ...draft.drivers },
    verify: { ...draft.verify },
  };
}

/** One field of a row's Assignment: its value and where it came from. */
function fieldPill(
  label: string,
  value: string | null,
  source: AssignmentSource,
  empty = "(none)",
): HTMLElement {
  return h(
    "span",
    { class: "reassign-pill" },
    h("span", { class: "reassign-pill-label dim" }, label),
    h("span", { class: "reassign-pill-value" }, value ?? empty),
    renderSource(source),
  );
}

/**
 * A field's provenance as a small pill: pinned on the ticket, requested by
 * the Spawn proposal that created it, inherited from its parent or build
 * ticket, taken from the pool defaults, or nowhere at
 * all. The one thing that says whether editing the pool defaults would move
 * this ticket.
 */
export function renderSource(source: AssignmentSource): HTMLElement {
  return h(
    "span",
    {
      class: `settings-badge reassign-source reassign-source-${source}`,
      title: SOURCE_TITLES[source],
    },
    source,
  );
}

const SOURCE_TITLES: Record<AssignmentSource, string> = {
  pinned: "this ticket's own assign entry sets this field",
  requested: "requested by the Spawn proposal that created this ticket",
  inherited: "taken from this ticket's parent or build ticket",
  default: "taken from the pool defaults; editing them moves this ticket",
  unset: "nothing sets this field",
};

/**
 * A select over the harnesses the engine knows. The key carries the option
 * list because a morph applies a select's `value` before its children: a
 * select whose options arrived in the same render would take its value
 * against the old, empty list. The value is reasserted once the options are
 * in place, the way the Settings pane's harness select does.
 */
export function harnessSelect(
  key: string,
  harnesses: string[],
  value: string,
  onPick: (value: string) => void,
): HTMLSelectElement {
  const options = [
    { value: "", label: "(none)" },
    ...harnesses.map((name) => ({ value: name, label: name })),
  ];
  // A value the options do not carry (a harness the engine no longer knows)
  // would silently become the first option, so it joins the list as itself.
  const all = options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: value }];
  const select = h(
    "select",
    {
      class: "settings-input settings-select reassign-select",
      // The whole option list, not just the harnesses: a ticket pinned to a
      // harness the engine no longer knows adds a fallback option, and a
      // kept node would take its value against the list it was built with.
      key: `${key}:${all.map((option) => option.value).join("|")}`,
      value,
      onchange: (event: Event) =>
        onPick((event.currentTarget as HTMLSelectElement).value),
    },
    ...all.map((option) =>
      h("option", { value: option.value, key: option.value }, option.label),
    ),
  );
  select.value = value;
  return select;
}
