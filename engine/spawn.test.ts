import { describe, expect, it } from "bun:test";
import {
  defaultHarnessDescriptors,
  defaultHarnesses,
  effortApplies,
  elidePromptArgv,
  engineEnvSet,
  harnessStreamMode,
  interactiveHarnessCommand,
  poolHarnessMode,
  type HarnessCommand,
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
    exitCodePath: "/tmp/pool/runs/01.exitcode",
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

  // ADR-0031: the Console names skills, never a subagent roster, so claude
  // launches with whatever agents the user's own harness config defines.
  it("never passes --agents to claude", () => {
    expect(defaultHarnesses.claude(context())).not.toContain("--agents");
    expect(defaultHarnessDescriptors.claude.interactiveArgv(context())).not.toContain("--agents");
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

  it("builds the cursor argv from the fields (run against the real Cursor Agent CLI)", () => {
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
    ]);
  });
});

describe("defaultHarnessDescriptors", () => {
  // The per-harness descriptor (pool ticket 01): one record per harness
  // carrying the batch argv, the interactive argv, the readiness pattern, the
  // prompt shaping for both modes, and the stream mode, so the interactive
  // work lands as fields instead of surgery inside the spawn paths. The batch
  // argv and batch prompt shaping must be byte-for-byte what `defaultHarnesses`
  // has always produced, because `defaultHarnesses` is derived from them.

  const names = ["claude", "opencode", "cursor"] as const;

  it("describes every known harness with all descriptor fields", () => {
    for (const name of names) {
      const descriptor = defaultHarnessDescriptors[name];
      expect(descriptor).toBeDefined();
      expect(typeof descriptor.batchArgv).toBe("function");
      expect(typeof descriptor.interactiveArgv).toBe("function");
      expect(typeof descriptor.readyPattern).toBe("string");
      expect(typeof descriptor.promptShaping.batch).toBe("function");
      expect(typeof descriptor.promptShaping.interactive).toBe("function");
      expect(["stream", "raw"]).toContain(descriptor.streamMode);
      expect(Array.isArray(descriptor.clearKeys)).toBe(true);
      // echoPattern is optional (opencode echoes the paste inline and has
      // no marker); when present it is a non-empty pane-rendered pattern.
      if (descriptor.echoPattern !== undefined) {
        expect(descriptor.echoPattern.length).toBeGreaterThan(0);
      }
    }
  });

  it("exposes the prototype-validated ready and echo patterns", () => {
    // The ready patterns are the prototype's canonical fixtures: claude's
    // header, opencode's first-boot placeholder, cursor's header — not the
    // bare prompt glyph, which the pane's own bash prompt collides with.
    expect(defaultHarnessDescriptors.claude.readyPattern).toBe("Claude Code v");
    expect(defaultHarnessDescriptors.opencode.readyPattern).toBe("Ask anything");
    expect(defaultHarnessDescriptors.cursor.readyPattern).toBe("Cursor Agent");
    // claude and cursor collapse a long paste to a `[Pasted text #N +N
    // lines]` marker the echo verification matches; opencode echoes inline
    // and carries no marker.
    expect(defaultHarnessDescriptors.claude.echoPattern).toBe("Pasted text");
    expect(defaultHarnessDescriptors.cursor.echoPattern).toBe("Pasted text");
    expect(defaultHarnessDescriptors.opencode.echoPattern).toBeUndefined();
  });

  it("carries the prototype-verified clear keys, with claude empty pending verification", () => {
    expect(defaultHarnessDescriptors.opencode.clearKeys).toEqual(["ctrl+c"]);
    expect(defaultHarnessDescriptors.cursor.clearKeys).toEqual(["ctrl+c"]);
    expect(defaultHarnessDescriptors.claude.clearKeys).toEqual([]);
  });

  it("is the single source the batch-argv projection and the stream mode read from", () => {
    for (const name of names) {
      const descriptor = defaultHarnessDescriptors[name];
      // defaultHarnesses is derived from the descriptors' batchArgv, so the
      // two cannot drift.
      expect(defaultHarnesses[name]).toBe(descriptor.batchArgv);
      // harnessStreamMode reads the descriptor's streamMode, so the mode
      // lives here and nowhere else.
      expect(harnessStreamMode(name)).toBe(descriptor.streamMode);
    }
  });

  it("shapes the batch prompt exactly as the batch argv embeds it", () => {
    const ctx = context();
    for (const name of names) {
      const descriptor = defaultHarnessDescriptors[name];
      const argv = descriptor.batchArgv(ctx);
      // opencode carries the batch shape in the message (argv[4], after
      // run --command <driver>) and the bare driver in --command; claude and
      // cursor carry the full shape in the -p argument (argv[2]).
      const embedded = name === "opencode" ? argv[4] : argv[2];
      expect(embedded).toBe(descriptor.promptShaping.batch(ctx));
      expect(embedded).toContain(ctx.body);
    }
    // The batch shapes are the byte-for-byte prompts of today.
    expect(defaultHarnessDescriptors.claude.promptShaping.batch(ctx)).toBe(
      "/implement /tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
    );
    expect(defaultHarnessDescriptors.opencode.promptShaping.batch(ctx)).toBe(
      "/tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
    );
  });

  it("builds the interactive argv from the batch argv minus the batch-only flags", () => {
    expect(defaultHarnessDescriptors.claude.interactiveArgv(context())).toEqual([
      "claude",
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
    ]);
    expect(
      defaultHarnessDescriptors.claude.interactiveArgv(context()),
    ).not.toContain("-p");
    expect(
      defaultHarnessDescriptors.claude.interactiveArgv(context()),
    ).not.toContain("--output-format");
    expect(defaultHarnessDescriptors.opencode.interactiveArgv(context())).toEqual([
      "opencode",
      "--model",
      "claude-test",
      "--auto",
    ]);
    expect(
      defaultHarnessDescriptors.opencode.interactiveArgv(context()),
    ).not.toContain("run");
    expect(defaultHarnessDescriptors.cursor.interactiveArgv(context())).toEqual([
      "agent",
      "--model",
      "claude-test",
      "--force",
      "--trust",
    ]);
    expect(
      defaultHarnessDescriptors.cursor.interactiveArgv(context()),
    ).not.toContain("-p");
  });

  it("carries the auto-approve flags on the interactive argv, as the spec's spawn keeps them", () => {
    const claude = defaultHarnessDescriptors.claude.interactiveArgv(context());
    expect(claude).toContain("--permission-mode");
    expect(claude).toContain("auto");
    const opencode = defaultHarnessDescriptors.opencode.interactiveArgv(context());
    expect(opencode).toContain("--auto");
    const cursor = defaultHarnessDescriptors.cursor.interactiveArgv(context());
    expect(cursor).toContain("--force");
    expect(cursor).toContain("--trust");
  });

  it("shapes the interactive prompt the way each TUI accepts the driver invocation", () => {
    const ctx = context();
    // All three TUIs take the leading /driver slash line: claude and
    // opencode expand it as a slash command, and the prototype pasted this
    // exact form into cursor and observed the agent act on it (FINDINGS
    // sections 3-4).
    for (const name of names) {
      expect(defaultHarnessDescriptors[name].promptShaping.interactive(ctx)).toBe(
        "/implement /tmp/pool/issues/01-a.md\n\n" +
          "Standing instructions for this job:\n\nDo the thing.\n" +
          "/tmp/pool/issues/01-a.md",
      );
      expect(
        defaultHarnessDescriptors[name].promptShaping
          .interactive(ctx)
          .split("\n")
          .at(-1),
      ).toBe(ctx.issuePath);
    }
  });

  it("exposes one canonical readiness pattern fixture per harness", () => {
    for (const name of names) {
      expect(defaultHarnessDescriptors[name].readyPattern.length).toBeGreaterThan(0);
    }
  });

  it("treats an unknown harness as a raw descriptor-shaped gap, exactly as the mode lookup does", () => {
    expect(defaultHarnessDescriptors["mystery"]).toBeUndefined();
    expect(harnessStreamMode("mystery")).toBe("raw");
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

describe("interactiveHarnessCommand", () => {
  const ctx = context();

  it("replaces the engine's own batch command with the descriptor's interactive argv", () => {
    // `defaultHarnesses` is the record the engine hands a spawn site, so a
    // known harness resolves to its interactive TUI.
    const command = interactiveHarnessCommand(defaultHarnesses, "claude");
    expect(command(ctx)).toEqual(defaultHarnessDescriptors.claude.interactiveArgv(ctx));
    expect(command(ctx)).not.toContain("-p");
    expect(interactiveHarnessCommand(defaultHarnesses, "opencode")(ctx)).toEqual(
      ["opencode", "--model", "claude-test", "--auto"],
    );
  });

  it("runs a pool-registered override as the pane command as-is", () => {
    // A pool (or test) that overrides a harness by name owns what runs: the
    // override is not the descriptor's batch command, so it is used verbatim
    // in the TUI.
    const custom: HarnessCommand = () => ["bash", "/tmp/pool/stub.sh"];
    const harnesses = { ...defaultHarnesses, claude: custom };
    expect(interactiveHarnessCommand(harnesses, "claude")).toBe(custom);
  });

  it("falls back to the registered command for a custom harness name", () => {
    const custom: HarnessCommand = () => ["bash", "/tmp/pool/custom.sh"];
    expect(interactiveHarnessCommand({ custom }, "custom")).toBe(custom);
  });
});

describe("effort (CONTEXT.md: Effort)", () => {
  const withEffort = context({ effort: "high" });

  it("passes claude's --effort in both modes, verbatim", () => {
    const { claude } = defaultHarnessDescriptors;
    const batch = claude.batchArgv(withEffort);
    expect(batch.slice(batch.indexOf("--effort"), batch.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
    const tui = claude.interactiveArgv(withEffort);
    expect(tui.slice(tui.indexOf("--effort"), tui.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
  });

  it("passes opencode's run --variant, and nothing to its TUI", () => {
    const { opencode } = defaultHarnessDescriptors;
    const batch = opencode.batchArgv(context({ harness: "opencode", effort: "minimal" }));
    expect(batch.slice(batch.indexOf("--variant"), batch.indexOf("--variant") + 2)).toEqual([
      "--variant",
      "minimal",
    ]);
    expect(opencode.interactiveArgv(context({ harness: "opencode", effort: "minimal" }))).toEqual([
      "opencode",
      "--model",
      "claude-test",
      "--auto",
    ]);
  });

  it("gives cursor nothing in either mode, and never folds it into the model", () => {
    const { cursor } = defaultHarnessDescriptors;
    const ctx = context({ harness: "cursor", effort: "high" });
    expect(cursor.batchArgv(ctx)).toEqual(cursor.batchArgv(context({ harness: "cursor" })));
    expect(cursor.interactiveArgv(ctx)).toEqual(cursor.interactiveArgv(context({ harness: "cursor" })));
  });

  it("adds no flag at all when the Assignment names no effort", () => {
    for (const name of ["claude", "opencode", "cursor"] as const) {
      const descriptor = defaultHarnessDescriptors[name];
      for (const argv of [descriptor.batchArgv(context()), descriptor.interactiveArgv(context())]) {
        expect(argv).not.toContain("--effort");
        expect(argv).not.toContain("--variant");
      }
    }
  });

  it("declares exactly the modes whose argv carries the effort", () => {
    for (const [name, descriptor] of Object.entries(defaultHarnessDescriptors)) {
      const carries = (argv: string[]) => argv.includes("sentinel-effort");
      const ctx = context({ harness: name, effort: "sentinel-effort" });
      expect(carries(descriptor.batchArgv(ctx))).toBe(descriptor.takesEffort.batch);
      expect(carries(descriptor.interactiveArgv(ctx))).toBe(descriptor.takesEffort.interactive);
    }
  });

  it("applies only on the engine's own command, in a mode that takes it", () => {
    expect(effortApplies(defaultHarnesses, "claude", "batch")).toBe(true);
    expect(effortApplies(defaultHarnesses, "claude", "interactive")).toBe(true);
    expect(effortApplies(defaultHarnesses, "opencode", "batch")).toBe(true);
    expect(effortApplies(defaultHarnesses, "opencode", "interactive")).toBe(false);
    expect(effortApplies(defaultHarnesses, "cursor", "batch")).toBe(false);
    expect(effortApplies(defaultHarnesses, "cursor", "interactive")).toBe(false);
    // A pool-registered command owns what runs, so the Console cannot vouch
    // that it reads the effort: an override by name and a custom name alike.
    const custom: HarnessCommand = () => ["bash", "/tmp/pool/stub.sh"];
    expect(effortApplies({ ...defaultHarnesses, claude: custom }, "claude", "batch")).toBe(false);
    expect(effortApplies({ custom }, "custom", "batch")).toBe(false);
  });

  it("reads a terminal-backed pool as the TUI and any other as batch", () => {
    expect(poolHarnessMode("herdr")).toBe("interactive");
    expect(poolHarnessMode(undefined)).toBe("batch");
  });
});

describe("elidePromptArgv", () => {
  const body = "the whole prompt, many lines";

  it("replaces the body with the placeholder and leaves every other element alone", () => {
    expect(
      elidePromptArgv(
        ["claude", "-p", `/implement /p/01.md\n\n${body}`, "--model", "m"],
        body,
      ),
    ).toEqual(["claude", "-p", "/implement /p/01.md\n\n<prompt>", "--model", "m"]);
  });

  it("elides every element that carries the body and passes an argv with none through unchanged", () => {
    const argv = [body, "keep", `${body} suffix`];
    expect(elidePromptArgv(argv, body)).toEqual(["<prompt>", "keep", "<prompt> suffix"]);
    expect(elidePromptArgv(["a", "b"], body)).toEqual(["a", "b"]);
    expect(elidePromptArgv(["a"], "")).toEqual(["a"]);
  });
});

describe("engineEnvSet", () => {
  it("reports the keys the spawn env changes from the parent environment", () => {
    const parent = { ...process.env };
    const set = engineEnvSet({ ...parent, PWD: "/spawn/cwd" });
    expect(set).toEqual({ PWD: "/spawn/cwd" });
  });

  it("reports nothing when the spawn env equals the parent's", () => {
    expect(engineEnvSet({ ...process.env })).toEqual({});
  });
});
