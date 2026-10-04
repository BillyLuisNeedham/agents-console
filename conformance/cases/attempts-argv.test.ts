/**
 * Headless and terminal-backed harness launch, seen from outside the server
 * (ADR-0036): the argv, environment, working directory and stdin each
 * harness binary is started with, the prompt it is handed, the Stream file
 * and log a launch leaves, and the facts its spawned, exited and crash
 * events record. Ticket C11 of the Rust port inventory
 * (docs/research/rust-port/test-inventory.md, `attempts`); each case names
 * the inventory rows it covers.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TicketEvent } from "../../engine/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import type { HerdrCall, HerdrProcess } from "../harness/herdr.ts";
import { readEvents, readStateLine, readTicketFile, until } from "../harness/pool-files.ts";
import { batchPromptArg, ticketPrompt, typedPrompt, type HarnessName } from "../harness/prompts.ts";
import type { World } from "../harness/world.ts";

const STUB_SCRIPT = join(import.meta.dir, "..", "fixtures", "stub-harness.sh");

/** Each harness's binary on PATH: cursor's is `agent`. */
const BINARY: Record<HarnessName, string> = { claude: "claude", opencode: "opencode", cursor: "agent" };

/** One ready Ticket's file, titled after its id. */
function ready(id: string, blockedBy = "none"): { file: string; marker: string; body: string } {
  return {
    file: `${id}-t.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
    body: `# Ticket ${id}\n\nDo ${id}.`,
  };
}

/**
 * Replace one stubbed binary with a case's own bash script. The preamble
 * finds what the shared stub finds (the Outcome path, the Ticket file and
 * the launch's key) and names the world's root `$out`; the body may end in
 * `delegate`, which hands the launch to the shared stub as it is.
 */
function customStub(world: World, binary: string, body: string): void {
  const script = [
    "#!/usr/bin/env bash",
    "issue=''; outcome=''",
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    *"outcome as JSON at "*)',
    '      rest="${arg#*outcome as JSON at }"; outcome="${rest%%:*}"',
    "      first=\"${arg%%$'\\n'*}\"; issue=\"${first##* }\"; break ;;",
    "  esac",
    "done",
    `if [ -n "$outcome" ]; then key="$(basename "$outcome" .outcome.json)"; else key="_${binary}"; fi`,
    `out=${JSON.stringify(world.root)}`,
    `delegate() { exec bash ${JSON.stringify(STUB_SCRIPT)} ${binary} "$@"; }`,
    body,
    "",
  ].join("\n");
  const path = join(world.stubs.bin, binary);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** A stub body line that records whether stdin was at EOF, then hands on. */
const RECORD_STDIN = [
  "if IFS= read -r -t 2 _line; then s=data; else rc=$?; if [ $rc -gt 128 ]; then s=open; else s=eof; fi; fi",
  'printf \'%s\' "$s" > "$out/stdin-$key"',
  'delegate "$@"',
].join("\n");

/** One claude stream-json assistant line carrying text. */
function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

/** One claude stream-json assistant line carrying a tool call. */
function toolLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

/** The worktree key the engine names a repository's worktrees and branches by. */
function poolKey(repo: string): string {
  return createHash("sha256").update(realpathSync(repo)).digest("hex").slice(0, 8);
}

function eventsOf(world: World, id: string, kind: string): TicketEvent[] {
  return readEvents(world.pool, id).filter((event) => event.kind === kind);
}

function waitForEvent(world: World, id: string, kind: string, ms = 20_000, count = 1): Promise<TicketEvent[]> {
  return until(
    () => eventsOf(world, id, kind),
    (found) => found.length >= count,
    { ms, what: `${id}'s ${kind} event` },
  );
}

interface StateBody {
  snapshot: {
    phase: string;
    state: { interrupts: { ticketId: string; kind: string; body: string }[] };
  } | null;
}

async function state(server: CaseServer): Promise<NonNullable<StateBody["snapshot"]>> {
  const answer = await server.http.get("/api/state");
  return answer.json<StateBody>().snapshot!;
}

/** Wait for the final Review and approve it, then for the run to be done. */
async function approveReview(server: CaseServer): Promise<void> {
  await until(
    () => state(server),
    (s) => s.state.interrupts.some((i) => i.ticketId === "REVIEW"),
    { ms: 30_000, what: "the final Review" },
  );
  const answer = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
  expect(answer.status).toBe(202);
  await until(() => state(server), (s) => s.phase === "done", { ms: 15_000, what: "the run to end done" });
}

function readRuns(world: World, name: string): string {
  return readFileSync(join(world.pool, "runs", name), "utf8");
}

/** The pane input calls the server made on one pane, in order. */
function inputsTo(herdr: HerdrProcess, paneId: string, upTo = herdr.calls.length): HerdrCall[] {
  return herdr.calls
    .slice(0, upTo)
    .filter((call) => call.method === "pane.send_input" && call.params.pane_id === paneId);
}

// ---------------------------------------------------------------------------
// The headless argv, every harness, with and without effort
// ---------------------------------------------------------------------------

// The six launches the effort rows ask for, one Ticket each: every harness
// with an effort and without one.
const MATRIX: { id: string; harness: HarnessName; model: string; effort?: string }[] = [
  { id: "01", harness: "claude", model: "claude-test", effort: "high" },
  { id: "02", harness: "opencode", model: "opencode-test", effort: "minimal" },
  { id: "03", harness: "cursor", model: "cursor-test", effort: "high" },
  { id: "04", harness: "claude", model: "m" },
  { id: "05", harness: "opencode", model: "m" },
  { id: "06", harness: "cursor", model: "m" },
];

const AGENT_MD = "Do the thing.\n";

function matrixWorld(t: Case, terminal: boolean): World {
  return t.world({
    tickets: MATRIX.map((m) => ready(m.id)),
    config: {
      defaults: { harness: "claude", model: "m" },
      assign: Object.fromEntries(
        MATRIX.map((m) => [m.id, { harness: m.harness, model: m.model, ...(m.effort ? { effort: m.effort } : {}) }]),
      ),
      ...(terminal ? { terminal: "herdr" as const } : {}),
      // A key the engine no longer reads: a leftover roster must not reach any argv.
      ...({ agents: { reviewer: "deepseek" } } as object),
    },
    agentMd: AGENT_MD,
  });
}

/** The batch argv after the binary name, the prompt argument given. */
function batchArgs(harness: HarnessName, model: string, effort: string | undefined, prompt: string): string[] {
  switch (harness) {
    case "claude":
      return [
        "-p", prompt, "--model", model, ...(effort ? ["--effort", effort] : []),
        "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
      ];
    case "opencode":
      return ["run", "--command", "implement", prompt, "--model", model, ...(effort ? ["--variant", effort] : []), "--auto"];
    case "cursor":
      return ["-p", prompt, "--model", model, "--force", "--trust", "--output-format", "stream-json"];
  }
}

/** The interactive argv after the binary name. */
function interactiveArgs(harness: HarnessName, model: string, effort: string | undefined): string[] {
  switch (harness) {
    case "claude":
      return ["--model", model, ...(effort ? ["--effort", effort] : []), "--permission-mode", "auto"];
    case "opencode":
      return ["--model", model, "--auto"];
    case "cursor":
      return ["--model", model, "--force", "--trust"];
  }
}

/** Whether the launch's mode carries the effort, per harness. */
const EFFORT_APPLIES: Record<"batch" | "interactive", Record<HarnessName, boolean>> = {
  batch: { claude: true, opencode: true, cursor: false },
  interactive: { claude: true, opencode: false, cursor: false },
};

/** What each matrix stub prints: two stream-json lines and a plain one. */
function matrixStdout(id: string): string {
  return `${assistantLine(`text from ${id}`)}\n${toolLine("Bash", { command: `make ${id}` })}\nstub output ${id}\n`;
}

// spawn.test.ts:33, :51 (headless), :56, :76, :154, :257, :297/:311/:326/:333/:343/:352 (headless),
// :375, :393; engine.test.ts:4792, :4828, :4851, :5266
conformance("attempts", "a headless launch runs each harness's batch argv, effort only where it takes one, with stdin at EOF", async (t) => {
  const world = matrixWorld(t, false);
  for (const m of MATRIX) world.stubs.script(m.id, { stdout: matrixStdout(m.id) });
  for (const binary of Object.values(BINARY)) customStub(world, binary, RECORD_STDIN);
  const head = world.git(["rev-parse", "HEAD"]).trim();
  const server = await t.start(world);
  await approveReview(server);

  const key = poolKey(world.repo);
  const runs = join(world.pool, "runs");
  const calls = world.stubs.calls();
  expect(calls.map((c) => c.key).sort()).toEqual(MATRIX.map((m) => m.id));
  for (const m of MATRIX) {
    const call = calls.find((c) => c.key === m.id)!;
    const issue = join(world.pool, "issues", `${m.id}-t.md`);
    const body = ticketPrompt({ agentMd: AGENT_MD, runs, outcome: m.id });
    const prompt = batchPromptArg(m.harness, "implement", issue, body);
    // The argv, prompt and all, byte for byte; never --agents, and no
    // trace of the leftover roster key.
    expect(call.harness).toBe(BINARY[m.harness]);
    expect(call.argv).toEqual(batchArgs(m.harness, m.model, m.effort, prompt));
    expectSameBytes(call.argv[m.harness === "opencode" ? 3 : 1]!, prompt, `${m.id}'s prompt argument`);
    expect(call.argv).not.toContain("--agents");
    expect(call.argv.join(" ")).not.toContain("deepseek");
    // stdin closed, and PWD the attempt's own working directory.
    expect(readFileSync(join(world.root, `stdin-${m.id}`), "utf8")).toBe("eof");
    const worktree = join(world.repo, ".git", "pool-worktrees", key, m.id);
    expect(call.cwd).toBe(worktree);
    expect(call.env.PWD).toBe(worktree);

    // The spawned event: the same argv with the prompt body elided, the
    // engine's env delta, and the effort facts only when an effort was set.
    const [spawned] = eventsOf(world, m.id, "spawned");
    const elided = batchPromptArg(m.harness, "implement", issue, "<prompt>");
    expect(spawned!.payload).toEqual({
      argv: [BINARY[m.harness], ...batchArgs(m.harness, m.model, m.effort, elided)],
      cwd: worktree,
      branch: `pool/${key}/${m.id}`,
      commitSha: head,
      env: { PWD: worktree },
      harness: m.harness,
      model: m.model,
      pid: expect.any(Number),
      ...(m.effort ? { effort: m.effort, effort_applied: EFFORT_APPLIES.batch[m.harness] } : {}),
    });
    expect(JSON.stringify(spawned!.payload)).not.toContain("Standing instructions");
    // The engine wrote done; the stub never touched the Ticket file.
    expect(readStateLine(world.pool, `${m.id}-t.md`).status).toBe("done");

    // The Stream file: claude and cursor tee stdout verbatim and derive the
    // log from it; opencode's raw stdout is the log, with no Stream file.
    const streamPath = join(runs, `${m.id}.stream.jsonl`);
    if (m.harness === "opencode") {
      expect(existsSync(streamPath)).toBe(false);
      expectSameBytes(readRuns(world, `${m.id}.log`), matrixStdout(m.id), `${m.id}.log`);
    } else {
      expectSameBytes(readRuns(world, `${m.id}.stream.jsonl`), matrixStdout(m.id), `${m.id}.stream.jsonl`);
      expectSameBytes(
        readRuns(world, `${m.id}.log`),
        `text from ${m.id}\n[tool] Bash: make ${m.id}\nstub output ${m.id}\n`,
        `${m.id}.log`,
      );
    }
  }
}, { timeoutMs: 90_000 });

// ---------------------------------------------------------------------------
// The terminal-backed argv and the typed prompt
// ---------------------------------------------------------------------------

/** A frame every harness reads as ready: each one's ready text. */
const ALL_READY = "Claude Code v2.0.0 · Ask anything · Cursor Agent\n❯ ";

/** Stubs a TUI launch holds open until `release` exists. */
function holdTuiStubs(world: World, release: string): void {
  for (const binary of Object.values(BINARY)) world.stubs.script(`_${binary}`, { outcome: null, waitFor: release });
}

// spawn.test.ts:51 (terminal), :177, :212, :223, :268, :297/:311/:326/:333/:343/:352 (terminal)
conformance("attempts", "a terminal-backed launch runs each harness's interactive argv and types the shaped prompt", async (t) => {
  const world = matrixWorld(t, true);
  const release = join(world.root, "release");
  holdTuiStubs(world, release);
  const herdr = await t.herdr(world, { rendered: ALL_READY });
  await t.start(world, { herdr });
  const submitted = await until(
    () => herdr.control<string[]>("submitted"),
    (s) => s.length >= MATRIX.length,
    { ms: 30_000, what: "every prompt typed" },
  );
  writeFileSync(release, "");

  const key = poolKey(world.repo);
  const runs = join(world.pool, "runs");
  // A launch's record is whole only once it has written its env, which can
  // land after its prompt was typed: wait for every one.
  const calls = await until(() => world.stubs.calls(), (c) => c.length >= MATRIX.length, {
    what: "every launch recorded",
  });
  for (const m of MATRIX) {
    const worktree = join(world.repo, ".git", "pool-worktrees", key, m.id);
    const call = calls.find((c) => c.cwd === worktree)!;
    // The TUI argv: no -p, run or --output-format, the auto-approve flags
    // kept, effort only on claude's.
    expect(call.harness).toBe(BINARY[m.harness]);
    expect(call.argv).toEqual(interactiveArgs(m.harness, m.model, m.effort));
    for (const batchOnly of ["-p", "run", "--output-format", "--agents", "--variant"]) {
      expect(call.argv).not.toContain(batchOnly);
    }
    const [spawned] = eventsOf(world, m.id, "spawned");
    expect(spawned!.payload).toMatchObject({
      argv: [BINARY[m.harness], ...interactiveArgs(m.harness, m.model, m.effort)],
      cwd: worktree,
      env: { PWD: worktree },
      harness: m.harness,
      model: m.model,
      pane_id: expect.any(String),
    });
    if (m.effort) {
      expect(spawned!.payload.effort).toBe(m.effort);
      expect(spawned!.payload.effort_applied).toBe(EFFORT_APPLIES.interactive[m.harness]);
    } else {
      expect(spawned!.payload).not.toHaveProperty("effort");
      expect(spawned!.payload).not.toHaveProperty("effort_applied");
    }
    // The typed prompt: the driver line, the body, the Ticket file alone on
    // the last line, whatever the harness.
    const issue = join(world.pool, "issues", `${m.id}-t.md`);
    const typed = submitted.filter((text) => text.includes(`${m.id}-t.md`));
    expect(typed.length).toBe(1);
    expectSameBytes(
      typed[0]!,
      typedPrompt("implement", issue, ticketPrompt({ agentMd: AGENT_MD, runs, outcome: m.id })),
      `${m.id}'s typed prompt`,
    );
  }
}, { timeoutMs: 90_000 });

/** Three Tickets, one per harness, on a terminal-backed pool. */
function threeHarnessWorld(t: Case): World {
  return t.world({
    tickets: ["01", "02", "03"].map((id) => ready(id)),
    config: {
      defaults: { harness: "claude", model: "m" },
      assign: { "01": { harness: "claude" }, "02": { harness: "opencode" }, "03": { harness: "cursor" } },
      terminal: "herdr",
    },
  });
}

const HARNESS_OF: Record<string, HarnessName> = { "01": "claude", "02": "opencode", "03": "cursor" };
const READY_TEXT: Record<HarnessName, string> = { claude: "Claude Code v2.0.0", opencode: "Ask anything", cursor: "Cursor Agent" };

// spawn.test.ts:121
conformance("attempts", "a TUI is typed into only once its ready text shows, and only claude and cursor take the paste marker as the echo", async (t) => {
  const world = threeHarnessWorld(t);
  const release = join(world.root, "release");
  holdTuiStubs(world, release);
  // Every paste is hidden from the frame once: what shows instead is the
  // collapsed-paste marker claude and cursor draw.
  const herdr = await t.herdr(world, { rendered: "", hideInputs: 1 });
  await t.start(world, { herdr });

  const typedFrom: Record<string, number> = {};
  for (const id of ["01", "02", "03"]) {
    const [spawned] = await waitForEvent(world, id, "spawned");
    const pane = spawned!.payload.pane_id as string;
    // Held back a while, then the ready frame arrives.
    await Bun.sleep(1_000);
    await herdr.control("setPaneContent", pane, `${READY_TEXT[HARNESS_OF[id]!]}\n[Pasted text #1 +40 lines]\n❯ `);
    typedFrom[id] = herdr.calls.length;
  }
  await until(() => herdr.control<string[]>("submitted"), (s) => s.length >= 3, { ms: 30_000, what: "three prompts typed" });
  writeFileSync(release, "");

  for (const id of ["01", "02", "03"]) {
    const pane = eventsOf(world, id, "spawned")[0]!.payload.pane_id as string;
    const issue = `${id}-t.md`;
    const pastes = (calls: HerdrCall[]) => calls.filter((c) => typeof c.params.text === "string" && String(c.params.text).includes(issue));
    // Nothing of the prompt went in before the ready text showed.
    expect(pastes(inputsTo(herdr, pane, typedFrom[id]))).toEqual([]);
    const after = inputsTo(herdr, pane);
    const clears = after.filter((c) => Array.isArray(c.params.keys) && (c.params.keys as string[]).includes("ctrl+c"));
    if (HARNESS_OF[id] === "opencode") {
      // No marker of its own: the hidden paste reads as lost, so it clears and pastes again.
      expect(clears.length).toBe(1);
      expect(pastes(after).length).toBe(2);
    } else {
      expect(clears).toEqual([]);
      expect(pastes(after).length).toBe(1);
    }
  }
}, { timeoutMs: 90_000 });

// spawn.test.ts:136
conformance("attempts", "a dropped paste is cleared with ctrl+c and pasted again on opencode and cursor, while claude crashes after its one paste", async (t) => {
  const world = threeHarnessWorld(t);
  const release = join(world.root, "release");
  holdTuiStubs(world, release);
  const herdr = await t.herdr(world, { rendered: ALL_READY, dropInputs: 1 });
  await t.start(world, { herdr });

  const [crash] = await waitForEvent(world, "01", "crash", 30_000);
  expect(crash!.payload.reason).toBe("prompt never landed");
  await until(() => herdr.control<string[]>("submitted"), (s) => s.length >= 2, { ms: 30_000, what: "two prompts typed" });
  writeFileSync(release, "");

  for (const id of ["01", "02", "03"]) {
    const pane = eventsOf(world, id, "spawned")[0]!.payload.pane_id as string;
    const after = inputsTo(herdr, pane);
    const pastes = after.filter((c) => typeof c.params.text === "string" && String(c.params.text).includes(`${id}-t.md`));
    const clears = after.filter((c) => Array.isArray(c.params.keys) && (c.params.keys as string[]).includes("ctrl+c"));
    if (id === "01") {
      expect(pastes.length).toBe(1);
      expect(clears).toEqual([]);
    } else {
      expect(clears.length).toBe(1);
      expect(pastes.length).toBe(2);
    }
  }
}, { timeoutMs: 90_000 });

// ---------------------------------------------------------------------------
// The Stream file and the derived log, live
// ---------------------------------------------------------------------------

// engine.test.ts:4639
conformance("attempts", "a claude attempt's stream is teed verbatim and its log derived live", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "claude-test" } } });
  const system = '{"type":"system","subtype":"init"}';
  const first = [system, assistantLine("Reading the ticket."), toolLine("Bash", { command: "bun test engine/" }), "this is not json at all"];
  const last = assistantLine("All done.");
  customStub(world, "claude", [
    ...first.map((line) => `printf '%s\\n' ${JSON.stringify(line).replace(/\$/g, "\\$")}`),
    'while [ ! -f "$out/release" ]; do sleep 0.02; done',
    `printf '%s\\n' ${JSON.stringify(last)}`,
    'printf \'{"status":"done","summary":"s","commitSha":null}\' > "$outcome"',
  ].join("\n"));
  const server = await t.start(world);

  // Mid-run, with the stub held: the log already shows the first burst.
  await until(
    () => (existsSync(join(world.pool, "runs", "01.log")) ? readRuns(world, "01.log") : ""),
    (text) => text.includes("this is not json at all"),
    { what: "the first burst in 01.log" },
  );
  expectSameBytes(readRuns(world, "01.log"), "Reading the ticket.\n[tool] Bash: bun test engine/\nthis is not json at all\n", "01.log mid-run");
  writeFileSync(join(world.root, "release"), "");
  await approveReview(server);

  expectSameBytes(
    readRuns(world, "01.log"),
    "Reading the ticket.\n[tool] Bash: bun test engine/\nthis is not json at all\nAll done.\n",
    "01.log",
  );
  expectSameBytes(readRuns(world, "01.stream.jsonl"), `${[...first, last].join("\n")}\n`, "01.stream.jsonl");
});

// engine.test.ts:4699
conformance("attempts", "a killed claude attempt keeps its log and Stream file up to the kill", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "claude-test" } } });
  const lines = [assistantLine("before the kill"), toolLine("Bash", { command: "sleep 100" })];
  customStub(world, "claude", [
    ...lines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`),
    'while [ ! -f "$out/release" ]; do sleep 0.02; done',
    "kill -9 $$",
  ].join("\n"));
  const server = await t.start(world);

  await until(
    () => (existsSync(join(world.pool, "runs", "01.log")) ? readRuns(world, "01.log") : ""),
    (text) => text.includes("[tool] Bash: sleep 100"),
    { what: "the tool line in 01.log" },
  );
  writeFileSync(join(world.root, "release"), "");
  await waitForEvent(world, "01", "crash");

  expect(readEvents(world.pool, "01").map((e) => e.kind)).toEqual(["scheduled", "spawned", "exited", "crash"]);
  expect(eventsOf(world, "01", "exited")[0]!.payload.code).toBe(137);
  expectSameBytes(readRuns(world, "01.log"), "before the kill\n[tool] Bash: sleep 100\n", "01.log");
  expectSameBytes(readRuns(world, "01.stream.jsonl"), `${lines.join("\n")}\n`, "01.stream.jsonl");
  const s = await until(() => state(server), (got) => got.state.interrupts.length > 0, { what: "the crash Interrupt" });
  expect(s.state.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([["01", "crash"]]);
});

// engine.test.ts:4749
conformance("attempts", "a re-run rotates both the log and the Stream file", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "claude-test" } } });
  const firstLine = assistantLine("first run text");
  const secondLine = assistantLine("second run text");
  world.stubs.script("01", {
    statuses: ["keep", "done"],
    exitCodes: [1, 0],
    stdout: [`${firstLine}\n`, `${secondLine}\n`],
  });
  const server = await t.start(world);
  await waitForEvent(world, "01", "crash");
  expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
  await approveReview(server);

  expectSameBytes(readRuns(world, "01.attempt-1.log"), "first run text\n", "01.attempt-1.log");
  expectSameBytes(readRuns(world, "01.attempt-1.stream.jsonl"), `${firstLine}\n`, "01.attempt-1.stream.jsonl");
  expectSameBytes(readRuns(world, "01.log"), "second run text\n", "01.log");
  expectSameBytes(readRuns(world, "01.stream.jsonl"), `${secondLine}\n`, "01.stream.jsonl");
  expect(eventsOf(world, "01", "spawned").map((e) => e.attempt)).toEqual([1, 2]);
});

// ---------------------------------------------------------------------------
// Exit facts and crash bodies
// ---------------------------------------------------------------------------

// engine.test.ts:4911, :5301
conformance("attempts", "the exited and crash events carry the log tail and outcome fact, and the crash body quotes both", async (t) => {
  const world = t.world({
    tickets: [ready("01"), ready("02"), ready("03")],
    config: { defaults: { harness: "claude", model: "m" } },
  });
  // 01: two lines and exit 7 with no Outcome, then on resume a line and an
  // Outcome that is not JSON. 02: one line, no Outcome, exit 1. 03: done.
  customStub(world, "claude", [
    'if [ "$key" = "01" ]; then',
    '  if [ ! -f "$out/01-ran" ]; then touch "$out/01-ran"; echo first-out-line; echo second-out-line; exit 7; fi',
    "  echo retry-line; printf 'not json' > \"$outcome\"; exit 0",
    "fi",
    'delegate "$@"',
  ].join("\n"));
  world.stubs.script("02", { outcome: null, exitCode: 1, stdout: "fake claude ran\n" });
  const server = await t.start(world);
  const runs = join(world.pool, "runs");

  const s = await until(
    () => state(server),
    (got) => got.state.interrupts.filter((i) => i.kind === "crash").length === 2,
    { ms: 30_000, what: "two crash Interrupts" },
  );
  const body = (id: string) => s.state.interrupts.find((i) => i.ticketId === id)!.body;
  expectSameBytes(
    body("01"),
    `crash: harness exited 7\n${runs}/01.log\n\nfirst-out-line\nsecond-out-line\n\noutcome file: ${runs}/01.outcome.json (missing)\n`,
    "01's crash body",
  );
  expectSameBytes(
    body("02"),
    `crash: harness exited 1\n${runs}/02.log\n\nfake claude ran\n\noutcome file: ${runs}/02.outcome.json (missing)\n`,
    "02's crash body",
  );
  expect(eventsOf(world, "01", "exited")[0]!.payload).toEqual({
    code: 7, status: "in-progress", logTail: ["first-out-line", "second-out-line"], outcomeExists: false,
  });
  expect(eventsOf(world, "01", "crash")[0]!.payload).toEqual({
    code: 7, reason: "harness exited 7", logTail: ["first-out-line", "second-out-line"], outcomeExists: false,
  });
  // A crash leaves the marker in progress; the done Ticket's is written by the engine.
  expect(readStateLine(world.pool, "02-t.md").status).toBe("in-progress");
  expect(readStateLine(world.pool, "03-t.md").status).toBe("done");
  expect(readTicketFile(world.pool, "03-t.md")).toBe("<!-- state: id=03 blocked-by=none status=done -->\n\n# Ticket 03\n\nDo 03.\n");

  // The retry crashes the other way: the file exists but is not JSON.
  expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
  const [, crash2] = await waitForEvent(world, "01", "crash", 20_000, 2);
  expect(crash2!.attempt).toBe(2);
  expect(crash2!.payload).toEqual({ code: 0, reason: "outcome is not parseable JSON", logTail: ["retry-line"], outcomeExists: true });
  expect(eventsOf(world, "01", "exited")[1]!.payload).toEqual({
    code: 0, status: "in-progress", logTail: ["retry-line"], outcomeExists: true,
  });
}, { timeoutMs: 90_000 });

// ---------------------------------------------------------------------------
// Where a launch runs: cwd, branch, commit, env
// ---------------------------------------------------------------------------

// engine.test.ts:5188
conformance("attempts", "a main-checkout attempt records its spawn facts against the commit it ran at", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const head = world.git(["rev-parse", "HEAD"]).trim();
  customStub(world, "claude", [
    'echo work > a.txt && git add a.txt && git commit -qm work',
    'delegate "$@"',
  ].join("\n"));
  await t.start(world);
  await until(() => readStateLine(world.pool, "01-t.md"), (m) => m.status === "done", { what: "01 done" });

  expect(world.git(["rev-parse", "HEAD"]).trim()).not.toBe(head);
  const issue = join(world.pool, "issues", "01-t.md");
  expect(eventsOf(world, "01", "spawned")[0]!.payload).toEqual({
    argv: ["claude", ...batchArgs("claude", "m", undefined, batchPromptArg("claude", "implement", issue, "<prompt>"))],
    cwd: world.repo,
    branch: null,
    commitSha: head,
    env: { PWD: world.repo },
    harness: "claude",
    model: "m",
    pid: expect.any(Number),
  });
});

// engine.test.ts:4879, :5250
conformance("attempts", "a pool outside git records its own directory, a null branch and a null commit", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "claude-test" } } });
  rmSync(join(world.repo, ".git"), { recursive: true, force: true });
  await t.start(world);
  await until(() => readStateLine(world.pool, "01-t.md"), (m) => m.status === "done", { what: "01 done" });

  const issue = join(world.pool, "issues", "01-t.md");
  expect(eventsOf(world, "01", "spawned")[0]!.payload).toEqual({
    argv: [
      "claude", "-p", `/implement ${issue}\n\n<prompt>`, "--model", "claude-test",
      "--permission-mode", "auto", "--output-format", "stream-json", "--verbose",
    ],
    cwd: world.pool,
    branch: null,
    commitSha: null,
    env: { PWD: world.pool },
    harness: "claude",
    model: "claude-test",
    pid: expect.any(Number),
  });
  expect(world.stubs.calls()[0]!.cwd).toBe(world.pool);
});

// spawn.test.ts:399
conformance("attempts", "a spawn env equal to the server's own records no env delta", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "claude", model: "m" } } });
  // Launched with PWD already the checkout the lone Ticket runs in.
  await t.start(world, { env: { PWD: world.repo } });
  await until(() => readStateLine(world.pool, "01-t.md"), (m) => m.status === "done", { what: "01 done" });
  const spawned = eventsOf(world, "01", "spawned")[0]!;
  expect(spawned.payload.cwd).toBe(world.repo);
  expect(spawned.payload.env).toEqual({});
});

// engine.test.ts:10689
conformance("attempts", "each worktree attempt gets PWD set to its own worktree, never the server's directory", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: { defaults: { harness: "opencode", model: "m" } } });
  // Not a shell: bash would reset an inherited PWD to its cwd, hiding
  // whether the server set it.
  const recorder = [
    "#!/usr/bin/env bun",
    'import { writeFileSync } from "node:fs";',
    "const message = process.argv.find((arg) => arg.includes(\"outcome as JSON at \")) ?? \"\";",
    "const outcome = message.split(\"outcome as JSON at \")[1]!.split(\":\")[0]!;",
    "const key = outcome.split(\"/\").pop()!.replace(\".outcome.json\", \"\");",
    `writeFileSync(${JSON.stringify(world.root)} + "/pwd-" + key, String(process.env.PWD ?? "(unset)"));`,
    'writeFileSync(outcome, JSON.stringify({ status: "done", summary: "s", commitSha: null }));',
    "",
  ].join("\n");
  const path = join(world.stubs.bin, "opencode");
  writeFileSync(path, recorder);
  chmodSync(path, 0o755);
  // The server's own PWD is the checkout, which no attempt runs in here.
  await t.start(world, { env: { PWD: world.repo } });
  for (const id of ["01", "02"]) {
    await until(() => readStateLine(world.pool, `${id}-t.md`), (m) => m.status === "done", { what: `${id} done` });
  }
  const key = poolKey(world.repo);
  for (const id of ["01", "02"]) {
    expect(readFileSync(join(world.root, `pwd-${id}`), "utf8")).toBe(join(world.repo, ".git", "pool-worktrees", key, id));
  }
});

// engine.test.ts:5221, :5372
conformance("attempts", "verify candidates run in worktrees cut from HEAD, and the judges in the checkout with their own exit facts", async (t) => {
  const world = t.world({
    tickets: [ready("01")],
    config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: 2 } } },
  });
  const head = world.git(["rev-parse", "HEAD"]).trim();
  // Each Candidate commits one file of its own, then finishes as the stub does.
  customStub(world, "claude", [
    'case "$key" in 01.attempt-*) n="${key##*-}"; echo "$n" > "cand-$n.txt"; git add "cand-$n.txt"; git commit -qm "cand-$n" ;; esac',
    'delegate "$@"',
  ].join("\n"));
  world.stubs.script("01-grader-1", {
    statuses: ["keep", "done"],
    exitCodes: [9, 0],
    grade: { score: 9, verdict: "pass", reasons: "recovered" },
    stdout: "grader noise line\n",
  });
  world.stubs.script("01-grader-2", { grade: { score: 8, verdict: "pass", reasons: "fine" }, stdout: "grader noise line\n" });
  // No script for 01-head-to-head: its done Outcome names no winner.
  await t.start(world);
  await until(() => readStateLine(world.pool, "01-t.md"), (m) => m.status === "done", { ms: 45_000, what: "01 done" });

  const key = poolKey(world.repo);
  for (const attempt of [1, 2]) {
    const spawned = eventsOf(world, "01", "spawned").find((e) => e.attempt === attempt)!;
    const worktree = join(world.repo, ".git", "pool-worktrees", key, `01.attempt-${attempt}`);
    expect(spawned.payload).toMatchObject({
      cwd: worktree,
      branch: `pool/${key}/01.attempt-${attempt}`,
      commitSha: head,
      env: { PWD: worktree },
    });
  }
  // The judges run in the checkout, at the commit it was at.
  const checkoutFacts = { cwd: world.repo, branch: null, commitSha: head, env: { PWD: world.repo } };
  const grader = readEvents(world.pool, "01-grader-1");
  for (const attempt of [1, 2]) {
    expect(grader.find((e) => e.kind === "spawned" && e.attempt === attempt)!.payload).toMatchObject(checkoutFacts);
  }
  expect(grader.find((e) => e.kind === "exited" && e.attempt === 1)!.payload).toEqual({
    code: 9, status: "in-progress", logTail: ["grader noise line"], outcomeExists: false,
  });
  expect(grader.find((e) => e.kind === "crash")!.payload).toEqual({
    code: 9, reason: "harness exited 9", logTail: ["grader noise line"], outcomeExists: false,
  });
  expect(grader.find((e) => e.kind === "exited" && e.attempt === 2)!.payload).toEqual({
    code: 0, status: "done", logTail: ["grader noise line"], outcomeExists: true,
  });
  const h2h = readEvents(world.pool, "01-head-to-head");
  expect(h2h.find((e) => e.kind === "spawned")!.payload).toMatchObject(checkoutFacts);
  expect(h2h.find((e) => e.kind === "exited")!.payload).toEqual({
    code: 0, status: "in-progress", logTail: [], outcomeExists: true,
  });
  expect(h2h.find((e) => e.kind === "crash")!.payload).toEqual({
    code: 0, reason: "outcome names no winner among the two attempts", logTail: [], outcomeExists: true,
  });
}, { timeoutMs: 90_000 });
