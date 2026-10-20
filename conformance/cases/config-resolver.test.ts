/**
 * The resolver's Assignment, seen from outside the server (ADR-0036): which
 * harness, model and effort a conflicted merge's resolver runs on, from
 * console.json's resolver key, the pool defaults and the Machine defaults,
 * and what an unknown one does. A model or effort reaches the resolver only
 * from a layer its harness owns (ADR-0044), and a resolver left with no model
 * that way stops the pool at load, or takes the manual path when the Machine
 * defaults change under a running pool. Each conflict case makes a real one: 01 and 02
 * run side by side in their own worktrees, the case commits a different
 * shared.txt into each while their stubs are held, and 02 merges second.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { StubCall } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import {
  approveReview,
  flagValue,
  holdFile,
  launchesOf,
  logLines,
  refusedAtLoad,
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

conformance("config", "with no resolver key the resolver runs on the Machine defaults' harness, the legacy file behind them, and only their model", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" } });
  writeFileSync(join(world.home, ".issue-runner"), "harness=opencode\n");
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(join(world.home, ".agent-graphs", "defaults.json"), JSON.stringify({ model: "machine-model", effort: "low" }));
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
  expect(resolver!.harness).toBe("opencode");
  // The pool defaults' model is claude's, so it never reaches an opencode resolver.
  expect(flagValue(resolver!.argv, "--model")).toBe("machine-model");
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

conformance("config", "an explicit resolver naming an unknown harness stops the pool at load, naming it", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" }, resolver: "does-not-exist" });
  const { code, output } = await refusedAtLoad(world);

  expect(code).not.toBe(0);
  expect(output).toContain(`pool config: resolver names unknown harness 'does-not-exist'. ${KNOWN}`);
  expect(world.stubs.calls()).toEqual([]);
});

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

conformance("config", "Machine defaults edited by hand after boot to leave the resolver no model take the manual path at the conflict, naming why", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" } });
  const server = await t.start(world);
  // Booted with no Machine defaults, the resolver has no harness and passes its check. The edit names
  // one that owns no model, and nothing checks the file again before the conflict reads it.
  mkdirSync(join(world.home, ".agent-graphs"), { recursive: true });
  writeFileSync(join(world.home, ".agent-graphs", "defaults.json"), JSON.stringify({ harness: "opencode" }));
  await conflict(world);
  const manual = await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "merge-conflict"),
    "02's merge-conflict Interrupt",
  );

  expect(manual.state.interrupts.find((i) => i.ticketId === "02")!.body).toEndWith(
    "\nThe resolver agent attempted: no resolver could launch: pool config: resolver takes harness 'opencode' " +
      "from the Machine defaults but no model: its model comes from defaults.model, which is for 'claude'. Give " +
      `resolver a model: { "harness": "opencode", "model": "..." }, or set "resolver": "none" for the manual path`,
  );
}, { timeoutMs: 90_000 });

conformance("config", "with no resolver key, Machine defaults on another harness than the defaults' with no model of their own stop the pool at load, naming them", async (t) => {
  const world = conflictingWorld(t, { defaults: { harness: "claude", model: "m" } });
  writeFileSync(join(world.home, ".issue-runner"), "harness=opencode\n");
  const { code, output } = await refusedAtLoad(world);

  expect(code).not.toBe(0);
  expect(output).toContain(
    "pool config: resolver takes harness 'opencode' from the Machine defaults but no model: its model comes from " +
      `defaults.model, which is for 'claude'. Give resolver a model: { "harness": "opencode", "model": "..." }, ` +
      `or set "resolver": "none" for the manual path`,
  );
  expect(world.stubs.calls()).toEqual([]);
});

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

conformance("config", "a resolver on another harness than the defaults' with no model of its own stops the pool at load, naming the fix", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { defaults: { harness: "cursor", model: "auto" }, resolver: "claude" },
  });
  const { code, output } = await refusedAtLoad(world);

  expect(code).not.toBe(0);
  expect(output).toContain(
    "pool config: resolver names harness 'claude' but no model: its model comes from defaults.model, " +
      `which is for 'cursor'. Give resolver a model: { "harness": "claude", "model": "..." }`,
  );
  expect(world.stubs.calls()).toEqual([]);
});

conformance("config", "a resolver on another harness than the defaults' runs on its own model and never on the defaults' model or effort", async (t) => {
  const world = conflictingWorld(t, {
    defaults: { harness: "cursor", model: "auto", effort: "high" },
    resolver: { harness: "claude", model: "opus" },
  });
  world.stubs.script("02.resolver", { outcome: null, waitFor: holdFile(world, "02.resolver") });
  const server = await t.start(world);
  await conflict(world);
  const [resolver] = await untilLaunched(world, "02.resolver");
  resolveAs(world, resolver!, "via its own model");
  release(world, "02.resolver");
  await approveResolution(server);

  expect(resolver!.harness).toBe("claude");
  expect(flagValue(resolver!.argv, "--model")).toBe("opus");
  expect(resolver!.argv).not.toContain("--effort");
  expect(launchesOf(world, "01").map((call) => [call.harness, flagValue(call.argv, "--model")])).toEqual([["agent", "auto"]]);
  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved\n");
}, { timeoutMs: 90_000 });
