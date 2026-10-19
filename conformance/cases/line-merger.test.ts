/**
 * A per-item node's Merger (ADR-0040, ADR-0041), seen from outside the server. Without one every
 * copy hands on alone, a Ticket per settled copy. With one the Line writes the next Ticket when the
 * whole pass has merged, and a merge conflict on a copy is decided by the Merger's `conflict`
 * policy when it happens: `wait` raises the plain merge-conflict Interrupt and runs no resolver, so
 * the pass holds; a resolver runs on the Merger's harness, model and effort, each field it leaves
 * empty falling through to console.json's resolver. Line start refuses a Merger whose resolver
 * names a harness the machine lacks.
 *
 * Every conflict here has copies 1 and 2 commit different text to shared.txt in their worktrees,
 * held until the case lets 1 merge first.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { gitIn, gitOk, resume, ticketWorktree, untilState } from "../harness/git-pool.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import { snapshot, statuses } from "../harness/pool-run.ts";
import type { World } from "../harness/world.ts";
import { MOMENT_MS, hasIssue, copiesPlan, makingItems, pieces, untilLaunched, type CopiesPlan } from "./line-copies-support.ts";
import { atCheckpoint, begun, issue, launches, lineWorld } from "./line-support.ts";

const raisedOn = (id: string, kind: string) => (snap: EnrichedSnapshot) =>
  snap.state.interrupts.some((i) => i.ticketId === id && i.kind === kind);

/**
 * A Line over two copies that conflict on shared.txt, begun on a Plan with `merger`: the case
 * commits each copy's text in its worktree, lets build-1.1 end and merge, then build-1.2, whose
 * merge conflicts.
 */
async function conflicting(
  t: Case,
  merger: CopiesPlan["merger"],
  config: PoolConfig,
): Promise<{ world: World; server: CaseServer }> {
  const world = lineWorld(t, null, { "shared.txt": "base\n" }, config);
  world.stubs.script("tasks-1", makingItems(pieces(2)));
  const holds = [world.stubs.hold("build-1.1"), world.stubs.hold("build-1.2")];
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 2, merger }), work: "#1" });

  await untilLaunched(world, ["build-1.1", "build-1.2"]);
  const [one, two] = ["build-1.1", "build-1.2"].map((key) => world.stubs.calls().find((call) => call.key === key)!);
  for (const [call, text] of [[one!, "from-1"], [two!, "from-2"]] as const) {
    writeFileSync(join(call.cwd, "shared.txt"), `${text}\n`);
    world.git(["-C", call.cwd, "add", "shared.txt"]);
    world.git(["-C", call.cwd, "commit", "-qm", `work ${text}`]);
  }
  await holds[0]!.release();
  await until(() => world.git(["show", "main:shared.txt"]), (text) => text === "from-1\n", { what: "build-1.1's merge into main" });
  await holds[1]!.release();
  return { world, server };
}

/** A resolver that reproduces the conflict in the copy's worktree and stages `resolved` without committing. */
function resolving(note: string) {
  return {
    run: ["git merge main >/dev/null 2>&1 || true", "echo resolved-by-merger > shared.txt", "git add shared.txt"].join("\n"),
    outcomeRaw: JSON.stringify({ resolved: true, note }),
  };
}

conformance("line", "with no Merger every settled copy hands on alone: a downstream Ticket per copy, each blocked by its own", async (t) => {
  const world = lineWorld(t, null);
  world.stubs.script("tasks-1", makingItems(pieces(3)));
  const server = await t.start(world);
  await begun(server, { plan: copiesPlan({ cap: 1 }), work: "#1" });

  const done = await atCheckpoint(server, "finish-1");
  expect(statuses(done)).toEqual({
    "tasks-1": "done",
    "build-1.1": "done",
    "build-1.2": "done",
    "build-1.3": "done",
    "check-1": "done",
    "check-2": "done",
    "check-3": "done",
    "finish-1": "checkpoint",
  });
  for (const n of [1, 2, 3]) {
    expect(readStateLine(world.pool, `check-${n}.md`).line).toBe(
      `<!-- state: id=check-${n} blocked-by=build-1.${n} status=done node=check -->`,
    );
  }
  expect(launches(world).filter((key) => key.startsWith("check-"))).toEqual(["check-1", "check-2", "check-3"]);
  expect(launches(world).filter((key) => key.startsWith("build-"))).toEqual(["build-1.1", "build-1.2", "build-1.3"]);
});

conformance("line", "conflict wait raises the plain merge-conflict Interrupt on the copy, runs no resolver, and holds the pass until the operator merges", async (t) => {
  // A console resolver is set, so a resolver that never launches is the Merger's doing.
  const { world, server } = await conflicting(t, { conflict: "wait" }, { defaults: { harness: "claude", model: "m" }, resolver: "claude" });

  const held = await untilState(server, raisedOn("build-1.2", "merge-conflict"), { what: "build-1.2's merge-conflict" });
  const { branch } = ticketWorktree(world.repo, "build-1.2");
  const body = held.state.interrupts.find((i) => i.ticketId === "build-1.2")!.body;
  expect(body).toStartWith(`merging ${branch} onto the working branch failed; the merge was aborted and the working branch was left clean.\nconflicted files: shared.txt\n`);
  expect(body).toEndWith("\nresolve the conflict and resume this ticket; the merge is re-attempted on resume.");
  expect(body).not.toContain("resolver");
  expect(held.state.interrupts.map((i) => i.ticketId)).toEqual(["build-1.2"]);

  await Bun.sleep(MOMENT_MS);
  expect(world.stubs.calls().map((call) => call.key).filter((key) => key.endsWith(".resolver"))).toEqual([]);
  expect(readEvents(world.pool, "build-1.2").map((event) => event.kind)).not.toContain("resolver");
  expect(readEvents(world.pool, "build-1.2").map((event) => event.kind)).toContain("merge-conflict");
  expect(statuses(await snapshot(server))["build-1.2"]).toBe("done");
  expect(hasIssue(world.pool, "check-1")).toBe(false);
  expect(launches(world)).not.toContain("check-1");

  // The operator merges by hand and resumes: the merge lands and the pass hands on.
  expect(gitOk(world.repo, ["merge", "--no-edit", branch])).toBe(false);
  writeFileSync(join(world.repo, "shared.txt"), "by-hand\n");
  gitIn(world.repo, ["add", "shared.txt"]);
  gitIn(world.repo, ["commit", "-qm", "merge build-1.2 by hand"]);
  await resume(server, "build-1.2");
  await atCheckpoint(server, "finish-1");
  expect(readStateLine(world.pool, "check-1.md").blockedBy).toEqual(["build-1.1", "build-1.2"]);
  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("by-hand\n");
});

conformance("line", "a Merger's resolver runs on its own harness and model, an empty field falling through to console.json's resolver", async (t) => {
  const { world, server } = await conflicting(
    t,
    { conflict: { resolver: { harness: "opencode", model: "merger-model" } } },
    { defaults: { harness: "claude", model: "m" }, resolver: { harness: "claude", model: "console-model", effort: "low" } },
  );
  world.stubs.script("build-1.2.resolver", resolving("kept the Merger's lines"));

  const approval = await untilState(server, raisedOn("build-1.2", "merge-approval"), { what: "build-1.2's merge-approval" });
  expect(approval.state.interrupts.find((i) => i.ticketId === "build-1.2")!.body).toStartWith(
    "The resolver agent resolved the merge conflict for ticket build-1.2.\nIt attempted: kept the Merger's lines\n",
  );
  const resolvers = world.stubs.calls().filter((call) => call.key.endsWith(".resolver"));
  expect(resolvers.map((call) => call.key)).toEqual(["build-1.2.resolver"]);
  const resolver = resolvers[0]!;
  expect(resolver.harness).toBe("opencode");
  const flag = (name: string) => resolver.argv[resolver.argv.indexOf(name) + 1];
  expect(flag("--model")).toBe("merger-model");
  expect(flag("--variant")).toBe("low");
  expect(resolver.cwd).toBe(ticketWorktree(world.repo, "build-1.2").path);
  expect(hasIssue(world.pool, "check-1")).toBe(false);

  await resume(server, "build-1.2", { action: "approve" });
  await atCheckpoint(server, "finish-1");
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-merger\n");
  expect(readStateLine(world.pool, "check-1.md").blockedBy).toEqual(["build-1.1", "build-1.2"]);
  expect(issue(world, "check-1")).toContain("# check-1: check, pass 1");
});

conformance("line", "a Merger left on its default resolver runs the pool's resolver", async (t) => {
  const { world, server } = await conflicting(
    t,
    true,
    { defaults: { harness: "claude", model: "m" }, resolver: { harness: "opencode", model: "console-model" } },
  );
  world.stubs.script("build-1.2.resolver", resolving("kept both"));

  await untilState(server, raisedOn("build-1.2", "merge-approval"), { what: "build-1.2's merge-approval" });
  const resolver = world.stubs.calls().find((call) => call.key === "build-1.2.resolver")!;
  expect(resolver.harness).toBe("opencode");
  expect(resolver.argv[resolver.argv.indexOf("--model") + 1]).toBe("console-model");
});
