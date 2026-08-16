/**
 * Console (prototype) — entry point.
 *
 * Reads `?variant=` (default "A"), loads the ShellContext (live or mock), and
 * renders the matching variant into #app, plus the floating switcher.
 */

import "./styles.css";
import { loadContext, type ShellContext } from "./data";
import { mountSwitcher } from "./switcher";
import { VariantA } from "./variants/VariantA";
import { VariantB } from "./variants/VariantB";
import { VariantC } from "./variants/VariantC";

export type VariantRender = (root: HTMLElement, ctx: ShellContext) => void;

export interface VariantDef {
  id: string;
  label: string;
  render: VariantRender;
}

export const VARIANTS: VariantDef[] = [
  { id: "A", label: "Thread List", render: VariantA },
  { id: "B", label: "Tabbed Ops", render: VariantB },
  { id: "C", label: "Graph View", render: VariantC },
];

const appRoot = document.getElementById("app");
if (!appRoot) throw new Error("#app not found");
const root: HTMLElement = appRoot;

let ctx: ShellContext | null = null;

function currentVariantId(): string {
  const id = new URLSearchParams(window.location.search).get("variant");
  return id && VARIANTS.some((v) => v.id === id) ? id : "A";
}

function renderVariant(id: string): void {
  if (!ctx) return;
  const def = VARIANTS.find((v) => v.id === id) ?? VARIANTS[0];
  root.replaceChildren();
  def.render(root, ctx);
}

async function rerender(id: string): Promise<void> {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", id);
  window.history.replaceState({}, "", url);
  renderVariant(id);
}

async function main(): Promise<void> {
  ctx = await loadContext();
  renderVariant(currentVariantId());
  mountSwitcher(currentVariantId(), VARIANTS, (id) => void rerender(id));
}

void main();
