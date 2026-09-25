/// <reference types="bun" />

// Keep talking (issue #139): a checkpointed Terminal-backed attempt's pane is
// held while its Interrupt waits, a Continued attempt carries on in it at
// once, plain Resume closes it before the fresh launch, and Finished
// terminals close only when the operator asks. The executing fake runs the
// wrapper for real, so the "TUI" here is a bash script that writes its
// Outcome and then stays alive, the way an interactive harness does
// (ADR-0016), until the test lets it go.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents } from "./events.ts";
import { startPool, type HarnessCommand, type PoolRun, type PoolSnapshot } from "./engine.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
} from "./herdr-executing-fake.ts";
import { cleanupPools, makeGitPool, makePool } from "./pool-fixture.ts";

const fakes: ExecutingFakeHerdr[] = [];
const runs: PoolRun[] = [];

afterEach(async () => {
  for (const run of runs.splice(0)) await run.shutdown(200).catch(() => {});
  for (const fake of fakes.splice(0)) await fake.close();
  await cleanupPools();
});

const READY = "<!-- state: id=01 blocked-by= status=ready -->";

/**
 * A stand-in TUI: writes the Outcome the test scripted for this spawn, then
 * stays alive until `quit` exists, as an interactive harness stays up after
 * its Outcome. Graders get a passing grade. A spawn with no script left
 * writes nothing and just waits.
 */
function tuiHarness(
  poolDir: string,
  outcomes: Record<string, Record<string, unknown>[]>,
): { harnesses: Record<string, HarnessCommand>; quit: string } {
  const script = join(poolDir, "tui.sh");
  const quit = join(poolDir, "quit");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      'outcome_path="$1"; outcome_json="$2"; quit="$3"',
      'if [ -n "$outcome_json" ]; then printf \'%s\' "$outcome_json" > "$outcome_path"; fi',
      "for _ in $(seq 1 600); do",
      '  [ -e "$quit" ] && exit 0',
      "  sleep 0.05",
      "done",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const tui: HarnessCommand = (ctx) => {
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const scripted = /-grader-\d+$/.test(ctx.id)
      ? {
          status: "done",
          summary: "graded",
          commitSha: null,
          grade: { score: 8, verdict: "pass", reasons: "fine" },
        }
      : outcomes[ctx.id]?.[n];
    return ["bash", script, ctx.outcomePath, scripted ? JSON.stringify(scripted) : "", quit];
  };
  return { harnesses: { tui }, quit };
}

const config = { defaults: { harness: "tui", model: "m" }, terminal: "herdr" as const };

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function latest(run: PoolRun): PoolSnapshot {
  return run.snapshots[run.snapshots.length - 1];
}

async function checkpointed(options: {
  git?: boolean;
  verify?: number;
  outcomes?: Record<string, Record<string, unknown>[]>;
}): Promise<{ run: PoolRun; poolDir: string; fake: ExecutingFakeHerdr; quit: string }> {
  const spec = {
    tickets: [{ file: "01.md", marker: READY, body: "# Talk it through\n\nbody" }],
    config: {
      ...config,
      ...(options.verify !== undefined ? { assign: { "01": { verify: options.verify } } } : {}),
    },
  };
  const poolDir = options.git ? makeGitPool(spec).poolDir : makePool(spec);
  const { harnesses, quit } = tuiHarness(
    poolDir,
    options.outcomes ?? {
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }],
    },
  );
  const fake = await startExecutingFakeHerdr();
  fakes.push(fake);
  const run = startPool({
    poolDir,
    harnesses,
    herdrSocket: fake.socketPath,
    enlistPollMs: 50,
    paneSurveyMs: 50,
  });
  runs.push(run);
  await until("the checkpoint's Held pane", () => latest(run).heldPanes["01"] !== undefined);
  return { run, poolDir, fake, quit };
}

function spawnedPanes(poolDir: string): { attempt: number; pane: unknown; tab: unknown }[] {
  return readEvents(join(poolDir, "runs"), "01")
    .filter((event) => event.kind === "spawned")
    .map((event) => ({ attempt: event.attempt, pane: event.payload.pane_id, tab: event.payload.tab_id }));
}

describe("Keep talking (issue #139)", () => {
  it("holds a checkpointed attempt's pane and continues it in place to done", async () => {
    const { run, poolDir, fake } = await checkpointed({});
    const held = latest(run).heldPanes["01"];
    const [first] = spawnedPanes(poolDir);
    expect(held).toEqual({ attempt: 1, paneId: first.pane as string });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);

    const { attempt } = await run.keepTalking("01");
    expect(attempt).toBe(2);
    // At once: the Interrupt is answered, the ticket runs, and the Live
    // attempt is the Continued one, on the very same pane.
    expect(run.interrupts).toEqual([]);
    expect(run.final.tickets["01"]).toBe("in-progress");
    const snapshot = latest(run);
    expect(snapshot.liveAttempts["01"]).toMatchObject({ attempt: 2, paneId: held.paneId });
    expect(snapshot.heldPanes["01"]).toBeUndefined();
    const continued = readEvents(join(poolDir, "runs"), "01").find(
      (event) => event.kind === "spawned" && event.attempt === 2,
    )!;
    expect(continued.payload).toMatchObject({
      pane_id: held.paneId,
      tab_id: first.tab,
      continued: true,
      continues: 1,
      numbered: false,
      harness: "tui",
      model: "m",
    });
    // No second tab: the Continued attempt launched nothing.
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(1);
    // The pane came forward and was taught once, with the exact Outcome path.
    const outcomePath = join(poolDir, "runs", "01.outcome.json");
    await until("the teaching Turn", () => fake.submitted.some((text) => text.includes(outcomePath)));
    expect(fake.submitted.filter((text) => text.includes("keep talking"))).toHaveLength(1);
    expect(fake.requests.some((r) => r.method === "pane.focus" && r.params.pane_id === held.paneId)).toBe(true);
    // The spent checkpoint Outcome was cleared before the watch was armed.
    expect(existsSync(outcomePath)).toBe(false);

    writeFileSync(
      outcomePath,
      JSON.stringify({ status: "done", summary: "talked it through", commitSha: null }),
    );
    await until("the Continued attempt's done", () => run.final.tickets["01"] === "done");
    expect(latest(run).liveAttempts["01"]).toBeUndefined();
    const exited = readEvents(join(poolDir, "runs"), "01").filter((e) => e.kind === "exited");
    expect(exited.map((e) => [e.attempt, e.payload.status])).toEqual([
      [1, "checkpoint"],
      [2, "done"],
    ]);
    expect(run.final.outcomes["01"].summary).toBe("talked it through");
  }, 30_000);

  it("raises a fresh checkpoint over the same pane, which can be continued again", async () => {
    const { run, poolDir } = await checkpointed({});
    const paneId = latest(run).heldPanes["01"].paneId;
    await run.keepTalking("01");
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "checkpoint", summary: "again", commitSha: null, brief: "one more thing" }),
    );
    await until("the second checkpoint", () => latest(run).heldPanes["01"]?.attempt === 2);
    expect(latest(run).heldPanes["01"].paneId).toBe(paneId);
    expect(run.interrupts[0].body).toContain("one more thing");
    const { attempt } = await run.keepTalking("01");
    expect(attempt).toBe(3);
  }, 30_000);

  it("crashes a Continued attempt whose pane goes before an Outcome", async () => {
    const { run, quit } = await checkpointed({});
    await run.keepTalking("01");
    writeFileSync(quit, "");
    await until("the crash interrupt", () => run.interrupts.some((i) => i.kind === "crash"));
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(run.interrupts[0].body).toContain("went before continued attempt 2 wrote an Outcome");
  }, 30_000);

  it("lets the Held pane go when the pane leaves herdr, and then refuses to continue", async () => {
    const { run, quit } = await checkpointed({});
    writeFileSync(quit, "");
    await until("the Held pane to go", () => latest(run).heldPanes["01"] === undefined);
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
    await expect(run.keepTalking("01")).rejects.toThrow("no terminal left to continue in");
  }, 30_000);

  it("refuses a ticket that is not at a checkpoint, and one with an answer already queued", async () => {
    const { run } = await checkpointed({});
    await expect(run.keepTalking("02")).rejects.toThrow("not waiting at a checkpoint");
    run.accept("01", "go again");
    await expect(run.keepTalking("01")).rejects.toThrow(/checkpoint/);
  }, 30_000);

  it("closes the checkpointed attempt's tab before a plain Resume launches afresh", async () => {
    const { run, poolDir, fake } = await checkpointed({
      outcomes: {
        "01": [
          { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" },
          { status: "done", summary: "fresh", commitSha: null },
        ],
      },
    });
    const [first] = spawnedPanes(poolDir);
    await run.resume("01");
    await until("the fresh attempt's done", () => run.final.tickets["01"] === "done");
    const methods = fake.requests.map((r) =>
      r.method === "tab.close" ? `tab.close ${String(r.params.tab_id)}` : r.method,
    );
    const closed = methods.indexOf(`tab.close ${String(first.tab)}`);
    const creates = methods.flatMap((method, i) => (method === "tab.create" ? [i] : []));
    expect(closed).toBeGreaterThan(-1);
    expect(creates).toHaveLength(2);
    expect(closed).toBeLessThan(creates[1]);
  }, 30_000);
});

describe("Finished terminals (issue #139)", () => {
  it("counts a done ticket's still-open tab and closes it on the bulk close alone", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01.md", marker: READY, body: "# Done and left open\n\nbody" }],
      config,
    });
    const { harnesses } = tuiHarness(poolDir, {
      "01": [{ status: "done", summary: "done", commitSha: null }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the finished terminal", () => latest(run).finishedTerminals === 1);
    // Nothing closes it on its own: the pool is done and the tab stays.
    await Bun.sleep(200);
    expect(fake.requests.some((r) => r.method === "tab.close")).toBe(false);

    const tab = readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "spawned")!.payload.tab_id;
    expect(await run.closeFinishedTerminals()).toBe(1);
    expect(fake.requests.some((r) => r.method === "tab.close" && r.params.tab_id === tab)).toBe(true);
    await until("the count to clear", () => latest(run).finishedTerminals === 0);
  }, 30_000);

  it("counts a Conversation's tab left open by a restart, crashed at boot", async () => {
    // A Stop or Restart leaves a started Conversation's tab open, and the
    // next boot crashes the record without a word to herdr: the tab is a
    // Finished terminal like any other, found from its spawned event.
    const poolDir = makePool({ tickets: [{ file: "01.md", marker: READY }], config });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    writeFileSync(
      join(poolDir, "conversations", "conv-1.md"),
      "<!-- conversation: id=conv-1 status=live spawned-by=none harness=tui model=m drivers=tdd -->\n\n# Left open\n\nhi\n",
    );
    appendEvent(join(poolDir, "runs"), "conv-1", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { cwd: poolDir, pane_id: "p-conv", tab_id: "tab-ghost" },
    });
    const { harnesses, quit } = tuiHarness(poolDir, {
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "later" }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.injectPane("p-conv");
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the crashed Conversation's tab counted", () =>
      latest(run).conversations.some((c) => c.id === "conv-1" && c.status === "crashed") &&
      latest(run).finishedTerminals === 1,
    );
    expect(await run.closeFinishedTerminals()).toBe(1);
    expect(fake.requests.some((r) => r.method === "tab.close" && r.params.tab_id === "tab-ghost")).toBe(true);
    writeFileSync(quit, "");
  }, 30_000);

  it("records a tab herdr refuses to close, and keeps the close best-effort", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01.md", marker: READY, body: "# Done and left open\n\nbody" }],
      config,
    });
    const { harnesses } = tuiHarness(poolDir, {
      "01": [{ status: "done", summary: "done", commitSha: null }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the finished terminal", () => latest(run).finishedTerminals === 1);
    fake.fail.add("tab.close");
    expect(await run.closeFinishedTerminals()).toBe(0);
    const failed = readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "tab-close-failed")!;
    expect(failed.payload.tab_id).toBe(
      readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "spawned")!.payload.tab_id,
    );
    expect(String(failed.payload.error)).toContain("tab.close");
    expect(run.final.log.some((line) => line.includes("could not be closed"))).toBe(true);
    expect(latest(run).finishedTerminals).toBe(1);
  }, 30_000);

  it("records a Conversation tab herdr refuses to close at its crash", async () => {
    const { poolDir } = makeGitPool({
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by= status=done -->" }],
      config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
    });
    const fake = await startExecutingFakeHerdr({ fail: ["tab.close"] });
    fakes.push(fake);
    const run = startPool({ poolDir, harnesses: { claude: () => ["false"] }, herdrSocket: fake.socketPath });
    runs.push(run);
    const view = await run.startConversation({ title: "Doomed" });
    expect(view.status).toBe("crashed");
    await until("the refused close on the Conversation's log", () =>
      readEvents(join(poolDir, "runs"), view.id).some((e) => e.kind === "tab-close-failed"),
    );
    // A crash closes through the engine's closeAttemptTabs (the host's), an
    // End through the module's own closeRuntimeTab; both record a refusal.
    expect(run.final.log.some((line) => line.includes(`${view.id}: herdr tab`))).toBe(true);
  }, 30_000);

  it("never counts a Held pane, a Live attempt's pane or a Continued attempt's", async () => {
    const { run } = await checkpointed({});
    await Bun.sleep(150);
    expect(latest(run).finishedTerminals).toBe(0);
    await run.keepTalking("01");
    await Bun.sleep(150);
    expect(latest(run).finishedTerminals).toBe(0);
    expect(await run.closeFinishedTerminals()).toBe(0);
  }, 30_000);

  it("refuses the bulk close in a headless pool", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01.md", marker: READY }],
      config: { defaults: { harness: "tui", model: "m" } },
    });
    const { harnesses, quit } = tuiHarness(poolDir, {
      "01": [{ status: "done", summary: "done", commitSha: null }],
    });
    writeFileSync(quit, "");
    const run = startPool({ poolDir, harnesses });
    runs.push(run);
    await run.settled;
    expect(latest(run).finishedTerminals).toBe(0);
    await expect(run.closeFinishedTerminals()).rejects.toThrow("not terminal-backed");
    await expect(run.keepTalking("01")).rejects.toThrow("not terminal-backed");
  }, 30_000);
});

describe("Continued attempts across a restart and on verify tickets (issue #139)", () => {
  it("re-adopts a live Continued attempt at boot and records its Outcome", async () => {
    const { run, poolDir, fake } = await checkpointed({});
    const paneId = latest(run).heldPanes["01"].paneId;
    await run.keepTalking("01");
    await until("the teaching Turn", () => fake.submitted.length > 0);
    await run.shutdown(200);
    runs.splice(runs.indexOf(run), 1);

    const { harnesses } = tuiHarness(poolDir, {});
    const again = startPool({
      poolDir,
      harnesses,
      herdrSocket: fake.socketPath,
      enlistPollMs: 50,
      paneSurveyMs: 50,
    });
    runs.push(again);
    await until("the re-adoption", () => latest(again).liveAttempts["01"]?.attempt === 2);
    expect(latest(again).liveAttempts["01"].paneId).toBe(paneId);
    expect(again.final.tickets["01"]).toBe("in-progress");
    // Taught before the restart: nothing more is typed.
    const typed = fake.submitted.length;
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "after the restart", commitSha: null }),
    );
    await until("the adopted Continued attempt's done", () => again.final.tickets["01"] === "done");
    expect(fake.submitted.length).toBe(typed);
    // The adoption interrupt went with the ending; only the run's Review is up.
    expect(again.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(readFileSync(join(poolDir, "issues", "01.md"), "utf8").split("\n")[0]).toContain("status=done");
  }, 30_000);

  it("grades a verify ticket's Continued attempt as a lone attempt and merges the branch it worked on", async () => {
    const { run, poolDir } = await checkpointed({ git: true, verify: 1 });
    const held = latest(run).heldPanes["01"];
    expect(held.attempt).toBe(1);
    const { attempt } = await run.keepTalking("01");
    expect(attempt).toBe(2);
    // A verify ticket's files are attempt-numbered, the Continued attempt's
    // included: its Outcome goes to its own file, taught by path.
    const outcomePath = join(poolDir, "runs", "01.attempt-2.outcome.json");
    writeFileSync(
      outcomePath,
      JSON.stringify({ status: "done", summary: "talked it through", commitSha: null }),
    );
    await until("the lone grading's done", () => run.final.tickets["01"] === "done", 20_000);
    const events = readEvents(join(poolDir, "runs"), "01");
    expect(events.filter((e) => e.kind === "graded").map((e) => e.attempt)).toEqual([1, 2]);
    const merged = events.find((e) => e.kind === "merged")!;
    expect(merged.attempt).toBe(2);
    // The branch merged is the one attempt 1's worktree was cut on, the
    // Continued attempt having worked there.
    expect(run.final.log.some((line) => line.includes("attempt 2 passed grading; merged") && line.includes("01.attempt-1"))).toBe(true);
  }, 40_000);
});
