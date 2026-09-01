/**
 * PROTOTYPE (throwaway) — bulk resume UI, issue #27.
 *
 * Plan: three radically different bulk-resume UIs on the real canvas route,
 * switchable via ?variant=A|B|C (and the ←/→ arrow keys), over a stubbed
 * post-crash pool. Question being answered: where should bulk-resume
 * selection and per-ticket instructions live?
 *
 * The real ConsoleView renders the canvas and Detail from a fixture
 * snapshot; answers hit the ProtoPool stub (accept-now / drain-at-boundary),
 * never the network. Dev only: main.ts gates this mount behind
 * import.meta.env.DEV, so a stray merge cannot ship it.
 */

import "./prototype.css";
import { h } from "../dom";
import {
  phaseLabel,
  projectDetail,
  projectDetailTabs,
  projectPool,
  type PoolSnapshot,
  type TabOverride,
  type TicketCardView,
} from "../project";
import { ConsoleView, type AppModel, type Handlers } from "../view";
import { ProtoPool } from "./fixture";
import { applyVariant, VARIANTS, type PendingCard, type ProtoUiState, type VariantKey } from "./variants";

export function mountPrototype(root: HTMLElement, variantParam: string): void {
  document.title = "PROTOTYPE · bulk resume — agent-console";
  const pool = new ProtoPool();
  const view = new ConsoleView();
  const ui: ProtoUiState = {
    checked: new Set(),
    notes: new Map(),
    modalOpen: false,
    sharedNote: "",
  };
  const session = {
    selectedId: null as string | null,
    logOpen: false,
    inspectorOpen: false,
    tabOverride: null as TabOverride | null,
  };
  let current: VariantKey = VARIANTS.some((v) => v.key === variantParam)
    ? (variantParam as VariantKey)
    : "A";

  const select = (nodeId: string | null): void => {
    session.selectedId = nodeId;
    render();
  };

  function model(): AppModel {
    const snapshot: PoolSnapshot = pool.snapshot;
    const projected = projectPool(snapshot);
    const detail = session.selectedId
      ? projectDetail(snapshot, session.selectedId)
      : null;
    return {
      phase: projected.phase,
      phaseLabel: phaseLabel(projected.phase),
      cards: projected.cards,
      edges: projected.edges,
      log: projected.log,
      logOpen: session.logOpen,
      inspectorJson: JSON.stringify(snapshot.state, null, 2),
      inspectorOpen: session.inspectorOpen,
      connected: true,
      seq: snapshot.seq,
      error: null,
      detail,
      detailTabs:
        detail?.kind === "ticket"
          ? projectDetailTabs(detail, session.tabOverride)
          : null,
      detailBody: null,
      detailBodyError: null,
      timeline: null,
      logPane: null,
    };
  }

  function handlers(): Handlers {
    return {
      onToggleLog: () => {
        session.logOpen = !session.logOpen;
        render();
      },
      onToggleInspector: () => {
        session.inspectorOpen = !session.inspectorOpen;
        render();
      },
      onSelectNode: select,
      onSelectAttempt: () => {},
      onLoadEarlier: () => {},
      onAnswer: (ticketId, action, note) => {
        pool.acceptAnswer(ticketId, action, note);
      },
      onSelectTab: (ticketId, tab) => {
        session.tabOverride = { ticketId, tab };
        render();
      },
    };
  }

  function cycle(delta: number): void {
    const index = VARIANTS.findIndex((v) => v.key === current);
    current = VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key;
    ui.modalOpen = false;
    const url = new URL(window.location.href);
    url.searchParams.set("variant", current);
    window.history.replaceState(null, "", url);
    render();
  }

  function switcher(): HTMLElement {
    const variant = VARIANTS.find((v) => v.key === current) ?? VARIANTS[0];
    const waiting = pool.snapshot.state.queuedAnswers.length;
    return h(
      "div",
      { class: "proto-switcher" },
      h("span", { class: "proto-badge" }, "prototype"),
      h(
        "button",
        { class: "proto-switcher-btn", title: "previous variant (←)", onclick: () => cycle(-1) },
        "‹",
      ),
      h("span", { class: "proto-switcher-label" }, `${variant.key} · ${variant.name}`),
      h(
        "button",
        { class: "proto-switcher-btn", title: "next variant (→)", onclick: () => cycle(1) },
        "›",
      ),
      h("span", { class: "proto-switcher-state" }, `queued: ${waiting} — ${variant.blurb}`),
    );
  }

  function render(): void {
    view.render(root, model(), handlers());
    const pending = projectPool(pool.snapshot).cards.filter(
      (c): c is PendingCard =>
        c.kind === "ticket" && c.interrupt !== null,
    ) as (TicketCardView & { interrupt: NonNullable<TicketCardView["interrupt"]> })[];
    applyVariant(root, current, pending, { pool, render, select, state: ui });
    root.append(switcher());
  }

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest("input, textarea, [contenteditable]") !== null)
    ) {
      return;
    }
    if (event.key === "ArrowLeft") cycle(-1);
    if (event.key === "ArrowRight") cycle(1);
  });

  pool.subscribe(render);
  render();
}
