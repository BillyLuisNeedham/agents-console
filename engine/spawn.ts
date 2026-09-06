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
  // before). The spawn sites set it from harnessStreamMode; the pump reads
  // it as the mode signal.
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

const STREAMED_HARNESSES = new Set(["claude", "cursor"]);

export function harnessStreamMode(harness: string): HarnessStreamMode {
  return STREAMED_HARNESSES.has(harness) ? "stream" : "raw";
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

// One case per harness, matching run.sh's launch shapes: the driver and issue
// reference arrive as structured fields and each adapter builds its own
// invocation from them, so a prompt-format change cannot silently break one
// harness while the others keep working. stdin is closed at spawn time by the
// engine, and the harness runs with its fullest auto-approve mode. There is no
// spend cap.
export const defaultHarnesses: Record<string, HarnessCommand> = {
  // claude expands the /driver line at the top of the -p prompt as a slash
  // command, so the adapter assembles that line from the structured fields.
  claude: (ctx) => [
    "claude",
    "-p",
    `/${ctx.driver} ${ctx.issuePath}\n\n${ctx.body}`,
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
  // opencode does not expand a slash command inside a run message, so the
  // driver goes through --command (bare name, no slash) and everything else
  // is the message, which becomes the command's arguments.
  opencode: (ctx) => [
    "opencode",
    "run",
    "--command",
    ctx.driver,
    `${ctx.issuePath}\n\n${ctx.body}`,
    "--model",
    ctx.model,
    "--auto",
  ],
  // UNPROVEN: written from Cursor's CLI docs, not yet run on a real queue.
  cursor: (ctx) => [
    "agent",
    "-p",
    `/${ctx.driver} ${ctx.issuePath}\n\n${ctx.body}`,
    "--model",
    ctx.model,
    "--force",
    "--trust",
    // The structured stream, same shape as claude's (ADR-0012).
    "--output-format",
    "stream-json",
    "--verbose",
  ],
};
