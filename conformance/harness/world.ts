/**
 * One case's world on disk: a git repository with a pool inside it at
 * `.scratch/<name>`, the layout Boot gives a real pool, plus the fences a
 * server under test runs inside. Nothing here is shared between cases, so
 * every case starts from the same files whichever server it drives.
 *
 *   <root>/repo                   the checkout, one commit on main
 *   <root>/repo/.scratch/<name>   the pool: issues/, console.json, AGENT.md
 *   <root>/home                   HOME, so no operator file is read or written
 *   <root>/claude-config          CLAUDE_CONFIG_DIR, as engine/test-preload.ts fences it
 *   <root>/bin                    the stub harnesses, first on PATH (stubs.ts)
 *   <root>/stubs                  their scripts, and the record of each launch
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { makeTempDir } from "../fixtures/tmp.ts";
import { installStubs, type Stubs } from "./stubs.ts";

/** One Ticket file: a marker line and a body, or the exact content. */
export type TicketSeed =
  | { file: string; marker: string; body?: string }
  | { file: string; content: string };

export interface WorldSpec {
  /** The pool's directory under `.scratch/`. Default "pool". */
  poolName?: string;
  tickets?: TicketSeed[];
  /** console.json, written only when given. */
  config?: PoolConfig;
  /** AGENT.md, written only when given. */
  agentMd?: string;
  /** Further pool files by path relative to the pool, Conversations say. */
  poolFiles?: Record<string, string>;
  /** Further repository files, committed with the first commit. */
  repoFiles?: Record<string, string>;
  /**
   * False for a pool that does not run in git: the repository directory is
   * never made a checkout, so the server finds no git around the pool.
   * Default true.
   */
  git?: boolean;
}

export interface World {
  root: string;
  repo: string;
  pool: string;
  home: string;
  claudeConfig: string;
  stubs: Stubs;
  /** Run git in the repository and hand back its stdout; throws on failure. */
  git(args: string[]): string;
  /**
   * The environment a process the world runs gets (the server, the fake
   * herdr and so the panes it runs): built from nothing rather than
   * inherited, so the operator's TYPESAFE_API_KEY, HERDR_WORKSPACE_ID or
   * real harness binaries can never reach a case, and two servers under
   * test see the same variables.
   */
  env(herdrSocket: string): Record<string, string>;
}

/** The content a seed writes: the marker, a blank line, the body. */
export function ticketContent(seed: TicketSeed): string {
  return "content" in seed ? seed.content : `${seed.marker}\n\n${seed.body ?? "# body"}\n`;
}

/** The directories a server's tools live in, the stubs' first. Only these
 *  are on PATH, so a real `claude` beside git on the operator's PATH is out
 *  of reach. */
function toolPath(bin: string): string {
  const dirs = [bin, dirname(process.execPath)];
  for (const tool of ["git", "bash", "script"]) {
    const found = Bun.which(tool);
    if (found) dirs.push(dirname(found));
  }
  dirs.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return [...new Set(dirs)].join(":");
}

/** Make the repository a checkout with one commit on main. */
function initRepo(git: (args: string[]) => string): void {
  git(["init", "-q", "-b", "main"]);
  // In the repository's own config, so every git the server runs here, in
  // the checkout or a worktree of it, commits as the same author.
  git(["config", "user.email", "conformance@test"]);
  git(["config", "user.name", "conformance"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
}

export function makeWorld(spec: WorldSpec = {}): World {
  const root = makeTempDir("conformance-");
  const repo = join(root, "repo");
  const pool = join(repo, ".scratch", spec.poolName ?? "pool");
  const home = join(root, "home");
  const claudeConfig = join(root, "claude-config");
  for (const dir of [repo, join(pool, "issues"), home, claudeConfig]) {
    mkdirSync(dir, { recursive: true });
  }

  const git = (args: string[]): string => {
    const run = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: toolPath(join(root, "bin")), HOME: home },
    });
    if (run.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
    }
    return run.stdout.toString();
  };
  // The pool is not tracked, as .scratch/ is not in the real repository.
  writeFileSync(join(repo, ".gitignore"), ".scratch/\n");
  writeFileSync(join(repo, "README.md"), "# conformance\n");
  for (const [path, content] of Object.entries(spec.repoFiles ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  if (spec.git !== false) initRepo(git);

  for (const ticket of spec.tickets ?? []) {
    writeFileSync(join(pool, "issues", ticket.file), ticketContent(ticket));
  }
  if (spec.config) {
    writeFileSync(join(pool, "console.json"), JSON.stringify(spec.config, null, 2));
  }
  if (spec.agentMd !== undefined) writeFileSync(join(pool, "AGENT.md"), spec.agentMd);
  for (const [path, content] of Object.entries(spec.poolFiles ?? {})) {
    mkdirSync(dirname(join(pool, path)), { recursive: true });
    writeFileSync(join(pool, path), content);
  }

  const stubs = installStubs(root);
  const path = toolPath(stubs.bin);
  return {
    root,
    repo,
    pool,
    home,
    claudeConfig,
    stubs,
    git,
    env: (herdrSocket) => {
      const env: Record<string, string> = {
        PATH: path,
        HOME: home,
        CLAUDE_CONFIG_DIR: claudeConfig,
        HERDR_SOCKET_PATH: herdrSocket,
        CONFORMANCE_STUBS: stubs.dir,
        LANG: "C.UTF-8",
        TERM: "dumb",
      };
      for (const name of ["TMPDIR", "USER", "LOGNAME"]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      return env;
    },
  };
}
