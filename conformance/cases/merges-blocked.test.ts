/**
 * Merges git refuses before starting, seen from outside the server
 * (ADR-0036, issue #92): an untracked file in the pool checkout that a
 * Ticket's branch would write, or a tracked file with uncommitted changes
 * there. A byte-identical untracked copy is deleted and the merge lands; a
 * differing one blocks the merge without starting it, raises a manual
 * merge-conflict Interrupt and spawns no resolver; a merge git started and
 * could not finish stays a conflict. Also the Keep talking merges (ADR-0027):
 * a Continued attempt in the pool checkout holds merges into it, and one
 * that ends done in a worktree merges onto the target.
 *
 * The pool lives at <repo>/.scratch/pool, so "the pool checkout" is the
 * world's repository checkout, world.repo. Two Tickets are ready in each
 * world so each runs in its own worktree and merges at the boundary; a lone
 * Ticket runs in the checkout itself.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot } from "../../protocol/wire.ts";
import { conformance, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import {
  approveReview,
  gitIn,
  gitOk,
  poolKey,
  resume,
  ticketWorktree,
  untilState,
  worktreeList,
} from "../harness/git-pool.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

const marker = (id: string, status = "ready") => `<!-- state: id=${id} blocked-by=none status=${status} -->`;

/** Tickets 01 and 02 ready, each in its own worktree once the pool runs. */
const TWO_READY = [
  { file: "01-a.md", marker: marker("01") },
  { file: "02-b.md", marker: marker("02") },
];

/** A pool whose resolver is the stub claude, so a resolver launch would show as `01.resolver`. */
const WITH_RESOLVER = { defaults: { harness: "claude", model: "m" }, resolver: "claude" };
/** A pool with no resolver: a conflict takes the manual path. */
const NO_RESOLVER = { defaults: { harness: "claude", model: "m" }, resolver: "none" };

/** Bash for a stub that writes `path` with `content` in its worktree and commits it. */
function commitFile(path: string, content: string, message: string): string {
  return [
    `mkdir -p "$(dirname ${JSON.stringify(path)})"`,
    // %b turns the backslash escapes JSON.stringify writes back into newlines.
    `printf %b ${JSON.stringify(content)} > ${JSON.stringify(path)}`,
    "git add -A",
    `git commit -qm ${JSON.stringify(message)}`,
  ].join("\n");
}

/** Write a file in the pool checkout without committing it. */
function writeInCheckout(world: World, path: string, content: string): void {
  const full = join(world.repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function readInCheckout(world: World, path: string): string {
  return readFileSync(join(world.repo, path), "utf8");
}

/** Whether a merge is in progress in the pool checkout. */
function mergeInProgress(world: World): boolean {
  return gitOk(world.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
}

function branchExists(world: World, branch: string): boolean {
  return gitOk(world.repo, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`]);
}

/** The launches of a resolver, any Ticket's. */
function resolverLaunches(world: World): string[] {
  return world.stubs
    .calls()
    .map((call) => call.key)
    .filter((key) => key.endsWith(".resolver"));
}

/** The merge-conflict Interrupt on a Ticket, waited for. */
async function untilMergeInterrupt(server: CaseServer, id: string): Promise<EnrichedSnapshot> {
  return untilState(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === id && i.kind === "merge-conflict"),
    { ms: 20_000, what: `a merge-conflict Interrupt on ${id}` },
  );
}

function interruptBody(snapshot: EnrichedSnapshot, id: string): string {
  return snapshot.state.interrupts.find((i) => i.ticketId === id && i.kind === "merge-conflict")!.body;
}

/** A Ticket's event kinds in runs/<id>.events.jsonl. */
function eventKinds(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => event.kind);
}

/** The whole body of a blocked merge's Interrupt (engine/worktrees.ts blockedMergeExplanation). */
function blockedBody(world: World, id: string, files: string[], gitSaid: string): string {
  const { path, branch } = ticketWorktree(world.repo, id);
  return (
    `merging ${branch} onto the working branch was blocked: ` +
    "git refused to start the merge; nothing conflicted and the working branch was not touched.\n" +
    `files in the way: ${files.join(", ")}\n` +
    `these files are untracked in the pool directory (${realpathSync(world.repo)}), ` +
    "or carry uncommitted changes there, and differ from the branch's committed version. " +
    "Move or delete them (commit them if tracked), then resume; the merge is re-attempted on resume.\n" +
    `the ticket's work is parked on branch ${branch}, checked out at ${path}.\n` +
    `git said: ${gitSaid}\n`
  );
}

/** What the server says git said for an untracked copy that differs. */
function untrackedDiffers(files: string[]): string {
  return (
    "untracked files in the checkout would be overwritten by the merge " +
    `and differ from the branch's version: ${files.join(", ")}`
  );
}

conformance(
  "merges",
  "a merge blocked by an untracked pool file raises a manual Interrupt naming it, spawns no resolver, and lands on resume once the file is gone",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: WITH_RESOLVER });
    writeInCheckout(world, "findings/01.md", "stale\n");
    world.stubs.script("01", { run: commitFile("findings/01.md", "fresh\n", "work-01") });
    world.stubs.script("02", { run: commitFile("two.txt", "two\n", "work-02") });
    const server = await t.start(world);

    const snapshot = await untilMergeInterrupt(server, "01");
    // The unrelated Ticket merged past the block.
    await until(() => existsSync(join(world.repo, "two.txt")), (yes) => yes, { what: "02's merge" });
    const { branch } = ticketWorktree(world.repo, "01");
    expect(snapshot.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "merge-conflict"]]);
    expectSameBytes(
      interruptBody(snapshot, "01"),
      blockedBody(world, "01", ["findings/01.md"], untrackedDiffers(["findings/01.md"])),
      "01's merge-conflict Interrupt body",
    );
    expect(eventKinds(world, "01")).toEqual(["scheduled", "spawned", "exited", "merge-blocked"]);
    expect(readEvents(world.pool, "01").at(-1)!.payload).toEqual({ files: ["findings/01.md"] });
    // The resolver was configured and never launched: nothing conflicted.
    expect(resolverLaunches(world)).toEqual([]);
    // The pool checkout was not touched and the branch is parked.
    expect(readInCheckout(world, "findings/01.md")).toBe("stale\n");
    expect(mergeInProgress(world)).toBe(false);
    expect(branchExists(world, branch)).toBe(true);

    rmSync(join(world.repo, "findings", "01.md"));
    await resume(server, "01");
    await approveReview(server);
    const done = await untilState(server, (s) => s.phase === "done", { what: "done" });
    expect(done.state.interrupts).toEqual([]);
    expect(readInCheckout(world, "findings/01.md")).toBe("fresh\n");
    expect(branchExists(world, branch)).toBe(false);
    expect(existsSync(ticketWorktree(world.repo, "01").path)).toBe(false);
    expect(eventKinds(world, "01")).not.toContain("resolver");
    expect(eventKinds(world, "01").at(-1)).toBe("merged");
    expect(resolverLaunches(world)).toEqual([]);
  },
);

conformance(
  "merges",
  "an untracked pool copy identical to the branch's version is deleted and the merge lands without holding",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: WITH_RESOLVER });
    writeInCheckout(world, "findings/01.md", "fresh\n");
    world.stubs.script("01", { run: commitFile("findings/01.md", "fresh\n", "work-01") });
    world.stubs.script("02", { run: commitFile("two.txt", "two\n", "work-02") });
    const server = await t.start(world);

    await approveReview(server);
    const done = await untilState(server, (s) => s.phase === "done", { what: "done" });
    expect(done.state.interrupts).toEqual([]);
    expect(done.state.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ["01", "done"],
      ["02", "done"],
    ]);
    expect(resolverLaunches(world)).toEqual([]);
    expect(readInCheckout(world, "findings/01.md")).toBe("fresh\n");
    expect(gitIn(world.repo, ["ls-files", "findings/01.md"]).trim()).toBe("findings/01.md");
    const merged = readEvents(world.pool, "01").find((event) => event.kind === "merged");
    expect(merged?.payload).toEqual({ cleared: ["findings/01.md"] });
  },
);

conformance(
  "merges",
  "a byte-identical untracked copy is cleared: the merge lands, the file is tracked, the checkout is clean, and the merged event carries cleared",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER });
    writeInCheckout(world, "findings/x.md", "fresh\n");
    world.stubs.script("01", { run: commitFile("findings/x.md", "fresh\n", "work-01") });
    const server = await t.start(world);

    await untilState(server, (s) => s.state.tickets.every((ticket) => ticket.status === "done"), { what: "both done" });
    await until(() => readEvents(world.pool, "01"), (events) => events.some((e) => e.kind === "merged"), {
      what: "01's merged event",
    });
    expect(readInCheckout(world, "findings/x.md")).toBe("fresh\n");
    expect(gitIn(world.repo, ["ls-files", "findings/x.md"]).trim()).toBe("findings/x.md");
    expect(gitIn(world.repo, ["status", "--porcelain"])).toBe("");
    const merged = readEvents(world.pool, "01").find((event) => event.kind === "merged");
    expect(merged?.payload).toEqual({ cleared: ["findings/x.md"] });
    expect(eventKinds(world, "01")).not.toContain("merge-blocked");
  },
);

conformance(
  "merges",
  "a differing untracked copy blocks the merge without starting it, and the merge lands on resume once it is gone",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER });
    writeInCheckout(world, "findings/x.md", "stale\n");
    world.stubs.script("01", { run: commitFile("findings/x.md", "fresh\n", "work-01") });
    const headBefore = world.git(["rev-parse", "HEAD"]).trim();
    const server = await t.start(world);

    const snapshot = await untilMergeInterrupt(server, "01");
    expect(interruptBody(snapshot, "01")).toContain("findings/x.md");
    const blocked = readEvents(world.pool, "01").filter((event) => event.kind === "merge-blocked");
    expect(blocked.map((event) => event.payload)).toEqual([{ files: ["findings/x.md"] }]);
    expect(eventKinds(world, "01")).not.toContain("merge-conflict");
    // Nothing was touched: the copy, HEAD, and no merge in progress.
    expect(readInCheckout(world, "findings/x.md")).toBe("stale\n");
    expect(world.git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(mergeInProgress(world)).toBe(false);

    rmSync(join(world.repo, "findings", "x.md"));
    await resume(server, "01");
    await until(() => readEvents(world.pool, "01"), (events) => events.some((e) => e.kind === "merged"), {
      ms: 20_000,
      what: "01's merged event",
    });
    expect(readInCheckout(world, "findings/x.md")).toBe("fresh\n");
    // Nothing was cleared: the file was gone before the merge.
    expect(readEvents(world.pool, "01").find((event) => event.kind === "merged")!.payload).toEqual({});
  },
);

conformance("merges", "untracked pool files the branch does not touch are left alone and do not block", async (t) => {
  const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER });
  writeInCheckout(world, "notes.md", "mine\n");
  world.stubs.script("01", { run: commitFile("findings/x.md", "fresh\n", "work-01") });
  const server = await t.start(world);

  await until(() => readEvents(world.pool, "01"), (events) => events.some((e) => e.kind === "merged"), {
    ms: 20_000,
    what: "01's merged event",
  });
  const snapshot = await untilState(server, (s) => s.state.tickets.every((ticket) => ticket.status === "done"), {
    what: "both done",
  });
  expect(snapshot.state.interrupts.filter((i) => i.kind === "merge-conflict")).toEqual([]);
  expect(readInCheckout(world, "findings/x.md")).toBe("fresh\n");
  expect(readInCheckout(world, "notes.md")).toBe("mine\n");
  expect(readEvents(world.pool, "01").find((event) => event.kind === "merged")!.payload).toEqual({});
});

conformance(
  "merges",
  "a merge git refused for uncommitted changes to a tracked file is blocked, not conflicted",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER, repoFiles: { "base.txt": "base\n" } });
    world.stubs.script("01", { run: commitFile("base.txt", "from-branch\n", "work-01") });
    // A tracked file with local changes the branch would overwrite.
    writeInCheckout(world, "base.txt", "dirty\n");
    const server = await t.start(world);

    const snapshot = await untilMergeInterrupt(server, "01");
    const blocked = readEvents(world.pool, "01").filter((event) => event.kind === "merge-blocked");
    expect(blocked.map((event) => event.payload)).toEqual([{ files: ["base.txt"] }]);
    expect(eventKinds(world, "01")).not.toContain("merge-conflict");
    // The Interrupt carries git's own refusal as what git said.
    const gitSaid =
      "error: Your local changes to the following files would be overwritten by merge:\n" +
      "\tbase.txt\n" +
      "Please commit your changes or stash them before you merge.\n" +
      "Aborting";
    expectSameBytes(
      interruptBody(snapshot, "01"),
      blockedBody(world, "01", ["base.txt"], gitSaid),
      "01's merge-conflict Interrupt body",
    );
    expect(readInCheckout(world, "base.txt")).toBe("dirty\n");
    expect(mergeInProgress(world)).toBe(false);
  },
);

conformance(
  "merges",
  "a merge git started and could not finish is a conflict: it is aborted and the Interrupt lists the conflicted file",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER, repoFiles: { "base.txt": "base\n" } });
    const moved = join(world.root, "main-moved");
    // 01 commits its change, then main moves on the same line while 01 is
    // still running; 02 waits for that, so no merge races the commit.
    world.stubs.script("01", {
      run: [
        commitFile("base.txt", "from-branch\n", "work-01"),
        `printf 'from-main\\n' > ${JSON.stringify(join(world.repo, "base.txt"))}`,
        `git -C ${JSON.stringify(world.repo)} commit -qam "main moves"`,
        `touch ${JSON.stringify(moved)}`,
      ].join("\n"),
    });
    world.stubs.script("02", { waitFor: moved });
    const server = await t.start(world);

    const snapshot = await untilMergeInterrupt(server, "01");
    const conflicts = readEvents(world.pool, "01").filter((event) => event.kind === "merge-conflict");
    expect(conflicts.map((event) => event.payload)).toEqual([{ files: ["base.txt"] }]);
    expect(eventKinds(world, "01")).not.toContain("merge-blocked");
    expect(mergeInProgress(world)).toBe(false);
    expect(readInCheckout(world, "base.txt")).toBe("from-main\n");
    expect(resolverLaunches(world)).toEqual([]);
    const { path, branch } = ticketWorktree(world.repo, "01");
    const gitSaid =
      "Auto-merging base.txt\n" +
      "CONFLICT (content): Merge conflict in base.txt\n" +
      "Automatic merge failed; fix conflicts and then commit the result.";
    expectSameBytes(
      interruptBody(snapshot, "01"),
      `merging ${branch} onto the working branch failed; the merge was aborted and the working branch was left clean.\n` +
        "conflicted files: base.txt\n" +
        `the ticket's work is parked on branch ${branch}, checked out at ${path}.\n` +
        `git said: ${gitSaid}\n` +
        "resolve the conflict and resume this ticket; the merge is re-attempted on resume.\n" +
        "The resolver agent attempted: no resolver harness available " +
        "(set console.json resolver= or a ~/.issue-runner default)",
      "01's merge-conflict Interrupt body",
    );
  },
);

conformance(
  "merges",
  "a blocked merge's Interrupt says git refused to start it, nothing conflicted, lists the files in the way, names the pool directory, and re-attempts on resume",
  async (t) => {
    const world = t.world({ tickets: TWO_READY, config: NO_RESOLVER });
    writeInCheckout(world, "findings/x.md", "stale\n");
    world.stubs.script("01", { run: commitFile("findings/x.md", "fresh\n", "work-01") });
    const server = await t.start(world);

    const snapshot = await untilMergeInterrupt(server, "01");
    expect(poolKey(world.repo)).toBe(ticketWorktree(world.repo, "01").key);
    expectSameBytes(
      interruptBody(snapshot, "01"),
      blockedBody(world, "01", ["findings/x.md"], untrackedDiffers(["findings/x.md"])),
      "01's merge-conflict Interrupt body",
    );
    // The worktree is still registered for the resume.
    expect(worktreeList(world.repo).map((entry) => entry.path)).toContain(ticketWorktree(world.repo, "01").path);
    expect(readStateLine(world.pool, "01-a.md").status).toBe("done");
  },
);

// Keep talking (ADR-0027) over the fake herdr. The stub claude in a pane
// stays alive the way an interactive harness does, until the case writes the
// quit file; the case writes each Outcome itself, as the agent in the TUI
// would. Its claude ready frame lets the engine type the prompt.
const READY_FRAME = "Claude Code v1\n❯ ";
const TERMINAL = { defaults: { harness: "claude", model: "m" }, terminal: "herdr" as const };

/** Script every terminal-backed claude launch to stay up until `quit` exists. */
function stayAlive(world: World): string {
  const quit = join(world.root, "quit");
  world.stubs.script("_claude", {
    run: `for _ in $(seq 1 1200); do [ -e ${JSON.stringify(quit)} ] && exit 0; sleep 0.05; done`,
  });
  return quit;
}

/** Write a Ticket's Outcome where its prompt told the agent to. */
function writeOutcome(world: World, id: string, outcome: Record<string, unknown>): void {
  writeFileSync(join(world.pool, "runs", `${id}.outcome.json`), JSON.stringify(outcome));
}

/** Commit `file` in a checkout, as the agent working there would. */
function commitIn(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), "work\n");
  gitIn(cwd, ["add", file]);
  gitIn(cwd, ["commit", "-qm", `add ${file}`]);
}

/** Wait until the fake herdr has seen `count` submitted inputs (prompts and Turns). */
async function untilSubmitted(herdr: { control<T>(name: string): Promise<T> }, count: number): Promise<void> {
  await until(() => herdr.control<string[]>("submitted"), (sent) => sent.length >= count, {
    ms: 20_000,
    what: `${count} submitted inputs on the fake herdr`,
  });
}

const CHECKPOINT = { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" };

conformance(
  "merges",
  "a Continued attempt in the pool checkout holds merges into it until it ends",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: marker("01"), body: "# Talk it through\n\nbody" }],
      config: TERMINAL,
    });
    const quit = stayAlive(world);
    const herdr = await t.herdr(world, { rendered: READY_FRAME });
    const server = await t.start(world, { herdr });
    try {
      // 01 runs alone, so in the pool checkout.
      await untilSubmitted(herdr, 1);
      const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
      expect(spawned.payload.cwd).toBe(world.repo);
      writeOutcome(world, "01", CHECKPOINT);
      await untilState(server, (s) => s.state.tickets.find((x) => x.id === "01")?.heldPane != null, {
        ms: 20_000,
        what: "01's Held pane",
      });

      const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
      expect(talk.status).toBe(202);
      expect(talk.json<unknown>()).toEqual({ ticketId: "01", attempt: 2 });

      // A Conversation works in its own worktree meanwhile.
      const started = await server.http.post("/api/conversations", { title: "Side work" });
      expect(started.status).toBeLessThan(300);
      const id = started.json<{ conversation: { id: string } }>().conversation.id;
      const worktree = ticketWorktree(world.repo, id).path;
      await until(() => existsSync(worktree), (yes) => yes, { what: "the Conversation's worktree" });
      commitIn(worktree, "side.txt");
      const ended = await server.http.post("/api/conversations/end", { id });
      expect(ended.status).toBeLessThan(300);
      // Its merge waits at the pool checkout's gate while 01 talks there.
      // A Conversation's End records no merge-deferred event (a Ticket's
      // held merge does), so the case looks for the merge after a while.
      await until(() => readEvents(world.pool, id), (events) => events.some((e) => e.kind === "end-requested"), {
        what: "the Conversation's end-requested event",
      });
      await Bun.sleep(500);
      expect(existsSync(join(world.repo, "side.txt"))).toBe(false);
      expect(readEvents(world.pool, id).some((e) => e.kind === "merged")).toBe(false);

      writeOutcome(world, "01", { status: "done", summary: "talked", commitSha: null });
      await until(() => readEvents(world.pool, id), (events) => events.some((e) => e.kind === "ended"), {
        ms: 20_000,
        what: "the Conversation's held merge and ending",
      });
      expect(existsSync(join(world.repo, "side.txt"))).toBe(true);
      const ending = readEvents(world.pool, id).filter((e) => e.kind === "merged" || e.kind === "ended");
      expect(ending.map((e) => [e.kind, e.payload])).toEqual([
        ["merged", {}],
        ["ended", { closing: null, by: "operator", merged: true }],
      ]);
      await untilState(server, (s) => s.state.tickets.find((x) => x.id === "01")?.status === "done", {
        what: "01 done",
      });
    } finally {
      writeFileSync(quit, "");
    }
  },
);

conformance(
  "merges",
  "a Continued attempt that ends done in a worktree merges onto the target",
  async (t) => {
    const world = t.world({
      tickets: [
        { file: "01-a.md", marker: marker("01"), body: "# First\n\nbody" },
        { file: "02-b.md", marker: marker("02"), body: "# Second\n\nbody" },
      ],
      config: TERMINAL,
    });
    const quit = stayAlive(world);
    const herdr = await t.herdr(world, { rendered: READY_FRAME });
    const server = await t.start(world, { herdr });
    try {
      await untilSubmitted(herdr, 2);
      const worktree = ticketWorktree(world.repo, "01").path;
      const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
      expect(spawned.payload.cwd).toBe(worktree);
      writeOutcome(world, "01", CHECKPOINT);
      writeOutcome(world, "02", { status: "done", summary: "done", commitSha: null });
      await untilState(server, (s) => s.state.tickets.find((x) => x.id === "01")?.heldPane != null, {
        ms: 20_000,
        what: "01's Held pane",
      });

      const talk = await server.http.post("/api/keep-talking", { ticketId: "01" });
      expect(talk.status).toBe(202);
      commitIn(worktree, "continued.txt");
      writeOutcome(world, "01", { status: "done", summary: "talked", commitSha: null });

      await until(() => readEvents(world.pool, "01"), (events) => events.some((e) => e.kind === "merged"), {
        ms: 20_000,
        what: "01's merged event",
      });
      expect(existsSync(join(world.repo, "continued.txt"))).toBe(true);
      await untilState(server, (s) => s.state.tickets.find((x) => x.id === "01")?.status === "done", {
        what: "01 done",
      });
    } finally {
      writeFileSync(quit, "");
    }
  },
);
