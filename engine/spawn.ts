export interface SpawnContext {
  id: string;
  // The canonical Issue file: the absolute main-checkout path. The driver
  // line hands it to the agent for both reading and status updates, and
  // read-back trusts the same file, so an attempt in a worktree updates the
  // file of record rather than its context-only seed copy.
  issuePath: string;
  body: string;
  driver: string;
  harness: string;
  model: string;
  agents?: string;
  logPath: string;
  outcomePath: string;
  cwd: string;
}

export type HarnessCommand = (ctx: SpawnContext) => string[];

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
    "--output-format",
    "text",
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
    "--output-format",
    "text",
  ],
};
