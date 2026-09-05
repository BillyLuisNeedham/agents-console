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
