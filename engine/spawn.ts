export interface SpawnContext {
  id: string;
  // The canonical Issue file: the absolute main-checkout path. The driver
  // line hands it to the agent for reading the spec and for ticking
  // acceptance criteria and appending notes; it is not a status channel.
  // The engine writes the final status to this file itself, from the
  // attempt's outcome JSON (ADR-0005).
  issuePath: string;
  body: string;
  driver: string;
  harness: string;
  model: string;
  agents?: string;
  logPath: string;
  outcomePath: string;
  // The attempt's exit-code file (ADR-0014): a terminal-backed attempt's pane
  // runs a wrapper shell that writes the harness's exit code here, because
  // herdr's API exposes none. Headless spawns ignore it. Named by
  // attemptExitCodeName with the same free variables as logPath.
  exitCodePath: string;
  cwd: string;
  // The attempt's Stream file (ADR-0012), the verbatim tee of the harness's
  // structured stream, or null when the harness has no stream mode (raw
  // passthrough: its stdout/stderr land in the log as bytes, exactly as
  // before). The spawn sites set it from the descriptor's streamMode; the
  // pump reads it as the mode signal.
  streamPath: string | null;
}

export type HarnessCommand = (ctx: SpawnContext) => string[];

// The log modes a harness adapter declares (ADR-0012): "stream" harnesses
// spawn with a structured stream mode and their attempt log is derived live
// from it in the spawn pump; "raw" harnesses keep the old passthrough where
// stdout/stderr bytes are the log. Keyed by harness name, not by spawn site,
// so a custom harness that is not a known streamer stays raw and an unknown
// name can never silently stream.
export type HarnessStreamMode = "stream" | "raw";

// The structured fields prompt shaping reads: the driver and the issue
// reference arrive as fields, never as a wall of text the shaping must parse
// back out. A subset of SpawnContext; the argv builders pass the whole
// context and it is structurally assignable.
export interface PromptShapingContext {
  driver: string;
  issuePath: string;
  body: string;
}

// One harness's prompt shaping for one mode: the prompt text the mode hands
// the agent, assembled from the structured fields. Batch shaping is the
// argv-embedded prompt of today; interactive shaping is how the TUI accepts
// the driver invocation (spec: steerable terminal-backed attempts).
export type PromptShaping = (ctx: PromptShapingContext) => string;

/**
 * The per-harness spawn descriptor (pool ticket 01): one record carrying
 * everything the two spawn paths need, so the interactive-TUI work lands as
 * fields here instead of as surgery inside the spawn paths. The batch argv is
 * what headless spawns run; the interactive argv, readiness pattern, and
 * interactive prompt shaping are what the terminal-backed path consumes
 * (ADR-0016).
 */
export interface HarnessDescriptor {
  // The argv a headless spawn runs: batch mode, stdin closed by the engine,
  // the prompt carried as argv (or --command), the fullest auto-approve mode.
  batchArgv: HarnessCommand;
  // The argv a terminal-backed spawn runs: the interactive TUI, the
  // batch-only flags dropped, auto-approve preserved.
  interactiveArgv: HarnessCommand;
  // The pane-rendered pattern that marks the TUI ready for typed input. One
  // canonical fixture per harness, validated against the real TUIs by the
  // prototype ticket (prototype/tui-prompt-paste/FINDINGS.md): claude's
  // header line, opencode's first-boot placeholder, cursor's header. The
  // bare prompt glyph is deliberately not used: the pane's own bash prompt
  // collides with it.
  readyPattern: string;
  // The pane-rendered pattern that marks the TUI idle, waiting on the
  // operator (the Conversations ADR's Turn state, engine/turn-state.ts):
  // present on 2 consecutive stable reads with unchanged text means
  // "waiting", per deriveTurnState. Defaults to readyPattern via
  // idlePatternFor below, which is only correct when readyPattern is itself
  // an idle-only signal (opencode's and cursor's placeholders, observed only
  // at the boot ready frame); a harness whose readyPattern is a persistent
  // header visible while working too (claude's "Claude Code v") must set its
  // own. See each harness's comment below for the evidence and its limits.
  idlePattern?: string;
  // The pane-rendered pattern that confirms a pasted prompt landed in the
  // input area. claude and cursor collapse a long paste to a
  // `[Pasted text #N +N lines]` marker, so the engine matches that; opencode
  // echoes the paste inline, so it has no marker and the engine falls back
  // to the prompt's issue reference.
  echoPattern?: string;
  // Keys that empty the TUI input area, sent before a retry or fallback
  // paste so a false-negative echo cannot concatenate. Empty until a
  // sequence is verified against the live TUI: opencode and cursor use
  // ctrl+c (prototype/tui-clear-input/FINDINGS.md); claude's slot stays
  // empty pending the operator's manual verification. Not sent before the
  // first paste: opencode's sequence exits on empty input.
  clearKeys: string[];
  // The prompt shaping per mode.
  promptShaping: {
    batch: PromptShaping;
    interactive: PromptShaping;
  };
  // The log mode (ADR-0012): "stream" harnesses tee a structured Stream file
  // and derive the log from it; "raw" harnesses pass stdout/stderr through.
  streamMode: HarnessStreamMode;
}

// The prompt text each mode hands the agent, per harness. claude expands a
// leading "/<driver> ..." as a slash command in both modes; opencode's batch
// mode carries the bare driver name in --command (so its batch shape is the
// message alone) while its TUI takes "/<driver> ..." like claude's; cursor's
// batch mode expands the slash line like claude's, and its interactive agent
// takes the same slash-line paste: the prototype pasted that exact form into
// cursor and the agent acted on it, and cursor executed "/implement <file>"
// as a typed command (prototype/tui-prompt-paste/FINDINGS.md sections 3-4).
// The interactive shapes are canonical fixtures, validated against the real
// TUIs by the prototype ticket.
const claudeShaping: HarnessDescriptor["promptShaping"] = {
  batch: ({ driver, issuePath, body }) => `/${driver} ${issuePath}\n\n${body}`,
  interactive: ({ driver, issuePath, body }) =>
    `/${driver} ${issuePath}\n\n${body}\n${issuePath}`,
};
const opencodeShaping: HarnessDescriptor["promptShaping"] = {
  batch: ({ issuePath, body }) => `${issuePath}\n\n${body}`,
  interactive: ({ driver, issuePath, body }) =>
    `/${driver} ${issuePath}\n\n${body}\n${issuePath}`,
};
const cursorShaping: HarnessDescriptor["promptShaping"] = {
  batch: ({ driver, issuePath, body }) => `/${driver} ${issuePath}\n\n${body}`,
  interactive: ({ driver, issuePath, body }) =>
    `/${driver} ${issuePath}\n\n${body}\n${issuePath}`,
};

// One case per harness, matching run.sh's launch shapes: the driver and issue
// reference arrive as structured fields and each descriptor builds its own
// invocation from them, so a prompt-format change cannot silently break one
// harness while the others keep working. stdin is closed at spawn time by the
// engine, and the harness runs with its fullest auto-approve mode. There is
// no spend cap.
export const defaultHarnessDescriptors: Record<string, HarnessDescriptor> = {
  // claude expands the /driver line at the top of the -p prompt as a slash
  // command, so the descriptor assembles that line from the structured fields.
  claude: {
    batchArgv: (ctx) => [
      "claude",
      "-p",
      claudeShaping.batch(ctx),
      "--model",
      ctx.model,
      "--permission-mode",
      "auto",
      // The roster JSON the glued prompt promises claude. opencode and cursor
      // get the roster as prose only, same as run.sh.
      ...(ctx.agents ? ["--agents", ctx.agents] : []),
      // The structured stream the pump tees to the attempt's Stream file and
      // derives the log from, live (ADR-0012). --verbose is required by the
      // real CLI for stream-json in print mode.
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    interactiveArgv: (ctx) => [
      "claude",
      "--model",
      ctx.model,
      "--permission-mode",
      "auto",
      ...(ctx.agents ? ["--agents", ctx.agents] : []),
    ],
    readyPattern: "Claude Code v",
    // claude's ready-frame header (prototype/tui-prompt-paste/FINDINGS.md
    // section 1) stays on screen while the agent works, so it cannot double
    // as an idle signal. The same findings record the ready frame's "empty
    // input prompt `❯`" and warn it is unsafe for *readiness* only because
    // the pane's own bash prompt is also `❯` before the TUI has come up; once
    // a Conversation is confirmed ready (this pane is the TUI, not a shell)
    // that collision cannot recur. A live capture of claude 2.1.267 (issue
    // #71) shows the glyph is not an idle-only marker either: the input box
    // keeps its `❯` while the agent works, and each operator turn is echoed
    // into the transcript with one. So for claude this pattern is a "the TUI
    // is up" guard, and idleness rests on deriveTurnState's transcript
    // stability (turn-state.ts): mid-turn the spinner row (`✢ Sautéing…`)
    // redraws every read, and once the turn ends the transcript holds
    // still.
    idlePattern: "❯",
    // claude collapses a long paste to `[Pasted text #N +N lines]` in the
    // input area before Enter (prototype finding); the engine matches that
    // marker to confirm the paste landed.
    echoPattern: "Pasted text",
    promptShaping: claudeShaping,
    streamMode: "stream",
    // Unverified on this machine (login expired). The operator confirms a
    // clear sequence on another machine before this slot is populated.
    clearKeys: [],
  },
  // opencode does not expand a slash command inside a run message, so the
  // driver goes through --command (bare name, no slash) and everything else
  // is the message, which becomes the command's arguments.
  opencode: {
    batchArgv: (ctx) => [
      "opencode",
      "run",
      "--command",
      ctx.driver,
      opencodeShaping.batch(ctx),
      "--model",
      ctx.model,
      "--auto",
    ],
    interactiveArgv: (ctx) => ["opencode", "--model", ctx.model, "--auto"],
    readyPattern: "Ask anything",
    // Unlike claude's, opencode's readyPattern is documented (same findings,
    // section 1) as "the first-boot placeholder" that "disappears once a
    // session has history" — it would never match again after the opening
    // Turn, wedging every later idle read as "working" forever. No ongoing
    // mid-session idle frame was captured by the prototype spike, so this
    // falls back to the ready frame's other static chrome, the footer's
    // `ctrl+p commands` hint; UNVERIFIED beyond the boot frame, same
    // provisional standing as claude's empty clearKeys below, pending an
    // operator confirming it against a live multi-turn opencode session.
    idlePattern: "ctrl+p commands",
    promptShaping: opencodeShaping,
    streamMode: "raw",
    clearKeys: ["ctrl+c"],
  },
  // Run against the real Cursor Agent CLI (2026.09.02-c22c1a3). --verbose was
  // dropped: that CLI has no such flag and rejects it with "unknown option
  // '--verbose'", unlike claude where the flag is required.
  cursor: {
    batchArgv: (ctx) => [
      "agent",
      "-p",
      cursorShaping.batch(ctx),
      "--model",
      ctx.model,
      "--force",
      "--trust",
      // The structured stream, same shape as claude's (ADR-0012).
      "--output-format",
      "stream-json",
    ],
    interactiveArgv: (ctx) => [
      "agent",
      "--model",
      ctx.model,
      "--force",
      "--trust",
    ],
    readyPattern: "Cursor Agent",
    // cursor's header, like claude's, is a persistent banner rather than an
    // idle-only frame (findings section 1 describes it alongside the
    // version line and footer, with no note that it disappears while
    // working). The same section records the ready frame's input
    // placeholder, `→ Plan, search, build anything`; used here without the
    // arrow glyph (not reliably captured through peekPane's text mode) as
    // the idle marker for an empty input box, on the same reasoning as
    // claude's bare `❯`. Captured only at the boot ready frame, not
    // confirmed present after later turns — flag alongside opencode's if it
    // proves wrong live.
    idlePattern: "Plan, search, build anything",
    // cursor collapses a long paste to `[Pasted text #N +N lines]` the same
    // way claude does (prototype finding).
    echoPattern: "Pasted text",
    promptShaping: cursorShaping,
    streamMode: "stream",
    clearKeys: ["ctrl+c"],
  },
};

// The batch-argv projection of the descriptors: what the spawn paths resolve
// a known harness to today (headless runs it directly; the terminal-backed
// path wraps it). Derived, never edited by hand, so the descriptor stays the
// single definition of a harness's batch argv. Custom harnesses registered by
// a pool are plain HarnessCommands and override these by name.
export const defaultHarnesses: Record<string, HarnessCommand> = Object.fromEntries(
  Object.entries(defaultHarnessDescriptors).map(([name, descriptor]) => [
    name,
    descriptor.batchArgv,
  ]),
);

// The log mode a harness declares (ADR-0012): read from the descriptor, so a
// custom harness that is not a known streamer stays raw and an unknown name
// can never silently stream.
export function harnessStreamMode(harness: string): HarnessStreamMode {
  return defaultHarnessDescriptors[harness]?.streamMode ?? "raw";
}

/**
 * The command a terminal-backed spawn hands its pane: the descriptor's
 * interactive argv when the registered command is the engine's own batch
 * command (no override, so the TUI replaces the batch flags), or the
 * registered command itself when it is not — a pool or test that overrides a
 * harness by name owns what runs, and its command runs as the pane command
 * under the script wrapper. `harnesses` is the same `{ ...defaultHarnesses,
 * ...poolHarnesses }` record the batch resolution reads, so the identity
 * check is "did the pool replace the engine's default" and nothing else.
 */
export function interactiveHarnessCommand(
  harnesses: Record<string, HarnessCommand>,
  harness: string,
): HarnessCommand {
  const descriptor = defaultHarnessDescriptors[harness];
  const command = harnesses[harness];
  if (descriptor && command === descriptor.batchArgv) {
    return descriptor.interactiveArgv;
  }
  return command;
}

/**
 * The batch command an attempt's assignment resolves to, or the pool config
 * error naming the ticket and the fix: a missing harness or model (an
 * unassigned ticket with no defaults, ADR-0013) or a harness name the table
 * does not carry. Fired at spawn time rather than at load so the
 * misconfiguration renders on the canvas first and the run dies naming the
 * ticket. Lives beside the harness table it reads so the Attempt-run module
 * and the engine's assignment paths share the one check.
 */
export function harnessCommandFor(
  harnesses: Record<string, HarnessCommand>,
  assignment: { harness?: string; model?: string },
  ticketId: string,
): HarnessCommand {
  if (!assignment.harness || !assignment.model) {
    throw new Error(
      `pool config: ticket ${ticketId} has no ` +
        `${assignment.harness ? "model" : "harness"} ` +
        `(set one in console.json assign or defaults)`,
    );
  }
  const command = harnesses[assignment.harness];
  if (!command) {
    throw new Error(
      `pool config: ticket ${ticketId} names unknown harness '${assignment.harness}'. ` +
        `Known: ${Object.keys(harnesses).sort().join(", ")}`,
    );
  }
  return command;
}

// The placeholder an argv element carries in a spawned event's facts where
// the prompt body sat (ADR-0012): the event records how the agent was
// invoked, and the prompt is the one wall of text it must not carry. The
// driver line and the issue reference around the body stay, so the event
// still names the command and the file the agent was sent to.
export const PROMPT_PLACEHOLDER = "<prompt>";

/**
 * The argv as the spawned event records it (ADR-0012): every element that
 * interpolates the prompt body carries the placeholder in its place. The
 * adapters build argv from the context's fields, so the body is a literal
 * substring of exactly the elements that hold it.
 */
export function elidePromptArgv(argv: string[], body: string): string[] {
  if (body === "") return argv;
  return argv.map((arg) =>
    arg.includes(body) ? arg.replace(body, PROMPT_PLACEHOLDER) : arg,
  );
}

/**
 * A descriptor's idle pattern (the Conversations ADR's Turn state,
 * engine/turn-state.ts): the descriptor's own when set, else its
 * readyPattern, matching HarnessDescriptor.idlePattern's documented default.
 * A custom harness with neither field set has no descriptor at all (spawn.ts
 * only defines them for the three defaults), so callers resolve through this
 * function rather than reading the field directly.
 */
export function idlePatternFor(descriptor: HarnessDescriptor): string {
  return descriptor.idlePattern ?? descriptor.readyPattern;
}

/**
 * The environment the engine hands a harness child: the parent environment
 * verbatim, with PWD forced to the spawn cwd. Bun passes env verbatim, so
 * the server's stale PWD (the checkout it was launched from) would otherwise
 * win, and opencode roots its project in PWD before cwd.
 */
export function spawnEnv(cwd: string): Record<string, string | undefined> {
  return { ...process.env, PWD: cwd };
}

/**
 * The keys the engine's spawn environment sets beyond the inherited parent's,
 * with their values. Today exactly PWD; derived from the actual delta rather
 * than hardcoded, so a future key cannot silently drop off the spawn event.
 */
export function engineEnvSet(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== process.env[key]) set[key] = value;
  }
  return set;
}
