/**
 * The Notices a parent Conversation is told (ADR-0018), seen from outside
 * the server (ADR-0036): the Turn the server types into the parent's pane
 * when a Ticket or Conversation it spawned ends. Rows of the
 * `conversations` area, ticket C17, in the Rust port inventory
 * (docs/research/rust-port/test-inventory.md), from engine/notices.test.ts's
 * text builders.
 *
 * Every Notice is pinned byte for byte (the inventory's Decided 4): its
 * whole text is written out here as the Bun server types it, with only the
 * run's own branch names and git's diff stat substituted. A spawned Ticket's
 * title is the heading the server wrote into its file, which leads with the
 * Ticket's id. The parent's pane reads busy until a case has every Notice it
 * wants queued, then idle, and each queued Notice is typed as its own Turn.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { ticketWorktree } from "../harness/git-pool.ts";
import { answerPrompt, doneOutcome } from "../harness/herdr-tui.ts";
import { readMarkers, until } from "../harness/pool-files.ts";
import {
  BODY,
  IDLE,
  checkpointOutcome,
  conversationEndedText,
  proposeSpawns,
  show,
  startConversation,
  startTalk,
  state,
  ticketClosedText,
  ticketEndedText,
  untilEvent,
  untilNoticesInto,
  untilSpawned,
  viewIn,
} from "./conversations-support.ts";

/** Each Notice typed against its whole expected text, the count included. */
function expectNotices(typed: string[], expected: string[]): void {
  expect(typed.length, `the Notices typed: ${JSON.stringify(typed)}`).toBe(expected.length);
  typed.forEach((turn, i) => expectSameBytes(turn, expected[i]!, `Notice ${i + 1}`));
}

// notices.test.ts:44, :130
conformance(
  "conversations",
  "a spawned Ticket that merged done is told by id, title, outcome, branch and git's diff stat, with no Brief",
  async (t) => {
    const { world, herdr, server } = await startTalk(t);
    const parent = await startConversation(server, { title: "Planner" });
    const before = world.git(["rev-parse", "main"]).trim();

    // Two at once, so each runs in a worktree of its own: a lone Ticket runs
    // in the pool checkout and has no branch to merge. The second pauses,
    // which ends the super-step the merge waits for.
    proposeSpawns(world, "conv-1", [
      { title: "Add a line", body: BODY },
      { title: "Pause after", body: BODY },
    ]);
    await answerPrompt(herdr, "conv-1-spawn-1", doneOutcome(), {
      ms: 30_000,
      // The agent's work: a.txt, committed on the Ticket's own branch.
      before: async () => {
        const spawned = await untilSpawned(world, "conv-1-spawn-1");
        writeFileSync(join(spawned.cwd, "a.txt"), "one\ntwo\n");
        world.git(["-C", spawned.cwd, "add", "a.txt"]);
        world.git(["-C", spawned.cwd, "commit", "-qm", "a.txt"]);
      },
    });
    await until(() => readMarkers(world.pool)["conv-1-spawn-1"]?.status, (status) => status === "done", {
      ms: 30_000,
      what: "conv-1-spawn-1 done",
    });
    await answerPrompt(herdr, "conv-1-spawn-2", checkpointOutcome("later"), { ms: 30_000 });
    await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "merged", "conv-1-spawn-1 merged");
    await untilEvent(world, "conv-1-spawn-2", (e) => e.kind === "checkpoint", "conv-1-spawn-2's checkpoint");
    await show(herdr, parent.paneId!, IDLE);

    // The pause is told at its exit and the merge at the super-step's end,
    // so which is typed first is left open: each is matched whole.
    const typed = (await untilNoticesInto(herdr, parent.paneId!, 2)).sort();
    // git's own stat of what the merge brought onto main, trimmed.
    const diff = world.git(["diff", "--stat", `${before}..main`]).trim();
    expect(diff).toContain("a.txt");
    const done = ticketEndedText({
      id: "conv-1-spawn-1",
      title: "conv-1-spawn-1: Add a line",
      outcome: "done",
      branch: ticketWorktree(world.repo, "conv-1-spawn-1").branch,
      diff,
    });
    expectNotices(typed, [
      done,
      ticketEndedText({
        id: "conv-1-spawn-2",
        title: "conv-1-spawn-2: Pause after",
        outcome: "checkpoint",
        brief: "later",
        branch: ticketWorktree(world.repo, "conv-1-spawn-2").branch,
        diff: "(no changes)",
      }),
    ]);
    expect(done).not.toContain("Brief:");
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:60, :139, and the Brief placeholder its hidden row
// (notices.test.ts:73) says the server always writes in a missing Brief's place.
conformance(
  "conversations",
  "a checkpoint is told with its Brief or the server's placeholder, and a diff git finds empty or cannot compute reads (no changes)",
  async (t) => {
    const { world, herdr, server } = await startTalk(t);
    const parent = await startConversation(server, { title: "Planner" });

    proposeSpawns(world, "conv-1", [
      { title: "Ask first", body: BODY },
      { title: "Lose the branch", body: BODY },
      { title: "Say nothing", body: BODY },
    ]);
    // No commits on its branch: git's diff of it is empty.
    await answerPrompt(herdr, "conv-1-spawn-1", checkpointOutcome("Needs a human decision on retry policy."), {
      ms: 30_000,
    });
    await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "checkpoint", "conv-1-spawn-1's checkpoint");
    // The agent renames its own branch before it pauses, so the branch the
    // server names in the diff no longer exists and git refuses the diff
    // (the inventory's seam for this row, reached from the agent's side).
    await answerPrompt(herdr, "conv-1-spawn-2", checkpointOutcome("Branch gone."), {
      ms: 30_000,
      before: async () => {
        const spawned = await untilSpawned(world, "conv-1-spawn-2");
        world.git(["-C", spawned.cwd, "branch", "-m", "renamed-by-the-agent"]);
      },
    });
    await untilEvent(world, "conv-1-spawn-2", (e) => e.kind === "checkpoint", "conv-1-spawn-2's checkpoint");
    // A checkpoint written with no brief is told with the placeholder the
    // server writes into the Ticket file in its place.
    await answerPrompt(herdr, "conv-1-spawn-3", { status: "checkpoint", summary: "paused", commitSha: null }, { ms: 30_000 });
    await untilEvent(world, "conv-1-spawn-3", (e) => e.kind === "checkpoint", "conv-1-spawn-3's checkpoint");
    await show(herdr, parent.paneId!, IDLE);

    const typed = await untilNoticesInto(herdr, parent.paneId!, 3);
    expectNotices(typed, [
      ticketEndedText({
        id: "conv-1-spawn-1",
        title: "conv-1-spawn-1: Ask first",
        outcome: "checkpoint",
        brief: "Needs a human decision on retry policy.",
        branch: ticketWorktree(world.repo, "conv-1-spawn-1").branch,
        diff: "(no changes)",
      }),
      ticketEndedText({
        id: "conv-1-spawn-2",
        title: "conv-1-spawn-2: Lose the branch",
        outcome: "checkpoint",
        brief: "Branch gone.",
        branch: ticketWorktree(world.repo, "conv-1-spawn-2").branch,
        diff: "(no changes)",
      }),
      ticketEndedText({
        id: "conv-1-spawn-3",
        title: "conv-1-spawn-3: Say nothing",
        outcome: "checkpoint",
        brief:
          "The agent signalled a checkpoint but wrote no brief, so what the attempt completed is only in " +
          "the ticket log. Answer the interrupt to point the next attempt.",
        branch: ticketWorktree(world.repo, "conv-1-spawn-3").branch,
        diff: "(no changes)",
      }),
    ]);
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:86, :92
conformance(
  "conversations",
  "a spawned Ticket closed at its checkpoint is told unmerged, with its trimmed note or no note line",
  async (t) => {
    const { world, herdr, server } = await startTalk(t);
    const parent = await startConversation(server, { title: "Planner" });

    proposeSpawns(world, "conv-1", [
      { title: "Keep it", body: BODY },
      { title: "Old idea", body: BODY },
    ]);
    await answerPrompt(herdr, "conv-1-spawn-1", checkpointOutcome("one"), { ms: 30_000 });
    await untilEvent(world, "conv-1-spawn-1", (e) => e.kind === "checkpoint", "conv-1-spawn-1's checkpoint");
    await answerPrompt(herdr, "conv-1-spawn-2", checkpointOutcome("two"), { ms: 30_000 });
    await untilEvent(world, "conv-1-spawn-2", (e) => e.kind === "checkpoint", "conv-1-spawn-2's checkpoint");

    const closeOld = await server.http.post("/api/resume", {
      ticketId: "conv-1-spawn-2",
      action: "close",
      note: "  superseded by 3 ",
    });
    expect(closeOld.status, closeOld.text).toBe(202);
    await until(() => readMarkers(world.pool)["conv-1-spawn-2"]?.status, (status) => status === "closed", {
      what: "conv-1-spawn-2 closed",
    });
    const closeKept = await server.http.post("/api/resume", { ticketId: "conv-1-spawn-1", action: "close", note: " " });
    expect(closeKept.status, closeKept.text).toBe(202);
    await until(() => readMarkers(world.pool)["conv-1-spawn-1"]?.status, (status) => status === "closed", {
      what: "conv-1-spawn-1 closed",
    });
    await show(herdr, parent.paneId!, IDLE);

    const typed = await untilNoticesInto(herdr, parent.paneId!, 4);
    const checkpointOf = (id: string, title: string, brief: string): string =>
      ticketEndedText({
        id,
        title,
        outcome: "checkpoint",
        brief,
        branch: ticketWorktree(world.repo, id).branch,
        diff: "(no changes)",
      });
    expectNotices(typed, [
      checkpointOf("conv-1-spawn-1", "conv-1-spawn-1: Keep it", "one"),
      checkpointOf("conv-1-spawn-2", "conv-1-spawn-2: Old idea", "two"),
      ticketClosedText("conv-1-spawn-2", "conv-1-spawn-2: Old idea", "superseded by 3"),
      ticketClosedText("conv-1-spawn-1", "conv-1-spawn-1: Keep it"),
    ]);
  },
  { timeoutMs: 120_000 },
);

// notices.test.ts:100, :106
conformance(
  "conversations",
  "a spawned Conversation the operator ended is told by its branch, with its trimmed closing note when it has one",
  async (t) => {
    const { world, herdr, server } = await startTalk(t);
    const parent = await startConversation(server, { title: "Planner" });

    const endChild = async (id: string, closing?: string): Promise<string> => {
      const child = await until(
        async () => viewIn(await state(server), id),
        (view) => view.status === "live",
        { ms: 30_000, what: `${id} live` },
      );
      const branch = child.branch!;
      const ended = await server.http.post("/api/conversations/end", { id, ...(closing !== undefined ? { closing } : {}) });
      expect(ended.status, ended.text).toBe(202);
      await untilEvent(world, id, (e) => e.kind === "ended", `${id} ended`);
      return branch;
    };

    proposeSpawns(world, "conv-1", [{ title: "Side talk", body: BODY, kind: "conversation" }]);
    const first = await endChild("conv-1-spawn-1");
    proposeSpawns(world, "conv-1", [{ title: "Another talk", body: BODY, kind: "conversation" }]);
    const second = await endChild("conv-1-spawn-2", "  all wrapped up  ");
    await show(herdr, parent.paneId!, IDLE);

    const typed = await untilNoticesInto(herdr, parent.paneId!, 2);
    expect(first).toBe(ticketWorktree(world.repo, "conv-1-spawn-1").branch);
    expect(second).toBe(ticketWorktree(world.repo, "conv-1-spawn-2").branch);
    expectNotices(typed, [conversationEndedText(first), conversationEndedText(second, "all wrapped up")]);
    expect(typed[0]).not.toContain("Closing note");
  },
  { timeoutMs: 120_000 },
);
