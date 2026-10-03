# Not ported to conformance

Visible rows of the test inventory (`docs/research/rust-port/test-inventory.md`) that are not, or not
wholly, a passing conformance case against `--server bun`, each with the reason and the Rust unit test it
implies; and the places where a case pins something other than the inventory's wording. Grouped by area.

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
