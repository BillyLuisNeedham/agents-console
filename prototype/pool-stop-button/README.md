# Prototype: stop a finished pool's server from the Console (#97)

Throwaway. A single HTML file that simulates one pool server and up to two
browser tabs, so the flow in issue #97 can be pressed through by hand before
any of it is written for real.

The question it answers: when a pool reaches `done` and the page offers a
"Stop server" button, what does the page (and any other open tab) show once
the server is gone, and can it tell "stopped on purpose" apart from "the
drive crashed" and "I lost the network"?

The issue's open questions are toggles on the page:

1. Offer the button only in `done`, or also in `quiescent` / `stalled`.
2. One "Really stop?" confirmation, or none.
3. (a) Does the server broadcast a farewell snapshot before it stops serving,
   or does only the tab that pressed Stop know? (b) Does the page land on a
   new word `stopped`, or reuse `dead`?

## Verdict

Clicked through on 2026-09-15. All four recommendations held:

1. Offer the button only in `done`. Any other phase may have an attempt
   mid-flight, and the server refuses `POST /api/stop` with 409 there so a
   stale tab or a curl cannot kill a pool with work left.
2. One inline "Really stop?" step on the button itself (the End button's
   "ending..." swap is the precedent); no modal. Cancel sends nothing and a
   refresh disarms it.
3. (a) The server broadcasts a farewell snapshot before it stops serving,
   from `shutdown()` itself so the SIGTERM path gets it too. Without it a
   second tab sees "pool · connecting" and retries forever, indistinguishable
   from a crash or a lost network. (b) The page lands on a new phase word
   `stopped`, not `dead`: `dead` means the drive threw and carries an entry
   in `runs/errors.jsonl`. A stopped tab keeps a slow retry so a relaunch
   from the terminal picks it up on its own.
4. No auto-stop timer.

## Run it

Open `prototype/pool-stop-button/index.html` in a browser. Nothing to install,
nothing real runs.

```
xdg-open prototype/pool-stop-button/index.html
```

The pure state model is the first `<script>` block (`PoolStop`); the rest of
the file is the page shell and is not meant to be kept.
