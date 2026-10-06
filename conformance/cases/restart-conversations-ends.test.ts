/**
 * Conversations a boot could not settle, and Ends a stop cut short (issue
 * #140), seen from outside the server (ADR-0036). A daemon that cannot be
 * asked, or a pane that cannot be read, changes nothing at boot: the record
 * stays live, its pane stays the pool's, and the pane survey's next listing
 * tries again; an End still ends it, closing its tab only when herdr lists
 * that tab as its own. An End in flight when the server stopped is finished
 * as the ending it was, or held at the Interrupt that owns its merge. Ticket
 * C06 of the inventory's split (docs/research/rust-port/test-inventory.md):
 * each case names the engine test it carries over.
 *
 * The pane survey lists every fifteen seconds (Decided 2: real timings), so
 * a case that needs the survey's own listing waits for it and is named slow.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { gitIn } from "../harness/git-pool.ts";
import { OPENCODE_WAITING, type HerdrCall } from "../harness/herdr.ts";
import { answer, poolLog, quiescentWith, restartCase, settle, untilLogged, untilState } from "./restart-support.ts";
import {
  DONE_01,
  appendEvent,
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

/** A daemon-wide `pane.list`, the listing a Conversation's boot adoption and the pane survey take. */
function daemonWide(call: HerdrCall): boolean {
  return call.method === "pane.list" && Object.keys(call.params).length === 0;
}

/** Commit one file in a Conversation's worktree, while no server runs. */
function commitIn(worktree: string, file: string): void {
  writeFileSync(join(worktree, file), "work\n");
  gitIn(worktree, ["add", "-A"]);
  gitIn(worktree, ["commit", "-qm", `add ${file}`]);
}

// ---------------------------------------------------------------------------
// A daemon that could not be asked at boot
// ---------------------------------------------------------------------------

// engine/conversations.test.ts:1061
restartCase(
  "a live record whose daemon did not answer at boot stays live, is re-adopted on a later listing, and its tab is never finished",
  async (t) => {
    const started = await startedThenStopped(t);
    const { world, herdr, paneId, tabId } = started;
    await herdr.control("fail", "pane.list", true);
    const from = herdr.calls.length;
    const second = await reboot(t, started);

    await herdr.waitForCall(daemonWide, { from, ms: 30_000 });
    await settle(second, "the drive at rest");
    // Unadopted, still live, still the pool's pane.
    expect(recordStatus(world)).toBe("live");
    expect(await viewNow(second)).toMatchObject({ status: "live", paneId, ending: false });
    const log = await poolLog(second);
    expect(log).toContain("terminal reconciliation skipped: herdr daemon unreachable");
    expect(log).not.toContain(readoptedLine("conv-1", paneId));

    // The daemon answers again; the pane survey's next listing, on its
    // cadence, re-adopts it.
    await herdr.control("fail", "pane.list", false);
    await untilLogged(second, readoptedLine("conv-1", paneId), 45_000);
    expect(await finishedNow(second)).toBe(0);
    expect(await closeFinished(second)).toBe(0);
    expect(await callsOnTab(herdr, tabId, from)).toEqual([]);
    expect(recordStatus(world)).toBe("live");
    expect(eventsOf(world, "crash")).toEqual([]);
  },
  { slow: true },
);

// engine/conversations.test.ts:1087
restartCase("a live record the boot could not read is still Ended, its own tab closed", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, tabId } = started;
  // The pane cannot be read, so the boot leaves the record live and
  // unadopted; the listing works, so its tab is known to be its own.
  await herdr.control("fail", "pane.read", true);
  const from = herdr.calls.length;
  const second = await reboot(t, started);

  await herdr.waitForCall((call) => call.method === "pane.read" && call.params.pane_id === paneId, { from, ms: 30_000 });
  await settle(second, "the drive at rest");
  expect(recordStatus(world)).toBe("live");
  // A listing on demand, which tries the adoption again and fails again:
  // the record is live and its tab no Finished terminal.
  expect(await closeFinished(second)).toBe(0);
  expect(await finishedNow(second)).toBe(0);
  expect(recordStatus(world)).toBe("live");
  expect(await poolLog(second)).not.toContain(readoptedLine("conv-1", paneId));

  await endConversation(second);
  await untilRecord(world, "ended");
  await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
  await herdr.waitForCall((call) => call.method === "pane.release_agent" && call.params.pane_id === paneId, {
    from,
    ms: 30_000,
  });
  expect(eventsOf(world, "crash")).toEqual([]);
  expect(eventsOf(world, "ended").map((event) => event.payload)).toEqual([
    { closing: null, by: "operator", merged: false },
  ]);
});

// engine/conversations.test.ts:1134
restartCase("two Ends racing on a record the boot could not read end it once", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, paneId, worktree } = started;
  commitIn(worktree, "raced.txt");
  await herdr.control("fail", "pane.read", true);
  const from = herdr.calls.length;
  const second = await reboot(t, started);
  await herdr.waitForCall((call) => call.method === "pane.read" && call.params.pane_id === paneId, { from, ms: 30_000 });
  await settle(second, "the drive at rest");
  expect(recordStatus(world)).toBe("live");

  const ends = await Promise.all([
    second.http.post("/api/conversations/end", { id: "conv-1" }),
    second.http.post("/api/conversations/end", { id: "conv-1" }),
  ]);
  expect(ends.map((each) => each.status)).toEqual([202, 202]);
  await untilRecord(world, "ended");
  await untilEvent(world, "ended");
  // Let a second ending land, were there one, before counting.
  await Bun.sleep(500);
  const kinds = kindsOf(world);
  for (const kind of ["end-requested", "merged", "ended"]) {
    expect(kinds.filter((each) => each === kind)).toEqual([kind]);
  }
  expect(readFileSync(join(world.repo, "raced.txt"), "utf8")).toBe("work\n");
  expect(eventsOf(world, "ended")[0]!.payload).toEqual({ closing: null, by: "operator", merged: true });
});

// engine/conversations.test.ts:1200
restartCase(
  "an End on a record the boot could not list releases no agent and closes no tab when herdr then lists another terminal under its ids",
  async (t) => {
    const started = await startedThenStopped(t);
    const { world, herdr, paneId, tabId } = started;
    await herdr.control("fail", "pane.list", true);
    const from = herdr.calls.length;
    const second = await reboot(t, started);
    const boot = await herdr.waitForCall(daemonWide, { from, ms: 30_000 });
    await settle(second, "the drive at rest");
    expect(recordStatus(world)).toBe("live");

    // Just after the pane survey's first refused listing, so its next one,
    // fifteen seconds off, cannot re-adopt the record before the End: herdr
    // now lists a different terminal under the recorded pane and tab ids,
    // and answers again.
    await herdr.waitForCall((call) => daemonWide(call) && call.at >= boot.at + 5_000, { from, ms: 45_000 });
    await herdr.control("relistPane", paneId, { terminalId: "term-someone-else" });
    await herdr.control("fail", "pane.list", false);
    const before = herdr.calls.length;
    await endConversation(second);
    await untilRecord(world, "ended");
    await untilEvent(world, "ended");

    expect(eventsOf(world, "ended").map((event) => event.payload)).toEqual([
      { closing: null, by: "operator", merged: false },
    ]);
    expect(eventsOf(world, "crash")).toEqual([]);
    expect(kindsOf(world)).not.toContain("tab-closed");
    expect(await callsOnTab(herdr, tabId, before)).toEqual([]);
    expect((await callsOnPane(herdr, paneId, before)).filter((method) => method !== "pane.read")).toEqual([]);
  },
  { slow: true },
);

// ---------------------------------------------------------------------------
// An End the stop cut short
// ---------------------------------------------------------------------------

// engine/conversations.test.ts:1112
restartCase("an End in flight at the stop is finished at boot as ended, not crashed", async (t) => {
  const started = await startedThenStopped(t);
  const { world, herdr, tabId } = started;
  // The End was asked for and recorded, and the server stopped before it finished.
  appendEvent(world, "end-requested", { closing: null });
  const from = herdr.calls.length;
  await reboot(t, started);

  await untilRecord(world, "ended");
  await untilEvent(world, "ended");
  await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
  await untilEvent(world, "tab-closed");
  expect(kindsOf(world)).toEqual(["spawned", "end-requested", "tab-closed", "ended"]);
  expect(eventsOf(world, "ended")[0]!.payload).toEqual({ closing: null, by: "operator", merged: false });
  expectSameBytes(
    recordText(world),
    "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n" +
      "# Across a restart\n\n\n",
  );
});

// engine/conversations.test.ts:1164
restartCase(
  "an End whose merge a cut-off resolver held is held at boot on a merge-conflict Interrupt, and Resume merges and ends it",
  async (t) => {
    const started = await startedThenStopped(t);
    const { world, herdr, paneId, tabId, branch, worktree } = started;
    commitIn(worktree, "resolving.txt");
    // The End handed its merge to a resolver, and the server stopped while it
    // ran: no Interrupt was raised.
    appendEvent(world, "end-requested", { closing: "bye" });
    appendEvent(world, "merge-conflict");
    appendEvent(world, "resolver");
    const from = herdr.calls.length;
    const second = await reboot(t, started);

    const held = await untilState(second, "conv-1 held ending at its Interrupt", (snapshot) =>
      snapshot.state.interrupts.some((each) => each.ticketId === "conv-1"),
    );
    expect(held.state.interrupts.filter((each) => each.ticketId === "conv-1")).toEqual([
      {
        ticketId: "conv-1",
        kind: "merge-conflict",
        body:
          "The engine stopped while the resolver ran on conversation conv-1's End; " +
          `the branch is parked at ${branch}. Resolve it by hand, or answer resume to re-attempt the merge.`,
      },
    ]);
    expect(conversationIn(held)).toMatchObject({ status: "live", ending: true, paneId: null });
    // Nothing merged again on its own.
    expect(kindsOf(world)).not.toContain("merged");
    expect(existsSync(join(world.repo, "resolving.txt"))).toBe(false);

    await answer(second, { ticketId: "conv-1" });
    await untilRecord(world, "ended");
    await untilEvent(world, "ended");
    expect(readFileSync(join(world.repo, "resolving.txt"), "utf8")).toBe("work\n");
    expect(kindsOf(world).filter((kind) => kind === "merged")).toEqual(["merged"]);
    expect(eventsOf(world, "ended")[0]!.payload).toEqual({ closing: "bye", by: "operator", merged: true });
    // The ending lets the pane's agent go and sweeps the tab the End never closed.
    await herdr.waitForCall((call) => call.method === "pane.release_agent" && call.params.pane_id === paneId, {
      from,
      ms: 30_000,
    });
    await herdr.waitForCall((call) => call.method === "tab.close" && call.params.tab_id === tabId, { from, ms: 30_000 });
    await settle(second, "conv-1's Interrupt gone", quiescentWith("REVIEW:review"));
  },
);

// ---------------------------------------------------------------------------
// An enlisted Conversation's daemon answering malformed
// ---------------------------------------------------------------------------

// engine/herdr.test.ts:544
conformance("restart", "an agent.list answered without an agents list leaves a live enlisted Conversation live at boot", async (t) => {
  const world = t.world({
    tickets: [DONE_01],
    config: { defaults: { harness: "opencode", model: "m" }, terminal: "herdr" },
  });
  const record =
    "<!-- conversation: id=conv-1 status=live spawned-by=none harness=opencode model= drivers=implement " +
    `pane=pane-op tab=tab-op directory=${encodeURIComponent(world.repo)} branch=main session=none -->\n\n` +
    "# Enlisted\n\n\n";
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  writeFileSync(join(world.pool, "conversations", "conv-1.md"), record);
  const herdr = await t.herdr(world, { rendered: OPENCODE_WAITING });
  // The operator's pane is still there, but the daemon's agent listing
  // comes back with no agents array: read as none, it would say the pane
  // had gone.
  await herdr.control("seedAgent", {
    paneId: "pane-op",
    agent: "opencode",
    cwd: world.repo,
    title: "OC",
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId: "tab-op",
  });
  await herdr.control("answerWith", "agent.list", { result: { type: "agent_list" } });
  const server = await t.start(world, { herdr });

  await herdr.waitForCall((call) => call.method === "agent.list", { ms: 30_000 });
  await settle(server, "the drive at rest");
  expectSameBytes(recordText(world), record);
  expect(kindsOf(world)).toEqual([]);
  expect((await viewNow(server)).status).toBe("live");
});
