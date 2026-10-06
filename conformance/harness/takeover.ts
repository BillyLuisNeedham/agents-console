/**
 * Takeover: one pool run across several server processes in turn, each
 * picking up from what the last left on disk (ADR-0036), as a pool does
 * across a Restart. CONFORMANCE_LEGS names each leg's server.
 *
 *   takeover("restart", "a checkpoint Interrupt survives a takeover", {
 *     world: { tickets: [...], config: {...} },
 *     prepare: (world) => world.stubs.script("01", { statuses: ["checkpoint", "done"] }),
 *     reach: async (leg) => { ...until 01's Interrupt is up },
 *     stopPoint: async (leg) => { ...until 01's Interrupt is up },
 *     finish: async (leg) => { ...resume 01, until the pool is done },
 *   });
 *
 * A case runs its scenario twice, in two worlds built from the same spec.
 * Once uninterrupted, on the run's own server: `reach`, `stopPoint`, then
 * `finish`. And once taken over, leg by leg:
 *
 *   leg 1        boots, `reach`es the stop point, stops
 *   legs 2..n-1  boot, wait for the `stopPoint`, stop
 *   leg n        boots, waits for the `stopPoint`, `finish`es
 *
 * Every server stops with SIGTERM and must stop cleanly (harness/server.ts).
 * After each takeover the stop point must look as the server before left
 * it, and at the end the taken over run must match the uninterrupted one.
 * Both comparisons are of an Observation: the snapshot once parsed, less
 * its revision and the pool log; the files people and agents read, byte
 * for byte; every harness launch; each events file's kinds in order; and
 * the herdr calls that change something. Each world's root is written as
 * <root> and its pool key as <key>, the key pinned rather than read back.
 * A scenario names what a takeover changes by design in `takeover`, so
 * every difference is one the case asserts rather than ignores.
 *
 * With `herdr`, one fake herdr process runs beside each world for the whole
 * run, every leg talking to it, as a live daemon outlives a Restart.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Area } from "./areas.ts";
import { conformance, type Case, type CaseServer } from "./case.ts";
import { expectParsedEqual, expectSameBytes } from "./equal.ts";
import type { HerdrOptions, HerdrProcess } from "./herdr.ts";
import type { ServerKind } from "./server.ts";
import type { StubCall } from "./stubs.ts";
import type { World, WorldSpec } from "./world.ts";
import { readEvents } from "./pool-files.ts";

/** One server's turn on a world, with what `prepare` made for that world. */
export interface Leg<P = void> {
  /** Which leg, from 0; the uninterrupted run is leg 0 of 1. */
  index: number;
  /** How many legs this run has. */
  count: number;
  kind: ServerKind;
  world: World;
  server: CaseServer;
  /** The world's fake herdr, the same process on every leg; null without `herdr`. */
  herdr: HerdrProcess | null;
  /** What `prepare` returned for this world. */
  prepared: P;
  t: Case;
}

/** What a run looks like from outside, at a stop point or at the end. */
export interface Observation {
  /** GET /api/state's snapshot, less its revision and the pool log. */
  snapshot: unknown;
  /** The files people and agents read, by path in the pool: their bytes. */
  files: Record<string, string>;
  /**
   * Every harness launch so far, by key and then launch number: the order
   * launches of one super-step race in is no part of the contract, and the
   * events give the order across super-steps.
   */
  launches: Launch[];
  /**
   * Each events file's events as `<attempt> <kind>`, by the Ticket or
   * Conversation id it belongs to: what happened and in what order, without
   * the times and pids no two runs share.
   */
  events: Record<string, string[]>;
  /**
   * The calls on the fake herdr that change something there (CHANGING_CALLS),
   * as `<method> <params>`, in arrival order; empty without a fake. Reads,
   * listings and subscriptions are left out: how often a server polls is
   * its own business, and every boot looks again.
   */
  herdr: string[];
}

/** The herdr methods whose calls an observation keeps. */
export const CHANGING_CALLS = new Set([
  "workspace.create",
  "tab.create",
  "tab.close",
  "pane.send_input",
  "pane.close",
]);

/** A harness launch as two runs can compare it. */
export interface Launch {
  key: string;
  n: number;
  harness: string;
  argv: string[];
  cwd: string;
}

export interface TakeoverScenario<P = void> {
  world: WorldSpec;
  /** Run a fake herdr beside the servers (with these options when an object). */
  herdr?: boolean | HerdrOptions;
  /**
   * Before the first server starts: stub scripts, files the run needs. What
   * it returns, held stubs say, every leg on that world gets as `prepared`.
   */
  prepare?(world: World): P;
  /** From the first boot until the pool sits at the stop point. */
  reach(leg: Leg<P>): Promise<void>;
  /**
   * Wait until the pool sits at the stop point: run after `reach`, before
   * each stop, and after each takeover's boot. It should wait for what the
   * stop point is, not only for the server to answer.
   */
  stopPoint(leg: Leg<P>): Promise<void>;
  /** From the stop point to the end, on the last leg. */
  finish(leg: Leg<P>): Promise<void>;
  /**
   * What a takeover legitimately changes, each given the observation it
   * would otherwise have to equal and how many servers have taken over, and
   * returning what the taken over run must show instead. Absent, it must
   * show the same.
   */
  takeover?: {
    /**
     * At the stop point after takeover `takeovers`, given the stop point as
     * the server before it left it. Null when the takeover moves the pool
     * on by design (a boot drains Queued answers and lands Pending spawns
     * at its first boundary): `stopPoint` then waits for, and so checks,
     * where it has moved to, and the next takeover is held to that.
     */
    atStop?(before: Observation, takeovers: number): Observation | null;
    /** At the end, after `takeovers` takeovers. */
    atEnd?(uninterrupted: Observation, takeovers: number): Observation;
  };
  /** Further checks on the taken over run at the end, its legs in hand. */
  verify?(legs: Leg<P>[], interrupted: Observation, uninterrupted: Observation): void | Promise<void>;
}

export interface TakeoverOptions {
  /** The case's bound, both runs included. Default 120 s. */
  timeoutMs?: number;
}

/** The readable files in a pool: Tickets, Conversations, the ledger, AGENT.md. */
export function readableFiles(pool: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of ["issues", "conversations"]) {
    const path = join(pool, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).filter((file) => file.endsWith(".md")).sort()) {
      out[`${dir}/${name}`] = readFileSync(join(path, name), "utf8");
    }
  }
  for (const file of ["runs/spawn-ledger.md", "AGENT.md"]) {
    const path = join(pool, file);
    if (existsSync(path)) out[file] = readFileSync(path, "utf8");
  }
  return out;
}

/**
 * The pool key a checkout's worktrees and branches are named by
 * (`.git/pool-worktrees/<key>/<id>`, `pool/<key>/<id>`): the first eight hex
 * digits of the SHA-256 of the checkout's real path. A pool resumes on
 * another server only if that server finds the worktrees the last one
 * made, so the key is pinned here rather than read back from the server.
 */
export function poolKey(world: World): string {
  return createHash("sha256").update(realpathSync(world.repo)).digest("hex").slice(0, 8);
}

/**
 * Every string in `value` with the world's root written as <root> and its
 * pool key as <key>, so two worlds compare. A server that named its
 * worktrees by any other key keeps that key here, and so fails to match.
 */
export function worldless<T>(value: T, world: World): T {
  const key = poolKey(world);
  const rewrite = (item: unknown): unknown => {
    if (typeof item === "string") return item.split(world.root).join("<root>").split(key).join("<key>");
    if (Array.isArray(item)) return item.map(rewrite);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([name, each]) => [name, rewrite(each)]));
    }
    return item;
  };
  return rewrite(value) as T;
}

/** Every events file in the pool, as Observation.events has it. */
function eventKinds(pool: string): Record<string, string[]> {
  const runs = join(pool, "runs");
  if (!existsSync(runs)) return {};
  const out: Record<string, string[]> = {};
  for (const name of readdirSync(runs).filter((file) => file.endsWith(".events.jsonl")).sort()) {
    const id = name.slice(0, -".events.jsonl".length);
    out[id] = readEvents(pool, id).map((event) => `${event.attempt} ${event.kind}`);
  }
  return out;
}

function launchOf(call: StubCall): Launch {
  return { key: call.key, n: call.n, harness: call.harness, argv: call.argv, cwd: call.cwd };
}

/**
 * The snapshot less what no two runs share: its revision, which every boot
 * starts afresh, and the pool log, which every boot adds its own lines to.
 */
function comparableSnapshot(answer: unknown): unknown {
  const snapshot = (answer as { snapshot: Record<string, unknown> | null }).snapshot;
  if (snapshot === null) return null;
  const { seq: _seq, state, ...rest } = snapshot as { seq: number; state: Record<string, unknown> };
  const { log: _log, ...kept } = state;
  return { ...rest, state: kept };
}

/** What a world looks like from outside now, its root and pool key written as <root> and <key>. */
export async function observe(world: World, server: CaseServer, herdr: HerdrProcess | null): Promise<Observation> {
  const state = await server.http.get("/api/state");
  if (state.status !== 200) throw new Error(`GET /api/state answered ${state.status}: ${state.text}`);
  return worldless(
    {
      snapshot: comparableSnapshot(state.json()),
      files: readableFiles(world.pool),
      launches: world.stubs
        .calls()
        .map(launchOf)
        .sort((a, b) => (a.key === b.key ? a.n - b.n : a.key < b.key ? -1 : 1)),
      events: eventKinds(world.pool),
      herdr: (herdr?.calls ?? [])
        .filter((call) => CHANGING_CALLS.has(call.method))
        .map((call) => `${call.method} ${JSON.stringify(call.params)}`),
    },
    world,
  );
}

/** Two observations alike: the snapshot once parsed, the files byte for byte, the launches. */
export function expectSameObservation(actual: Observation, expected: Observation, where: string): void {
  expect(Object.keys(actual.files).sort(), `the readable files ${where}`).toEqual(Object.keys(expected.files).sort());
  for (const [path, bytes] of Object.entries(expected.files)) {
    expectSameBytes(actual.files[path]!, bytes, `${path} ${where}`);
  }
  expectParsedEqual(actual.snapshot, expected.snapshot, `the snapshot ${where}`);
  expect(actual.launches, `the harness launches ${where}`).toEqual(expected.launches);
  expect(actual.events, `the events ${where}`).toEqual(expected.events);
  expect(actual.herdr, `the changing herdr calls ${where}`).toEqual(expected.herdr);
}

async function herdrFor<P>(t: Case, world: World, scenario: TakeoverScenario<P>): Promise<HerdrProcess | null> {
  if (!scenario.herdr) return null;
  return t.herdr(world, scenario.herdr === true ? {} : scenario.herdr);
}

/** The scenario uninterrupted, on the run's own server. */
async function uninterrupted<P>(t: Case, scenario: TakeoverScenario<P>): Promise<Observation> {
  const world = t.world(scenario.world);
  const prepared = scenario.prepare?.(world) as P;
  const herdr = await herdrFor(t, world, scenario);
  const server = await t.start(world, herdr ? { herdr } : {});
  const leg: Leg<P> = { index: 0, count: 1, kind: t.kind, world, server, herdr, prepared, t };
  await scenario.reach(leg);
  await scenario.stopPoint(leg);
  await scenario.finish(leg);
  const seen = await observe(world, server, herdr);
  await server.stop();
  return seen;
}

/** The scenario taken over at its stop point by each leg in turn. */
async function takenOver<P>(t: Case, scenario: TakeoverScenario<P>): Promise<{ legs: Leg<P>[]; seen: Observation }> {
  const world = t.world(scenario.world);
  const prepared = scenario.prepare?.(world) as P;
  const herdr = await herdrFor(t, world, scenario);
  const legs: Leg<P>[] = [];
  let atStop: Observation | null = null;
  for (const [index, kind] of t.legs.entries()) {
    const server = await t.start(world, { ...(herdr ? { herdr } : {}), leg: index });
    const leg: Leg<P> = { index, count: t.legs.length, kind, world, server, herdr, prepared, t };
    legs.push(leg);
    if (index === 0) await scenario.reach(leg);
    await scenario.stopPoint(leg);
    const seen = await observe(world, server, herdr);
    if (atStop !== null) {
      const want = scenario.takeover?.atStop ? scenario.takeover.atStop(atStop, index) : atStop;
      if (want !== null) {
        expectSameObservation(seen, want, `at the stop point after takeover ${index} (${legName(t.legs, index)})`);
      }
    }
    atStop = seen;
    if (index === t.legs.length - 1) {
      await scenario.finish(leg);
      const end = await observe(world, server, herdr);
      await server.stop();
      return { legs, seen: end };
    }
    await server.stop();
  }
  throw new Error("unreachable: a takeover has at least two legs");
}

function legName(legs: ServerKind[], index: number): string {
  return `${legs[index - 1]} to ${legs[index]}`;
}

/**
 * Register a takeover case: the scenario run uninterrupted, then across
 * every leg in CONFORMANCE_LEGS, the two compared.
 */
export function takeover<P = void>(area: Area, name: string, scenario: TakeoverScenario<P>, options: TakeoverOptions = {}): void {
  conformance(
    area,
    name,
    async (t) => {
      const reference = await uninterrupted(t, scenario);
      const { legs, seen } = await takenOver(t, scenario);
      const takeovers = legs.length - 1;
      const want = scenario.takeover?.atEnd?.(reference, takeovers) ?? reference;
      expectSameObservation(seen, want, `at the end of ${t.legs.join(",")} against one ${t.kind} server`);
      await scenario.verify?.(legs, seen, reference);
    },
    { timeoutMs: options.timeoutMs ?? 120_000, takeover: true },
  );
}
