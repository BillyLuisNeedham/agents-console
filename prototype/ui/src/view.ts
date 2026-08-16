/**
 * DOM rendering: a thin layer over the view model from project.ts. All data
 * flows in through `renderApp`; all user intent flows out through `Handlers`.
 */

import type { ChannelView, ThreadSummary, TicketView } from "./project";

export interface AppModel {
  threads: ThreadSummary[];
  showAll: boolean;
  selectedId: string | null;
  channels: ChannelView[];
  log: string[];
  logOpen: boolean;
  error: string | null;
}

export interface Handlers {
  onSelectThread: (threadId: string) => void;
  onToggleShowAll: (showAll: boolean) => void;
  onToggleLog: () => void;
  onRefresh: () => void;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "checked" || key === "disabled" || key.startsWith("on")) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const kid of kids) {
    if (kid == null) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

// ---------------------------------------------------------------------------
// Left rail: thread list + show-all toggle
// ---------------------------------------------------------------------------

function renderRail(model: AppModel, handlers: Handlers): HTMLElement {
  const toggle = h("input", { type: "checkbox", checked: model.showAll }) as HTMLInputElement;
  toggle.addEventListener("change", () => handlers.onToggleShowAll(toggle.checked));

  const list = h("div", { class: "thread-list" });
  if (model.threads.length === 0) {
    list.append(h("div", { class: "dim" }, model.showAll ? "no threads" : "no Console threads yet"));
  }
  for (const t of model.threads) {
    const meta = h("span", {}, t.status);
    if (t.interruptCount > 0) {
      meta.append(
        h("span", {
          class: "dot dot-interrupt",
          title: `${t.interruptCount} pending interrupt${t.interruptCount === 1 ? "" : "s"}`,
        }),
      );
    }
    list.append(
      h(
        "div",
        {
          class: "thread-item" + (t.threadId === model.selectedId ? " thread-active" : ""),
          onclick: () => handlers.onSelectThread(t.threadId),
        },
        h("div", { class: "thread-label" }, t.label),
        h("div", { class: "thread-meta" }, h("span", {}, t.origin), meta),
      ),
    );
  }

  return h(
    "div",
    { class: "rail" },
    h(
      "div",
      { class: "rail-head" },
      h("h2", {}, "Threads"),
      h("label", { class: "dim checkrow" }, toggle, "show all"),
      h("button", { class: "btn", onclick: () => handlers.onRefresh() }, "refresh"),
    ),
    list,
  );
}

// ---------------------------------------------------------------------------
// Main panel: the selected thread's channels, as a plain list
// ---------------------------------------------------------------------------

function ticketRow(t: TicketView): HTMLElement {
  return h(
    "div",
    { class: "ticket-row" },
    h("span", { class: `chip chip-${t.status}` }, t.id),
    h("span", { class: "dim" }, t.title),
    t.blockedBy.length > 0 ? h("span", { class: "dim" }, `after ${t.blockedBy.join(", ")}`) : null,
  );
}

function renderChannel(channel: ChannelView): HTMLElement {
  const body =
    channel.kind === "tickets"
      ? h(
          "div",
          { class: "channel-body" },
          ...(channel.tickets.length > 0
            ? channel.tickets.map(ticketRow)
            : [h("span", { class: "dim" }, "(empty)")]),
        )
      : channel.kind === "pre"
        ? h("pre", { class: "channel-body channel-pre" }, channel.text)
        : channel.kind === "json"
          ? h("pre", { class: "channel-body channel-pre" }, channel.json)
          : h("div", { class: "channel-body" }, channel.text);
  return h("section", { class: "channel" }, h("h3", { class: "channel-name" }, channel.name), body);
}

function renderMain(model: AppModel): HTMLElement {
  const main = h("div", { class: "main" });
  if (model.error) {
    main.append(h("div", { class: "error" }, model.error));
    return main;
  }
  if (!model.selectedId) {
    main.append(h("div", { class: "dim placeholder" }, "select a thread"));
    return main;
  }
  if (model.channels.length === 0) {
    main.append(h("div", { class: "dim placeholder" }, "thread has no state yet"));
    return main;
  }
  main.append(...model.channels.map(renderChannel));
  return main;
}

// ---------------------------------------------------------------------------
// Bottom drawer: the log channel, collapsible
// ---------------------------------------------------------------------------

function renderLogDrawer(model: AppModel, handlers: Handlers): HTMLElement {
  const lines = model.log.length > 0 ? model.log.join("\n") : "— no log lines yet —";
  return h(
    "div",
    { class: "log-drawer" + (model.logOpen ? " log-open" : "") },
    h(
      "button",
      { class: "log-bar", onclick: () => handlers.onToggleLog() },
      `log (${model.log.length}) ${model.logOpen ? "▾" : "▴"}`,
    ),
    model.logOpen ? h("pre", { class: "log-lines" }, lines) : null,
  );
}

// ---------------------------------------------------------------------------

export function renderApp(root: HTMLElement, model: AppModel, handlers: Handlers): void {
  const content = h("div", { class: "content" }, renderRail(model, handlers), renderMain(model));
  root.replaceChildren(h("div", { class: "shell" }, content, renderLogDrawer(model, handlers)));
}
