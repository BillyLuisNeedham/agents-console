/**
 * The enlisted Ticket's lifecycle (issue #101), seen from outside the server
 * (ADR-0036): an operator's opencode pane, seeded on the fake herdr, is
 * enlisted as a Ticket over POST /api/enlist, and its endings, merges,
 * checkpoints, Keep talking and restarts are read back through HTTP, the
 * pool's files, the repository and the calls on the herdr socket.
 *
 * The pool is terminal-backed, so an ordinary Attempt (a re-run, an
 * unrelated Ticket) runs the stub `opencode` as an interactive TUI in a pane
 * the fake herdr executes. Its argv names no outcome file, so the case plays
 * the agent's part from outside: it waits for the prompt the engine typed,
 * reads the outcome path from it, writes the Outcome there and lets the stub
 * exit (`releaseAttempt`).
 */

import { expect } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  CloseFinishedTerminalsResponse,
  EnrichedSnapshot,
  EnrichedTicketState,
  KeepTalkingResponse,
} from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { StubCall } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";

// What an opencode pane shows, as the engine's Turn state reads it
// (engine/spawn.ts: opencode's idlePattern is "ctrl+p commands").
const OPENCODE_WORKING = "opencode\nworking on it";
const OPENCODE_WAITING = "opencode\nctrl+p commands";
// What every pane the engine opens shows once the stub's TUI is "up":
// opencode's readyPattern (engine/spawn.ts) and its idle footer.
const OPENCODE_READY = "opencode\nAsk anything\nctrl+p commands";

const STUB_SCRIPT = join(import.meta.dir, "..", "fixtures", "stub-harness.sh");

const DONE = { status: "done", summary: "finished", commitSha: null };

/** A git repository whose pool is terminal-backed, opencode by default. */
function gitTerminalWorld(
  t: Case,
  tickets: { file: string; marker: string }[],
  config: Record<string, unknown> = {},
): World {
  const world = t.world({
    tickets,
    config: { defaults: { harness: "opencode", model: "m" }, terminal: "herdr", ...config },
  });
  holdInteractiveOpencode(world);
  return world;
}

/**
 * The stub `opencode` an interactive launch runs: the stub records the
 * launch and exits, then this wrapper holds the pane open until the case
 * releases it, so the case can write the Outcome before the TUI goes.
 */
function holdInteractiveOpencode(world: World): void {
  // Scripted under its own name, a terminal-backed launch is keyed
  // `_opencode` rather than waiting on its pane for the prompt; the case
  // writes the Outcome itself.
  world.stubs.script("_opencode", {});
  const wrapper = join(world.stubs.bin, "opencode");
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `bash ${JSON.stringify(STUB_SCRIPT)} opencode "$@"`,
      "code=$?",
      "for _ in $(seq 1 2400); do",
      `  [ -e ${JSON.stringify(releaseFile(world))} ] && break`,
      "  sleep 0.05",
      "done",
      'exit "$code"',
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
}

function releaseFile(world: World): string {
  return join(world.root, "release-opencode");
}

/** The fake herdr, every pane it opens showing opencode's ready frame. */
function herdrFor(t: Case, world: World): Promise<HerdrProcess> {
  return t.herdr(world, { rendered: OPENCODE_READY });
}

/** A linked worktree on feature/x with one commit, so the found branch has
 *  something to merge. */
function featureWorktree(world: World): string {
  const worktree = join(world.root, "enlist-life");
  world.git(["worktree", "add", "-q", "-b", "feature/x", worktree]);
  writeFileSync(join(worktree, "enlisted.txt"), "work\n");
  world.git(["-C", worktree, "add", "-A"]);
  world.git(["-C", worktree, "commit", "-qm", "enlist work"]);
  return worktree;
}

/** The operator's opencode pane, waiting on them. */
async function seedPane(
  herdr: HerdrProcess,
  paneId: string,
  tabId: string,
  cwd: string,
  title: string,
  workspaceId?: string,
): Promise<void> {
  await herdr.control("seedAgent", {
    paneId,
    agent: "opencode",
    cwd,
    title,
    status: "idle",
    rendered: OPENCODE_WAITING,
    tabId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  });
}

function enlist(server: CaseServer, body: Record<string, unknown>) {
  return server.http.post("/api/enlist", body);
}

function resume(server: CaseServer, ticketId: string) {
  return server.http.post("/api/resume", { ticketId, action: "resume" });
}

async function snapshotOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const snapshot = (await server.http.get("/api/state")).json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (!snapshot) throw new Error("no snapshot yet");
  return snapshot;
}

async function ticketOf(server: CaseServer, id: string): Promise<EnrichedTicketState | undefined> {
  return (await snapshotOf(server)).state.tickets.find((ticket) => ticket.id === id);
}

function waitForStatus(server: CaseServer, id: string, status: string, ms = 30_000) {
  return until(() => ticketOf(server, id), (ticket) => ticket?.status === status, {
    ms,
    what: `${id} ${status}`,
  });
}

function outcomePath(world: World, id: string): string {
  return join(world.pool, "runs", `${id}.outcome.json`);
}

function writeOutcome(world: World, id: string, outcome: Record<string, unknown>): void {
  writeFileSync(outcomePath(world, id), JSON.stringify(outcome));
}

function kindsOf(world: World, id: string): string[] {
  return readEvents(world.pool, id).map((event) => event.kind);
}

function marker(world: World, id: string): string {
  return readFileSync(join(world.pool, "issues", `${id}.md`), "utf8").split("\n")[0]!;
}

function currentBranch(world: World): string {
  return world.git(["branch", "--show-current"]).trim();
}

function branchNames(world: World): string {
  return world.git(["branch", "--list"]);
}

/** The pool branch the engine made for `id`, `pool/<pool key>/<id>`, or null. */
function poolBranch(world: World, id: string): string | null {
  const names = world
    .git(["branch", "--list", "--format=%(refname:short)", `pool/*/${id}`])
    .split("\n")
    .filter((name) => name !== "");
  return names[0] ?? null;
}

function fileAt(world: World, ref: string, path: string): string {
  const run = Bun.spawnSync(["git", "-C", world.repo, "show", `${ref}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.stdout.toString();
}

function isAncestor(world: World, commit: string, ref: string): boolean {
  return (
    Bun.spawnSync(["git", "-C", world.repo, "merge-base", "--is-ancestor", commit, ref], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0
  );
}

function opencodeLaunches(world: World): StubCall[] {
  return world.stubs.calls().filter((call) => call.key === "_opencode");
}

/**
 * Play the agent of the next interactive Attempt: wait for its launch and
 * the prompt the engine typed into its pane, run `work` in its directory,
 * then write a done Outcome at the path the prompt names and let the TUI
 * exit. Returns the launch.
 */
async function releaseAttempt(
  world: World,
  herdr: HerdrProcess,
  id: string,
  work?: (call: StubCall) => void,
): Promise<StubCall> {
  const call = await until(() => opencodeLaunches(world)[0], (found) => found !== undefined, {
    ms: 60_000,
    what: `the interactive launch for ${id}`,
  });
  const typed = await until(
    () => herdr.control<string[]>("submitted"),
    (texts) => texts.some((text) => text.includes(`/${id}.outcome.json`)),
    { ms: 60_000, what: `the prompt typed for ${id}` },
  );
  const prompt = typed.find((text) => text.includes(`/${id}.outcome.json`))!;
  const path = /outcome as JSON at (\/\S+?\.outcome\.json)/.exec(prompt)![1]!;
  work?.(call!);
  writeFileSync(path, JSON.stringify(DONE));
  writeFileSync(releaseFile(world), "");
  return call!;
}

// engine/server.test.ts:5643
conformance(
  "enlist",
  "enlisted ticket lifecycle › an Outcome of done lands the ticket done, merges the found branch, and leaves the checkout and branch alone",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Do the thing", spec: "" });
    expect(res.status).toBe(201);
    // The enlist itself opens no tab.
    await herdr.settle();
    expect(herdr.calls.some((call) => call.method === "tab.create")).toBe(false);

    writeOutcome(world, "enlist-1", DONE);

    await waitForStatus(server, "enlist-1", "done");
    await until(() => existsSync(join(world.repo, "enlisted.txt")), Boolean, {
      ms: 30_000,
      what: "the found branch merged into the merge target",
    });
    await until(() => kindsOf(world, "enlist-1"), (kinds) => kinds.includes("merged"), { what: "the merged event" });
    const kinds = kindsOf(world, "enlist-1");
    expect(kinds).toContain("scheduled");
    expect(kinds).toContain("spawned");
    expect(kinds).toContain("exited");
    expect(kinds).toContain("merged");
    expect(kinds).not.toContain("crash");
    // Never touched: the found directory, its commit and the found branch.
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, "enlisted.txt"))).toBe(true);
    expect(branchNames(world)).toContain("feature/x");
    // The tab was never closed, nor any other opened.
    await herdr.settle();
    expect(herdr.calls.some((call) => call.method === "tab.close" && call.params.tab_id === "tab-op")).toBe(false);
    expect(herdr.calls.some((call) => call.method === "tab.create")).toBe(false);
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:5709
conformance(
  "enlist",
  "enlisted ticket lifecycle › holds an enlisted ticket's checkpointed pane and keeps talking in it, never closing it (issue #139)",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    expect((await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Talk", spec: "" })).status).toBe(201);

    writeOutcome(world, "enlist-1", { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" });
    // The pane survey runs every 15 s (engine/pane-survey.ts PANE_SURVEY_MS).
    const held = await until(() => ticketOf(server, "enlist-1"), (ticket) => ticket?.heldPane != null, {
      ms: 45_000,
      what: "the enlisted pane held at its checkpoint",
    });
    expect(held!.heldPane).toEqual({ attempt: 1, paneId: "pane-op" });
    // Held, and still the operator's: never a Finished terminal.
    expect((await snapshotOf(server)).finishedTerminals).toBe(0);
    const closed = await server.http.post("/api/terminals/close-finished");
    expect(closed.json<CloseFinishedTerminalsResponse>()).toEqual({ closed: 0 });

    const res = await server.http.post("/api/keep-talking", { ticketId: "enlist-1" });
    expect(res.status).toBe(202);
    expect(res.json<KeepTalkingResponse>()).toEqual({ ticketId: "enlist-1", attempt: 2 });
    await until(
      () => herdr.control<string[]>("submitted"),
      (texts) => texts.some((text) => text.includes(outcomePath(world, "enlist-1"))),
      { ms: 30_000, what: "the teaching Turn typed into the enlisted pane" },
    );
    const talking = await ticketOf(server, "enlist-1");
    expect(talking!.liveAttempt).toMatchObject({ attempt: 2, paneId: "pane-op" });
    // As found, still: the harness herdr named, no model.
    expect(talking!.assignment).toMatchObject({ harness: "opencode", model: null });

    writeOutcome(world, "enlist-1", DONE);
    await waitForStatus(server, "enlist-1", "done");
    await until(() => existsSync(join(world.repo, "enlisted.txt")), Boolean, {
      ms: 30_000,
      what: "the found branch merged",
    });
    expect(existsSync(worktree)).toBe(true);
    expect(branchNames(world)).toContain("feature/x");
    await herdr.settle();
    expect(herdr.calls.some((call) => call.method === "tab.close" && call.params.tab_id === "tab-op")).toBe(false);
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:5771
conformance(
  "enlist",
  "enlisted ticket lifecycle › merges a pane enlisted in the pool's own checkout onto the branch the pool was on",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    // The branch the pool is on when the pane is found. The enlist's branch
    // rule creates a pool branch in this very checkout and moves it there, so
    // the done merge must still land the work back on this branch.
    const target = currentBranch(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-main", "tab-main", world.repo, "OC on main");
    const server = await t.start(world, { herdr });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" });
    expect(res.status).toBe(201);
    // The rule moved the pool's own checkout onto the created pool branch.
    const created = poolBranch(world, "enlist-1");
    expect(created).not.toBeNull();
    expect(currentBranch(world)).toBe(created!);

    // The agent commits its work in the checkout it was moved onto.
    writeFileSync(join(world.repo, "enlisted.txt"), "work\n");
    world.git(["add", "enlisted.txt"]);
    world.git(["commit", "-qm", "enlist work"]);
    const branchSha = world.git(["rev-parse", created!]).trim();

    writeOutcome(world, "enlist-1", DONE);
    await waitForStatus(server, "enlist-1", "done");

    // The commit reached the branch the pool was on, not merely the pool
    // branch that checkout had been moved to.
    await until(() => isAncestor(world, branchSha, target), Boolean, {
      ms: 30_000,
      what: "the found branch's commit on the branch the pool was on",
    });
    expect(fileAt(world, target, "enlisted.txt")).toBe("work\n");
    await until(() => kindsOf(world, "enlist-1"), (kinds) => kinds.includes("merged"), { what: "the merged event" });
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:5841
conformance(
  "enlist",
  "enlisted ticket lifecycle › an ordinary ticket's merge lands on the merge target without moving the checkout an enlisted agent works in",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=checkpoint -->" },
    ]);
    // The pool's files are tracked, as in a pool that is its repository's
    // root: the Ticket file has a pool copy and a branch copy to reconcile
    // at merge (#92).
    writeFileSync(join(world.repo, ".gitignore"), "");
    world.git(["add", "-A"]);
    world.git(["commit", "-qm", "track the pool"]);
    const poolInRepo = relative(world.repo, world.pool);
    const target = currentBranch(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-main", "tab-main", world.repo, "OC on main");
    const server = await t.start(world, { herdr });

    const res = await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" });
    expect(res.status).toBe(201);
    const created = poolBranch(world, "enlist-1");
    expect(created).not.toBeNull();
    expect(currentBranch(world)).toBe(created!);
    // The enlisted agent's work in the checkout the enlist moved: one commit
    // on the created pool branch, one uncommitted file.
    writeFileSync(join(world.repo, "agent.txt"), "agent work\n");
    world.git(["add", "agent.txt"]);
    world.git(["commit", "-qm", "agent work"]);
    writeFileSync(join(world.repo, "wip.txt"), "uncommitted\n");
    const headBefore = world.git(["rev-parse", "HEAD"]).trim();
    // A note on the pool's copy of 01's ticket file, to be reconciled with
    // the branch's copy at merge (#92) even though the merge runs elsewhere.
    appendFileSync(join(world.pool, "issues", "01.md"), "\npool note\n");

    // An unrelated ticket resumes, runs to done and merges while enlist-1 is
    // still live in that checkout.
    expect((await resume(server, "01")).status).toBe(202);
    const call = await releaseAttempt(world, herdr, "01", (launch) => {
      const ticketDir = launch.cwd;
      // The attempt never runs in the checkout the enlisted agent works in.
      expect(realpathSync(ticketDir)).not.toBe(realpathSync(world.repo));
      // The ticket's worktree forks from the merge target, not from the
      // enlisted agent's branch.
      expect(existsSync(join(ticketDir, "agent.txt"))).toBe(false);
      writeFileSync(join(ticketDir, "ordinary.txt"), "01 work\n");
      appendFileSync(join(ticketDir, poolInRepo, "issues", "01.md"), "\nbranch note\n");
      world.git(["-C", ticketDir, "add", "-A"]);
      world.git(["-C", ticketDir, "commit", "-qm", "01 work"]);
    });
    expect(call.key).toBe("_opencode");

    await waitForStatus(server, "01", "done");
    await until(() => fileAt(world, target, "ordinary.txt"), (text) => text === "01 work\n", {
      ms: 30_000,
      what: "01's work on the merge target",
    });
    await until(() => kindsOf(world, "01"), (kinds) => kinds.includes("merged"), { what: "01's merged event" });
    // The enlisted agent's commit did not ride into the merge target.
    expect(fileAt(world, target, "agent.txt")).toBe("");
    // Both sides' notes on the ticket file survive on the pool copy (#92).
    const poolCopy = readFileSync(join(world.pool, "issues", "01.md"), "utf8");
    expect(poolCopy).toContain("pool note");
    expect(poolCopy).toContain("branch note");

    // The enlisted agent's checkout was not moved, not advanced and not
    // written: still on the created pool branch, at the same commit, with
    // its uncommitted work, and without the other ticket's file.
    expect(currentBranch(world)).toBe(created!);
    expect(world.git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(readFileSync(join(world.repo, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(existsSync(join(world.repo, "ordinary.txt"))).toBe(false);
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:5933
conformance(
  "enlist",
  "enlisted ticket lifecycle › a re-run of a created-branch enlist waits as a checkpoint until the checkout is off the branch",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const target = currentBranch(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-main", "tab-main", world.repo, "OC on main");
    const server = await t.start(world, { herdr });
    expect((await enlist(server, { becomes: "ticket", paneId: "pane-main", title: "On main", spec: "" })).status).toBe(201);
    const created = poolBranch(world, "enlist-1");
    expect(created).not.toBeNull();
    expect(currentBranch(world)).toBe(created!);

    // The pane goes before an Outcome: the checkpoint names the created
    // branch and warns that a re-run needs it free.
    await herdr.control("endPane", "pane-main");
    await until(() => marker(world, "enlist-1"), (line) => line.includes("status=checkpoint"), {
      ms: 30_000,
      what: "the pane-gone checkpoint",
    });
    const paneGone = (await snapshotOf(server)).state.interrupts.find((i) => i.ticketId === "enlist-1")!;
    expect(paneGone.body).toContain("branch free");

    // Answering while the checkout still holds the branch: no drive death,
    // a fresh checkpoint naming the directory, and no attempt launched.
    expect((await resume(server, "enlist-1")).status).toBe(202);
    await until(
      () => snapshotOf(server),
      (snapshot) =>
        snapshot.state.interrupts.some((i) => i.ticketId === "enlist-1" && i.body.includes("is checked out in")),
      { ms: 30_000, what: "the held-branch checkpoint" },
    );
    expect(marker(world, "enlist-1")).toContain("status=checkpoint");
    expect(opencodeLaunches(world)).toEqual([]);
    expect(currentBranch(world)).toBe(created!);
    const state = await server.http.get("/api/state");
    expect(state.status).toBe(200);
    expect(
      state.json<{ snapshot: EnrichedSnapshot }>().snapshot.state.log.some((line) => /drive (died|death)/i.test(line)),
    ).toBe(false);

    // The operator moves the checkout off the branch and answers again: the
    // re-run continues on the parked branch and lands on the target.
    world.git(["checkout", "-q", target]);
    expect((await resume(server, "enlist-1")).status).toBe(202);
    const rerun = await releaseAttempt(world, herdr, "enlist-1");
    expect(realpathSync(rerun.cwd)).not.toBe(realpathSync(world.repo));
    await waitForStatus(server, "enlist-1", "done");
    await until(() => kindsOf(world, "enlist-1"), (kinds) => kinds.includes("merged"), {
      ms: 30_000,
      what: "the re-run merged",
    });
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:6011
conformance(
  "restart",
  "enlisted ticket lifecycle › a Conversation-arm enlist in the pool checkout keeps the captured merge target across a restart",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=checkpoint -->" },
    ]);
    const target = currentBranch(world);
    const herdr = await herdrFor(t, world);
    const first = await t.start(world, { herdr });
    await seedPane(herdr, "pane-main", "tab-main", world.repo, "OC on main");
    expect((await enlist(first, { becomes: "conversation", paneId: "pane-main", title: "Talk" })).status).toBe(201);
    const created = poolBranch(world, "conv-1");
    expect(created).not.toBeNull();
    expect(currentBranch(world)).toBe(created!);
    await first.stop();

    const second = await t.start(world, { herdr });
    // A lone ticket resumes after the restart: it still gets a worktree
    // forked from the target, and its merge still lands on the target.
    expect((await resume(second, "01")).status).toBe(202);
    const call = await releaseAttempt(world, herdr, "01", (launch) => {
      expect(realpathSync(launch.cwd)).not.toBe(realpathSync(world.repo));
    });
    expect(call.key).toBe("_opencode");
    await waitForStatus(second, "01", "done");
    await until(() => kindsOf(world, "01"), (kinds) => kinds.includes("merged"), {
      ms: 30_000,
      what: "01 merged",
    });
    expect(currentBranch(world)).toBe(created!);
    const branch01 = poolBranch(world, "01");
    expect(branch01 === null || isAncestor(world, branch01, target)).toBe(true);
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:6075
conformance(
  "enlist",
  "enlisted ticket lifecycle › withholds a ticket blocked by the enlisted one until the merge lands",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=enlist-1 status=ready -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Blocker", spec: "" });
    // 01 waits on enlist-1, which does not exist yet, so it never spawns.
    expect(opencodeLaunches(world)).toEqual([]);

    writeOutcome(world, "enlist-1", DONE);
    await releaseAttempt(world, herdr, "01", () => {
      // 01 runs only once enlist-1's merge has landed.
      expect(kindsOf(world, "enlist-1")).toContain("merged");
      expect(existsSync(join(world.repo, "enlisted.txt"))).toBe(true);
    });
    await waitForStatus(server, "01", "done");
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:6123
conformance(
  "enlist",
  "enlisted ticket lifecycle › raises the checkpoint interrupt with the Outcome's Brief",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Pause for me", spec: "" });

    writeOutcome(world, "enlist-1", {
      status: "checkpoint",
      summary: "paused",
      brief: "Decide the schema before this goes on",
      commitSha: null,
    });
    const snapshot = await until(
      () => snapshotOf(server),
      (got) => got.state.interrupts.some((i) => i.ticketId === "enlist-1"),
      { ms: 30_000, what: "the checkpoint interrupt" },
    );
    const interrupt = snapshot.state.interrupts.find((i) => i.ticketId === "enlist-1")!;
    expect(interrupt.kind).toBe("checkpoint");
    expect(interrupt.body).toContain("Decide the schema");
    expect(marker(world, "enlist-1")).toContain("status=checkpoint");
    expect(readFileSync(join(world.pool, "issues", "enlist-1.md"), "utf8")).toContain("## Brief");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6176
conformance(
  "enlist",
  "enlisted ticket lifecycle › records a tab closed after the Outcome as a trailing exit and changes nothing",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Close me after", spec: "" });
    writeOutcome(world, "enlist-1", DONE);
    await waitForStatus(server, "enlist-1", "done");

    // The operator tidies the tab now the work is finished.
    await herdr.control("endPane", "pane-op");
    await until(
      () => snapshotOf(server),
      (snapshot) => snapshot.state.log.some((line) => line.includes("trailing exit")),
      { ms: 30_000, what: "the trailing exit on the pool log" },
    );
    expect(marker(world, "enlist-1")).toContain("status=done");
    expect(kindsOf(world, "enlist-1")).not.toContain("crash");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6225
conformance(
  "enlist",
  "enlisted ticket lifecycle › checkpoints with the branch kept when the pane goes before an Outcome, and answering re-runs it",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Pane goes first", spec: "" });

    await herdr.control("endPane", "pane-op");
    const snapshot = await until(
      () => snapshotOf(server),
      (got) => got.state.interrupts.some((i) => i.ticketId === "enlist-1"),
      { ms: 30_000, what: "the pane-gone checkpoint" },
    );
    const interrupt = snapshot.state.interrupts.find((i) => i.ticketId === "enlist-1")!;
    expect(interrupt.kind).toBe("checkpoint");
    expect(interrupt.body).toContain("went away");
    expect(interrupt.body).toContain("feature/x");
    expect(marker(world, "enlist-1")).toContain("status=checkpoint");
    // The branch and the checkout are kept.
    expect(existsSync(worktree)).toBe(true);
    expect(branchNames(world)).toContain("feature/x");
    expect(kindsOf(world, "enlist-1")).not.toContain("crash");

    // Answering re-runs the ticket as an ordinary engine-launched attempt.
    expect((await resume(server, "enlist-1")).status).toBe(202);
    await until(
      () => readEvents(world.pool, "enlist-1"),
      (events) => events.some((e) => e.attempt === 2 && e.kind === "spawned"),
      { ms: 60_000, what: "the re-run as an ordinary engine-launched attempt" },
    );
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6289
conformance(
  "enlist",
  "enlisted ticket lifecycle › ignores a verify entry for an enlisted ticket and says so at enlist",
  async (t) => {
    const world = gitTerminalWorld(
      t,
      [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
      { assign: { "enlist-1": { harness: "claude", model: "m", verify: 2 } } },
    );
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    const res = await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Ungraded", spec: "" });
    expect(res.status).toBe(201);
    await until(
      () => snapshotOf(server),
      (snapshot) => snapshot.state.log.some((line) => line.includes("verify: 2 ignored")),
      { ms: 30_000, what: "the ignored-verify log line" },
    );
    // The card's assignment is the as-found one, with no verify.
    const card = (await ticketOf(server, "enlist-1"))!;
    expect(card.assignment.harness).toBe("opencode");
    expect(card.assignment.model).toBeNull();
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6330
conformance(
  "restart",
  "enlisted ticket lifecycle › re-adopts a live enlisted pane after a restart without a tab.create, and its Outcome later ends it",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    const first = await t.start(world, { herdr });
    // The operator's pane sits in the operator's own workspace, never the
    // Pool workspace, so boot reconciliation has to find it with a
    // daemon-wide question rather than a workspace-scoped one.
    const workspaces = await until(() => herdr.control<string[]>("workspaceIds"), (ids) => ids.length > 0, {
      what: "the Pool workspace",
    });
    expect(workspaces[0]).not.toBe("ws-operator");
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC", "ws-operator");
    const res = await enlist(first, { becomes: "ticket", paneId: "pane-op", title: "Survive the restart", spec: "" });
    expect(res.status).toBe(201);
    await herdr.settle();
    const tabsBefore = herdr.calls.filter((call) => call.method === "tab.create").length;
    await first.stop();

    const second = await t.start(world, { herdr });
    await until(() => ticketOf(second, "enlist-1"), (ticket) => ticket?.liveAttempt?.paneId === "pane-op", {
      ms: 30_000,
      what: "the re-adopted enlisted attempt",
    });
    // Re-adopted, not re-launched: no new tab for the enlisted pane.
    await herdr.settle();
    expect(herdr.calls.filter((call) => call.method === "tab.create").length).toBe(tabsBefore);

    writeOutcome(world, "enlist-1", DONE);
    await waitForStatus(second, "enlist-1", "done");
  },
  { timeoutMs: 120_000 },
);

// engine/server.test.ts:6402
conformance(
  "restart",
  "enlisted ticket lifecycle › a re-adopted enlisted pane keeps reporting its Turn state after the restart",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    const first = await t.start(world, { herdr });
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC", "ws-operator");
    expect((await enlist(first, { becomes: "ticket", paneId: "pane-op", title: "Report", spec: "" })).status).toBe(201);
    await first.stop();

    const from = herdr.calls.length;
    const second = await t.start(world, { herdr });
    await until(() => ticketOf(second, "enlist-1"), (ticket) => ticket?.liveAttempt?.paneId === "pane-op", {
      ms: 30_000,
      what: "the re-adopted enlisted attempt",
    });
    const lastReport = (): unknown => {
      const reports = herdr.calls
        .slice(from)
        .filter((call) => call.method === "pane.report_agent" && call.params.pane_id === "pane-op");
      return reports.at(-1)?.params.state ?? null;
    };
    // The pane is waiting on the operator, so the sidebar reads blocked, not
    // a working pinned at boot; and it follows the agent from then on.
    await until(lastReport, (state) => state === "blocked", { ms: 30_000, what: "blocked after the restart" });
    await herdr.control("setPaneContent", "pane-op", OPENCODE_WORKING);
    await until(lastReport, (state) => state === "working", { ms: 30_000, what: "working once the agent replies" });
    await herdr.control("setPaneContent", "pane-op", OPENCODE_WAITING);
    await until(lastReport, (state) => state === "blocked", { ms: 30_000, what: "blocked once it waits again" });
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:6458
conformance(
  "restart",
  "enlisted ticket lifecycle › answering the restart interrupt lets an enlisted pane go without closing it, and the re-run stays out of the found checkout",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    const first = await t.start(world, { herdr });
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC", "ws-operator");
    expect((await enlist(first, { becomes: "ticket", paneId: "pane-op", title: "Let go", spec: "" })).status).toBe(201);
    await first.stop();

    const second = await t.start(world, { herdr });
    const snapshot = await until(
      () => snapshotOf(second),
      (got) => got.state.interrupts.some((i) => i.ticketId === "enlist-1" && i.kind === "checkpoint"),
      { ms: 30_000, what: "the adoption interrupt" },
    );
    const interrupt = snapshot.state.interrupts.find((i) => i.ticketId === "enlist-1")!;
    // The interrupt promises what the answer delivers: the pane is let go.
    expect(interrupt.body).toContain("never closed");
    expect(interrupt.body).not.toContain("the pane is closed");

    expect((await resume(second, "enlist-1")).status).toBe(202);
    const rerun = await releaseAttempt(world, herdr, "enlist-1");
    await until(
      () => readEvents(world.pool, "enlist-1"),
      (events) => events.some((e) => e.attempt === 2 && e.kind === "spawned"),
      { ms: 30_000, what: "the re-run as an ordinary engine-launched attempt" },
    );

    // Never closed, the identity released, attempt 1 recorded no exit, and
    // the re-run launched outside the operator's checkout.
    await herdr.settle();
    expect(herdr.calls.some((call) => call.method === "pane.close" && call.params.pane_id === "pane-op")).toBe(false);
    expect(herdr.calls.some((call) => call.method === "tab.close" && call.params.tab_id === "tab-op")).toBe(false);
    expect(
      herdr.calls.some((call) => call.method === "pane.release_agent" && call.params.pane_id === "pane-op"),
    ).toBe(true);
    const events = readEvents(world.pool, "enlist-1");
    expect(events.some((e) => e.kind === "exited" && e.attempt === 1)).toBe(false);
    const spawned = events.find((e) => e.attempt === 2 && e.kind === "spawned")!;
    const cwd = (spawned.payload as { cwd?: string }).cwd!;
    expect(realpathSync(cwd)).not.toBe(realpathSync(worktree));
    expect(realpathSync(rerun.cwd)).not.toBe(realpathSync(worktree));
    expect(existsSync(worktree)).toBe(true);
    expect(branchNames(world)).toContain("feature/x");
    await waitForStatus(second, "enlist-1", "done");
  },
  { timeoutMs: 150_000 },
);

// engine/server.test.ts:6549
conformance(
  "enlist",
  "enlisted ticket lifecycle › moves the found directory's diff through /api/activity while the attempt runs",
  async (t) => {
    const world = gitTerminalWorld(t, [
      { file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" },
    ]);
    const worktree = featureWorktree(world);
    const herdr = await herdrFor(t, world);
    await seedPane(herdr, "pane-op", "tab-op", worktree, "OC");
    const server = await t.start(world, { herdr });
    await enlist(server, { becomes: "ticket", paneId: "pane-op", title: "Watch the diff", spec: "" });
    writeFileSync(join(worktree, "more.txt"), "one\ntwo\nthree\n");

    const res = await server.http.get("/api/activity?ticket=enlist-1");
    expect(res.status).toBe(200);
    const body = res.json<{ running: boolean; diff: { added: number } | null }>();
    expect(body.running).toBe(true);
    expect(body.diff?.added ?? 0).toBeGreaterThan(0);
  },
  { timeoutMs: 120_000 },
);
