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

## C19: Assignments and Config reload (`config`)

Every one of the 44 rows is a passing case in `cases/config-assignments.test.ts`,
`cases/config-reload.test.ts` and `cases/config-resolver.test.ts`. Six of the area's seven gaps are cases there
too. One gap is left:

- **A console.json hand-edited into invalid JSON, seen from every route that reads it** (GET /api/settings,
  PUT /api/settings/pool, PUT /api/reassign, GET /api/panes, the socket's `panes.list`, the snapshot's
  `poolTitle`; source `engine/server.ts:1815`). Left because it is mostly the routes' answers, which C00 and
  C20 own, and because GET /api/panes answers with Bun's own 500 page there, the same class of answer as the
  unknown-path 500s conv-1-spawn-14 is fixing (inventory open question 5). Once that fix lands, the case is:
  a started pool, console.json rewritten to `{ not json`; GET /api/settings answers 500 `{error}`, the pool
  PUT answers 400 and leaves the broken bytes, PUT /api/reassign answers 500, GET /api/panes and `panes.list`
  answer a clean 500 refusal, and the snapshot keeps the last good `poolTitle`. The Reassign half of it
  (every ticket refused while the config will not parse) is C20's `reassign.test.ts:382` row.

## `herdr`: the Pool workspace, tabs and the RPC client (C14)

Every one of the 37 visible rows has a passing case, in `cases/herdr-workspace.test.ts` and
`cases/herdr-tabs.test.ts`. Of the three rows the inventory marks with a seam:

- `engine.test.ts:6047` (a workspace closed mid-run) needs no seam: the case closes the launch workspace
  before it writes 01's outcome, which is always before 02's `tab.create`.
- `engine.test.ts:6123` (concurrent spawns both refused) uses a new fake herdr control,
  `removeWorkspaceOn(method, workspaceId)`, which closes the workspace as the next call of that method
  arrives.
- `herdr.test.ts:66` (one request per connection) uses the connection number the fake herdr now reports
  with each call, and its `openConnections` control.

Gaps from the inventory's `herdr` list:

- Taken as cases: the workspace that cannot be re-resolved after a refused tab (`engine.ts:3111`), the
  socket under `HOME/.config/herdr/herdr.sock` when `HERDR_SOCKET_PATH` is unset or blank
  (`herdr.ts:48`), the boot line `Pool workspace w1 created for this pool's tabs`, the launch and
  not-created workspaces never relabelled, and `pane.focus` never answered (a real 10 s wait, its case
  named slow).
- Partly taken: the title change for the launch and not-created workspaces is made through
  `PUT /api/settings/pool`, not by editing `console.json` by hand. The Bun server reads a hand-edited
  title only when it next enriches a snapshot (`server.ts` `titleNow`), and nothing a case can do from
  outside makes that happen within a bound. Rust unit test: *server: a Pool title read from
  console.json at any snapshot is handed to the run's relabel exactly once per change, whether it came
  from a Settings save or a hand edit.*
- Left to C15, whose rows they sit beside: the bulk close when `pane.list` fails, the bulk close itself
  and its refused `tab.close`, and Peek of a pane no Turn loop watches.

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

## Engine tests not ported to conformance

The engine tests that have no conformance case, each with why it cannot be one and what takes its place (ADR-0036). A row ends in the Rust unit test it implies, which the port ticket for its area must include, or in `Dropped:` with the reason no Rust test is needed. Every other engine test that the conformance suite has taken on is named by a `// engine/<file>:<line>` comment above its case under `cases/`. Line numbers are those of the TypeScript engine before the flip.

### engine/server.test.ts

- `engine/server.test.ts:847` snapshot push coalescing › pushes every emit as its own frame with a zero window: needs a settable snapshot coalescing window, and the open questions decided against timing knobs; against the fixed 50 ms window the server coalesces emits, so one frame per emit cannot be provoked from outside. Rust unit test: with a zero coalescing window, every engine emit reaches an open socket as its own snapshot or delta frame, each frame's seq one more than the last, up to the run's final seq.
- `engine/server.test.ts:2089` ticket activity endpoint › serves the cached payload for repeat requests inside the TTL: the activity diff cache is an internal cost saving, not a contract (the inventory files it Hidden), and a black-box read inside a 1.5 s window is timing-sensitive on a loaded machine. Rust unit test: activity diff cache: a second Vitals read of the same ticket's worktree within 1.5 s serves the first read's diff unchanged, running no git, and a read after the TTL runs git again and shows the file written in between.
- `engine/server.test.ts:2211` pool lock › has no force override: a live lock refuses even when forced: passes an undeclared `force` field through a type cast into createPoolServer's options; the CLI has no force flag to pass, so nothing outside the process can ask for one. Dropped: a TypeScript options shape with no Rust counterpart; the live-lock refusal it ends on is covered by the other pool lock cases.
- `engine/server.test.ts:3257` terminalRuntimeRefusal › refuses a terminal-backed pool on a Bun below the floor: calls terminalRuntimeRefusal with a made-up Bun version; the runtime version cannot be chosen from outside. Dropped: the refusal text for a Bun below the 1.3.0 floor (the issue #61 segfault) guards the Bun runtime, which the Rust server does not run on.
- `engine/server.test.ts:3265` terminalRuntimeRefusal › boots a terminal-backed pool on the floor and above: calls the version guard directly with chosen versions. Dropped: a Bun version guard the Rust binary does not have.
- `engine/server.test.ts:3272` terminalRuntimeRefusal › never refuses a headless pool: calls the version guard directly. Dropped: the Bun runtime floor is a Bun-only guard with no Rust counterpart.
- `engine/server.test.ts:3277` terminalRuntimeRefusal › never refuses on a version it cannot read: calls the version guard directly with unparseable versions. Dropped: a Bun version guard with no Rust counterpart.
- `engine/server.test.ts:3282` terminalRuntimeRefusal › boots on this test run's own Bun: calls the version guard directly with Bun.version. Dropped: a Bun runtime quirk with no Rust counterpart.
- `engine/server.test.ts:3319` stop from the Console (#97) › refuses a stop before the pool has started and keeps serving: needs a server bound without its pool started, and the command line starts the drive in the same tick it binds, so no launch shows that state (inventory open question 6: no flag). Rust unit test: with the pool not started, POST /api/stop answers 409 with an error containing "not started", nothing is torn down, and GET /api/state still answers 200 with {snapshot: null}.
- `engine/server.test.ts:3425` stop from the Console (#97) › hands a stop to onStopRequested exactly once and does not shut itself down: injects an in-process onStopRequested callback and counts its calls; from outside, the CLI's own callback always exits the process, so "the server stays up" and the call count cannot be observed (the single "stop requested" line is checked by the repeat-stop case). Rust unit test: stop latch: two accepted stop requests hand the stop to the process owner exactly once, the second is only acknowledged with 202, and the server leaves the teardown to that owner.
- `engine/server.test.ts:4022` conversation endpoints › PoolServer exposes startConversation/endConversation directly, guarded before the pool starts: the server command line starts the drive in the same tick it binds, so the "pool not started" refusals of POST /api/conversations and POST /api/conversations/end cannot be reached from outside (inventory open question 6, decided: no flag); the half after the start is the create/end round trip `engine/server.test.ts:3906` already ports. Rust unit test: the server's request handling, before its pool starts, answers both conversation routes 409 with reason 'pool not started', and after the start a create answers 201 with a live Conversation and an end leaves conversations/<id>.md ended.

### engine/ws.test.ts

- `engine/ws.test.ts:533` a push or a reply that cannot go › refuses a result it cannot serialise, keeps the socket, and answers the next request: needs a request result that cannot be encoded (a cycle, a BigInt), which only a push hub fed by in-process sources can produce; no request the real server answers yields one. Rust unit test: socket replies: a request result that cannot be encoded is answered as a refusal with status 500 and a reason starting 'could not encode the result: ', it is logged, and the socket stays open and answers the next request.
- `engine/ws.test.ts:571` a push or a reply that cannot go › logs a push that throws with no coalescing window, and pushes the next emit: needs a snapshot read that throws and a zero coalescing window, both in-process seams of the push hub the server process never exposes. Rust unit test: snapshot push: a snapshot build that fails is logged as 'snapshot push: <reason>' and escapes nowhere, and the next emit is pushed as usual.
- `engine/ws.test.ts:598` a push or a reply that cannot go › keeps every socket at the last good revision when a snapshot cannot be encoded: needs a snapshot that cannot be encoded (a BigInt in a Ticket), which no pool on disk can make the real server build. Rust unit test: snapshot push: a version whose frame cannot be encoded is logged once and not counted, every socket stays at the last good revision, a socket opening meanwhile is sent that revision, and the next good version's delta is based on it.
- `engine/ws.test.ts:655` a push or a reply that cannot go › never counts a first snapshot it cannot encode, and sends the next good one whole: needs a first snapshot that cannot be encoded, which no pool on disk can make the real server build. Rust unit test: snapshot push: a first snapshot that cannot be encoded is logged and never counted pushed, sockets keep the null snapshot of revision 0, and the next good version goes whole as revision 1, not as a delta.
- `engine/ws.test.ts:685` a push or a reply that cannot go › logs a pushed version that no longer encodes whole, drops only the socket opening on it, and serves the page bare: needs a pushed snapshot object changed in place after its delta went out, which only an in-process source can do. Rust unit test: socket open and page: when the version the sockets hold cannot be encoded whole, only the socket opening on it is dropped with no snapshot frame, sockets already open are untouched, and the page is served as built, without the embedded boot, with cache-control no-store.
### Ported in part

Engine tests that have a conformance case, but whose case cannot carry the whole claim from outside. The rest of each claim is a Rust unit test.

* `engine/server.test.ts:861` snapshot push coalescing › pushes a burst of emits as one frame carrying the latest: the case runs against the fixed 50 ms window (open question 2), so it keeps "fewer frames than emits" but cannot read `/api/state` inside a window that is still holding a push back. Rust unit test: snapshot push: while the coalescing window is open, the state the HTTP route serves already carries the latest seq and the socket has not been sent it yet.
* `engine/server.test.ts:884` snapshot push coalescing › pushes a waiting snapshot before the sockets close: with a 50 ms window the `stopped` snapshot may go out on its timer before the close, so the case proves the farewell arrives, not that a snapshot still waiting is flushed on close. Rust unit test: closing the sockets on stop first sends any snapshot the coalescing window is still holding, then closes with 1000 "stopped".
* `engine/server.test.ts:5003` enlist a pane as a conversation › peek serves the engine's own viewport read of an enlisted Conversation's pane, and forgets it at End (issue #122): the server's real 2 s pane poll reads the pane around End, so the case checks only that the 404 peek after End reads nothing. Rust unit test: ending an enlisted Conversation makes no `pane.read` of its pane.
* `engine/ws.test.ts:1142` the served page › embeds the boot snapshot the socket's first frames repeat: the "revision 0, null snapshot" boot before the pool starts cannot be reached from outside (open question 6); the case checks the boot once the pool has started. Rust unit test: before the pool starts, the page's embedded boot carries protocol 1, revision 0 and a null snapshot.

### TypeScript divergences found while porting

Behaviour of the Bun server, reproduced while writing these cases, that no engine test pins and that looks wrong. The cases step around it rather than pin it; deciding the intended behaviour is the operator's call (inventory decision 5 is the pattern).

* `GET /api/panes` on a `terminal: "herdr"` pool with no herdr daemon answers 502 and then the process dies of an uncaught `connect ENOENT` (from the herdr RPC under the agent listing). The socket's `panes.list` answers the same 502 and the server lives. The `engine/ws.test.ts:470` case asks only the socket.
* `GET /api/panes` with an unreadable `console.json` answers Bun's HTML 500 page rather than a JSON refusal. The same case asks `panes.list` before it breaks `console.json`.
