// PROTOTYPE — throwaway
/**
 * Prototype plumbing for the ticket-detail view variants (issue #11 "See
 * ticket details"): reads the ?variant= URL param and renders a floating
 * switcher pill that cycles the variant keys with wraparound. Cycling
 * rewrites the URL via history.replaceState and fires a window-level
 * `proto-variant-change` event so the app can re-render in the new variant.
 * The same cycle is reachable from the ←/→ keys, bound exactly once.
 */

import { h } from "../view";

const SWITCHER_CLASS = "proto-switcher";

// Module state shared between the pill's buttons and the once-bound keyboard
// handler, so cycling always works on the variant set last rendered.
let lastKeys: string[] = [];
let lastCurrent = "";
let keyboardBound = false;

/** The ?variant= param as an uppercase key, or null when absent. */
export function currentVariant(): string | null {
  const raw = new URLSearchParams(location.search).get("variant");
  return raw ? raw.toUpperCase() : null;
}

function applyVariant(key: string): void {
  lastCurrent = key;
  const params = new URLSearchParams(location.search);
  params.set("variant", key);
  history.replaceState(
    null,
    "",
    `${location.pathname}?${params.toString()}${location.hash}`,
  );
  window.dispatchEvent(new Event("proto-variant-change"));
}

function cycle(direction: 1 | -1): void {
  if (lastKeys.length === 0) return;
  let index = lastKeys.indexOf(lastCurrent);
  if (index === -1) index = 0;
  const next = (index + direction + lastKeys.length) % lastKeys.length;
  applyVariant(lastKeys[next]);
}

// Bound once per page load; later renders refresh lastKeys/lastCurrent so the
// keys stay in step with the pill. Skipped while typing in a field.
function bindKeyboardOnce(): void {
  if (keyboardBound) return;
  keyboardBound = true;
  window.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.matches("input, textarea") || target.isContentEditable) return;
    }
    event.preventDefault();
    cycle(event.key === "ArrowLeft" ? -1 : 1);
  });
}

/**
 * The floating variant switcher pill: `◀  <current> — <name>  ▶`, fixed
 * bottom-center. Names come from the optional map, falling back to the key.
 */
export function renderPrototypeSwitcher(
  current: string,
  keys: string[],
  names?: Record<string, string>,
): HTMLElement {
  lastKeys = keys;
  lastCurrent = current;
  bindKeyboardOnce();
  const label = `${current} — ${names?.[current] ?? current}`;
  return h(
    "div",
    { class: SWITCHER_CLASS, title: "prototype detail variants" },
    h(
      "button",
      { class: "proto-switcher-arrow", onclick: () => cycle(-1), "aria-label": "previous variant" },
      "←",
    ),
    h("span", { class: "proto-switcher-label" }, label),
    h(
      "button",
      { class: "proto-switcher-arrow", onclick: () => cycle(1), "aria-label": "next variant" },
      "→",
    ),
  );
}