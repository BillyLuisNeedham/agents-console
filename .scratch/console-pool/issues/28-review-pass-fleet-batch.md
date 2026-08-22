<!-- state: id=28 blocked-by=23,24,25,26,27 status=done -->

# 28 — Review pass over the fleet batch

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`. Decision record: `docs/adr/0001-one-console-per-pool.md`.

## What to build

Final review pass over the fleet batch before calling the spec done, mirroring tickets 11 and 22's shape. Run both review axes (standards plus spec, per the `code-review` or `peer-review` skill) across the full diff of tickets 23 to 27, verify every user story in the spec is demonstrably working, and address the findings. Vocabulary gets specific attention: the CONTEXT.md terms Pool, Fleet, and the updated Console used correctly in code and skill copy, avoid-words absent. ADR 0001's claims are checked against what actually landed — especially boot order (lock → bind → register) and the absence of any `--force` hatch.

## Acceptance criteria

- [x] Both review axes run over the 23-27 diff and findings addressed (axes ran; all three findings fixed by ticket 29, reviewed clean by ticket 30)
- [x] Every user story in the spec verified working end to end (15 of 16 verified live; story 7 was partial, fix landed in 7a4b1fc and verified below)
- [x] CONTEXT.md vocabulary used correctly; avoid-words absent
- [x] ADR 0001's recorded decisions match the landed behaviour
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 23 — Engine-enforced pool lock
- 24 — Pinned pool ports
- 25 — Fleet registry, written on start
- 26 — Fleet list command
- 27 — my-console-runner speaks the new conventions

## Notes

- This is the batch review, not the pool's final Review interrupt — the engine raises that itself once every ticket in the pool is done.

### Review setup (ticket 28)

- Review diff: tickets 23-26 are commits 7d37820, 1da30a6, ff3d0a8, b7f5148 on main; ticket 27 is 35e7170 in the skills repo (`~/.claude/commands`). 4263f89 is a byte-identical duplicate of 1da30a6 (resolver cherry-pick), not extra work. engine.ts/events.ts changes in the range belong to ticket 17, not this batch; only the `port?: number` field in `PoolConfig` is fleet.
- Working tree was dirty on arrival: `engine/server.ts` and `ui/` carry an uncommitted `/api/ticket` prototype explicitly marked "PROTOTYPE — throwaway", and `CONTEXT.md` carries uncommitted Pool/Fleet/Console glossary additions. Neither belongs to a fleet-batch commit; left untouched per "unexpected repo state is not a puzzle to solve". The CONTEXT.md additions look like batch vocabulary work nobody committed (inference) — flagged in the brief.
- No CODING_STANDARDS.md / CONTRIBUTING.md exists; documented standards are CONTEXT.md vocabulary plus this job's runner constraints (public-interface testing, no new runtime deps, bun:sqlite only).

### Story verification (live smoke, temp pools under /tmp, all servers killed after)

- Stories 1, 2: second boot on a live pool exits 1 with `pool <dir> is locked by live server pid 333065 on port 19381; open the running console or kill it` (pid and port both named, port via the registry). PASS.
- Story 3: kill -9 the server, re-boot takes the pool over with no manual cleanup. PASS.
- Story 4: the engine writes runs/server.pid itself on direct `bun run engine/server.ts` launches. PASS.
- Story 5: no `--force` anywhere in server.ts or PoolServerOptions. PASS.
- Story 6: after a stale-pid takeover the pool rebinds its pinned port; the URL is stable. PASS.
- Story 7: a pool pinned to a busy port exits 1 with `port 19382 is already in use; free it or pass a different --port`. Loud, but the conflicting process is NOT named. PARTIAL (see Brief).
- Story 8: `--port 19384` overrides the pin for one launch; the pin stays in console.json. PASS.
- Story 9: an unpinned pool bound 8787 (next-free hunt intact). PASS.
- Stories 10, 11, 13: both live pools registered in ~/.agent-graphs/pools.json and listed by `bun run engine/fleet-cli.ts` as `poolDir -> URL`. PASS.
- Story 12: after kill -9 on one server, the next fleet list drops it. PASS.
- Stories 14-16: skill commit 35e7170 writes the `port` key, never writes runs/server.pid, and surfaces the engine refusal verbatim; verified by ticket 27 against a temp pool and re-read here against the engine messages. PASS (one disagreement noted in the Brief).

### ADR 0001 check

Boot order is lock -> bind -> register (engine/server.ts:345 acquires, :497 binds, :512 registers; a failed bind clears the claimed pid at :501). No `--force` hatch exists. The ADR matches what landed.

### Suite

`bun test` 183 pass / 0 fail; `bunx tsc --noEmit` clean; `bun run build` in ui/ clean.

## Brief

Review pass over the fleet batch (23-27) is complete: both axes ran, all sixteen user stories were exercised live, ADR 0001 checks out, vocabulary is clean, and the suite is green. The review found three problems that are Billy's call, so this stops here per the review-issue rule.

What I completed:

1. Standards axis (sub-agent): no documented-standard breaches. Judgement-call smells only: `pidIsLive` duplicated between server.ts and fleet.ts; a duplicated dead-pid test helper across three test files; the lock path `runs/server.pid` as a repeated string; server.ts drifting toward a god-file (563 lines, edited for three reasons in this batch); the `defaultPort` test-only option as speculative generality. None urgent.
2. Spec axis (sub-agent, adjudicated by me): the findings below.
3. Live end-to-end verification of every user story (table above).
4. Committed the uncommitted CONTEXT.md glossary additions (Pool, Fleet, updated Console) as a10b68e; they were batch vocabulary work left in the working tree.

Findings needing Billy's decision:

1. **Story 7 is partial (spec gap).** The spec twice asks for a busy pinned port to name the conflicting process (lines 32 and 52: "with the conflicting process named", "naming the holder"). The landed error names only the port. The lock-refusal path already does a best-effort fleet-registry lookup to name a holder; the port-conflict path never does. Fix is small and mirrors existing code, but the spec could also be amended if naming the port is enough.
2. **The pool lock has a TOCTOU window.** `acquirePoolLock` is read-then-write with no atomicity: two near-simultaneous launches of the same pool can both pass, and the failed-bind cleanup (server.ts:501) deletes the pid file unconditionally, which can erase the winning server's lock. Story 1 says two consoles can "never" silently corrupt one pool; this window contradicts that, narrowly. Candidate fixes: atomic claim (O_EXCL create), and cleanup that only removes the file if it still names our pid.
3. **Fleet registry writes are not atomic.** `upsertFleetEntry` is an unlocked read-modify-write; two servers booting different pools at the same moment can lose one entry until that pool's next launch. Low stakes, self-healing, but it undercuts story 10's "one place recording which pools are live". Candidate fix: write to a temp file and rename, or a lockfile.

One disagreement with the spec sub-agent, for the record: it called story 16 partial because the skill surfaces the refusal rather than opening the live console, and because the port is named only "when known". I judge story 16 satisfied: surfacing the refusal verbatim is pointing at the live console, and "port from the fleet registry if known" is the spec's own wording (line 51). Flagged in case Billy reads it the other way.

Also noted, no action taken:

- The working tree still carries an uncommitted `/api/ticket` prototype in engine/server.ts and ui/ marked "PROTOTYPE - throwaway", plus ui/src/prototype/. Not part of this batch; commit or discard is Billy's call.
- 4263f89 is a byte-identical duplicate of 1da30a6 (a merge-resolver artifact from ticket 24). Harmless.
- Ticket 22 is still status=ready while branches pool/18 and pool/19 exist unmerged; outside this Issue's scope but the pool's next agent will meet it.

What the human has to do: decide findings 1-3 (fix, amend the spec, or accept). Each is a small, well-scoped change if he wants it.

After he decides: apply any fixes as follow-up tickets, tick criteria 1 and 2 here, and set this Issue to done. If he accepts all three as-is, this Issue can go straight to done.

### Second independent review (parallel session, after the checkpoint above was written)

A second agent ran the same two-axis review concurrently, unaware the ticket was already checkpointed. It independently reproduced the story 7 gap (live smoke: the busy-pinned-port refusal names only the port) and the lock TOCTOU concern, and its own end-to-end smoke passed every acceptance-listed story: two consoles on different pools concurrently, same-pool refusal naming pid and port, stable pinned URL across a kill and re-boot, prune-on-read fleet list, no --force hatch. Suite re-run on the same tree: 183 pass, tsc clean, ui build clean.

It adds one finding the first pass missed:

4. **Em dash in committed batch prose.** engine/server.ts:464 at b7f5148 (working tree :507): the comment "Registration is best-effort — a registry write that..." breaches the standing "prose without em dashes" rule. One-character fix, bundled with whatever Billy decides on findings 1-3.

The pre-existing runs/28.outcome.json belongs to the first review and was left untouched.

---

## Brief, written by the engine

The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted), so the work is part done at best and the agent left no brief. The ticket is back to ready; read the working tree before it runs again.

## Resume note

Billy decided: fix all three findings. Done: ticket 29 implemented them (merged, aec2f65 era) and ticket 30 reviewed the fixes clean (done). Do not create new ticket files. Your remaining work: tick acceptance criteria 1 and 2 (both axes ran; stories verified), record your outcome, and set this issue to done.

## Closeout verification (this run)

All three findings verified fixed in the tree:

1. Story 7: server.ts:476 appends `holderText` naming the conflicting pool and pid on a busy pinned port; pinned by server.test.ts:827. Full story now satisfied.
2. Lock TOCTOU: the pid claim is an O_EXCL create (server.ts:512, `flag: "wx"`).
3. Fleet registry: upsert claims a lockfile with O_EXCL and writes temp-then-rename (fleet.ts:144, :179).

Bonus finding 4: no em dash remains in engine/ (grep clean).

Suite re-run on the merged tree: 226 pass / 0 fail, `tsc --noEmit` clean, ui build clean. No commit: the only files this run touched live in `.scratch/`, which is never committed.
