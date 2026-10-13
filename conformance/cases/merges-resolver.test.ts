/**
 * The resolver agent, seen from outside the server (ADR-0036): a merge that
 * conflicts hands its parked worktree to the resolver harness named by
 * console.json's resolver=, and what the resolver writes decides between a
 * merge-approval Interrupt and the manual merge-conflict one. Every world
 * here has Tickets 01 and 02 overwrite shared.txt differently; 02 commits
 * only once 01's work is on main, so 01 always merges first and 02 always
 * conflicts.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { anyIsoTime, expectParsedEqual, expectSameBytes, expectSameFile } from "../harness/equal.ts";
import {
  approveReview,
  branches,
  cardOf,
  gitIn,
  gitOk,
  poolLog,
  resume,
  ticketWorktree,
  untilLogged,
  untilState,
  worktreeList,
} from "../harness/git-pool.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { ConformanceStubBehaviour } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";

const marker = (id: string, blockedBy = "none") =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`;

/** Bash that waits, up to twenty seconds, for 01's commit to reach main. */
const AFTER_01_MERGED =
  'for _ in $(seq 1 400); do case "$(git log --format=%s main)" in *work-01*) break;; esac; sleep 0.05; done\n';

/**
 * A resolver that reproduces the conflict, records what it found (MERGE_HEAD
 * and the branch it ran on, per launch, in the stubs directory) and stages
 * `resolution` as shared.txt without committing.
 */
function resolving(resolution: string, note: string, extra: Partial<ConformanceStubBehaviour> = {}): ConformanceStubBehaviour {
  return {
    run: [
      "git merge main >/dev/null 2>&1 || true",
      'git rev-parse --verify -q MERGE_HEAD > "$CONFORMANCE_STUBS/mergehead-$STUB_N" || true',
      'git rev-parse --abbrev-ref HEAD > "$CONFORMANCE_STUBS/branch-$STUB_N"',
      `echo ${resolution} > shared.txt`,
      "git add shared.txt",
    ].join("\n"),
    outcomeRaw: JSON.stringify({ resolved: true, note }),
    ...extra,
  };
}

interface ConflictSpec {
  /** console.json's resolver=; default "claude". */
  resolver?: string;
  /** Add Ticket 03, blocked by 02, committing three.txt. */
  third?: boolean;
  /** The resolver launch's behaviour, keyed 02.resolver; none for no script. */
  resolverStub?: ConformanceStubBehaviour;
  /** 02's work per launch; default one commit of from-02 after 01 lands. */
  run02?: string | string[];
}

function conflictWorld(t: Case, spec: ConflictSpec = {}): World {
  const tickets = [
    { file: "01-t.md", marker: marker("01") },
    { file: "02-t.md", marker: marker("02") },
    ...(spec.third ? [{ file: "03-t.md", marker: marker("03", "02") }] : []),
  ];
  const world = t.world({
    tickets,
    config: { defaults: { harness: "claude", model: "m" }, resolver: spec.resolver ?? "claude" },
    repoFiles: { "shared.txt": "base\n" },
  });
  world.stubs.script("01", { run: "echo from-01 > shared.txt\ngit add -A\ngit commit -qm work-01" });
  world.stubs.script("02", {
    run: spec.run02 ?? `${AFTER_01_MERGED}echo from-02 > shared.txt\ngit add -A\ngit commit -qm work-02`,
  });
  if (spec.third) world.stubs.script("03", { run: "echo three > three.txt\ngit add -A\ngit commit -qm work-03" });
  if (spec.resolverStub) world.stubs.script("02.resolver", spec.resolverStub);
  return world;
}

/** The merge-approval Interrupt's body for 02, whole. */
function approvalBody(world: World, note: string): string {
  const { branch } = ticketWorktree(world.repo, "02");
  return (
    "The resolver agent resolved the merge conflict for ticket 02.\n" +
    `It attempted: ${note}\n` +
    "conflicted files: shared.txt\n" +
    `the resolution is staged on branch ${branch}; approve to commit it and continue, or reject to resolve by hand.`
  );
}

/**
 * The manual merge-conflict Interrupt's body for 02 must be exactly this,
 * ending in what the resolver attempted. Every byte is the server's own but
 * the `git said:` line, which quotes git: its stderr, else its stdout. That
 * quote depends on git's version and on whether `.git/rr-cache` exists yet
 * (rerere then adds "Recorded preimage for 'shared.txt'" on stderr), so it is
 * held only to naming the conflicted file.
 */
function expectManualBody(body: string, world: World, attempted: string): void {
  const { branch, path } = ticketWorktree(world.repo, "02");
  const head =
    `merging ${branch} onto the working branch failed; the merge was aborted and the working branch was left clean.\n` +
    "conflicted files: shared.txt\n" +
    `the ticket's work is parked on branch ${branch}, checked out at ${path}.\n` +
    "git said: ";
  const tail =
    "\nresolve the conflict and resume this ticket; the merge is re-attempted on resume.\n" +
    `The resolver agent attempted: ${attempted}`;
  const said = body.startsWith(head) && body.endsWith(tail) ? body.slice(head.length, body.length - tail.length) : "";
  expect(said, "git's quoted message").toContain("shared.txt");
  expectSameBytes(body, head + said + tail, "the merge-conflict Interrupt's body");
}

/** The state's one Interrupt, a manual merge-conflict on 02, its body checked whole. */
function expectOnlyManual(snapshot: EnrichedSnapshot, world: World, attempted: string): void {
  expect(snapshot.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["02", "merge-conflict"]]);
  expectManualBody(snapshot.state.interrupts[0]!.body, world, attempted);
}

/** The resolver's prompt for 02, whole, as the harness receives it. */
function resolverPrompt(world: World): string {
  const { branch, path } = ticketWorktree(world.repo, "02");
  return [
    `/resolving-merge-conflicts ${join(world.pool, "issues", "02-t.md")}`,
    "",
    "Resolve the git merge conflict for ticket 02.",
    "",
    `You are in the git worktree at ${path}, with branch ${branch} checked out. The pool's working branch is main.`,
    "",
    "To reproduce the conflict, run: git merge main",
    "Then resolve each conflicted file (shared.txt), stage the resolution with git add, and DO NOT commit.",
    "",
    `When you have staged a resolution, write JSON to ${join(world.pool, "runs", "02.resolver.outcome.json")}: ` +
      '{"resolved": true, "note": "what you did, in a sentence or two"}',
    "",
    'If you cannot resolve it, write {"resolved": false, "note": "why"} and exit.',
    "",
  ].join("\n");
}

function untilInterrupt(server: CaseServer, kind: string, ms = 20_000): Promise<EnrichedSnapshot> {
  return untilState(server, (s) => s.state.interrupts.some((i) => i.ticketId === "02" && i.kind === kind), {
    ms,
    what: `02's ${kind} Interrupt`,
  });
}

/** The launches so far by key, the first two (01 and 02, started together) sorted. */
function launchKeys(world: World): string[] {
  const keys = world.stubs.calls().map((call) => call.key);
  return [...keys.slice(0, 2).sort(), ...keys.slice(2)];
}

function eventShape(world: World, id: string): [string, number][] {
  return readEvents(world.pool, id).map((event) => [event.kind, event.attempt]);
}

const stubRecord = (world: World, name: string) => readFileSync(join(world.stubs.dir, name), "utf8").trim();

conformance("merges", "the resolver takes the next attempt number after the implement run, and its approval merges on that attempt", async (t) => {
  const world = conflictWorld(t, { resolverStub: resolving("resolved-by-agent", "kept both lines") });
  const { branch, path } = ticketWorktree(world.repo, "02");
  const server = await t.start(world);
  await untilInterrupt(server, "merge-approval");

  // The implement run is attempt 1; the resolver run is attempt 2.
  const before = readEvents(world.pool, "02");
  expect(eventShape(world, "02")).toEqual([
    ["scheduled", 1],
    ["spawned", 1],
    ["exited", 1],
    ["merge-conflict", 1],
    ["resolver", 2],
    ["spawned", 2],
  ]);
  expectParsedEqual(before[3], { at: anyIsoTime(), attempt: 1, kind: "merge-conflict", payload: { files: ["shared.txt"] } }, "the merge-conflict event");
  expectParsedEqual(before[4], {
    at: anyIsoTime(),
    attempt: 2,
    kind: "resolver",
    payload: { files: ["shared.txt"], cwd: path, branch },
  }, "the resolver event");
  // The resolver's spawned event: its prompt elided from argv, the parked
  // worktree's cwd, branch and commit.
  expectParsedEqual(before[5], {
    at: anyIsoTime(),
    attempt: 2,
    kind: "spawned",
    payload: {
      argv: [
        "claude",
        "-p",
        `/resolving-merge-conflicts ${join(world.pool, "issues", "02-t.md")}\n\n<prompt>`,
        "--model",
        "m",
        "--permission-mode",
        "auto",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      cwd: path,
      branch,
      commitSha: gitIn(world.repo, ["rev-parse", branch]).trim(),
      env: { PWD: path },
      harness: "claude",
      model: "m",
      pid: expect.any(Number),
    },
  }, "the resolver's spawned event");
  // The harness itself got the whole prompt.
  const resolverCall = world.stubs.calls().find((call) => call.key === "02.resolver")!;
  expect(resolverCall.argv[0]).toBe("-p");
  expectSameBytes(resolverCall.argv[1]!, resolverPrompt(world), "the resolver's prompt");

  await resume(server, "02", { action: "approve" });
  await approveReview(server);
  await untilState(server, (s) => s.phase === "done", { what: "done" });

  // Approving answered the Interrupt and merged, both on the resolver's attempt.
  expect(eventShape(world, "02")).toEqual([
    ["scheduled", 1],
    ["spawned", 1],
    ["exited", 1],
    ["merge-conflict", 1],
    ["resolver", 2],
    ["spawned", 2],
    ["answered", 2],
    ["merged", 2],
  ]);
});

conformance("merges", "a resolver whose grandchild holds its stdout open is torn down in time, and its late output still reaches runs/02.resolver.log", async (t) => {
  const world = conflictWorld(t, {
    resolverStub: resolving("resolved-by-resolver", "staged by the pipe holder", {
      run: [
        "bash -c 'sleep 0.3; echo resolver-late-output-from-grandchild; sleep 30' &",
        "git merge main >/dev/null 2>&1 || true",
        "echo resolved-by-resolver > shared.txt",
        "git add shared.txt",
      ].join("\n"),
    }),
  });
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-approval", 30_000);
  // The grandchild sleeps 30 s holding the pipe; the server stops waiting on
  // it well before that, so the approval lands within 10 s of the spawn.
  const spawned = readEvents(world.pool, "02").at(-1)!;
  expect(spawned.kind).toBe("spawned");
  expect(Date.now() - Date.parse(spawned.at)).toBeLessThan(10_000);
  expect(held.state.interrupts).toEqual([
    { ticketId: "02", kind: "merge-approval", body: approvalBody(world, "staged by the pipe holder") },
  ]);
  await until(
    () => readFileSync(join(world.pool, "runs", "02.resolver.log"), "utf8"),
    (log) => log.includes("resolver-late-output-from-grandchild"),
    { what: "the grandchild's line in runs/02.resolver.log" },
  );

  await resume(server, "02", { action: "approve" });
  await approveReview(server);
  await untilState(server, (s) => s.phase === "done", { what: "done" });
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-resolver\n");
});

conformance("merges", "a conflict runs the resolver in the parked worktree, holds the pool on its approval, and approving lands the resolution and continues", async (t) => {
  const world = conflictWorld(t, { third: true, resolverStub: resolving("resolved-by-agent", "kept both lines") });
  const { branch, path } = ticketWorktree(world.repo, "02");
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-approval");

  // One Interrupt, the approval, whole; 03 waits behind the merge hold.
  expect(held.state.interrupts).toEqual([
    { ticketId: "02", kind: "merge-approval", body: approvalBody(world, "kept both lines") },
  ]);
  expect(launchKeys(world)).toEqual(["01", "02", "02.resolver"]);
  expect(cardOf(held, "03").status).toBe("ready");
  // The resolver ran once, in 02's worktree on 02's branch, with the merge in progress.
  const resolverCall = world.stubs.calls().find((call) => call.key === "02.resolver")!;
  expect(resolverCall.cwd).toBe(path);
  expect(stubRecord(world, "branch-1")).toBe(branch);
  expect(stubRecord(world, "mergehead-1")).toBe(gitIn(world.repo, ["rev-parse", "main"]).trim());
  // Nothing of the resolution is on main yet.
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("from-01\n");

  await resume(server, "02", { action: "approve" });
  await untilLogged(server, "interrupt answered for 02 (merge-approval): resolver resolution committed");
  await approveReview(server);
  const done = await untilState(server, (s) => s.phase === "done", { what: "done" });

  expect(done.state.interrupts).toEqual([]);
  expect(cardOf(done, "03").status).toBe("done");
  expect(launchKeys(world)).toEqual(["01", "02", "02.resolver", "03"]);
  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("resolved-by-agent\n");
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-agent\n");
  expect(branches(world.repo, "pool/*")).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(worktreeList(world.repo).length).toBe(1);
});

conformance("merges", "rejecting the resolver's resolution reopens the Ticket with the note, and the re-run's resolved merge completes the pool", async (t) => {
  const world = conflictWorld(t, {
    third: true,
    run02: [
      `${AFTER_01_MERGED}echo from-02 > shared.txt\ngit add -A\ngit commit -qm work-02`,
      "echo from-02-again > shared.txt\ngit add -A\ngit commit -qm work-02-again",
    ],
    resolverStub: resolving("resolved-by-agent", "kept both lines"),
  });
  const { path } = ticketWorktree(world.repo, "02");
  const server = await t.start(world);
  await untilInterrupt(server, "merge-approval");

  await resume(server, "02", { action: "reject", note: "the resolver dropped a field" });
  await untilLogged(server, "merge-approval rejected for 02: staged resolution discarded, ticket reopened for a re-run");
  // The staged resolution is gone and the working branch keeps 01's line.
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("from-01\n");

  // The re-run conflicts again and the resolver runs a second time.
  await until(
    () => world.stubs.calls().filter((call) => call.key === "02.resolver").length,
    (count) => count === 2,
    { ms: 20_000, what: "the second resolver launch" },
  );
  await untilInterrupt(server, "merge-approval");
  await resume(server, "02", { action: "approve" });
  await approveReview(server);
  const done = await untilState(server, (s) => s.phase === "done", { what: "done" });

  expect(done.state.interrupts).toEqual([]);
  expect(cardOf(done, "03").status).toBe("done");
  // 03 launched only after 02's second merge landed.
  expect(launchKeys(world)).toEqual(["01", "02", "02.resolver", "02", "02.resolver", "03"]);
  // The rejection never raised a manual merge-conflict Interrupt.
  expect((await poolLog(server)).filter((line) => line.includes("(merge-conflict)"))).toEqual([]);
  expect(eventShape(world, "02").map(([kind]) => kind)).toEqual([
    "scheduled",
    "spawned",
    "exited",
    "merge-conflict",
    "resolver",
    "spawned",
    "answered",
    "scheduled",
    "spawned",
    "exited",
    "merge-conflict",
    "resolver",
    "spawned",
    "answered",
    "merged",
  ]);
  // The note rides on the Ticket as a resume note.
  expectSameFile(
    join(world.pool, "issues", "02-t.md"),
    `${marker("02").replace("status=ready", "status=done")}\n\n# body\n\n## Resume note\n\nthe resolver dropped a field\n`,
  );
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("resolved-by-agent\n");
  expect(branches(world.repo, "pool/*")).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

conformance("merges", "a resolver that reports no resolution takes the manual path with its note, and a hand merge then resume completes the pool", async (t) => {
  const world = conflictWorld(t, {
    resolverStub: {
      run: "git merge main >/dev/null 2>&1 || true",
      outcomeRaw: JSON.stringify({ resolved: false, note: "could not reconcile the schema" }),
    },
  });
  const { branch } = ticketWorktree(world.repo, "02");
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-conflict");
  expectOnlyManual(held, world, "could not reconcile the schema");

  // The operator merges by hand in the pool checkout and resumes.
  expect(gitOk(world.repo, ["merge", "--no-edit", branch])).toBe(false);
  writeFileSync(join(world.repo, "shared.txt"), "manual\n");
  gitIn(world.repo, ["add", "shared.txt"]);
  gitIn(world.repo, ["commit", "-qm", "resolve 02 by hand"]);
  await resume(server, "02");
  await approveReview(server);
  await untilState(server, (s) => s.phase === "done", { what: "done" });
  expect(readFileSync(join(world.repo, "shared.txt"), "utf8")).toBe("manual\n");
});

conformance("merges", "a resolver Attempt reads as live on its done Ticket, role resolver, started at its spawned event", async (t) => {
  const world = conflictWorld(t);
  const release = join(world.root, "release-resolver");
  world.stubs.script("02.resolver", resolving("resolved-by-agent", "kept both lines", { waitFor: release }));
  const server = await t.start(world);
  const resolvingNow = await untilState(server, (s) => cardOf(s, "02").liveAttempt !== null && cardOf(s, "02").status === "done", {
    ms: 20_000,
    what: "02 done with a live resolver",
  });
  const spawned = readEvents(world.pool, "02").at(-1)!;
  expect(spawned.kind).toBe("spawned");
  const card = cardOf(resolvingNow, "02");
  expect(card.status).toBe("done");
  expect(card.mergeState).toBe("resolving");
  expect(card.liveAttempt).toEqual({ attempt: 2, paneId: null, role: "resolver", startedAt: spawned.at });
  expect(resolvingNow.state.mergeQueue).toEqual([{ ticketId: "02", state: "resolving" }]);

  writeFileSync(release, "");
  const held = await untilInterrupt(server, "merge-approval");
  expect(cardOf(held, "02").liveAttempt).toBeNull();
});

conformance("merges", "a resolver that exits 3 without a resolution takes the manual path with its crash reason, and the merge is aborted in the worktree", async (t) => {
  const world = conflictWorld(t, {
    resolverStub: {
      run: [
        "git merge main >/dev/null 2>&1 || true",
        'git rev-parse --verify -q MERGE_HEAD > "$CONFORMANCE_STUBS/mergehead-$STUB_N" || true',
      ].join("\n"),
      exitCode: 3,
      outcome: null,
    },
  });
  const { path } = ticketWorktree(world.repo, "02");
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-conflict");
  expectOnlyManual(held, world, "resolver exited 3");
  // The resolver left a merge in progress; the server aborted it.
  expect(stubRecord(world, "mergehead-1")).not.toBe("");
  expect(gitOk(path, ["rev-parse", "--verify", "-q", "MERGE_HEAD"])).toBe(false);
  expect(gitIn(path, ["status", "--porcelain"])).toBe("");
});

conformance("merges", "a resolver outcome with no resolved boolean takes the manual path as no resolution", async (t) => {
  const world = conflictWorld(t, { resolverStub: { outcomeRaw: JSON.stringify({ note: "looked at it" }) } });
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-conflict");
  expectOnlyManual(held, world, "resolver produced no resolution");
});

conformance("merges", "resolver none takes the manual path at once and launches no resolver", async (t) => {
  const world = conflictWorld(t, { resolver: "none" });
  const server = await t.start(world);
  const held = await untilInterrupt(server, "merge-conflict");
  expectOnlyManual(held, world, "no resolver harness available (set console.json resolver= or a ~/.issue-runner default)");
  expect(launchKeys(world)).toEqual(["01", "02"]);
  expect(readEvents(world.pool, "02").some((event) => event.kind === "resolver")).toBe(false);
});

conformance("merges", "approving a resolution after main moved on raises a manual merge-conflict in place of the approval", async (t) => {
  const world = conflictWorld(t, { resolverStub: resolving("resolved-by-agent", "kept both lines") });
  const server = await t.start(world);
  await untilInterrupt(server, "merge-approval");

  // Main moves under the staged resolution before the operator approves it.
  writeFileSync(join(world.repo, "shared.txt"), "moved-on-main\n");
  gitIn(world.repo, ["commit", "-qam", "move main on"]);
  await resume(server, "02", { action: "approve" });
  const lines = await untilLogged(server, "merge after resolver approval for 02 still conflicts");
  expect(lines.filter((line) => line.startsWith("merge after resolver approval"))).toEqual([
    "merge after resolver approval for 02 still conflicts",
  ]);
  const held = await untilInterrupt(server, "merge-conflict");
  expectOnlyManual(held, world, "the resolver's resolution did not merge cleanly on approval");
  expect(gitIn(world.repo, ["show", "main:shared.txt"])).toBe("moved-on-main\n");
});
