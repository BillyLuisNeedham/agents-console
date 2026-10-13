/**
 * The last line a Conversation's Turn names (ADR-0018, issue #71), seen
 * from outside the server (ADR-0036): the last row of the pane's transcript
 * that has content once runs of whitespace and box-drawing or block glyphs
 * are collapsed, the transcript being every row above the TUI's input box.
 * Rows of the `conversations` area, ticket C17, in the Rust port inventory
 * (docs/research/rust-port/test-inventory.md), from engine/turn-state.test.ts's
 * extractLastLine and transcriptOf.
 *
 * None of these frames carries claude's idle `❯`, so the Turn stays working
 * throughout, and each frame's own last line is published as the read that
 * first sees it: every frame here names a different last line from the one
 * before it.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import type { Talk } from "./conversations-support.ts";
import { show, startConversation, startTalk, untilPushedTurn } from "./conversations-support.ts";

const RULE = "─".repeat(120);

/** Start Conversation conv-1 on the busy frame; its pane id once its first read is published. */
async function talking(talk: Talk): Promise<string> {
  const view = await startConversation(talk.server, { title: "Talk" });
  await untilPushedTurn(talk.socket, "conv-1", (turn) => turn.lastLine === "✢ Working…", { what: "conv-1's first read" });
  return view.paneId!;
}

/** Show `frame` and expect the Turn it publishes to name `lastLine`, still working. */
async function expectLastLine(talk: Talk, paneId: string, frame: string, lastLine: string): Promise<void> {
  const from = talk.socket.frames.length;
  await show(talk.herdr, paneId, frame);
  const pushed = await untilPushedTurn(talk.socket, "conv-1", (turn) => turn.lastLine === lastLine, {
    from,
    what: `the last line ${JSON.stringify(lastLine)} for ${JSON.stringify(frame)}`,
  });
  expect(pushed.turn).toEqual({ state: "working", lastLine, idleSince: null });
}

// turn-state.test.ts:105, :109, :113, :119, :124, :276
conformance(
  "conversations",
  "the last line is the last row with content, trimmed, chrome rows skipped and chrome runs collapsed to a space",
  async (t) => {
    const talk = await startTalk(t);
    const paneId = await talking(talk);

    // Trimmed, and trailing blank rows skipped.
    await expectLastLine(talk, paneId, "first\nsecond\nthird   ", "third");
    await expectLastLine(talk, paneId, "hello\n\n\n   \n", "hello");
    // Rows of box-drawing glyphs alone are chrome, never the last line.
    await expectLastLine(talk, paneId, "agent said this\n──────────\n│          │\n──────────", "agent said this");
    // A run of chrome inside a row collapses to one space.
    await expectLastLine(talk, paneId, "some─────text", "some text");
    // All blank and chrome: no last line.
    await expectLastLine(talk, paneId, "   \n──────\n\n", "");
    // A rendered table's bottom edge is skipped for its last row.
    await expectLastLine(talk, paneId, "│ a │ b │\n└───┴───┘", "a b");
    // An empty read: no last line.
    await expectLastLine(talk, paneId, "", "");
  },
  { timeoutMs: 90_000 },
);

// turn-state.test.ts:235, :248, :253
conformance(
  "conversations",
  "the transcript ends at the input box's top border: the highest border row within eight rows above the lowest",
  async (t) => {
    const talk = await startTalk(t);
    const paneId = await talking(talk);

    // No other border within eight rows above the bottom rule: the cut is
    // at the bottom rule alone, so a small box higher up stays transcript.
    await expectLastLine(
      talk,
      paneId,
      ["┌────┐", "│ a  │", "└────┘", ...Array.from({ length: 9 }, (_, i) => `draft ${i + 1}`), RULE, "footer"].join("\n"),
      "draft 9",
    );
    // A rule exactly eight rows above the bottom one is the box's top.
    await expectLastLine(
      talk,
      paneId,
      ["said above the box", RULE, ...Array.from({ length: 7 }, (_, i) => `draft ${i + 1}`), RULE, "footer"].join("\n"),
      "said above the box",
    );
    // A box padded inside with bare ┃ rows is cut at the highest of them.
    await expectLastLine(
      talk,
      paneId,
      ["said before the padding", "┃", "┃ typed", "┃", "┃ model", "╹▀▀▀▀", "footer"].join("\n"),
      "said before the padding",
    );
  },
  { timeoutMs: 90_000 },
);
