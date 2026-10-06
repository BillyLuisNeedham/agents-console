/**
 * What the Steward is told (ADR-0030), seen from outside the server
 * (ADR-0036): the Notices typed into its pane as Turns. Each pending Ticket
 * Interrupt it may answer and has not left, a stalled Merge queue head,
 * what merged since its last Notice and where Review stands, batched into
 * one Turn per delivery, each item told once and told again only once it
 * went and came back.
 *
 * Every Notice is pinned byte for byte: the whole Turn is written out here
 * as the Bun server types it, with only the run's own paths and branch names
 * substituted. Where a case needs several items in one Turn it holds them
 * back the way a real Steward does, by its pane reading busy mid-Turn, and
 * lets them go together by its pane reading idle again.
 */

import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { conformance, type CaseServer } from "../../harness/case.ts";
import { expectSameBytes } from "../../harness/equal.ts";
import type { HerdrCall, HerdrProcess } from "../../harness/herdr.ts";
import { readEvents, until } from "../../harness/pool-files.ts";
import type { TicketSeed, World } from "../../harness/world.ts";
import {
  BUSY,
  checkpoint,
  done,
  driveOutcomes,
  enlistSteward,
  OPENCODE_IDLE,
  type ScriptedOutcome,
  snapshot,
  STEWARD_PANE,
  stewardNotices,
  stewardWorld,
  type StewardWorld,
  turnsInto,
  untilInterrupt,
  untilNotices,
  untilSnapshot,
} from "./pool.ts";

/** The Steward's pane reads mid-Turn: Notices wait in its queue. */
function stewardBusy(herdr: HerdrProcess): Promise<unknown> {
  return herdr.control("setPaneContent", STEWARD_PANE, BUSY);
}

/**
 * Enlist the Steward and let it take its first look at the pool, then make
 * its pane read busy. The first look is what a Steward counts as already
 * merged, so a case that means it to hear of merges lets its Tickets finish
 * only after it. Each look follows a read of the pane on the Conversation
 * poll: three reads after the teaching was submitted span at least two
 * polls, so the first look has been taken.
 */
async function enlistBusySteward(sw: StewardWorld, server: CaseServer): Promise<string> {
  const id = await enlistSteward(server);
  await until(() => turnsInto(sw.herdr, STEWARD_PANE), (turns) => turns.length >= 1, {
    what: "the Steward's teaching",
  });
  const after = sw.herdr.calls.length;
  await until(
    () => sw.herdr.calls.slice(after).filter((c) => c.method === "pane.read" && c.params.pane_id === STEWARD_PANE),
    (reads) => reads.length >= 3,
    { what: "the Steward's first look", ms: 15_000 },
  );
  await stewardBusy(sw.herdr);
  return id;
}

/** The Steward's pane reads waiting again: what waited is typed as one Turn. */
function stewardIdle(herdr: HerdrProcess): Promise<unknown> {
  return herdr.control("setPaneContent", STEWARD_PANE, OPENCODE_IDLE);
}

/**
 * The Notices typed so far, each against its whole expected text. The count
 * must match too, so a Notice typed twice or one too many fails here.
 */
function expectNotices(herdr: HerdrProcess, expected: string[]): void {
  const typed = stewardNotices(herdr);
  expect(typed.length, `the Steward Notices typed: ${JSON.stringify(typed)}`).toBe(expected.length);
  typed.forEach((turn, i) => expectSameBytes(turn, expected[i]!, `Steward Notice ${i + 1}`));
}

/**
 * Nothing more is typed: a bounded wait of about two and a half Conversation
 * polls (2 s each), in which the Notices must stay exactly `count`. A
 * negative can only be watched for a while, never proven.
 */
async function noFurtherNotices(herdr: HerdrProcess, count: number, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    expect(stewardNotices(herdr).length, "no further Steward Notice").toBe(count);
    await Bun.sleep(100);
  }
}

/** Whether a Ticket's log records a Notice of `kind` to the Steward as delivered. */
function loggedNotice(pool: string, ticketId: string, kind: string): boolean {
  return readEvents(pool, ticketId).some(
    (e) => e.kind === "notice" && e.payload.kind === kind && e.payload.delivered === true,
  );
}

/**
 * One step a played agent takes: an Outcome, or a function making one at the
 * moment it is written, which may answer null for "not yet": the agent is
 * then still at work, and the step is tried again shortly.
 */
type Step = ScriptedOutcome | (() => ScriptedOutcome | null);

/** The agents a case plays, from `playAgents`. */
interface Agents {
  /** Let go every prompt noted while held, and answer later ones as they come. */
  release(): void;
}

/**
 * Play the agent in every pane the server prompts, as the fixture's
 * driveOutcomes does, with three differences these cases need. A script is
 * keyed by the whole name of the file the prompt asks for, less
 * `.outcome.json` (`01`, `01.attempt-2`, `01-grader-1`, `03.resolver`), so
 * the Attempts of one verify round are told apart. The resolver's prompt is
 * played too. And with `held`, prompts are only noted until `release()`, so
 * a case can make its Steward's pane read busy before anything is raised.
 * A step that is a function runs as it is written: it may commit the work
 * the Outcome reports, as the agent would before writing it, or hold the
 * agent at work until the case is ready for its Outcome.
 */
function playAgents(herdr: HerdrProcess, scripts: Record<string, Step[]>, options: { held?: boolean } = {}): Agents {
  const used: Record<string, number> = {};
  const typed = new Map<string, string>();
  const waiting: string[] = [];
  let held = options.held === true;
  let seen = 0;
  const later: string[] = [];
  const answer = (path: string): void => {
    const key = basename(path, ".outcome.json");
    const n = used[key] ?? 0;
    const step = scripts[key]?.[n];
    if (!step) return;
    const outcome = typeof step === "function" ? step() : step;
    if (outcome === null) {
      later.push(path);
      return;
    }
    used[key] = n + 1;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(outcome));
  };
  const look = (call: HerdrCall): void => {
    if (call.method !== "pane.send_input") return;
    const pane = String(call.params.pane_id);
    const text = typeof call.params.text === "string" ? call.params.text : "";
    const match = /(?:outcome as JSON at|write JSON to) (\S+?\.outcome\.json):/.exec(text);
    if (match) typed.set(pane, match[1]!);
    const keys = Array.isArray(call.params.keys) ? (call.params.keys as string[]) : [];
    const path = typed.get(pane);
    if (!keys.includes("enter") || path === undefined) return;
    typed.delete(pane);
    if (held) waiting.push(path);
    else answer(path);
  };
  const timer = setInterval(() => {
    if (!held) for (const path of later.splice(0)) answer(path);
    while (seen < herdr.calls.length) look(herdr.calls[seen++]!);
  }, 20);
  // The case's teardown stops the herdr; the timer must not outlive the case.
  timer.unref();
  return {
    release() {
      held = false;
      for (const path of waiting.splice(0)) answer(path);
    },
  };
}

/** Wait until a prompt naming `<key>.outcome.json` has been submitted into some pane. */
function untilPrompted(herdr: HerdrProcess, key: string): Promise<boolean> {
  const file = `/${key}.outcome.json:`;
  const panes = (): string[] => [
    ...new Set(herdr.calls.filter((c) => c.method === "pane.send_input").map((c) => String(c.params.pane_id))),
  ];
  return until(() => panes().some((pane) => turnsInto(herdr, pane).some((turn) => turn.includes(file))), Boolean, {
    what: `the prompt naming ${key}.outcome.json`,
    ms: 30_000,
  });
}

/** What the server gave a Ticket's first Attempt, from its `spawned` event: pane, worktree and branch. */
interface Spawned {
  pane_id: string;
  cwd: string;
  branch: string;
}

function untilSpawned(pool: string, ticketId: string): Promise<Spawned> {
  return until(
    () => readEvents(pool, ticketId).find((e) => e.kind === "spawned")?.payload as Spawned | undefined,
    (payload) => payload !== undefined,
    { what: `${ticketId}'s spawned event`, ms: 30_000 },
  ) as Promise<Spawned>;
}

/** Commit one file in a checkout of the world's repository: a Ticket's worktree, or the main checkout. */
function commitFile(world: World, checkout: string, file: string, content: string): void {
  writeFileSync(join(checkout, file), content);
  world.git(["-C", checkout, "add", file]);
  world.git(["-C", checkout, "commit", "-qm", `${file} from ${basename(checkout)}`]);
}

/**
 * Turn Tickets the server ran into Tickets recorded done before a boot with
 * their work unmerged. Each must be paused at a checkpoint (so no Attempt is
 * in flight). With the server stopped, the case commits work on each
 * Ticket's own branch, as its agent would have, and records the Ticket done
 * in its marker, as a Ticket finished while no server ran; then it starts
 * the server again. The branches are the ones the server created and named
 * in each spawned event, never computed here. Hands back the new server.
 */
async function doneUnmergedAtBoot(sw: StewardWorld, server: CaseServer, ids: string[]): Promise<CaseServer> {
  const spawned = await Promise.all(ids.map((id) => untilSpawned(sw.world.pool, id)));
  await server.stop();
  ids.forEach((id, i) => {
    // A lone ready Ticket runs in the pool checkout itself, on no branch of
    // its own: a case must run at least two, so each has a worktree.
    const head = sw.world.git(["-C", spawned[i]!.cwd, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (head !== spawned[i]!.branch) throw new Error(`${id} ran on ${head}, not in a worktree on ${spawned[i]!.branch}`);
    commitFile(sw.world, spawned[i]!.cwd, `work-${id}.txt`, `${id}\n`);
    const file = join(sw.world.pool, "issues", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace(/ status=\S+ -->/, " status=done -->"));
  });
  return sw.start();
}

/** A Ticket seed: `id`, ready, blocked by `blockedBy`, its title its heading. */
function ticket(id: string, title: string, blockedBy = "none"): TicketSeed {
  return { file: `${id}.md`, marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`, body: `# ${title}\n\nbody` };
}

/** The stall Notice's text for a head with nothing behind it or with `behind` waiting. */
function stallText(head: string, title: string, behind: string): string {
  return (
    `The Merge queue head, Ticket ${head} ("${title}"), is stalled: it is done, its branch ` +
    "has not landed, and no resolver runs and no Interrupt is raised for it. Nothing in the " +
    "pool moves until it lands.\n" +
    `${behind}\n` +
    "There is no Interrupt to answer. Read its Ticket log and branch, and tell the operator in " +
    "this pane what you found; merge it by hand only if the operator's own words allowed you to."
  );
}

/** A step that commits `file` on the Ticket's branch and on main, differently, then reports done: its merge conflicts. */
function conflictingDone(world: World, ticketId: string, file = "shared.txt"): () => ScriptedOutcome {
  return () => {
    const worktree = readEvents(world.pool, ticketId).find((e) => e.kind === "spawned")!.payload.cwd as string;
    commitFile(world, worktree, file, `${ticketId}\n`);
    commitFile(world, world.repo, file, "main\n");
    return done();
  };
}

/** End a Ticket's pane once its prompt is in: no Outcome, no exit code, so a crash. */
async function crashTicket(sw: StewardWorld, ticketId: string): Promise<void> {
  await untilPrompted(sw.herdr, ticketId);
  await sw.herdr.control("endPane", (await untilSpawned(sw.world.pool, ticketId)).pane_id);
}

/** A grader's Outcome: done, carrying its Grade of the Attempt it read. */
function graded(score: number): ScriptedOutcome {
  return { ...done(), grade: { score, verdict: "pass", reasons: `scored ${score}` } };
}

// The checkpoint Notice the fixture's first scripted pause is told as: its
// pane still alive, so Keep talking is offered, and the whole budget left.
const CHECKPOINT_01 =
  "Ticket 01 (\"Talk it through\") is waiting at a checkpoint Interrupt.\n" +
  "Brief:\n" +
  "ask me\n" +
  "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
  "or leave 01 <note> for the operator.\n" +
  "Steward budget on 01: 5 of 5 answers left.";

// The same for a Ticket titled "One", as most cases here seed with `ticket`.
const CHECKPOINT_ONE =
  "Ticket 01 (\"One\") is waiting at a checkpoint Interrupt.\n" +
  "Brief:\n" +
  "ask me\n" +
  "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
  "or leave 01 <note> for the operator.\n" +
  "Steward budget on 01: 5 of 5 answers left.";

// Why the Steward may neither answer nor leave Review, word for word.
const FINAL_JUDGEMENT = "steward: the review Interrupt is the operator's final judgement, never the Steward's";

conformance(
  "steward",
  "a Steward is told a checkpoint with the answers it has left and a merge approval whose budget it spent",
  async (t) => {
    const sw = await stewardWorld(t, {
      tickets: [ticket("01", "One"), ticket("03", "Three")],
      config: { resolver: "claude" },
    });
    // 01 pauses three times and 03 five, the Steward answering 01 twice and
    // 03 five times; 03 then finishes with a conflicting merge, which the
    // resolver resolves, so it waits for approval. 03's first pause waits
    // for 01's, so the Notices queue in a known order.
    let first = false;
    const agents = playAgents(
      sw.herdr,
      {
        "01": [checkpoint("first"), checkpoint("second"), checkpoint("ask me")],
        "03": [
          () => (first ? checkpoint("one") : null),
          checkpoint("two"),
          checkpoint("three"),
          checkpoint("four"),
          checkpoint("five"),
          conflictingDone(sw.world, "03"),
        ],
        "03.resolver": [{ resolved: true, note: "kept both lines" }],
      },
      { held: true },
    );
    const server = await sw.start();
    const id = await enlistBusySteward(sw, server);
    agents.release();
    await untilInterrupt(server, "01", "checkpoint");
    first = true;

    const answers: Record<string, number> = { "01": 2, "03": 5 };
    const spent = (snap: Awaited<ReturnType<typeof snapshot>>, ticketId: string): boolean =>
      (snap.stewardBudget?.used[ticketId] ?? 0) >= answers[ticketId]!;
    const answerable = (snap: Awaited<ReturnType<typeof snapshot>>): string[] =>
      Object.keys(answers).filter(
        (ticketId) =>
          !spent(snap, ticketId) &&
          snap.state.interrupts.some((i) => i.ticketId === ticketId && i.kind === "checkpoint") &&
          !snap.state.queuedAnswers.some((a) => a.ticketId === ticketId),
      );
    for (;;) {
      const snap = await untilSnapshot(
        server,
        (s) => answerable(s).length > 0 || Object.keys(answers).every((ticketId) => spent(s, ticketId)),
        "a checkpoint for the Steward to answer",
        60_000,
      );
      const next = answerable(snap);
      if (next.length === 0) break;
      for (const ticketId of next) {
        const answer = await server.http.post("/api/steward/answer", { conversation: id, ticketId, action: "resume" });
        expect(answer.status).toBe(202);
      }
    }
    await untilSnapshot(
      server,
      (snap) =>
        snap.state.interrupts.map((i) => `${i.ticketId} ${i.kind} ${i.kind === "checkpoint" ? i.body : ""}`).sort().join(", ") ===
        "01 checkpoint ask me, 03 merge-approval ",
      "01's third checkpoint and 03's merge approval",
      60_000,
    );
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    const three = await untilSpawned(sw.world.pool, "03");
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Ticket 01 (\"One\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "ask me\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 3 of 5 answers left.\n\n---\n\n" +
        "Ticket 03 (\"Three\") is waiting at a merge-approval Interrupt.\n" +
        "Body:\n" +
        "The resolver agent resolved the merge conflict for ticket 03.\n" +
        "It attempted: kept both lines\n" +
        "conflicted files: shared.txt\n" +
        `the resolution is staged on branch ${three.branch}; approve to commit it and continue, or reject to resolve by hand.\n` +
        "Answers: answer 03 approve [note], or answer 03 reject [note]; or leave 03 <note> for the operator.\n" +
        "Steward budget on 03 is spent (5 of 5): leave it to the operator with a note.",
    ]);
  },
  { timeoutMs: 180_000 },
);

conformance(
  "steward",
  "a crash with the operator's answer queued is not told, while one unanswered is",
  async (t) => {
    // 07 waits for 08, so once 08 merges it runs in the next super-step and
    // keeps it in flight: an answer given then is queued until it joins.
    const sw = await stewardWorld(t, {
      tickets: [ticket("02", "Two"), ticket("06", "Six"), ticket("07", "Seven", "08"), ticket("08", "Eight")],
    });
    playAgents(sw.herdr, { "08": [done()] });
    const server = await sw.start();
    await crashTicket(sw, "02");
    await crashTicket(sw, "06");
    await untilPrompted(sw.herdr, "07");
    await untilSnapshot(
      server,
      (snap) => snap.state.interrupts.filter((i) => i.kind === "crash").length === 2,
      "both crashes",
    );
    // Answered mid-flight, the request is held until the answer is
    // processed; it is not awaited.
    void server.http.post("/api/resume", { ticketId: "02", action: "resume" });
    await untilSnapshot(server, (snap) => snap.state.queuedAnswers.some((a) => a.ticketId === "02"), "02's answer queued");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expect((await snapshot(server)).state.queuedAnswers.map((a) => a.ticketId)).toEqual(["02"]);
    const runs = join(sw.world.pool, "runs");
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\n" +
        "Ticket 06 (\"Six\") is waiting at a crash Interrupt.\n" +
        "Body:\n" +
        `crash: harness exit code unreadable: the pane wrapper never wrote a usable ${runs}/06.exitcode\n` +
        `${runs}/06.log\n` +
        "\n" +
        `outcome file: ${runs}/06.outcome.json (missing)\n` +
        "Answers: answer 06 resume [note]; or leave 06 <note> for the operator.\n" +
        "Steward budget on 06: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "an Interrupt the Steward left with a note is not told again, even to the Steward re-adopted after a restart",
  async (t) => {
    // 04 has no model anywhere, so it waits at a config Interrupt.
    const sw = await stewardWorld(t, {
      tickets: [ticket("01", "One"), ticket("04", "Four")],
      config: { defaults: { harness: "claude" }, assign: { "01": { model: "m" } } },
    });
    playAgents(sw.herdr, { "01": [checkpoint("ask me")] });
    let server = await sw.start();
    await untilSnapshot(
      server,
      (snap) => snap.state.interrupts.map((i) => `${i.ticketId} ${i.kind}`).sort().join(", ") === "01 checkpoint, 04 config",
      "01's checkpoint and 04's config Interrupt",
    );
    const id = await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    const left = await server.http.post("/api/steward/leave", {
      conversation: id,
      ticketId: "04",
      note: "Needs a model only the operator can choose.",
    });
    expect(left.status).toBe(200);

    // Nothing told survives a restart, but the note does.
    await server.stop();
    server = await sw.start();
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Ticket 04 (\"Four\") is waiting at a config Interrupt.\n" +
        "Body:\n" +
        "ticket 04 has no model: set one in console.json (an assign entry for 04, or defaults.model) and answer " +
        "resume. The pool reloads console.json at the next super-step boundary and schedules the ticket on what it finds.\n" +
        "Answers: reassign 04 field=value..., then answer 04 resume; or leave 04 <note> for the operator.\n" +
        "Steward budget on 04: 5 of 5 answers left.\n\n---\n\n" +
        CHECKPOINT_ONE,
      `Pool news for the Steward:\n\n${CHECKPOINT_ONE}`,
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a Conversation's merge conflict is never told to the Steward",
  async (t) => {
    const sw = await stewardWorld(t);
    playAgents(sw.herdr, { "01": [checkpoint("ask me")] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    const started = await server.http.post("/api/conversations", { title: "Side talk" });
    expect(started.status).toBe(201);
    const conv = started.json<{ conversation: { id: string } }>().conversation.id;
    const spawned = await untilSpawned(sw.world.pool, conv);
    commitFile(sw.world, spawned.cwd, "shared.txt", "conversation\n");
    commitFile(sw.world, sw.world.repo, "shared.txt", "main\n");
    const ended = await server.http.post("/api/conversations/end", { id: conv });
    expect(ended.status).toBe(202);
    // The Interrupt is raised as the conflict is recorded, but with the pool
    // quiescent nothing emits it: the Bun server's /api/state shows it only
    // at the next emit, which enlisting the Steward makes. So the conflict is
    // waited for in the Conversation's log, and the Interrupt after.
    await until(
      () => readEvents(sw.world.pool, conv).some((e) => e.kind === "merge-conflict"),
      Boolean,
      { what: `${conv}'s merge conflict in its log`, ms: 30_000 },
    );
    await enlistSteward(server);
    await untilInterrupt(server, conv, "merge-conflict");
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [`Pool news for the Steward:\n\n${CHECKPOINT_01}`]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "an engine store failure is never told to the Steward",
  async (t) => {
    // 02 merges before the Steward's first look, which is no news; 01 pauses.
    const sw = await stewardWorld(t, { tickets: [ticket("01", "One"), ticket("02", "Two")] });
    const agents = playAgents(sw.herdr, { "01": [checkpoint("ask me")], "02": [done()] }, { held: true });
    const server = await sw.start();
    // The case holds console.db's write lock while the super-step runs, so
    // the engine cannot write its checkpoint when the step joins and, its
    // retries spent, raises the persistence Interrupt.
    const store = join(sw.world.pool, "console.db");
    await until(() => existsSync(store), Boolean, { what: "console.db" });
    const lock = new Database(store);
    lock.exec("BEGIN EXCLUSIVE");
    try {
      agents.release();
      await untilSnapshot(
        server,
        (snap) => snap.state.interrupts.map((i) => `${i.ticketId} ${i.kind}`).sort().join(", ") ===
          "01 checkpoint, PERSISTENCE persistence",
        "01's checkpoint and the persistence Interrupt",
      );
      await enlistSteward(server);
      await untilNotices(sw.herdr, 1);
      await noFurtherNotices(sw.herdr, 1);
      expectNotices(sw.herdr, [`Pool news for the Steward:\n\n${CHECKPOINT_ONE}`]);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a verify round paused at a checkpoint naming Candidates offers resume and close, never adopt",
  async (t) => {
    const sw = await stewardWorld(t, {
      config: { steward: { mayClose: true }, assign: { "01": { verify: 2 } } },
    });
    // Attempt 1 pauses, attempt 2 finishes; each is graded, and the round
    // checkpoints with attempt 2, the one finished, as its one Candidate.
    playAgents(sw.herdr, {
      "01.attempt-1": [checkpoint("ask me")],
      "01.attempt-2": [done()],
      "01-grader-1": [graded(5)],
      "01-grader-2": [graded(8)],
    });
    const server = await sw.start();
    const snap = await untilInterrupt(server, "01", "checkpoint", 60_000);
    expect(snap.state.interrupts.find((i) => i.ticketId === "01")!.candidates).toEqual([2]);
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    const second = readEvents(sw.world.pool, "01").find((e) => e.kind === "spawned" && e.attempt === 2)!;
    // The Brief is the engine's, written for the operator, and names the
    // Adopt open to them; the Answers offered the Steward never do.
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\n" +
        "Ticket 01 (\"Talk it through\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "The verify round of 2 attempts ended with 1 checkpointed, so no candidate was selected and nothing merged.\n" +
        "\n" +
        "### Attempt 1 checkpointed\n" +
        "\n" +
        "ask me\n" +
        "\n" +
        "### Attempt 2 finished\n" +
        "\n" +
        `Graded 8/10, verdict pass. Its work waits unmerged on ${second.payload.branch as string}.\n` +
        "\n" +
        "Answering resume resets the ticket to ready; the next round runs a fresh fan-out and grades it again. " +
        "Closing it ends the ticket without merging any candidate. The operator may instead adopt a finished " +
        "candidate (2): it merges as the winner and the rest are discarded.\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive), or close 01 <note>; " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.",
    ]);
    const answers = stewardNotices(sw.herdr)[0]!.split("\n").find((line) => line.startsWith("Answers: "))!;
    expect(answers).not.toContain("adopt");
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "close is offered on a checkpoint and a merge conflict only while the pool lets the Steward Close, never on a deadlock or a crash",
  async (t) => {
    const sw = await stewardWorld(t, {
      tickets: [
        ticket("01", "One"),
        ticket("02", "Two"),
        ticket("03", "Three", "09"),
        ticket("04", "Four"),
        { file: "09.md", marker: "<!-- state: id=09 blocked-by=none status=closed -->", body: "# Nine\n\nbody" },
      ],
    });
    playAgents(sw.herdr, { "01": [checkpoint("ask me")], "02": [conflictingDone(sw.world, "02")] });
    let server = await sw.start();
    await crashTicket(sw, "04");
    await untilSnapshot(
      server,
      (snap) => snap.state.interrupts.map((i) => `${i.ticketId} ${i.kind}`).sort().join(", ") ===
        "01 checkpoint, 02 merge-conflict, 03 deadlock, 04 crash",
      "the four Interrupts",
    );
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);

    // Close on, and a restart so the re-adopted Steward hears the backlog
    // afresh, under the setting as it now stands.
    const saved = await server.http.put("/api/settings/pool", { config: { steward: { mayClose: true } } });
    expect(saved.status).toBe(200);
    await server.stop();
    server = await sw.start();
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);

    const two = await untilSpawned(sw.world.pool, "02");
    const runs = join(sw.world.pool, "runs");
    const conflict =
      `merging ${two.branch} onto the working branch failed; the merge was aborted and the working branch was left clean.\n` +
      "conflicted files: shared.txt\n" +
      `the ticket's work is parked on branch ${two.branch}, checked out at ${two.cwd}.\n` +
      "git said: Auto-merging shared.txt\n" +
      "CONFLICT (add/add): Merge conflict in shared.txt\n" +
      "Automatic merge failed; fix conflicts and then commit the result.\n" +
      "resolve the conflict and resume this ticket; the merge is re-attempted on resume.\n" +
      "The resolver agent attempted: no resolver harness available (set console.json resolver= or a ~/.issue-runner default)";
    const crash =
      `crash: harness exit code unreadable: the pane wrapper never wrote a usable ${runs}/04.exitcode\n` +
      `${runs}/04.log\n` +
      "\n" +
      `outcome file: ${runs}/04.outcome.json (missing)`;
    const deadlock =
      "Ticket 03 (\"Three\") is waiting at a deadlock Interrupt.\n" +
      "Body:\n" +
      "blocker 09 was closed\n" +
      "Answers: answer 03 resume [note]; or leave 03 <note> for the operator.\n" +
      "Steward budget on 03: 5 of 5 answers left.";
    // The rest in the order they were raised: the checkpoint as 01's
    // Attempt ended, then the conflict and the crash as the super-step
    // joined. The deadlock comes first at the first boot, where it was
    // raised before anything ran, and last after the restart, which
    // restores the others and derives it afresh.
    const others = (close: boolean): string =>
      "Ticket 01 (\"One\") is waiting at a checkpoint Interrupt.\n" +
      "Brief:\n" +
      "ask me\n" +
      "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive)" +
      (close ? ", or close 01 <note>" : "") +
      "; or leave 01 <note> for the operator.\n" +
      "Steward budget on 01: 5 of 5 answers left.\n\n---\n\n" +
      "Ticket 02 (\"Two\") is waiting at a merge-conflict Interrupt.\n" +
      "Body:\n" +
      `${conflict}\n` +
      "Answers: answer 02 resume (re-attempts the merge)" +
      (close ? ", or close 02 <note>" : "") +
      "; or leave 02 <note> for the operator.\n" +
      "Steward budget on 02: 5 of 5 answers left.\n\n---\n\n" +
      "Ticket 04 (\"Four\") is waiting at a crash Interrupt.\n" +
      "Body:\n" +
      `${crash}\n` +
      "Answers: answer 04 resume [note]; or leave 04 <note> for the operator.\n" +
      "Steward budget on 04: 5 of 5 answers left.";
    expectNotices(sw.herdr, [
      `Pool news for the Steward (4 items):\n\n${deadlock}\n\n---\n\n${others(false)}`,
      `Pool news for the Steward (4 items):\n\n${others(true)}\n\n---\n\n${deadlock}`,
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "only the Merge queue head is told as stalled, with the Tickets waiting behind it",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("05", "Five"), ticket("06", "Six")] });
    playAgents(sw.herdr, { "05": [checkpoint("parked")], "06": [checkpoint("parked")] });
    let server = await sw.start();
    await untilSnapshot(server, (snap) => snap.state.interrupts.length === 2, "both checkpoints");
    server = await doneUnmergedAtBoot(sw, server, ["05", "06"]);
    await untilSnapshot(
      server,
      (snap) => snap.state.mergeQueue.map((e) => `${e.ticketId} ${e.state}`).join(", ") === "05 stalled, 06 stalled",
      "05 and 06 stalled in the Merge queue",
    );
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [`Pool news for the Steward:\n\n${stallText("05", "Five", "Waiting behind it: 06.")}`]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a Merge queue head waiting at its merge Interrupt is told as that Interrupt, never as a stall",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("05", "Five"), ticket("06", "Six")] });
    // 05's agent commits a file main also gains, so its merge conflicts; 06
    // pauses, to be recorded done with its work unmerged before the next boot.
    playAgents(sw.herdr, {
      "05": [
        () => {
          const worktree = readEvents(sw.world.pool, "05").find((e) => e.kind === "spawned")!.payload.cwd as string;
          commitFile(sw.world, worktree, "shared.txt", "five\n");
          commitFile(sw.world, sw.world.repo, "shared.txt", "main\n");
          return done();
        },
      ],
      "06": [checkpoint("parked")],
    });
    let server = await sw.start();
    await untilInterrupt(server, "05", "merge-conflict");
    const five = await untilSpawned(sw.world.pool, "05");
    server = await doneUnmergedAtBoot(sw, server, ["06"]);
    await untilSnapshot(
      server,
      (snap) => snap.state.mergeQueue.map((e) => `${e.ticketId} ${e.state}`).join(", ") === "05 needs-you, 06 stalled",
      "05 needing the operator ahead of 06 stalled",
    );
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\n" +
        "Ticket 05 (\"Five\") is waiting at a merge-conflict Interrupt.\n" +
        "Body:\n" +
        `merging ${five.branch} onto the working branch failed; the merge was aborted and the working branch was left clean.\n` +
        "conflicted files: shared.txt\n" +
        `the ticket's work is parked on branch ${five.branch}, checked out at ${five.cwd}.\n` +
        "git said: Auto-merging shared.txt\n" +
        "CONFLICT (add/add): Merge conflict in shared.txt\n" +
        "Automatic merge failed; fix conflicts and then commit the result.\n" +
        "resolve the conflict and resume this ticket; the merge is re-attempted on resume.\n" +
        "The resolver agent attempted: no resolver harness available (set console.json resolver= or a ~/.issue-runner default)\n" +
        "Answers: answer 05 resume (re-attempts the merge); or leave 05 <note> for the operator.\n" +
        "Steward budget on 05: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a Steward is told what merged and that Review waits, then that the operator approved Review",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("01", "One"), ticket("03", "Three")] });
    const agents = playAgents(sw.herdr, { "01": [done()], "03": [done()] }, { held: true });
    const server = await sw.start();
    await enlistBusySteward(sw, server);
    agents.release();
    await untilInterrupt(server, "REVIEW", "review");
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);

    const approve = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
    expect(approve.status).toBe(202);
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Merged since your last Notice: 01 \"One\", 03 \"Three\".\n\n---\n\n" +
        "Every Ticket is done and merged; Review waits for the operator.",
      "Pool news for the Steward:\n\nThe operator approved Review: the pool is done.",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "news that waited on a busy Steward is one Turn, what asks for an act first and the merges last, and a lone merge is one line",
  async (t) => {
    const sw = await stewardWorld(t, {
      tickets: [ticket("01", "One"), ticket("02", "Two"), ticket("03", "Three"), ticket("04", "Four", "03")],
    });
    // 02 writes nothing and its pane ends: a crash, raised once its
    // super-step joins. 04 waits for 03, so it runs in the next one, and
    // finishes only when the case writes its Outcome.
    const agents = playAgents(sw.herdr, { "01": [done()], "03": [done()] }, { held: true });
    const server = await sw.start();
    await enlistBusySteward(sw, server);
    agents.release();
    await untilPrompted(sw.herdr, "02");
    await sw.herdr.control("endPane", (await untilSpawned(sw.world.pool, "02")).pane_id);
    await untilSnapshot(
      server,
      (snap) =>
        snap.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "crash") &&
        ["01", "03"].every((id) => snap.state.tickets.some((x) => x.id === id && x.status === "done" && x.mergeState === null)),
      "02 crashed, 01 and 03 merged",
    );
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);

    await untilPrompted(sw.herdr, "04");
    writeFileSync(join(sw.world.pool, "runs", "04.outcome.json"), JSON.stringify(done()));
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    const runs = join(sw.world.pool, "runs");
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Ticket 02 (\"Two\") is waiting at a crash Interrupt.\n" +
        "Body:\n" +
        `crash: harness exit code unreadable: the pane wrapper never wrote a usable ${runs}/02.exitcode\n` +
        `${runs}/02.log\n` +
        "\n" +
        `outcome file: ${runs}/02.outcome.json (missing)\n` +
        "Answers: answer 02 resume [note]; or leave 02 <note> for the operator.\n" +
        "Steward budget on 02: 5 of 5 answers left.\n\n---\n\n" +
        "Merged since your last Notice: 01 \"One\", 03 \"Three\".",
      "Pool news for the Steward:\n\nMerged since your last Notice: 04 \"Four\".",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a Steward enlisted after one merge and beside a stall is told the stall alone, then the stalled branch merging by hand",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("01", "One"), ticket("02", "Two")] });
    playAgents(sw.herdr, { "01": [done()], "02": [checkpoint("parked")] });
    let server = await sw.start();
    await untilSnapshot(
      server,
      (snap) =>
        snap.state.tickets.some((x) => x.id === "01" && x.status === "done" && x.mergeState === null) &&
        snap.state.interrupts.some((i) => i.ticketId === "02"),
      "01 merged and 02 paused",
    );
    const two = await untilSpawned(sw.world.pool, "02");
    server = await doneUnmergedAtBoot(sw, server, ["02"]);
    await untilSnapshot(server, (snap) => snap.state.mergeQueue[0]?.state === "stalled", "02 stalled at the head");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);

    // Busy while the operator lands 02 by hand, so its merge and Review
    // arrive as one Turn.
    await stewardBusy(sw.herdr);
    sw.world.git(["merge", "--no-ff", "-q", "-m", "land 02 by hand", two.branch]);
    await untilInterrupt(server, "REVIEW", "review");
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      `Pool news for the Steward:\n\n${stallText("02", "Two", "Nothing else waits behind it.")}`,
      "Pool news for the Steward (2 items):\n\n" +
        "Merged since your last Notice: 02 \"Two\".\n\n---\n\n" +
        "Every Ticket is done and merged; Review waits for the operator.",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a checkpoint is told once across later polls, and a second raise on the same Ticket is told again",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me"), checkpoint("ask me again")] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);

    const answer = await server.http.post("/api/resume", { ticketId: "01", action: "resume" });
    expect(answer.status).toBe(202);
    await untilSnapshot(
      server,
      (snap) => snap.state.interrupts.some((i) => i.ticketId === "01" && i.body === "ask me again"),
      "01's second checkpoint",
    );
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      `Pool news for the Steward:\n\n${CHECKPOINT_01}`,
      "Pool news for the Steward:\n\n" +
        "Ticket 01 (\"Talk it through\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "ask me again\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a Steward enlisted beside a checkpoint is told it once, logged as delivered, and again after a restart",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me")] });
    let server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    // The fake records the Turn as it is typed; the engine logs the delivery once the send returns.
    await until(() => loggedNotice(sw.world.pool, "01", "steward-interrupt"), (logged) => logged, { what: "01's steward-interrupt notice logged" });
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [`Pool news for the Steward:\n\n${CHECKPOINT_01}`]);

    // What it was told is kept in memory only: the re-adopted Steward hears
    // the backlog again.
    await server.stop();
    server = await sw.start();
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      `Pool news for the Steward:\n\n${CHECKPOINT_01}`,
      `Pool news for the Steward:\n\n${CHECKPOINT_01}`,
    ]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "two checkpoints pending at the Steward's start are told in one Turn of two items",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("01", "One"), ticket("02", "Two")] });
    // 02 pauses only once 01 has, so the two are raised in a known order.
    let first = false;
    playAgents(sw.herdr, { "01": [checkpoint("first")], "02": [() => (first ? checkpoint("second") : null)] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    first = true;
    await untilInterrupt(server, "02", "checkpoint");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Ticket 01 (\"One\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "first\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.\n\n---\n\n" +
        "Ticket 02 (\"Two\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "second\n" +
        "Answers: answer 02 resume [note], or keep-talking 02 <message> (its pane is still alive); " +
        "or leave 02 <note> for the operator.\n" +
        "Steward budget on 02: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "at Review the Steward is told only that Review waits for the operator, and may neither answer nor leave it",
  async (t) => {
    const sw = await stewardWorld(t, {
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: "# Done\n\nbody" }],
    });
    const server = await sw.start();
    await untilInterrupt(server, "REVIEW", "review");
    const id = await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    // What merged before the Steward started is no news; Review is, as
    // information, never as an Interrupt to answer.
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\nEvery Ticket is done and merged; Review waits for the operator.",
    ]);

    const answer = await server.http.post("/api/steward/answer", {
      conversation: id,
      ticketId: "REVIEW",
      action: "approve",
    });
    expect({ status: answer.status, body: answer.json() }).toEqual({ status: 409, body: { reason: FINAL_JUDGEMENT } });
    const leave = await server.http.post("/api/steward/leave", {
      conversation: id,
      ticketId: "REVIEW",
      note: "looks fine",
    });
    expect({ status: leave.status, body: leave.json() }).toEqual({ status: 409, body: { reason: FINAL_JUDGEMENT } });
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a stalled Merge queue head is told once, and not again over later polls",
  async (t) => {
    // 02 runs beside 01 so that 01 has a worktree and branch of its own; it
    // merges before the Steward's first look, which is no news.
    const sw = await stewardWorld(t, { tickets: [ticket("01", "Talk it through"), ticket("02", "Two")] });
    playAgents(sw.herdr, { "01": [checkpoint("parked")], "02": [done()] });
    let server = await sw.start();
    await untilSnapshot(
      server,
      (snap) =>
        snap.state.tickets.some((x) => x.id === "02" && x.status === "done" && x.mergeState === null) &&
        snap.state.interrupts.some((i) => i.ticketId === "01"),
      "02 merged and 01 paused",
    );
    server = await doneUnmergedAtBoot(sw, server, ["01"]);
    await untilSnapshot(server, (snap) => snap.state.mergeQueue[0]?.state === "stalled", "the stalled head");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      `Pool news for the Steward:\n\n${stallText("01", "Talk it through", "Nothing else waits behind it.")}`,
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a Ticket the Steward answered is told merged and the pool told at Review, the budget charged once",
  async (t) => {
    const sw = await stewardWorld(t);
    driveOutcomes(sw.herdr, { "01": [checkpoint("ask me"), done()] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    const id = await enlistSteward(server, "Watch 01 through, then finish.");
    await untilNotices(sw.herdr, 1);
    // Busy while 01 runs to done, so its merge and Review arrive as one Turn.
    await stewardBusy(sw.herdr);
    const answer = await server.http.post("/api/steward/answer", { conversation: id, ticketId: "01", action: "resume" });
    expect(answer.status).toBe(202);
    await untilInterrupt(server, "REVIEW", "review");
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 2);
    await noFurtherNotices(sw.herdr, 2);
    expectNotices(sw.herdr, [
      `Pool news for the Steward:\n\n${CHECKPOINT_01}`,
      "Pool news for the Steward (2 items):\n\n" +
        "Merged since your last Notice: 01 \"Talk it through\".\n\n---\n\n" +
        "Every Ticket is done and merged; Review waits for the operator.",
    ]);
    // Informing costs nothing: the one answer is all the budget spent.
    expect((await snapshot(server)).stewardBudget?.used).toEqual({ "01": 1 });
    // The fake records the Turn as it is typed; the engine logs the delivery once the send returns.
    await until(() => loggedNotice(sw.world.pool, "01", "steward-merged"), (logged) => logged, { what: "01's steward-merged notice logged" });
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a Brief past 1500 characters is cut short in the Notice, pointing at the Ticket file and its log",
  async (t) => {
    const sw = await stewardWorld(t);
    // 1,600 characters, so the cut falls inside the run of x.
    const brief = `${"a".repeat(1_490)}${"x".repeat(110)}`;
    driveOutcomes(sw.herdr, { "01": [checkpoint(brief)] });
    const server = await sw.start();
    await untilInterrupt(server, "01", "checkpoint");
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\n" +
        "Ticket 01 (\"Talk it through\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        `${"a".repeat(1_490)}${"x".repeat(10)}\n` +
        "... (cut short: read the Ticket file and its log for the rest)\n" +
        "Answers: answer 01 resume [note], or keep-talking 01 <message> (its pane is still alive); " +
        "or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 90_000 },
);

conformance(
  "steward",
  "a config Interrupt asks for a Reassign then resume, and a human selection for the attempt number to merge",
  async (t) => {
    // 01 has no model anywhere; 02 and its graders have one, 02 runs a
    // verify round of two, and the pool's selection is the human's.
    const sw = await stewardWorld(t, {
      tickets: [ticket("01", "One"), ticket("02", "Two")],
      config: {
        defaults: { harness: "claude" },
        selection: "human",
        assign: {
          "02": { model: "m", verify: 2 },
          "02-grader-1": { model: "m" },
          "02-grader-2": { model: "m" },
        },
      },
    });
    playAgents(sw.herdr, {
      "02.attempt-1": [done()],
      "02.attempt-2": [done()],
      "02-grader-1": [graded(7)],
      "02-grader-2": [graded(9)],
    });
    const server = await sw.start();
    await untilInterrupt(server, "02", "selection", 60_000);
    await enlistSteward(server);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      "Pool news for the Steward (2 items):\n\n" +
        "Ticket 01 (\"One\") is waiting at a config Interrupt.\n" +
        "Body:\n" +
        "ticket 01 has no model: set one in console.json (an assign entry for 01, or defaults.model) and answer " +
        "resume. The pool reloads console.json at the next super-step boundary and schedules the ticket on what it finds.\n" +
        "Answers: reassign 01 field=value..., then answer 01 resume; or leave 01 <note> for the operator.\n" +
        "Steward budget on 01: 5 of 5 answers left.\n\n---\n\n" +
        "Ticket 02 (\"Two\") is waiting at a selection Interrupt.\n" +
        "Body:\n" +
        "verify fan-out complete: 2 graded attempts, and the pool's selection is yours.\n" +
        "\n" +
        "- attempt 1: score 7/10, verdict pass\n" +
        "  scored 7\n" +
        "- attempt 2: score 9/10, verdict pass\n" +
        "  scored 9\n" +
        "\n" +
        "Answer with the number of the attempt to merge; the rest are discarded with their logs, outcomes and grades kept.\n" +
        "Answers: answer 02 resume <the attempt number to merge>; or leave 02 <note> for the operator.\n" +
        "Steward budget on 02: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 120_000 },
);

conformance(
  "steward",
  "a checkpoint the operator answers while the Steward's pane is busy is never told",
  async (t) => {
    const sw = await stewardWorld(t, { tickets: [ticket("01", "One"), ticket("02", "Two")] });
    // 01 has one pause scripted: once answered, its next Attempt stays at
    // work. Neither pauses before the Steward's pane reads busy.
    const agents = playAgents(sw.herdr, { "01": [checkpoint("first")], "02": [checkpoint("second")] }, { held: true });
    const server = await sw.start();
    await enlistBusySteward(sw, server);
    agents.release();
    await untilSnapshot(
      server,
      (snap) => snap.state.interrupts.filter((i) => i.kind === "checkpoint").length === 2,
      "both checkpoints",
    );
    const answer = await server.http.post("/api/resume", { ticketId: "01", action: "resume" });
    expect(answer.status).toBe(202);
    await untilSnapshot(server, (snap) => !snap.state.interrupts.some((i) => i.ticketId === "01"), "01 answered");
    await stewardIdle(sw.herdr);
    await untilNotices(sw.herdr, 1);
    await noFurtherNotices(sw.herdr, 1);
    expectNotices(sw.herdr, [
      "Pool news for the Steward:\n\n" +
        "Ticket 02 (\"Two\") is waiting at a checkpoint Interrupt.\n" +
        "Brief:\n" +
        "second\n" +
        "Answers: answer 02 resume [note], or keep-talking 02 <message> (its pane is still alive); " +
        "or leave 02 <note> for the operator.\n" +
        "Steward budget on 02: 5 of 5 answers left.",
    ]);
  },
  { timeoutMs: 90_000 },
);
