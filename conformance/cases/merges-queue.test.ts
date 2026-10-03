/**
 * The Merge queue (issue #129, amending ADR-0014), seen from outside the
 * server (ADR-0036): the held tickets in the order the engine took their
 * merges on, each named by where its merge stands, on GET /api/state's
 * `state.mergeQueue`, on each card's `mergeState`, and on the socket.
 *
 * Every conflict here is made the same way: a ticket overwrites shared.txt
 * in its worktree and commits only once an earlier ticket's commit is on
 * main (or once an earlier ticket's marker reads done), so the merges are
 * taken on in a known order and every later one conflicts. A slow resolver
 * is a resolver stub that waits for a release file the case creates.
 */

import { expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState, MergeQueueEntry } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import {
  cardOf,
  gitIn,
  gitOk,
  resume,
  stateOf,
  ticketWorktree,
  untilLogged,
  untilState,
} from "../harness/git-pool.ts";
import type { ConformanceStubBehaviour } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";
import { applySnapshotDelta } from "../fixtures/socket-protocol.ts";

const marker = (id: string, status = "ready", blockedBy = "none") =>
  `<!-- state: id=${id} blocked-by=${blockedBy} status=${status} -->`;

/** Bash that loops, up to thirty seconds, until `body` (a `case` arm set) breaks out. */
const loop = (body: string) => `for _ in $(seq 1 600); do ${body} sleep 0.05; done\n`;

/** Bash that waits for a commit with this subject to reach main. */
const afterOnMain = (subject: string) =>
  loop(`case "$(git log --format=%s main)" in *${subject}*) break;; esac;`);

/** Bash that waits for a Ticket file's marker to read status=done. */
const afterDone = (world: World, file: string) =>
  loop(`case "$(head -n 1 '${join(world.pool, "issues", file)}')" in *status=done*) break;; esac;`);

/** Bash that waits for a file in the stubs directory, the case's release. */
const afterRelease = (name: string) => loop(`[ -e "$CONFORMANCE_STUBS/${name}" ] && break;`);

/** Bash that overwrites shared.txt with this ticket's line and commits it as work-<id>. */
const commitShared = (id: string) => `echo from-${id} > shared.txt\ngit add -A\ngit commit -qm work-${id}\n`;

/** Create the release file a stub waits for. */
function release(world: World, name: string): void {
  writeFileSync(join(world.stubs.dir, name), "");
}

/** A resolver that waits for `release-<id>`, then gives up: the manual path. */
function slowGiveUp(id: string): ConformanceStubBehaviour {
  return {
    run: afterRelease(`release-${id}`),
    outcomeRaw: JSON.stringify({ resolved: false, note: `gave up on ${id}` }),
  };
}

/** A resolver that waits for `release-<id>`, then stages a resolution: the approval path. */
function slowResolve(id: string): ConformanceStubBehaviour {
  return {
    run:
      afterRelease(`release-${id}`) +
      `git merge main >/dev/null 2>&1 || true\necho resolved-${id} > shared.txt\ngit add shared.txt\n`,
    outcomeRaw: JSON.stringify({ resolved: true, note: `resolved ${id}` }),
  };
}

/**
 * A world of ready tickets on a repository holding shared.txt, the stubs
 * scripted by id. `resolver` is console.json's resolver=.
 */
function queueWorld(
  t: Case,
  ids: string[],
  resolver: string,
  extra: { terminal?: boolean } = {},
): World {
  return t.world({
    tickets: ids.map((id) => ({ file: `${id}-t.md`, marker: marker(id) })),
    config: {
      defaults: { harness: "claude", model: "m" },
      resolver,
      ...(extra.terminal ? { terminal: "herdr" } : {}),
    },
    repoFiles: { "shared.txt": "base\n" },
  });
}

/** Each card's mergeState, keyed by id, for the ids asked. */
function mergeStates(snapshot: EnrichedSnapshot, ids: string[]): Record<string, string | null> {
  return Object.fromEntries(ids.map((id) => [id, cardOf(snapshot, id).mergeState]));
}

/** The queue as each card should read it: every queued id's state, every other id null. */
function cardsFor(queue: MergeQueueEntry[], ids: string[]): Record<string, string | null> {
  return Object.fromEntries(ids.map((id) => [id, queue.find((e) => e.ticketId === id)?.state ?? null]));
}

const isResolver = (card: EnrichedTicketState) => card.liveAttempt?.role === "resolver";

const interruptOn = (snapshot: EnrichedSnapshot, id: string, kind: string) =>
  snapshot.state.interrupts.some((i) => i.ticketId === id && i.kind === kind);

/** Wait until the server's resolver for `id` is live and stays the merge it is on. */
function untilResolverLive(server: CaseServer, id: string, ms = 20_000): Promise<EnrichedSnapshot> {
  return untilState(server, (s) => isResolver(cardOf(s, id)), { ms, what: `${id}'s resolver to be live` });
}

/** A held branch for `id`: one commit main lacks, on pool/<key>/<id>, with no worktree. */
function unmergedBranch(world: World, id: string): string {
  const { branch } = ticketWorktree(world.repo, id);
  const sha = world.git(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", `work-${id}`]).trim();
  world.git(["branch", branch, sha]);
  return branch;
}

conformance(
  "merges",
  "publishes the Merge queue in the order it resolves, with the resolver marked on the live attempt (#129)",
  async (t) => {
    const world = queueWorld(t, ["01", "02", "03"], "claude");
    world.stubs.script("01", { run: afterRelease("go") + commitShared("01") });
    for (const id of ["02", "03"]) {
      world.stubs.script(id, { run: afterRelease("go") + afterOnMain("work-01") + commitShared(id) });
      world.stubs.script(`${id}.resolver`, slowResolve(id));
    }
    const server = await t.start(world);
    const socket = await t.socket(server, { visible: true });
    await socket.sync();
    release(world, "go");

    // 02 and 03 both conflict with 01; which exits first is the race, and
    // the queue's order is whichever it was: the order the resolvers run in.
    const firstLive = await untilState(
      server,
      (s) => ["02", "03"].some((id) => isResolver(cardOf(s, id))),
      { ms: 20_000, what: "the first resolver to be live" },
    );
    const first = ["02", "03"].find((id) => isResolver(cardOf(firstLive, id)))!;
    const second = first === "02" ? "03" : "02";
    // Held long enough for the push to carry it before the next step.
    await Bun.sleep(300);
    release(world, `release-${first}`);
    await untilResolverLive(server, second);
    await Bun.sleep(300);
    release(world, `release-${second}`);
    await untilState(
      server,
      (s) => s.state.interrupts.filter((i) => i.kind === "merge-approval").length === 2,
      { ms: 20_000, what: "both merge-approval interrupts" },
    );
    await Bun.sleep(300);
    await socket.sync();

    // The resolvers ran in queue order.
    const resolverLaunches = world.stubs.calls().filter((c) => c.key.endsWith(".resolver"));
    expect(resolverLaunches.map((c) => c.key)).toEqual([`${first}.resolver`, `${second}.resolver`]);

    // Every version of the snapshot the socket carried, in order.
    const snapshots: EnrichedSnapshot[] = [];
    let pushed = null as Parameters<typeof applySnapshotDelta>[0] | null;
    for (const frame of socket.frames) {
      if (frame.type === "snapshot") {
        if (frame.snapshot === null) continue;
        pushed = { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
      } else if (frame.type === "delta") {
        pushed = applySnapshotDelta(pushed!, frame.delta);
      } else {
        continue;
      }
      snapshots.push(pushed.snapshot);
    }
    expect(snapshots.length).toBeGreaterThan(2);
    // Nothing held reads as an empty queue.
    expect(snapshots[0]!.state.mergeQueue).toEqual([]);
    // While the first resolver runs, the second waits behind it with
    // nothing running, and the live attempt says it is a resolver.
    const firstResolving = snapshots.find((s) => isResolver(cardOf(s, first)));
    expect(firstResolving?.state.mergeQueue).toEqual([
      { ticketId: first, state: "resolving" },
      { ticketId: second, state: "queued" },
    ]);
    expect(snapshots.map((s) => s.state.mergeQueue)).toContainEqual([
      { ticketId: first, state: "awaiting-approval" },
      { ticketId: second, state: "resolving" },
    ]);
    expect(snapshots.at(-1)!.state.mergeQueue).toEqual([
      { ticketId: first, state: "awaiting-approval" },
      { ticketId: second, state: "awaiting-approval" },
    ]);
    // Only a done ticket's live attempt is ever a resolver.
    for (const snapshot of snapshots) {
      for (const card of snapshot.state.tickets) {
        if (card.liveAttempt === null) continue;
        expect(card.liveAttempt.role).toBe(card.status === "done" ? "resolver" : "agent");
      }
    }
  },
  { timeoutMs: 60_000 },
);

conformance(
  "merges",
  "orders the held tickets the way the engine took their merges on, and queues the ones it has not reached",
  async (t) => {
    const ids = ["01", "02", "05", "09"];
    const world = queueWorld(t, ids, "claude");
    // 05, 02 and 09 exit done in that order, each after 01 has landed.
    world.stubs.script("01", { run: commitShared("01") });
    world.stubs.script("05", { run: afterOnMain("work-01") + commitShared("05") });
    world.stubs.script("02", { run: afterDone(world, "05-t.md") + commitShared("02") });
    world.stubs.script("09", { run: afterDone(world, "02-t.md") + commitShared("09") });
    for (const id of ["05", "02", "09"]) world.stubs.script(`${id}.resolver`, slowGiveUp(id));
    const server = await t.start(world);

    const during = await untilResolverLive(server, "05");
    const queue: MergeQueueEntry[] = [
      { ticketId: "05", state: "resolving" },
      { ticketId: "02", state: "queued" },
      { ticketId: "09", state: "queued" },
    ];
    expect(during.state.mergeQueue).toEqual(queue);
    expect(mergeStates(during, ids)).toEqual(cardsFor(queue, ids));

    for (const id of ["05", "02", "09"]) release(world, `release-${id}`);
    await untilState(
      server,
      (s) => ["05", "02", "09"].every((id) => interruptOn(s, id, "merge-conflict")),
      { ms: 20_000, what: "a merge-conflict interrupt on each" },
    );
  },
);

conformance(
  "merges",
  "reads resolving from the engine's own handling before the resolver is live, so a slow launch is not a stall",
  async (t) => {
    const world = queueWorld(t, ["01", "02"], "claude", { terminal: true });
    // Terminal-backed, every launch is keyed _claude: the Tickets' run in
    // their worktrees, commit and write their own Outcome, then exit before
    // any TUI comes up. The second launch in 02's worktree is the resolver:
    // it holds the pane until released and never paints claude's ready
    // frame, since the fake paints nothing a pane is not told to.
    world.stubs.script("_claude", {
      run: [
        'id="$(basename "$PWD")"',
        'if [ -e "$CONFORMANCE_STUBS/ran-$id" ]; then',
        `  ${afterRelease("release-02").trim()}`,
        "  exit 0",
        "fi",
        'touch "$CONFORMANCE_STUBS/ran-$id"',
        `if [ "$id" = 02 ]; then ${afterOnMain("work-01").trim()}; fi`,
        'echo "from-$id" > shared.txt',
        "git add -A",
        'git commit -qm "work-$id"',
        `printf '{"status":"done","summary":"s","commitSha":null}' > '${join(world.pool, "runs")}/'"$id.outcome.json"`,
      ].join("\n"),
    });
    // A shell prompt that takes a second to draw stretches the launch before
    // the resolver's wrapper lands, the window a slow terminal opens.
    const herdr = await t.herdr(world, { shellPromptDelayMs: 1_000 });
    const server = await t.start(world, { herdr });

    await untilState(server, (s) => cardOf(s, "02").mergeState === "resolving", {
      ms: 30_000,
      what: "02 to read resolving",
    });
    const readings: { state: string | null; live: boolean; pane: string | null }[] = [];
    let liveSince: number | null = null;
    // Read throughout the launch: until the resolver has been live for two
    // seconds of its readiness wait, the ready frame never having come.
    for (;;) {
      const card = cardOf(await stateOf(server), "02");
      readings.push({ state: card.mergeState, live: isResolver(card), pane: card.liveAttempt?.paneId ?? null });
      if (isResolver(card)) liveSince ??= Date.now();
      if (liveSince !== null && Date.now() - liveSince > 2_000) break;
      if (readings.length > 2_000) throw new Error("the resolver never went live");
      await Bun.sleep(20);
    }
    expect(readings.filter((r) => r.state !== "resolving")).toEqual([]);
    // Some of those readings came before the resolver was live, and some after.
    expect(readings.some((r) => !r.live)).toBe(true);
    expect(readings.some((r) => r.live)).toBe(true);
    // The resolver runs in a herdr pane, and its launch was never answered
    // with a ready frame: still live, still in its readiness wait.
    expect(readings.filter((r) => r.live && r.pane === null)).toEqual([]);
    expect(readings.at(-1)!.live).toBe(true);

    release(world, "release-02");
    const after = await untilState(server, (s) => interruptOn(s, "02", "merge-conflict"), {
      ms: 20_000,
      what: "02's merge-conflict interrupt once the resolver gave up",
    });
    expect(after.state.mergeQueue).toEqual([{ ticketId: "02", state: "needs-you" }]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "merges",
  "names the interrupt a settled head waits at, and keeps its place in the line",
  async (t) => {
    const ids = ["01", "02", "04"];
    const world = queueWorld(t, ids, "claude");
    world.stubs.script("01", { run: commitShared("01") });
    world.stubs.script("02", { run: afterOnMain("work-01") + commitShared("02") });
    world.stubs.script("04", { run: afterDone(world, "02-t.md") + commitShared("04") });
    // 02's resolver stages a resolution; 04's gives up.
    world.stubs.script("02.resolver", slowResolve("02"));
    world.stubs.script("04.resolver", slowGiveUp("04"));
    release(world, "release-02");
    release(world, "release-04");
    const server = await t.start(world);

    const settled = await untilState(
      server,
      (s) => interruptOn(s, "02", "merge-approval") && interruptOn(s, "04", "merge-conflict"),
      { ms: 20_000, what: "02 at merge-approval and 04 at merge-conflict" },
    );
    const queue: MergeQueueEntry[] = [
      { ticketId: "02", state: "awaiting-approval" },
      { ticketId: "04", state: "needs-you" },
    ];
    expect(settled.state.mergeQueue).toEqual(queue);
    expect(mergeStates(settled, ids)).toEqual(cardsFor(queue, ids));
  },
);

conformance(
  "merges",
  "calls a held ticket with nothing running, nothing raised and nothing taken on stalled (#87)",
  async (t) => {
    const ids = ["02", "03"];
    const world = t.world({
      tickets: ids.map((id) => ({ file: `${id}-t.md`, marker: marker(id, "done") })),
      config: { defaults: { harness: "claude", model: "m" }, resolver: "claude" },
    });
    for (const id of ids) unmergedBranch(world, id);
    const server = await t.start(world);

    const held = await untilState(server, (s) => s.state.mergeQueue.length > 0, { what: "the Merge queue" });
    const queue: MergeQueueEntry[] = [
      { ticketId: "02", state: "stalled" },
      { ticketId: "03", state: "stalled" },
    ];
    expect(held.state.mergeQueue).toEqual(queue);
    expect(mergeStates(held, ids)).toEqual(cardsFor(queue, ids));
    expect(held.state.interrupts).toEqual([]);
    expect(world.stubs.calls()).toEqual([]);
  },
);

conformance(
  "merges",
  "leaves out a ticket that landed, and keeps an unfixed re-attempt's place in the line",
  async (t) => {
    const ids = ["01", "02", "04"];
    const world = queueWorld(t, ids, "none");
    world.stubs.script("01", { run: commitShared("01") });
    world.stubs.script("02", { run: afterOnMain("work-01") + commitShared("02") });
    world.stubs.script("04", { run: afterDone(world, "02-t.md") + commitShared("04") });
    const server = await t.start(world);

    const both = await untilState(
      server,
      (s) => interruptOn(s, "02", "merge-conflict") && interruptOn(s, "04", "merge-conflict"),
      { ms: 20_000, what: "merge-conflict interrupts on 02 and 04" },
    );
    expect(both.state.mergeQueue).toEqual([
      { ticketId: "02", state: "needs-you" },
      { ticketId: "04", state: "needs-you" },
    ]);

    // Resumed unfixed, 02's merge is tried again and conflicts again: it is
    // raised again where it stood, not sent to the back.
    await resume(server, "02");
    await untilLogged(server, "merge re-attempt for 02 still conflicts");
    const again = await untilState(server, (s) => interruptOn(s, "02", "merge-conflict"), {
      what: "02's merge-conflict interrupt raised again",
    });
    expect(again.state.mergeQueue).toEqual([
      { ticketId: "02", state: "needs-you" },
      { ticketId: "04", state: "needs-you" },
    ]);

    // Fixed on its branch and resumed, 02 lands and leaves the queue.
    const worktree = ticketWorktree(world.repo, "02").path;
    gitOk(worktree, ["merge", "--no-edit", "main"]);
    writeFileSync(join(worktree, "shared.txt"), "from-01\nfrom-02\n");
    gitIn(worktree, ["add", "shared.txt"]);
    gitIn(worktree, ["commit", "-qm", "fix 02"]);
    await resume(server, "02");
    const landed = await untilState(server, (s) => !s.state.mergeQueue.some((e) => e.ticketId === "02"), {
      what: "02 to land",
    });
    const queue: MergeQueueEntry[] = [{ ticketId: "04", state: "needs-you" }];
    expect(landed.state.mergeQueue).toEqual(queue);
    expect(mergeStates(landed, ids)).toEqual(cardsFor(queue, ids));
  },
);

conformance(
  "merges",
  "is a read: two consecutive queue reads agree, and a dropped ticket keeps its place if held again",
  async (t) => {
    const ids = ["02", "04"];
    const world = queueWorld(t, ids, "none");
    const start = world.git(["rev-parse", "HEAD"]).trim();
    // 02 lands cleanly; 04 commits once 02 is on main and conflicts.
    world.stubs.script("02", { run: commitShared("02") });
    world.stubs.script("04", { run: afterOnMain("work-02") + commitShared("04") });
    const server = await t.start(world);

    await untilState(server, (s) => interruptOn(s, "04", "merge-conflict"), {
      ms: 20_000,
      what: "04's merge-conflict interrupt",
    });
    const first = await stateOf(server);
    const second = await stateOf(server);
    expect(second.state.mergeQueue).toEqual(first.state.mergeQueue);
    expect(first.state.mergeQueue).toEqual([{ ticketId: "04", state: "needs-you" }]);

    // Undo 02's merge by hand: main back to before it, 02's branch back at
    // its old tip. 02 is held again, and the watch notices.
    const tip = world
      .git(["log", "--format=%H %s", "main"])
      .split("\n")
      .find((line) => line.endsWith(" work-02"))!
      .split(" ")[0]!;
    world.git(["reset", "-q", "--hard", start]);
    world.git(["branch", ticketWorktree(world.repo, "02").branch, tip]);
    const queue: MergeQueueEntry[] = [
      { ticketId: "02", state: "stalled" },
      { ticketId: "04", state: "needs-you" },
    ];
    const heldAgain = await untilState(server, (s) => s.state.mergeQueue.length === 2, {
      ms: 6_000,
      what: "the watch to see 02 held again",
    });
    expect(heldAgain.state.mergeQueue).toEqual(queue);
    expect(mergeStates(heldAgain, ids)).toEqual(cardsFor(queue, ids));
    const reread = await stateOf(server);
    expect(reread.state.mergeQueue).toEqual(queue);
  },
);

conformance(
  "merges",
  "is empty when nothing is held, whatever the engine is doing",
  async (t) => {
    const ids = ["01", "02"];
    const world = queueWorld(t, ids, "claude");
    world.stubs.script("01", { run: commitShared("01") });
    world.stubs.script("02", { run: afterOnMain("work-01") + commitShared("02") });
    world.stubs.script("02.resolver", slowGiveUp("02"));
    const server = await t.start(world);

    const resolving = await untilResolverLive(server, "02");
    expect(resolving.state.mergeQueue).toEqual([{ ticketId: "02", state: "resolving" }]);

    // Merge 02's branch into main by hand while its resolver still runs.
    const { branch } = ticketWorktree(world.repo, "02");
    gitOk(world.repo, ["merge", "--no-edit", branch]);
    writeFileSync(join(world.repo, "shared.txt"), "by hand\n");
    world.git(["add", "shared.txt"]);
    world.git(["commit", "-qm", "merge 02 by hand"]);

    // Within a watch interval (2 s), nothing is held.
    const empty = await untilState(server, (s) => s.state.mergeQueue.length === 0, {
      ms: 4_000,
      what: "the Merge queue to empty",
    });
    expect(mergeStates(empty, ids)).toEqual({ "01": null, "02": null });
    // The resolver is still running.
    expect(isResolver(cardOf(empty, "02"))).toBe(true);
    expect(existsSync(join(world.stubs.dir, "release-02"))).toBe(false);

    release(world, "release-02");
    await untilState(server, (s) => cardOf(s, "02").liveAttempt === null, {
      ms: 20_000,
      what: "the resolver to end",
    });
  },
);
