# The Console talks to its server over one pushed WebSocket

After the lag fixes of issue #157, the browser was mostly idle, and what still felt slow was waiting on the server (issue #161, https://github.com/BillyLuisNeedham/agents-console/issues/161). Three channels carried the Console's traffic:
- an SSE stream at `/api/stream` sent the whole snapshot, about 11 KB with all of `state.log`, about once a second;
- each card click fetched the ticket body, its events and two log ranges;
- Vitals and terminal peeks were polled every 2 s per card (ADR-0011).

All of this shared the browser's six HTTP/1.1 connections to the server, and the stream held one of them for good. So a press could queue behind a poll, and a card's data took three round trips: 142 ms at a 40 ms RTT. The server also did the same polling work once per open tab.

We decided that **the Console and its server talk over one WebSocket, `/api/ws`, and the server pushes**. The contract is `engine/protocol.ts`, which both sides import, and the Rust port (issue #162) must keep it. It works like this:

- **The snapshot.** When the socket opens, the server sends the whole snapshot, then only deltas.
  - Tickets and Conversations change by id. Every other field is replaced whole.
  - The pool log travels as its last 500 lines plus appends, and earlier lines are a request.
  - Each version is numbered by a server-side revision, because the engine's `seq` misses changes made by enrichment.
  - The Console rebuilds the same `EnrichedSnapshot` it rendered before, and unchanged entities keep their identity, so nothing downstream of the session changed.
- **Live values.** The server checks activity, peeks and grades itself, once for all tabs, and pushes only what moved. It does this only for tabs that are visible.
- **Cards.** The Console subscribes to the selected card, and to hovered ones as a prefetch. The server then streams that card's body, events and log appends.
- **Requests.** Every action and on-demand read the Console used to fetch is a request on the same socket, matched to its reply by id.
  - The reply carries the HTTP route's own response type, or one refusal shape `{reason, status}`. This replaces the routes' split between `error` and `reason`.
  - The server sends the delta that carries an action's effect before the action's reply. So a reply means the confirmed state is already in hand, and the Console can update a press optimistically and roll it back on a refusal.
- **First paint.** The served `index.html` embeds the first snapshot, so the page paints before the socket opens.
- **Version.** A `hello` carries the protocol version, and a page built for another version reloads itself. This is how a tab left open across a Restart picks up a rebuilt UI.

The HTTP routes all stay, and `/api/stream` is the only one removed. The Steward's command, Boot's readiness poll, the bench and the tests keep calling them, and each socket request runs the same function as its HTTP twin.

**Considered options**:
- **Keeping SSE and adding HTTP/2** would lift the six-connection limit, but the Console would still poll and still pay a round trip per fetch. The server, which serves plain HTTP on localhost and over Tailscale, would need TLS to get HTTP/2 from a browser.
- **SSE for pushes plus `fetch` for requests** would keep two channels, whose ordering the Console would have to reconcile. That ordering is exactly what makes optimistic presses safe: the confirming delta always arrives before the reply.
- **An SSE fallback beside the socket** was rejected. Every supported browser has WebSocket, and a second transport would be a second protocol to keep in step, for the Rust port as well.
- **Replaying missed deltas on reconnect** was rejected in favour of a fresh snapshot. It costs one snapshot per reconnect and needs no history on the server.

**Consequences**:
- The server now owns work each tab used to repeat:
  - a 2 s check of activity and peeks, which runs only while a visible tab is open;
  - `fs.watch` on `runs/` and `issues/` for the subscribed cards, with the same 2 s check statting their files as a backstop.
- The server keeps per-socket state: visibility, subscriptions, each card's followed log and the offset it has sent up to.
- A Console page is tied to its server's protocol version. An old tab against a new server, or the reverse, reloads instead of misreading frames.
- The Console's background traffic is zero, and the bench gates on that, counting socket frames as well as HTTP requests.
- `ui/src/poll.ts`, the request limiter and the per-target throttles exist only because of the connection limit, so they are deleted.
- ADRs 0004, 0011, 0012, 0014 and 0019 carry amendments where they named the SSE stream, client polling or the stream's farewell.
