import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERSISTENCE_TICKET_ID,
  REVIEW_TICKET_ID,
  runPool,
  startPool,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
} from "./engine.ts";
import { SqliteCheckpointStore, type CheckpointStore } from "./checkpoints.ts";
import { appendEvent } from "./events.ts";
import { QueuedAnswerStore } from "./queued-answers.ts";
import type { SpawnContext } from "./spawn.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface PoolSpec {
  tickets: { file: string; marker: string; body?: string }[];
  config?: PoolConfig;
  agentMd?: string;
}

function makePool(spec: PoolSpec): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of spec.tickets) {
    writeFileSync(
      join(poolDir, "issues", ticket.file),
      `${ticket.marker}\n\n${ticket.body ?? "# body"}\n`,
    );
  }
  if (spec.config) {
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify(spec.config, null, 2),
    );
  }
  if (spec.agentMd) {
    writeFileSync(join(poolDir, "AGENT.md"), spec.agentMd);
  }
  return poolDir;
}

// The fake agent contract (ADR-0005): the stub signals its ending through the
// outcome JSON it writes, never by editing the Issue marker. "done" and
// "checkpoint" land in the outcome's status field; "keep" writes no outcome
// (crash material); "ready" and "marker-done" sed the marker without writing
// an outcome, the old protocol's misbehaviours the clean break must ignore.
interface StubBehaviour {
  status?: "done" | "checkpoint" | "ready" | "keep" | "marker-done";
  statuses?: ("done" | "checkpoint" | "ready" | "keep" | "marker-done")[];
  outcome?: { summary: string; commitSha: string | null } | null;
  outcomeRaw?: string;
  brief?: string;
  exitCode?: number;
  exitCodes?: number[];
}

interface StubRig {
  harnesses: Record<string, HarnessCommand>;
  spawned: Record<string, SpawnContext>;
  spawnOrder: string[];
}

function stubHarness(behaviour: Record<string, StubBehaviour>): StubRig {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"; outcome_path="$3"; outcome_json="$4"; exit_code="$5"',
      'if [ "$status" = "ready" ] || [ "$status" = "marker-done" ]; then',
      '  sed -i "1s/status=[a-z-]*/status=${status#marker-}/" "$issue"',
      "fi",
      'if [ -n "$outcome_json" ]; then',
      '  printf \'%s\' "$outcome_json" > "$outcome_path"',
      "fi",
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  const spawned: Record<string, SpawnContext> = {};
  const spawnOrder: string[] = [];
  const spawnCounts: Record<string, number> = {};
  const stub: HarnessCommand = (ctx) => {
    spawned[ctx.id] = ctx;
    spawnOrder.push(ctx.id);
    const n = spawnCounts[ctx.id] ?? 0;
    spawnCounts[ctx.id] = n + 1;
    const b = behaviour[ctx.id] ?? {};
    const status = b.statuses
      ? b.statuses[Math.min(n, b.statuses.length - 1)]
      : (b.status ?? "done");
    const outcome =
      b.outcomeRaw !== undefined
        ? b.outcomeRaw
        : b.outcome === null || status === "keep" || status === "ready" || status === "marker-done"
          ? ""
          : JSON.stringify({
              status,
              ...(b.outcome ?? {
                summary: `summary-${ctx.id}`,
                commitSha: `sha-${ctx.id}`,
              }),
              ...(b.brief !== undefined ? { brief: b.brief } : {}),
            });
    const exitCode = b.exitCodes
      ? b.exitCodes[Math.min(n, b.exitCodes.length - 1)]
      : (b.exitCode ?? 0);
    return [
      "bash",
      stubPath,
      ctx.issuePath,
      status,
      ctx.outcomePath,
      outcome,
      String(exitCode),
    ];
  };
  return { harnesses: { stub }, spawned, spawnOrder };
}

const stubConfig: PoolConfig = {
  defaults: { harness: "stub", model: "stub-model" },
};

// The manual merge-conflict path without a resolver: explicit resolver="none"
// means no resolver harness, so a conflict takes the manual path directly.
const noResolverConfig: PoolConfig = {
  ...stubConfig,
  resolver: "none",
};

// Every fully-done pool stops at the final Review interrupt; a test that
// wants a finished run approves it through the same answer path the UI uses.
async function approveReview(run: PoolRun): Promise<PoolRun> {
  const review = run.interrupts.find((i) => i.kind === "review");
  expect(review).toBeTruthy();
  return run.approve(review!.ticketId);
}

describe("pool loading", () => {
  it("rejects a pool with a missing line-1 marker", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-no-marker.md", marker: "# no marker here" }],
      config: stubConfig,
    });
    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/line-1 state marker/);
  });

  it("rejects a pool with no Issue files", async () => {
    const poolDir = makePool({ tickets: [], config: stubConfig });
    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/no Issue files/);
  });

  it("rejects a ticket with no resolvable harness", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
    });
    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/no harness/);
  });
});

describe("super-steps", () => {
  it("runs independent ready tickets as one super-step and terminates done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(Object.keys(rig.spawned).sort()).toEqual(["01", "02"]);
    expect(
      run.final.log.some((line) => line === "super-step 1: 01, 02"),
    ).toBe(true);
    expect(run.final.log.at(-1)).toBe("pool done: every ticket reached done");

    const markers = ["01-a.md", "02-b.md"].map(
      (file) =>
        Bun.file(join(poolDir, "issues", file))
          .text()
          .then((text) => text.split("\n")[0]),
    );
    for (const marker of await Promise.all(markers)) {
      expect(marker).toContain("status=done");
    }
  });

  it("keeps a ticket waiting until every blocker is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.log).toContain("super-step 1: 01");
    expect(run.final.log).toContain("super-step 2: 02");
    expect(
      run.snapshots.some(
        (snapshot) =>
          snapshot.state.tickets["01"] === "in-progress" &&
          snapshot.state.tickets["02"] === "ready",
      ),
    ).toBe(true);
  });

  it("runs the ready set against one shared starting snapshot", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.log).toContain("super-step 2: 02, 03");
    expect(rig.spawned["02"].body).toContain("summary-01");
    expect(rig.spawned["03"].body).toContain("summary-01");
    expect(rig.spawned["02"].body).not.toContain("summary-03");
    expect(rig.spawned["03"].body).not.toContain("summary-02");
    expect(Object.keys(run.final.outcomes).sort()).toEqual([
      "01",
      "02",
      "03",
    ]);
  });
});

// The spawn pump grace: a harness child that exits while a grandchild still
// holds its stdout pipe would park the drive forever on an EOF that never
// comes. The teardown bound turns the parked wait into a bounded drain, and
// the drive proceeds to the next super-step.
describe("spawn pump teardown", () => {
  it("returns from a child whose grandchild holds its stdout pipe and runs the next super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const holderPath = join(poolDir, "pipe-holder.sh");
    writeFileSync(
      holderPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome_path="$1"',
        // The grandchild inherits the harness's stdout, writes one line
        // inside the grace window, then outlives the run on purpose: an
        // unbounded pump would park on its open pipe and blow the time
        // bound below.
        "bash -c 'sleep 0.3; echo late-output-from-grandchild; sleep 30' &",
        'printf \'%s\' \'{"status":"done","summary":"held the pipe","commitSha":"sha-01"}\' > "$outcome_path"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const rig = stubHarness({});
    const harnesses: Record<string, HarnessCommand> = {
      stub: (ctx) =>
        ctx.id === "01"
          ? ["bash", holderPath, ctx.outcomePath]
          : rig.harnesses.stub(ctx),
    };

    const started = Date.now();
    const first = await runPool({ poolDir, harnesses });
    // The bounded grace, not the grandchild's patience, returns the spawn:
    // an unbounded pump would sit on the still-open pipe for the 30s the
    // grandchild lives.
    expect(Date.now() - started).toBeLessThan(10_000);

    const run = await approveReview(first);

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.final.log).toContain("super-step 2: 02");
    // The grandchild's line landed inside the grace window, so the attempt
    // log still captured it.
    expect(readFileSync(join(poolDir, "runs", "01.log"), "utf8")).toContain(
      "late-output-from-grandchild",
    );
  }, 15000);
});

describe("ticket events", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  it("records a checkpoint and resume in order, numbering attempts per ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    const resumed = await run.resume("01", "the name is Foo");
    const done = await approveReview(resumed);
    expect(done.phase).toBe("done");

    const events = readEventsFile(poolDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(events.filter((e) => e.attempt === 1).map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
    ]);
    expect(events.filter((e) => e.attempt === 2).map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    // The exited event carries the exit code and the status from the
    // attempt's outcome JSON.
    const exited = events.filter((e) => e.kind === "exited");
    expect(exited[0].payload).toEqual({ code: 0, status: "checkpoint" });
    expect(exited[1].payload).toEqual({ code: 0, status: "done" });

    // The blocked ticket ran once, cleanly.
    const events02 = readEventsFile(poolDir, "02");
    expect(events02.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(events02.map((e) => e.attempt)).toEqual([1, 1, 1]);
  });

  it("records a crash and its answer, carrying the exit code", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["keep", "done"], exitCodes: [3, 0] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");

    const crash = readEventsFile(poolDir, "01");
    expect(crash.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(crash.at(-1)?.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
    });

    const resumed = await run.resume("01");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const answered = readEventsFile(poolDir, "01");
    expect(answered.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "answered",
      "scheduled",
      "spawned",
      "exited",
    ]);
  });

  it("records a deadlock raise and clear for a blocked cycle", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual([
      "deadlock",
      "deadlock",
    ]);

    const deadlock01 = readEventsFile(poolDir, "01");
    expect(deadlock01.map((e) => e.kind)).toEqual(["deadlock"]);
    expect(deadlock01[0].attempt).toBe(0);
    expect(deadlock01[0].payload).toEqual({ blockers: ["02"] });

    writeFileSync(
      join(poolDir, "issues", "02-b.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n",
    );
    await run.resume("02", "broke the cycle");

    // 01 stays deadlocked until it can complete; once 02 is done and 01 runs,
    // the cleared deadlock lands in the record.
    const cleared01 = readEventsFile(poolDir, "01");
    expect(cleared01.map((e) => e.kind)).toEqual([
      "deadlock",
      "scheduled",
      "spawned",
      "exited",
      "deadlock-cleared",
    ]);
  });

  it("records a review-reject reset against the rejected ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const rejected = await run.reject(REVIEW_TICKET_ID, "redo 01");
    expect(rejected.phase).toBe("quiescent");

    const events = readEventsFile(poolDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "review-reject",
      "scheduled",
      "spawned",
      "exited",
    ]);
  });
});

describe("attempt log rotation", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(
      join(poolDir, "runs", `${id}.events.jsonl`),
      "utf8",
    );
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  it("rotates the raw log to its attempt-numbered name before a re-run writes", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    // A harness that stamps each spawn into the log so the rotated file and
    // the well-known path hold distinguishable content.
    const script = join(poolDir, "stamp-stub.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'status="$1"; stamp="$2"; outcome_path="$3"',
        'echo "attempt-output-$stamp"',
        'printf \'{"status":"%s","summary":"s","commitSha":null}\' "$status" > "$outcome_path"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    let spawn = 0;
    const harness: HarnessCommand = (ctx) => {
      spawn += 1;
      const status = spawn === 1 ? "checkpoint" : "done";
      return ["bash", script, status, String(spawn), ctx.outcomePath];
    };

    const run = await runPool({ poolDir, harnesses: { stub: harness } });
    const resumed = await run.resume("01", "go on");
    const done = await approveReview(resumed);
    expect(done.phase).toBe("done");

    // Attempt 1's output rotated away, attempt 2's at the long-standing path.
    const rotated = readFileSync(join(poolDir, "runs", "01.attempt-1.log"), "utf8");
    expect(rotated).toContain("attempt-output-1");
    const live = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(live).toContain("attempt-output-2");
    // The events file records both attempts, agreeing with the rotated names.
    const events = readEventsFile(poolDir, "01");
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 1)).toBe(true);
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 2)).toBe(true);
  });
});

describe("channels", () => {
  it("lands outcomes in the channel and injects them into downstream prompts", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { outcome: { summary: "built the schema", commitSha: "abc123" } },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.outcomes["01"]).toEqual({
      status: "done",
      summary: "built the schema",
      commitSha: "abc123",
    });
    expect(rig.spawned["02"].body).toContain("01: built the schema");
    expect(rig.spawned["02"].body).toContain("abc123");
  });

  it("appends to the log channel across super-steps", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    const superSteps = run.final.log.filter((line) =>
      line.startsWith("super-step"),
    );
    expect(superSteps).toEqual(["super-step 1: 01", "super-step 2: 02"]);
  });

  it("exposes console.json as the static config channel", async () => {
    const config: PoolConfig = {
      defaults: { harness: "stub", model: "stub-model" },
      roster: "- deepseek: general-purpose subagent",
    };
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.config).toEqual(config);
  });
});

describe("glued prompt", () => {
  it("glues AGENT.md, chain, and roster in run.sh's shape, without a driver line", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: {
        defaults: { harness: "stub", model: "stub-model" },
        assign: { "01": { drivers: "implement code-review" } },
        roster: "- deepseek: general-purpose subagent",
      },
      agentMd: "# Runner agent instructions\n\nDo the thing.",
    });
    const rig = stubHarness({});

    await runPool({ poolDir, harnesses: rig.harnesses });

    const body = rig.spawned["01"].body;
    expect(body).toContain("Standing instructions for this job:");
    expect(body).toContain("Do the thing.");
    expect(body).toContain("dispatch these subagents in this order");
    expect(body).toContain("code-review");
    expect(body).toContain("The subagent roster for this job");
    expect(body).toContain("deepseek: general-purpose subagent");
    expect(body).toContain("outcome.json");
    // The outcome instruction teaches the new contract: a required status,
    // and the engine, not the agent, owning the Issue's status write.
    expect(body).toContain('"status": "done" or "checkpoint"');
    expect(body).toContain("Never edit the Issue's line-1 status marker");
    // The driver invocation line belongs to the adapters now; the body the
    // engine passes carries it nowhere, so a prompt change cannot break a
    // harness that assembles its own invocation.
    expect(body).not.toContain("/implement");
  });

  it("re-reads AGENT.md at every spawn, so a mid-run edit reaches the next attempt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
      agentMd: "version one instructions",
    });
    const rig = stubHarness({});
    const harnesses = {
      stub: (ctx: SpawnContext) => {
        // 01's prompt is already built when its argv is assembled, so this
        // edit can only reach 02's spawn if AGENT.md is read fresh then.
        if (ctx.id === "01") {
          writeFileSync(join(poolDir, "AGENT.md"), "version two instructions");
        }
        return rig.harnesses.stub(ctx);
      },
    };

    await runPool({ poolDir, harnesses });

    expect(rig.spawned["01"].body).toContain("version one instructions");
    expect(rig.spawned["02"].body).toContain("version two instructions");
    expect(rig.spawned["02"].body).not.toContain("version one instructions");
  });

  it("spawns with stdin closed and writes a per-ticket log to runs/", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    await runPool({ poolDir, harnesses: rig.harnesses });

    const logText = await Bun.file(join(poolDir, "runs", "01.log")).text();
    expect(typeof logText).toBe("string");
  });
});

describe("harness CLIs", () => {
  // Fake CLI binaries on PATH exercise the real default harnesses: the
  // engine resolves the console.json harness name to a binary and launches
  // it in the shape run.sh proved. Each fake records its argv one argument
  // per file (argv.0, argv.1, ...) so assertions see exact strings, newline-
  // carrying prompts included. The fake learns where to write its outcome
  // JSON from an env var, never by parsing the prompt, so no test depends on
  // the prompt's format.

  interface FakeCli {
    binDir: string;
    recordDir: string;
  }

  function fakeCli(
    poolDir: string,
    binary: string,
    opts: { writeOutcome?: boolean; exitCode?: number } = {},
  ): FakeCli {
    const binDir = join(poolDir, "bin");
    const recordDir = join(poolDir, "record");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(binDir, binary),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'out="$FAKE_RECORD_DIR"',
        "i=0",
        'for a in "$@"; do printf \'%s\' "$a" > "$out/argv.$i"; i=$((i+1)); done',
        // Distinguish a closed stdin (instant EOF, what the engine sets up)
        // from an open one (the read would block until the timeout).
        "start=$SECONDS",
        "if read -t 2 _line; then stdin=data",
        "elif [ $((SECONDS - start)) -ge 2 ]; then stdin=open",
        "else stdin=eof; fi",
        'printf \'%s\' "$stdin" > "$out/stdin"',
        ...(opts.writeOutcome ?? true
          ? [
              'printf \'{"status":"done","summary":"fake","commitSha":null}\' > "$FAKE_OUTCOME_REL"',
            ]
          : []),
        `echo "fake ${binary} ran"`,
        `exit ${opts.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, binary), 0o755);
    return { binDir, recordDir };
  }

  function recordedArgs(recordDir: string): string[] {
    const args: string[] = [];
    for (let i = 0; ; i++) {
      const path = join(recordDir, `argv.${i}`);
      if (!existsSync(path)) break;
      args.push(readFileSync(path, "utf8"));
    }
    return args;
  }

  async function withFakePath(
    fake: FakeCli,
    fn: () => Promise<void>,
  ): Promise<void> {
    const originalPath = process.env.PATH;
    const originalRecord = process.env.FAKE_RECORD_DIR;
    const originalOutcome = process.env.FAKE_OUTCOME_REL;
    process.env.PATH = `${fake.binDir}:${originalPath}`;
    process.env.FAKE_RECORD_DIR = fake.recordDir;
    process.env.FAKE_OUTCOME_REL = "runs/01.outcome.json";
    try {
      await fn();
    } finally {
      process.env.PATH = originalPath;
      if (originalRecord === undefined) delete process.env.FAKE_RECORD_DIR;
      else process.env.FAKE_RECORD_DIR = originalRecord;
      if (originalOutcome === undefined) delete process.env.FAKE_OUTCOME_REL;
      else process.env.FAKE_OUTCOME_REL = originalOutcome;
    }
  }

  function oneTicketPool(
    harness: string,
    model: string,
    extra?: Partial<PoolConfig>,
  ): string {
    return makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: { defaults: { harness, model }, ...extra },
      agentMd: "# Runner agent instructions\n\nDo the thing.",
    });
  }

  it("spawns the console.json-assigned claude CLI with stdin closed and the unattended permission mode", async () => {
    const agents =
      '{"deepseek":{"description":"General-purpose subagent","prompt":"Do the reading.","model":"deepseek"}}';
    const poolDir = oneTicketPool("claude", "claude-test", { agents });
    const fake = fakeCli(poolDir, "claude");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(
      argv[1].startsWith(
        `/implement ${join(poolDir, "issues", "01-a.md")}\n`,
      ),
    ).toBe(true);
    expect(argv[1]).toContain("Standing instructions for this job:");
    expect(argv.slice(2)).toEqual([
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
      "--agents",
      agents,
      "--output-format",
      "text",
    ]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
    const logText = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(logText).toContain("fake claude ran");
  });

  it("drives opencode through --command with the bare driver name and the issue path leading the message", async () => {
    const poolDir = oneTicketPool("opencode", "opencode-test");
    const fake = fakeCli(poolDir, "opencode");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("--command");
    expect(argv[2]).toBe("implement");
    expect(
      argv[3].startsWith(`${join(poolDir, "issues", "01-a.md")}\n`),
    ).toBe(true);
    expect(argv[3]).toContain("Standing instructions for this job:");
    expect(argv[3]).not.toContain("/implement");
    expect(argv.slice(4)).toEqual(["--model", "opencode-test", "--auto"]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
  });

  it("launches cursor's agent CLI with the documented flags (unproven line, carried over from run.sh)", async () => {
    const poolDir = oneTicketPool("cursor", "cursor-test");
    const fake = fakeCli(poolDir, "agent");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(
      argv[1].startsWith(
        `/implement ${join(poolDir, "issues", "01-a.md")}\n`,
      ),
    ).toBe(true);
    expect(argv.slice(2)).toEqual([
      "--model",
      "cursor-test",
      "--force",
      "--trust",
      "--output-format",
      "text",
    ]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
  });

  it("drives status from the outcome JSON a spawned CLI writes, done or absent alike", async () => {
    const doneDir = oneTicketPool("claude", "claude-test");
    const doneFake = fakeCli(doneDir, "claude");
    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(doneFake, async () => {
      run = await approveReview(await runPool({ poolDir: doneDir }));
    });
    expect(run!.phase).toBe("done");
    expect(run!.final.tickets["01"]).toBe("done");
    // The fake never touched the Issue: the engine wrote the done marker
    // itself from the outcome.
    expect(markerLine(doneDir, "01-a.md")).toContain("status=done");

    const crashDir = oneTicketPool("claude", "claude-test");
    const crashFake = fakeCli(crashDir, "claude", {
      writeOutcome: false,
      exitCode: 1,
    });
    await withFakePath(crashFake, async () => {
      run = await runPool({ poolDir: crashDir });
    });
    expect(run!.phase).toBe("quiescent");
    expect(run!.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body: join(crashDir, "runs", "01.log"),
      },
    ]);
    expect(markerLine(crashDir, "01-a.md")).toContain("status=in-progress");
  });
});

describe("checkpoints", () => {
  it("writes a sqlite checkpoint to the pool directory after every super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq")
      .all() as { state: string }[];
    db.close();

    // Two super-step joins, the review gate, the quiescent final, the
    // approval's own persist (a processed answer persists its state change),
    // and the approval's done final.
    expect(rows.length).toBe(6);
    const first = JSON.parse(rows[0].state);
    const second = JSON.parse(rows[1].state);
    const approved = JSON.parse(rows[4].state);
    const terminal = JSON.parse(rows[5].state);
    expect(first.tickets).toEqual({ "01": "done", "02": "ready" });
    expect(second.tickets).toEqual({ "01": "done", "02": "done" });
    expect(second.outcomes["01"].summary).toBe("summary-01");
    expect(approved.interrupts).toEqual([]);
    expect(approved.reviewApproved).toBe(true);
    expect(terminal.log.at(-1)).toBe("pool done: every ticket reached done");
    expect(terminal.reviewApproved).toBe(true);
    expect(run.snapshots.at(-1)?.phase).toBe("done");
  });
});

describe("persist failures", () => {
  // The substitutable-store seam: a real sqlite store wrapped in one whose
  // write fails on demand. The wrapper counts every write attempt (failed or
  // not) and every close, so a test can see the retries and prove a persist
  // failure never closed the store.
  class FlakyStore implements CheckpointStore {
    writeAttempts = 0;
    closeCalls = 0;
    private inner: CheckpointStore;
    constructor(
      poolDir: string,
      public failWritesLeft: number,
    ) {
      this.inner = new SqliteCheckpointStore(poolDir);
    }
    write(state: unknown): void {
      this.writeAttempts += 1;
      if (this.failWritesLeft > 0) {
        this.failWritesLeft -= 1;
        throw new Error("db is down");
      }
      this.inner.write(state);
    }
    latest(): unknown | null {
      return this.inner.latest();
    }
    close(): void {
      this.closeCalls += 1;
      this.inner.close();
    }
  }

  function checkpointRows(poolDir: string): { state: string }[] {
    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq")
      .all() as { state: string }[];
    db.close();
    return rows;
  }

  it("retries a failed boundary persist and recovers: the next ticket is scheduled and the row lands", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    // The first write attempt throws; the retry lands the row and the run
    // carries on as if nothing happened.
    const store = new FlakyStore(poolDir, 1);

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses, store }),
    );

    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(run.phase).toBe("done");
    // Five healthy persists in a run to done (two boundaries, the review
    // gate, and two finals) plus the one failed boundary attempt that the
    // retry recovered.
    expect(store.writeAttempts).toBe(6);
    const rows = checkpointRows(poolDir);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].state).tickets).toEqual({
      "01": "done",
      "02": "ready",
    });
  });

  it("raises the persistence interrupt when the store keeps failing, and the store remains open", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    const store = new FlakyStore(poolDir, Infinity);

    const run = await runPool({ poolDir, harnesses: rig.harnesses, store });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    expect(run.interrupts[0].ticketId).toBe(PERSISTENCE_TICKET_ID);
    expect(run.interrupts[0].kind).toBe("persistence");
    expect(run.interrupts[0].body).toContain("persistence is failing");
    expect(run.interrupts[0].body).toContain("db is down");
    // Ticket 01 ran; the failing boundary stopped any further scheduling.
    expect(rig.spawnOrder).toEqual(["01"]);
    // Bounded retries, not a forever loop: the boundary persist and the
    // final settle each make four write attempts (1 + 3 backoff retries).
    expect(store.writeAttempts).toBe(8);
    // A persist failure never closes the checkpoint store.
    expect(store.closeCalls).toBe(0);
    expect(checkpointRows(poolDir)).toHaveLength(0);

    // Once the store is healthy again, answering the interrupt continues
    // the run: the next boundary write lands and the pool reaches Review.
    store.failWritesLeft = 0;
    const resumed = await run.resume(PERSISTENCE_TICKET_ID);
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(checkpointRows(poolDir).length).toBeGreaterThan(0);
  });

  it("resumes cleanly from disk after a restart when the store kept failing", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    const store = new FlakyStore(poolDir, Infinity);

    const first = await runPool({ poolDir, harnesses: rig.harnesses, store });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The markers were written before the store write failed, so disk says
    // 01 done: restart-from-disk is the escape hatch, and 01 never re-runs.
    expect(markerStatuses(poolDir, ["01-a.md", "02-b.md"])).toEqual({
      "01": "done",
      "02": "ready",
    });
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect((await approveReview(second)).phase).toBe("done");
  });
});

describe("interrupts", () => {
  it("raises a checkpoint interrupt carrying the Issue's Brief", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body:
            "# 01\n\n## Brief\n\n1. did the first half\n" +
            "2. human must pick a name\n\n## Notes\n\nunrelated",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": {
        status: "checkpoint",
        brief: "1. did the first half\n2. human must pick a name",
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "checkpoint",
        body: "1. did the first half\n2. human must pick a name",
      },
    ]);
    expect(run.final.tickets["01"]).toBe("checkpoint");
    expect(run.final.tickets["02"]).toBe("ready");
    expect(run.snapshots.at(-1)?.phase).toBe("quiescent");
    expect(run.snapshots.at(-1)?.state.interrupts).toHaveLength(1);
  });

  it("raises a crash interrupt carrying the log path when the attempt writes no outcome", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "keep", exitCode: 1 } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body: join(poolDir, "runs", "01.log"),
      },
    ]);
    expect(run.final.log.some((line) => line.includes("exited 1"))).toBe(true);
  });

  it("treats a marker rewritten to ready as a crash, not a respawn", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    // The harness exits having set its own marker back to ready and written
    // no outcome: a crash with extra steps. The agent-written marker is
    // ignored (the clean break), so this re-spawns nothing and reaches a
    // human.
    const rig = stubHarness({ "01": { status: "ready", exitCode: 0 } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body: join(poolDir, "runs", "01.log"),
      },
    ]);
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("raises deadlock interrupts for a blocked-by cycle without spawning", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "deadlock",
        body: "blockers can never complete: 02",
      },
      {
        ticketId: "02",
        kind: "deadlock",
        body: "blockers can never complete: 01",
      },
    ]);
  });

  it("keeps ready siblings running while a ticket is interrupted", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.log).toContain("super-step 1: 01, 02");
    expect(run.final.log).toContain("super-step 2: 03");
    expect(run.final.tickets).toEqual({
      "01": "checkpoint",
      "02": "done",
      "03": "done",
    });
    expect(run.interrupts).toHaveLength(1);
    expect(run.phase).toBe("quiescent");
  });

  it("resume-with-answer restarts the ticket and continues the pool", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "done"] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    const snapshotsBefore = run.snapshots.length;

    const resumed = await run.resume("01", "carry on with option two");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(rig.spawnOrder).toEqual(["01", "01", "02"]);
    expect(done.snapshots.length).toBeGreaterThan(snapshotsBefore);
    expect(done.final.log).toContain(
      "interrupt answered for 01 (checkpoint): resumed",
    );
    const markerLines = ["01-a.md", "02-b.md"].map(
      (file) =>
        readFileSync(join(poolDir, "issues", file), "utf8").split("\n")[0],
    );
    for (const line of markerLines) {
      expect(line).toContain("status=done");
    }
  });

  it("holds a dependent behind a checkpointed blocker without a deadlock, then schedules it after resume", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "done"], brief: "need a decision" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Only done satisfies the edge: 02 never spawns while 01 sits at
    // checkpoint, and a human-resumable pause is not a deadlock.
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(run.final.tickets).toEqual({ "01": "checkpoint", "02": "ready" });
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "need a decision" },
    ]);
    expect(run.phase).toBe("quiescent");

    const resumed = await run.resume("01", "carry on");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(rig.spawnOrder).toEqual(["01", "01", "02"]);
  });

  it("appends the resume note to the Issue file", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    await run.resume("01", "picked the name Foo");

    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("picked the name Foo");
  });

  it("rejects resuming a ticket with no pending interrupt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    await expect(run.resume("02")).rejects.toThrow(/no pending interrupt/);
  });

  it("resumes a deadlock after the pool files are fixed", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual([
      "deadlock",
      "deadlock",
    ]);

    writeFileSync(
      join(poolDir, "issues", "02-b.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n",
    );
    const resumed = await run.resume("02", "broke the cycle");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["02", "01"]);
  });

  it("distinguishes quiescent from done in emitted state", async () => {
    const stuckDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const stuck = await runPool({
      poolDir: stuckDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });

    const cleanDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const clean = await runPool({
      poolDir: cleanDir,
      harnesses: stubHarness({}).harnesses,
    });

    expect(stuck.phase).toBe("quiescent");
    expect(stuck.interrupts).toHaveLength(1);
    expect(stuck.snapshots.at(-1)?.phase).toBe("quiescent");
    // A clean run stops at the final Review interrupt; approving ends it.
    expect(clean.phase).toBe("quiescent");
    expect(clean.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const done = await approveReview(clean);
    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.snapshots.at(-1)?.phase).toBe("done");
  });

  it("raises a deadlock interrupt for a blocker id that does not exist", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=99 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "deadlock",
        body: "blockers can never complete: 99",
      },
    ]);
  });

  it("keeps a crashed ticket's interrupt pending across rehydration", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["keep", "done"] } });

    const first = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(first.interrupts[0]?.kind).toBe("crash");
    first.close();

    // The marker still reads in-progress, but the pending crash interrupt
    // means a human has not looked yet: rehydration must not silently
    // re-run the ticket.
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(second.phase).toBe("quiescent");
    expect(second.interrupts[0]?.kind).toBe("crash");
    expect(rig.spawnOrder).toEqual(["01"]);
    const resumed = await second.resume("01");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
  });

  it("resumes a crash interrupt by re-running the ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["keep", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts[0]?.kind).toBe("crash");

    const resumed = await run.resume("01");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(done.final.log).toContain(
      "interrupt answered for 01 (crash): resumed",
    );
  });
});

describe("outcome contract", () => {
  // The agent's only result channel is the outcome JSON (ADR-0005); the
  // engine owns the marker. These tests assert externally visible behavior
  // only: the marker on disk, the ticket-log events, and the interrupt.

  const oneTicket = (): string =>
    makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

  function readEvents(poolDir: string, id: string) {
    return readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
  }

  it("writes the done marker itself when the outcome says done", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The stub never touched the Issue; the done on disk is the engine's
    // write from the outcome JSON.
    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
  });

  it("records a crash when the agent writes no outcome", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "keep" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "no outcome written",
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("never honors a stale outcome a previous attempt left behind", async () => {
    const poolDir = oneTicket();
    // Attempt 1 checkpoints with a valid outcome; the resume re-runs the
    // ticket and attempt 2 exits 0 writing nothing. The spawn-side delete
    // means the stale checkpoint file is gone, so this is a crash, not a
    // re-raised checkpoint carrying the old brief.
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "keep"], brief: "pick a name" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts[0]?.kind).toBe("checkpoint");

    const resumed = await run.resume("01", "go with the first");

    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "no outcome written",
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("records a crash when the outcome is not parseable", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { outcomeRaw: "not json" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "outcome is not parseable JSON",
    });
  });

  it("records a crash when the outcome's status is invalid", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({
      "01": { outcomeRaw: '{"status":"dnoe","summary":"x","commitSha":null}' },
    });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "outcome's status is not done or checkpoint",
    });
  });

  it("records a crash for a valid done outcome with a non-zero exit", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "done", exitCode: 1 } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 1,
      reason: "harness exited 1",
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("ignores a done marker the agent wrote directly and never re-spawns", async () => {
    const poolDir = oneTicket();
    // The old protocol's slip: the agent seds the marker to done but writes
    // no outcome. The clean break ignores the marker, records the crash, and
    // corrects the marker back to in-progress.
    const rig = stubHarness({ "01": { status: "marker-done" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("writes the checkpoint marker itself when the outcome says checkpoint", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({
      "01": { status: "checkpoint", brief: "pick a name" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The stub never touched the Issue; the checkpoint on disk is the
    // engine's write from the outcome JSON, and the interrupt was raised.
    expect(run.phase).toBe("quiescent");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=checkpoint");
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    const kinds = readEvents(poolDir, "01").map((e) => e.kind);
    expect(kinds).toEqual(["scheduled", "spawned", "exited", "checkpoint"]);
    expect(readEvents(poolDir, "01")[2]?.payload).toEqual({
      code: 0,
      status: "checkpoint",
    });
  });

  it("appends the outcome's brief as the Issue's Brief section, replacing a stale one", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nstale brief from an earlier attempt",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { status: "checkpoint", brief: "fresh brief" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The interrupt's body comes from the section the engine just landed,
    // never from a Brief an earlier attempt left behind.
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "fresh brief" },
    ]);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief\n\nfresh brief");
    expect(issueText).not.toContain("stale brief from an earlier attempt");
    expect(
      issueText.split("\n").filter((line) => line.startsWith("## Brief")),
    ).toHaveLength(1);
  });

  it("lands a placeholder Brief section when a checkpoint outcome has no brief", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The pause was signalled, so it is not a crash: the interrupt stands
    // and its body is the engine's placeholder.
    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("wrote no brief");
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief, written by the engine");
  });

  it("replaces a stale Brief with the placeholder when a later checkpoint has no brief", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nstale brief from an earlier attempt",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The Brief section always mirrors the latest attempt: a stale brief
    // never masquerades as the current one.
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("wrote no brief");
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).not.toContain("stale brief from an earlier attempt");
    expect(
      issueText.split("\n").filter((line) => line.startsWith("## Brief")),
    ).toHaveLength(1);
  });

  it("re-raises the checkpoint interrupt from the engine-written Brief after a restart", async () => {
    const poolDir = oneTicket();
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({
        "01": { status: "checkpoint", brief: "pick a name" },
      }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // Killed before the boundary persist: no stored checkpoint survives,
    // but the marker and the Brief the engine landed are on disk, so
    // rehydration re-raises the interrupt from the Issue unchanged.
    rmSync(join(poolDir, "console.db"), { force: true });
    const rig = stubHarness({});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(second.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(second.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
  });
});

describe("final review", () => {
  it("raises exactly one Review interrupt when every ticket is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts).toHaveLength(1);
    const review = run.interrupts[0];
    expect(review.ticketId).toBe(REVIEW_TICKET_ID);
    expect(review.kind).toBe("review");
    expect(review.body).toContain("every ticket is done");
    expect(review.body).toContain("- 01: summary-01");
    expect(review.body).toContain("- 02: summary-02");
    expect(run.final.log.at(-1)).toBe(
      "pool quiescent: interrupts pending for REVIEW",
    );
  });

  it("approve ends the run, and a restart comes up done without re-asking", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });
    const done = await run.approve(REVIEW_TICKET_ID, "looks right");

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.final.log).toContain(
      "review approved: the run is complete (looks right)",
    );
    expect(done.final.log.at(-1)).toBe("pool done: every ticket reached done");

    const rig = stubHarness({});
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(restarted.phase).toBe("done");
    expect(restarted.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual([]);
  });

  it("reject sends the named tickets and their downstream back to ready, and the run re-reviews", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
        {
          file: "04-d.md",
          marker: "<!-- state: id=04 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    const rejected = await run.reject(
      REVIEW_TICKET_ID,
      "redo 02: the parser is wrong",
    );

    // 02 went back to ready with the note on its Issue; its downstream 03
    // was invalidated with it (no note); 01 and 04 were left alone. The pool
    // re-ran both and stopped at a fresh Review.
    expect(rig.spawnOrder).toEqual(["01", "04", "02", "03", "02", "03"]);
    expect(rejected.phase).toBe("quiescent");
    expect(rejected.interrupts).toHaveLength(1);
    expect(rejected.interrupts[0].kind).toBe("review");
    expect(rejected.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
      "04": "done",
    });
    expect(rejected.final.log).toContain(
      "review rejected: 02 back to ready; downstream 03 also reset",
    );
    const issue02 = readFileSync(join(poolDir, "issues", "02-b.md"), "utf8");
    expect(issue02).toContain("## Review note");
    expect(issue02).toContain("redo 02: the parser is wrong");
    const issue03 = readFileSync(join(poolDir, "issues", "03-c.md"), "utf8");
    expect(issue03).not.toContain("## Review note");

    const done = await approveReview(rejected);
    expect(done.phase).toBe("done");
  });

  it("reject without a named ticket throws and keeps the gate up", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });

    await expect(
      run.reject(REVIEW_TICKET_ID, "this is not good enough"),
    ).rejects.toThrow(/name at least one ticket/);
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    // The reject failed at acceptance, so nothing was recorded: no answered
    // event in the log and no queued-answer record on disk. Before the
    // acceptance-time check both were written and the failure surfaced only
    // at processing, where no waiter was listening.
    const reviewEvents = join(poolDir, "runs", `${REVIEW_TICKET_ID}.events.jsonl`);
    if (existsSync(reviewEvents)) {
      const kinds = readFileSync(reviewEvents, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).not.toContain("answered");
    }
    expect(existsSync(join(poolDir, "runs", "queued-answers.json"))).toBe(false);

    const done = await approveReview(run);
    expect(done.phase).toBe("done");
  });

  it("refuses a plain resume on the review gate", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });

    await expect(run.resume(REVIEW_TICKET_ID)).rejects.toThrow(
      /use approve\(\) or reject\(\)/,
    );
  });

  it("an approve over a marker a human reset on disk continues to a fresh review", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    // run.sh reset the ticket behind the engine's back; the marker is the
    // truth, so the approval cannot close the run over work now unfinished.
    setMarker(poolDir, "01-a.md", "ready");
    const continued = await run.approve(REVIEW_TICKET_ID);

    expect(continued.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(continued.final.log).toContain(
      "review approved, but markers on disk are not all done: the run " +
        "continues to a fresh review",
    );
    expect(continued.interrupts.map((i) => i.kind)).toEqual(["review"]);

    const done = await approveReview(continued);
    expect(done.phase).toBe("done");
  });

  it("holds the gate while another interrupt is pending", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);

    const resumed = await run.resume("01");
    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
  });
});

function markerLine(poolDir: string, file: string): string {
  return readFileSync(join(poolDir, "issues", file), "utf8").split("\n")[0];
}

function markerStatuses(poolDir: string, files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [
      file.slice(0, 2),
      /status=([a-z-]+)/.exec(markerLine(poolDir, file))?.[1] ?? "",
    ]),
  );
}

function setMarker(poolDir: string, file: string, status: string): void {
  const path = join(poolDir, "issues", file);
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  lines[0] = lines[0].replace(/status=[a-z-]+/, `status=${status}`);
  writeFileSync(path, lines.join("\n"));
}

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor: timed out");
}

describe("durability", () => {
  it("keeps the line-1 markers in agreement with every emitted snapshot", async () => {
    const files = ["01-a.md", "02-b.md"];
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });
    const disagreements: string[] = [];

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      onSnapshot: (snapshot) => {
        const markers = markerStatuses(poolDir, files);
        for (const [id, status] of Object.entries(snapshot.state.tickets)) {
          if (markers[id] !== status) {
            disagreements.push(
              `seq ${snapshot.seq}: state says ${id}=${status}, marker says ${markers[id]}`,
            );
          }
        }
      },
    });

    expect(disagreements).toEqual([]);
    expect(run.phase).toBe("quiescent");
    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const row = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .get() as { state: string };
    db.close();
    expect(JSON.parse(row.state).tickets).toEqual(
      markerStatuses(poolDir, files),
    );
    run.close();
  });

  it("re-runs a ticket whose marker was reset to ready after the checkpoint said done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await approveReview(
      await runPool({
        poolDir,
        harnesses: stubHarness({}).harnesses,
      }),
    );
    expect(first.phase).toBe("done");

    // run.sh reset 02: the marker on disk is the truth, the checkpoint's
    // done is stale, and the earlier review approval lapses with it.
    setMarker(poolDir, "02-b.md", "ready");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02"]);
  });

  it("clears a stored interrupt whose ticket the marker says is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The human finished 01 by hand. The marker wins over the stored
    // checkpoint interrupt.
    setMarker(poolDir, "01-a.md", "done");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(second.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["02"]);
    expect(second.final.log).toContain(
      "interrupt cleared for 01 (checkpoint): marker says done",
    );
  });

  it("resets an in-progress marker to ready: the agent holding it died with the process", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=in-progress -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(
      run.final.log.some((line) =>
        line.includes("back to ready"),
      ),
    ).toBe(true);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief, written by the engine");
    expect(issueText).toContain("back to ready");
  });

  it("clears a stored interrupt whose marker a human reset to ready", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // run.sh reset 01: the human answered on disk. The stored interrupt
    // must not linger into the next engine run.
    setMarker(poolDir, "01-a.md", "ready");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(second.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(second.final.log).toContain(
      "interrupt cleared for 01 (checkpoint): marker says ready",
    );
  });

  it("restores a pending interrupt across a restart and keeps it answerable", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({
        "01": { status: "checkpoint", brief: "pick a name" },
      }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    expect(first.final.tickets["03"]).toBe("done");
    first.close();

    const rig = stubHarness({ "01": { status: "done" } });
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(second.phase).toBe("quiescent");
    expect(second.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    expect(rig.spawnOrder).toEqual([]);

    const resumed = await second.resume("01", "the name is Foo");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
  });

  it("resumes a killed engine mid-super-step without re-running done tickets", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    writeFileSync(
      join(poolDir, "agent.sh"),
      [
        "#!/usr/bin/env bash",
        'issue="$1"; id="$2"; outcome_path="$3"',
        'if [ "$id" = "01" ]; then',
        '  printf \'%s\' \'{"status":"done","summary":"recovered-01","commitSha":"sha-01"}\' > "$outcome_path"',
        "  exit 0",
        "fi",
        "sleep 60",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(poolDir, "fixture.ts"),
      [
        "const [enginePath, poolDir] = process.argv.slice(2);",
        "const { runPool } = await import(enginePath);",
        "const harnesses = {",
        "  stub: (ctx: { issuePath: string; id: string; outcomePath: string }) => [",
        '    "bash",',
        "    `${poolDir}/agent.sh`,",
        "    ctx.issuePath,",
        "    ctx.id,",
        "    ctx.outcomePath,",
        "  ],",
        "};",
        "await runPool({ poolDir, harnesses });",
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      ["bun", join(poolDir, "fixture.ts"), join(import.meta.dir, "engine.ts"), poolDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitFor(
        () =>
          markerLine(poolDir, "01-a.md").includes("status=done") &&
          markerLine(poolDir, "02-b.md").includes("status=in-progress"),
      );
    } finally {
      proc.kill();
      await proc.exited;
    }

    const rig = stubHarness({});
    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02"]);
    expect(
      run.final.log.some(
        (line) => line.includes("02") && line.includes("back to ready"),
      ),
    ).toBe(true);
    // 01 finished before the kill but no checkpoint landed; its outcome
    // file on disk still wins over the (absent) checkpoint.
    expect(run.final.outcomes["01"]).toEqual({
      status: "done",
      summary: "recovered-01",
      commitSha: "sha-01",
    });
  });

  it("picks up a pool run.sh halted: a checkpoint marker becomes an answerable interrupt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=done -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=checkpoint -->",
          body: "# 02\n\n## Brief\n\nrun.sh stopped here",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const first = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(first.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(first.interrupts).toEqual([
      { ticketId: "02", kind: "checkpoint", body: "run.sh stopped here" },
    ]);

    const resumed = await first.resume("02");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02", "03"]);
  });

  it("stays inspectable and continuable by run.sh after a part-run", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const engine = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(engine.phase).toBe("quiescent");
    engine.close();

    const homeDir = join(poolDir, "home");
    const binDir = join(poolDir, "bin");
    mkdirSync(homeDir);
    mkdirSync(binDir);
    writeFileSync(
      join(homeDir, ".issue-runner"),
      "harness=claude\nmodel=stub-model\n",
    );
    writeFileSync(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        'prompt=""',
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    -p) prompt="$2"; shift 2 ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'rel="$(printf \'%s\' "$prompt" | head -1 | sed \'s|^/[^ ]* ||\')"',
        'sed -i "1s/status=[a-z-]*/status=done/" "$rel"',
        'echo "fake claude worked $rel"',
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "claude"), 0o755);
    writeFileSync(
      join(poolDir, "run.sh"),
      readFileSync(
        join(import.meta.dir, "..", ".scratch", "console-pool", "run.sh"),
        "utf8",
      ),
    );
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
    };
    Bun.spawnSync(["git", "init"], { cwd: poolDir, stdout: "ignore", stderr: "ignore" });

    const status = Bun.spawnSync(["bash", "run.sh", "status"], {
      cwd: poolDir,
      env,
    });
    const board = status.stdout.toString();
    expect(status.exitCode).toBe(0);
    expect(board).toMatch(/01\s+checkpoint/);
    expect(board).toMatch(/02\s+ready/);
    expect(board).toMatch(/03\s+done/);

    const reset = Bun.spawnSync(["bash", "run.sh", "reset", "01"], {
      cwd: poolDir,
      env,
    });
    expect(reset.exitCode).toBe(0);

    const continued = Bun.spawnSync(["bash", "run.sh"], {
      cwd: poolDir,
      env,
    });
    const output = continued.stdout.toString();
    expect(continued.exitCode).toBe(0);
    expect(output).toContain("fake claude worked issues/01-a.md");
    expect(output).toContain("fake claude worked issues/02-b.md");
    expect(output).not.toContain("fake claude worked issues/03-c.md");
    expect(markerStatuses(poolDir, ["01-a.md", "02-b.md", "03-c.md"])).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
  });
});

// Worktree tests run the same public seam against pools that are real git
// repos (the pool dir is the repo root). The git stub harness is a bash
// script driven by a per-spawn plan file, so each ticket can do real work in
// its checkout: write and commit files, wait on siblings, and record what it
// observed (HEAD, branch, cwd) for the assertions.
describe("worktrees", () => {
  interface GitStubBehaviour {
    status?: "done" | "checkpoint" | "keep";
    outcome?: { summary: string; commitSha: string | null } | null;
    exitCode?: number;
    workFile?: string;
    workLine?: string;
    overwrite?: boolean;
    commitMsg?: string;
    leaveFile?: string;
    touch?: string;
    waitFor?: string;
    waitMerged?: string;
    recordDir?: string;
    expectFile?: string;
  }

  interface GitPool {
    poolDir: string;
    head: string;
    git: (args: string[]) => { exitCode: number; stdout: Buffer; stderr: Buffer };
  }

  function makeGitPool(
    spec: PoolSpec,
    seed: Record<string, string> = {},
  ): GitPool {
    const poolDir = makePool(spec);
    for (const [path, content] of Object.entries(seed)) {
      writeFileSync(join(poolDir, path), content);
    }
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], {
        cwd: poolDir,
        stdout: "pipe",
        stderr: "pipe",
      });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "pool@test"]);
    git(["config", "user.name", "pool"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    const head = git(["rev-parse", "HEAD"]).stdout.toString().trim();
    return { poolDir, head, git };
  }

  function gitStubHarness(
    poolDir: string,
    behaviour: Record<string, GitStubBehaviour | GitStubBehaviour[]>,
  ): StubRig {
    const stubPath = join(poolDir, "git-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'issue="$1"; status="$2"; outcome_path="$3"; outcome_json="$4"; exit_code="$5"; plan="$6"',
        'WORK_FILE=""; WORK_LINE=""; OVERWRITE=""; COMMIT_MSG=""',
        'LEAVE_FILE=""; TOUCH=""; WAIT_FOR=""; WAIT_MERGED=""; MAIN_REPO=""; RECORD_DIR=""; EXPECT_FILE=""',
        'source "$plan"',
        'if [ -n "$TOUCH" ]; then touch "$TOUCH"; fi',
        'if [ -n "$WAIT_FOR" ]; then',
        "  for _ in $(seq 1 100); do",
        '    [ -e "$WAIT_FOR" ] && break',
        "    sleep 0.05",
        "  done",
        '  [ -e "$WAIT_FOR" ] || exit 42',
        "fi",
        'if [ -n "$WAIT_MERGED" ]; then',
        "  for _ in $(seq 1 100); do",
        '    log="$(git -C "$MAIN_REPO" log --format=%s 2>/dev/null)"',
        '    case "$log" in *"$WAIT_MERGED"*) break;; esac',
        "    sleep 0.05",
        "  done",
        '  log="$(git -C "$MAIN_REPO" log --format=%s 2>/dev/null)"',
        '  case "$log" in *"$WAIT_MERGED"*) ;; *) exit 42;; esac',
        "fi",
        'if [ -n "$EXPECT_FILE" ] && [ ! -e "$EXPECT_FILE" ]; then exit 43; fi',
        'if [ -n "$RECORD_DIR" ]; then',
        '  mkdir -p "$RECORD_DIR"',
        '  git rev-parse HEAD > "$RECORD_DIR/head"',
        '  git branch --show-current > "$RECORD_DIR/branch"',
        '  pwd > "$RECORD_DIR/cwd"',
        "fi",
        "staged=0",
        'if [ -n "$WORK_FILE" ]; then',
        '  mkdir -p "$(dirname "$WORK_FILE")"',
        '  if [ -n "$OVERWRITE" ]; then printf \'%s\\n\' "${WORK_LINE:-work}" > "$WORK_FILE"',
        '  else printf \'%s\\n\' "${WORK_LINE:-work}" >> "$WORK_FILE"; fi',
        '  git add "$WORK_FILE"; staged=1',
        "fi",
        'if [ -n "$LEAVE_FILE" ]; then printf "partial\\n" > "$LEAVE_FILE"; fi',
        'if [ "$staged" = "1" ]; then git commit -qm "${COMMIT_MSG:-ticket}"; fi',
        // The outcome JSON is the ending signal (ADR-0005): the stub writes
        // it to the outcome path the engine handed over, and the engine
        // writes the canonical Issue's marker itself.
        'if [ -n "$outcome_json" ]; then printf \'%s\' "$outcome_json" > "$outcome_path"; fi',
        'exit "$exit_code"',
        "",
      ].join("\n"),
    );
    const spawned: Record<string, SpawnContext> = {};
    const spawnOrder: string[] = [];
    const spawnCounts: Record<string, number> = {};
    const stub: HarnessCommand = (ctx) => {
      spawned[ctx.id] = ctx;
      spawnOrder.push(ctx.id);
      const n = spawnCounts[ctx.id] ?? 0;
      spawnCounts[ctx.id] = n + 1;
      const entry = behaviour[ctx.id] ?? {};
      const b = Array.isArray(entry)
        ? entry[Math.min(n, entry.length - 1)]
        : entry;
      const status = b.status ?? "done";
      const outcome =
        b.outcome === null || status === "keep"
          ? ""
          : JSON.stringify({
              status,
              ...(b.outcome ?? {
                summary: `summary-${ctx.id}`,
                commitSha: `sha-${ctx.id}`,
              }),
            });
      const planPath = join(poolDir, `plan-${ctx.id}-${n}.sh`);
      const quote = (value: string) => JSON.stringify(value);
      const lines = [`MAIN_REPO=${quote(poolDir)}`];
      if (b.workFile) lines.push(`WORK_FILE=${quote(b.workFile)}`);
      if (b.workLine) lines.push(`WORK_LINE=${quote(b.workLine)}`);
      if (b.overwrite) lines.push('OVERWRITE="1"');
      if (b.commitMsg) lines.push(`COMMIT_MSG=${quote(b.commitMsg)}`);
      if (b.leaveFile) lines.push(`LEAVE_FILE=${quote(b.leaveFile)}`);
      if (b.touch) lines.push(`TOUCH=${quote(b.touch)}`);
      if (b.waitFor) lines.push(`WAIT_FOR=${quote(b.waitFor)}`);
      if (b.waitMerged) lines.push(`WAIT_MERGED=${quote(b.waitMerged)}`);
      if (b.recordDir) lines.push(`RECORD_DIR=${quote(b.recordDir)}`);
      if (b.expectFile) lines.push(`EXPECT_FILE=${quote(b.expectFile)}`);
      writeFileSync(planPath, lines.join("\n") + "\n");
      return [
        "bash",
        stubPath,
        ctx.issuePath,
        status,
        ctx.outcomePath,
        outcome,
        String(b.exitCode ?? 0),
        planPath,
      ];
    };
    return { harnesses: { stub }, spawned, spawnOrder };
  }

  const readyTicket = (id: string, blockedBy = "none") => ({
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
  });

  it("runs a multi-ticket super-step concurrently, each in its own worktree branched from the same HEAD", async () => {
    const { poolDir, head, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "one.txt",
        commitMsg: "work-01",
        touch: join(poolDir, "started-01"),
        waitFor: join(poolDir, "started-02"),
        recordDir: join(poolDir, "rec-01"),
      },
      "02": {
        workFile: "two.txt",
        commitMsg: "work-02",
        touch: join(poolDir, "started-02"),
        waitFor: join(poolDir, "started-01"),
        recordDir: join(poolDir, "rec-02"),
      },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The rendezvous only passes if both tickets are alive at once; a serial
    // engine would time the wait out and crash both tickets.
    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    for (const id of ["01", "02"]) {
      const rec = join(poolDir, `rec-${id}`);
      expect(readFileSync(join(rec, "head"), "utf8").trim()).toBe(head);
      expect(readFileSync(join(rec, "branch"), "utf8").trim()).toBe(
        `pool/${id}`,
      );
      expect(readFileSync(join(rec, "cwd"), "utf8").trim()).toBe(
        join(poolDir, ".git", "pool-worktrees", id),
      );
    }
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "two.txt"))).toBe(true);
    const subjects = git(["log", "--format=%s"]).stdout.toString();
    expect(subjects).toContain("work-01");
    expect(subjects).toContain("work-02");
    // Clean merges clean up after themselves: one worktree (the main
    // checkout), no pool branches left.
    const worktrees = git(["worktree", "list", "--porcelain"])
      .stdout.toString()
      .match(/^worktree /gm);
    expect(worktrees).toHaveLength(1);
    expect(
      git(["branch", "--list", "pool/*"]).stdout.toString().trim(),
    ).toBe("");
  }, 15000);

  // A fake opencode binary on PATH records the PWD the engine passed it.
  // The real opencode CLI is a Bun binary and bun hands the inherited
  // environment through verbatim; a shell fake would sanitize $PWD back to
  // the true cwd and hide the bug this guards against.
  function opencodePwdFake(poolDir: string): { binDir: string; recordDir: string } {
    const binDir = join(poolDir, "bin");
    const recordDir = join(poolDir, "rec");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "opencode"),
      [
        "#!/usr/bin/env bun",
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { dirname, join, resolve } from "node:path";',
        'const commandArgs = process.argv[process.argv.indexOf("--command") + 2];',
        'const issueRef = commandArgs.split("\\n")[0];',
        'const id = issueRef.split("/").at(-1)!.split("-")[0];',
        // The prompt names the canonical Issue file by its absolute
        // main-checkout path; the outcome file sits beside it under runs/.
        'const issue = resolve(process.cwd(), issueRef);',
        'const outcome = join(dirname(dirname(issue)), "runs", `${id}.outcome.json`);',
        'const recordDir = process.env.PWD_RECORD_DIR;',
        'mkdirSync(recordDir, { recursive: true });',
        'writeFileSync(join(recordDir, `pwd.${id}`), process.env.PWD ?? "");',
        'writeFileSync(outcome, JSON.stringify({ status: "done", summary: "fake", commitSha: null }));',
        "console.log(`fake opencode ran in ${process.env.PWD}`);",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "opencode"), 0o755);
    return { binDir, recordDir };
  }

  it("spawns with PWD set to the worktree cwd so opencode roots in the worktree, not the server's checkout", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: { defaults: { harness: "opencode", model: "opencode-test" } },
    });
    const fake = opencodePwdFake(poolDir);
    const originalPath = process.env.PATH;
    const originalRecord = process.env.PWD_RECORD_DIR;
    process.env.PATH = `${fake.binDir}:${originalPath}`;
    process.env.PWD_RECORD_DIR = fake.recordDir;

    let run: Awaited<ReturnType<typeof runPool>>;
    try {
      run = await approveReview(await runPool({ poolDir }));
    } finally {
      process.env.PATH = originalPath;
      if (originalRecord === undefined) delete process.env.PWD_RECORD_DIR;
      else process.env.PWD_RECORD_DIR = originalRecord;
    }

    expect(run!.phase).toBe("done");
    for (const id of ["01", "02"]) {
      // The tickets ran in worktrees; the child must see the worktree as
      // PWD, not the server's checkout (where the test process lives).
      expect(readFileSync(join(fake.recordDir, `pwd.${id}`), "utf8")).toBe(
        join(poolDir, ".git", "pool-worktrees", id),
      );
      expect(readFileSync(join(fake.recordDir, `pwd.${id}`), "utf8")).not.toBe(
        process.env.PWD,
      );
    }
  }, 15000);

  it("hands the agent the canonical main-checkout Issue path and recognises its done, merging the attempt", async () => {
    // The old contract's false crash is deleted: the attempt signals done
    // through its outcome JSON and the engine writes the canonical Issue's
    // marker itself, so a worktree-relative slip by the agent can no longer
    // strand the status and skip the merge.
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "one.txt", commitMsg: "work-01" },
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts).toEqual([]);
    for (const id of ["01", "02"]) {
      // The spawn context names the canonical Issue file: the absolute
      // main-checkout path, not the worktree's context-only seed copy.
      expect(rig.spawned[id].issuePath).toBe(
        join(poolDir, "issues", `${id}-t.md`),
      );
      expect(rig.spawned[id].cwd).toBe(
        join(poolDir, ".git", "pool-worktrees", id),
      );
      // The engine wrote the marker on exactly that file: done on disk.
      expect(markerLine(poolDir, `${id}-t.md`)).toContain("status=done");
      // And the merge was not skipped: the branch landed on the working
      // branch and the ticket log records it.
      const events = readFileSync(
        join(poolDir, "runs", `${id}.events.jsonl`),
        "utf8",
      );
      expect(events).toContain('"kind":"merged"');
    }
    const subjects = git(["log", "--format=%s"]).stdout.toString();
    expect(subjects).toContain("work-01");
    expect(subjects).toContain("work-02");
  }, 15000);

  it("merges finished branches in completion order and never rebases a running ticket", async () => {
    const { poolDir, head, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      // 01 stays alive until 02's merge has landed on the working branch.
      "01": {
        workFile: "one.txt",
        commitMsg: "work-01",
        waitMerged: "work-02",
        recordDir: join(poolDir, "rec-01"),
      },
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // 01's branch was never rebased: it still sits on the super-step's
    // starting HEAD, observed after 02's merge had already landed.
    expect(readFileSync(join(poolDir, "rec-01", "head"), "utf8").trim()).toBe(
      head,
    );
    const commits = git(["log", "--format=%H %s"])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
    const bySubject = (subject: string) =>
      commits.find((c) => c.subject === subject)!.sha;
    // Completion order: 02 finished first and fast-forwarded; 01's merge
    // commit has 02's commit as its first parent and 01's as its second.
    const merge = commits.find((c) => c.subject.startsWith("Merge branch"))!;
    const parents = git(["rev-list", "--parents", "-n", "1", merge.sha])
      .stdout.toString()
      .trim()
      .split(" ")
      .slice(1);
    expect(parents).toEqual([bySubject("work-02"), bySubject("work-01")]);
    // And 01's own commit still hangs off the shared starting snapshot.
    const baseOf01 = git(["rev-list", "--parents", "-n", "1", bySubject("work-01")])
      .stdout.toString()
      .trim()
      .split(" ")[1];
    expect(baseOf01).toBe(head);
  }, 15000);

  it("raises a merge-conflict interrupt on a clashing merge without stalling unrelated tickets", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03")],
        config: noResolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.ticketId).toBe("02");
    expect(interrupt.kind).toBe("merge-conflict");
    expect(interrupt.body).toContain("shared.txt");
    expect(interrupt.body).toContain("pool/02");
    // The working branch was left clean: no half-merged state, 01's content
    // in place, 03 merged past the conflict, 02's branch parked for a human.
    expect(
      git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode,
    ).not.toBe(0);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("from-01\n");
    expect(existsSync(join(poolDir, "three.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", "pool/02"]).exitCode).toBe(0);
    expect(
      existsSync(join(poolDir, ".git", "pool-worktrees", "02")),
    ).toBe(true);

    // The human resolves by hand in the main checkout, then resumes.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", "pool/02"]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "resolved\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02"]);

    const resumed = await run.resume("02");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(git(["rev-parse", "--verify", "pool/02"]).exitCode).not.toBe(0);
    expect(
      existsSync(join(poolDir, ".git", "pool-worktrees", "02")),
    ).toBe(false);
  }, 15000);

  it("passes a blocker's outcome downstream even when its merge conflicted", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [
          readyTicket("01"),
          readyTicket("02"),
          readyTicket("03", "02"),
        ],
        config: noResolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
        outcome: { summary: "schema v2", commitSha: "sha-02" },
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("merge-conflict");
    // 02 is done (its merge is machinery), so 03 ran in the next super-step
    // with 02's outcome in its prompt, against a HEAD the merge never
    // reached. The outcomes channel, not the merge, carries state downstream.
    expect(rig.spawnOrder).toContain("03");
    expect(rig.spawned["03"].body).toContain("02: schema v2");
    expect(run.final.tickets["03"]).toBe("done");
    expect(rig.spawned["03"].cwd).toBe(poolDir);
  }, 15000);

  it("keeps a checkpointed ticket's worktree parked and reuses it on resume", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { status: "checkpoint", workFile: "one.txt", commitMsg: "work-01", leaveFile: "partial.txt" },
        { status: "done", workFile: "one-more.txt", commitMsg: "work-01b", expectFile: "partial.txt" },
      ],
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "checkpoint",
        body:
          "The agent signalled a checkpoint but wrote no brief, so what " +
          "the attempt completed is only in the ticket log. Answer the " +
          "interrupt to point the next attempt.",
      },
    ]);
    // The checkpoint parked 01's worktree with its partial work; 02 merged
    // and cleaned up.
    expect(existsSync(join(poolDir, ".git", "pool-worktrees", "01"))).toBe(
      true,
    );
    expect(git(["rev-parse", "--verify", "pool/01"]).exitCode).toBe(0);
    expect(existsSync(join(poolDir, ".git", "pool-worktrees", "02"))).toBe(
      false,
    );

    const resumed = await run.resume("01", "carry on");
    const done = await approveReview(resumed);

    // The second spawn asserts partial.txt is present (exit 43 otherwise),
    // which only holds in the parked worktree.
    expect(done.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02", "01"]);
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "one-more.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", "pool/01"]).exitCode).not.toBe(0);
    const issueText = readFileSync(join(poolDir, "issues", "01-t.md"), "utf8");
    expect(issueText).toContain("status=done");
    expect(issueText).toContain("carry on");
  }, 15000);

  it("runs a single-ticket super-step in the main checkout without a worktree", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "one.txt", commitMsg: "work-01", recordDir: join(poolDir, "rec-01") },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(readFileSync(join(poolDir, "rec-01", "cwd"), "utf8").trim()).toBe(
      poolDir,
    );
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(
      git(["branch", "--list", "pool/*"]).stdout.toString().trim(),
    ).toBe("");
  }, 15000);

  describe("resolver agent", () => {
  interface ResolverBehaviour {
    resolved?: boolean;
    note?: string;
    exitCode?: number;
    conflictFile?: string;
    resolution?: string;
    recordDir?: string;
  }

  function resolverStub(
    poolDir: string,
    behaviour: Record<string, ResolverBehaviour>,
  ): {
    harnesses: Record<string, HarnessCommand>;
    spawned: Record<string, SpawnContext>;
    spawnOrder: string[];
  } {
    const stubPath = join(poolDir, "resolver-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome="$1"; plan="$2"; worktree="$3"',
        'source "$plan"',
        ': "${CONFLICT_FILE:=}" "${RESOLUTION:=}" "${RECORD_DIR:=}"',
        'git -C "$worktree" merge "$WORKING_BRANCH" >/dev/null 2>&1 || true',
        'if [ "$RESOLVED" = "1" ]; then',
        '  if [ -n "$CONFLICT_FILE" ]; then',
        '    printf \'%s\\n\' "$RESOLUTION" > "$worktree/$CONFLICT_FILE"',
        '    git -C "$worktree" add "$CONFLICT_FILE"',
        "  fi",
        '  printf \'{"resolved": true, "note": "%s"}\' "$NOTE" > "$outcome"',
        "else",
        '  printf \'{"resolved": false, "note": "%s"}\' "$NOTE" > "$outcome"',
        "fi",
        'if [ -n "$RECORD_DIR" ]; then',
        '  mkdir -p "$RECORD_DIR"',
        '  git -C "$worktree" branch --show-current > "$RECORD_DIR/branch"',
        '  git -C "$worktree" rev-parse --verify MERGE_HEAD > "$RECORD_DIR/mergehead" 2>/dev/null || true',
        "fi",
        'exit "$EXIT"',
        "",
      ].join("\n"),
    );
    const spawned: Record<string, SpawnContext> = {};
    const spawnOrder: string[] = [];
    const stub: HarnessCommand = (ctx) => {
      spawned[ctx.id] = ctx;
      spawnOrder.push(ctx.id);
      const b = behaviour[ctx.id] ?? { resolved: false, note: "no behaviour" };
      const planPath = join(poolDir, `resolver-plan-${ctx.id}.sh`);
      const quote = (value: string) => JSON.stringify(value);
      const lines = [
        "WORKING_BRANCH=main",
        `RESOLVED=${b.resolved ? "1" : ""}`,
        `NOTE=${quote(b.note ?? "")}`,
        `EXIT=${b.exitCode ?? 0}`,
      ];
      if (b.conflictFile) lines.push(`CONFLICT_FILE=${quote(b.conflictFile)}`);
      if (b.resolution) lines.push(`RESOLUTION=${quote(b.resolution)}`);
      if (b.recordDir) lines.push(`RECORD_DIR=${quote(b.recordDir)}`);
      writeFileSync(planPath, lines.join("\n") + "\n");
      return ["bash", stubPath, ctx.outcomePath, planPath, ctx.cwd];
    };
    return {
      harnesses: { "resolver-stub": stub },
      spawned,
      spawnOrder,
    };
  }

  const resolverConfig: PoolConfig = {
    ...stubConfig,
    resolver: "resolver-stub",
  };

  it("shares attempt numbers between implement and resolver runs", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    interface EventLine {
      at: string;
      attempt: number;
      kind: string;
      payload: Record<string, unknown>;
    }
    const readEventsFile = (id: string): EventLine[] =>
      readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventLine);

    // The implement attempt conflicted, then the resolver took the next
    // attempt number for the same ticket.
    const before = readEventsFile("02");
    expect(before.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "merge-conflict",
      "resolver",
    ]);
    expect(before[0].attempt).toBe(1);
    expect(before.find((e) => e.kind === "resolver")?.attempt).toBe(2);

    const approved = await run.approve("02");
    const done = await approveReview(approved);
    expect(done.phase).toBe("done");

    // The approval answered the interrupt and the merge landed on the
    // resolver's attempt.
    const after = readEventsFile("02");
    expect(after.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "merge-conflict",
      "resolver",
      "answered",
      "merged",
    ]);
    expect(after.at(-1)?.attempt).toBe(2);
    expect(after.at(-1)?.kind).toBe("merged");
  }, 15000);

  it("tears down a resolver spawn whose grandchild holds its pipe, still capturing late output", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    // The resolver reproduces the conflict, stages a resolution, and holds
    // its stdout pipe open with a grandchild that outlives it: one line
    // lands inside the grace window, then the grandchild exits by itself.
    const holderPath = join(poolDir, "pipe-holder-resolver.sh");
    writeFileSync(
      holderPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome="$1"; worktree="$2"',
        "bash -c 'sleep 0.3; echo resolver-late-output-from-grandchild; sleep 30' &",
        'git -C "$worktree" merge main >/dev/null 2>&1 || true',
        'printf \'%s\\n\' "resolved-by-resolver" > "$worktree/shared.txt"',
        'git -C "$worktree" add shared.txt',
        'printf \'%s\' \'{"resolved": true, "note": "staged by the pipe holder"}\' > "$outcome"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const harnesses: Record<string, HarnessCommand> = {
      ...rig.harnesses,
      "resolver-stub": (ctx) => ["bash", holderPath, ctx.outcomePath, ctx.cwd],
    };

    // The comment above the ticket-spawn test's grandchild applies here too:
    // the grandchild outlives the run, so only the bounded grace gets the
    // resolver spawn back.
    const started = Date.now();
    const first = await runPool({ poolDir, harnesses });
    expect(Date.now() - started).toBeLessThan(10_000);
    const approval = first.interrupts.find((i) => i.kind === "merge-approval");
    expect(approval).toBeTruthy();
    expect(approval!.body).toContain("staged by the pipe holder");

    const done = await approveReview(await first.approve("02"));
    expect(done.phase).toBe("done");

    // The resolver's log captured the grandchild's line that landed inside
    // the grace window, and the drive did not park on the open pipe.
    expect(
      readFileSync(join(poolDir, "runs", "02.resolver.log"), "utf8"),
    ).toContain("resolver-late-output-from-grandchild");
  }, 15000);

  it("spawns the resolver on a conflict, raises an approval interrupt, and approve commits the merge and continues", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
        recordDir: join(poolDir, "res-rec"),
      },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.ticketId).toBe("02");
    expect(interrupt.kind).toBe("merge-approval");
    expect(interrupt.body).toContain("resolver agent resolved");
    expect(interrupt.body).toContain("kept both lines");

    // The resolver ran in 02's parked worktree on branch pool/02 and left the
    // resolution staged: the resolution is not yet committed, MERGE_HEAD set.
    expect(resolver.spawnOrder).toEqual(["02"]);
    expect(resolver.spawned["02"].cwd).toBe(
      join(poolDir, ".git", "pool-worktrees", "02"),
    );
    expect(readFileSync(join(poolDir, "res-rec", "branch"), "utf8").trim()).toBe(
      "pool/02",
    );
    expect(
      readFileSync(join(poolDir, "res-rec", "mergehead"), "utf8").trim(),
    ).toBeTruthy();

    const approved = await run.approve("02");
    const done = await approveReview(approved);
    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "resolved-by-agent\n",
    );
    expect(done.final.tickets["03"]).toBe("done");
    expect(git(["rev-parse", "--verify", "pool/02"]).exitCode).not.toBe(0);
    expect(
      existsSync(join(poolDir, ".git", "pool-worktrees", "02")),
    ).toBe(false);
  }, 15000);

  it("reject converts the approval to a manual interrupt carrying the attempt, and resume completes the merge", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    const rejected = await run.reject("02", "the resolver dropped a field");
    expect(rejected.phase).toBe("quiescent");
    expect(rejected.interrupts).toHaveLength(1);
    expect(rejected.interrupts[0].kind).toBe("merge-conflict");
    expect(rejected.interrupts[0].body).toContain("resolver agent attempted");
    expect(rejected.interrupts[0].body).toContain("kept both lines");
    expect(rejected.interrupts[0].body).toContain("shared.txt");
    // The rejection note was appended to the Issue as a durable resume note.
    expect(
      readFileSync(join(poolDir, "issues", "02-t.md"), "utf8"),
    ).toContain("the resolver dropped a field");
    // The staged resolution was discarded: the branch is back to its own
    // commits and the working branch still holds 01's content.
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("from-01\n");
    expect(
      git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode,
    ).not.toBe(0);

    // Billy resolves by hand in the main checkout, then resumes.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", "pool/02"]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "manual-resolution\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02 manually"]);

    const resumed = await rejected.resume("02");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "manual-resolution\n",
    );
  }, 15000);

  it("a resolver that fails takes the manual path with the failure noted", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    const resolver = resolverStub(poolDir, {
      "02": { resolved: false, note: "could not reconcile the schema" },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.kind).toBe("merge-conflict");
    expect(interrupt.body).toContain("resolver agent attempted");
    expect(interrupt.body).toContain("could not reconcile the schema");

    // Manual resolution then resume completes the merge.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", "pool/02"]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "manual\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02"]);
    const resumed = await run.resume("02");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("manual\n");
  }, 15000);

  it("falls back to the ~/.issue-runner default harness when resolver= is unset", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: stubConfig,
      },
      { "shared.txt": "base\n" },
    );
    const runnerFile = join(poolDir, "issue-runner");
    writeFileSync(runnerFile, "harness=resolver-stub\nmodel=resolver-model\n");
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "fallback-resolved",
        note: "via default",
      },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
      issueRunnerPath: runnerFile,
    });

    expect(run.interrupts[0]?.kind).toBe("merge-approval");
    expect(run.interrupts[0].body).toContain("via default");
    expect(resolver.spawnOrder).toEqual(["02"]);
  }, 15000);

  it("fails fast when an explicit resolver names an unknown harness", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: { ...stubConfig, resolver: "does-not-exist" },
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });

    await expect(
      runPool({ poolDir, harnesses: rig.harnesses }),
    ).rejects.toThrow(/resolver names unknown harness 'does-not-exist'/);
  }, 15000);

  it("rotates the resolver log to its attempt-numbered name on a second resolver run", async () => {
    const { poolDir } = makeGitPool(
      {
        // 04 is an independent sibling that also rewrites shared.txt in round
        // 2: rejecting it alongside 02 leaves two tickets ready at once, and
        // 02 waits on 04's merged change before overwriting shared.txt again,
        // so the second merge conflicts and the resolver runs a second time.
        tickets: [
          readyTicket("01"),
          readyTicket("02"),
          readyTicket("03", "02"),
          readyTicket("04"),
        ],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": [
        {
          waitMerged: "work-01",
          workFile: "shared.txt",
          workLine: "from-02",
          overwrite: true,
          commitMsg: "work-02",
        },
        {
          waitMerged: "work-04-again",
          workFile: "shared.txt",
          workLine: "from-02-again",
          overwrite: true,
          commitMsg: "work-02-again",
        },
      ],
      "03": { workFile: "three.txt", commitMsg: "work-03" },
      "04": [
        { workFile: "four.txt", commitMsg: "work-04" },
        {
          workFile: "shared.txt",
          workLine: "from-04-again",
          overwrite: true,
          commitMsg: "work-04-again",
        },
      ],
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    const approved = await run.approve("02");
    expect(approved.phase).toBe("quiescent");

    // Reject 02 and 04 together (03 resets as 02's downstream) so 02 re-runs
    // in a worktree alongside 04 and conflicts again.
    const rejected = await run.reject(REVIEW_TICKET_ID, "redo 02 04");
    expect(
      rejected.interrupts.some((i) => i.kind === "merge-approval"),
    ).toBe(true);

    // Implement attempt 1 rotated away; attempt 3 sits at the long-standing
    // path. Resolver attempt 2 rotated away; attempt 4 sits at its path.
    expect(existsSync(join(poolDir, "runs", "02.attempt-1.log"))).toBe(true);
    expect(existsSync(join(poolDir, "runs", "02.log"))).toBe(true);
    expect(existsSync(join(poolDir, "runs", "02.attempt-2.resolver.log"))).toBe(
      true,
    );
    expect(existsSync(join(poolDir, "runs", "02.resolver.log"))).toBe(true);

    // Rotated names agree with the attempt numbers in the events file.
    const events = readFileSync(
      join(poolDir, "runs", "02.events.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { attempt: number; kind: string });
    expect(
      events.filter((e) => e.kind === "spawned").map((e) => e.attempt),
    ).toEqual([1, 3]);
    expect(
      events.filter((e) => e.kind === "resolver").map((e) => e.attempt),
    ).toEqual([2, 4]);
  }, 20000);
  });
});

describe("accept/process split", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  interface QueuedAnswersFile {
    nextSeq: number;
    answers: {
      seq: number;
      ticketId: string;
      kind: string;
      approve?: boolean;
      note?: string;
      at: string;
      processedAt: string | null;
    }[];
  }

  function readQueuedAnswers(poolDir: string): QueuedAnswersFile {
    return JSON.parse(
      readFileSync(join(poolDir, "runs", "queued-answers.json"), "utf8"),
    ) as QueuedAnswersFile;
  }

  async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(10);
    }
  }

  // A stub harness whose blocked tickets hold their spawned script until the
  // sentinel file appears, so a test can keep a super-step in flight while it
  // answers an interrupt. Every other ticket takes the instant path. A ticket
  // can also fail: exitCode exits non-zero, and a status that is not done or
  // checkpoint writes no outcome at all. `blocks` gates per attempt (a
  // resumed ticket can hold its next super-step), and `sentinel` gives one
  // ticket its own release file.
  function blockingHarness(
    behaviour: Record<string, { statuses?: ("done" | "checkpoint" | "ready")[]; block?: boolean; blocks?: boolean[]; exitCode?: number; brief?: string; sentinel?: string }>,
    sentinel: string,
  ): StubRig {
    const poolLocal = tempDirs[tempDirs.length - 1];
    const stubPath = join(poolLocal, "blocking-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'issue="$1"; status="$2"; outcome_path="$3"; gate="$4"; sentinel="$5"; exit_code="$6"; outcome_json="$7"',
        'if [ "$gate" = "block" ]; then',
        '  while [ ! -f "$sentinel" ]; do sleep 0.02; done',
        "fi",
        'if [ -n "$outcome_json" ]; then',
        '  printf \'%s\' "$outcome_json" > "$outcome_path"',
        "fi",
        'exit "$exit_code"',
        "",
      ].join("\n"),
    );
    const spawned: Record<string, SpawnContext> = {};
    const spawnOrder: string[] = [];
    const counts: Record<string, number> = {};
    const stub: HarnessCommand = (ctx) => {
      spawned[ctx.id] = ctx;
      spawnOrder.push(ctx.id);
      const n = counts[ctx.id] ?? 0;
      counts[ctx.id] = n + 1;
      const b = behaviour[ctx.id] ?? {};
      const statuses = b.statuses ?? (["done"] as const);
      const status = statuses[Math.min(n, statuses.length - 1)];
      const block = b.blocks
        ? b.blocks[Math.min(n, b.blocks.length - 1)]
        : b.block;
      const outcome =
        status === "done" || status === "checkpoint"
          ? JSON.stringify({
              status,
              summary: "smoke",
              commitSha: null,
              ...(b.brief !== undefined ? { brief: b.brief } : {}),
            })
          : "";
      return [
        "bash",
        stubPath,
        ctx.issuePath,
        status,
        ctx.outcomePath,
        block ? "block" : "-",
        b.sentinel ?? sentinel,
        String(b.exitCode ?? 0),
        outcome,
      ];
    };
    return { harnesses: { stub }, spawned, spawnOrder };
  }

  it("accepts answers mid-super-step and drains them in submission order at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
        { file: "04-d.md", marker: "<!-- state: id=04 blocked-by=03 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-04");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["checkpoint", "done"] },
        "03": { statuses: ["done"] },
        "04": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["04"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01") &&
        run.interrupts.some((i) => i.ticketId === "02"),
      "ticket 04 spawned with interrupts pending for 01 and 02",
    );

    const first = run.resume("02", "answered first");
    const second = run.resume("01", "answered second");

    // Acceptance was immediate: the answered events and the queued records
    // landed while ticket 04's attempt still held the super-step open.
    expect(readEventsFile(poolDir, "02").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
    ]);
    expect(readEventsFile(poolDir, "02").at(-1)?.payload).toEqual({
      kind: "checkpoint",
    });
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers.map((a) => a.ticketId)).toEqual(["02", "01"]);
    expect(queue.answers.map((a) => a.kind)).toEqual(["checkpoint", "checkpoint"]);
    expect(queue.answers.every((a) => a.processedAt === null)).toBe(true);

    // The answer path never spawns: both tickets still sit at one attempt,
    // and the resume promises are still waiting on the boundary.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "spawned"),
    ).toHaveLength(1);
    expect(
      readEventsFile(poolDir, "02").filter((e) => e.kind === "spawned"),
    ).toHaveLength(1);
    let firstResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    await Bun.sleep(50);
    expect(firstResolved).toBe(false);

    writeFileSync(sentinel, "go");
    await first;
    await second;

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01", "02", "03", "04", "01", "02"]);
    const log = run.final.log;
    const answeredIdx = (id: string) =>
      log.findIndex((line) => line === `interrupt answered for ${id} (checkpoint): resumed`);
    const exited04 = log.findIndex((line) => line.startsWith("ticket 04: exited"));
    const step3 = log.findIndex((line) => line === "super-step 3: 01, 02");
    // Both answers were processed after the in-flight super-step joined, in
    // submission order, before the next super-step was scheduled.
    expect(answeredIdx("02")).toBeGreaterThan(exited04);
    expect(answeredIdx("02")).toBeLessThan(answeredIdx("01"));
    expect(answeredIdx("01")).toBeLessThan(step3);
    // The answered event precedes the attempt it unblocked in the ticket log.
    const kinds01 = readEventsFile(poolDir, "01").map((e) => e.kind);
    expect(kinds01.indexOf("answered")).toBeLessThan(kinds01.lastIndexOf("spawned"));
    expect(readQueuedAnswers(poolDir).answers.every((a) => a.processedAt !== null)).toBe(true);
  }, 15000);

  it("persists drained answers before the next super-step is scheduled", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
        { file: "04-d.md", marker: "<!-- state: id=04 blocked-by=03 status=ready -->" },
      ],
      config: stubConfig,
    });
    const release = join(poolDir, "release-03");
    const hold = join(poolDir, "hold-resumed");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"], blocks: [false, true], sentinel: hold },
        "02": { statuses: ["checkpoint", "done"], blocks: [false, true], sentinel: hold },
        "03": { statuses: ["done"], block: true },
        "04": { statuses: ["done"] },
      },
      release,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01") &&
        run.interrupts.some((i) => i.ticketId === "02"),
      "ticket 03 spawned with interrupts pending for 01 and 02",
    );

    const first = run.resume("02", "answered first");
    const second = run.resume("01", "answered second");

    // Release the held super-step: its boundary drains both answers and the
    // next super-step spawns the resumed tickets, which block again. While
    // that super-step is in flight, the answered state must already be on
    // disk: the drain persisted it before scheduling, so a kill here cannot
    // leave the resume in memory only.
    writeFileSync(release, "go");
    await waitFor(
      () => rig.spawnOrder.filter((id) => id === "01").length === 2,
      "resumed ticket 01 spawned into the next super-step",
    );
    const db = new Database(join(poolDir, "console.db"));
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .all() as { state: string }[];
    db.close();
    const persisted = JSON.parse(rows.at(-1)!.state) as {
      tickets: Record<string, string>;
      interrupts: { ticketId: string }[];
      log: string[];
    };
    expect(persisted.tickets["01"]).toBe("ready");
    expect(persisted.tickets["02"]).toBe("ready");
    expect(persisted.interrupts).toEqual([]);
    expect(persisted.log).toContain("interrupt answered for 02 (checkpoint): resumed");
    expect(persisted.log).toContain("interrupt answered for 01 (checkpoint): resumed");

    writeFileSync(hold, "go");
    await run.settled;
    await first;
    await second;
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02", "03", "01", "02", "04"]);
    expect(readQueuedAnswers(poolDir).answers.every((a) => a.processedAt !== null)).toBe(true);
  }, 15000);

  it("emits the queued answer on acceptance mid-flight and clears it at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-03");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "03": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 03 spawned with 01's interrupt pending",
    );

    run.accept("01", "go on");

    // Acceptance emitted a snapshot carrying the queued answer while the
    // super-step was still in flight; the interrupt is still pending on it.
    const accepted = run.snapshots.at(-1)!;
    expect(accepted.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(accepted.queuedAnswers[0]?.kind).toBe("checkpoint");
    expect(accepted.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);

    writeFileSync(sentinel, "go");
    await run.settled;

    // The boundary drain processed the answer, and the snapshots that follow
    // no longer carry it.
    const settled = run.snapshots.at(-1)!;
    expect(settled.queuedAnswers).toEqual([]);
    expect(settled.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);
  }, 15000);

  it("writes the answered event and queued record at acceptance for a review approval", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    run.accept(REVIEW_TICKET_ID, "ship it", true);

    expect(readEventsFile(poolDir, REVIEW_TICKET_ID).map((e) => e.kind)).toEqual([
      "answered",
    ]);
    expect(readEventsFile(poolDir, REVIEW_TICKET_ID)[0]?.payload).toEqual({
      kind: "review",
    });
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]).toMatchObject({
      ticketId: REVIEW_TICKET_ID,
      kind: "review",
      approve: true,
      note: "ship it",
    });

    const done = await run.settled;
    expect(done.phase).toBe("done");
    expect(done.final.log).toContain("review approved: the run is complete (ship it)");
  });

  it("drains queued answers left behind by a killed server after rehydrate", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The on-disk state a kill leaves behind when an answer was accepted but
    // the process died before the drain: acceptance's exact writes (the
    // answered event, then the queued record) with the interrupt still
    // pending in the checkpoint.
    appendEvent(join(poolDir, "runs"), "01", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "answered",
      payload: { kind: "checkpoint" },
    });
    new QueuedAnswerStore(join(poolDir, "runs")).enqueue({
      ticketId: "01",
      kind: "checkpoint",
      note: "the name is Foo",
      at: new Date().toISOString(),
    });

    const rig = stubHarness({ "01": { status: "done" } });
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });

    // The queued answer took effect without resubmission: 01 resumed and
    // finished, its dependent ran, and the run reached the review gate.
    expect(restarted.phase).toBe("quiescent");
    expect(restarted.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]?.processedAt).not.toBeNull();
    // The only answered event is acceptance's own, written before the kill.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
  });

  it("keeps an answered interrupt durable across a kill before the next super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-01");
    // Attempt 1 of 01 checkpoints; its resume attempt holds the super-step
    // open on the sentinel, so the kill lands between the processed answer
    // and the next super-step's join. The attempt-1 log only exists once a
    // re-run rotated it, which marks the resume attempt as spawned.
    writeFileSync(
      join(poolDir, "agent.sh"),
      [
        "#!/usr/bin/env bash",
        'issue="$1"; id="$2"; outcome_path="$3"; pool="$4"; sentinel="$5"',
        'if [ "$id" = "01" ]; then',
        '  if [ ! -f "$pool/runs/01.attempt-1.log" ]; then',
        '    printf \'%s\' \'{"status":"checkpoint","summary":"need a name","commitSha":null,"brief":"pick a name"}\' > "$outcome_path"',
        "    exit 0",
        "  fi",
        '  while [ ! -f "$sentinel" ]; do sleep 0.02; done',
        "  exit 0",
        "fi",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(poolDir, "fixture.ts"),
      [
        "const [enginePath, poolDir] = process.argv.slice(2);",
        "const { runPool } = await import(enginePath);",
        "const harnesses = {",
        "  stub: (ctx: { issuePath: string; id: string; outcomePath: string }) => [",
        '    "bash",',
        "    `${poolDir}/agent.sh`,",
        "    ctx.issuePath,",
        "    ctx.id,",
        "    ctx.outcomePath,",
        "    poolDir,",
        "    `${poolDir}/release-01`,",
        "  ],",
        "};",
        "const run = await runPool({ poolDir, harnesses });",
        "await run.resume('01', 'the name is Foo');",
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      ["bun", join(poolDir, "fixture.ts"), join(import.meta.dir, "engine.ts"), poolDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitFor(
        () =>
          existsSync(join(poolDir, "runs", "01.attempt-1.log")) &&
          readQueuedAnswers(poolDir).answers[0]?.processedAt !== null,
        "answer processed and the resume attempt spawned",
      );
    } finally {
      proc.kill();
      await proc.exited;
    }
    // The killed engine's blocked attempt holds no one: release it so the
    // orphaned stub exits instead of polling a directory the test teardown
    // removes.
    writeFileSync(sentinel, "go");

    const rig = stubHarness({ "01": { status: "done" }, "02": { status: "done" } });
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });

    // The answered state was on disk before the kill: the restart rehydrates
    // it, shows the answer in the log without resubmission, and runs the
    // resumed pool through to the review gate.
    expect(restarted.phase).toBe("quiescent");
    expect(restarted.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(restarted.final.log).toContain(
      "interrupt answered for 01 (checkpoint): resumed",
    );
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]?.processedAt).not.toBeNull();
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
  }, 20000);

  it("acknowledges a duplicate answer without a second event or record, and both callers settle", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-03");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["done"] },
        "03": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 03 spawned with the checkpoint interrupt pending for 01",
    );

    // The client answered, timed out waiting, and retried the same answer
    // while the first was still queued behind the in-flight super-step.
    const first = run.resume("01", "carry on");
    const retry = run.resume("01", "carry on");

    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    expect(readQueuedAnswers(poolDir).answers).toHaveLength(1);

    writeFileSync(sentinel, "go");
    await first;
    await retry;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(run.final.tickets["01"]).toBe("done");
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  }, 15000);

  it("records a crash at attempt exit, before a slow sibling's super-step ends", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 fails fast without writing an outcome; 02 holds the super-step
        // open until the sentinel lands.
        "01": { statuses: ["ready"], exitCode: 3 },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");
    const snapshotsBefore = run.snapshots.length;

    // The crash is recorded the moment 01's attempt exits: the event lands in
    // the ticket log and the marker is corrected while 02 still holds the
    // super-step open, and a snapshot pushes the crash to the Console.
    await waitFor(
      () => readEventsFile(poolDir, "01").some((e) => e.kind === "crash"),
      "crash event for ticket 01",
    );
    expect(readEventsFile(poolDir, "01").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(readEventsFile(poolDir, "01").at(-1)?.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
    });
    expect(
      readFileSync(join(poolDir, "issues", "01-a.md"), "utf8").split("\n")[0],
    ).toContain("status=in-progress");
    await waitFor(
      () => run.snapshots.length > snapshotsBefore,
      "snapshot emitted at crash recording",
    );
    // The interrupt itself still waits for the super-step boundary.
    expect(run.interrupts).toEqual([]);

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(run.interrupts[0]?.ticketId).toBe("01");
    // Recorded once, at exit; the boundary raises the interrupt only.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "crash"),
    ).toHaveLength(1);
  }, 15000);

  it("joins a done result into state and emits a snapshot at attempt exit, before a slow sibling exits", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 finishes done fast; 02 holds the super-step open until the
        // sentinel lands.
        "01": { statuses: ["done"] },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");

    // 02 has not been released, so the super-step is still in flight. A
    // snapshot already shows 01 done while 02 still reads in-progress: the
    // terminal status landed in state at 01's exit.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "done" &&
            snapshot.state.tickets["02"] === "in-progress",
        ),
      "snapshot showing 01 done and 02 still in-progress",
    );
    // A plain done carries no interrupt, even while it shows green early.
    expect(run.interrupts).toEqual([]);

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    // The exited line for the fast ticket was written exactly once: the
    // boundary did not re-apply the at-exit join.
    expect(
      run.final.log.filter((line) => line === "ticket 01: exited 0, marker done"),
    ).toHaveLength(1);
  }, 15000);

  it("raises a checkpoint's interrupt at attempt exit, before a slow sibling exits", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 checkpoints fast; 02 holds the super-step open until the sentinel.
        "01": { statuses: ["checkpoint", "done"], brief: "pick a name" },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");

    // The checkpoint status and its interrupt both landed in state at exit
    // while 02 still runs: the snapshot already carries the red status word,
    // the pending interrupt, and the checkpoint event.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "checkpoint" &&
            snapshot.state.tickets["02"] === "in-progress" &&
            snapshot.state.interrupts.some(
              (i) => i.ticketId === "01" && i.kind === "checkpoint",
            ),
        ),
      "snapshot showing 01 checkpoint with its interrupt pending while 02 still runs",
    );
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    // The checkpoint event is recorded at exit, once.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "checkpoint"),
    ).toHaveLength(1);
    // The sibling is untouched: still in-progress, no pause, no crash.
    expect(run.final.tickets["02"]).toBe("in-progress");

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
    expect(run.interrupts[0]?.body).toBe("pick a name");
    expect(run.final.tickets).toEqual({ "01": "checkpoint", "02": "done" });
    // The boundary did not raise or record the checkpoint again.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "checkpoint"),
    ).toHaveLength(1);
  }, 15000);

  it("accepts an answer during the window, queues it, and processes it at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"], brief: "pick a name" },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["02"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 02 spawned with 01's checkpoint interrupt already pending",
    );

    // 02 has not been released, so the super-step is still in flight; the
    // interrupt raised at 01's exit is answerable now. Acceptance is
    // immediate: the answered event and the queued record land while 02
    // still runs, and a snapshot pushes the waiting state to the Console.
    const resume = run.resume("01", "the name is Foo");
    const accepted = run.snapshots.at(-1)!;
    expect(accepted.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(accepted.queuedAnswers[0]?.kind).toBe("checkpoint");
    expect(accepted.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).toBeNull();
    // The answer is queued, not processed: the marker is still checkpoint and
    // the resume promise waits on the boundary.
    expect(
      readFileSync(join(poolDir, "issues", "01-a.md"), "utf8").split("\n")[0],
    ).toContain("status=checkpoint");
    let resolved = false;
    void resume.then(() => {
      resolved = true;
    });
    await Bun.sleep(50);
    expect(resolved).toBe(false);

    writeFileSync(sentinel, "go");
    await resume;

    // The boundary drained the answer (01 back to ready) and the next
    // super-step re-ran it to done; the sibling ran its own exit untouched.
    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  }, 15000);

  it("applies an at-exit terminal join exactly once and keeps the final snapshot sequence coherent", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["done"], block: true },
        "03": { statuses: ["done"] },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");
    // 03 is blocked by 02, so it is not in this super-step; the checkpoint
    // snapshot is already out while 02 still holds the super-step open.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "checkpoint" &&
            snapshot.state.tickets["02"] === "in-progress",
        ),
      "snapshot showing 01 checkpoint while 02 still runs",
    );

    writeFileSync(sentinel, "go");
    await run.settled;
    const settled = run.snapshots.at(-1)!;

    // The checkpoint attempt's update was joined at exit and skipped at the
    // boundary: its exited line appears once, and nothing diverged. The
    // interrupted ticket stayed checkpointed, its siblings finished, and the
    // boundary snapshot is coherent with the settled state.
    expect(
      run.final.log.filter(
        (line) => line === "ticket 01: exited 0, marker checkpoint",
      ),
    ).toHaveLength(1);
    expect(settled.state.tickets["01"]).toBe("checkpoint");
    expect(settled.state.tickets["02"]).toBe("done");
    expect(settled.state.tickets["03"]).toBe("done");
    expect(run.final.tickets).toEqual({
      "01": "checkpoint",
      "02": "done",
      "03": "done",
    });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  }, 15000);

  it("records the queued answer in its own store, separate from the PoolState checkpoints", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    run.accept("01", "carry on");

    // The record lives in runs/queued-answers.json, not in the checkpoint
    // database's PoolState rows.
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers.map((a) => a.ticketId)).toEqual(["01"]);
    const db = new Database(join(poolDir, "console.db"));
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .all() as { state: string }[];
    db.close();
    expect(rows.at(-1)?.state ?? "").not.toContain("queued-answer");

    const resumed = await run.settled;
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(resumed.final.tickets["01"]).toBe("done");
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  });
});
