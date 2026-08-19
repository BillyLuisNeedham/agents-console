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
      run = await runPool({ poolDir });
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
      run = await runPool({ poolDir });
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
      run = await runPool({ poolDir });
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
      run = await runPool({ poolDir: doneDir });
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
    expect(resumed.phase).toBe("done");
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

    expect(resumed.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(resumed.final.log).toContain(
      "interrupt answered for 01 (crash): resumed",
    );
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
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });
    expect(first.phase).toBe("done");

    // run.sh reset 02: the marker on disk is the truth, the checkpoint's
    // done is stale.
    setMarker(poolDir, "02-b.md", "ready");
    const rig = stubHarness({});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

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
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

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

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

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
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

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
    expect(resumed.phase).toBe("done");
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
    const run = await runPool({ poolDir, harnesses: rig.harnesses });

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
    expect(resumed.phase).toBe("done");
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
