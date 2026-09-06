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
import { homedir } from "node:os";
import { join } from "node:path";

/** The daemon's socket under the user's config dir; overridable per run (tests, other layouts). */
export const HERDR_SOCKET_DEFAULT = join(homedir(), ".config/herdr/herdr.sock");

/** Attempt tab labels cap at this many characters (`~40` per the spec). */
export const ATTEMPT_TAB_LABEL_MAX = 40;

interface HerdrResponse {
  result?: unknown;
  error?: unknown;
}

// Sockets of in-flight RPCs, held strongly until each settles: fire-and-
// forget callers (best-effort closes) hold no reference to the returned
// promise, and without this the runtime may collect the socket before its
// connection even completes, silently dropping the request.
const liveSockets = new Set<ReturnType<typeof connect>>();

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
    liveSockets.add(sock);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      liveSockets.delete(sock);
      sock.destroy();
      reject(new Error(`herdr rpc timed out (${method})`));
    }, 10_000);
    const finish = (err: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveSockets.delete(sock);
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    // Responses are newline-delimited, so the first complete line settles the
    // call: request/response RPCs close the socket right after, but a
    // blocking call may keep its connection open once the response line
    // lands, and a close-based reader would hang on it until the timeout.
    const parseLine = (): void => {
      const newline = buf.indexOf("\n");
      if (newline === -1) return;
      const line = buf.slice(0, newline);
      try {
        const msg = JSON.parse(line) as HerdrResponse;
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
        finish(new Error(`bad herdr response for ${method}: ${line}`));
      }
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "1", method, params }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
      parseLine();
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => {
      // A daemon that answered without a trailing newline (or died mid-write)
      // still settles here from whatever the socket carried.
      if (settled) return;
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

/**
 * The live pane ids herdr currently holds, from `pane.list`. Boot
 * reconciliation (ADR-0014) treats membership as liveness: a recorded attempt
 * pane that is not listed died with the daemon restart or was closed.
 */
export async function listPaneIds(socketPath: string): Promise<string[]> {
  const list = await herdrRpc(socketPath, "pane.list", {});
  const panes =
    typeof list === "object" && list !== null
      ? (list as { panes?: unknown }).panes
      : undefined;
  if (!Array.isArray(panes)) return [];
  return (panes as { pane_id?: unknown }[])
    .filter((p) => typeof p?.pane_id === "string")
    .map((p) => p.pane_id as string);
}

/**
 * Send input to a pane, exactly as the operator's keystrokes would land. Text
 * and keys travel in separate calls: a literal `\r` inside text is pasted
 * data, not a submit (verified herdr behaviour), so the caller sends the
 * command line as text and the Enter as a key.
 */
export async function paneSendInput(
  socketPath: string,
  paneId: string,
  input: { text?: string; keys?: string[] },
): Promise<void> {
  await herdrRpc(socketPath, "pane.send_input", { pane_id: paneId, ...input });
}

/**
 * How a pane's end was observed.
 * - "exited": the pane's process ended (`pane_exited`), the terminal-backed
 *   attempt's normal ending.
 * - "closed": the pane vanished without exiting (`pane_closed`, e.g. the
 *   operator closed the tab): the attempt is gone either way.
 * - "lost": the subscription could not be kept (daemon restart, or a daemon
 *   without `events.subscribe`): the caller must fall back to watching the
 *   attempt's own exit-code file.
 */
export type PaneEnd = "exited" | "closed" | "lost";

/**
 * Wait until the pane is gone, on herdr's `events.subscribe`: one connection
 * subscribes to `pane.exited` and `pane.closed` (verified live against herdr
 * 0.8.2; `events.wait` only supports agent-status matches, so a subscription
 * is the only event channel) and the first matching event settles the wait.
 * The daemon pushes every pane's events to every subscriber, so the filter is
 * client-side. Two backstops close the gaps a subscription cannot see: the
 * socket erroring settles "lost" (the caller falls back to the exit-code
 * file), and a pane already absent from `pane.list` when the subscription ack
 * lands settles "exited" (its end predated the subscription, so no event will
 * ever arrive). The liveness check runs only after the ack, so an end can
 * never slip between the check and the daemon registering the subscription.
 */
export function waitForPaneEnd(
  socketPath: string,
  paneId: string,
): Promise<PaneEnd> {
  return new Promise<PaneEnd>((resolve) => {
    let settled = false;
    const sock = connect(socketPath);
    liveSockets.add(sock);
    let buf = "";
    const release = (): void => {
      liveSockets.delete(sock);
      sock.destroy();
    };
    const settle = (end: PaneEnd): void => {
      if (settled) return;
      settled = true;
      release();
      resolve(end);
    };
    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          id: "1",
          method: "events.subscribe",
          params: {
            subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }],
          },
        }) + "\n",
      );
    });
    sock.on("data", (d) => {
      buf += d.toString();
      let newline: number;
      while ((newline = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, newline);
        buf = buf.slice(newline + 1);
        let msg: { event?: unknown; data?: { pane_id?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.event !== "string") {
          // The subscription ack: from here the daemon will push this pane's
          // ends, so only an end that predated the subscription can be
          // missed, and the liveness check below covers exactly that.
          void listPaneIds(socketPath)
            .then((ids) => {
              if (!ids.includes(paneId)) settle("exited");
            })
            .catch(() => {});
          continue;
        }
        if (msg.data?.pane_id !== paneId) continue; // another pane's event
        settle(msg.event === "pane_closed" ? "closed" : "exited");
        return;
      }
    });
    sock.on("error", () => settle("lost"));
    sock.on("close", () => settle("lost"));
  });
}

/**
 * Close a pane (`pane.close`). Best-effort: callers use it where a vanished
 * pane is already the expected state, so a rejection (daemon restart, pane
 * already gone) is not an error.
 */
export async function closePane(
  socketPath: string,
  paneId: string,
): Promise<void> {
  await herdrRpc(socketPath, "pane.close", { pane_id: paneId });
}

/**
 * Close a tab (`tab.close`), the engine's cleanup for a merged attempt's
 * terminal (ADR-0014: exited panes persist until merge, then close). Closing
 * the tab closes its panes with it.
 */
export async function closeTab(
  socketPath: string,
  tabId: string,
): Promise<void> {
  await herdrRpc(socketPath, "tab.close", { tab_id: tabId });
}
