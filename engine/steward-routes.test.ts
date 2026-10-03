/// <reference types="bun" />

/**
 * The Steward's routes (ADR-0030) and the command that reaches them: the
 * seam between steward-cli.ts and the engine's Steward actions. The engine's
 * own cases (steward.test.ts) cover the rules; these cover that a Steward
 * Enlisted and started over HTTP is refused a second time, that the command
 * run against a live server reads, reassigns, leaves and ends, that a close
 * is refused while the pool keeps Close the operator's, that an adopt is
 * always refused (ADR-0035), and that a
 * refusal comes back as the 409 `reason` the command prints.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPoolServer, type PoolServer } from "./server.ts";
import type { HarnessCommand } from "./engine.ts";
import { readEvents } from "./events.ts";
import { startExecutingFakeHerdr, type ExecutingFakeHerdr } from "../conformance/fixtures/herdr-executing-fake.ts";
import { cleanupPools, makeGitPool, registerTempDir } from "../conformance/fixtures/pool-fixture.ts";
import { runStewardCli } from "./steward-cli.ts";
import { makeTempDir } from "../conformance/fixtures/tmp.ts";

const servers: PoolServer[] = [];
const fakes: ExecutingFakeHerdr[] = [];

afterEach(async () => {
  await cleanupPools(servers);
  for (const fake of fakes.splice(0)) await fake.close();
});

async function until(what: string, check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function post(server: PoolServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the Steward's routes and command", () => {
  it("enlists a Steward once, then reads, reassigns, leaves and ends through the command", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [
        { file: "01.md", marker: "<!-- state: id=01 blocked-by= status=ready -->", body: "# Talk\n\nbody" },
      ],
      config: { defaults: { harness: "tui", model: "m" }, terminal: "herdr" },
    });
    const desk = join(makeTempDir("steward-desk-"), "wt");
    registerTempDir(join(desk, ".."));
    git(["worktree", "add", "-q", "-b", "desk", desk]);
    const script = join(poolDir, "tui.sh");
    writeFileSync(
      script,
      '#!/usr/bin/env bash\nprintf \'%s\' "$2" > "$1"\nsleep 60\n',
    );
    const tui: HarnessCommand = (ctx) => [
      "bash",
      script,
      ctx.outcomePath,
      JSON.stringify({ status: "checkpoint", summary: "paused", commitSha: null, brief: "ask me" }),
    ];
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.seedAgent({
      paneId: "pane-desk",
      agent: "opencode",
      cwd: desk,
      status: "idle",
      rendered: "opencode\nctrl+p commands",
      tabId: "tab-desk",
    });
    const registry = join(poolDir, "fleet.json");
    const server = createPoolServer({
      poolDir,
      port: 0,
      harnesses: { tui },
      distDir: "/nonexistent",
      registryPath: registry,
      herdrSocket: fake.socketPath,
      enlistPollMs: 50,
      conversationPollMs: 50,
      paneSurveyMs: 50,
      enlistTeachingWaitMs: 3_000,
    });
    servers.push(server);
    await server.start();
    await until("the checkpoint", () =>
      (server.latest?.state.interrupts ?? []).some((i) => i.kind === "checkpoint"),
    );

    const enlisted = await post(server, "/api/enlist", { becomes: "steward", paneId: "pane-desk" });
    expect(enlisted.status).toBe(201);
    const { conversationId: id } = (await enlisted.json()) as { conversationId: string };
    // The teaching names this server's URL.
    await until("the teaching", () => fake.submitted.some((t) => t.includes(`--url ${server.url}`)));

    const second = await post(server, "/api/conversations", { role: "steward" });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { reason: string }).reason).toContain("a Steward is already on duty");

    const out: string[] = [];
    const err: string[] = [];
    const cli = (...args: string[]) =>
      runStewardCli(["--pool", poolDir, "--as", id, ...args], {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        stdin: () => "",
        registry,
      });

    expect(await cli("state")).toBe(0);
    expect(out.at(-1)).toContain(`Steward ${id}; budget 5 per Ticket`);
    expect(out.at(-1)).toContain('01 "Talk": checkpoint (pane alive, budget 5 of 5 left)');
    expect(out.at(-1)).toContain("Close off (the operator's)");

    // Issue #154: Close is the operator's while the pool has not let the
    // Steward Close; the command prints the engine's refusal.
    expect(await cli("close", "01", "superseded")).toBe(1);
    expect(err.at(-1)).toBe(
      "steward: Close is off for this pool; the operator turns on Steward may Close checkpoints in Settings",
    );

    // ADR-0035: Adopt is the operator's; the route refuses it with the reason.
    const adopt = await post(server, "/api/steward/answer", {
      conversation: id,
      ticketId: "01",
      action: "adopt",
      attempt: 2,
    });
    expect(adopt.status).toBe(400);
    expect(((await adopt.json()) as { reason: string }).reason).toBe(
      "adopting a candidate is the operator's: leave 01 with a note naming the one you recommend",
    );

    expect(
      await runStewardCli(["--pool", poolDir, "--as", "conv-9", "answer", "01", "resume"], {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        stdin: () => "",
        registry,
      }),
    ).toBe(1);
    expect(err.at(-1)).toBe(`steward: conv-9 is not the Steward on duty (${id} is)`);

    const malformed = await post(server, "/api/steward/answer", { conversation: id, ticketId: "01" });
    expect(malformed.status).toBe(400);

    expect(await cli("reassign", "01", "model=judge")).toBe(0);
    const config = JSON.parse(readFileSync(join(poolDir, "console.json"), "utf8"));
    expect(config.assign["01"]).toEqual({ model: "judge" });
    expect(
      readEvents(join(poolDir, "runs"), "01").find((e) => e.kind === "reassign-requested")?.payload,
    ).toEqual({ fields: { model: "judge" }, by: "steward", conversation: id });

    expect(await cli("leave", "01", "Recommend", "resume", "on", "judge.")).toBe(0);
    expect(out.at(-1)).toBe("left 01 to the operator with your note");
    await until("the note on the snapshot", () =>
      (server.latest?.state.interrupts ?? []).some((i) => i.stewardNote?.text === "Recommend resume on judge."),
    );
    expect(server.latest?.stewardBudget).toEqual({ budget: 5, used: {} });

    expect(await cli("end", "Done", "for", "tonight.")).toBe(0);
    await until("the Steward ended", () =>
      (server.latest?.state.conversations ?? []).some((c) => c.id === id && c.status === "ended"),
    );
    expect(readEvents(join(poolDir, "runs"), id).find((e) => e.kind === "ended")?.payload).toMatchObject({
      closing: "Done for tonight.",
      by: "steward",
    });
  }, 40_000);
});
