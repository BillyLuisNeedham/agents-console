import { describe, expect, it } from "bun:test";
import { buildHeadToHeadPrompt, buildPrompt } from "./prompt.ts";

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

describe("buildHeadToHeadPrompt", () => {
  const parts = () => ({
    buildId: "01",
    ticketPath: "/tmp/pool/issues/01-t.md",
    skill: null,
    top: {
      attempt: 1,
      outcomePath: "/tmp/pool/runs/01.attempt-1.outcome.json",
      diffPath: "/tmp/pool/runs/01-head-to-head.attempt-1.diff.patch",
      logPath: "/tmp/pool/runs/01-head-to-head.attempt-1.trim.log",
      score: 9,
      verdict: "pass" as const,
      reasons: "scored 9",
    },
    runnerUp: {
      attempt: 2,
      outcomePath: "/tmp/pool/runs/01.attempt-2.outcome.json",
      diffPath: "/tmp/pool/runs/01-head-to-head.attempt-2.diff.patch",
      logPath: "/tmp/pool/runs/01-head-to-head.attempt-2.trim.log",
      score: 8,
      verdict: "pass" as const,
      reasons: "scored 8",
    },
    outcomePath: "/tmp/pool/runs/01-head-to-head.outcome.json",
  });

  it("names both sides' grades and binds each side's three artifacts", () => {
    const body = buildHeadToHeadPrompt(parts());
    expect(body).toContain("attempt 1, graded 9/10");
    expect(body).toContain("attempt 2, graded 8/10");
    expect(body).toContain("/tmp/pool/runs/01.attempt-1.outcome.json");
    expect(body).toContain("/tmp/pool/runs/01.attempt-2.outcome.json");
    expect(body).toContain("01-head-to-head.attempt-1.diff.patch");
    expect(body).toContain("01-head-to-head.attempt-2.diff.patch");
    expect(body).toContain("01-head-to-head.attempt-1.trim.log");
    expect(body).toContain("01-head-to-head.attempt-2.trim.log");
    expect(body).toContain("/tmp/pool/issues/01-t.md");
  });

  it("carries the pool's verify skill as the shared criteria, or says it is absent", () => {
    const withSkill = buildHeadToHeadPrompt({
      ...parts(),
      skill: "POOL-SKILL-MARKER: compare on the three criteria only.",
    });
    expect(withSkill).toContain(
      "POOL-SKILL-MARKER: compare on the three criteria only.",
    );
    const withoutSkill = buildHeadToHeadPrompt(parts());
    expect(withoutSkill).toContain("(the pool has no verify skill");
  });

  it("states the pick contract, the tie clause, and the trust rule", () => {
    const body = buildHeadToHeadPrompt(parts());
    expect(body).toContain('"winner"');
    expect(body).toContain("exactly one of 1 or 2");
    expect(body).toContain('"winner": "tie"');
    expect(body).toContain("falls back to the higher score, then the earlier");
    expect(body).toContain("Trust terminal output over the agents' self-assessments.");
    expect(body).toContain("The engine owns every status write");
  });
});
