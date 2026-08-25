<!-- state: id=02 blocked-by=01 status=ready -->
# 02: Queued answers survive restart; resume is idempotent

**What to build:** A queued answer can never be silently lost or confusingly doubled. When the pool server restarts and rehydrates, it loads the queued-answer store and drains any unprocessed answers as part of recovery, with no manual redo. Answering an interrupt that already has a queued or accepted answer (same ticket, same interrupt identity) is idempotent: the request returns 202 again and no duplicate `answered` event or queued record is written — so a client that timed out and retried is safe. An answer for a ticket with no pending interrupt and no matching accepted answer still 400s, as today.

**Blocked by:** 01: Accept/process split — answers acknowledged with 202, processed at the super-step boundary

**Status:** ready-for-agent

- [ ] Killing the server with answers queued, then restarting, drains the queued answers automatically after rehydrate — each takes effect without being resubmitted
- [ ] A duplicate answer for the same ticket and interrupt returns 202 and writes no second `answered` event and no second queued record
- [ ] An answer for a ticket with no pending interrupt and no matching accepted answer returns 400 as today
- [ ] Engine seam tests cover restart-drain; server seam tests cover idempotent retry and the genuine 400; existing suites pass
