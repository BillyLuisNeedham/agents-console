/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  StreamLineBuffer,
  TranscriptLineBuffer,
  deriveStreamLine,
} from "./streamlog.ts";

describe("deriveStreamLine", () => {
  it("passes assistant text through verbatim", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the spec now."}]}}',
      ),
    ).toBe("Reading the spec now.");
  });

  it("keeps multi-line assistant text multi-line", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"line one\\nline two"}]}}',
      ),
    ).toBe("line one\nline two");
  });

  it("derives one [tool] line per tool call, command as the Bash summary", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"bun test engine/"}}]}}',
      ),
    ).toBe("[tool] Bash: bun test engine/");
  });

  it("summarizes file tools by their path field", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.ts","limit":10}}]}}',
      ),
    ).toBe("[tool] Read: /a/b.ts");
  });

  it("falls back to the first string field for an unknown tool", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Mystery","input":{"count":3,"target":"the thing"}}]}}',
      ),
    ).toBe("[tool] Mystery: the thing");
  });

  it("collapses newlines inside a summary and truncates a long one", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"echo a\\necho b"}}]}}',
      ),
    ).toBe("[tool] Bash: echo a echo b");
    const long = "x".repeat(300);
    expect(
      deriveStreamLine(
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"${long}"}}]}}`,
      ),
    ).toBe(`[tool] Bash: ${"x".repeat(200)}...`);
  });

  it("derives text and tool blocks of one event in content order", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Running"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
      ),
    ).toBe("Running\n[tool] Bash: ls");
  });

  it("writes no line for an assistant event with no content blocks", () => {
    expect(
      deriveStreamLine('{"type":"assistant","message":{"content":[]}}'),
    ).toBe("");
  });

  it("writes no line for recognized events the log has no use for", () => {
    expect(deriveStreamLine('{"type":"system","subtype":"init"}')).toBe("");
    expect(deriveStreamLine('{"type":"result","usage":{}}')).toBe("");
    expect(
      deriveStreamLine(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}',
      ),
    ).toBe("");
  });

  it("passes through unrecognized event types and non-jsonl lines verbatim", () => {
    expect(deriveStreamLine('{"type":"future-event","data":{}}')).toBeNull();
    expect(deriveStreamLine("fake claude ran")).toBeNull();
    expect(deriveStreamLine("")).toBeNull();
    expect(deriveStreamLine("[1,2,3]")).toBeNull();
    expect(deriveStreamLine('"just a string"')).toBeNull();
  });

  it("passes through an assistant event whose shape it does not know", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":"a plain string"}}',
      ),
    ).toBeNull();
    expect(deriveStreamLine('{"type":"assistant"}')).toBeNull();
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"future-block"}]}}',
      ),
    ).toBeNull();
  });

  it("skips thinking blocks but keeps the message's text and tool calls", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"The answer."}]}}',
      ),
    ).toBe("The answer.");
  });

  it("writes no line for a thinking-only assistant message", () => {
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}',
      ),
    ).toBe("");
  });
});

describe("StreamLineBuffer", () => {
  it("emits each complete line of a chunk in order", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.push(new TextEncoder().encode("alpha\nbeta\n"))).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("reassembles a line split across chunks", () => {
    const buffer = new StreamLineBuffer();
    const bytes = new TextEncoder().encode("one-two-three\n");
    expect(buffer.push(bytes.slice(0, 5))).toEqual([]);
    expect(buffer.push(bytes.slice(5))).toEqual(["one-two-three"]);
  });

  it("keeps a multi-byte character split across chunks intact", () => {
    const buffer = new StreamLineBuffer();
    const bytes = new TextEncoder().encode("héllo\n");
    expect(buffer.push(bytes.slice(0, 2))).toEqual([]);
    expect(buffer.push(bytes.slice(2))).toEqual(["héllo"]);
  });

  it("strips a carriage return from a CRLF line", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.push(new TextEncoder().encode("cr-lf\r\n"))).toEqual([
      "cr-lf",
    ]);
  });

  it("flushes a final unterminated line once", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.push(new TextEncoder().encode("complete\npartial"))).toEqual([
      "complete",
    ]);
    expect(buffer.flush()).toEqual(["partial"]);
    expect(buffer.flush()).toEqual([]);
  });

  it("emits nothing for an empty flush", () => {
    const buffer = new StreamLineBuffer();
    expect(buffer.push(new TextEncoder().encode("done\n"))).toEqual(["done"]);
    expect(buffer.flush()).toEqual([]);
  });
});

describe("TranscriptLineBuffer (ADR-0016)", () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  it("derives an ANSI-laden typescript line into its readable text", () => {
    const buffer = new TranscriptLineBuffer();
    // A PTY paints with colour and cursor moves; script records the raw
    // bytes, CR line endings included. The derived line is the plain text.
    expect(
      buffer.push(
        encode("\x1b[32mClaude Code v2.1.263\x1b[0m\r\nhello from the TUI\r\n"),
      ),
    ).toEqual(["Claude Code v2.1.263", "hello from the TUI"]);
  });

  it("strips CSI sequences, OSC sequences, and two-byte escapes", () => {
    const buffer = new TranscriptLineBuffer();
    expect(
      buffer.push(
        encode(
          "\x1b]0;title\x07agent output\x1b7\x1b8\x1b[1A\x1b[2Kprogress done\r\n",
        ),
      ),
    ).toEqual(["agent outputprogress done"]);
  });

  it("keeps the operator's keystrokes, which the typescript records too", () => {
    const buffer = new TranscriptLineBuffer();
    // The engine's typed prompt appears in the typescript like any other
    // input, and the derivation keeps it so the ticket log shows the
    // steering.
    expect(
      buffer.push(encode("❯ /implement /tmp/pool/issues/01-t.md\r\n")),
    ).toEqual(["❯ /implement /tmp/pool/issues/01-t.md"]);
  });

  it("reassembles an escape sequence split across chunks", () => {
    const buffer = new TranscriptLineBuffer();
    const bytes = encode("\x1b[32mcoloured\x1b[0m\r\n");
    // The escape is cut mid-sequence in the first chunk.
    expect(buffer.push(bytes.slice(0, 4))).toEqual([]);
    expect(buffer.push(bytes.slice(4))).toEqual(["coloured"]);
  });

  it("keeps blank lines and non-ASCII text", () => {
    const buffer = new TranscriptLineBuffer();
    expect(buffer.push(encode("one\r\n\r\ntwo ✓\r\n"))).toEqual([
      "one",
      "",
      "two ✓",
    ]);
  });

  it("flushes a final unterminated line once", () => {
    const buffer = new TranscriptLineBuffer();
    expect(buffer.push(encode("partial\x1b[0m"))).toEqual([]);
    expect(buffer.flush()).toEqual(["partial"]);
    expect(buffer.flush()).toEqual([]);
  });
});
