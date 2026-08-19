export interface SpawnContext {
  id: string;
  issuePath: string;
  issueRel: string;
  prompt: string;
  driver: string;
  harness: string;
  model: string;
  agents?: string;
  logPath: string;
  outcomePath: string;
  cwd: string;
}

export type HarnessCommand = (ctx: SpawnContext) => string[];

// One case per harness, matching run.sh's launch shapes: the prompt leads
// with the driver skill, stdin is closed at spawn time by the engine, and the
// harness runs with its fullest auto-approve mode. There is no spend cap.
export const defaultHarnesses: Record<string, HarnessCommand> = {
  claude: (ctx) => [
    "claude",
    "-p",
    ctx.prompt,
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
    `${ctx.issueRel}\n\n${afterFirstLine(ctx.prompt)}`,
    "--model",
    ctx.model,
    "--auto",
  ],
  // UNPROVEN: written from Cursor's CLI docs, not yet run on a real queue.
  cursor: (ctx) => [
    "agent",
    "-p",
    ctx.prompt,
    "--model",
    ctx.model,
    "--force",
    "--trust",
    "--output-format",
    "text",
  ],
};

function afterFirstLine(prompt: string): string {
  const newline = prompt.indexOf("\n");
  return newline === -1 ? "" : prompt.slice(newline + 1);
}
