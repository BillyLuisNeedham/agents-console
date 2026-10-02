---
name: my-console-runner
description: Boot a Console for a pool by running the agent-console script, then write the pool's own prose: AGENT.md below the CONFIG marker, and verify.md.
disable-model-invocation: true
---

**The interview is gone from this skill.** Detecting the pool, prefilling from the pool's config, a
Setup and Machine defaults, asking whatever is left, writing `console.json`, creating the
directories, rebuilding the Console and launching the server are all one script now:
`agent-console` (issue #121, ADR-0026). Editing a pool's config afterwards is Pool settings in the
Console, and the per-machine harness, model, drivers, terminal and engine path are Machine
defaults, edited beside them. Neither is a reason to run an agent.

What is left is the part a script cannot do: the pool's prose. `AGENT.md` below the CONFIG marker
and `verify.md` are written for agents that have to act on them, and the script can only fill in
what it detected.

So this skill has two jobs.

## 1. Boot the pool

Run the script and relay what it says:

```sh
agent-console <pool-dir>          # or just `agent-console` from the project checkout
bun run boot -- <pool-dir>        # the same thing from the engine checkout
```

It takes `[pool-dir] [--yes] [--relaunch] [--port <n>] [--setup <name>] [--no-open]`. With no
directory it uses the working directory when that is already a pool, otherwise the single pool
under the checkout's `.scratch/`, otherwise it offers a choice or creates one. `--yes` takes every
prefill and asks nothing, which is also how the Console's Restart hands off to it.

The script prints the Console's URL, the log path and the line that stops it. Relay all three. Name
the absent spend cap while you are there: an unattended run spends until the pool stops.

If it refuses, the message is the engine's own and is worth passing on verbatim. The two common
ones are a pool already locked by a live server, which names the pid, and a pinned port that will
not bind.

## 2. Write the pool's prose

The script copies [`AGENT.template.md`](AGENT.template.md) into the pool as `AGENT.md` and fills
what it detected below the CONFIG marker: the context files beside `issues/`, the commit prefix,
and the reviewer and checkpoint answers as constraints. On every boot after that, a Restart's
included, it rewrites the part above the marker from the current template and keeps everything
below the marker byte for byte. An `AGENT.md` with no marker is left alone.

Everything above the marker is the same in every runner and that sameness is the point: leave it
as it is, because the next boot replaces it anyway. Below the marker, improve what the script left:

- context files: say what each one is for, not just that it exists
- this pool's constraints: the reviewer's authority and the checkpoint definition as rules, plus
  the environment quirks a fresh agent would trip over (secrets files, external systems, known-red
  tests)
- which tickets are expected to stop: the script leaves this as a placeholder because it is a
  judgement about this pool's work. Name them, so a checkpoint on those reads as correct rather
  than as a failure

`AGENT.md` reaches one surface: a ticket the engine launched itself. A Conversation is taught by
its own opening Turn and never sees this file, and an enlisted pane of either kind keeps the
context it already had and is taught the protocol with a Turn. So on a Seeded Pool nobody the
operator Enlists ever reads `AGENT.md`. Write it for the tickets those Conversations Spawn, which
do read it, and say so when you ask for the pool prose, so the human writes for the right audience.

The script also copies [`verify.template.md`](verify.template.md) into the pool as `verify.md`,
verbatim, when there is none. It seeds the grading instructions a grader agent follows when a
ticket opts into verification: does the work match the ticket, do the outputs match the agent's
claims, are there error signals in the log, with terminal output trusted over the agent's
self-assessment. When the pool has a Jev key this file serves the fallback grader only: the engine
grades the Attempts itself, and `verify.md` is left unused for that round. Verification is
activated per ticket by a `verify: N` key on that ticket's entry under `assign` in `console.json`,
set by hand when a ticket is wanted verified. If `verify.md` is already there, leave it alone:
criteria tuned by hand must not be clobbered.

## Check the drivers before the first super-step

The one detection worth doing by hand, because it needs skill frontmatter read and a harness's
command directory checked.

For each skill named in the pool's `drivers`, read its frontmatter. A skill carrying
`disable-model-invocation: true` can only be reached from the prompt, which is the one slot that
counts as the human typing, so **at most one such skill per ticket and it must be first**. Two is a
clash: name both, say which is blocked, and ask again.

In your own library `implement`, `triage`, `to-tickets`, `wayfinder` and
`thermo-nuclear-code-quality-review` all carry it. `tdd`, `code-review`, `diagnosing-bugs`,
`research`, `prototype`, `fits-the-codebase` and `resolving-merge-conflicts` do not.

Later skills in a chain reach the agent as a list in its prompt: skills to use, in order, once the
driver's work is done. The prompt names them and leaves how to run them to the agent (ADR-0031).
Put the weight of a ticket on the first driver rather than the tail of a chain.

Then check reachability per harness. The first driver goes in the prompt, so it must resolve as a
command on whatever harness the ticket is assigned:

- `claude` reaches every linked skill. Nothing to check.
- `opencode` only sees the stubs in `~/.config/opencode/command/`. If the driver's stub is
  missing, run `~/.claude/commands/scripts/link-opencode-commands.sh`, the skills repo's linker,
  which is the right tool because the drivers (`implement`, `triage` and the rest) live in the
  skills repo.
- `cursor` only sees real copies in `~/.cursor/skills/`. If the driver's copy is missing, run
  `~/.claude/commands/scripts/link-skills.sh`, also the skills repo's linker, for the same drivers.

Every harness named in the config must be on PATH. The script warns when one is not; the engine
fails fast on an unknown harness at run start, so getting this right means the first super-step
does not stop for it.

## How a Console run works

One server process per pool. Tickets whose blockers are all `done` run as one super-step, each in
its own git worktree, on the harness and model `console.json` assigns. Anything that needs a human
becomes an interrupt on that ticket's card: a checkpoint Brief, a merge-approval, a crash, a
deadlock, the final Review. Answering an interrupt resumes the pool.

A Conversation runs beside all that and holds nothing up: it has no blockers, never joins a
super-step, is never verified or graded, and ends only when the human ends it (ADR-0018).

A **Seeded Pool** holds no tickets at the start and grows from live work: the operator Enlists
herdr panes into it as Conversations, and those Conversations Spawn the tickets (ADR-0024). The
script asks which kind of pool it is when the directory cannot say, and creates `conversations/`
on the seeded path, which is the opt-in the engine reads.

The pool's ticket directory is called `issues/` on disk, a legacy name; prose says ticket.

**The engine writes every ticket, and this skill writes none.** On a ticket pool `to-tickets` wrote
them; on a Seeded Pool the engine writes them when a Conversation Spawns one, and when a pane is
enlisted as a ticket.

If the pool's own checkout is dirty, recommend committing before launch: tickets commit to the
current branch, and an unattended agent can sweep unrelated changes into a commit that says it is
the work of a ticket. A herdr pane the human means to Enlist is the exception and keeps its
uncommitted work. That work is usually why the pane is worth enlisting, and the engine records the
pane's directory and branch as found and writes into neither (ADR-0021).

## What the engine already handles

Leave these alone rather than rediscovering them:

- The pool lock: one server per pool, enforced at boot. `runs/server.pid` is the engine's file;
  it claims it and clears it on a failed bind. Neither the script nor this skill writes it. To
  stop a server, send SIGTERM to the pid in that file (a plain `kill`). The server stops every
  headless attempt it spawned before it exits and removes the file itself (ADR-0017). Never
  `kill -9` a pool server with attempts in flight: that skips the stop, and the attempts run on
  as orphans until the next boot finds and stops them.
- The spawn kernel is ported from `run.sh`: non-interactive invocation with stdin closed, the
  fullest auto-approve permission mode per harness, the prompt glued from the driver skill,
  AGENT.md and the chain. opencode gets the driver through `--command`; cursor's launch line comes from
  Cursor's documentation and is unproven.
- Upstream outcomes are injected into each ticket's prompt at spawn time, so downstream agents
  build on what upstream agents did.
- A ticket the engine launched that exits without an outcome status in its outcome JSON is a crash
  and surfaces as an interrupt carrying the log path. An enlisted ticket has no wrapper and so no
  exit to read: its ending is raced between a valid Outcome on disk and its pane leaving herdr's
  listing, and a pane that goes before the Outcome lands the ticket in a checkpoint saying so, with
  the branch kept (ADR-0021). A Conversation has no Outcome at all and ends when the human ends it.
- A merge conflict spawns the resolver agent; its resolution comes to the human as an approval
  interrupt, and rejecting hands the conflicted state over with the attempt noted.
- Line-1 markers are dual-written alongside the sqlite checkpoint and are the truth on conflict,
  so the pool on disk is always inspectable.
- Enlist takes a live herdr pane the human opened themselves and makes it a Pool citizen, as a
  ticket or a Conversation, chosen at that moment and fixed from then on (ADR-0021). The pane, its
  directory and its branch are recorded as found; the engine never closes the tab, never removes
  the directory and never deletes the branch. The Console drives all of this from its own surface.
- Per-ticket logs land in the pool's `runs/` directory.
- The pool config's assignment slice (`defaults`, `assign`, `resolver`) re-reads at every
  super-step boundary (ADR-0018): an edit lands on any ticket with no Attempt in flight at its
  next boundary, no restart needed. `selection`, `terminal` and `port` stay exactly as they were
  at boot; an edit to any of those takes effect on a Restart, which the
  Console offers and which hands back to `agent-console --relaunch`. A restart is otherwise
  cheap: markers and the checkpoint are the truth, so ticket state and a pending interrupt both
  survive it. What does not survive is a headless attempt in flight. A terminal-backed attempt is
  the exception: its pane outlives the server and the boot re-adopts it (ADR-0014).

---

The human-facing guide is [`GUIDE.md`](GUIDE.md): what you get, how to start, how it stops,
what it does not do.
