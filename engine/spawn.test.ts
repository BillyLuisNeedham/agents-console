import { describe, expect, it } from "bun:test";
import {
  defaultHarnessDescriptors,
  defaultHarnesses,
  elidePromptArgv,
  engineEnvSet,
  harnessStreamMode,
  interactiveHarnessCommand,
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
    const agents = '{"deepseek":{"description":"General-purpose subagent"}}';
    expect(defaultHarnessDescriptors.claude.interactiveArgv(context({ agents }))).toEqual([
      "claude",
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
      "--agents",
      agents,
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
    // claude and opencode expand a leading /driver slash command in their
    // TUIs; cursor's interactive agent takes a plain message.
    expect(defaultHarnessDescriptors.claude.promptShaping.interactive(ctx)).toBe(
      "/implement /tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
    );
    expect(defaultHarnessDescriptors.opencode.promptShaping.interactive(ctx)).toBe(
      "/implement /tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
    );
    expect(defaultHarnessDescriptors.cursor.promptShaping.interactive(ctx)).toBe(
      "/tmp/pool/issues/01-a.md\n\n" +
        "Standing instructions for this job:\n\nDo the thing.",
    );
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
