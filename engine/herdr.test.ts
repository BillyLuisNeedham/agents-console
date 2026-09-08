import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_TAB_LABEL_MAX,
  attemptTabLabel,
  herdrRpc,
  openAttemptTab,
  waitForPaneEnd,
} from "./herdr.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

interface FakeHerdr {
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
}

interface FakePane {
  tab_id: string;
  pane_id: string;
}

/**
 * A fake herdr daemon speaking the real wire shape: one JSON line in, one
 * JSON line out, per connection. `tab.create` mints a tab id and a root pane;
 * `pane.list` serves the created panes plus any foreign panes the test seeds
 * (live-agent panes the pool must never touch). Any other method, or a method
 * in `fail`, answers with a herdr-style error body.
 *
 * `events.subscribe` is the exception to one-line-out: the daemon
 * acknowledges it and then holds the connection open as the subscriber's
 * event channel, so the fake does too. What was subscribed to lands in
 * `requests` like any other call, and the test drives the channel from the
 * daemon's side: `pushEvent` to deliver one, `hangUpSubscribers` to hang up
 * with a FIN, `dropSubscribers` to die outright.
 */
function startFakeHerdr(options?: {
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
  const subscribers = new Set<Socket>();
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
          response = {
            id: msg.id,
            result: { panes: options?.listOnly ?? panes },
          };
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
          const line = JSON.stringify({ event, data }) + "\n";
          for (const socket of subscribers) socket.write(line);
        },
        hangUpSubscribers() {
          for (const socket of subscribers) socket.end();
        },
        dropSubscribers() {
          for (const socket of subscribers) socket.destroy();
        },
      }),
    );
  });
}

// Wait for something the fake daemon has seen, so a test drives the daemon's
// side only once the client has actually got there.
async function until(what: string, held: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (held()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the fake daemon never saw ${what}`);
}

// A live pane for the wait to subscribe about: the liveness check on the
// subscription ack settles "exited" for any pane the listing does not hold.
const LIVE_PANE: FakePane = { tab_id: "tab-1", pane_id: "pane-1" };

// Subscribed and past the liveness check: from here the only thing that can
// settle the wait is what the test does next.
async function subscribedAndChecked(fake: FakeHerdr): Promise<void> {
  await until("the subscriber connect", () => fake.subscribers === 1);
  await until("the liveness check", () =>
    fake.requests.some((r) => r.method === "pane.list"),
  );
}

describe("attemptTabLabel", () => {
  it("joins the ticket id and title with the middle dot", () => {
    expect(attemptTabLabel("01", "Named herdr tabs")).toBe(
      "01 · Named herdr tabs",
    );
  });

  it("truncates to the label cap", () => {
    const label = attemptTabLabel("07", "x".repeat(60));
    expect(label).toBe(`07 · ${"x".repeat(ATTEMPT_TAB_LABEL_MAX - "07 · ".length)}`);
    expect(label.length).toBe(ATTEMPT_TAB_LABEL_MAX);
  });

  it("keeps an exactly-capped label whole", () => {
    const title = "x".repeat(ATTEMPT_TAB_LABEL_MAX - "07 · ".length);
    expect(attemptTabLabel("07", title).length).toBe(ATTEMPT_TAB_LABEL_MAX);
  });
});

describe("herdrRpc", () => {
  it("sends one request per connection and resolves the result", async () => {
    const fake = await startFakeHerdr();
    const first = await herdrRpc(fake.socketPath, "pane.list", {});
    const second = await herdrRpc(fake.socketPath, "pane.list", {});
    // One connection per call, exactly as the daemon's protocol demands.
    expect(fake.connections).toBe(2);
    expect(first).toEqual({ panes: [] });
    expect(second).toEqual({ panes: [] });
    expect(fake.requests).toEqual([
      { method: "pane.list", params: {} },
      { method: "pane.list", params: {} },
    ]);
  });

  it("rejects with the herdr error body", async () => {
    const fake = await startFakeHerdr({
      fail: { "pane.list": { code: -1, message: "daemon says no" } },
    });
    await expect(herdrRpc(fake.socketPath, "pane.list", {})).rejects.toThrow(
      /daemon says no/,
    );
  });
});

describe("openAttemptTab", () => {
  it("creates an unfocused tab in the attempt cwd and recovers the root pane by tab id", async () => {
    const fake = await startFakeHerdr({
      foreignPanes: [
        { tab_id: "tab-foreign", pane_id: "pane-foreign" },
      ],
    });
    const tab = await openAttemptTab(
      fake.socketPath,
      "01 · Named herdr tabs",
      "/work/tree",
    );
    expect(tab.tabId).toBe("tab-1");
    // The pane id comes from the pane.list entry whose tab_id is the created
    // tab: tab.create carries no root pane id (verified herdr behaviour),
    // and a foreign pane must never be picked.
    expect(tab.paneId).toBe("pane-1");
    expect(fake.requests).toEqual([
      {
        method: "tab.create",
        params: { label: "01 · Named herdr tabs", focus: false, cwd: "/work/tree" },
      },
      { method: "pane.list", params: {} },
    ]);
  });

  it("throws when tab.create returns an error", async () => {
    const fake = await startFakeHerdr({
      fail: { "tab.create": { code: -1, message: "no daemon here" } },
    });
    await expect(
      openAttemptTab(fake.socketPath, "01 · Named herdr tabs", "/work/tree"),
    ).rejects.toThrow(/tab\.create failed.*no daemon here/);
  });

  it("throws when no pane belongs to the created tab", async () => {
    // The daemon accepted tab.create but its listing does not show the new
    // tab yet: recovery must fail loudly rather than guess a pane.
    const fake = await startFakeHerdr({
      listOnly: [{ tab_id: "tab-foreign", pane_id: "pane-foreign" }],
    });
    await expect(
      openAttemptTab(fake.socketPath, "01 · Named herdr tabs", "/work/tree"),
    ).rejects.toThrow(/no pane found for new tab/);
  });
});

describe("waitForPaneEnd", () => {
  it("settles exited on the pane's own exit event", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnd(fake.socketPath, "pane-1");
    await subscribedAndChecked(fake);
    // The subscription names both ends the daemon can report; the filtering
    // by pane is the client's job, since every subscriber sees every pane.
    expect(fake.requests[0]).toEqual({
      method: "events.subscribe",
      params: {
        subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }],
      },
    });
    fake.pushEvent("pane_exited", { pane_id: "pane-1" });
    expect(await ending).toBe("exited");
  });

  it("settles closed when the pane vanished without exiting", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnd(fake.socketPath, "pane-1");
    await subscribedAndChecked(fake);
    fake.pushEvent("pane_closed", { pane_id: "pane-1" });
    expect(await ending).toBe("closed");
  });

  it("ignores another pane's event", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnd(fake.socketPath, "pane-1");
    await subscribedAndChecked(fake);
    // The daemon pushes every pane's ends to every subscriber, so a busy host
    // delivers other attempts' endings down this same connection.
    fake.pushEvent("pane_exited", { pane_id: "pane-other" });
    fake.pushEvent("pane_closed", { pane_id: "pane-other" });
    fake.pushEvent("pane_exited", { pane_id: "pane-1" });
    expect(await ending).toBe("exited");
  });

  it("settles lost when the daemon hangs up on the subscriber", async () => {
    // Ticket 19 of the run-digest pool: the daemon dropped the subscription
    // with a plain FIN, saying nothing and reporting no error, and the wait
    // parked for 98 minutes over an attempt that had already finished. A
    // hang-up must settle the ending, so the exit-code file can answer.
    // Every handler the wait has must hold this: under Bun 1.2.13 a FIN
    // raises "end" and "close" both, so no single one of them is what this
    // test proves, and losing all of them is what it catches.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnd(fake.socketPath, "pane-1");
    await subscribedAndChecked(fake);
    fake.hangUpSubscribers();
    expect(await ending).toBe("lost");
  });

  it("settles lost when the subscriber connection is dropped", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const ending = waitForPaneEnd(fake.socketPath, "pane-1");
    await subscribedAndChecked(fake);
    fake.dropSubscribers();
    expect(await ending).toBe("lost");
  });

  it("settles lost when there is no daemon to subscribe to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
    tempDirs.push(dir);
    expect(await waitForPaneEnd(join(dir, "absent.sock"), "pane-1")).toBe(
      "lost",
    );
  });

  it("settles exited when the pane is already gone as the subscription lands", async () => {
    // Its end predated the subscription, so no event will ever arrive: the
    // liveness check on the ack is the only thing that can see it.
    const fake = await startFakeHerdr({ listOnly: [] });
    expect(await waitForPaneEnd(fake.socketPath, "pane-1")).toBe("exited");
  });
});
