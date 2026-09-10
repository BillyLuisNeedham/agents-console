import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPT_TAB_LABEL_MAX,
  attemptTabLabel,
  closeTab,
  herdrRpc,
  openAttemptTab,
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
    const fake = await startFakeHerdr();
    const tab = await openAttemptTab(fake.socketPath, "01 · Tab", "/work/tree");
    const ending = waitForPaneEnd(fake.socketPath, tab.paneId);
    await subscribedAndChecked(fake);
    await closeTab(fake.socketPath, tab.tabId);
    expect(await ending).toBe("closed");
  });

  it("keeps waiting through another tab's close", async () => {
    // Every subscriber sees every tab's close; only the listing says whose
    // pane went with it.
    const fake = await startFakeHerdr();
    const mine = await openAttemptTab(fake.socketPath, "01 · Mine", "/work/tree");
    const other = await openAttemptTab(fake.socketPath, "02 · Other", "/work/tree");
    const ending = waitForPaneEnd(fake.socketPath, mine.paneId);
    await subscribedAndChecked(fake);
    await closeTab(fake.socketPath, other.tabId);
    await until(
      "the listing re-read after the other tab's close",
      () => fake.requests.filter((r) => r.method === "pane.list").length >= 4,
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
