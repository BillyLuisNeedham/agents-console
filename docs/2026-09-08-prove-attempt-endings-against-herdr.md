# Prove raced attempt endings against a real herdr daemon

The suite drives a fake daemon. Ticket 19 of the run-digest pool was a real daemon dropping a
real subscriber. This note is the operator procedure that closes that gap, plus what a throwaway
probe already showed on this host without starting a terminal-backed pool.

Do not point this at the attempt-endings-raced pool. That pool is headless on purpose so it
does not run through the wait it is fixing. Do not restart, kill, or reconfigure a live pool
server or the herdr daemon.

## What this host already showed

On 2026-09-08, against herdr 0.8.2 (pid 92565, socket `~/.config/herdr/herdr.sock`):

1. `openAttemptTab` created an unfocused tab `wE:t4` with pane `wE:p4`. The pane appeared in
   the daemon's listing alongside the operator's existing panes, which were not touched.
2. The pane ran the engine's wrapper shape: `bash -c 'sleep 12 2>&1 | tee <stream>; echo
   ${PIPESTATUS[0]} > <exit-code>'; exit`.
3. `waitForAttemptEnding` subscribed through a Bun unix-socket relay in front of the real
   daemon. `socat` is not on this host, so the relay is the way to FIN one subscriber without
   hanging up the daemon.
4. Mid-attempt the relay FINned only the `events.subscribe` connection. The exit-code file did
   not yet exist. Relay subscriber count went from 1 to 0.
5. About 12.5 seconds later (the sleep, plus the 250ms file poll) the wait settled
   `exit-code`. The file contained `0` and a trailing newline. The wait did not time out.
6. After that, pane `wE:p4` was gone from `pane.list`. `lsof` on the daemon socket showed only
   the daemon itself, the same as before the probe. The relay held no subscribers.
7. `tab.close` then failed with `tab_not_found`: the wrapper's trailing `exit` had already
   taken the tab with the pane. That is the daemon's close of an exited shell, not a leaked
   wait.

The daemon did not originate the hang-up. The wait saw a peer FIN on its subscriber socket,
which is the event `waitForPaneEnd` treats as `lost`, after which the exit-code file won the
race. Inference: a FIN the daemon itself sends is the same socket event. What this did not
prove is the engine's recording of that ending (lifecycle `exited`, Outcome, ticket status,
Ticket log tailer descriptors). That needs a real pool, below.

## Operator half: one throwaway terminal-backed pool

Use a scratch pool that is not attempt-endings-raced. One short ticket is enough: it should
sleep long enough to drop the subscriber (thirty seconds is plenty), write an Outcome of
`done`, and exit 0.

The server CLI has no `--herdr-socket` flag. `createPoolServer` already takes `herdrSocket`,
which is how the engine tests point at a fake. Start the throwaway pool that way, through the
same kind of relay the probe used, so the drop hits only that pool's subscriber.

1. Start a unix-socket relay that forwards to `~/.config/herdr/herdr.sock`, classifies
   connections whose first JSON line is `events.subscribe`, and can FIN those pairs only
   (`socket.end()` on both the client and daemon sides so the daemon does not keep an orphan
   subscriber).
2. Start the throwaway pool with `createPoolServer({ poolDir, herdrSocket: relayPath, port })`
   from `engine/server.ts`. Give it `"terminal": "herdr"` in its `console.json`. Do not move
   or replace the daemon's own socket: the operator TUI and any other pool keep talking to
   herdr directly.
3. Wait until the ticket's `spawned` lifecycle event records a `pane_id` and the relay shows
   one subscriber.
4. FIN the subscriber. Confirm the exit-code file is still absent at that instant.
5. Let the attempt finish. Do not interrupt it.

## What to gather

From that pool's `runs/` directory, for the attempt that was dropped on:

- the exit-code file and its exact bytes (a real `0` plus newline is the success case)
- the Outcome JSON
- the lifecycle events file: `scheduled`, `spawned` (with `pane_id`), and `exited`
- the ticket's line-1 status after the engine wrote it, which must follow the Outcome, not a
  crash
- `lsof` on the pool server pid after `exited`: the Ticket log tailer's descriptors on that
  attempt's Stream or log file must be gone
- the relay's subscriber count at 0, and `lsof` on `herdr.sock` showing no leftover connection
  from the relay

If the wait is still pending, the card will keep reading `running` while the exit-code file
already holds `0`. That is the original fault. Copy the same evidence the run-digest pool
left: pane listing, file mtime, Outcome, missing `exited`, open tailer descriptors.

If it recovered, the wait ended, `exited` was written, the status matches the Outcome, and
nothing is still watching that pane or that log.

## Constraints that stay in force

- No wall-clock timeout on the attempt. A short ticket is only so the drop is observable, not
  a deadline in the engine.
- `engine/herdr.ts` stays pure transport. The relay is throwaway and lives outside the repo.
- Do not add a second fake daemon; this procedure talks to the real one.
