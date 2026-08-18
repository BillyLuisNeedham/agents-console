<!-- state: id=14 blocked-by=10,11,12,13 status=done -->

# 14 — Review the Detail panel and resizable drawers iteration

## What to build

Nothing new. This Issue reviews the work of Issues 10 to 13 against the spec (.scratch/console/spec-detail-and-resizable-drawers.md) and the repo's standards, using the /code-review skill. The fixed point for the review is the commit immediately before Issue 10's commit. The review checks both axes the skill provides: Standards (does the code follow the documented standards) and Spec (does the code match what the spec asked for).

This Issue has no fix authority. If the review finds problems, this Issue becomes a checkpoint and the brief carries the disagreement: each finding, which acceptance criterion or standard it touches, and what would settle it. Billy decides what happens next. If the review comes back clean, this Issue is done.

## Acceptance criteria

- [x] Review covers every commit from Issue 10's commit onward, against the spec and the standards
- [x] Every acceptance criterion of Issues 10, 11, 12 and 13 is checked off as genuinely true in the code, or named in the brief as not met
- [x] A clean review ends this Issue as done; any finding ends it as checkpoint with the disagreement written into the brief
- [x] No code changes are made by this Issue beyond its own bookkeeping

## Blocked by

- 10 — Detail panel skeleton
- 11 — Detail content: channels and raw state
- 12 — Interrupts answerable from the Detail
- 13 — Resizable bottom drawers

## Review

Fixed point `67d40bd` (the commit immediately before Issue 10's commit `aeb4ab5`); diff `git diff 67d40bd...HEAD` covering aeb4ab5, 2215851, 527d7a2, 04f6a61. Two review axes ran as parallel sub-agents per the /code-review skill. Independently confirmed: `bun test` 82 pass, `tsc --noEmit` clean, and all four verify scripts (verify-10 through verify-13) pass against the live dev server on :2024, so the live-behaviour criteria are observed, not inferred. All 23 acceptance criteria of Issues 10 to 13 are genuinely true in the code.

## Standards

No hard violations of any documented standard. The Detail projection is pure at the seam; the panel is a third flex child with no overlay or transform; the clamp is a pure 15/80vh function; height and selection live at module scope with no localStorage; the interrupt form is shared, not duplicated; the backend is untouched; new identifiers follow the CONTEXT.md glossary. Baseline smells (all judgement calls, none hard):

1. Repeated Switches / Duplicated Code: the `channel.kind` if-cascade now appears a third time in `renderDetailChannel` (view.ts:893), alongside `renderCardChannel` and `renderInspectorChannel`. Branches differ only in wrapper class and the 8-line truncation. A shared per-kind renderer with a truncate/class knob would do.
2. Duplicated Code (minor): `height:${drawersHeight}vh` appears four times across the two drawer renderers and `applyDrawersHeight`; one `drawersHeightStyle()` helper would centralize it.
3. Duplicated Code (weak): `projectNodeStateSlice` (project.ts:631) loops NODE_CHANNELS much as `projectNodeChannels` (project.ts:496) does; the ownership lookup could be shared.
4. Divergent Change (weak, suppressed): project.ts gains four unrelated helpers, but Issue 13's notes cite the documented `zoomAtCursor` precedent for the seam location, so the repo standard endorses it.
5. Mysterious Name (weak): `stateSlice` is vague until the doc comment; `ownedChannels` would name the concept.

## Spec

No missing requirements, no scope creep. Every addition maps to a User Story or Implementation Decision; the Out of Scope list is respected (no persistence, inline card form untouched, no backend changes, view module not split). Criterion verdicts: 23/23 genuinely true, with live verification for the streaming, resume and resize behaviour. Nits (none blocking):

- US 3 lists the status vocabulary as "idle, ran, active, next, interrupted", but `statusLabel` renders the active status as "running" (view.ts:577-583), inherited from the cards. All five states are computed correctly; only the label word differs from the spec's list.
- Selection also survives a thread switch: the Detail stays open and projects the same node id against the new thread's run. The spec neither asks for nor forbids this; recorded as unspecified behaviour.
- For a deadlocked node the Detail's channels inherit the card selection, which filters tickets to pending and adds a hint channel, not literally the full channel, though the raw-state slice below shows everything and the spec's Implementation Decisions sanction reusing the existing per-node channel selection.

Summary: Standards has 5 findings, all judgement-call smells; worst is the third copy of the channel-kind cascade. Spec has 0 missing, 0 creep, 3 nits; worst is the "running" versus "active" label wording.

## Brief

1. Completed: the full two-axis review of commits aeb4ab5 through 04f6a61 against the spec and the repo standards, written above. All 23 acceptance criteria of Issues 10 to 13 verified as genuinely true, by reading the code, by the 82 seam tests, and by re-running verify-10 through verify-13 against the live dev server (all pass). No code changed; this Issue touched only its own file (and committed Issue 10's orphaned done-bookkeeping).
2. What the human has to do: the review is substantively clean but not literally finding-free, and this Issue has no fix authority. Decide on the five Standards smells and the three Spec nits above. The only ones worth a decision are the channel-kind cascade triplication (extract a shared renderer, or accept per the truncate-versus-full intent) and the "running" label (rename to "active" to match the spec, or amend the spec's vocabulary). Everything else is recorded for the deferred view-module split.
3. After deciding: either close this Issue as done (if all findings are accepted or deferred) or queue follow-up Issues for whichever findings you want fixed.

## Decision

Billy closed the review as done on 2026-08-18. The five Standards smells and the deadlock/selection nits are accepted and deferred to the planned view-module split. The "running" versus "active" wording is settled by amending the spec's US 3 vocabulary to "running", matching `statusLabel`.
