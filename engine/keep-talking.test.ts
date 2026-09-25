/// <reference types="bun" />

// Keep talking (issue #139): a checkpointed Terminal-backed attempt's pane is
// held while its Interrupt waits, a Continued attempt carries on in it at
// once, plain Resume closes it before the fresh launch, and Finished
// terminals close only when the operator asks. The executing fake runs the
// wrapper for real, so the "TUI" here is a bash script that writes its
// Outcome and then stays alive, the way an interactive harness does
// (ADR-0016), until the test lets it go.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, readEvents } from "./events.ts";
import { startPool, type HarnessCommand, type PoolRun, type PoolSnapshot } from "./engine.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
} from "./herdr-executing-fake.ts";
import { cleanupPools, makeGitPool, makePool } from "./pool-fixture.ts";
import { branchFor, worktreePathFor } from "./worktrees.ts";

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
      : (outcomes[ctx.id]?.[n] ?? outcomes["*"]?.[0]);
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
  holdPane?: boolean;
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
  const fake = await startExecutingFakeHerdr(options.holdPane ? { holdPane: true } : undefined);
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
    const { run, fake } = await checkpointed({});
    const paneId = latest(run).heldPanes["01"].paneId;
    await run.keepTalking("01");
    fake.endPane(paneId);
    await until("the crash interrupt", () => run.interrupts.some((i) => i.kind === "crash"));
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(run.interrupts[0].body).toContain("went before continued attempt 2 wrote an Outcome");
  }, 30_000);

  it("crashes a Continued attempt whose TUI exits while its pane stays open (review item 1)", async () => {
    // The wrapper runs in the pane's own shell, so a TUI that quits leaves
    // the pane at its prompt; only the exit-code file says the agent is gone.
    const { run, quit } = await checkpointed({ holdPane: true });
    await run.keepTalking("01");
    writeFileSync(quit, "");
    await until("the crash interrupt", () => run.interrupts.some((i) => i.kind === "crash"));
    expect(run.interrupts[0].body).toContain("exited before continued attempt 2 wrote an Outcome");
  }, 30_000);

  it("lets a Held pane go when its TUI exits and offers no Keep talking over the bare shell (review item 1)", async () => {
    const { run, quit } = await checkpointed({ holdPane: true });
    writeFileSync(quit, "");
    await until("the Held pane to go", () => latest(run).heldPanes["01"] === undefined);
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
    await expect(run.keepTalking("01")).rejects.toThrow("no terminal left to continue in");
  }, 30_000);

  it("clears a stale exit-code file from before the attempt, then races a fresh one (review item 1)", async () => {
    const { run, poolDir, quit } = await checkpointed({ holdPane: true });
    const exitCode = join(poolDir, "runs", "01.exitcode");
    writeFileSync(exitCode, "0\n");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(exitCode, past, past);
    await run.keepTalking("01");
    expect(existsSync(exitCode)).toBe(false);
    writeFileSync(quit, "");
    await until("the crash interrupt", () => run.interrupts.some((i) => i.kind === "crash"));
  }, 30_000);

  it("ends on a valid Outcome even when the pane goes with it (review item 5)", async () => {
    const { run, poolDir, fake } = await checkpointed({});
    const paneId = latest(run).heldPanes["01"].paneId;
    await run.keepTalking("01");
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "said and gone", commitSha: null }),
    );
    fake.endPane(paneId);
    await until("done", () => run.final.tickets["01"] === "done");
    expect(run.interrupts.filter((i) => i.kind === "crash")).toEqual([]);
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

  it("closes the checkpointed attempt's tab before a plain Resume launches afresh, once (review item 10)", async () => {
    const { run, poolDir, fake, quit } = await checkpointed({
      outcomes: {
        "01": [
          { status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" },
          // attempt 2 writes nothing: it crashes when its TUI quits
        ],
      },
    });
    const [first] = spawnedPanes(poolDir);
    // Accepted, not awaited: the fresh attempt runs until the test quits it.
    run.accept("01");
    await until("the fresh attempt's tab", () => spawnedPanes(poolDir).length === 2);
    const methods = fake.requests.map((r) =>
      r.method === "tab.close" ? `tab.close ${String(r.params.tab_id)}` : r.method,
    );
    const closed = methods.indexOf(`tab.close ${String(first.tab)}`);
    const creates = methods.flatMap((method, i) => (method === "tab.create" ? [i] : []));
    expect(closed).toBeGreaterThan(-1);
    expect(closed).toBeLessThan(creates[1]);
    expect(
      readEvents(join(poolDir, "runs"), "01").filter((e) => e.kind === "tab-closed").map((e) => e.payload.tab_id),
    ).toEqual([first.tab]);

    // Attempt 2 crashes; resuming it launches attempt 3, and the Resume
    // close reaches back for nothing: the checkpointed tab is closed
    // already, and a crashed attempt's tab stays.
    writeFileSync(quit, "");
    await until("the crash", () => run.interrupts.some((i) => i.kind === "crash"));
    const second = spawnedPanes(poolDir)[1];
    run.accept("01");
    await until("attempt 3's tab", () => spawnedPanes(poolDir).length === 3);
    const closes = fake.requests.filter((r) => r.method === "tab.close").map((r) => r.params.tab_id);
    expect(closes.filter((tab) => tab === first.tab)).toHaveLength(1);
    expect(closes).not.toContain(second.tab);
  }, 30_000);

  it("leaves the tab open at a Resume when a Continued attempt crashed in it after the checkpoint (R6)", async () => {
    const { run, poolDir, fake, quit } = await checkpointed({ holdPane: true });
    const [first] = spawnedPanes(poolDir);
    await run.keepTalking("01");
    // The Continued attempt's TUI exits with no Outcome: a crash, and its
    // tab stays open as every crashed attempt's does.
    writeFileSync(quit, "");
    await until("the crash", () => run.interrupts.some((i) => i.kind === "crash"));
    run.accept("01");
    await until("the fresh attempt's tab", () => spawnedPanes(poolDir).length === 3);
    expect(fake.requests.some((r) => r.method === "tab.close" && r.params.tab_id === first.tab)).toBe(false);
  }, 30_000);

  it("refuses Keep talking while an enlisted Conversation works in a subdirectory of the pool checkout (R3)", async () => {
    const { run, poolDir, fake } = await checkpointed({ git: true });
    expect(readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "spawned")!.payload.cwd).toBe(poolDir);
    const sub = join(poolDir, "sub");
    mkdirSync(sub, { recursive: true });
    fake.seedAgent({
      paneId: "pane-op",
      agent: "opencode",
      cwd: sub,
      title: "OC",
      status: "idle",
      rendered: "opencode\nctrl+p commands",
      tabId: "tab-op",
    });
    const enlisted = await run.enlist({ becomes: "conversation", paneId: "pane-op", title: "Beside" });
    expect(enlisted).toBeDefined();
    await expect(run.keepTalking("01")).rejects.toThrow("working now");
  }, 30_000);

  it("refuses Keep talking in the pool checkout while another agent works there (review item 3)", async () => {
    // A pool with no git runs every attempt in its own checkout: 02 is still
    // working there when 01 checkpoints.
    const poolDir = makePool({
      tickets: [
        { file: "01.md", marker: READY, body: "# Talk\n\nbody" },
        { file: "02.md", marker: "<!-- state: id=02 blocked-by= status=ready -->", body: "# Busy\n\nbody" },
      ],
      config,
    });
    const { harnesses } = tuiHarness(poolDir, {
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("01's Held pane", () => latest(run).heldPanes["01"] !== undefined);
    expect(latest(run).liveAttempts["02"]).toBeDefined();
    await expect(run.keepTalking("01")).rejects.toThrow("where 02 is working now");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
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

  it("re-adopts a started Conversation left talking by a restart instead of leaving its tab behind (issue #140)", async () => {
    // A Stop or Restart leaves a started Conversation's tab open. Its pane is
    // still its own, so the next boot re-adopts it: live again, and its tab
    // no Finished terminal. (A dead one is crashed with its tab closed; the
    // Conversation suite covers that.)
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
    await until("the re-adopted Conversation", () =>
      latest(run).conversations.some((c) => c.id === "conv-1" && c.status === "live" && c.paneId === "p-conv"),
    );
    await Bun.sleep(200);
    expect(latest(run).finishedTerminals).toBe(0);
    expect(await run.closeFinishedTerminals()).toBe(0);
    expect(fake.requests.some((r) => r.method === "tab.close")).toBe(false);
    writeFileSync(quit, "");
  }, 30_000);

  it("never counts or closes an ended enlisted Conversation's tab (issue #140)", async () => {
    const poolDir = makePool({ tickets: [{ file: "01.md", marker: READY }], config });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    writeFileSync(
      join(poolDir, "conversations", "conv-1.md"),
      "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model= drivers=tdd " +
        `pane=p-op tab=tab-ghost directory=${encodeURIComponent(poolDir)} branch=main session=none -->\n\n# Theirs\n\nhi\n`,
    );
    appendEvent(join(poolDir, "runs"), "conv-1", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { argv: [], cwd: poolDir, pane_id: "p-op", tab_id: "tab-ghost" },
    });
    const { harnesses, quit } = tuiHarness(poolDir, {
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "later" }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.injectPane("p-op");
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the checkpoint", () => run.interrupts.some((i) => i.kind === "checkpoint"));
    await Bun.sleep(300);
    expect(latest(run).conversations.find((c) => c.id === "conv-1")?.enlisted).toBe(true);
    expect(latest(run).finishedTerminals).toBe(0);
    expect(await run.closeFinishedTerminals()).toBe(0);
    expect(fake.requests.some((r) => r.method === "tab.close" && r.params.tab_id === "tab-ghost")).toBe(false);
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

describe("Keep talking review fixes (issue #139)", () => {
  // A pool booted over events written by hand, the way a restart finds
  // them: the checkpoint's Held pane is decided at boot from the events
  // alone, against a pane the fake daemon lists.
  async function bootOver(options: {
    id: string;
    marker: string;
    events: { attempt: number; kind: Parameters<typeof appendEvent>[2]["kind"]; payload?: Record<string, unknown> }[];
    paneId: string;
  }): Promise<PoolRun> {
    const poolDir = makePool({
      tickets: [{ file: `${options.id}.md`, marker: options.marker, body: "# Held?\n\nbody\n\n## Brief\n\nask me" }],
      config,
    });
    for (const event of options.events) {
      appendEvent(join(poolDir, "runs"), options.id, {
        at: new Date(Date.now() - 60_000).toISOString(),
        attempt: event.attempt,
        kind: event.kind,
        payload: { cwd: poolDir, ...(event.payload ?? {}) },
      });
    }
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.injectPane(options.paneId, { cwd: poolDir });
    const { harnesses } = tuiHarness(poolDir, {});
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the checkpoint Interrupt", () => run.interrupts.some((i) => i.kind === "checkpoint"));
    await Bun.sleep(300);
    return run;
  }

  const CHECKPOINTED = "<!-- state: id=01 blocked-by= status=checkpoint -->";
  const spawnedInPane = { argv: ["tui"], pane_id: "p-x", tab_id: "tab-ghost", branch: null };

  it("holds the checkpointed attempt's own pane at boot", async () => {
    const run = await bootOver({
      id: "01",
      marker: CHECKPOINTED,
      paneId: "p-x",
      events: [
        { attempt: 1, kind: "spawned", payload: spawnedInPane },
        { attempt: 1, kind: "exited", payload: { status: "checkpoint" } },
        { attempt: 1, kind: "checkpoint" },
      ],
    });
    expect(latest(run).heldPanes["01"]).toEqual({ attempt: 1, paneId: "p-x" });
  }, 30_000);

  it("holds nothing for an engine-raised checkpoint about a held branch (review item 11)", async () => {
    const run = await bootOver({
      id: "01",
      marker: CHECKPOINTED,
      paneId: "p-x",
      events: [
        { attempt: 1, kind: "spawned", payload: spawnedInPane },
        { attempt: 1, kind: "exited", payload: { status: "checkpoint" } },
        { attempt: 1, kind: "branch-held", payload: { branch: "b", directory: "/elsewhere" } },
        { attempt: 1, kind: "checkpoint" },
      ],
    });
    expect(latest(run).heldPanes["01"]).toBeUndefined();
  }, 30_000);

  const ENLISTED = "<!-- state: id=enlist-1 blocked-by= status=checkpoint enlisted-from=p-op -->";
  const enlistSpawn = {
    argv: [],
    pane_id: "p-op",
    tab_id: "tab-ghost",
    branch: "main",
    harness: "opencode",
  };

  it("holds an enlisted Ticket's checkpointed pane at boot", async () => {
    const run = await bootOver({
      id: "enlist-1",
      marker: ENLISTED,
      paneId: "p-op",
      events: [
        { attempt: 1, kind: "spawned", payload: enlistSpawn },
        { attempt: 1, kind: "exited", payload: { status: "checkpoint" } },
        { attempt: 1, kind: "checkpoint" },
      ],
    });
    expect(latest(run).heldPanes["enlist-1"]).toEqual({ attempt: 1, paneId: "p-op" });
  }, 30_000);

  it("never holds an enlisted pane the pool let go, across a restart (review item 9)", async () => {
    const run = await bootOver({
      id: "enlist-1",
      marker: ENLISTED,
      paneId: "p-op",
      events: [
        { attempt: 1, kind: "spawned", payload: enlistSpawn },
        { attempt: 1, kind: "exited", payload: { status: "checkpoint" } },
        { attempt: 1, kind: "let-go", payload: { pane_id: "p-op" } },
        { attempt: 1, kind: "checkpoint" },
      ],
    });
    expect(latest(run).heldPanes["enlist-1"]).toBeUndefined();
  }, 30_000);

  it("never counts or closes a finished tab whose agent was enlisted afterwards (review item 2)", async () => {
    // 01 finishes and leaves its tab open (w1:t1 over w1:p1, the fake's
    // first); the operator then enlisted that live agent as enlist-1.
    const poolDir = makePool({
      tickets: [
        { file: "01.md", marker: READY, body: "# Done and left open\n\nbody" },
        {
          file: "enlist-1.md",
          marker: "<!-- state: id=enlist-1 blocked-by= status=done enlisted-from=w1:p1 -->",
          body: "# Enlisted from a finished tab\n\nbody",
        },
      ],
      config,
    });
    appendEvent(join(poolDir, "runs"), "enlist-1", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { argv: [], cwd: poolDir, branch: "main", pane_id: "w1:p1", tab_id: "w1:t1", harness: "tui" },
    });
    const { harnesses } = tuiHarness(poolDir, {
      "01": [{ status: "done", summary: "done", commitSha: null }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("01 done", () => run.final.tickets["01"] === "done");
    await Bun.sleep(300);
    expect(latest(run).finishedTerminals).toBe(0);
    expect(await run.closeFinishedTerminals()).toBe(0);
    expect(fake.requests.some((r) => r.method === "tab.close")).toBe(false);
  }, 30_000);

  it("grades a verify ticket's Continued attempt owed its grade across a restart (review item 6)", async () => {
    const { run, poolDir, fake, quit } = await checkpointed({ git: true, verify: 1 });
    await run.keepTalking("01");
    await until("the teaching Turn", () => fake.submitted.length > 0);
    await run.shutdown(200);
    runs.splice(runs.indexOf(run), 1);
    // While the engine was down the attempt ended done and its exit was
    // recorded, but no grade was: the state a Stop between the two leaves.
    writeFileSync(
      join(poolDir, "runs", "01.attempt-2.outcome.json"),
      JSON.stringify({ status: "done", summary: "done before the stop", commitSha: null }),
    );
    appendEvent(join(poolDir, "runs"), "01", {
      at: new Date().toISOString(),
      attempt: 2,
      kind: "exited",
      payload: { code: 0, status: "done", logTail: [], outcomeExists: true },
    });
    writeFileSync(quit, "");
    const spawnsBefore = spawnedPanes(poolDir).length;
    const { harnesses } = tuiHarness(poolDir, {});
    const again = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(again);
    await until("the owed grade's done", () => again.final.tickets["01"] === "done", 20_000);
    const events = readEvents(join(poolDir, "runs"), "01");
    expect(events.filter((e) => e.kind === "graded").map((e) => e.attempt)).toEqual([1, 2]);
    // No fresh fan-out: the ticket never re-ran.
    expect(spawnedPanes(poolDir).length).toBe(spawnsBefore);
  }, 40_000);

  // 01 ran alone, so in the pool checkout, and is continued there. A
  // Conversation then spawns a ticket, which runs in its own worktree and
  // finishes done while 01's conversation goes on: its merge waits at the
  // pool checkout's gate.
  async function heldMerge() {
    const { run, poolDir, fake } = await checkpointed({
      git: true,
      outcomes: {
        "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }],
        "*": [{ status: "done", summary: "spawned work", commitSha: null }],
      },
    });
    await run.keepTalking("01");
    const view = await run.startConversation({ title: "Spawner" });
    writeFileSync(
      join(poolDir, "runs", `${view.id}.spawn.json`),
      JSON.stringify({ spawn: [{ title: "Side ticket", body: "do a small side thing please, in its own worktree" }] }),
    );
    const spawned = (): string | undefined =>
      Object.keys(run.final.tickets).find((id) => id.startsWith(`${view.id}-spawn`));
    await until(
      "the spawned ticket done",
      () => {
        const id = spawned();
        return id !== undefined && run.final.tickets[id] === "done";
      },
      20_000,
    );
    await Bun.sleep(300);
    const id = spawned()!;
    expect(readEvents(join(poolDir, "runs"), id).some((e) => e.kind === "merged")).toBe(false);
    return { run, poolDir, fake, id };
  }

  it("records a merge held at the gate at once, with no drive running, and redoes it after a restart (M1)", async () => {
    // 02's attempt runs in its worktree, re-adopted at boot; 01 runs alone
    // in the pool checkout, checkpoints, and is continued there, so the pool
    // is quiescent when 02 ends done and its merge meets the held gate.
    const { poolDir } = makeGitPool({
      tickets: [
        { file: "01.md", marker: READY, body: "# First\n\nbody" },
        { file: "02.md", marker: "<!-- state: id=02 blocked-by= status=in-progress -->", body: "# Second\n\nbody" },
      ],
      config,
    });
    const worktree = worktreePathFor(poolDir, "02");
    const branch = branchFor(poolDir, "02");
    Bun.spawnSync(["git", "-C", poolDir, "worktree", "add", "-q", "-b", branch, worktree], {
      stdout: "ignore",
      stderr: "ignore",
    });
    appendEvent(join(poolDir, "runs"), "02", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { argv: ["tui"], cwd: worktree, branch, pane_id: "p-02", tab_id: "t-02" },
    });
    const { harnesses } = tuiHarness(poolDir, {
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }],
    });
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.injectPane("p-02", { tabId: "t-02", cwd: worktree, workspaceId: "w1" });
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, enlistPollMs: 50, paneSurveyMs: 50 });
    runs.push(run);
    await until("01's Held pane", () => latest(run).heldPanes["01"] !== undefined);
    await run.keepTalking("01");
    await run.settled;
    commitIn(worktree, "held.txt");
    writeFileSync(
      join(poolDir, "runs", "02.outcome.json"),
      JSON.stringify({ status: "done", summary: "done", commitSha: null }),
    );
    await until("the merge-deferred record", () =>
      readEvents(join(poolDir, "runs"), "02").some((e) => e.kind === "merge-deferred"),
    );
    expect(existsSync(join(poolDir, "held.txt"))).toBe(false);
    await run.shutdown(300);
    runs.splice(runs.indexOf(run), 1);

    const again = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, enlistPollMs: 50, paneSurveyMs: 50 });
    runs.push(again);
    await until("01 re-adopted", () => latest(again).liveAttempts["01"]?.attempt === 2);
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked", commitSha: null }),
    );
    await until("the redone merge", () => existsSync(join(poolDir, "held.txt")), 20_000);
    expect(readEvents(join(poolDir, "runs"), "02").some((e) => e.kind === "merged")).toBe(true);
  }, 60_000);

  it("redoes a merge a Stop dropped at the pool checkout's gate once the Continued attempt ends after the restart (F2)", async () => {
    const { run, poolDir, fake, id } = await heldMerge();
    await run.shutdown(300);
    runs.splice(runs.indexOf(run), 1);
    const deferred = readEvents(join(poolDir, "runs"), id).filter((e) => e.kind === "merge-deferred");
    expect(deferred).toHaveLength(1);

    const { harnesses } = tuiHarness(poolDir, {});
    const again = startPool({
      poolDir,
      harnesses,
      herdrSocket: fake.socketPath,
      enlistPollMs: 50,
      paneSurveyMs: 50,
    });
    runs.push(again);
    // The Continued attempt is re-adopted and still holds the checkout; the
    // redone merge waits at the gate again.
    await until("01 re-adopted", () => latest(again).liveAttempts["01"]?.attempt === 2);
    await Bun.sleep(300);
    expect(readEvents(join(poolDir, "runs"), id).some((e) => e.kind === "merged")).toBe(false);
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked", commitSha: null }),
    );
    await until(
      "the redone merge",
      () => readEvents(join(poolDir, "runs"), id).some((e) => e.kind === "merged"),
      20_000,
    );
  }, 60_000);

  it("holds merges into the pool checkout while a Continued attempt works there (review item 3)", async () => {
    // 01 ran alone, so in the pool checkout; a Conversation works in its own
    // worktree meanwhile, and its End's merge waits for the conversation in
    // the checkout to end.
    const { run, poolDir } = await checkpointed({ git: true });
    const [first] = spawnedPanes(poolDir);
    expect(readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "spawned")!.payload.cwd).toBe(poolDir);
    void first;
    await run.keepTalking("01");
    const view = await run.startConversation({ title: "Side work" });
    const worktree = worktreePathFor(poolDir, view.id);
    writeFileSync(join(worktree, "side.txt"), "side\n");
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "ignore", stderr: "ignore" });
    git(["add", "side.txt"]);
    git(["commit", "-qm", "side work"]);
    // The End answers at once (R4): its ending is recorded and its tab
    // closed, and its merge waits at the gate, off the caller.
    await run.endConversation(view.id);
    await Bun.sleep(500);
    expect(existsSync(join(poolDir, "side.txt"))).toBe(false);
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked", commitSha: null }),
    );
    await until("the held merge", () => existsSync(join(poolDir, "side.txt")));
    expect(run.final.tickets["01"]).toBe("done");
  }, 40_000);

  // A worktree, not the pool checkout: two tickets ready at once each get
  // their own, and a done attempt there has a branch to merge.
  async function twoInWorktrees(outcomes: Record<string, Record<string, unknown>[]>) {
    const { poolDir } = makeGitPool({
      tickets: [
        { file: "01.md", marker: READY, body: "# First\n\nbody" },
        { file: "02.md", marker: "<!-- state: id=02 blocked-by= status=ready -->", body: "# Second\n\nbody" },
      ],
      config,
    });
    const { harnesses, quit } = tuiHarness(poolDir, outcomes);
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    return { poolDir, harnesses, quit, fake };
  }

  function commitIn(worktree: string, file: string): void {
    writeFileSync(join(worktree, file), "work\n");
    const git = (args: string[]) => Bun.spawnSync(["git", "-C", worktree, ...args], { stdout: "ignore", stderr: "ignore" });
    git(["add", file]);
    git(["commit", "-qm", `add ${file}`]);
  }

  it("merges a Continued attempt that ends done in a worktree onto the target", async () => {
    const { poolDir, harnesses, fake } = await twoInWorktrees({
      "01": [{ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }],
      "02": [{ status: "done", summary: "done", commitSha: null }],
    });
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, enlistPollMs: 50, paneSurveyMs: 50 });
    runs.push(run);
    await until("01's Held pane", () => latest(run).heldPanes["01"] !== undefined);
    const worktree = worktreePathFor(poolDir, "01");
    expect(readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "spawned")!.payload.cwd).toBe(worktree);
    await run.keepTalking("01");
    commitIn(worktree, "continued.txt");
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "talked", commitSha: null }),
    );
    await until("the merge", () => readEvents(join(poolDir, "runs"), "01").some((e) => e.kind === "merged"), 20_000);
    expect(existsSync(join(poolDir, "continued.txt"))).toBe(true);
    expect(run.final.tickets["01"]).toBe("done");
  }, 40_000);

  it("merges a boot-re-adopted terminal attempt that ends done in a worktree onto the target", async () => {
    // What a restart finds: 01's attempt was launched into its worktree by
    // the engine before, and its pane is still running there.
    const { poolDir } = makeGitPool({
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by= status=in-progress -->", body: "# First\n\nbody" }],
      config,
    });
    const worktree = worktreePathFor(poolDir, "01");
    const branch = branchFor(poolDir, "01");
    Bun.spawnSync(["git", "-C", poolDir, "worktree", "add", "-q", "-b", branch, worktree], {
      stdout: "ignore",
      stderr: "ignore",
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { argv: ["tui"], cwd: worktree, branch, pane_id: "p-01", tab_id: "t-01" },
    });
    const { harnesses } = tuiHarness(poolDir, {});
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    // In the Pool workspace the boot will create (the fake's first, w1),
    // where boot reconciliation looks for this pool's panes.
    fake.injectPane("p-01", { tabId: "t-01", cwd: worktree, workspaceId: "w1" });
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 50 });
    runs.push(run);
    await until("the re-adoption", () => latest(run).liveAttempts["01"] !== undefined);
    expect(run.final.log.some((line) => line.includes("attempt 1 re-adopted"))).toBe(true);
    commitIn(worktree, "adopted.txt");
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "finished after the restart", commitSha: null }),
    );
    await until("the merge", () => readEvents(join(poolDir, "runs"), "01").some((e) => e.kind === "merged"), 20_000);
    expect(existsSync(join(poolDir, "adopted.txt"))).toBe(true);
    expect(run.final.tickets["01"]).toBe("done");
  }, 40_000);

  it("drops a tab from the Finished terminals count the moment the engine closes it (minor 2)", async () => {
    const { poolDir } = makeGitPool({
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by= status=done -->" }],
      config,
    });
    const { harnesses } = tuiHarness(poolDir, {});
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    // A cadence far longer than the test: every listing here is on demand.
    const run = startPool({ poolDir, harnesses, herdrSocket: fake.socketPath, paneSurveyMs: 600_000 });
    runs.push(run);
    const view = await run.startConversation({ title: "Brief" });
    // A listing while the Conversation is live: its tab is open and in use.
    expect(await run.closeFinishedTerminals()).toBe(0);
    await run.endConversation(view.id);
    await until("ended", () => latest(run).conversations.find((c) => c.id === view.id)?.status === "ended");
    await Bun.sleep(300);
    expect(latest(run).finishedTerminals).toBe(0);
  }, 30_000);
});
