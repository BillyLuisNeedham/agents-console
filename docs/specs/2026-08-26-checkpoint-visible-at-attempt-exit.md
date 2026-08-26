---
status: ready-for-agent
adr: docs/adr/0004-accept-answers-immediately-process-at-boundary.md
---

# Spec: Checkpoint visible at attempt exit

## Problem Statement

Billy operates a pool through the Console. Tickets in the same super-step run
in parallel. When one ticket finishes into a checkpoint — it needs human input
— while a sibling is still running, the Console shows **both** tickets as
running. For the whole window between the checkpointed ticket's exit and the
slowest sibling's exit (which can be minutes), there is no red card, no
interrupt form, no red tab, no "needs input" anywhere. Billy cannot tell the
pool is waiting on him, and cannot answer the interrupt, until the sibling
happens to finish.

The cause is in the engine's drive loop: a super-step's tickets run under one
coordinated join, and the checkpoint status, the interrupt, and the snapshot
emit are all deferred until every sibling exits. The crash path already
received an at-exit snapshot emit ("record a crash at attempt exit and push a
snapshot immediately"); the checkpoint path is the same shape of problem
without the same fix.

## Solution

When an attempt exits with a terminal result — checkpoint, done, or crash —
the engine records that result into state and emits a snapshot immediately,
without waiting for its siblings. For a checkpoint, the interrupt is raised at
attempt exit too, so the moment the ticket stops:

- the ticket's card turns red ("checkpoint" word, pulsing border, red dot),
- the interrupt form is available in the card and in Detail,
- the tab title and favicon turn red "needs input".

The still-running sibling is untouched: it runs to its own exit exactly as
today. If Billy answers the interrupt while the sibling is still in flight,
the answer lands in the queued-answer channel and is processed at the next
super-step boundary, per ADR-0004 — the card shows the queued waiting state as
it already does.

Same engine semantics, truthful timing.

## User Stories

1. As a pool operator, I want a checkpointed ticket's card to turn red the
   moment its attempt exits, so that I know the pool needs me without waiting
   for unrelated tickets to finish.
2. As a pool operator, I want the interrupt form available as soon as the
   checkpoint lands, so that I can read the brief and answer immediately.
3. As a pool operator, I want the tab title and favicon to show "needs input"
   as soon as any ticket checkpoints, so that I notice from another window.
4. As a pool operator, I want the still-running sibling's card to keep showing
   running, so that one ticket's checkpoint never misrepresents another's
   state.
5. As a pool operator, I want my answer to an early-raised interrupt to be
   accepted immediately and queued for the next super-step boundary, so that I
   can answer when I see it rather than when the engine is ready.
6. As a pool operator, I want the queued answer's waiting state to show on the
   checkpointed card while the sibling still runs, so that I can tell my
   answer landed.
7. As a pool operator, I want a ticket that finishes `done` while siblings
   still run to show green immediately, so that the board is truthful about
   progress, not just about stops.
8. As a pool operator, I want the super-step boundary join to remain correct
   after at-exit joins, so that no result is applied twice or lost.
9. As a pool operator, I want a reconnecting client or a state poll during the
   window to see the checkpoint, so that the truth does not depend on which
   snapshot I happen to hold.
10. As a pool operator, I want a ticket blocked by a checkpointed ticket to
    keep showing its blocked-by-checkpoint notice during the window, so that
    dependents stay as informative as they are today.

## Implementation Decisions

- **Engine, drive loop.** When an attempt exits with a terminal result
  (checkpoint, done, crash), its update is applied to pool state at exit and a
  snapshot is emitted immediately. A terminal status is an idempotent fact
  once the attempt has exited, so this relaxes the "state join is the single
  writer of pool state" rule for terminal per-ticket results only.
- **Boundary join becomes skip-if-present.** The super-step boundary join
  skips results already joined at exit; applying the same terminal update
  twice must be a no-op. Non-terminal bookkeeping that genuinely requires all
  siblings (anything computed across results) stays at the boundary.
- **Interrupt raised at attempt exit.** A checkpoint's interrupt enters pool
  state when the attempt exits, not at the boundary. This is what turns the
  card, tab, and favicon red during the window, and what makes the interrupt
  answerable early.
- **Answering early is queued, not processed.** ADR-0004 stands unchanged: an
  answer accepted while a super-step is in flight rides the queued-answer
  channel and is processed at the next boundary. Raising an interrupt is not
  processing an answer, so there is no conflict with the ADR.
- **Phase logic unchanged.** The phase computation already tolerates pending
  interrupts during `running`; no change needed.
- **No server changes.** The server enrichment already renders whatever the
  snapshot carries; once the snapshot carries the checkpoint and interrupt
  early, the wire is correct.
- **No UI changes.** The card, Detail, tab, and favicon already render
  checkpoint and pending-interrupt states correctly (including the
  blocked-by-checkpoint notice on dependents); the bug was that the snapshot
  never carried them during the window.
- **No glossary or ADR changes.** No term's meaning shifted; the fix extends
  the precedent set by the crash-at-exit emit rather than making a new
  trade-off.

## Testing Decisions

- **Seam: the engine's drive loop, driven by a stub harness** — the same seam
  the existing engine tests already use. One seam, no new ones. Tests assert
  on the emitted snapshot stream and state transitions (external behavior),
  never on loop internals.
- **The core test:** a super-step of two tickets where one checkpoints quickly
  and the other runs slowly; assert a snapshot arrives before the slow sibling
  exits showing the fast ticket at `checkpoint` with its interrupt pending and
  the slow ticket still `in-progress`.
- **Done rides along:** same shape with a fast `done` — assert the early
  snapshot shows it done.
- **Idempotent boundary join:** after at-exit joins, the boundary produces no
  duplicate or divergent state, and the final snapshot sequence is coherent.
- **Early answer:** an answer submitted during the window is accepted, appears
  as a queued answer, and is processed at the next boundary (covered by the
  existing queued-answer tests plus one wiring test through the new timing).
- **Prior art:** the crash-at-exit snapshot test added with "engine: record a
  crash at attempt exit and push a snapshot immediately" in the engine test
  suite — the new tests sit beside it and share its harness-stubbing pattern.

## Out of Scope

- Any change to super-step scheduling, node execution order, or the merge
  queue.
- Pausing or cancelling siblings when a checkpoint lands — the sibling runs to
  its own exit by design.
- UI, CSS, or server changes of any kind.
- Changes to queued-answer processing semantics (ADR-0004).
- Reconnect/backfill behavior beyond what falls out of emitting truthful
  snapshots earlier.

## Further Notes

- Origin: observed operating the resume-feedback queue on 2026-08-26 — one
  ticket checkpointed while a sibling ran, and the Console showed both as
  running until the sibling exited.
- The crash-at-exit emit (commit "engine: record a crash at attempt exit and
  push a snapshot immediately") is the precedent this spec generalises to all
  terminal results.
