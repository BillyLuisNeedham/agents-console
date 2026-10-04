# Not ported

What the conformance suite leaves out (ADR-0036): an inventory row
(`docs/research/rust-port/test-inventory.md`) no case can express from outside
a server, or one waiting on a seam, each with the reason and the Rust unit
test it implies; and the places where a case pins less than the TypeScript
server does, or works around what it does, because that looks like a bug.
One section per contract area.

## `conversations`

Every row of ticket C16 (the lifecycle rows) is a case in
`cases/conversations-lifecycle.test.ts`. Left out or worked around:

- **A conflicted End's Interrupt is not published** (`conversations.test.ts:602`).
  `raiseInterrupt` in `engine/engine.ts` changes the state without emitting a
  snapshot, and a Conversation's End runs off the drive loop, so the
  merge-approval it raises once the resolver resolves stays out of
  `/api/state` and the socket until something else publishes: 28 s passed
  with it unseen in a run of the case. The case starts a second Conversation
  to carry it, then answers it. Intended behaviour: the snapshot carries the
  Interrupt the moment it is raised, as the Conversation's start and End
  snapshots already do. The Rust server should publish it; the Bun server
  needs the fix Decided 5 gives suspected bugs before the case can drop the
  carrier.
- **A refused empty pool leaves its lock** (`conversations.test.ts:727`,
  `pool.test.ts:206`). The server exits 1 and names the Seeded Pool opt-in, as
  the case pins, but `runs/server.pid` is left behind: the lock is taken
  before the pool loads. The case does not pin the lock either way.
  Intended behaviour (inference): a start refused at pool load releases the
  lock it took, as an orderly stop does.
- **A Notice dropped for an ended parent** (the gap at
  `engine/conversations.ts:2386-2390`) is Notice delivery, ticket C17's
  scope, and is left to it.

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

## `formats`: on-disk formats (C01)

Every one of C01's 44 rows is a passing case under `conformance/cases/formats-markdown.test.ts`,
`formats-events.test.ts`, `formats-ledger.test.ts` and `formats-home.test.ts`, and seven of the area's
eight gaps are cases there too. Left out or pinned short of the row:

- **The resolver's exit-code file** (`attempt-run.test.ts:398`). The row's pool is terminal-backed,
  where the wrapper the engine sends to the pane writes `runs/01.resolver.exitcode`. The conformance
  stub cannot finish a terminal-backed Attempt yet (its prompt is pasted into the pane, so the stub
  never learns its result path; conv-1-spawn-2-spawn-1 adds that), so the case runs the resolver
  headless and pins `01.resolver.log`, `.stream.jsonl` and `.outcome.json` only. Add the `.exitcode`
  file to the case once a terminal-backed resolver can finish. Rust unit test implied: the
  exit-code file name of a resolver run is `<id>.resolver.exitcode`.
- **A verify fan-out with a leftover base log** (`attempt-run.test.ts:374`). The row says the
  leftover `runs/01.log` keeps its bytes because Candidates rotate nothing. On the Bun server the
  pool's first launch still rotates a log from before events existed, so the leftover moves to
  `runs/01.attempt-0.log` with its bytes. The case pins what the server does: no Candidate writes
  the base log, and the leftover lands at attempt-0. The row described the Candidate's own launch,
  which rotates nothing; that stays a Rust unit test of the Candidate launch.
- **The current implement attempt after a resolver run** (seen in the case for
  `engine.test.ts:12034`). Every resolver run records a `spawned` event of its own, and
  `listAttemptLogs` in `engine/server.ts` takes the highest `spawned` attempt as the current
  implement attempt. So once a resolver has run after the last implement attempt, `GET /api/log`
  lists that implement attempt as not current and names `<id>.attempt-N.log`, a file that does not
  exist, while its log is still `<id>.log` (inference from the code, matched by a run: attempt 3 of
  02 listed `02.attempt-3.log`). Intended behaviour (inference): the current implement attempt is
  the highest attempt with an `exited` event, served from the well-known name, as
  `rotateAttemptLog` already keys on. The case pins only the resolver rows of that listing. A fix
  belongs with Decided 5's bug ticket.
- **Grader and head-to-head Ticket files byte for byte** (the gap at `engine/engine.ts:7450-7488`
  and `8635-8671`). Not written here: it needs a verify round graded close enough to call a
  head-to-head, and the two templates copied whole. It is left to the verify ticket (C21), which
  builds those rounds anyway.

Observed while writing these, not pinned (each is another area's to decide):

- A spawn proposal whose body is under 20 characters is dropped as thin, so the cases give every
  proposal a longer body.
- A Ticket's `spawn-assign` effort shows in `assignment.effort`, but `reassign.sources.effort`
  reads `unset` rather than `requested` for a spawned Ticket that has not run (`config`, C19/C20).
- An `overlaps` mark naming a sibling proposal from the same Outcome is held with that id listed as
  not in the pool (`spawns`, C10).
