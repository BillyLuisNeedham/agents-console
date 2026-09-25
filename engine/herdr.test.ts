import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_TAB_LABEL_MAX,
  HERDR_SOCKET_DEFAULT,
  PANE_AGENT_SOURCE,
  attemptTabLabel,
  closeTab,
  herdrRpc,
  listPaneIds,
  listPanes,
  openAttemptTab,
  relabelWorkspace,
  releasePaneAgent,
  reportPaneAgent,
  resolvePoolWorkspace,
  waitForPaneEnd,
} from "./herdr.ts";
import {
  startFakeHerdr,
  stopFakeHerdrs,
  until,
  type FakeHerdr,
  type FakePane,
} from "./herdr-fake.ts";

afterEach(stopFakeHerdrs);

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
  it("creates an unfocused tab in the Pool workspace and takes the pane off root_pane", async () => {
    const fake = await startFakeHerdr({
      workspaces: [{ workspace_id: "w7" }],
      foreignPanes: [{ tab_id: "tab-foreign", pane_id: "pane-foreign" }],
    });
    const tab = await openAttemptTab(
      fake.socketPath,
      "01 · Named herdr tabs",
      "/work/tree",
      "w7",
    );
    // The ids the daemon minted inside the named workspace (issue #94): the
    // tab landed in the Pool workspace, not wherever herdr's focus was.
    expect(tab.tabId).toBe("w7:t1");
    expect(tab.paneId).toBe("w7:p1");
    // One call, and only one: herdr protocol 20 answers tab.create with
    // `tab_created { tab, root_pane }`, so the pane.list scan the first cut
    // needed (and the race it carried) is gone.
    expect(fake.requests).toEqual([
      {
        method: "tab.create",
        params: {
          label: "01 · Named herdr tabs",
          focus: false,
          cwd: "/work/tree",
          workspace_id: "w7",
        },
      },
    ]);
  });

  it("throws when tab.create returns an error", async () => {
    const fake = await startFakeHerdr({
      workspaces: [{ workspace_id: "w7" }],
      fail: { "tab.create": { code: -1, message: "no daemon here" } },
    });
    await expect(
      openAttemptTab(fake.socketPath, "01 · Named herdr tabs", "/work/tree", "w7"),
    ).rejects.toThrow(/tab\.create failed.*no daemon here/);
  });

  it("throws when the Pool workspace is gone", async () => {
    // The operator closed it mid-run: the daemon refuses the tab, and the
    // caller (attempt-run.ts) re-resolves once before falling back.
    const fake = await startFakeHerdr({ workspaces: [{ workspace_id: "w7" }] });
    fake.removeWorkspace("w7");
    await expect(
      openAttemptTab(fake.socketPath, "01 · Named herdr tabs", "/work/tree", "w7"),
    ).rejects.toThrow(/no such workspace w7/);
  });

  it("throws when the answer carries no root pane", async () => {
    // A daemon older than protocol 20: the tab exists but its pane id is
    // unknowable, and guessing one is what the pane.list scan used to do.
    const fake = await startFakeHerdr({
      workspaces: [{ workspace_id: "w7" }],
      rootPaneless: true,
    });
    await expect(
      openAttemptTab(fake.socketPath, "01 · Named herdr tabs", "/work/tree", "w7"),
    ).rejects.toThrow(/tab\.create returned no root pane id/);
  });
});

describe("resolvePoolWorkspace", () => {
  const candidates = { label: "pool", cwd: "/repo" };

  it("keeps the remembered workspace when it is still there", async () => {
    const fake = await startFakeHerdr({
      workspaces: [{ workspace_id: "wR" }, { workspace_id: "wL" }],
    });
    expect(
      await resolvePoolWorkspace(fake.socketPath, {
        ...candidates,
        remembered: "wR",
        launch: "wL",
      }),
    ).toEqual({ workspaceId: "wR", origin: "remembered" });
    // Confirmed before it is used, and nothing else asked: no listing, no
    // path matching, no create.
    expect(fake.requests).toEqual([
      { method: "workspace.get", params: { workspace_id: "wR" } },
    ]);
  });

  it("falls to the launch workspace when the remembered one is gone", async () => {
    const fake = await startFakeHerdr({
      workspaces: [{ workspace_id: "wR" }, { workspace_id: "wL" }],
    });
    fake.removeWorkspace("wR");
    expect(
      await resolvePoolWorkspace(fake.socketPath, {
        ...candidates,
        remembered: "wR",
        launch: "wL",
      }),
    ).toEqual({ workspaceId: "wL", origin: "launch" });
    expect(fake.requests.map((r) => r.method)).toEqual([
      "workspace.get",
      "workspace.get",
    ]);
  });

  it("creates one, unfocused and labelled for the pool, when neither holds", async () => {
    const fake = await startFakeHerdr();
    expect(
      await resolvePoolWorkspace(fake.socketPath, {
        ...candidates,
        remembered: "wR",
        launch: "wL",
      }),
    ).toEqual({ workspaceId: "w1", origin: "created" });
    expect(fake.requests.at(-1)).toEqual({
      method: "workspace.create",
      params: { label: "pool", cwd: "/repo", focus: false },
    });
  });

  it("creates one when the pool remembers nothing and was not launched in one", async () => {
    const fake = await startFakeHerdr();
    expect(
      await resolvePoolWorkspace(fake.socketPath, {
        ...candidates,
        remembered: null,
        launch: null,
      }),
    ).toEqual({ workspaceId: "w1", origin: "created" });
    // No candidate to confirm, so nothing but the create.
    expect(fake.requests.map((r) => r.method)).toEqual(["workspace.create"]);
  });

  it("rejects when the daemon will not create one either", async () => {
    const fake = await startFakeHerdr({
      fail: { "workspace.create": { code: -1, message: "daemon says no" } },
    });
    await expect(
      resolvePoolWorkspace(fake.socketPath, {
        ...candidates,
        remembered: null,
        launch: null,
      }),
    ).rejects.toThrow(/workspace\.create failed.*daemon says no/);
  });
});

describe("relabelWorkspace", () => {
  it("renames the workspace by id with workspace.rename", async () => {
    const fake = await startFakeHerdr({ workspaces: [{ workspace_id: "w1", label: "old" }] });
    await relabelWorkspace(fake.socketPath, "w1", "Jev as the grader");
    expect(fake.requests).toEqual([
      { method: "workspace.rename", params: { workspace_id: "w1", label: "Jev as the grader" } },
    ]);
    expect(fake.workspaces[0]?.label).toBe("Jev as the grader");
  });

  it("rejects when the daemon holds no such workspace", async () => {
    const fake = await startFakeHerdr();
    await expect(relabelWorkspace(fake.socketPath, "w9", "x")).rejects.toThrow(
      /no such workspace w9/,
    );
  });
});

describe("listPaneIds", () => {
  it("scopes the listing to the Pool workspace when one is known", async () => {
    const fake = await startFakeHerdr({ workspaces: [{ workspace_id: "w7" }] });
    const mine = await openAttemptTab(fake.socketPath, "01 · Mine", "/w", "w7");
    // A pane of another workspace: the daemon serves every one of them, and
    // the scope is what keeps this pool's reconciliation to its own.
    fake.workspaces.push({ workspace_id: "w8" });
    await openAttemptTab(fake.socketPath, "02 · Theirs", "/w", "w8");
    expect(await listPaneIds(fake.socketPath, "w7")).toEqual([mine.paneId]);
    expect((await listPaneIds(fake.socketPath)).length).toBe(2);
    const listings = fake.requests.filter((r) => r.method === "pane.list");
    expect(listings[0].params).toEqual({ workspace_id: "w7" });
    expect(listings[1].params).toEqual({});
  });
});

describe("pane agent reporting", () => {
  it("reports the agent under the engine's own source, with a monotonic seq", async () => {
    const fake = await startFakeHerdr();
    await reportPaneAgent(fake.socketPath, "pane-1", "claude", "working", "01 · t");
    await reportPaneAgent(fake.socketPath, "pane-1", "claude", "blocked", "01 · t");
    const reports = fake.requests.filter((r) => r.method === "pane.report_agent");
    expect(reports).toHaveLength(2);
    expect(reports[0].params).toMatchObject({
      pane_id: "pane-1",
      source: PANE_AGENT_SOURCE,
      agent: "claude",
      state: "working",
      message: "01 · t",
    });
    expect(reports[1].params.state).toBe("blocked");
    expect(typeof reports[0].params.seq).toBe("number");
    expect(Number(reports[1].params.seq)).toBeGreaterThan(
      Number(reports[0].params.seq),
    );
  });

  it("releases the agent under the same source", async () => {
    const fake = await startFakeHerdr();
    await releasePaneAgent(fake.socketPath, "pane-1", "claude");
    expect(fake.requests).toEqual([
      {
        method: "pane.release_agent",
        params: {
          pane_id: "pane-1",
          source: PANE_AGENT_SOURCE,
          agent: "claude",
        },
      },
    ]);
  });

  it("rejects when the daemon refuses the report, so the caller can swallow it", async () => {
    const fake = await startFakeHerdr({
      fail: { "pane.report_agent": { code: -1, message: "no such pane" } },
    });
    await expect(
      reportPaneAgent(fake.socketPath, "pane-1", "claude", "working", "01 · t"),
    ).rejects.toThrow(/pane\.report_agent failed/);
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
        subscriptions: [
          { type: "pane.exited" },
          { type: "pane.closed" },
          { type: "tab.closed" },
        ],
      },
    });
    fake.pushEvent("pane_exited", { pane_id: "pane-1" });
    expect(await ending).toBe("exited");
  });

  it("settles closed when the pane's tab is closed", async () => {
    // Issue #61: `tab.close` pushes one `tab_closed` and no `pane_closed`
    // for the panes it took (verified against herdr 0.8.2), so a wait that
    // only listened for pane events parked for good when the operator
    // closed an attempt's tab. The tab event names no pane, so the wait
    // re-reads the listing and settles on the pane's absence.
    const fake = await startFakeHerdr({ workspaces: [{ workspace_id: "w7" }] });
    const tab = await openAttemptTab(fake.socketPath, "01 · Tab", "/work/tree", "w7");
    const ending = waitForPaneEnd(fake.socketPath, tab.paneId);
    await subscribedAndChecked(fake);
    await closeTab(fake.socketPath, tab.tabId);
    expect(await ending).toBe("closed");
  });

  it("keeps waiting through another tab's close", async () => {
    // Every subscriber sees every tab's close; only the listing says whose
    // pane went with it.
    const fake = await startFakeHerdr({ workspaces: [{ workspace_id: "w7" }] });
    const mine = await openAttemptTab(fake.socketPath, "01 · Mine", "/work/tree", "w7");
    const other = await openAttemptTab(fake.socketPath, "02 · Other", "/work/tree", "w7");
    const ending = waitForPaneEnd(fake.socketPath, mine.paneId);
    await subscribedAndChecked(fake);
    await closeTab(fake.socketPath, other.tabId);
    await until(
      "the listing re-read after the other tab's close",
      // The subscription's own liveness check, then the re-read the other
      // tab's close forces; opening a tab no longer lists anything.
      () => fake.requests.filter((r) => r.method === "pane.list").length >= 2,
    );
    let settled = false;
    void ending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    fake.pushEvent("pane_exited", { pane_id: mine.paneId });
    expect(await ending).toBe("exited");
  });

  it("settles lost at once when released mid-connect, and still lets go of the socket", async () => {
    // Issue #61: a release that lands before the connect completes must not
    // destroy a socket the runtime is still connecting. The wait resolves
    // immediately and the socket is torn down from its own connect callback,
    // so the daemon sees the subscriber arrive and leave.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const release = new AbortController();
    const ending = waitForPaneEnd(fake.socketPath, "pane-1", release.signal);
    release.abort();
    expect(await ending).toBe("lost");
    await until("the connection come and go", () => fake.connections === 1);
    await until("the subscriber go", () => fake.subscribers === 0);
  });

  it("resolves lost without connecting when released before it starts", async () => {
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const release = new AbortController();
    release.abort();
    expect(await waitForPaneEnd(fake.socketPath, "pane-1", release.signal)).toBe("lost");
    expect(fake.connections).toBe(0);
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
    expect(await waitForPaneEnd(join(dir, "absent.sock"), "pane-1")).toBe(
      "lost",
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("settles lost when the caller releases it", async () => {
    // The caller found the attempt's ending somewhere the daemon knows
    // nothing about, and wants its subscription back rather than leaving one
    // dead connection per attempt behind it.
    const fake = await startFakeHerdr({ foreignPanes: [LIVE_PANE] });
    const release = new AbortController();
    const ending = waitForPaneEnd(fake.socketPath, "pane-1", release.signal);
    await subscribedAndChecked(fake);
    release.abort();
    expect(await ending).toBe("lost");
    await until("the subscriber go", () => fake.subscribers === 0);
  });

  it("settles exited when the pane is already gone as the subscription lands", async () => {
    // Its end predated the subscription, so no event will ever arrive: the
    // liveness check on the ack is the only thing that can see it.
    const fake = await startFakeHerdr({ listOnly: [] });
    expect(await waitForPaneEnd(fake.socketPath, "pane-1")).toBe("exited");
  });
});

describe("HERDR_SOCKET_DEFAULT in a test run", () => {
  // Four tests once built terminal-backed pools with no fake, reached the
  // operator's live daemon through this default, and left a `pool-XXXXXX`
  // workspace behind on every run. The preload points it at scratch.
  it("is pointed away from the operator's daemon by the preload", () => {
    expect(process.env.HERDR_SOCKET_PATH).toBeTruthy();
    expect(HERDR_SOCKET_DEFAULT).toBe(process.env.HERDR_SOCKET_PATH!);
    expect(existsSync(HERDR_SOCKET_DEFAULT)).toBe(false);
    expect(HERDR_SOCKET_DEFAULT.startsWith(join(homedir(), ".config"))).toBe(false);
  });
});

describe("listPanes (issue #139)", () => {
  it("reads each pane's tab, workspace, directory and terminal id", async () => {
    const fake = await startFakeHerdr({
      foreignPanes: [
        { tab_id: "t1", pane_id: "p1", workspace_id: "w1" },
        // herdr 0.8.2's own fields, beyond the fake's usual three.
        { tab_id: "w7:t1", pane_id: "w7:p1", workspace_id: "w7", cwd: "/w", terminal_id: "term_65b1" } as FakePane,
      ],
    });
    expect(await listPanes(fake.socketPath)).toEqual([
      { paneId: "p1", tabId: "t1", workspaceId: "w1", cwd: null, terminalId: null },
      { paneId: "w7:p1", tabId: "w7:t1", workspaceId: "w7", cwd: "/w", terminalId: "term_65b1" },
    ]);
  });

  it("throws on an answer with no panes list rather than reading it as none (review item 8)", async () => {
    const { createServer } = await import("node:net");
    const dir = mkdtempSync(join(tmpdir(), "herdr-malformed-"));
    const socketPath = join(dir, "herdr.sock");
    const server = createServer((socket) => {
      socket.on("data", () => socket.end(`${JSON.stringify({ id: "1", result: { type: "ok" } })}\n`));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      await expect(listPanes(socketPath)).rejects.toThrow("without a panes list");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the root pane's terminal id off a tab.create answer that carries one", async () => {
    const { createServer } = await import("node:net");
    const dir = mkdtempSync(join(tmpdir(), "herdr-terminal-id-"));
    const socketPath = join(dir, "herdr.sock");
    const server = createServer((socket) => {
      socket.on("data", () =>
        socket.end(
          `${JSON.stringify({
            id: "1",
            result: {
              type: "tab_created",
              tab: { tab_id: "w7:t1" },
              root_pane: { pane_id: "w7:p1", tab_id: "w7:t1", terminal_id: "term_65b1" },
            },
          })}\n`,
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      expect(await openAttemptTab(socketPath, "01 · x", "/w", "w7")).toEqual({
        tabId: "w7:t1",
        paneId: "w7:p1",
        terminalId: "term_65b1",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
