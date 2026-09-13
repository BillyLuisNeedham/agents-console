/**
 * herdr socket client (ADR-0014, refined by ADR-0015): the engine's one
 * module that speaks to the herdr daemon.
 *
 * herdr speaks newline-delimited JSON-RPC over a unix socket, ONE REQUEST PER
 * CONNECTION: open a fresh connection, write `{"id":..,"method":..,
 * "params":..}\n`, read exactly one JSON line, then the daemon closes the
 * socket. Every call therefore connects anew (verified live against herdr
 * 0.8.2; the prototype-verified quirks are recorded in
 * docs/adr/0015-attempts-spawn-as-named-herdr-tabs.md).
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

// How long a call waits on the daemon before giving up on it: every RPC's
// watchdog, and the grace a settled pane-end wait gives a connect that has
// not completed before destroying the socket anyway.
const CONNECT_GRACE_MS = 10_000;

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
    }, CONNECT_GRACE_MS);
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
 * Read a pane's recent output for the card's read-only peek: `pane.read`
 * with source `recent`, text format, ANSI stripped, a small line count.
 * Resolves with the text; an empty read (a freshly created background tab
 * returns empty for its first seconds while herdr warms up its viewport,
 * verified behaviour) resolves to empty text, never an error. `revision`
 * is deliberately not part of the return: the prototype verified it stays
 * stagnant while output grows, so freshness comes from re-polling and
 * comparing text, never from the revision counter.
 */
export async function peekPane(
  socketPath: string,
  paneId: string,
  lines: number,
): Promise<string> {
  const res = await herdrRpc(socketPath, "pane.read", {
    pane_id: paneId,
    source: "recent",
    format: "text",
    strip_ansi: true,
    lines,
  });
  const read = (res as { read?: { text?: unknown } } | null)?.read;
  return typeof read?.text === "string" ? read.text : "";
}

/**
 * Focus the pane's tab in the operator's herdr TUI: one `pane.focus` call.
 * The pool server only ever names a pane the engine's own snapshot records
 * as a live attempt's or a live Conversation's (server.ts), so this can
 * never yank the TUI to an unrelated live agent session sharing the daemon.
 */
export async function focusPane(
  socketPath: string,
  paneId: string,
): Promise<void> {
  await herdrRpc(socketPath, "pane.focus", { pane_id: paneId });
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
 *   without `events.subscribe`). Says only that this observation is over,
 *   never that the attempt is.
 */
export type PaneEnd = "exited" | "closed" | "lost";

/**
 * Wait until the pane is gone, on herdr's `events.subscribe`: one connection
 * subscribes to `pane.exited`, `pane.closed` and `tab.closed` (verified live
 * against herdr 0.8.2; `events.wait` only supports agent-status matches, so
 * a subscription is the only event channel) and the first matching event
 * settles the wait. The daemon pushes every pane's events to every
 * subscriber, so the filter is client-side. Three backstops close the gaps a
 * subscription cannot see: the socket ending, erroring or closing settles
 * "lost"; a pane already absent from `pane.list` when the subscription ack
 * lands settles "exited" (its end predated the subscription, so no event
 * will ever arrive); and the optional release signal settles "lost" for a
 * caller that found the attempt's ending somewhere else and wants its
 * connection back. The liveness check runs only after the ack, so an end can
 * never slip between the check and the daemon registering the subscription.
 *
 * `tab.closed` is subscribed because a closed tab takes its panes silently
 * (verified against herdr 0.8.2, issue #61): `tab.close` pushes one
 * `tab_closed` carrying the tab id and no `pane_closed` for any pane in it,
 * while `pane.close` does push `pane_closed`. The event carries no pane id,
 * so a `tab_closed` for any tab re-checks `pane.list`: the pane gone from
 * the listing settles "closed", the pane still listed was another tab's.
 * The daemon drops the panes from its listing before it answers
 * `tab.close`, and pushes `tab_closed` tens of milliseconds after that
 * answer (verified six of six live closes), so the re-read never sees the
 * pane it is about to lose. Without that, an operator closing an attempt's
 * tab left this wait parked for good.
 *
 * "lost" says only that this observation is over, never that the attempt is:
 * the pane may still be running and the daemon merely unreachable. What a
 * caller does about that is the caller's, and this module has no opinion on
 * it, because it has no knowledge of anything the attempt writes.
 *
 * Every way the connection can go must settle it, because whatever does not
 * settle it parks it: an attempt that had finished and written its exit code
 * was left reading `running` for 98 minutes on a wait that nothing could
 * reach. A peer's FIN raises "end", so "end" settles too.
 *
 * The socket is torn down only once its connect has completed or failed. A
 * release that lands while the connect is still in flight resolves the wait
 * at once but leaves the socket to be destroyed from its own connect (or
 * error) callback: destroying a socket whose connect is pending is the one
 * lifecycle this module ever ran that the runtime's event loop was not
 * asked to survive, and the terminal-backed boot that segfaulted Bun inside
 * its poll dispatch (issue #61) is the reason the module no longer runs it.
 */
export function waitForPaneEnd(
  socketPath: string,
  paneId: string,
  releaseSignal?: AbortSignal,
): Promise<PaneEnd> {
  return new Promise<PaneEnd>((resolve) => {
    if (releaseSignal?.aborted) {
      resolve("lost");
      return;
    }
    let settled = false;
    let connecting = true;
    let connectGrace: ReturnType<typeof setTimeout> | null = null;
    const sock = connect(socketPath);
    liveSockets.add(sock);
    let buf = "";
    const onRelease = (): void => settle("lost");
    const teardown = (): void => {
      if (connectGrace !== null) clearTimeout(connectGrace);
      connectGrace = null;
      liveSockets.delete(sock);
      sock.destroy();
    };
    const connected = (): void => {
      connecting = false;
      if (connectGrace !== null) clearTimeout(connectGrace);
      connectGrace = null;
    };
    const settle = (end: PaneEnd): void => {
      if (settled) return;
      settled = true;
      releaseSignal?.removeEventListener("abort", onRelease);
      if (connecting) {
        // Settled mid-connect: the connect callback tears the socket down.
        // A connect that never completes (a socket file whose daemon is
        // wedged) would otherwise hold the socket forever, so the same
        // watchdog herdrRpc keeps bounds the wait for it; past that, the
        // connect is hung, not pending, and destroying it is the way out.
        connectGrace = setTimeout(teardown, CONNECT_GRACE_MS);
      } else {
        teardown();
      }
      resolve(end);
    };
    // The pane's absence from the listing is the end the subscription cannot
    // report: one that predated the ack, or one a closed tab took silently.
    const settleIfUnlisted = (end: PaneEnd): void => {
      void listPaneIds(socketPath)
        .then((ids) => {
          if (!ids.includes(paneId)) settle(end);
        })
        .catch(() => {});
    };
    releaseSignal?.addEventListener("abort", onRelease, { once: true });
    sock.on("connect", () => {
      connected();
      if (settled) {
        // Released while the connect was in flight: the wait has already
        // resolved, and the socket is torn down now that it exists.
        teardown();
        return;
      }
      sock.write(
        JSON.stringify({
          id: "1",
          method: "events.subscribe",
          params: {
            subscriptions: [
              { type: "pane.exited" },
              { type: "pane.closed" },
              { type: "tab.closed" },
            ],
          },
        }) + "\n",
      );
    });
    sock.on("data", (d) => {
      if (settled) return;
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
          // missed, and the liveness check covers exactly that.
          settleIfUnlisted("exited");
          continue;
        }
        if (msg.event === "tab_closed") {
          settleIfUnlisted("closed");
          continue;
        }
        if (msg.data?.pane_id !== paneId) continue; // another pane's event
        settle(msg.event === "pane_closed" ? "closed" : "exited");
        return;
      }
    });
    sock.on("end", () => settle("lost"));
    sock.on("error", () => {
      connected();
      settle("lost");
    });
    sock.on("close", () => {
      connected();
      liveSockets.delete(sock);
      settle("lost");
    });
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
