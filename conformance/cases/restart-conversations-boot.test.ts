/**
 * Conversations across a stop and start, decided at boot (issue #140, the
 * ADR-0018 amendment), seen from outside the server (ADR-0036). A stop leaves
 * a started Conversation's tab and TUI running, so the next server decides by
 * its pane, against one listing of herdr's panes: still its own and its TUI
 * running, it is re-adopted; gone, or its TUI exited, it is crashed with its
 * tab closed and its branch kept; listed as another terminal, it is crashed
 * and its tab and agent are left alone. A Conversation with no pane to ask
 * about is crashed at once. Ticket C06 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over.
 *
 * A case that starts two servers on its pool runs the second as the next
 * takeover leg (`restartCase`, `reboot`), with one fake herdr alive across
 * both. A case that seeds the record a dead server left starts one server.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { branches } from "../harness/git-pool.ts";
import { callsOf, CLAUDE_READY } from "../harness/herdr.ts";
import { poolLog, restartCase, settle, snapshotOf, untilLogged } from "./restart-support.ts";
import {
  DONE_01,
  callsOnPane,
  callsOnTab,
  closeFinished,
  conversationIn,
  endConversation,
  eventsOf,
  finishedNow,
  kindsOf,
  readoptedLine,
  reboot,
  recordStatus,
  recordText,
  startedThenStopped,
  untilEvent,
  untilRecord,
  viewNow,
} from "./restart-conversations-support.ts";

/** conv-1's record as the first server wrote it, at `status`, byte for byte. */
function startedRecord(status: string): string {
  return (
    `<!-- conversation: id=conv-1 status=${status} spawned-by=none harness=claude model=m drivers=implement -->\n\n` +
    "# Across a restart\n\n\n"
  );
}

// ---------------------------------------------------------------------------
// A started Conversation whose pane is still its own
// ---------------------------------------------------------------------------

// engine/conversations.test.ts:958
restartCase("a started Conversation whose pane is still its own is re-adopted at boot, and End closes its tab", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, tabId } = started;
  const from = herdr.calls.length;
  const second = await reboot(t, started);

  await untilLogged(second, readoptedLine("conv-1", paneId));
  expect(await viewNow(second)).toMatchObject({ id: "conv-1", status: "live", paneId, ending: false });
  expectSameBytes(recordText(world), startedRecord("live"));
  expect(kindsOf(world)).toEqual(["spawned"]);
  // Back the way a launch leaves it: its agent reported on its own pane
  // again, and nothing opened or typed.
  const report = await herdr.waitForCall(
    (call) => call.method === "pane.report_agent" && call.params.pane_id === paneId,
    { from, ms: 30_000 },
  );
  expect(report.params).toMatchObject({ pane_id: paneId, agent: "claude", source: "herdr:agent-console" });
  await herdr.settle();
  expect(callsOf(herdr, "tab.create", from)).toEqual([]);
  expect(callsOf(herdr, "pane.send_input", from)).toEqual([]);

  await endConversation(second);
  await untilRecord(world, "ended");
  await untilEvent(world, "ended");
  await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
  expect(kindsOf(world)).toEqual(["spawned", "end-requested", "tab-closed", "ended"]);
  expect(eventsOf(world, "tab-closed")[0]!.payload).toEqual({
    tab_id: tabId,
    terminal_id: started.terminalId,
    reason: "end",
  });
  expect(eventsOf(world, "ended")[0]!.payload).toEqual({ closing: null, by: "operator", merged: false });
  // Closed once: the ending's sweep finds the End's close on record.
  expect(await callsOnTab(herdr, tabId, from)).toEqual(["tab.close"]);
});

// engine/conversations.test.ts:1047
restartCase("a started Conversation whose tab moved to another workspace is re-adopted by its terminal id", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId } = started;
  // The operator moved the tab while no server ran: same pane, same
  // terminal, another workspace.
  await herdr.control("relistPane", paneId, { workspaceId: "w-elsewhere" });
  const second = await reboot(t, started);

  await untilLogged(second, readoptedLine("conv-1", paneId));
  expect(await viewNow(second)).toMatchObject({ status: "live", paneId });
  expect(recordStatus(world)).toBe("live");
  expect(eventsOf(world, "crash")).toEqual([]);
});

// keep-talking.test.ts:401
conformance(
  "restart",
  "a started Conversation left talking is re-adopted at boot and its tab is no Finished terminal",
  async (t) => {
    const world = t.world({
      tickets: [DONE_01],
      config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
      poolFiles: {
        "conversations/conv-1.md":
          "<!-- conversation: id=conv-1 status=live spawned-by=none harness=claude model=m drivers=tdd -->\n\n" +
          "# Left open\n\nhi\n",
      },
    });
    mkdirSync(join(world.pool, "runs"), { recursive: true });
    writeFileSync(
      join(world.pool, "runs", "conv-1.events.jsonl"),
      `${JSON.stringify({
        at: new Date(Date.now() - 60_000).toISOString(),
        attempt: 1,
        kind: "spawned",
        payload: { cwd: world.repo, pane_id: "p-conv", tab_id: "tab-ghost" },
      })}\n`,
    );
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
    await herdr.control("injectPane", "p-conv", { tabId: "tab-ghost", cwd: world.repo });
    const server = await t.start(world, { herdr });

    await untilLogged(server, readoptedLine("conv-1", "p-conv"));
    expect(await viewNow(server)).toMatchObject({ status: "live", paneId: "p-conv" });
    // A listing on demand: the live Conversation's tab is in use, not finished.
    expect(await closeFinished(server)).toBe(0);
    expect(await finishedNow(server)).toBe(0);
    await herdr.settle();
    expect(callsOf(herdr, "tab.close")).toEqual([]);
  },
);

// ---------------------------------------------------------------------------
// A started Conversation found dead at boot
// ---------------------------------------------------------------------------

// engine/conversations.test.ts:976
restartCase("a started Conversation whose pane went while no server ran is crashed at boot, its tab closed and its branch kept", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, tabId, branch, worktree } = started;
  await herdr.control("endPane", paneId);
  const from = herdr.calls.length;
  const second = await reboot(t, started);

  await untilRecord(world, "crashed");
  await untilEvent(world, "crash");
  expect(eventsOf(world, "crash").map((event) => event.payload)).toEqual([
    { reason: "engine restarted and its pane was gone" },
  ]);
  await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
  await untilEvent(world, "tab-closed");
  expect(kindsOf(world)).toEqual(["spawned", "crash", "tab-closed"]);
  expect(eventsOf(world, "tab-closed")[0]!.payload).toEqual({
    tab_id: tabId,
    terminal_id: started.terminalId,
    reason: "crashed at boot",
  });
  const release = await herdr.waitForCall(
    (call) => call.method === "pane.release_agent" && call.params.pane_id === paneId,
    { from, ms: 30_000 },
  );
  expect(release.params).toEqual({ pane_id: paneId, source: "herdr:agent-console", agent: "claude" });
  expect(await poolLog(second)).toContain("conversation conv-1: crashed at boot, its pane was gone; its tab is closed");
  expectSameBytes(recordText(world), startedRecord("crashed"));
  expect((await viewNow(second)).status).toBe("crashed");
  // Kept, as for any crash after going live.
  expect(branches(world.repo)).toContain(branch);
  expect(existsSync(worktree)).toBe(true);
});

// engine/conversations.test.ts:993
restartCase("a started Conversation whose TUI exited while no server ran is crashed at boot and the tab left at its shell closed", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, tabId } = started;
  // The wrapper's record that the TUI exited, newer than the launch.
  writeFileSync(join(world.pool, "runs", "conv-1.exitcode"), "0\n");
  const from = herdr.calls.length;
  const second = await reboot(t, started);

  await untilRecord(world, "crashed");
  await untilEvent(world, "crash");
  expect(eventsOf(world, "crash").map((event) => event.payload)).toEqual([
    { reason: "engine restarted and its TUI had exited" },
  ]);
  await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
  await herdr.waitForCall((call) => call.method === "pane.release_agent" && call.params.pane_id === paneId, {
    from,
    ms: 30_000,
  });
  expect(await poolLog(second)).toContain("conversation conv-1: crashed at boot, its TUI had exited; its tab is closed");
  expectSameBytes(recordText(world), startedRecord("crashed"));
});

// engine/conversations.test.ts:1028
restartCase("a started Conversation whose pane herdr lists as another terminal is crashed, its tab and agent untouched", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, tabId } = started;
  // The same pane and tab ids, another terminal behind them.
  await herdr.control("relistPane", paneId, { terminalId: "term-someone-else" });
  const from = herdr.calls.length;
  const second = await reboot(t, started);

  await untilRecord(world, "crashed");
  // At rest, boot reconciliation is over.
  await settle(second, "the drive at rest");
  expect(eventsOf(world, "crash").map((event) => event.payload)).toEqual([
    { reason: `engine restarted and herdr lists pane ${paneId} as another terminal` },
  ]);
  expect(await poolLog(second)).toContain(
    `conversation conv-1: crashed at boot; herdr lists its pane ${paneId} as another terminal, ` +
      "so its tab and agent were left as they are",
  );
  expect(await callsOnTab(herdr, tabId, from)).toEqual([]);
  expect((await callsOnPane(herdr, paneId, from)).filter((method) => method !== "pane.read")).toEqual([]);
  expectSameBytes(recordText(world), startedRecord("crashed"));
});

// ---------------------------------------------------------------------------
// Records a dead server left, booted on once
// ---------------------------------------------------------------------------

// engine/conversations.test.ts:898
conformance("restart", "a Conversation recorded live in a headless pool is crashed before the first snapshot", async (t) => {
  const record = (status: string) =>
    `<!-- conversation: id=conv-1 status=${status} spawned-by=none harness=claude model=opus drivers=implement -->\n\n` +
    "# Left running\n\nstill going when the engine died\n";
  const world = t.world({
    tickets: [DONE_01],
    config: { defaults: { harness: "claude", model: "m" } },
    poolFiles: { "conversations/conv-1.md": record("live") },
  });
  const server = await t.start(world);

  // By the first snapshot the server serves, the record is already crashed.
  const first = await snapshotOf(server);
  expect(conversationIn(first).status).toBe("crashed");
  expectSameBytes(recordText(world), record("crashed"));
  expect(eventsOf(world, "crash").map((event) => event.payload)).toEqual([
    { reason: "engine restarted and the Conversation had no pane to re-adopt" },
  ]);
  expect(kindsOf(world)).toEqual(["crash"]);
});

// engine/conversations.test.ts:1229
conformance("restart", "an enlisted Conversation whose pane herdr no longer lists is crashed at boot and its tab never closed", async (t) => {
  const world = t.world({
    tickets: [DONE_01],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
  });
  const record = (status: string) =>
    `<!-- conversation: id=conv-1 status=${status} spawned-by=none harness=claude model= drivers=implement ` +
    `pane=pane-op tab=tab-op directory=${encodeURIComponent(world.repo)} branch=main session=none -->\n\n` +
    "# Enlisted\n\n\n";
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  writeFileSync(join(world.pool, "conversations", "conv-1.md"), record("live"));
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });

  await untilRecord(world, "crashed");
  await settle(server, "the drive at rest");
  expect(eventsOf(world, "crash").map((event) => event.payload)).toEqual([{ reason: "enlisted pane gone at boot" }]);
  expectSameBytes(recordText(world), record("crashed"));
  await herdr.settle();
  expect(callsOf(herdr, "tab.close")).toEqual([]);
  expect(callsOf(herdr, "pane.close")).toEqual([]);
});
