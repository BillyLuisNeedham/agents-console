/**
 * A Console Stop on a live pool, seen from outside the server (ADR-0039,
 * ADR-0036): Stop is offered in every phase, and leaves the world as a
 * Restart leaves it before its relaunch. A terminal-backed Attempt and a
 * started Conversation keep running in their herdr panes, nothing on the
 * herdr socket closes or kills them, and the next server on the same pool
 * re-adopts both: the Attempt behind its adoption checkpoint until its pane's
 * TUI finishes, the Conversation live in its own pane.
 *
 * The fake herdr runs beside both servers, as a live daemon outlives a stop,
 * and keeps a pane open after its wrapper exits (`holdPane`). Ticket 01's
 * stub is held in its pane across the stop and let go only once the second
 * server has re-adopted it, so its Outcome landing proves the harness
 * process the first server started was still alive.
 */

import { expect } from "bun:test";
import type { ConversationView, EnrichedSnapshot } from "../../protocol/wire.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import { callsOf, CLAUDE_READY } from "../harness/herdr.ts";
import { readEvents, readTicketFile, until } from "../harness/pool-files.ts";
import type { StubHold } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import { readoptedLine, recordStatus, viewNow } from "./restart-conversations-support.ts";
import { TERMINAL, eventLine, restartCase, settle, startLeg, stateLine, ticket, untilLogged, untilState } from "./restart-support.ts";

// protocol/protocol.ts CLOSE_STOPPED: how the server closes a socket on an orderly stop.
const CLOSE_STOPPED = { code: 1000, reason: "stopped" };

/** The body Ticket 01 is seeded with. */
const BODY = "# 01\n\nWork on 01.";

/** Long enough for the case; the stub ends early once its world is gone. */
const HOLD_SECONDS = 150;

function cardOf(snapshot: EnrichedSnapshot, id: string) {
  const card = snapshot.state.tickets.find((each) => each.id === id);
  if (!card) throw new Error(`no Ticket ${id} in the snapshot`);
  return card;
}

/** Hold `key`'s launches, and let them go at the teardown if the case failed first. */
function holdStub(t: Case, world: World, key: string, behaviour: Parameters<World["stubs"]["hold"]>[1]): StubHold {
  const held = world.stubs.hold(key, behaviour);
  let released = false;
  t.defer(async () => {
    if (!released) await held.release(2_000).catch(() => {});
  });
  return {
    async release(ms) {
      await held.release(ms);
      released = true;
    },
  };
}

/** The adoption checkpoint's body for attempt 1 in `paneId`, word for word. */
function adoptionBody(paneId: string): string {
  return (
    "The engine restarted while this ticket's terminal-backed attempt 1 was still running in herdr pane " +
    `${paneId}. The pane proved live at boot, so the engine re-adopted the attempt and is waiting on the ` +
    "pane's exit; the attempt's real outcome will be recorded then. Answering this interrupt abandons the " +
    "attempt (the pane is closed) and re-runs the ticket."
  );
}

/** Ticket 01 live in a pane with its stub reading the prompt, and conv-1 live beside it; both panes. */
async function bothLive(server: CaseServer, world: World): Promise<{ ticketPane: string; conversationPane: string }> {
  const live = await untilState(server, "01 live in a pane", (s) => cardOf(s, "01").liveAttempt?.paneId != null, 60_000);
  await until(() => world.stubs.calls().some((call) => call.key === "01"), (read) => read, {
    what: "01's stub to read its prompt",
    ms: 60_000,
  });
  // Scripted only now: a launch with `_claude` scripted never waits for a
  // Ticket prompt, so 01's would have been taken for the Conversation's.
  world.stubs.script("_claude", { hold: HOLD_SECONDS });
  const started = await server.http.post("/api/conversations", { title: "Across a stop" });
  expect(started.status, started.text).toBe(201);
  const view = started.json<{ conversation: ConversationView }>().conversation;
  expect(view).toMatchObject({ id: "conv-1", status: "live" });
  const spawned = readEvents(world.pool, view.id).find((event) => event.kind === "spawned");
  if (!spawned) throw new Error("conv-1 has no spawned event");
  return { ticketPane: cardOf(live, "01").liveAttempt!.paneId!, conversationPane: String(spawned.payload.pane_id) };
}

restartCase(
  "a Console stop while a terminal-backed Attempt and a Conversation run leaves both panes alive, and the next server re-adopts them",
  async (t) => {
    const world = t.world({ tickets: [ticket("01", "a", { body: BODY })], config: TERMINAL });
    const herdr = await t.herdr(world, { rendered: CLAUDE_READY, holdPane: true });
    const held = holdStub(t, world, "01", { status: "done" });
    const first = await startLeg(t, world, 0, { herdr });
    const { ticketPane, conversationPane } = await bothLive(first, world);
    expect((await untilState(first, "the pool running", (s) => s.phase === "running")).phase).toBe("running");

    const tab = await t.socket(first);
    await tab.waitFor((frame) => frame.type === "snapshot" && frame.snapshot !== null);
    await herdr.settle();
    const atStop = herdr.calls.length;

    // Accepted while running, with one farewell and a clean close.
    const stop = await first.http.post("/api/stop");
    expect(stop.status).toBe(202);
    expect(stop.json<unknown>()).toEqual({ stopping: true });
    expect(await tab.closed).toEqual(CLOSE_STOPPED);
    expect(tab.frames.filter((frame) => frame.type === "delta" && frame.delta.set?.phase === "stopped")).toHaveLength(1);
    expect(tab.pushed?.snapshot.phase).toBe("stopped");
    await until(() => first.exited(), (gone) => gone, { ms: 20_000, what: "the first server to exit" });
    await first.stop();
    await expect(fetch(`${first.url}/api/state`)).rejects.toThrow();

    // Nothing on the herdr socket closed or killed a pane, and herdr still lists both.
    await herdr.settle();
    for (const method of ["pane.close", "tab.close", "pane.send_input"]) {
      expect([method, callsOf(herdr, method, atStop)]).toEqual([method, []]);
    }
    const listed = await herdr.control<string[]>("listedPanes");
    expect(listed).toContain(ticketPane);
    expect(listed).toContain(conversationPane);
    // The stop recorded no end for either: 01 is still in-progress on attempt 1, conv-1 still live.
    expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned"]);
    expect(readTicketFile(world.pool, "01-a.md").startsWith(stateLine("01", "in-progress"))).toBe(true);
    expect(recordStatus(world)).toBe("live");
    expect(readEvents(world.pool, "conv-1").map((event) => event.kind)).toEqual(["spawned"]);

    // The relaunch of the same pool re-adopts both, opening nothing new.
    const atBoot = herdr.calls.length;
    const second = await startLeg(t, world, 1, { herdr });
    await untilLogged(second, readoptedLine("conv-1", conversationPane));
    expect(await viewNow(second)).toMatchObject({ id: "conv-1", status: "live", paneId: conversationPane });
    const adopted = await untilState(
      second,
      "01's adoption checkpoint",
      (s) => s.state.interrupts.some((interrupt) => interrupt.ticketId === "01" && interrupt.kind === "checkpoint"),
    );
    expect(adopted.state.interrupts.find((interrupt) => interrupt.ticketId === "01")?.body).toBe(adoptionBody(ticketPane));
    expect(cardOf(adopted, "01")).toMatchObject({ status: "in-progress", liveAttempt: { attempt: 1, paneId: ticketPane } });

    // The harness the first server launched was alive all along: let go now,
    // its done Outcome lands on the re-adopted Attempt, which merges at once (ADR-0041).
    await held.release();
    await untilState(second, "01 done", (s) => cardOf(s, "01").status === "done", 60_000);
    await until(() => eventLine(world, "01"), (lines) => lines.includes("1 tab-closed"), { what: "01's tab-closed" });
    expect(eventLine(world, "01")).toEqual(["1 scheduled", "1 spawned", "1 exited", "1 merged", "1 tab-closed"]);
    await herdr.settle();
    expect(callsOf(herdr, "tab.create", atBoot)).toEqual([]);
    expect(world.stubs.calls().filter((call) => call.key === "01")).toHaveLength(1);
    await settle(second, "the drive to rest");
  },
  { timeoutMs: 180_000 },
);
