/**
 * The Stream file and the attempt log derived from it, seen from outside
 * the server (ADR-0036). A headless streamed harness (claude, cursor) has
 * its stdout teed verbatim to `<id>.stream.jsonl` while the log gets one
 * readable line per stream line: assistant text as it is, a `[tool]` line
 * per tool call, nothing for the events it has no use for, and anything it
 * does not know verbatim. stderr reaches the log and never the Stream file.
 * A raw harness (opencode) has its output passed through as the log, with
 * no Stream file. A terminal-backed Attempt's Stream file is the pane's
 * `script` typescript, and its log is that transcript less the ANSI and
 * control noise. Every spawn site streams this way: the implement Attempt,
 * the resolver, the graders and the head-to-head judge.
 *
 * Ticket C13 of the Rust port inventory (docs/research/rust-port/
 * test-inventory.md, area `attempts`); each case names the rows it covers.
 */

import { expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TicketLogResponse } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { approveReview, answer, settleOn } from "../harness/pool-run.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import {
  assistant,
  CLAUDE_READY,
  conflictWorld,
  eventsOf,
  HEADLESS,
  lines,
  printLines,
  readRuns,
  ready,
  runsExists,
  SAMPLE,
  snapshot,
  TERMINAL,
  text,
  toolUse,
  transcriptLines,
  waitForExit,
} from "./attempts-endings-support.ts";

/** A headless claude pool whose Ticket 01 prints `stdout` and ends done. */
async function streamed(t: Parameters<Parameters<typeof conformance>[2]>[0], stdout: string[]): Promise<World> {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  world.stubs.script("01", { stdout: lines(...stdout) });
  await t.start(world);
  await waitForExit(world, "01");
  return world;
}

/** The log and Stream file a headless claude Attempt leaves, byte for byte. */
function expectStreamed(world: World, id: string, raw: string[], derived: string[]): void {
  expectSameBytes(readRuns(world, `${id}.stream.jsonl`), lines(...raw), `runs/${id}.stream.jsonl`);
  expectSameBytes(readRuns(world, `${id}.log`), lines(...derived), `runs/${id}.log`);
}

// streamlog.test.ts:11 deriveStreamLine › passes assistant text through verbatim
// streamlog.test.ts:19 deriveStreamLine › keeps multi-line assistant text multi-line
// streamlog.test.ts:27 deriveStreamLine › derives one [tool] line per tool call, command as the Bash summary
// streamlog.test.ts:35 deriveStreamLine › summarizes file tools by their path field
// streamlog.test.ts:43 deriveStreamLine › falls back to the first string field for an unknown tool
// streamlog.test.ts:51 deriveStreamLine › collapses newlines inside a summary and truncates a long one
// streamlog.test.ts:65 deriveStreamLine › derives text and tool blocks of one event in content order
// streamlog.test.ts:111 deriveStreamLine › skips thinking blocks but keeps the message's text and tool calls
conformance("attempts", "a claude Attempt's log holds its assistant text verbatim and one [tool] line per tool call", async (t) => {
  const raw = [
    assistant(text("Reading the spec now.")),
    assistant(text("line one\nline two")),
    assistant(toolUse("Bash", { command: "bun test engine/" })),
    assistant(toolUse("Read", { file_path: "/a/b.ts", limit: 10 })),
    assistant(toolUse("Mystery", { count: 3, target: "the thing" })),
    assistant(toolUse("Bash", { command: "echo a\necho b" })),
    assistant(toolUse("Bash", { command: "x".repeat(300) })),
    assistant(text("Running"), toolUse("Bash", { command: "ls" })),
    assistant({ type: "thinking", thinking: "Weighing it up." }, text("The answer.")),
  ];
  const derived = [
    "Reading the spec now.",
    "line one",
    "line two",
    "[tool] Bash: bun test engine/",
    "[tool] Read: /a/b.ts",
    "[tool] Mystery: the thing",
    "[tool] Bash: echo a echo b",
    `[tool] Bash: ${"x".repeat(200)}...`,
    "Running",
    "[tool] Bash: ls",
    "The answer.",
  ];
  const world = await streamed(t, raw);
  expectStreamed(world, "01", raw, derived);
});

// streamlog.test.ts:73 deriveStreamLine › writes no line for an assistant event with no content blocks
// streamlog.test.ts:79 deriveStreamLine › writes no line for recognized events the log has no use for
// streamlog.test.ts:119 deriveStreamLine › writes no line for a thinking-only assistant message
conformance("attempts", "stream events the log has no use for write no line, and the Stream file keeps them", async (t) => {
  const raw = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    assistant(),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t-1", content: "ok" }] } }),
    assistant({ type: "thinking", thinking: "Only thinking." }),
    JSON.stringify({ type: "result", subtype: "success", result: "done" }),
  ];
  const world = await streamed(t, raw);
  expectStreamed(world, "01", raw, []);
});

// streamlog.test.ts:89 deriveStreamLine › passes through unrecognized event types and non-jsonl lines verbatim
// streamlog.test.ts:97 deriveStreamLine › passes through an assistant event whose shape it does not know
conformance("attempts", "stream lines the deriver does not know reach the log verbatim, an empty one as nothing", async (t) => {
  const unknown = [
    JSON.stringify({ type: "future_event", detail: 1 }),
    "a plain text line",
    "[1,2,3]",
    '"just a string"',
    JSON.stringify({ type: "assistant", message: { content: "plain string content" } }),
    JSON.stringify({ type: "assistant" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "future_block", x: 1 }] } }),
  ];
  const raw = [...unknown.slice(0, 2), "", ...unknown.slice(2)];
  const world = await streamed(t, raw);
  expectStreamed(world, "01", raw, unknown);
});

// streamlog.test.ts:129 StreamLineBuffer › emits each complete line of a chunk in order
// streamlog.test.ts:137 StreamLineBuffer › reassembles a line split across chunks
// streamlog.test.ts:144 StreamLineBuffer › keeps a multi-byte character split across chunks intact
// streamlog.test.ts:151 StreamLineBuffer › strips a carriage return from a CRLF line
// streamlog.test.ts:158 StreamLineBuffer › flushes a final unterminated line once
// streamlog.test.ts:167 StreamLineBuffer › emits nothing for an empty flush
conformance("attempts", "a claude Attempt's log is cut into whole lines however its stdout arrives", async (t) => {
  const world = t.world({ tickets: [ready("01"), ready("02")], config: HEADLESS });
  world.stubs.script("01", {
    run: [
      "printf 'alpha\\nbeta\\n'",
      "sleep 0.3; printf 'one-two'; sleep 0.5; printf -- '-three\\n'",
      "printf 'h\\xc3'; sleep 0.5; printf '\\xa9llo\\n'",
      "printf 'cr-lf\\r\\n'",
      "printf 'complete\\npartial'",
    ].join("\n"),
  });
  world.stubs.script("02", { stdout: "last words\ndone\n" });
  await t.start(world);
  await waitForExit(world, "01");
  await waitForExit(world, "02");

  expectSameBytes(
    readRuns(world, "01.stream.jsonl"),
    Buffer.from("alpha\nbeta\none-two-three\nh\xc3\xa9llo\ncr-lf\r\ncomplete\npartial", "latin1"),
    "runs/01.stream.jsonl",
  );
  expectSameBytes(readRuns(world, "01.log"), lines("alpha", "beta", "one-two-three", "héllo", "cr-lf", "complete", "partial"), "runs/01.log");
  expectSameBytes(readRuns(world, "02.log"), lines("last words", "done"), "runs/02.log");
});

// gap: engine/attempt-run.ts:1366 and :1419-1420 (stderr reaches the log, never the Stream file)
conformance("attempts", "a claude Attempt's stderr reaches its log and never its Stream file, nor joins a stdout line", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  const first = assistant(text("before the warning"));
  const last = assistant(text("after the warning"));
  const diagnostic = "warning: a plain diagnostic on stderr";
  // The diagnostic lands while stdout is part way through a line.
  world.stubs.script("01", {
    run: [
      printLines([first]),
      "sleep 0.3; printf 'partial-out'; sleep 0.3",
      `printf '%s\\n' '${diagnostic}' >&2`,
      "sleep 0.3; printf -- '-rest\\n'",
      printLines([last]),
    ].join("\n"),
  });
  await t.start(world);
  await waitForExit(world, "01");

  expectSameBytes(readRuns(world, "01.stream.jsonl"), lines(first, "partial-out-rest", last), "runs/01.stream.jsonl");
  // The two pipes are read side by side, so only stdout's own order is fixed.
  const log = readRuns(world, "01.log").split("\n").slice(0, -1);
  expect(log.filter((line) => line === diagnostic)).toHaveLength(1);
  expect(log.filter((line) => line !== diagnostic)).toEqual(["before the warning", "partial-out-rest", "after the warning"]);
});

// engine.test.ts:5004 streamed logs at every spawn site › streams an implement attempt on the well-known paths
// streamlog.test.ts:11 deriveStreamLine › passes assistant text through verbatim (GET /api/log)
conformance("attempts", "an implement Attempt streams on the well-known paths, and GET /api/log serves both files", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: HEADLESS });
  world.stubs.script("01", { stdout: lines(...SAMPLE.raw) });
  const server = await t.start(world);
  await approveReview(server);

  expectStreamed(world, "01", SAMPLE.raw, SAMPLE.derived);
  const log = (await server.http.get("/api/log?ticket=01")).json<TicketLogResponse>();
  expect(log.content).toBe(lines(...SAMPLE.derived));
  expect(log.attempts).toEqual([
    { attempt: 1, kind: "implement", logFile: "01.log", streamFile: "01.stream.jsonl", current: true },
  ]);
  const stream = (await server.http.get("/api/log?ticket=01&stream=1")).json<TicketLogResponse>();
  expect(stream.content).toBe(lines(...SAMPLE.raw));
});

// engine.test.ts:5163 streamed logs at every spawn site › keeps a raw harness's log passthrough with no Stream file
// engine.test.ts:3825 attempt log rotation › rotates the raw log to its attempt-numbered name before a re-run writes
conformance("attempts", "a raw harness's output is its log as it came, rotated before a re-run, with no Stream file", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { defaults: { harness: "opencode", model: "m" } } });
  // A stream-json line and a CRLF too: a raw harness's log derives nothing.
  const first = `attempt-output-1\n${assistant(text("not derived"))}\nwith a cr\r\n`;
  world.stubs.script("01", { statuses: ["checkpoint", "done"], stdout: [first, "attempt-output-2\n"] });
  const server = await t.start(world);

  await settleOn(server, "01", "checkpoint");
  expectSameBytes(readRuns(world, "01.log"), first, "runs/01.log after attempt 1");
  await answer(server, { ticketId: "01" });
  await approveReview(server);

  expectSameBytes(readRuns(world, "01.attempt-1.log"), first, "runs/01.attempt-1.log");
  expectSameBytes(readRuns(world, "01.log"), "attempt-output-2\n", "runs/01.log");
  expect(eventsOf(world, "01", "spawned").map((e) => e.attempt)).toEqual([1, 2]);
  expect(readdirSync(join(world.pool, "runs")).filter((file) => file.endsWith(".stream.jsonl"))).toEqual([]);
});

// engine.test.ts:5026 streamed logs at every spawn site › streams the resolver run beside its resolver log
conformance("attempts", "a resolver run streams beside its resolver log", async (t) => {
  const world = conflictWorld(
    t,
    `${printLines(SAMPLE.raw)}; printf 'resolved\\n' > shared.txt; git add shared.txt; ` +
      "printf '{\"resolved\": true, \"note\": \"kept both\"}' > \"$rout\"; exit 0",
  );
  const server = await t.start(world);

  // The merge hold keeps the drive running, so the wait is on the Interrupt alone.
  await until(
    () => snapshot(server),
    (s) => s.state.interrupts.some((i) => i.ticketId === "01" && i.kind === "merge-approval"),
    { ms: 40_000, what: "01's merge-approval Interrupt" },
  );
  expectStreamed(world, "01.resolver", SAMPLE.raw, SAMPLE.derived);
});

/** Script a verify launch to print the three-line sample before its Outcome. */
function sampleScript(world: World, key: string, extra: Parameters<World["stubs"]["script"]>[1] = {}): void {
  world.stubs.script(key, { stdout: lines(...SAMPLE.raw), ...extra });
}

// engine.test.ts:5074 streamed logs at every spawn site › streams grader runs and keeps the grader artifacts working
conformance("attempts", "a verify candidate and its grader each stream beside their logs, and the grader's trim holds the derived text", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { ...HEADLESS, assign: { "01": { verify: 1 } } } });
  sampleScript(world, "01.attempt-1", { work: { file: "cand-1.txt", message: "cand-1" } });
  sampleScript(world, "01-grader-1", { grade: { score: 9, verdict: "pass", reasons: "it works" } });
  const server = await t.start(world);

  await waitForExit(world, "01-grader-1");
  expectStreamed(world, "01.attempt-1", SAMPLE.raw, SAMPLE.derived);
  expectStreamed(world, "01-grader-1", SAMPLE.raw, SAMPLE.derived);
  const trim = readRuns(world, "01-grader-1.trim.log");
  for (const line of SAMPLE.derived) expect(trim).toContain(line);
  await approveReview(server);
});

// engine.test.ts:5120 streamed logs at every spawn site › streams the head-to-head judge run and keeps its side artifacts working
conformance("attempts", "a head-to-head judge streams beside its log, beside a trimmed log of each candidate", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: { ...HEADLESS, assign: { "01": { verify: 2 } } } });
  for (const n of [1, 2]) sampleScript(world, `01.attempt-${n}`, { work: { file: `cand-${n}.txt`, message: `cand-${n}` } });
  sampleScript(world, "01-grader-1", { grade: { score: 8, verdict: "pass", reasons: "scored 8" } });
  sampleScript(world, "01-grader-2", { grade: { score: 7, verdict: "pass", reasons: "scored 7" } });
  sampleScript(world, "01-head-to-head", { winner: 1 });
  const server = await t.start(world);

  await waitForExit(world, "01-head-to-head", 60_000);
  expectStreamed(world, "01-head-to-head", SAMPLE.raw, SAMPLE.derived);
  for (const n of [1, 2]) {
    expect(runsExists(world, `01-head-to-head.attempt-${n}.trim.log`)).toBe(true);
    expectStreamed(world, `01-grader-${n}`, SAMPLE.raw, SAMPLE.derived);
  }
  await approveReview(server);
});

// streamlog.test.ts:177 TranscriptLineBuffer (ADR-0016) › derives an ANSI-laden typescript line into its readable text
// streamlog.test.ts:188 TranscriptLineBuffer (ADR-0016) › strips CSI sequences, OSC sequences, and two-byte escapes
// streamlog.test.ts:199 TranscriptLineBuffer (ADR-0016) › keeps the operator's keystrokes, which the typescript records too
// streamlog.test.ts:209 TranscriptLineBuffer (ADR-0016) › reassembles an escape sequence split across chunks
// streamlog.test.ts:217 TranscriptLineBuffer (ADR-0016) › keeps blank lines and non-ASCII text
// streamlog.test.ts:226 TranscriptLineBuffer (ADR-0016) › flushes a final unterminated line once
conformance("attempts", "a terminal-backed Attempt's log is its pane's transcript less the ANSI and control noise", async (t) => {
  const world = t.world({ tickets: [ready("01")], config: TERMINAL });
  // The TUI's output in its pane: colours, a title, cursor moves, the
  // prompt it echoes as typed, an escape split across two writes, then a
  // last line with no newline. Its Outcome follows and it stays up, so the
  // Attempt ends on the Outcome with the transcript as it stands.
  world.stubs.script("01", {
    run: [
      "printf '\\x1b[32mClaude Code v2.1.263\\x1b[0m\\r\\n'",
      "printf 'hello from the TUI\\r\\n'",
      "printf '\\x1b]0;agent title\\x07agent output\\x1b7\\x1b8\\x1b[1A\\x1b[2Kprogress done\\r\\n'",
      "printf '❯ /implement %s\\r\\n' \"$STUB_ISSUE\"",
      "printf '\\x1b[3'; sleep 0.6; printf '1mcoloured\\x1b[0m\\r\\n'",
      "printf 'one\\r\\n\\r\\ntwo ✓\\r\\n'",
      "printf 'partial\\x1b[0m'",
      "sleep 1",
    ].join("\n"),
    hold: 60,
  });
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  await t.start(world, { herdr });

  const exited = await waitForExit(world, "01");
  expect(exited.payload).toMatchObject({ code: 0, status: "done", outcomeExists: true });
  const issue = join(world.pool, "issues", "01-t.md");
  const log = readRuns(world, "01.log");
  expect(log.endsWith("partial\n")).toBe(true);
  expect(transcriptLines(log.split("\n").slice(0, -1))).toEqual([
    "Claude Code v2.1.263",
    "hello from the TUI",
    "agent outputprogress done",
    `❯ /implement ${issue}`,
    "coloured",
    "one",
    "",
    "two ✓",
    "partial",
  ]);
  // The Stream file is the raw typescript, escapes and carriage returns kept.
  const stream = readRuns(world, "01.stream.jsonl");
  expect(stream).toContain("\x1b[32mClaude Code v2.1.263\x1b[0m\r");
  expect(stream).toContain("\x1b]0;agent title\x07agent output\x1b7\x1b8\x1b[1A\x1b[2Kprogress done\r");
  expect(stream).toContain("partial\x1b[0m");
  expect(existsSync(join(world.pool, "runs", "01.exitcode"))).toBe(false);
});
