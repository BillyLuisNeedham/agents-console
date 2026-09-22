import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultClaudeConfigPath, seedClaudeFolderTrust } from "./claude-trust.ts";
import { homedir } from "node:os";
import { makeTempDir } from "./tmp.ts";

// The folder-trust seed (issue #127, ADR-0025) against a scratch copy of
// claude's config: it adds the one entry claude reads to skip its workspace
// trust dialog, writes the file the way claude does, and leaves the file
// alone whenever a write could cost the operator more than the dialog.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): { dir: string; config: string; worktree: string } {
  const dir = makeTempDir("claude-trust-");
  dirs.push(dir);
  const worktree = join(dir, "pool-worktrees", "abcd1234", "01");
  mkdirSync(worktree, { recursive: true });
  return { dir, config: join(dir, "claude.json"), worktree };
}

// The shape of a real ~/.claude.json: many top-level keys, a projects map
// keyed by absolute path, and claude's own formatting (two-space indent, no
// trailing newline).
function realisticConfig(projects: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      numStartups: 795,
      installMethod: "native",
      projects: {
        "/home/op/repos/other": {
          allowedTools: [],
          hasTrustDialogAccepted: true,
          lastSessionId: "6f1c",
        },
        ...projects,
      },
      tipsHistory: { "shift-enter": 3 },
    },
    null,
    2,
  );
}

describe("seedClaudeFolderTrust (issue #127)", () => {
  it("adds a trusted entry for a directory claude has never seen, keeping everything else", () => {
    const { config, worktree } = scratch();
    writeFileSync(config, realisticConfig());

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed).toEqual({ outcome: "seeded", paths: [worktree] });
    const text = readFileSync(config, "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.projects[worktree]).toEqual({
      allowedTools: [],
      mcpContextUris: [],
      mcpServers: {},
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false,
    });
    // Everything the operator's claude wrote is still there.
    expect(parsed.numStartups).toBe(795);
    expect(parsed.projects["/home/op/repos/other"].lastSessionId).toBe("6f1c");
    expect(parsed.tipsHistory).toEqual({ "shift-enter": 3 });
    // Written the way claude writes it, so a diff shows only the entry, and
    // through a temp file that is gone once the rename lands.
    expect(text.startsWith('{\n  "')).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
    expect(readdirSync(join(config, "..")).filter((f) => f.includes(".tmp."))).toEqual([]);
  });

  it("flips an entry claude already holds as untrusted and keeps its other fields", () => {
    const { config, worktree } = scratch();
    writeFileSync(
      config,
      realisticConfig({
        [worktree]: { allowedTools: ["Bash"], hasTrustDialogAccepted: false, lastCost: 0.4 },
      }),
    );

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed.outcome).toBe("seeded");
    expect(JSON.parse(readFileSync(config, "utf8")).projects[worktree]).toEqual({
      allowedTools: ["Bash"],
      hasTrustDialogAccepted: true,
      lastCost: 0.4,
    });
  });

  it("does not touch the file when the directory is already trusted", () => {
    const { config, worktree } = scratch();
    const before = realisticConfig({ [worktree]: { hasTrustDialogAccepted: true } });
    writeFileSync(config, before);
    const mtime = statSync(config).mtimeMs;

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed).toEqual({ outcome: "already" });
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(statSync(config).mtimeMs).toBe(mtime);
  });

  it("seeds the realpath beside the path when the two differ", () => {
    const { dir, config, worktree } = scratch();
    writeFileSync(config, realisticConfig());
    const link = join(dir, "link");
    symlinkSync(join(dir, "pool-worktrees"), link);
    const viaLink = join(link, "abcd1234", "01");

    const seed = seedClaudeFolderTrust(viaLink, config);

    expect(seed).toEqual({ outcome: "seeded", paths: [viaLink, worktree] });
    const projects = JSON.parse(readFileSync(config, "utf8")).projects;
    expect(projects[viaLink].hasTrustDialogAccepted).toBe(true);
    expect(projects[worktree].hasTrustDialogAccepted).toBe(true);
  });

  it("writes through a symlinked config rather than replacing the link", () => {
    const { dir, config, worktree } = scratch();
    const target = join(dir, "real-claude.json");
    writeFileSync(target, realisticConfig());
    symlinkSync(target, config);

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed.outcome).toBe("seeded");
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).projects[worktree].hasTrustDialogAccepted).toBe(true);
  });

  it("skips a machine where claude has never run, creating nothing", () => {
    const { config, worktree } = scratch();

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed).toEqual({ outcome: "skipped", reason: `${config} does not exist` });
    expect(existsSync(config)).toBe(false);
  });

  it("skips a file it cannot parse rather than overwrite it", () => {
    const { config, worktree } = scratch();
    writeFileSync(config, '{"projects": {');

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed.outcome).toBe("skipped");
    if (seed.outcome === "skipped") expect(seed.reason).toContain("did not parse");
    expect(readFileSync(config, "utf8")).toBe('{"projects": {');
  });

  it("skips a file whose top level is not an object", () => {
    const { config, worktree } = scratch();
    writeFileSync(config, "[]");

    const seed = seedClaudeFolderTrust(worktree, config);

    expect(seed).toEqual({ outcome: "skipped", reason: `${config} is not a JSON object` });
    expect(readFileSync(config, "utf8")).toBe("[]");
  });
});

describe("defaultClaudeConfigPath", () => {
  it("follows CLAUDE_CONFIG_DIR the way claude does, and falls back to the home directory", () => {
    expect(defaultClaudeConfigPath({ CLAUDE_CONFIG_DIR: "/srv/claude" })).toBe("/srv/claude/.claude.json");
    expect(defaultClaudeConfigPath({ CLAUDE_CONFIG_DIR: "  " })).toBe(join(homedir(), ".claude.json"));
    expect(defaultClaudeConfigPath({})).toBe(join(homedir(), ".claude.json"));
  });

  it("is pointed at scratch for every test run by the preload", () => {
    expect(process.env.CLAUDE_CONFIG_DIR).toBeTruthy();
    expect(defaultClaudeConfigPath().startsWith(homedir())).toBe(false);
  });
});
