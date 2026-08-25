<!-- state: id=02 blocked-by=01 status=done -->
# 02: Queued answers survive restart; resume is idempotent

**What to build:** A queued answer can never be silently lost or confusingly doubled. When the pool server restarts and rehydrates, it loads the queued-answer store and drains any unprocessed answers as part of recovery, with no manual redo. Answering an interrupt that already has a queued or accepted answer (same ticket, same interrupt identity) is idempotent: the request returns 202 again and no duplicate `answered` event or queued record is written — so a client that timed out and retried is safe. An answer for a ticket with no pending interrupt and no matching accepted answer still 400s, as today.

**Blocked by:** 01: Accept/process split — answers acknowledged with 202, processed at the super-step boundary

**Status:** ready-for-agent

- [x] Killing the server with answers queued, then restarting, drains the queued answers automatically after rehydrate — each takes effect without being resubmitted
- [x] A duplicate answer for the same ticket and interrupt returns 202 and writes no second `answered` event and no second queued record
- [x] An answer for a ticket with no pending interrupt and no matching accepted answer returns 400 as today
- [x] Engine seam tests cover restart-drain; server seam tests cover idempotent retry and the genuine 400; existing suites pass

## Notes

Findings before touching code (proven by reading, not yet by tests):

- Restart-drain needs no engine change: `startPool` always calls `startDrive`,
  and `driveLoop` runs `drainAnswers` at the first boundary before the
  ready-tickets check, so records pending in `runs/queued-answers.json` are
  drained after rehydrate. Rehydrate restores the pending interrupt from the
  checkpoint, so processing finds it. The work is a test proving it.
- Idempotency is NOT implemented: `acceptAnswer` always writes a second
  `answered` event and record while the interrupt pends, and throws when no
  interrupt pends even if a matching accepted answer exists.
- `answerWaiters` is one waiter per seq; an idempotent retry returning the
  same record would overwrite the first waiter and hang it. Needs a list.
- Plan: dedupe in `acceptAnswer` (same ticket, same interrupt kind, same
  approve payload -> return existing record, write nothing); no pending
  interrupt but a matching accepted answer in the store -> return it;
  otherwise 400 as today. `answer()` skips the waiter for already-processed
  records. Server approve/reject guard passes through when no interrupt
  pends and lets the engine decide (202 retry vs 400).

Outcome: all four criteria met. `bun test` 279 pass, `bun run typecheck`
clean. ui/ untouched, so no UI build was required.
