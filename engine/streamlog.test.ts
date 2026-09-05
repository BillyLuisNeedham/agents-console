/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { StreamLineBuffer, deriveStreamLine } from "./streamlog.ts";

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

  it("passes through other event types and non-jsonl lines verbatim", () => {
    expect(deriveStreamLine('{"type":"system","subtype":"init"}')).toBeNull();
    expect(deriveStreamLine('{"type":"result","usage":{}}')).toBeNull();
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
    expect(
      deriveStreamLine(
        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}',
      ),
    ).toBeNull();
    expect(deriveStreamLine('{"type":"assistant"}')).toBeNull();
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
