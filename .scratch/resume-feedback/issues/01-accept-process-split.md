<!-- state: id=01 blocked-by=none status=ready -->
# 01: Accept/process split — answers acknowledged with 202, processed at the super-step boundary

**What to build:** Answering any interrupt (resume, approve, reject) becomes two moments. Acceptance is immediate and durable: the `answered` event is appended to the ticket log, a queued-answer record (ticket id, interrupt identity, payload, submission order) is written to a new persisted queued-answer store kept alongside the pool's run artifacts, and `POST /api/resume` returns 202 with the current snapshot — from the very first super-step, because starting a pool returns a live run handle immediately with the drive proceeding in the background (400 "pool not started" disappears entirely). Processing applies the answer and continues the drive: immediately when the pool is idle (today's behaviour), or drained in submission order at the next super-step boundary while a super-step is in flight. Only acceptance is ever immediate — an answered ticket's next attempt is always spawned by the drive, never by the answer path. Review interrupts gain the uniform `answered` event at acceptance; `review-reject` remains for the rejection outcome. The queued-answer store is deliberately separate from PoolState so the super-step join cannot clobber it (ADR-0004).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `POST /api/resume` returns 202 promptly for every interrupt kind, including while a super-step is held open mid-flight and during the pool's initial drive — no hanging request, no "pool not started"
- [ ] The `answered` event (carrying the interrupt kind) appears in the ticket log at acceptance time, before any processing
- [ ] A queued-answer record is persisted to its own store at acceptance, separate from PoolState
- [ ] While a super-step is in flight, the queued answer is processed at the next super-step boundary; answers to multiple tickets process in submission order
- [ ] When the pool is idle, an answer is processed immediately, as today
- [ ] An answered ticket's next attempt is spawned only by the drive, never by the answer path
- [ ] Approve/reject answers write an `answered` event at acceptance like all other interrupt kinds
- [ ] Engine seam tests (stub harnesses, including a blocking stub that holds a super-step open) and server seam tests (real HTTP) cover all of the above; existing suites pass

## Notes

Design settled before writing code (proven against the source, not inferred):

- `runPool` keeps its await-to-settle contract for existing callers by becoming
  an async wrapper over a new synchronous `startPool`, which returns the live
  handle immediately and kicks the drive in the background. The server uses
  `startPool`, so "pool not started" can only fire before `/api/start`.
- The handle (`PoolRun`) gains `accept` (synchronous acceptance: `answered`
  event + queued-answer record, throws on an invalid answer) and `settled`
  (promise for the next settle). `resume`/`approve`/`reject` keep their old
  shape: rejection at acceptance for invalid answers, resolution at the settle
  after the answer is processed, so existing engine tests keep their timing.
- Queued-answer store: `runs/queued-answers.json`, atomic tmp+rename writes,
  records `{seq, ticketId, kind, approve?, note?, at, processedAt}`. Separate
  from PoolState per ADR-0004. Unprocessed records load back on construction,
  which is what Issue 02's restart drain will lean on.
- Processing is the old `answerTicket` minus the `answered` event and the
  `drive()` tail; the five answer paths (resumeMerge, approveMerge,
  rejectMerge, approveReview, rejectReview) become mutate-only. The drive loop
  drains the queue at the top of each iteration (after the previous
  super-step's persist, before scheduling), and acceptance kicks a drain plus
  a fresh drive whenever no drive is in flight.
- Mid-flight pending interrupts only exist via rehydrate or via a dependent
  ticket running in a later super-step (interrupts are raised at the join), so
  the blocking-stub tests use a blocker ticket in a following super-step.

---

## Brief, written by the runner

The agent stopped without setting its own status, last seen as 'in-progress'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit.

- Stopped: 2026-08-25 22:50
- Log: `.scratch/resume-feedback/runs/01.log`
- Working tree at the stop:

```
 M .scratch/resume-feedback/issues/01-accept-process-split.md
 M engine/engine.test.ts
 M engine/engine.ts
 M engine/server.test.ts
 M engine/server.ts
?? .scratch/resume-feedback/runs/
?? engine/queued-answers.ts
```

Last lines of the log:

```
+++ /home/billy/repos/agent-console/engine/engine.ts
@@ -278,9 +278,8 @@
 driving: false,
 settledPhase: null,
 settleWaiters: [],
 answerWaiters: new Map(),
-processChain: Promise.resolve(),
 handle: undefined as unknown as PoolRun,
 onSnapshot: options.onSnapshot,
 issueRunnerPath: options.issueRunnerPath ?? join(homedir(), ".issue-runner"),
 resolverAttempts: new Map(),

[0m
[0m$ [0mbun test engine/engine.test.ts 2>&1 | tail -8
(no output)

<shell_metadata>
shell tool terminated command after exceeding timeout 300000 ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.
</shell_metadata>
[0m
Deadlock found: on the idle path, `acceptAnswer` drains synchronously before `answer()` registers the waiter, so the resume promise never settles. Fix: register the waiter before kicking processing.
Terminated                 opencode run --command "$driver" "$rel

${prompt#*'
'}" --model "$model" --auto < /dev/null
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.
