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

- **Gaps left to the other `attempts` tickets.** The area's "no test covers yet" entries on terminal-backed
  launch (prompt never landed after the wrapper, the managed-settings and workspace trust dialogs, the readiness
  bound, `pane.report_agent` and `pane.release_agent`, `terminal_id` on the spawned event) are C12's scope, and
  the stderr-in-the-log-not-the-Stream entry is C13's. The headless git-checkout entry (harness, model and
  commitSha on the spawned event) is already pinned by `cases/disk.test.ts` and `attempts-argv.test.ts`.

## `steward`: the Steward (C18)

Every one of C18's 37 rows is a passing case under `conformance/cases/steward/` (`teaching.test.ts`,
`config.test.ts`, `notices.test.ts`, `answers.test.ts`, on the shared world in `pool.ts`). Every Steward teaching
and Notice is also compared whole, byte for byte, against its text written out in the case. Five of the area's
six gaps are cases there too. One gap is left in part:

- **Two of the Steward answer refusals** (gap entry, `engine/engine.ts:9937-9948` and `:10004`). The cases pin
  "has no pending Interrupt" and "already has an answer queued". Two refusals are not pinned:
  - A Steward answer on a Conversation's merge conflict. It cannot be set up as a pending answer target with
    the Steward on duty in a way that reaches this check rather than an earlier one. Rust unit test: a Steward
    answer whose ticket id is a known Conversation is refused with
    `steward: <id> is a Conversation: the Steward stewards Tickets, never talks`.
  - A Steward resume on a merge-approval. It needs a merge conflict and then a resolver run that resolves it,
    which `notices.test.ts` does build, but only to reach the Notice. Rust unit test: a Steward resume on a
    merge-approval Interrupt is refused with `steward: ticket <id>'s merge-approval takes approve or reject`.

Where the cases reach a row differently from its wording:

- `steward.test.ts:148` (what the Steward is told about) is five cases, one per exclusion, plus the Review one in
  the `steward.test.ts:607` case. A queued answer needs another Attempt in flight, and a pending merge-approval
  stalls the pool, so the seven Interrupts cannot all be pending together from outside.
- `steward.test.ts:179`: "never the word adopt" holds for the Notice's Answers line only. The verify round's own
  Brief, which the Notice quotes, says the operator may adopt a candidate.

Behaviour of the TypeScript server the cases pin as it is today, each worth a look before the port copies it:

- After a Steward resume or Close, the Ticket file keeps the earlier checkpoint's `## Brief` section and the note
  follows it, so a Ticket that then finishes without another checkpoint keeps a stale Brief.
- POST /api/steward/answer with action `adopt` is refused by the route with 400 and no `steward: ` prefix; every
  other Steward refusal is a 409 from the engine with the prefix.
- A second Steward is refused as `steward start: ...` on POST /api/conversations and `enlist: ...` on
  POST /api/enlist.
- An ended Steward's `conversations/<id>.md` ends `# Steward\n\n\n` when it had no opening.
- A Conversation's merge-conflict Interrupt raised while the pool is quiescent reaches the snapshot only at the
  next emit (inference: `raiseInterrupt` changes state without emitting; proposal-32 in the RUST pool fixes it).
  The case waits on the event in the Conversation's log first.

## `merges`

Ticket C09. Its 48 rows and 9 gaps are cases in `cases/merges-*.test.ts`; what follows is the part of them
that is not a plain passing case.

### Partly ported

- **`merge-hold.test.ts:543`**, *leaves out a ticket that landed, and a re-taken ticket joins the back of the
  line*. The inventory has POST /api/resume re-take 02's merge, but the real server's resume retries the merge
  in place (`resumeMerge`, engine.ts:6147) and never takes it again, so 02 keeps its place, which is what
  CONTEXT.md says of a ticket left waiting on the operator. The case
  (`merges-queue.test.ts`) pins that, and that a landed ticket leaves the queue. Joining the back happens
  only on the paths that take a merge again (the drive's merge chain, an adopted or Continued attempt ending,
  the boot re-chain of a merge dropped at shutdown, an enlisted ticket's merge), none of which re-takes a
  merge already in the line from outside today.
  Rust unit test: *merge line: a ticket taken again after it left the line joins the back, behind tickets
  taken since; one resumed in place keeps its place.*

### Pinned pending a TypeScript fix (Decided 5)

- **Gap: the reconcile's merge-base fallback** (engine.ts:6054-6082). With `runs/01.seed.md` deleted, the
  Bun server loses the branch's committed edits to the Ticket file and keeps only the pool copy's. The
  inferred cause, confirmed by experiment: `ticketSeedFor` runs `git merge-base HEAD <branch>` after the merge
  has been committed, so the base is the branch's own copy. The case in `merges-reconcile.test.ts` pins the
  intended result (both copies' edits kept) and is a `test.todo` until the fix lands; it runs with
  `CONFORMANCE_PENDING=1`. Once the TypeScript server computes the base before the merge (or from `HEAD^1`),
  drop the pending wrapper.

### Pinned differently from the inventory's wording

- **`engine.test.ts:11187`**: the row reads "/api/state mergeHold is [01]", but `mergeHold` is the engine's
  internal snapshot field and the server does not send it. The case pins its visible form,
  `state.mergeQueue` `[{01, stalled}]` and the card's `mergeState`.
- **Git's own text in Interrupt bodies.** The `git said:` part of a merge-conflict or blocked body quotes git
  verbatim. Two blocked-merge cases pin it whole (git's local-changes refusal and its CONFLICT lines) and so
  depend on git's wording; the resolver cases require only that it name the conflicted file, because rerere,
  switched on by the first conflict's `.git/rr-cache`, changes what later conflicts in one pool print. A Rust
  server that runs git as a process matches both; one built on libgit2 would not.
