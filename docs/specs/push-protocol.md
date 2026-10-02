# Push protocol: the Console over one WebSocket (issue #161)

This spec is the contract three workstreams build against in parallel: the server, the UI and the bench. The types and the pure helpers are in `engine/protocol.ts`, with tests in `engine/protocol.test.ts`. That file wins wherever this text and it disagree. ADR-0032 records the decision. This spec is deleted before the PR (AGENTS.md).

## What changes, in one paragraph

Today the Console fetches JSON, holds an SSE stream at `/api/stream`, and polls activity and peeks every 2 s. After this change it holds **one WebSocket at `/api/ws`** and nothing else:

- The server sends the snapshot whole when the socket opens, then only deltas.
- The server pushes activity, peeks and grades when they change.
- The server streams the data of the cards the Console subscribes to.
- Every action and on-demand read goes over the same socket as a request with an id, answered by a reply carrying the same id.

The served `index.html` carries the first snapshot, so the page paints before the socket opens. `/api/stream` is removed. Every other HTTP route stays.

## Vocabulary

- **rev**: the server's revision. It starts at 0 when the process starts and goes up by one each time the server pushes a snapshot version that differs from the last one (`diffSnapshot` returned non-null). `seq` cannot do this job: enrichment changes the snapshot without the engine emitting.
- **epoch**: a per-process id, `${Date.now().toString(36)}-${random}`. A rev only means something within one epoch.
- **PushedSnapshot**: `{ rev, logTotal, snapshot }`, where `snapshot.state.log` holds only the last `POOL_LOG_WINDOW` (500) lines and `logTotal` is the full length. Built with `toPushed(full, rev)`.

## Messages

Every frame is one JSON text frame. `encodeMessage` writes it, and `decodeClientMessage` / `decodeServerMessage` read it. Both decoders check the envelope and throw `ProtocolError`.

### Server → client

| type | when | example |
|---|---|---|
| `hello` | first frame on every socket | `{"type":"hello","protocol":1,"epoch":"lq3k9-7f2a","heartbeatMs":20000}` |
| `snapshot` | second frame on every socket; also whenever a client must be resynced | `{"type":"snapshot","rev":41,"logTotal":1312,"snapshot":{…EnrichedSnapshot, state.log = last 500…}}` (`snapshot` is `null` before the pool started) |
| `delta` | every later snapshot version, to every socket, visible or hidden | `{"type":"delta","delta":{"base":41,"rev":42,"set":{"seq":88},"tickets":{"upsert":[{…ticket 07…}]},"log":{"append":["07 merged"],"total":1313}}}` |
| `live` | a check found activity, peeks or grades that moved; visible sockets only | `{"type":"live","activity":{"07":{…TicketActivityResponse}},"peeks":{"07":{"ticket":"07","paneId":"p3","text":"…"},"c1":{"ticket":"c1","error":"pane gone"}},"grades":{"05":{…}}}` |
| `card` | a subscribed card's data: everything on subscribe, then whatever changed | `{"type":"card","id":"07","body":{"id":"07","body":"…"},"events":{…TicketEventsResponse},"log":{"mode":"window","attempt":2,"stream":false,"content":"…","offset":131072,"nextOffset":196608,"totalSize":196608,"attempts":[…]}}` |
| `card` (append) | new bytes in the followed log | `{"type":"card","id":"07","log":{"mode":"append","attempt":2,"stream":false,"content":"[tool] Edit: …\n","offset":196608,"nextOffset":196700,"totalSize":196700}}` |
| `card` (error) | subscribed to an id the pool does not know | `{"type":"card","id":"99","error":"unknown ticket 99"}` |
| `reply` (ok) | a request finished | `{"type":"reply","id":12,"kind":"terminal.focus","rev":42,"ok":true,"result":{"ok":true,"paneId":"p3"}}` |
| `reply` (refused) | a request was refused | `{"type":"reply","id":13,"kind":"stop","rev":42,"ok":false,"refusal":{"reason":"pool is running, not done: stop refused","status":409}}` |
| `heartbeat` | every `heartbeatMs`, to every socket | `{"type":"heartbeat"}` |

### Client → server

| type | when | example |
|---|---|---|
| `hello` | first frame after every open (it carries the whole resubscription) | `{"type":"hello","protocol":1,"visible":true,"cards":[{"id":"07"},{"id":"03","follow":{"attempt":1,"stream":true}}]}` |
| `visibility` | on `visibilitychange` | `{"type":"visibility","visible":false}` |
| `subscribe` | select a card, or hover-prefetch one; sending it again updates `follow` | `{"type":"subscribe","card":{"id":"07"}}` |
| `unsubscribe` | the card is no longer selected or held for prefetch | `{"type":"unsubscribe","id":"07"}` |
| `request` | any action or read | `{"type":"request","id":12,"kind":"terminal.focus","payload":{"ticketId":"07"}}` |

The server sends `hello` and `snapshot` as soon as the socket opens. It does not wait for the client's `hello`. Until that `hello` lands, the server treats the socket as visible with no subscriptions.

A frame that fails to decode is logged and dropped. If it is a `request` with a usable `id` and `kind`, the server answers it with a refusal of status 400.

## The delta

`SnapshotDelta = { base, rev, set?, unset?, state?, tickets?, conversations?, log? }`. A field absent from the delta is unchanged.

- **`tickets` and `conversations`** are `EntityDelta = { upsert?, remove?, order? }`, keyed by `id`.
  - `upsert` holds each new or changed entity, whole.
  - `remove` lists the ids that went.
  - `order` is the full id list. It is present only when the id sequence changed (an add, a removal or a reorder), so the client never has to guess where a new card goes.
- **`set`** holds the top-level fields (everything except `state`) that changed, each replaced whole. **`unset`** lists the optional top-level fields that disappeared (only `stewardBudget` today).
- **`state`** holds the changed fields inside `state` other than tickets, conversations and log (`outcomes`, `interrupts`, `mergeQueue`, `queuedAnswers`, `config`), each replaced whole.
- **`log`** is `{append, total}` when the log only grew: the lines after the old end. It is `{replace, total}` otherwise, for example after a new run. The client keeps the last 500 lines.

`applyDelta(prev, delta)` throws `ProtocolError` when `delta.base !== prev.rev`. Everything the delta does not name is carried over **by reference**: unchanged tickets, unchanged Conversations, and `state` itself when nothing inside it moved. The morph renderer and any memoised projection therefore see identity wherever nothing changed. On a `ProtocolError` the client closes its socket with `CLOSE_RESYNC` (4001), and the reconnect brings a fresh snapshot. This cannot happen on an ordered socket unless there is a bug, which is why the simplest recovery is enough.

Why JSON-string equality per entity: tickets are about 1 KB each and there are tens of them, so it costs microseconds. A false "changed" (keys in a different order) only resends one entity.

## Requests

`Requests` in `protocol.ts` maps every kind to its payload and result, so `request<K>(kind: K, payload: RequestPayload<K>): Promise<RequestResult<K>>` is typed end to end. Every kind has an HTTP twin (`HTTP_TWINS`). **The socket handler and the HTTP route call the same function.** The server workstream extracts each route body into a function returning `{ ok: true, result } | { ok: false, refusal }`; the route turns that into its HTTP response with its existing status and field (`error` or `reason`), and the socket turns it into a reply. HTTP responses do not change at all.

| kind | payload | result | HTTP twin |
|---|---|---|---|
| `start` | `{}` | `{}` | POST /api/start |
| `resume` | `{ticketId, action, note?}` | `{}` | POST /api/resume |
| `stop` | `{}` | `{stopping: true}` | POST /api/stop |
| `restart` | `{}` | `RestartResponse` | POST /api/restart |
| `keepTalking` | `KeepTalkingRequest` | `KeepTalkingResponse` | POST /api/keep-talking |
| `terminal.focus` | `{ticketId}` | `{ok: true, paneId}` | POST /api/terminal/focus?ticket= |
| `terminals.closeFinished` | `{}` | `CloseFinishedTerminalsResponse` | POST /api/terminals/close-finished |
| `enlist` | `EnlistRequest` | `EnlistResponse` | POST /api/enlist |
| `reassign` | `ReassignRequest` | `{applied, skipped}` | PUT /api/reassign |
| `spawns.held.adopt` / `.discard` | `{id}` | `{id}` | POST /api/spawns/held/{adopt,discard} |
| `spawns.pending.hold` / `.discard` | `{id}` | `{id}` | POST /api/spawns/pending/{hold,discard} |
| `conversations.start` | `StartConversationRequest` | `{conversation}` | POST /api/conversations |
| `conversations.end` | `{id, closing?}` | `{}` | POST /api/conversations/end |
| `settings.get` | `{}` | `SettingsResponse` | GET /api/settings |
| `settings.pool.put` | `{config}` | `SettingsResponse` | PUT /api/settings/pool |
| `settings.machine.put` | `{defaults}` | `SettingsResponse` | PUT /api/settings/machine |
| `panes.list` | `{}` | `PanesResponse` | GET /api/panes |
| `log.read` | `{id, attempt?, offset, end?, stream?}` | `TicketLogResponse` | GET /api/log |
| `log.follow` | `{id, attempt: number\|null, stream}` | `LogFollowResult`: the tail window plus the resolved `attempt` and `stream` | GET /api/log (a tail read) |
| `poolLog.read` | `{before, limit?}` | `PoolLogRange {start, lines, total}` | GET /api/pool-log (**new route**) |

Three things are deliberately not on the socket:

- The Steward routes (`/api/steward/*`). Only the Steward CLI calls them.
- `/api/state`, `/api/events`, `/api/ticket`, `/api/activity`, `/api/terminal/peek` and `/api/grades`. They are now pushed, and the routes stay for other consumers.
- `/api/pool-log`. It is new, gets the same function as `poolLog.read` (default `limit` 500, capped at 2000), and exists so every request kind has a twin the tests and the Rust port can hit.

### Replies and refusals

- A reply carries the request's `id`, its `kind` and `rev`. It carries either `ok: true, result` or `ok: false, refusal: {reason, status}`.
- `status` is what the HTTP twin answers: 400, 404, 409, 500 or 502. Today's `{error}` and `{reason}` both become `refusal.reason`.
- **Ordering rule**: for an action kind (`ACTION_KINDS`), the server first flushes the pending coalesced snapshot push to every socket, then sends the reply. `rev` is the revision the socket has been sent at that moment. The delta that carries an action's effect is therefore on the wire before its reply. When the reply arrives, the client already holds the confirmed state, so dropping the optimistic overlay is enough. Read kinds do not flush, but they still report `rev`.
- Replies can arrive in any order and are matched by `id`. Ids are per socket and count up from 1.
- When the socket closes with requests outstanding, the client rejects each one with `{reason: "connection lost before the server answered", status: 0}` and never resends it, because actions are not all idempotent. The fresh snapshot after the reconnect shows what really happened.
- There is no per-request timeout. The silence watchdog covers a dead socket.

## Subscriptions (cards)

`subscribe {card: {id, follow?}}` is an upsert. `follow` defaults to `{attempt: null, stream: false}`, meaning the latest attempt's derived log.

1. **On subscribe**, the server sends one `card` frame with all three fields: `body` (`TicketBodyResponse | null`; null for a Conversation), `events` (`TicketEventsResponse`), and `log` (a `window` frame).
   - The window is what the log pane's open does today: the last `LOG_CHUNK_BYTES` (64 KiB) of the followed file.
   - `log` is null when the card has no attempt.
   - The three come in one frame, so they paint in one render.
2. **After that**, the server sends `card` frames with only what changed:
   - `events` (the whole `TicketEventsResponse`) when the events file stamp moves;
   - `body` when the Issue file changes;
   - `log` `append` frames with the new bytes, in chunks of at most 64 KiB.
   - When the card follows `attempt: null` and a new attempt starts, it gets a `log` `window` for that attempt.
   - An append carries `attempts` only when the attempt list changed.
3. **`log.follow`** changes what the appends follow. Its reply is the new tail window, and appends from then on are for that attempt and stream. The client drops any append whose `attempt`/`stream` does not match its pane: a frame already on the wire can still name the old one.
4. **`log.read`** is "load earlier" (`end` = the oldest byte the pane holds) and any one-off range. It changes no subscription.
5. **`unsubscribe`** stops all pushes for the card. Unsubscribing an id that is not subscribed does nothing.
6. When an append's `offset` is not the pane's `nextOffset` (it should not happen), the client re-sends `log.follow` with the same follow, and the window in the reply replaces the pane.

The server keeps, per socket and per card, the follow and the byte offset it has sent up to.

## Server responsibilities

**The socket.**
- Bun's `server.upgrade(req)` at `WS_PATH` inside `fetch`, with a `websocket` handler on `Bun.serve`: `idleTimeout: 120`, `sendPings: true` (the defaults, stated explicitly).
- Browsers answer pings on their own, so a dead client is reaped without application traffic from it.
- `bunServer.timeout` does not apply to sockets.

**The snapshot push.** This replaces `clients`, `sendTo` and `frameOf`.
- Keep the 50 ms coalescing window and `current()`. At the window's end, `sendNow()` does the following:
  1. builds `next = toPushed(current(), lastPushed.rev + 1)`;
  2. computes `diffSnapshot(lastPushed, next)`;
  3. when the delta is non-null, sets `lastPushed = next`, serialises `{type:"delta"}` **once**, and sends it to every socket.
- There is one `lastPushed` for the whole server, so every socket is always at the same rev and every delta is serialised once.
- `reenrich()` goes through the same path. The first snapshot after start (when `lastPushed` is null) goes out as a `snapshot` frame, not a delta.

**On open.**
1. Flush any pending push (`sendNow()`), so the other sockets get it.
2. Send this socket `hello`, then `snapshot` from `lastPushed`, or `{rev: 0, logTotal: 0, snapshot: null}` before the pool starts.
3. Then, if it is visible, send it one `live` frame with the whole current live cache.

**The live check.** One check for every client, on a `LIVE_CHECK_MS` (2 s) timer that runs only while at least one visible socket is open.
- **Activity**: for each vitals candidate (status `in-progress` or `checkpoint`, or a ticket whose `liveAttempt.role` is `resolver`), call the same `readTicketActivityCached`. The 1.5 s diff cache stays.
  - The UI's "drop from the cadence once a response says not running" rule moves here: a candidate whose last activity said `running: false` is skipped until a snapshot push changes its status or live attempt.
- **Peeks**: for every terminal-backed pane, meaning a ticket's `liveAttempt.paneId ?? heldPane.paneId` and a live Conversation's `paneId`, use the same resolve-and-read the peek route uses (`run.paneRead` first, otherwise a `visible` herdr read).
  - A failure becomes `PeekFailure {ticket, error}`.
  - Reads run with a concurrency of 4.
- **Grades**: `poolGrades()`, which is already stat-cached.
- Compare each value with the last one pushed (JSON string), and send a `live` frame with only the changed entries to every visible socket. Grades go whole when they changed, and to hidden sockets too: they are rare and cheap.
- **Run a check at once** (on the same 50 ms coalescing window) when a snapshot push adds a candidate or a pane, so a new pane's peek does not wait 2 s.
- **Forget** cached values for ids that left the candidate or pane sets.

**The card watchers.**
- `fs.watch` on `runs/` and on `issues/` (non-recursive). An event naming a subscribed card's events file, its followed log or Stream file, or its Issue file schedules that card's check on the 50 ms window.
- The check:
  - reads new bytes from the sent offset with `readLogRange`;
  - re-reads the events when `eventsStamp` moved;
  - re-reads the body when its stamp moved.
- Every live check also stats the subscribed cards' files. This is a backstop for a missed watch event (FSEvents coalesces), so a missed event costs at most 2 s.
- An events change for any ticket also re-runs `poolGrades()`, so grades move without waiting for the timer.

**Hidden sockets.**
- No `live` frames and no `append` frames while hidden. Deltas, `card` events and body frames, replies and heartbeats still go, because the tab title and favicon must follow the pool while hidden.
- On `visibility {visible: true}`:
  1. send the whole live cache;
  2. resume each card's appends from its sent offset, in 64 KiB chunks, or send a `window` instead when more than `LOG_PANE_MAX_CHARS` (256 KiB) was missed;
  3. run a check now.

**Heartbeat.** Send `{"type":"heartbeat"}` every `streamHeartbeatMs` (default 20 s, still the test option) to every socket.

**Stop farewell.**
- `closeStreams()` becomes `closeSockets()`. It flushes, so the `stopped` delta goes out, then closes every socket with `CLOSE_STOPPED` (1000, "stopped").
- `STREAM_DRAIN_MS` is kept before `server.stop(true)`.

**Embedded boot.**
- `serveStatic` for `/` and `/index.html` reads `dist/index.html` (cached by mtime).
- After a `sendNow()` flush, it injects `embedBoot(html, {protocol, epoch, rev, logTotal, snapshot})` from `lastPushed`, and sets `cache-control: no-store`.
- Every other static file is unchanged.

**Removed.** The `/api/stream` route, `encodeSnapshot`, `HEARTBEAT_FRAME` and `encodeStreamConfig`. `SNAPSHOT_STREAM_HEARTBEAT_MS` is renamed `HEARTBEAT_MS`, now imported from `protocol.ts`, and the option keeps its name `streamHeartbeatMs`.

## Client responsibilities

**Transport.** The new `ui/src/socket.ts` takes a `SocketLike` factory: the real `WebSocket` in the browser, fakes in tests and in the bench's UI half.
- It holds one socket and the `PushedSnapshot`, and applies `snapshot` and `delta` frames, so the session still receives an `EnrichedSnapshot`.
- It routes `live`, `card` and `reply` frames.
- It exposes `request(kind, payload)`, `subscribe(card)`, `unsubscribe(id)` and `setVisible(v)`.
- It keeps the set of subscriptions and sends them whole in `hello` after every open.

**Version.**
- On `hello.protocol !== PROTOCOL_VERSION`, the page calls `location.reload()`.
- Loop guard: a `sessionStorage` timestamp. When the page already reloaded for this reason in the last 10 s, it shows the banner "Console was updated: reload the page" instead.

**Liveness.**
- Any frame resets a silence timer of `SILENCE_FACTOR × hello.heartbeatMs` (60 s). Before `hello` lands, the timer uses `HEARTBEAT_MS`.
- When the timer fires, the client closes the socket and reconnects.
- Reconnect delays follow `RECONNECT_DELAYS_MS` (250, 500, 1000, 2000, then 3000 repeating), and reset after a socket that reached `hello`.
- The connection banner keeps its 4 s grace. A close with `CLOSE_STOPPED` raises no banner. The retry keeps running, so a relaunch is picked up on its own.

**Reconnect.** Every open gets a fresh `snapshot`, with no replay. The client replaces its `PushedSnapshot` (the skip rule below applies) and its `hello` re-sends the subscriptions. Live values come fresh in the first `live` frame.

**Embedded snapshot.**
- `main.ts` reads `#console-boot` with `readEmbeddedBoot`. When it finds one, `session.setSnapshot` is called and the page renders **before** the socket is opened.
- When the socket's first `snapshot` has the same `epoch` (from `hello`) and `rev`, the client keeps the held object and does not notify, so nothing re-renders.
- With `snapshot: null`, the page sends the `start` request (today's `getState`-then-`start` boot), and the first delta or snapshot renders it.
- `client.getState()` is no longer called at boot.

**The pool log.**
- The drawer reads `snapshot.state.log`.
- "Load earlier" sends `poolLog.read {before: logTotal - heldLines.length}` and prepends the lines to a client-side `earlier` array.
- While `earlier` is non-empty, the lines an append pushes out of the 500-line window are moved onto the end of `earlier`, so the drawer's text stays contiguous. A `replace` clears `earlier`.

**Vitals and terminal stores.**
- `Vitals` and `TerminalSurface` stop fetching. Their `update(snapshot)` still derives the candidates (for pruning and the pending shell), and they take payloads from `live` frames.
- The 2 s wall-clock tick stays, with no network. It appends a sparkline sample from the held payload for each running candidate (today's one-sample-per-poll timeline), and it re-renders only when the staleness copy moved.
- `TargetPoller` and `RequestLimiter` in `poll.ts` are deleted, together with their test.

**Subscriptions and hover prefetch.**
- Selecting a card subscribes it.
- When the pointer rests on a card for `HOVER_DWELL_MS` (100 ms), it is subscribed too.
- At most `HOVER_SUBSCRIPTIONS` (2) hovered cards are held, least recently hovered unsubscribed first. The selected card never counts against that.
- Cached card data is kept while subscribed and dropped on unsubscribe.
- A click on a hovered card finds its body, events and log already in hand, and the Detail draws them in the click's own render.

**Optimistic presses.** The UI's rule, made possible by the ordering rule and the refusal shape.
- **Optimistic** (update at once, roll back on refusal, reason shown beside the control): answer, Open in herdr, Keep talking, held spawn Adopt/Discard, pending spawn Hold/Discard, End conversation.
  - The overlay is keyed by request id and dropped when the reply arrives, because the confirming delta is already applied by then.
  - On a refusal, the overlay is dropped and `refusal.reason` is shown beside the control until the next press.
- **"…ing" until the reply**: Stop, Restart, Settings save, Reassign, Enlist, Start conversation.
- Every press must show a visible response within one frame: the overlay, or the "…ing" label.

**Where the HTTP calls go.**
- `PoolClient`'s fetch methods are replaced by `request` calls.
- `stream()` and `refetchStateOnVisible` are deleted.
- `probeServer` (the restart probe, an HTTP no-cors fetch) stays: it runs only after a Restart, against a port with no socket yet.

## HTTP routes

- **Removed:** `/api/stream`.
- **Added:** `/api/ws` (upgrade) and `GET /api/pool-log`.
- **Unchanged:** every other route, including `/api/state` (Boot polls it), `/api/steward/*` (the Steward CLI), and the reads the bench and tests use.

## Speed targets and why the protocol allows them

| Target | How |
|---|---|
| Press feedback within 1 frame | optimistic overlay or "…ing" label set in the handler; render flushed as the press bubbles out (#157) |
| Click → Detail drawn in the next frame | the Detail shell comes from the held snapshot; no request blocks it |
| Click → data within RTT + 20 ms, instant if hovered | one `subscribe` frame and one `card` frame: a single round trip. The server reads three small files; prefetch makes it zero |
| Open in herdr answered < 5 ms | one request on an open socket; no connection to wait for; no flush for reads, and the focus flush is a no-op when nothing is pending |
| 0 frames over 16 ms | deltas touch only changed entities, applied with identity sharing; `live` frames batch every change of one check into one render |
| 0 background polling | no timers send anything; the server pushes |
| Start → usable < 300 ms | the snapshot embedded in index.html paints before any script fetch or socket |

## Bench changes (scripts/bench-lag/**)

- **`ui/probe.ts`** wraps `window.WebSocket` before the page's code runs.
  - It counts frames by direction and `type` (and `kind` for requests and replies), with bytes and timestamps.
  - It records the time from a card press to the first `card` frame for that id, and from an Open in herdr press to its `terminal.focus` reply.
  - The report gains `ws: {sent, received, bytes, frames: [...]}`.
- **`e2e.ts`**:
  - The **polling gate** counts, over an idle window of at least 10 s with no input, both HTTP resources requested after load and client-sent socket frames. Both must be 0. Heartbeats are server-sent and do not count.
  - The gates for the issue's table are added. `--e2e` exits non-zero when any one is missed.
  - **Start → usable** is navigation start to the first committed render that shows the cards.
- **`bench-lag.ts`'s server half**: the snapshot counter (`streamRate`) reads a WebSocket and counts `snapshot` and `delta` frames and their bytes, in place of `/api/stream`.
- **`load.ts`**: each simulated tab holds one socket.
  - A click becomes `subscribe`, timed to its `card` frame.
  - Open in herdr becomes a `terminal.focus` request, timed to its reply.
  - The 2 s polls are removed, since the server now does that work once for every tab.
  - The connection-pool model is kept only for HTTP.
- **`ui-bench.ts` and `ui/bench.ts`** (the UI half) drive the Console through a fake `SocketLike` that plays `snapshot`, `delta`, `live` and `card` frames built with `toPushed` and `diffSnapshot`. They do not fake the old fetch seams.
- Re-record `baseline/` after the merge.

## Tests each side owns

- **Contract (done here):** `engine/protocol.test.ts`.
- **Server:**
  - `engine/server.test.ts`: the SSE tests (stream config, heartbeat, replay on connect, coalescing, farewell) are rewritten against `/api/ws` with Bun's `WebSocket` client.
  - `engine/settings-routes.test.ts`: its `/api/stream` use is moved over.
  - New `engine/ws.test.ts`:
    - hello then snapshot;
    - a delta per coalesced change, and the same rev for every socket;
    - the reply-after-delta ordering for an action;
    - a refusal for every kind's status class;
    - subscribe gives one card frame, followed by appends after a log write;
    - `log.follow` and `log.read`;
    - hidden sockets get no `live` frames, and get the cache on visible;
    - a stop sends the `stopped` delta, then close 1000 "stopped";
    - the embedded boot in `/`;
    - `/api/pool-log`.
  - One parity test runs each request kind over the socket and over its HTTP twin and compares result and status.
- **UI:**
  - `ui/src/client.test.ts` is replaced by `ui/src/socket.test.ts`: apply and resync, the version reload and its guard, silence reconnect, resubscribe on reopen, outstanding requests rejected on close, and the skip on an identical epoch and rev.
  - `session.test.ts`: the boot from embed, optimistic overlay and rollback, "…ing" kinds, hover dwell and the LRU of 2.
  - `vitals.test.ts` and `terminal.test.ts`: push-fed, with no fetch.
  - `log-pane.test.ts`: window/append/follow and an append that does not match.
  - `poll.test.ts` is deleted.
  - `ui/harness/render-survival.ts` still passes.
- **Bench:** `bun run scripts/bench-lag.ts --e2e` passes its gates on Linux and on the Mac.

## Build split

Three workstreams, branched from this commit. Each one only touches the files it owns. `engine/protocol.ts` is frozen: a change to it goes to the contract owner (the lead), not into a workstream branch.

| Workstream | Owns | Must not touch |
|---|---|---|
| **Server** | `engine/server.ts`; new `engine/ws.ts` (socket handler, live check, card watchers; keep server.ts from growing); `engine/server.test.ts`, `engine/settings-routes.test.ts`, new `engine/ws.test.ts`; `README.md`'s protocol paragraph | `ui/**`, `scripts/**` |
| **UI** | `ui/src/**` (new `socket.ts`; `client.ts`, `session.ts`, `main.ts`, `vitals.ts`, `terminal.ts`, `log-pane.ts`, `poll.ts`, view and press handlers), their tests, `ui/harness/**`, `ui/index.html` | `engine/**` except type imports, `scripts/**` |
| **Bench** | `scripts/bench-lag.ts`, `scripts/bench-lag/**` | `engine/**`, `ui/src/**` |

How the three work in parallel:
- The UI tests against a fake `SocketLike` and needs no server.
- The bench's UI half uses the same fake.
- The bench's e2e half runs against the server branch once that branch lands. Until then it can be type-checked and run in UI-half mode only.

**Merge order:**
1. Server. HTTP is unchanged, so today's UI keeps working; only `/api/stream` is gone, and the old UI will show "connecting" until step 2.
2. UI.
3. Bench, which needs both for e2e.

Merge 1 and 2 back to back, with no release in between. After 3, re-record the baseline and run the gates on both machines.

## Decisions made here (one line each)

- Replies never carry snapshots, and deltas go ahead of replies: one source of state, and confirmation reduces to "reply arrived".
- One global `lastPushed`: every socket shares a rev, so a delta is computed and serialised once.
- Client `hello` carries the subscriptions: the reconnect resubscription is one frame and cannot race.
- `events` is pushed whole on change: the files are small, and a diff format for them would be a second protocol.
- Grades go to hidden tabs too: they are rare and cheap, and the tab returns current.
- The rev-gap recovery is a reconnect: it cannot happen on an ordered socket, so the simplest recovery is enough.
- No per-request timeout: the watchdog already bounds a dead socket.
- Hover dwell is 100 ms and 2 cards: long enough to skip pass-overs, short enough to beat a click (about 150 ms from rest to press).
- `/api/pool-log` was added so every request kind has an HTTP twin; the Rust port's contract stays uniform.
- Ping/pong is Bun's own, and the app heartbeat is server-sent only: browsers cannot read pings, and the client needs a frame to time silence against.
