/**
 * A terminal-backed Attempt run to its end against the executing fake herdr
 * (ADR-0036): the server opens a tab, types its wrapper, waits for the stub
 * TUI's ready frame and types the prompt, and the stub harness, reading
 * that prompt from its pane as a real TUI would, writes the outcome it
 * names. The fuller terminal launch contract is the attempts cases'; this
 * one proves the stub can finish such an Attempt at all.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { readEvents, readStateLine, until } from "../harness/pool-files.ts";

/** What claude's TUI shows once it is up: its readiness pattern, and an empty input. */
const READY_FRAME = "Claude Code v2.1.0\n\n❯ ";

conformance("attempts", "a terminal-backed Attempt finishes done on the outcome its typed prompt names", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-first.md",
        marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        body: "# First\n\nWrite the first thing.",
      },
    ],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
  });
  const ticket = join(world.pool, "issues", "01-first.md");
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  // No script for 01: the stub writes a done outcome and exits 0.
  await t.start(world, { herdr });

  await until(
    () => readStateLine(world.pool, "01-first.md"),
    (marker) => marker.status === "done",
    { what: "01's marker to say done", ms: 30_000 },
  );

  // The prompt went in by typing, not in argv, and the stub keyed its
  // launch by the outcome file that prompt named.
  const typed = await herdr.control<string[]>("submitted");
  expect(typed).toHaveLength(1);
  expect(typed[0]!.startsWith(`/implement ${ticket}\n\n`)).toBe(true);
  const calls = world.stubs.calls();
  expect(calls.map((call) => [call.key, call.harness, call.argv])).toEqual([
    ["01", "claude", ["--model", "m", "--permission-mode", "auto"]],
  ]);
  expect(calls[0]!.issue).toBe(ticket);
  expect(typed[0]).toContain(`outcome as JSON at ${calls[0]!.outcome}:`);
  expect(JSON.parse(readFileSync(calls[0]!.outcome, "utf8"))).toEqual({
    status: "done",
    summary: "summary-01",
    commitSha: null,
  });

  // The Attempt ran in the pane the tab came back with, and ended on the
  // stub's own exit code with the outcome read.
  const events = readEvents(world.pool, "01");
  const spawned = events.find((event) => event.kind === "spawned");
  expect(spawned?.payload).toMatchObject({ harness: "claude", pane_id: expect.any(String) });
  expect(events.find((event) => event.kind === "exited")?.payload).toMatchObject({
    code: 0,
    status: "done",
    outcomeExists: true,
  });
  expect(herdr.calls.some((call) => call.method === "tab.create")).toBe(true);
});
