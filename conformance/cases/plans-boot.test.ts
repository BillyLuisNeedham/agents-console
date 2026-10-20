import { expect } from "bun:test";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PlanBootResponse } from "../../protocol/wire.ts";
import { bootRecorder, type BootRecorder } from "../harness/boot-recorder.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { World, WorldSpec } from "../harness/world.ts";
import { doneTicket, restedSnapshot } from "./config-support.ts";
import { plan, plansDir, smallPlan, node, edge } from "./plans-support.ts";

async function bootPool(t: Case, spec: WorldSpec = {}): Promise<{ world: World; server: CaseServer; recorder: BootRecorder }> {
  const world = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "m" } }, ...spec });
  const recorder = bootRecorder(world);
  const server = await t.start(world, recorder.start);
  await restedSnapshot(server);
  return { world, server, recorder };
}

conformance("plans", "a Preset boots a Line with the Boot argv, from the main worktree, into a log of its own beside the pool's boot log", async (t) => {
  const { world, server, recorder } = await bootPool(t);
  const poolLog = join(world.pool, "runs", "boot.log");
  writeFileSync(poolLog, "the pool's own boot\n");

  const answer = await server.http.post("/api/plans/boot", { slug: "addy-commands", work: " fix the flaky merge test " });

  expect(answer.status, answer.text).toBe(200);
  const started = answer.json<PlanBootResponse>();
  const argv = ["--plan", "addy-commands", "--work", "fix the flaky merge test", "--yes"];
  expect(started.argv).toEqual(argv);
  expect(started.cwd).toBe(realpathSync(world.repo));
  expect(dirname(realpathSync(started.log))).toBe(realpathSync(join(world.pool, "runs")));
  expect(basename(started.log)).toMatch(/^plans-boot-addy-commands-\d+\.log$/);
  const [call, ...more] = await recorder.handOffs(1);
  expect(more).toEqual([]);
  expect(call).toEqual({ ran: "shim", argv, cwd: realpathSync(world.repo) });
  expect(readFileSync(started.log, "utf8")).toContain(`boot recorder: ${argv.join(" ")}`);
  expect(readFileSync(poolLog, "utf8")).toBe("the pool's own boot\n");
});

conformance("plans", "a Line booted from a Line's own worktree is cut from the repository's main worktree", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const linked = join(world.root, "line-worktree");
  world.git(["worktree", "add", "-q", "-b", "line/186", linked]);
  const pool = join(linked, ".scratch", "pool");
  cpSync(world.pool, pool, { recursive: true });
  const recorder = bootRecorder(world);
  const server = await t.start({ ...world, pool }, recorder.start);

  const answer = await server.http.post("/api/plans/boot", { slug: "factory-today", work: "186" });

  expect(answer.status, answer.text).toBe(200);
  expect(answer.json<PlanBootResponse>().cwd).toBe(realpathSync(world.repo));
  const [call] = await recorder.handOffs(1);
  expect(call!.cwd).toBe(realpathSync(world.repo));
});

conformance("plans", "a library Plan boots the same way over the socket", async (t) => {
  const { server, recorder } = await bootPool(t);
  const socket = await t.socket(server);
  await socket.sync();
  const saved = await socket.request("plans.save", { slug: "my-flow", plan: smallPlan("My flow") });
  expect(saved.ok).toBe(true);

  const reply = await socket.request("plans.boot", { slug: "my-flow", work: "186" });

  if (!reply.ok) throw new Error(`plans.boot was refused: ${JSON.stringify(reply.refusal)}`);
  expect(reply.result.argv).toEqual(["--plan", "my-flow", "--work", "186", "--yes"]);
  const [call] = await recorder.handOffs(1);
  expect(call!.argv).toEqual(reply.result.argv);
});

conformance("plans", "every plans.boot refusal comes before Boot is started", async (t) => {
  const { world, server, recorder } = await bootPool(t);
  mkdirSync(plansDir(world), { recursive: true });
  const invalid = plan([node.agent("a"), node.finish()], [edge("a", "maybe", "finish")], "Broken");
  writeFileSync(join(plansDir(world), "broken.json"), JSON.stringify(invalid));
  writeFileSync(join(plansDir(world), "garbled.json"), "not json");

  const refusals: [unknown, number, string][] = [
    [{ slug: "factory-today", work: "  " }, 400, "needs its work"],
    [{ slug: "factory-today", work: "--yes" }, 400, "--yes"],
    [{ slug: "no-such-plan", work: "x" }, 404, "no Plan"],
    [{ slug: "BAD", work: "x" }, 400, "is not a Plan slug"],
    [{ slug: "broken", work: "x" }, 400, "maybe"],
    [{ slug: "garbled", work: "x" }, 422, "not JSON"],
    [{ slug: "factory-today" }, 400, "work"],
  ];
  for (const [body, status, word] of refusals) {
    const answer = await server.http.post("/api/plans/boot", body);
    expect([JSON.stringify(body), answer.status]).toEqual([JSON.stringify(body), status]);
    expect(answer.json<{ reason: string }>().reason).toContain(word);
  }
  await Bun.sleep(500);
  expect(recorder.calls()).toEqual([]);
});

conformance("plans", "a pool in no git checkout cannot boot a Line, and starts nothing", async (t) => {
  const { server, recorder } = await bootPool(t, { git: false });

  const answer = await server.http.post("/api/plans/boot", { slug: "factory-today", work: "186" });

  expect(answer.status, answer.text).toBe(409);
  expect(answer.json<{ reason: string }>().reason).toContain("no git checkout");
  await Bun.sleep(500);
  expect(recorder.calls()).toEqual([]);
});
