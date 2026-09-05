// PROTOTYPE — throwaway, issue #29 terminal surface on real cards.
//
// Terminal-backed attempt surface: every running ticket card (or every card
// in ?demo=1) gets a read-only peek of a herdr pane, an "Open in herdr ➚"
// button (pane.focus via the bridge), and a copyable `herdr agent attach
// <pane_id>` chip. The engine has no pane_id anywhere — the pane ids are
// faked here: lazily spawned through the bridge's /api/spawn-fake-agent,
// capped at SPAWN_CAP total spawns (beyond that, pane ids are reused
// round-robin). Peeks poll the bridge every 2s per pane.
import { h } from "../dom";
import type { PrototypeRenderContext, PrototypeVariant } from "./index";
import "./variant-t.css";

const BRIDGE = "http://localhost:5299";
const PEEK_LINES = 6;
const POLL_MS = 2000;
const SPAWN_CAP = 4;

/** ticketId -> paneId. "" means the lazy spawn failed this session. */
const paneByTicket = new Map<string, string>();
/** Pane ids this session created, in creation order (the round-robin pool). */
const spawnedPanes: string[] = [];
/** How many pane assignments have been made (spawns + round-robin reuses). */
let spawnCount = 0;
/** In-flight spawn promises, so a re-render never double-spawns a ticket. */
const pendingSpawns = new Map<string, Promise<string | null>>();
/** paneId -> latest peek payload, kept across the full-DOM rebuilds. */
const peekByPane = new Map<string, { text: string; revision: number; truncated: boolean }>();
/** paneId -> poll interval; one poller per pane, never more. */
const pollers = new Map<string, number>();
/** ticketId -> transient note (focus/copy feedback) with its expiry. */
const notes = new Map<string, { text: string; until: number }>();

function noteFor(id: string, now: number): string | null {
  const n = notes.get(id);
  if (!n) return null;
  if (now >= n.until) {
    notes.delete(id);
    return null;
  }
  return n.text;
}

function flashNote(id: string, text: string): void {
  notes.set(id, { text, until: Date.now() + 2500 });
}

async function spawnFakeAgent(label: string): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE}/api/spawn-fake-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pane_id?: unknown };
    return typeof body?.pane_id === "string" ? body.pane_id : null;
  } catch {
    return null;
  }
}

async function focusPane(paneId: string): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE}/api/focus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function copyCommand(paneId: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(`herdr agent attach ${paneId}`);
    return true;
  } catch {
    return false;
  }
}

async function peekOnce(paneId: string): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE}/api/peek?pane_id=${encodeURIComponent(paneId)}&lines=${PEEK_LINES}`);
    if (!res.ok) return;
    const body = (await res.json()) as {
      text?: unknown;
      revision?: unknown;
      truncated?: unknown;
    };
    peekByPane.set(paneId, {
      text: typeof body?.text === "string" ? body.text : "",
      revision: Number(body?.revision ?? 0),
      truncated: !!body?.truncated,
    });
  } catch {
    // Keep the last payload; a card with nothing yet shows the placeholder.
  }
}

function startPolling(paneId: string): void {
  if (pollers.has(paneId)) return;
  void peekOnce(paneId);
  pollers.set(paneId, window.setInterval(() => void peekOnce(paneId), POLL_MS));
}

/** Resolve (and lazily spawn) the pane for a ticket. Deduped across renders. */
function ensurePane(ticketId: string, label: string): Promise<string | null> {
  const existing = paneByTicket.get(ticketId);
  if (existing !== undefined) return Promise.resolve(existing || null);
  const inFlight = pendingSpawns.get(ticketId);
  if (inFlight) return inFlight;
  const spawn = (async (): Promise<string | null> => {
    const idx = spawnCount;
    spawnCount += 1;
    let paneId: string;
    if (idx < SPAWN_CAP) {
      const fresh = await spawnFakeAgent(label);
      if (!fresh) {
        paneByTicket.set(ticketId, "");
        return null;
      }
      paneId = fresh;
      spawnedPanes.push(paneId);
      startPolling(paneId);
    } else {
      // Cap reached: reuse an existing pane id, round-robin.
      paneId = spawnedPanes[idx % SPAWN_CAP] ?? "";
    }
    paneByTicket.set(ticketId, paneId);
    return paneId || null;
  })();
  pendingSpawns.set(ticketId, spawn);
  void spawn.finally(() => pendingSpawns.delete(ticketId));
  return spawn;
}

function render(ctx: PrototypeRenderContext): void {
  const cards = ctx.root.querySelectorAll<HTMLElement>("[data-ticket-id]");
  for (const card of cards) {
    const id = card.dataset.ticketId;
    if (!id) continue;
    const body = card.querySelector(".node-card-body");
    body?.querySelector(".termproto")?.remove();
    if (!body) continue;
    const a = ctx.activity.get(id);
    // Decorate when the ticket is in-progress/running — or every card in demo
    // mode, so the surface is visible even when nothing is running.
    if (!ctx.demo && (!a || !a.running)) continue;

    // undefined → spawn not resolved yet (in flight); "" → spawn failed.
    const raw = paneByTicket.get(id);
    const spawning = raw === undefined;
    const paneId = raw === undefined ? null : raw;
    if (spawning) {
      // Kick off the lazy spawn; the 2s source tick will re-render with the
      // pane id. Only tickets that still decorate get one. Tab label matches
      // the ticket: "<id> · <title>" (title from the card's summary text).
      const title =
        card.querySelector(".ticket-card-summary")?.textContent?.trim() ?? "";
      const label = title ? `${id} · ${title}`.slice(0, 40) : id;
      void ensurePane(id, label);
    }

    const peek = paneId ? peekByPane.get(paneId) : undefined;
    const note = noteFor(id, ctx.now);
    const meta = paneId
      ? `pane ${paneId} · rev ${peek ? peek.revision : "—"}`
      : spawning
        ? "spawning pane…"
        : "no pane";
    const peekText = spawning
      ? "spawning pane…"
      : !paneId
        ? "pane unavailable — bridge not running?"
        : peek
          ? peek.text
          : "waiting for pane output…";

    const focusBtn = h(
      "button",
      {
        class: "termproto-focus",
        type: "button",
        disabled: !paneId,
        onclick: () => {
          if (!paneId) return;
          void focusPane(paneId).then((ok) =>
            flashNote(id, ok ? "focused in herdr" : "focus failed"),
          );
        },
      },
      "Open in herdr ➚",
    );

    const chip = h(
      "button",
      {
        class: "termproto-chip",
        type: "button",
        disabled: !paneId,
        title: "copy the attach command",
        onclick: () => {
          if (!paneId) return;
          void copyCommand(paneId).then((ok) =>
            flashNote(id, ok ? "copied" : "copy blocked — select manually"),
          );
        },
      },
      h("code", { class: "termproto-chip-cmd" }, "herdr agent attach "),
      h("span", { class: "termproto-chip-pane" }, paneId || (spawning ? "…" : "—")),
    );

    body.appendChild(
      h(
        "div",
        { class: "termproto" },
        h(
          "div",
          { class: "termproto-bar" },
          h("span", { class: "termproto-label" }, "terminal-backed attempt"),
          h("span", { class: "termproto-meta" }, meta),
        ),
        h("pre", { class: "termproto-peek" }, peekText),
        h(
          "div",
          { class: "termproto-row" },
          focusBtn,
          chip,
          note ? h("span", { class: "termproto-note" }, note) : null,
        ),
      ),
    );
  }
}

export const variantT: PrototypeVariant = {
  key: "T",
  name: "Terminal attempt",
  render,
};