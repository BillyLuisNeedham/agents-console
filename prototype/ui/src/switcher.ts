/**
 * Floating variant switcher — fixed bottom-center pill, high contrast + shadow
 * so it is obviously not part of the design. Cycles A → B → C → A via arrows
 * or ← / → keys (ignored while an input/textarea/contenteditable is focused).
 */

import type { VariantDef } from "./main";

export function mountSwitcher(
  currentId: string,
  variants: VariantDef[],
  onSelect: (id: string) => void,
): void {
  const bar = document.createElement("div");
  bar.className = "switcher";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Prototype variant switcher");

  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "←";
  prev.title = "Previous variant";
  prev.setAttribute("aria-label", "Previous variant");

  const label = document.createElement("span");
  label.className = "switcher-label";

  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "→";
  next.title = "Next variant";
  next.setAttribute("aria-label", "Next variant");

  const update = (): void => {
    const current = variants.find((v) => v.id === currentId) ?? variants[0];
    label.textContent = `${current.id} — ${current.label}`;
  };

  const cycle = (dir: number): void => {
    const index = variants.findIndex((v) => v.id === currentId);
    if (index < 0) return;
    const target = variants[(index + dir + variants.length) % variants.length];
    if (!target) return;
    currentId = target.id;
    update();
    onSelect(target.id);
  };

  prev.addEventListener("click", () => cycle(-1));
  next.addEventListener("click", () => cycle(1));
  update();
  bar.append(prev, label, next);
  document.body.appendChild(bar);

  const isEditable = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    );
  };

  window.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (isEditable(event.target)) return;
    event.preventDefault();
    cycle(event.key === "ArrowLeft" ? -1 : 1);
  });
}
