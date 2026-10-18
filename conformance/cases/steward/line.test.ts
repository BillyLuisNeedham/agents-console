/**
 * The Steward in a Line pool (ADR-0039), seen from outside the server: it is taught the Plan and
 * which of the Line's checkpoints and holds are its, it answers a Ticket's no-verdict checkpoint
 * and a spent `stewardExtra` loop's hold once until that loop resets, it is never told of the
 * Finish hold and its answer there is refused, it decides a Held spawn proposed from inside the
 * Line only while `steward.mayAdoptLineSpawns` is true, and it edits the Line's Plan only while the
 * Plan says `stewardEdits`, never widening what it may answer: it opens an `open: steward` gate and
 * is refused at an `open: operator` one.
 *
 * The Line runs in a terminal-backed pool: each Ticket launches the stand-in TUI as claude, and the
 * case plays its agent, writing the scripted Outcome once the prompt naming it is submitted.
 */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../../protocol/wire.ts";
import { type Case, type CaseServer, conformance } from "../../harness/case.ts";
import { readEvents } from "../../harness/pool-files.ts";
import { BRIEF, SPEC, begun, lineOf } from "../line-support.ts";
import { edge, node, plan } from "../plans-support.ts";
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

const withVerdict = (verdict: unknown): ScriptedOutcome => ({ ...done("node done"), verdict });
const PASS = withVerdict({ prove: "pass", evidence: "proof/ok.txt" });
const FAIL = withVerdict({ prove: "fail", evidence: "proof/fail.txt" });
const NO_FINDINGS = withVerdict({ findings: [] });
const SHIP = withVerdict({ decide: "ship" });

/** A terminal-backed pool holding a Line brief and its spec, with no Ticket until the Line begins. */
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

async function post(server: CaseServer, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const answer = await server.http.post(path, body);
  return { status: answer.status, body: answer.json() };
}

const refused = (why: string) => ({ status: 409, body: { reason: `steward: ${why}` } });

conformance(
  "steward",
  "in a Line pool the Steward answers a no-verdict checkpoint but is never told of the Finish hold and is refused there",
  async (t) => {
    const sw = await lineStewardWorld(t);
    driveOutcomes(sw.herdr, {
      "implement-1": [done()],
      "prove-1": [done("no verdict yet"), PASS],
      "review-1": [NO_FINDINGS],
      "decide-1": [SHIP],
    });
    const server = await sw.start();
    // Decide's report, where its body says, so the ship verdict stands.
    mkdirSync(join(sw.world.pool, "runs"), { recursive: true });
    writeFileSync(join(sw.world.pool, "runs", "main-decide-1-report.html"), "<!doctype html><title>report</title>");
    await begun(server);

    await untilInterrupt(server, "prove-1", "checkpoint");
    const id = await enlistSteward(server);
    const [notice] = await untilNotices(sw.herdr, 1);
    expect(notice).toContain("prove-1");
    const teaching = turnsInto(sw.herdr, STEWARD_PANE).join("\n");
    expect(teaching).toContain('This pool runs one Line on the Plan "Factory today" (ADR-0039)');
    expect(teaching).toContain(
      'You may answer a checkpoint on a Ticket of implement, prove, review, decide (a "no verdict" one: resume, asking it to record its Outcome again with a valid verdict); the hold of a spent loop on prove --fail--> implement, once until that loop resets',
    );
    expect(teaching).toContain("the Finish hold and the Finish Ticket are the operator's");
    expect(teaching).toContain("This Plan does not let you edit it.");
    expect(teaching).toContain("Held spawns proposed from inside the Line are the operator's to adopt or discard");

    expect(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "prove-1",
        action: "resume",
        note: "record the Outcome again with the Prove verdict",
      }),
    ).toMatchObject({ status: 202 });

    const atFinish = await untilInterrupt(server, "finish-1", "checkpoint");
    expect(atFinish.state.interrupts.map((i) => i.ticketId)).toEqual(["finish-1"]);
    expect(
      await post(server, "/api/steward/answer", { conversation: id, ticketId: "finish-1", action: "resume", note: "approved" }),
    ).toEqual(
      refused("finish-1 is the Line's Finish: approving the Line and its act are the operator's, never the Steward's"),
    );
    expect(
      await post(server, "/api/steward/keep-talking", { conversation: id, ticketId: "finish-1", message: "approved" }),
    ).toEqual(
      refused("finish-1 is the Line's Finish: approving the Line and its act are the operator's, never the Steward's"),
    );
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ interrupts: { ticketId: string; answerable: boolean }[] }>().interrupts).toMatchObject([
      { ticketId: "finish-1", answerable: false },
    ]);

    // The idle Steward pane would have been told by now; it never is, and nothing is logged on finish-1.
    await Bun.sleep(3_000);
    expect(stewardNotices(sw.herdr).filter((turn) => turn.includes("finish-1"))).toEqual([]);
    expect(readEvents(sw.world.pool, "finish-1").filter((e) => e.kind === "notice")).toEqual([]);
    expect(atFinish.line?.status).toBe("finishing");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the Steward answers a spent stewardExtra loop's hold once, and the loop's next hold is the operator's",
  async (t) => {
    const sw = await lineStewardWorld(t);
    driveOutcomes(sw.herdr, {
      "implement-1": [done()],
      "implement-2": [done()],
      "implement-3": [done()],
      "implement-4": [done()],
      "implement-5": [done()],
      "prove-1": [FAIL],
      "prove-2": [FAIL],
      "prove-3": [FAIL],
      "prove-4": [FAIL],
    });
    const server = await sw.start();
    await begun(server);

    await untilInterrupt(server, "prove-fail-implement-3", "checkpoint", 60_000);
    const id = await enlistSteward(server);
    const [notice] = await untilNotices(sw.herdr, 1);
    expect(notice).toContain("prove-fail-implement-3");
    expect(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "prove-fail-implement-3",
        action: "resume",
        note: "try the other port",
      }),
    ).toMatchObject({ status: 202 });

    const again = await untilInterrupt(server, "prove-fail-implement-4", "checkpoint", 60_000);
    expect(again.state.tickets.find((ticket) => ticket.id === "implement-4")?.status).toBe("done");
    expect(
      await post(server, "/api/steward/answer", {
        conversation: id,
        ticketId: "prove-fail-implement-4",
        action: "resume",
        note: "once more",
      }),
    ).toEqual(refused("prove-fail-implement-4 is the Line's, and its Plan leaves it to the operator"));
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ interrupts: { ticketId: string; answerable: boolean }[] }>().interrupts).toMatchObject([
      { ticketId: "prove-fail-implement-4", answerable: false },
    ]);

    const operator = await server.http.post("/api/resume", { ticketId: "prove-fail-implement-4", note: "one more" });
    expect(operator.status).toBe(202);
    await untilSnapshot(
      server,
      (s) => s.state.tickets.some((ticket) => ticket.id === "implement-5" && ticket.status === "done"),
      "the operator's bought pass",
      60_000,
    );
  },
  { timeoutMs: 180_000 },
);

/** A Line whose Implement proposes one follow-up, held for the operator, then rests at Prove's checkpoint. */
async function heldLineSpawn(t: Case, config: Partial<PoolConfig>): Promise<{ server: CaseServer; id: string; held: string }> {
  const sw = await lineStewardWorld(t, config);
  driveOutcomes(sw.herdr, {
    "implement-1": [
      { ...done(), spawn: [{ title: "Tidy the logs", body: "Tidy the pool log lines the Line writes, they repeat." }] },
    ],
    // Prove stops, so the pool rests and an Adopt lands at once.
    "prove-1": [checkpoint("needs a device")],
  });
  const server = await sw.start();
  await begun(server);
  await untilInterrupt(server, "prove-1", "checkpoint");
  const snap = await untilSnapshot(server, (s) => s.heldSpawns.length === 1, "the Line's spawn held");
  expect(snap.heldSpawns[0]).toMatchObject({ parentId: "implement-1", reason: "line" });
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
      (s) => s.heldSpawns.length === 0 && s.state.tickets.some((ticket) => ticket.id === "implement-1-spawn-1"),
      "the adopted spawn landed as a Ticket",
    );
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the Steward edits the Line's Plan only while it says stewardEdits and never widens its own powers, opening a steward gate but refused at an operator one",
  async (t) => {
    const sw = await lineStewardWorld(t);
    driveOutcomes(sw.herdr, { "draft-1": [done()] });
    const server = await sw.start();
    const gated = {
      ...plan(
        [node.agent("draft"), node.gate("approve", "steward"), node.gate("sign", "operator"), node.finish()],
        [edge("draft", "done", "approve"), edge("approve", "open", "sign"), edge("sign", "open", "finish")],
        "Gated",
      ),
      stewardEdits: true,
    };
    await begun(server, { plan: gated, work: "#1" });
    await untilInterrupt(server, "approve-1", "checkpoint", 60_000);
    const id = await enlistSteward(server);
    expect(turnsInto(sw.herdr, STEWARD_PANE).join("\n")).toContain(
      "This Plan lets you edit it with plan <rev> <edits>: rev is the `rev` GET /api/line on the Console answers",
    );
    const rev = async () => (await lineOf(server))?.rev;
    const edit = (baseRev: number, edits: unknown[]) => post(server, "/api/steward/plan", { conversation: id, baseRev, edits });

    expect(await edit(0, [{ edit: "setNode", node: node.gate("sign", "steward") }])).toEqual(
      refused("the Steward may not give itself powers the operator did not: the gate sign opening on steward"),
    );
    expect(await rev()).toBe(0);
    expect(await edit(0, [{ edit: "move", id: "draft", x: 40, y: 400 }])).toEqual({
      status: 200,
      body: { ok: true, message: "edited the Plan: now at rev 1" },
    });
    expect(await rev()).toBe(1);

    const hold = (await lineOf(server))?.nodes.find((n) => n.id === "approve")?.hold;
    expect(hold).toBe("approve-1");
    expect(await post(server, "/api/steward/answer", { conversation: id, ticketId: hold, action: "resume" })).toMatchObject({
      status: 202,
    });
    await untilInterrupt(server, "sign-1", "checkpoint", 60_000);
    expect((await lineOf(server))?.nodes.find((n) => n.id === "sign")?.hold).toBe("sign-1");
    expect(await post(server, "/api/steward/answer", { conversation: id, ticketId: "sign-1", action: "resume" })).toEqual(
      refused("sign-1 is the Line's, and its Plan leaves it to the operator"),
    );
    const state = await server.http.get(`/api/steward/state?conversation=${id}`);
    expect(state.json<{ interrupts: { ticketId: string; answerable: boolean }[] }>().interrupts).toMatchObject([
      { ticketId: "sign-1", answerable: false },
    ]);

    expect(await edit(1, [{ edit: "setMeta", name: "Gated", stewardEdits: false }])).toMatchObject({ status: 200 });
    expect(await edit(2, [{ edit: "move", id: "draft", x: 40, y: 60 }])).toEqual(
      refused("this Plan does not let the Steward edit it"),
    );
    expect(await rev()).toBe(2);
  },
  { timeoutMs: 120_000 },
);
