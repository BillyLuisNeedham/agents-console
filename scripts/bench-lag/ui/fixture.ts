/**
 * The lag bench UI half's pool (issues #157, #161): 20 ticket cards and 3
 * Conversations, the shape of a pool partway through a day's run, and the
 * data its cards' fetches or frames bring. Both pages (bench.ts for the push
 * protocol, bench-sse.ts for the checkouts before it) churn the Console with
 * this one fixture, so a before and an after are measured on the same pool.
 */

import type {
  ConversationView,
  EnrichedSnapshot,
  EnrichedTicketState,
  SettingsResponse,
  TicketActivityResponse,
  TicketEvent,
  TicketEventsResponse,
  TicketGradeSummary,
} from "@console/project";

export const DONE = Array.from({ length: 12 }, (_, i) => `t-${String(i + 1).padStart(2, "0")}`);
export const RUNNING = ["t-13", "t-14", "t-15", "t-16"];
export const WAITING = ["t-17", "t-18", "t-19", "t-20"];
export const CONVERSATIONS = ["conv-1", "conv-2", "conv-3"];
const started = new Date(Date.now() - 20 * 60_000).toISOString();
/** The done tickets whose branches have not landed: the Merge queue. */
const UNMERGED = new Set(["t-10", "t-11", "t-12"]);

export function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join("\n");
}

function ticket(id: string, overrides: Partial<EnrichedTicketState>): EnrichedTicketState {
  const base = {
    id,
    title: `Ticket ${id}: make the thing behave under load`,
    blockedBy: [] as string[],
    status: "ready" as const,
    mergeState: null,
    enlisted: false,
    heldPane: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    liveAttempt: null,
    ...overrides,
  };
  const eligible = base.liveAttempt === null && base.status !== "done";
  return {
    ...base,
    reassign: {
      eligible,
      reason: eligible ? null : "an Attempt is in flight",
      verify: null,
      sources: { harness: "default", model: "pinned", drivers: "default" },
    },
  } as EnrichedTicketState;
}

export function conversation(id: string, seq: number, i: number): ConversationView {
  const waiting = (seq + i) % 3 === 0;
  return {
    id,
    title: `Conversation ${id}`,
    status: "live",
    spawnedBy: null,
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    paneId: `pane-${id}`,
    branch: `pool/bench/${id}`,
    turn: waiting
      ? { state: "waiting", lastLine: `waiting on you (${seq})`, idleSince: new Date().toISOString() }
      : { state: "working", lastLine: `editing src/module-${(seq + i) % 17}.ts`, idleSince: null },
    children: [],
    enlisted: false,
    ending: false,
  } as ConversationView;
}

/** The pool log, which every pushed version adds a line to. */
export const poolLog: string[] = Array.from({ length: 150 }, (_, i) => `[pool] boot line ${i + 1}`);

/** The pool at version `seq`: each version moves a Conversation's turn line. */
export function snapshot(seq: number): EnrichedSnapshot {
  const tickets: EnrichedTicketState[] = [
    ...DONE.map((id, i) =>
      ticket(id, {
        status: "done",
        // A chain of done work, so the canvas has edges to route.
        blockedBy: i > 0 && i % 3 !== 0 ? [DONE[i - 1]!] : [],
        mergeState: UNMERGED.has(id) ? "queued" : null,
      }),
    ),
    ...RUNNING.map((id, i) =>
      ticket(id, {
        status: "in-progress",
        blockedBy: [DONE[i * 3 + 2]!],
        liveAttempt: { attempt: 1 + (i % 2), paneId: `pane-${id}`, role: "agent", startedAt: started },
      }),
    ),
    ...WAITING.map((id, i) =>
      ticket(id, {
        status: "ready",
        blockedBy: i === 3 ? [RUNNING[0]!, RUNNING[1]!] : [RUNNING[i]!],
      }),
    ),
  ];
  const outcomes: EnrichedSnapshot["state"]["outcomes"] = {};
  for (const id of DONE) {
    outcomes[id] = { status: "done", summary: lines(`outcome of ${id}`, 12), commitSha: "abc1234" };
  }
  return {
    seq,
    phase: "running",
    poolName: "bench/lag",
    poolTitle: "Lag bench",
    poolDir: "/tmp/bench-pool",
    finishedTerminals: 2,
    spawnUsage: { spawnedThisRun: 6, perAttempt: 5, perRun: 20 },
    pendingSpawns: [],
    heldSpawns: [],
    stewardBudget: { budget: 5, used: {} },
    state: {
      tickets,
      conversations: CONVERSATIONS.map((id, i) => conversation(id, seq, i)),
      log: [...poolLog],
      outcomes,
      interrupts: [],
      mergeQueue: [...UNMERGED].map((ticketId) => ({ ticketId, state: "queued" as const })),
      queuedAnswers: [],
      config: { terminal: "herdr", defaults: { harness: "claude", model: "opus" } },
    },
  } as EnrichedSnapshot;
}

/** A few hundred events: several attempts' worth of launches, exits,
 *  grades, checkpoints and answers, which is what a long-lived ticket's
 *  events file reads like by the afternoon. */
function events(id: string): TicketEventsResponse {
  const list: TicketEvent[] = [];
  const t0 = Date.now() - 3 * 3600_000;
  let n = 0;
  const ev = (attempt: number, kind: TicketEvent["kind"], payload: Record<string, unknown> = {}) =>
    list.push({ at: new Date(t0 + n++ * 30_000).toISOString(), attempt, kind, payload });
  for (let attempt = 1; attempt <= 8; attempt++) {
    ev(attempt, "scheduled");
    for (let r = 0; r < 4; r++) ev(attempt, "launch-retried", { reason: "the wrapper never ran" });
    ev(attempt, "spawned", { paneId: `pane-${id}` });
    for (let k = 0; k < 10; k++) {
      ev(attempt, "checkpoint", { brief: lines("brief", 4) });
      ev(attempt, "answered", { action: "resume", note: "carry on with the smaller change" });
    }
    ev(attempt, "exited", { code: 0 });
    ev(attempt, "graded", {
      score: 6 + (attempt % 4),
      verdict: attempt % 3 ? "pass" : "flag",
      reasons: lines("reason", 6),
    });
    for (let k = 0; k < 6; k++) ev(attempt, "merge-conflict", { files: [`src/f${k}.ts`, `src/g${k}.ts`] });
  }
  return { events: list, attempts: [], reconstructed: false, spec: `# ${id}\n\n${lines("spec", 40)}` };
}

const EVENTS = new Map<string, TicketEventsResponse>();
/** A ticket's events, a fresh object each time, as a parsed response would be. */
export function eventsFor(id: string): TicketEventsResponse {
  let cached = EVENTS.get(id);
  if (!cached) {
    cached = events(id);
    EVENTS.set(id, cached);
  }
  return JSON.parse(JSON.stringify(cached)) as TicketEventsResponse;
}

/** A ticket's Issue body. */
export function bodyOf(id: string): string {
  return `# ${id}\n\n${lines("spec paragraph", 60)}`;
}

/** An attempt's raw log, about 150 KB of it. */
export const LOG_TEXT = lines("[agent] raw log output, a tool call or a diff hunk", 3000);

export function grades(): Record<string, TicketGradeSummary> {
  const out: Record<string, TicketGradeSummary> = {};
  for (const [i, id] of DONE.entries()) {
    out[id] = { attempt: 1, score: 6 + (i % 4), verdict: i % 5 ? "pass" : "flag", winner: 1 };
  }
  return out;
}

let activityTick = 0;
/** A running ticket's activity, moved on every call. */
export function activity(ticketId: string): TicketActivityResponse {
  activityTick += 1;
  const files = Array.from({ length: 3 + (activityTick % 5) }, (_, i) => `src/area-${i}/file-${i}.ts`);
  return {
    ticketId,
    running: true,
    diff: { added: 40 + activityTick, removed: 10 + (activityTick % 13), files },
    log: { size: 100_000 + activityTick * 512, mtime: new Date().toISOString() },
    lastEventAt: new Date(Date.now() - 5_000).toISOString(),
  };
}

let peekTick = 0;
/** A pane's rendered tail, moved on every call. */
export function peekText(ticketId: string): string {
  peekTick += 1;
  return [
    `● ${ticketId}: reading src/module-${peekTick % 23}.ts`,
    `  ⎿  ${peekTick % 40} lines`,
    `● running bun test (${peekTick})`,
    "  ⎿  412 pass, 0 fail",
    "> ",
  ].join("\n");
}

export const SETTINGS: SettingsResponse = {
  pool: {
    path: "/tmp/bench-pool/console.json",
    config: { defaults: { harness: "claude", model: "opus" }, port: 4300 },
    bootOnly: ["selection", "terminal", "port"],
    effective: { port: 4300, terminal: "herdr", stale: [] },
  },
  machine: {
    path: "/home/me/.agent-graphs/defaults.json",
    defaults: { harness: "claude" },
    own: { harness: "claude" },
  },
  harnesses: ["claude", "opencode"],
};
