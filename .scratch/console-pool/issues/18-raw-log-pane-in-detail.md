<!-- state: id=18 blocked-by=16,17 status=done -->

# 18 — Raw log pane in the Detail

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`.

## What to build

The ticket Detail gains a raw log pane below the timeline: the full harness output of the selected attempt, readable end to end. A new server endpoint returns a byte range of an attempt's raw log (from an offset, reporting the total size and the list of attempts), with ANSI escape sequences stripped server-side so the output reads as clean text. Clicking an attempt row in the timeline switches the pane to that attempt. A ticket that has never run shows its spec text with a "no attempts yet" marker in place of timeline and log, so clicking any ticket always tells you something useful. This ticket is static: the pane fetches on selection; live tailing is ticket 19.

## Acceptance criteria

- [x] The log endpoint serves content from a byte offset, reports total size, strips ANSI escapes, and lists the ticket's attempts (implement and resolver)
- [x] The ticket Detail renders the raw log pane below the timeline, showing the selected attempt
- [x] Clicking an attempt row switches the pane to that attempt's log
- [x] A never-run ticket shows its spec text with a "no attempts yet" marker instead of timeline and log
- [x] Older attempts' rotated logs are readable through the same pane via the attempt list
- [x] Server tests cover range reads, ANSI stripping, and the attempt list; projection tests cover attempt selection and the never-run fallback
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 16 — Per-ticket event timeline (the timeline the rows are selected from)
- 17 — Attempt log retention (rotated logs the attempt list names)

## Notes

- Byte-range reads keep large logs cheap: the endpoint never has to serve a whole multi-megabyte file in one response, and ticket 19's tailing reuses the offset contract for growth between reads.

---

## Notes

Implemented on pool/18.

- Server: `GET /api/log?ticket=<id>&attempt=<n>&offset=<bytes>` returns `{content, offset, nextOffset, totalSize, attempts}`. Content is a byte range of the attempt's raw log, ANSI-stripped server-side; `nextOffset` pages forward and `totalSize` marks the end, so the offset contract doubles as ticket 19's growth signal. `attempts` lists implement/resolver/reconstructed rows with their log files and a `current` flag (the latest of each kind holds the well-known path; older attempts their rotated `attempt-N` names).
- The events endpoint now also returns the ticket's `spec` text (issue body after the title heading), which feeds the never-run fallback in the Detail.
- UI: the Detail renders the raw log pane below the timeline; clicking an attempt row selects that attempt and fetches its log. A never-run ticket shows the spec text with a "no attempts yet" marker instead of timeline and log. Attempt selection and the never-run fallback are pure projection (`selectLogAttempt`, `projectLogPane`), tested at the projection seam; fetched content and the selected attempt live in module-scope vars so full-DOM rebuilds from live snapshots never drop them.
- 176 engine/server/fleet tests + 68 UI tests pass; `tsc --noEmit` (both) and `vite build` clean. Smoke-checked the endpoint against a real temp pool: ANSI stripped, ranges served, rotated older attempt readable via the attempt list, events carry spec.

## Review pass (code-review skill)

Two findings from the review, both addressed:

- UTF-8 split across a chunk boundary: `readLogRange` used to decode each 64KB slice independently, so a multi-byte char straddling the boundary decoded as U+FFFD and the corruption persisted in the pane. Now `utf8End` trims the raw slice at a char boundary and `nextOffset` resumes from the trimmed end, so the next read brings the char back whole (pinned by a server test).
- Duplicated `logState` reset in main.ts: extracted `resetLogPane()`, used by the deselect path.

Deferred by design (ticket 19's job, per this issue's "static pane" scope): tail-first loading with a "load earlier" affordance, and refetching the log on SSE snapshots. The offset contract both build on is in place.
