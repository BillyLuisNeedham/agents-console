/**
 * The per-Ticket files under runs/ (the inventory's ticket C01, area
 * `formats`): the events JSONL and how a server reads it back as it grows,
 * tears, shrinks or is replaced; and the attempt log and Stream file names,
 * their rotation before a re-run, and the attempts a pre-events pool's logs
 * are reconstructed into. JSONL is compared once parsed, file names and
 * rotated bytes exactly (ADR-0036).
 *
 * Each case names the inventory rows it covers (docs/research/rust-port/
 * test-inventory.md, area `formats`) as `file:line` of the engine test it
 * came from, or `gap` with the source line for behaviour no test covered.
 */

import { expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogAttemptInfo, TicketLogResponse } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual, expectSameBytes, expectSameFile } from "../harness/equal.ts";
import type { Http } from "../harness/http.ts";
import { parseJsonl, readEvents, until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { events, snapshot, ticket, untilStatus } from "./formats-helpers.ts";

const DEFAULTS = { defaults: { harness: "claude", model: "m" } };
const AT = "2026-01-01T00:00:00.000Z";

/** One events line as the engine writes it. */
function line(kind: string, attempt: number | string = 1, payload: unknown = {}): string {
  return `${JSON.stringify({ at: AT, attempt, kind, payload })}\n`;
}

function runs(world: World, file: string): string {
  return join(world.pool, "runs", file);
}

async function kinds(http: Http, id = "01"): Promise<string[]> {
  return (await events(http, id)).events.map((e) => e.kind);
}

async function logAttempts(http: Http, id = "01"): Promise<LogAttemptInfo[]> {
  const answer = await http.get(`/api/log?ticket=${id}`);
  expect(answer.status, answer.text).toBe(200);
  return answer.json<TicketLogResponse>().attempts;
}

/** A stream-json line a headless claude prints: one assistant text block. */
function streamText(text: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
}

/** A done Ticket 01 whose events file the case writes before the server starts. */
function doneWorld(t: Parameters<Parameters<typeof conformance>[2]>[0], eventsText?: string): World {
  const world = t.world({
    tickets: [ticket("01", { status: "done" })],
    config: DEFAULTS,
    ...(eventsText !== undefined ? { poolFiles: { "runs/01.events.jsonl": eventsText } } : {}),
  });
  mkdirSync(join(world.pool, "runs"), { recursive: true });
  return world;
}

// ---------------------------------------------------------------------------
// The events file.
// ---------------------------------------------------------------------------

// events.test.ts:31 ticket events › reads back events written through appendEvent
conformance("formats", "an Attempt's events are one JSON object per line, served back as written", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS });
  const server = await t.start(world);
  await untilStatus(world, "01-t.md", "done");
  const text = await until(
    () => readFileSync(runs(world, "01.events.jsonl"), "utf8"),
    (body) => body.includes('"exited"'),
    { what: "01's exited event" },
  );
  const lines = text.split("\n");
  expect(lines.at(-1)).toBe("");
  for (const each of lines.slice(0, -1)) {
    expect(Object.keys(JSON.parse(each)).sort()).toEqual(["at", "attempt", "kind", "payload"]);
  }
  const written = parseJsonl<{ at: string; attempt: number; kind: string }>(text);
  expect(written.map((e) => [e.kind, e.attempt])).toEqual([
    ["scheduled", 1],
    ["spawned", 1],
    ["exited", 1],
  ]);
  for (const e of written) expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expectParsedEqual((await events(server.http, "01")).events, written, "GET /api/events?ticket=01's events");
});

// events.test.ts:45 ticket events › skips a line whose kind is not a known event kind
// gap: engine/events.ts:419-426 (an attempt that is not a number)
conformance("formats", "an events line of an unknown kind, or whose attempt is not a number, is skipped", async (t) => {
  const world = doneWorld(t, line("scheduled") + line("bogus") + line("spawned", "1"));
  const server = await t.start(world);
  const answer = await events(server.http, "01");
  expectParsedEqual(answer.events, [{ at: AT, attempt: 1, kind: "scheduled", payload: {} }], "the events served");
  expect(answer.reconstructed).toBe(false);
});

// events.test.ts:73 ticket events read again › picks up each append, and a torn final line once the rest of it lands
conformance("formats", "the events read picks up each append, and a torn last line once it is whole", async (t) => {
  const world = doneWorld(t, line("scheduled"));
  const server = await t.start(world);
  const path = runs(world, "01.events.jsonl");
  const spawned = line("spawned");
  expect(await kinds(server.http)).toEqual(["scheduled"]);
  appendFileSync(path, spawned.slice(0, 20));
  expect(await kinds(server.http)).toEqual(["scheduled"]);
  appendFileSync(path, spawned.slice(20));
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned"]);
  appendFileSync(path, line("exited"));
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned", "exited"]);
});

// events.test.ts:86 ticket events read again › reads a final line with no newline yet when it is whole, and never keeps it
conformance("formats", "a whole last events line with no newline is read, and read once when its newline lands", async (t) => {
  const world = doneWorld(t, line("scheduled") + line("spawned").trimEnd());
  const server = await t.start(world);
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned"]);
  appendFileSync(runs(world, "01.events.jsonl"), `\n${line("exited")}`);
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned", "exited"]);
});

// events.test.ts:94 ticket events read again › reads a file removed and written again as a new file, at the same size too
conformance("formats", "an events file removed, then written again at the same size, is read as the new file", async (t) => {
  const first = line("scheduled") + line("spawned");
  const world = doneWorld(t, first);
  const server = await t.start(world);
  const path = runs(world, "01.events.jsonl");
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned"]);
  rmSync(path);
  expect(await kinds(server.http)).toEqual([]);
  const second = line("spawned") + line("scheduled");
  expect(second.length).toBe(first.length);
  writeFileSync(path, second);
  expect(await kinds(server.http)).toEqual(["spawned", "scheduled"]);
});

// events.test.ts:105 ticket events read again › reads a file cut shorter as a new file
conformance("formats", "an events file rewritten shorter is read as a new file", async (t) => {
  const world = doneWorld(t, line("scheduled") + line("spawned"));
  const server = await t.start(world);
  expect(await kinds(server.http)).toEqual(["scheduled", "spawned"]);
  writeFileSync(runs(world, "01.events.jsonl"), line("exited"));
  expect(await kinds(server.http)).toEqual(["exited"]);
});

// ---------------------------------------------------------------------------
// Attempt log and Stream file names.
// ---------------------------------------------------------------------------

// events.test.ts:122 attempt log naming › names the well-known base log and the attempt-numbered logs
// events.test.ts:162 attempt stream naming › names the well-known base stream and the attempt-numbered streams
conformance("formats", "a re-run keeps the base log and Stream file names and rotates the last run's to attempt-numbered ones", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS });
  world.stubs.script("01", {
    statuses: ["checkpoint", "done"],
    brief: "carry on?",
    stdout: [streamText("attempt one"), streamText("attempt two")],
  });
  const server = await t.start(world);
  await untilStatus(world, "01-t.md", "checkpoint");
  await until(() => readEvents(world.pool, "01"), (e) => e.some((x) => x.kind === "exited"), { what: "attempt 1's exit" });
  const firstLog = readFileSync(runs(world, "01.log"));
  const firstStream = readFileSync(runs(world, "01.stream.jsonl"));
  expectSameBytes(firstStream, streamText("attempt one"), "attempt 1's Stream file");

  const resumed = await server.http.post("/api/resume", { ticketId: "01" });
  expect(resumed.status, resumed.text).toBe(202);
  await untilStatus(world, "01-t.md", "done");
  await until(
    () => readEvents(world.pool, "01"),
    (e) => e.filter((x) => x.kind === "exited").length === 2,
    { what: "attempt 2's exit" },
  );

  expectSameFile(runs(world, "01.attempt-1.log"), firstLog);
  expectSameFile(runs(world, "01.attempt-1.stream.jsonl"), firstStream);
  expectSameFile(runs(world, "01.stream.jsonl"), streamText("attempt two"));
  expect(readFileSync(runs(world, "01.log"), "utf8")).not.toContain("attempt one");
  expect(await logAttempts(server.http)).toEqual([
    { attempt: 1, kind: "implement", current: false, logFile: "01.attempt-1.log", streamFile: "01.attempt-1.stream.jsonl" },
    { attempt: 2, kind: "implement", current: true, logFile: "01.log", streamFile: "01.stream.jsonl" },
  ]);
});

// attempt-run.test.ts:347 headless attempts › rotates the well-known log and Stream file to the last exited attempt's name before a re-run
conformance("formats", "a re-run after an exited attempt 1 found on disk rotates its log and Stream file to attempt-1", async (t) => {
  const exited = line("scheduled") + line("spawned") + line("exited", 1, { code: 0, status: "checkpoint", logTail: [], outcomeExists: true });
  const world = t.world({
    tickets: [ticket("01")],
    config: DEFAULTS,
    poolFiles: {
      "runs/01.events.jsonl": exited,
      "runs/01.log": "attempt one's log\n",
      "runs/01.stream.jsonl": streamText("attempt one"),
    },
  });
  world.stubs.script("01", { stdout: streamText("attempt two") });
  await t.start(world);
  await untilStatus(world, "01-t.md", "done");
  await until(
    () => readEvents(world.pool, "01"),
    (e) => e.some((x) => x.kind === "exited" && x.attempt === 2),
    { what: "attempt 2's exit" },
  );
  expectSameFile(runs(world, "01.attempt-1.log"), "attempt one's log\n");
  expectSameFile(runs(world, "01.attempt-1.stream.jsonl"), streamText("attempt one"));
  expectSameFile(runs(world, "01.stream.jsonl"), streamText("attempt two"));
  expect(readFileSync(runs(world, "01.log"), "utf8")).not.toContain("attempt one's log");
});

// events.test.ts:122 and :162 (their pre-events halves)
// gap: engine/attempt-run.ts:364-391 (a lone leftover Stream file rotates too)
conformance("formats", "a log or Stream file from before events existed rotates to attempt-0 at the first launch", async (t) => {
  const both = t.world({
    tickets: [ticket("01")],
    config: DEFAULTS,
    poolFiles: { "runs/01.log": "old log\n", "runs/01.stream.jsonl": streamText("old stream") },
  });
  const streamOnly = t.world({
    tickets: [ticket("01")],
    config: DEFAULTS,
    poolFiles: { "runs/01.stream.jsonl": streamText("old stream") },
  });
  for (const world of [both, streamOnly]) {
    world.stubs.script("01", { stdout: streamText("new") });
    const server = await t.start(world);
    await untilStatus(world, "01-t.md", "done");
    await until(() => readEvents(world.pool, "01"), (e) => e.some((x) => x.kind === "exited"), { what: "01's exit" });
    await server.stop();
  }
  expectSameFile(runs(both, "01.attempt-0.log"), "old log\n");
  expectSameFile(runs(both, "01.attempt-0.stream.jsonl"), streamText("old stream"));
  expectSameFile(runs(both, "01.stream.jsonl"), streamText("new"));
  expectSameFile(runs(streamOnly, "01.attempt-0.stream.jsonl"), streamText("old stream"));
  expect(existsSync(runs(streamOnly, "01.attempt-0.log"))).toBe(false);
  expectSameFile(runs(streamOnly, "01.stream.jsonl"), streamText("new"));
});

// attempt-run.test.ts:374 headless attempts › names a verify candidate's files by attempt and rotates nothing
conformance("formats", "verify Candidates write attempt-numbered files, and never the base log", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { ...DEFAULTS, assign: { "01": { verify: 2 } } },
    poolFiles: { "runs/01.log": "leftover\n" },
  });
  await t.start(world);
  await until(
    () => readEvents(world.pool, "01"),
    (e) => e.filter((x) => x.kind === "exited").length >= 2,
    { ms: 30_000, what: "both Candidates' exits" },
  );
  for (const n of [1, 2]) {
    expect(existsSync(runs(world, `01.attempt-${n}.log`))).toBe(true);
    expect(JSON.parse(readFileSync(runs(world, `01.attempt-${n}.outcome.json`), "utf8"))).toMatchObject({ status: "done" });
  }
  expect(world.stubs.calls().filter((c) => c.key.startsWith("01.")).map((c) => c.key).sort()).toEqual([
    "01.attempt-1",
    "01.attempt-2",
  ]);
  // No Candidate writes the base log. The leftover is a log from before
  // events existed, so the first launch rotates it to attempt-0 like any
  // other (NOT-PORTED.md: the row this comes from says it stays put).
  expect(existsSync(runs(world, "01.log"))).toBe(false);
  expectSameFile(runs(world, "01.attempt-0.log"), "leftover\n");
});

// events.test.ts:133 attempt log naming › parses back the four shapes it names
conformance("formats", "a pool with no events file reconstructs its attempts from the four log names, by age", async (t) => {
  const files = ["01.log", "01.attempt-3.log", "01.resolver.log", "01.attempt-4.resolver.log"];
  const world = doneWorld(t);
  files.forEach((file, i) => {
    writeFileSync(runs(world, file), `${file}\n`);
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
    utimesSync(runs(world, file), at, at);
  });
  const server = await t.start(world);
  const answer = await events(server.http, "01");
  expect(answer.reconstructed).toBe(true);
  expect(answer.events).toEqual([]);
  expect(answer.attempts).toEqual(
    files.map((file, i) => ({
      attempt: i + 1,
      logFile: file,
      modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    })),
  );
});

// events.test.ts:152 attempt log naming › rejects names outside the contract
conformance("formats", "reconstruction takes only this Ticket's names in the contract", async (t) => {
  const world = doneWorld(t);
  for (const file of ["01.log", "02.log", "01.outcome.json", "01.attempt-x.log", "01.attempt-01.log"]) {
    writeFileSync(runs(world, file), "x\n");
  }
  const server = await t.start(world);
  const answer = await events(server.http, "01");
  expect(answer.reconstructed).toBe(true);
  expect(answer.attempts.map((a) => a.logFile)).toEqual(["01.log"]);
});


// ---------------------------------------------------------------------------
// The resolver's files.
// ---------------------------------------------------------------------------

/**
 * Put a bash prelude in front of the claude stub on the world's PATH, so a
 * launch can commit and resolve before the stub records it and plays its
 * script. The prelude sees the argv as "$@", `key` as the Outcome file's
 * stem when the prompt names one, and `rout` as the resolver's result path
 * when it is a resolver launch.
 */
function prelude(world: World, script: string): void {
  const path = join(world.stubs.bin, "claude");
  const [shebang, ...rest] = readFileSync(path, "utf8").split("\n");
  const head = [
    'out=""; rout=""',
    'for arg in "$@"; do',
    '  case "$arg" in *"outcome as JSON at "*) r="${arg#*outcome as JSON at }"; out="${r%%:*}" ;; esac',
    '  case "$arg" in *"Resolve the git merge conflict"*) r="${arg#*write JSON to }"; rout="${r%%:*}" ;; esac',
    "done",
    'key=""; [ -n "$out" ] && key="$(basename "$out" .outcome.json)"',
  ];
  writeFileSync(path, [shebang, ...head, script, ...rest].join("\n"));
}

/**
 * Tickets 01 and 02 both change shared.txt. In every round 01 merges first
 * (fast-forwarding onto main before it writes, so it never conflicts) and 02
 * commits only once 01's commit of that round is on main, so 02's merge
 * conflicts and the claude resolver runs on it. The resolver prints one
 * stream-json line naming its round and stages a resolution.
 */
function twoRoundWorld(t: Parameters<Parameters<typeof conformance>[2]>[0]): World {
  const world = t.world({
    tickets: [ticket("01"), ticket("02")],
    config: { ...DEFAULTS, resolver: "claude" },
    repoFiles: { "shared.txt": "base\n" },
  });
  const count = (name: string) =>
    `n=$(( $(cat "$CONFORMANCE_STUBS/${name}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$CONFORMANCE_STUBS/${name}"`;
  prelude(
    world,
    [
      'if [ -n "$rout" ]; then',
      `  ${count("rounds-resolver")}`,
      "  git merge main >/dev/null 2>&1",
      '  printf "resolved-%s\\n" "$n" > shared.txt; git add shared.txt',
      `  printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"resolver run'"$n"'"}]}}'`,
      '  printf \'{"resolved": true, "note": "round %s"}\' "$n" > "$rout"',
      "  exit 0",
      "fi",
      'if [ "$key" = "01" ]; then',
      `  ${count("rounds-01")}`,
      "  git merge -q main >/dev/null 2>&1",
      '  printf "from-01-%s\\n" "$n" > shared.txt; git add shared.txt; git commit -qm "work-01-$n"',
      "fi",
      'if [ "$key" = "02" ]; then',
      `  ${count("rounds-02")}`,
      `  for _ in $(seq 1 400); do git -C ${JSON.stringify(world.repo)} log main --format=%s | grep -qx "work-01-$n" && break; sleep 0.05; done`,
      '  printf "from-02-%s\\n" "$n" > shared.txt; git add shared.txt; git commit -qm "work-02-$n"',
      "fi",
    ].join("\n"),
  );
  return world;
}

async function approveMerge(http: Http, round: number): Promise<void> {
  await until(
    () => snapshot(http),
    (snap) => snap?.state.interrupts.some((i) => i.ticketId === "02" && i.kind === "merge-approval") ?? false,
    { ms: 40_000, what: `02's merge-approval in round ${round}` },
  );
  const answer = await http.post("/api/resume", { ticketId: "02", action: "approve" });
  expect(answer.status, answer.text).toBe(202);
}

async function review(http: Http, round: number) {
  return until(
    () => snapshot(http),
    (snap) => snap?.state.interrupts.some((i) => i.ticketId === "REVIEW") ?? false,
    { ms: 40_000, what: `the final Review in round ${round}` },
  );
}

// engine.test.ts:12034 worktrees › resolver agent › rotates the resolver log to its attempt-numbered name on a second resolver run
// events.test.ts:128 attempt log naming › names the resolver log and its attempt-numbered variants
// events.test.ts:168 attempt stream naming › names the resolver stream and its attempt-numbered variants
// attempt-run.test.ts:398 headless attempts › names the resolver's files with the resolver suffix, the result file included
conformance("formats", "a second resolver run rotates the first's log and Stream file to its attempt number", async (t) => {
  const world = twoRoundWorld(t);
  const server = await t.start(world);
  await approveMerge(server.http, 1);
  await review(server.http, 1);
  expectSameFile(runs(world, "02.resolver.stream.jsonl"), streamText("resolver run1"));
  const firstResolverLog = readFileSync(runs(world, "02.resolver.log"));
  expectParsedEqual(readFileSync(runs(world, "02.resolver.outcome.json"), "utf8"), { resolved: true, note: "round 1" }, "round 1's resolution");

  const reject = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "reject", note: "01, 02" });
  expect(reject.status, reject.text).toBe(202);
  await approveMerge(server.http, 2);
  await review(server.http, 2);

  const kindsOf = (kind: string) =>
    readEvents(world.pool, "02").filter((e) => e.kind === kind).map((e) => e.attempt);
  expect(kindsOf("spawned")).toEqual([1, 2, 3, 4]);
  expect(kindsOf("exited")).toEqual([1, 3]);
  expect(kindsOf("resolver")).toEqual([2, 4]);

  const files = readdirSync(join(world.pool, "runs")).filter((f) => f.startsWith("02.")).sort();
  for (const file of [
    "02.attempt-1.log",
    "02.log",
    "02.attempt-2.resolver.log",
    "02.resolver.log",
    "02.attempt-2.resolver.stream.jsonl",
    "02.resolver.stream.jsonl",
    "02.resolver.outcome.json",
  ]) {
    expect(files).toContain(file);
  }
  expectSameFile(runs(world, "02.attempt-2.resolver.log"), firstResolverLog);
  expectSameFile(runs(world, "02.attempt-2.resolver.stream.jsonl"), streamText("resolver run1"));
  expectSameFile(runs(world, "02.resolver.stream.jsonl"), streamText("resolver run2"));
  expectParsedEqual(readFileSync(runs(world, "02.resolver.outcome.json"), "utf8"), { resolved: true, note: "round 2" }, "round 2's resolution");
  // Only the resolver rows: the implement rows of this listing are wrong on
  // the Bun server (NOT-PORTED.md, "the current implement attempt").
  const listed = (await logAttempts(server.http, "02")).filter((a) => a.kind === "resolver");
  expect(listed).toEqual([
    { attempt: 2, kind: "resolver", current: false, logFile: "02.attempt-2.resolver.log", streamFile: "02.attempt-2.resolver.stream.jsonl" },
    { attempt: 4, kind: "resolver", current: true, logFile: "02.resolver.log", streamFile: "02.resolver.stream.jsonl" },
  ]);
}, { timeoutMs: 120_000 });
