import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPool,
  type HarnessCommand,
  type PoolConfig,
  type SpawnContext,
} from "./engine.ts";

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

interface StubBehaviour {
  status?: "done" | "checkpoint" | "keep";
  statuses?: ("done" | "checkpoint" | "keep")[];
  outcome?: { summary: string; commitSha: string | null } | null;
  exitCode?: number;
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
      'if [ "$status" != "keep" ]; then',
      '  sed -i "1s/status=[a-z-]*/status=$status/" "$issue"',
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
      b.outcome === null
        ? ""
        : JSON.stringify(
            b.outcome ?? {
              summary: `summary-${ctx.id}`,
              commitSha: `sha-${ctx.id}`,
            },
          );
    return [
      "bash",
      stubPath,
      ctx.issuePath,
      status,
      ctx.outcomePath,
      outcome,
      String(b.exitCode ?? 0),
    ];
  };
  return { harnesses: { stub }, spawned, spawnOrder };
}

const stubConfig: PoolConfig = {
  defaults: { harness: "stub", model: "stub-model" },
};

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

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

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

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

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
    expect(rig.spawned["02"].prompt).toContain("summary-01");
    expect(rig.spawned["03"].prompt).toContain("summary-01");
    expect(rig.spawned["02"].prompt).not.toContain("summary-03");
    expect(rig.spawned["03"].prompt).not.toContain("summary-02");
    expect(Object.keys(run.final.outcomes).sort()).toEqual([
      "01",
      "02",
      "03",
    ]);
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
      summary: "built the schema",
      commitSha: "abc123",
    });
    expect(rig.spawned["02"].prompt).toContain("01: built the schema");
    expect(rig.spawned["02"].prompt).toContain("abc123");
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
  it("glues driver skill, AGENT.md, chain, and roster in run.sh's shape", async () => {
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

    const prompt = rig.spawned["01"].prompt;
    const lines = prompt.split("\n");
    expect(lines[0]).toMatch(/^\/implement .*issues\/01-a\.md$/);
    expect(prompt).toContain("Standing instructions for this job:");
    expect(prompt).toContain("Do the thing.");
    expect(prompt).toContain("dispatch these subagents in this order");
    expect(prompt).toContain("code-review");
    expect(prompt).toContain("The subagent roster for this job");
    expect(prompt).toContain("deepseek: general-purpose subagent");
    expect(prompt).toContain("outcome.json");
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

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq")
      .all() as { state: string }[];
    db.close();

    expect(rows.length).toBe(3);
    const first = JSON.parse(rows[0].state);
    const second = JSON.parse(rows[1].state);
    const terminal = JSON.parse(rows[2].state);
    expect(first.tickets).toEqual({ "01": "done", "02": "ready" });
    expect(second.tickets).toEqual({ "01": "done", "02": "done" });
    expect(second.outcomes["01"].summary).toBe("summary-01");
    expect(terminal.log.at(-1)).toBe("pool done: every ticket reached done");
    expect(run.snapshots.length).toBe(6);
    expect(run.snapshots.at(-1)?.phase).toBe("done");
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
    const rig = stubHarness({ "01": { status: "checkpoint" } });

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

  it("raises a crash interrupt carrying the log path when no status is set", async () => {
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

    expect(resumed.phase).toBe("done");
    expect(resumed.interrupts).toEqual([]);
    expect(resumed.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(rig.spawnOrder).toEqual(["01", "01", "02"]);
    expect(resumed.snapshots.length).toBeGreaterThan(snapshotsBefore);
    expect(resumed.final.log).toContain(
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

    expect(resumed.phase).toBe("done");
    expect(resumed.interrupts).toEqual([]);
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
    expect(clean.phase).toBe("done");
    expect(clean.interrupts).toEqual([]);
    expect(clean.snapshots.at(-1)?.phase).toBe("done");
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

  it("reports stalled when nothing can run and no interrupt explains it", async () => {
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

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("stalled");
    expect(run.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual([]);
    expect(run.final.log.at(-1)).toBe("pool stalled: 01 cannot run");
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

    expect(resumed.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(resumed.final.log).toContain(
      "interrupt answered for 01 (crash): resumed",
    );
  });
});
