/**
 * herdr socket client (ADR-0014, refined by ADR-0015): the engine's one
 * module that speaks to the herdr daemon.
 *
 * herdr speaks newline-delimited JSON-RPC over a unix socket, ONE REQUEST PER
 * CONNECTION: open a fresh connection, write `{"id":..,"method":..,
 * "params":..}\n`, read exactly one JSON line, then the daemon closes the
 * socket. Every call therefore connects anew (verified live against herdr
 * 0.8.2; the prototype at prototype/console-terminal-surface/ holds the raw
 * evidence).
 *
 * Terminal-backed attempts (pools configured `terminal: "herdr"`) each open
 * their own named tab at spawn time via `openAttemptTab`: the tab is created
 * unfocused in the attempt's worktree cwd and named `<ticket-id> ·
 * <ticket-title>` so the operator's tab bar reads as the roster of tickets in
 * flight. `tab.create` carries no root pane id (verified herdr behaviour), so
 * the pane id is recovered from `pane.list` filtered by the created tab's id,
 * and the engine records it on the attempt's `spawned` event.
 */

import { connect } from "node:net";

/** The daemon's socket on this machine; overridable per run (tests, other layouts). */
export const HERDR_SOCKET_DEFAULT = "/home/billy/.config/herdr/herdr.sock";

/** Attempt tab labels cap at this many characters (`~40` per the spec). */
export const ATTEMPT_TAB_LABEL_MAX = 40;

interface HerdrResponse {
  result?: unknown;
  error?: unknown;
}

/**
 * One JSON-RPC request over a fresh unix-socket connection. Resolves with the
 * `result` object; rejects with the herdr `error` body when the call fails,
 * and on timeout, socket error, or an unparseable response line.
 */
export function herdrRpc(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`herdr rpc timed out (${method})`));
    }, 10_000);
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "1", method, params }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => {
      try {
        const msg = JSON.parse(buf) as HerdrResponse;
        if (msg.error !== undefined) {
          const detail =
            typeof msg.error === "object" && msg.error !== null
              ? JSON.stringify(msg.error)
              : String(msg.error);
          finish(new Error(`${method} failed: ${detail}`));
        } else {
          finish(null, msg.result);
        }
      } catch {
        finish(new Error(`bad herdr response for ${method}: ${buf}`));
      }
    });
  });
}

/**
 * The attempt tab's label: `<ticket-id> · <ticket-title>`, capped at
 * ATTEMPT_TAB_LABEL_MAX characters so a long ticket title never blows up the
 * operator's tab bar.
 */
export function attemptTabLabel(ticketId: string, title: string): string {
  const label = `${ticketId} · ${title.trim()}`;
  return label.length > ATTEMPT_TAB_LABEL_MAX
    ? label.slice(0, ATTEMPT_TAB_LABEL_MAX)
    : label;
}

export interface AttemptTab {
  tabId: string;
  paneId: string;
}

/**
 * Open an attempt's named tab: `tab.create` unfocused in the attempt's
 * worktree cwd, then the root pane id recovered from `pane.list` filtered by
 * the created tab's id, because `tab.create` (and the `tab_created` event)
 * carries no root pane id (verified herdr behaviour). Throws when the daemon
 * errors or the response shapes do not hold; callers treat a throw as the
 * headless fallback (ADR-0014) and record the failure on the spawned event.
 */
export async function openAttemptTab(
  socketPath: string,
  label: string,
  cwd: string,
): Promise<AttemptTab> {
  const created = await herdrRpc(socketPath, "tab.create", {
    label,
    focus: false,
    cwd,
  });
  const tabId =
    typeof created === "object" && created !== null
      ? (created as { tab?: { tab_id?: unknown } }).tab?.tab_id
      : undefined;
  if (typeof tabId !== "string" || tabId === "") {
    throw new Error(`tab.create returned no tab id: ${JSON.stringify(created)}`);
  }
  const list = await herdrRpc(socketPath, "pane.list", {});
  const panes =
    typeof list === "object" && list !== null
      ? (list as { panes?: unknown }).panes
      : undefined;
  const pane = Array.isArray(panes)
    ? (panes as { tab_id?: unknown; pane_id?: unknown }[]).find(
        (p) => p?.tab_id === tabId,
      )
    : undefined;
  const paneId = pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`no pane found for new tab ${tabId}`);
  }
  return { tabId, paneId };
}
