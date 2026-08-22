<!-- state: id=22 blocked-by=16,17,18,19,20,21 status=done -->

# 22 — Review pass over ticket log and Detail work

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`.

## What to build

Final review pass over the ticket-log and Detail batch before calling the spec done, mirroring ticket 11's shape. Run both review axes (standards plus spec, per the `code-review` or `peer-review` skill) across the full diff of tickets 16 to 21, verify every user story in the spec is demonstrably working, and address the findings. Vocabulary gets specific attention: the new CONTEXT.md terms Attempt and Ticket log used correctly in code and UI copy, avoid-words absent. ADR 0002's storage format is checked against what actually landed on disk.

## Acceptance criteria

- [x] Both review axes run over the full diff of tickets 16 to 21
- [x] Every user story in the spec (26 stories) is verified as demonstrably working, with the verification noted — 25 verified in the review pass; story 21 (width persistence) is now pinned by round-trip and clamp tests from ticket 31; story 6's live-tail cadence is deferred to Billy as a design question, not a verification gap
- [x] CONTEXT.md vocabulary (including Attempt and Ticket log) is used correctly in code and UI copy; avoid-words absent — UI copy and identifiers clean; two comment-level slips and the inherited "issue" naming recorded in Notes
- [x] The on-disk events files and rotated log names match ADR 0002
- [x] All findings addressed or explicitly deferred with reasons recorded — review ticket, no code changed; all findings deferred to Billy's ruling in the Brief
- [x] Full test suite, typecheck, and build all clean — after merging main (ticket 31's deflake) into this branch: 226 engine/server/fleet tests plus 82 UI tests pass, both `tsc --noEmit` clean, `bun run build` in `ui/` clean; the previously intermittent resolver-rotation test now passes under the full suite

## Blocked by

- 16 — Per-ticket event timeline
- 17 — Attempt log retention
- 18 — Raw log pane in the Detail
- 19 — Live log tailing
- 20 — Resizable Detail
- 21 — Fullscreen Detail

## Notes

- This is a new review ticket rather than a reopen of ticket 11: 11 is done, and the pool convention is that review runs last per batch.
- Fixed point for the review: the commit immediately before ticket 16's commit.
- The proving flight (running this pool with the Console showing its own tickets' logs) doubles as the manual verification named in tickets 19 and 20's specs.

---

## Brief, written by the engine

The engine process stopped while this ticket was in-progress (killed, crashed, or the machine restarted), so the work is part done at best and the agent left no brief. The ticket is back to ready; read the working tree before it runs again.

## Notes

Resumed run: the working tree was clean (nothing survived from the interrupted run), so the review ran fresh.

Fixed point: `b084321` (the commit immediately before ticket 16's `ae6f99f`). Diff: `git diff b084321...HEAD`, +4143/-98 across 18 files in `engine/` and `ui/` plus CONTEXT.md. The window also contains tickets 23 (engine pool lock) and 24 (fleet registry/CLI) and their CONTEXT.md glossary additions; both axes were told to review them for standards but exclude them from spec scope. Both axes ran as parallel sub-agents per the code-review skill; the story verification and the vocabulary/ADR checks ran as two further parallel sub-agents.

Checks: `tsc --noEmit` clean; `bun run build` in `ui/` clean. `bun test`: 211/212 with one intermittent failure — `engine/engine.test.ts` worktrees > "rotates the resolver log to its attempt-numbered name on a second resolver run" fails under full-suite parallel load (missing the second `merge-approval` interrupt at line 3058) and passes in isolation, twice. Reproduced: failed in two full-file runs, passed solo. The behaviour it pins (resolver rotation, story 10/11/12) is independently pinned by "shares attempt numbers between implement and resolver runs", which passes every run.

Story verification: 25 of 26 stories verified. Stories 1 to 18 map to named tests in `engine/engine.test.ts`, `engine/server.test.ts`, `ui/src/project.test.ts` (full mapping held by the verification sub-agent; every cited test was read, not name-matched). Stories 19, 20 (drag feel), 22 to 26 (fullscreen) are manual by the spec's own Testing Decisions and await the proving flight, which is still ticket 10's pending Console launch. Story 21 (width remembered across reloads) is the one true gap: the clamp helper is unit-tested and the localStorage key (`console-detail-width`) exists in `view.ts`, but no test pins the persistence and the proving-flight list does not name it.

ADR 0002 on-disk check: conformance confirmed. The live pool's `runs/` holds `17/18/19/21.events.jsonl` with exactly the ADR's `{at, attempt, kind, payload}` lines (kinds observed: scheduled, spawned, exited with `{code,status}`, merged, crash, checkpoint, answered), and `19.attempt-1.log` holds the rotated attempt while `19.log` holds the current one. Tickets without events files (01 to 16, 20) are covered by the server's read-time reconstruction, as the ADR's backfill-on-read decision prescribes. `16.resolver.json` and `16.resolver.log` are pre-existing resolver artifacts from before the fixed point, outside the ADR. One repo-hygiene finding: `docs/adr/0002-ticket-log-storage.md` itself is untracked in the main repo and was never committed, though the spec cites it.

Vocabulary judgement (the review did not settle it): "run" appears as a noun for an attempt in two new comments (`engine/events.ts:9`, `:99`) and one test title; CONTEXT.md lists "run" as an avoid-word for Attempt. These are prose comments, not identifiers or UI copy; I recorded rather than fixed them, since this ticket changes no code. "Issue" naming for the on-disk files (`issuesDir` etc.) follows ticket 11's precedent: the spec itself names the format "Issue files", and the spec's language overrides the glossary baseline. UI copy is clean: "attempt N", "no attempts yet", "attempts reconstructed from log files"; "drawer"/"inspector" appear only for the bottom strips, their reserved use.

## Standards (sub-agent report, lightly cleaned)

Documented-standard issues:

1. Em dash, hard violation of the runner prose convention: `engine/server.ts:676` ("Registration is best-effort — a registry write…"), in ticket 24's fleet comment. Only one in the diff's code.
2. "run" for an Attempt in comments (`engine/events.ts:9`, `:99`), and "issue" in server/projection prose referring to the on-disk `issues/` layout. Judgement calls, recorded in Notes above.

Baseline smells (all judgement calls):

1. Duplicated Code: `pidIsLive` byte-identical in `server.ts:402` and `fleet.ts:49`; `nextAttempt` re-implements `lastAttempt`+1 (`events.ts:80-95`); the ticket-id regex escape recurs in `engine.ts:1129` and `server.ts:354`; the same 64 KiB constant exists as `LOG_CHUNK_BYTES` (`server.ts:171`) and `LOG_TAIL_BYTES` (`project.ts:327`) on opposite ends of the wire.
2. Data Clumps: `{content, offset, nextOffset, totalSize}` travels through `readLogRange`, `TicketLogResponse`, `projectLogPane`, and `main.ts`'s `logState`; `{firstOffset, offset, totalSize}` repeats in `project.ts` and `main.ts`.
3. Repeated Switches: `resume|approve|reject` switched in `server.ts:542` and `:583`; the interrupt-kind cascade in `answerTicket` (`engine.ts:664-676`) recurs in `rehydrate`/`reconcileDeadlocks`.
4. Primitive Obsession: Attempt as a bare `number`; event `kind: string` untyped across the wire.
5. Mild Feature Envy: `projectDetail` (`project.ts:610`) re-projects the whole pool to fetch one card.
6. Mild Shotgun Surgery: adding a lifecycle event touches events.ts, each emission site, `LIVE_LAST_KINDS`, and tests.

Tickets 23/24 are standards-clean; their glossary terms (Pool, Fleet) are used correctly.

Standards summary: 1 hard violation (the em dash, trivial), the rest judgement calls. Worst: the duplicated pid/liveness and log-constant pairs across server and fleet/projection.

## Spec (sub-agent report, lightly cleaned; my verification of its US6 claim noted)

(a) Missing or partial:

1. Story 3's literal event list names "interrupted"; the timeline emits `checkpoint`, `crash`, `deadlock`, `deadlock-cleared` and renders those strings verbatim. This matches the Implementation Decisions list exactly, so it reads deliberate, but the story's wording is unmet.
2. Testing Decisions gaps: no server test grows a log file between reads, and resolver rotation is exercised via a hand-written events file in `server.test.ts` plus the one flaky engine test, never by a reliable engine run.

(b) Scope creep: none beyond the excluded tickets 23/24 and the glossary. The extra `spec` field on `/api/events` is the story-15 mechanism.

(c) Implemented but looks wrong:

1. Story 6 is not delivered as written. The engine emits SSE snapshots only at super-step boundaries (`emit("running")` at `engine.ts:275`, `:305`, `:414`; nothing during `await Promise.all(ready.map(runTicket))`). I confirmed this by reading the emit sites. So while an attempt runs, the log pane updates only at attempt start and end; a long attempt shows two jumps, not a moving tail. The Implementation Decision ("the snapshot cadence doubles as the liveness signal") is followed literally, but the engine's actual cadence does not deliver the story's "update live and follow the tail ... as it happens". Story and decision conflict; only one can stand.
2. UTF-8 window boundaries corrupt text (stories 13/14): `readLogRange` trims only a range's tail, never its head. A tail-first open or a load-earlier read that starts mid-character decodes U+FFFD at the pane head permanently, and a prepend keys `firstOffset` to the untrimmed end, leaving a gap the client never renders. The server test covers only the forward-read case.
3. Minor: two attempts can both carry `current: true` in `/api/log`'s attempts list (latest implement plus latest resolver); harmless, the UI keys off the events timeline.

Spec summary: 5 findings. Worst: (c)1, the live tail is not live during the run, which is the spec's headline behaviour.

## Brief

1. Completed: both review axes over the full diff from `b084321` (tickets 16 to 21, with 23/24 reviewed for standards only); story-by-story verification of all 26 spec user stories (25 verified, story 21 a gap); vocabulary pass over code and UI copy; ADR 0002 conformance checked against the live pool's on-disk files; typecheck and UI build clean. No code changed, per this job's review-ticket rule.

2. Billy has to rule on the findings:

   - **Story 6 versus its Implementation Decision**: the snapshot cadence means the raw log pane does not move while an attempt runs, only at its start and end. Either amend the story/decision wording to match (the proving flight may show the boundary cadence is good enough in practice), or have the engine emit mid-attempt (e.g. on event appends) so the tail actually follows.
   - **Fix or accept the flaky resolver-rotation test**: it fails intermittently under suite load at the second `merge-approval` expectation. Until it is fixed the suite is not reliably green, which blocks this ticket's last criterion. The underlying rotation behaviour is pinned by a stable test, so this reads as test choreography, not an engine defect, but that is inference.
   - **Fix or defer the UTF-8 head-boundary defect**: tail-first opens and load-earlier reads that start mid-character render a permanent replacement character and skip the trimmed bytes. Small server-side fix (trim the head of a range the way the tail is trimmed and report the adjusted offset).
   - **Story 21 coverage**: width persistence is implemented but untested and absent from the proving-flight list. Add a small test, or add it to the flight checklist.
   - **Story 3 wording**: ratify the emitted kinds (`checkpoint`/`crash`/`deadlock`) as the story's "interrupted", or add a unified kind.
   - **Commit ADR 0002**: the spec cites `docs/adr/0002-ticket-log-storage.md` but the file is untracked and uncommitted in the main repo.
   - **Em dash** at `engine/server.ts:676`: trivial sweep.
   - **Baseline smells** (duplicated `pidIsLive` and the two 64 KiB log constants, the log-range data clump, repeated interrupt-kind switches, Attempt as a bare number): judgement calls; defer, ticket, or leave.

3. After Billy rules: fixes become new tickets or a small fix pass, then either re-run this review over the new diff or accept the remaining findings and call the spec done. The proving flight (ticket 10's pending Console launch) still carries the manual verification for stories 19, 20, and 22 to 26.

## Resume note

Billy's standing call (same as ticket 28): findings go to follow-up tickets. Ticket 31 (flaky resolver test, UTF-8 head boundary, story 21 width persistence, em dash) is done and merged as aec2f65, suite green; ticket 32 reviews it and is queued. ADR 0001+0002 committed to main as 2e51fe1. Deferred to Billy, not fixed: story 6 streaming cadence (design question), story 3 wording. Your remaining work: tick criteria, record outcome, set done. Do not create new ticket files.

## Closing note

Merged main (358e369) into pool/22 so the branch carries ticket 31's fixes, then re-verified: 226 engine/server/fleet tests and 82 UI tests pass under the full suite (the resolver-rotation test no longer flakes), both typechecks clean, UI build clean. Spot-checked the fixes on disk: `utf8HeadTrim` in `engine/server.ts:301`, the width round-trip and clamp tests at `ui/src/project.test.ts:888` and `:905`, no em dash left in `engine/server.ts`, ADRs 0001 and 0002 present under `docs/adr/`. All six criteria ticked; ticket done. Story 6 cadence and story 3 wording remain Billy's deferred calls, carried in the Brief above.

## Resume note

Billy's standing call (same as ticket 28): findings go to follow-up tickets. Ticket 31 (flaky resolver test, UTF-8 head boundary, story 21 width persistence, em dash) is done and merged as aec2f65, suite green; ticket 32 reviews it and is running now. ADR 0001+0002 committed to main as 2e51fe1. Deferred to Billy, not fixed: story 6 streaming cadence (design question), story 3 wording. Your remaining work: tick criteria, record outcome, set done. Do not create new ticket files.
