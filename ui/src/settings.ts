/**
 * Settings: the pane that edits one Pool's config and the machine's defaults
 * (ADR-0026, issue #121), one module owning the whole session state (whether
 * the pane is open, the read in flight and its failure, the two drafts, and
 * each form's save state) and rendering from the pure projections. The read
 * fires when the pane opens, never on the snapshot cadence: settings are
 * files on disk, not pool state, so they get no channel and no cache.
 *
 * Two forms sit in one pane because they answer one question between them:
 * what this pool runs with, and what a pool inherits when it says nothing.
 * Each has its own Save, its own dirty flag and its own inline status, so a
 * refused machine write never loses a pool edit. The assignment slice takes
 * effect through the engine's Config reload at the next super-step boundary;
 * the boot-only keys carry a "restart to apply" badge until the Restart in
 * the footer hands off to Boot.
 */

import { h } from "./dom";
import {
  projectRestartBadges,
  type BootOnlyKey,
  type MachineDefaults,
  type PoolConfig,
  type PoolConfigPatch,
  type SettingsResponse,
} from "./project";
import type { RestartView } from "./view";

export type GetSettingsHandler = () => Promise<SettingsResponse>;
export type SavePoolHandler = (config: PoolConfigPatch) => Promise<SettingsResponse>;
export type SaveMachineHandler = (
  defaults: MachineDefaults,
) => Promise<SettingsResponse>;

/** The Restart control's three intents, the Stop control's shape exactly. */
export interface RestartHandlers {
  onArmRestart: () => void;
  onCancelRestart: () => void;
  onConfirmRestart: () => void;
}

export interface SettingsOptions {
  onGetSettings: GetSettingsHandler;
  onSavePool: SavePoolHandler;
  onSaveMachine: SaveMachineHandler;
  /** Open the Reassign bulk dialog (issue #126). The pane offers the button
   *  and nothing more: the dialog is its own pane with its own store. */
  onOpenReassign: () => void;
  /** Pane state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

/** A form's save state: the button's label and what shows beside it. */
export type SaveState = "idle" | "saving" | "saved";

/** The Pool settings form's text and toggle fields, all held as drafts. */
export interface PoolDraft {
  harness: string;
  model: string;
  drivers: string;
  /** The resolver's harness, or "none" to opt out of resolution entirely. */
  resolverHarness: string;
  resolverModel: string;
  selection: string;
  terminal: boolean;
  /** Empty means auto: the server picks a free port at boot. */
  port: string;
  roster: string;
  agents: string;
  reviewer: string;
  checkpoint: string;
}

export interface MachineDraft {
  harness: string;
  model: string;
  drivers: string;
  terminal: boolean;
  engine: string;
}

export type PoolTextField = Exclude<keyof PoolDraft, "terminal">;
export type MachineTextField = Exclude<keyof MachineDraft, "terminal">;

/** The "opt out of resolution" value, which the file holds as a plain string. */
const RESOLVER_NONE = "none";

const EMPTY_POOL_DRAFT: PoolDraft = {
  harness: "",
  model: "",
  drivers: "",
  resolverHarness: "",
  resolverModel: "",
  selection: "",
  terminal: false,
  port: "",
  roster: "",
  agents: "",
  reviewer: "",
  checkpoint: "",
};

const EMPTY_MACHINE_DRAFT: MachineDraft = {
  harness: "",
  model: "",
  drivers: "",
  terminal: false,
  engine: "",
};

/** The pool draft the file's config seeds, every absent key an empty field. */
export function poolDraftFrom(config: PoolConfig): PoolDraft {
  const defaults = config.defaults ?? {};
  const resolver = config.resolver;
  let resolverHarness = "";
  let resolverModel = "";
  if (typeof resolver === "string") {
    resolverHarness = resolver;
  } else if (resolver && typeof resolver === "object") {
    resolverHarness = resolver.harness ?? "";
    resolverModel = resolver.model ?? "";
  }
  return {
    harness: defaults.harness ?? "",
    model: defaults.model ?? "",
    drivers: defaults.drivers ?? "",
    resolverHarness,
    resolverModel,
    selection: config.selection ?? "",
    terminal: config.terminal === "herdr",
    port: typeof config.port === "number" ? String(config.port) : "",
    roster: config.roster ?? "",
    agents: config.agents ?? "",
    reviewer: config.reviewer ?? "",
    checkpoint: config.checkpoint ?? "",
  };
}

/** The machine draft the defaults file seeds; the merged view is placeholders. */
export function machineDraftFrom(own: MachineDefaults): MachineDraft {
  return {
    harness: own.harness ?? "",
    model: own.model ?? "",
    drivers: own.drivers ?? "",
    terminal: own.terminal === "herdr",
    engine: own.engine ?? "",
  };
}

/**
 * What is wrong with a draft, or null when it is sendable. Only the two
 * fields with a shape the operator can get wrong are checked here: a port
 * that is not a port, and an agents roster that is not JSON. Everything else
 * is free text the engine validates on its own terms.
 */
export function validatePoolDraft(draft: PoolDraft): string | null {
  const port = draft.port.trim();
  if (port) {
    const parsed = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return "port must be a whole number between 1 and 65535, or empty for auto";
    }
  }
  const agents = draft.agents.trim();
  if (agents) {
    try {
      JSON.parse(agents);
    } catch {
      return "agents must be valid JSON";
    }
  }
  return null;
}

/**
 * The patch a pool draft sends. An emptied field travels as null (or, inside
 * `defaults`, as an empty string) so the engine removes the key rather than
 * writing a blank one: an absent port means auto, an absent terminal means
 * headless. The resolver collapses to the shape it was given, a bare harness
 * name when there is no resolver model and the pair when there is.
 */
export function poolPatchFrom(draft: PoolDraft): PoolConfigPatch {
  const trim = (value: string): string => value.trim();
  const orNull = (value: string): string | null => trim(value) || null;
  const resolverHarness = trim(draft.resolverHarness);
  const resolverModel = trim(draft.resolverModel);
  let resolver: PoolConfigPatch["resolver"];
  if (resolverHarness === RESOLVER_NONE) {
    resolver = RESOLVER_NONE;
  } else if (!resolverHarness && !resolverModel) {
    resolver = null;
  } else if (!resolverModel) {
    resolver = resolverHarness;
  } else {
    resolver = resolverHarness
      ? { harness: resolverHarness, model: resolverModel }
      : { model: resolverModel };
  }
  const port = trim(draft.port);
  const selection = trim(draft.selection);
  return {
    defaults: {
      harness: trim(draft.harness),
      model: trim(draft.model),
      drivers: trim(draft.drivers),
    },
    resolver,
    terminal: draft.terminal ? "herdr" : null,
    port: port ? Number(port) : null,
    selection: selection === "auto" || selection === "human" ? selection : null,
    roster: orNull(draft.roster),
    agents: orNull(draft.agents),
    reviewer: orNull(draft.reviewer),
    checkpoint: orNull(draft.checkpoint),
  };
}

/** The machine defaults a draft sends, every emptied field left out. */
export function machineDefaultsFrom(draft: MachineDraft): MachineDefaults {
  const defaults: MachineDefaults = {};
  const harness = draft.harness.trim();
  const model = draft.model.trim();
  const drivers = draft.drivers.trim();
  const engine = draft.engine.trim();
  if (harness) defaults.harness = harness;
  if (model) defaults.model = model;
  if (drivers) defaults.drivers = drivers;
  if (engine) defaults.engine = engine;
  if (draft.terminal) defaults.terminal = "herdr";
  return defaults;
}

function sameDraft<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key]);
}

export class SettingsStore {
  private isPaneOpen = false;
  private inFlight = false;
  private readFailure: string | null = null;
  private data: SettingsResponse | null = null;
  // The in-flight read's token: closing the pane (or a later open) makes an
  // older answer stale, so it never clobbers the newer state.
  private token = 0;

  private poolDraft: PoolDraft = { ...EMPTY_POOL_DRAFT };
  private poolBaseline: PoolDraft = { ...EMPTY_POOL_DRAFT };
  private poolState: SaveState = "idle";
  private poolError: string | null = null;

  private machineDraft: MachineDraft = { ...EMPTY_MACHINE_DRAFT };
  private machineBaseline: MachineDraft = { ...EMPTY_MACHINE_DRAFT };
  private machineState: SaveState = "idle";
  private machineError: string | null = null;

  private readonly onGetSettings: GetSettingsHandler;
  private readonly onSavePool: SavePoolHandler;
  private readonly onSaveMachine: SaveMachineHandler;
  private readonly onOpenReassign: () => void;
  private readonly onChange: () => void;

  constructor(options: SettingsOptions) {
    this.onGetSettings = options.onGetSettings;
    this.onSavePool = options.onSavePool;
    this.onSaveMachine = options.onSaveMachine;
    this.onOpenReassign = options.onOpenReassign;
    this.onChange = options.onChange;
  }

  get isOpen(): boolean {
    return this.isPaneOpen;
  }

  get isLoading(): boolean {
    return this.inFlight;
  }

  /** The last read's failure, or null. */
  get failure(): string | null {
    return this.readFailure;
  }

  /** The settings last read, or null before the first answer lands. */
  get settings(): SettingsResponse | null {
    return this.data;
  }

  get poolDirty(): boolean {
    return !sameDraft(this.poolDraft, this.poolBaseline);
  }

  get machineDirty(): boolean {
    return !sameDraft(this.machineDraft, this.machineBaseline);
  }

  get poolSaveState(): SaveState {
    return this.poolState;
  }

  get machineSaveState(): SaveState {
    return this.machineState;
  }

  get poolFailure(): string | null {
    return this.poolError;
  }

  get machineFailure(): string | null {
    return this.machineError;
  }

  poolField(name: PoolTextField): string {
    return this.poolDraft[name];
  }

  machineField(name: MachineTextField): string {
    return this.machineDraft[name];
  }

  get poolTerminal(): boolean {
    return this.poolDraft.terminal;
  }

  get machineTerminal(): boolean {
    return this.machineDraft.terminal;
  }

  /**
   * The boot-only keys waiting on a Restart, as the engine reports them.
   * Empty before the first read: with nothing read off disk, there is
   * nothing to badge. Every read and every save re-reads the file and
   * re-derives the list, so the badges follow the file rather than this
   * session's history, and a key edited by hand or by another tab badges
   * here too.
   */
  badges(): Set<BootOnlyKey> {
    if (!this.data) return new Set();
    return projectRestartBadges(this.data.pool.effective.stale);
  }

  /**
   * Open the pane and read the settings. A second open while it is showing
   * is a no-op; closing and reopening reads afresh and discards any answer
   * still in flight from before, so the drafts always match what is on disk.
   */
  async open(): Promise<void> {
    if (this.isPaneOpen) return;
    const token = ++this.token;
    this.isPaneOpen = true;
    this.inFlight = true;
    this.readFailure = null;
    this.poolState = "idle";
    this.poolError = null;
    this.machineState = "idle";
    this.machineError = null;
    this.onChange();
    try {
      const response = await this.onGetSettings();
      if (token !== this.token) return;
      this.apply(response);
    } catch (err) {
      if (token !== this.token) return;
      this.readFailure = err instanceof Error ? err.message : String(err);
    } finally {
      if (token === this.token) {
        this.inFlight = false;
        this.onChange();
      }
    }
  }

  close(): void {
    // Any answer still out belongs to the pane that is closing.
    this.token += 1;
    this.isPaneOpen = false;
    this.inFlight = false;
    this.readFailure = null;
    this.onChange();
  }

  /** The header button: open the pane, or close one already showing. */
  toggle(): void {
    if (this.isPaneOpen) this.close();
    else void this.open();
  }

  setPoolField(name: PoolTextField, value: string): void {
    if (this.poolDraft[name] === value) return;
    this.poolDraft[name] = value;
    // A fresh edit retires the last save's verdict: "saved" belongs to what
    // is on disk, and this draft no longer is.
    if (this.poolState === "saved") this.poolState = "idle";
    this.poolError = null;
  }

  setPoolTerminal(value: boolean): void {
    if (this.poolDraft.terminal === value) return;
    this.poolDraft.terminal = value;
    if (this.poolState === "saved") this.poolState = "idle";
    this.poolError = null;
    this.onChange();
  }

  setMachineField(name: MachineTextField, value: string): void {
    if (this.machineDraft[name] === value) return;
    this.machineDraft[name] = value;
    if (this.machineState === "saved") this.machineState = "idle";
    this.machineError = null;
  }

  setMachineTerminal(value: boolean): void {
    if (this.machineDraft.terminal === value) return;
    this.machineDraft.terminal = value;
    if (this.machineState === "saved") this.machineState = "idle";
    this.machineError = null;
    this.onChange();
  }

  /**
   * Save the pool form. A draft that cannot be sent fails on the spot with
   * its reason inline and nothing leaves the page; a refusal from the engine
   * leaves the draft as it stands with the reason beside Save. The response
   * is the file as it now reads, so the drafts re-seed from disk rather than
   * from what was sent, and the badges recompute against it.
   */
  async savePool(): Promise<void> {
    if (this.poolState === "saving") return;
    const invalid = validatePoolDraft(this.poolDraft);
    if (invalid) {
      this.poolError = invalid;
      this.poolState = "idle";
      this.onChange();
      return;
    }
    this.poolState = "saving";
    this.poolError = null;
    this.onChange();
    try {
      const response = await this.onSavePool(poolPatchFrom(this.poolDraft));
      this.apply(response);
      this.poolState = "saved";
    } catch (err) {
      this.poolState = "idle";
      this.poolError = err instanceof Error ? err.message : String(err);
    }
    this.onChange();
  }

  /** Save the machine defaults form. Same refusal and re-seed as the pool's. */
  async saveMachine(): Promise<void> {
    if (this.machineState === "saving") return;
    this.machineState = "saving";
    this.machineError = null;
    this.onChange();
    try {
      const response = await this.onSaveMachine(
        machineDefaultsFrom(this.machineDraft),
      );
      this.apply(response);
      this.machineState = "saved";
    } catch (err) {
      this.machineState = "idle";
      this.machineError = err instanceof Error ? err.message : String(err);
    }
    this.onChange();
  }

  /** Hold a read or a save's answer and re-seed both drafts from it. */
  private apply(response: SettingsResponse): void {
    this.data = response;
    this.poolDraft = poolDraftFrom(response.pool.config);
    this.poolBaseline = { ...this.poolDraft };
    this.machineDraft = machineDraftFrom(response.machine.own);
    this.machineBaseline = { ...this.machineDraft };
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /** The pane, or null while it is closed. */
  render(restart: RestartView, handlers: RestartHandlers): HTMLElement | null {
    if (!this.isPaneOpen) return null;
    const body = this.inFlight
      ? h("div", { class: "settings-empty" }, "reading settings…")
      : this.readFailure
        ? h("div", { class: "error-inline settings-failure" }, this.readFailure)
        : this.data
          ? h(
              "div",
              { class: "settings-body", key: "settings-body" },
              this.renderPoolForm(this.data),
              this.renderReassignSection(),
              this.renderMachineForm(this.data),
            )
          : h("div", { class: "settings-empty" }, "no settings");
    return h(
      "div",
      { class: "settings-pane", key: "settings-pane" },
      h(
        "div",
        { class: "settings-head" },
        h("span", { class: "settings-title" }, "settings"),
        h(
          "button",
          { class: "btn settings-close", type: "button", onclick: () => this.close() },
          "close",
        ),
      ),
      body,
      h(
        "div",
        { class: "settings-foot" },
        this.renderRestartControl(restart, handlers),
      ),
    );
  }

  private renderPoolForm(data: SettingsResponse): HTMLElement {
    const badges = this.badges();
    const text = (
      name: PoolTextField,
      label: string,
      options: { badge?: BootOnlyKey; area?: boolean; placeholder?: string; hint?: string } = {},
    ): HTMLElement =>
      this.renderField(
        `pool-${name}`,
        label,
        options.area
          ? h("textarea", {
              class: "settings-input settings-area",
              key: `pool-${name}-input`,
              value: this.poolDraft[name],
              placeholder: options.placeholder ?? null,
              oninput: (event: Event) =>
                this.setPoolField(
                  name,
                  (event.currentTarget as HTMLTextAreaElement).value,
                ),
            })
          : h("input", {
              class: "settings-input",
              key: `pool-${name}-input`,
              type: "text",
              value: this.poolDraft[name],
              placeholder: options.placeholder ?? null,
              oninput: (event: Event) =>
                this.setPoolField(name, (event.currentTarget as HTMLInputElement).value),
            }),
        options.badge ? badges.has(options.badge) : false,
        options.hint,
      );

    return h(
      "section",
      { class: "settings-section", key: "settings-pool" },
      h(
        "div",
        { class: "settings-section-head" },
        h("span", { class: "settings-section-title" }, "pool settings"),
        h("span", { class: "settings-path dim" }, data.pool.path),
      ),
      this.renderField(
        "pool-harness",
        "harness",
        this.renderHarnessSelect(
          "pool-harness-input",
          data.harnesses,
          this.poolDraft.harness,
          "(none)",
          null,
          (value) => {
            this.setPoolField("harness", value);
            this.onChange();
          },
        ),
        false,
      ),
      text("model", "model"),
      text("drivers", "drivers"),
      this.renderField(
        "pool-resolver",
        "resolver",
        h(
          "div",
          { class: "settings-pair" },
          this.renderHarnessSelect(
            "pool-resolver-input",
            data.harnesses,
            this.poolDraft.resolverHarness,
            "(unset)",
            RESOLVER_NONE,
            (value) => {
              this.setPoolField("resolverHarness", value);
              this.onChange();
            },
          ),
          h("input", {
            class: "settings-input settings-pair-model",
            key: "pool-resolver-model",
            type: "text",
            value: this.poolDraft.resolverModel,
            placeholder: "model (optional)",
            oninput: (event: Event) =>
              this.setPoolField(
                "resolverModel",
                (event.currentTarget as HTMLInputElement).value,
              ),
          }),
        ),
        false,
        'a harness resolves each Ticket\'s Assignment; "none" opts out',
      ),
      this.renderField(
        "pool-selection",
        "selection",
        this.renderSelect(
          "pool-selection-input",
          [
            { value: "", label: "(unset)" },
            { value: "auto", label: "auto" },
            { value: "human", label: "human" },
          ],
          this.poolDraft.selection,
          (value) => {
            this.setPoolField("selection", value);
            this.onChange();
          },
        ),
        badges.has("selection"),
      ),
      this.renderField(
        "pool-terminal",
        "terminal",
        h(
          "label",
          { class: "settings-check" },
          h("input", {
            type: "checkbox",
            key: "pool-terminal-input",
            checked: this.poolDraft.terminal,
            onchange: (event: Event) =>
              this.setPoolTerminal((event.currentTarget as HTMLInputElement).checked),
          }),
          h("span", {}, "Terminal-backed (herdr)"),
        ),
        badges.has("terminal"),
      ),
      this.renderField(
        "pool-port",
        "port",
        h("input", {
          class: "settings-input settings-port",
          key: "pool-port-input",
          type: "number",
          min: "1",
          max: "65535",
          value: this.poolDraft.port,
          placeholder: `auto (now ${data.pool.effective.port})`,
          oninput: (event: Event) =>
            this.setPoolField("port", (event.currentTarget as HTMLInputElement).value),
        }),
        badges.has("port"),
      ),
      text("roster", "roster", { badge: "roster", area: true }),
      text("agents", "agents", {
        badge: "agents",
        area: true,
        hint: "JSON",
      }),
      text("reviewer", "reviewer", { area: true }),
      text("checkpoint", "checkpoint", { area: true }),
      this.renderSaveRow(
        "pool",
        this.poolDirty,
        this.poolState,
        this.poolError,
        () => void this.savePool(),
      ),
    );
  }

  /**
   * Reassign (CONTEXT.md: Reassign; issue #126), beside the pool defaults
   * because it is the other half of the same question: the defaults move
   * every ticket that follows them, and reassigning a ticket is how it stops
   * following them. The section says only that, and opens the dialog that
   * does the work.
   */
  private renderReassignSection(): HTMLElement {
    return h(
      "section",
      { class: "settings-section", key: "settings-reassign" },
      h(
        "div",
        { class: "settings-section-head" },
        h("span", { class: "settings-section-title" }, "reassign tickets"),
      ),
      h(
        "div",
        { class: "settings-note dim" },
        "pinning tickets stops them following the pool defaults for the fields you set; edit the defaults instead to move every unpinned ticket",
      ),
      h(
        "div",
        { class: "settings-save-row", key: "settings-reassign-row" },
        h(
          "button",
          {
            class: "btn settings-reassign-open",
            type: "button",
            onclick: () => this.onOpenReassign(),
          },
          "Reassign tickets…",
        ),
      ),
    );
  }

  private renderMachineForm(data: SettingsResponse): HTMLElement {
    const merged = data.machine.defaults;
    const text = (
      name: MachineTextField,
      label: string,
      placeholder: string | undefined,
    ): HTMLElement =>
      this.renderField(
        `machine-${name}`,
        label,
        h("input", {
          class: "settings-input",
          key: `machine-${name}-input`,
          type: "text",
          value: this.machineDraft[name],
          placeholder: placeholder ?? null,
          oninput: (event: Event) =>
            this.setMachineField(name, (event.currentTarget as HTMLInputElement).value),
        }),
        false,
      );

    return h(
      "section",
      { class: "settings-section", key: "settings-machine" },
      h(
        "div",
        { class: "settings-section-head" },
        h("span", { class: "settings-section-title" }, "machine defaults"),
        h("span", { class: "settings-path dim" }, data.machine.path),
      ),
      h(
        "div",
        { class: "settings-note dim" },
        "what a new pool inherits when nothing more specific says otherwise; placeholders show the merged value in force",
      ),
      this.renderField(
        "machine-harness",
        "harness",
        this.renderHarnessSelect(
          "machine-harness-input",
          data.harnesses,
          this.machineDraft.harness,
          merged.harness ? `(${merged.harness})` : "(none)",
          null,
          (value) => {
            this.setMachineField("harness", value);
            this.onChange();
          },
        ),
        false,
      ),
      text("model", "model", merged.model),
      text("drivers", "drivers", merged.drivers),
      this.renderField(
        "machine-terminal",
        "terminal",
        h(
          "label",
          { class: "settings-check" },
          h("input", {
            type: "checkbox",
            key: "machine-terminal-input",
            checked: this.machineDraft.terminal,
            onchange: (event: Event) =>
              this.setMachineTerminal(
                (event.currentTarget as HTMLInputElement).checked,
              ),
          }),
          h("span", {}, "Terminal-backed (herdr)"),
        ),
        false,
      ),
      text("engine", "engine", merged.engine),
      this.renderSaveRow(
        "machine",
        this.machineDirty,
        this.machineState,
        this.machineError,
        () => void this.saveMachine(),
      ),
    );
  }

  private renderField(
    key: string,
    label: string,
    control: HTMLElement,
    badge: boolean,
    hint?: string,
  ): HTMLElement {
    return h(
      "label",
      { class: "settings-field", key },
      h(
        "span",
        { class: "settings-field-label" },
        h("span", {}, label),
        badge
          ? h(
              "span",
              {
                class: "settings-badge",
                title: "this key is read at boot; the running server still has the old one",
              },
              "restart to apply",
            )
          : null,
        hint ? h("span", { class: "settings-hint dim" }, hint) : null,
      ),
      control,
    );
  }

  /**
   * A select over the harnesses the engine knows, plus a blank option and,
   * for the resolver, "none". The key carries the option list because the
   * morph applies a select's `value` before its children: a select whose
   * options arrived in the same render would take its value against the old,
   * empty list. A changed option list is a different key, so the node is
   * built afresh with its value already in place. The list changes once, when
   * the read lands, so nothing in focus is ever disturbed by it.
   */
  private renderHarnessSelect(
    key: string,
    harnesses: string[],
    value: string,
    blankLabel: string,
    extra: string | null,
    onPick: (value: string) => void,
  ): HTMLElement {
    const options = [
      { value: "", label: blankLabel },
      ...harnesses.map((name) => ({ value: name, label: name })),
      ...(extra ? [{ value: extra, label: extra }] : []),
    ];
    return this.renderSelect(`${key}:${harnesses.join("|")}`, options, value, onPick);
  }

  private renderSelect(
    key: string,
    options: { value: string; label: string }[],
    value: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    // A value the options do not carry (a harness the engine no longer knows)
    // would silently become the first option, so it joins the list as itself.
    const known = options.some((option) => option.value === value);
    const all = known ? options : [...options, { value, label: value }];
    const select = h(
      "select",
      {
        class: "settings-input settings-select",
        key,
        value,
        onchange: (event: Event) =>
          onPick((event.currentTarget as HTMLSelectElement).value),
      },
      ...all.map((option) =>
        h("option", { value: option.value, key: option.value }, option.label),
      ),
    );
    // `h` writes its props before it appends children, and a select cannot
    // hold a value its options do not carry yet, so the value is reasserted
    // once they are in place. The prop stays recorded either way, so a morph
    // re-applies it against options that are already on the page.
    select.value = value;
    return select;
  }

  private renderSaveRow(
    which: "pool" | "machine",
    dirty: boolean,
    state: SaveState,
    failure: string | null,
    onSave: () => void,
  ): HTMLElement {
    return h(
      "div",
      { class: "settings-save-row", key: `settings-save-${which}` },
      h(
        "button",
        {
          class: "btn btn-primary settings-save",
          type: "button",
          disabled: state === "saving" || !dirty,
          onclick: onSave,
        },
        state === "saving" ? "saving…" : "Save",
      ),
      state === "saved" && !dirty
        ? h("span", { class: "settings-saved dim" }, "saved")
        : null,
      failure ? h("span", { class: "error-inline settings-failure" }, failure) : null,
    );
  }

  /**
   * The Restart control (ADR-0026), the Stop control's three states exactly,
   * but offered in any phase while the stream is live: a restart is how a
   * boot-only key takes effect, and waiting for the pool to finish first
   * would be the one thing the operator cannot do anything about. Cancel
   * sends nothing, and a refusal shows beside the button, never on the
   * global banner.
   */
  private renderRestartControl(
    restart: RestartView,
    handlers: RestartHandlers,
  ): HTMLElement {
    if (!restart.offered) {
      return h(
        "span",
        { class: "settings-restart-off dim" },
        "restart needs a live connection",
      );
    }
    if (restart.state === "requesting") {
      return h(
        "div",
        { class: "settings-restart" },
        h(
          "button",
          { class: "btn btn-danger", type: "button", disabled: true },
          "restarting...",
        ),
      );
    }
    if (restart.state === "armed") {
      return h(
        "div",
        { class: "settings-restart settings-restart-armed" },
        h("span", { class: "settings-restart-prompt" }, "Really restart?"),
        h(
          "button",
          {
            class: "btn btn-danger",
            type: "button",
            title: "stop this pool's server and let Boot relaunch it",
            onclick: () => handlers.onConfirmRestart(),
          },
          "Restart",
        ),
        h(
          "button",
          { class: "btn", type: "button", onclick: () => handlers.onCancelRestart() },
          "Cancel",
        ),
      );
    }
    return h(
      "div",
      { class: "settings-restart" },
      h(
        "button",
        {
          class: "btn btn-danger settings-restart-server",
          type: "button",
          title: "stop this pool's server and let Boot relaunch it",
          onclick: () => handlers.onArmRestart(),
        },
        "Restart server",
      ),
      restart.failure
        ? h("span", { class: "error-inline settings-restart-failure" }, restart.failure)
        : null,
    );
  }
}
