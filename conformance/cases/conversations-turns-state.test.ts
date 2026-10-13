/**
 * A Conversation's Turn state (ADR-0018), seen from outside the server
 * (ADR-0036): working or waiting, judged from consecutive reads of its pane,
 * one viewport read every two seconds. Rows of the `conversations` area,
 * ticket C17, in the Rust port inventory (docs/research/rust-port/
 * test-inventory.md), from engine/turn-state.test.ts and the herdr sidebar
 * report in engine/notices.test.ts.
 *
 * The rule the cases pin: a read whose transcript (the rows above the TUI's
 * input box) differs from the last is working, and publishes when the
 * state or the last line moved; two further reads of the same transcript,
 * each with the harness's idle pattern anywhere in the read, flip it to
 * waiting, stamping idleSince between the third read and the fourth; once
 * waiting it holds, publishing nothing, until the transcript moves. The
 * frames from a live claude and opencode are verbatim from
 * engine/turn-state.test.ts (captured with tmux at 120x40, issue #71).
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { OPENCODE_READY, type HerdrCall } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";
import {
  BUSY,
  IDLE,
  ms,
  pushedSince,
  pushedTurns,
  show,
  startConversation,
  startTalk,
  state,
  untilPushedTurn,
  untilReads,
  viewIn,
  type Talk,
  type Turn,
} from "./conversations-support.ts";

/** Start Conversation conv-1 and wait for its first read's Turn, its last line `firstLine`; its pane id. */
async function talkingOn(talk: Talk, firstLine: string, assign?: Record<string, string>): Promise<string> {
  const view = await startConversation(talk.server, { title: "Talk", ...(assign ? { assign } : {}) });
  await untilPushedTurn(talk.socket, "conv-1", (turn) => turn.lastLine === firstLine, {
    what: `conv-1's first read, its last line ${JSON.stringify(firstLine)}`,
  });
  return view.paneId!;
}

/** idleSince lies between the third read of a frame and the fourth: the flip was the second stable read's. */
function expectFlippedOnThirdRead(turn: Turn, reads: HerdrCall[]): void {
  expect(turn.state).toBe("waiting");
  expect(ms(turn.idleSince)).toBeGreaterThanOrEqual(reads[2]!.at);
  expect(ms(turn.idleSince)).toBeLessThanOrEqual(reads[3]!.at);
}

// ---------------------------------------------------------------------------
// The transition.
// ---------------------------------------------------------------------------

// turn-state.test.ts:24
conformance(
  "conversations",
  "the first read is working whatever the pane shows, even an idle prompt",
  async (t) => {
    const talk = await startTalk(t, { herdr: { rendered: IDLE } });
    const { herdr, socket } = talk;
    const paneId = (await startConversation(talk.server, { title: "Talk" })).paneId!;

    const reads = await untilReads(herdr, paneId, 0, 4);
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting");
    // Fresh at the start, working once read, waiting only on the third read.
    expect(pushedTurns(socket, "conv-1").map((pushed) => pushed.turn)).toEqual([
      { state: "working", lastLine: "", idleSince: null },
      { state: "working", lastLine: "❯", idleSince: null },
      waiting.turn,
    ]);
    expect(pushedTurns(socket, "conv-1")[1]!.at).toBeGreaterThanOrEqual(reads[0]!.at);
    expectFlippedOnThirdRead(waiting.turn, reads);
  },
);

// turn-state.test.ts:53
conformance(
  "conversations",
  "a working Turn whose pane comes to rest on its idle prompt flips to waiting on the second stable read",
  async (t) => {
    const talk = await startTalk(t);
    const { herdr, socket } = talk;
    const paneId = await talkingOn(talk, "✢ Working…");

    const fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, IDLE);
    const reads = await untilReads(herdr, paneId, from, 4);
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting", { from: fromFrame });

    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([
      { state: "working", lastLine: "❯", idleSince: null },
      waiting.turn,
    ]);
    expectFlippedOnThirdRead(waiting.turn, reads);
  },
);

// turn-state.test.ts:31
conformance(
  "conversations",
  "a waiting Turn whose transcript changes is working at once, and waits again only after two fresh stable reads",
  async (t) => {
    const talk = await startTalk(t, { herdr: { rendered: IDLE } });
    const { herdr, socket } = talk;
    const paneId = await talkingOn(talk, "❯");
    await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting");

    // Still idle, its last line unchanged: only the transcript above it moved.
    const fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, "Claude Code v1\nsaid one more thing\n❯ ");
    const reads = await untilReads(herdr, paneId, from, 4);
    const again = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting", { from: fromFrame });

    const pushed = pushedTurns(socket, "conv-1").filter((p) => p.frame >= fromFrame);
    expect(pushed.map((p) => p.turn)).toEqual([{ state: "working", lastLine: "❯", idleSince: null }, again.turn]);
    expect(pushed[0]!.at).toBeGreaterThanOrEqual(reads[0]!.at);
    expectFlippedOnThirdRead(again.turn, reads);
  },
);

// turn-state.test.ts:73
conformance(
  "conversations",
  "a stable pane with no idle prompt anywhere stays working however many reads pass",
  async (t) => {
    const talk = await startTalk(t);
    const { herdr, socket, server } = talk;
    const paneId = await talkingOn(talk, "✢ Working…");

    const fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, "Claude Code v1\nAllow this edit?\n  1. Yes\n  2. No");
    await untilReads(herdr, paneId, from, 5);

    const dialog: Turn = { state: "working", lastLine: "2. No", idleSince: null };
    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([dialog]);
    expect(viewIn(await state(server), "conv-1").turn).toEqual(dialog);
  },
);

// A frame whose transcript is "said this", above an input box drawn
// between two rules: the idle prompt sits in the box, out of the transcript.
const RULE_40 = "─".repeat(40);
const boxed = (prompt: string): string =>
  ["Claude Code v1", "said this", "", RULE_40, prompt, RULE_40, "  footer"].join("\n");

// turn-state.test.ts:81, :89
conformance(
  "conversations",
  "a waiting Turn holds through stable reads, idle or not, keeping its idleSince and publishing nothing",
  async (t) => {
    const talk = await startTalk(t, { herdr: { rendered: boxed("❯ ") } });
    const { herdr, socket, server } = talk;
    const paneId = await talkingOn(talk, "said this");
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting");
    expect(waiting.turn.lastLine).toBe("said this");

    // The idle frame left as it is.
    await herdr.settle();
    let fromFrame = socket.frames.length;
    await untilReads(herdr, paneId, herdr.calls.length, 3);
    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([]);
    expect(viewIn(await state(server), "conv-1").turn).toEqual(waiting.turn);

    // The same transcript with no idle prompt anywhere: no flap back.
    fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, boxed("> "));
    await untilReads(herdr, paneId, from, 3);
    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([]);
    expect(viewIn(await state(server), "conv-1").turn).toEqual(waiting.turn);
  },
);

// turn-state.test.ts:230
conformance(
  "conversations",
  "with no border row in the read the whole read is transcript: its last row is the last line, and a change on any row is working",
  async (t) => {
    const talk = await startTalk(t, { herdr: { rendered: "Claude Code v1\nfirst row\n❯ last row" } });
    const { herdr, socket } = talk;
    const paneId = await talkingOn(talk, "❯ last row");
    await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting");

    const fromFrame = socket.frames.length;
    const from = await show(herdr, paneId, "Claude Code v1\nfirst row, edited\n❯ last row");
    const reads = await untilReads(herdr, paneId, from, 1);
    const working = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "working", { from: fromFrame });
    expect(working.turn).toEqual({ state: "working", lastLine: "❯ last row", idleSince: null });
    expect(working.at).toBeGreaterThanOrEqual(reads[0]!.at);
  },
);

// ---------------------------------------------------------------------------
// Live frames (issue #71).
// ---------------------------------------------------------------------------

const RULE = "─".repeat(120);

/** Rows padded with blank rows to a fixed-size read, as herdr serves one. */
function pane(rows: string[], height = 40): string {
  return [...rows, ...Array(Math.max(0, height - rows.length)).fill("")].join("\n");
}

const CLAUDE_HEADER = [
  " ▐▛███▛█   Claude Code v2.1.267",
  "▝▜██████▀  Haiku 4.5 · Claude Max",
  "  ▝▝ ▝▝    /tmp/tmp.dH29nBRnvR",
  "",
  "",
];

const CLAUDE_FOOTER = (statusline: string, mode = "bypass permissions on") => [
  `  [/tmp/tmp.dH29nBRnvR ] ${statusline}`.padEnd(76) + "Update available! Run: mise upgrade claude",
  `  -- INSERT -- ⏵⏵ ${mode} (shift+tab to cycle) · ← for agents` + " ".repeat(40) + "/rc",
];

// Freshly ready, nothing said yet.
const CLAUDE_BOOT = pane([...CLAUDE_HEADER, "", RULE, "❯ ", RULE, ...CLAUDE_FOOTER("")]);

// Mid-turn: the operator's echoed turn, the spinner row, and the input box
// still showing its `❯` underneath.
const CLAUDE_WORKING = pane([
  ...CLAUDE_HEADER,
  "❯ reply with exactly the word hello and nothing else",
  "",
  "✢ Sautéing…",
  "",
  RULE,
  "❯ ",
  RULE,
  ...CLAUDE_FOOTER(""),
]);

// Turn over: the reply, the done row, and a statusline now carrying usage.
function claudeIdle(statusline = "63.5k 32% $0.07", mode?: string): string {
  return pane([
    ...CLAUDE_HEADER,
    "❯ reply with exactly the word hello and nothing else",
    "",
    "● hello",
    "",
    "✻ Sautéed for 1s · done 2:35 PM",
    "",
    RULE,
    "❯ ",
    RULE,
    ...CLAUDE_FOOTER(statusline, mode),
  ]);
}

function opencodeHome(placeholder = "What is the tech stack of this project?", footer = "tab agents", version = "1.18.29"): string {
  return pane([
    ...Array(13).fill(""),
    "                                                                          ▄",
    "                                         █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
    "                                         █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
    "                                         ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
    "",
    "",
    "                       ┃",
    `                       ┃  Ask anything… "${placeholder}"`,
    "                       ┃",
    "                       ┃  Build · Kimi K3 (1M) Kimi For Coding (OAuth) · high",
    "                       ╹" + "▀".repeat(72),
    `                                                                       ${footer}  ctrl+p commands`,
    ...Array(13).fill(""),
    "  /tmp/tmp.dH29nBRnvR" + " ".repeat(90) + version,
  ]);
}

const DONE_ROW = "✻ Sautéed for 1s · done 2:35 PM";

// turn-state.test.ts:212, :260, :282, :302, :264, :268
conformance(
  "conversations",
  "claude's live frames: the done row is the last line, a ticking footer is no change, and the working and boot frames name their own rows",
  async (t) => {
    const talk = await startTalk(t);
    const { herdr, socket, server } = talk;
    const paneId = await talkingOn(talk, "✢ Working…");

    // claude's idle frame, its statusline ticking under it at every read.
    const fromFrame = socket.frames.length;
    let cursor = await show(herdr, paneId, claudeIdle("63.5k 32% $0.07"));
    const reads: HerdrCall[] = [];
    for (const statusline of ["63.6k 32% $0.08", "63.6k 32% $0.08 ↻ 33m", "63.6k 32% $0.08 ↻ 32m"]) {
      const [read] = await untilReads(herdr, paneId, cursor, 1);
      reads.push(read!);
      await show(herdr, paneId, claudeIdle(statusline));
      cursor = herdr.calls.indexOf(read!) + 1;
    }
    reads.push((await untilReads(herdr, paneId, cursor, 1))[0]!);
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting", { from: fromFrame });
    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([
      { state: "working", lastLine: DONE_ROW, idleSince: null },
      waiting.turn,
    ]);
    expect(waiting.turn.lastLine).toBe(DONE_ROW);
    expectFlippedOnThirdRead(waiting.turn, reads);

    // The mode row and the statusline change; the Turn holds, unpublished.
    let held = socket.frames.length;
    const from = await show(herdr, paneId, claudeIdle("70.1k 35% $0.11", "accept edits on"));
    await untilReads(herdr, paneId, from, 3);
    expect(pushedSince(socket, "conv-1", held)).toEqual([]);
    expect(viewIn(await state(server), "conv-1").turn).toEqual(waiting.turn);

    // The transcript moves: claude at work again, its spinner row the last line.
    held = socket.frames.length;
    await show(herdr, paneId, CLAUDE_WORKING);
    const working = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "working", { from: held });
    expect(working.turn).toEqual({ state: "working", lastLine: "✢ Sautéing…", idleSince: null });

    // Freshly booted, nothing said: the header's path row is the last line.
    held = socket.frames.length;
    await show(herdr, paneId, CLAUDE_BOOT);
    const boot = await untilPushedTurn(socket, "conv-1", (turn) => turn.lastLine !== "✢ Sautéing…", { from: held });
    expect(boot.turn).toEqual({ state: "working", lastLine: "/tmp/tmp.dH29nBRnvR", idleSince: null });
  },
  { timeoutMs: 90_000 },
);

// turn-state.test.ts:222, :272
conformance(
  "conversations",
  "opencode's home frame has no last line above its box, and a changed placeholder, footer or version is no change",
  async (t) => {
    const talk = await startTalk(t, { herdr: { rendered: OPENCODE_READY } });
    const { herdr, socket, server } = talk;
    const paneId = await talkingOn(talk, "ctrl+p commands", { harness: "opencode" });

    const fromFrame = socket.frames.length;
    await show(herdr, paneId, opencodeHome());
    const waiting = await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting" && turn.lastLine === "", {
      from: fromFrame,
    });
    expect(pushedSince(socket, "conv-1", fromFrame)).toEqual([
      { state: "working", lastLine: "", idleSince: null },
      waiting.turn,
    ]);

    for (const frame of [
      opencodeHome("Fix the flaky test"),
      opencodeHome("Fix the flaky test", "tab sessions"),
      opencodeHome("Fix the flaky test", "tab sessions", "1.18.30"),
    ]) {
      const held = socket.frames.length;
      const from = await show(herdr, paneId, frame);
      await untilReads(herdr, paneId, from, 2);
      expect(pushedSince(socket, "conv-1", held)).toEqual([]);
    }
    expect(viewIn(await state(server), "conv-1").turn).toEqual(waiting.turn);
  },
  { timeoutMs: 90_000 },
);

// ---------------------------------------------------------------------------
// The herdr sidebar (issue #94).
// ---------------------------------------------------------------------------

// notices.test.ts:977
conformance(
  "conversations",
  "the pane is reported working at launch, blocked on each flip to waiting, working on each flip back, and released at End",
  async (t) => {
    const talk = await startTalk(t);
    const { herdr, socket, server } = talk;
    const paneId = await talkingOn(talk, "✢ Working…");
    const reports = (): HerdrCall[] =>
      herdr.calls.filter((call) => call.method === "pane.report_agent" && call.params.pane_id === paneId);
    const report = (state: string) => ({
      pane_id: paneId,
      source: "herdr:agent-console",
      agent: "claude",
      state,
      seq: expect.any(Number),
      message: "conv-1 · Talk",
    });

    await until(reports, (calls) => calls.length >= 1, { what: "the launch's report" });
    expect(reports().map((call) => call.params)).toEqual([report("working")]);

    await show(herdr, paneId, IDLE);
    await untilPushedTurn(socket, "conv-1", (turn) => turn.state === "waiting");
    await until(reports, (calls) => calls.length >= 2, { what: "the blocked report" });
    // Reads that hold the Turn waiting report nothing more.
    await untilReads(herdr, paneId, herdr.calls.length, 2);
    expect(reports().map((call) => call.params)).toEqual([report("working"), report("blocked")]);

    await show(herdr, paneId, BUSY);
    await until(reports, (calls) => calls.length >= 3, { what: "the working report" });
    expect(reports().map((call) => call.params)).toEqual([report("working"), report("blocked"), report("working")]);
    const seqs = reports().map((call) => call.params.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);

    const ended = await server.http.post("/api/conversations/end", { id: "conv-1" });
    expect(ended.status, ended.text).toBe(202);
    const release = await herdr.waitForCall((call) => call.method === "pane.release_agent", { ms: 20_000 });
    expect(release.params).toEqual({ pane_id: paneId, source: "herdr:agent-console", agent: "claude" });
    await herdr.settle();
    expect(reports()).toHaveLength(3);
  },
);
