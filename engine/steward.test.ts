/// <reference types="bun" />

// The Steward (ADR-0030): a Conversation in the role of keeping the Pool's
// Tickets moving while the operator is away. The pure rules first (the
// config entry, the budget read off a Ticket log, what the Steward is told
// about, the note store, the command), then the engine end to end against
// the executing fake: a Steward is an enlisted opencode pane, the Tickets
// are bash stand-in TUIs that write their Outcome and stay alive.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvents, type TicketEvent } from "./events.ts";
import {
  parseConfig,
  startPool,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
  type PoolSnapshot,
} from "./engine.ts";
import { loadConversations, readConversation } from "./conversations.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
} from "./herdr-executing-fake.ts";
import { cleanupPools, makeGitPool, registerTempDir } from "./pool-fixture.ts";
import { writePoolSettings } from "./pool-settings.ts";
import {
  checkStewardConfig,
  freshStewardItems,
  loadStewardNotes,
  stewardBudgetOf,
  stewardBatchText,
  stewardBudgetUsed,
  stewardCommand,
  stewardItems,
  type StewardPoolView,
} from "./steward.ts";
import { parseStewardArgs, runStewardCli, stewardCall } from "./steward-cli.ts";
import { makeTempDir } from "./tmp.ts";
import { branchFor } from "./worktrees.ts";

// ---------------------------------------------------------------------------
// The pure rules.
// ---------------------------------------------------------------------------

function answered(payload: Record<string, unknown>): TicketEvent {
  return { at: "2026-10-01T00:00:00.000Z", attempt: 1, kind: "answered", payload };
}

describe("the steward entry of console.json", () => {
  it("defaults the budget to 5 and reads one that is set", () => {
    expect(stewardBudgetOf({})).toBe(5);
    expect(stewardBudgetOf({ steward: { budget: 2 } })).toBe(2);
  });

  it("refuses a budget that is not a whole number of 1 or more, and an assign that is not strings", () => {
    expect(() => checkStewardConfig({ budget: 0 })).toThrow("steward.budget must be a whole number, 1 or more");
    expect(() => checkStewardConfig({ budget: 1.5 })).toThrow("steward.budget");
    expect(() => checkStewardConfig({ budget: "3" })).toThrow("steward.budget");
    expect(() => checkStewardConfig({ assign: { model: 4 } })).toThrow("steward.assign.model must be a string");
    expect(() => checkStewardConfig("x")).toThrow("steward must be an object");
    expect(checkStewardConfig(undefined)).toBeUndefined();
    expect(checkStewardConfig({ budget: 3, assign: { model: "m" } })).toEqual({ budget: 3, assign: { model: "m" } });
  });

  it("is refused at boot's parse like any other malformed key", () => {
    expect(() => parseConfig(JSON.stringify({ steward: { budget: 0 } }), "/pool")).toThrow("steward.budget");
    expect(parseConfig(JSON.stringify({ steward: { budget: 4 } }), "/pool").steward).toEqual({ budget: 4 });
  });

  it("is a Pool setting, replaced whole, its budget typed as text, its harness checked", () => {
    const pool = makeTempDir("steward-settings-");
    registerTempDir(pool);
    writeFileSync(join(pool, "console.json"), JSON.stringify({ defaults: { harness: "claude", model: "m" } }));
    const saved = writePoolSettings(
      pool,
      { steward: { budget: " 3 ", assign: { model: " judge ", harness: "", effort: "high" } } },
      { harnesses: ["claude", "opencode"] },
    );
    expect(saved.steward).toEqual({ budget: 3, assign: { model: "judge", effort: "high" } });
    expect(() => writePoolSettings(pool, { steward: { budget: "0" } }, { harnesses: [] })).toThrow(
      "steward.budget must be a whole number, 1 or more",
    );
    expect(() =>
      writePoolSettings(pool, { steward: { assign: { harness: "nope" } } }, { harnesses: ["claude"] }),
    ).toThrow("steward.assign.harness names unknown harness 'nope'");
    // Everything emptied goes back to the defaults: the key is removed.
    expect(writePoolSettings(pool, { steward: { budget: "", assign: {} } }, { harnesses: [] }).steward).toBeUndefined();
    expect(JSON.parse(readFileSync(join(pool, "console.json"), "utf8")).defaults).toEqual({
      harness: "claude",
      model: "m",
    });
  });
});

describe("the Steward budget, read off the Ticket log", () => {
  it("counts the Steward's answers and Keep talks since the operator last answered", () => {
    expect(stewardBudgetUsed([])).toBe(0);
    expect(
      stewardBudgetUsed([
        answered({ kind: "checkpoint", by: "steward" }),
        answered({ kind: "checkpoint" }),
        answered({ kind: "checkpoint", by: "steward" }),
        { at: "x", attempt: 2, kind: "steward-note", payload: { by: "steward" } },
        answered({ kind: "checkpoint", action: "keep-talking", by: "steward" }),
      ]),
    ).toBe(2);
    // The operator's answer resets it.
    expect(
      stewardBudgetUsed([answered({ kind: "crash", by: "steward" }), answered({ kind: "crash" })]),
    ).toBe(0);
  });
});

function view(overrides: Partial<StewardPoolView> = {}): StewardPoolView {
  return {
    interrupts: [],
    titleOf: (id) => `title of ${id}`,
    conversations: new Set(),
    queued: new Set(),
    left: () => false,
    keepTalking: () => false,
    budget: 5,
    used: () => 0,
    mergeQueue: [],
    merged: [],
    review: null,
    ...overrides,
  };
}

describe("what the Steward is told about", () => {
  it("tells every pending Ticket Interrupt but review, persistence, a Conversation's, a queued one and a left one", () => {
    const items = stewardItems(
      view({
        interrupts: [
          { ticketId: "01", kind: "checkpoint", body: "ask me" },
          { ticketId: "REVIEW", kind: "review", body: "review" },
          { ticketId: "PERSISTENCE", kind: "persistence", body: "disk" },
          { ticketId: "conv-1", kind: "merge-conflict", body: "conflict" },
          { ticketId: "02", kind: "crash", body: "crashed" },
          { ticketId: "03", kind: "merge-approval", body: "staged" },
          { ticketId: "04", kind: "config", body: "no model" },
        ],
        conversations: new Set(["conv-1"]),
        queued: new Set(["02"]),
        left: (id) => id === "04",
        keepTalking: (id) => id === "01",
        used: (id) => (id === "03" ? 5 : id === "01" ? 2 : 0),
      }),
    );
    expect(items.map((item) => item.key)).toEqual(["interrupt:01:checkpoint", "interrupt:03:merge-approval"]);
    const [checkpoint, approval] = items;
    expect(checkpoint.text).toContain('Ticket 01 ("title of 01") is waiting at a checkpoint Interrupt.');
    expect(checkpoint.text).toContain("Brief:\nask me");
    expect(checkpoint.text).toContain("keep-talking 01 <message> (its pane is still alive)");
    expect(checkpoint.text).toContain("Steward budget on 01: 3 of 5 answers left.");
    expect(approval.text).toContain("answer 03 approve [note], or answer 03 reject [note]");
    expect(approval.text).toContain("Steward budget on 03 is spent (5 of 5)");
  });

  it("tells a stalled Merge queue head, and only the head", () => {
    expect(
      stewardItems(view({ mergeQueue: [{ ticketId: "05", state: "needs-you" }, { ticketId: "06", state: "stalled" }] })),
    ).toEqual([]);
    const [stall] = stewardItems(
      view({ mergeQueue: [{ ticketId: "05", state: "stalled" }, { ticketId: "06", state: "stalled" }] }),
    );
    expect(stall.key).toBe("merge-stall:05");
    expect(stall.text).toContain("The Merge queue head, Ticket 05");
    expect(stall.text).toContain("Waiting behind it: 06.");
  });

  it("tells what merged and where Review stands, only informing", () => {
    const items = stewardItems(view({ merged: ["01", "03"], review: "pending" }));
    expect(items.map((i) => [i.key, i.kind, i.ticketId])).toEqual([
      ["merged:01", "steward-merged", "01"],
      ["merged:03", "steward-merged", "03"],
      ["pool:review", "steward-pool", null],
    ]);
    expect(stewardItems(view({ review: "approved" }))[0].text).toBe(
      "The operator approved Review: the pool is done.",
    );
  });

  it("batches news into one Turn: what asks for an act first, then one line of merges, then the pool", () => {
    const items = stewardItems(
      view({
        interrupts: [{ ticketId: "02", kind: "crash", body: "died" }],
        merged: ["01", "03"],
        review: null,
      }),
    );
    const text = stewardBatchText(items);
    expect(text).toStartWith("Pool news for the Steward (2 items):\n\nTicket 02");
    expect(text).toEndWith('Merged since your last Notice: 01 "title of 01", 03 "title of 03".');
    expect(stewardBatchText(stewardItems(view({ merged: ["01"] })))).toBe(
      'Pool news for the Steward:\n\nMerged since your last Notice: 01 "title of 01".',
    );
  });

  it("takes what merged before a Steward's first look as told, and tells later merges", () => {
    const told = new Set<string>();
    const first = stewardItems(view({ merged: ["01"], mergeQueue: [{ ticketId: "02", state: "stalled" }] }));
    expect(freshStewardItems(told, first, true).map((i) => i.key)).toEqual(["merge-stall:02"]);
    const later = stewardItems(view({ merged: ["01", "02"] }));
    expect(freshStewardItems(told, later).map((i) => i.key)).toEqual(["merged:02"]);
  });

  it("tells each item once, and again once it went and came back (a new stall, a new raise)", () => {
    const told = new Set<string>();
    const stalled = stewardItems(view({ mergeQueue: [{ ticketId: "05", state: "stalled" }] }));
    expect(freshStewardItems(told, stalled).map((i) => i.key)).toEqual(["merge-stall:05"]);
    expect(freshStewardItems(told, stalled)).toEqual([]);
    expect(freshStewardItems(told, [])).toEqual([]);
    expect(freshStewardItems(told, stalled).map((i) => i.key)).toEqual(["merge-stall:05"]);
  });
});

describe("the Steward note store", () => {
  it("keeps a note across a reload, and prunes it once its Interrupt is no longer pending", () => {
    const runs = makeTempDir("steward-notes-");
    registerTempDir(runs);
    const notes = loadStewardNotes(runs);
    notes.set("01", "checkpoint", { text: "resume with the smaller fix", at: "t", conversation: "conv-1" });
    const again = loadStewardNotes(runs);
    expect(again.get("01", "checkpoint")).toEqual({
      text: "resume with the smaller fix",
      at: "t",
      conversation: "conv-1",
    });
    expect(again.get("01", "crash")).toBeNull();
    expect(again.prune([{ ticketId: "01", kind: "checkpoint" }])).toBe(false);
    expect(again.prune([{ ticketId: "01", kind: "crash" }])).toBe(true);
    expect(loadStewardNotes(runs).size()).toBe(0);
  });
});

describe("the Steward's command", () => {
  it("names this Bun, the CLI, the pool and the Steward, quoting what needs it", () => {
    expect(
      stewardCommand({
        bun: "/home/me/.bun/bin/bun",
        cli: "/repo/engine/steward-cli.ts",
        poolDir: "/work/my pool",
        url: "http://localhost:8790",
        conversation: "conv-3",
      }),
    ).toBe(
      "/home/me/.bun/bin/bun /repo/engine/steward-cli.ts --pool '/work/my pool' --url http://localhost:8790 --as conv-3",
    );
  });

  it("maps each verb onto its route, taking options anywhere and a note from stdin", () => {
    const args = parseStewardArgs(["--pool", "/p", "answer", "01", "resume", "use", "plan", "B", "--as", "conv-1"]);
    expect(args).toMatchObject({ pool: "/p", conversation: "conv-1", verb: "answer", rest: ["01", "resume", "use", "plan", "B"] });
    const stdin = () => "  from stdin \n";
    expect(stewardCall("conv-1", "answer", ["01", "resume", "use", "plan", "B"], stdin)).toEqual({
      method: "POST",
      path: "/api/steward/answer",
      body: { conversation: "conv-1", ticketId: "01", action: "resume", note: "use plan B" },
    });
    expect(stewardCall("conv-1", "leave", ["01", "-"], stdin).body).toEqual({
      conversation: "conv-1",
      ticketId: "01",
      note: "from stdin",
    });
    expect(stewardCall("conv-1", "keep-talking", ["01", "try", "again"], stdin).body).toMatchObject({
      message: "try again",
    });
    expect(stewardCall("conv-1", "held", ["adopt", "proposal-2"], stdin).body).toMatchObject({
      action: "adopt",
      id: "proposal-2",
    });
    expect(stewardCall("conv-1", "reassign", ["01", "model=big", "effort=", "verify=2"], stdin).body).toEqual({
      conversation: "conv-1",
      tickets: ["01"],
      fields: { model: "big", effort: null, verify: 2 },
    });
    expect(() => stewardCall("conv-1", "reassign", ["01", "verify=abc"], stdin)).toThrow("not a whole number");
    expect(stewardCall("conv-1", "state", [], stdin)).toEqual({
      method: "GET",
      path: "/api/steward/state?conversation=conv-1",
    });
    expect(stewardCall("conv-1", "end", ["all", "done"], stdin).body).toEqual({
      conversation: "conv-1",
      closing: "all done",
    });
    expect(() => stewardCall("conv-1", "answer", ["01", "maybe"], stdin)).toThrow("answer <ticket>");
    expect(() => stewardCall("conv-1", "dance", [], stdin)).toThrow("unknown verb");
  });

  it("tries --url first and finds the Console by pool directory when nothing answers there", async () => {
    const pool = makeTempDir("steward-cli-");
    registerTempDir(pool);
    const registry = join(pool, "pools.json");
    writeFileSync(
      registry,
      JSON.stringify([{ poolDir: pool, port: 9911, pid: process.pid, startedAt: "t" }]),
    );
    const asked: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith("http://localhost:1")) throw new TypeError("connection refused");
      return Response.json({ ok: true, message: "answered 01: resume" }, { status: 202 });
    }) as typeof fetch;
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStewardCli(
      ["--pool", pool, "--url", "http://localhost:1", "--as", "conv-1", "answer", "01", "resume"],
      { out: (l) => out.push(l), err: (l) => err.push(l), stdin: () => "", fetch: fakeFetch, registry },
    );
    expect(code).toBe(0);
    expect(asked).toEqual(["http://localhost:1/api/steward/answer", "http://localhost:9911/api/steward/answer"]);
    expect(out).toEqual(["answered 01: resume"]);

    const refused = (async () =>
      Response.json({ reason: "steward: the Steward budget on ticket 01 is spent" }, { status: 409 })) as unknown as typeof fetch;
    const code2 = await runStewardCli(
      ["--url", "http://localhost:9911", "--as", "conv-1", "answer", "01", "resume"],
      { out: (l) => out.push(l), err: (l) => err.push(l), stdin: () => "", fetch: refused, registry },
    );
    expect(code2).toBe(1);
    expect(err.at(-1)).toBe("steward: the Steward budget on ticket 01 is spent");
  });
});

// ---------------------------------------------------------------------------
// The engine, end to end.
// ---------------------------------------------------------------------------

const fakes: ExecutingFakeHerdr[] = [];
const runs: PoolRun[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.shutdown(200).catch(() => {});
  for (const fake of fakes.splice(0)) await fake.close();
  await cleanupPools();
});

const READY = "<!-- state: id=01 blocked-by= status=ready -->";
const DONE = "<!-- state: id=01 blocked-by= status=done -->";
// What an idle opencode pane shows: its idle pattern, so the enlisted
// Steward reads as waiting and its Turns land.
const OPENCODE_IDLE = "opencode\nctrl+p commands";
const STEWARD_PANE = "pane-steward";

/** A stand-in TUI, as keep-talking.test.ts's: writes the scripted Outcome for this spawn, then stays alive. */
function tuiHarness(
  poolDir: string,
  outcomes: Record<string, Record<string, unknown>[]>,
): Record<string, HarnessCommand> {
  const script = join(poolDir, "tui.sh");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'outcome_path="$1"; outcome_json="$2"',
      'if [ -n "$outcome_json" ]; then printf \'%s\' "$outcome_json" > "$outcome_path"; fi',
      "sleep 60",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const tui: HarnessCommand = (ctx) => {
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const scripted = outcomes[ctx.id]?.[n];
    return ["bash", script, ctx.outcomePath, scripted ? JSON.stringify(scripted) : ""];
  };
  return { tui };
}

const checkpoint = (brief: string) => ({ status: "checkpoint", summary: "paused", commitSha: null, brief });

const baseConfig: PoolConfig = { defaults: { harness: "tui", model: "m" }, terminal: "herdr" };

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function latest(run: PoolRun): PoolSnapshot {
  return run.snapshots[run.snapshots.length - 1];
}

interface StewardPool {
  poolDir: string;
  fake: ExecutingFakeHerdr;
  harnesses: Record<string, HarnessCommand>;
  run: PoolRun;
  boot: () => PoolRun;
}

/**
 * A git pool whose Ticket 01 runs a stand-in TUI, with an idle opencode pane
 * the operator opened in a worktree of their own (so enlisting it moves no
 * checkout the Tickets use), ready to be Enlisted as the Steward.
 */
async function stewardPool(options: {
  outcomes?: Record<string, Record<string, unknown>[]>;
  config?: Partial<PoolConfig>;
  tickets?: { file: string; marker: string; body?: string }[];
  beforeBoot?: (poolDir: string, git: (args: string[]) => unknown) => void;
}): Promise<StewardPool> {
  const { poolDir, git } = makeGitPool({
    tickets: options.tickets ?? [{ file: "01.md", marker: READY, body: "# Talk it through\n\nbody" }],
    config: { ...baseConfig, ...options.config },
  });
  options.beforeBoot?.(poolDir, git);
  const stewardDir = join(makeTempDir("steward-wt-"), "wt");
  registerTempDir(join(stewardDir, ".."));
  git(["worktree", "add", "-q", "-b", "steward-desk", stewardDir]);
  const harnesses = tuiHarness(poolDir, options.outcomes ?? { "01": [checkpoint("ask me")] });
  const fake = await startExecutingFakeHerdr();
  fakes.push(fake);
  fake.seedAgent({
    paneId: STEWARD_PANE,
    agent: "opencode",
    cwd: stewardDir,
    title: "Desk",
    status: "idle",
    rendered: OPENCODE_IDLE,
    tabId: "tab-steward",
  });
  const boot = (): PoolRun => {
    const run = startPool({
      poolDir,
      harnesses,
      herdrSocket: fake.socketPath,
      enlistPollMs: 50,
      paneSurveyMs: 50,
      conversationPollMs: 50,
      enlistTeachingWaitMs: 3_000,
      consoleUrl: "http://localhost:8799",
    });
    runs.push(run);
    return run;
  };
  return { poolDir, fake, harnesses, run: boot(), boot };
}

async function enlistSteward(run: PoolRun, opening?: string): Promise<string> {
  const answer = await run.enlist({
    becomes: "steward",
    paneId: STEWARD_PANE,
    ...(opening ? { opening } : {}),
  });
  if (!("conversationId" in answer)) throw new Error("not a conversation");
  return answer.conversationId;
}

const stewardTurns = (fake: ExecutingFakeHerdr) =>
  fake.submitted.filter((text) => text.startsWith("Pool news for the Steward"));

describe("the Steward as a Conversation in a role", () => {
  it("persists its role, shows it on the view, and keeps it across a restart's re-adoption", async () => {
    const pool = await stewardPool({});
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run, "Keep 01 moving tonight.");
    const rec = readConversation(join(pool.poolDir, "conversations", `${id}.md`));
    expect(rec.role).toBe("steward");
    expect(rec.title).toBe("Steward");
    expect(readFileSync(rec.file, "utf8").split("\n")[0]).toContain("role=steward");
    expect(latest(pool.run).conversations.find((c) => c.id === id)?.role).toBe("steward");
    // Taught as the Steward, its command naming this pool and its own id.
    await until("the teaching", () => pool.fake.submitted.some((t) => t.includes("You are this pool's Steward")));
    const teaching = pool.fake.submitted.find((t) => t.includes("You are this pool's Steward"))!;
    expect(teaching).toContain("my-console-steward");
    expect(teaching).toContain(`--pool ${pool.poolDir} --url http://localhost:8799 --as ${id}`);
    expect(teaching).toContain("Your Steward budget is 5 answers per Ticket");
    expect(teaching).toContain("only if the operator's own words in this pane allow it");
    expect(pool.fake.submitted).toContain("Keep 01 moving tonight.");

    await pool.run.shutdown(200);
    const again = pool.boot();
    await until("the re-adoption", () =>
      latest(again).conversations.some((c) => c.id === id && c.role === "steward" && c.paneId === STEWARD_PANE),
    );
    expect(loadConversations(join(pool.poolDir, "conversations")).map((c) => c.role)).toEqual(["steward"]);
  }, 40_000);

  it("refuses a second Steward while one is live, and frees the slot once it ends", async () => {
    const pool = await stewardPool({});
    const id = await enlistSteward(pool.run);
    await expect(pool.run.startConversation({ title: "Another", role: "steward" })).rejects.toThrow(
      `a Steward is already on duty (${id}); end it before starting another`,
    );
    pool.fake.seedAgent({
      paneId: "pane-other",
      agent: "opencode",
      cwd: pool.poolDir,
      status: "idle",
      rendered: OPENCODE_IDLE,
    });
    await expect(pool.run.enlist({ becomes: "steward", paneId: "pane-other" })).rejects.toThrow(
      "a Steward is already on duty",
    );
    await pool.run.steward.end(id, "handing back");
    await until("the ending", () => latest(pool.run).conversations.find((c) => c.id === id)?.status === "ended");
    const started = await pool.run.startConversation({ title: "Night shift", role: "steward" });
    expect(started.role).toBe("steward");
  }, 40_000);
});

describe("Notices to the Steward", () => {
  it("delivers the backlog on start, once, and again after a restart's re-adoption", async () => {
    const pool = await stewardPool({});
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    await enlistSteward(pool.run);
    await until("the backlog Notice", () => stewardTurns(pool.fake).length === 1);
    const [turn] = stewardTurns(pool.fake);
    expect(turn).toContain('Ticket 01 ("Talk it through") is waiting at a checkpoint Interrupt.');
    expect(turn).toContain("Brief:\nask me");
    expect(turn).toContain("keep-talking 01 <message>");
    expect(turn).toContain("5 of 5 answers left");
    // The Ticket log records the telling.
    expect(
      readEvents(join(pool.poolDir, "runs"), "01").some(
        (e) => e.kind === "notice" && e.payload.kind === "steward-interrupt" && e.payload.delivered === true,
      ),
    ).toBe(true);
    await Bun.sleep(400);
    expect(stewardTurns(pool.fake)).toHaveLength(1);

    await pool.run.shutdown(200);
    pool.boot();
    await until("the backlog again", () => stewardTurns(pool.fake).length === 2);
  }, 40_000);

  it("batches several items arriving together into one Turn, and tells nothing that is not its own", async () => {
    const pool = await stewardPool({
      tickets: [
        { file: "01.md", marker: READY, body: "# One\n\nbody" },
        { file: "02.md", marker: "<!-- state: id=02 blocked-by= status=ready -->", body: "# Two\n\nbody" },
      ],
      outcomes: { "01": [checkpoint("first")], "02": [checkpoint("second")] },
    });
    await until("both checkpoints", () => pool.run.interrupts.filter((i) => i.kind === "checkpoint").length === 2);
    await enlistSteward(pool.run);
    await until("the Notice", () => stewardTurns(pool.fake).length === 1);
    const [turn] = stewardTurns(pool.fake);
    expect(turn).toStartWith("Pool news for the Steward (2 items):");
    expect(turn).toContain("Ticket 01");
    expect(turn).toContain("Ticket 02");
  }, 40_000);

  it("never offers or takes the review Interrupt, only says the pool reached it", async () => {
    const pool = await stewardPool({ tickets: [{ file: "01.md", marker: DONE, body: "# Done\n\nbody" }] });
    await until("the review gate", () => pool.run.interrupts.some((i) => i.kind === "review"));
    const id = await enlistSteward(pool.run);
    await until("the pool's news", () => stewardTurns(pool.fake).length === 1);
    await Bun.sleep(400);
    // What merged before the Steward started is no news; the Review gate is,
    // as information, never as an Interrupt to answer.
    expect(stewardTurns(pool.fake)).toEqual([
      "Pool news for the Steward:\n\nEvery Ticket is done and merged; Review waits for the operator.",
    ]);
    expect(() => pool.run.steward.answer(id, "REVIEW", "approve")).toThrow(
      "the review Interrupt is the operator's final judgement",
    );
    expect(() => pool.run.steward.leave(id, "REVIEW", "looks fine")).toThrow("final judgement");
  }, 40_000);

  it("tells a stalled Merge queue head once per stall", async () => {
    const pool = await stewardPool({
      tickets: [{ file: "01.md", marker: DONE, body: "# Landed elsewhere\n\nbody" }],
      beforeBoot: (poolDir, git) => {
        const branch = branchFor(poolDir, "01");
        git(["checkout", "-q", "-b", branch]);
        writeFileSync(join(poolDir, "work.txt"), "work\n");
        git(["add", "work.txt"]);
        git(["commit", "-qm", "work"]);
        git(["checkout", "-q", "main"]);
      },
    });
    await until("the stalled head", () => latest(pool.run).mergeQueue[0]?.state === "stalled");
    await enlistSteward(pool.run);
    await until("the stall Notice", () => stewardTurns(pool.fake).length === 1);
    expect(stewardTurns(pool.fake)[0]).toContain("The Merge queue head, Ticket 01");
    await Bun.sleep(400);
    expect(stewardTurns(pool.fake)).toHaveLength(1);
  }, 40_000);
});

describe("news that only informs the Steward", () => {
  it("tells it a Ticket merged and the pool reached Review, so it knows its orders are done", async () => {
    const pool = await stewardPool({
      outcomes: { "01": [checkpoint("ask me"), { status: "done", summary: "ok", commitSha: null }] },
    });
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run, "Watch 01 through, then finish.");
    await until("the backlog Notice", () => stewardTurns(pool.fake).length === 1);
    pool.run.steward.answer(id, "01", "resume");
    await until("the merge and Review news", () =>
      stewardTurns(pool.fake).some((t) => t.includes("Review waits for the operator")),
      30_000,
    );
    const news = stewardTurns(pool.fake).slice(1).join("\n");
    expect(news).toContain('Merged since your last Notice: 01 "Talk it through".');
    // Informing costs nothing: the one answer is all the budget spent.
    expect(latest(pool.run).stewardBudget.used).toEqual({ "01": 1 });
    expect(
      readEvents(join(pool.poolDir, "runs"), "01").some(
        (e) => e.kind === "notice" && e.payload.kind === "steward-merged" && e.payload.delivered === true,
      ),
    ).toBe(true);
  }, 60_000);
});

describe("Notices that cannot land", () => {
  it("shows a pane that swallows every Notice on the view, logs the episode once, and clears it when one lands", async () => {
    const pool = await stewardPool({ outcomes: { "01": [checkpoint("one"), checkpoint("two")] } });
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run);
    await until("the backlog Notice", () => stewardTurns(pool.fake).length === 1);
    // Something in the pane eats every Turn from here (a Blocking dialog,
    // live), while it still reads as waiting.
    pool.fake.dropPaneInput(STEWARD_PANE, 1_000_000);
    pool.run.accept("01");
    await until("the delivery failure on the view", () =>
      latest(pool.run).conversations.some((c) => c.id === id && c.delivery !== undefined),
      30_000,
    );
    const failing = latest(pool.run).conversations.find((c) => c.id === id)!.delivery!;
    expect(failing.lastError).toBe("the Turn never showed in the pane, so it was not sent");
    // Retries go on, but the logs carry the episode's first failure only.
    const retriesSeen = () =>
      pool.fake.requests.filter((r) => r.method === "pane.send_input" && r.params.pane_id === STEWARD_PANE).length;
    const before = retriesSeen();
    await until("more retries", () => retriesSeen() > before + 4, 30_000);
    const failed = (owner: string) =>
      readEvents(join(pool.poolDir, "runs"), owner).filter(
        (e) => e.kind === "notice" && e.payload.delivered === false,
      );
    expect(failed("01")).toHaveLength(1);
    expect(failed(id)).toHaveLength(1);
    expect(pool.run.final.log.filter((line) => line.includes("Notices are not reaching its pane"))).toHaveLength(1);

    pool.fake.dropPaneInput(STEWARD_PANE, -2_000_000);
    await until("the Notice lands", () => stewardTurns(pool.fake).some((t) => t.includes("Brief:\ntwo")), 30_000);
    await until("the view clears", () => latest(pool.run).conversations.find((c) => c.id === id)?.delivery === undefined);
    expect(
      readEvents(join(pool.poolDir, "runs"), "01").filter((e) => e.kind === "notice" && e.payload.delivered === true),
    ).toHaveLength(2);
    expect(failed("01")).toHaveLength(1);
  }, 90_000);
});

describe("the Steward's answers", () => {
  it("answers on the operator's path, recorded as its own with its note", async () => {
    const pool = await stewardPool({ outcomes: { "01": [checkpoint("ask me"), { status: "done", summary: "ok", commitSha: null }] } });
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run);
    expect(() => pool.run.steward.answer("conv-99", "01", "resume")).toThrow(
      `conv-99 is not the Steward on duty (${id} is)`,
    );
    expect(() => pool.run.steward.answer(id, "01", "approve")).toThrow("takes resume");
    pool.run.steward.answer(id, "01", "resume", "Take the smaller fix first.");
    const answer = readEvents(join(pool.poolDir, "runs"), "01").find((e) => e.kind === "answered")!;
    expect(answer.payload).toEqual({
      kind: "checkpoint",
      by: "steward",
      conversation: id,
      note: "Take the smaller fix first.",
    });
    await until("the rerun to finish", () => pool.run.final.tickets["01"] === "done");
    const ticket = readFileSync(join(pool.poolDir, "issues", "01.md"), "utf8");
    expect(ticket).toContain("## Resume note, from the Steward\n\nTake the smaller fix first.");
    expect(pool.run.final.log).toContain("interrupt answered for 01 (checkpoint): resumed by the Steward");
    expect(latest(pool.run).stewardBudget).toEqual({ budget: 5, used: { "01": 1 } });
  }, 40_000);

  it("refuses an answer beyond the budget, and the operator's answer resets it", async () => {
    const pool = await stewardPool({
      config: { steward: { budget: 1 } },
      outcomes: { "01": [checkpoint("one"), checkpoint("two"), checkpoint("three"), checkpoint("four")] },
    });
    await until("the first checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run);
    pool.run.steward.answer(id, "01", "resume");
    await until("the second checkpoint", () => pool.run.interrupts.some((i) => i.body.includes("two")));
    expect(() => pool.run.steward.answer(id, "01", "resume")).toThrow(
      "the Steward budget on ticket 01 is spent (1 of 1 answers since the operator last answered it)",
    );
    await expect(pool.run.steward.keepTalking(id, "01", "go on")).rejects.toThrow("budget on ticket 01 is spent");
    await until("the spent budget on the Notice", () =>
      stewardTurns(pool.fake).some((t) => t.includes("Steward budget on 01 is spent (1 of 1)")),
    );
    pool.run.accept("01");
    expect(latest(pool.run).stewardBudget.used).toEqual({});
    await until("the third checkpoint", () => pool.run.interrupts.some((i) => i.body.includes("three")));
    pool.run.steward.answer(id, "01", "resume");
    await until("the fourth checkpoint", () => pool.run.interrupts.some((i) => i.body.includes("four")));
  }, 60_000);

  it("keeps talking with a message typed after the teaching Turn, counted on the budget", async () => {
    const pool = await stewardPool({});
    await until("the Held pane", () => latest(pool.run).heldPanes["01"] !== undefined);
    const id = await enlistSteward(pool.run);
    const { attempt } = await pool.run.steward.keepTalking(id, "01", "Try the parser fix first.");
    expect(attempt).toBe(2);
    await until("the message", () =>
      pool.fake.submitted.includes("From the pool's Steward:\n\nTry the parser fix first."),
    );
    const teachingAt = pool.fake.submitted.findIndex((t) =>
      t.includes("The pool's Steward, standing in for the operator, chose to keep talking"),
    );
    const messageAt = pool.fake.submitted.indexOf("From the pool's Steward:\n\nTry the parser fix first.");
    expect(teachingAt).toBeGreaterThan(-1);
    expect(messageAt).toBeGreaterThan(teachingAt);
    const answer = readEvents(join(pool.poolDir, "runs"), "01").find((e) => e.kind === "answered")!;
    expect(answer.payload).toMatchObject({
      kind: "checkpoint",
      action: "keep-talking",
      by: "steward",
      conversation: id,
      message: "Try the parser fix first.",
    });
    expect(latest(pool.run).stewardBudget.used).toEqual({ "01": 1 });
  }, 40_000);

  it("leaves an Interrupt with a Steward note that survives a restart, and is not told about it again", async () => {
    const pool = await stewardPool({});
    await until("the checkpoint", () => pool.run.interrupts.some((i) => i.kind === "checkpoint"));
    const id = await enlistSteward(pool.run);
    await until("the Notice", () => stewardTurns(pool.fake).length === 1);
    pool.run.steward.leave(id, "01", "Product call: I'd resume with option B.");
    const shown = latest(pool.run).state.interrupts.find((i) => i.ticketId === "01")!;
    expect(shown.stewardNote).toMatchObject({ text: "Product call: I'd resume with option B.", conversation: id });
    // The note is on the snapshot's copy only, never the persisted Interrupt.
    expect(pool.run.interrupts[0].stewardNote).toBeUndefined();
    const left = readEvents(join(pool.poolDir, "runs"), "01").find((e) => e.kind === "steward-note")!;
    expect(left.payload).toEqual({
      kind: "checkpoint",
      note: "Product call: I'd resume with option B.",
      by: "steward",
      conversation: id,
    });
    // A leave never counts.
    expect(latest(pool.run).stewardBudget.used).toEqual({});

    await pool.run.shutdown(200);
    const again = pool.boot();
    await until("the note after the restart", () =>
      latest(again).state.interrupts.some((i) => i.stewardNote?.text === "Product call: I'd resume with option B."),
    );
    // Re-adopted: its Turn state is read from the pane again.
    await until("the re-adoption", () =>
      latest(again).conversations.some((c) => c.id === id && c.turn.lastLine !== ""),
    );
    await Bun.sleep(400);
    expect(stewardTurns(pool.fake)).toHaveLength(1);

    // The operator's answer clears it with the Interrupt.
    again.accept("01");
    await until("the note gone", () => !existsSync(join(pool.poolDir, "runs", "steward-notes.json")) ||
      !readFileSync(join(pool.poolDir, "runs", "steward-notes.json"), "utf8").includes("option B"));
  }, 60_000);

  it("ends itself with a closing line, as an operator End would", async () => {
    const pool = await stewardPool({});
    const id = await enlistSteward(pool.run);
    await pool.run.steward.end(id, "Super-step done; 01 waits for you.");
    await until("the ending", () => latest(pool.run).conversations.find((c) => c.id === id)?.status === "ended");
    const ended = readEvents(join(pool.poolDir, "runs"), id).find((e) => e.kind === "ended")!;
    expect(ended.payload).toMatchObject({ closing: "Super-step done; 01 waits for you.", by: "steward" });
    expect(readEvents(join(pool.poolDir, "runs"), id).find((e) => e.kind === "end-requested")!.payload).toEqual({
      closing: "Super-step done; 01 waits for you.",
      by: "steward",
    });
    // Nobody but the Steward ends this way.
    expect(() => pool.run.steward.check(id)).toThrow("no Steward is on duty");
  }, 40_000);
});

describe("the Steward's Held spawn decisions", () => {
  it("adopts and discards Held spawns, each recorded as the Steward's on the parent's log", async () => {
    const proposal = (title: string) => ({ title, body: `${title}: a follow-up worth doing later` });
    const pool = await stewardPool({
      config: { spawnCaps: { perAttempt: 0 } },
      outcomes: {
        "01": [
          {
            status: "done",
            summary: "done, two follow-ups",
            commitSha: null,
            spawn: [proposal("Keep"), proposal("Drop")],
          },
        ],
      },
    });
    await until("both held", () => latest(pool.run).heldSpawns.length === 2);
    const id = await enlistSteward(pool.run);
    const [keep, drop] = latest(pool.run).heldSpawns;
    pool.run.steward.adoptHeldSpawn(id, keep.id);
    pool.run.steward.discardHeldSpawn(id, drop.id);
    await until("the adoption", () => latest(pool.run).heldSpawns.length === 0);
    const events = readEvents(join(pool.poolDir, "runs"), "01");
    expect(events.find((e) => e.kind === "spawn-adopted")?.payload).toMatchObject({
      adopted: ["01-spawn-1"],
      fromHeld: keep.id,
      by: "steward",
      conversation: id,
    });
    expect(events.find((e) => e.kind === "spawn-discarded")?.payload).toEqual({
      id: drop.id,
      title: "Drop",
      by: "steward",
      conversation: id,
    });
    expect(() => pool.run.steward.adoptHeldSpawn("conv-99", keep.id)).toThrow("not the Steward on duty");
  }, 40_000);
});

describe("the Steward's Assignment", () => {
  it("resolves the request, then the Steward entry, then the pool defaults, field by field", async () => {
    const pool = await stewardPool({
      tickets: [{ file: "01.md", marker: DONE, body: "# Done\n\nbody" }],
      config: { steward: { assign: { model: "judge", effort: "high" } } },
    });
    const fromEntry = await pool.run.startConversation({
      title: "Night",
      role: "steward",
      opening: "Watch the next super-step, then finish.",
    });
    expect(fromEntry.role).toBe("steward");
    // The standing orders are the opening Turn, the Steward's teaching after them.
    const opening = pool.fake.submitted.find((t) => t.startsWith("Watch the next super-step, then finish."));
    expect(opening).toContain("You are this pool's Steward");
    expect(opening).toContain(`--as ${fromEntry.id}`);
    expect(fromEntry.assignment).toMatchObject({ harness: "tui", model: "judge", effort: "high" });
    await pool.run.endConversation(fromEntry.id);
    await until("the first ending", () =>
      latest(pool.run).conversations.find((c) => c.id === fromEntry.id)?.status === "ended",
    );
    const fromRequest = await pool.run.startConversation({
      title: "Night",
      role: "steward",
      assign: { model: "asked" },
    });
    expect(fromRequest.assignment).toMatchObject({ harness: "tui", model: "asked", effort: "high" });
    await pool.run.endConversation(fromRequest.id);
    await until("the second ending", () =>
      latest(pool.run).conversations.find((c) => c.id === fromRequest.id)?.status === "ended",
    );
    // An ordinary Conversation never reads the Steward entry.
    const ordinary = await pool.run.startConversation({ title: "Chat" });
    expect(ordinary.assignment).toMatchObject({ harness: "tui", model: "m" });
    expect(ordinary.assignment.effort).toBeUndefined();
    expect(ordinary.role).toBeUndefined();
  }, 60_000);
});

describe("the Steward entry's Config reload", () => {
  it("reloads the budget at the boundary, and rejects an unknown harness whole", async () => {
    const pool = await stewardPool({ tickets: [{ file: "01.md", marker: DONE, body: "# Done\n\nbody" }] });
    await until("an idle pool", () => pool.run.interrupts.some((i) => i.kind === "review"));
    const write = (config: PoolConfig) =>
      writeFileSync(join(pool.poolDir, "console.json"), JSON.stringify({ ...baseConfig, ...config }));
    write({ steward: { budget: 2, assign: { harness: "nope" } } });
    pool.run.reloadConfig();
    expect(pool.run.final.log.at(-1)).toContain("config reload rejected: pool config: steward.assign names unknown harness 'nope'");
    expect(latest(pool.run).stewardBudget.budget).toBe(5);
    write({ steward: { budget: 2 } });
    pool.run.reloadConfig();
    expect(pool.run.final.log).toContain("config reloaded: steward");
    expect(latest(pool.run).stewardBudget.budget).toBe(2);
  }, 40_000);
});
