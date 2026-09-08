# Race the attempt's two endings, and trust the exit-code file

Decision record: a fifth amendment on ADR-0014 (`docs/adr/0014-attempts-terminal-backed-in-herdr.md`),
superseding its second amendment, which made the exit-code file a fallback behind the pane-end
subscription.

## Problem Statement

A **terminal-backed attempt** can finish completely — commit its work, write its **Outcome**, exit
zero — and the pool never notices. From the operator's seat the **Console** card still reads
`running`, its **Vitals** counting up `no changes yet, idle 98m`, and nothing will ever change it:
no **Interrupt** is raised, no crash is reported, the ticket's `exited` lifecycle event is never
written, and every ticket behind it stays blocked. The pool is stopped and presents itself as
working.

This happened live on ticket 19 of the run-digest pool. The attempt ran 98 minutes, wrote exit code
`0` at 09:12, wrote a complete Outcome naming its commit and three proposed **Spawn** tickets, and
its harness closed its own **Stream file** cleanly. Two hours later the engine was still waiting.
`lsof` on the server showed the **Ticket log** tailer's file descriptors still open — so execution
had not left the wait — and a hole in an otherwise contiguous descriptor table where the herdr
subscription socket used to be.

The cause is that the engine waits on one signal that can fail without saying so. `waitForPaneEnd`
holds a single long-lived connection subscribed to herdr's `pane.exited` and `pane.closed`, and
settles on a matching event, a socket `error`, or a socket `close`. The herdr daemon dropped that
long-lived subscriber with a plain FIN, which raises `end` — the one ending the socket had no
handler for. The promise stayed pending forever. Meanwhile the wrapper's exit-code file, which is
written whatever the daemon does, sat on disk with the answer, consulted only if the subscription
*reported itself* lost. The longer an attempt runs, the more exposed it is: a seven-minute attempt
in the same super-step was unaffected, a 98-minute one was not.

## Solution

The engine stops ranking the two observations. An **Attempt ending** is whichever independent
observation arrives first: the pane's end as reported by herdr, or the appearance of the exit-code
file the pane wrapper writes before its shell exits. Neither is trusted alone, because each can be
missed in a way the other cannot — a dropped subscription hides the event, and an operator closing
a tab or a killed pane means no file is ever written.

An attempt that finishes therefore ends, whether or not the daemon is still talking to us. A pool
rides out a daemon that hangs up on it, exactly as the existing amendment intended for a daemon
that restarts, and it does so without depending on the daemon to be honest about its own failure.

## User Stories

1. As the pool operator, I want an attempt that finished to be recorded as finished, so that a
   completed 98-minute review is not thrown away by a socket I cannot see.
2. As the pool operator, I want the wrapper's exit-code file treated as an ending in its own right
   rather than a fallback, so that the one observation that does not depend on the daemon is never
   gated behind one that does.
3. As the pool operator, I want the pane-end event to keep working as the prompt ending, so that a
   normal attempt is recorded the instant it exits rather than up to a poll interval later.
4. As the pool operator, I want a daemon that hangs up on a long-lived subscriber to be detected,
   so that the failure mode that parked ticket 19 cannot recur silently.
5. As the pool operator, I want a daemon that restarts, errors, or closes the socket to keep
   working as it does today, so that this change adds backstops without removing any.
6. As the pool operator, I want a pane that was already gone when the subscription registered to
   settle immediately, so that a spawn racing a fast exit is not parked waiting for an event that
   will never come.
7. As the pool operator, I want the case where *both* observations fail — the subscription dropped
   and no exit-code file ever written — to end as a crash rather than as a parked wait, so that no
   combination of failures leaves the pool lying about its state.
8. As the pool operator, I want that crash to name the pane and the unwritten exit-code file, so
   that I read the truth instead of blaming the harness for an exit it never made.
9. As the pool operator, I want no wall-clock timeout on the wait, so that a legitimate 98-minute
   review is never killed for the crime of taking 98 minutes.
10. As the pool operator, I want the boot-time adopted-attempt path fixed by the same mechanism, so
    that restarting the engine mid-attempt does not reintroduce the fault I just fixed.
11. As the pool operator, I want an attempt whose exit-code file already exists at adoption time to
    be finalised immediately, so that a restart after an attempt finished does not wait on anything
    at all.
12. As the pool operator, I want whichever observation loses the race to be released, so that a
    long pool does not accumulate one dead subscription and one polling timer per attempt.
13. As the pool operator, I want the live **Ticket log** tailer to be shut down on every ending
    path, so that its file descriptors are not held open by a wait that has already resolved.
14. As a ticket agent, I want my Outcome and my exit code to mean exactly what they mean today, so
    that the hand-off protocol is unchanged by this fix.
15. As the pool operator, I want a non-zero exit to keep crashing an attempt even when its Outcome
    claims success, so that the rule that catches a cheerful agent that then died stays intact.
16. As a maintainer, I want one named module to own the ending wait, so that both call sites use the
    same logic and neither can drift.
17. As a maintainer, I want the herdr module to stay a pure transport for herdr's protocol, so that
    knowledge of the pane wrapper's files does not leak into it.
18. As a maintainer, I want the ending logic testable without the engine's own test file, so that
    the fix is covered on a machine where that file cannot run.
19. As a maintainer, I want one fake herdr daemon in the test suite rather than two, so that the
    wire shape the tests assume is defined in a single place.
20. As a maintainer, I want ADR-0014's second amendment marked as superseded rather than
    quietly rewritten, so that a future reader can see the decision was tried and found wanting.
21. As a maintainer, I want **Attempt ending** written into the glossary, so that "lost", "exited"
    and "the exit-code file" stop being three ways of saying the same thing in comments.
22. As the pool operator, I want the fix proven against a real herdr daemon dropping a real
    subscriber, so that it is verified by the mechanism that broke rather than by a mock of it.

## Implementation Decisions

- **Attempt ending** becomes a named concept with one owner: a new module holding the wait for an
  attempt's ending, exporting a single function that takes the herdr socket, the pane id, the
  exit-code file path and a release signal, and resolves when the attempt has ended. Both existing
  call sites — the terminal-backed spawn's wait, and the boot-reconcile path that finalises an
  adopted attempt — collapse to a call to it.
- **The two observations are raced, not ranked.** Making the file primary was considered and
  rejected: an operator who closes a tab, or a pane killed by the host, produces a pane end and no
  file ever, so a file-primary wait parks on exactly the case the pane event exists to catch.
  Ranking either way reintroduces a single point of failure; racing them means each covers the
  other's blind spot.
- **Four backstops on the subscription**, in the herdr module, three of which exist today: a
  matching `pane.exited`/`pane.closed` event settles the ending; socket `error`, `close` **and
  `end`** settle it as lost; a pane already absent from the pane listing when the subscription
  acknowledgement lands settles it as exited, since its end predated the subscription; and an
  optional abort signal lets a caller that found the ending elsewhere release the connection. `end`
  is the new one and the one that matters: a peer's FIN is guaranteed to raise it, and its absence
  is the whole bug.
- **The exit-code file is watched by polling**, at the interval the stream tailer already uses.
  `fs.watch` was rejected: the tailer already polls that same directory at that interval, so
  polling adds no new cost, while `fs.watch` adds platform-dependent behaviour for a file that
  appears exactly once.
- **A periodic pane-liveness re-check closes the both-failed case.** While waiting, the ending
  wait re-checks the pane listing on a slow cadence (every 30 seconds); if the pane is absent, it
  gives the exit-code file a short grace window (10 seconds) to appear and then settles. The pane
  being gone with no file after the grace window is a genuine crash, and it is reported as one.
  Thirty seconds is invisible against attempt durations measured in minutes and costs one cheap
  request; the grace window covers the ordering the exit-code read already assumes, where the
  daemon reaps the pane just ahead of the wrapper's final write.
- **No wall-clock timeout, deliberately.** A ceiling generous enough for a real review is too
  generous to catch anything, and a ceiling tight enough to catch something kills legitimate work.
  Liveness, not duration, is the signal.
- **The exit-code read is unchanged.** An unreadable code remains its own value, still crashes the
  attempt, and still reports a reason naming the pane wrapper and the unwritten file rather than
  guessing an exit status.
- **The adopted-attempt path keeps its fast path**: if the exit-code file already exists when the
  attempt is adopted, it is finalised without waiting on anything, because the wrapper writes that
  file before its shell exits and the previous attempt's file is removed before a wrapper is sent.
- **The herdr module stays pure transport.** It speaks herdr's protocol and nothing else; it never
  learns the wrapper's file layout. That is why the race lives in the new module rather than inside
  the pane-end wait, even though a single function there would have been fewer moving parts.
- **Ownership and release are explicit.** Whichever observation loses the race is released by the
  caller when the ending is recorded, alongside the existing shutdown of the live log tailer, so a
  long-running pool leaks neither a subscription nor a timer per attempt.
- **ADR-0014 gains a fifth amendment** recording that a design it already carries — subscription
  primary, exit-code file polled only once the subscription reported itself lost — was live-tested
  and found to have a silent hole, and that endings are now raced. The design being superseded is
  the one in ADR-0014's **second** amendment, headed `Amendment (ticket 01-spawn-1-spawn-1)`,
  whose second half introduced the fall back to an unbounded poll of the exit-code file on a lost
  subscription. Its text stays as written and is marked superseded. The two amendments after it
  stay in force and are not touched: the zsh `bash -c` wrapper and `EXIT_CODE_UNREADABLE` are both
  load-bearing here, since the raced ending still reads the exit code the wrapper writes.
- **`CONTEXT.md` gains an Attempt ending entry**, naming the three observed forms and stating which
  one does not depend on the daemon. It must not blur the existing Outcome entry's "avoid: exit
  code" note: the Outcome is the agent's account of itself, the exit code is evidence, and an
  Attempt ending is the observation that the attempt is over.
- **Nothing else moves.** The Outcome contract, the Stream file, the derived Ticket log, the
  lifecycle events, the crash-on-non-zero-exit rule and the headless spawn path are all untouched.
  The headless path waits on its own child process and shares none of this fault.

## Testing Decisions

- **Two seams, one of them new.** The existing seam is the pane-end wait in the herdr module, which
  already takes a socket path and is already driven in tests by a fake daemon over a real unix
  socket. The new seam is the ending module's single exported function, which takes a socket path,
  a pane id and a file path — all of which a test can supply — and is the only new module boundary
  this change introduces. The two engine call sites are callers, not seams: they are asserted
  indirectly by the module's own tests plus the live reproduction.
- **Why a new seam at all.** The ending race is module-private in the engine today, and the
  engine's own test file cannot be run on this machine — it Bus-errors under Bun 1.2.13, a
  pre-existing failure unrelated to this change. Putting the race behind a named export is what
  makes it testable at all; leaving it inline would mean shipping the fix with no coverage of the
  thing being fixed.
- **Grow the existing fake daemon, do not add a second.** The herdr test suite's fake already
  speaks the real wire shape one line in, one line out. It gains the ability to hold a connection
  open, to record what a client subscribed to, to push an event to its subscribers, and to hang up
  on a subscriber. One fake, one definition of the protocol the tests assume.
- **Tests at the pane-end seam:** settles exited on the pane's own event; ignores another pane's
  event, since the daemon pushes every pane's events to every subscriber; settles lost when the
  daemon hangs up on the subscriber with a FIN — the regression test for this bug; settles lost when
  the socket errors or closes; settles lost when the caller releases it; settles exited when the
  pane was already absent at subscription time.
- **Tests at the ending seam:** the file wins when the subscription is dropped and the file exists —
  the ticket 19 case end to end; the pane event wins when it arrives first; the ending is reported
  when the file appears while the subscription is healthy but silent; the wait ends and reports a
  crash when the pane is gone and no file appears within the grace window; the loser is released
  once the ending is found; an already-present file resolves without waiting.
- **A good test here asserts only external behaviour**: that the wait ends, and with which ending.
  It never asserts how many sockets were opened, which handler fired, or the internal shape of the
  race. The one exception is the subscriber count on the fake daemon, which is external behaviour
  from the daemon's side and the only way to prove the loser was released.
- **Prior art:** the fake-daemon tests in the herdr suite, and the exit-reason tests that pin how an
  unreadable exit code is described.
- **Acceptance requires a live reproduction**, not just a green suite: a real herdr daemon, a real
  terminal-backed attempt, the subscriber socket dropped mid-attempt, and the attempt still
  recorded with its real exit code. This makes the ticket stop as a checkpoint for a human, by
  design. Every amendment ADR-0014 already carries was written after a live failure and none of
  them after a test, including the one that cost a day.
- **No test may be added to the engine's own test file** while it Bus-errors under Bun 1.2.13, or
  the coverage will be unrunnable on the machine that needs it.

## Out of Scope

- A shared, reconnecting subscription per pool instead of one connection per wait. It would reduce
  the number of long-lived sockets, but the fault was never the count — it was trusting them.
- Surfacing a parked wait to the operator. Vitals showed `idle 98m` and nothing more; making a
  stuck wait legible, or folding it into dead-drive detection, is a separate concern and a
  separate decision, and this fix removes the cause rather than reporting it.
- Any change to how a crashed attempt is presented, retried, or interrupted.
- The duplicate ADR numbers in `docs/adr/` (`0006`, `0014` twice, and `0011` a copy of the vitals
  ADR). Hygiene, and its own ticket.
- The Console's herdr surface: the open-in-herdr button, tab lifecycle and pane close rules are
  untouched.
- Ticket 19's own pool: closing that ticket by hand and writing its fix ticket is operator work
  already done outside this spec.

## Further Notes

- The evidence for the diagnosis, for whoever reads this later: the pane absent from the daemon's
  own pane listing; a real `0` in the exit-code file, timestamped an hour and a half before the
  engine was inspected; a complete Outcome with a commit; the harness's own result line closing the
  Stream file; no surviving harness process; a lifecycle event file holding `scheduled` and
  `spawned` and no `exited`; the log tailer's descriptors still open; and the missing descriptor
  where the subscription socket had been.
- Duration is the exposure. Two attempts in the same super-step on the same daemon: the
  seven-minute one was fine, the 98-minute one was not. Any pool whose tickets are reviews rather
  than edits is disproportionately exposed, which is the shape of most review and verify work.
- The reason this was expensive to see is that a parked wait looks exactly like slow work. The
  engine had no way to distinguish "the agent is thinking" from "nobody is listening any more",
  and the only distinguishing evidence was on disk the whole time.
