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
  REVIEW_TICKET_ID,
  runPool,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
} from "./engine.ts";
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

interface StubBehaviour {
  status?: "done" | "checkpoint" | "ready" | "keep";
  statuses?: ("done" | "checkpoint" | "ready" | "keep")[];
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
    // The exited event carries the exit code and the marker status the
    // harness left behind.
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
      "01": { statuses: ["keep", "done"], exitCode: 3 },
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
    expect(crash.at(-1)?.payload).toEqual({ code: 3 });

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
        'issue="$1"; status="$2"; stamp="$3"',
        'echo "attempt-output-$stamp"',
        'sed -i "1s/status=[a-z-]*/status=$status/" "$issue"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    let spawn = 0;
    const harness: HarnessCommand = (ctx) => {
      spawn += 1;
      const status = spawn === 1 ? "checkpoint" : "done";
      return ["bash", script, ctx.issuePath, status, String(spawn)];
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

describe("harness CLIs", () => {
  // Fake CLI binaries on PATH exercise the real default harnesses: the
  // engine resolves the console.json harness name to a binary and launches
  // it in the shape run.sh proved. Each fake records its argv one argument
  // per file (argv.0, argv.1, ...) so assertions see exact strings, newline-
  // carrying prompts included.

  interface FakeCli {
    binDir: string;
    recordDir: string;
  }

  function fakeCli(
    poolDir: string,
    binary: string,
    argExtract: string[],
    opts: { setDone?: boolean; exitCode?: number } = {},
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
        ...argExtract,
        ...(opts.setDone ?? true
          ? ['sed -i "1s/status=[a-z-]*/status=done/" "$rel"']
          : []),
        `echo "fake ${binary} ran"`,
        `exit ${opts.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, binary), 0o755);
    return { binDir, recordDir };
  }

  // claude and cursor take the whole prompt after -p; its first line is
  // "/<driver> <issueRel>".
  const extractFromPrintFlag = [
    'prompt=""',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    -p) prompt="$2"; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    'rel="$(printf \'%s\' "$prompt" | head -1 | sed \'s|^/[^ ]* ||\')"',
  ];

  // opencode takes the message after --command <driver>; its first line is
  // the bare issueRel.
  const extractFromCommandMessage = [
    'seen=0; msg=""',
    'for a in "$@"; do',
    '  if [ "$seen" = "2" ]; then msg="$a"; break; fi',
    '  if [ "$seen" = "1" ]; then seen=2; fi',
    '  if [ "$a" = "--command" ]; then seen=1; fi',
    "done",
    'rel="$(printf \'%s\' "$msg" | head -1)"',
  ];

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
    process.env.PATH = `${fake.binDir}:${originalPath}`;
    process.env.FAKE_RECORD_DIR = fake.recordDir;
    try {
      await fn();
    } finally {
      process.env.PATH = originalPath;
      if (originalRecord === undefined) delete process.env.FAKE_RECORD_DIR;
      else process.env.FAKE_RECORD_DIR = originalRecord;
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
    const fake = fakeCli(poolDir, "claude", extractFromPrintFlag);

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toMatch(/^\/implement issues\/01-a\.md\n/);
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
    const fake = fakeCli(poolDir, "opencode", extractFromCommandMessage);

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("--command");
    expect(argv[2]).toBe("implement");
    expect(argv[3]).toMatch(/^issues\/01-a\.md\n/);
    expect(argv[3]).toContain("Standing instructions for this job:");
    expect(argv[3]).not.toContain("/implement");
    expect(argv.slice(4)).toEqual(["--model", "opencode-test", "--auto"]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
  });

  it("launches cursor's agent CLI with the documented flags (unproven line, carried over from run.sh)", async () => {
    const poolDir = oneTicketPool("cursor", "cursor-test");
    const fake = fakeCli(poolDir, "agent", extractFromPrintFlag);

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toMatch(/^\/implement issues\/01-a\.md\n/);
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

  it("drives status from the marker a spawned CLI leaves behind, done or untouched alike", async () => {
    const doneDir = oneTicketPool("claude", "claude-test");
    const doneFake = fakeCli(doneDir, "claude", extractFromPrintFlag);
    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(doneFake, async () => {
      run = await approveReview(await runPool({ poolDir: doneDir }));
    });
    expect(run!.phase).toBe("done");
    expect(run!.final.tickets["01"]).toBe("done");

    const crashDir = oneTicketPool("claude", "claude-test");
    const crashFake = fakeCli(crashDir, "claude", extractFromPrintFlag, {
      setDone: false,
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

    // Two super-step joins, the review gate, the quiescent final, and the
    // approval's done final.
    expect(rows.length).toBe(5);
    const first = JSON.parse(rows[0].state);
    const second = JSON.parse(rows[1].state);
    const terminal = JSON.parse(rows[4].state);
    expect(first.tickets).toEqual({ "01": "done", "02": "ready" });
    expect(second.tickets).toEqual({ "01": "done", "02": "done" });
    expect(second.outcomes["01"].summary).toBe("summary-01");
    expect(terminal.log.at(-1)).toBe("pool done: every ticket reached done");
    expect(terminal.reviewApproved).toBe(true);
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
    // The harness exits having set its own marker back to ready: a crash
    // with extra steps. Without the read-back mapping this re-spawns
    // forever and never reaches a human.
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
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
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
        '  sed -i "1s/status=[a-z-]*/status=done/" "$issue"',
        '  printf \'%s\' \'{"summary":"recovered-01","commitSha":"sha-01"}\' > "$outcome_path"',
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
    commitIssue?: boolean;
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
        'WORK_FILE=""; WORK_LINE=""; OVERWRITE=""; COMMIT_MSG=""; COMMIT_ISSUE="1"',
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
        'if [ "$status" != "keep" ]; then',
        '  sed -i "1s/status=[a-z-]*/status=$status/" "$issue"',
        '  if [ -n "$COMMIT_ISSUE" ]; then git add "$issue"; staged=1; fi',
        "fi",
        'if [ -n "$LEAVE_FILE" ]; then printf "partial\\n" > "$LEAVE_FILE"; fi',
        'if [ "$staged" = "1" ]; then git commit -qm "${COMMIT_MSG:-ticket}"; fi',
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
        b.outcome === null
          ? ""
          : JSON.stringify(
              b.outcome ?? {
                summary: `summary-${ctx.id}`,
                commitSha: `sha-${ctx.id}`,
              },
            );
      const planPath = join(poolDir, `plan-${ctx.id}-${n}.sh`);
      const quote = (value: string) => JSON.stringify(value);
      const lines = [`MAIN_REPO=${quote(poolDir)}`];
      if (b.workFile) lines.push(`WORK_FILE=${quote(b.workFile)}`);
      if (b.workLine) lines.push(`WORK_LINE=${quote(b.workLine)}`);
      if (b.overwrite) lines.push('OVERWRITE="1"');
      if (b.commitMsg) lines.push(`COMMIT_MSG=${quote(b.commitMsg)}`);
      if (b.commitIssue === false) lines.push('COMMIT_ISSUE=""');
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
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const commandArgs = process.argv[process.argv.indexOf("--command") + 2];',
        'const issueRel = commandArgs.split("\\n")[0];',
        'const id = issueRel.split("/").at(-1)!.split("-")[0];',
        'const issue = join(process.cwd(), issueRel);',
        'const recordDir = process.env.PWD_RECORD_DIR;',
        'mkdirSync(recordDir, { recursive: true });',
        'writeFileSync(join(recordDir, `pwd.${id}`), process.env.PWD ?? "");',
        'writeFileSync(issue, readFileSync(issue, "utf8").replace(/status=[a-z-]*/, "status=done"));',
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
    expect(rig.spawned["03"].prompt).toContain("02: schema v2");
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
        body: "(no Brief section in the Issue file)",
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
