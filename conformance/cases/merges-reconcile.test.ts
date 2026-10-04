/**
 * Ticket file reconcile at merge (#92), seen from outside the server
 * (ADR-0036). The pool's Ticket file is the file of record; an Attempt in a
 * worktree gets a seed copy of it at the same path relative to the
 * worktree, and whatever the agent adds to either copy must be in the file
 * of record once its branch merges.
 *
 * The engine places the worktree copy at the Ticket file's path relative
 * to the pool directory, under the worktree's root. That lines up with the
 * committed file only when the pool directory is the checkout root and its
 * issues/ are tracked, the layout the original engine tests used. So these
 * cases run their pool at the world's repository root (not the usual
 * gitignored .scratch/pool), with issues/ and console.json committed on
 * main before the server starts.
 *
 * Every case runs two ready Tickets, so each gets its own worktree: a lone
 * ready Ticket runs in the pool checkout and has no copy to reconcile.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Case } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes, expectSameFile } from "../harness/equal.ts";
import {
  approveReview,
  poolLog,
  stateOf,
  ticketWorktree,
  untilState,
} from "../harness/git-pool.ts";
import { readEvents, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";

/** Every Ticket's body, as the original tests seeded it. */
const BODY = "# Ticket\n\n## Acceptance\n\n1. Do A\n2. Do B\n";

function stateLine(id: string, status: string): string {
  return `<!-- state: id=${id} blocked-by=none status=${status} -->`;
}

/** A Ticket file as seeded: the state line, a blank line, the body and one more newline. */
function ticketFile(id: string, status: string, body = BODY): string {
  return `${stateLine(id, status)}\n\n${body}\n`;
}

/** What one Ticket's agent does in its worktree before it writes its done Outcome. */
interface AgentWork {
  /** Appended to the worktree copy, then committed. */
  ticketAppend?: string;
  /** A literal replacement in the worktree copy, then committed. */
  ticketReplace?: [string, string];
  /** Appended to the pool copy through the absolute path the prompt names. */
  poolAppend?: string;
  /** A literal replacement in the pool copy. */
  poolReplace?: [string, string];
  /** The work file it commits. */
  workFile: string;
  /** Once its edits are made and committed, touch `<stubs>/edited-<id>` and
   *  wait for `<stubs>/release-<id>` before ending. */
  hold?: boolean;
}

/** A bash single-quoted word; none of the texts here hold a single quote. */
function quoted(text: string): string {
  if (text.includes("'")) throw new Error(`cannot single-quote ${text}`);
  return `'${text}'`;
}

/** Text for printf '%b': its newlines as backslash escapes. */
function escaped(text: string): string {
  return quoted(text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n"));
}

/** The stub's run script for an agent's work: the worktree copy sits at the
 *  Ticket file's name under issues/ in the launch's cwd, the pool copy is
 *  STUB_ISSUE. The replacement keeps the file's trailing newlines exactly,
 *  which $(...) alone would strip. */
function agentScript(id: string, work: AgentWork): string {
  const lines = [
    'wt_ticket="issues/$(basename "$STUB_ISSUE")"',
    'replace_in() { local f="$1" from="$2" to="$3" c; c="$(cat "$f"; printf x)"; c="${c%x}"; printf \'%s\' "${c//"$from"/"$to"}" > "$f"; }',
  ];
  if (work.ticketAppend !== undefined) {
    lines.push(`printf '%b' ${escaped(work.ticketAppend)} >> "$wt_ticket"`, 'git add "$wt_ticket"');
  }
  if (work.ticketReplace) {
    const [from, to] = work.ticketReplace;
    lines.push(`replace_in "$wt_ticket" ${quoted(from)} ${quoted(to)}`, 'git add "$wt_ticket"');
  }
  if (work.poolAppend !== undefined) {
    lines.push(`printf '%b' ${escaped(work.poolAppend)} >> "$STUB_ISSUE"`);
  }
  if (work.poolReplace) {
    const [from, to] = work.poolReplace;
    lines.push(`replace_in "$STUB_ISSUE" ${quoted(from)} ${quoted(to)}`);
  }
  lines.push(
    `printf 'work\\n' > ${quoted(work.workFile)}`,
    `git add ${quoted(work.workFile)}`,
    `git commit -qm ${quoted(`work-${id}`)}`,
  );
  if (work.hold) {
    lines.push(
      `touch "$CONFORMANCE_STUBS/edited-${id}"`,
      `for _ in $(seq 1 600); do [ -e "$CONFORMANCE_STUBS/release-${id}" ] && break; sleep 0.05; done`,
      `[ -e "$CONFORMANCE_STUBS/release-${id}" ]`,
    );
  }
  return lines.join("\n");
}

/**
 * A world whose pool is its repository root: Tickets 01 and 02 ready with
 * the same body, issues/ and console.json committed on main, and each
 * Ticket's agent scripted. Start the server with `{ pool: world.repo }`.
 */
function trackedPool(t: Case, work: Record<"01" | "02", AgentWork>): World {
  const world = t.world();
  mkdirSync(join(world.repo, "issues"), { recursive: true });
  for (const id of ["01", "02"] as const) {
    writeFileSync(join(world.repo, "issues", `${id}-t.md`), ticketFile(id, "ready"));
  }
  writeFileSync(
    join(world.repo, "console.json"),
    JSON.stringify({ defaults: { harness: "claude", model: "m" } }, null, 2),
  );
  world.git(["add", "-A"]);
  world.git(["commit", "-qm", "pool"]);
  for (const id of ["01", "02"] as const) {
    world.stubs.script(id, { run: agentScript(id, work[id]) });
  }
  return world;
}

const DEFAULT_02: AgentWork = { workFile: "two.txt" };

/** Approve Review and wait for the run to end done. */
async function runToDone(server: Awaited<ReturnType<Case["start"]>>): Promise<void> {
  await approveReview(server);
  await untilState(server, (s) => s.phase === "done", { what: "the run to end done" });
}

function eventKinds(world: World, id: string): string[] {
  return readEvents(world.repo, id).map((event) => event.kind);
}

/** A merges case the server does not pass yet: a visible todo in the run,
 *  and a real case under CONFORMANCE_PENDING=1. */
function pending(name: string, body: (t: Case) => Promise<void>): void {
  if (process.env.CONFORMANCE_PENDING === "1") conformance("merges", name, body);
  else test.todo(`[merges] ${name}`, () => {});
}

conformance(
  "merges",
  "carries notes and ticks committed to the worktree copy into the file of record",
  async (t) => {
    const note = "\n## Notes\n\n- field id is customfield_10020\n";
    const world = trackedPool(t, {
      "01": { workFile: "one.txt", ticketAppend: note, ticketReplace: ["1. Do A", "1. [x] Do A"] },
      "02": DEFAULT_02,
    });
    const server = await t.start(world, { pool: world.repo });
    await runToDone(server);

    const snapshot = await stateOf(server);
    expect(snapshot.state.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ["01", "done"],
      ["02", "done"],
    ]);
    expectSameFile(
      join(world.repo, "issues", "01-t.md"),
      `${ticketFile("01", "done", BODY.replace("1. Do A", "1. [x] Do A"))}${note}`,
    );
    // The merge commit and the disk agree on the body; the committed copy
    // keeps the state line the worktree was seeded with.
    expectSameBytes(
      world.git(["show", "HEAD:issues/01-t.md"]),
      `${ticketFile("01", "ready", BODY.replace("1. Do A", "1. [x] Do A"))}${note}`,
      "HEAD:issues/01-t.md",
    );
    expect(eventKinds(world, "01")).not.toContain("ticket-file-conflict");
    expect(existsSync(join(world.repo, "issues", "01-t.md.pool-aside"))).toBe(false);
    // The seed the reconcile used is kept under runs/.
    expectSameFile(join(world.repo, "runs", "01.seed.md"), ticketFile("01", "ready"));
    // The untouched Ticket is exactly as before, its status aside.
    expectSameFile(join(world.repo, "issues", "02-t.md"), ticketFile("02", "done"));
  },
);

conformance(
  "merges",
  "keeps notes written to the pool copy through the absolute path",
  async (t) => {
    const note = "\n## Notes\n\n- written to the file of record\n";
    const world = trackedPool(t, {
      "01": { workFile: "one.txt", poolAppend: note },
      "02": DEFAULT_02,
    });
    const server = await t.start(world, { pool: world.repo });
    await runToDone(server);

    expectSameFile(join(world.repo, "issues", "01-t.md"), `${ticketFile("01", "done")}${note}`);
    expect(eventKinds(world, "01")).not.toContain("ticket-file-conflict");
  },
);

conformance("merges", "keeps edits to different regions of both copies", async (t) => {
  const note = "\n## Notes\n\n- pool-side note\n";
  const world = trackedPool(t, {
    "01": { workFile: "one.txt", ticketReplace: ["1. Do A", "1. [x] Do A"], poolAppend: note },
    "02": DEFAULT_02,
  });
  const server = await t.start(world, { pool: world.repo });
  await runToDone(server);

  expectSameFile(
    join(world.repo, "issues", "01-t.md"),
    `${ticketFile("01", "done", BODY.replace("1. Do A", "1. [x] Do A"))}${note}`,
  );
  expect(eventKinds(world, "01")).not.toContain("ticket-file-conflict");
});

/** The file of record after both copies rewrote `1. Do A`, the conflict left in it. */
function conflictedFile(branch: string): string {
  const body =
    "# Ticket\n\n## Acceptance\n\n" +
    "<<<<<<< pool (file of record)\n1. [ ] Do A (skipped)\n=======\n1. [x] Do A\n" +
    `>>>>>>> branch ${branch}\n2. Do B\n`;
  return ticketFile("01", "done", body);
}

function conflictingWork(): Record<"01" | "02", AgentWork> {
  return {
    "01": {
      workFile: "one.txt",
      ticketReplace: ["1. Do A", "1. [x] Do A"],
      poolReplace: ["1. Do A", "1. [ ] Do A (skipped)"],
    },
    "02": DEFAULT_02,
  };
}

conformance(
  "merges",
  "leaves conflict markers and a ticket-file-conflict event when both copies changed the same lines, raising no Interrupt",
  async (t) => {
    const world = trackedPool(t, conflictingWork());
    const branch = ticketWorktree(world.repo, "01").branch;
    const server = await t.start(world, { pool: world.repo });

    // Up to the Review gate no Interrupt but Review is ever raised: the file
    // says it all, and the pool is not held.
    const atReview = await untilState(
      server,
      (s) => s.state.interrupts.length > 0,
      { ms: 20_000, what: "the first Interrupt" },
    );
    expect(atReview.state.interrupts.map((interrupt) => [interrupt.kind, interrupt.ticketId])).toEqual([
      ["review", "REVIEW"],
    ]);
    expect(atReview.state.mergeQueue).toEqual([]);
    await runToDone(server);

    const snapshot = await stateOf(server);
    expect(snapshot.state.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([
      ["01", "done"],
      ["02", "done"],
    ]);
    expectSameFile(join(world.repo, "issues", "01-t.md"), conflictedFile(branch));
    const conflicts = readEvents(world.repo, "01").filter((event) => event.kind === "ticket-file-conflict");
    expect(conflicts.map((event) => event.payload)).toEqual([{ file: "issues/01-t.md", branch }]);
    expect(eventKinds(world, "01")).not.toContain("merge-conflict");
  },
);

conformance(
  "merges",
  "a Ticket file conflict at merge is named in the pool log with the file it left markers in",
  async (t) => {
    const world = trackedPool(t, conflictingWork());
    const server = await t.start(world, { pool: world.repo });
    await runToDone(server);

    const line =
      "01: the pool's ticket file and the branch's copy changed the same lines; " +
      "conflict markers left in issues/01-t.md";
    const lines = await poolLog(server);
    expect(lines.filter((entry) => entry.includes(line))).toHaveLength(1);
  },
);

/**
 * PENDING A SERVER FIX. The Bun server loses the branch's edits here: with
 * no seed kept, ticketSeedFor (engine/engine.ts:6054-6082) asks git for
 * `merge-base HEAD <branch>` only after the merge has landed, so HEAD already
 * contains the branch and the "base" is the branch's own copy. The three-way
 * merge then sees no change on the branch side and keeps the pool copy alone:
 * the pool-side note survives and the committed tick is dropped. This case
 * pins the intended behaviour (inventory decision 5), so it is registered as
 * a todo, and runs only with CONFORMANCE_PENDING=1, until the fix lands.
 */
const SEED_FALLBACK =
  "with its kept seed gone, the reconcile takes the merge base's committed copy as its base and keeps both copies' edits";

pending(
  SEED_FALLBACK,
  async (t) => {
    const note = "\n## Notes\n\n- pool-side note\n";
    const world = trackedPool(t, {
      "01": {
        workFile: "one.txt",
        ticketReplace: ["1. Do A", "1. [x] Do A"],
        poolAppend: note,
        hold: true,
      },
      "02": DEFAULT_02,
    });
    const seed = join(world.repo, "runs", "01.seed.md");
    const server = await t.start(world, { pool: world.repo });

    await until(
      () => existsSync(join(world.stubs.dir, "edited-01")),
      (edited) => edited,
      { ms: 15_000, what: "01's agent to make its edits" },
    );
    expect(existsSync(seed)).toBe(true);
    rmSync(seed);
    writeFileSync(join(world.stubs.dir, "release-01"), "");
    await runToDone(server);

    // With no base at all the pool copy would stand in and the pool-side
    // note would be lost; the merge base's committed copy keeps both.
    expectSameFile(
      join(world.repo, "issues", "01-t.md"),
      `${ticketFile("01", "done", BODY.replace("1. Do A", "1. [x] Do A"))}${note}`,
    );
    expect(eventKinds(world, "01")).not.toContain("ticket-file-conflict");
    expect(existsSync(seed)).toBe(false);
  },
);
