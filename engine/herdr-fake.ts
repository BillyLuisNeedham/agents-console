/**
 * The fake herdr daemon the engine's herdr-facing suites run against, over a
 * real unix socket speaking the real wire shape. It lives in its own module
 * rather than inside `herdr.test.ts` so both the pane-end seam and the
 * attempt-ending seam drive the same one: one fake, one definition of the
 * protocol the tests assume. Not itself a test file, so importing it never
 * drags another suite's cases into the importer's run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeHerdr {
  socketPath: string;
  requests: RecordedRequest[];
  connections: number;
  /** Connections held open by an `events.subscribe`, the daemon's event channel. */
  subscribers: number;
  /** Push one event line to every subscriber, as the daemon pushes every pane's. */
  pushEvent(event: string, data: Record<string, unknown>): void;
  /** Hang up on every subscriber with a plain FIN, saying nothing first. */
  hangUpSubscribers(): void;
  /** Drop every subscriber abruptly, the shape of a daemon that died. */
  dropSubscribers(): void;
  /**
   * Take a pane out of the listing without announcing it: a daemon that
   * reaped a pane while nobody was being told, which is the only way the
   * pane's absence and the event's absence can be observed together.
   */
  removePane(paneId: string): void;
}

export interface FakePane {
  tab_id: string;
  pane_id: string;
}

const servers: Server[] = [];
const tempDirs: string[] = [];

/** Shut every fake started so far down; suites call it from `afterEach`. */
export async function stopFakeHerdrs(): Promise<void> {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
}

/**
 * A fake herdr daemon speaking the real wire shape: one JSON line in, one
 * JSON line out, per connection. `tab.create` mints a tab id and a root pane;
 * `pane.list` serves the created panes plus any foreign panes the test seeds
 * (live-agent panes the pool must never touch); `tab.close` drops the tab's
 * panes from the listing and pushes only `tab_closed`, `pane.close` drops
 * the pane and pushes `pane_closed`, the daemon's own asymmetry (verified
 * against herdr 0.8.2, issue #61). Any other method, or a method in `fail`,
 * answers with a herdr-style error body.
 *
 * `events.subscribe` is the exception to one-line-out: the daemon
 * acknowledges it and then holds the connection open as the subscriber's
 * event channel, so the fake does too. What was subscribed to lands in
 * `requests` like any other call, and the test drives the channel from the
 * daemon's side: `pushEvent` to deliver one, `hangUpSubscribers` to hang up
 * with a FIN, `dropSubscribers` to die outright, `removePane` to reap a pane
 * silently.
 */
export function startFakeHerdr(options?: {
  foreignPanes?: FakePane[];
  // When set, pane.list answers exactly these panes, ignoring created tabs:
  // the shape of a daemon whose new tab has not shown up in the listing yet.
  listOnly?: FakePane[];
  fail?: Record<string, unknown>;
}): Promise<FakeHerdr> {
  const requests: RecordedRequest[] = [];
  let connections = 0;
  let minted = 0;
  const panes: FakePane[] = [...(options?.foreignPanes ?? [])];
  const listOnly = options?.listOnly ? [...options.listOnly] : null;
  const subscribers = new Set<Socket>();
  const push = (event: string, data: Record<string, unknown>): void => {
    const line = JSON.stringify({ event, data: { type: event, ...data } }) + "\n";
    for (const socket of subscribers) socket.write(line);
  };
  const server = createServer((socket) => {
    connections += 1;
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      let newline: number;
      while ((newline = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, newline);
        buf = buf.slice(newline + 1);
        const msg = JSON.parse(line) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        requests.push({ method: msg.method, params: msg.params });
        const failure = options?.fail?.[msg.method];
        let response: Record<string, unknown>;
        if (failure !== undefined) {
          response = { id: msg.id, error: failure };
        } else if (msg.method === "events.subscribe") {
          // The subscriber's connection is the channel: acknowledge and keep
          // it, rather than answering and hanging up.
          subscribers.add(socket);
          socket.on("close", () => subscribers.delete(socket));
          socket.write(JSON.stringify({ id: msg.id, result: {} }) + "\n");
          continue;
        } else if (msg.method === "tab.create") {
          minted += 1;
          const tab_id = `tab-${minted}`;
          panes.push({ tab_id, pane_id: `pane-${minted}` });
          response = { id: msg.id, result: { tab: { tab_id } } };
        } else if (msg.method === "pane.list") {
          response = { id: msg.id, result: { panes: listOnly ?? panes } };
        } else if (msg.method === "tab.close") {
          // A closed tab takes its panes silently (verified herdr 0.8.2,
          // issue #61): the listing drops them and one `tab_closed` goes
          // out, with no `pane_closed` for any of them.
          const tabId = String(msg.params.tab_id ?? "");
          for (const list of [panes, listOnly]) {
            if (!list) continue;
            for (let at = list.length - 1; at >= 0; at--) {
              if (list[at].tab_id === tabId) list.splice(at, 1);
            }
          }
          socket.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
          push("tab_closed", { tab_id: tabId, workspace_id: "w1" });
          return;
        } else if (msg.method === "pane.close") {
          // A closed pane announces itself (verified herdr 0.8.2).
          const paneId = String(msg.params.pane_id ?? "");
          for (const list of [panes, listOnly]) {
            if (!list) continue;
            const at = list.findIndex((p) => p.pane_id === paneId);
            if (at !== -1) list.splice(at, 1);
          }
          socket.end(JSON.stringify({ id: msg.id, result: { type: "ok" } }) + "\n");
          push("pane_closed", { pane_id: paneId, workspace_id: "w1" });
          return;
        } else {
          response = {
            id: msg.id,
            error: { code: -32601, message: `unknown method ${msg.method}` },
          };
        }
        socket.end(JSON.stringify(response) + "\n");
        return;
      }
    });
    socket.on("error", () => subscribers.delete(socket));
  });
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        requests,
        get connections() {
          return connections;
        },
        get subscribers() {
          return subscribers.size;
        },
        pushEvent(event, data) {
          push(event, data);
        },
        hangUpSubscribers() {
          for (const socket of subscribers) socket.end();
        },
        dropSubscribers() {
          for (const socket of subscribers) socket.destroy();
        },
        removePane(paneId) {
          for (const list of [panes, listOnly]) {
            if (!list) continue;
            const at = list.findIndex((p) => p.pane_id === paneId);
            if (at !== -1) list.splice(at, 1);
          }
        },
      }),
    );
  });
}

/**
 * Wait for something the fake daemon has seen, so a test drives the daemon's
 * side only once the client has actually got there.
 */
export async function until(
  what: string,
  held: () => boolean,
): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (held()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the fake daemon never saw ${what}`);
}
