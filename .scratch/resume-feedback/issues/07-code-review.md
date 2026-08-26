<!-- state: id=07 blocked-by=01,02,03,04,05,06 status=done -->
# 07: Code review of the resume-feedback work

**What to build:** A full review of everything tickets 01-06 landed, run through the code-review skill against the spec (`docs/specs/2026-08-25-resume-feedback-and-pool-drive-fixes.md`) and ADR-0004. Check the work along both axes the skill provides: does it follow the repo's documented standards, and does it match what the spec and the tickets actually asked for. Verify each ticket's acceptance criteria genuinely hold, that the test suites pass, and that the accept/process split was honoured (no answer path ever spawns an attempt; the queued-answer store stays out of PoolState). Append every finding to this Issue as a numbered list under a `## Findings` heading, each marked blocker or nit. An empty findings list is a valid, successful outcome.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [x] The code-review skill has been run over the full diff of tickets 01-06
- [x] Every finding is appended to this Issue under `## Findings`, numbered, each marked blocker or nit
- [x] `bun test` and `bun run typecheck` pass and their output is noted in the Issue
- [x] The accept/process split is verified: acceptance never spawns, the queued-answer store is separate from PoolState, resume is idempotent
- [x] The Issue closes with an explicit verdict: clean, or N blockers for ticket 08

## Findings

Review ran per the code-review skill: fixed point `be3a819`, diff
`be3a819...HEAD`, both axes as parallel sub-agents, key claims spot-checked
against the code by the reviewer.

1. **blocker** (spec): an invalid review reject is acknowledged 202 and then
   silently swallowed. `POST /api/resume {action: reject}` with a note naming
   no ticket passes acceptance: the `answered` event and queued record are
   written (`engine/engine.ts` `acceptAnswer` validates only kind-vs-action),
   the client gets 202, and the failure surfaces only at processing, where
   `rejectReview` throws "name at least one ticket" (`engine/engine.ts:1361`).
   `drainAnswers` (`engine/engine.ts:831`) catches the throw, marks the record
   processed, and rejects only registered waiters; the server's `answer()` uses
   `run.accept()` (`engine/server.ts:644`), which registers none, so the error
   is dropped. Net effect: the operator's explicit reject does nothing, the
   review gate stays up with no error anywhere, and the ticket log carries an
   `answered` event for an answer that had no effect. Before this work the same
   request was a 400. The spec's contract (spec line 149: "400 only for
   genuinely invalid answers") calls this genuinely invalid, and user story 3
   makes the misleading log entry a regression in its own right. No server test
   covers an invalid reject. Ticket 08 should validate the reject at
   acceptance (markers are in-session, so the named-ticket check can run
   there) or otherwise surface the processing failure to the operator.
2. **nit** (spec): `engine/server.ts:624` still throws "pool not started",
   reachable by POSTing `/api/resume` before `/api/start`; no test covers it.
   The spec's "never for pool not started" is written flatly, but Issue 01
   already scoped this as acceptable: it can only fire before any interrupt
   exists, so the 400 is honest there. Noted for the record; no fix needed.
3. **nit** (spec, robustness): `processAnswer` matches the pending interrupt
   by `ticketId` only (`engine/engine.ts:852`), ignoring `record.kind`, while
   idempotency keys on ticket+kind+approve. Unreachable in practice (a ticket
   holds one interrupt kind until its record drains); a comment would do.
4. **nit** (standards, Duplicated Code): the queued-match predicate
   `answer.ticketId === X && answer.kind === Y` appears twice in
   `ui/src/project.ts` (`toInterruptView` and `poolStatus`), with a near-twin
   in `engine.ts` `acceptAnswer`. One shared helper would bind them.
5. **nit** (standards, Duplicated Code): the
   `card.interrupt.queued ? "dot dot-queued" : "dot dot-interrupt"` class and
   title ternaries are copied between the `ticketCard` and `utilityCard`
   renderers in `ui/src/canvas.ts`.
6. **nit** (standards, Mysterious Name): `Session.handle` is bootstrapped as
   `undefined as unknown as PoolRun` (`engine/engine.ts`) to break the handle
   cycle; a nullable handle with a guard would read honestly.
7. **nit** (standards, commit convention): `3cf9931` carries two prefixes
   (`ui, engine:`) where the repo convention is one of engine / ui / docs.
   Already landed; noted only so the next queue keeps to one prefix.

Scope-creep check: `PoolServer.settled()` is new public surface not in the
spec, but Issue 03 documents it as fixing a pre-existing test flake; accepted.
The `.scratch` run-log churn was cleaned up by `322eae7`. Both axes otherwise
came back clean: CONTEXT.md vocabulary is used correctly throughout, and no
baseline smell rises above the judgement calls listed above.

## Accept/process split verification

- Acceptance never spawns: the mid-flight server test asserts the spawn count
  does not move when an answer is accepted during a held-open super-step;
  `kickProcessing` (`engine/engine.ts:821`) drains and drives but the spawn
  itself is always the drive's.
- The queued-answer store is separate from PoolState: persisted independently
  at `runs/queued-answers.json`, merged into snapshots only at emit time;
  `readyTickets` and `reconcileDeadlocks` have zero diff hunks, so join and
  merge semantics are untouched.
- Resume is idempotent: a duplicate answer (same ticket, same interrupt
  identity) returns 202 with no second `answered` event, tested for both the
  pending-retry and the already-processed-retry paths.
- Crash recorded at attempt exit with an immediate snapshot push; the crash
  interrupt is still raised at the super-step boundary.
- Only `done` satisfies a blocked-by edge; the deadlock detector is
  untouched; the blocked-by-checkpoint notice projects onto card and Detail
  and clears when the blocker resolves.
- AGENT.md is re-read per spawn; spawn prompt and read-back both use the
  canonical main-checkout Issue path.

## Test and build output

- `bun test`: 297 pass, 0 fail, 1111 expect() calls, 10 files, 18.19s.
- `bun run typecheck` (`tsc --noEmit`): clean, no output.
- `bun install --cwd ui && bun run build` in `ui/`: built in 56ms, no
  warnings.

## Verdict

Not clean: 1 blocker for ticket 08 (finding 1, invalid review rejects
acknowledged 202 and silently swallowed), plus 6 nits (findings 2-7) for
ticket 08 to take or leave.
