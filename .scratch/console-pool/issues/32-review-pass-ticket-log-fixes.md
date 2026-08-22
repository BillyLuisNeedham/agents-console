<!-- state: id=32 blocked-by=31 status=done -->

# 32 — Review pass over the ticket-log fixes

Spec: `.scratch/console-pool/spec-ticket-log-and-detail-resize.md`. Mirrors tickets 22, 28, and 30's shape. Reviews ticket 31, the follow-up fixes from ticket 22's review.

## What to build

Review pass over ticket 31's diff. Run both review axes (standards plus spec, per the `code-review` skill) across ticket 31's commit, and verify each fix behaves as specified: the resolver-rotation test is stable across repeated full-suite parallel runs, log range reads handle multi-byte UTF-8 at the head of a range, the Detail width persistence test pins spec story 21, and engine/server.ts prose carries no em dashes. Re-run the full suite repeatedly enough to trust the deflake. This ticket changes no code: if the review finds problems it ends as a checkpoint and the brief carries the disagreement; a clean review ends it as done.

## Acceptance criteria

- [x] Both review axes run over ticket 31's diff and findings addressed
- [x] Each of ticket 31's fixes verified, including repeated full-suite runs for the deflake
- [x] CONTEXT.md vocabulary used correctly; avoid-words absent
- [x] Full test suite, typecheck, and build clean

## Blocked by

- 31 — Ticket-log batch review fixes (the diff under review)

## Notes

- This is a batch review, not the pool's final Review interrupt — the engine raises that itself once every ticket in the pool is done.
- Ticket 22's file carries the original findings; the deferred items (story 6 streaming cadence, story 3 wording) stay deferred and are not this ticket's scope.

---

## Notes (review record)

Fixed point: `f9fda2b` (ticket 29's merge). Diff: `git diff f9fda2b...HEAD`, exactly ticket 31's commit aec2f65, +100/-9 across engine/engine.test.ts, engine/server.test.ts, engine/server.ts, ui/src/project.test.ts, ui/src/project.ts, ui/src/view.ts. Both axes ran as parallel sub-agents per the code-review skill.

### Standards axis

No documented-standard violations. Em dashes absent from the diff and from all touched files (grep-verified). Commit message matches the `console: <imperative>` format. Tests stay at the public seams (the /api/log endpoint, the exported parseStoredDetailWidth). CONTEXT.md terms respected: Detail and attempt used correctly; no avoid-words in the diff's prose or identifiers.

Two new baseline smells, both judgement calls:

1. Duplicated Code (borderline): the continuation-byte predicate `(bytes[i] & 0xc0) === 0x80` now appears in both `utf8End` and the new `utf8HeadTrim` (engine/server.ts). Mirror-image trimmers scanning opposite directions; extraction optional.
2. Speculative Generality (mild): `utf8HeadTrim(bytes, start, end)` takes start/end but the sole call site passes `(0, bytes.length)`. Defensible as signature symmetry with `utf8End`.

### Spec axis

All four ticket 31 requirements implemented; no scope creep. One partial note, adjudicated below:

1. The head-split regression test pins only a 2-byte character (U+00E9); no test pins a head mid-sequence of a 3- or 4-byte character. Judgement: accepted. Ticket 31's letter asked for "a regression test", and `utf8HeadTrim`'s loop skips any run of continuation bytes, so the 3-/4-byte cases are handled by the same code path the test exercises. Coverage breadth, not a defect.

Verified by the spec sub-agent's reading of the code: (i) the `case`-based match removes the SIGPIPE race (no pipe remains), the exit-42 pin and loop bound are unchanged in effect, and quoted `case` patterns are literal so the match is at least as strict as the old grep; (ii) `offset = start + headTrim` with `decodeEnd >= headTrim` keeps paging monotonic, and both `openLog` and `prependLog` in ui/src/main.ts key `firstOffset` off the adjusted `chunk.offset`, so load-earlier ranges stay contiguous; (iii) `parseStoredDetailWidth` pins the exact round trip the write path performs (`String(detailWidth)` under one global key), and its read-time clamp is behaviour-identical to before because the caller already clamped and `clampDetailWidth` is idempotent.

### Fix verification

- Deflake: 1 solo full-suite run plus 6 concurrent full-suite runs (parallel `bun test` processes, the load condition that exposed the flake), 226/226 pass in every run.
- UTF-8 head: the new server test passes (offset 11 into a 2-byte char serves " tail\n", offset 12, nextOffset 18, no U+FFFD); the pre-existing tail-boundary tests still pass.
- Width persistence: the five new `parseStoredDetailWidth` tests pass at the projection seam, pinning the round trip per spec story 21.
- Em dashes: none in engine/server.ts or any touched file.
- Suite: `bun test` 226 pass / 0 fail. Root `tsc --noEmit` clean (covers engine/). `bun run build` in ui/ clean.

### Pre-existing untracked scratch, not this review's finding

`ui/src/prototype/` (untracked, created 12:08 today, before ticket 31's commit at 14:39) makes a standalone `tsc --noEmit` inside ui/ fail with 13 import errors, all in that directory. It is leftover exploration scratch, outside ticket 31's diff and outside the tracked tree; every error is confined to it. Recorded so the final Review interrupt can decide whether to delete it; this ticket changes nothing.

### Disposition

Clean review: no hard findings, no spec gaps, nothing needing Billy's decision. The smells and the test-breadth note are recorded for the pool's final Review interrupt. This ticket changes no code, and the Issue files are untracked runner state (`.scratch/` is never committed), so there is no commit for this ticket.
