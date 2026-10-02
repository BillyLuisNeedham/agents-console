# my-console-runner: Guide

For the human. Written in Simplified Technical English.

## What you get

Three files in your pool directory. `console.json` holds your interview answers as data: the default
harness and model, per-ticket overrides, the merge resolver, the pool port,
the reviewer and what counts as a checkpoint. `AGENT.md` tells each agent what the job is. `verify.md`
holds the grading instructions a grader agent follows when a ticket opts into verification. The
Console server reads the first two when it starts.

To change the default harness or model for every pool, edit `~/.issue-runner`. To change them for
one pool, edit that pool's `console.json`. To change one ticket, edit its entry under `assign`. To
have one ticket verified, set `verify: N` on its entry under `assign`.

## How to start

Point the skill at a pool: `/my-console-runner <path-to-pool>`. It checks the pool, asks
its questions, writes the files, starts the server and opens your browser. Run it
again on a configured pool to relaunch without the questions.

Before it checks anything it asks which kind of pool you are starting. A **ticket pool**
already holds the tickets `to-tickets` wrote. A **Seeded Pool** holds none: it starts
empty and grows from live work. You enlist herdr terminals you already have open into it
as Conversations, and those Conversations spawn the tickets. Both kinds get the same
interview, the same files and the same server. On a Seeded Pool the skill creates the
`issues/` and `conversations/` directories for you, and an empty `issues/` is expected
rather than a fault.

On a Seeded Pool, `AGENT.md` is read by the tickets your Conversations spawn. Nothing you
enlist reads it: an enlisted terminal keeps the context it already had, and the engine
teaches it the protocol by typing into the pane.

If you have saved Setups, the interview opens with Q0: it lists them by name, with a
"none" option, and asks which one to start from. Choosing a Setup prefills the
behavioural answers (drivers, harness and model, resolver, reviewer, checkpoint)
and you still confirm each one. A Setup is a starting point, never a silent override.
Choose "none", or have no saved Setups, and the interview runs as before. The port, the
per-ticket assignments, the expected stops and the AGENT.md prose are always asked fresh;
no Setup carries them. A Setup file that is malformed is reported by name and skipped, and
the interview carries on.

After it writes the two files it asks "Save this Setup as...?" Give it a name and the
behavioural answers (harness, model, drivers, resolver, reviewer, checkpoint) are saved
as a Setup: one JSON file under `~/.agent-graphs/setups/`, named for you to recognise later.
The port and the per-ticket assignments are never saved; they belong to the one pool. Decline,
or give an empty name, and nothing is saved. Saving over a name that already exists asks for
confirmation first. Setups are plain files: inspect, edit or delete them by hand.

## How it stops

The pool runs until something needs you. Then it waits. A ticket's checkpoint, a merge that needs
your approval, a crash, a deadlock and the final Review all appear as interrupts on the card that
raised them. Answer in the card or in its Detail. The pool resumes when you answer. A stop at a
checkpoint is correct behaviour. Expect a good share of a real pool to stop this way.

## What it does not do

The server makes commits on the current branch. It does not push, and it does not open a pull
request. You do those, after you have read the log.

There is no spend cap. An unattended run spends until the pool stops.

The line-1 markers on each ticket file are the truth for ticket status; the engine and the human
both read them.
