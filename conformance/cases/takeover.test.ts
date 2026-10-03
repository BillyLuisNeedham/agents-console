/**
 * Takeover (ADR-0036): a pool stopped mid-run by one server process and
 * resumed by the next from what is on disk, leg by leg across the servers
 * CONFORMANCE_LEGS names, and matched against the same pool run
 * uninterrupted. harness/takeover.ts drives the legs and the comparison.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../engine/wire.ts";
import { anyIsoTime } from "../harness/equal.ts";
import type { HerdrCall } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";
import type { StubHold } from "../harness/stubs.ts";
import { takeover, type Leg, type Observation } from "../harness/takeover.ts";

type State = { snapshot: EnrichedSnapshot | null };

/** GET /api/state until `done` holds of its snapshot. */
async function snapshotUntil(leg: Leg<unknown>, done: (snapshot: EnrichedSnapshot) => boolean, what: string): Promise<EnrichedSnapshot> {
  const answer = await until(
    () => leg.server.http.get("/api/state"),
    (got) => {
      const snapshot = got.status === 200 ? got.json<State>().snapshot : null;
      return snapshot !== null && done(snapshot);
    },
    { what, ms: 20_000 },
  );
  return answer.json<State>().snapshot!;
}

/**
 * The pending Interrupts as `<ticket id>:<kind>`, sorted: Attempts of one
 * super-step end in whatever order they race to.
 */
function interrupts(snapshot: EnrichedSnapshot): string[] {
  return snapshot.state.interrupts.map((interrupt) => `${interrupt.ticketId}:${interrupt.kind}`).sort();
}

/** Quiescent with exactly these Interrupts pending. */
function quiescentWith(...expected: string[]) {
  return (snapshot: EnrichedSnapshot): boolean =>
    snapshot.phase === "quiescent" && interrupts(snapshot).join(" ") === expected.join(" ");
}

async function resume(leg: Leg<unknown>, body: Record<string, unknown>): Promise<void> {
  const answer = await leg.server.http.post("/api/resume", body);
  if (answer.status !== 202) throw new Error(`POST /api/resume ${JSON.stringify(body)} answered ${answer.status}: ${answer.text}`);
}

/** An observation with its snapshot changed by `edit`, the rest as it was. */
function withSnapshot(seen: Observation, edit: (snapshot: EnrichedSnapshot) => void): Observation {
  const snapshot = structuredClone(seen.snapshot) as EnrichedSnapshot;
  edit(snapshot);
  return { ...seen, snapshot };
}

function ticketIn(snapshot: EnrichedSnapshot, id: string) {
  const ticket = snapshot.state.tickets.find((each) => each.id === id);
  if (!ticket) throw new Error(`no Ticket ${id} in the snapshot`);
  return ticket;
}

const DEFAULTS = { defaults: { harness: "claude", model: "m" } };

takeover("restart", "a checkpoint Interrupt survives each takeover and resumes to done", {
  world: {
    tickets: [
      { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nStop to ask." },
      { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->", body: "# Second\n\nAfter the first." },
    ],
    config: DEFAULTS,
  },
  prepare(world) {
    world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "decide the colour" });
  },
  // Nothing to drive: 01 checkpoints on its own, and stopPoint waits for it.
  async reach() {},
  async stopPoint(leg) {
    await snapshotUntil(leg, quiescentWith("01:checkpoint"), "01's checkpoint Interrupt");
  },
  async finish(leg) {
    await resume(leg, { ticketId: "01", note: "blue" });
    await snapshotUntil(leg, quiescentWith("REVIEW:review"), "the run's Review");
  },
});

/** The fake herdr's pane renders as Claude Code's TUI, so a terminal-backed launch reads as ready. */
const CLAUDE_TUI = { rendered: "Claude Code v9.9.9\n" };
const TERMINAL = { ...DEFAULTS, terminal: "herdr" as const };

/** The Enter that submits a pasted prompt: keys alone, no text. */
function submits(call: HerdrCall): boolean {
  return call.method === "pane.send_input" && call.params.text === undefined &&
    Array.isArray(call.params.keys) && (call.params.keys as string[]).includes("enter");
}

takeover<StubHold>("restart", "a terminal-backed Attempt live in its pane is re-adopted by each takeover and ends there", {
  world: {
    tickets: [{ file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nWork in a pane." }],
    config: TERMINAL,
  },
  herdr: CLAUDE_TUI,
  // Terminal-backed, the stub learns no outcome path: it stays open in its
  // pane, and the case writes the Outcome itself.
  prepare: (world) => world.stubs.hold("_claude"),
  async reach(leg) {
    await leg.herdr!.waitForCall(submits, { ms: 20_000 });
  },
  async stopPoint(leg) {
    await snapshotUntil(
      leg,
      (snapshot) => {
        const ticket = ticketIn(snapshot, "01");
        const adopted = leg.index === 0 || interrupts(snapshot).includes("01:checkpoint");
        return ticket.status === "in-progress" && ticket.liveAttempt !== null && adopted;
      },
      leg.index === 0 ? "01's Attempt live in its pane" : "01's Attempt re-adopted from its pane",
    );
  },
  async finish(leg) {
    writeFileSync(
      join(leg.world.pool, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "worked in the pane", commitSha: null }),
    );
    await snapshotUntil(leg, quiescentWith("REVIEW:review"), "the run's Review");
    await leg.prepared.release();
  },
  takeover: {
    // A server that finds the Attempt's pane live re-adopts it, starting
    // its clock afresh, and raises the adoption checkpoint: answering it
    // would abandon the pane and re-run the Ticket. The pool waits on the
    // operator meanwhile, so it reads quiescent rather than running.
    atStop: (before) =>
      withSnapshot(before, (snapshot) => {
        snapshot.phase = "quiescent";
        snapshot.state.interrupts = [
          {
            ticketId: "01",
            kind: "checkpoint",
            body:
              "The engine restarted while this ticket's terminal-backed attempt 1 was still running in herdr pane " +
              "w1:p1. The pane proved live at boot, so the engine re-adopted the attempt and is waiting on the " +
              "pane's exit; the attempt's real outcome will be recorded then. Answering this interrupt abandons " +
              "the attempt (the pane is closed) and re-runs the ticket.",
          },
        ];
        ticketIn(snapshot, "01").liveAttempt!.startedAt = anyIsoTime() as string;
      }),
  },
});

/** The pool's Tickets as `<id>:<status>`, in order. */
function statuses(snapshot: EnrichedSnapshot): string[] {
  return snapshot.state.tickets.map((ticket) => `${ticket.id}:${ticket.status}`);
}

/** Release a held Ticket's launch once the server has made it, unless the Ticket is done. */
async function releaseWhenHeld(leg: Leg<StubHold>, id: string): Promise<void> {
  const snapshot = await snapshotUntil(
    leg,
    (each) => ticketIn(each, id).status === "done" || ticketIn(each, id).liveAttempt !== null,
    `${id} live or done`,
  );
  if (ticketIn(snapshot, id).status !== "done") await leg.prepared.release();
}

/** The note the engine appends to a Ticket a stop left in-progress with no agent alive at the next boot. */
const ENGINE_RESET_NOTE =
  "\n---\n\n## Brief, written by the engine\n\n" +
  "The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted). " +
  "No agent from that process was found still running at this boot, so the work is part done at best and the " +
  "agent left no brief. The ticket is back to ready; read the working tree before it runs again.\n";

/**
 * The end of an uninterrupted run as it reads when a stop killed Ticket
 * `id`'s headless Attempt once: the stop ended attempt 1 as a crash, the
 * boot put the Ticket back to ready with the engine's note, and it ran
 * again as attempt 2, from the same argv in the same place, to the same end.
 */
function rerunAfterStop(seen: Observation, id: string, file: string): Observation {
  const first = seen.launches.find((launch) => launch.key === id && launch.n === 1)!;
  const launches = [...seen.launches, { ...first, n: 2 }].sort((a, b) =>
    a.key === b.key ? a.n - b.n : a.key < b.key ? -1 : 1,
  );
  const events = seen.events[id]!;
  const stopped = events.slice(0, events.indexOf("1 exited") + 1);
  const again = events.map((event) => event.replace(/^1 /, "2 "));
  return {
    ...seen,
    files: { ...seen.files, [`issues/${file}`]: seen.files[`issues/${file}`] + ENGINE_RESET_NOTE },
    launches,
    events: { ...seen.events, [id]: [...stopped, "1 crash", ...again] },
  };
}

takeover<StubHold>("restart", "a Queued answer and a pending Interrupt survive a takeover with a sibling Attempt in flight", {
  world: {
    tickets: [
      { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nAsk, then finish." },
      { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->", body: "# Second\n\nTake a while." },
      { file: "03-third.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->", body: "# Third\n\nAsk too." },
    ],
    config: DEFAULTS,
  },
  prepare(world) {
    world.stubs.script("01", { statuses: ["checkpoint", "done"], brief: "brief-01" });
    world.stubs.script("03", { statuses: ["checkpoint", "done"], brief: "brief-03" });
    // 02 keeps the super-step open, so the answer to 01 queues.
    return world.stubs.hold("02");
  },
  async reach(leg) {
    await snapshotUntil(
      leg,
      (snapshot) => interrupts(snapshot).join(" ") === "01:checkpoint 03:checkpoint",
      "01's and 03's checkpoints",
    );
    await resume(leg, { ticketId: "01", note: "carry on" });
  },
  async stopPoint(leg) {
    if (leg.index === 0) {
      await snapshotUntil(
        leg,
        (snapshot) =>
          snapshot.state.queuedAnswers.length === 1 &&
          interrupts(snapshot).join(" ") === "01:checkpoint 03:checkpoint" &&
          ticketIn(snapshot, "02").liveAttempt !== null,
        "01's answer queued behind 02's Attempt",
      );
      return;
    }
    // The stop killed 02's Attempt, so the boot puts 02 back to ready, and
    // its first boundary drains the answer to 01: both run, and 03 is left.
    await releaseWhenHeld(leg, "02");
    await snapshotUntil(
      leg,
      (snapshot) =>
        statuses(snapshot).join(" ") === "01:done 02:done 03:checkpoint" &&
        quiescentWith("03:checkpoint")(snapshot) &&
        snapshot.state.queuedAnswers.length === 0,
      "01 and 02 done, 03's checkpoint left",
    );
  },
  async finish(leg) {
    await releaseWhenHeld(leg, "02");
    await snapshotUntil(leg, quiescentWith("03:checkpoint"), "03's checkpoint alone");
    await resume(leg, { ticketId: "03", note: "and you" });
    await snapshotUntil(leg, quiescentWith("REVIEW:review"), "the run's Review");
  },
  takeover: {
    atStop: (before, takeovers) => (takeovers === 1 ? null : before),
    atEnd: (seen) => rerunAfterStop(seen, "02", "02-second.md"),
  },
});

/** Every Ticket settled (none ready, in progress or live) with the pool quiescent. */
function settled(snapshot: EnrichedSnapshot): boolean {
  return (
    snapshot.phase === "quiescent" &&
    snapshot.state.tickets.every(
      (ticket) => ticket.liveAttempt === null && ticket.status !== "ready" && ticket.status !== "in-progress",
    )
  );
}

const FOLLOW_UPS = [
  // Blocked by 02, so it runs after 02 on every path: alone, never beside a
  // re-run of 02 in worktrees of their own.
  { title: "Follow up first", body: "Carry the first thread on once the second Ticket is in.", blockedBy: ["02"] },
  { title: "Follow up second", body: "Carry the second thread on, past the per-attempt cap." },
];

takeover<StubHold>("restart", "a Pending spawn lands and a Held spawn stays held across a takeover, then is Adopted", {
  world: {
    tickets: [
      { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nPropose two." },
      { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->", body: "# Second\n\nTake a while." },
    ],
    config: { ...DEFAULTS, spawnCaps: { perAttempt: 1 } },
  },
  prepare(world) {
    // One proposal fits the per-attempt cap and waits for the boundary; the
    // other is held. 02 keeps the super-step open, so neither lands yet.
    world.stubs.script("01", { spawn: FOLLOW_UPS });
    return world.stubs.hold("02");
  },
  // Nothing to drive: 01's Outcome proposes on its own, and stopPoint
  // waits for it.
  async reach() {},
  async stopPoint(leg) {
    if (leg.index === 0) {
      await snapshotUntil(
        leg,
        (snapshot) =>
          snapshot.pendingSpawns.length === 1 &&
          snapshot.heldSpawns.length === 1 &&
          ticketIn(snapshot, "02").liveAttempt !== null,
        "one Pending and one Held spawn, with 02 in flight",
      );
      return;
    }
    // The boot puts 02 back to ready and lands the Pending spawn at its
    // first boundary; the Held spawn waits for the operator.
    await releaseWhenHeld(leg, "02");
    await snapshotUntil(
      leg,
      (snapshot) =>
        settled(snapshot) &&
        statuses(snapshot).sort().join(" ") === "01-spawn-1:done 01:done 02:done" &&
        snapshot.pendingSpawns.length === 0 &&
        snapshot.heldSpawns.length === 1,
      "the Pending spawn landed and done, the Held one still held",
    );
  },
  async finish(leg) {
    await releaseWhenHeld(leg, "02");
    const before = await snapshotUntil(
      leg,
      (snapshot) => settled(snapshot) && snapshot.pendingSpawns.length === 0 && snapshot.heldSpawns.length === 1,
      "the Held spawn alone left",
    );
    const adopt = await leg.server.http.post("/api/spawns/held/adopt", { id: before.heldSpawns[0]!.id });
    expect(adopt.status).toBe(202);
    await snapshotUntil(
      leg,
      (snapshot) =>
        settled(snapshot) && snapshot.heldSpawns.length === 0 && ticketIn(snapshot, "01-spawn-2").status === "done",
      "the Adopted spawn done",
    );
  },
  takeover: {
    // A run is one boot, and the per-run count is of Spawns landed since
    // it: a takeover's count starts again at 0.
    atStop: (before, takeovers) =>
      takeovers === 1 ? null : withSnapshot(before, (snapshot) => (snapshot.spawnUsage.spawnedThisRun = 0)),
    // Uninterrupted, both Spawns land in the one run. The first takeover
    // lands the Pending one and, when it is also the last leg, the Adopted
    // one too; a later last leg lands only the Adopted one.
    atEnd: (seen, takeovers) =>
      withSnapshot(rerunAfterStop(seen, "02", "02-second.md"), (snapshot) => {
        expect(snapshot.spawnUsage.spawnedThisRun).toBe(2);
        snapshot.spawnUsage.spawnedThisRun = takeovers === 1 ? 2 : 1;
      }),
  },
});

/** Commit `text` to shared.txt in the worktree Ticket `id`'s first launch ran in. */
function commitIn(leg: Leg<unknown>, id: string, text: string): void {
  const launch = leg.world.stubs.calls().find((call) => call.key === id && call.n === 1);
  if (!launch || launch.cwd === leg.world.repo) throw new Error(`${id} did not launch in a worktree of its own`);
  writeFileSync(join(launch.cwd, "shared.txt"), text);
  leg.world.git(["-C", launch.cwd, "add", "-A"]);
  leg.world.git(["-C", launch.cwd, "commit", "-qm", `${id} edits shared.txt`]);
}

/** Ticket 02 done, its merge conflicting and waiting on the operator, the pool paused behind it. */
function heldBehind02(snapshot: EnrichedSnapshot): boolean {
  const second = ticketIn(snapshot, "02");
  return (
    statuses(snapshot).join(" ") === "01:done 02:done 03:ready" &&
    second.mergeState === "needs-you" &&
    second.liveAttempt === null &&
    interrupts(snapshot).join(" ") === "02:merge-conflict"
  );
}

takeover<{ first: StubHold; second: StubHold }>(
  "restart",
  "a done Ticket waiting on the Merge hold keeps the pool paused across a takeover, then merges",
  {
    world: {
      tickets: [
        { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nEdit shared.txt." },
        { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->", body: "# Second\n\nEdit it too." },
        { file: "03-third.md", marker: "<!-- state: id=03 blocked-by=01 status=ready -->", body: "# Third\n\nAfter the first." },
      ],
      // No resolver: a conflict waits on the operator rather than on an Attempt.
      config: { ...DEFAULTS, resolver: "none" },
      repoFiles: { "shared.txt": "base\n" },
    },
    prepare: (world) => ({ first: world.stubs.hold("01"), second: world.stubs.hold("02") }),
    async reach(leg) {
      await until(
        () => leg.world.stubs.calls().map((call) => call.key).sort().join(" "),
        (keys) => keys === "01 02",
        { what: "01 and 02 launched" },
      );
      // The stubs commit nothing, so the case commits for them: both edit
      // one line, and the second to merge conflicts.
      commitIn(leg, "01", "from 01\n");
      commitIn(leg, "02", "from 02\n");
      await leg.prepared.first.release();
      await snapshotUntil(
        leg,
        (snapshot) => ticketIn(snapshot, "01").status === "done" && ticketIn(snapshot, "01").mergeState === null,
        "01 done and merged",
      );
      await leg.prepared.second.release();
    },
    async stopPoint(leg) {
      await snapshotUntil(leg, heldBehind02, "02's merge conflict holding the pool");
    },
    async finish(leg) {
      const launch = leg.world.stubs.calls().find((call) => call.key === "02")!;
      leg.world.git(["-C", launch.cwd, "merge", "-q", "-X", "ours", "main", "-m", "02 resolves shared.txt"]);
      await resume(leg, { ticketId: "02" });
      await snapshotUntil(
        leg,
        (snapshot) => settled(snapshot) && quiescentWith("REVIEW:review")(snapshot),
        "02 merged, 03 run, the run's Review",
      );
      // Both merged into main, 02's resolution last; its worktree is gone.
      expect(leg.world.git(["show", "main:shared.txt"])).toBe("from 02\n");
      expect(existsSync(launch.cwd)).toBe(false);
    },
  },
);

/** The pool's one Conversation in the snapshot. */
function conversationIn(snapshot: EnrichedSnapshot) {
  const [conversation, ...rest] = snapshot.state.conversations;
  if (!conversation || rest.length > 0) throw new Error(`not one Conversation: ${snapshot.state.conversations.length}`);
  return conversation;
}

/** How many times the pool log says the Conversation was re-adopted at boot. */
function readoptions(snapshot: EnrichedSnapshot): number {
  return snapshot.state.log.filter((line) => line.startsWith("conversation conv-1: re-adopted at boot")).length;
}

takeover<StubHold>("restart", "a live Conversation is re-adopted from its pane by each takeover, then Ended", {
  world: {
    // A done Ticket only, so nothing runs but the Conversation.
    tickets: [{ file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: "# First\n\nDone already." }],
    config: TERMINAL,
  },
  herdr: CLAUDE_TUI,
  prepare: (world) => world.stubs.hold("_claude"),
  async reach(leg) {
    const started = await leg.server.http.post("/api/conversations", {
      title: "Across a restart",
      opening: "Hello there, let us plan.",
    });
    expect(started.status).toBe(201);
    await leg.herdr!.waitForCall(submits, { ms: 20_000 });
  },
  async stopPoint(leg) {
    await snapshotUntil(
      leg,
      (snapshot) => {
        const conversation = conversationIn(snapshot);
        // The Turn state has read the pane at least once, so what it shows
        // is the pane's, not a fresh launch's empty line.
        return (
          conversation.status === "live" &&
          conversation.paneId !== null &&
          conversation.turn.lastLine === "Claude Code v9.9.9" &&
          readoptions(snapshot) >= leg.index
        );
      },
      leg.index === 0 ? "the Conversation live in its pane" : "the Conversation re-adopted from its pane",
    );
  },
  async finish(leg) {
    const ended = await leg.server.http.post("/api/conversations/end", { id: "conv-1" });
    expect(ended.status).toBe(202);
    await snapshotUntil(leg, (snapshot) => conversationIn(snapshot).status === "ended", "the Conversation ended");
  },
});
