/// <reference types="bun" />

// Stress pin for the spawnToLog pump teardown (the engine's live log pumps): a
// grandchild that inherits the child's stdout/stderr pipe and outlives it
// holds the write end open, so the pumps park until the child-exit grace
// cancels them. A run whose pump is still alive when its pool directory is
// removed (the way a test's cleanup removes the temp dir under a pump that
// outlived its owner) had its log write stream destroyed by the ENOENT, and
// the destruction used to reject the teardown as ERR_STREAM_DESTROYED,
// surfacing as an unhandled between-tests error that failed unrelated
// server tests. These tests drive both paths in a loop and fail on any
// ERR_STREAM_DESTROYED escaping the teardown.

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startPool,
  type HarnessCommand,
  type PoolRun,
} from "./engine.ts";

const tempDirs: string[] = [];

// The teardown failures the pinned bug produced. A genuine failure (the
// drive reading files that are gone) may still kill the drive and reject
// settled, and the death record may name it; neither surface may name one
// of these.
const TEARDOWN_ARTIFACTS = [
  "Cannot call end after a stream was destroyed",
  "ERR_STREAM_DESTROYED",
];

/** The settled handle, or its rejection carried as an Error. */
function settleEither(run: PoolRun): Promise<PoolRun | Error> {
  return run.settled.then(
    (settled) => settled,
    (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
  );
}

/** No teardown artifact on the settled error or the engine's death record. */
function expectNoTeardownArtifact(
  poolDir: string,
  settled: PoolRun | Error,
): void {
  const message = settled instanceof Error ? settled.message : "";
  for (const artifact of TEARDOWN_ARTIFACTS) {
    expect(message).not.toContain(artifact);
  }
  // The death record is recreated after a removal, so its absence is fine.
  const errorsPath = join(poolDir, "runs", "errors.jsonl");
  if (existsSync(errorsPath)) {
    const errors = readFileSync(errorsPath, "utf8");
    for (const artifact of TEARDOWN_ARTIFACTS) {
      expect(errors).not.toContain(artifact);
    }
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const MARKER = "<!-- state: id=01 blocked-by=none status=ready -->";

function makePool(): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-pump-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  writeFileSync(join(poolDir, "issues", "01-a.md"), `${MARKER}\n\n# body\n`);
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify({ defaults: { harness: "stub", model: "m" } }, null, 2),
  );
  return poolDir;
}

// A stub harness that leaves a grandchild holding the pipe: the grandchild
// inherits stdout, keeps writing long after the child exited, so EOF never
// reaches the pumps and the child-exit grace is what tears them down.
function grandchildHarness(): Record<string, HarnessCommand> {
  const poolDir = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolDir, "grandchild-stub.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'status="$1"; outcome_path="$2"',
      "( for i in $(seq 1 100); do echo \"grandchild $i\"; sleep 0.03; done ) &",
      "printf '{\"status\":\"%s\",\"summary\":\"smoke\",\"commitSha\":null}' \"$status\" > \"$outcome_path\"",
      "echo 'harness done'",
      "exit 0",
      "",
    ].join("\n"),
  );
  const harness: HarnessCommand = (ctx) => [
    "bash",
    stubPath,
    "done",
    ctx.outcomePath,
  ];
  return { stub: harness };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("spawn pump teardown", () => {
  it("settles a grandchild-holds-the-pipe spawn through the child-exit grace", async () => {
    for (let round = 0; round < 2; round++) {
      const poolDir = makePool();
      const run = startPool({ poolDir, harnesses: grandchildHarness() });
      const settled = await run.settled;
      expect(settled.phase).toBe("quiescent");
      const log = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
      expect(log).toContain("grandchild 1");
      expect(log).toContain("harness done");
    }
  });

  it(
    "tears the pumps down without ERR_STREAM_DESTROYED when the pool dir goes away under them",
    async () => {
      for (let round = 0; round < 3; round++) {
        const poolDir = makePool();
        const run = startPool({ poolDir, harnesses: grandchildHarness() });
        const logPath = join(poolDir, "runs", "01.log");
        await waitFor(
          () =>
            existsSync(logPath) &&
            readFileSync(logPath, "utf8").includes("grandchild 2"),
          "the grandchild's output to reach the pump",
        );
        // The pool directory removed under a pump that is still reading and
        // writing: exactly what a cleanup step after the owner's settle does
        // to an attempt a grandchild kept alive past it.
        rmSync(poolDir, { recursive: true, force: true });
        expectNoTeardownArtifact(poolDir, await settleEither(run));
        // Room for any late rejection to surface; the runner fails the file
        // on an unhandled one, which is the pin itself.
        await Bun.sleep(50);
      }
    },
    // Three grandchild-parked rounds at the pump grace's own pace; the
    // explicit timeout holds all three, which the default cannot.
    30000,
  );

  it(
    "never rejects the teardown when the attempt's log cannot be opened at all",
    async () => {
      for (let round = 0; round < 3; round++) {
        const poolDir = makePool();
        // A broken symlink where the attempt's log should be: the write
        // stream's open fails, the stream is destroyed from birth, and the
        // pumps write into a dead writer for the whole attempt. This is the
        // destroyed-stream teardown the flaked suite runs tripped: end() on
        // it rejects with ERR_STREAM_DESTROYED, and with no error listener
        // the open failure itself escapes as an unhandled error.
        const logPath = join(poolDir, "runs", "01.log");
        mkdirSync(join(poolDir, "runs"), { recursive: true });
        symlinkSync("/nonexistent-dir-for-pump-test/log.txt", logPath);
        const run = startPool({ poolDir, harnesses: grandchildHarness() });
        expectNoTeardownArtifact(poolDir, await settleEither(run));
        // Room for any late rejection to surface; the runner fails the file
        // on an unhandled one, which is the pin itself.
        await Bun.sleep(50);
      }
    },
    // Three grandchild-parked rounds at the pump grace's own pace; the
    // explicit timeout holds all three, which the default cannot.
    30000,
  );
});
