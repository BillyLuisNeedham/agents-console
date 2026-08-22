<!-- state: id=19 blocked-by=18 status=done -->

# 19 — Live log tailing

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`.

## What to build

While a ticket's Detail is open and an attempt is running, the raw log pane follows the tail live: it refetches new bytes on each SSE snapshot (the snapshot cadence is the liveness signal; no per-ticket streaming) and auto-scrolls to the bottom. Scrolling up pins the view where it is; scrolling back to the bottom resumes following. Selecting an older attempt stays put when a new attempt starts, so reading attempt 1 while attempt 2 runs is undisturbed; the timeline still shows the new attempt arriving with its running marker. Long logs open tail-first with a "load earlier" affordance that prepends older content. Scroll pin and selected attempt survive full-DOM rebuilds from live snapshots.

## Acceptance criteria

- [x] The log pane refetches on new snapshots for the selected ticket, requesting only bytes past the last offset read
- [x] Auto-scroll follows the tail only while the view is pinned at the bottom; scrolling up pins, scrolling to bottom resumes
- [x] A new attempt starting does not switch the pane away from a selected older attempt
- [x] "Load earlier" prepends older content for long logs, keeping the opened view anchored
- [x] Scroll position, pin state, and selected attempt survive SSE-driven rebuilds
- [x] Projection tests cover the tailing view-model decisions (pin state, attempt-stay, offset bookkeeping); scroll feel verified manually in the proving flight
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 18 — Raw log pane in the Detail (the pane and the offset-serving endpoint this makes live)

## Notes

- UI-only liveness state (pin, offsets, selected attempt) lives in module scope per the established idiom; the projection stays pure over snapshot plus events data.

## Notes (this run, 2026-08-22)

- **Blocker's code is absent from this worktree.** Issue 18 is marked done and its outcome (commit d85baf3 on branch pool/18) is recorded, but pool/18 was never merged onto main. This worktree (pool/19, branched from ff3d0a8 = main at spawn) has no `/api/log` endpoint in engine/server.ts and no raw log pane in ui/src/main.ts. Proven, not inferred: `git branch --contains d85baf3` lists only pool/18; `git merge-base --is-ancestor d85baf3 main` is false; main's reflog merges pool/16, 17, 20, 21, 23, 24, 25, 26 but never pool/18.
- **Why it happened (proven from the pool's log channel).** Super-step 2 ran 18, 25, 27. Ticket 18 exited with marker `in-progress` (its first attempt), so the engine raised a crash interrupt and queued no merge. The crash was later answered and the engine logged "interrupt answered for 18 (crash): already done on disk", which clears the interrupt but does not merge the branch. So the engine treats 18 as done while its commit sits orphaned on pool/18. This is a pool-engine gap: a crash-answered-as-done ticket never gets its branch merged.
- **Consequence.** Issue 19 is blocked by 18 precisely so it can build live tailing on the raw log pane and the offset-serving endpoint. Neither exists here. Building them again would duplicate issue 18's work, which is explicitly forbidden. Merging pool/18 onto my branch myself would be solving repo state the engine owns, also against the standing constraints.
- **What I did not do:** no code changes, no merge, no git mutation. This Issue stops at checkpoint.

## Brief

1. **What I completed.** Diagnosis only. I confirmed that issue 19's blocker (18) is marked done with its work committed (d85baf3 on pool/18), but that branch was never merged onto main, so this worktree lacks the raw log pane and the `/api/log` endpoint that issue 19 must make live. Root cause: issue 18's first attempt exited with an in-progress marker, the engine raised a crash interrupt, and answering it as "already done on disk" cleared the interrupt without merging pool/18.
2. **What you have to do.** Merge branch `pool/18` onto main, then re-run this Issue. Suggested commands, run in the main checkout at the repo root:
   - `git checkout main && git merge pool/18`
   - then `cd .scratch/console-pool && ./run.sh reset 19`
   The merge brings the raw log pane and `/api/log` endpoint onto the branch the engine spawns 19 from. (If you prefer, resolve the engine gap first so a crash-answered-as-done ticket always merges; either way the manual merge unblocks this Issue.)
3. **What should happen after.** The runner re-spawns issue 19 on a main that contains issue 18's work. The live tailing then proceeds exactly as this Issue's What to build describes, and the acceptance criteria can be genuinely met.

## Resume note

pool/18 merged onto main as b832f08 (clean ort merge; 132 engine + 68 UI tests green, typecheck and build clean). Raw log pane and /api/log endpoint are now on main — build live tailing on them.

## Notes (this run, 2026-08-22, resume)

- Branch state at spawn: pool/19 sat at ff3d0a8 while main had moved to b832f08 (the pool/18 merge the resume note describes). ff3d0a8 was a clean ancestor of main, so I fast-forwarded pool/19 to b832f08 before touching code. No rebase, no force, no other branch touched. Proven: `git merge-base --is-ancestor ff3d0a8 main` was true and the merge resolved as `--ff-only`.
- Decision the Issue did not settle: the `/api/log` endpoint gained an optional `end` byte parameter (bounded range, still capped at one 64KB chunk, UTF-8 trimmed). Reason: "load earlier" must read exactly the prefix before the held window; an offset-only range cannot express that without slicing decoded text client-side, which ANSI stripping makes unsafe. Server tests added for the bound, the clamp, and the end-boundary trim.
- How it hangs together: openLog probes totalSize (offset past EOF serves empty content plus the total, per the endpoint's clamp) then opens the last 64KB window; tailLog appends from the last read offset on each snapshot, guarded against overlap by an in-flight flag; prependLog fetches [firstOffset-64KB, firstOffset) and a captured scroll anchor keeps the opened line put across the rebuild. Attempt-stay: logState.clicked records a hand-picked attempt; an unclicked pane follows the running attempt as new attempts start. Pin/scroll/key live in view.ts module scope, same idiom as the drawer and Detail width state.
- Known cosmetic seam (inference): a multi-byte char or ANSI sequence straddling a prepend boundary renders one replacement char or a few stray bytes at that seam. The endpoint trims range tails to char boundaries but not starts; fixing it would change 18's tested offset contract for a 64KB-boundary edge case, so it stays.
- Flake note: one engine test (worktrees > resolver agent > rotates the resolver log...) failed once in a full run, then passed in isolation and in a full re-run. Untouched by this Issue; noting it so the next agent does not chase it.
- Verified: 212 engine + 77 UI tests, both `tsc --noEmit`, and `bun run build` in ui/ clean. Scroll feel remains for the proving flight per the acceptance criterion.
