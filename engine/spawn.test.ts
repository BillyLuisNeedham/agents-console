import { describe, expect, it } from "bun:test";
import {
  defaultHarnesses,
  harnessStreamMode,
  type SpawnContext,
} from "./spawn.ts";

function context(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    id: "01",
    issuePath: "/tmp/pool/issues/01-a.md",
    body: "Standing instructions for this job:\n\nDo the thing.",
    driver: "implement",
    harness: "claude",
    model: "claude-test",
    logPath: "/tmp/pool/runs/01.log",
    outcomePath: "/tmp/pool/runs/01.outcome.json",
    cwd: "/tmp/pool",
    streamPath: null,
    ...overrides,
  };
}

describe("defaultHarnesses", () => {
  it("builds the claude argv from the driver, issue reference, and body fields", () => {
    expect(defaultHarnesses.claude(context())).toEqual([
      "claude",
      "-p",
      "/implement /tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("passes the roster JSON to claude through --agents", () => {
    const agents = '{"deepseek":{"description":"General-purpose subagent"}}';
    const argv = defaultHarnesses.claude(context({ agents }));
    expect(argv[argv.indexOf("--agents") + 1]).toBe(agents);
  });

  it("builds the opencode argv from the fields without the driver line in the message", () => {
    expect(defaultHarnesses.opencode(context())).toEqual([
      "opencode",
      "run",
      "--command",
      "implement",
      "/tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
      "--model",
      "claude-test",
      "--auto",
    ]);
    expect(
      defaultHarnesses.opencode(context())[3],
    ).not.toContain("/implement");
    expect(defaultHarnesses.opencode(context())).not.toContain(
      "--output-format",
    );
  });

  it("builds the cursor argv from the fields (unproven line, carried over from run.sh)", () => {
    expect(defaultHarnesses.cursor(context())).toEqual([
      "agent",
      "-p",
      "/implement /tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
      "--model",
      "claude-test",
      "--force",
      "--trust",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });
});

describe("harnessStreamMode", () => {
  it("declares the structured-stream harnesses streamed and everything else raw", () => {
    expect(harnessStreamMode("claude")).toBe("stream");
    expect(harnessStreamMode("cursor")).toBe("stream");
    expect(harnessStreamMode("opencode")).toBe("raw");
    expect(harnessStreamMode("mystery")).toBe("raw");
  });
});
