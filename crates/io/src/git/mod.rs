//! The git edge (ADR-0036, M2): every git command the Console runs, ported from engine/worktrees.ts and
//! from the git calls the other TypeScript modules make, with identical argv, the same environment
//! (inherited whole: the TypeScript sets no `GIT_*` variable and passes no `-c` option) and identical
//! error texts. Runs are synchronous, blocking the caller exactly as `Bun.spawnSync` blocked the engine's
//! one thread, except [`git_async`] and [`activity_diff`], the reads the TypeScript awaits.
//!
//! Where each TypeScript git call is served (line numbers are the TypeScript engine's before the flip).
//!
//! worktrees.ts itself:
//!
//! | TypeScript | git | Rust |
//! | --- | --- | --- |
//! | worktrees.ts:17 `git` | `git -C <dir> <args>` (spawnSync) | [`git`] |
//! | worktrees.ts:35 `gitAsync` | the same, awaited | [`git_async`] |
//! | worktrees.ts:49 `refExists` | `rev-parse --verify <ref>` | [`ref_exists`] |
//! | worktrees.ts:55 `gitAvailable` | `rev-parse --verify HEAD` | [`git_available`] |
//! | worktrees.ts:59 `currentBranch` | `branch --show-current` | [`current_branch`] |
//! | worktrees.ts:71 `commitShaAt` | `rev-parse HEAD` | [`commit_sha_at`] |
//! | worktrees.ts:80 `commitMerge` | `commit -qm "merge <branch> by resolver"` | [`commit_merge`] |
//! | worktrees.ts:90 `branchFor` | none | [`branch_for`] |
//! | worktrees.ts:107 `gitCommonDir` | `rev-parse --path-format=absolute --git-common-dir` | [`git_common_dir`] |
//! | worktrees.ts:124 `gitDirOf` | `rev-parse --absolute-git-dir` | `worktrees::git_dir_of` (private) |
//! | worktrees.ts:144 `refStamp` | none (reads HEAD, stats ref files) | [`ref_stamp`] |
//! | worktrees.ts:187 `poolKeyFor` | none | [`pool_key_for`] |
//! | worktrees.ts:198 `worktreePathFor` | none | [`worktree_path_for`] |
//! | worktrees.ts:218 `isPoolWorktree` | none | [`is_pool_worktree`] |
//! | worktrees.ts:222 `branchExists` | `rev-parse --verify pool/<key>/<id>[.attempt-N]` | [`branch_exists`] |
//! | worktrees.ts:240 `checkoutNewBranch` | `checkout <branch>` or `checkout -b <branch>` | [`checkout_new_branch`] |
//! | worktrees.ts:263 `registeredWorktrees` | `worktree list --porcelain` | `worktrees::registered_worktrees` (private) |
//! | worktrees.ts:284 `prepareWorktree` | `worktree prune`, then `worktree add <path> <branch>` or `worktree add <path> -b <branch> <base>` | [`prepare_worktree`] |
//! | worktrees.ts:323 `mergeCheckoutPathFor` | none | [`merge_checkout_path_for`] |
//! | worktrees.ts:334 `removeStaleMergeCheckout` | `worktree prune`, `worktree remove --force <path>` | [`remove_stale_merge_checkout`] |
//! | worktrees.ts:343 `openMergeCheckout` | `worktree add <path> <branch>` | [`open_merge_checkout`] |
//! | worktrees.ts:358 `closeMergeCheckout` | `worktree remove --force <path>` | [`close_merge_checkout`] |
//! | worktrees.ts:365 `branchCheckedOutAt` | `worktree prune`, `worktree list --porcelain` | [`branch_checked_out_at`] |
//! | worktrees.ts:375 `removeWorktree` | `worktree remove --force <path>`, `branch -d <branch>` | [`remove_worktree`] |
//! | worktrees.ts:404 `toplevelOf` | `rev-parse --show-toplevel` | `merge::toplevel_of` (private) over [`show_toplevel`] |
//! | worktrees.ts:415 `untrackedInTheWay` | `merge-base HEAD <branch>`, `diff --name-only <base> <branch>`, `status --porcelain=v1 -z -uall`, `rev-parse -q --verify <branch>:<path>`, `hash-object -- <file>` | `merge::untracked_in_the_way` (private) |
//! | worktrees.ts:448 `refusedPaths` | none (reads git's refusal) | `merge::refused_paths` (private) |
//! | worktrees.ts:468 `mergeBranch` | `merge --no-edit <branch>`, `diff --name-only --diff-filter=U`, `rev-parse -q --verify MERGE_HEAD`, `merge --abort` | [`merge_branch`] |
//! | worktrees.ts:528 `blockedMergeExplanation` | `rev-parse --show-toplevel` | [`blocked_merge_explanation`] |
//! | worktrees.ts:545 `attemptBranches` | `for-each-ref --format=%(refname) refs/heads/pool/<key>/<id>.attempt-*` | [`attempt_branches`] |
//! | worktrees.ts:564 `discardWorktree` | `worktree remove --force <path>`, `branch -D <branch>` | [`discard_worktree`] |
//!
//! Git run directly by the other modules:
//!
//! | TypeScript | git | Rust |
//! | --- | --- | --- |
//! | boot-pool.ts:185 `toplevel` probe | `rev-parse --show-toplevel` through `gitLine` | [`git_line`] |
//! | boot-pool.ts:186 `branch` probe | `branch --show-current` through `gitLine` | [`git_line`] |
//! | boot-pool.ts:191 `gitDirOf` | `rev-parse --absolute-git-dir` through `gitLine` | [`absolute_git_dir`] |
//! | boot-pool.ts:196 `gitLine` | `git -C <dir> <args>`, stderr ignored | [`git_line`] |
//! | boot-cli.ts:309, 601, 602 | `rev-parse --show-toplevel` through `gitLine` | [`git_line`] |
//! | boot-detect.ts:137 `recentSubjects` | `log -20 --format=%s`, stderr ignored | [`recent_subjects`] |
//! | boot-launch.ts:43 `uiSourceCommitMs` | `log -1 --format=%ct -- ui/src`, stderr ignored | [`ui_source_commit_ms`] |
//! | enlist.ts:197 `branchAt` | `branch --show-current` | [`branch_at`] |
//! | notices.ts:54 `diffStatSummary` | `diff --stat <range>` | [`diff_stat_summary`] |
//! | merge-hold.ts:78 `gitMergeHoldProbe` branchExists | `rev-parse --verify <branch>` | [`ref_exists`] |
//! | merge-hold.ts:80 `gitMergeHoldProbe` isAncestor | `merge-base --is-ancestor <branch> <target>` | [`is_ancestor`] |
//! | server.ts:763 `computeActivityDiff` | `diff --numstat HEAD`, `status --porcelain` (awaited) | [`activity_diff`] |
//! | conversations.ts:1972 in `end` | `rev-list --count <target>..<branch>` | [`has_commits_beyond`] |
//! | conversations.ts:2121 `rejectMerge` | `merge --abort` in the worktree | [`merge_abort`] |
//! | engine.ts:3839 `recordAdoptedExit` | `rev-parse --verify refs/heads/<branch>` | [`ref_exists`] |
//! | engine.ts:4530 `inPoolCheckout` | `rev-parse --show-toplevel` | [`show_toplevel`] |
//! | engine.ts:5849 `keepTicketFileNotes` | `show <branch>:<rel>` (spawnSync, raw stdout) | [`show_file`] |
//! | engine.ts:5900 `mergeTargetSha` | `rev-parse <ref>` (stdout even on failure) | [`rev_parse`] |
//! | engine.ts:5913 `withMergeCheckout` | `openMergeCheckout`, `closeMergeCheckout` around the merge | [`with_merge_checkout`] |
//! | engine.ts:6005 `mergeInPlace` | `mergeBranch` with the Ticket file stepped aside | [`merge_in_place`] |
//! | engine.ts:6026 `mergeInCheckout` | `mergeBranch` in the merge checkout | [`merge_in_checkout`] |
//! | engine.ts:6066, 6068 `ticketSeedFor` | `merge-base <target> <branch>`, then `show <base>:<rel>` (spawnSync, raw stdout) | [`merge_base`], [`show_file`] |
//! | engine.ts:6109 `reconcileTicketFile` | `merge-file -p -L <pool> -L seed -L <branch> <ours> <base> <theirs>` (spawnSync, no `-C`, exit code and raw stdout) | [`merge_file`] |
//! | engine.ts:6347 `routeMergeConflict` | `merge --abort` in the worktree | [`merge_abort`] |
//! | engine.ts:6534 `rejectMerge` | `merge --abort` in the worktree | [`merge_abort`] |
//! | engine.ts:7228, 7232 `attemptDiff` | `merge-base HEAD <branch>`, `diff <base>..<branch>` | [`branch_diff`] |
//! | engine.ts:7253, 7258 `attemptDiffParts` | the same, with `-U0` on the base budget | [`branch_diff`] |
//! | engine.ts:10279, 10280 `applyEnlistBranchRule` | `rev-parse --show-toplevel` in the pane's directory and the pool's (stdout even on failure) | [`show_toplevel`] |
//! | engine.ts:10692, 10693 `removeEnlistedBranch` | `checkout <found>`, `branch -D <pool branch>` | [`restore_found_branch`] |
//! | engine.ts:11969 `repoRootOf` | `rev-parse --show-toplevel` in the pool dir, stderr ignored | [`repo_root_of`] |
//!
//! The worktrees.ts exports, where the other modules call them:
//!
//! | TypeScript | Called at | Rust |
//! | --- | --- | --- |
//! | `attemptBranches` | engine.ts:5777, 8559 | [`attempt_branches`] |
//! | `blockedMergeExplanation` | conversations.ts:2034; engine.ts:8112, 11694 | [`blocked_merge_explanation`] |
//! | `branchCheckedOutAt` | engine.ts:1923 | [`branch_checked_out_at`] |
//! | `branchExists` | engine.ts:1922, 5781, 7225, 7250, 9521 | [`branch_exists`] |
//! | `branchFor` | conversations.ts:769, 1128, 2356; engine.ts:792, 1923, 1929, 2151, 2156, 3961, 4021, 7224, 7249, 7931, 8037, 8108, 8488, 8512, 8563, 10255; merge-hold.ts:77 | [`branch_for`] |
//! | `checkoutNewBranch` | engine.ts:10262 | [`checkout_new_branch`] |
//! | `closeMergeCheckout` | engine.ts:5924 | [`close_merge_checkout`] |
//! | `commitMerge` | conversations.ts:2097; engine.ts:6475 | [`commit_merge`] |
//! | `commitShaAt` | attempt-run.ts:988; engine.ts:4743, 10378, 10518 | [`commit_sha_at`] |
//! | `currentBranch` | engine.ts:5893, 5916; merge-hold.ts:76 | [`current_branch`] |
//! | `discardWorktree` | conversations.ts:1542; engine.ts:5787, 8561 | [`discard_worktree`] |
//! | `git` | the direct runs above | [`git`] |
//! | `gitAsync` | server.ts:765, 766 | [`git_async`] |
//! | `gitAvailable` | engine.ts:1213 | [`git_available`] |
//! | `gitCommonDir` | enlist.ts:135, 192, 236 | [`git_common_dir`] |
//! | `isPoolWorktree` | attempt-run.ts:607 | [`is_pool_worktree`] |
//! | `mergeBranch` | engine.ts:1133 (a Conversation's merge, inside `withMergeCheckout`), 6012, 6034 | [`merge_branch`] |
//! | `openMergeCheckout` | engine.ts:5920 | [`open_merge_checkout`] |
//! | `prepareWorktree` | conversations.ts:1442; engine.ts:9530 | [`prepare_worktree`] |
//! | `refStamp` | merge-hold.ts:81 | [`ref_stamp`] |
//! | `removeStaleMergeCheckout` | engine.ts:1217 | [`remove_stale_merge_checkout`] |
//! | `removeWorktree` | conversations.ts:1490, 1830; engine.ts:11644 | [`remove_worktree`] |
//! | `worktreePathFor` | conversations.ts:1128; engine.ts:791, 1924, 2673, 4234, 4434, 5814, 8036, 8487, 8562 | [`worktree_path_for`] |
//!
//! Where a TypeScript call reads its probe in a way no function here names (`.out` of a failed run,
//! say), the runner's [`GitProbe`] carries exactly what the TypeScript saw. A git that cannot be started
//! at all reads as a failed run carrying the reason, where Bun's spawn would have thrown.

mod boot;
mod diffs;
mod merge;
mod node;
mod repo;
mod runner;
mod worktrees;

#[cfg(test)]
mod test_repo;

pub use boot::{absolute_git_dir, recent_subjects, ui_source_commit_ms};
pub use diffs::{ActivityDiff, BranchDiffFailure, activity_diff, branch_diff, diff_stat_summary};
pub use merge::{
    MergeFailure, MergeResult, MergedTicketFile, blocked_merge_explanation, commit_merge,
    merge_abort, merge_branch, merge_file, merge_in_checkout, merge_in_place, with_merge_checkout,
};
pub use repo::{
    branch_at, commit_sha_at, current_branch, git_available, has_commits_beyond, is_ancestor,
    merge_base, ref_exists, repo_root_of, rev_parse, show_file, show_toplevel,
};
pub use runner::{GitOutput, GitProbe, git, git_async, git_line, run_git, run_git_async};
pub use worktrees::{
    WorktreeInfo, attempt_branches, branch_checked_out_at, branch_exists, branch_for,
    checkout_new_branch, close_merge_checkout, discard_worktree, git_common_dir, is_pool_worktree,
    merge_checkout_path_for, open_merge_checkout, pool_key_for, prepare_worktree, ref_stamp,
    remove_stale_merge_checkout, remove_worktree, restore_found_branch, worktree_path_for,
};
