# Agent-grader baseline

`agent-grader-baseline.jsonl` holds every `graded` and `selected` event from the first real
`verify: 2` runs on this machine, taken from the `jev-integration` pool on 2026-09-20 before the
Jev grader existed. Each line is the engine's event as written, plus a `ticket` field naming the
Ticket it came from.

- `conv-1-spawn-1`: the two `engine/jev.ts` port fixes (attempts 4 and 5).
- `conv-1-spawn-2`: the Jev grader build itself (attempts 1 and 2).

Workers and graders all ran on `opencode` with `opencode-go/deepseek-v4.1-flash`, grading from
the pool's `verify.md`.

The pattern worth noting: all four Grades are `9 / pass`, so both rounds tied at a 0 margin and
went to the head-to-head. The agent grader did not separate the attempts. That makes these
four events the point of comparison for the Jev-graded rounds, whose spread the bench put
between 7.2 and 8.4 on passes. It says nothing about which grader is more accurate: these are
two Tickets, not a benchmark.
