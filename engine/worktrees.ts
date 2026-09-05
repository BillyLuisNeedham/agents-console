import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
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
  conflicted: string[];
  detail: string;
}

// Merges the ticket's branch onto whatever the pool's working branch
// currently is. A failure aborts the merge so the working branch is never
// left half-merged; the caller surfaces the conflict. A missing branch means
// a human finished the job by hand and cleaned up, which counts as merged.
export function mergeBranch(repoRoot: string, branch: string): MergeResult {
  if (!refExists(repoRoot, branch)) {
    return { ok: true, conflicted: [], detail: `branch ${branch} is gone` };
  }
  const merge = git(repoRoot, ["merge", "--no-edit", branch]);
  if (merge.ok) return { ok: true, conflicted: [], detail: merge.out };
  const conflicted = git(repoRoot, ["diff", "--name-only", "--diff-filter=U"])
    .out.split("\n")
    .filter(Boolean);
  if (git(repoRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    git(repoRoot, ["merge", "--abort"]);
  }
  return { ok: false, conflicted, detail: merge.err || merge.out };
}

// True when the branch's work has landed in the merge target: either the
// branch is gone (the engine deletes it once its merge lands, and a missing
// branch means a human finished the job by hand, the same reading
// mergeBranch applies) or it is an ancestor of the target, whether the
// engine's merge or a manual one did it.
export function branchLandedInto(
  repoRoot: string,
  branch: string,
  target: string,
): boolean {
  if (!refExists(repoRoot, branch)) return true;
  return git(repoRoot, ["merge-base", "--is-ancestor", branch, target]).ok;
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
