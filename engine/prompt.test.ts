import { describe, expect, it } from "bun:test";
import { DEFAULT_SPAWN_CAPS, SPAWN_BODY_MIN_CHARS } from "./engine.ts";
import {
  buildContinuedTeaching,
  buildConversationTeaching as build,
  buildHeadToHeadPrompt,
  buildPrompt,
} from "./prompt.ts";

function prompt(): string {
  return buildPrompt({
    chain: [],
    agentMd: "Do the thing.",
    roster: "",
    upstream: [],
    outcomePath: "/tmp/pool/runs/01.outcome.json",
    spawnCaps: DEFAULT_SPAWN_CAPS,
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

describe("buildPrompt spawn teaching", () => {
  it("documents the spawn key's shape and the engine-assigned ids", () => {
    const body = prompt();
    expect(body).toContain('optional "spawn" array');
    expect(body).toContain('"title"');
    expect(body).toContain('"body"');
    expect(body).toContain('"blockedBy"');
    expect(body).toContain("<parent>-spawn-N");
    expect(body).toContain("07-spawn-1");
  });

  it("names the same body floor the engine's validator enforces", () => {
    expect(prompt()).toContain(
      `at least ${SPAWN_BODY_MIN_CHARS} characters of intent`,
    );
  });

  it("documents the drop rules, the caps, and that a drop never fails the attempt", () => {
    const body = prompt();
    expect(body).toContain("Thin or out-of-pool proposals are dropped");
    expect(body).toContain("recorded in the ticket log");
    expect(body).toContain("never costs your attempt its result");
    expect(body).toContain("5 proposals honored per attempt");
    expect(body).toContain("20 per run");
  });

  // Issue #149: the caps are the pool's live ones, not a hardcoded pair.
  it("names the pool's own caps, in the singular when a cap is one", () => {
    const body = buildPrompt({
      chain: [],
      agentMd: "",
      roster: "",
      upstream: [],
      outcomePath: "/tmp/pool/runs/01.outcome.json",
      spawnCaps: { perAttempt: 1, perRun: 12 },
    });
    expect(body).toContain("1 proposal honored per attempt and 12 per run");
  });

  it("states the standing rule: agents propose, the engine writes pool state", () => {
    const body = prompt();
    expect(body).toContain("proposed, never written");
    expect(body).toContain("You never write pool state");
    expect(body).toContain("You propose; the engine writes.");
  });

  it("renders identically for an attempt whose ticket was itself spawned", () => {
    const spawned = buildPrompt({
      chain: [],
      agentMd: "Do the thing.",
      roster: "",
      upstream: [],
      outcomePath: "/tmp/pool/runs/01-spawn-1.outcome.json",
      spawnCaps: DEFAULT_SPAWN_CAPS,
    });
    expect(spawned).toContain("/tmp/pool/runs/01-spawn-1.outcome.json");
    expect(spawned).toBe(
      prompt().replace("/01.outcome.json", "/01-spawn-1.outcome.json"),
    );
  });
});

describe("buildConversationTeaching", () => {
  const spawnPath = "/tmp/pool/runs/conv-1.spawn.json";
  const own = { harness: "claude", model: "opus", drivers: "implement" };
  const defaults = { harness: "opencode", model: "deepseek", drivers: "implement" };
  const buildConversationTeaching = (path: string) => build(path, own, defaults, 5);

  it("states the Conversation's own Assignment, the pool defaults, the fall-through, and the citizen skill", () => {
    const body = build(spawnPath, own, defaults, 5);
    expect(body).toContain("Load the my-console-citizen skill");
    expect(body).toContain("This Conversation's Assignment: harness claude, model opus, drivers implement.");
    expect(body).toContain("The pool defaults: harness opencode, model deepseek, drivers implement.");
    expect(body).toContain("falls through to the pool defaults");
    expect(body).toContain("ask the operator here before you write the file");
  });

  it("names an effort only where one is set, and offers it in the assign shape", () => {
    const body = build(spawnPath, { ...own, effort: "high" }, defaults, 5);
    expect(body).toContain("This Conversation's Assignment: harness claude, model opus, effort high, drivers implement.");
    expect(body).toContain("The pool defaults: harness opencode, model deepseek, drivers implement.");
    expect(body).toContain('"effort": "..."');
  });

  it("spells out an empty field rather than leaving a blank: an enlisted pane names no model, a pool may name no defaults", () => {
    const body = build(spawnPath, { ...own, model: "" }, undefined, 5);
    expect(body).toContain("This Conversation's Assignment: harness claude, model (none), drivers implement.");
    expect(body).toContain("The pool defaults: harness (none), model (none), drivers (none).");
  });

  it("names the spawn.json path and the proposal shape, including kind and assign", () => {
    const body = buildConversationTeaching(spawnPath);
    expect(body).toContain(spawnPath);
    expect(body).toContain('"spawn"');
    expect(body).toContain('"title"');
    expect(body).toContain('"body"');
    expect(body).toContain('"blockedBy"');
    expect(body).toContain('"kind"');
    expect(body).toContain('"assign"');
  });

  it("names the same body floor the engine's validator enforces", () => {
    expect(buildConversationTeaching(spawnPath)).toContain(
      `at least ${SPAWN_BODY_MIN_CHARS} characters`,
    );
  });

  it("states blockedBy may only name Tickets and that a Conversation entry is dropped", () => {
    const body = buildConversationTeaching(spawnPath);
    expect(body).toContain("may only name Tickets, never");
    expect(body).toContain("another Conversation");
    expect(body).toContain("dropped and logged");
  });

  it("documents the per-file cap of five and that there is no run-wide cap", () => {
    const body = buildConversationTeaching(spawnPath);
    expect(body).toContain("5 entries honored per file");
    expect(body).toContain("no run-wide cap");
  });

  it("names the pool's own per-file cap (issue #149)", () => {
    expect(build(spawnPath, own, defaults, 8)).toContain("8 entries honored per file");
    expect(build(spawnPath, own, defaults, 1)).toContain("1 entry honored per file");
  });

  it("documents that a spawned Ticket and a spawned Conversation both report back as a Turn", () => {
    const body = buildConversationTeaching(spawnPath);
    expect(body).toContain("reports back here as a Turn");
    expect(body).toContain("branch, and a diff");
    expect(body).toContain("its branch and the operator's closing note");
    expect(body).toContain("cannot answer either one's own Interrupt");
  });

  it("states the standing rule: agents propose, the engine writes pool state", () => {
    const body = buildConversationTeaching(spawnPath);
    expect(body).toContain("You never write pool state");
    expect(body).toContain("You propose; the engine writes.");
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

describe("buildContinuedTeaching", () => {
  const teaching = buildContinuedTeaching({
    id: "01",
    issuePath: "/pool/issues/01.md",
    outcomePath: "/pool/runs/01.attempt-3.outcome.json",
    attempt: 3,
  });

  it("tells the agent the operator carries on here and a fresh Outcome is owed at the exact path", () => {
    expect(teaching).toContain("keep talking with you here about Ticket 01");
    expect(teaching).toContain("attempt 3");
    expect(teaching).toContain("The Outcome you wrote before is spent");
    expect(teaching).toContain("/pool/runs/01.attempt-3.outcome.json");
    expect(teaching).toContain("/pool/issues/01.md");
  });

  it("restates the whole Outcome contract, spawn floor included", () => {
    expect(teaching).toContain('"status": "done" or "checkpoint"');
    expect(teaching).toContain('"brief"');
    expect(teaching).toContain('"spawn" array');
    expect(teaching).toContain(`at least ${SPAWN_BODY_MIN_CHARS} characters`);
  });
});
