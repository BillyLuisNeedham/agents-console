/**
 * Boot's first job (issue #121): work out which Pool directory this run is
 * for, without asking when the answer is already on disk. The operator runs
 * `agent-console` from a project checkout, so the script has to go from a
 * working directory to a pool the way a person would: is this a pool, is
 * there one under the project's `.scratch/`, are there several, or is this
 * the first one and it has to be created.
 *
 * Everything here is pure apart from the two functions that touch the
 * filesystem at the end. The git lookups arrive as an injected probe so the
 * decision can be tested against a table of directories rather than a real
 * repository.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The three markers that make a directory a Pool. `console.json` is the
 * configured pool; a ticket file under `issues/` is a ticket pool written by
 * `to-tickets`; a `conversations/` directory is a Seeded Pool's opt-in
 * (ADR-0024) and counts even when it is empty.
 */
export function isPoolDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, "console.json"))) return true;
  if (existsSync(join(dir, "conversations"))) return true;
  return countTickets(dir) > 0;
}

/** Ticket files in the pool's `issues/` directory, which is a legacy name. */
export function countTickets(dir: string): number {
  const issues = join(dir, "issues");
  if (!existsSync(issues)) return 0;
  try {
    return readdirSync(issues).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

/** A name a directory can carry: lowercase, hyphens, nothing else. A
 * branch's slashes become hyphens too, so `feature/try-boot` reads as
 * `feature-try-boot` rather than running its words together. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** What the repository probe has to answer for the decision below. */
export interface RepoProbe {
  /** The git toplevel containing `cwd`, or null when there is no checkout. */
  toplevel(cwd: string): string | null;
  /** The checked-out branch, or null when the head is detached. */
  branch(cwd: string): string | null;
}

export type PoolResolution =
  | { kind: "found"; dir: string; why: string }
  | { kind: "several"; candidates: string[]; scratch: string }
  | { kind: "create"; scratch: string; suggested: string; why: string }
  | { kind: "no-repo"; cwd: string };

export interface ResolveInput {
  /** The positional argument or `--pool`, when one was given. */
  explicit?: string | undefined;
  cwd: string;
  repo: RepoProbe;
}

/**
 * Which Pool this Boot is for. An explicit directory is taken as given, even
 * when nothing is there yet, because naming a directory is the operator
 * saying where the pool belongs. Otherwise the working directory decides:
 * a pool is used in place, and a checkout looks under its own `.scratch/`.
 */
export function resolvePool(input: ResolveInput): PoolResolution {
  if (input.explicit) {
    return {
      kind: "found",
      dir: input.explicit,
      why: "named on the command line",
    };
  }
  if (isPoolDir(input.cwd)) {
    return {
      kind: "found",
      dir: input.cwd,
      why: "the working directory is a pool",
    };
  }
  const top = input.repo.toplevel(input.cwd);
  // A pool lives beside a checkout because its Attempts branch from one.
  // Without a checkout there is nothing for the pool to be about, so this is
  // the one resolution that has no answer rather than a question.
  if (!top) return { kind: "no-repo", cwd: input.cwd };
  const scratch = join(top, ".scratch");
  const candidates = scratchPools(scratch);
  if (candidates.length === 1) {
    return {
      kind: "found",
      dir: candidates[0] as string,
      why: `the only pool under ${scratch}`,
    };
  }
  if (candidates.length > 1) return { kind: "several", candidates, scratch };
  const branch = input.repo.branch(top);
  return {
    kind: "create",
    scratch,
    suggested: branch ? slugify(branch) || "pool" : "pool",
    why: `no pool under ${scratch}`,
  };
}

/** The pool directories directly under a project's `.scratch/`, sorted. */
export function scratchPools(scratch: string): string[] {
  if (!existsSync(scratch)) return [];
  let names: string[];
  try {
    names = readdirSync(scratch);
  } catch {
    return [];
  }
  return names
    .map((name) => join(scratch, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && isPoolDir(dir);
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Create the pool directory and keep `.scratch/` out of the project's
 * history. The exclude goes in `.git/info/exclude` rather than `.gitignore`:
 * pools are this machine's working material, and a line in the tracked
 * ignore file would be a change to the project every operator has to carry.
 */
export function createPool(
  scratch: string,
  slug: string,
  gitDir: string,
): { dir: string; excluded: "added" | "present" | "unavailable" } {
  const dir = join(scratch, slug);
  mkdirSync(dir, { recursive: true });
  return { dir, excluded: ensureScratchExcluded(gitDir) };
}

/** Append `.scratch/` to the checkout's private exclude file when missing. */
export function ensureScratchExcluded(
  gitDir: string,
): "added" | "present" | "unavailable" {
  const info = join(gitDir, "info");
  const file = join(info, "exclude");
  try {
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").map((line) => line.trim());
      if (lines.includes(".scratch/") || lines.includes(".scratch")) return "present";
    } else {
      mkdirSync(info, { recursive: true });
    }
    const needsNewline = existsSync(file) && !readFileSync(file, "utf8").endsWith("\n");
    appendFileSync(file, `${needsNewline ? "\n" : ""}.scratch/\n`);
    return "added";
  } catch {
    // A worktree or a submodule can put the git directory somewhere this
    // script cannot write. The pool still works; only the exclude is missed.
    return "unavailable";
  }
}

/** The git probe Boot runs for real, shelling out the way the skill did. */
export function realRepoProbe(): RepoProbe {
  return {
    toplevel: (cwd) => gitLine(cwd, ["rev-parse", "--show-toplevel"]),
    branch: (cwd) => gitLine(cwd, ["branch", "--show-current"]),
  };
}

/** The `.git` directory for a checkout, which is a file in a worktree. */
export function gitDirOf(top: string): string {
  const line = gitLine(top, ["rev-parse", "--absolute-git-dir"]);
  return line ?? join(top, ".git");
}

export function gitLine(cwd: string, args: string[]): string | null {
  if (!existsSync(cwd)) return null;
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return null;
  const out = probe.stdout.toString().trim();
  return out === "" ? null : out;
}

/**
 * The nearest existing ancestor of a path, itself included. A pool named on
 * the command line may not exist yet, and the git questions asked about it
 * (which checkout is this, what does it commit) have to be asked somewhere
 * that does.
 */
export function nearestExisting(dir: string): string {
  let current = dir;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** A pool's display name, which is its directory name. */
export function poolName(dir: string): string {
  return basename(dir);
}
