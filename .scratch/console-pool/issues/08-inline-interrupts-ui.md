<!-- state: id=08 blocked-by=02,07 status=done -->

# 08 — Inline interrupts in card and Detail

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

Every interrupt kind answerable from the UI. A card whose ticket has a pending interrupt shows it inline — one form shape across the six kinds (ticket checkpoint, merge-conflict approval, resolver-failure/manual merge, harness crash, deadlock, final Review) with a kind-specific body: a checkpoint shows the Issue's Brief, a crash shows the log path, a conflict approval shows the resolver's resolution, and so on. The same interrupt renders at full size in the card's Detail, and both stay live as snapshots stream. Answering (with an optional note where the kind supports one) posts resume-with-answer and the pool continues with no separate continue step. Pending interrupts are visible at a glance across the canvas, so Billy can see everything waiting on him.

## Acceptance criteria

- [x] A pending interrupt renders inline on its card with a kind-specific body
- [x] The same interrupt renders at full size in the Detail; both views stay live across snapshots
- [x] Answering an interrupt resumes the pool automatically — one answer, one action
- [x] Kinds that support a note append it to the Issue file via the engine's resume path
- [x] All six interrupt kinds are renderable and answerable
- [x] Cards with pending interrupts are visually distinguishable from running and done cards
- [x] Covered by projection tests over snapshots carrying each interrupt kind

## Blocked by

- 02 — Interrupt engine
- 07 — Server and pool projection UI

---

## Brief, written by the runner

The agent stopped without setting its own status, last seen as 'in-progress'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit.

- Stopped: 2026-08-20 21:00
- Log: `.scratch/console-pool/runs/08.log`
- Working tree at the stop:

```
 M .scratch/console-pool/issues/08-inline-interrupts-ui.md
?? .scratch/console-pool/runs/
```

Last lines of the log:

```
How does the existing code handle this for other inputs? Let me think about how the current app handles the edgeMode toggle — it's module scope, not tied to render. And drawer height is module scope.

For the interrupt note textarea, I should preserve the draft across re-renders using module-scope state keyed by ticket id. That way a note being typed survives snapshot re-renders.

Let me design: a module-scope `draftNotes: Map<string, string>` in view.ts. When rendering a note textarea, initialize its value from `draftNotes.get(ticketId) ?? ""`. On input, update `draftNotes`. On answer, the note is sent and the draft cleared (when the interrupt resolves).

But wait — the `h` helper doesn't easily support value binding + oninput. I can create the textarea and attach listeners manually.

Actually, since the whole DOM rebuilds, and I want the textarea to keep focus/typing... this is tricky. Rebuilding DOM on every snapshot will steal focus from a textarea being typed in. But snapshots only stream when state changes (a super-step completes, an interrupt is answered, etc.), which is infrequent when quiescent. When quiescent (waiting on you), no snapshots stream, so the user can type freely. When running, they wouldn't be answering an interrupt (interrupts only appear when quiescent). So focus-stealing is not a practical problem for the note entry: the user answers interrupts while the pool is quiescent, which doesn't stream snapshots.

But to be safe, I'll preserve draft notes in module scope keyed by ticket id, so a re-render doesn't wipe the typed text (even if rare).

Let me now design the answer flow in main.ts:
- Add `onAnswer` handler that calls `client.answer(ticketId, action, note)` and on success updates snapshot (the SSE will also push the new snapshot).
- The `answer` returns a snapshot; I should set it and re-render. But the SSE stream also pushes. Either way, fine.

Now, let me consider: should the answer form be in `project.ts` (the projection) or `view.ts` (DOM)? Per the test convention: "The UI projection is tested as pure functions over snapshot fixtures." So the form config (kind → title, note support, actions) belongs in `project.ts` as a pure function `interruptForm`, and is tested over fixtures. The DOM rendering of the form goes in `view.ts`.

Now let me reconsider the "six kinds" and Issue 09 dependency. Since Issue 09 adds the `review` kind to the engine and is blocked by 08, I should make `interruptForm` handle `review` so the UI is ready. But the engine type `InterruptKind` doesn't include review yet. In the UI projection, `PoolInterrupt.kind` is `string` (not the narrow union), so I can handle "review" without type issues. Good — the UI `PoolInterrupt` already types `kind: string`.

Let me verify the client `answer` and server `answer` support all the actions. Yes, `resume|approve|reject`.

Now, let me look at how to make the card visually distinct and check styles.css.

Let me look at the styles.cs
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.

---

## Notes

Findings from the restarted run (the crashed run left no code; the working tree
was clean apart from this Issue):

- The previous run's log tail is sound and was adopted: `interruptForm` lives in
  `project.ts` as a pure function (tested over snapshot fixtures), the DOM form
  lives in `view.ts`, note drafts are module-scope keyed by ticket id.
- Engine interrupt kinds on the wire (engine/engine.ts:64): `checkpoint`,
  `crash`, `deadlock`, `merge-conflict`, `merge-approval`. The spec's
  resolver-failure/manual-merge kind is a `merge-conflict` whose body carries
  the resolver's attempt; the UI does not need to distinguish it.
- The sixth kind, `review`, is Issue 09's to add to the engine. `interruptForm`
  handles it now (approve/reject + note); 09 still has to attach the review
  interrupt to a card in the projection (likely the REVIEW utility card) once
  it fixes the engine shape.
- The engine appends the note to the Issue file on every answer path
  (`answerTicket`, `resumeMerge`, `approveMerge`, `rejectMerge`), so every kind
  supports a note.
- Client and server already support `resume|approve|reject` with an optional
  note (client.ts `answer`, server.ts `/api/resume`); no wire changes needed.
- One answer resumes the pool: `answerTicket` calls back into `drive`, and the
  POST response plus the SSE stream both carry the new snapshot.
- Focus: snapshots stream on every state change, and siblings keep running
  while an interrupt waits (spec story 20), so a rebuild can land mid-typing.
  The note text survives via the draft map; focus and cursor are restored
  after rebuild by matching the textarea's data-note-key.

Two-axis review ran clean after a tidy-up pass:

- Standards: the switch became the `INTERRUPT_FORMS` table, dead generality
  dropped (the always-true note flag, the unused default tone, the unused
  form kind), and interrupt+form collapsed into one `InterruptView` on the
  card and Detail view models.
- Spec: one flag worth repeating for 09. `review` maps to approve/reject in
  the form, matching spec stories 29/30. Today those actions only reach
  merge logic when the kind is `merge-approval`; 09 defines what review
  approve/reject do in the engine and attaches the review interrupt to a
  card (likely the REVIEW utility card) in the projection.
- Judgement call: the note placeholder says "appended to the Issue". The
  CONTEXT glossary avoids "issue" for tickets, but the runner's own
  vocabulary names the pool files Issue files, and the text refers to the
  file on disk.

Verified: `bun test` (87 pass, engine + server + ui), `tsc --noEmit` in both
the repo root and ui/, `vite build` in ui/.
