import { describe, expect, test } from "bun:test";
import { exitCrashReason, exitedPhrase } from "./engine.ts";

// The three causes of a non-zero exit read differently on purpose: a real code
// blames the harness, an unreadable one points at the pane wrapper, and a pane
// that left herdr's listing blames neither. Conflating the first two once
// reported successful attempts as `harness exited 1` (ADR-0014).
describe("exitCrashReason", () => {
  test("names the harness and its code for a real exit", () => {
    expect(exitCrashReason(3, "/runs/17.exitcode", "harness", null)).toBe(
      "harness exited 3",
    );
  });

  test("carries the subject through, so a resolver reads as one", () => {
    expect(exitCrashReason(2, "/runs/17.exitcode", "resolver", null)).toBe(
      "resolver exited 2",
    );
  });

  test("points at the unwritten file when no code arrived", () => {
    const reason = exitCrashReason(-1, "/runs/17.exitcode", "harness", null);
    expect(reason).toContain("exit code unreadable");
    expect(reason).toContain("/runs/17.exitcode");
    expect(reason).not.toContain("exited -1");
  });

  // The pane left herdr's listing and the grace window passed with no file:
  // the attempt is over and nothing it did is knowable. Reporting that as the
  // wrapper's fault reads as a harness fault, which is what sent an operator
  // looking at a harness that had never run.
  test("names the pane and the unwritten file when the pane is gone", () => {
    const reason = exitCrashReason(
      -2,
      "/runs/17.exitcode",
      "harness",
      "pane-4",
    );
    expect(reason).toContain("pane-4");
    expect(reason).toContain("/runs/17.exitcode");
    expect(reason).not.toContain("exited -2");
    // The two words that would blame something that never got the chance.
    expect(reason).not.toContain("harness exited");
    expect(reason).not.toContain("wrapper never wrote");
  });
});

// The pool log has to name the ending in passing, on the same line as the
// marker and the crash reason. Templating the number unconditionally put
// `exited -2` immediately beside a reason whose whole job is to say no exit
// status was ever observed, so one attempt read two contradictory ways on
// consecutive lines.
describe("exitedPhrase", () => {
  test("reads as the shell's own status for a real exit", () => {
    expect(exitedPhrase(3)).toBe("exited 3");
    expect(exitedPhrase(0)).toBe("exited 0");
  });

  test("says no code arrived rather than printing the sentinel", () => {
    expect(exitedPhrase(-1)).toBe("ended with no exit code");
    expect(exitedPhrase(-1)).not.toContain("-1");
  });

  test("says the pane went away rather than printing the sentinel", () => {
    expect(exitedPhrase(-2)).toBe("ended with its pane gone");
    expect(exitedPhrase(-2)).not.toContain("-2");
  });

  // Both halves of a log line come from here: the phrase and the reason it
  // sits beside must agree about whether a status was ever seen.
  test("agrees with the crash reason it sits beside", () => {
    for (const code of [-1, -2]) {
      const reason = exitCrashReason(
        code,
        "/runs/17.exitcode",
        "harness",
        "pane-4",
      );
      expect(`${exitedPhrase(code)}, crash: ${reason}`).not.toContain(
        `exited ${code}`,
      );
    }
  });
});
