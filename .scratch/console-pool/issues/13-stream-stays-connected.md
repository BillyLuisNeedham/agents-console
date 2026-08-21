<!-- state: id=13 blocked-by=none status=ready -->

# 13 — Pool stream survives a quiet pool

Spec: `.scratch/console-pool/spec-console-flight-fixes.md`

## What to build

The Console's pool stream stops crying wolf. A quiet pool (waiting at an interrupt, or done) keeps its SSE connection open instead of being disconnected every ten seconds; and when a genuine blip does drop the stream, the top bar shows "connecting" at once but only raises the "pool stream disconnected" banner if the stream is still down after a grace delay of about four seconds. A snapshot arriving inside the grace window cancels the banner and restores the connected state; reconnect clears any banner already showing. No heartbeat frames.

## Acceptance criteria

- [ ] The stream route opts out of the Bun server's idle timeout (Bun's documented per-request mechanism for SSE); the JSON and static routes keep the default timeout
- [ ] A bun test starts the real pool server, connects to the stream route, and asserts the connection survives more than ten seconds of silence
- [ ] A stream error marks the connection down immediately so the top bar never claims "connected" underneath an error
- [ ] The error banner appears only if the stream is still down after the grace delay, and clears on reconnect without user action
- [ ] Full test suite, typecheck, and build clean

## Blocked by

None — can start immediately.

## Notes

- Root cause (found in proving-flight diagnosis, reproduced empirically against the real server): Bun.serve's default idle timeout closes any connection silent for ten seconds, and the stream is silent whenever the pool waits at an interrupt. The server writes no keep-alive and the client treats every close as an immediate hard error, so the banner flashes on each drop and clears on the browser's automatic reconnect a few seconds later.
- The server already replays the latest snapshot on connect, so no state is lost across a reconnect; no reconnect machinery changes are needed.
- Grace timer lives in the client's stream wiring; it must be cancelled by the snapshot handler. The grace/banner behavior itself is verified manually during the proving flight, not by a new harness.
