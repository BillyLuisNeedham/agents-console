/**
 * Conversations: the Conversations tray (list + "New Conversation" form) and
 * the End action's per-conversation in-flight/failure state, shared by the
 * card and Detail so either surface's End button disables together and
 * shows the same 409/failure reason. One module owns this session state, the
 * needs-input.ts / terminal.ts way: a small store the composition wires
 * once, its state feeding the pure projection (`endView` on the card and
 * Detail) and its actions reached through the same seam from both places.
 */

import {
  conversationTurnLabel,
  type ConversationTrayRow,
  type ConversationView,
  type StartConversationRequest,
} from "./project";
import { h } from "./dom";
import { effortInput } from "./effort";

export type StartConversationHandler = (
  request: StartConversationRequest,
) => Promise<ConversationView>;

export type EndConversationHandler = (
  conversationId: string,
  closing?: string,
) => Promise<void>;

export interface ConversationsOptions {
  onStart: StartConversationHandler;
  onEnd: EndConversationHandler;
  /** Tray or End state changed outside a render: the composition re-renders. */
  onChange: () => void;
}

export interface ConversationsHandlers {
  /** A row's id was clicked: select that card and open its Detail. */
  onSelect: (cardId: string) => void;
}

/** Pool defaults shown as the New Conversation form's field placeholders. */
export interface ConversationAssignmentDefaults {
  harness?: string;
  model?: string;
  effort?: string;
  drivers?: string;
}

interface ConversationDraft {
  title: string;
  opening: string;
  harness: string;
  model: string;
  effort: string;
  drivers: string;
}

type DraftField = keyof ConversationDraft;

const EMPTY_DRAFT: ConversationDraft = {
  title: "",
  opening: "",
  harness: "",
  model: "",
  effort: "",
  drivers: "",
};

export class ConversationsTray {
  private draft: ConversationDraft = { ...EMPTY_DRAFT };
  private formOpen = false;
  private submitting = false;
  private startFailure: string | null = null;
  // The End action's in-flight and failure marks, keyed by conversation id:
  // the same shape the card and Detail both project (`endView`), so a click
  // from either surface disables both.
  private readonly ending = new Set<string>();
  private readonly endFailures = new Map<string, string>();
  private readonly onStart: StartConversationHandler;
  private readonly onEnd: EndConversationHandler;
  private readonly onChange: () => void;

  constructor(options: ConversationsOptions) {
    this.onStart = options.onStart;
    this.onEnd = options.onEnd;
    this.onChange = options.onChange;
  }

  // -------------------------------------------------------------------------
  // New Conversation form
  // -------------------------------------------------------------------------

  get isFormOpen(): boolean {
    return this.formOpen;
  }

  openForm(): void {
    this.formOpen = true;
    this.onChange();
  }

  closeForm(): void {
    this.formOpen = false;
    this.startFailure = null;
    this.onChange();
  }

  /** The draft field's current value, for a freshly rebuilt input's `.value`. */
  field(name: DraftField): string {
    return this.draft[name];
  }

  setField(name: DraftField, value: string): void {
    this.draft = { ...this.draft, [name]: value };
  }

  get isSubmitting(): boolean {
    return this.submitting;
  }

  /** The last start attempt's failure (a 409 reason or any other error),
   *  or null while the form stands unmarked. */
  get failure(): string | null {
    return this.startFailure;
  }

  /**
   * Submit the New Conversation form: validates the title client-side (the
   * one field the engine also requires), then starts the Conversation with
   * only the Assignment fields the operator actually filled in, so an empty
   * field really means "use the pool default" rather than an empty string
   * override. A 409 (headless pool) or any other failure marks the form
   * inline and leaves the draft in place for a retry; success clears the
   * draft and closes the form.
   */
  async submit(): Promise<void> {
    if (this.submitting) return;
    const title = this.draft.title.trim();
    if (!title) {
      this.startFailure = "title is required";
      this.onChange();
      return;
    }
    this.submitting = true;
    this.startFailure = null;
    this.onChange();
    const assign: StartConversationRequest["assign"] = {};
    if (this.draft.harness.trim()) assign.harness = this.draft.harness.trim();
    if (this.draft.model.trim()) assign.model = this.draft.model.trim();
    if (this.draft.effort.trim()) assign.effort = this.draft.effort.trim();
    if (this.draft.drivers.trim()) assign.drivers = this.draft.drivers.trim();
    try {
      await this.onStart({
        title,
        opening: this.draft.opening.trim() || undefined,
        assign: Object.keys(assign).length > 0 ? assign : undefined,
      });
      this.draft = { ...EMPTY_DRAFT };
      this.formOpen = false;
    } catch (err) {
      this.startFailure = err instanceof Error ? err.message : String(err);
    } finally {
      this.submitting = false;
      this.onChange();
    }
  }

  // -------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------

  /** The End view a card or Detail projects for a conversation id. */
  endView(id: string): { ending: boolean; failure: string | null } {
    return { ending: this.ending.has(id), failure: this.endFailures.get(id) ?? null };
  }

  /** The per-conversation End state, for the pool projection's endings map. */
  endState(): Record<string, { ending: boolean; failure: string | null }> {
    const ids = new Set([...this.ending, ...this.endFailures.keys()]);
    const state: Record<string, { ending: boolean; failure: string | null }> = {};
    for (const id of ids) state[id] = this.endView(id);
    return state;
  }

  /** Drop End failure marks for conversations no longer live: once a
   *  Conversation ends (or leaves the pool), its stale failure mark goes
   *  with it. */
  pruneEndFailures(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.endFailures.keys()]) {
      if (!liveIds.has(id)) this.endFailures.delete(id);
    }
  }

  /**
   * End a Conversation, from either the card or the Detail. A second click
   * while one is already in flight for the same id is a no-op: the button
   * on both surfaces reads `endView(id).ending` and disables itself.
   */
  async endConversation(id: string, closing?: string): Promise<void> {
    if (this.ending.has(id)) return;
    this.ending.add(id);
    this.endFailures.delete(id);
    this.onChange();
    try {
      await this.onEnd(id, closing);
    } catch (err) {
      this.endFailures.set(id, err instanceof Error ? err.message : String(err));
    } finally {
      this.ending.delete(id);
      this.onChange();
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * The Conversations tray: the count, the collapsible "New Conversation"
   * form, and every live Conversation row, already sorted by the projection
   * (waiting-on-you first, then longest idle). Clicking a row selects its
   * card and opens the Detail, the same navigation the canvas offers.
   */
  render(
    rows: ConversationTrayRow[],
    defaults: ConversationAssignmentDefaults,
    handlers: ConversationsHandlers,
  ): HTMLElement {
    return h(
      "div",
      { class: "conversations-tray" },
      h(
        "div",
        { class: "conversations-head" },
        h("span", { class: "conversations-count" }, `conversations · ${rows.length}`),
        h(
          "button",
          {
            class: "btn btn-primary conversations-new-toggle",
            onclick: () => (this.formOpen ? this.closeForm() : this.openForm()),
          },
          this.formOpen ? "cancel" : "new conversation",
        ),
      ),
      this.formOpen ? this.renderForm(defaults) : null,
      ...rows.map((row) => this.renderRow(row, handlers)),
    );
  }

  private renderForm(defaults: ConversationAssignmentDefaults): HTMLElement {
    // The text lives in the draft; each field renders from it and reports
    // back into it.
    const title = h("input", {
      class: "field conversations-field",
      type: "text",
      placeholder: "title",
      disabled: this.submitting,
      value: this.draft.title,
      oninput: (event: Event) =>
        this.setField("title", (event.currentTarget as HTMLInputElement).value),
    });

    const opening = h("textarea", {
      class: "field conversations-field",
      placeholder: "opening turn (optional)",
      rows: 3,
      disabled: this.submitting,
      value: this.draft.opening,
      oninput: (event: Event) =>
        this.setField("opening", (event.currentTarget as HTMLTextAreaElement).value),
    });

    return h(
      "div",
      { class: "conversations-form" },
      title,
      opening,
      h(
        "div",
        { class: "conversations-assign-row" },
        this.assignField("harness", defaults.harness),
        this.assignField("model", defaults.model),
        effortInput({
          key: "conversation-effort",
          class: "field conversations-field",
          harness: this.draft.harness.trim() || defaults.harness,
          value: this.draft.effort,
          placeholder: defaults.effort ?? "effort",
          disabled: this.submitting,
          onInput: (value) => this.setField("effort", value),
        }),
        this.assignField("drivers", defaults.drivers),
      ),
      this.startFailure
        ? h("div", { class: "error-inline conversations-failure" }, this.startFailure)
        : null,
      h(
        "button",
        {
          class: "btn btn-primary",
          disabled: this.submitting,
          onclick: () => {
            void this.submit();
          },
        },
        this.submitting ? "starting..." : "start",
      ),
    );
  }

  private assignField(name: "harness" | "model" | "drivers", placeholder?: string): HTMLInputElement {
    return h("input", {
      class: "field conversations-field",
      type: "text",
      placeholder: placeholder ?? name,
      disabled: this.submitting,
      value: this.draft[name],
      oninput: (event: Event) =>
        this.setField(name, (event.currentTarget as HTMLInputElement).value),
    });
  }

  private renderRow(row: ConversationTrayRow, handlers: ConversationsHandlers): HTMLElement {
    return h(
      "div",
      { class: "conversations-row", key: row.id },
      h(
        "button",
        {
          class: "conversations-row-id",
          title: row.title,
          onclick: () => handlers.onSelect(row.cardId),
        },
        row.id,
      ),
      h(
        "span",
        { class: `conversations-turn conversations-turn-${row.turn.state}` },
        conversationTurnLabel(row.turn.state),
      ),
      row.idleAge ? h("span", { class: "dim conversations-idle" }, row.idleAge) : null,
    );
  }
}
