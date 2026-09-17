/**
 * The executing fake herdr daemon (ADR-0014, ADR-0016): the real wire shape
 * (newline-delimited JSON-RPC, one request per connection) and it actually
 * RUNS what a pane is sent. The engine's wrapper shell executes under bash
 * in the pane's cwd, so the typescript Stream file, the exit-code file, and
 * the harness's result are all real, exactly as a live herdr would produce
 * them. Pane ends are pushed to the engine's events.subscribe connections,
 * the way herdr pushes subscribed events.
 *
 * It lives beside `herdr-fake.ts` (the protocol-only fake the pane-end and
 * attempt-ending seams drive) so the Attempt-run module's own suite and the
 * engine suite share one definition of a pane that runs things. Not itself
 * a test file, so importing it never drags another suite's cases into the
 * importer's run.
 *
 * Test-only controls simulate the interactive surface: `rendered` supplies
 * the pane.read text every new pane shows (a test sets it to a harness's
 * ready frame so the engine's readiness poll passes), `setPaneContent`
 * overrides a single pane's rendered text, and `dropPaneInput` drops the
 * next typed inputs after the wrapper (a lost paste) so the engine's echo
 * verification has a failure to retry on. After the wrapper boots, the pane
 * has an input area: paste appends, clear keys empty it, Enter submits it
 * (`submitted` records each submit). `hideInputs` conceals that many pastes
 * from pane.read so a false-negative echo is testable: the text still
 * occupies the input. `wrapWidth` renders the input area the way a real TUI
 * draws it: a bordered box narrower than the pane, every input line
 * hard-wrapped at that width with a border glyph and padding on each row,
 * so a long echo target (an issue path) lands split across rows (the
 * opencode viewport that issue #56 found).
 *
 * The fake executes only the pane's FIRST Enter as bash, the wrapper, and
 * treats every later Enter as the TUI consuming input, matching how a real
 * pane hands control to the harness. By default the pane ends when the
 * wrapper's bash exits, the shorthand the ending tests rely on; a real
 * herdr pane holds a shell, so a wrapper that exits leaves the pane alive
 * at its prompt and no pane end ever fires. `holdPane` models that, for the
 * harness-died-on-launch case (issue #58). `breakSubscriptions` simulates a
 * daemon that cannot keep a subscription (restart mid-wait), for the
 * exit-code file fallback. `injectPane` and `endPane` simulate the orphans
 * boot reconciliation must handle: a pane with no process behind it, and
 * its later end. A method named in `fail` (seeded by the option, mutable on
 * the handle) answers with a herdr-style error body, the shape of a daemon
 * refusing the call, so a refusal can be switched on mid-run.
 *
 * Workspaces are modelled too (issue #94): `workspaces` seeds the ones the
 * daemon already holds (a pool's remembered or launch workspace),
 * `workspace.create` mints `w<N>`, `tab.create` refuses a workspace the
 * daemon does not hold and otherwise mints its ids inside it
 * (`<ws>:t<N>` / `<ws>:p<N>`), `pane.list` honours a `workspace_id` filter,
 * and `removeWorkspace` closes one out from under a running pool the way an
 * operator does. `pane.report_agent` and `pane.release_agent` are recorded
 * and acknowledged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface ExecutingFakeHerdrOptions {
  breakSubscriptions?: boolean;
  /**
   * Workspaces the daemon already holds (issue #94), so a test can offer one
   * as the pool's remembered or launch workspace. A fake with none makes the
   * pool create its own, which is the ordinary boot.
   */
  workspaces?: string[];
  fail?: string[];
  /**
   * Called with every request the daemon receives, after it is recorded and
   * before it is answered: the seam a test drives the daemon's own world
   * from at an exact moment (closing a workspace as boot reconciliation's
   * listing lands, say), where a timer would race the engine.
   */
  onRequest?: (method: string, params: Record<string, unknown>) => void;
  rendered?: string;
  dropInputs?: number;
  hideInputs?: number;
  wrapWidth?: number;
  holdPane?: boolean;
  /**
   * The shell-startup race (issue #96, issue #102): the first N tabs swallow
   * the wrapper typed into them — the text vanishes and the Enter submits
   * nothing, the pane left sitting at its prompt with `script` never run.
   */
  swallowWrapper?: number;
  /**
   * How long after tab.create a pane's read stays empty before its shell
   * prompt appears: a fresh tab is not ready the instant it is created.
   */
  shellPromptDelayMs?: number;
}

// What a pane shows before its wrapper runs: the shell's prompt. Non-empty,
// so the engine's shell-settle gate sees a shell that has drawn its prompt.
export const FAKE_SHELL_PROMPT = "$ ";

export interface ExecutingFakeHerdr {
  socketPath: string;
  requests: FakeHerdrRequest[];
  submitted: string[];
  /** Methods that answer with an error body from now on. */
  fail: Set<string>;
  /** Refuse the next `times` calls of this method, then answer normally again: a daemon blip, not a daemon that is down. */
  failNextCall: (method: string, times?: number) => void;
  close: () => Promise<void>;
  injectPane: (paneId: string) => void;
  /** Close a workspace out from under the pool, the way an operator does mid-run (issue #94). */
  removeWorkspace: (workspaceId: string) => void;
  /** The workspace ids the fake currently holds, seeded plus created. */
  workspaceIds: () => string[];
  endPane: (paneId: string) => void;
  setPaneContent: (paneId: string, text: string) => void;
  dropPaneInput: (paneId: string, count: number) => void;
}

export async function startExecutingFakeHerdr(
  options?: ExecutingFakeHerdrOptions,
): Promise<ExecutingFakeHerdr> {
  const breakSubscriptions = options?.breakSubscriptions === true;
  const defaultRendered = options?.rendered ?? "";
  const defaultDropInputs = options?.dropInputs ?? 0;
  const defaultHideInputs = options?.hideInputs ?? 0;
  const wrapWidth = options?.wrapWidth;
  const holdPane = options?.holdPane === true;
  let swallowRemaining = options?.swallowWrapper ?? 0;
  const shellPromptDelayMs = options?.shellPromptDelayMs ?? 0;
  const fail = new Set(options?.fail ?? []);
  // Method -> how many more calls of it are refused before it works again.
  const failNext = new Map<string, number>();
  const workspaces = new Set(options?.workspaces ?? []);
  let mintedWorkspaces = 0;
  // The input area as pane.read shows it: verbatim, or drawn as a bordered
  // box that wraps each line at `wrapWidth` columns.
  const renderInput = (inputArea: string): string => {
    if (wrapWidth === undefined) return inputArea;
    const rows: string[] = [];
    for (const line of inputArea.split("\n")) {
      for (let i = 0; i < Math.max(line.length, 1); i += wrapWidth) {
        const chunk = line.slice(i, i + wrapWidth);
        rows.push(`  ┃  ${chunk.padEnd(wrapWidth)}  ┃`);
      }
    }
    return `\n${rows.join("\n")}\n`;
  };
  const requests: FakeHerdrRequest[] = [];
  const submitted: string[] = [];
  let minted = 0;
  const panes = new Map<
    string,
    {
      tabId: string;
      workspaceId: string | null;
      cwd: string;
      alive: boolean;
      buffer: string;
      rendered: string;
      booted: boolean;
      dropInputs: number;
      hideInputs: number;
      inputArea: string;
      hideEcho: boolean;
      swallow: boolean;
      createdAt: number;
      proc?: ReturnType<typeof Bun.spawn>;
    }
  >();
  const subscribers: Socket[] = [];
  const connections = new Set<Socket>();
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const firePaneEnd = (
    paneId: string,
    event: "pane_exited" | "pane_closed",
  ): void => {
    const pane = panes.get(paneId);
    if (pane) {
      pane.alive = false;
      pane.proc?.kill();
    }
    broadcast(event, { pane_id: paneId, workspace_id: "w1" });
  };
  // herdr pushes every event to every subscriber; the engine filters. A
  // subscriber whose wait already settled has closed its end, so prune
  // before broadcasting.
  const broadcast = (event: string, data: Record<string, unknown>): void => {
    for (const sub of [...subscribers]) {
      if (sub.destroyed || !sub.writable) {
        subscribers.splice(subscribers.indexOf(sub), 1);
        continue;
      }
      sub.write(JSON.stringify({ event, data: { type: event, ...data } }) + "\n");
    }
  };
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      const msg = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method: msg.method, params: msg.params });
      options?.onRequest?.(msg.method, msg.params);
      const respond = (result: unknown): void => {
        socket.end(JSON.stringify({ id: msg.id, result }) + "\n");
      };
      const blips = failNext.get(msg.method) ?? 0;
      if (blips > 0) {
        // A transient refusal: this call fails, the next one works.
        if (blips === 1) failNext.delete(msg.method);
        else failNext.set(msg.method, blips - 1);
        socket.end(
          JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: `${msg.method} blipped` },
          }) + "\n",
        );
        return;
      }
      if (fail.has(msg.method)) {
        socket.end(
          JSON.stringify({
            id: msg.id,
            error: { code: -32000, message: `${msg.method} refused` },
          }) + "\n",
        );
        return;
      }
      if (msg.method === "tab.create") {
        const workspaceId =
          typeof msg.params.workspace_id === "string" ? msg.params.workspace_id : null;
        if (workspaceId !== null && !workspaces.has(workspaceId)) {
          // The Pool workspace is gone (the operator closed it mid-run):
          // the daemon refuses the tab, and the engine re-resolves once.
          socket.end(
            JSON.stringify({
              id: msg.id,
              error: { code: -32001, message: `no such workspace ${workspaceId}` },
            }) + "\n",
          );
          return;
        }
        minted += 1;
        // Ids carry the workspace when one was named, so a test reads where
        // a tab landed off the ids alone (issue #94).
        const tabId = workspaceId !== null ? `${workspaceId}:t${minted}` : `tab-${minted}`;
        const paneId = workspaceId !== null ? `${workspaceId}:p${minted}` : `pane-${minted}`;
        panes.set(paneId, {
          tabId,
          workspaceId,
          cwd: String(msg.params.cwd ?? "/"),
          alive: true,
          buffer: "",
          rendered: defaultRendered,
          booted: false,
          dropInputs: defaultDropInputs,
          hideInputs: defaultHideInputs,
          inputArea: "",
          hideEcho: false,
          swallow: swallowRemaining > 0,
          createdAt: Date.now(),
        });
        swallowRemaining -= 1;
        respond({
          type: "tab_created",
          tab: { tab_id: tabId, ...(workspaceId !== null ? { workspace_id: workspaceId } : {}) },
          root_pane: {
            pane_id: paneId,
            tab_id: tabId,
            ...(workspaceId !== null ? { workspace_id: workspaceId } : {}),
          },
        });
      } else if (msg.method === "workspace.get") {
        const workspaceId = String(msg.params.workspace_id ?? "");
        if (workspaces.has(workspaceId)) {
          respond({ workspace: { workspace_id: workspaceId } });
        } else {
          socket.end(
            JSON.stringify({
              id: msg.id,
              error: { code: -32001, message: `no such workspace ${workspaceId}` },
            }) + "\n",
          );
        }
      } else if (msg.method === "workspace.create") {
        mintedWorkspaces += 1;
        const workspaceId = `w${mintedWorkspaces}`;
        workspaces.add(workspaceId);
        respond({
          workspace: {
            workspace_id: workspaceId,
            label: typeof msg.params.label === "string" ? msg.params.label : "",
          },
        });
      } else if (msg.method === "pane.report_agent" || msg.method === "pane.release_agent") {
        // Recorded in `requests` like every call; the daemon answers ok.
        respond({ type: "ok" });
      } else if (msg.method === "pane.list") {
        const scope =
          typeof msg.params.workspace_id === "string" ? msg.params.workspace_id : null;
        respond({
          panes: [...panes.entries()]
            .filter(([, pane]) => pane.alive)
            .filter(([, pane]) => scope === null || pane.workspaceId === scope)
            .map(([paneId, pane]) => ({
              tab_id: pane.tabId,
              pane_id: paneId,
              ...(pane.workspaceId !== null ? { workspace_id: pane.workspaceId } : {}),
            })),
        });
      } else if (msg.method === "pane.read") {
        const pane = panes.get(String(msg.params.pane_id));
        const visible = pane
          ? pane.booted
            ? pane.hideEcho
              ? pane.rendered
              : `${pane.rendered}${renderInput(pane.inputArea)}`
            : Date.now() - pane.createdAt < shellPromptDelayMs
              ? ""
              : `${FAKE_SHELL_PROMPT}${pane.rendered}${pane.buffer}`
          : "";
        respond({
          read: {
            text: visible,
            revision: 0,
            truncated: false,
          },
        });
      } else if (msg.method === "pane.send_input") {
        const pane = panes.get(String(msg.params.pane_id));
        if (pane && !pane.booted && pane.swallow) {
          // The race: the shell was still starting, the wrapper is gone,
          // and the pane sits at its prompt as if nothing was typed.
          pane.swallow = false;
          respond({});
          return;
        }
        if (pane) {
          if (typeof msg.params.text === "string") {
            if (!pane.booted) {
              pane.buffer += msg.params.text;
            } else if (pane.dropInputs > 0) {
              // A lost paste: the text vanishes from the pane, the way a
              // paste sent before the TUI is truly ready can.
              pane.dropInputs -= 1;
            } else {
              pane.inputArea += msg.params.text;
              pane.hideEcho = pane.hideInputs > 0;
              if (pane.hideInputs > 0) pane.hideInputs -= 1;
            }
          }
          if (Array.isArray(msg.params.keys)) {
            if (msg.params.keys.includes("enter")) {
              if (pane.booted) {
                submitted.push(pane.inputArea);
                pane.inputArea = "";
                pane.hideEcho = false;
                respond({});
                return;
              }
              const command = pane.buffer;
              pane.buffer = "";
              pane.booted = true;
              const proc = Bun.spawn(["bash", "-c", command], {
                cwd: pane.cwd,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              });
              pane.proc = proc;
              procs.push(proc);
              void proc.exited.then(() => {
                if (!holdPane) {
                  firePaneEnd(String(msg.params.pane_id), "pane_exited");
                }
              });
            } else if (pane.booted) {
              pane.inputArea = "";
              pane.hideEcho = false;
            }
          }
        }
        respond({});
      } else if (msg.method === "events.subscribe") {
        if (breakSubscriptions) {
          // The daemon drops the subscription before acking: the engine's
          // wait degrades to the exit-code file.
          socket.destroy();
          return;
        }
        // The ack answers this request; the connection then stays open and
        // receives pushed events until close() destroys it or the
        // subscriber's own end closes it (an exited wait releases its
        // socket, and firePaneEnd prunes closed subscribers).
        subscribers.push(socket);
        socket.on("close", () => {
          const at = subscribers.indexOf(socket);
          if (at !== -1) subscribers.splice(at, 1);
        });
        socket.write(
          JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n",
        );
      } else if (msg.method === "pane.close") {
        const paneId = String(msg.params.pane_id ?? "");
        respond({ type: "ok" });
        firePaneEnd(paneId, "pane_closed");
      } else if (msg.method === "tab.close") {
        // A closed tab takes its panes silently (verified herdr 0.8.2,
        // issue #61): they leave the listing and one `tab_closed` goes out,
        // with no `pane_closed` for any of them.
        const tabId = String(msg.params.tab_id ?? "");
        for (const pane of panes.values()) {
          if (pane.tabId !== tabId) continue;
          pane.alive = false;
          pane.proc?.kill();
        }
        respond({ type: "ok" });
        broadcast("tab_closed", { tab_id: tabId, workspace_id: "w1" });
      } else {
        respond({});
      }
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
  const socketPath = join(dir, "herdr.sock");
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    submitted,
    fail,
    failNextCall: (method, times = 1) => {
      failNext.set(method, (failNext.get(method) ?? 0) + times);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const proc of procs) proc.kill();
        for (const sub of subscribers) sub.destroy();
        // bun's server.close() waits for every connection to drain, and a
        // request/response connection whose client already destroyed its
        // end can linger in a half-closed state that outlives the test.
        // Teardown destroys what is left instead of waiting on it.
        for (const conn of connections) conn.destroy();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
    injectPane: (paneId) => {
      panes.set(paneId, {
        tabId: "tab-ghost",
        // An injected orphan belongs to whatever workspace the pool
        // resolved, so a scoped pane.list still finds it: the first
        // workspace the fake holds, or none at all when it holds none.
        workspaceId: [...workspaces][0] ?? null,
        cwd: "/tmp",
        alive: true,
        buffer: "",
        rendered: defaultRendered,
        booted: true,
        dropInputs: 0,
        hideInputs: 0,
        inputArea: "",
        hideEcho: false,
        swallow: false,
        createdAt: 0,
      });
    },
    endPane: (paneId) => firePaneEnd(paneId, "pane_exited"),
    removeWorkspace: (workspaceId) => {
      workspaces.delete(workspaceId);
    },
    workspaceIds: () => [...workspaces],
    setPaneContent: (paneId, text) => {
      const pane = panes.get(paneId);
      if (pane) pane.rendered = text;
    },
    dropPaneInput: (paneId, count) => {
      const pane = panes.get(paneId);
      if (pane) pane.dropInputs += count;
    },
  };
}
