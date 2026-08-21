<!-- state: id=13 blocked-by=none status=done -->

# 13 — Pool stream survives a quiet pool

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

The Console's pool stream stops crying wolf. A quiet pool (waiting at an interrupt, or done) keeps its SSE connection open instead of being disconnected every ten seconds; and when a genuine blip does drop the stream, the top bar shows "connecting" at once but only raises the "pool stream disconnected" banner if the stream is still down after a grace delay of about four seconds. A snapshot arriving inside the grace window cancels the banner and restores the connected state; reconnect clears any banner already showing. No heartbeat frames.

## Acceptance criteria

- [x] The stream route opts out of the Bun server's idle timeout (Bun's documented per-request mechanism for SSE); the JSON and static routes keep the default timeout
- [x] A bun test starts the real pool server, connects to the stream route, and asserts the connection survives more than ten seconds of silence
- [x] A stream error marks the connection down immediately so the top bar never claims "connected" underneath an error
- [x] The error banner appears only if the stream is still down after the grace delay, and clears on reconnect without user action
- [x] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Root cause (found in proving-flight diagnosis, reproduced empirically against the real server): Bun.serve's default idle timeout closes any connection silent for ten seconds, and the stream is silent whenever the pool waits at an interrupt. The server writes no keep-alive and the client treats every close as an immediate hard error, so the banner flashes on each drop and clears on the browser's automatic reconnect a few seconds later.
- The server already replays the latest snapshot on connect, so no state is lost across a reconnect; no reconnect machinery changes are needed.
- Grace timer lives in the client's stream wiring; it must be cancelled by the snapshot handler. The grace/banner behavior itself is verified manually during the proving flight, not by a new harness.

## Notes (agent, 13)

- Server: `/api/stream` calls `server.timeout(req, 0)` (Bun's per-request idle-timeout opt-out) before returning the SSE response; no other route touched.
- Client: `onError` sets `connected = false` immediately and arms a 4000ms grace timer; the snapshot handler cancels the timer, and `setSnapshot` already clears `error`, so a reconnect clears a showing banner. Lives in `ui/src/main.ts` stream wiring.
- Test gotcha (proven): when Bun's idle timeout kills the stream, the pending `reader.read()` *rejects* ("socket connection was closed unexpectedly"), it does not resolve `done: true`. The first version of the test only watched for `done` and passed against the unfixed server. Detection now treats a rejection as closed.
- Second gotcha (proven): the timeout fires server-side at 10s but the rejection reaches the fetch client at ~12s, so the test sleeps 14s. Verified the test fails against the unfixed server (`void bunServer;` in place of the timeout call) and passes with the fix.
- Banner/grace visuals are manual-verify per the spec's testing decisions.
