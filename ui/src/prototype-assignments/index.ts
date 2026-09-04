// PROTOTYPE (issue #35, throwaway): three variants of "which harness and model
// is assigned to which ticket" on the existing Console page, switchable via
// ?assignments=A|B|C, ?demo=1 for a synthetic assign config.
import type { PoolSnapshot } from "../project";
import { h } from "../dom";
import "./switcher.css";
import {
  demoConfig,
  readConfig,
  resolveAssignments,
  type ResolvedAssignment,
} from "./assignments";
import { variantA } from "./variant-a";
import { variantB } from "./variant-b";
import { variantC } from "./variant-c";

export interface AssignmentRenderContext {
  root: HTMLElement;
  assignments: ReadonlyMap<string, ResolvedAssignment>;
  demo: boolean;
  working: boolean;
}

export interface AssignmentVariant {
  key: string;
  name: string;
  render(ctx: AssignmentRenderContext): void;
  unmount?(): void;
}

export interface AssignmentsPrototype {
  afterRender(root: HTMLElement): void;
  update(snapshot: PoolSnapshot | null): void;
  dispose(): void;
}

const VARIANTS: AssignmentVariant[] = [variantA, variantB, variantC];

interface SwitcherHandle {
  el: HTMLElement;
  dispose(): void;
}

function mountSwitcher(opts: {
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

function updateSwitcher(
  handle: SwitcherHandle,
  variant: AssignmentVariant,
): void {
  const label = handle.el.querySelector(".proto-switcher-label");
  if (label) label.textContent = `${variant.key} · ${variant.name}`;
}

export function createAssignmentsPrototype(opts: {
  onNeedRender: () => void;
}): AssignmentsPrototype | null {
  const params = new URLSearchParams(location.search);
  if (!params.has("assignments")) return null;
  const demo = params.get("demo") === "1";
  const working = params.get("working") === "1";
  const wanted = (params.get("assignments") ?? "A").toUpperCase();
  let current = VARIANTS.find((v) => v.key === wanted) ?? VARIANTS[0];

  let snapshot: PoolSnapshot | null = null;
  let switcher: SwitcherHandle | null = null;

  function assignments(): ReadonlyMap<string, ResolvedAssignment> {
    if (!snapshot) return new Map();
    const ids = snapshot.state.tickets.map((t) => t.id);
    const config = demo ? demoConfig(ids) : readConfig(snapshot.state.config);
    return resolveAssignments(ids, config);
  }

  function select(index: number): void {
    current.unmount?.();
    current = VARIANTS[(index + VARIANTS.length) % VARIANTS.length];
    const next = new URLSearchParams(location.search);
    next.set("assignments", current.key);
    history.replaceState(null, "", `${location.pathname}?${next}`);
    opts.onNeedRender();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!params.has("variant")) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") select(VARIANTS.indexOf(current) - 1);
      else if (event.key === "ArrowRight")
        select(VARIANTS.indexOf(current) + 1);
    }
  }
  window.addEventListener("keydown", onKeydown);

  return {
    afterRender(root) {
      current.render({ root, assignments: assignments(), demo, working });
      if (!switcher) {
        switcher = mountSwitcher({
          onPrev: () => select(VARIANTS.indexOf(current) - 1),
          onNext: () => select(VARIANTS.indexOf(current) + 1),
        });
      }
      updateSwitcher(switcher, current);
    },
    update(next) {
      snapshot = next;
    },
    dispose() {
      current.unmount?.();
      window.removeEventListener("keydown", onKeydown);
      switcher?.dispose();
      switcher = null;
    },
  };
}
