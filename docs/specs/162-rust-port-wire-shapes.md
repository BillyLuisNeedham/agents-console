# Wire shapes as the Bun server builds them

Research for the Rust port (issue #162): how each wire object is built at runtime, in what key order, and
what is always present, read from the TypeScript at c429645 and checked against Bun 1.3.14. The Rust
server's objects follow this, so frames and bodies read the same. Line numbers are engine/server.ts unless
said otherwise.

## Global rules

- **Serialisation.** All JSON goes through `JSON.stringify` or Bun's `Response.json`. Keys whose value is
  `undefined` are dropped; NaN and Infinity become `null`.
- **Integer-like keys.** JavaScript objects keep keys in insertion order, except integer-like keys ("0",
  "1", "42", no leading zero), which serialise first in ascending numeric order. This affects every map
  keyed by ticket id: `grades`, `live.activity`, `live.peeks`, `state.outcomes`, `stewardBudget.used`. An id
  like "01" is not integer-like.
- **Explicit undefined.** No listed shape is built with a key set to `undefined`; optional keys come from
  conditional spreads. The exceptions are `state.config` after a config reload and `lastEventAt` from a
  hand-written event line (below).
- **Snapshot stripping on the socket.** `withoutSnapshot` (ws.ts:100-106) removes `snapshot` from a result
  with a rest-spread, keeping the remaining key order: start, resume and conversations.end reply `{}`;
  reassign replies `{applied, skipped}`.
- **Uncaught throws.** A throw that escapes an HTTP route gets Bun's own 500: an HTML error page by
  default, or text/plain "Something went wrong!" under NODE_ENV=production. The socket twin catches the
  same throw and replies with Refusal `{reason, status: 500}` (ws.ts:1093-1097).

## EnrichedSnapshot

- Built only by `enrich` (340-388), through `current()` (1294-1302).
- Sent by `GET /api/state` as `{snapshot: current()}` (null before start); `POST /api/start` `{snapshot}`
  200, never null (the drive's first emit is synchronous); `POST /api/resume` `{snapshot}` 202;
  `POST /api/conversations/end` `{snapshot: current()}` 202; `PUT /api/reassign` (see ReassignResponse).
- Order: seq, phase, poolName, poolTitle, poolDir, finishedTerminals, spawnUsage, pendingSpawns,
  heldSpawns, stewardBudget, state.
- `stewardBudget` is always present: `{budget, used}`, built on every emit (engine.ts:1717-1720); `used`
  values are 1 or more, and an operator answer deletes the key.
- `poolTitle` is always present: a non-empty normalised string or null. A config that stops parsing keeps
  the last title.
- `seq` is an integer from 0; `finishedTerminals` an integer, 0 or more; `poolDir` is `path.resolve(--pool)`,
  not realpath'd; `poolName` is the last two "/" segments of `poolDir`.
- From the engine's emit (engine.ts:1688-1721): `spawnUsage` is `{spawnedThisRun, perAttempt, perRun}`
  (spawnedThisRun first at runtime). `pendingSpawns` items (spawn-proposals.ts:190-203): id, parentId,
  origin, kind, title, body, blockedBy, blocks, overlaps, at. `heldSpawns` items (spawn-proposals.ts:373-380):
  the same base keys, then reason, unknownOverlaps, adopting, adoptError? (present only once set).
- Socket and page copies: `toPushed` (ui/src/protocol.ts:42-49) builds `{rev, logTotal, snapshot:
  {...full, state: {...full.state, log: last 500 lines}}}`, positions kept. HTTP always sends the whole log.

## EnrichedSnapshot.state

- Built at 351-387. Order: tickets, conversations, log, outcomes, interrupts, mergeQueue, queuedAnswers,
  config. `reviewApproved` is not sent.
- `tickets`: one per issue file, in sorted file-name order (pool.ts:224-226).
- `conversations`: the engine's `viewOf` (conversations.ts:770-800): id, title, status, spawnedBy,
  assignment, paneId, branch, turn{state, lastLine, idleSince}, children, enlisted, ending, role?,
  delivery?{failingSince, lastError}; `role` and `delivery` only when set.
- `interrupts`: ticketId, kind, body, candidates?; the snapshot's copy may append
  `stewardNote{text, at, conversation}` last (engine.ts:9908-9914).
- `mergeQueue`: `{ticketId, state}` (merge-hold.ts:344).
- `queuedAnswers`: `{...answer, seq, processedAt: null}` (queued-answers.ts:69-73, the answer from
  engine.ts:5510-5519): ticketId, kind, approve?, action?, attempt?, note?, by?, at, seq, processedAt. After
  a restart they are parsed from the runs file in the same order.
- `config`: the engine's live config object, arbitrary JSON. At boot, console.json parsed in file order with
  "roster" and "agents" deleted, or `{}` when absent or empty (engine.ts:11900-11920). After a boundary
  reload, `{...prev, defaults, assign, resolver, spawnCaps, steward}` (engine.ts:7043-7050): keys already
  present keep their place, new ones are appended in that order; a slice key the file lacks becomes
  undefined (dropped from JSON but keeping its slot, so a later re-add lands in the old place); unvalidated
  values pass through (null included).

## EnrichedTicketState

- Built at 354-378. Order: id, title, blockedBy, status, mergeState, assignment, liveAttempt, heldPane,
  enlisted, reassign.
- `mergeState`, `liveAttempt` and `heldPane` are always present (each `?? null`).
- `status` is the engine's, or "ready" when the engine has none. `title` is the first "# " heading,
  trimmed, or "(untitled)"; it can be "" (pool.ts:134-138). `assignment` is
  `row?.assignment ?? snapshot.assignments[id] ?? {...UNASSIGNED_ASSIGNMENT_VIEW}`. `liveAttempt` is
  `{attempt, paneId, role, startedAt}` (live-attempts.ts:122-127). `heldPane` is `{attempt, paneId}`
  (engine.ts:4304). `reassign` is `row?.reassign ?? UNKNOWN_REASSIGN` (316-323).

## Per-ticket reads

- **ReconstructedAttempt** (718-722): attempt, logFile, modifiedAt. `attempt` is index+1 in mtime order;
  `modifiedAt` is `new Date(mtimeMs).toISOString()`. Sent only when the ticket has no parseable events.
- **TicketEventsResponse** (734, 736-741): events, attempts, reconstructed, spec. With events:
  `attempts: []`, `reconstructed: false`; without: `events: []`, reconstructed rows, `reconstructed: true`.
  `spec` is "" for Conversation ids. Events are the JSONL lines served verbatim (events.ts:413-433): only
  `kind` (a known kind) and `attempt` (a number) are checked; `at` and `payload` are unvalidated and extra
  keys are kept. Socket card frames (`cardEvents`, ws.ts:304-315) drop `logTail` from any object payload
  (on "exited" and "crash"), positions kept; `GET /api/events` keeps it.
- **LogAttemptInfo** (474-487 implement, 491-504 resolver, 509-515 reconstructed). Key order differs by
  branch: implement and resolver rows are attempt, kind, current, logFile, streamFile; reconstructed rows
  are attempt, kind, logFile, streamFile, current. `streamFile` is always present: the name when the file
  exists, else null (always null when reconstructed). The highest implement attempt and the highest
  resolver attempt are both `current: true`. Event rows sort by attempt; reconstructed rows are in mtime
  order.
- **TicketLogResponse** (2215, `{...readLogRange(...), attempts}`; readLogRange returns
  `{content: "", offset: 0, nextOffset: 0, totalSize: 0}` when the file cannot be opened (628), else
  661-668). Order: content, offset, nextOffset, totalSize, attempts. The offset is clamped to 0..totalSize,
  plus up to 3 bytes of UTF-8 head trim; negative offsets clamp to 0. HTTP `?offset=abc` is NaN, so offset
  and nextOffset serialise as null. A fractional offset makes `readSync` throw ERR_OUT_OF_RANGE: Bun's 500
  over HTTP; over the socket, Refusal 500 `The value of "position" is out of range. It must be an integer.
  Received 1.5`.
- **TicketActivityResponse** (864; diff 812-816; log 859), served by `GET /api/activity` (ticket ids only)
  and the socket's `live.activity`. Order: ticketId, running, diff{added, removed, files}, log{size, mtime},
  lastEventAt. `diff` is always present, null when no worktree comes from a spawned or resolver event's
  `payload.cwd`, the worktree is gone, or git fails. `log` is always present, null when there are no
  attempt rows or the stat fails. `lastEventAt` is the last event's raw `at`, or null when there are no
  events; when that line has no `at` the key is absent, and a non-string `at` is passed as is. added,
  removed and size are integers, 0 or more; `files` is unique, in first-seen order.
- **TicketGradeSummary** (919-924), served as `{grades}` by `GET /api/grades` and whole as the socket's
  `live.grades`. Order: attempt, score, verdict, winner. `winner` is always present: the selected event's
  attempt, else the merged event's, else null. score is any number; verdict any string. The map is keyed
  in issue file-name order; tickets with no valid grade are absent.
- **TicketBodyResponse** (974-977): id, body. `id` echoes the request; `body` can be "". The socket card's
  `body` is null when there is no issue file (Conversations). `/api/ticket?id=` only checks that a matching
  issue file exists.

## Action results

- KeepTalkingResponse (1566): `{ticketId, attempt}`, 202.
- CloseFinishedTerminalsResponse (2124): `{closed}`, 200.
- HeldSpawnResponse (2153): `{id}`, 202 for adopt, 200 for discard. PendingSpawnResponse (2179): `{id}`, 200.
- TerminalPeekResponse (2253): `{ticket, paneId, text}`, 200; text is the engine's recorded read, else
  herdr's; it can be "". The socket's `live.peeks` carries it or PeekFailure `{ticket, error}`
  (ws.ts:582, 584).
- TerminalFocusResponse (2267): `{ok: true, paneId}`, 200.
- RestartResponse (1803): `{ok: true, port}`, 202. `port` is console.json's raw `port`, re-read and
  unvalidated, when it is not undefined and not 0; otherwise the bound port (1675-1684). After a hand edit
  it can be null, a string, a float or an object.
- Stop: `{stopping: true}` (1782), 202, also while a stop is already under way.
- conversations.start: `{conversation}` (1993), 201, from `viewOf`; a launch that died still answers 201
  with `status: "crashed"` (conversations.ts:1547).
- EnlistResponse: `{ticketId}` (engine.ts:10614) or `{conversationId}` (engine.ts:10399), 201.

## Settings

- SettingsResponse (1615-1635), sent by GET settings, both PUTs and their socket twins. Order: pool,
  machine, harnesses; `harnesses` is the harness names in JavaScript's default sort (UTF-16 order).
- PoolSettingsView (1618-1627): path, config, bootOnly, effective{port, terminal, stale}. `config` is the
  raw parsed file in file order (unknown keys and `assign` included, roster and agents deleted), `{}` when
  absent. `bootOnly` is always `["selection", "terminal", "port"]`. `effective.port` is the bound integer;
  `terminal` is "herdr" or null, always present; `stale` is a subset of bootOnly, in that order (1651-1663).
- MachineDefaultsView (1628-1632): `{path, defaults, own}`. `own` (machine-defaults.ts:136-145): harness,
  model, effort, drivers, engine, terminal, each present only as a non-empty trimmed string, `terminal`
  only as "herdr", `{}` when the file is missing or will not parse. `defaults` (machine-defaults.ts:74-78):
  `{...own}`, then harness and model from ~/.issue-runner and engine from ~/.console-runner when missing,
  appended at the end.

## Reassign and Assignments

- ReassignResponse (1882): `{...outcome, snapshot}`, 200: applied, skipped, snapshot. `applied` is the
  requested ids deduplicated in first-occurrence order, eligible only, possibly []. `skipped` items are
  `{id, reason}` (reassign.ts:390).
- TicketReassignView (reassign.ts:261, `{...judgement, verify, sources}`; fallback UNKNOWN_REASSIGN,
  316-323): eligible, reason, verify, sources. `reason` is always present, null only when plainly eligible.
  `verify` is always present: an integer of 1 or more, or null (always null when enlisted).
- AssignmentSources (assignment.ts:200-205; engine.ts:6845-6853 enlisted; reassign.ts:129-134 NO_SOURCES;
  322): harness, model, effort, drivers, always. The resolver never reports drivers "unset" (it maps to
  "default"); "unset" appears only through NO_SOURCES, when the config does not parse or the ticket was not
  resolved.
- AssignmentView (`assignmentViewOf`, assignment.ts:80-85; also `{...UNASSIGNED_ASSIGNMENT_VIEW}` =
  `{harness: null, model: null, drivers: "implement"}`): harness, model, [effort, effortApplied], drivers.
  effort and effortApplied are both present or both absent, present only for a non-empty effort. harness
  and model are always present ("" becomes null); drivers always present.

## Steward

- StewardActionResponse (2509): `{ok: true, message}`. Messages: answer 202 `answered ${t}: ${action}`;
  keep-talking 202 `keep talking on ${t}: attempt ${n} continues in its pane`; leave 200
  `left ${t} to the operator with your note`; held 200 `${adopted|discarded} held spawn ${id}`; reassign
  200 `reassigned ${tickets.join(", ")}; resume to run on it`; end 202 `ending: your tab closes now`.
- StewardStateResponse (engine.ts:10097-10124, served at 2518, 200): steward, budget, mayClose, phase,
  interrupts, mergeQueue, pendingSpawns, heldSpawns, ledger. Interrupt items: ticketId, title, kind,
  answerable, keepTalking, queued, note, used, remaining (`title` is the marker title, possibly "", or null
  for non-ticket ids; `note` a string or null; `remaining` is max(0, budget-used)). `mergeQueue` is the last
  snapshot's entries verbatim, or []. pendingSpawns items `{id, parentId, title}`; heldSpawns items
  `{id, parentId, title, reason}`. `phase` is "running" or the settled phase. `ledger` is an absolute path
  under the realpath'd runs directory.

## Panes and the pool log

- PanesResponse and EnlistPane (enlist.ts:237-255): `{panes}`; each pane: paneId, harness, status, title,
  directory, branch, eligible, reason. Null-able keys are always present; `status` defaults to "unknown";
  `title` can be ""; `harness` is herdr's `agent` verbatim, possibly ""; `branch` is a trimmed non-empty
  string or null. Panes come in herdr's order; panes without a string `pane_id` are skipped
  (herdr.ts:566-585).
- PoolLogRange (2231): start, lines, total; it reads the full log, not the 500-line window. HTTP
  `?before=` with an empty value is `Number("")`, which is 0, so it is valid.
- LogFollowResult (ws.ts:969-972): content, offset, nextOffset, totalSize, attempts, attempt, stream; the
  read is the log route's with offset "tail" (`max(0, size - 65536)`).

## Error and refusal bodies

Always exactly one key, `{error}` or `{reason}` (`httpOf`, 694).

`{error}`:
- `POST /api/stop` 409: "pool not started: nothing to stop", or `pool is <phase>, not done: stop refused`.
- `GET /api/settings` 500: the parse error.
- `PUT /api/settings/pool` and `/machine` 400 for everything: invalid JSON ("Failed to parse JSON", or
  "Unexpected end of JSON input" for an empty body), "settings: config must be an object", "settings:
  defaults must be an object", validation and fs errors.
- `PUT /api/reassign`: 400 for ReassignRefusal; 500 for everything else (invalid JSON, "reassign: body must
  be an object", "reassign: pool not started", ConfigUnreadableError, fs errors).
- `POST /api/resume` 400: invalid JSON; `null is not an object (evaluating 'body.ticketId')` for a JSON null
  body; `unknown action <json>: expected one of resume, approve, reject, close, adopt`; `attempt must be a
  whole attempt number, got <json>`; "missing ticketId"; "pool not started"; engine errors. 409 for
  AnswerQueuedConflict.
- `GET /api/events` and `GET /api/activity` 404: `unknown ticket <id>`.
- `GET /api/log` 404: `unknown ticket <id>`, `no stream file for attempt <n> of <id>`, or
  `unknown attempt <n> for <id>`.
- `GET /api/pool-log` 400: "before must be a line number" or "limit must be a positive whole number".
- `GET /api/terminal/peek` and `POST /api/terminal/focus`: 404 `no terminal-backed pane for ticket <id>`;
  502 for herdr errors.
- `GET /api/panes` 502 (its 409 uses `reason`).
- `GET /api/ticket` 404: "not found".

`{reason}`:
- `POST /api/conversations`: 400 "invalid JSON body", `role must be "steward" when given`, or "title is
  required"; 409 for engine errors.
- `POST /api/conversations/end`: 400 "invalid JSON body" or "id is required"; 404 when the message contains
  "no live conversation"; 409 otherwise.
- `POST /api/enlist`: 400 "invalid JSON body", "paneId is required", or `becomes must be "ticket",
  "conversation" or "steward"`; 409 otherwise.
- `POST /api/keep-talking`: 400 "invalid JSON body" or "ticketId is required"; 409 otherwise.
- `POST /api/terminals/close-finished`: 409 "pool not started" or the engine error.
- Held adopt and discard, Pending hold and discard: 400 "invalid JSON body" or "id is required"; 409 "pool
  not started" or the engine error.
- `GET /api/panes` 409: `enlist requires a terminal-backed pool (set console.json "terminal": "herdr")`.
- `/api/steward/*` (2503-2643): 409 "pool not started", checked first; `GET /api/steward/state` refusal
  409; any non-POST other than that GET 404 `no steward route <path>`; 400 "invalid JSON body" or
  "conversation is required"; `/answer` 400 `adopting a candidate is the operator's: leave <ticketId|the
  ticket> with a note naming the one you recommend` or "ticketId and an action of resume, approve, reject or
  close are required"; `/keep-talking` 400 "ticketId and message are required"; `/leave` 400 "ticketId and
  note are required"; `/held` 400 "id and an action of adopt or discard are required"; unknown POST path
  404 `no steward route <path>`; thrown errors 409 (a ReassignRefusal here is 409, not 400);
  ConfigUnreadableError 500.

Not JSON:
- `/api/ws`: 403 "cross-origin socket refused", or 400 "expected a WebSocket upgrade".
- The "not found" 404 at 2690 is unreachable: `serveStatic` checks `!Bun.file().exists()`, but `exists()`
  returns a Promise, which is always truthy, so an unmatched path or wrong method gets Bun's 500 for a
  missing file.

Socket Refusal `{reason, status}` (ws.ts:1068): a handler that throws gives 500; a request that cannot be
decoded but has a known kind gives 400 ("request without payload"); a result that cannot be encoded gives
500 "could not encode the result: ...".

## Socket frames

- hello: type, protocol, epoch, heartbeatMs.
- snapshot: type, rev, logTotal, snapshot; before start `rev: 0, logTotal: 0, snapshot: null`.
- delta: base, rev, then set?, unset?, state?, tickets?, conversations?, log?. `set` keys follow the
  previous top-level key order; `state` keys come in state order; EntityDelta is upsert?, remove?, order?;
  the log delta is `{append, total}` or `{replace, total}`.
- live: type, then activity?, peeks?, grades?, each only when it changed (non-empty).
- card on subscribe: `{"type","id","body","events","log"}`, spliced from strings; body and log can be null.
  card refresh: type, id, body?, events?. card log push and error: type, id, log; or type, id, error.
- LogPush: mode, attempt, stream, content, offset, nextOffset, totalSize, attempts; on an append,
  `attempts` only when the list changed.
- reply: type, id, kind, rev, ok, then result or refusal.
- heartbeat: `{type}`.
- EmbeddedBoot: protocol, epoch, rev, logTotal, snapshot.
