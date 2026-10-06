/**
 * The Steward's teaching (ADR-0030), read where an agent reads it: the Turn
 * the server types into the Steward's pane. A started Steward gets its
 * operator's standing orders with the teaching after them, in the claude
 * pane the server opens for it; an Enlisted one gets the teaching first and
 * its opening after, in the pane it was found in. Either way the teaching is
 * pinned byte for byte against `stewardTeaching` below, besides the facts
 * each case names, since the words are the contract an agent acts on.
 */

import { expect } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EnrichedSnapshot } from "../../../protocol/wire.ts";
import type { Case, CaseServer } from "../../harness/case.ts";
import { conformance } from "../../harness/case.ts";
import { expectSameBytes, expectSameFile } from "../../harness/equal.ts";
import type { HerdrProcess } from "../../harness/herdr.ts";
import { until } from "../../harness/pool-files.ts";
import { serverChoice } from "../../harness/server.ts";
import {
  checkpoint,
  DONE_01,
  driveOutcomes,
  enlistSteward,
  snapshot,
  STEWARD_PANE,
  stewardCommandPrefix,
  stewardWorld,
  tuiLaunches,
  turnsInto,
  untilInterrupt,
  untilSnapshot,
  type StewardWorldSpec,
} from "./pool.ts";

/** A Conversation as the snapshot shows it. */
type ConversationView = EnrichedSnapshot["state"]["conversations"][number];

/** What every Steward teaching opens with, after the line that sets it off. */
const TEACHING_START = "You are this pool's Steward";

/** The run-specific parts of a Steward teaching, and the pool settings it reads. */
interface TeachingParts {
  /** The Steward's command as typed, up to `<verb> ...`. */
  command: string;
  pool: string;
  id: string;
  /** Its own Assignment, as the protocol describes one. */
  own: string;
  /** Default 5, the pool's when console.json names none. */
  budget?: number;
  mayClose?: boolean;
}

/**
 * The whole Steward teaching, as the Bun server typed it: the Steward's
 * role, its command and verbs, its budget, its rules, then the Conversation
 * protocol every Conversation gets with the one sentence a Steward's differs
 * in. Every pool here has the defaults claude and m, and the caps' default
 * of 5 entries per file.
 */
function stewardTeaching(p: TeachingParts): string {
  const budget = p.budget ?? 5;
  const close = p.mayClose
    ? "- close <ticket> <note>: drop a Ticket waiting at a checkpoint or a merge conflict without merging it; its branch and worktree are discarded. Only when the work is no longer wanted, always with a note saying why. It counts against your budget. A deadlocked dependent of a closed Ticket is the operator's to close, not yours.\n"
    : "";
  const closing = p.mayClose
    ? "The operator lets you Close for now; they can turn it off in Settings at any time, and the engine then refuses a close. Run state when in doubt."
    : "Closing a Ticket without merging it is the operator's in this pool: the engine refuses it from you. To recommend one, leave the Ticket with a note saying so. If the operator turns on Steward may Close checkpoints later, state says so and each Notice offers close.";
  return `---

You are this pool's Steward: you keep its Tickets moving while the operator is away, under the orders above. Load the my-console-steward skill now: it is how to judge each Interrupt. It builds on the my-console-citizen skill, which is how to work inside this pool.

You do not poll. Whenever you are waiting, the engine types a Turn here naming every pending Ticket Interrupt you may answer and have not left, and a Merge queue head that has stalled. Items that arrive together come as one Turn. The same Turn also tells you, with nothing to answer, which Tickets merged since your last Notice and when every Ticket is done and Review waits for the operator: that is how you know when orders like "watch the next super-step, then finish" are done, and can end yourself.

Act with this command, run in your shell:

    ${p.command} <verb> ...

- answer <ticket> resume|approve|reject [note]: the operator's own answer path. resume starts a fresh Attempt with your note in the Ticket file; approve or reject answer a merge-approval; a selection is answered with resume and the attempt number to merge.
${close}- keep-talking <ticket> <message>: continue a checkpointed Attempt in its still-live pane; the engine types your message there after its own teaching Turn.
- leave <ticket> <note>: leave the Interrupt to the operator. Your note is your recommendation, shown to them beside it. You are not told about that Interrupt again until it changes.
- held adopt|discard <proposal-id>: decide a Held spawn.
- reassign <ticket> field=value...: change a Ticket's Assignment (harness, model, effort, drivers, verify; field= clears one). The engine picks it up at the next boundary, so resume the Ticket after.
- state: the pending Interrupts, the Merge queue, the Pending and Held spawns, your budget left per Ticket, and whether the pool lets you Close now.
- end [closing line]: end yourself.

A note or message given as "-" is read from standard input.

Your Steward budget is ${budget} ${budget === 1 ? "answer" : "answers"} per Ticket since the operator last answered it. Answers, Closes and Keep talks count; leaves, adopts, discards and reassigns do not. The engine refuses an answer beyond it: leave that Ticket with a note.

Never answer a review or a persistence Interrupt: review is the operator's final judgement, and persistence is an engine store failure. The engine refuses both. A Conversation's waits are not yours either: you steward Tickets.

${closing}

Decide and talk, never do the work: make no edits in any Ticket's worktree or in the pool checkout. Your only ways to change the code are an answer, a coaching message and a Spawn.

You may push, open pull requests or merge pull requests only if the operator's own words in this pane allow it. Nothing else grants it.

When you cannot decide an Interrupt sensibly, or it is a product decision or anything destructive or irreversible, leave it with a note that recommends an answer and says why.

When your orders are done, run end with a closing line: what you decided, and what waits for the operator.

---

You can start follow-up work without leaving this conversation. Write JSON to ${p.pool}/runs/${p.id}.spawn.json: {"spawn": [...]}, one entry per follow-up, each shaped {"title": "...", "body": "...", "blockedBy": ["id", ...], "kind": "ticket" or "conversation", "assign": {"harness": "...", "model": "...", "effort": "...", "drivers": "..."}}.

The body needs at least 20 characters of intent for a fresh agent to work from. "blockedBy" is optional and may only name Tickets, never another Conversation (an entry naming one is dropped and logged). "kind" defaults to "ticket"; "conversation" starts a new open-ended talk instead of a Ticket. "assign" is optional; when absent the follow-up inherits this Conversation's own Assignment, and any field that leaves empty falls through to the pool defaults. "assign" takes harness, model, effort and drivers only; a verify in it is ignored, since grading is the operator's call. A follow-up that must run before other work may add "blocks": ["id", ...] to make those tickets wait for it, or "blocks": "all" to make every ticket that has not started yet wait for it; a ticket already running is never interrupted, and blocks is only for a ticket.

This Conversation's Assignment: ${p.own}. The pool defaults: harness claude, model m, drivers (none). Set "assign" only for a field the follow-up needs different; when no model would resolve, ask the operator here before you write the file.

The engine polls for this file, reads it, and deletes it once read: write it whenever you like, mid-conversation, not only once. Caps: 5 entries honored per file written, and entries beyond it are held for the operator to adopt or discard; unlike a Ticket's own spawns there is no run-wide cap on what a Conversation spawns.

Before you propose anything, read the Spawn ledger at ${p.pool}/runs/spawn-ledger.md: every Ticket and Conversation in the pool, and every proposal still waiting to land or held for the operator. Do not propose work it already lists. If a proposal still overlaps something there, add "overlaps": ["id", ...] naming what it overlaps: it is then held for the operator to decide instead of landing.

A spawned Ticket reports back here as a Turn typed into this conversation once it ends (done, or checkpoint with its Brief) and you are next idle: its id, title, outcome, branch, and a diff summary. A spawned Conversation reports back the same way once the operator ends it: its branch and the operator's closing note, if any. Both only inform; a spawned Ticket's Interrupt reaches you as a Steward Notice like any other Ticket's.

You never write pool state yourself: no ticket files, no ids, no statuses, no status markers. You propose; the engine writes.`;
}

/** The Steward's command for a pool whose path needs no quoting. */
function commandFor(server: CaseServer, pool: string, id: string): string {
  return `${stewardCommandPrefix()} --pool ${pool} --url ${server.url} --as ${id}`;
}

/** The first Turn typed into a pane that carries a Steward teaching. */
function untilTeaching(herdr: HerdrProcess, paneId: string, ms = 30_000): Promise<string> {
  return until(
    () => turnsInto(herdr, paneId).find((turn) => turn.includes(TEACHING_START)),
    (turn) => turn !== undefined,
    { what: `a Steward teaching typed into ${paneId}`, ms },
  ) as Promise<string>;
}

/** POST /api/conversations, and the Conversation it started, once it has a pane. */
async function startConversation(server: CaseServer, body: Record<string, unknown>): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", body);
  expect(answer.status, answer.text).toBe(201);
  const started = answer.json<{ conversation: ConversationView }>().conversation;
  expect(started.paneId).not.toBeNull();
  return started;
}

/** End a live Conversation the operator's way, and wait until it reads ended. */
async function endConversation(server: CaseServer, id: string): Promise<void> {
  const answer = await server.http.post("/api/conversations/end", { id });
  expect(answer.status, answer.text).toBe(202);
  await untilSnapshot(
    server,
    (snap) => snap.state.conversations.find((c) => c.id === id)?.status === "ended",
    `${id} to end`,
  );
}

/**
 * A Steward started with POST /api/conversations on a pool whose 01 is
 * already done, so nothing but the teaching reaches its pane; hands back
 * that teaching Turn whole.
 */
async function startedStewardTeaching(
  t: Case,
  spec: StewardWorldSpec,
): Promise<{ teaching: string; server: CaseServer; pool: string; id: string }> {
  const sw = await stewardWorld(t, { tickets: [{ file: "01.md", marker: DONE_01, body: "# Done\n\nbody" }], ...spec });
  const server = await sw.start();
  const started = await startConversation(server, { title: "Night", role: "steward" });
  expect(started.role).toBe("steward");
  const teaching = await untilTeaching(sw.herdr, started.paneId!);
  return { teaching, server, pool: sw.world.pool, id: started.id };
}

conformance(
  "steward",
  "a started Steward is taught the my-console-steward skill, its command, every verb and the budget in force",
  async (t) => {
    const { teaching, server, pool, id } = await startedStewardTeaching(t, { config: { steward: { budget: 1 } } });

    expect(teaching).toContain("Load the my-console-steward skill");
    expect(teaching).toContain(`    ${stewardCommandPrefix()} --pool ${pool} --url ${server.url} --as ${id} <verb> ...`);
    for (const verb of [
      "- answer <ticket>",
      "- keep-talking <ticket>",
      "- leave <ticket>",
      "- held adopt|discard",
      "- reassign <ticket>",
      "- state:",
      "- end [closing line]",
    ]) {
      expect(teaching).toContain(verb);
    }
    expect(teaching).toContain("Your Steward budget is 1 answer per Ticket");
    expectSameBytes(
      teaching,
      stewardTeaching({
        command: commandFor(server, pool, id),
        pool,
        id,
        own: "harness claude, model m, drivers implement",
        budget: 1,
      }),
      "the Steward teaching",
    );
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "the teaching lists close only while the pool lets the Steward Close, and says state tells whether it may now",
  async (t) => {
    const off = await startedStewardTeaching(t, { config: { steward: { mayClose: false } } });
    const on = await startedStewardTeaching(t, { config: { steward: { mayClose: true } } });

    expect(off.teaching).not.toContain("- close <ticket>");
    expect(off.teaching).toContain("Closing a Ticket without merging it is the operator's in this pool");
    expect(on.teaching).toContain(
      "- close <ticket> <note>: drop a Ticket waiting at a checkpoint or a merge conflict",
    );
    expect(on.teaching).toContain("always with a note saying why");
    expect(on.teaching).toContain("It counts against your budget");
    expect(on.teaching).not.toContain("is the operator's in this pool");
    for (const { teaching } of [off, on]) expect(teaching).toContain("whether the pool lets you Close now");

    for (const [run, mayClose] of [
      [off, false],
      [on, true],
    ] as const) {
      expectSameBytes(
        run.teaching,
        stewardTeaching({
          command: commandFor(run.server, run.pool, run.id),
          pool: run.pool,
          id: run.id,
          own: "harness claude, model m, drivers implement",
          mayClose,
        }),
        `the Steward teaching with Steward may Close ${mayClose ? "on" : "off"}`,
      );
    }
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "the teaching states the exclusions, the hands-off rule, the push rule, and how to leave and end",
  async (t) => {
    const { teaching, server, pool, id } = await startedStewardTeaching(t, {});

    expect(teaching).toContain("Never answer a review or a persistence Interrupt");
    expect(teaching).toContain("make no edits in any Ticket's worktree or in the pool checkout");
    expect(teaching).toContain("only if the operator's own words in this pane allow it");
    expect(teaching).toContain("leave it with a note that recommends an answer");
    expect(teaching).toContain("When your orders are done, run end with a closing line");
    expectSameBytes(
      teaching,
      stewardTeaching({ command: commandFor(server, pool, id), pool, id, own: "harness claude, model m, drivers implement" }),
      "the Steward teaching",
    );
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "the teaching carries the Conversation protocol, with a spawned Ticket's Interrupt reaching the Steward as a Notice",
  async (t) => {
    const { teaching, server, pool, id } = await startedStewardTeaching(t, {});

    expect(teaching).toContain(`Write JSON to ${pool}/runs/${id}.spawn.json: {"spawn": [...]}`);
    expect(teaching).toContain(`read the Spawn ledger at ${pool}/runs/spawn-ledger.md`);
    expect(teaching).toContain("reaches you as a Steward Notice");
    expect(teaching).not.toContain("you cannot answer either one's own Interrupt");
    expectSameBytes(
      teaching,
      stewardTeaching({ command: commandFor(server, pool, id), pool, id, own: "harness claude, model m, drivers implement" }),
      "the Steward teaching",
    );
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a Steward in a pool whose path has a space is taught a command that runs as typed in a shell",
  async (t) => {
    const sw = await stewardWorld(t, { poolName: "my pool" });
    const server = await sw.start();
    const id = await enlistSteward(server);
    const teaching = await untilTeaching(sw.herdr, STEWARD_PANE);
    const pool = sw.world.pool;
    expect(pool).toContain(" ");

    // The pool is the one word that needs quoting; the rest go bare.
    const command = `${stewardCommandPrefix()} --pool '${pool}' --url ${server.url} --as ${id}`;
    expect(teaching).toContain(`\n    ${command} <verb> ...\n`);
    expectSameBytes(
      teaching,
      stewardTeaching({ command, pool, id, own: "harness opencode, model (none), drivers implement" }),
      "the Steward teaching",
    );

    // The line as typed, split into words by bash, is the Steward's argv.
    const line = /\n {4}(.*) <verb> \.\.\.\n/.exec(teaching)![1]!;
    const split = Bun.spawnSync(["bash", "-c", `printf '%s\\0' ${line}`], { stdout: "pipe", stderr: "pipe" });
    expect(split.exitCode, split.stderr.toString()).toBe(0);
    expect(split.stdout.toString().split("\0").slice(0, -1)).toEqual([
      ...stewardCommandPrefix().split(" "),
      "--pool",
      pool,
      "--url",
      server.url,
      "--as",
      id,
    ]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a Steward started after the server's binary was rebuilt under it is taught the rebuilt binary's path, never a deleted file's",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [{ file: "01.md", marker: DONE_01, body: "# Done\n\nbody" }] });
    // The server runs from a copy of its binary, and the copy is replaced
    // while it runs, the way `cargo build` relinks target/release/agent-console:
    // on Linux the running process's own link then reads `<path> (deleted)`.
    const binary = join(sw.world.root, "rebuilt", "agent-console");
    mkdirSync(dirname(binary), { recursive: true });
    copyFileSync(serverChoice().rustBin, binary);
    chmodSync(binary, 0o755);
    const server = await sw.start({ binary });
    copyFileSync(serverChoice().rustBin, `${binary}.new`);
    chmodSync(`${binary}.new`, 0o755);
    renameSync(`${binary}.new`, binary);

    const started = await startConversation(server, { title: "Night", role: "steward" });
    const teaching = await untilTeaching(sw.herdr, started.paneId!);
    const command = `${binary} steward --pool ${sw.world.pool} --url ${server.url} --as ${started.id}`;
    expect(teaching).not.toContain("(deleted)");
    expect(teaching).toContain(`\n    ${command} <verb> ...\n`);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "an Enlisted Steward persists its role, is taught as the Steward with its opening, and is re-adopted as Steward on restart",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me")] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint", 60_000);
    const id = await enlistSteward(server, "Keep 01 moving tonight.");
    const pool = sw.world.pool;

    // The record: its marker names the role, its title is Steward, its
    // opening the operator's.
    expectSameFile(
      join(pool, "conversations", `${id}.md`),
      `<!-- conversation: id=${id} status=live spawned-by=none harness=opencode model= drivers=implement pane=${STEWARD_PANE} tab=tab-steward directory=${encodeURIComponent(sw.stewardDir)} branch=steward-desk session=none role=steward -->

# Steward

Keep 01 moving tonight.
`,
    );
    const marker = readFileSync(join(pool, "conversations", `${id}.md`), "utf8").split("\n")[0]!;
    expect(marker).toContain("role=steward");
    expect((await snapshot(server)).state.conversations.find((c) => c.id === id)?.role).toBe("steward");

    // Taught as the Steward first, its opening typed after.
    const teaching = await untilTeaching(sw.herdr, STEWARD_PANE);
    expect(teaching).toContain("my-console-steward");
    expect(teaching).toContain(`--pool ${pool} --url ${server.url} --as ${id}`);
    expect(teaching).toContain("Your Steward budget is 5 answers per Ticket");
    expect(teaching).toContain("only if the operator's own words in this pane allow it");
    expectSameBytes(
      teaching,
      stewardTeaching({
        command: commandFor(server, pool, id),
        pool,
        id,
        own: "harness opencode, model (none), drivers implement",
      }),
      "the Steward teaching",
    );
    const turns = await until(
      () => turnsInto(sw.herdr, STEWARD_PANE),
      (typed) => typed.includes("Keep 01 moving tonight."),
      { what: "the opening typed into the Steward's pane" },
    );
    expect(turns.indexOf("Keep 01 moving tonight.")).toBeGreaterThan(turns.indexOf(teaching));

    await server.stop();
    const again = await sw.start();
    await untilSnapshot(
      again,
      (snap) =>
        snap.state.conversations.some((c) => c.id === id && c.role === "steward" && c.paneId === STEWARD_PANE),
      `${id} re-adopted as the Steward in ${STEWARD_PANE}`,
    );
    expect((await snapshot(again)).state.conversations.map((c) => [c.id, c.role])).toEqual([[id, "steward"]]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a started Steward's Assignment comes from the request, then the Steward entry, then the pool defaults",
  async (t) => {
    const sw = await stewardWorld(t, {
      tickets: [{ file: "01.md", marker: DONE_01, body: "# Done\n\nbody" }],
      config: { steward: { assign: { model: "judge", effort: "high" } } },
    });
    const server = await sw.start();
    const pool = sw.world.pool;

    // The standing orders are the opening Turn, the Steward's teaching after them.
    const orders = "Watch the next super-step, then finish.";
    const fromEntry = await startConversation(server, { title: "Night", role: "steward", opening: orders });
    expect(fromEntry.role).toBe("steward");
    expect(fromEntry.assignment).toMatchObject({ harness: "claude", model: "judge", effort: "high" });
    const opening = await untilTeaching(sw.herdr, fromEntry.paneId!);
    expect(opening.startsWith(orders)).toBe(true);
    expect(opening).toContain(`--as ${fromEntry.id}`);
    expectSameBytes(
      opening,
      `${orders}\n\n${stewardTeaching({
        command: commandFor(server, pool, fromEntry.id),
        pool,
        id: fromEntry.id,
        own: "harness claude, model judge, effort high, drivers implement",
      })}`,
      "the standing orders and the Steward teaching",
    );
    await endConversation(server, fromEntry.id);

    const fromRequest = await startConversation(server, {
      title: "Night",
      role: "steward",
      assign: { model: "asked" },
    });
    expect(fromRequest.assignment).toMatchObject({ harness: "claude", model: "asked", effort: "high" });
    await untilTeaching(sw.herdr, fromRequest.paneId!);
    await endConversation(server, fromRequest.id);

    // An ordinary Conversation never reads the Steward entry.
    const ordinary = await startConversation(server, { title: "Chat" });
    expect(ordinary.assignment).toMatchObject({ harness: "claude", model: "m" });
    expect(ordinary.assignment.effort).toBeUndefined();
    expect(ordinary.role).toBeUndefined();

    const launches = await until(() => tuiLaunches(sw.world), (all) => all.length >= 3, {
      what: "three claude launches",
    });
    expect(launches.map((launch) => launch.argv)).toEqual([
      ["claude", "--model", "judge", "--effort", "high", "--permission-mode", "auto"],
      ["claude", "--model", "asked", "--effort", "high", "--permission-mode", "auto"],
      ["claude", "--model", "m", "--permission-mode", "auto"],
    ]);
  },
  { timeoutMs: 120_000 },
);
