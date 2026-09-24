import { describe, expect, test } from "bun:test";
import { normaliseTitle, TITLE_MAX } from "./pool-title.ts";

describe("normaliseTitle", () => {
  test("collapses whitespace to one line and trims", () => {
    expect(normaliseTitle("  Jev as\n the\tgrader  ")).toBe("Jev as the grader");
  });

  test("blank is no title", () => {
    expect(normaliseTitle(" \n ")).toBeNull();
  });

  test("drops control characters, so a terminal escape cannot ride a workspace label", () => {
    expect(normaliseTitle("\x1b[31mRed\x07 pool")).toBe("[31mRed pool");
  });

  test("cuts a pasted wall of text to the maximum", () => {
    const title = normaliseTitle("x".repeat(500));
    expect(title).toHaveLength(TITLE_MAX);
  });

  test("cuts by character, never splitting one in two", () => {
    const title = normaliseTitle("🙂".repeat(TITLE_MAX + 5))!;
    expect([...title]).toHaveLength(TITLE_MAX);
  });
});
