import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WorktreeInfo {
  path: string;
  branch: string;
}

interface GitProbe {
  ok: boolean;
  out: string;
  err: string;
}

export function git(repoRoot: string, args: string[]): GitProbe {
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", repoRoot, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: probe.exitCode === 0,
    out: probe.stdout.toString().trim(),
    err: probe.stderr.toString().trim(),
  };
}

function refExists(repoRoot: string, ref: string): boolean {
  return git(repoRoot, ["rev-parse", "--verify", ref]).ok;
}

// Worktree mode needs a real repo with at least one commit; without one the
// engine runs tickets in the main checkout, exactly as before.
export function gitAvailable(repoRoot: string): boolean {
  return refExists(repoRoot, "HEAD");
}

export function currentBranch(repoRoot: string): string {
  const probe = git(repoRoot, ["branch", "--show-current"]);
  return probe.out || "main";
}

/**
 * The commit SHA the checkout or worktree at `cwd` was at, resolved with git
 * at call time (ADR-0012: nothing captured this before). Works in the main
 * checkout and in any linked worktree of the same repo; null when git is
 * unavailable or the cwd is not a checkout with a HEAD, so a pool that does
 * not run in git records the fact as absent rather than as a wrong SHA.
 */
export function commitShaAt(cwd: string): string | null {
  const probe = git(cwd, ["rev-parse", "HEAD"]);
  return probe.ok && probe.out ? probe.out : null;
}

// Completes an in-progress merge in a worktree: the resolver leaves a staged
// resolution and a MERGE_HEAD in the worktree, and committing turns it into a
// merge commit on the ticket's branch, making the working branch an ancestor
// so the follow-up merge fast-forwards.
export function commitMerge(worktree: WorktreeInfo): GitProbe {
  return git(worktree.path, ["commit", "-qm", `merge ${worktree.branch} by resolver`]);
}

// The solo branch keeps the well-known name; a verify fan-out's attempt
// branches suffix the attempt number. Dotted rather than slashed, so an
// attempt branch never collides with a parked solo branch: git forbids
// refs where one is a prefix path of the other. The pool key namespaces
// everything by the pool's own directory, so two pools sharing one repo
// (distinct checkouts, one common git dir) never collide on a ticket id.
export function branchFor(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): string {
  return attempt === undefined
    ? `pool/${poolKeyFor(repoRoot)}/${ticketId}`
    : `pool/${poolKeyFor(repoRoot)}/${ticketId}.attempt-${attempt}`;
}

// Worktrees live inside the common git dir so they never appear in a
// checkout's status, where an in-place ticket could sweep one into a commit.
// The common dir is the main checkout's .git for every worktree of the repo ,
// a linked worktree's own .git is a file, not a directory, so anchoring there
// would break ticket worktree creation.
const commonDirCache = new Map<string, string>();

function gitCommonDir(repoRoot: string): string {
  const cached = commonDirCache.get(repoRoot);
  if (cached) return cached;
  const probe = git(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const dir = probe.ok && probe.out ? probe.out : join(repoRoot, ".git");
  commonDirCache.set(repoRoot, dir);
  return dir;
}

// Two pools can share one repo: two checkouts of it (a plain clone and a
// linked worktree, say) have distinct roots but one common git dir, so a
// bare ticket id would collide on worktree paths and pool/<id> refs across
// pools, proven live on 2026-09-05, when two engines of different pools
// shared one worktree concurrently. The key namespaces by the pool's own
// directory, the identity a pool has on disk: deterministic across restarts,
// distinct per pool, and independent of the pool's working branch, which a
// feature-branch merge target changes. Eight hex chars: opaque, but the
// birthday bound at pool counts a repo will ever see is beyond negligible.
const poolKeyCache = new Map<string, string>();

export function poolKeyFor(repoRoot: string): string {
  const cached = poolKeyCache.get(repoRoot);
  if (cached) return cached;
  const key = createHash("sha256")
    .update(realpathSync(repoRoot))
    .digest("hex")
    .slice(0, 8);
  poolKeyCache.set(repoRoot, key);
  return key;
}

export function worktreePathFor(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): string {
  return join(
    gitCommonDir(repoRoot),
    "pool-worktrees",
    poolKeyFor(repoRoot),
    attempt === undefined ? ticketId : `${ticketId}.attempt-${attempt}`,
  );
}

export function branchExists(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): boolean {
  return refExists(repoRoot, branchFor(repoRoot, ticketId, attempt));
}

// A parked branch or worktree (left by a checkpoint, a crash or a conflict)
// is reused, so the ticket keeps the work it already did; the base is never
// moved under it. Fresh tickets branch from HEAD. An attempt number names a
// verify fan-out's per-attempt branch and worktree; attempt numbers never
// repeat for a ticket, so an attempt worktree is always created fresh.
// The reuse rule only trusts a worktree on this pool's own branch: two
// pools sharing one repo share the worktree registry too, and the old
// bare-id paths let one pool silently adopt another's worktree, proven
// live on 2026-09-05. A registered worktree at this path on any other
// branch (or a detached HEAD) is foreign, and reusing it would graft one
// pool's parked work into another's run, so it is rejected loudly.
interface RegisteredWorktree {
  path: string;
  branch: string | null;
}

function registeredWorktrees(repoRoot: string): RegisteredWorktree[] {
  const trees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of git(repoRoot, ["worktree", "list", "--porcelain"]).out.split(
    "\n",
  )) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      trees.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return trees;
}

export function prepareWorktree(
  repoRoot: string,
  ticketId: string,
  attempt?: number,
): WorktreeInfo {
  const branch = branchFor(repoRoot, ticketId, attempt);
  const path = worktreePathFor(repoRoot, ticketId, attempt);
  git(repoRoot, ["worktree", "prune"]);
  const existing = registeredWorktrees(repoRoot).find((t) => t.path === path);
  if (existing) {
    if (existing.branch !== `refs/heads/${branch}`) {
      throw new Error(
        `worktree ${path} is checked out on ` +
          `${existing.branch ?? "a detached HEAD"}, not this pool's ` +
          `${branch}; refusing to adopt a foreign pool's worktree`,
      );
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    const add = branchExists(repoRoot, ticketId, attempt)
      ? git(repoRoot, ["worktree", "add", path, branch])
      : git(repoRoot, ["worktree", "add", path, "-b", branch, "HEAD"]);
    if (!add.ok) {
      throw new Error(
        `worktree add failed for ticket ${ticketId}: ${add.err || add.out}`,
      );
    }
  }
  return { path, branch };
}

// Only called once the branch has merged, so anything left uncommitted in
// the worktree is debris; --force discards it.
export function removeWorktree(repoRoot: string, info: WorktreeInfo): void {
  git(repoRoot, ["worktree", "remove", "--force", info.path]);
  git(repoRoot, ["branch", "-d", info.branch]);
}

export interface MergeResult {
  ok: boolean;
  // Why a failed merge failed. "conflict": git started the merge and hit
  // unmerged paths (named in `conflicted`); the engine aborted it and the
  // resolver can reproduce it. "blocked": git refused before starting,
  // typically because the checkout holds untracked files the merge would
  // overwrite (named in `blocked`); nothing conflicted, there is nothing
  // for a resolver to resolve, and only the operator can clear the way.
  reason?: "conflict" | "blocked";
  conflicted: string[];
  blocked: string[];
  // Untracked files in the checkout that were byte-identical to the
  // branch's version and were deleted so the merge could write them.
  cleared: string[];
  detail: string;
}

interface UntrackedInTheWay {
  blocked: string[];
  identical: string[];
}

// The checkout's top level: `git status` and `git diff --name-only` name
// paths relative to it whatever directory the pool runs in.
function toplevelOf(repoRoot: string): string {
  const probe = git(repoRoot, ["rev-parse", "--show-toplevel"]);
  return probe.ok && probe.out ? probe.out : repoRoot;
}

// Untracked files in the checkout that merging `branch` would write: the
// intersection of the checkout's untracked entries with the files the
// branch changes against the merge base. Git refuses such a merge outright
// (#92), even when the file's bytes already match, so each one is sorted
// into byte-identical (safe to delete) or differing (the operator's call).
// Ignored files are not listed: git overwrites those without asking.
function untrackedInTheWay(repoRoot: string, branch: string): UntrackedInTheWay {
  const none: UntrackedInTheWay = { blocked: [], identical: [] };
  const base = git(repoRoot, ["merge-base", "HEAD", branch]);
  if (!base.ok || !base.out) return none;
  const touched = new Set(
    git(repoRoot, ["diff", "--name-only", base.out, branch]).out
      .split("\n")
      .filter(Boolean),
  );
  if (touched.size === 0) return none;
  const untracked = git(repoRoot, ["status", "--porcelain=v1", "-z", "-uall"])
    .out.split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((path) => touched.has(path));
  const toplevel = toplevelOf(repoRoot);
  const result: UntrackedInTheWay = { blocked: [], identical: [] };
  for (const path of untracked) {
    // No blob on the branch means the branch deleted the file; the merge
    // then has nothing to write over the untracked copy.
    const theirs = git(repoRoot, ["rev-parse", "-q", "--verify", `${branch}:${path}`]);
    if (!theirs.ok) continue;
    const ours = git(repoRoot, ["hash-object", "--", join(toplevel, path)]);
    if (ours.ok && ours.out === theirs.out) result.identical.push(path);
    else result.blocked.push(path);
  }
  return result;
}

// The paths git names when it refuses a merge before starting: the
// tab-indented lines of "The following untracked working tree files would
// be overwritten by merge:" and "Your local changes to the following files
// would be overwritten by merge:".
function refusedPaths(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.trim())
    .filter(Boolean);
}

// Merges the ticket's branch onto whatever the pool's working branch
// currently is. A failure aborts the merge so the working branch is never
// left half-merged; the caller surfaces the conflict. A missing branch means
// a human finished the job by hand and cleaned up, which counts as merged.
//
// Before merging, untracked files in the checkout that the branch would
// overwrite are checked (#92): byte-identical copies are deleted so the
// merge can proceed, and a differing copy blocks the merge without
// starting it, reported as `reason: "blocked"` rather than as a conflict.
// A merge git refuses for any other reason before starting (no MERGE_HEAD,
// no unmerged paths) is classified the same way, with git's own message
// as the detail.
export function mergeBranch(repoRoot: string, branch: string): MergeResult {
  if (!refExists(repoRoot, branch)) {
    return {
      ok: true,
      conflicted: [],
      blocked: [],
      cleared: [],
      detail: `branch ${branch} is gone`,
    };
  }
  const way = untrackedInTheWay(repoRoot, branch);
  if (way.blocked.length > 0) {
    return {
      ok: false,
      reason: "blocked",
      conflicted: [],
      blocked: way.blocked,
      cleared: [],
      detail:
        "untracked files in the checkout would be overwritten by the merge " +
        `and differ from the branch's version: ${way.blocked.join(", ")}`,
    };
  }
  const toplevel = toplevelOf(repoRoot);
  for (const path of way.identical) {
    rmSync(join(toplevel, path), { force: true });
  }
  const cleared = way.identical;
  const clearedNote =
    cleared.length > 0
      ? ` (deleted untracked copies identical to the branch's: ${cleared.join(", ")})`
      : "";
  const merge = git(repoRoot, ["merge", "--no-edit", branch]);
  if (merge.ok) {
    return { ok: true, conflicted: [], blocked: [], cleared, detail: merge.out + clearedNote };
  }
  const conflicted = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"])
    .out.split("\n")
    .filter(Boolean);
  const inProgress = git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;
  if (inProgress) {
    git(repoRoot, ["merge", "--abort"]);
  }
  const detail = (merge.err || merge.out) + clearedNote;
  if (conflicted.length === 0 && !inProgress) {
    return {
      ok: false,
      reason: "blocked",
      conflicted: [],
      blocked: refusedPaths(merge.err),
      cleared,
      detail,
    };
  }
  return { ok: false, reason: "conflict", conflicted, blocked: [], cleared, detail };
}

// Where a blocked merge's files are and what the operator does about them:
// the shared explanation the engine's and the Conversation module's
// interrupts both carry, so the two never describe the refusal differently.
export function blockedMergeExplanation(repoRoot: string, result: MergeResult): string {
  const files = result.blocked.length > 0 ? result.blocked.join(", ") : "(none named)";
  return (
    "git refused to start the merge; nothing conflicted and the working " +
    "branch was not touched.\n" +
    `files in the way: ${files}\n` +
    `these files are untracked in the pool directory (${toplevelOf(repoRoot)}), ` +
    "or carry uncommitted changes there, and differ from the branch's " +
    "committed version. Move or delete them (commit them if tracked), then " +
    "resume; the merge is re-attempted on resume.\n"
  );
}

// The attempt branches a verify ticket currently has on disk: every
// pool/<id>.attempt-N ref, numbered. Selection keeps the winner's branch and
// discards the rest, so a superseded round's branches are cleaned up with
// the round that beat them.
export function attemptBranches(repoRoot: string, ticketId: string): number[] {
  const prefix = `refs/heads/pool/${poolKeyFor(repoRoot)}/${ticketId}.attempt-`;
  return git(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/heads/pool/${poolKeyFor(repoRoot)}/${ticketId}.attempt-*`,
  ])
    .out.split("\n")
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => Number(ref.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
}

// Discards a losing verify attempt's branch and worktree. The branch never
// merged, so unlike removeWorktree the deletion is forced: -d would refuse
// an unmerged branch. Anything uncommitted in the worktree is debris by the
// same reading that lets removeWorktree force it. Missing pieces (a pruned
// worktree, a branch a human already removed) probe as failures and are left
// alone.
export function discardWorktree(repoRoot: string, info: WorktreeInfo): void {
  git(repoRoot, ["worktree", "remove", "--force", info.path]);
  git(repoRoot, ["branch", "-D", info.branch]);
}
