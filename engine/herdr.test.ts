import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
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
  const server = createServer((socket) => {
    connections += 1;
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const newline = buf.indexOf("\n");
      if (newline < 0) return;
      const msg = JSON.parse(buf.slice(0, newline)) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method: msg.method, params: msg.params });
      let response: Record<string, unknown>;
      if (options?.fail && msg.method in options.fail) {
        response = { id: msg.id, error: options.fail[msg.method] };
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
    });
  });
  servers.push(server);
  const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () =>
      resolve({ socketPath, requests, get connections() { return connections; } }),
    );
  });
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
  // A fake daemon that accepts the events.subscribe subscription (the ack
  // answers the request and the connection stays open, as real herdr does),
  // and reports a live pane id so the subscribe-time liveness backstop does
  // not settle the wait prematurely.
  function startSubscribingHerdr(): Promise<{
    socketPath: string;
    connections: number;
    subscribers: import("node:net").Socket[];
  }> {
    const subscribers: import("node:net").Socket[] = [];
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (d) => {
        buf += d.toString();
        const newline = buf.indexOf("\n");
        if (newline < 0) return;
        const msg = JSON.parse(buf.slice(0, newline)) as {
          id: string;
          method: string;
        };
        if (msg.method === "events.subscribe") {
          subscribers.push(socket);
          socket.on("close", () => {
            const at = subscribers.indexOf(socket);
            if (at !== -1) subscribers.splice(at, 1);
          });
          socket.write(
            JSON.stringify({
              id: msg.id,
              result: { type: "subscription_started" },
            }) + "\n",
          );
          return;
        }
        if (msg.method === "pane.list") {
          socket.end(
            JSON.stringify({
              id: msg.id,
              result: { panes: [{ tab_id: "tab-1", pane_id: "pane-1" }] },
            }) + "\n",
          );
          return;
        }
        socket.end(JSON.stringify({ id: msg.id, result: {} }) + "\n");
      });
    });
    servers.push(server);
    const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "herdr.sock");
    let connections = 0;
    return new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, () =>
        resolve({ socketPath, get connections() { return connections; }, subscribers }),
      );
    });
  }

  it("aborting the wait settles it and releases the subscription socket", async () => {
    const fake = await startSubscribingHerdr();
    const controller = new AbortController();
    const end = waitForPaneEnd(fake.socketPath, "pane-1", controller.signal);
    // The subscription is live until the abort releases it.
    const deadline = Date.now() + 5000;
    while (fake.subscribers.length === 0) {
      if (Date.now() > deadline) throw new Error("subscription never registered");
      await Bun.sleep(10);
    }
    controller.abort();
    expect(await end).toBe("lost");
    // The released subscription socket disconnected from the daemon.
    await Bun.sleep(20);
    expect(fake.subscribers).toHaveLength(0);
  });

  it("settles exited when the pane's end event arrives", async () => {
    const fake = await startSubscribingHerdr();
    const end = waitForPaneEnd(fake.socketPath, "pane-1");
    const deadline = Date.now() + 5000;
    while (fake.subscribers.length === 0) {
      if (Date.now() > deadline) throw new Error("subscription never registered");
      await Bun.sleep(10);
    }
    fake.subscribers[0]!.write(
      JSON.stringify({
        event: "pane_exited",
        data: { type: "pane_exited", pane_id: "pane-1" },
      }) + "\n",
    );
    expect(await end).toBe("exited");
  });
});
