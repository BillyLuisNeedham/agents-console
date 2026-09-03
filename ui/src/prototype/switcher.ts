import "./switcher.css";
import { h } from "../dom";
import type { PrototypeVariant } from "./index";

export interface SwitcherHandle {
  el: HTMLElement;
  dispose(): void;
}

export function mountSwitcher(opts: {
  onPrev: () => void;
  onNext: () => void;
}): SwitcherHandle {
  const label = h("span", { class: "proto-switcher-label" });
  const el = h(
    "div",
    { class: "proto-switcher" },
    h(
      "button",
      { class: "proto-switcher-arrow", type: "button", onclick: opts.onPrev },
      "‹",
    ),
    label,
    h(
      "button",
      { class: "proto-switcher-arrow", type: "button", onclick: opts.onNext },
      "›",
    ),
  );
  document.body.appendChild(el);
  return { el, dispose: () => el.remove() };
}

export function updateSwitcher(
  handle: SwitcherHandle,
  variant: PrototypeVariant,
): void {
  const label = handle.el.querySelector(".proto-switcher-label");
  if (label) label.textContent = `${variant.key} · ${variant.name}`;
}
