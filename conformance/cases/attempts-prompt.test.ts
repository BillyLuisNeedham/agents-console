/**
 * The ticket prompt an Attempt launches with, seen from outside the server
 * (ADR-0036): the argv the stub harness received. Every prompt is compared
 * whole, byte for byte, against the pinned template (harness/prompts.ts,
 * test-inventory.md Decided 4), beside the facts each row of the inventory
 * names, so a reworded sentence fails here even where no fact check would.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectSameBytes } from "../harness/equal.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import { batchPromptArg, ticketPrompt, type TicketPromptParts } from "../harness/prompts.ts";
import type { StubCall } from "../harness/stubs.ts";
import type { World } from "../harness/world.ts";

const ready = (id: string, blockedBy = "none") => `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`;

/** The first launch recorded under `key`, waiting for it. */
async function launchOf(world: World, key: string, ms = 20_000): Promise<StubCall> {
  const calls = await until(
    () => world.stubs.calls(),
    (all) => all.some((call) => call.key === key),
    { ms, what: `a launch of ${key}` },
  );
  return calls.find((call) => call.key === key)!;
}

/** The argv element a claude launch carries its prompt in, `-p` first. */
function claudePromptArg(call: StubCall): string {
  expect(call.harness).toBe("claude");
  expect(call.argv[0]).toBe("-p");
  return call.argv[1]!;
}

/** The prompt body out of a claude launch, after checking the whole element byte for byte. */
function expectClaudePrompt(
  call: StubCall,
  issue: string,
  parts: TicketPromptParts,
  driver = "implement",
): string {
  const body = ticketPrompt(parts);
  expectSameBytes(claudePromptArg(call), batchPromptArg("claude", driver, issue, body), `${call.key}'s prompt`);
  return body;
}

// Covers engine.test.ts:4475 and prompt.test.ts:42, :48, :56, :60, :68,
// :78, :87, :93, :115, :122, :144, :152 on one launch of Ticket 01 (default
// drivers, default caps, no AGENT.md), and prompt.test.ts:26 on Ticket 02's.
conformance("attempts", "the ticket prompt teaches the Outcome, the Spawn protocol and the chain, byte for byte", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-first.md", marker: ready("01"), body: "# First\n\nDo the first thing." },
      { file: "02-second.md", marker: ready("02"), body: "# Second\n\nDo the second thing." },
    ],
    config: {
      defaults: { harness: "claude", model: "m" },
      assign: { "02": { drivers: "implement tdd code-review" } },
    },
  });
  const runs = join(world.pool, "runs");
  await t.start(world);
  const first = await launchOf(world, "01");
  const second = await launchOf(world, "02");

  // prompt.test.ts:42: drivers 'implement' alone, so no chain section.
  const body = expectClaudePrompt(first, join(world.pool, "issues", "01-first.md"), {
    agentMd: null,
    runs,
    outcome: "01",
  });
  expect(body).not.toContain("Skills for this Issue");

  // prompt.test.ts:48: the Outcome path and its full schema.
  expect(body).toContain(
    `record your outcome as JSON at ${runs}/01.outcome.json: {"status": "done" or "checkpoint", ` +
      '"summary": "what you did, in a sentence or two", "commitSha": "the sha of your commit, or null"}',
  );
  // prompt.test.ts:56: the brief on a checkpoint.
  expect(body).toContain('On a checkpoint, add "brief": "what the human has to do next".');
  // prompt.test.ts:60: the engine owns the status write.
  expect(body).toContain(
    "The engine reads this file at your exit and writes the final status to the Issue itself. " +
      "Never edit the Issue's line-1 status marker; the engine owns that write.",
  );
  // prompt.test.ts:68: the spawn array's shape and engine-assigned ids.
  expect(body).toContain('add an optional "spawn" array to that outcome JSON');
  expect(body).toContain('{"title": "...", "body": "...", "blockedBy": ["id", ...]}');
  expect(body).toContain("(<parent>-spawn-N: ticket 07's first proposal becomes 07-spawn-1)");
  // prompt.test.ts:78: assign takes exactly the four Assignment fields; verify is ignored.
  expect(body).toContain(
    '"assign": {"harness": "...", "model": "...", "effort": "...", "drivers": "..."}',
  );
  expect(body).toContain("when absent it inherits your own Assignment");
  expect(body).toContain('"assign" takes harness, model, effort and drivers only; a verify in it is ignored');
  // prompt.test.ts:87: the body floor the engine's validator enforces.
  expect(body).toContain("the body carrying at least 20 characters of intent");
  // prompt.test.ts:93: drop rules, the caps, and a drop never fails the attempt.
  expect(body).toContain("Thin or out-of-pool proposals are dropped with the reason recorded in the ticket log");
  expect(body).toContain("a dropped proposal never costs your attempt its result");
  expect(body).toContain("Caps apply: 5 proposals honored per attempt and 20 per run");
  // prompt.test.ts:115: blocks, by ids or all, never interrupting a running ticket.
  expect(body).toContain('"blocks": ["id", ...]');
  expect(body).toContain('"blocks": "all" to make every ticket that has not started yet wait for it');
  expect(body).toContain("a ticket already running is never interrupted");
  // prompt.test.ts:122: overflow is held for the operator, never truncated.
  expect(body).toContain("overflow held for the operator to adopt or discard");
  expect(body).not.toMatch(/truncat/i);
  // prompt.test.ts:144: the Spawn ledger and overlaps.
  expect(body).toContain(`read the Spawn ledger at ${runs}/spawn-ledger.md`);
  expect(body).toContain("Do not propose work it already lists.");
  expect(body).toContain('add "overlaps": ["id", ...] naming what it overlaps: it is then held for the operator');
  // prompt.test.ts:152: agents propose, the engine writes.
  expect(body).toContain("proposed, never written");
  expect(body).toContain("You never write pool state");
  expect(body).toContain("You propose; the engine writes.");

  // prompt.test.ts:26: the chain as skills in order, and nothing of how.
  const chained = expectClaudePrompt(second, join(world.pool, "issues", "02-second.md"), {
    agentMd: null,
    runs,
    outcome: "02",
    chain: ["tdd", "code-review"],
  });
  expect(chained).toContain("also use these skills, in this order: tdd, code-review.");
  expect(chained).not.toMatch(/subagent|dispatch|orchestrat|delegat/i);

  // engine.test.ts:4475: the per-ticket attempt log is written and readable.
  await until(() => readStateLine(world.pool, "01-first.md").status, (status) => status === "done", {
    what: "01 to be done",
  });
  expect(typeof (await Bun.file(join(runs, "01.log")).text())).toBe("string");
});

// prompt.test.ts:103
conformance("attempts", "the ticket prompt names the pool's own Spawn caps, singular for a cap of one", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-first.md", marker: ready("01") }],
    config: { defaults: { harness: "claude", model: "m" }, spawnCaps: { perAttempt: 1, perRun: 12 } },
  });
  await t.start(world);
  const body = expectClaudePrompt(await launchOf(world, "01"), join(world.pool, "issues", "01-first.md"), {
    agentMd: null,
    runs: join(world.pool, "runs"),
    outcome: "01",
    perAttempt: 1,
    perRun: 12,
  });
  expect(body).toContain("1 proposal honored per attempt and 12 per run");
});

// prompt.test.ts:129
conformance("attempts", "the ticket prompt says a cap of 0 holds every proposal for the operator", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-first.md", marker: ready("01") }],
    config: { defaults: { harness: "claude", model: "m" }, spawnCaps: { perAttempt: 0 } },
  });
  await t.start(world);
  const body = expectClaudePrompt(await launchOf(world, "01"), join(world.pool, "issues", "01-first.md"), {
    agentMd: null,
    runs: join(world.pool, "runs"),
    outcome: "01",
    perAttempt: 0,
    perRun: 20,
  });
  expect(body).toContain("this pool's are 0 per attempt and 20 per run");
  expect(body).toContain("every proposal you make is held for the operator to adopt or discard");
  expect(body).not.toContain("proposals honored per attempt");
});

// engine.test.ts:4400
conformance("attempts", "the ticket prompt glues AGENT.md and the chain without a driver line, for opencode", async (t) => {
  const agentMd = "# Runner agent instructions\n\nDo the thing.";
  const world = t.world({
    tickets: [{ file: "01-a.md", marker: ready("01") }],
    config: {
      defaults: { harness: "opencode", model: "opencode-test" },
      assign: { "01": { drivers: "implement code-review" } },
      // A roster left over from before ADR-0031 is read past.
      ...({ roster: "- deepseek: general-purpose subagent" } as Partial<PoolConfig>),
    },
    agentMd,
  });
  await t.start(world);
  const call = await launchOf(world, "01");
  const issue = join(world.pool, "issues", "01-a.md");
  const body = ticketPrompt({ agentMd, runs: join(world.pool, "runs"), outcome: "01", chain: ["code-review"] });

  expect(call.harness).toBe("opencode");
  expect(call.argv.slice(0, 3)).toEqual(["run", "--command", "implement"]);
  const message = call.argv[3]!;
  expectSameBytes(message, batchPromptArg("opencode", "implement", issue, body), "01's message");
  expect(message).toContain("Standing instructions for this job:");
  expect(message).toContain("Do the thing.");
  expect(message).toContain(
    "Skills for this Issue. When the driver skill's work is done, also use these skills, in this order: code-review.",
  );
  expect(message).toContain("outcome.json");
  expect(message).toContain('"status": "done" or "checkpoint"');
  expect(message).toContain("Never edit the Issue's line-1 status marker");
  expect(message).not.toContain("/implement");
  expect(message).not.toMatch(/subagent|dispatch|roster/i);
  expect(message).not.toContain("deepseek");
});

// engine.test.ts:4441
conformance("attempts", "the ticket prompt re-reads AGENT.md at every launch, so a mid-run edit reaches the next", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-a.md", marker: ready("01") },
      { file: "02-b.md", marker: ready("02", "01") },
    ],
    config: { defaults: { harness: "claude", model: "m" } },
    agentMd: "version one instructions",
  });
  const release = join(world.root, "release-01");
  world.stubs.script("01", { waitFor: release });
  const runs = join(world.pool, "runs");
  await t.start(world);

  // 01 is launched, its prompt built, before AGENT.md changes; 02's comes after.
  const first = await launchOf(world, "01");
  writeFileSync(join(world.pool, "AGENT.md"), "version two instructions");
  writeFileSync(release, "");
  const second = await launchOf(world, "02");

  const one = expectClaudePrompt(first, join(world.pool, "issues", "01-a.md"), {
    agentMd: "version one instructions",
    runs,
    outcome: "01",
  });
  const two = expectClaudePrompt(second, join(world.pool, "issues", "02-b.md"), {
    agentMd: "version two instructions",
    runs,
    outcome: "02",
    upstream: [{ id: "01", summary: "summary-01", commitSha: null }],
  });
  expect(one).toContain("version one instructions");
  expect(two).toContain("version two instructions");
  expect(two).not.toContain("version one instructions");
});

// prompt.test.ts:159
conformance("attempts", "a spawned Ticket's prompt is its parent's but for the Outcome path", async (t) => {
  const world = t.world({
    tickets: [{ file: "01-first.md", marker: ready("01") }],
    config: { defaults: { harness: "claude", model: "m" } },
    agentMd: "Do the thing.",
  });
  world.stubs.script("01", {
    spawn: [{ title: "Follow up", body: "Follow up on the first thing, which needs more work." }],
  });
  const runs = join(world.pool, "runs");
  await t.start(world);
  const parent = await launchOf(world, "01");
  const child = await launchOf(world, "01-spawn-1", 30_000);

  const parentBody = expectClaudePrompt(parent, join(world.pool, "issues", "01-first.md"), {
    agentMd: "Do the thing.",
    runs,
    outcome: "01",
  });
  const prefix = `/implement ${child.issue}\n\n`;
  const childArg = claudePromptArg(child);
  expect(child.issue).toStartWith(join(world.pool, "issues", "01-spawn-1"));
  expect(childArg.startsWith(prefix)).toBe(true);
  const childBody = childArg.slice(prefix.length);
  expect(childBody).toContain(`${runs}/01-spawn-1.outcome.json`);
  expectSameBytes(childBody, parentBody.replace("/01.outcome.json", "/01-spawn-1.outcome.json"), "01-spawn-1's prompt");
});
