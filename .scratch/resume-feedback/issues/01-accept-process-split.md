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
