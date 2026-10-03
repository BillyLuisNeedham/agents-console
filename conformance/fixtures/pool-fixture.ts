/**
 * The pool fixture the engine's suites share: one makePool, one makeGitPool,
 * one stubHarness, one teardown, where each used to be copied per suite and
 * the copies had already drifted (different temp-dir makers, different stub
 * outcome shapes, an implicit "call makePool first" coupling through a
 * module-level tempDirs array). Lives in its own module beside herdr-fake.ts
 * rather than inside one suite for the same reason the fake does: one
 * definition of the pool the tests assume, and importing it never drags
 * another suite's cases into the importer's run.
 *
 * It sits in conformance/fixtures (ADR-0036), where nothing may import the
 * engine but the wire's types, so the engine shapes the in-process helpers
 * take (a harness command, its spawn context, a server to settle) are
 * restated structurally below. The engine suites that hand these helpers to
 * the engine are what keep the two in step: a field one side gains and the
 * other lacks fails `bun run typecheck` there.
 *
 * The registry is the module's own: every directory the fixture makes is
 * registered, and cleanupPools drains it, so no suite keeps its own
 * tempDirs array for pool dirs. Suite-local dirs (a fake herdr's socket
 * dir, a wrapper's bin dir) join the same registry through registerTempDir.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { makeTempDir } from "./tmp.ts";

/**
 * What the engine hands a harness command when it launches an Attempt: the
 * engine's SpawnContext (engine/spawn.ts), field for field.
 */
export interface StubSpawnContext {
  id: string;
  issuePath: string;
  body: string;
  driver: string;
  harness: string;
  model: string;
  effort?: string;
  logPath: string;
  outcomePath: string;
  exitCodePath: string;
  cwd: string;
  streamPath: string | null;
}

/** A harness command: the engine's HarnessCommand, over the context above. */
export type StubHarnessCommand = (ctx: StubSpawnContext) => string[];

/** The part of an in-process pool server the teardown drives. */
export interface SettlingServer {
  settled(): Promise<unknown>;
  close(): Promise<unknown>;
}

const tempDirs: string[] = [];

/** The console.json content the stub-driving suites boot with. */
export const STUB_DEFAULTS = {
  defaults: { harness: "stub", model: "m" },
} satisfies PoolConfig;

export interface PoolSpec {
  tickets: { file: string; marker: string; body?: string }[];
  config?: PoolConfig;
  agentMd?: string;
}

/** A pool in a fresh temp dir: the Issue files, plus console.json iff the
 *  spec carries a config and AGENT.md iff it carries agentMd. */
export function makePool(spec: PoolSpec): string {
  const poolDir = makeTempDir("pool-");
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

export interface GitPool {
  poolDir: string;
  head: string;
  git: (args: string[]) => { exitCode: number; stdout: Buffer; stderr: Buffer };
}

/** A pool that is also a real git checkout (Conversations and worktree
 *  tests need one), with the seed files committed as the initial commit. */
export function makeGitPool(
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

// The fake agent contract (ADR-0005): the stub signals its ending through the
// outcome JSON it writes, never by editing the Issue marker. "done" and
// "checkpoint" land in the outcome's status field; "keep" writes no outcome
// (crash material); "ready" and "marker-done" sed the marker without writing
// an outcome, the old protocol's misbehaviours the clean break must ignore.
export type StubStatus = "done" | "checkpoint" | "ready" | "keep" | "marker-done";

export interface StubBehaviour {
  status?: StubStatus;
  statuses?: StubStatus[];
  outcome?: { summary: string; commitSha: string | null } | null;
  outcomeRaw?: string;
  brief?: string;
  spawn?: unknown;
  grade?: { score: number; verdict: "pass" | "flag"; reasons: string };
  winner?: number | string;
  exitCode?: number;
  exitCodes?: number[];
  /**
   * A file the stub waits for (up to ten seconds) before doing anything,
   * so a test can hold the harness open until the engine has reached the
   * point it means to observe, then release it by creating the file.
   */
  waitFor?: string;
}

/** What one launch of a stub does: the status it plays, the outcome JSON it
 *  writes ("" for none) and the code it exits with. */
export interface StubStep {
  status: StubStatus;
  outcome: string;
  exitCode: number;
}

/**
 * The `n`th launch (from 0) of `id` under its behaviour: the one reading of
 * the fake agent contract, shared by the in-process stub below and the
 * conformance suite's stubs on PATH (conformance/harness/stubs.ts). A
 * grader id with no behaviour passes with a default grade, so a case that
 * does not care about grading still flows through it. `commitSha` is the
 * default outcome's commit.
 */
export function stubStep(
  id: string,
  behaviour: StubBehaviour | undefined,
  n: number,
  commitSha: string | null = `sha-${id}`,
): StubStep {
  const b = behaviour ??
    (/-grader-\d+$/.test(id)
      ? { grade: { score: 8, verdict: "pass" as const, reasons: "default grade" } }
      : {});
  const status = b.statuses
    ? b.statuses[Math.min(n, b.statuses.length - 1)]!
    : (b.status ?? "done");
  const outcome =
    b.outcomeRaw !== undefined
      ? b.outcomeRaw
      : b.outcome === null || status === "keep" || status === "ready" || status === "marker-done"
        ? ""
        : JSON.stringify({
            status,
            ...(b.outcome ?? { summary: `summary-${id}`, commitSha }),
            ...(b.brief !== undefined ? { brief: b.brief } : {}),
            ...(b.spawn !== undefined ? { spawn: b.spawn } : {}),
            ...(b.grade !== undefined ? { grade: b.grade } : {}),
            ...(b.winner !== undefined ? { winner: b.winner } : {}),
          });
  const exitCode = b.exitCodes
    ? b.exitCodes[Math.min(n, b.exitCodes.length - 1)]!
    : (b.exitCode ?? 0);
  return { status, outcome, exitCode };
}

export interface StubRig {
  harnesses: Record<string, StubHarnessCommand>;
  spawned: Record<string, StubSpawnContext>;
  spawnOrder: string[];
  // Every spawn context in spawn order, attempts included: a verify fan-out
  // spawns one ticket id several times, which the keyed map cannot hold.
  spawnList: StubSpawnContext[];
}

/** A headless bash stub harness under the name "stub", recording every spawn
 *  context it is invoked with. Takes the pool dir explicitly: the script it
 *  writes must live inside the pool, and the old copies reached for it
 *  through an implicit tempDirs[last] coupling instead. Each launch plays
 *  stubStep's reading of its behaviour. */
export function stubHarness(
  poolDir: string,
  behaviour: Record<string, StubBehaviour>,
): StubRig {
  const stubPath = join(poolDir, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"; outcome_path="$3"; outcome_json="$4"; exit_code="$5"; wait_for="${6:-}"',
      'if [ -n "$wait_for" ]; then',
      "  for _ in $(seq 1 200); do",
      '    [ -e "$wait_for" ] && break',
      "    sleep 0.05",
      "  done",
      "fi",
      'if [ "$status" = "ready" ] || [ "$status" = "marker-done" ]; then',
      // In place on line 1, through awk rather than `sed -i`: BSD sed wants
      // an argument after -i and GNU sed refuses one, so the sed form rewrote
      // nothing on macOS and left its complaint in the attempt log.
      '  awk -v s="${status#marker-}" \'NR==1{sub(/status=[a-z-]*/, "status=" s)} {print}\' "$issue" > "$issue.new"',
      '  mv "$issue.new" "$issue"',
      "fi",
      'if [ -n "$outcome_json" ]; then',
      '  printf \'%s\' "$outcome_json" > "$outcome_path"',
      "fi",
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  const spawned: Record<string, StubSpawnContext> = {};
  const spawnOrder: string[] = [];
  const spawnList: StubSpawnContext[] = [];
  const spawnCounts: Record<string, number> = {};
  const stub: StubHarnessCommand = (ctx) => {
    spawned[ctx.id] = ctx;
    spawnOrder.push(ctx.id);
    spawnList.push(ctx);
    const n = spawnCounts[ctx.id] ?? 0;
    spawnCounts[ctx.id] = n + 1;
    const { status, outcome, exitCode } = stubStep(ctx.id, behaviour[ctx.id], n);
    const waitFor = behaviour[ctx.id]?.waitFor;
    return [
      "bash",
      stubPath,
      ctx.issuePath,
      status,
      ctx.outcomePath,
      outcome,
      String(exitCode),
      ...(waitFor ? [waitFor] : []),
    ];
  };
  return { harnesses: { stub }, spawned, spawnOrder, spawnList };
}

/** A suite-local temp dir joins the registry, so cleanupPools drains it too. */
export function registerTempDir(dir: string): void {
  tempDirs.push(dir);
}

/** The pool's quiescence, bounded: a merge-held pool never settles by design
 *  (ADR-0014), so the wait races settled against the 2 s beat. A drive that
 *  died reports its death through settled()'s rejection, and by then the work
 *  it was driving is over, so the cleanup still proceeds. */
export async function settleOrBeat(server: SettlingServer): Promise<void> {
  await Promise.race([server.settled().catch(() => {}), Bun.sleep(2000)]);
}

/** Teardown for every suite: give each server its bounded settle, close it,
 *  and drain the temp-dir registry. A test that ends right after an answer
 *  leaves a fresh drive running its last attempt, and a directory removed
 *  under that attempt makes its continuation read deleted files — the stray
 *  ENOENT that fails whichever test runs next. */
export async function cleanupPools(servers: SettlingServer[] = []): Promise<void> {
  for (const server of servers.splice(0)) {
    await settleOrBeat(server);
    await server.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
}
