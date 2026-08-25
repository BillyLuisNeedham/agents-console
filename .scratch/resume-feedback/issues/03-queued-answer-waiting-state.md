<!-- state: id=03 blocked-by=01 status=ready -->
# 03: Queued-answer waiting state in snapshots and the Console

**What to build:** An accepted-but-unprocessed answer (a Queued answer, per CONTEXT.md) is visible everywhere the operator looks, with no polling. The server's snapshot projection merges the queued-answer store into every emitted snapshot, so `/api/state` and every SSE frame carry the waiting state with no change to super-step merge semantics. The ticket card shows its interrupt as answered-and-waiting; the Detail shows the same state at full size; both clear the moment the answer is processed and the interrupt leaves state. The operator can always tell "my click landed and is waiting" from "still needs my answer".

**Blocked by:** 01: Accept/process split — answers acknowledged with 202, processed at the super-step boundary

**Status:** ready-for-agent

- [ ] Snapshots (both `/api/state` and SSE frames) include queued answers, merged at emit time from the queued-answer store
- [ ] The ticket card renders a distinct answered-and-waiting state on its interrupt while the answer is queued
- [ ] The Detail renders the same waiting state, mirroring the card
- [ ] The waiting state clears on the snapshot where the answer has been processed, without any refresh or re-poll
- [ ] UI projection tests cover the waiting state and its clearing; server seam tests cover the snapshot shape; existing suites pass
