/**
 * Detail: the right-hand panel for the selected card. One module owns the
 * panel render, the width drag on its left edge, fullscreen, and the
 * interrupt forms, as instance state on the class the composition root
 * creates once per session, so every render says the same thing: the
 * dragged width, the fullscreen flag, and a note being typed all render from
 * here. The note drafts are the Draft answers store the Needs input tray
 * shares (issue #147). Selection changes arrive through the `onClose`
 * callback and `exitFullscreen`; the composition owns the selection itself.
 */

import {
  checkpointNotice,
  clampDetailWidth,
  conversationTurnLabel,
  DETAIL_MAX_FRACTION,
  DETAIL_MIN_PX,
  parseStoredDetailWidth,
  resolverFiles,
  statusLabel,
  stewardBudgetText,
  ticketBodyHtml,
  UNASSIGNED_LABEL,
  type AssignmentSource,
  type ConversationDetailView,
  type DetailTab,
  type DetailTabView,
  type DetailView,
  type HeldSpawnRow,
  type PendingSpawnRow,
  type ResumeAction,
  type SpawnDetailView,
  type InterruptView,
  type LogPaneView,
  type TimelineGradeView,
  type TimelineView,
} from "./project";
import { noteLogScroll } from "./log-pane";
import {
  renderKeepTalkingButton,
  renderKeepTalkingFailure,
  renderTerminalSurface,
} from "./terminal";
import { harnessSelect, renderSource, type ReassignSeed, type ReassignStore } from "./reassign";
import { h } from "./dom";
import { DRAFT_TICKET_ATTR, type DraftAnswers } from "./drafts";
import { renderStewardBadge, renderStewardNote } from "./steward";
import { renderDeliveryWarning } from "./conversations";
import { EFFORT_NOT_APPLIED_TITLE, effortInput, effortText, effortValue } from "./effort";

// One global localStorage key (not per pool) remembers the dragged width
// across reloads.
const DETAIL_WIDTH_KEY = "console-detail-width";

/** The slice of the app model the Detail renders from. */
export interface DetailModel {
  detail: DetailView | null;
  timeline: TimelineView | null;
  logPane: LogPaneView | null;
  /** The ticket Detail's tab bar; null for a utility Detail or no selection. */
  detailTabs: DetailTabView[] | null;
  /** The ticket's markdown body: undefined while the fetch is out, null when the pool has none. */
  detailBody: string | null | undefined;
  detailBodyError: string | null;
}

/** The handlers the Detail's interactive elements report through. */
export interface DetailHandlers {
  onSelectAttempt: (ticketId: string, attempt: number) => void;
  onSelectStream: (ticketId: string, attempt: number) => void;
  onLoadEarlier: (ticketId: string, attempt: number) => void;
  onAnswer: (ticketId: string, action: ResumeAction, note?: string) => void;
  /** Keep talking on a checkpoint with a Held pane (issue #139): fire and
   *  forget, like onAnswer; the session holds the in-flight and refusal
   *  state the interrupt's `keepTalking` view reads back. */
  onKeepTalking: (ticketId: string) => void;
  /** "Use as answer" on a Steward note (ADR-0030): the composition makes it
   *  the ticket's Draft answer and re-renders, so the note field here and
   *  the Needs input row's both show it. */
  onUseStewardNote: (ticketId: string, text: string) => void;
  onSelectTab: (ticketId: string, tab: DetailTab) => void;
  /** A Conversation's End: fire-and-forget, mirroring onAnswer. The
   *  Conversations store tracks the in-flight/failure state on `endView`. */
  onEndConversation: (conversationId: string, closing?: string) => void;
  /** "Open in herdr" on a Conversation's terminal peek. */
  onFocusConversationTerminal: (conversationId: string) => Promise<boolean>;
  /** "open resolver" on a ticket whose merge a resolver is resolving
   *  (issue #129): the same focus seam the card's button uses, by ticket id. */
  onFocusResolver: (ticketId: string) => Promise<boolean>;
  /**
   * The Reassign store (issue #126), passed in rather than owned: the Detail
   * has no onChange of its own, and a Save that enables on dirty has to
   * re-render the moment a field moves. The store holds the drafts, the
   * harness list and the save state; this pane only draws them.
   */
  reassign: ReassignStore;
  /**
   * A Pending or Held spawn's decisions (issue #150): Hold and Discard, or
   * Adopt and Discard, drawn by the Spawns list's store so the Detail and
   * the list share one in-flight and refusal state.
   */
  renderSpawnDecision: (
    row: PendingSpawnRow | HeldSpawnRow,
    state: "pending" | "held",
  ) => HTMLElement;
}

export class Detail {
  private width = DETAIL_MIN_PX;
  private drag: { startX: number; startWidth: number } | null = null;
  // Fullscreen fixes the Detail over the content area below the toolbar
  // (canvas and drawers covered, toolbar visible and live) without
  // unmounting it, so snapshots, interrupt forms, and log tailing all
  // keep working. Esc, the toggle, or selecting another card exits; exiting
  // restores the dragged width.
  private fullscreen = false;
  // The ticket whose note the next commit focuses, set by writeFullSize and
  // cleared once the note has focus or fullscreen is left, so the focus is
  // asked for once and never pulled back on a later render.
  private noteFocus: string | null = null;
  // Interrupt note drafts, keyed by ticket id, so a snapshot re-render
  // (siblings keep running while an interrupt waits) never wipes a note
  // being typed. The store is shared with the Needs input tray (issue #147)
  // and pruned by the composition when an interrupt resolves.
  private readonly drafts: DraftAnswers;
  // A Conversation's closing-line draft, keyed by conversation id: separate
  // from the interrupt drafts above, which are pruned against pending
  // ticket ids on every render and would otherwise wipe this on the next
  // snapshot.
  private readonly conversationEndDrafts = new Map<string, string>();
  private readonly onClose: () => void;

  constructor(options: { onClose: () => void; drafts: DraftAnswers }) {
    this.onClose = options.onClose;
    this.drafts = options.drafts;
    if (typeof window !== "undefined") {
      this.width = clampDetailWidth(this.readStoredWidth(), currentMaxPx());
      // Esc leaves fullscreen; the toggle and card selection handle their own
      // exits, so this is the one path that must listen globally.
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.fullscreen) {
          this.fullscreen = false;
          this.noteFocus = null;
          this.applyFullscreen();
        }
      });
      // The toolbar can wrap on a narrow window, so its height (the
      // fullscreen Detail's top) is re-measured when the window resizes.
      window.addEventListener("resize", () => {
        if (this.fullscreen) this.applyFullscreen();
      });
    }
  }

  /** Selection changed or the panel closed: leave fullscreen. */
  exitFullscreen(): void {
    this.fullscreen = false;
    this.noteFocus = null;
  }

  /**
   * Write a ticket's answer full size (issue #147): the next render draws
   * the Detail fullscreen, and the commit after it focuses the ticket's note
   * (`settleNoteFocus`). The caller selects the card and its Progress tab;
   * selecting leaves fullscreen, so it comes first.
   */
  writeFullSize(ticketId: string): void {
    this.fullscreen = true;
    this.noteFocus = ticketId;
  }

  /**
   * After a commit: focus the note writeFullSize asked for, caret at the
   * end of the draft, once it is on the page. The morph may have kept the
   * old node or mounted the new one, so the note is found on the page, not
   * held from the render.
   */
  settleNoteFocus(root: ParentNode): void {
    if (this.noteFocus === null) return;
    const key = noteKey(this.noteFocus);
    const note = [
      ...root.querySelectorAll<HTMLTextAreaElement>(".detail-open textarea.interrupt-note"),
    ].find((el) => el.getAttribute("data-key") === key);
    if (!note) return;
    this.noteFocus = null;
    note.focus();
    note.setSelectionRange(note.value.length, note.value.length);
  }

  render(model: DetailModel, handlers: DetailHandlers): HTMLElement {
    const detail = h("div", { class: "detail" });
    const view = model.detail;
    if (!view) return detail;
    detail.classList.add("detail-open");
    if (this.fullscreen) {
      detail.classList.add("detail-fullscreen");
      detail.style.top = `${canvasHeaderBottom()}px`;
    } else {
      detail.style.width = `${clampDetailWidth(this.width, currentMaxPx())}px`;
    }
    const title =
      view.kind === "ticket"
        ? view.ticketId
        : view.kind === "conversation"
          ? view.conversationId
          : view.kind === "spawn"
            ? view.proposalId
            : view.label;
    const fullscreenToggle = h("button", {
      class: "btn detail-fullscreen-toggle",
      onclick: () => this.toggleFullscreen(),
    });
    this.setFullscreenToggleLabel(fullscreenToggle);
    detail.append(
      h(
        "div",
        { class: "detail-head" },
        h("span", { class: "detail-title" }, title),
        h(
          "div",
          { class: "detail-head-actions" },
          fullscreenToggle,
          h(
            "button",
            { class: "btn", title: "close detail", onclick: () => this.onClose() },
            "✕",
          ),
        ),
      ),
      view.kind === "ticket"
        ? this.renderTicketDetail(view, model, handlers)
        : view.kind === "conversation"
          ? this.renderConversationDetail(view, model, handlers)
          : view.kind === "spawn"
            ? this.renderSpawnDetail(view, handlers)
            : this.renderUtilityDetail(view, handlers),
    );
    return detail;
  }

  // The Detail's left edge as a drag handle, sitting between the canvas and
  // the panel. Rendered only while a Detail is open, so a closed panel
  // leaves no orphan strip.
  renderHandle(): HTMLElement {
    return h("div", {
      class: "detail-handle",
      title: "drag to resize detail",
      onpointerdown: (event: PointerEvent) => {
        if (this.drag || this.fullscreen) return;
        this.drag = {
          startX: event.clientX,
          startWidth: clampDetailWidth(this.width, currentMaxPx()),
        };
        try {
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
          // pointer already gone
        }
      },
      onpointermove: (event: PointerEvent) => {
        if (!this.drag) return;
        const dx = event.clientX - this.drag.startX;
        this.width = clampDetailWidth(this.drag.startWidth - dx, currentMaxPx());
        this.applyWidth();
      },
      onpointerup: () => {
        this.drag = null;
        this.writeStoredWidth();
      },
      onpointercancel: () => {
        this.drag = null;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Interrupt form
  // -------------------------------------------------------------------------

  // One interrupt form shape, rendered in the Detail: the only place an
  // interrupt is read and answered. The kind-specific body comes from the
  // engine: a checkpoint's Brief, a crash's log path, a conflict's resolution
  // or attempt. A checkpoint whose Held pane is still alive also offers Keep
  // talking beside Resume (issue #139); it is not an answer, so the note
  // stays with Resume and the button sends none. A Steward note (ADR-0030)
  // sits above the note field, with "Use as answer" to take it as the draft.
  private renderInterrupt(
    interrupt: InterruptView,
    handlers: DetailHandlers,
  ): HTMLElement {
    const box = h(
      "div",
      { class: interrupt.queued ? "interrupt-box interrupt-box-queued" : "interrupt-box" },
      h("span", { class: "interrupt-kind" }, interrupt.form.title),
      h("pre", { class: "interrupt-body" }, interrupt.body || "(no details)"),
    );
    // Answered-and-waiting: the answer is recorded and will be applied at the
    // next super-step boundary, so the form steps aside for the waiting line.
    // The interrupt stays on the card until processing clears it.
    if (interrupt.queued) {
      box.append(
        h(
          "div",
          { class: "interrupt-waiting" },
          "answered · waiting for the next super-step boundary",
        ),
      );
      return box;
    }
    const stewardNote = interrupt.stewardNote;
    if (stewardNote) {
      box.append(
        renderStewardNote(stewardNote, {
          disabled: false,
          onUse: () => handlers.onUseStewardNote(interrupt.ticketId, stewardNote.text),
        }),
      );
    }
    const note = h("textarea", {
      class: "interrupt-note",
      key: noteKey(interrupt.ticketId),
      placeholder:
        interrupt.form.notePlaceholder ?? "note (optional, appended to the Issue)",
      rows: 3,
      value: this.drafts.get(interrupt.ticketId),
      [DRAFT_TICKET_ATTR]: interrupt.ticketId,
      oninput: (event: Event) => {
        this.drafts.input(interrupt.ticketId, event.currentTarget as HTMLTextAreaElement);
      },
    });
    box.append(note);
    box.append(
      h(
        "div",
        { class: "interrupt-actions" },
        ...interrupt.form.actions.map(({ action, label, tone }) =>
          h(
            "button",
            {
              class: "btn" + (tone === "primary" ? " btn-primary" : " btn-danger"),
              onclick: () =>
                handlers.onAnswer(
                  interrupt.ticketId,
                  action,
                  this.drafts.get(interrupt.ticketId) || undefined,
                ),
            },
            label,
          ),
        ),
        interrupt.keepTalking
          ? renderKeepTalkingButton(interrupt.keepTalking, () =>
              handlers.onKeepTalking(interrupt.ticketId),
            )
          : null,
      ),
    );
    const refusal = interrupt.keepTalking
      ? renderKeepTalkingFailure(interrupt.keepTalking)
      : null;
    if (refusal) box.append(refusal);
    return box;
  }

  // -------------------------------------------------------------------------
  // Ticket body: timeline, raw log, never-run spec
  // -------------------------------------------------------------------------

  // The ticket's timeline: one row per attempt with its events, read from the
  // events endpoint and rendered under the interrupt form. The currently
  // running attempt is marked; a reconstructed timeline (a pre-feature pool
  // with no events file) notes that its rows came from log files. Clicking an
  // attempt row selects that attempt's raw log in the pane below.
  private renderTimelineSection(
    ticketId: string,
    timeline: TimelineView,
    logPane: LogPaneView | null,
    handlers: DetailHandlers,
    winnerAttempt: number | null,
  ): HTMLElement {
    const body = h("div", { class: "timeline" });
    body.append(h("div", { class: "dim" }, "timeline"));
    if (timeline.attempts.length === 0) {
      body.append(h("div", { class: "dim timeline-empty" }, "no attempts yet"));
      return body;
    }
    if (timeline.reconstructed) {
      body.append(
        h(
          "div",
          { class: "dim timeline-note" },
          "attempts reconstructed from log files",
        ),
      );
    }
    for (const attempt of timeline.attempts) {
      const selected = logPane?.selectedAttempt === attempt.number;
      // The winner badge reads the grades endpoint's winner, the one
      // derivation both surfaces share: the attempt the selected event named
      // (merged only stands in for tickets graded before the selection
      // machinery). Keying on the merged event here would leave the badge
      // off for the whole window between selection and merge, and forever
      // on a conflicted merge that checkpoints, while the card already shows
      // the winner's grade. Null means ungraded or unselected: no badge.
      const winner =
        winnerAttempt !== null && attempt.number === winnerAttempt;
      const row = h(
        "div",
        {
          class:
            "timeline-attempt" +
            (attempt.running ? " timeline-attempt-running" : "") +
            (selected ? " timeline-attempt-selected" : "") +
            (winner ? " timeline-attempt-winner" : ""),
          role: "button",
          title: "show this attempt's raw log",
          onclick: () => handlers.onSelectAttempt(ticketId, attempt.number),
        },
        h(
          "div",
          { class: "timeline-attempt-head" },
          h(
            "span",
            { class: "timeline-attempt-number" },
            `attempt ${attempt.number}`,
          ),
          attempt.running
            ? h("span", { class: "timeline-running" }, "running")
            : null,
          selected ? h("span", { class: "timeline-selected" }, "showing") : null,
          winner ? h("span", { class: "timeline-winner" }, "winner") : null,
          attempt.reconstructed ? h("span", { class: "dim" }, "reconstructed") : null,
          // The attempt's Stream file link (ADR-0012): one click from the
          // timeline to the raw stream tee for deep forensics. Rendered only
          // when the server's attempt listing resolved one; an attempt with
          // no Stream file (opencode, pre-streaming) renders no link rather
          // than a dead one.
          attempt.streamFile
            ? h(
                "button",
                {
                  class: "timeline-stream",
                  title: `view this attempt's stream file (${attempt.streamFile})`,
                  onclick: (event: Event) => {
                    event.stopPropagation();
                    handlers.onSelectStream(ticketId, attempt.number);
                  },
                },
                "stream",
              )
            : null,
        ),
      );
      if (attempt.events.length === 0) {
        row.append(h("div", { class: "dim timeline-event" }, "no events recorded"));
      } else {
        for (const event of attempt.events) {
          row.append(
            h(
              "div",
              { class: "timeline-event" },
              h("span", { class: "timeline-event-kind" }, event.kind),
              h("span", { class: "dim timeline-event-at" }, event.timeLabel),
            ),
          );
          if (event.grade) row.append(renderGrade(event.grade));
          if (event.reassignment) {
            row.append(h("div", { class: "timeline-reassigned" }, event.reassignment));
          }
          if (event.spawn) row.append(h("div", { class: "timeline-spawn" }, event.spawn));
          if (event.steward) {
            row.append(h("div", { class: "timeline-steward" }, event.steward));
          }
        }
      }
      body.append(row);
    }
    return body;
  }

  // The raw log pane below the timeline: the harness output of the selected
  // attempt, opened tail-first and tailed live on the snapshot cadence.
  // Content is fetched as byte ranges and already ANSI-stripped server-side.
  // A "load earlier" button prepends the previous window while the opened
  // view stays anchored; the scroll listener drives the pin that decides
  // whether renders follow the tail. While a fetch is in flight the
  // previously loaded content stays visible.
  private renderLogPane(
    logPane: LogPaneView,
    ticketId: string,
    handlers: DetailHandlers,
  ): HTMLElement {
    const pane = h("div", { class: "log-pane" });
    pane.append(
      h(
        "div",
        { class: "log-pane-head" },
        h("span", { class: "dim" }, logPane.stream ? "stream file" : "raw log"),
        logPane.selectedAttempt !== null
          ? h("span", { class: "log-pane-attempt" }, `attempt ${logPane.selectedAttempt}`)
          : null,
        logPane.error
          ? h("span", { class: "error-inline log-pane-error" }, logPane.error)
          : null,
      ),
    );
    if (logPane.hasEarlier && logPane.selectedAttempt !== null) {
      const attempt = logPane.selectedAttempt;
      pane.append(
        h(
          "button",
          {
            class: "btn log-pane-earlier",
            title: "prepend the previous chunk of this log",
            onclick: () => handlers.onLoadEarlier(ticketId, attempt),
          },
          "load earlier",
        ),
      );
    }
    const pre = h(
      "pre",
      {
        class: "log-pane-content",
        onscroll: (event: Event) => {
          const el = event.currentTarget as HTMLElement;
          noteLogScroll(el.scrollTop, el.clientHeight, el.scrollHeight);
        },
      },
      logPane.content.length > 0 ? logPane.content : "(no output yet)",
    );
    pane.append(pre);
    if (logPane.hasMore) {
      pane.append(h("div", { class: "dim log-pane-more" }, "loading more..."));
    }
    return pane;
  }

  // The ticket Detail's body is the Spec / Progress / Outcome tab bar; the
  // tab panels hold what the old stacked layout carried.
  private renderTicketDetail(
    detail: Extract<DetailView, { kind: "ticket" }>,
    model: DetailModel,
    handlers: DetailHandlers,
  ): HTMLElement {
    const body = h("div", { class: "detail-body" });
    const tabs = model.detailTabs ?? [];
    body.append(this.renderDetailTabs(tabs, detail.ticketId, handlers));
    const active = tabs.find((tab) => tab.active)?.id ?? "spec";
    if (active === "spec") {
      body.append(
        this.renderSpecTab(
          detail,
          model.detailBody,
          model.detailBodyError,
          handlers.reassign,
        ),
      );
    } else if (active === "progress") {
      body.append(
        this.renderProgressTab(detail, model.timeline, model.logPane, handlers),
      );
    } else {
      body.append(this.renderOutcomeTab(detail));
    }
    return body;
  }

  private renderDetailTabs(
    tabs: DetailTabView[],
    ticketId: string,
    handlers: DetailHandlers,
  ): HTMLElement {
    return h(
      "div",
      { class: "detail-tabs", role: "tablist" },
      ...tabs.map((tab) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            class: "detail-tab" + (tab.active ? " detail-tab-active" : ""),
            onclick: () => handlers.onSelectTab(ticketId, tab.id),
          },
          tab.label,
          tab.interruptDot
            ? h("span", { class: "dot dot-interrupt", title: "interrupt pending" })
            : null,
        ),
      ),
    );
  }

  // One tab panel's container: the column the Spec, Progress and Outcome
  // bodies share.
  private detailPanel(...kids: (Node | string | null)[]): HTMLElement {
    return h("div", { class: "detail-panel" }, ...kids);
  }

  // The Spec tab: the ticket's markdown body rendered to HTML, preceded by
  // the blockers line and the Reassign section. Reassign lives here rather
  // than on Progress because it says how the ticket's next Attempt will run,
  // not how the one that ran went.
  private renderSpecTab(
    detail: Extract<DetailView, { kind: "ticket" }>,
    body: string | null | undefined,
    error: string | null,
    reassign: ReassignStore,
  ): HTMLElement {
    const panel = this.detailPanel(
      h(
        "div",
        { class: "dim detail-blockers" },
        detail.blockedBy.length > 0
          ? `blocked by ${detail.blockedBy.join(", ")}`
          : "no blockers",
      ),
      this.renderReassign(detail, reassign),
    );
    if (detail.blockedByCheckpoint.length > 0) {
      panel.append(
        h(
          "div",
          { class: "checkpoint-blocked" },
          checkpointNotice(detail.blockedByCheckpoint),
        ),
      );
    }
    if (body === undefined) {
      panel.append(
        error
          ? h("div", { class: "error-inline" }, error)
          : h("div", { class: "dim" }, "loading ticket body..."),
      );
    } else if (body === null) {
      panel.append(h("div", { class: "dim" }, "no ticket body"));
    } else {
      const md = h("div", { class: "detail-md" });
      md.innerHTML = ticketBodyHtml(body);
      panel.append(md);
    }
    return panel;
  }

  // The Progress tab: the status, the resolver running on the ticket's merge
  // when there is one, the interrupt form (the Detail's only action surface)
  // and the timeline, with attempt rows opening raw logs in the pane below.
  // A never-run ticket's timeline carries its own "no attempts yet" marker,
  // and its log pane stays closed.
  private renderProgressTab(
    detail: Extract<DetailView, { kind: "ticket" }>,
    timeline: TimelineView | null,
    logPane: LogPaneView | null,
    handlers: DetailHandlers,
  ): HTMLElement {
    const panel = this.detailPanel(
      h("div", { class: "dim" }, "status"),
      h(
        "div",
        {
          class:
            `detail-status ticket-state-${detail.status}` +
            (detail.mergeState ? ` ticket-merge-${detail.mergeState}` : ""),
        },
        statusLabel(detail.status, detail.mergeState),
      ),
    );
    // The Steward budget (ADR-0030), only once the Steward has answered this
    // ticket since the operator last did: how much more it may answer here.
    if (detail.stewardBudget) {
      panel.append(
        h(
          "div",
          {
            class:
              "detail-steward-budget" +
              (detail.stewardBudget.remaining === 0 ? " detail-steward-budget-spent" : ""),
            title: "answers the Steward may still give this ticket before it waits for you",
          },
          stewardBudgetText(detail.stewardBudget),
        ),
      );
    }
    if (detail.resolver) {
      panel.append(this.renderResolver(detail.ticketId, detail.resolver, timeline, handlers));
    }
    if (detail.interrupt) {
      panel.append(this.renderInterrupt(detail.interrupt, handlers));
    }
    if (timeline) {
      panel.append(
        this.renderTimelineSection(
          detail.ticketId,
          timeline,
          logPane,
          handlers,
          detail.winner,
        ),
      );
    }
    if (logPane && !logPane.neverRun) {
      panel.append(this.renderLogPane(logPane, detail.ticketId, handlers));
    }
    return panel;
  }

  // The resolver on a held ticket's merge (issue #129): how long it has run,
  // the files it was handed (the timeline's resolver event, so empty until
  // the events land), and a jump to its herdr tab. A headless resolver has
  // no tab to open; its output is the log pane's, below.
  private renderResolver(
    ticketId: string,
    resolver: NonNullable<Extract<DetailView, { kind: "ticket" }>["resolver"]>,
    timeline: TimelineView | null,
    handlers: DetailHandlers,
  ): HTMLElement {
    const files = resolverFiles(timeline, resolver.attempt);
    return h(
      "section",
      { class: "detail-resolver", key: "detail-resolver" },
      h(
        "div",
        { class: "detail-resolver-head" },
        h(
          "span",
          { class: "detail-resolver-elapsed" },
          `resolver · attempt ${resolver.attempt} · running ${resolver.elapsed}`,
        ),
        resolver.paneId !== null
          ? h(
              "button",
              {
                class: "btn detail-resolver-open",
                type: "button",
                title: "focus the resolver's tab in the herdr TUI",
                onclick: () => {
                  void handlers.onFocusResolver(ticketId);
                },
              },
              "open resolver",
            )
          : null,
      ),
      files.length > 0
        ? h(
            "div",
            { class: "detail-resolver-files" },
            h("div", { class: "dim" }, `conflicted files (${files.length})`),
            h("ul", {}, ...files.map((file) => h("li", { key: file }, h("code", {}, file)))),
          )
        : null,
    );
  }

  // -------------------------------------------------------------------------
  // Reassign (CONTEXT.md: Reassign; issue #126)
  // -------------------------------------------------------------------------

  // The ticket's Assignment, editable when the engine says a write would
  // take effect at the next boundary and read-only with its one-line reason
  // when it would not. Each field carries the pill that says where its value
  // came from, so the operator can see at a glance whether editing the pool
  // defaults would move this ticket or whether it is pinned away from them.
  // Emptying a field is how a ticket stops being pinned on it.
  private renderReassign(
    detail: Extract<DetailView, { kind: "ticket" }>,
    store: ReassignStore,
  ): HTMLElement {
    const view = detail.reassign;
    // An enlisted ticket runs as it was found, so the engine fixes its model,
    // effort, drivers and verify and refuses a write to any of them: the
    // editor offers its harness and shows the rest the way an ineligible
    // ticket shows every field.
    const seed: ReassignSeed = {
      assignment: detail.assignment,
      verify: view.verify,
      harnessOnly: detail.enlisted,
    };
    const head = h(
      "div",
      { class: "reassign-section-head" },
      h("span", { class: "reassign-section-title" }, "reassign"),
    );
    if (!view.eligible) {
      return h(
        "section",
        { class: "reassign-section", key: "reassign-section" },
        head,
        h(
          "div",
          { class: "reassign-readonly" },
          this.renderReadonlyField("harness", detail.assignment.harness, view.sources.harness),
          this.renderReadonlyField("model", detail.assignment.model, view.sources.model),
          this.renderReadonlyEffort(detail),
          this.renderReadonlyField("drivers", detail.assignment.drivers, view.sources.drivers),
          this.renderReadonlyField(
            "verify",
            view.verify === null ? null : String(view.verify),
            view.verify === null ? "unset" : "pinned",
          ),
        ),
        h(
          "div",
          { class: "dim reassign-reason" },
          view.reason ?? "this ticket cannot be reassigned right now",
        ),
      );
    }
    const ticketId = detail.ticketId;
    const state = store.saveState(ticketId);
    const dirty = store.isDirty(ticketId, seed);
    const failure = store.saveFailure(ticketId);
    return h(
      "section",
      { class: "reassign-section", key: "reassign-section" },
      head,
      this.renderReassignField(
        detail,
        store,
        seed,
        "harness",
        harnessSelect(
          "reassign-detail-harness",
          store.harnesses,
          store.field(ticketId, "harness", seed),
          (value) => store.setField(ticketId, "harness", value, seed),
        ),
      ),
      detail.enlisted
        ? h(
            "div",
            { class: "reassign-readonly", key: "reassign-fixed" },
            this.renderReadonlyField("model", detail.assignment.model, view.sources.model),
            this.renderReadonlyEffort(detail),
            this.renderReadonlyField(
              "drivers",
              detail.assignment.drivers,
              view.sources.drivers,
            ),
            this.renderReadonlyField(
              "verify",
              view.verify === null ? null : String(view.verify),
              view.verify === null ? "unset" : "pinned",
            ),
          )
        : null,
      detail.enlisted
        ? null
        : this.renderReassignField(
            detail,
            store,
            seed,
            "model",
            h("input", {
              class: "settings-input reassign-input",
              key: "reassign-detail-model",
              type: "text",
              placeholder: "(inherited)",
              value: store.field(ticketId, "model", seed),
              oninput: (event: Event) =>
                store.setField(
                  ticketId,
                  "model",
                  (event.currentTarget as HTMLInputElement).value,
                  seed,
                ),
            }),
          ),
      detail.enlisted
        ? null
        : this.renderReassignField(
            detail,
            store,
            seed,
            "effort",
            effortInput({
              key: "reassign-detail-effort",
              class: "settings-input reassign-input",
              harness: store.field(ticketId, "harness", seed),
              value: store.field(ticketId, "effort", seed),
              placeholder: "(harness default)",
              onInput: (value) => store.setField(ticketId, "effort", value, seed),
            }),
          ),
      // The effort in force, when the harness cannot take it in the mode
      // this pool launches in: kept, but said plainly (CONTEXT.md: Effort).
      !detail.enlisted && detail.assignment.effortApplied === false
        ? h(
            "div",
            { class: "dim reassign-note effort-unapplied-note", key: "reassign-effort-note" },
            `effort ${detail.assignment.effort} is not applied: ${EFFORT_NOT_APPLIED_TITLE}`,
          )
        : null,
      detail.enlisted
        ? null
        : this.renderReassignField(
            detail,
            store,
            seed,
            "drivers",
            h("input", {
              class: "settings-input reassign-input",
              key: "reassign-detail-drivers",
              type: "text",
              placeholder: "(inherited)",
              value: store.field(ticketId, "drivers", seed),
              oninput: (event: Event) =>
                store.setField(
                  ticketId,
                  "drivers",
                  (event.currentTarget as HTMLInputElement).value,
                  seed,
                ),
            }),
          ),
      detail.enlisted
        ? null
        : this.renderReassignField(
            detail,
            store,
            seed,
            "verify",
            h("input", {
              class: "settings-input settings-port reassign-input",
              key: "reassign-detail-verify",
              type: "number",
              min: "1",
              placeholder: "(none)",
              value: store.field(ticketId, "verify", seed),
              oninput: (event: Event) =>
                store.setField(
                  ticketId,
                  "verify",
                  (event.currentTarget as HTMLInputElement).value,
                  seed,
                ),
            }),
          ),
      h(
        "div",
        { class: "reassign-save-row", key: "reassign-save-row" },
        h(
          "button",
          {
            class: "btn btn-primary reassign-save",
            type: "button",
            disabled: state === "saving" || !dirty,
            onclick: () => void store.save(ticketId, seed),
          },
          state === "saving" ? "saving…" : "Save",
        ),
        state === "saved" && !dirty
          ? h("span", { class: "reassign-saved dim" }, "saved")
          : null,
        failure
          ? h("span", { class: "error-inline reassign-failure" }, failure)
          : null,
      ),
      // An eligible ticket can still carry a caveat: an enlisted one says
      // which of its fields the engine holds fixed.
      view.reason
        ? h("div", { class: "dim reassign-note", key: "reassign-note" }, view.reason)
        : detail.enlisted
          ? h(
              "div",
              { class: "dim reassign-note", key: "reassign-note" },
              "this ticket runs as it was found: only its harness can be reassigned",
            )
          : null,
    );
  }

  private renderReadonlyField(
    label: string,
    value: string | null,
    source: AssignmentSource,
    empty: string = UNASSIGNED_LABEL,
  ): HTMLElement {
    return h(
      "div",
      { class: "reassign-readonly-field", key: `reassign-readonly-${label}` },
      h("span", { class: "reassign-field-label" }, label),
      h("span", { class: "reassign-readonly-value" }, value ?? empty),
      renderSource(source),
    );
  }

  // Effort is optional by nature: none set reads as the harness's own
  // default rather than as unassigned.
  private renderReadonlyEffort(detail: Extract<DetailView, { kind: "ticket" }>): HTMLElement {
    return this.renderReadonlyField(
      "effort",
      effortValue(detail.assignment),
      detail.reassign.sources.effort,
      "(harness default)",
    );
  }

  // One editable field: its label, the pill saying where the value in force
  // came from, a clear affordance while the ticket pins it, and the control.
  private renderReassignField(
    detail: Extract<DetailView, { kind: "ticket" }>,
    store: ReassignStore,
    seed: ReassignSeed,
    name: "harness" | "model" | "effort" | "drivers" | "verify",
    control: HTMLElement,
  ): HTMLElement {
    const source: AssignmentSource =
      name === "verify"
        ? detail.reassign.verify === null
          ? "unset"
          : "pinned"
        : detail.reassign.sources[name];
    const held = store.field(detail.ticketId, name, seed);
    return h(
      "label",
      { class: "reassign-edit-field", key: `reassign-field-${name}` },
      h(
        "span",
        { class: "reassign-field-label" },
        h("span", {}, name),
        renderSource(source),
        source === "pinned"
          ? h(
              "button",
              {
                class: "btn reassign-clear",
                key: `reassign-clear-${name}`,
                type: "button",
                disabled: held.trim() === "",
                title:
                  "clear this field so the ticket follows its parent or the pool defaults again",
                onclick: (event: Event) => {
                  event.preventDefault();
                  store.clearField(detail.ticketId, name, seed);
                },
              },
              "clear",
            )
          : null,
      ),
      control,
    );
  }

  // The Outcome tab: the summary and commit sha once the ticket has
  // finished, or a dim placeholder before then so the tab bar never
  // reshapes.
  private renderOutcomeTab(
    detail: Extract<DetailView, { kind: "ticket" }>,
  ): HTMLElement {
    const outcome = detail.outcome;
    if (!outcome) {
      return this.detailPanel(h("div", { class: "dim" }, "not finished yet"));
    }
    return this.detailPanel(
      h("pre", { class: "detail-pre" }, outcome.summary || "-"),
      outcome.commitSha
        ? h("div", { class: "dim" }, `commit ${outcome.commitSha}`)
        : null,
    );
  }

  // The Conversation Detail (ADR-0018): the card's facts at full size,
  // the terminal peek, the timeline (from the same /api/events?ticket=<id>
  // path a ticket uses), and End with an optional closing-line textarea.
  private renderConversationDetail(
    detail: ConversationDetailView,
    model: DetailModel,
    handlers: DetailHandlers,
  ): HTMLElement {
    const panel = h(
      "div",
      { class: "detail-body conversation-detail" },
      detail.steward ? renderStewardBadge() : null,
      detail.delivery ? renderDeliveryWarning(detail.delivery, { showError: true }) : null,
      h("div", { class: "dim" }, "assignment"),
      h(
        "div",
        { class: "card-text" },
        [
          detail.assignment.harness,
          detail.assignment.model,
          effortText(detail.assignment),
          detail.assignment.drivers,
        ]
          .filter((field): field is string => Boolean(field))
          .join(" · ") || UNASSIGNED_LABEL,
      ),
      h("div", { class: "dim" }, "status"),
      h(
        "div",
        { class: `detail-status conversation-turn-${detail.turn.state}` },
        detail.status === "live"
          ? conversationTurnLabel(detail.turn.state)
          : detail.status,
      ),
    );
    if (detail.status === "live") {
      panel.append(
        h(
          "div",
          { class: "dim conversation-detail-last-line" },
          detail.turn.lastLine || "(no Turn yet)",
        ),
      );
      if (detail.idleAge) {
        panel.append(h("div", { class: "dim" }, `idle ${detail.idleAge}`));
      }
    } else if (detail.branch) {
      panel.append(h("div", { class: "dim" }, `branch ${detail.branch}`));
    }
    if (detail.terminal) {
      panel.append(
        renderTerminalSurface(detail.terminal, {
          onFocus: () => handlers.onFocusConversationTerminal(detail.conversationId),
        }),
      );
    }
    if (model.timeline) {
      panel.append(
        this.renderTimelineSection(
          detail.conversationId,
          model.timeline,
          model.logPane,
          handlers,
          null,
        ),
      );
    }
    if (model.logPane && !model.logPane.neverRun) {
      panel.append(this.renderLogPane(model.logPane, detail.conversationId, handlers));
    }
    if (detail.status === "live") {
      panel.append(this.renderConversationEnd(detail, handlers));
    }
    return panel;
  }

  // End with an optional closing line: the operator's word to the
  // Conversation's parent (a Notice) or simply a record of why it ended.
  // Disables while the store's endView says a request is already out.
  private renderConversationEnd(
    detail: ConversationDetailView,
    handlers: DetailHandlers,
  ): HTMLElement {
    const closing = h("textarea", {
      class: "interrupt-note",
      placeholder: "closing note (optional)",
      rows: 2,
      disabled: detail.endView.ending,
      value: this.conversationEndDrafts.get(detail.conversationId) ?? "",
      oninput: (event: Event) => {
        this.conversationEndDrafts.set(
          detail.conversationId,
          (event.currentTarget as HTMLTextAreaElement).value,
        );
      },
    });
    const box = h(
      "div",
      { class: "interrupt-box conversation-end-box" },
      closing,
      h(
        "div",
        { class: "interrupt-actions" },
        h(
          "button",
          {
            class: "btn btn-danger",
            disabled: detail.endView.ending,
            onclick: () => {
              handlers.onEndConversation(
                detail.conversationId,
                closing.value.trim() || undefined,
              );
            },
          },
          detail.endView.ending ? "ending..." : "End",
        ),
      ),
    );
    if (detail.endView.failure) {
      box.append(h("div", { class: "error-inline" }, detail.endView.failure));
    }
    return box;
  }

  // A Pending or Held spawn's Detail (issue #150): the proposal whole, and
  // the Spawns list's own decisions, so the two never disagree about one in
  // flight. No Peek, logs or Assignment: it is not in the pool yet.
  private renderSpawnDetail(detail: SpawnDetailView, handlers: DetailHandlers): HTMLElement {
    const field = (label: string, value: string) => [
      h("div", { class: "dim" }, label),
      h("div", { class: "card-text" }, value),
    ];
    const blocks =
      detail.blocks === "all"
        ? "every ticket not yet started"
        : detail.blocks && detail.blocks.length > 0
          ? detail.blocks.join(", ")
          : null;
    return h(
      "div",
      { class: "detail-body spawn-detail" },
      h(
        "div",
        { class: `spawn-detail-state spawn-detail-${detail.state}` },
        `${detail.state === "pending" ? "Pending" : "Held"} spawn · ${detail.label}`,
      ),
      ...field("title", detail.title),
      ...field("from", detail.parentId),
      ...field("becomes", detail.spawnKind === "conversation" ? "a Conversation" : "a Ticket"),
      ...(detail.blockedBy.length > 0 ? field("blocked by", detail.blockedBy.join(", ")) : []),
      ...(blocks !== null ? field("blocks", blocks) : []),
      ...(detail.overlaps.length > 0 ? field("overlaps", detail.overlaps.join(", ")) : []),
      h("div", { class: "dim" }, "body"),
      h("div", { class: "card-text spawn-detail-body" }, detail.body),
      handlers.renderSpawnDecision(detail.row, detail.state),
    );
  }

  private renderUtilityDetail(
    detail: Extract<DetailView, { kind: "utility" }>,
    handlers: DetailHandlers,
  ): HTMLElement {
    const body = h(
      "div",
      { class: "detail-body" },
      h("div", { class: "dim" }, "kind"),
      h("div", { class: "card-text" }, "utility card"),
      h("div", { class: "dim" }, "label"),
      h("div", { class: "card-text" }, detail.label),
    );
    if (detail.interrupt) {
      body.append(this.renderInterrupt(detail.interrupt, handlers));
    }
    return body;
  }

  // -------------------------------------------------------------------------
  // Width drag and fullscreen
  // -------------------------------------------------------------------------

  private readStoredWidth(): number {
    try {
      return parseStoredDetailWidth(
        localStorage.getItem(DETAIL_WIDTH_KEY),
        currentMaxPx(),
      );
    } catch {
      // quota or private mode: the default width applies
      return DETAIL_MIN_PX;
    }
  }

  private writeStoredWidth(): void {
    try {
      localStorage.setItem(DETAIL_WIDTH_KEY, String(this.width));
    } catch {
      // quota or private mode: the width just will not persist
    }
  }

  private applyWidth(): void {
    const width = `${clampDetailWidth(this.width, currentMaxPx())}px`;
    for (const el of document.querySelectorAll<HTMLElement>(".detail-open")) {
      el.style.width = width;
    }
  }

  // One writer for the fullscreen toggle's label and tooltip, so the render
  // and the direct-DOM toggle stay in step.
  private setFullscreenToggleLabel(toggle: HTMLElement | null): void {
    if (!toggle) return;
    toggle.title = this.fullscreen ? "exit fullscreen" : "fill the window";
    toggle.textContent = this.fullscreen ? "restore" : "fullscreen";
  }

  private applyFullscreen(): void {
    const detail = document.querySelector<HTMLElement>(".detail-open");
    if (!detail) return;
    if (this.fullscreen) {
      detail.classList.add("detail-fullscreen");
      detail.style.width = "";
      detail.style.top = `${canvasHeaderBottom()}px`;
    } else {
      detail.classList.remove("detail-fullscreen");
      detail.style.top = "";
      detail.style.width = `${clampDetailWidth(this.width, currentMaxPx())}px`;
    }
    this.setFullscreenToggleLabel(
      document.querySelector(".detail-fullscreen-toggle"),
    );
  }

  private toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.applyFullscreen();
  }
}

function currentMaxPx(): number {
  return Math.round(window.innerWidth * DETAIL_MAX_FRACTION);
}

// The interrupt note's morph key, which is also how settleNoteFocus finds
// the ticket's note on the page.
function noteKey(ticketId: string): string {
  return `interrupt-note:${ticketId}`;
}

// The canvas-header's bottom edge in the window, the Detail's top while
// fullscreen. The header sits at the top of the main column, so its bottom
// is the height of the strip the fullscreen Detail must not cover.
function canvasHeaderBottom(): number {
  const header = document.querySelector<HTMLElement>(".canvas-header");
  return header ? header.getBoundingClientRect().bottom : 0;
}

// One grade under its attempt's graded event: the score and verdict on one
// line, the grader's reasons below. This is the "why the winner won" record,
// read from the same append-only events file after the run has ended. A Jev
// Grade (ADR-0023) also carries provenance, shown small and dim beside it, so
// a score always says which instrument produced it.
function renderGrade(grade: TimelineGradeView): HTMLElement {
  const provenance = [
    grade.rubric,
    grade.model,
    grade.evidenceBudget ? `${grade.evidenceBudget} evidence` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return h(
    "div",
    { class: "timeline-grade" },
    h(
      "span",
      { class: `timeline-grade-score grade-${grade.verdict}` },
      `${grade.score}/10 ${grade.verdict}`,
    ),
    h("span", { class: "timeline-grade-reasons" }, grade.reasons),
    ...(provenance.length
      ? [h("span", { class: "timeline-grade-provenance" }, provenance.join(" · "))]
      : []),
  );
}
