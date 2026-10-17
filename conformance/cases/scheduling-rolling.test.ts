import { expect } from "bun:test";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { ticketWorktree } from "../harness/git-pool.ts";
import { answer, settle, snapshot, statuses, ticketOf } from "../harness/pool-run.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { TicketSeed, World } from "../harness/world.ts";

const CONFIG = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

function ticket(id: string, blockedBy = "none"): TicketSeed {
  return { file: `${id}-t.md`, marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->` };
}

const launches = (world: World): string[] => world.stubs.calls().map((call) => call.key);
const eventKinds = (world: World, id: string): string[] => readEvents(world.pool, id).map((e) => e.kind);
const interrupted = (s: EnrichedSnapshot, id: string, kind: string): boolean =>
  s.state.interrupts.some((i) => i.ticketId === id && i.kind === kind);
const mainSha = (world: World): string => world.git(["rev-parse", "main"]).trim();
const reviewUp = (s: EnrichedSnapshot): boolean => interrupted(s, "REVIEW", "review");

function running(world: World, s: EnrichedSnapshot, id: string): boolean {
  return launches(world).includes(id) && ticketOf(s, id).liveAttempt !== null && !eventKinds(world, id).includes("exited");
}

function commitFile(file: string, content: string, message: string): string {
  return [
    `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(file)}`,
    `git add ${JSON.stringify(file)}`,
    `git commit -qm ${JSON.stringify(message)}`,
  ].join("\n");
}

conformance(
  "scheduling",
  "a Ticket blocked by a fast one starts from the tip its merge made, while a slow unrelated Ticket still runs",
  async (t) => {
    const world = t.world({ tickets: [ticket("01"), ticket("02"), ticket("03", "02")], config: CONFIG });
    const slow = world.stubs.hold("01");
    world.stubs.script("02", { work: { file: "two.txt", line: "two", message: "work-02" } });
    const base = mainSha(world);
    const server = await t.start(world);

    await until(() => launches(world), (keys) => keys.includes("03"), { what: "03 to launch", ms: 30_000 });
    const now = await snapshot(server);
    expect(running(world, now, "01")).toBe(true);
    const merged = mainSha(world);
    expect(merged).not.toBe(base);
    const log = now.state.log;
    const mergedAt = log.findIndex((line) => line.startsWith("ticket 02: merged "));
    expect(mergedAt).toBeGreaterThan(-1);
    expect(log.indexOf(`start 03 at ${merged.slice(0, 7)}`)).toBeGreaterThan(mergedAt);
    const worktree = ticketWorktree(world.repo, "03");
    const spawned = readEvents(world.pool, "03").find((e) => e.kind === "spawned")!;
    expect([spawned.payload.cwd, spawned.payload.branch, spawned.payload.commitSha]).toEqual([
      worktree.path,
      worktree.branch,
      merged,
    ]);

    await until(() => snapshot(server), (s) => statuses(s)["03"] === "done", { what: "03 to finish", ms: 30_000 });
    expect(running(world, await snapshot(server), "01")).toBe(true);
    await slow.release();
    const reviewed = await settle(server, reviewUp, { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done", "03": "done" });
  },
);

conformance(
  "scheduling",
  "a Ticket with no stake in a conflicted merge starts while that merge waits at its Interrupt, and the conflicted Ticket's dependent waits",
  async (t) => {
    const world = t.world({
      tickets: [ticket("01"), ticket("02"), ticket("03", "02"), ticket("04")],
      config: { ...CONFIG, resolver: "none" },
      repoFiles: { "shared.txt": "base\n" },
    });
    world.stubs.script("01", { run: commitFile("shared.txt", "from-01", "work-01") });
    world.stubs.script("02", {
      run: [
        "for _ in $(seq 1 400); do",
        `  git -C ${JSON.stringify(world.repo)} log --format=%s | grep -qx work-01 && break`,
        "  sleep 0.05",
        "done",
        commitFile("shared.txt", "from-02", "work-02"),
      ].join("\n"),
    });
    world.stubs.script("04", { statuses: ["checkpoint", "done"], brief: "go on?" });
    const server = await t.start(world);

    const stuck = await until(
      () => snapshot(server),
      (s) => interrupted(s, "02", "merge-conflict") && interrupted(s, "04", "checkpoint"),
      { what: "02's merge conflict and 04's checkpoint", ms: 30_000 },
    );
    expect(statuses(stuck)).toEqual({ "01": "done", "02": "done", "03": "ready", "04": "checkpoint" });

    await answer(server, { ticketId: "04", note: "yes" });
    const after = await until(() => snapshot(server), (s) => statuses(s)["04"] === "done", {
      what: "04 to run again to done",
      ms: 30_000,
    });
    expect(interrupted(after, "02", "merge-conflict")).toBe(true);
    expect(after.phase).toBe("running");
    expect(launches(world).filter((key) => key === "04")).toHaveLength(2);
    expect(eventKinds(world, "03")).toEqual([]);
    const log = after.state.log;
    const raisedAt = log.findIndex((line) => line.startsWith("interrupt raised for 02 (merge-conflict)"));
    expect(raisedAt).toBeGreaterThan(-1);
    expect(Math.max(...log.map((line, i) => (line.startsWith("start 04 at ") ? i : -1)))).toBeGreaterThan(raisedAt);
    expect(world.git(["show", "main:shared.txt"])).toBe("from-01\n");
  },
);

conformance(
  "scheduling",
  "a crash Interrupt lands at the Attempt's exit and its answer relaunches the Ticket, while a slow sibling still runs",
  async (t) => {
    const world = t.world({ tickets: [ticket("01"), ticket("02")], config: CONFIG });
    const slow = world.stubs.hold("01");
    world.stubs.script("02", { statuses: ["keep", "done"], exitCodes: [3, 0] });
    const server = await t.start(world);

    const crashed = await until(() => snapshot(server), (s) => interrupted(s, "02", "crash"), {
      what: "02's crash Interrupt",
      ms: 30_000,
    });
    expect(running(world, crashed, "01")).toBe(true);
    expect(eventKinds(world, "02")).toEqual(["scheduled", "spawned", "exited", "crash"]);

    await answer(server, { ticketId: "02" });
    const rerun = await until(() => snapshot(server), (s) => statuses(s)["02"] === "done", {
      what: "02 to run again to done",
      ms: 30_000,
    });
    expect(running(world, rerun, "01")).toBe(true);
    expect(rerun.state.interrupts).toEqual([]);
    expect(eventKinds(world, "02")).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "answered",
      "scheduled",
      "spawned",
      "exited",
      "merged",
    ]);

    await slow.release();
    const reviewed = await settle(server, reviewUp, { what: "the Review" });
    expect(statuses(reviewed)).toEqual({ "01": "done", "02": "done" });
  },
);
