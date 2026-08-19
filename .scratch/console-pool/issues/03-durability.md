<!-- state: id=03 blocked-by=01 status=ready -->

# 03 — Durability and rehydration

Spec: `.scratch/console-pool/spec-ticket-pools.md`

## What to build

The engine's durability story. Line-1 state markers are dual-written alongside every sqlite checkpoint, and on any disagreement the marker wins — the file on disk is the human-readable truth shared with `run.sh`. An engine process that stops mid-run (kill, crash, machine restart) can be started again against the same pool directory and rehydrates: tickets marked done stay done, in-progress tickets are treated per their marker (an interrupted agent's marker semantics match my-issue-runner's: back to ready with the note it left), pending interrupts are restored, and the run continues from the next super-step. A pool driven partway by the Console remains drivable by `run.sh` and vice versa.

## Acceptance criteria

- [ ] Every checkpoint write is accompanied by the corresponding line-1 marker writes
- [ ] On rehydration, a marker that disagrees with the checkpoint wins
- [ ] A killed engine resumes the same pool from rehydrated state without re-running done tickets
- [ ] Pending interrupts survive a restart and are still answerable
- [ ] A pool part-run by the engine can be inspected by `run.sh status` and continued by it
- [ ] Covered by engine-seam tests, including a kill-mid-super-step scenario

## Blocked by

- 01 — Pool engine walking skeleton

---

## Brief, written by the runner

The agent stopped without setting its own status, last seen as 'in-progress'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit.

- Stopped: 2026-08-18 22:52
- Log: `.scratch/console-pool/runs/03.log`
- Working tree at the stop:

```
 M .scratch/console-pool/issues/01-pool-engine-skeleton.md
 M .scratch/console-pool/issues/02-interrupt-engine.md
 M .scratch/console-pool/issues/03-durability.md
?? .scratch/console-pool/runs/
```

Last lines of the log:

```
-rwxr-xr-x 1 billy billy 16244 Aug 18 22:10 run.sh
-rw-r--r-- 1 billy billy 13136 Aug 18 21:50 spec-ticket-pools.md
81a74ba console: add interrupt engine with checkpoint, crash, and deadlock interrupts
4e96563 console: add the pool engine walking skeleton
41ac900 console-pool: ticket queue, spec, and runner for the pool engine
12aea8c remove the lessons; promote the console prototype to the repo root
591fb52 console: close the Detail review, accept findings and fix the spec vocab
98cb424 console: review the Detail panel and resizable drawers iteration
04f6a61 console: add a drag handle to resize the bottom drawers
527d7a2 console: answer interrupts from the Detail panel
 M .scratch/console-pool/issues/01-pool-engine-skeleton.md
 M .scratch/console-pool/issues/02-interrupt-engine.md
 M .scratch/console-pool/issues/03-durability.md
?? .scratch/console-pool/runs/
[0m
[0m• [0mRead spec and engine state[90m Deepseek Agent[0m
[0m✓ [0mRead spec and engine state[90m Deepseek Agent[0m
[0m→ [0mRead engine/engine.ts
Now let me read the engine code itself, since the substance is mine to write.
[0m→ [0mRead engine/pool.ts
[0m→ [0mRead engine/checkpoints.ts
[0m→ [0mRead engine/engine.test.ts
Now let me read `run.sh` to understand the interop seam for AC5.
[0m→ [0mRead .scratch/console-pool/run.sh
[91m[1mError: [0mYou've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.
