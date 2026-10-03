# Accept interrupt answers immediately, process them at the super-step boundary

Answering an interrupt used to mean the HTTP request hung until the whole drive settled, queued answers were invisible, and `/api/resume` 400ed whenever a super-step was in flight. We split answering into two moments: **acceptance** (record the `answered` event, persist a queued-answer record, return 202 immediately) and **processing** (apply the answer and continue the drive), which happens immediately when the pool is idle and otherwise at the next super-step boundary.

Immediate processing mid-super-step was considered and rejected: the super-step join rebuilds state from a pre-flight snapshot and would silently undo the answer; an immediate spawn runs in the main checkout and races in-flight tickets' merges; and there is no reentrancy guard on `drive()`. For the same reason, queued answers live in their own persisted store rather than in `PoolState`, where the join would clobber them — and so a server restart cannot silently lose them.

**Consequences**: an answered ticket never spawns faster than the next super-step boundary while attempts are in flight; resume is idempotent, so a retried answer after a client timeout returns 202 again rather than a misleading 400.

**Amendment (issue #161, ADR-0032)**: the Console now answers over the `resume` request on its WebSocket, which runs the same function as `POST /api/resume`. Acceptance works as before. The socket's reply carries no snapshot: the delta that shows the accepted answer, its Queued answer, goes out to every tab ahead of the reply. The Console therefore shows the answer as soon as it is pressed and takes it back only if the reply is a refusal. The HTTP route and its 202 are unchanged for other callers.
