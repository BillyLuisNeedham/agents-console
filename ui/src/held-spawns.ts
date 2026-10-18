/**
 * The Spawns list (CONTEXT.md: Held spawn; issues #149 and #150, ADR-0029,
 * ADR-0042): what the canvas header's Spawn caps line opens. It lists the
 * Held spawns, each waiting for the operator's Adopt or Discard. One module
 * owns the whole session state: whether the list is open, which bodies are
 * expanded, which Discard is asking to be confirmed, the request in flight
 * per spawn and its refusal, so a refused decision says why beside that
 * spawn's buttons rather than on the global banner.
 *
 * The spawns themselves are read from the snapshot, never cached here: an
 * Adopt shows as the engine's `adopting` until the next Tick writes the
 * ticket and the row goes, and a Discard shows with the snapshot the engine
 * pushes once it is done. Discard is final, so it asks first, inline, the
 * way the header's Stop does (issue #97). The Detail of a held spawn's faded
 * card offers the same decisions through `renderDecision`, so the list and
 * the Detail can never disagree about a spawn in flight.
 */

import { h } from "./dom";
import { REFUSED_AT_LANDING } from "./project";
import type {
  HeldSpawnResponse,
  HeldSpawnRow,
  SpawnLineView,
} from "./project";

export type HeldSpawnHandler = (id: string) => Promise<HeldSpawnResponse>;

export interface HeldSpawnsOptions {
  onAdopt: HeldSpawnHandler;
  onDiscard: HeldSpawnHandler;
  /** Store state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

type Decision = "adopt" | "discard";

export class HeldSpawnsStore {
  private isListOpen = false;
  private readonly inFlight = new Map<string, Decision>();
  private readonly armed = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly expanded = new Set<string>();

  private readonly options: HeldSpawnsOptions;

  constructor(options: HeldSpawnsOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.isListOpen;
  }

  open(): void {
    if (this.isListOpen) return;
    this.isListOpen = true;
    this.options.onChange();
  }

  close(): void {
    this.isListOpen = false;
    this.armed.clear();
    this.options.onChange();
  }

  /** The header line: open the list, or close one already showing. */
  toggle(): void {
    if (this.isListOpen) this.close();
    else this.open();
  }

  toggleBody(id: string): void {
    if (!this.expanded.delete(id)) this.expanded.add(id);
    this.options.onChange();
  }

  /** Drop the state of every spawn no longer held (adopted or discarded). */
  prune(live: Set<string>): void {
    for (const set of [this.armed, this.expanded]) {
      for (const id of set) if (!live.has(id)) set.delete(id);
    }
    for (const map of [this.inFlight, this.failures]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
  }

  async adopt(id: string): Promise<void> {
    await this.decide(id, "adopt");
  }

  /** Raise the inline "Discard for good?" confirmation; nothing is sent. */
  armDiscard(id: string): void {
    if (this.inFlight.has(id)) return;
    this.armed.add(id);
    this.failures.delete(id);
    this.options.onChange();
  }

  cancelDiscard(id: string): void {
    this.armed.delete(id);
    this.options.onChange();
  }

  async confirmDiscard(id: string): Promise<void> {
    await this.decide(id, "discard");
  }

  private async decide(id: string, decision: Decision): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.set(id, decision);
    this.failures.delete(id);
    this.options.onChange();
    const send = decision === "adopt" ? this.options.onAdopt : this.options.onDiscard;
    try {
      await send(id);
    } catch (err) {
      this.failures.set(id, err instanceof Error ? err.message : String(err));
    }
    this.inFlight.delete(id);
    this.armed.delete(id);
    this.options.onChange();
  }

  // -------------------------------------------------------------------------
  // Render: an absolute pane over the canvas column, beside Settings
  // -------------------------------------------------------------------------

  /** The list, or null while it is closed. */
  render(held: HeldSpawnRow[], line: SpawnLineView): HTMLElement | null {
    if (!this.isListOpen) return null;
    return h(
      "div",
      { class: "held-spawns-pane", key: "held-spawns-pane" },
      h(
        "div",
        { class: "held-spawns-head" },
        h("span", { class: "held-spawns-title" }, "spawns"),
        h(
          "span",
          { class: "held-spawns-line" + (line.warn ? " spawn-line-warn" : "") },
          line.text,
        ),
        h(
          "button",
          { class: "btn held-spawns-close", type: "button", onclick: () => this.close() },
          "close",
        ),
      ),
      h(
        "div",
        { class: "held-spawns-scroll", key: "held-spawns-scroll" },
        h(
          "div",
          { class: "held-spawns-section-head", key: "held-head" },
          `held · ${held.length}`,
        ),
        h(
          "div",
          { class: "held-spawns-note dim", key: "held-note" },
          "proposals a cap had no room for, that overlap work already in the pool, or that you held. Adopt lands one past both caps; Discard drops it for good. Raise the caps in Settings.",
        ),
        held.length === 0
          ? h("div", { class: "held-spawns-empty", key: "held-empty" }, "no held spawns")
          : h(
              "div",
              { class: "held-spawns-list", key: "held-list" },
              ...held.map((row) => this.renderRow(row)),
            ),
      ),
    );
  }

  private renderRow(row: HeldSpawnRow): HTMLElement {
    const open = this.expanded.has(row.id);
    const meta = [
      row.parent,
      row.reason,
      row.overlaps && row.reason !== row.overlaps ? row.overlaps : null,
      row.blockedBy,
      row.blocks,
    ].filter((part): part is string => part !== null);
    return h(
      "div",
      {
        class: "held-spawn held-spawn-held",
        key: `held-spawn-${row.id}`,
      },
      h(
        "div",
        { class: "held-spawn-head" },
        h(
          "button",
          {
            class: "held-spawn-toggle",
            type: "button",
            title: open ? "hide the proposal" : "show the proposal",
            onclick: () => this.toggleBody(row.id),
          },
          `${open ? "▾" : "▸"} ${row.title}`,
        ),
        row.kind === "conversation"
          ? h("span", { class: "held-spawn-kind dim" }, "Conversation")
          : null,
      ),
      h(
        "div",
        { class: "held-spawn-meta dim" },
        meta.join(" · "),
        row.waited ? " · " : null,
        row.waited ? h("span", { title: row.at }, row.waited) : null,
      ),
      open ? h("div", { class: "held-spawn-body", key: "body" }, row.body) : null,
      ...this.renderDecisionParts(row),
    );
  }

  /**
   * A held spawn's decisions and any refusal, for the Detail of its faded
   * card: the same buttons and state the list shows.
   */
  renderDecision(row: HeldSpawnRow): HTMLElement {
    return h(
      "div",
      { class: "held-spawn-decision", key: `decision-${row.id}` },
      ...this.renderDecisionParts(row),
    );
  }

  private renderDecisionParts(row: HeldSpawnRow): (HTMLElement | null)[] {
    // This tab's own refusal is the newer news; the engine's is from a
    // Tick that refused an Adopt queued earlier, or refused to land the
    // spawn (issue #150).
    const failure =
      this.failures.get(row.id) ??
      (row.adoptError && !row.adopting
        ? `${row.reason === REFUSED_AT_LANDING ? "the Tick could not land it" : "last Adopt refused"}: ${row.adoptError}`
        : null);
    return [
      this.renderActions(row),
      failure ? h("span", { class: "error-inline held-spawn-failure" }, failure) : null,
    ];
  }

  private renderActions(row: HeldSpawnRow): HTMLElement {
    const pending = this.inFlight.get(row.id) ?? null;
    if (this.armed.has(row.id)) {
      return h(
        "div",
        { class: "held-spawn-actions held-spawn-armed", key: "actions" },
        h("span", { class: "held-spawn-prompt" }, "Discard for good?"),
        h(
          "button",
          {
            class: "btn btn-danger held-spawn-confirm",
            type: "button",
            disabled: pending !== null,
            onclick: () => void this.confirmDiscard(row.id),
          },
          pending === "discard" ? "discarding…" : "Discard",
        ),
        h(
          "button",
          {
            class: "btn held-spawn-cancel",
            type: "button",
            disabled: pending !== null,
            onclick: () => this.cancelDiscard(row.id),
          },
          "Cancel",
        ),
      );
    }
    const busy = pending !== null || row.adopting;
    return h(
      "div",
      { class: "held-spawn-actions", key: "actions" },
      h(
        "button",
        {
          class: "btn btn-primary held-spawn-adopt",
          type: "button",
          title: "add it to the pool past both caps",
          disabled: busy,
          onclick: () => void this.adopt(row.id),
        },
        row.adopting || pending === "adopt" ? "adopting…" : "Adopt",
      ),
      h(
        "button",
        {
          class: "btn held-spawn-discard",
          type: "button",
          title: "drop this proposal for good",
          disabled: busy,
          onclick: () => this.armDiscard(row.id),
        },
        "Discard",
      ),
    );
  }
}
