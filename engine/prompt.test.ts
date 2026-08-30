import { describe, expect, it } from "bun:test";
import { buildPrompt } from "./prompt.ts";

function prompt(): string {
  return buildPrompt({
    chain: [],
    agentMd: "Do the thing.",
    roster: "",
    upstream: [],
    outcomePath: "/tmp/pool/runs/01.outcome.json",
  });
}

describe("buildPrompt outcome instruction", () => {
  it("documents the full outcome schema, with the required status field", () => {
    const body = prompt();
    expect(body).toContain('"status": "done" or "checkpoint"');
    expect(body).toContain('"summary"');
    expect(body).toContain('"commitSha": "the sha of your commit, or null"');
    expect(body).toContain('/tmp/pool/runs/01.outcome.json');
  });

  it("documents the brief for checkpoints", () => {
    expect(prompt()).toContain('"brief"');
  });

  it("states that the engine owns the status write and the marker is off-limits", () => {
    const body = prompt();
    expect(body).toContain("Never edit the Issue's line-1 status marker");
    expect(body).toContain("the engine owns that write");
  });
});
