# Not ported to conformance

The visible behaviour the conformance suite does not pin as a case, each with why and what stands in for it
(ADR-0036). Rows are the inventory's (`docs/research/rust-port/test-inventory.md`), named by the engine test they
came from. A row listed here is either not expressible from outside a server process yet, or the TypeScript
server diverges from the intended behaviour, in which case the case pins what it can and the entry says what is
left loose.

Each conformance ticket adds a section for its own scope.

## `attempts`: headless launch (C11)

Every one of C11's 68 rows is a passing case under `conformance/cases/attempts-argv.test.ts`,
`attempts-prompt.test.ts` and `attempts-launch.test.ts`. What is left:

- **TypeScript divergence: `effort_applied` on a tab-open fallback.** Gap entry (engine/attempt-run.ts:514-531),
  case "a headless fallback on opencode carries the effort the TUI would drop" in `attempts-uncovered.test.ts`.
  A terminal-backed opencode Ticket with effort `minimal` whose fake herdr refuses `tab.create` falls back to
  headless, and its argv carries `--variant minimal`, yet the spawned event records `effort_applied: false`.
  The cause: `recordSpawned` decides the mode from its `terminalError` argument, and the tab-open fallback,
  `headless(opened)`, passes its error on `terminal.error` instead, so the run counts as interactive. The
  wrapper-send fallback passes `terminalError` and is right. The case pins every other fact and accepts any
  boolean for `effort_applied`. Intended: `true`, since the batch argv carried the effort. Once the reference
  server is fixed, the case pins `true`. Rust unit test: the spawned payload's mode is batch for every
  headless fallback, whichever way the fallback learned of the failure.
- **Gaps left to the other `attempts` tickets.** The area's "no test covers yet" entries on terminal-backed
  launch (prompt never landed after the wrapper, the managed-settings and workspace trust dialogs, the readiness
  bound, `pane.report_agent` and `pane.release_agent`, `terminal_id` on the spawned event) are C12's scope, and
  the stderr-in-the-log-not-the-Stream entry is C13's. The headless git-checkout entry (harness, model and
  commitSha on the spawned event) is already pinned by `cases/disk.test.ts` and `attempts-argv.test.ts`.
