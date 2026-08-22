/**
 * Detail: the right-hand panel for the selected card. One module owns the
 * panel render, the width drag on its left edge, fullscreen, the interrupt
 * forms, and the note drafts, as instance state on the class the composition
 * root creates once per session. State survives the full-DOM rebuild on
 * every snapshot: the dragged width and the fullscreen flag re-apply to the
 * fresh panel, and a note being typed lives in the drafts map with focus and
 * cursor restored across the swap. Selection changes arrive through the
 * `onClose` callback and `exitFullscreen`; the composition owns the
 * selection itself.
 */

import {
  clampDetailWidth,
  DETAIL_MAX_FRACTION,
  DETAIL_MIN_PX,
  parseStoredDetailWidth,
  statusLabel,
  type DetailView,
  type InterruptAction,
  type InterruptView,
  type LogPaneView,
  type TimelineView,
} from "./project";
import { noteLogScroll } from "./log-pane";
import { h } from "./dom";

// One global localStorage key (not per pool) remembers the dragged width
// across reloads.
const DETAIL_WIDTH_KEY = "console-detail-width";

/** The slice of the app model the Detail renders from. */
export interface DetailModel {
  detail: DetailView | null;
  timeline: TimelineView | null;
  logPane: LogPaneView | null;
}

/** The handlers the Detail's interactive elements report through. */
export interface DetailHandlers {
  onSelectAttempt: (ticketId: string, attempt: number) => void;
  onLoadEarlier: (ticketId: string, attempt: number) => void;
  onAnswer: (ticketId: string, action: InterruptAction, note?: string) => void;
}

/** A note textarea's focus, captured before a rebuild and restored after. */
export interface NoteFocus {
  key: string;
  start: number;
  end: number;
}

export class Detail {
  private width = DETAIL_MIN_PX;
  private drag: { startX: number; startWidth: number } | null = null;
  // Fullscreen fixes the Detail over the content area below the toolbar
  // (canvas and drawers covered, toolbar visible and live) without
  // unmounting it, so SSE rebuilds, interrupt forms, and log tailing all
  // keep working. Esc, the toggle, or selecting another card exits; exiting
  // restores the dragged width.
  private fullscreen = false;
  // Interrupt note drafts, keyed by ticket id, so a snapshot re-render
  // (siblings keep running while an interrupt waits) never wipes a note
  // being typed. Drafts are pruned when their interrupt resolves.
  private readonly drafts = new Map<string, string>();
  private readonly onClose: () => void;

  constructor(options: { onClose: () => void }) {
    this.onClose = options.onClose;
    if (typeof window !== "undefined") {
      this.width = clampDetailWidth(this.readStoredWidth(), currentMaxPx());
      // Esc leaves fullscreen; the toggle and card selection handle their own
      // exits, so this is the one path that must listen globally.
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.fullscreen) {
          this.fullscreen = false;
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
  }

  /** Drop an in-flight width drag: a full-DOM rebuild pulls the floor away. */
  cancelDrag(): void {
    this.drag = null;
  }

  /** Drop drafts whose interrupt resolved (or whose ticket left the pool). */
  pruneDrafts(pendingTicketIds: ReadonlySet<string>): void {
    for (const id of [...this.drafts.keys()]) {
      if (!pendingTicketIds.has(id)) this.drafts.delete(id);
    }
  }

  /**
   * Remember a note being typed before the rebuild: the text lives in the
   * drafts map, focus and cursor are restored after the swap.
   */
  captureNoteFocus(): NoteFocus | null {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.dataset.noteKey) {
      return {
        key: active.dataset.noteKey,
        start: active.selectionStart,
        end: active.selectionEnd,
      };
    }
    return null;
  }

  /** Restore a captured note focus onto the freshly rebuilt textarea. */
  restoreNoteFocus(root: HTMLElement, focus: NoteFocus | null): void {
    if (!focus) return;
    const next = root.querySelector<HTMLTextAreaElement>(
      `textarea[data-note-key="${CSS.escape(focus.key)}"]`,
    );
    if (next) {
      next.focus();
      next.setSelectionRange(
        Math.min(focus.start, next.value.length),
        Math.min(focus.end, next.value.length),
      );
    }
  }

  /** Re-apply fullscreen after a rebuild, so the panel never unmounts. */
  afterRender(): void {
    if (this.fullscreen) this.applyFullscreen();
  }

  render(model: DetailModel, handlers: DetailHandlers): HTMLElement {
    const detail = h("div", { class: "detail" });
    const view = model.detail;
    if (!view) return detail;
    detail.classList.add("detail-open");
    if (this.fullscreen) {
      detail.classList.add("detail-fullscreen");
    } else {
      detail.style.width = `${clampDetailWidth(this.width, currentMaxPx())}px`;
    }
    const title = view.kind === "ticket" ? view.ticketId : view.label;
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
        ? this.renderTicketDetail(view, model.timeline, model.logPane, handlers)
        : this.renderUtilityDetail(view, handlers),
    );
    return detail;
  }

  // The Detail's left edge as a drag handle, sitting between the canvas and
  // the panel. Rendered only while a Detail is open, so a closed panel
  // leaves no orphan strip.
  renderHandle(): HTMLElement {
    const handle = h("div", {
      class: "detail-handle",
      title: "drag to resize detail",
    });
    this.bindHandle(handle);
    return handle;
  }

  // -------------------------------------------------------------------------
  // Interrupt form
  // -------------------------------------------------------------------------

  // One interrupt form shape, rendered in the Detail: the only place an
  // interrupt is read and answered. The kind-specific body comes from the
  // engine: a checkpoint's Brief, a crash's log path, a conflict's resolution
  // or attempt.
  private renderInterrupt(
    interrupt: InterruptView,
    handlers: DetailHandlers,
  ): HTMLElement {
    const box = h(
      "div",
      { class: "interrupt-box" },
      h("span", { class: "interrupt-kind" }, interrupt.form.title),
      h("pre", { class: "interrupt-body" }, interrupt.body || "(no details)"),
    );
    const note = h("textarea", {
      class: "interrupt-note",
      placeholder:
        interrupt.form.notePlaceholder ?? "note (optional, appended to the Issue)",
      "data-note-key": `${interrupt.ticketId}:detail`,
      rows: 3,
    }) as HTMLTextAreaElement;
    note.value = this.drafts.get(interrupt.ticketId) ?? "";
    note.addEventListener("input", () => {
      this.drafts.set(interrupt.ticketId, note.value);
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
                  this.drafts.get(interrupt.ticketId),
                ),
            },
            label,
          ),
        ),
      ),
    );
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
      const row = h(
        "div",
        {
          class:
            "timeline-attempt" +
            (attempt.running ? " timeline-attempt-running" : "") +
            (selected ? " timeline-attempt-selected" : ""),
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
          attempt.reconstructed ? h("span", { class: "dim" }, "reconstructed") : null,
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
              h("span", { class: "dim timeline-event-at" }, formatEventTime(event.at)),
            ),
          );
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
  // whether rebuilds follow the tail. While a fetch is in flight the
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
        h("span", { class: "dim" }, "raw log"),
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
      { class: "log-pane-content" },
      logPane.content.length > 0 ? logPane.content : "(no output yet)",
    );
    pre.addEventListener("scroll", () => {
      noteLogScroll(pre.scrollTop, pre.clientHeight, pre.scrollHeight);
    });
    pane.append(pre);
    if (logPane.hasMore) {
      pane.append(h("div", { class: "dim log-pane-more" }, "loading more..."));
    }
    return pane;
  }

  // A never-run ticket: the ticket's spec text in place of timeline and log,
  // with a "no attempts yet" marker, so clicking any ticket tells you
  // something.
  private renderNeverRun(logPane: LogPaneView): HTMLElement {
    const body = h("div", { class: "never-run" });
    body.append(h("div", { class: "dim never-run-marker" }, "no attempts yet"));
    if (logPane.spec) {
      body.append(
        h("div", { class: "dim" }, "spec"),
        h("pre", { class: "detail-pre never-run-spec" }, logPane.spec),
      );
    }
    return body;
  }

  private renderTicketDetail(
    detail: Extract<DetailView, { kind: "ticket" }>,
    timeline: TimelineView | null,
    logPane: LogPaneView | null,
    handlers: DetailHandlers,
  ): HTMLElement {
    const body = h("div", { class: "detail-body" });
    body.append(
      h("div", { class: "dim" }, "status"),
      h(
        "div",
        { class: `detail-status ticket-state-${detail.status}` },
        statusLabel(detail.status),
      ),
      h("div", { class: "dim" }, "blocked by"),
      h(
        "div",
        { class: "card-text" },
        detail.blockedBy.length > 0 ? detail.blockedBy.join(", ") : "none",
      ),
    );
    if (detail.interrupt) {
      body.append(this.renderInterrupt(detail.interrupt, handlers));
    }
    if (logPane?.neverRun) {
      // A never-run ticket shows its spec text with a "no attempts yet"
      // marker in place of timeline and log.
      body.append(this.renderNeverRun(logPane));
    } else {
      if (timeline) {
        body.append(
          this.renderTimelineSection(detail.ticketId, timeline, logPane, handlers),
        );
      }
      if (logPane) {
        body.append(this.renderLogPane(logPane, detail.ticketId, handlers));
      }
    }
    if (detail.outcome) {
      body.append(
        h("div", { class: "dim" }, "outcome"),
        h("pre", { class: "detail-pre" }, detail.outcome.summary || "-"),
      );
      if (detail.outcome.commitSha) {
        body.append(h("div", { class: "dim" }, `commit ${detail.outcome.commitSha}`));
      }
    }
    return body;
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

  private bindHandle(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      if (this.drag || this.fullscreen) return;
      this.drag = {
        startX: event.clientX,
        startWidth: clampDetailWidth(this.width, currentMaxPx()),
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // pointer already gone
      }
    });
    handle.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.startX;
      this.width = clampDetailWidth(this.drag.startWidth - dx, currentMaxPx());
      this.applyWidth();
    });
    handle.addEventListener("pointerup", () => {
      this.drag = null;
      this.writeStoredWidth();
    });
    handle.addEventListener("pointercancel", () => {
      this.drag = null;
    });
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

// The canvas-header's bottom edge in the window, the Detail's top while
// fullscreen. The header sits at the top of the main column, so its bottom
// is the height of the strip the fullscreen Detail must not cover.
function canvasHeaderBottom(): number {
  const header = document.querySelector<HTMLElement>(".canvas-header");
  return header ? header.getBoundingClientRect().bottom : 0;
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}
