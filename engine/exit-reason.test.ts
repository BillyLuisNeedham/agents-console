import { describe, expect, test } from "bun:test";
import { exitCrashReason } from "./engine.ts";

// The two causes of a non-zero exit read differently on purpose: a real code
// blames the harness, an unreadable one points at the pane wrapper. Conflating
// them once reported successful attempts as `harness exited 1` (ADR-0014).
describe("exitCrashReason", () => {
  test("names the harness and its code for a real exit", () => {
    expect(exitCrashReason(3, "/runs/17.exitcode", "harness")).toBe(
      "harness exited 3",
    );
  });

  test("carries the subject through, so a resolver reads as one", () => {
    expect(exitCrashReason(2, "/runs/17.exitcode", "resolver")).toBe(
      "resolver exited 2",
    );
  });

  test("points at the unwritten file when no code arrived", () => {
    const reason = exitCrashReason(-1, "/runs/17.exitcode", "harness");
    expect(reason).toContain("exit code unreadable");
    expect(reason).toContain("/runs/17.exitcode");
    expect(reason).not.toContain("exited -1");
  });
});
