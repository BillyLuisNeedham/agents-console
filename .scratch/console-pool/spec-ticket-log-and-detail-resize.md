# Spec: Ticket log and resizable Detail

Status: agreed in grill session (three rounds, all decisions confirmed), written locally (no tracker). Apply `ready-for-agent` if published later.

Follow-up to `spec-console-flight-fixes.md`. Domain language per `CONTEXT.md`; storage format per `docs/adr/0002-ticket-log-storage.md`.

## Problem Statement

Billy drives a pool from the Console and cannot see what a ticket is doing:

1. Clicking a ticket card opens its Detail, but the Detail shows only status, blockers, and a pending interrupt. When a ticket is running — or ran and did something unexpected — there is no way to watch its progress or read what the harness actually did without leaving the Console and tailing `runs/<id>.log` by hand in a terminal.
2. When a ticket re-runs (crash retry, review reject), its previous log is silently overwritten, so the record of what already happened is destroyed.
3. The Detail panel is fixed at 340px. Reading anything long in it — a Brief, a log — means scrolling a narrow column while most of the window shows canvas the reader isn't using.

## Solution

Every ticket gains a **ticket log**: clicking the ticket shows a timeline of its life — scheduled, spawned, exited, merged, interrupted, one row per attempt — above the raw harness output of the selected attempt. While an attempt runs, the log follows the tail live. Every attempt's output is kept, so the ticket's whole history is readable from its Detail.

The **Detail** becomes resizable: drag its left edge to widen it, or toggle it to fill the Console window while keeping the toolbar. The width is remembered across reloads.

## User Stories

Timeline and raw log:

1. As Billy, I want clicking a ticket card to show its timeline in the Detail, so that I can see what is happening with it at a glance without opening a terminal.
2. As Billy, I want one timeline row per attempt, so that a ticket that took three tries shows all three tries.
3. As Billy, I want each attempt's lifecycle events listed — scheduled, spawned, exited with code and marker status, merged, merge-conflicted, interrupted, answered — so that I can reconstruct exactly what the pool did to this ticket.
4. As Billy, I want the raw harness output of the selected attempt below the timeline, so that I can read the whole log of that ticket in one place.
5. As Billy, I want clicking a different attempt row to switch the raw log to that attempt, so that I can compare what changed between tries.
6. As Billy, I want the log of the currently-running attempt to update live and follow the tail, so that I can watch a ticket work as it happens.
7. As Billy, I want the log to stop auto-scrolling when I scroll up, and resume when I scroll back to the bottom, so that following the tail never yanks away what I'm reading.
8. As Billy, I want the log pane to stay on the attempt I selected when a new attempt starts, so that reading attempt 1 while attempt 2 runs is undisturbed — with the timeline showing the new attempt arriving.
9. As Billy, I want the running attempt marked in the timeline, so that I always know which row is live.
10. As Billy, I want every attempt's raw log kept on disk, so that a re-run never destroys the record of what already happened.
11. As Billy, I want the current attempt to keep the long-standing log paths, so that my terminal habits and the crash interrupt's log-path references keep working.
12. As Billy, I want resolver runs to appear as attempts too, so that merge-conflict resolution is part of the ticket's visible history.
13. As Billy, I want ANSI escape codes stripped from the served log, so that the raw output reads as clean text rather than control sequences.
14. As Billy, I want long logs to load tail-first with a "load earlier" affordance, so that a multi-megabyte log opens fast and is still fully readable.
15. As Billy, I want a ticket that has never run to show its spec text with a "no attempts yet" marker, so that clicking any ticket always tells me something useful.
16. As Billy, I want tickets from before this feature existed to still show attempt rows reconstructed from their existing log files, so that my in-flight pool's history isn't blank.
17. As Billy, I want the ticket log to stay live across SSE snapshot rebuilds — scroll position and selected attempt preserved — so that a status change elsewhere in the pool doesn't reset what I'm reading.
18. As Billy, I want the pool-level log drawer to stay exactly as it is, so that the coarse pool-wide narrative remains available alongside the per-ticket view.

Resizable and fullscreen Detail:

19. As Billy, I want to drag the Detail's left edge to make it wider or narrower, so that the panel fits what I'm reading.
20. As Billy, I want the width clamped between a readable minimum and most of the window, so that I can't drag it into uselessness.
21. As Billy, I want my chosen width remembered across reloads, so that I set it once.
22. As Billy, I want a fullscreen toggle on the Detail, so that a long log or Brief can take the whole window.
23. As Billy, I want fullscreen to cover the canvas and the bottom drawers but keep the top toolbar, so that I keep thread control (start/resume) while reading.
24. As Billy, I want Esc and the toggle button to exit fullscreen, so that leaving is as easy as entering.
25. As Billy, I want exiting fullscreen to restore my dragged width, so that fullscreen is a temporary excursion, not a reset.
26. As Billy, I want the Detail — including a pending interrupt form — to stay live in fullscreen, so that I can still answer an interrupt from the expanded view.

## Implementation Decisions

- **Engine emits structured events.** At each lifecycle point the engine already passes through — scheduled in a super-step, spawned, exited with code and marker status, merged, merge-conflict, resolver run, checkpoint interrupt with Brief, crash interrupt with log path, deadlock raised/cleared, interrupt answered, review-reject reset — it appends one JSON line to the ticket's events file in the pool's runs directory: timestamp, attempt number, event kind, small payload. See ADR 0002 for why this beats filtering the pool log or deriving from checkpoints.
- **Attempt rotation on re-run.** When the engine spawns a ticket whose raw log already exists, the existing files rotate to attempt-numbered names before the new attempt writes. The long-standing paths always hold the current attempt, so the crash interrupt's log-path body and manual tailing keep working untouched. Resolver logs rotate the same way and count as attempts.
- **Two new server endpoints**, scoped to the pool's runs directory: one returns a ticket's parsed events (whole file — it stays small), one returns a byte range of an attempt's raw log with ANSI escapes stripped, plus the total size and the list of attempts. Both are fetched lazily for the selected ticket and refetched when a new SSE snapshot arrives — the snapshot cadence doubles as the liveness signal, so no per-ticket streaming is built.
- **Backfill on read, not on write.** Pools without events files are not migrated. When the server answers the events endpoint for a ticket with no events file, it reconstructs one attempt row per existing log file from file presence and modification time, marked as reconstructed. New pools write events from the start; old pools degrade gracefully.
- **Ticket Detail layout.** Header (id, status, title), then the pending interrupt form if one exists, then the timeline (attempt rows with their events), then the raw log pane for the selected attempt. A never-run ticket replaces timeline and log with the ticket's spec text and a "no attempts yet" marker. The interrupt form's position at the top is unchanged — the log takes the space below it.
- **Timeline and log state live in the projection's view model.** Attempt selection, which attempt is live, and per-timeline rendering are derived in the pure projection, following the established seam. UI-only state that must survive rebuilds — scroll pin, selected attempt, read offsets — lives in module-scope vars, the same idiom as drawer height and interrupt note drafts.
- **Detail resize copies the drawer pattern.** A drag handle on the Detail's left edge adjusts a module-scope width var, clamped (minimum 340px, maximum about 80vw) by a helper alongside the existing drawer clamp, persisted to a single global localStorage key (not per pool). The width is applied as inline style per render, so the full-DOM rebuild idiom is untouched.
- **Fullscreen is a Detail mode, not browser fullscreen.** A toggle on the Detail header sets a class that fixes the Detail over the content area below the toolbar — canvas and drawers covered, toolbar visible and live. Esc, the toggle, or selecting another card exits; the drag handle is inert while fullscreen; exiting restores the dragged width. All live behavior (SSE rebuilds, interrupt forms, log tailing) is unaffected because the Detail never unmounts.
- **No changes to the pool-level log channel or drawer.** The per-ticket log is additive; the coarse pool narrative stays.

## Testing Decisions

- Only external behavior is tested, never implementation details — same bar as the parent specs.
- **Projection seam (primary).** All new view-model logic — timeline rows from events, attempt selection, running-attempt marking, reconstructed-attempt rendering, never-run fallback, Detail width clamp — is pure and tested at the established projection seam with snapshot/event fixtures. Prior art: the existing projection tests.
- **Server seam.** Bun tests start the real pool server against temp pools and exercise both endpoints: event parsing, byte-range log reads (offset, growth between reads, total size), ANSI stripping, and the reconstructed-attempt backfill for an events-less ticket. Prior art: the engine's temp-pool server tests.
- **Engine seam.** Temp-pool engine tests assert events are appended at the lifecycle points (a scripted ticket run leaves the expected event kinds in order) and that re-running a ticket rotates the old logs to attempt-numbered names while the long-standing paths hold the newest attempt. Prior art: the engine's scripted-pool tests.
- **Manually verified in the proving flight:** drag feel and clamping, fullscreen enter/exit, live-tail following and scroll-pin behavior, timeline rendering against the real console-pool.

## Out of Scope

- ANSI color rendering in the log view (stripped, deliberately; can be revisited).
- Searching or filtering within a log.
- Per-pool width persistence, mobile/narrow-window layouts, browser fullscreen API.
- Changes to the pool-level log drawer, the bottom state inspector, or the legacy LangGraph graph.
- Migrating or rewriting existing pools' runs directories — backfill is read-time only.
- Push, pull requests, or any publishing — the standing line.

## Further Notes

- The founding spec's harness-execution decision already mandates per-ticket logs in the runs directory "so log-reading habits carry over" — this spec is the Console half of that user story.
- The crash interrupt's body is the ticket's log path; keeping that path pointed at the current attempt means a crash card and the ticket's Detail tell the same story.
- Reconstructed attempt rows for pre-feature tickets are approximate by design (file presence and mtime only); ADR 0002 records why the events format is nonetheless treated as stable from first write.
