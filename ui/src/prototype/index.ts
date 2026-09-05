// PROTOTYPE (issue #25, throwaway): three activity-visualization variants on the existing canvas/Detail, switchable via ?variant=A|B|C, ?demo=1 for synthetic data.
import type { PoolSnapshot } from "../project";
import type { TicketActivity } from "./activity";
export type { TicketActivity } from "./activity";
import { PoolClient } from "../client";
import { createActivitySource } from "./source";
import {
  mountSwitcher,
  updateSwitcher,
  type SwitcherHandle,
} from "./switcher";
import { variantA } from "./variant-a";
import { variantB } from "./variant-b";
import { variantC } from "./variant-c";
import { variantT } from "./variant-t";

export interface PrototypeRenderContext {
  root: HTMLElement;
  activity: ReadonlyMap<string, TicketActivity>;
  demo: boolean;
  now: number;
}

export interface PrototypeVariant {
  key: string;
  name: string;
  render(ctx: PrototypeRenderContext): void;
}

export interface Prototype {
  afterRender(root: HTMLElement): void;
  update(snapshot: PoolSnapshot | null): void;
  dispose(): void;
}

const VARIANTS: PrototypeVariant[] = [variantA, variantB, variantC, variantT];

export function createPrototype(opts: {
  onNeedRender: () => void;
}): Prototype | null {
  const params = new URLSearchParams(location.search);
  // The prototype activates on ?variant= as before, and additionally on
  // ?termproto=1 (issue #29), which selects variant T by default.
  const termproto = params.get("termproto") === "1";
  if (!params.has("variant") && !termproto) return null;
  const demo = params.get("demo") === "1";
  const wanted = (params.get("variant") ?? (termproto ? "T" : "A")).toUpperCase();
  let current = VARIANTS.find((v) => v.key === wanted) ?? VARIANTS[0];

  const source = createActivitySource({
    client: new PoolClient(),
    demo,
    onTick: () => opts.onNeedRender(),
  });

  let switcher: SwitcherHandle | null = null;

  function select(index: number): void {
    current = VARIANTS[(index + VARIANTS.length) % VARIANTS.length];
    const next = new URLSearchParams(location.search);
    next.set("variant", current.key);
    history.replaceState(null, "", `${location.pathname}?${next}`);
    opts.onNeedRender();
  }

  function onKeydown(event: KeyboardEvent): void {
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
    else if (event.key === "ArrowRight") select(VARIANTS.indexOf(current) + 1);
  }
  window.addEventListener("keydown", onKeydown);

  return {
    afterRender(root) {
      current.render({
        root,
        activity: source.activity,
        demo,
        now: Date.now(),
      });
      if (!switcher) {
        switcher = mountSwitcher({
          onPrev: () => select(VARIANTS.indexOf(current) - 1),
          onNext: () => select(VARIANTS.indexOf(current) + 1),
        });
      }
      updateSwitcher(switcher, current);
    },
    update(snapshot) {
      source.update(snapshot);
    },
    dispose() {
      source.dispose();
      window.removeEventListener("keydown", onKeydown);
      switcher?.dispose();
      switcher = null;
    },
  };
}
