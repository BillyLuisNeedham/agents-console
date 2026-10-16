/**
 * PROTOTYPE — throwaway. Three variants of an always-present Stop server
 * control, switchable via ?variant=, on the real Console header.
 *
 *   A  Header button, always on: the inline confirm names what dies.
 *   B  Floating kill switch: a fixed power pill over every overlay, with a
 *      popover listing what dies.
 *   C  Hold to stop: a stop chip in the status line, press and hold 1.5s.
 *
 * With no `?variant=` on the URL every export here is inert, so the real
 * Console behaves exactly as it does without this file. The stop itself is
 * a stub: nothing is sent, the page flips to a fake stopped state.
 * `&demo=armed` opens each variant's confirming state on load (the
 * screenshot hook): A armed, B's popover open, C frozen mid-hold;
 * `&demo=stopped` lands on the stub's stopped state.
 */

import { h } from "./dom";
import { commit } from "./morph";
import type { PoolCardView } from "./project";
import type { AppModel } from "./view";

export type StopVariant = "A" | "B" | "C";

const VARIANTS: StopVariant[] = ["A", "B", "C"];
const NAMES: Record<StopVariant, string> = {
  A: "Header button, always on",
  B: "Floating kill switch",
  C: "Hold to stop",
};
const HOLD_MS = 1500;

function params(): URLSearchParams | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.search);
}

/** The variant on the URL, or null: null means the real Console. */
export function prototypeVariant(): StopVariant | null {
  const v = params()?.get("variant")?.toUpperCase();
  return v === "A" || v === "B" || v === "C" ? v : null;
}

// ---------------------------------------------------------------------------
// State: the prototype's own, not the session's, so nothing real is touched.
// ---------------------------------------------------------------------------

const demoArmed = params()?.get("demo") === "armed";
let armed = demoArmed; // A's inline confirm, B's popover
let holding = demoArmed; // C's press in progress
let stubStopped = params()?.get("demo") === "stopped";
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let requestRender: () => void = () => {};
let keysBound = false;

function reset(): void {
  armed = false;
  holding = false;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}

function stubStop(variant: StopVariant, cost: StopCost): void {
  console.log(`[prototype-stop] variant ${variant}: stop requested (stubbed, nothing sent)`, cost);
  reset();
  stubStopped = true;
  requestRender();
}

// ---------------------------------------------------------------------------
// What a stop would kill, from the model's cards.
// ---------------------------------------------------------------------------

export interface StopCost {
  tickets: number;
  conversations: number;
  panes: number;
}

export function stopCost(cards: PoolCardView[]): StopCost {
  let tickets = 0;
  let conversations = 0;
  const panes = new Set<string>();
  for (const card of cards) {
    if (card.kind === "ticket" && card.hasLiveAttempt) {
      tickets += 1;
      if (card.paneId) panes.add(card.paneId);
    } else if (card.kind === "conversation" && card.status === "live") {
      conversations += 1;
      if (card.paneId) panes.add(card.paneId);
    }
  }
  return { tickets, conversations, panes: panes.size };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const isLive = (cost: StopCost): boolean => cost.tickets + cost.conversations > 0;

function costPhrase(cost: StopCost): string {
  const parts: string[] = [];
  if (cost.tickets) parts.push(`${plural(cost.tickets, "Ticket")} running`);
  if (cost.conversations) parts.push(`${plural(cost.conversations, "Conversation")} live`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The model, as the prototype bends it: offered on any phase, fake stopped.
// ---------------------------------------------------------------------------

/** Called at the top of ConsoleView.render; returns the model unchanged with no variant. */
export function prototypeModel(model: AppModel, onChange: () => void): AppModel {
  if (!prototypeVariant()) return model;
  requestRender = onChange;
  bindKeys();
  if (!stubStopped) return model;
  return {
    ...model,
    phase: "stopped",
    phaseLabel: "stopped",
    stop: { ...model.stop, offered: false, stoppedFromHere: true },
  };
}

function offered(model: { connected: boolean; phase: string | null }): boolean {
  return model.connected && !stubStopped && model.phase !== "stopped";
}

// ---------------------------------------------------------------------------
// Variant A: in .canvas-tools, every phase, the prompt names the cost.
// ---------------------------------------------------------------------------

/** Replaces renderStopControl's output while a variant is on; null for B and C. */
export function renderHeaderStop(model: {
  connected: boolean;
  phase: string | null;
  cards: PoolCardView[];
}): HTMLElement | null {
  if (prototypeVariant() !== "A" || !offered(model)) return null;
  const cost = stopCost(model.cards);
  if (armed) {
    const live = isLive(cost);
    return h(
      "div",
      { class: "canvas-stop canvas-stop-armed proto-a-armed" + (live ? " proto-a-live" : ""), key: "canvas-stop" },
      h(
        "span",
        { class: "canvas-stop-prompt proto-a-prompt" },
        live
          ? `Stop now? ${costPhrase(cost)} — their ${plural(cost.panes, "pane")} are killed.`
          : "Really stop?",
      ),
      h(
        "button",
        { class: "btn btn-danger", type: "button", onclick: () => stubStop("A", cost) },
        live ? "Stop and kill" : "Stop",
      ),
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            armed = false;
            requestRender();
          },
        },
        "Cancel",
      ),
    );
  }
  return h(
    "div",
    { class: "canvas-stop", key: "canvas-stop" },
    h(
      "button",
      {
        class: "btn btn-danger canvas-stop-server",
        type: "button",
        title: "stop this pool's server",
        onclick: () => {
          armed = true;
          requestRender();
        },
      },
      "Stop server",
    ),
  );
}

// ---------------------------------------------------------------------------
// Variant C: a stop chip on the status line, press and hold.
// ---------------------------------------------------------------------------

export function renderStatusChip(model: {
  connected: boolean;
  phase: string | null;
  cards: PoolCardView[];
}): HTMLElement | null {
  if (prototypeVariant() !== "C" || !offered(model)) return null;
  const cost = stopCost(model.cards);
  const live = isLive(cost);
  const release = (): void => {
    if (!holding || demoArmed) return;
    holding = false;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
    requestRender();
  };
  return h(
    "button",
    {
      class: "proto-c-chip" + (holding ? " proto-c-holding" : "") + (demoArmed ? " proto-c-demo" : ""),
      type: "button",
      key: "proto-c-chip",
      title: live
        ? `hold to stop the server: kills ${costPhrase(cost)}`
        : "hold to stop the server",
      onpointerdown: (event: PointerEvent) => {
        if (event.button !== 0) return;
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        holding = true;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => stubStop("C", cost), HOLD_MS);
        requestRender();
      },
      onpointerup: release,
      onpointercancel: release,
      onlostpointercapture: release,
      onkeydown: (event: KeyboardEvent) => {
        if ((event.key === " " || event.key === "Enter") && !holding) {
          event.preventDefault();
          holding = true;
          holdTimer = setTimeout(() => stubStop("C", cost), HOLD_MS);
          requestRender();
        }
      },
      onkeyup: release,
    },
    h("span", { class: "proto-c-fill" }),
    h("span", { class: "proto-c-glyph" }, "■"),
    h(
      "span",
      { class: "proto-c-label" },
      holding ? "release to cancel" : live ? `hold to stop · ${cost.tickets + cost.conversations} live` : "hold to stop",
    ),
  );
}

// ---------------------------------------------------------------------------
// Overlay host: variant B's pill, the switcher, the stub notice. On <body>,
// outside the app's morph root, so it sits over every overlay.
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;

/** Called at the end of ConsoleView.render. */
export function syncPrototypeOverlay(model: AppModel): void {
  const variant = prototypeVariant();
  if (!variant) return;
  ensureStyles();
  if (!host) {
    host = document.createElement("div");
    host.id = "proto-stop-host";
    document.body.appendChild(host);
  }
  commit(host, () =>
    h(
      "div",
      { class: "proto-host" },
      variant === "B" ? renderFloating(model) : null,
      stubStopped
        ? h(
            "div",
            { class: "proto-stub-note" },
            "stopped (prototype stub) — no request was sent. ",
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () => {
                  stubStopped = false;
                  requestRender();
                },
              },
              "undo",
            ),
          )
        : null,
      renderSwitcher(variant),
    ),
  );
}

function renderFloating(model: AppModel): HTMLElement | null {
  if (!offered(model)) return null;
  const cost = stopCost(model.cards);
  const live = isLive(cost);
  const close = (): void => {
    armed = false;
    requestRender();
  };
  return h(
    "div",
    { class: "proto-b", key: "proto-b" },
    armed
      ? h(
          "div",
          { class: "proto-b-pop" + (live ? " proto-b-live" : ""), role: "dialog" },
          h("div", { class: "proto-b-title" }, live ? "Stop the server now?" : "Stop the server?"),
          live
            ? h(
                "ul",
                { class: "proto-b-list" },
                h("li", {}, h("b", {}, String(cost.tickets)), ` Ticket${cost.tickets === 1 ? "" : "s"} running`),
                h("li", {}, h("b", {}, String(cost.conversations)), ` Conversation${cost.conversations === 1 ? "" : "s"} live`),
                h("li", {}, h("b", {}, String(cost.panes)), ` herdr pane${cost.panes === 1 ? "" : "s"} killed`),
              )
            : h("div", { class: "proto-b-quiet" }, "Nothing is running. The pool is safe to stop."),
          h(
            "div",
            { class: "proto-b-actions" },
            h("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
            h(
              "button",
              { class: "btn btn-danger", type: "button", onclick: () => stubStop("B", cost) },
              live ? "Stop and kill" : "Stop",
            ),
          ),
        )
      : null,
    h(
      "button",
      {
        class: "proto-b-pill" + (live ? " proto-b-pill-live" : "") + (armed ? " proto-b-pill-open" : ""),
        type: "button",
        title: "stop this pool's server",
        onclick: () => {
          armed = !armed;
          requestRender();
        },
      },
      h("span", { class: "proto-b-icon" }, "⏻"),
      h("span", {}, "Stop server"),
      live ? h("span", { class: "proto-b-count" }, String(cost.tickets + cost.conversations)) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// The switcher: bottom-centre, deliberately loud.
// ---------------------------------------------------------------------------

function cycle(step: number): void {
  const current = prototypeVariant() ?? "A";
  const next = VARIANTS[(VARIANTS.indexOf(current) + step + VARIANTS.length) % VARIANTS.length]!;
  const search = new URLSearchParams(location.search);
  search.set("variant", next);
  search.delete("demo");
  history.replaceState(null, "", `${location.pathname}?${search.toString()}${location.hash}`);
  reset();
  requestRender();
}

function renderSwitcher(variant: StopVariant): HTMLElement {
  return h(
    "div",
    { class: "proto-switch", key: "proto-switch" },
    h("button", { type: "button", title: "previous variant (←)", onclick: () => cycle(-1) }, "←"),
    h("span", { class: "proto-switch-label" }, `${variant} (${NAMES[variant]})`),
    h("button", { type: "button", title: "next variant (→)", onclick: () => cycle(1) }, "→"),
  );
}

function bindKeys(): void {
  if (keysBound || typeof window === "undefined") return;
  keysBound = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
    event.preventDefault();
    cycle(event.key === "ArrowLeft" ? -1 : 1);
  });
}

// ---------------------------------------------------------------------------
// Styles, injected only while a variant is on.
// ---------------------------------------------------------------------------

let styled = false;
function ensureStyles(): void {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* A */
.proto-a-live .proto-a-prompt { font-size: 12px; font-weight: 600; }
.proto-a-live { padding: 2px 4px 2px 8px; border: 1px solid var(--interrupt); border-radius: 4px;
  background: color-mix(in srgb, var(--interrupt) 12%, transparent); }

/* B */
.proto-b { position: fixed; bottom: 48px; left: 16px; z-index: 10000; display: flex;
  flex-direction: column-reverse; align-items: flex-start; gap: 8px; }
.proto-b-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px 6px 10px;
  border-radius: 999px; border: 1px solid #5a2a2a; background: #1c1214; color: #ffb4ae;
  font: 600 12px var(--mono); cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.5); }
.proto-b-pill:hover { background: #2a1517; border-color: var(--interrupt); }
.proto-b-pill-live { border-color: var(--interrupt); }
.proto-b-pill-open { background: var(--interrupt); color: #fff; }
.proto-b-icon { font-size: 15px; line-height: 1; }
.proto-b-count { min-width: 18px; padding: 0 5px; border-radius: 9px; background: var(--interrupt);
  color: #fff; font-size: 11px; text-align: center; }
.proto-b-pill-open .proto-b-count { background: #fff; color: var(--interrupt); }
.proto-b-pop { width: 260px; padding: 12px; border-radius: 8px; background: var(--bg-panel-2);
  border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.6); color: var(--text); font-size: 12px; }
.proto-b-live { border-color: var(--interrupt); }
.proto-b-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.proto-b-list { margin: 0 0 10px; padding: 0; list-style: none; display: grid; gap: 4px; color: var(--text-dim); }
.proto-b-list b { color: var(--interrupt); font-family: var(--mono); display: inline-block; min-width: 22px; }
.proto-b-quiet { color: var(--text-dim); margin-bottom: 10px; }
.proto-b-actions { display: flex; justify-content: flex-end; gap: 6px; }

/* C */
.proto-c-chip { position: relative; overflow: hidden; flex-shrink: 0; display: inline-flex; align-items: center;
  gap: 5px; padding: 2px 9px; border-radius: 999px; border: 1px solid #5a2a2a; background: transparent;
  color: #ff8f87; font: 600 11px var(--mono); cursor: pointer; user-select: none; touch-action: none; }
.proto-c-chip:hover { border-color: var(--interrupt); }
.proto-c-chip > :not(.proto-c-fill) { position: relative; }
.proto-c-fill { position: absolute; inset: 0; width: 0; background: color-mix(in srgb, var(--interrupt) 55%, transparent); }
.proto-c-holding { border-color: var(--interrupt); color: #fff; }
.proto-c-holding .proto-c-fill { animation: proto-c-fill ${HOLD_MS}ms linear forwards; }
.proto-c-demo .proto-c-fill { animation-delay: -${HOLD_MS * 0.6}ms; animation-play-state: paused; }
.proto-c-glyph { font-size: 9px; }
@keyframes proto-c-fill { from { width: 0; } to { width: 100%; } }

/* stub note */
.proto-stub-note { position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%); z-index: 10001;
  padding: 6px 10px; border-radius: 6px; background: #3b0d0d; border: 1px solid var(--interrupt);
  color: #fff; font: 12px var(--mono); }

/* switcher: loud on purpose, it is not the design */
.proto-switch { position: fixed; bottom: 44px; left: 50%; transform: translateX(-50%); z-index: 10002;
  display: inline-flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 999px;
  background: #ffe600; color: #000; border: 2px solid #000; box-shadow: 0 4px 18px rgba(0,0,0,.6);
  font: 700 13px var(--mono); }
.proto-switch button { width: 28px; height: 28px; border-radius: 50%; border: 2px solid #000; background: #000;
  color: #ffe600; font: 700 15px var(--mono); cursor: pointer; }
.proto-switch button:hover { background: #333; }
.proto-switch-label { padding: 0 4px; white-space: nowrap; }
`;
