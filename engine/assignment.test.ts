import { describe, expect, it } from "bun:test";
import { assignmentViewOf, resolveAssignment, UNASSIGNED_ASSIGNMENT_VIEW } from "./assignment.ts";
import type { HarnessCommand } from "./spawn.ts";

const harnesses: Record<string, HarnessCommand> = {
  claude: () => ["claude"],
  codex: () => ["codex"],
};
const known = "Known: claude, codex";

const parent = { harness: "codex", model: "o3", drivers: "implement review" };
const defaults = { harness: "claude", model: "opus", drivers: "implement" };

// The four callers, each with its own overrides (ticket 04's Design).
const ordinary = { subject: "pool config: ticket 01", defaults, strict: false, verify: true, harnesses };
const spawned = { subject: "pool config: ticket 01-spawn-1", inherited: parent, strict: false, verify: true, harnesses };
const grader = { subject: "pool config: ticket 01-grader-1", inherited: parent, strict: false, verify: false, harnesses };
const conversation = { subject: "conversation start:", inherited: parent, defaults, strict: true, verify: false, harnesses };

describe("resolveAssignment: field-wise overrides", () => {
  it("ordinary ticket: request over defaults, empty when neither says", () => {
    expect(resolveAssignment({ ...ordinary, request: undefined })).toEqual(defaults);
    expect(resolveAssignment({ ...ordinary, request: { model: "haiku" } })).toEqual({
      ...defaults,
      model: "haiku",
    });
    expect(resolveAssignment({ ...ordinary, request: undefined, defaults: undefined })).toEqual({
      harness: "",
      model: "",
      drivers: "implement",
    });
  });

  it("spawned ticket: request over the parent, the parent over the defaults", () => {
    expect(resolveAssignment({ ...spawned, request: undefined })).toEqual(parent);
    expect(resolveAssignment({ ...spawned, request: { harness: "claude", drivers: "fix" } })).toEqual({
      harness: "claude",
      model: "o3",
      drivers: "fix",
    });
    // A field the parent leaves empty falls through to the defaults, field
    // by field (issue #118: an enlisted Conversation names no model).
    expect(
      resolveAssignment({ ...spawned, request: undefined, inherited: { ...parent, model: "" }, defaults }),
    ).toEqual({ harness: "codex", model: "opus", drivers: "implement review" });
    expect(
      resolveAssignment({ ...spawned, request: undefined, inherited: { ...parent, model: "" } }),
    ).toEqual({ ...parent, model: "" });
  });

  it("grader: harness and model over the build's, drivers pinned to the build's, verify ignored", () => {
    // The caller strips drivers and verify from the request (engine.ts's
    // resolveEngineTicketAssignment); here the resolver's own verify flag
    // shows the verify key is ignored even when handed in.
    expect(resolveAssignment({ ...grader, request: { model: "haiku", verify: 3 } })).toEqual({
      harness: "codex",
      model: "haiku",
      drivers: "implement review",
    });
  });

  it("conversation: request, then the parent, then the defaults", () => {
    expect(resolveAssignment({ ...conversation, request: { model: "sonnet" } })).toEqual({
      harness: "codex",
      model: "sonnet",
      drivers: "implement review",
    });
    expect(resolveAssignment({ ...conversation, request: undefined, inherited: undefined })).toEqual(
      defaults,
    );
    expect(
      resolveAssignment({ ...conversation, request: undefined, inherited: undefined, defaults: { harness: "claude", model: "opus" } }),
    ).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
  });
});

describe("resolveAssignment: errors, verbatim", () => {
  it("a named harness must be known, in every mode", () => {
    expect(() => resolveAssignment({ ...ordinary, request: { harness: "gemini" } })).toThrow(
      `pool config: ticket 01 names unknown harness 'gemini'. ${known}`,
    );
    expect(() => resolveAssignment({ ...spawned, request: { harness: "gemini" } })).toThrow(
      `pool config: ticket 01-spawn-1 names unknown harness 'gemini'. ${known}`,
    );
    expect(() => resolveAssignment({ ...grader, request: { harness: "gemini" } })).toThrow(
      `pool config: ticket 01-grader-1 names unknown harness 'gemini'. ${known}`,
    );
    expect(() => resolveAssignment({ ...conversation, request: { harness: "gemini" } })).toThrow(
      `conversation start: names unknown harness 'gemini'. ${known}`,
    );
  });

  it("strict: no harness, then unknown harness, then no model, in that order", () => {
    const bare = { ...conversation, inherited: undefined, defaults: undefined };
    expect(() => resolveAssignment({ ...bare, request: undefined })).toThrow(
      "conversation start: no harness resolved (set assign.harness, inherit " +
        "from the parent Conversation, or console.json defaults.harness)",
    );
    expect(() => resolveAssignment({ ...bare, request: { harness: "claude" } })).toThrow(
      "conversation start: no model resolved (set assign.model, inherit " +
        "from the parent Conversation, or console.json defaults.model)",
    );
    // An unknown harness is reported before the missing model.
    expect(() => resolveAssignment({ ...bare, request: { harness: "gemini" } })).toThrow(
      `conversation start: names unknown harness 'gemini'. ${known}`,
    );
  });

  it("lenient: an empty harness or model is not an error", () => {
    expect(resolveAssignment({ ...ordinary, request: { harness: "" }, defaults: undefined }).harness).toBe("");
  });

  it("verify: honoured when integer >= 1, null treated as absent, otherwise rejected verbatim", () => {
    expect(resolveAssignment({ ...ordinary, request: { verify: 3 } }).verify).toBe(3);
    expect(resolveAssignment({ ...spawned, request: { verify: 1 } }).verify).toBe(1);
    expect(resolveAssignment({ ...ordinary, request: { verify: null } }).verify).toBeUndefined();
    expect(resolveAssignment({ ...ordinary, request: {} })).not.toHaveProperty("verify");
    for (const verify of [0, -1, 2.5, "3", true, {}]) {
      expect(() => resolveAssignment({ ...ordinary, request: { verify } })).toThrow(
        `pool config: ticket 01 has invalid verify ${JSON.stringify(verify)} (must be an integer >= 1)`,
      );
    }
    // A mode that ignores verify never validates it either.
    expect(resolveAssignment({ ...grader, request: { verify: "bad" } })).not.toHaveProperty("verify");
  });
});

describe("assignmentViewOf", () => {
  it("renders empty harness and model as null and drivers verbatim", () => {
    expect(assignmentViewOf({ harness: "", model: "", drivers: "implement" })).toEqual(
      UNASSIGNED_ASSIGNMENT_VIEW,
    );
    expect(assignmentViewOf({ harness: "", model: "", drivers: "" }).drivers).toBe("");
    expect(assignmentViewOf({ harness: "claude", model: "opus", drivers: "fix" })).toEqual({
      harness: "claude",
      model: "opus",
      drivers: "fix",
    });
  });
});
