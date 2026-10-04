/**
 * The remembered Pool workspace across a stop and start (issue #94, issue
 * #100), seen from outside the server (ADR-0036): which workspace the next
 * server resolves from what `runs/pool-workspace.json` remembers and the
 * workspace it was launched in, how boot reconciliation scopes its pane
 * listing to it, when a title edited while no server ran relabels it, and
 * what a torn record costs. Ticket C06 of the inventory's split
 * (docs/research/rust-port/test-inventory.md): each case names the engine
 * test it carries over, or the uncovered behaviour it pins.
 *
 * Every case starts two servers on one pool, the second as the next
 * takeover leg, with one fake herdr alive across both. The first creates
 * the Pool workspace (the fake mints `w1`), runs Ticket 01 to done and
 * stops; what changed while no server ran is done between the two.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Case, CaseServer } from "../harness/case.ts";
import { CLAUDE_READY, type HerdrCall, type HerdrProcess } from "../harness/herdr.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { StubHold } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import {
  TERMINAL,
  poolLog,
  quiescentWith,
  restartCase,
  settle,
  startLeg,
  ticket,
  untilLogged,
  untilState,
} from "./restart-support.ts";

/** The pool's directory name, which labels a workspace the pool creates untitled. */
const POOL = "workspace-pool";

/** The workspace the second server is launched in (HERDR_WORKSPACE_ID), which the fake holds. */
const LAUNCH = "w-launch";

/** The fake herdr's options: claude's ready frame, and the launch workspace held from the start. */
const HERDR = { rendered: CLAUDE_READY, workspaces: [LAUNCH] };

/** `runs/pool-workspace.json`, parsed. */
function remembered(world: World): unknown {
  return JSON.parse(readFileSync(join(world.pool, "runs", "pool-workspace.json"), "utf8"));
}

/** The herdr calls from index `from` on whose method is a workspace's. */
function workspaceCalls(herdr: HerdrProcess, from: number): { method: string; params: Record<string, unknown> }[] {
  return herdr.calls
    .slice(from)
    .filter((call) => call.method.startsWith("workspace."))
    .map((call) => ({ method: call.method, params: call.params }));
}

/** The calls of one method from index `from` on. */
function callsOf(herdr: HerdrProcess, method: string, from = 0): HerdrCall[] {
  return herdr.calls.slice(from).filter((call) => call.method === method);
}

/** A world whose pool is `POOL`, terminal-backed on claude, with Ticket 01 ready. */
function workspaceWorld(t: Case, config: Record<string, unknown> = {}): World {
  return t.world({ poolName: POOL, tickets: [ticket("01", "a")], config: { ...TERMINAL, ...config } });
}

/**
 * The first server, launched in no workspace: it creates the Pool workspace,
 * runs Ticket 01 to done in a tab there and stops at the Review.
 */
async function firstLeg(t: Case, world: World, herdr: HerdrProcess): Promise<void> {
  const first = await startLeg(t, world, 0, { herdr });
  await settle(first, "01 done and the Review raised", quiescentWith("REVIEW:review"), 60_000);
  expect(callsOf(herdr, "workspace.create").map((call) => call.params.label)).toHaveLength(1);
  expect(String(readEvents(world.pool, "01").find((event) => event.kind === "spawned")!.payload.pane_id)).toStartWith(
    "w1:",
  );
  await first.stop();
  await herdr.settle();
}

/** Ticket 02, ready, added while no server runs, so the next server has a tab to open. */
function addTicket02(world: World): void {
  writeFileSync(
    join(world.pool, "issues", "02-b.md"),
    "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n\nWork on 02.\n",
  );
}

/** Wait for Ticket 02 to run to done; the pane its Attempt was spawned into. */
async function until02Done(server: CaseServer, world: World): Promise<string> {
  await untilState(
    server,
    "02 done",
    (snapshot) => snapshot.state.tickets.some((each) => each.id === "02" && each.status === "done"),
    60_000,
  );
  return String(readEvents(world.pool, "02").find((event) => event.kind === "spawned")!.payload.pane_id);
}

// engine/herdr.test.ts:158
restartCase("a remembered Pool workspace still there wins over the launch workspace, asked for once and nothing else", async (t) => {
  const world = workspaceWorld(t);
  const herdr = await t.herdr(world, HERDR);
  await firstLeg(t, world, herdr);
  expect(remembered(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
  addTicket02(world);
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr, env: { HERDR_WORKSPACE_ID: LAUNCH } });

  const pane = await until02Done(second, world);
  expect(workspaceCalls(herdr, from)).toEqual([{ method: "workspace.get", params: { workspace_id: "w1" } }]);
  expect(callsOf(herdr, "tab.create", from).map((call) => call.params.workspace_id)).toEqual(["w1"]);
  expect(pane).toStartWith("w1:");
  expect(remembered(world)).toEqual({ workspace_id: "w1", created: true, label: POOL });
}, { timeoutMs: 120_000 });

// engine/herdr.test.ts:176
restartCase("a remembered Pool workspace closed while no server ran falls to the launch workspace, remembered from then on", async (t) => {
  const world = workspaceWorld(t);
  const herdr = await t.herdr(world, HERDR);
  await firstLeg(t, world, herdr);
  // The operator closes the Pool workspace while no server runs.
  await herdr.control("removeWorkspace", "w1");
  addTicket02(world);
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr, env: { HERDR_WORKSPACE_ID: LAUNCH } });

  const pane = await until02Done(second, world);
  expect(workspaceCalls(herdr, from)).toEqual([
    { method: "workspace.get", params: { workspace_id: "w1" } },
    { method: "workspace.get", params: { workspace_id: LAUNCH } },
  ]);
  expect(callsOf(herdr, "tab.create", from).map((call) => call.params.workspace_id)).toEqual([LAUNCH]);
  expect(pane).toStartWith(`${LAUNCH}:`);
  // The launch workspace is the operator's: remembered bare, never as made here.
  expect(remembered(world)).toEqual({ workspace_id: LAUNCH });
}, { timeoutMs: 120_000 });

// engine/herdr.test.ts:255
restartCase("boot reconciliation lists only the Pool workspace's panes: an orphan pane moved to another workspace is not re-adopted", async (t) => {
  const world = t.world({ poolName: POOL, tickets: [ticket("01", "a"), ticket("02", "b")], config: TERMINAL });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY, holdPane: true });
  const held: StubHold[] = [];
  for (const id of ["01", "02"]) {
    const hold = world.stubs.hold(id, {});
    held.push(hold);
    t.defer(() => hold.release(2_000).catch(() => {}));
  }
  const first = await startLeg(t, world, 0, { herdr });
  const panes = await until(
    () => ["01", "02"].map((id) => readEvents(world.pool, id).find((event) => event.kind === "spawned")?.payload.pane_id),
    (ids) => ids.every((id) => typeof id === "string"),
    { what: "01 and 02 spawned into panes", ms: 60_000 },
  );
  const [pane01, pane02] = panes.map(String) as [string, string];
  await until(() => world.stubs.calls().map((call) => call.key).sort(), (keys) => keys.join() === "01,02", {
    what: "both stubs launched",
    ms: 60_000,
  });
  await first.stop();
  // While no server runs, 02's tab is moved to another workspace: herdr
  // still runs its pane, now listed under w8.
  await herdr.control("relistPane", pane02, { workspaceId: "w8" });
  await herdr.settle();
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });

  await untilLogged(second, `ticket 01: attempt 1 re-adopted from live pane ${pane01}; waiting on its exit`);
  await untilLogged(second, "ticket 02: attempt 1's pane is gone at boot; the attempt crashed and the ticket re-runs");
  const listings = callsOf(herdr, "pane.list", from);
  expect(listings[0]!.params).toEqual({ workspace_id: "w1" });
  expect(readEvents(world.pool, "02").filter((event) => event.kind === "crash").map((event) => event.payload)).toEqual([
    { code: null, reason: "attempt pane gone at boot reconciliation", logTail: [], outcomeExists: false },
  ]);
  // 02 runs again in a new tab of the Pool workspace; the moved pane was
  // only let go of, never re-adopted, typed into or closed.
  await herdr.waitForCall((call) => call.method === "tab.create", { from, ms: 60_000 });
  expect(callsOf(herdr, "tab.create", from).map((call) => call.params.workspace_id)).toEqual(["w1"]);
  await herdr.settle();
  const onMoved = herdr.calls
    .slice(from)
    .filter((call) => call.params.pane_id === pane02)
    .map((call) => call.method);
  expect(onMoved.filter((method) => method !== "pane.read")).toEqual(["pane.release_agent"]);
}, { timeoutMs: 120_000 });

// Gap: engine/engine.ts:3039 (a title edited while no server ran)
restartCase("a Pool workspace the pool created is relabelled at boot to a title edited while no server ran", async (t) => {
  const world = workspaceWorld(t, { title: "Old title" });
  const herdr = await t.herdr(world, HERDR);
  await firstLeg(t, world, herdr);
  expect(remembered(world)).toEqual({ workspace_id: "w1", created: true, label: "Old title" });
  // The operator retitles the pool in console.json while no server runs.
  writeFileSync(join(world.pool, "console.json"), JSON.stringify({ ...TERMINAL, title: "New title" }, null, 2));
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });

  await untilLogged(second, 'Pool workspace w1 relabelled "New title"');
  expect(workspaceCalls(herdr, from)).toEqual([
    { method: "workspace.get", params: { workspace_id: "w1" } },
    { method: "workspace.rename", params: { workspace_id: "w1", label: "New title" } },
  ]);
  expect(remembered(world)).toEqual({ workspace_id: "w1", created: true, label: "New title" });
  expect(await herdr.control<string | null>("workspaceLabel", "w1")).toBe("New title");
}, { timeoutMs: 120_000 });

// Gap: engine/engine.ts:2929 (a torn runs/pool-workspace.json)
restartCase("a torn runs/pool-workspace.json is resolved afresh at boot and rewritten with the new workspace", async (t) => {
  const world = workspaceWorld(t);
  const herdr = await t.herdr(world, HERDR);
  await firstLeg(t, world, herdr);
  // A write cut off part way, while no server runs.
  writeFileSync(join(world.pool, "runs", "pool-workspace.json"), '{"workspace_id":"w1","crea');
  addTicket02(world);
  const from = herdr.calls.length;
  const second = await startLeg(t, world, 1, { herdr });

  const pane = await until02Done(second, world);
  expect(workspaceCalls(herdr, from)).toEqual([
    { method: "workspace.create", params: { label: POOL, cwd: world.repo, focus: false } },
  ]);
  expect(remembered(world)).toEqual({ workspace_id: "w2", created: true, label: POOL });
  expect(pane).toStartWith("w2:");
  expect(await poolLog(second)).toContain("Pool workspace w2 created for this pool's tabs");
}, { timeoutMs: 120_000 });
