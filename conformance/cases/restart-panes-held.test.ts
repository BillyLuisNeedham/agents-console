/**
 * Held panes after a restart (issue #139, ADR-0027), seen from outside the
 * server (ADR-0036): a server booting on a pool whose Ticket waits at a
 * checkpoint reads back, from the Ticket's events alone, which Attempt's
 * pane the checkpoint holds, and holds it while the fake herdr lists it.
 * It holds the pane of the Attempt the latest checkpoint was raised for, an
 * enlisted Ticket's found pane while the Ticket still works in it, and
 * nothing for an engine-raised checkpoint about a held branch or for an
 * enlisted pane the pool let go. Ticket C06 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over.
 *
 * Each case boots one server over the events a stopped server leaves, written
 * by hand, with the panes they name injected into the fake herdr. A case
 * whose Ticket holds nothing carries the witness of herdr-panes-support.ts,
 * a Ticket held over a listed pane, so the pane survey is known to have
 * listed when the Ticket is read.
 */

import { expect } from "bun:test";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import type { World } from "../harness/world.ts";
import {
  bootWorld,
  event,
  fakeHerdr,
  plantWitness,
  ticketAt,
  ticketIn,
  untilHeld,
  untilInterrupt,
  untilSurveyed,
  writeEvents,
} from "./herdr-panes-support.ts";

/** A terminal-backed claude spawn's payload in the pool checkout, in pane `paneId` and tab `tabId`. */
function inPane(world: World, paneId: string, tabId: string): Record<string, unknown> {
  return { argv: ["claude"], cwd: world.repo, branch: null, harness: "claude", model: "m", pane_id: paneId, tab_id: tabId };
}

/** An enlisted opencode spawn's payload, in the operator's pane p-op, on main in the pool checkout. */
function enlistedSpawn(world: World): Record<string, unknown> {
  return { argv: [], cwd: world.repo, branch: "main", harness: "opencode", pane_id: "p-op", tab_id: "tab-ghost" };
}

/** The checkpoint Interrupts on a snapshot, by Ticket id. */
function checkpointsOf(snapshot: EnrichedSnapshot): string[] {
  return snapshot.state.interrupts.filter((each) => each.kind === "checkpoint").map((each) => each.ticketId).sort();
}

// engine/held-panes.test.ts:93
conformance("restart", "the pane held at boot is the one of the Attempt the latest checkpoint was raised for", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("01", "checkpoint")] });
  // Attempt 1 checkpointed, was answered, attempt 2 crashed and was
  // answered, and attempt 3 checkpointed. Attempt 1's pane is still listed
  // too, so the latest checkpoint, not the first listed pane, decides.
  writeEvents(world, "01", [
    event(1, "scheduled"),
    event(1, "spawned", inPane(world, "p-1", "t-1")),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(1, "checkpoint"),
    event(1, "answered", { kind: "checkpoint" }),
    event(2, "scheduled"),
    event(2, "spawned", inPane(world, "p-2", "t-2")),
    event(2, "exited", { code: 3, status: "in-progress" }),
    event(2, "crash", { code: 3, reason: "harness exited 3" }),
    event(2, "answered", { kind: "crash" }),
    event(3, "scheduled"),
    event(3, "spawned", inPane(world, "p-3", "t-3")),
    event(3, "exited", { code: 0, status: "checkpoint" }),
    event(3, "checkpoint"),
  ]);
  const herdr = await fakeHerdr(t, world);
  await herdr.control("injectPane", "p-1", { tabId: "t-1", cwd: world.repo });
  await herdr.control("injectPane", "p-3", { tabId: "t-3", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  expect(await untilHeld(server, "01")).toEqual({ attempt: 3, paneId: "p-3" });
  const surveyed = await untilSurveyed(server);
  expect(checkpointsOf(surveyed)).toEqual(["01", "09"]);
  expect(ticketIn(surveyed, "01").heldPane).toEqual({ attempt: 3, paneId: "p-3" });
});

// engine/keep-talking.test.ts:637
conformance("restart", "a checkpointed Attempt's own pane, still listed, is held at boot", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("01", "checkpoint")] });
  writeEvents(world, "01", [
    event(1, "spawned", inPane(world, "p-x", "tab-ghost")),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(1, "checkpoint"),
  ]);
  const herdr = await fakeHerdr(t, world);
  await herdr.control("injectPane", "p-x", { tabId: "tab-ghost", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  await untilInterrupt(server, "01", "checkpoint");
  expect(await untilHeld(server, "01")).toEqual({ attempt: 1, paneId: "p-x" });
});

// engine/keep-talking.test.ts:651
conformance("restart", "an engine-raised checkpoint about a held branch holds no pane at boot", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("01", "checkpoint")] });
  writeEvents(world, "01", [
    event(1, "spawned", inPane(world, "p-x", "tab-ghost")),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(1, "branch-held", { branch: "b", directory: "/elsewhere" }),
    event(1, "checkpoint"),
  ]);
  const herdr = await fakeHerdr(t, world);
  await herdr.control("injectPane", "p-x", { tabId: "tab-ghost", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  const surveyed = await untilSurveyed(server);
  expect(checkpointsOf(surveyed)).toEqual(["01", "09"]);
  expect(ticketIn(surveyed, "01").heldPane).toBeNull();
});

// engine/keep-talking.test.ts:675
conformance("restart", "an enlisted Ticket's checkpointed pane is held at boot", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("enlist-1", "checkpoint", "enlisted-from=p-op")] });
  writeEvents(world, "enlist-1", [
    event(1, "spawned", enlistedSpawn(world)),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(1, "checkpoint"),
  ]);
  const herdr = await fakeHerdr(t, world);
  await herdr.control("injectPane", "p-op", { tabId: "tab-ghost", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  await untilInterrupt(server, "enlist-1", "checkpoint");
  expect(await untilHeld(server, "enlist-1")).toEqual({ attempt: 1, paneId: "p-op" });
});

// engine/keep-talking.test.ts:719
conformance("restart", "an enlisted pane the pool let go is never held, across a restart", async (t) => {
  const world = bootWorld(t, { tickets: [ticketAt("enlist-1", "checkpoint", "enlisted-from=p-op")] });
  writeEvents(world, "enlist-1", [
    event(1, "spawned", enlistedSpawn(world)),
    event(1, "exited", { code: 0, status: "checkpoint" }),
    event(1, "let-go", { pane_id: "p-op" }),
    event(1, "checkpoint"),
  ]);
  const herdr = await fakeHerdr(t, world);
  await herdr.control("injectPane", "p-op", { tabId: "tab-ghost", cwd: world.repo });
  await plantWitness(world, herdr);
  const server = await t.start(world, { herdr });

  const surveyed = await untilSurveyed(server);
  expect(checkpointsOf(surveyed)).toEqual(["09", "enlist-1"]);
  expect(ticketIn(surveyed, "enlist-1").heldPane).toBeNull();
});
