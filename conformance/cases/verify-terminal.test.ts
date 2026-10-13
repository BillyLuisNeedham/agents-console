/**
 * Verify on terminal-backed runs (C21 of the Rust port's inventory,
 * docs/research/rust-port/test-inventory.md): a verify Ticket whose
 * Attempts run as tabs in herdr, so a checkpoint leaves a Held pane that
 * Keep talking continues and an Adopt lets go.
 *
 * The server launches every Attempt and grader as the claude stub inside a
 * pane of the fake herdr, which runs the pane's command for real. The
 * prompt is pasted rather than passed in argv, so the stub cannot see an
 * outcome path: the case writes each Outcome itself once the prompt naming
 * it has been submitted, as the TUI would. An interactive harness stays up
 * after its Outcome (ADR-0016), so the stub holds the pane's process open
 * after it records its launch, until the world is deleted.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { conformance } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import { answer, snapshot, ticketOf } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { ready, verifyConfig } from "./verify-common.ts";

/** What the fake's panes show: claude's ready frame, so the prompt is typed. */
const RENDERED = "Claude Code v2.1\n❯ ";

/** console.json for a terminal-backed pool with `verify: n` on Ticket 01. */
function terminalConfig(n: number, assign: Record<string, { verify: number }> = {}) {
  return verifyConfig(n, { terminal: "herdr", assign: { "01": { verify: n }, ...assign } });
}

/**
 * Keep every pane's claude up after the stub records its launch, the way a
 * TUI stays up after its Outcome: until the world is gone or a minute
 * passes. A terminal launch names no outcome file, so its stub key is
 * `_claude`.
 */
function holdTuis(world: World): void {
  world.stubs.script("_claude", { hold: join(world.root, "quit") });
}

type OutcomeJson = Record<string, unknown>;

const PASSING_GRADE: OutcomeJson = {
  status: "done",
  summary: "graded",
  commitSha: null,
  grade: { score: 8, verdict: "pass", reasons: "fine" },
};

/**
 * Answer each prompt the server types into a pane, by the outcome file it
 * names: the next scripted Outcome for that file's stem, or a passing grade
 * for a grader. A stem with nothing scripted is left alone, for the case to
 * write itself. Stops when `stop` is called.
 */
function serveOutcomes(herdr: HerdrProcess, outcomes: Record<string, OutcomeJson[]>): { stop(): void } {
  let stopped = false;
  let seen = 0;
  const queues = Object.fromEntries(Object.entries(outcomes).map(([key, list]) => [key, [...list]]));
  void (async () => {
    while (!stopped) {
      const submitted = await herdr.control<string[]>("submitted").catch(() => [] as string[]);
      for (const text of submitted.slice(seen)) {
        const match = /outcome as JSON at ([^:\s]+\.outcome\.json)/.exec(text);
        if (!match) continue;
        const path = match[1]!;
        const key = basename(path, ".outcome.json");
        const outcome = /-grader-\d+$/.test(key) ? PASSING_GRADE : queues[key]?.shift();
        if (outcome) writeFileSync(path, JSON.stringify(outcome));
      }
      seen = Math.max(seen, submitted.length);
      await Bun.sleep(50);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}

const CHECKPOINT: OutcomeJson = { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" };
const FINISHED: OutcomeJson = { status: "done", summary: "finished", commitSha: null };

/** Wait for a Ticket's Held pane on the snapshot. */
async function heldPaneOf(server: Parameters<typeof snapshot>[0], id: string) {
  const held = await until(
    async () => ticketOf(await snapshot(server), id).heldPane,
    (pane) => pane !== null,
    { ms: 20_000, what: `${id}'s Held pane` },
  );
  return held!;
}

/** The tab each attempt of a Ticket was spawned in, by its spawned events. */
function spawnedTabs(world: World, id: string): { attempt: number; tab: unknown }[] {
  return readEvents(world.pool, id)
    .filter((e) => e.kind === "spawned")
    .map((e) => ({ attempt: e.attempt, tab: e.payload.tab_id }));
}

// keep-talking.test.ts:572
conformance(
  "verify",
  "grades a verify ticket's Continued attempt as a lone attempt and merges the branch it worked on",
  async (t) => {
    const world = t.world({ tickets: [ready("01")], config: terminalConfig(1) });
    holdTuis(world);
    const herdr = await t.herdr(world, { rendered: RENDERED });
    const outcomes = serveOutcomes(herdr, { "01.attempt-1": [CHECKPOINT] });
    const server = await t.start(world, { herdr });

    const held = await heldPaneOf(server, "01");
    expect(held.attempt).toBe(1);

    const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
    expect(talk.status).toBe(202);
    expect(talk.json<{ attempt: number }>().attempt).toBe(2);

    // A verify ticket's files are attempt-numbered, the Continued attempt's
    // included: its Outcome goes to its own file.
    const outcomePath = join(world.pool, "runs", "01.attempt-2.outcome.json");
    writeFileSync(outcomePath, JSON.stringify({ status: "done", summary: "talked it through", commitSha: null }));

    const done = await until(
      () => snapshot(server),
      (snap) => ticketOf(snap, "01").status === "done",
      { ms: 30_000, what: "01 to be done" },
    );
    outcomes.stop();

    const events = readEvents(world.pool, "01");
    expect(events.filter((e) => e.kind === "graded").map((e) => e.attempt)).toEqual([1, 2]);
    expect(events.find((e) => e.kind === "merged")?.attempt).toBe(2);
    expect(
      done.state.log.some((line) => line.includes("attempt 2 passed grading; merged") && line.includes("01.attempt-1")),
    ).toBe(true);
  },
  { timeoutMs: 60_000 },
);

// keep-talking.test.ts:1054
conformance(
  "verify",
  "lets the paused candidate's Held pane go and closes its tab when a finished candidate is adopted",
  async (t) => {
    const world = t.world({ tickets: [ready("01")], config: terminalConfig(2) });
    holdTuis(world);
    const herdr = await t.herdr(world, { rendered: RENDERED });
    const outcomes = serveOutcomes(herdr, { "01.attempt-1": [CHECKPOINT], "01.attempt-2": [FINISHED] });
    const server = await t.start(world, { herdr });

    expect((await heldPaneOf(server, "01")).attempt).toBe(1);
    const paused = await snapshot(server);
    expect(paused.state.interrupts.map((i) => [i.ticketId, i.kind, i.candidates])).toEqual([
      ["01", "checkpoint", [2]],
    ]);
    const pausedTab = spawnedTabs(world, "01").find((s) => s.attempt === 1)!.tab;
    expect(typeof pausedTab).toBe("string");

    await answer(server, { ticketId: "01", action: "adopt", attempt: 2 });
    await until(
      () => readEvents(world.pool, "01"),
      (events) => events.some((e) => e.kind === "tab-closed" && e.payload.tab_id === pausedTab),
      { ms: 20_000, what: "the paused candidate's tab-closed event" },
    );
    const done = await until(
      () => snapshot(server),
      (snap) => ticketOf(snap, "01").status === "done",
      { ms: 20_000, what: "01 to be done" },
    );
    outcomes.stop();

    expect(ticketOf(done, "01").heldPane).toBeNull();
    expect(herdr.calls.filter((c) => c.method === "tab.close").map((c) => c.params.tab_id)).toContain(pausedTab);
    // Nothing relaunched: the question went unanswered with the Interrupt.
    // The two candidates launch together, so their spawned events land in
    // either order.
    expect(spawnedTabs(world, "01").map((s) => s.attempt).sort()).toEqual([1, 2]);
  },
  { timeoutMs: 60_000 },
);

// keep-talking.test.ts:1083
conformance(
  "verify",
  "holds a queued Adopt while a Continued attempt works in the pool checkout, and merges it after",
  async (t) => {
    const world = t.world({ tickets: [ready("01"), ready("03"), ready("02", "03")], config: terminalConfig(2) });
    holdTuis(world);
    const herdr = await t.herdr(world, { rendered: RENDERED });
    const outcomes = serveOutcomes(herdr, {
      "01.attempt-1": [CHECKPOINT],
      "01.attempt-2": [FINISHED],
      "03": [{ status: "done", summary: "done", commitSha: null }],
      "02": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me too" }],
    });
    const server = await t.start(world, { herdr });

    // 02 runs alone after 03, so in the pool checkout, and checkpoints there.
    await heldPaneOf(server, "02");
    const paused = await snapshot(server);
    expect(paused.state.interrupts.find((i) => i.ticketId === "01")?.candidates).toEqual([2]);
    expect(readEvents(world.pool, "02").find((e) => e.kind === "spawned")?.payload.cwd).toBe(world.repo);
    const talk = await server.http.post("/api/keep-talking", { ticketId: "02" });
    expect(talk.status).toBe(202);

    await answer(server, { ticketId: "01", note: "the finished one", action: "adopt", attempt: 2 });
    await Bun.sleep(500);
    // Adopt merges, so it waits, still queued, while the checkout is held.
    const waiting = await snapshot(server);
    expect(ticketOf(waiting, "01").status).toBe("checkpoint");
    expect(waiting.state.queuedAnswers.map((a) => [a.ticketId, a.action, a.attempt])).toEqual([["01", "adopt", 2]]);
    expect(readEvents(world.pool, "01").some((e) => e.kind === "merged")).toBe(false);

    writeFileSync(
      join(world.pool, "runs", "02.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked", commitSha: null }),
    );
    const done = await until(
      () => snapshot(server),
      (snap) => ticketOf(snap, "01").status === "done",
      { ms: 20_000, what: "01 to be done" },
    );
    outcomes.stop();

    expect(ticketOf(done, "02").status).toBe("done");
    expect(readEvents(world.pool, "01").filter((e) => e.kind === "merged").map((e) => e.attempt)).toEqual([2]);
  },
  { timeoutMs: 60_000 },
);
