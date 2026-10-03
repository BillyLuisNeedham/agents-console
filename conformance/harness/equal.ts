/**
 * The two equalities the contract asks for (ADR-0036). The files people and
 * agents read, Ticket and Conversation markdown, the state line,
 * spawn-ledger.md and AGENT.md, must be the same byte for byte. JSON, JSONL,
 * checkpoint state and socket frames need only be equal once parsed: key
 * order and spacing are free, values are not.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseJsonl } from "./pool-files.ts";

type Bytes = string | Uint8Array;

function toBuffer(value: Bytes): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

/** Where two byte runs first differ, as line and column (from 1). */
function firstDifference(a: Buffer, b: Buffer): { offset: number; line: number; column: number } {
  let offset = 0;
  while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
  const before = a.subarray(0, offset);
  const line = before.filter((byte) => byte === 0x0a).length + 1;
  const column = offset - (before.lastIndexOf(0x0a) + 1) + 1;
  return { offset, line, column };
}

/**
 * Byte-identical, for the files people and agents read. A mismatch fails
 * with Bun's text diff and the first differing byte, since a trailing space
 * or a missing final newline is exactly what this is here to catch.
 */
export function expectSameBytes(actual: Bytes, expected: Bytes, what = "the file"): void {
  const a = toBuffer(actual);
  const b = toBuffer(expected);
  if (a.equals(b)) return;
  const at = firstDifference(a, b);
  const where = `${what} differs from byte ${at.offset} (line ${at.line}, column ${at.column})`;
  // The text diff names what changed; the message names where.
  expect(a.toString("utf8"), where).toBe(b.toString("utf8"));
  // Bytes that differ but decode alike (bad UTF-8 on both sides) still fail.
  throw new Error(`${where}, in bytes the text decoding hides`);
}

/** A file's bytes against what they must be. */
export function expectSameFile(path: string, expected: Bytes): void {
  expectSameBytes(readFileSync(path), expected, path);
}

function parsed(value: unknown, what: string): unknown {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) return value;
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Equal once parsed, for JSON, checkpoint state and socket frames. Either
 * side may be JSON text or a value already parsed; the expected side may
 * hold Bun's asymmetric matchers (`expect.any(String)` for a timestamp).
 */
export function expectParsedEqual(actual: unknown, expected: unknown, what = "the value"): void {
  expect(parsed(actual, what), `${what} once parsed`).toEqual(parsed(expected, `the expected ${what}`));
}

/** A matcher for a timestamp as the engine writes one: ISO 8601, UTC, to the millisecond. */
export function anyIsoTime(): unknown {
  return expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

/** JSONL equal once parsed, line by line. */
export function expectJsonlEqual(actual: Bytes, expected: Bytes | unknown[], what = "the JSONL"): void {
  const text = (value: Bytes) => (typeof value === "string" ? value : Buffer.from(value).toString("utf8"));
  const want = Array.isArray(expected) ? expected : parseJsonl(text(expected as Bytes));
  expect(parseJsonl(text(actual)), `${what} once parsed`).toEqual(want);
}
