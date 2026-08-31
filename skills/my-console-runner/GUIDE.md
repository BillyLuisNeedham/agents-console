# my-console-runner: Guide

For the human. Written in Simplified Technical English.

## What you get

Two files in your pool directory. `console.json` holds your interview answers as data: the default
harness and model, per-ticket overrides, the subagent roster, the merge resolver, the pool port,
the reviewer and what counts as a checkpoint. `AGENT.md` tells each agent what the job is. The
Console server reads both when it starts.

To change the default harness or model for every pool, edit `~/.issue-runner`. To change them for
one pool, edit that pool's `console.json`. To change one ticket, edit its entry under `assign`.

## How to start

Point the skill at a pool: `/my-console-runner <path-to-pool>`. It checks the pool, asks seven
questions, writes the two files, starts the server and opens your browser. Run it again on a
configured pool to relaunch without the questions.

## How it stops

The pool runs until something needs you. Then it waits. A ticket's checkpoint, a merge that needs
your approval, a crash, a deadlock and the final Review all appear as interrupts on the card that
raised them. Answer in the card or in its Detail. The pool resumes when you answer. A stop at a
checkpoint is correct behaviour. Expect a good share of a real pool to stop this way.

## What it does not do

The server makes commits on the current branch. It does not push, and it does not open a pull
request. You do those, after you have read the log.

There is no spend cap. An unattended run spends until the pool stops.

The pool on disk stays drivable by `run.sh`. The line-1 markers are the truth both executors read.
