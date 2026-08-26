<!-- state: id=02 blocked-by=01 status=ready -->
# 02: Checkpoint interrupt raised at attempt exit

**What to build:** A checkpoint's interrupt enters pool state when the attempt exits, not at the super-step boundary. The moment a ticket checkpoints, its card pulses red with the interrupt dot, its Detail offers the interrupt form, and the tab title and favicon turn red "needs input" — even while a sibling is still running. An answer given during that window is accepted immediately, shows the queued waiting state on the card, and is processed at the next super-step boundary per ADR-0004. Raising the interrupt is not processing an answer, so the ADR's accept/process split is untouched. Dependents of the checkpointed ticket keep showing their blocked-by-checkpoint notice during the window, as they do today.

**Blocked by:** 01: Terminal results join pool state at attempt exit

**Status:** ready-for-agent

- [ ] A two-ticket super-step with a fast checkpoint and a slow sibling emits a snapshot before the sibling exits carrying the checkpoint interrupt pending
- [ ] The projected card for the checkpointed ticket shows the full needs-human look (red checkpoint word, pulsing border, interrupt dot, interrupt form in Detail) during the window
- [ ] `poolStatus` reports "needs input" during the window (tab title and favicon turn red)
- [ ] An answer submitted during the window is accepted, appears as a queued answer on the card, and is processed at the next super-step boundary
- [ ] A dependent ticket's blocked-by-checkpoint notice projects during the window and clears when the blocker resolves, as today
- [ ] Engine seam tests and UI projection tests cover all of the above; `bun test` and `bun run typecheck` pass, and the UI still builds
