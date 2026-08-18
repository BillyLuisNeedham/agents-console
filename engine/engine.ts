import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CheckpointStore } from "./checkpoints.ts";
import {
  loadPoolMarkers,
  readMarker,
  writeMarkerStatus,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { buildPrompt } from "./prompt.ts";
import {
  defaultHarnesses,
  type HarnessCommand,
  type SpawnContext,
} from "./spawn.ts";

export type { TicketStatus } from "./pool.ts";
export type { HarnessCommand, SpawnContext } from "./spawn.ts";

export interface Outcome {
  summary: string;
  commitSha: string | null;
}

export interface TicketAssignment {
  harness?: string;
  model?: string;
  drivers?: string;
}

export interface PoolConfig {
  defaults?: { harness?: string; model?: string; drivers?: string };
  assign?: Record<string, TicketAssignment>;
  roster?: string;
}

export interface PoolState {
  tickets: Record<string, TicketStatus>;
  log: string[];
  outcomes: Record<string, Outcome>;
  config: PoolConfig;
}

export interface PoolUpdate {
  tickets?: Record<string, TicketStatus>;
  log?: string[];
  outcomes?: Record<string, Outcome>;
}

export type RunPhase = "running" | "done" | "stalled";

export interface PoolSnapshot {
  seq: number;
  phase: RunPhase;
  state: PoolState;
}

export interface RunOptions {
  poolDir: string;
  harnesses?: Record<string, HarnessCommand>;
  onSnapshot?: (snapshot: PoolSnapshot) => void;
}

export interface PoolRun {
  phase: Exclude<RunPhase, "running">;
  final: PoolState;
  snapshots: PoolSnapshot[];
}

const reduceTickets = (
  current: PoolState["tickets"],
  update: NonNullable<PoolUpdate["tickets"]>,
): PoolState["tickets"] => ({ ...current, ...update });

const reduceLog = (
  current: PoolState["log"],
  update: NonNullable<PoolUpdate["log"]>,
): PoolState["log"] => [...current, ...update];

const reduceOutcomes = (
  current: PoolState["outcomes"],
  update: NonNullable<PoolUpdate["outcomes"]>,
): PoolState["outcomes"] => ({ ...current, ...update });

function applyUpdate(state: PoolState, update: PoolUpdate): PoolState {
  return {
    tickets: update.tickets
      ? reduceTickets(state.tickets, update.tickets)
      : state.tickets,
    log: update.log ? reduceLog(state.log, update.log) : state.log,
    outcomes: update.outcomes
      ? reduceOutcomes(state.outcomes, update.outcomes)
      : state.outcomes,
    config: state.config,
  };
}

export function readyTickets(
  markers: TicketMarker[],
  tickets: PoolState["tickets"],
): TicketMarker[] {
  return markers.filter(
    (marker) =>
      tickets[marker.id] === "ready" &&
      marker.blockedBy.every((id) => tickets[id] === "done"),
  );
}

export async function runPool(options: RunOptions): Promise<PoolRun> {
  const poolDir = options.poolDir;
  const issuesDir = join(poolDir, "issues");
  const runsDir = join(poolDir, "runs");
  const markers = loadPoolMarkers(issuesDir);
  mkdirSync(runsDir, { recursive: true });

  const config = readConfig(poolDir);
  const harnesses = { ...defaultHarnesses, ...options.harnesses };
  const agentMd = readOptional(join(poolDir, "AGENT.md")) ?? "";
  const cwd = repoRootOf(poolDir);

  const assignments = new Map(
    markers.map((marker) => [
      marker.id,
      resolveAssignment(marker, config, harnesses),
    ]),
  );

  let state: PoolState = {
    tickets: Object.fromEntries(markers.map((m) => [m.id, m.status])),
    log: [],
    outcomes: {},
    config,
  };

  const snapshots: PoolSnapshot[] = [];
  const emit = (phase: RunPhase) => {
    const snapshot: PoolSnapshot = { seq: snapshots.length, phase, state };
    snapshots.push(snapshot);
    options.onSnapshot?.(snapshot);
  };

  const store = new CheckpointStore(poolDir);
  let phase: Exclude<RunPhase, "running">;
  try {
    emit("running");
    let superStep = 0;
    for (;;) {
      const ready = readyTickets(markers, state.tickets);
      if (ready.length === 0) break;
      superStep += 1;
      state = applyUpdate(state, {
        tickets: Object.fromEntries(
          ready.map((marker) => [marker.id, "in-progress" as const]),
        ),
        log: [
          `super-step ${superStep}: ${ready.map((m) => m.id).join(", ")}`,
        ],
      });
      emit("running");
      const snapshot = state;

      const updates = await Promise.all(
        ready.map((marker) =>
          runTicket(marker, snapshot, assignments.get(marker.id)!, {
            poolDir,
            runsDir,
            issuesDir,
            agentMd,
            harnesses,
            cwd,
          }),
        ),
      );

      let joined = snapshot;
      for (const update of updates) {
        joined = applyUpdate(joined, update);
      }
      state = joined;
      store.write(state);
      emit("running");
    }

    const pending = markers
      .map((m) => m.id)
      .filter((id) => state.tickets[id] !== "done");
    phase = pending.length === 0 ? "done" : "stalled";
    state = applyUpdate(state, {
      log: [
        phase === "done"
          ? "pool done: every ticket reached done"
          : `pool stalled: ${pending.join(", ")} cannot run`,
      ],
    });
    store.write(state);
    emit(phase);
  } finally {
    store.close();
  }
  return { phase: phase!, final: state, snapshots };
}

interface TicketEnv {
  poolDir: string;
  runsDir: string;
  issuesDir: string;
  agentMd: string;
  harnesses: Record<string, HarnessCommand>;
  cwd: string;
}

interface Assignment {
  harness: string;
  model: string;
  drivers: string;
}

async function runTicket(
  marker: TicketMarker,
  snapshot: PoolState,
  assignment: Assignment,
  env: TicketEnv,
): Promise<PoolUpdate> {
  const [driver, ...chain] = assignment.drivers.split(/\s+/).filter(Boolean);
  const logPath = join(env.runsDir, `${marker.id}.log`);
  const outcomePath = join(env.runsDir, `${marker.id}.outcome.json`);
  const issueRel = relative(env.cwd, marker.file);

  const upstream = marker.blockedBy.flatMap((id) => {
    const outcome = snapshot.outcomes[id];
    return outcome ? [{ id, outcome }] : [];
  });

  const prompt = buildPrompt({
    driver,
    chain,
    issueRel,
    agentMd: env.agentMd,
    roster: snapshot.config.roster ?? "",
    upstream,
    outcomePath,
  });

  writeMarkerStatus(marker.file, "in-progress");

  const ctx: SpawnContext = {
    id: marker.id,
    issuePath: marker.file,
    issueRel,
    prompt,
    driver,
    harness: assignment.harness,
    model: assignment.model,
    logPath,
    outcomePath,
    cwd: env.cwd,
  };
  const argv = env.harnesses[assignment.harness](ctx);
  const exitCode = await spawnToLog(argv, ctx);

  const status = readMarker(marker.file).status;
  const outcome = readOutcome(outcomePath);

  return {
    tickets: { [marker.id]: status },
    log: [
      `ticket ${marker.id}: exited ${exitCode}, marker ${status}` +
        (outcome ? "" : ", no outcome recorded"),
    ],
    ...(outcome ? { outcomes: { [marker.id]: outcome } } : {}),
  };
}

async function spawnToLog(
  argv: string[],
  ctx: SpawnContext,
): Promise<number> {
  const proc = Bun.spawn(argv, {
    cwd: ctx.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await Bun.write(ctx.logPath, stdout + stderr);
  return exitCode;
}

function readOutcome(path: string): Outcome | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.summary !== "string") return null;
    return {
      summary: parsed.summary,
      commitSha: typeof parsed.commitSha === "string" ? parsed.commitSha : null,
    };
  } catch {
    return null;
  }
}

function resolveAssignment(
  marker: TicketMarker,
  config: PoolConfig,
  harnesses: Record<string, HarnessCommand>,
): Assignment {
  const assign = config.assign?.[marker.id] ?? {};
  const harness = assign.harness ?? config.defaults?.harness ?? "";
  const model = assign.model ?? config.defaults?.model ?? "";
  const drivers =
    assign.drivers ?? config.defaults?.drivers ?? "implement";
  if (!harness) {
    throw new Error(
      `pool config: ticket ${marker.id} has no harness ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  if (!model) {
    throw new Error(
      `pool config: ticket ${marker.id} has no model ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  if (!harnesses[harness]) {
    throw new Error(
      `pool config: ticket ${marker.id} names unknown harness '${harness}'. ` +
        `Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  return { harness, model, drivers };
}

function readConfig(poolDir: string): PoolConfig {
  const raw = readOptional(join(poolDir, "console.json"));
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pool config: ${join(poolDir, "console.json")} must be a JSON object`);
  }
  return parsed as PoolConfig;
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function repoRootOf(poolDir: string): string {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", poolDir, "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode === 0) {
    const root = probe.stdout.toString().trim();
    if (root) return root;
  }
  return poolDir;
}
