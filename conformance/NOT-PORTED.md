# Not ported

What the conformance suite leaves out (ADR-0036): an inventory row
(`docs/research/rust-port/test-inventory.md`) no case can express from outside
a server, or one waiting on a seam, each with the reason and the Rust unit
test it implies; and the places where a case pins less than the TypeScript
server does, or works around what it does, because that looks like a bug.
One section per contract area.

The `engine/<file>.ts:<line>` paths below are as of the flip, commit `75ea8fe`,
which deleted the TypeScript server. Read one with
`git show 75ea8fe^:engine/<file>.ts`.

## `conversations`

Every row of ticket C16 (the lifecycle rows) is a case in
`cases/conversations-lifecycle.test.ts`. Left out or worked around:

- **A conflicted End's Interrupt was not published** (`conversations.test.ts:602`).
  Fixed in the Rust server. `raiseInterrupt` in `engine/engine.ts` changed the
  state without emitting a snapshot, and a Conversation's End runs off the
  drive loop, so the merge-approval it raised once the resolver resolved
  stayed out of `/api/state` and the socket until something else published.
  The Rust server publishes once the End's merge handling settles
  (`crates/engine/src/conversations/end.rs`, `end_merge_link`), and the case
  asserts the socket frame directly, with no carrier Conversation.
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

Both are Rust unit tests in `crates/engine/src/steward_actions.rs`:
`refuses_a_steward_answer_whose_ticket_id_is_a_known_conversation` and
`refuses_a_steward_resume_on_a_merge_approval_interrupt`. The TypeScript's refusal of an `adopt` word inside
`stewardAnswer` (`engine.ts:9937`) has no Rust twin: the Steward's answer action has no `adopt` variant, so the
route's own 400 is the only place it is refused, as the cases pin.

The Steward's command, as its teaching names it, is this binary's `steward` subcommand: `<current_exe> steward
--pool <pool-dir> [--url <console-url>] --as <conversation>` where the TypeScript named `<bun> <repo>/engine/steward-cli.ts
--pool ...` (ADR-0036: one binary). `ac_core::steward::steward_command` builds it, quoting each word as the
TypeScript's did.

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
  taken since; one resumed in place keeps its place.* It is
  `a_ticket_taken_again_joins_the_back_and_one_resumed_in_place_keeps_its_place` in
  `crates/core/src/merge_hold.rs`.

### Fixed in the Rust server (Decided 5)

- **The reconcile's merge-base fallback** (engine.ts:6054-6082). With `runs/01.seed.md` deleted, the
  Bun server lost the branch's committed edits to the Ticket file and kept only the pool copy's:
  `ticketSeedFor` ran `git merge-base HEAD <branch>` after the merge had been committed, so the base was
  the branch's own copy. The Rust server takes the merge base before the merge lands
  (`merge_with_issue_aside` in `crates/engine/src/merges.rs`), and the case in
  `merges-reconcile.test.ts` that pins the intended result (both copies' edits kept) is a real case.

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
  (every ticket refused while the config will not parse) is C20's `reassign.test.ts:382` row. C20 has
  since taken the gap as `cases/config-settings-unreadable.test.ts`, pinning GET /api/panes's status only;
  its section at the end says what else it pins short.

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
  from a Settings save or a hand edit.* It is
  `hands_each_pool_title_change_to_the_relabel_once_from_a_hand_edit_or_a_save` in
  `crates/server/src/tests.rs`.
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
- `engine/ws.test.ts:685` a push or a reply that cannot go › logs a pushed version that no longer encodes whole, drops only the socket opening on it, and serves the page bare: needs a pushed snapshot object changed in place after its delta went out, which only an in-process source can do. Rust unit test: socket open and page: when the version the sockets hold cannot be encoded whole, only the socket opening on it is dropped with no snapshot frame, sockets already open are untouched, and the page is served as built, without the embedded boot, with cache-control no-store. Not needed in Rust: a pushed version is an immutable `serde_json::Value` that nothing changes after its delta goes out, and encoding a `Value` cannot fail, so no version the sockets hold can stop encoding; `hub::page` keeps the bare fallback all the same.
### Ported in part

Engine tests that have a conformance case, but whose case cannot carry the whole claim from outside. The rest of each claim is a Rust unit test.

* `engine/server.test.ts:861` snapshot push coalescing › pushes a burst of emits as one frame carrying the latest: the case runs against the fixed 50 ms window (open question 2), so it keeps "fewer frames than emits" but cannot read `/api/state` inside a window that is still holding a push back. Rust unit test: snapshot push: while the coalescing window is open, the state the HTTP route serves already carries the latest seq and the socket has not been sent it yet.
* `engine/server.test.ts:884` snapshot push coalescing › pushes a waiting snapshot before the sockets close: with a 50 ms window the `stopped` snapshot may go out on its timer before the close, so the case proves the farewell arrives, not that a snapshot still waiting is flushed on close. Rust unit test: closing the sockets on stop first sends any snapshot the coalescing window is still holding, then closes with 1000 "stopped".
* `engine/server.test.ts:5003` enlist a pane as a conversation › peek serves the engine's own viewport read of an enlisted Conversation's pane, and forgets it at End (issue #122): the server's real 2 s pane poll reads the pane around End, so the case checks only that the 404 peek after End reads nothing. Rust unit test: ending an enlisted Conversation makes no `pane.read` of its pane. It is `ending_an_enlisted_conversation_reads_nothing_of_its_pane` in `crates/engine/src/conversations/tests.rs`.
* `engine/ws.test.ts:1142` the served page › embeds the boot snapshot the socket's first frames repeat: the "revision 0, null snapshot" boot before the pool starts cannot be reached from outside (open question 6); the case checks the boot once the pool has started. Rust unit test: before the pool starts, the page's embedded boot carries protocol 1, revision 0 and a null snapshot.

### TypeScript divergences found while porting

Behaviour of the Bun server, reproduced while writing these cases, that no engine test pins and that looks wrong. The cases step around it rather than pin it; deciding the intended behaviour is the operator's call (inventory decision 5 is the pattern).

* `GET /api/panes` on a `terminal: "herdr"` pool with no herdr daemon answers 502 and then the process dies of an uncaught `connect ENOENT` (from the herdr RPC under the agent listing). The socket's `panes.list` answers the same 502 and the server lives. The `engine/ws.test.ts:470` case asks only the socket.
* `GET /api/panes` with an unreadable `console.json` answers Bun's HTML 500 page rather than a JSON refusal. The same case asks `panes.list` before it breaks `console.json`.

## C20: Reassign and settings (`config`)

Ticket C20's 70 rows are `machine-defaults.test.ts`, `pool-settings.test.ts`, `pool-title.test.ts` and
`reassign.test.ts`. Sixty-eight are passing cases in `cases/config-reassign-views.test.ts`,
`config-reassign-conversations.test.ts`, `config-reassign-writes.test.ts`, `config-settings-pool.test.ts`,
`config-settings-machine.test.ts`, `config-settings-title.test.ts` and `config-settings-unreadable.test.ts`;
the other two are pinned by C00's cases already. The last gap of the area, the one C19 left (a console.json
that will not parse, seen from every route), is `config-settings-unreadable.test.ts`.

### Pinned by a C00 case already

- `reassign.test.ts:254` (refuses a done ticket): `cases/reassign-routes.test.ts`'s case for
  `engine/reassign-routes.test.ts:90` pins a Ticket run to done as refused with reason `done`.
- `reassign.test.ts:706` (skips a ticket that went in flight since the listing, and applies the rest): the
  case for `engine/reassign-routes.test.ts:332` is the same write with the two ids swapped.

### Pinned as the Bun server does it, worth a look before the port copies it

- **An enlisted Ticket's sources** (`reassign.test.ts:264`). The engine test expects harness `default`, model
  and effort `unset` and drivers `default`. The server serves `unset` for all four, drivers included, though
  drivers otherwise always resolves to something: `reassignViews` seeds every enlisted Ticket frozen from
  the engine's own record (`frozenSeed` with `enlisted: true` in `engine/reassign.ts`), and a seeded id gets
  no sources, so it falls to `NO_SOURCES`. The engine test hands it no engine records, so it takes a path
  the server never does. The case pins all four `unset`. Intended behaviour (inference): the harness names
  the layer the file supplies it from and drivers reads `default`, while the card keeps the engine's record.
  Rust unit test: *reassign views: an enlisted ticket at rest reads harness from its layer (default with only
  pool defaults), model and effort unset and drivers default, and its card shows the engine's record.* Not
  written yet: the Rust port serves all four `unset`, as the case pins, so this test waits on the operator
  choosing the intended behaviour.
- **PUT /api/settings/machine with an unreadable console.json** (`config-settings-unreadable.test.ts`). The
  save writes `~/.agent-graphs/defaults.json`, then fails to read the pool half of its answer and refuses with
  400 and the parse error, so the operator is told the request was refused when it landed; GET /api/settings
  answers the same failure with 500. The case pins the 400 and the written file. Intended behaviour
  (inference): a 500, as GET /api/settings answers, the write kept and said so.
- **GET /api/panes with an unreadable console.json** answers 500 with Bun's own HTML error page (also under
  "TypeScript divergences found while porting" above). The case pins the 500 alone; its socket twin,
  `panes.list`, refuses with status 500 and a reason, which the case pins. Intended behaviour: the JSON
  refusal its twin gives.

### Where the cases reach a row differently from its wording

- **A Ticket "waiting" to be offered** (`reassign.test.ts:100` and most rows of a Ticket offered for Reassign):
  it waits on a Ticket at its checkpoint, which the pool never schedules, instead of behind a held stub,
  so nothing runs out the stub's ten-second wait on a loaded machine. A held stub (`world.stubs.hold`)
  stands in only where a row needs an Attempt in flight (`:246`, `:291`, `:382`, `:720`).
- **"Then GET /api/state" after a hand edit** (`:100`, `:246`, `:291`, `:318`, `:334`, `:347`, `:371`). The Bun
  server builds the snapshot GET /api/state serves at an engine emit, a Reassign or a settings save, and a
  pool at rest emits nothing, so a hand edit to console.json or a Ticket file is not on GET /api/state until
  one of those (seen: the old card still served 3 s after an edit). The cases ask for a fresh snapshot with a
  Reassign naming only a Ticket that cannot take a write (done, or in flight), which writes nothing and
  answers with a snapshot built afresh, then read GET /api/state. Each first waits for the pool to rest, so
  the engine's own first reload has run before the edit. `:382` cannot ask that way (the Reassign route cannot
  read the file either) and reads the snapshot the run publishes when its held Attempt ends. Nothing pins
  how stale GET /api/state may be.
- **Enlisted Tickets** (`:264`, `:280`, `:318`, `:670`, `:687`) are written as the engine writes one
  (`enlisted-from=<pane>` in the marker), at their checkpoint, on a terminal-backed pool with the fake
  herdr, rather than enlisted over POST /api/enlist: a Ticket enlisted live is an Attempt in flight and so
  refused for Reassign, while these rows are about one the engine holds no Attempt for.
- **`machine-defaults.test.ts:47`, "creates the directory"**: the server registers itself in
  `~/.agent-graphs/pools.json` at boot, so the directory is there before any save. The case removes it once
  the server is up, and the save makes it again.
- **`pool-settings.test.ts:84`** sends `selection: null` for the engine test's `undefined`, which JSON cannot
  carry: a key sent as undefined is a key not sent, which a save leaves alone.
- **`pool-settings.test.ts:263`**, its last claim (no harness table means no check): the server always has
  its harness table. Dropped: an option of the writer that only an in-process caller can leave empty.
- **`pool-settings.test.ts:313`, "writes through a rename"**: from outside, only that no `console.json.*`
  file is left beside console.json after a save. Rust unit test: *pool settings: a save writes console.json
  to a temporary file and renames it over the old one, so a reader never sees half a file.*

### Observed while writing these, not pinned

- The formats section's observation that `reassign.sources.effort` reads `unset` for a `spawn-assign` effort
  does not reproduce here: hand-written or adopted at a boundary, a spawned Ticket that has not run reads
  `requested`, which the `reassign.test.ts:154` case now pins beside its own row.
- PUT /api/reassign answers a body that is not an object (a string, an array, null) with 500
  `reassign: body must be an object`, and one that is not JSON with 500 `Failed to parse JSON`, where
  PUT /api/settings/pool answers 400 for the same body: a malformed request reads back as the server's
  failure. Intended behaviour (inference): 400, as for every other request the route refuses.
- A Reassign naming one Ticket twice applies it once (`applied` lists it once).

## `interrupts`: Interrupts and answers (C08)

Every one of C08's 42 rows is a passing case under `conformance/cases/interrupts-answers.test.ts`,
`interrupts-queued.test.ts`, `interrupts-close.test.ts`, `interrupts-persistence.test.ts` and
`interrupts-keep-talking.test.ts`. So are the area's ten gaps, two of them pinned to what the server answers
rather than to the gap's wording, and one behaviour no gap lists (an answer to the PERSISTENCE Interrupt while
the store still refuses). What follows is the part that is not a plain passing case.

### Pinned short

- **A refused checkpoint write's retry** (`engine.test.ts:7033`). The row's seam, a store that fails exactly
  one write, does not exist. The case makes the store refuse from outside instead: it holds an exclusive SQLite
  lock on `console.db` from the test process, lets 01 finish, and lets go once the server answers a request sent
  after 01's `exited` event is on disk. On the Bun server 01's exit and the boundary write run in one stretch of
  the event loop, so that request is answered only in the backoff after the first write, which the lock refused:
  in the runs measured, the first checkpoint row landed about 50 ms after the release. What a case cannot show
  from outside is that a write failed at all: a server that answers HTTP while its boundary write is still to
  come passes it without retrying anything. The case pins what it can: no persistence Interrupt, 02 launched
  after 01, and the first row holding `{01: done, 02: ready}`. Rust unit tests: *persist retry: a boundary
  checkpoint write that fails once is retried after the backoff, the next Ticket is scheduled and no persistence
  Interrupt is raised; a run to done makes seven write attempts, the failed one and six rows*, and *persistence
  Interrupt: with a store that always fails, the boundary write and the closing write each make four attempts,
  eight in all, and the store is never closed.* They are `a_write_that_fails_once_is_retried_and_the_run_goes_on`
  and `a_store_that_always_fails_makes_four_attempts_per_write_and_stays_open` in `crates/engine/src/persist.rs`.
- **Two Keep talking refusals are never given** (gap entries `engine/engine.ts:4682` and `:4685`). keepTalking
  checks the hold again after its fresh pane listing, and by then that listing's own handler (`surveyListed`,
  called before `paneSurvey.refresh()` resolves) has already let the hold go. So a pane that is gone, or whose
  TUI has exited, always gets `keep talking: ticket 01 has no terminal left to continue in`, never `... lost its
  terminal: pane <id> is gone` or `... lost its agent: the TUI in pane <id> has exited`. The cases in
  `interrupts-keep-talking.test.ts` pin today's answer: 409, `heldPane` null, the checkpoint Interrupt kept.
  Intended behaviour (inference): the refusal says why. Rust unit test: *keep talking: over a Held pane the fresh
  listing no longer has, answer 409 `keep talking: ticket <id> lost its terminal: pane <pane> is gone`; over one
  whose TUI's exit-code file landed after the attempt began, answer `keep talking: ticket <id> lost its agent:
  the TUI in pane <pane> has exited`; each lets the hold go.* The Rust port keeps today's answer from outside, as
  the cases pin; `the_claim_says_why_a_held_pane_cannot_be_continued_and_lets_the_hold_go` in
  `crates/engine/src/keep_talking.rs` holds the claim's own two refusals, which a listing that has not let the
  hold go would reach.
- **A Continued attempt's crash body is pinned at its head and foot only** (`keep-talking.test.ts:198`, `:208`,
  `:226`). The log-tail lines between come from the pane's Stream file, where util-linux `script` writes its own
  start and done lines as the TUI exits and BSD `script -q` writes none. So the cases pin the reason, the log
  path and the outcome-file line, check only that `logTail` is an array on the events, and do not pin the
  Continued attempt's `stream_offset` to a number (the log case checks what it means instead: above 0, and
  attempt 2's log holds only the line printed after Keep talking began). Rust unit test: *continued attempt
  ending: a crash body reads `crash: <reason>\n<log path>\n\n`, then the derived log's last lines and a blank
  line when there are any, then `outcome file: <path> (missing)\n`.*

### Pinned as the TypeScript server does it today, each worth a look before the port copies it

- **A Brief landed between two sections takes the blank lines above it** (the case for `engine.test.ts:7253`).
  Landing a checkpoint's Brief strips the old `## Brief` section and the blank lines above it
  (`stripBriefSections` in `engine/engine.ts`), blank lines meant to go with an engine-written `---` separator,
  even when there is no separator. So `# 01\n\n## Brief\n\n...\n\n## Notes` becomes `# 01\n## Notes`, and the
  case pins those bytes. Intended behaviour (inference): the blank lines go only with a `---` an engine append
  wrote.
- **An answer to the PERSISTENCE Interrupt while the store still refuses** (`engine/engine.ts:5587-5592`, a case
  in `interrupts-persistence.test.ts`). The answer is accepted first, so its `answered` event and its queued
  record are written; its processing then fails to persist, and POST /api/resume answers 400
  `{"error": "database is locked"}`. Inside, the processing has already cleared the Interrupt from state and
  logged it answered, but nothing is emitted and no drive starts, so /api/state still serves the Interrupt; the
  next answer, once the store is healthy, is acknowledged as a retry of the pending record and the run carries
  on. The case pins the 400, the Interrupt still served, the one event and record, and the run carrying on. The
  drain's own comment expects the run to go down there, which it does not on the idle path. Rust unit test:
  *answer drain: an answer whose persist fails leaves the pool state and its queued record as they were, and the
  next answer to the same Interrupt processes it.* The Rust port does what the Bun server does, which the case
  pins: the failed processing has already cleared the Interrupt in memory, so the next answer's drain consumes
  the pending record with a refusal and the drive it starts is the retry.
  `an_answer_whose_persist_fails_stays_queued_and_the_next_answer_carries_the_run_on` in
  `crates/engine/src/answers.rs` pins that; making the state as it was is the operator's call.

## `attempts`: terminal-backed launch (C12)

Every one of C12's 47 rows is a passing case under `conformance/cases/attempts-terminal-tabs.test.ts`,
`attempts-terminal-wrapper.test.ts`, `attempts-terminal-prompt.test.ts`, `attempts-terminal-launch.test.ts` and
`attempts-terminal-trust.test.ts`; a row that runs for several harnesses is one case per harness. The terminal-backed
gaps the C11 section hands on are cases there too: the prompt that never landed after the wrapper, the
managed-settings dialog, the trust dialog still up after its answer, the readiness bound, `pane.report_agent` and
`pane.release_agent` at a done and at a crashed ending, and `terminal_id` on the spawned event. For these the fake herdr
gained three options, `noRootPane` (a `tab.create` answer with no root pane), `keyFrames` (a frame a key brings up, so
a dialog's highlight moves the moment the key lands) and `failFrom` (a method refused from its nth call on), and its
call record gained each call's arrival time (`at`).

Where a case reaches a row differently from its wording:

- **`engine.test.ts:6548`, the other platform's `script(1)` form.** The case checks the form of the host it runs on:
  util-linux's `-eqfc '<command>' <stream file>` on Linux, BSD's `-eqF <stream file> sh -c <relay> sh "$(tty)" <words>`
  on darwin. A Linux run never checks the darwin form; the Mac run does. The platform override the row's seam asks for
  was not added. Rust unit test: the wrapper for each platform, built from an argv holding a space and a quote, is
  exactly that form, the darwin relay word byte for byte.
- **`engine.test.ts:5477`, "one events.subscribe".** The row's engine test ran a harness with no descriptor, which has
  no readiness wait. A pool's console.json can name only claude, opencode and cursor, whose readiness wait subscribes
  too, so the case pins two subscriptions, the readiness wait's and the ending wait's, each naming pane.exited,
  pane.closed and tab.closed, the second after the prompt's Enter. Rust unit test: a harness with no descriptor is sent
  the wrapper and nothing typed, and its result or its pane's end decides the Attempt.
- **`attempt-run.test.ts:1514`, "within 15 s".** The 15 s held for the engine test's shortened launch cadence. The
  server gives `script` 10 s per tab to create the Stream file, so three botched tabs take over 30 s. That case and
  `:1465` (one botched tab) wait at the real bound behind the slow tag (Decided 2) and pin no elapsed time.
- **`herdr.test.ts:142`, a `tab.create` answer with no root pane.** It costs the one re-resolve and retry any refused
  tab costs; the workspace is still there, so the retry goes to it again. Two tabs are created and the terminal_error
  quotes the second answer. The quoted answer is compared once parsed, not byte for byte: a server that re-serialises
  the daemon's answer may order its keys differently.
- **"At once" and "within seconds"** (`:1287`, `:1660`, `:1696`): pinned as the crash landing less than 30 s after the
  spawn, half the 60 s readiness bound, so a loaded machine does not fail them.

Behaviour of the TypeScript server seen while writing these, worth knowing before the port copies it:

- A terminal-backed Attempt's derived log opens with util-linux script's own `Script started on <date>
  [COMMAND="..." <not executed on terminal>]` line and, when `script` has exited by the time the ending is read, closes
  with its `Script done on ...` line, because the log derives from the whole typescript. script writes its header only
  once the harness first prints or exits, so a silent TUI leaves the log empty and a Blocking dialog's frame is what
  lands there. The cases pin the harness's own lines and the frame block, never script's lines.
- `GET /api/log?ticket=<id>&stream=1` serves the Stream file ANSI-stripped, as the plain route serves the log, so the
  raw typescript cannot be had over HTTP. Seen in the `:711` case and left unpinned: it is the `http` area's.
- A launch botched in all three tabs never reports its pane's agent, yet releases it at the ending: `awaitAttempt`
  releases whenever the handle names a pane (inference from the code, not pinned).
- A `tab.create` answered without a root pane leaves its tab open, and so does the retry's: the answer names the tab,
  but `openAttemptTab` throws without closing it, so a daemon of that kind gains two tabs nobody closes per Attempt.
  The case pins the headless fallback, not the leftover tabs.

Rust unit tests these rows imply, for what no case can show from outside:

- The pane frame block keeps at most 19 of the frame's lines under its heading, blank lines at both ends trimmed
  first; the cases' frames are all shorter.
- The folder-trust seed writes both the worktree path and its realpath when the two differ. A conformance world's
  paths are real (the runner hands every server a realpath TMPDIR), so no case sees two.
- Readiness needs the ready pattern on three consecutive reads 500 ms apart, an empty read never counts, and a
  Blocking dialog still on screen four polls after its answer ends the wait. The cases pin only that readiness is read
  between the wrapper and the prompt, and the dialog endings' words.

## C03: server lifecycle outside the route files (`server`)

Ticket C03's 25 rows are `engine.test.ts:7183` and `:13274`, `fleet.test.ts` and `ports.test.ts`. Every one is
a passing case in `cases/server-fleet.test.ts`, `server-ports.test.ts` and `server-terminal-phases.test.ts`,
but the half of `ports.test.ts:15` that a C00 case pins already. All seven of the area's gaps are cases, or
pinned by C00 already, and `cases/server-boot.test.ts` and `server-restart.test.ts` hold the rest: the boot
line, what a refused start leaves, and the Restart hand-off end to end through the real Boot. Some extras ride
along: a console.json port out of range, a registry lock a live writer holds and one left empty (both
`[slow]`, ten real seconds each), a `--pool` spelt with `..` and a trailing slash, and which entries a
registration keeps (every well-formed one of another pool, dead or with its directory gone, extra keys and
all; nothing malformed).

### Pinned by a C00 case already

- `ports.test.ts:15`, the half with 8787 free: `server-lifecycle.test.ts`'s case for `server.test.ts:2466`,
  which runs only when 8787 is free on the machine (Decided 2). The half with 8787 busy is in
  `server-ports.test.ts`, pinned short (below).
- The gap at `engine/server.ts:2694-2706` (a busy pin leaves no runs/server.pid of its own): the case for
  `server.test.ts:2307`.
- The gap at `engine/server.ts:1075-1081` (an empty runs/server.pid is cleared and claimed): the case for
  `server.test.ts:2198`, whose four lock contents include the empty one.

### Pinned as the Bun server does it, worth a look before the port copies it

- **A start refused after the pool lock leaves runs/server.pid behind** (`server-boot.test.ts`; the
  `conversations` section above meets the same with an empty pool). `createPoolServer` claims the lock before
  it loads the Tickets and Conversations and before it resolves the port, and releases it only on an orderly
  stop or a failed bind. So a Ticket file with no state line, a `--port` outside 0-65535 and a console.json
  port outside it each exit 1 leaving runs/server.pid naming the dead process. The next start takes a dead
  pid's lock over, which the case pins too, so nothing is stuck. Intended behaviour (inference): a start
  refused before it serves releases the lock it took, as a failed bind does, or checks the port before it
  takes the lock.
- **A refusal from the drive's first load comes after the bind and the registration**
  (`server-boot.test.ts`; inventory open question 5, its first bullet). An Assignment the drive refuses
  (`verify: 0`), or a `held-spawns.json` it cannot read, surfaces from `server.start()`, which the command line
  calls after the lock, the bind and the fleet entry, with no catch: the process dies of an unhandled
  rejection with exit 1, Bun's crash dump on stderr and no boot line, leaving runs/server.pid and its registry
  entry. The case pins the exit, the empty stdout, the message within stderr, the lock and the entry.
  Intended behaviour (inference): refused before the bind like any other pool-load error, exit 1 naming the
  problem, nothing left behind.
- **`--port` is read with JavaScript's `Number`** (`server-ports.test.ts`). A word is refused as `got NaN`,
  which the case pins for `abc`; a `--port` with nothing after it says the same. Not pinned: `--port ""` reads
  as 0 and boots on any free port, and `--port 0x10` and `--port 1e3` read as ports 16 and 1000 (which the
  system then refuses an ordinary user), where a Rust server parsing a decimal integer would refuse all three
  as given. Intended behaviour (inference): anything but decimal digits is refused, naming the text as given.

### Pinned short of what the Bun server prints

- **A registry lock a live writer holds.** After its ten-second wait the server writes
  `fleet registry: fleet registry: lock <path> is held by live pid <pid>` to stderr: `engine/fleet.ts`'s error
  starts `fleet registry: ` already and `engine/server.ts` adds it again. The case asks for one line that
  starts `fleet registry: ` and names the lock and its pid, so a server that says it once passes.
- **A registry that cannot be written** (the gap at `engine/server.ts:2711`): what follows `fleet registry: `
  is Bun's own error (`EEXIST: file already exists, mkdir '<HOME>/.agent-graphs'`), so the case pins the prefix
  and that the line is the only one on stderr.
- **The dead drive's error** (`engine.test.ts:7183`): Bun's is `Executable not found in $PATH: "claude"`, and
  runs/errors.jsonl carries its JavaScript stack beside it. The case asks for an error naming `claude`, the
  same error after `pool dead: ` as the pool log's last line, and no key beside `at`, `error` and an optional
  `stack`.
- **Which port the unpinned hunt lands on** (`ports.test.ts:15`, 8787 busy): other servers come and go on the
  ports just above 8787 on a shared machine, so the case pins a port above 8787 and outside the range the
  system assigns for port 0, not the first free one. Rust unit test: *port resolution: with neither a flag
  nor a pin, the server binds the first free port from 8787 upward.*
- **Port 0** (`ports.test.ts:30`, `:35`): "a free port the system assigns" is a port in the system's ephemeral
  range, read from Linux's `ip_local_port_range` or macOS's `net.inet.ip.portrange` sysctls; where neither can
  be read, only that it bound.
- **"Registers without waiting"** (`fleet.test.ts:152`): a boot within ten seconds of the launch, the wait a
  live writer's lock gets. A machine loaded enough to take that long to boot fails the case though the server
  is right.

### Where the cases reach a row differently from its wording

- `engine.test.ts:7183`: a drive that dies in its first super-step is dead before a socket can open, so the
  case runs 01 on the opencode stub, held until a socket watches, and kills the drive with 02's launch on
  claude. The server coalesces frames (seen: one running snapshot, then one delta straight to dead), so the
  case asks for at least one running frame before the dead one, and nothing else.
- `engine.test.ts:13274`, "SIGTERM (or POST /api/stop)": both, as two cases.
- `fleet.test.ts:211` and `:224`: "the live pid of the listener holding P" is the test process's own, since
  the rig's listener runs in it.
- `ports.test.ts:11`: the busy half holds the pin after the first server stopped on it, so the registry still
  lists that server; the refusal names no holder because its pid is dead.

### Observed while writing these, not pinned

- The relaunched Boot of a Restart opens the Console in a browser again: the hand-off passes no `--no-open`,
  so the tab already waiting for the port gets another beside it. The restart case puts a recording
  `xdg-open` and `open` first on the server's PATH. Intended behaviour (inference): a relaunch opens nothing.
- The boot line names `--pool` as given, not resolved: launched with `<repo>/.scratch/../.scratch/./pool/` it
  prints that spelling, while runs/server.pid, the registry and the refusals use the resolved path. Boot reads
  only the port from it.
- `ports.test.ts:23` stays hidden, as the inventory files it: the hunt's start port cannot be set from
  outside (Decided 2, no knobs).

## `herdr` panes: the pane survey, Peek, Held panes and Finished terminals (C15)

Every one of C15's 39 visible rows (36 `herdr`, 3 `enlist`) is a passing case in
`cases/herdr-panes-finished.test.ts`, `herdr-panes-held.test.ts`, `herdr-panes-survey.test.ts` and
`herdr-panes-reads.test.ts`, on the shared setup in `herdr-panes-support.ts`. So are the four gaps the C14
section above leaves here: the bulk close, its refused `tab.close`, the bulk close when `pane.list` fails, and
Peek of a pane no Turn loop watches. The two seam rows use new fake herdr controls: `answerWith(method, reply)`
answers every call of a method with a body given whole (a `pane.list` result with no `panes` list for
`herdr.test.ts:497`, a `tab_not_found` error for `:560`). Two more serve the survey rows: `relistPane(paneId,
listing)` changes how `pane.list` reports a pane, and `closeTab(tabId)` closes a tab the way the operator does
from herdr. Seven cases wait out the survey's real fifteen-second cadence and are named slow. The area's two hidden
rows (`pane-survey.test.ts:43` and `:64`, how refreshes queue behind a listing) stay Rust unit tests, as the
inventory sorts them.

How the cases come by a listing, which binds the Rust server:

- The Held panes and the Finished terminals count come from the survey's last listing, which lands on the
  cadence or when the engine asks for one. Where a row needs a listing at a moment of its own, the case asks
  for the bulk close (POST /api/terminals/close-finished) or Keep talking, both of which list through the
  survey before they act; only the cadence rows (`pane-survey.test.ts:9`, `:25`, `herdr.test.ts:497`) wait
  for the timer. So a Rust bulk close and Keep talking must list through the same survey the snapshot is
  derived from, and the listing they take must move the Held panes and the count as a cadence listing does.
- A pool booted over events written by hand carries a witness, a Ticket at a checkpoint over a listed pane.
  Holding it at boot asks for a listing at once, as `seedHeldPanes` does, so the first listing lands without
  the cadence. A server that waits for its cadence still passes, fifteen seconds slower.

Where the cases reach a row differently from its wording:

- `finished-terminals.test.ts:52`: the crash Interrupts of 01, 04 and 05 wait for their super-step, which the
  Live attempt holds open, so the case waits for the three Attempts to end rather than for their Interrupts.
- `held-panes.test.ts:78`: the headless attempt, the resolver attempt and the attempt never spawned are
  booted from events written by hand, since a terminal-backed pool runs nothing headless but a fallback and a
  resolver never checkpoints its Ticket. The fallback is a real run with `tab.create` refused.
- `held-panes.test.ts:48`: the candidate's checkpoint is raised only once its grader has graded it, so the
  case answers the grader with a pass.
- `keep-talking.test.ts:251`: the pane leaves herdr's listing through the fake's `endPane`, which writes no
  exit-code file, so the case is told apart from `:218`, where the TUI exits.
- `finished-terminals.test.ts:66`: the attempt's ending released the engine's report of its agent from herdr's
  `agent.list`, so the case binds the agent again (`seedAgent`) before the operator enlists it.
- `enlisted.test.ts:69`: the row has every `pane.read` of the enlisted pane a viewport read. Through POST
  /api/enlist that holds from the claim on only: the teaching Turn the claim types checks its paste with
  `recent` reads of 200 lines, as every typed Turn does (`LAUNCH_READ` in `engine/pane-session.ts`). The unit
  test registers with no teaching Turn, the shape a boot re-adoption has. The case pins the reads after the
  claim answers. Rust unit test: *enlisted attempts: registered with no teaching Turn, every read of the pane,
  the settling reads included, is `pane.read {pane_id, source: visible, format: text, strip_ansi: true}` with no
  line count, and each is recorded for Peek.*
- `enlisted.test.ts:128`: the row's second half, that disposing the enlisted attempts at shutdown forgets a
  live pane's recorded read, leaves nothing to see once the process is gone. Rust unit test: *enlisted
  attempts: dispose stops every tick and forgets every pane's recorded read.*
- `pane-reads.test.ts:20`: that forgetting a pane never recorded changes nothing is in-memory only. Rust unit
  test: *pane read register: forgetting a pane with no recorded read is a no-op and leaves the others.* It is
  `records_replaces_and_forgets` in `crates/engine/src/pane_reads.rs`.

Behaviour of the TypeScript server the cases pin as it is today, each worth a look before the port copies it:

- A tab herdr refuses to close at a Conversation's crash (`keep-talking.test.ts:491`) puts its
  `<id>: herdr tab <tab> could not be closed (<error>)` line in the pool's state with no snapshot of its own
  (`closeTabRecorded` in `engine/engine.ts` applies the line without emitting), so the line reaches GET
  /api/pool-log and the socket only with the next snapshot. The case publishes one with a Settings save that
  changes nothing (PUT /api/settings/pool with an empty `config`), and passes as well on a server that
  publishes the line when it writes it. Intended behaviour (inference): the line is published at once.
- The bulk close records each `tab-closed` on its owner's latest attempt, not on the attempt that opened the
  tab, and with the terminal id of the last spawn that named the tab (`finished-terminals.test.ts:38`: Ticket
  01's t1, opened by attempt 1 and named again by its Continued attempt 2, is recorded closed on attempt 3, a
  headless one, with no terminal id).
- The enlist claim's teaching Turn reads the scrollback of the operator's pane to check its paste, which moves
  the viewport of an operator sitting in it: what issue #122 stopped the Turn-state reads from doing. Not
  pinned either way; the case for `enlisted.test.ts:69` counts only the reads after the claim.

## `restart`: Tickets and Attempts (C05)

Forty-nine of C05's 50 rows are passing cases under `conformance/cases/restart-tickets-durability.test.ts`,
`restart-tickets-orphans.test.ts`, `restart-tickets-terminal.test.ts`, `restart-tickets-answers.test.ts`,
`restart-tickets-spawns.test.ts`, `restart-tickets-verify.test.ts` and `restart-tickets-merges.test.ts`. A case
that starts more than one server on its pool is a takeover case (`restartCase` in `restart-support.ts`): each
server after the first runs the next leg of CONFORMANCE_LEGS, so `--legs bun,rust` has the Rust server boot on
what the Bun one left. The five rows that stop at an Interrupt and resume with nothing changed between servers
(`engine.test.ts:7647`, `:9881`, `:13877`, `:1327`, `:3354`) run on the takeover harness itself and are matched
against the same run uninterrupted. Seven of the area's nine gaps are cases there too; the two about the
remembered Pool workspace (`engine/engine.ts:3039`, the relabel at boot, and `engine/engine.ts:2929`, a torn
`runs/pool-workspace.json`) belong with the Pool workspace rows of ticket C06 and are left to it.

### Left out

- **`merge-hold.test.ts:536`**, *reads a live resolver as resolving even when the engine never took the merge on
  (a boot adoption)*. The row's premise does not hold on the Bun server: boot never re-adopts a resolver's
  pane. `terminalAdoptable` in `engine/engine.ts` gives a resolver Attempt the headless orphan fate and releases
  its agent (the case for `engine.test.ts:6228` pins exactly that), so after a restart the Ticket's merge-conflict
  Interrupt stands and its `mergeState` reads needs-you. Every resolver the server does launch is one whose merge
  it took and marked resolving before the launch, so a live resolver the merge line never took cannot be made from
  outside. Rust unit test: *merge queue: a held ticket whose resolver Attempt is live reads resolving, not
  needs-you, even when the merge line never took it and its merge-conflict Interrupt is on record.* It is
  `a_live_resolver_reads_resolving_though_the_line_never_took_the_ticket` in `crates/core/src/merge_hold.rs`.

### Pinned short

- **The crash Interrupt of a re-adopted Attempt decided at boot** (`attempt-ending.test.ts:248`, `:390`). The
  body is pinned at its head (the reason and the log path) and its foot (the outcome file line) only, and the
  crash event's `logTail` only as an array: the lines between come from the pane's Stream file, where util-linux
  `script` writes its own start and done lines and BSD `script -q` writes none, as C08 found for Continued
  attempts.
- **The reused-pid and gone-worktree orphan checks run on Linux only** (`children.test.ts:86`,
  `engine.test.ts:13235`). The server reads a pid's working directory from `/proc` (`processCwd` in
  `engine/children.ts`); with no procfs it trusts liveness alone, so on macOS these two cases are skipped, not
  failed. See the first entry below.

### Pinned as the TypeScript server does it today, each worth a look before the port copies it

- **On macOS a reused pid is stopped as an orphan.** With no procfs, `orphanIsLive` treats any live process
  holding a recorded pid as the previous server's harness, so a boot TERMs, then KILLs, the process group of
  whatever unrelated process has since been given that pid, and also stops a recorded pid whose worktree is gone.
  Intended behaviour (inference): the cwd check holds on every platform (macOS has `proc_pidinfo`). Rust unit
  test: *orphan liveness: a live pid whose working directory is not the recorded worktree, or whose worktree is
  gone, is never an orphan, on Linux and macOS alike.*
- **A store that refuses every write does not stop a server from stopping in order** (`engine.test.ts:7114`). The
  server stopped while the case holds its exclusive lock on `console.db` exits 0 and releases the pool lock, with
  no checkpoint row ever written; the next boot runs from the state lines alone. The case pins that.

### Where the cases reach a row differently from its wording

- **`engine.test.ts:10346`** (a SIGKILL mid-super-step). A SIGKILL stops nothing, so 02's held stub outlives the
  server in its worktree, and the next boot stops it as an orphan before it puts 02 back to ready: the "back to
  ready" line the row names is the orphan line (`... is still running from the previous engine process; stopping
  it before scheduling, ticket back to ready`), which the case pins with the stub's pid.
- **`engine.test.ts:12561`** (an answered Interrupt across a SIGKILL). The resumed attempt the kill left running is
  let go and waited out before the restart, so the boot finds no agent alive and takes the plain reset; left
  running, it would take the orphan path of `engine.test.ts:13174` instead.
- **`merge-hold.test.ts:526`** (a restart's merge queue). The one merge the restart takes on must stay queued long
  enough to read, and a merge is one synchronous git run inside the server. The only thing that holds one from
  outside is the pool checkout's gate: the case continues Ticket 01 in the pool checkout by Keep talking, stops,
  writes 03, 07 and 09 done on branches main lacks with 07's events ending in `merge-deferred`, and restarts. The
  re-adopted Continued attempt holds 07's re-chained merge at the gate, so the queue reads 07 queued, then 03 and
  09 stalled, beside the Continued attempt's adoption checkpoint, the one Interrupt up.
- **`children.test.ts:62`** (a harness that ignores TERM). The stub is made to ignore TERM by its own wrapper
  (`trap '' TERM` before its exec), since the stop signals the whole process group and the stub script itself
  must outlive the TERM for the KILL to be what ends it (exit 137).

### Hidden

- `children.test.ts:76` stays a Rust unit test, as the inventory sorts it: *shutdown child stop: a harness child
  registered after the shutdown began is sent TERM to its process group on arrival, so a launch racing the stop
  cannot outlive it.*

## `attempts`: endings and logs (C13)

Every one of C13's 60 rows is a passing case under `conformance/cases/attempts-endings-pane.test.ts`,
`attempts-endings-liveness.test.ts`, `attempts-endings-exits.test.ts` and `attempts-endings-logs.test.ts`, and so is
the area's stderr gap (a headless Attempt's stderr reaches its log, never its Stream file, and never joins a stdout
line part way through). One gap no list named is a case too: an exit-code file left in `runs/` from before a
terminal-backed launch is removed as the wrapper is sent, so it never ends the new Attempt
(`engine/pane-session.ts:314`). No row is left out. Of the twelve rows with a seam:

- The eight that ask for short liveness and grace cadences (`attempt-ending.test.ts:120`, `:150`, `:167`, `:195`,
  `:223`, `:452`, `:484`, `:491`) wait out the real 30 s sweep and 10 s grace window (Decided 2), in the two slow
  cases of `attempts-endings-liveness.test.ts`, each of which runs its worlds side by side.
- `attempt-ending.test.ts:80` and `herdr.test.ts:449` (the subscriber connections) use the fake's
  `openConnections` (C14) and a new `listedPanes` control.
- The fake herdr gained the rest: `delistPane` (a pane reaped from the listing while its process runs on,
  `attempt-ending.test.ts:167`), `hangUpSubscribers` (a plain FIN on every subscriber, `herdr.test.ts:418`),
  `endPaneOn(method, paneId, nth)` (a pane ended as a chosen call arrives, `herdr.test.ts:462`), `closeTab` and
  `closePane` (an operator's own closes, `herdr.test.ts:337`, `:351`, `:398`, `:406`), and the fake's process a
  `kill()` (a daemon that dies mid-Attempt, `herdr.test.ts:441`).

Where the cases reach a row differently from its wording:

- **Which `pane.list` is the sweep.** The ending's liveness sweep and the pane survey both list with `pane.list {}`,
  so a case cannot tell one from the other. The "several sweeps" rows (`:120`, `:195`, `:223`) wait two sweep
  periods from the moment the ending's wait began, and `:167` lets its stub exit 2 s after the first sweep is due,
  inside the grace window (one run saw the sweep 30.0 s in and, with no exit, the pane-gone crash at 40.1 s). A
  server whose sweep fires late finds the exit code through its file poll instead, and the case passes without
  reaching the grace window. Rust unit test: *ending wait: an exit-code file that lands inside the grace window
  after a sweep found the pane gone ends the Attempt with the file's code, never as pane gone.*
- **Where the ending's wait begins.** A case finds it as the `events.subscribe` the server holds open once the
  prompt's Enter is in, or, with every subscription dropped, the one made after the Enter. The Bun server
  subscribes twice per launch, once for the readiness wait, let go before the prompt is typed; only
  `herdr.test.ts:462` depends on that, arming the pane's end on the second `events.subscribe`.
- **`streamlog.test.ts:199`** (the operator's keystrokes in the typescript): the fake herdr types nothing into a
  pane's terminal, so the stub prints the echoed prompt line itself, as a TUI does.
- **Splits across chunks** (`streamlog.test.ts:137`, `:144`, `:209`): the stub pauses 0.3 to 0.6 s inside the line,
  the character or the escape. A server that reads both halves in one go passes without reassembling anything.
  Rust unit test: *stream and transcript line buffers: a line, a UTF-8 character and an escape sequence split
  across two chunks each come out whole, exactly once.*
- **`attempt-ending.test.ts:435`** pins what `attempt-run.test.ts:420` (C11, `attempts-launch.test.ts`) already
  does, plus the resolver's own log and Stream file. `engine.test.ts:5026` builds the conflict the way C11 does,
  so the resolver's files are `01.resolver.*` rather than the row's `02.resolver.*`.
- **`engine.test.ts:3825` and `:5163`** are one case on opencode: its raw log, a stream-json line and a carriage
  return kept as they came, rotated to `01.attempt-1.log` by the re-run, and no Stream file for either attempt.

Behaviour of the TypeScript server the cases tolerate rather than pin:

- On Linux every terminal-backed Attempt's derived log carries util-linux script(1)'s own banner: a
  `Script started on <local time> [COMMAND="..." <not executed on terminal>]` line before the harness's first
  output and, once the harness exits, a blank line and `Script done on <local time> [COMMAND_EXIT_CODE="<n>"]`. So
  do the exited and crash events' `logTail` and the crash Interrupt body. BSD's script, the Mac's, writes neither
  under `-q`. The server does not strip them, and the cases read the transcript without them (`transcriptLines` in
  `attempts-endings-support.ts`). A Rust server that runs the same `script` keeps them unless the port decides to
  strip them.

## `conversations`: Turn state and Notices (C17)

Every one of C17's 38 rows is a passing case under `conformance/cases/conversations-turns-state.test.ts`,
`conversations-turns-lines.test.ts`, `conversations-notices-texts.test.ts` and
`conversations-notices-delivery.test.ts`, on the shared setup in `conversations-support.ts`. So is the gap the C16
section above leaves here, a Notice still queued when its parent ends (`engine/conversations.ts:2386-2390`), and two
more no list named: a checkpoint Notice from a pool with no git checkout, and the placeholder Brief a checkpoint
written without one is told with (the visible side of the hidden row `notices.test.ts:73`). Every Notice typed or
dropped is compared whole, byte for byte, with its text written out in the case (Decided 4). No harness or fixture
changed. The area's four hidden rows (`turn-state.test.ts:39`, `:97`, `:316`, `notices.test.ts:73`) stay Rust unit
tests, as the inventory sorts them: a publish that changes nothing on the wire sends no frame, so whether the server
signalled one cannot be seen.

How the cases see a Turn, which binds the Rust server:

- A Conversation's Turn-state reads are the only viewport reads (`pane.read` with `source: visible`) of its pane;
  readiness and paste checks read `recent`. The cases count them to tell which read did what, so a Rust server that
  reads a Conversation's viewport for anything else, or more than once a tick, fails them.
- The flip to waiting is pinned by its idleSince: no earlier than the third read of the idle frame reaching herdr
  and no later than the fourth. The Bun server stamps it as the third read returns.
- "Publishes nothing" is pinned as no socket frame that changes the Conversation's `turn`.

Where the cases reach a row differently from its wording:

- **`notices.test.ts:139`'s seam** (a diff git cannot compute) is reached without one: the case plays an agent that
  renames its own branch before it pauses, so the branch the server names in `git diff --stat
  <target>...<branch>` no longer exists and git refuses the diff.
- **`notices.test.ts:44`, `:130`**: a lone spawned Ticket runs in the pool checkout and never merges (see below),
  so the case spawns two at once, which gives each a worktree, and pauses the second. Its done and checkpoint
  Notices are each matched whole, in either order: the pause is told at its exit and the merge at the end of the
  super-step.
- **`notices.test.ts:86`** and every other spawned Ticket's Notice: the title is the heading the server writes into
  a spawned Ticket's file, which leads with its id (`conv-1-spawn-2: Old idea`), not the proposal's title alone.
- **`notices.test.ts:668`, `:744`, `:813`**: the spawned Ticket runs in a pane on the claude TUI stand-in like its
  parent, not headless on a stub, and the case plays its agent. Under `verify: 1` its Attempt's prompt names
  `conv-1-spawn-1.attempt-1.outcome.json`, and the Notice names that Attempt's branch, `pool/<key>/conv-1-spawn-1.attempt-1`.
- **`notices.test.ts:744`**: the failed delivery's `error` is pinned as `pane.send_input failed: ` followed by the
  daemon's error body, which is the fake's own, so only its message is checked inside it.
- **`turn-state.test.ts:119`**: a frame with content stands between the all-chrome frame and the empty one, so
  each of the two publishes its own empty last line.
- **`steward.test.ts:671`** is pinned on the Steward, as worded. The delivery failure shown on the view and its
  pool log lines are the same for any Conversation; the case for `notices.test.ts:744` pins them on a plain one.

Behaviour of the TypeScript server the cases pin as it is today, each worth a look before the port copies it:

- A spawned Ticket's Notice repeats its id inside the title, `Ticket conv-1-spawn-1 ("conv-1-spawn-1: Checkpointing
  child") ended: checkpoint.`, since the title is the file's heading.
- A lone spawned Ticket runs in the pool checkout, on no branch of its own, yet its checkpoint Notice names
  `Branch: pool/<key>/<id>`, a branch that does not exist, and `(no changes)` as its diff, because git cannot
  compute one against a missing branch.

Observed while writing these, not pinned:

- **A lone spawned Ticket that finishes done tells its parent nothing.** It ran in the pool checkout, so nothing
  merges, and only the merge paths call `ticketEnded` (`engine/engine.ts`). No Notice is queued, typed or dropped:
  a run with the parent waiting saw none in twelve seconds after the Ticket's done. The teaching tells the agent a
  spawned Ticket reports back once it ends, done included. Intended behaviour (inference): a done Notice whose
  diff is the range the Attempt added to the working branch. Rust unit test, once decided: *a spawned Ticket that
  ends done in the pool checkout queues a ticket-ended Notice to its parent.*
- **The third drop reason**, `parent conversation is ending`, needs a child's Notice raised after its parent's End
  began and before it finished, and an End with nothing to merge takes no time a case can hold open from outside.
  Rust unit test: *Notice queue: a Notice for a parent whose End is under way is dropped at once, logged on the
  child's latest attempt with reason `parent conversation is ending` and the Notice's text.*
- Rust unit tests for what the delivery does inside one drain, which no case can time: *Notice delivery: the queue
  is claimed whole before the first Turn is typed, so a tick and an enqueue racing it never type a Notice twice;
  a Turn that fails puts itself and the rest of the claimed queue back at the front, in order; a read that throws
  leaves the Turn state as it was, and the next tick reads as usual.*

## C02: the socket protocol and the HTTP read surface (`protocol`, `http`)

Ticket C02's 16 rows are passing cases: the fourteen `protocol.test.ts` rows of the `protocol` area in
`cases/protocol-deltas.test.ts`, `protocol-log-window.test.ts` and `protocol-envelope.test.ts`, and the two
`http` rows, `protocol.test.ts:306` and `stat-cache.test.ts:65`, in `http-page.test.ts` and
`http-reads.test.ts`. (`protocol.test.ts` has since moved to `ui/src/protocol.test.ts`, each case two lines
below the line the inventory cites.) All six of the `protocol` area's gaps and nine of the `http` area's ten
are cases too, in `protocol-envelope.test.ts`, `protocol-cards.test.ts`, `http-page.test.ts`,
`http-reads.test.ts` and `http-bodies.test.ts`.

### Fixed in the Rust server (Decided 5)

- **GET /api/ticket?id=01 beside an adopted `01-spawn-1.md`** (the gap at `engine/server.ts:958`).
  `ticketBodyFile` served the first file `readdir` listed whose name before its first `-` is the id, so which
  of `01-a.md` and `01-spawn-1.md` answered for 01 depended on the filesystem: tmpfs lists the newest first,
  while a sorted listing (APFS) serves `01-a.md`. The intended answer, the Ticket's own file, is open question
  5's (Decided 5). The Rust server takes `<id>.md`, then the `<id>-*.md` file whose state line names the id,
  and only then a file with no readable state line, by name; a spawned child's file never answers for its
  parent. The socket's card for 01 reads the same file. The case in `pool-routes.test.ts` pins it, and the
  Rust unit test, *ticket body lookup: with `01-a.md` and `01-spawn-1.md` in issues/, id 01 resolves to
  `01-a.md`, the file whose state line says id=01, whatever order the directory lists them in*, is
  `ticket_body_lookup_takes_the_file_whose_state_line_names_the_id_in_any_listing_order` in
  `crates/server/src/reads.rs`.

### Pinned as the Bun server does it, worth a look before the port copies it

- **Unknown paths answer 500** (`http-page.test.ts`, the gap at `engine/server.ts:395`). An unknown `/api/`
  route, a GET on a POST-only route and a missing asset each answer 500 with Bun's own HTML error page:
  `serveStatic` tests the Promise `Bun.file().exists()` returns, which is always truthy, so it answers every
  path with a file that is not there and the read fails; the `not found` 404 at the end of the route table is
  never reached. The case pins the 500 alone, and that the server stays up. Intended behaviour (open question
  5, Decided 5): 404 `not found`. conv-1-spawn-14 was closed without that fix, so the Rust server answers
  the same 500 (a plain `Internal Server Error`); when the TypeScript fix lands, the case and the Rust
  fallback in `crates/server/src/http.rs` both move to 404. The traversal case beside it asks only that a path climbing out of the build answers an error
  and nothing of the file, so it holds either way.
- **A body that is not JSON** (`http-bodies.test.ts`, the gap at `engine/server.ts:1958`). POST /api/resume
  and both settings PUTs answer 400 `{error: "Failed to parse JSON"}`, the message Bun's `req.json()` throws;
  PUT /api/reassign answers 500 with it, as the server's own failure, though the route's comment keeps that for
  a file it cannot read (C20's section notes the same); every other JSON route answers 400
  `{reason: "invalid JSON body"}`. The case pins all of it, Bun's words included, so a Rust server says
  `Failed to parse JSON` where the Bun server does. Intended behaviour (inference): the Reassign answers 400,
  as the routes beside it do.

### Where the cases reach a row differently from its wording

- **The snapshot re-read.** GET /api/state serves the snapshot built at the last engine emit, Reassign or
  settings save, and a pool at rest emits nothing (C20's section has the detail). `protocol.test.ts:92`,
  `:114` and `:122` re-read with a Reassign of a Ticket to the model its assign entry already names, as the
  rows say, which leaves every Assignment as it was and rebuilds the snapshot. `stat-cache.test.ts:65` and the
  gap at `engine/server.ts:1244` re-read with a Reassign naming only a done Ticket (`rebuiltSnapshot` in
  `cases/config-support.ts`), which writes nothing.
- **A pool log over the window** (`protocol.test.ts:149`, `:233`, `:247`) comes from a restored checkpoint,
  one of the two ways the rows name: a first server rests and stops, its last checkpoint in console.db has
  its log replaced by lines of the case's own, and the server under test restores them as it boots. The rest
  of that checkpoint is as the first server wrote it. `:247` also reads the page's embedded boot, which
  carries the same trimmed window.
- **By reference** (`protocol.test.ts:97` and `:184`). Neighbours and untouched lists kept by reference are
  the Console's apply, client code now in `ui/src/protocol.ts` (Decided 3); the cases pin the server's half,
  that a delta resends none of them.
- **The hostile title** (`protocol.test.ts:306`). The engine test counted one `</script>` in a page of its
  own making. The built page carries its own module script, so the case pins that the boot element's text
  holds no `<` at all, runs whole to the `</script></head>` that closes it, and parses back to GET
  /api/state's snapshot with the title intact.
- **The envelope** (`protocol.test.ts:258`, `:276`). The engine tests decoded frames in process; the cases
  send them to a real server, on a finished pool so that a stop run by mistake would show. Request 3's reply
  carries id 3, its kind, the socket's revision and the HTTP twin's refusal; the six frames that are not the
  protocol's get nothing back, and the next request is answered. A frame sent as given, text or binary, goes
  through `sendRaw`, which the socket fixture gained for these cases.
- **Conversations** (`protocol.test.ts:130`, and the gap at `engine/ws.ts:681`) are started through POST
  /api/conversations on the fake herdr, each waited for until its Turn rests, so the first is unchanged while
  the second starts.

### Hidden behaviour worth a Rust unit test

- A socket counts as visible from its opening until its hello says otherwise. A live check that runs before a
  hidden tab's hello lands sends it activity and peeks once, and a socket opening after a live check is sent
  the whole live cache before its hello is read. The hidden-grades case counts only what follows its hello's
  round trip. Rust unit test: *live check: a socket is visible until its hello says otherwise; once a hello
  says visible false, no live frame it is sent carries activity or peeks, and a change of grades still
  reaches it as a live frame with grades alone.* It is
  `a_socket_is_visible_until_its_hello_says_otherwise_and_a_hidden_one_gets_grades_alone` in
  `crates/server/src/tests.rs`.
- A Ticket file that will not load leaves the server on the last Ticket list that did, for every route and
  the snapshot alike, and each later read tries again. The draft case pins two readers of it. Rust unit test:
  *pool meta: a read of issues/ that fails keeps the last list that loaded, and the next read that loads
  replaces it.* It is `a_read_of_issues_that_fails_keeps_the_last_list_and_the_next_good_read_replaces_it` in
  `crates/server/src/tests.rs`.

### Observed while writing these, not pinned

- An engine emit that changes nothing but `seq` goes out as a delta of `set.seq` alone (seen while a
  Conversation starts, on its Turn polls).
- The Steward routes answer a body that is not JSON with 400 `{reason: "invalid JSON body"}` too (C18's area).
- GET / with no UI build answers 500, Bun's page for the missing `index.html`; the Rust binary embeds the UI,
  so it never lacks one: `crates/server/build.rs` refuses a release build without `ui/dist/index.html`.

## `restart`: Conversations and panes (C06)

Every one of C06's 28 rows is a passing case under `conformance/cases/restart-conversations-boot.test.ts`,
`restart-conversations-ends.test.ts`, `restart-panes-held.test.ts`, `restart-panes-continued.test.ts` and
`restart-panes-workspace.test.ts`, on the shared setup in `restart-conversations-support.ts`. So are the two gaps C05
left here, as restarts rather than seeded boots: the relabel at boot of a Pool workspace the pool created, to a title
edited while no server ran (`engine/engine.ts:3039`), and a torn `runs/pool-workspace.json` resolved afresh
(`engine/engine.ts:2929`). A case that starts two servers on its pool is a takeover case (`restartCase`), its second
server the next leg of CONFORMANCE_LEGS, with one fake herdr alive across both. A row that boots on records a dead
server left, written by hand, starts one server. The one seam row (`herdr.test.ts:544`) answers `agent.list` with the
fake's `answerWith`. Two cases wait out the pane survey's real fifteen-second cadence and are named slow. No row is
left out, and no harness or fixture changed.

### Where the cases reach a row differently from its wording

- **`herdr.test.ts:158`, `:176` and `:255`** run as restarts. The first server, launched in no workspace, creates the
  Pool workspace (the fake's `w1`), remembers it and stops; the second is launched in `w-launch`, which the fake
  holds, and runs a Ticket added while no server ran, so its tab shows where the pool's tabs go. For `:255` two
  Tickets run in `w1` and stop held in their panes; while no server runs, 02's pane is listed under `w8`. The boot's
  listing is `pane.list {workspace_id: w1}`: 01 is re-adopted, and 02's attempt is crashed as pane gone and re-run in
  a new tab of `w1`, its moved pane only released (see the first entry below).
- **`conversations.test.ts:993`**: the exit-code file is written by hand while no server runs, as the row says, with
  the stub TUI still running in the pane; the boot reads it, crashes the Conversation and closes the tab.
- **`conversations.test.ts:1061` and `:1200`** have no survey knob (Decided 2). `:1061` waits for the cadence
  listing that re-adopts the record. `:1200` must End before any listing finds the other terminal, or that listing
  would crash the record first (the boot rule for a pane listed as another terminal), so the case waits for the
  survey's first refused cadence listing, then relists the pane, lets `pane.list` answer and Ends at once, inside the
  fifteen seconds before the next. Rust unit test: *an End on a live started Conversation with no runtime, whose
  recorded pane herdr lists as another terminal, releases no agent, closes no tab and ends it.*
- **`conversations.test.ts:1087`**: `finishedTerminals` 0 is read after a listing on demand (POST
  /api/terminals/close-finished, which answers `closed: 0`), since a boot over a pane it holds no Ticket for lists
  only on the cadence.
- **`conversations.test.ts:1134`**: both concurrent POST /api/conversations/end answer 202, and the events hold one
  `end-requested`, one `merged` and one `ended`. The race the row is about, two claims on one id, is inside the
  server; HTTP reaches it only while the first End's claim awaits its listing, which the second request almost always
  lands in. Rust unit test: *Conversation claims: two Ends, or an End and the boot's adoption pass, racing on a live
  record with no runtime build one runtime, and the ending is recorded once.*
- **`keep-talking.test.ts:832`**: the first server boots on 02's orphan written by hand in its worktree, as the engine
  test does, since a Ticket working in a worktree beside a lone Ticket in the pool checkout arises only from a
  restart; the stop and start that follow are real.
- **`keep-talking.test.ts:889`**: the Conversation runs on opencode and the Ticket it proposes names claude in its
  `assign`. Once `_claude` is scripted the stub keys every claude launch `_claude`, so a Conversation on claude could
  not be told apart from the Tickets' launches.
- **`keep-talking.test.ts:768`**: the TUI quitting while no server runs is its pane ended through the fake
  (`endPane`), since the stub's own quit file is bounded at a minute; with attempt 2's exit on record, the boot reads
  either the same way.
- **`held-panes.test.ts:93`**: the attempt between the two checkpoints crashed and was answered, and attempt 1's pane
  is still listed beside attempt 3's, so the latest checkpoint decides, not the first listed pane.
- **`herdr.test.ts:544`** boots once on the live enlisted record with the operator's pane seeded and `agent.list`
  answered `{type: agent_list}` with no `agents`; the drive at rest proves boot reconciliation has run.

### Pinned as the TypeScript server does it today, each worth a look before the port copies it

- **An orphan pane moved out of the Pool workspace while no server ran is crashed, and its Ticket re-run beside it**
  (`herdr.test.ts:255`'s case). Boot reconciliation lists only the Pool workspace, so a Ticket's pane the operator
  moved to another workspace reads as gone: the attempt is crashed, its agent released, and the Ticket re-run in a
  new tab, in the same worktree, while the moved pane's harness may still be working there. The comment before
  `releaseOrphanAgent` in `reconcileTerminalAttempts` (`engine/engine.ts`) says the pane may still be alive. Intended
  behaviour (inference): an orphan's pane is looked for daemon-wide by its recorded ids before it is called gone, as a
  Conversation's is and as an enlisted Ticket's already is.
- **A merge redone at boot is recorded deferred a second time** (`keep-talking.test.ts:832`, `:889`): meeting the
  pool checkout's gate again, the redo appends another `merge-deferred`, so the Ticket's events read `merge-deferred`
  twice before `merged`. The cases pin the whole list.

### Observed while writing these, not pinned

- While a merge redone at boot waits at the pool checkout's gate, the drive's phase stays `running` until the Continued
  attempt ends (inference: the merge hold stands at the first boundary). The cases wait for the redo's pool log line
  (`ticket <id>: merge dropped at the last shutdown chained again`) and the Ticket's `mergeState: queued` instead.
- A started Conversation's TUI counts as exited at boot only when its exit-code file is no older than its launch's
  `spawned` event, so a stale file never crashes a live talk. No case makes a stale file appear after a launch. Rust
  unit test: *Conversation boot adoption: an exit-code file older than the recorded launch is not read as the TUI
  exiting, and the Conversation is re-adopted.*

## `cli`: Boot, the Steward's command and the fleet list (C04)

### Changed on purpose (ADR-0036, "Scope")

Boot no longer builds the Console. The release binary embeds the UI and the shim (`bin/agent-console`)
rebuilds the binary when it is stale, so `buildConsole`, its staleness check (`needsRebuild`, `distMtime`,
`uiSourceCommitMs`) and Boot's prose about building have no Rust counterpart. These are the lines the
TypeScript Boot printed that the Rust Boot never prints:

- `the Console build is missing or stale; rebuilding` (stdout, when `ui/dist/index.html` was missing or older
  than the last commit touching `ui/src`).
- Everything `bun install` and `bun run build` printed in the engine's `ui/`, on both streams.
- `the Console build failed; fix it and boot again` (stderr, then exit 1).

`boot-cli.test.ts:536` (rebuilds when there is no build and when the source is newer) is dropped with them, as
the inventory already says.

Boot starts the server as this same binary, `agent-console server --pool <dir> [--port <n>]`, in the engine
checkout, detached in its own session with both streams appended to `runs/server.log`, where the TypeScript
ran `bun run engine/server.ts` with the same arguments. So the Machine defaults' `engine` no longer chooses
which server code runs; it still names the checkout Boot reads `skills/my-console-runner/` from, runs the
server in, prints on the `detected:` line and writes into a first Machine defaults file. When it names no
directory that exists, that checkout is the one the binary was built from, where the TypeScript took the one
its source sat in.

The Steward command's usage names the command it is: its first line reads `usage: agent-console steward
--pool <pool-dir> [--url <console-url>] --as <conversation> <verb> ...` where steward-cli.ts printed
`usage: bun steward-cli.ts --pool ...`. The verb lines are unchanged, and `cli-steward.test.ts` pins only
those. Boot's own usage line is the TypeScript's, word for word.

### Hidden: Rust unit tests

Both of the area's hidden rows are unit tests in `crates/cli/src/boot/config.rs`:
`removes_the_port_pin_on_an_explicit_auto_and_the_terminal_key_on_a_no` (`boot-cli.test.ts:348`) and
`returns_nothing_to_write_when_the_template_itself_has_no_marker` (`boot-cli.test.ts:451`).

## `verify` with Jev (C22)

Every one of C22's 29 rows is a passing case on the Jev fake at `JEV_BASE_URL`: `engine.test.ts:2428` in
`cases/jev.test.ts`, the other 28 under `cases/verify-jev-grading.test.ts`, `verify-jev-rubric.test.ts` and
`verify-jev-fallbacks.test.ts`. Four cases no row names are there too: the whole request one Attempt sends (the
rubric's nine questions word for word, and its Evidence object whole: the Ticket text as it reads mid-round, the
summary claim, the `-U0` diff with a lockfile's section dropped, the log with its escape sequences stripped, and
both notes), the Evidence of a pool outside git (`no diff: the pool does not run in git`), a widening re-ask that
fails, and the statuses no cause names (408 after its retries and 404 at once, both `unreachable`). The fake
gained `failFor`, a status served by the Evidence a request carries, and its server no longer cuts a held
response at Bun's 10 s idle limit, which raced the client's own 10 s timeout.

Where the cases reach a row differently from its wording, or pin less than the server does:

- **`jev.test.ts:191`, a label not offered.** The rubric asks only Scores and Nouls, so the server never asks a
  Choice, and no answer can carry a label it did not offer. The case pins the wrong-type half. Rust unit test:
  *Jev answer check: a Choice answered with a label outside its criteria falls back as malformed, detail
  `<id>: choice is not one of the labels`.*
- **`engine.test.ts:13466`, "Turn state reads or grades".** Grading is the only place today's server asks Jev, so
  the four asks are four verify: 1 Tickets run one after another, the first two refused with 429.
- **The SDK's message in a detail** (`jev.test.ts:159`, `:166`). For a 400 or a 422 the detail is `HTTP <status>: `
  and then the TypeSafe SDK's own error message, which the cases pin only as carrying the API's words. Today it
  repeats the status and adds the body's `error`, `message`, `detail` or `detail.message` string, or the body as
  JSON cut at 200 characters when it has none: `HTTP 400: 400 question set refused`,
  `HTTP 400: 400 {"detail":{"error_type":"max_tokens_exceeded"}}`. Rust unit test: *Jev error detail: a refused
  request's detail names its status and the message its body gives.*
- **A dead network's detail** (`jev.test.ts:144`) is the HTTP client's own error, under Bun
  `Connection error: Unable to connect. Is the computer able to access the url?`. The case pins the cause only.
- **`jev.test.ts:186`, a body that is not JSON.** The SDK hands back the unparsed text, so the detail is the
  server's own shape check, `response is not an object`, and the case pins it whole. A client that fails the
  parse itself must still say `malformed`, with that detail.
- **The waits between retries.** The cases pin how often each failure is asked (three times for 408, 429, any 5xx
  and a timeout; once for 400, 401, 403, 404 and 422) and the 10 s per-try timeout (`no answer within 10000ms`,
  a slow case that waits it out three times), not the waits between tries. The SDK backs off 500 ms, then 1 s,
  each less up to a quarter at random and capped at 5 s, and honours a `retry-after-ms` or `Retry-After` header up
  to 60 s. Rust unit test: *Jev retry policy: two retries of 408, 429, 5xx, connection errors and timeouts, with
  that backoff and that header rule.*

Hidden behaviour the cases cannot show, for the Rust port:

- **The size check before the wire** (`jev.test.ts:225`, `:235`, `:247`, hidden rows) cannot fire from outside:
  the Evidence builder caps Evidence at 100,000 characters, about 28,600 tokens at 3.5 characters per token, and
  the longest rubric question adds about 400, under the 32,000-token limit. The builder's 100,000-character cap
  and its 2,000-character diff and 4,000-character log floors (`jev-evidence.test.ts`) are out of reach for the
  same reason. Both stay Rust unit tests, as the inventory sorts them.
- **The composed score's rounding.** The score is `round(sum * 10 * 10) / 10` in floating point, summed ticket
  fit, then claim fidelity, then log health. The rubric case at level 0 depends on it: the fake's expected levels
  sit a hair under 0.25, 0.2 and 0.2, the sum a hair under 0.065, and the score is 0.6, not 0.7. A Rust server
  summing `f64` in the same order and rounding half up matches:
  `the_composed_score_sums_in_rubric_order_and_rounds_a_hair_under_half_down` in `crates/core/src/jev_rubric.rs`.
- **A Score answered outside its levels** (inference, from reading `engine/jev-rubric.ts`). The answer check
  accepts any finite score, so a ticket fit of 4.6 on its five levels normalises to 1.15, the composed score can
  pass 10, and the reason reads `ticket fit: level 4.6`. No case pins it, since the API answers within the
  levels. Intended behaviour (inference): a score outside `0..levels-1` is malformed. Rust unit test: *Jev answer
  check: a Score outside its levels falls back as malformed.*

## `herdr` and `enlist`: the Rust port's choices (r-panes)

Where the Rust port differs from the TypeScript on purpose, or copied what looks wrong:

- **A Turn read in flight when an enlisted tick stops.** In `engine/enlisted.ts` a `pane.read` already out when the
  ending watch (or a release) stops the tick still records its text in the pane read register afterwards, so
  a Peek can serve a viewport frozen after the entry was forgotten. The Rust port drops such a read. No case
  can time it; the Peek would otherwise answer a pane nothing watches.
- **A conflicted enlisted merge keeps its writer mark.** `chainEnlistedMerge` handles the conflict (the
  resolver run included) inside the pool checkout's gate, so the merge counts as a writer there until it is
  settled and Keep talking refuses beside it. The Rust gate runs one synchronous merge, so the port re-takes
  the same mark inside the merge's own job and releases it when the conflict handling ends. Same words, same
  span.
- **The enlist teaching's paste check** reads `recent` 200 lines of the operator's pane (`type_verified`), which
  moves their viewport; copied as the TypeScript has it (see `herdr` panes above).
- **A refused `tab.close` outside the bulk close** writes its pool-log line and a `tab-close-failed` event with no
  snapshot emitted; copied as is.

## `restart`: what the Rust port does differently (r-restart)

- **The tab of a boot-adopted or boot-redone merge's attempt is recorded closed sooner in Rust.** Two cases read
  a Ticket's events right after its `merged` event, and expect them to end there: the one for
  `attempt-ending.test.ts:405` (a re-adopted attempt that wrote a done Outcome while no server ran; read at the
  Review) and the one for `keep-talking.test.ts:832` (a merge held at the gate and redone after a restart; read
  as soon as `merged` shows). On Bun the `tab-closed` event lands later than the read, 200 to 400 ms after
  `merged` in a world with a fake herdr: the close is a round trip over a fresh socket that waits behind the
  synchronous merges of the same burst. In Rust the close runs on its own task, and its event follows `merged` by
  a few milliseconds. Nothing about the Ticket differs, only when the event is written. The three cases that read
  there now wait for the `tab-closed` event and expect it last, so they pin the same events on both servers
  without racing the close.
- **A merge a boot takes on holds the pool checkout for the merge only.** On Bun the checkout is held across the
  resolver a conflict starts; the Rust gate's closure cannot await. Keep talking's refusal beside a boot-adopted
  merge's resolver names a different writer.
