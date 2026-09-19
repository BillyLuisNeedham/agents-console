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
 * unfocused in the attempt's worktree cwd, named `<ticket-id> ·
 * <ticket-title>` so the operator's tab bar reads as the roster of tickets in
 * flight, and inside the **Pool workspace** (issue #94), the one herdr
 * workspace every tab of one Pool opens in. herdr protocol 20 answers
 * `tab.create` with `tab_created { tab, root_pane }`, both required, so the
 * pane id comes straight off `root_pane` and the `pane.list` scan the first
 * cut needed is gone; the engine records the pane id on the attempt's
 * `spawned` event.
 *
 * The Pool workspace itself is resolved once per boot by
 * `resolvePoolWorkspace` (remembered id, else the workspace the server was
 * launched in, else a fresh one created for the pool), and the engine keeps
 * the id in the pool's runs directory so a restart lands its tabs back where
 * the operator left them.
 *
 * herdr lists a pane in its left-hand agent sidebar only when the pane has
 * an agent bound to it, and its own process-name detection never binds ours
 * (the harness runs inside `script`), so the engine asserts the identity
 * itself: `reportPaneAgent` after the wrapper lands and on every Turn flip,
 * `releasePaneAgent` at the Attempt ending. Both are best-effort.
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
 * Open an attempt's named tab in the Pool workspace (issue #94):
 * `tab.create` unfocused in the attempt's worktree cwd, carrying the
 * workspace id so every tab of one Pool lands together instead of wherever
 * the daemon's focus happens to be. The pane id comes off the answer's
 * `root_pane`: herdr protocol 20 answers `tab_created { tab, root_pane }`
 * with both required, so the `pane.list` scan the first cut needed (and the
 * race it carried, a listing that had not caught up with the new tab) is
 * gone. Throws when the daemon errors or either response shape does not
 * hold; callers treat a throw as the headless fallback (ADR-0014) and record
 * the failure on the spawned event.
 */
export async function openAttemptTab(
  socketPath: string,
  label: string,
  cwd: string,
  workspaceId: string,
): Promise<AttemptTab> {
  const created = await herdrRpc(socketPath, "tab.create", {
    label,
    focus: false,
    cwd,
    workspace_id: workspaceId,
  });
  const answer =
    typeof created === "object" && created !== null
      ? (created as {
          tab?: { tab_id?: unknown };
          root_pane?: { pane_id?: unknown };
        })
      : {};
  const tabId = answer.tab?.tab_id;
  if (typeof tabId !== "string" || tabId === "") {
    throw new Error(`tab.create returned no tab id: ${JSON.stringify(created)}`);
  }
  const paneId = answer.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(
      `tab.create returned no root pane id: ${JSON.stringify(created)}`,
    );
  }
  return { tabId, paneId };
}

/** Where the Pool workspace id the engine uses came from (issue #94). */
export type PoolWorkspaceOrigin = "remembered" | "launch" | "created";

export interface PoolWorkspaceResolution {
  workspaceId: string;
  origin: PoolWorkspaceOrigin;
}

/**
 * Resolve the Pool workspace (issue #94), the one herdr workspace a
 * Terminal-backed pool opens its attempt and Conversation tabs in. Three
 * steps, in order:
 *
 * 1. `remembered`: the id this pool used last, read from its runs directory.
 *    It is used only once `workspace.get` confirms the workspace is still
 *    there; an operator who closed it leaves an id that answers with an
 *    error, and the resolution falls through.
 * 2. `launch`: the workspace the Console server was launched in
 *    (`HERDR_WORKSPACE_ID`), confirmed the same way, so a pool started from
 *    inside herdr puts its tabs where the operator already is.
 * 3. Otherwise a fresh one: `workspace.create` labelled for the pool, in the
 *    pool's repo root, unfocused (ADR-0015's rule that a spawn never steals
 *    the operator's focus, applied one level up).
 *
 * There is deliberately no path-matching against `workspace.list`: a
 * workspace's cwd is the operator's to change and two pools of one repo
 * would collide on it, so identity comes from an id the pool recorded or
 * was told, never from a guess. Rejects when the daemon cannot be reached at
 * all and no candidate held; the caller boots headless-falling-back rather
 * than refusing the pool.
 */
export async function resolvePoolWorkspace(
  socketPath: string,
  candidates: {
    remembered: string | null;
    launch: string | null;
    label: string;
    cwd: string;
  },
): Promise<PoolWorkspaceResolution> {
  const known: [PoolWorkspaceOrigin, string | null][] = [
    ["remembered", candidates.remembered],
    ["launch", candidates.launch],
  ];
  for (const [origin, workspaceId] of known) {
    if (workspaceId === null || workspaceId === "") continue;
    if (await workspaceExists(socketPath, workspaceId)) {
      return { workspaceId, origin };
    }
  }
  const created = await herdrRpc(socketPath, "workspace.create", {
    label: candidates.label,
    cwd: candidates.cwd,
    focus: false,
  });
  const workspaceId =
    typeof created === "object" && created !== null
      ? (created as { workspace?: { workspace_id?: unknown } }).workspace
          ?.workspace_id
      : undefined;
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new Error(
      `workspace.create returned no workspace id: ${JSON.stringify(created)}`,
    );
  }
  return { workspaceId, origin: "created" };
}

/**
 * Whether the daemon still holds this workspace: `workspace.get` answering
 * with one. Any error (an unknown id, a daemon that is not there) is a "no",
 * because both mean the same thing to the caller — this id cannot be used.
 * Exported for the engine's re-resolve, which asks the same question of the
 * id a `tab.create` just refused: a workspace that is still there means the
 * refusal was something else, and nothing should be created.
 */
export async function workspaceExists(
  socketPath: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const got = await herdrRpc(socketPath, "workspace.get", {
      workspace_id: workspaceId,
    });
    const id =
      typeof got === "object" && got !== null
        ? (got as { workspace?: { workspace_id?: unknown } }).workspace
            ?.workspace_id
        : undefined;
    return typeof id === "string" && id !== "";
  } catch {
    return false;
  }
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
 * What the engine calls itself when it asserts a pane's agent identity, on
 * every `pane.report_agent` and the matching `pane.release_agent`: herdr
 * keys a reported agent by (pane, source), so the source is what stops one
 * reporter from releasing another's binding.
 */
export const PANE_AGENT_SOURCE = "herdr:agent-console";

/**
 * How herdr's agent sidebar shows a pane the engine reported: "working" is
 * an attempt the agent is running, "blocked" is a Conversation waiting on
 * the operator (herdr's vocabulary for "it needs a human"). A Ticket
 * attempt has no Turn state and stays "working" for its whole life.
 */
export type PaneAgentState = "working" | "blocked";

// The `seq` every report carries, so the daemon can order two reports about
// one pane whatever order they arrive in. Strictly increasing within this
// process, and seeded from the clock so a restarted engine almost always
// continues above where its predecessor left off — the exception being a
// process that reported more times than the milliseconds it lived, or a
// clock that went backwards.
let paneAgentSeq = Date.now();

/**
 * Report a pane's agent identity (issue #94): herdr lists a pane in its
 * left-hand agent sidebar only when the pane has an agent bound to it, and
 * its process-name detection never binds ours, because the harness runs
 * inside `script` (ADR-0016). So the engine asserts the identity itself —
 * the harness name, the state, and the attempt's tab label as the message —
 * once the wrapper has landed, and again on every Conversation Turn flip.
 */
export async function reportPaneAgent(
  socketPath: string,
  paneId: string,
  agent: string,
  state: PaneAgentState,
  message: string,
): Promise<void> {
  paneAgentSeq += 1;
  await herdrRpc(socketPath, "pane.report_agent", {
    pane_id: paneId,
    source: PANE_AGENT_SOURCE,
    agent,
    state,
    seq: paneAgentSeq,
    message,
  });
}

/**
 * Drop the agent identity this engine reported for a pane, at the Attempt
 * ending: the attempt is over, so it leaves herdr's agent list even where
 * the pane itself lives on (a crashed attempt's tab stays open until merge,
 * ADR-0014). Best-effort, exactly as closeTab is.
 */
export async function releasePaneAgent(
  socketPath: string,
  paneId: string,
  agent: string,
): Promise<void> {
  await herdrRpc(socketPath, "pane.release_agent", {
    pane_id: paneId,
    source: PANE_AGENT_SOURCE,
    agent,
  });
}

/**
 * The live pane ids herdr currently holds, from `pane.list`. Boot
 * reconciliation (ADR-0014) treats membership as liveness: a recorded attempt
 * pane that is not listed died with the daemon restart or was closed.
 * Scoped to the Pool workspace when one is known (issue #94), so the answer
 * is this pool's panes rather than every pane on the host; daemon-wide
 * otherwise, which is what the check has always done.
 */
export async function listPaneIds(
  socketPath: string,
  workspaceId?: string,
): Promise<string[]> {
  const list = await herdrRpc(
    socketPath,
    "pane.list",
    workspaceId !== undefined ? { workspace_id: workspaceId } : {},
  );
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
 * One pane as herdr's `agent.list` reports it (the enlist picker's raw
 * material, issue #101). herdr lists an entry per pane it binds an agent to,
 * whether the engine reported the agent or herdr detected one itself; the
 * fields are the ones the picker shows. `directory` is the pane's cwd (herdr
 * reports no branch, so the engine resolves that itself).
 */
export interface HerdrAgent {
  paneId: string;
  harness: string | null;
  status: string;
  title: string;
  directory: string | null;
}

/** The string field of an `AgentInfo`-shaped record, or null. */
function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The live agents herdr holds, from `agent.list`: every pane with an agent
 * bound to it, engine-reported or herdr-detected. The enlist route reads it
 * through the engine, never the Console, and judges eligibility itself
 * (engine/enlist.ts). A daemon answer missing the `agents` array reads as
 * none, the way `listPaneIds` reads a missing `panes` array.
 */
export async function listAgents(socketPath: string): Promise<HerdrAgent[]> {
  const list = await herdrRpc(socketPath, "agent.list", {});
  const agents =
    typeof list === "object" && list !== null
      ? (list as { agents?: unknown }).agents
      : undefined;
  if (!Array.isArray(agents)) return [];
  return (agents as Record<string, unknown>[]).flatMap((agent) => {
    const paneId = stringField(agent.pane_id);
    if (paneId === null) return [];
    return [
      {
        paneId,
        harness: stringField(agent.agent),
        status: stringField(agent.agent_status) ?? "unknown",
        title:
          stringField(agent.terminal_title) ??
          stringField(agent.terminal_title_stripped) ??
          stringField(agent.title) ??
          stringField(agent.name) ??
          "",
        directory: stringField(agent.cwd) ?? stringField(agent.foreground_cwd),
      },
    ];
  });
}

/**
 * Send input to a pane, exactly as the operator's keystrokes would land. A
 * literal `\r` inside text is pasted data, not a submit (verified herdr
 * behaviour), so a command line travels as text and its Enter as a key. The
 * two may share one call: herdr applies text first, then keys (verified
 * live on 0.8.2, and what its CLI's `pane run` sends), which is how a
 * command line and its submit reach the shell without a gap between them
 * (issue #96).
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
