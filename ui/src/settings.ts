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
 * refused machine write never loses a pool edit. The assignment slice, the
 * Spawn caps, the Steward entry and the Factory settings take effect through
 * the engine's Config reload at the next Tick; the boot-only keys carry a "restart to apply" badge
 * until the Restart in the footer hands off to Boot.
 */

import { h } from "./dom";
import { effortInput } from "./effort";
import {
  FACTORY_DEFAULTS,
  FACTORY_STATIONS,
  factoryDraftFrom,
  factoryFrom,
  factoryUnder,
  sameFactoryDraft,
  validateFactoryDraft,
  type FactoryDraft,
  type FactoryField,
  type FactoryStation,
} from "./factory-settings";
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
  /** The Pool title (issue #100): empty means none, and the directory names the pool. */
  title: string;
  harness: string;
  model: string;
  effort: string;
  drivers: string;
  /** The resolver's harness, or "none" to opt out of resolution entirely. */
  resolverHarness: string;
  resolverModel: string;
  resolverEffort: string;
  selection: string;
  terminal: boolean;
  /** Empty means auto: the server picks a free port at boot. */
  port: string;
  reviewer: string;
  checkpoint: string;
  /** The Spawn caps (issue #149): empty means the engine's default. */
  spawnsPerAttempt: string;
  spawnsPerRun: string;
  /** The Steward budget (ADR-0030): empty means the engine's 5. */
  stewardBudget: string;
  /** The Steward's Assignment: each empty field falls to the pool defaults. */
  stewardHarness: string;
  stewardModel: string;
  stewardEffort: string;
  stewardDrivers: string;
  /** "Steward may Close checkpoints" (issue #154): off unless the file says so. */
  stewardMayClose: boolean;
  /** "Steward may adopt Line spawns" (ADR-0037): off unless the file says so. */
  stewardMayAdoptLineSpawns: boolean;
}

export interface MachineDraft {
  harness: string;
  model: string;
  effort: string;
  drivers: string;
  terminal: boolean;
  engine: string;
}

export type PoolTextField = Exclude<
  keyof PoolDraft,
  "terminal" | "stewardMayClose" | "stewardMayAdoptLineSpawns"
>;
export type MachineTextField = Exclude<keyof MachineDraft, "terminal">;

/** The "opt out of resolution" value, which the file holds as a plain string. */
const RESOLVER_NONE = "none";

const EMPTY_POOL_DRAFT: PoolDraft = {
  title: "",
  harness: "",
  model: "",
  effort: "",
  drivers: "",
  resolverHarness: "",
  resolverModel: "",
  resolverEffort: "",
  selection: "",
  terminal: false,
  port: "",
  reviewer: "",
  checkpoint: "",
  spawnsPerAttempt: "",
  spawnsPerRun: "",
  stewardBudget: "",
  stewardHarness: "",
  stewardModel: "",
  stewardEffort: "",
  stewardDrivers: "",
  stewardMayClose: false,
  stewardMayAdoptLineSpawns: false,
};

/** The engine's Steward budget when the file sets none (crates/core/src/steward.rs),
 *  shown as the field's placeholder. */
const DEFAULT_STEWARD_BUDGET = 5;

/** The engine's Spawn caps when the file sets none (crates/core/src/spawn_caps.rs),
 *  shown as the fields' placeholders. */
const DEFAULT_SPAWN_CAPS = { perAttempt: 5, perRun: 20 };

const EMPTY_MACHINE_DRAFT: MachineDraft = {
  harness: "",
  model: "",
  effort: "",
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
  let resolverEffort = "";
  if (typeof resolver === "string") {
    resolverHarness = resolver;
  } else if (resolver && typeof resolver === "object") {
    resolverHarness = resolver.harness ?? "";
    resolverModel = resolver.model ?? "";
    resolverEffort = resolver.effort ?? "";
  }
  return {
    title: config.title ?? "",
    harness: defaults.harness ?? "",
    model: defaults.model ?? "",
    effort: defaults.effort ?? "",
    drivers: defaults.drivers ?? "",
    resolverHarness,
    resolverModel,
    resolverEffort,
    selection: config.selection ?? "",
    terminal: config.terminal === "herdr",
    port: typeof config.port === "number" ? String(config.port) : "",
    reviewer: config.reviewer ?? "",
    checkpoint: config.checkpoint ?? "",
    spawnsPerAttempt: capField(config.spawnCaps?.perAttempt),
    spawnsPerRun: capField(config.spawnCaps?.perRun),
    stewardBudget: capField(config.steward?.budget),
    stewardHarness: config.steward?.assign?.harness ?? "",
    stewardModel: config.steward?.assign?.model ?? "",
    stewardEffort: config.steward?.assign?.effort ?? "",
    stewardDrivers: config.steward?.assign?.drivers ?? "",
    stewardMayClose: config.steward?.mayClose === true,
    stewardMayAdoptLineSpawns: config.steward?.mayAdoptLineSpawns === true,
  };
}

function capField(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "";
}

/** The machine draft the defaults file seeds; the merged view is placeholders. */
export function machineDraftFrom(own: MachineDefaults): MachineDraft {
  return {
    harness: own.harness ?? "",
    model: own.model ?? "",
    effort: own.effort ?? "",
    drivers: own.drivers ?? "",
    terminal: own.terminal === "herdr",
    engine: own.engine ?? "",
  };
}

/**
 * What is wrong with a draft, or null when it is sendable. Only the fields
 * with a shape the operator can get wrong are checked here: a port that is
 * not a port, a Spawn cap that is not a whole number of 0 or more, and a
 * Steward budget that is not a whole number of 1 or more. Everything else is
 * free text the engine validates on its own terms.
 */
export function validatePoolDraft(draft: PoolDraft): string | null {
  const port = draft.port.trim();
  if (port) {
    const parsed = Number(port);
    if (!/^\d+$/.test(port) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return "port must be a whole number between 1 and 65535, or empty for auto";
    }
  }
  for (const [field, label] of [
    ["spawnsPerAttempt", "spawns per attempt"],
    ["spawnsPerRun", "spawns per run"],
  ] as const) {
    const cap = draft[field].trim();
    // A cap of 0 holds every proposal for the operator (issue #150).
    if (cap && !/^\d+$/.test(cap)) {
      return `${label} must be a whole number of 0 or more, or empty for the default`;
    }
  }
  // The engine refuses a budget of 0: a Steward that may never answer is no
  // Steward, and ending it is how the operator takes over.
  const budget = draft.stewardBudget.trim();
  if (budget && (!/^\d+$/.test(budget) || Number(budget) < 1)) {
    return "Steward budget must be a whole number of 1 or more, or empty for the default";
  }
  return null;
}

/**
 * The patch a pool draft sends. An emptied field travels as null (or, inside
 * `defaults`, as an empty string) so the engine removes the key rather than
 * writing a blank one: an absent port means auto, an absent terminal means
 * headless. The resolver collapses to the shape it was given, a bare harness
 * name when there is no resolver model or effort and the object when there is.
 */
export function poolPatchFrom(draft: PoolDraft): PoolConfigPatch {
  const trim = (value: string): string => value.trim();
  const orNull = (value: string): string | null => trim(value) || null;
  const resolverHarness = trim(draft.resolverHarness);
  const resolverModel = trim(draft.resolverModel);
  const resolverEffort = trim(draft.resolverEffort);
  let resolver: PoolConfigPatch["resolver"];
  if (resolverHarness === RESOLVER_NONE) {
    resolver = RESOLVER_NONE;
  } else if (!resolverHarness && !resolverModel && !resolverEffort) {
    resolver = null;
  } else if (!resolverModel && !resolverEffort) {
    resolver = resolverHarness;
  } else {
    resolver = {
      ...(resolverHarness ? { harness: resolverHarness } : {}),
      ...(resolverModel ? { model: resolverModel } : {}),
      ...(resolverEffort ? { effort: resolverEffort } : {}),
    };
  }
  const port = trim(draft.port);
  const selection = trim(draft.selection);
  const cap = (value: string): number | null => (trim(value) ? Number(trim(value)) : null);
  return {
    defaults: {
      harness: trim(draft.harness),
      model: trim(draft.model),
      effort: trim(draft.effort),
      drivers: trim(draft.drivers),
    },
    resolver,
    terminal: draft.terminal ? "herdr" : null,
    port: port ? Number(port) : null,
    selection: selection === "auto" || selection === "human" ? selection : null,
    reviewer: orNull(draft.reviewer),
    checkpoint: orNull(draft.checkpoint),
    title: orNull(draft.title),
    spawnCaps: { perAttempt: cap(draft.spawnsPerAttempt), perRun: cap(draft.spawnsPerRun) },
    steward: {
      budget: cap(draft.stewardBudget),
      assign: {
        harness: trim(draft.stewardHarness),
        model: trim(draft.stewardModel),
        effort: trim(draft.stewardEffort),
        drivers: trim(draft.stewardDrivers),
      },
      // Off is the default, so each travels as an absent key and the file
      // never holds a `mayClose: false` or a `mayAdoptLineSpawns: false`.
      ...(draft.stewardMayClose ? { mayClose: true } : {}),
      ...(draft.stewardMayAdoptLineSpawns ? { mayAdoptLineSpawns: true } : {}),
    },
  };
}

/** The machine defaults a draft sends, every emptied field left out. */
export function machineDefaultsFrom(draft: MachineDraft): MachineDefaults {
  const defaults: MachineDefaults = {};
  const harness = draft.harness.trim();
  const model = draft.model.trim();
  const effort = draft.effort.trim();
  const drivers = draft.drivers.trim();
  const engine = draft.engine.trim();
  if (harness) defaults.harness = harness;
  if (model) defaults.model = model;
  if (effort) defaults.effort = effort;
  if (drivers) defaults.drivers = drivers;
  if (engine) defaults.engine = engine;
  if (draft.terminal) defaults.terminal = "herdr";
  return defaults;
}

/** The pool directory's name, from the path of its console.json. */
function poolDirName(configPath: string): string {
  const parts = configPath.split("/").filter((part) => part !== "");
  return parts.at(-2) ?? "";
}

/**
 * Whether two drafts would write the same file. Text compares trimmed, the
 * way the patch sends it, so a stray space never enables a Save that would
 * change nothing on disk.
 */
function sameDraft<T extends object>(a: T, b: T): boolean {
  const norm = (value: unknown): unknown =>
    typeof value === "string" ? value.trim() : value;
  return (Object.keys(a) as (keyof T)[]).every((key) => norm(a[key]) === norm(b[key]));
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

  // The Factory settings (issue #187): each form's layer, a draft of its own
  // beside the form's, saved with it.
  private poolFactory: FactoryDraft = factoryDraftFrom(undefined);
  private poolFactoryBaseline: FactoryDraft = factoryDraftFrom(undefined);
  private machineFactory: FactoryDraft = factoryDraftFrom(undefined);
  private machineFactoryBaseline: FactoryDraft = factoryDraftFrom(undefined);

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
    return (
      !sameDraft(this.poolDraft, this.poolBaseline) ||
      !sameFactoryDraft(this.poolFactory, this.poolFactoryBaseline)
    );
  }

  get machineDirty(): boolean {
    return (
      !sameDraft(this.machineDraft, this.machineBaseline) ||
      !sameFactoryDraft(this.machineFactory, this.machineFactoryBaseline)
    );
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

  /** One field of a form's Factory settings draft. */
  factoryField(form: "pool" | "machine", field: FactoryField): string {
    return (form === "pool" ? this.poolFactory : this.machineFactory)[field];
  }

  get poolTerminal(): boolean {
    return this.poolDraft.terminal;
  }

  get machineTerminal(): boolean {
    return this.machineDraft.terminal;
  }

  get stewardMayClose(): boolean {
    return this.poolDraft.stewardMayClose;
  }

  get stewardMayAdoptLineSpawns(): boolean {
    return this.poolDraft.stewardMayAdoptLineSpawns;
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
    this.onChange();
  }

  setPoolTerminal(value: boolean): void {
    if (this.poolDraft.terminal === value) return;
    this.poolDraft.terminal = value;
    if (this.poolState === "saved") this.poolState = "idle";
    this.poolError = null;
    this.onChange();
  }

  setStewardMayClose(value: boolean): void {
    if (this.poolDraft.stewardMayClose === value) return;
    this.poolDraft.stewardMayClose = value;
    if (this.poolState === "saved") this.poolState = "idle";
    this.poolError = null;
    this.onChange();
  }

  setStewardMayAdoptLineSpawns(value: boolean): void {
    if (this.poolDraft.stewardMayAdoptLineSpawns === value) return;
    this.poolDraft.stewardMayAdoptLineSpawns = value;
    if (this.poolState === "saved") this.poolState = "idle";
    this.poolError = null;
    this.onChange();
  }

  setFactoryField(form: "pool" | "machine", field: FactoryField, value: string): void {
    const draft = form === "pool" ? this.poolFactory : this.machineFactory;
    if (draft[field] === value) return;
    draft[field] = value;
    if (form === "pool") {
      if (this.poolState === "saved") this.poolState = "idle";
      this.poolError = null;
    } else {
      if (this.machineState === "saved") this.machineState = "idle";
      this.machineError = null;
    }
    this.onChange();
  }

  setMachineField(name: MachineTextField, value: string): void {
    if (this.machineDraft[name] === value) return;
    this.machineDraft[name] = value;
    if (this.machineState === "saved") this.machineState = "idle";
    this.machineError = null;
    this.onChange();
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
    const invalid =
      validatePoolDraft(this.poolDraft) ?? validateFactoryDraft(this.poolFactory);
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
      const response = await this.onSavePool({
        ...poolPatchFrom(this.poolDraft),
        factory: factoryFrom(this.poolFactory),
      });
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
    const invalid = validateFactoryDraft(this.machineFactory);
    if (invalid) {
      this.machineError = invalid;
      this.machineState = "idle";
      this.onChange();
      return;
    }
    this.machineState = "saving";
    this.machineError = null;
    this.onChange();
    try {
      const factory = factoryFrom(this.machineFactory);
      const response = await this.onSaveMachine({
        ...machineDefaultsFrom(this.machineDraft),
        ...(factory ? { factory } : {}),
      });
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
    this.poolFactory = factoryDraftFrom(response.pool.config.factory);
    this.poolFactoryBaseline = { ...this.poolFactory };
    this.machineFactory = factoryDraftFrom(response.machine.own.factory);
    this.machineFactoryBaseline = { ...this.machineFactory };
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
      // First, because it is the one setting about which pool this is. It
      // takes effect on save, with no badge: the header, the tab and a Pool
      // workspace the Console made all follow it at once (issue #100).
      text("title", "title", {
        placeholder: poolDirName(data.pool.path),
        hint: "display only",
      }),
      this.renderField(
        "pool-harness",
        "harness",
        this.renderHarnessSelect(
          "pool-harness-input",
          data.harnesses,
          this.poolDraft.harness,
          "(none)",
          null,
          (value) => this.setPoolField("harness", value),
        ),
        false,
      ),
      text("model", "model"),
      this.renderField(
        "pool-effort",
        "effort",
        effortInput({
          key: "pool-effort-input",
          harness: this.poolDraft.harness,
          value: this.poolDraft.effort,
          placeholder: "(harness default)",
          onInput: (value) => this.setPoolField("effort", value),
        }),
        false,
      ),
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
            (value) => this.setPoolField("resolverHarness", value),
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
          effortInput({
            key: "pool-resolver-effort",
            class: "settings-input settings-pair-effort",
            // The resolver's own harness names the words, else the one it
            // falls back to.
            harness: this.poolDraft.resolverHarness || this.poolDraft.harness,
            value: this.poolDraft.resolverEffort,
            placeholder: "effort (optional)",
            onInput: (value) => this.setPoolField("resolverEffort", value),
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
          (value) => this.setPoolField("selection", value),
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
      // The Spawn caps (issue #149, ADR-0029) reload at the next Tick,
      // or at once on an idle pool, so they carry no badge.
      this.renderCapField("spawnsPerAttempt", "spawns per attempt", DEFAULT_SPAWN_CAPS.perAttempt),
      this.renderCapField(
        "spawnsPerRun",
        "spawns per run",
        DEFAULT_SPAWN_CAPS.perRun,
        "counted since this Console boot; 0 holds every proposal for you",
      ),
      ...this.renderStewardFields(data),
      text("reviewer", "reviewer", { area: true }),
      text("checkpoint", "checkpoint", { area: true }),
      ...this.renderFactoryFields("pool", data),
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
          (value) => this.setMachineField("harness", value),
        ),
        false,
      ),
      text("model", "model", merged.model),
      this.renderField(
        "machine-effort",
        "effort",
        effortInput({
          key: "machine-effort-input",
          harness: this.machineDraft.harness || merged.harness,
          value: this.machineDraft.effort,
          placeholder: merged.effort ?? "(harness default)",
          onInput: (value) => this.setMachineField("effort", value),
        }),
        false,
      ),
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
      ...this.renderFactoryFields("machine", data),
      this.renderSaveRow(
        "machine",
        this.machineDirty,
        this.machineState,
        this.machineError,
        () => void this.saveMachine(),
      ),
    );
  }

  /**
   * The Steward entry (ADR-0030): its budget, its Assignment, and whether it
   * may Close (issue #154). All reload at the next Tick, like the Spawn
   * caps, so none carries a badge.
   * The Assignment's empty fields show the pool defaults they fall to, the
   * Steward resolving its own entry ahead of them the way the resolver does.
   */
  private renderStewardFields(data: SettingsResponse): HTMLElement[] {
    const text = (
      name: "stewardModel" | "stewardDrivers",
      placeholder: string,
    ): HTMLElement =>
      h("input", {
        class: "settings-input settings-pair-model",
        key: `pool-${name}`,
        type: "text",
        value: this.poolDraft[name],
        placeholder,
        oninput: (event: Event) =>
          this.setPoolField(name, (event.currentTarget as HTMLInputElement).value),
      });
    return [
      this.renderField(
        "pool-stewardBudget",
        "steward budget",
        h("input", {
          class: "settings-input settings-number",
          key: "pool-stewardBudget-input",
          type: "number",
          min: "1",
          value: this.poolDraft.stewardBudget,
          placeholder: `${DEFAULT_STEWARD_BUDGET} (default)`,
          oninput: (event: Event) =>
            this.setPoolField("stewardBudget", (event.currentTarget as HTMLInputElement).value),
        }),
        false,
        "answers the Steward may give one Ticket since you last answered it",
      ),
      this.renderField(
        "pool-steward",
        "steward",
        h(
          "div",
          { class: "settings-pair settings-steward" },
          this.renderHarnessSelect(
            "pool-steward-harness",
            data.harnesses,
            this.poolDraft.stewardHarness,
            "(pool default)",
            null,
            (value) => this.setPoolField("stewardHarness", value),
          ),
          text("stewardModel", "model (pool default)"),
          effortInput({
            key: "pool-steward-effort",
            class: "settings-input settings-pair-effort",
            harness: this.poolDraft.stewardHarness || this.poolDraft.harness,
            value: this.poolDraft.stewardEffort,
            placeholder: "effort (pool default)",
            onInput: (value) => this.setPoolField("stewardEffort", value),
          }),
          text("stewardDrivers", "drivers (pool default)"),
        ),
        false,
        "the Steward's Assignment; empty fields use the pool defaults",
      ),
      this.renderField(
        "pool-stewardMayClose",
        "steward close",
        h(
          "label",
          { class: "settings-check" },
          h("input", {
            type: "checkbox",
            key: "pool-stewardMayClose-input",
            checked: this.poolDraft.stewardMayClose,
            onchange: (event: Event) =>
              this.setStewardMayClose((event.currentTarget as HTMLInputElement).checked),
          }),
          h("span", {}, "Steward may Close checkpoints"),
        ),
        false,
        "on, the Steward may close a checkpoint or merge conflict without merging; off, only you can",
      ),
      this.renderField(
        "pool-stewardMayAdoptLineSpawns",
        "steward line spawns",
        h(
          "label",
          { class: "settings-check" },
          h("input", {
            type: "checkbox",
            key: "pool-stewardMayAdoptLineSpawns-input",
            checked: this.poolDraft.stewardMayAdoptLineSpawns,
            onchange: (event: Event) =>
              this.setStewardMayAdoptLineSpawns((event.currentTarget as HTMLInputElement).checked),
          }),
          h("span", {}, "Steward may adopt Line spawns"),
        ),
        false,
        "on, the Steward may adopt or discard a Held spawn proposed from inside the Line; off, only you can",
      ),
    ];
  }

  /**
   * The Factory settings (issue #187, ADR-0037) of one form's layer: each
   * Station's drivers, Assignment and note, whether Prove and Review run, the
   * Line's two limits and the default Finish. Every empty field inherits, and
   * its placeholder shows what it inherits: the pool's the machine's layer
   * over the built-in settings, the machine's the built-in settings. They
   * reload at the next Tick and reach the next Station Ticket written, so
   * none carries a badge.
   */
  private renderFactoryFields(form: "pool" | "machine", data: SettingsResponse): HTMLElement[] {
    const draft = form === "pool" ? this.poolFactory : this.machineFactory;
    const under =
      form === "pool"
        ? factoryUnder(factoryDraftFrom(data.machine.defaults.factory), FACTORY_DEFAULTS)
        : FACTORY_DEFAULTS;
    const key = (field: string): string => `${form}-factory-${field}`;
    const set = (field: FactoryField) => (value: string) =>
      this.setFactoryField(form, field, value);
    const input = (
      field: FactoryField,
      cls: string,
      placeholder: string,
      inputKey: string = key(field),
    ): HTMLElement =>
      h("input", {
        class: `settings-input ${cls}`,
        key: inputKey,
        type: "text",
        value: draft[field],
        placeholder,
        oninput: (event: Event) => set(field)((event.currentTarget as HTMLInputElement).value),
      });
    const number = (field: "proveFailsPerRound" | "extraRounds", label: string, hint: string) =>
      this.renderField(
        key(field),
        label,
        h("input", {
          class: "settings-input settings-number",
          key: key(`${field}-input`),
          type: "number",
          min: "0",
          value: draft[field],
          placeholder: `${under[field]} (${form === "pool" ? "inherited" : "default"})`,
          oninput: (event: Event) => set(field)((event.currentTarget as HTMLInputElement).value),
        }),
        false,
        hint,
      );
    const station = (name: FactoryStation): HTMLElement[] => {
      const enabled =
        name === "prove" || name === "review"
          ? this.renderSelect(
              key(`${name}.enabled`),
              [
                { value: "", label: `(${under[`${name}.enabled`]})` },
                { value: "on", label: "on" },
                { value: "off", label: "off" },
              ],
              draft[`${name}.enabled`],
              set(`${name}.enabled`),
            )
          : null;
      return [
        this.renderField(
          key(name),
          `factory ${name}`,
          h(
            "div",
            { class: "settings-pair settings-factory-station" },
            enabled,
            input(`${name}.drivers`, "settings-pair-model", `drivers (${under[`${name}.drivers`]})`),
            this.renderHarnessSelect(
              key(`${name}.harness`),
              data.harnesses,
              draft[`${name}.harness`],
              `(${under[`${name}.harness`]})`,
              null,
              set(`${name}.harness`),
            ),
            input(`${name}.model`, "settings-pair-model", `model (${under[`${name}.model`]})`),
            effortInput({
              key: key(`${name}.effort`),
              class: "settings-input settings-pair-effort",
              harness: draft[`${name}.harness`] || under[`${name}.harness`],
              value: draft[`${name}.effort`],
              placeholder: `effort (${under[`${name}.effort`]})`,
              onInput: set(`${name}.effort`),
            }),
          ),
          false,
          name === "prove" || name === "review"
            ? "on or off, drivers and Assignment; off skips the Station"
            : "drivers and Assignment",
        ),
        this.renderField(
          key(`${name}-note`),
          `${name} note`,
          h("textarea", {
            class: "settings-input settings-area",
            key: key(`${name}.note`),
            value: draft[`${name}.note`],
            placeholder: under[`${name}.note`] || "(none)",
            oninput: (event: Event) =>
              set(`${name}.note`)((event.currentTarget as HTMLTextAreaElement).value),
          }),
          false,
          "an extra instruction written into every Ticket of the Station",
        ),
      ];
    };
    return [
      h(
        "div",
        { class: "settings-note dim", key: key("head") },
        form === "pool"
          ? "factory: this pool's layer over the machine's; empty fields inherit, and a Line brief may override any of them. Changes reach the next Station Ticket written"
          : "factory: every pool's Factory settings unless the pool or a Line brief says otherwise",
      ),
      ...FACTORY_STATIONS.flatMap(station),
      number("proveFailsPerRound", "prove fails per round", "Prove failures before the Line checkpoints"),
      number("extraRounds", "extra rounds", "Rounds Decide may start after the first"),
      this.renderField(
        key("finish"),
        "finish",
        input("finish", "", under.finish, key("finish-input")),
        false,
        "none, draft-pr, pr, or an act Decide carries out",
      ),
    ];
  }

  private renderCapField(
    name: "spawnsPerAttempt" | "spawnsPerRun",
    label: string,
    fallback: number,
    hint?: string,
  ): HTMLElement {
    return this.renderField(
      `pool-${name}`,
      label,
      h("input", {
        class: "settings-input settings-number",
        key: `pool-${name}-input`,
        type: "number",
        min: "0",
        value: this.poolDraft[name],
        placeholder: `${fallback} (default)`,
        oninput: (event: Event) =>
          this.setPoolField(name, (event.currentTarget as HTMLInputElement).value),
      }),
      false,
      hint,
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
