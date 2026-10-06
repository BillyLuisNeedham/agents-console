/**
 * The files in the pool directory, seen from outside the server (ADR-0036):
 * what people and agents read byte for byte, JSONL equal once parsed.
 */

import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { anyIsoTime, expectJsonlEqual, expectSameBytes, expectSameFile } from "../harness/equal.ts";
import { readStateLine, until } from "../harness/pool-files.ts";

conformance("disk", "a done outcome rewrites the Ticket's state line to status=done", async (t) => {
  const world = t.world({
    tickets: [
      {
        file: "01-first.md",
        marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        body: "# First\n\nWrite the first thing.",
      },
    ],
    config: { defaults: { harness: "claude", model: "m" } },
  });
  const head = world.git(["rev-parse", "HEAD"]).trim();
  const ticket = join(world.pool, "issues", "01-first.md");
  // No script for 01: the stub writes a done outcome and exits 0.
  await t.start(world);

  const line = await until(
    () => readStateLine(world.pool, "01-first.md"),
    (marker) => marker.status === "done",
    { what: "01's marker to say done" },
  );

  // The stub ran once, as claude, and wrote the outcome the engine read.
  const calls = world.stubs.calls();
  expect(calls.map((call) => [call.key, call.harness])).toEqual([["01", "claude"]]);
  expect(JSON.parse(readFileSync(calls[0]!.outcome, "utf8"))).toEqual({
    status: "done",
    summary: "summary-01",
    commitSha: null,
  });

  expectSameBytes(line.line, "<!-- state: id=01 blocked-by=none status=done -->", "the state line");
  expectSameFile(ticket, "<!-- state: id=01 blocked-by=none status=done -->\n\n# First\n\nWrite the first thing.\n");
  expectJsonlEqual(readFileSync(join(world.pool, "runs", "01.events.jsonl")), [
    { at: anyIsoTime(), attempt: 1, kind: "scheduled", payload: {} },
    {
      at: anyIsoTime(),
      attempt: 1,
      kind: "spawned",
      payload: {
        argv: [
          "claude",
          "-p",
          `/implement ${ticket}\n\n<prompt>`,
          "--model",
          "m",
          "--permission-mode",
          "auto",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        cwd: world.repo,
        branch: null,
        commitSha: head,
        env: { PWD: world.repo },
        harness: "claude",
        model: "m",
        pid: expect.any(Number),
      },
    },
    {
      at: anyIsoTime(),
      attempt: 1,
      kind: "exited",
      payload: { code: 0, status: "done", logTail: [], outcomeExists: true },
    },
  ], "runs/01.events.jsonl");
});
