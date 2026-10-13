/**
 * The two terminal phases a run reports, seen from outside the server (the
 * inventory's ticket C03): `dead`, which a drive killed by an error it
 * cannot continue from reports itself with (runs/errors.jsonl, a last pool
 * log line, the dead phase on the snapshot), and `stopped`, the farewell an
 * orderly stop sends once, as the next snapshot after the run's last.
 *
 * A drive is killed here the way the engine test kills it: the Ticket's
 * harness binary is not on the server's PATH, so its launch fails inside
 * the super-step.
 */

import { expect } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLOSE_STOPPED } from "../fixtures/socket-protocol.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { anyIsoTime } from "../harness/equal.ts";
import { parseJsonl, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import { CONFIG, finishRun, phaseFrames, snapshotOf, ticket, type PhaseFrame } from "./server-support.ts";

/**
 * Take the claude stub off the world's PATH, so a launch on claude fails.
 * Nothing else on that PATH may be a claude, or the case proves nothing.
 */
function withoutClaude(world: World): void {
  rmSync(join(world.stubs.bin, "claude"));
  const found = Bun.which("claude", { PATH: world.env("").PATH! });
  if (found !== null) throw new Error(`a claude outside the stubs is on the server's PATH (${found}); this case needs none`);
}

/** Wait until the socket's frames end on `phase`, then for a round trip, so any frame behind it is in hand. */
async function untilLastPhase(tab: SocketClient, phase: string, ms = 30_000): Promise<PhaseFrame[]> {
  await until(() => phaseFrames(tab).at(-1)?.phase, (last) => last === phase, { ms, what: `a ${phase} frame` });
  await tab.sync();
  return phaseFrames(tab);
}

// ---------------------------------------------------------------------------
// Dead drives report themselves
// ---------------------------------------------------------------------------

// engine/engine.test.ts:7183
conformance(
  "server",
  "dead drives report themselves › running frames, then one dead frame last, one errors.jsonl line naming the missing binary, and pool dead: last in the pool log",
  async (t) => {
    // 01 runs on the opencode stub, held until a socket watches; 02 waits on
    // it and runs on claude, which is not there, so the second super-step's
    // launch kills the drive.
    const world = t.world({
      tickets: [ticket("01"), ticket("02", { blockedBy: "01" })],
      config: { ...CONFIG, assign: { "01": { harness: "opencode" } } },
    });
    withoutClaude(world);
    const held = world.stubs.hold("01");
    const server = await t.start(world);
    const tab = await t.socket(server);
    await tab.waitFor((frame) => frame.type === "snapshot" && frame.snapshot !== null, { what: "the opening snapshot" });
    await held.release();

    const frames = await untilLastPhase(tab, "dead");
    expect(frames.slice(0, -1).map((frame) => frame.phase)).toEqual(frames.slice(0, -1).map(() => "running"));
    expect(frames.length).toBeGreaterThan(1);

    // The durable record: one JSON line, when and what.
    const lines = parseJsonl<Record<string, unknown>>(readFileSync(join(world.pool, "runs", "errors.jsonl"), "utf8"));
    expect(lines).toHaveLength(1);
    const { at, error, ...rest } = lines[0]!;
    expect(at).toEqual(anyIsoTime());
    expect(typeof error).toBe("string");
    expect(error).toContain("claude");
    // Beside them, only the error's stack when the server has one to give.
    expect(Object.keys(rest).filter((key) => key !== "stack")).toEqual([]);

    // The same error last in the pool log, and the server still serving it.
    const dead = (await snapshotOf(server))!;
    expect(dead.phase).toBe("dead");
    expect(dead.state.log.at(-1)).toBe(`pool dead: ${error as string}`);
    expect(server.exited()).toBe(false);
  },
);

// The gap at engine/engine.ts:1641-1668.
conformance(
  "server",
  "dead drives report themselves › a drive whose error log cannot be written still ends dead, with pool dead: last in the pool log",
  async (t) => {
    const world = t.world({ tickets: [ticket("01")], config: CONFIG });
    withoutClaude(world);
    // A directory where the error log goes, so no record can be appended.
    const errors = join(world.pool, "runs", "errors.jsonl");
    mkdirSync(errors, { recursive: true });
    const server = await t.start(world);
    const tab = await t.socket(server);

    expect((await untilLastPhase(tab, "dead")).at(-1)?.phase).toBe("dead");
    const dead = (await snapshotOf(server))!;
    expect(dead.phase).toBe("dead");
    expect(dead.state.log.at(-1)).toMatch(/^pool dead: .*claude/);
    expect(statSync(errors).isDirectory()).toBe(true);
    expect(readdirSync(errors)).toEqual([]);
    expect(server.exited()).toBe(false);
  },
);

// ---------------------------------------------------------------------------
// The shutdown farewell
// ---------------------------------------------------------------------------

/**
 * A finished run watched by a socket from its start: one Ticket run to
 * done and its Review approved, and the frames the socket saw.
 */
async function finishedRun(t: Case): Promise<{ world: World; server: CaseServer; tab: SocketClient }> {
  const world = t.world({ tickets: [ticket("01")], config: CONFIG });
  const server = await t.start(world);
  const tab = await t.socket(server);
  await finishRun(server);
  await untilLastPhase(tab, "done");
  return { world, server, tab };
}

/** The frames end on exactly one `stopped` frame, the done frame's seq plus one. */
function expectFarewell(frames: PhaseFrame[]): void {
  const stopped = frames.filter((frame) => frame.phase === "stopped");
  expect(stopped).toHaveLength(1);
  expect(frames.at(-1)).toEqual(stopped[0]);
  const done = frames.filter((frame) => frame.phase === "done").at(-1);
  expect(done).toBeDefined();
  expect(stopped[0]!.seq).toBe(done!.seq + 1);
}

// engine/engine.test.ts:13274
conformance("server", "the shutdown farewell › SIGTERM ends a finished run's frames with one stopped frame, its seq one past the done frame's", async (t) => {
  const { server, tab } = await finishedRun(t);
  // SIGTERM; stop() requires exit 0 and runs/server.pid released.
  await server.stop();
  expect(await tab.closed).toEqual(CLOSE_STOPPED);
  expectFarewell(phaseFrames(tab));
});

// engine/engine.test.ts:13274, by the row's other way to stop.
conformance("server", "the shutdown farewell › POST /api/stop ends a finished run's frames with one stopped frame, its seq one past the done frame's", async (t) => {
  const { server, tab } = await finishedRun(t);
  const stop = await server.http.post("/api/stop");
  expect(stop.status).toBe(202);
  expect(await tab.closed).toEqual(CLOSE_STOPPED);
  expectFarewell(phaseFrames(tab));
  await until(() => server.exited(), (gone) => gone, { ms: 20_000, what: "the server to exit" });
  await server.stop();
});
