/**
 * Headless launch behaviour no engine test drove before the port: the
 * inventory's `attempts` gaps (docs/research/rust-port/test-inventory.md,
 * "Visible behaviour no test covers yet") that sit in headless launch,
 * seen from outside the server (ADR-0036).
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { anyIsoTime, expectJsonlEqual } from "../harness/equal.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { batchPromptArg, ticketPrompt } from "../harness/prompts.ts";

// Gap: engine/attempt-run.ts recordSpawned. A terminal-backed launch that
// falls back to headless takes the batch argv, so the effort the TUI's argv
// would have dropped reaches opencode after all, and the spawned event's
// effort_applied says so even when the fallback came from the tab open.
conformance("attempts", "a headless fallback on opencode carries the effort the TUI would drop", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->", body: "# First\n\nDo it." }],
    config: { defaults: { harness: "opencode", model: "m", effort: "minimal" }, terminal: "herdr" },
  });
  const herdr = await t.herdr(world, { fail: ["tab.create"] });
  await t.start(world, { herdr });

  await until(() => readStateLine(world.pool, "01-first.md"), (line) => line.status === "done", {
    ms: 20_000,
    what: "01 to finish headless",
  });

  const issue = join(world.pool, "issues", "01-first.md");
  const body = ticketPrompt({ agentMd: null, runs: join(world.pool, "runs"), outcome: "01" });
  const calls = world.stubs.calls();
  expect(calls.map((call) => call.key)).toEqual(["01"]);
  expect(calls[0]!.argv).toEqual([
    "run",
    "--command",
    "implement",
    batchPromptArg("opencode", "implement", issue, body),
    "--model",
    "m",
    "--variant",
    "minimal",
    "--auto",
  ]);

  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    {
      at: anyIsoTime(),
      attempt: 1,
      kind: "spawned",
      payload: {
        argv: ["opencode", "run", "--command", "implement", `${issue}\n\n<prompt>`, "--model", "m", "--variant", "minimal", "--auto"],
        cwd: world.repo,
        branch: null,
        commitSha: world.git(["rev-parse", "HEAD"]).trim(),
        env: { PWD: world.repo },
        harness: "opencode",
        model: "m",
        effort: "minimal",
        pid: expect.any(Number),
        pane_id: null,
        tab_id: null,
        terminal_error: expect.stringContaining("tab.create failed"),
        effort_applied: true,
      },
    },
    { at: anyIsoTime(), attempt: 1, kind: "exited", payload: { code: 0, status: "done", logTail: [], outcomeExists: true } },
  ], "runs/01.events.jsonl");
});
