/**
 * The Steward's entry in console.json (ADR-0030), and the Steward budget the
 * server reads off each Ticket's log, seen from outside the server
 * (ADR-0036): what /api/state and GET /api/steward/state report for an
 * entry that is absent or set, and the boot refusal, by exit code and
 * output, for one that breaks a rule.
 */

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StewardStateResponse } from "../../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../../harness/case.ts";
import { expectParsedEqual } from "../../harness/equal.ts";
import { CHECKOUT, freePort, serverArgv, serverChoice } from "../../harness/server.ts";
import type { World } from "../../harness/world.ts";
import { DONE_01, enlistSteward, snapshot, stewardWorld } from "./pool.ts";

const DEFAULTS = { harness: "claude", model: "m" };

/** A plain headless pool whose console.json is exactly `config`, malformed or not. */
function poolWith(t: Case, config: Record<string, unknown>): World {
  return t.world({
    tickets: [{ file: "01.md", marker: DONE_01, body: "# Done\n\nbody" }],
    poolFiles: { "console.json": JSON.stringify(config, null, 2) },
  });
}

/** How a server that refused to boot ended: its exit code and everything it printed. */
interface Refusal {
  code: number;
  output: string;
}

/**
 * Start the chosen server on a world that must not boot, the way the
 * harness starts one (same argv, same environment, no herdr listening), and
 * wait for it to exit. A server still running at the bound has booted when
 * it should have refused, and fails the case.
 */
async function bootRefused(world: World, ms = 15_000): Promise<Refusal> {
  const proc = Bun.spawn(serverArgv(serverChoice(), world.pool, await freePort()), {
    cwd: CHECKOUT,
    env: world.env(join(world.root, "no-herdr.sock")),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  if (!exited) proc.kill("SIGKILL");
  const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  if (!exited) throw new Error(`the server was still running ${ms} ms after start, not refusing:\n${output}`);
  return { code: proc.exitCode!, output };
}

/** Expect the server to refuse this world at boot, naming `rule`, and leave no pool lock behind. */
async function expectBootRefused(world: World, rule: string, what: string): Promise<void> {
  const refusal = await bootRefused(world);
  expect(refusal.code, `${what}: exit code`).not.toBe(0);
  expect(refusal.output, `${what}: output`).toContain(`pool config: ${rule}`);
  expect(existsSync(join(world.pool, "runs", "server.pid")), `${what}: runs/server.pid left behind`).toBe(false);
}

/** The Steward's state as its command reads it. */
async function stewardState(server: CaseServer, conversation: string): Promise<StewardStateResponse> {
  const answer = await server.http.get(`/api/steward/state?conversation=${encodeURIComponent(conversation)}`);
  if (answer.status !== 200) throw new Error(`steward state answered ${answer.status}: ${answer.text}`);
  return answer.json<StewardStateResponse>();
}

// steward.test.ts:54
conformance(
  "steward",
  "the Steward budget is 5 with no steward entry and the entry's budget when it sets one",
  async (t) => {
    for (const [steward, budget] of [[undefined, 5], [{ budget: 2 }, 2]] as const) {
      const sw = await stewardWorld(t, { config: steward ? { steward } : {} });
      const server = await sw.start();
      const id = await enlistSteward(server);

      const snap = await snapshot(server);
      expect(snap.stewardBudget?.budget, `/api/state with steward ${JSON.stringify(steward)}`).toBe(budget);
      const state = await stewardState(server, id);
      expect(state.steward).toBe(id);
      expect(state.budget, `steward state with steward ${JSON.stringify(steward)}`).toBe(budget);
      await server.stop();
    }
  },
  { timeoutMs: 120_000 },
);

// steward.test.ts:59
conformance(
  "steward",
  "a steward entry that breaks a rule is refused at boot, naming the rule",
  async (t) => {
    const rows: [unknown, string][] = [
      [{ budget: 0 }, "steward.budget must be a whole number, 1 or more"],
      [{ budget: 1.5 }, "steward.budget must be a whole number, 1 or more"],
      [{ budget: "3" }, "steward.budget must be a whole number, 1 or more"],
      [{ assign: { model: 4 } }, "steward.assign.model must be a string"],
      ["x", "steward must be an object"],
    ];
    for (const [steward, rule] of rows) {
      const world = poolWith(t, { defaults: DEFAULTS, steward });
      await expectBootRefused(world, rule, `steward ${JSON.stringify(steward)}`);
    }
  },
  { timeoutMs: 120_000 },
);

// steward.test.ts:59
conformance(
  "steward",
  "a pool with no steward entry, or one with budget 3 and assign.model m, boots",
  async (t) => {
    const absent = await t.start(poolWith(t, { defaults: DEFAULTS }));
    const bare = await snapshot(absent);
    expect(bare.stewardBudget?.budget).toBe(5);
    expect("steward" in bare.state.config).toBe(false);
    await absent.stop();

    const set = await t.start(poolWith(t, { defaults: DEFAULTS, steward: { budget: 3, assign: { model: "m" } } }));
    const snap = await snapshot(set);
    expect(snap.stewardBudget?.budget).toBe(3);
    expectParsedEqual(snap.state.config.steward, { budget: 3, assign: { model: "m" } }, "/api/state config.steward");
  },
  { timeoutMs: 120_000 },
);

// steward.test.ts:70
conformance(
  "steward",
  "the Steward may Close only when the entry's mayClose is true",
  async (t) => {
    const rows: [Record<string, unknown>, boolean][] = [
      [{}, false],
      [{ steward: { mayClose: false } }, false],
      [{ steward: { mayClose: true } }, true],
    ];
    for (const [config, mayClose] of rows) {
      const sw = await stewardWorld(t, { config });
      const server = await sw.start();
      const id = await enlistSteward(server);
      const state = await stewardState(server, id);
      expect(state.mayClose, `steward state with ${JSON.stringify(config)}`).toBe(mayClose);
      await server.stop();
    }
  },
  { timeoutMs: 150_000 },
);

// steward.test.ts:70
conformance(
  "steward",
  "a mayClose that is not true or false is refused at boot, naming the rule",
  async (t) => {
    for (const mayClose of ["yes", 1]) {
      const world = poolWith(t, { defaults: DEFAULTS, steward: { mayClose } });
      await expectBootRefused(world, "steward.mayClose must be true or false", `mayClose ${JSON.stringify(mayClose)}`);
    }
  },
  { timeoutMs: 60_000 },
);

// steward.test.ts:80
conformance(
  "steward",
  "a steward budget of 0 is refused at boot and one of 4 boots and is served",
  async (t) => {
    await expectBootRefused(
      poolWith(t, { defaults: DEFAULTS, steward: { budget: 0 } }),
      "steward.budget must be a whole number, 1 or more",
      "steward budget 0",
    );

    const server = await t.start(poolWith(t, { defaults: DEFAULTS, steward: { budget: 4 } }));
    const snap = await snapshot(server);
    expect(snap.stewardBudget?.budget).toBe(4);
    expectParsedEqual(snap.state.config.steward, { budget: 4 }, "/api/state config.steward");
  },
  { timeoutMs: 60_000 },
);

/** One `answered` event as the engine logs it, by the operator or (with `conversation`) the Steward. */
function answered(payload: Record<string, unknown>, conversation?: string): string {
  const by = conversation ? { by: "steward", conversation } : {};
  return JSON.stringify({ at: "2026-10-01T00:00:00.000Z", attempt: 1, kind: "answered", payload: { ...payload, ...by } });
}

// steward.test.ts:111
conformance(
  "steward",
  "the budget used on a Ticket counts the Steward's answers since the operator last answered it",
  async (t) => {
    const steward = "conv-1";
    const ticket01 = [
      answered({ kind: "checkpoint" }, steward),
      answered({ kind: "checkpoint" }),
      answered({ kind: "checkpoint" }, steward),
      JSON.stringify({
        at: "2026-10-01T00:00:01.000Z",
        attempt: 2,
        kind: "steward-note",
        payload: { kind: "checkpoint", note: "the operator should look", by: "steward", conversation: steward },
      }),
      answered({ kind: "checkpoint", action: "keep-talking", message: "carry on" }, steward),
    ];
    const ticket02 = [answered({ kind: "crash" }, steward), answered({ kind: "crash" })];
    // Done Tickets, so the pool runs nothing and the logs stay as seeded.
    const world = t.world({
      tickets: [
        { file: "01.md", marker: DONE_01, body: "# One\n\nbody" },
        { file: "02.md", marker: "<!-- state: id=02 blocked-by=none status=done -->", body: "# Two\n\nbody" },
      ],
      config: { defaults: DEFAULTS },
      poolFiles: {
        "runs/01.events.jsonl": ticket01.join("\n") + "\n",
        "runs/02.events.jsonl": ticket02.join("\n") + "\n",
      },
    });
    const server = await t.start(world);
    const snap = await snapshot(server);
    expectParsedEqual(snap.stewardBudget, { budget: 5, used: { "01": 2 } }, "/api/state stewardBudget");
  },
  { timeoutMs: 60_000 },
);
