/**
 * The Steward in a Factory pool (issue #187, ADR-0037), seen from outside the
 * server: it is taught which of the Line's checkpoints are its, it answers a
 * Station's no-verdict checkpoint, it is never told of the Finish checkpoint
 * and its answer there is refused, and it decides a Held spawn proposed from
 * inside the Line only while `steward.mayAdoptLineSpawns` is true.
 *
 * The Line runs in a terminal-backed pool: each Station Ticket launches the
 * stand-in TUI as claude, and the case plays its agent, writing the scripted
 * Outcome once the prompt naming it is submitted.
 */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../../protocol/wire.ts";
import { type Case, type CaseServer, conformance } from "../../harness/case.ts";
import { readEvents } from "../../harness/pool-files.ts";
import { BRIEF, REPORT, SPEC } from "../factory-line-support.ts";
import {
  checkpoint,
  done,
  driveOutcomes,
  enlistSteward,
  type ScriptedOutcome,
  STEWARD_PANE,
  stewardNotices,
  stewardWorld,
  type StewardWorld,
  turnsInto,
  untilInterrupt,
  untilNotices,
  untilSnapshot,
} from "./pool.ts";

const withVerdict = (verdict: unknown): ScriptedOutcome => ({ ...done("station done"), verdict });
const PASS = withVerdict({ prove: "pass", evidence: "proof/ok.txt" });
const NO_FINDINGS = withVerdict({ findings: [] });
const FINISH = withVerdict({ decide: "finish" });

/** A terminal-backed pool holding a Line brief and its spec, with no Ticket until the Line starts. */
async function lineStewardWorld(t: Case, config: Partial<PoolConfig> = {}): Promise<StewardWorld> {
  return stewardWorld(t, {
    tickets: [],
    config,
    repoFiles: {
      [SPEC]: "# The spec\n\nBuild the thing.\n",
      [BRIEF]: JSON.stringify({ spec: SPEC, finish: "none" }),
    },
    beforeBoot: (world) => mkdirSync(join(world.pool, "conversations"), { recursive: true }),
  });
}

async function startLine(server: CaseServer): Promise<void> {
  const started = await server.http.post("/api/line/start", {});
  expect(started.status).toBe(202);
}

async function post(server: CaseServer, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const answer = await server.http.post(path, body);
  return { status: answer.status, body: answer.json() };
}

const refused = (why: string) => ({ status: 409, body: { reason: `steward: ${why}` } });

conformance(
  "steward",
  "in a Factory pool the Steward answers a no-verdict checkpoint but is never told of the Finish checkpoint and is refused there",
  async (t) => {
    const sw = await lineStewardWorld(t);
    driveOutcomes(sw.herdr, {
      "r1-implement": [done()],
      "r1-prove": [done("no verdict yet"), PASS],
      "r1-review": [NO_FINDINGS],
      "r1-decide": [FINISH],
    });
    const server = await sw.start();
    // Decide's report, where its body says, so the finish verdict stands.
    mkdirSync(join(sw.world.pool, "runs"), { recursive: true });
    writeFileSync(join(sw.world.pool, REPORT), "<!doctype html><title>report</title>");
    await startLine(server);

    await untilInterrupt(server, "r1-prove", "checkpoint");
    const id = await enlistSteward(server);
    const [notice] = await untilNotices(sw.herdr, 1);
    expect(notice).toContain("r1-prove");
    // The Steward is taught the Line's checkpoints, and that Line spawns are the operator's here.
    const teaching = turnsInto(sw.herdr, STEWARD_PANE).join("\n");
    expect(teaching).toContain("This is a Factory pool: it runs one Line, and the engine routes its Stations (ADR-0037).");
    expect(teaching).toContain("The Finish checkpoint is never yours");
    expect(teaching).toContain("Held spawns proposed from inside the Line are the operator's to adopt or discard");

    expect(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "r1-prove",
        action: "resume",
        note: "record the Outcome again with the Prove verdict",
      }),
    ).toMatchObject({ status: 202 });

    const atFinish = await untilInterrupt(server, "r1-finish", "checkpoint");
    expect(atFinish.state.interrupts.map((i) => i.ticketId)).toEqual(["r1-finish"]);
    expect(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "r1-finish", action: "resume", note: "approved" }),
    ).toEqual(
      refused("r1-finish is the Line's Finish checkpoint: approving the Line is the operator's, never the Steward's"),
    );
    expect(
      await post(server, "/api/steward/keep-talking", { conversation: id, ticketId: "r1-finish", message: "approved" }),
    ).toEqual(
      refused("r1-finish is the Line's Finish checkpoint: approving the Line is the operator's, never the Steward's"),
    );
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ interrupts: { ticketId: string; answerable: boolean }[] }>().interrupts).toMatchObject([
      { ticketId: "r1-finish", answerable: false },
    ]);

    // The idle Steward pane would have been told by now; it never is, and nothing is logged on r1-finish.
    await Bun.sleep(3_000);
    expect(stewardNotices(sw.herdr).filter((turn) => turn.includes("r1-finish"))).toEqual([]);
    expect(readEvents(sw.world.pool, "r1-finish").filter((e) => e.kind === "notice")).toEqual([]);
    expect(atFinish.line?.status).toBe("finish");
  },
  { timeoutMs: 120_000 },
);

/** A Line whose Implement proposes one follow-up, held for the operator, then rests at Prove's checkpoint. */
async function heldLineSpawn(t: Case, config: Partial<PoolConfig>): Promise<{ server: CaseServer; id: string; held: string }> {
  const sw = await lineStewardWorld(t, config);
  driveOutcomes(sw.herdr, {
    "r1-implement": [
      { ...done(), spawn: [{ title: "Tidy the logs", body: "Tidy the pool log lines the Line writes, they repeat." }] },
    ],
    // Prove stops, so the pool rests and an Adopt lands at once.
    "r1-prove": [checkpoint("needs a device")],
  });
  const server = await sw.start();
  await startLine(server);
  await untilInterrupt(server, "r1-prove", "checkpoint");
  const snap = await untilSnapshot(server, (s) => s.heldSpawns.length === 1, "the Line's spawn held");
  expect(snap.heldSpawns[0]).toMatchObject({ parentId: "r1-implement", reason: "line" });
  const id = await enlistSteward(server);
  return { server, id, held: snap.heldSpawns[0]!.id };
}

conformance(
  "steward",
  "with steward.mayAdoptLineSpawns off the Steward may neither adopt nor discard a Held spawn proposed from inside the Line",
  async (t) => {
    const { server, id, held } = await heldLineSpawn(t, {});
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ mayAdoptLineSpawns: boolean }>().mayAdoptLineSpawns).toBe(false);
    for (const action of ["adopt", "discard"]) {
      expect(await post(server, "/api/steward/held", { conversation: id, action, id: held })).toEqual(
        refused(
          `held spawn ${held} was proposed from inside the Line, so it is the operator's to ${action} ` +
            "(steward.mayAdoptLineSpawns is off)",
        ),
      );
    }
    // The operator still can.
    expect((await server.http.post("/api/spawns/held/adopt", { id: held })).status).toBeLessThan(300);
    await untilSnapshot(server, (s) => s.heldSpawns.length === 0, "the operator's adopt");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "with steward.mayAdoptLineSpawns on the Steward adopts a Held spawn proposed from inside the Line",
  async (t) => {
    const { server, id, held } = await heldLineSpawn(t, { steward: { mayAdoptLineSpawns: true } });
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ mayAdoptLineSpawns: boolean }>().mayAdoptLineSpawns).toBe(true);
    expect(await post(server, "/api/steward/held", { conversation: id, action: "adopt", id: held })).toEqual({
      status: 200,
      body: { ok: true, message: `adopted held spawn ${held}` },
    });
    await untilSnapshot(
      server,
      (s) => s.heldSpawns.length === 0 && s.state.tickets.some((ticket) => ticket.id === "r1-implement-spawn-1"),
      "the adopted spawn landed as a Ticket",
    );
  },
  { timeoutMs: 120_000 },
);
