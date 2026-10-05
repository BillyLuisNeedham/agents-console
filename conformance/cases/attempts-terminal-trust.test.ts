/**
 * Folder trust for the worktrees the server makes (issue #127, ADR-0025),
 * seen from outside it (ADR-0036): before a terminal-backed claude Attempt
 * opens its tab in a pool worktree, the server marks that directory trusted
 * in claude's own config, `.claude.json` under CLAUDE_CONFIG_DIR or else the
 * home directory, adding to the file and never rewriting what it cannot
 * read, and records what the seed did on the spawned event. Rows of the
 * `attempts` area the Rust port inventory gives ticket C12
 * (docs/research/rust-port/test-inventory.md).
 */

import { expect } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../protocol/wire.ts";
import { conformance, type Case } from "../harness/case.ts";
import { ticketWorktree } from "../harness/git-pool.ts";
import { spawnedPayloads, untilTicketStatus } from "../harness/herdr-tui.ts";
import type { World } from "../harness/world.ts";
import { READY, terminalConfig, ticket } from "./attempts-terminal-support.ts";

/** claude's own entry for a directory it has just seen, trusted: what a fresh seed writes. */
const FRESH = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

/** A claude config that holds more than the projects map. */
const OPERATOR_CONFIG = {
  numStartups: 3,
  theme: "dark",
  projects: { "/home/someone/elsewhere": { allowedTools: ["Bash"], hasTrustDialogAccepted: true } },
};

/** A terminal-backed claude pool with two ready Tickets, so each runs in a pool worktree. */
function twoWorktrees(t: Case, config: PoolConfig = terminalConfig()): World {
  return t.world({ tickets: [ticket("01", "First worktree"), ticket("02", "Second worktree")], config });
}

/** Where Ticket `id`'s worktree is, the path the seed keys its entry by. */
function worktree(world: World, id: string): string {
  return ticketWorktree(world.repo, id).path;
}

/** claude's config file under the world's CLAUDE_CONFIG_DIR. */
function claudeJson(world: World): string {
  return join(world.claudeConfig, ".claude.json");
}

function writeConfig(path: string, config: unknown): void {
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/** Run the world's pool until both Tickets are done. */
async function runBoth(t: Case, world: World, env: Record<string, string | null> = {}): Promise<void> {
  const herdr = await t.herdr(world, { rendered: READY.claude });
  await t.start(world, { herdr, env });
  await untilTicketStatus(world, "01", "done", 60_000);
  await untilTicketStatus(world, "02", "done", 60_000);
}

function folderTrust(world: World, id: string): unknown {
  return spawnedPayloads(world, id)[0]!.folder_trust;
}

/** A file written the way claude writes it: two-space indent, no trailing newline. */
function expectClaudeShaped(text: string): void {
  expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
}

// attempt-run.test.ts:1760 folder trust for the worktrees the engine makes (issue #127),
// and claude-trust.test.ts:60 seedClaudeFolderTrust (issue #127)
conformance("attempts", "each pool worktree gains claude's trusted entry before its tab opens, the rest of the file kept", async (t) => {
  const world = twoWorktrees(t);
  writeConfig(claudeJson(world), OPERATOR_CONFIG);
  await runBoth(t, world);

  const text = readFileSync(claudeJson(world), "utf8");
  expectClaudeShaped(text);
  expect(JSON.parse(text)).toEqual({
    ...OPERATOR_CONFIG,
    projects: { ...OPERATOR_CONFIG.projects, [worktree(world, "01")]: FRESH, [worktree(world, "02")]: FRESH },
  });
  // Written through a temporary file renamed over it, none left behind.
  expect(readdirSync(world.claudeConfig)).toEqual([".claude.json"]);
  expect(folderTrust(world, "01")).toBe("seeded");
  expect(folderTrust(world, "02")).toBe("seeded");
});

// claude-trust.test.ts:90 seedClaudeFolderTrust (issue #127)
conformance("attempts", "an entry claude holds as untrusted is flipped to trusted, its other fields kept", async (t) => {
  const world = twoWorktrees(t);
  const held = { allowedTools: ["Bash(git:*)"], hasTrustDialogAccepted: false, lastCost: 1.5 };
  writeConfig(claudeJson(world), { numStartups: 3, projects: { [worktree(world, "01")]: held } });
  await runBoth(t, world);

  const text = readFileSync(claudeJson(world), "utf8");
  expectClaudeShaped(text);
  expect(JSON.parse(text)).toEqual({
    numStartups: 3,
    projects: { [worktree(world, "01")]: { ...held, hasTrustDialogAccepted: true }, [worktree(world, "02")]: FRESH },
  });
  expect(folderTrust(world, "01")).toBe("seeded");
  expect(folderTrust(world, "02")).toBe("seeded");
});

// claude-trust.test.ts:109 seedClaudeFolderTrust (issue #127)
conformance("attempts", "a worktree claude already trusts leaves the file untouched, and the spawned event says so", async (t) => {
  const world = twoWorktrees(t);
  writeConfig(claudeJson(world), {
    numStartups: 3,
    projects: {
      [worktree(world, "01")]: { hasTrustDialogAccepted: true },
      [worktree(world, "02")]: { allowedTools: [], hasTrustDialogAccepted: true },
    },
  });
  // An old mtime, so any rewrite at all would show.
  const old = new Date("2020-01-02T03:04:05Z");
  utimesSync(claudeJson(world), old, old);
  const before = readFileSync(claudeJson(world));
  await runBoth(t, world);

  expect(readFileSync(claudeJson(world)).equals(before)).toBe(true);
  expect(statSync(claudeJson(world)).mtimeMs).toBe(old.getTime());
  expect(folderTrust(world, "01")).toBe("already");
  expect(folderTrust(world, "02")).toBe("already");
});

// claude-trust.test.ts:137 seedClaudeFolderTrust (issue #127)
conformance("attempts", "a claude config that is a symlink is written through, the link kept", async (t) => {
  const world = twoWorktrees(t);
  const target = join(world.root, "dotfiles", "claude.json");
  mkdirSync(join(world.root, "dotfiles"));
  writeConfig(target, { numStartups: 3 });
  symlinkSync(target, claudeJson(world));
  await runBoth(t, world);

  expect(lstatSync(claudeJson(world)).isSymbolicLink()).toBe(true);
  expect(readlinkSync(claudeJson(world))).toBe(target);
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
    numStartups: 3,
    projects: { [worktree(world, "01")]: FRESH, [worktree(world, "02")]: FRESH },
  });
  expect(readdirSync(join(world.root, "dotfiles"))).toEqual(["claude.json"]);
  expect(folderTrust(world, "01")).toBe("seeded");
});

// attempt-run.test.ts:1780 folder trust for the worktrees the engine makes (issue #127),
// and claude-trust.test.ts:150 seedClaudeFolderTrust (issue #127)
conformance("attempts", "where claude has never run no config is created, the skip is recorded, and the Attempts still run", async (t) => {
  const world = twoWorktrees(t);
  await runBoth(t, world);

  expect(readdirSync(world.claudeConfig)).toEqual([]);
  expect(folderTrust(world, "01")).toBe(`skipped: ${claudeJson(world)} does not exist`);
  expect(folderTrust(world, "02")).toBe(`skipped: ${claudeJson(world)} does not exist`);
});

// claude-trust.test.ts:159 seedClaudeFolderTrust (issue #127)
conformance("attempts", "a claude config that does not parse is left byte for byte, the skip naming why", async (t) => {
  const world = twoWorktrees(t);
  const torn = '{"numStartups": 3, "projects": {';
  writeFileSync(claudeJson(world), torn);
  await runBoth(t, world);

  expect(readFileSync(claudeJson(world), "utf8")).toBe(torn);
  // The parser's own words follow; they are the runtime's, not the server's.
  for (const id of ["01", "02"]) {
    expect(String(folderTrust(world, id)).startsWith(`skipped: ${claudeJson(world)} did not parse: `)).toBe(true);
  }
});

// claude-trust.test.ts:170 seedClaudeFolderTrust (issue #127)
conformance("attempts", "a claude config whose top level is not an object is left alone, the skip naming why", async (t) => {
  const world = twoWorktrees(t);
  writeFileSync(claudeJson(world), "[]");
  await runBoth(t, world);

  expect(readFileSync(claudeJson(world), "utf8")).toBe("[]");
  expect(folderTrust(world, "01")).toBe(`skipped: ${claudeJson(world)} is not a JSON object`);
  expect(folderTrust(world, "02")).toBe(`skipped: ${claudeJson(world)} is not a JSON object`);
});

// claude-trust.test.ts:182 defaultClaudeConfigPath
conformance("attempts", "the seed follows CLAUDE_CONFIG_DIR as claude does, and the home directory when it is blank or unset", async (t) => {
  const cases: { dir: string | null; inHome: boolean }[] = [
    { dir: "set", inHome: false },
    { dir: "", inHome: true },
    { dir: "  ", inHome: true },
    { dir: null, inHome: true },
  ];
  await Promise.all(
    cases.map(async ({ dir, inHome }) => {
      const world = twoWorktrees(t);
      const home = join(world.home, ".claude.json");
      writeConfig(claudeJson(world), { numStartups: 1 });
      writeConfig(home, { numStartups: 2 });
      await runBoth(t, world, dir === "set" ? {} : { CLAUDE_CONFIG_DIR: dir });

      const seeded = inHome ? home : claudeJson(world);
      const untouched = inHome ? claudeJson(world) : home;
      expect(JSON.parse(readFileSync(seeded, "utf8"))).toEqual({
        numStartups: inHome ? 2 : 1,
        projects: { [worktree(world, "01")]: FRESH, [worktree(world, "02")]: FRESH },
      });
      expect(readFileSync(untouched, "utf8")).toBe(JSON.stringify({ numStartups: inHome ? 1 : 2 }, null, 2));
      expect(folderTrust(world, "01")).toBe("seeded");
    }),
  );
}, { timeoutMs: 120_000 });

// attempt-run.test.ts:1799 folder trust for the worktrees the engine makes (issue #127)
conformance("attempts", "neither the operator's own checkout nor another harness's worktree is ever seeded", async (t) => {
  // 01 runs alone, in the checkout; 02 and 03 then run on opencode in worktrees.
  const world = t.world({
    tickets: [ticket("01", "In the checkout"), ticket("02", "Opencode one", "01"), ticket("03", "Opencode two", "01")],
    config: terminalConfig("claude", { assign: { "02": { harness: "opencode" }, "03": { harness: "opencode" } } }),
  });
  writeConfig(claudeJson(world), OPERATOR_CONFIG);
  const before = readFileSync(claudeJson(world));
  // One frame both harnesses' readiness patterns match.
  const herdr = await t.herdr(world, { rendered: `${READY.claude}\n${READY.opencode}` });
  await t.start(world, { herdr });
  for (const id of ["01", "02", "03"]) await untilTicketStatus(world, id, "done", 30_000);

  expect(readFileSync(claudeJson(world)).equals(before)).toBe(true);
  expect(spawnedPayloads(world, "01")[0]).toMatchObject({ cwd: world.repo, harness: "claude" });
  for (const id of ["02", "03"]) {
    expect(spawnedPayloads(world, id)[0]).toMatchObject({ cwd: worktree(world, id), harness: "opencode" });
  }
  for (const id of ["01", "02", "03"]) expect(Object.keys(spawnedPayloads(world, id)[0]!)).not.toContain("folder_trust");
});
