/**
 * The resolver's Assignment, seen from outside the server (ADR-0036): which
 * harness, model and effort a conflicted merge's resolver runs on, from
 * console.json's resolver key, the pool defaults and the Machine defaults,
 * and what an unknown one does. Each case makes a real conflict: 01 and 02
 * run side by side in their own worktrees, the case commits a different
 * shared.txt into each while their stubs are held, and 02 merges second.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { StubCall } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import {
  approveReview,
  flagValue,
  holdFile,
  logLines,
  release,
  ticket,
  untilLaunched,
  untilSnapshot,
  writeConfig,
} from "./config-support.ts";

const KNOWN = "Known: claude, cursor, opencode";

/** Commit `line` as shared.txt in a launch's worktree. */
function commitShared(world: World, launch: StubCall, line: string): void {
  writeFileSync(join(launch.cwd, "shared.txt"), `${line}\n`);
  world.git(["-C", launch.cwd, "add", "shared.txt"]);
  world.git(["-C", launch.cwd, "commit", "-qm", `work ${line}`]);
}

/**
 * Run `first` and `second` to a conflicted merge of `second`: both held,
 * each commits its own shared.txt, `first` merges, then `second` is let go.
 */
async function conflict(world: World, first = "01", second = "02"): Promise<void> {
  const [a] = await untilLaunched(world, first);
  const [b] = await untilLaunched(world, second);
  commitShared(world, a!, `from-${first}`);
  commitShared(world, b!, `from-${second}`);
  release(world, first);
  await until(
    () => world.git(["show", "main:shared.txt"]),
    (text) => text === `from-${first}\n`,
    { what: `${first}'s merge into main` },
  );
  release(world, second);
}

/** A pool of two Tickets that conflict on shared.txt, both held at launch. */
function conflictingWorld(t: Case, config: PoolConfig): World {
  const world = t.world({
    tickets: [ticket("01"), ticket("02")],
    config,
    repoFiles: { "shared.txt": "base\n" },
  });
  world.stubs.script("01", { waitFor: holdFile(world, "01") });
  world.stubs.script("02", { waitFor: holdFile(world, "02") });
  return world;
}

/**
 * Play the resolver a held stub launched as: merge the working branch in
 * its worktree, stage `resolution`, and write the result its prompt asks
 * for. The resolver's prompt names its result file after "write JSON to".
 */
function resolveAs(world: World, resolver: StubCall, note: string): void {
  const prompt = resolver.argv.find((arg) => arg.includes("write JSON to "));
  if (!prompt) throw new Error(`the resolver's argv names no result file: ${JSON.stringify(resolver.argv)}`);
  const resultPath = prompt.split("write JSON to ")[1]!.split(":")[0]!;
  // Exits non-zero on the conflict it is here to leave in the worktree.
  Bun.spawnSync(["git", "-C", resolver.cwd, "merge", "main"], { env: world.env("") });
  writeFileSync(join(resolver.cwd, "shared.txt"), "resolved\n");
  world.git(["-C", resolver.cwd, "add", "shared.txt"]);
  writeFileSync(resultPath, JSON.stringify({ resolved: true, note }));
}

/** Wait for 02's merge-approval, approve it, then the final Review. */
async function approveResolution(server: CaseServer): Promise<void> {
  await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "merge-approval"),
    "02's merge-approval",
  );
  expect((await server.http.post("/api/resume", { ticketId: "02", action: "approve" })).status).toBe(202);
  await approveReview(server);
}

conformance("config", "with no resolver key the resolver runs on the Machine defaults' harness, the legacy file behind them", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" } });
  writeFileSync(join(world.home, ".issue-runner"), "harness=opencode\n");
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(join(world.home, ".agent-graphs", "defaults.json"), JSON.stringify({ effort: "low" }));
  world.stubs.script("02.resolver", { outcome: null, waitFor: holdFile(world, "02.resolver") });
  const server = await t.start(world);
  await conflict(world);
  const [resolver] = await untilLaunched(world, "02.resolver");
  resolveAs(world, resolver!, "via default");
  release(world, "02.resolver");

  const approval = await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "merge-approval"),
    "02's merge-approval",
  );
  expect(approval.state.interrupts.find((i) => i.ticketId === "02")!.body).toContain("It attempted: via default");
  expect(flagValue(resolver!.argv, "--model")).toBe("m");
  expect(flagValue(resolver!.argv, "--variant")).toBe("low");
  await approveResolution(server);
  expect(world.stubs.calls().filter((call) => call.key.endsWith(".resolver"))).toHaveLength(1);
}, { timeoutMs: 90_000 });

conformance("config", "the resolver's object form pins its own model and effort over the pool defaults'", async (t) => {
  const world = conflictingWorld(t, {
    defaults: { harness: "claude", model: "m", effort: "high" },
    resolver: { harness: "opencode", model: "resolver-model", effort: "max" },
  });
  world.stubs.script("02.resolver", { outcome: null, waitFor: holdFile(world, "02.resolver") });
  const server = await t.start(world);
  await conflict(world);
  const [resolver] = await untilLaunched(world, "02.resolver");
  resolveAs(world, resolver!, "via pinned model");
  release(world, "02.resolver");
  await approveResolution(server);

  expect(world.stubs.calls().filter((call) => call.key.endsWith(".resolver"))).toHaveLength(1);
  expect(flagValue(resolver!.argv, "--model")).toBe("resolver-model");
  expect(flagValue(resolver!.argv, "--variant")).toBe("max");
  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved\n");
}, { timeoutMs: 90_000 });

conformance("config", "an explicit resolver naming an unknown harness kills the pool at the conflict, naming it", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" }, resolver: "does-not-exist" });
  const server = await t.start(world);
  await conflict(world);
  const dead = await untilSnapshot(server, (s) => s.phase === "dead", "the pool to die");

  const message = `pool config: resolver names unknown harness 'does-not-exist'. ${KNOWN}`;
  expect(dead.state.log).toContain(`pool dead: ${message}`);
  const errors = readFileSync(join(world.pool, "runs", "errors.jsonl"), "utf8");
  expect(errors).toContain(message);
  expect(world.stubs.calls().filter((call) => call.key.endsWith(".resolver"))).toEqual([]);
}, { timeoutMs: 90_000 });

conformance("config", "an unknown harness the Machine defaults name takes the manual path, never killing the pool", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" } });
  writeFileSync(join(world.home, ".issue-runner"), "harness=does-not-exist\n");
  const server = await t.start(world);
  await conflict(world);
  const manual = await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "merge-conflict"),
    "02's merge-conflict Interrupt",
  );

  expect(manual.phase).not.toBe("dead");
  expect(world.stubs.calls().filter((call) => call.key.endsWith(".resolver"))).toEqual([]);
}, { timeoutMs: 90_000 });

conformance("config", "a resolver set mid-run reaches the next conflict through Config reload", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02", { blockedBy: ["01"] }), ticket("03", { blockedBy: ["01"] })],
    config: { defaults: { harness: "claude", model: "m" }, resolver: "none" },
    repoFiles: { "shared.txt": "base\n" },
  });
  for (const id of ["01", "02", "03"]) world.stubs.script(id, { waitFor: holdFile(world, id) });
  world.stubs.script("03.resolver", { outcome: null, waitFor: holdFile(world, "03.resolver") });
  const server = await t.start(world);
  await untilLaunched(world, "01");
  writeConfig(world, { defaults: { harness: "claude", model: "m" }, resolver: "claude" });
  release(world, "01");
  await conflict(world, "02", "03");
  const [resolver] = await untilLaunched(world, "03.resolver");
  const reloaded = await untilSnapshot(server, (s) => s.state.log.includes("config reloaded: resolver"), "the reload's log line");
  release(world, "03.resolver");

  expect(resolver!.cwd).toContain("03");
  expect(existsSync(join(world.pool, "runs", "03.resolver.log"))).toBe(true);
  expect(readEvents(world.pool, "03").some((event) => event.kind === "resolver")).toBe(true);
  expect(logLines(reloaded, "config reload rejected")).toEqual([]);
}, { timeoutMs: 90_000 });
