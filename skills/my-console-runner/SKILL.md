---
name: my-console-runner
description: Point the Console at a pool, whether it already holds tickets or starts seeded and empty: detect, interview, write console.json and AGENT.md, launch the server.
disable-model-invocation: true
---

This skill connects a pool to the Console. A pool reaches it one of two ways.

A **ticket pool** already holds its tickets, written by `to-tickets`. This is the common path.

A **Seeded Pool** holds none. It starts empty and grows from live work: the human Enlists herdr
panes into it as Conversations, and those Conversations Spawn the tickets (ADR-0024). The skill
creates the directories, runs the same interview, and launches the same server.

You ask which one before you detect anything, because an empty ticket directory means opposite
things on the two paths and only the human knows which.

The pool's ticket directory is called `issues/` on disk — a legacy name; prose says ticket.

It is the sibling of `my-issue-runner`: the same pool on disk, and the same interview on the ticket
path. Where my-issue-runner writes `run.sh`, this skill writes `console.json` and `AGENT.md` into
the pool directory, then starts the Console server bound to that pool and opens the browser.

**The engine writes every ticket, and this skill writes none.** On a ticket pool `to-tickets` wrote
them; on a Seeded Pool the engine writes them when a Conversation Spawns one, and when a pane is
enlisted as a ticket. A ticket pool with nothing in it, or a ticket without a state marker, is a
reason to stop and say so.

The engine is one versioned copy per machine, its location read from the `engine=` line in
`~/.console-runner` (`engine/` for the server, `ui/` for the Console). If the file or the line is
missing, ask once where the engine repo lives and write it, one line, `engine=..`, before anything
else. The pool carries its own config as data, so regenerating a pool's config never means copying
engine code.

## How a Console run works

One server process per pool. Tickets whose blockers are all `done` run as one super-step, each in
its own git worktree, on the harness and model `console.json` assigns. Anything that needs a human
becomes an interrupt on that ticket's card: a checkpoint Brief, a merge-approval, a crash, a
deadlock, the final Review. Answering an interrupt resumes the pool.

A Conversation runs beside all that and holds nothing up: it has no blockers, never joins a
super-step, is never verified or graded, and ends only when the human ends it (ADR-0018).

## 0. Pointed at a configured pool

If the pool directory already holds `console.json` and `AGENT.md`, say so, show the config's
defaults and assignments, and ask one question: relaunch as-is, or re-interview. A relaunch goes
straight to step 6. A re-interview runs steps 1 to 5 and overwrites both files.

## 1. Ask which pool, then detect

One question comes before the lookups, because the disk cannot answer it:

**Which kind of pool is this: a ticket pool, or a Seeded Pool?** Recommend what the directory
suggests. Tickets in `issues/` means a ticket pool. An empty `issues/`, or no pool directory at
all, means you are probably being asked for a Seeded Pool. Take the answer over the suggestion:
the human's intent decides this, and the disk only hints.

Then look these up. Asking for them wastes a question:

- how many tickets sit in the pool's `issues/` directory, and whether every one carries a line 1
  state marker
- the `blocked-by` edges already written
- the repository's language and test framework
- the commit prefix in the last twenty commits
- which context files sit in the pool directory beside `issues/`, and their names
- whether the worktree is clean
- whether `~/.issue-runner` exists, and its contents if it does
- whether `~/.console-runner` exists, and the `engine=` path it names if it does
- which of `claude`, `opencode` and `agent` are on PATH
- whether herdr is installed and its daemon live: the `herdr` binary on PATH, and a socket at
  `~/.config/herdr/herdr.sock`

Report all ten back in one short brief and get it confirmed.

On a **ticket pool**, stop if the pool has no `issues/` directory, no tickets in it, or any ticket
without a state marker. Say which, and the human fixes the pool or `to-tickets` writes it again.

On a **Seeded Pool**, an empty `issues/` is the point, so report it as the point. The ticket count,
the `blocked-by` edges and the per-ticket overrides of question 3 have nothing to describe yet; say
so and move on. Everything else in the list still counts, and herdr counts for more than usual:
Enlist is how this pool grows, so a missing binary or a dead socket is worth raising before launch
rather than after.

If the pool's own checkout is dirty, recommend committing before launch: tickets commit to the
current branch, and an unattended agent can sweep unrelated changes into a commit that says it is
the work of a ticket. A herdr pane the human means to Enlist is the exception and keeps its
uncommitted work. That work is usually why the pane is worth enlisting, and the engine records the
pane's directory and branch as found and writes into neither (ADR-0021).

## 2. Ask

Q0 comes first, and only when Setups exist. Look in `~/.agent-graphs/setups/`. If the
directory is missing or empty, Q0 does not appear and the interview below runs exactly as
before. If Setups exist, open by listing them by name with a "none" option and ask which
to start from. A Setup file that does not parse as JSON, or that lacks any of the six
required behavioural keys (`terminal` is optional), is malformed: report it by name, leave it off the list, and carry on. A
bad Setup is never fatal.

"None" runs the interview un-prefilled. Choosing a Setup prefills it: the Setup's values
become the recommendations on the questions they answer (`defaults` for questions 1 and
2, `roster` and `agents` for question 4, `reviewer` for question 5, `checkpoint` for
question 6, `terminal` for question 8, `resolver` for the resolver config), and every one of those questions is
still asked and confirmed with the operator exactly as today. A Setup is a starting
point, never a silent override. Question 2's `~/.issue-runner` skip still applies; when
that file and the chosen Setup disagree, name the disagreement and ask rather than skip.

What a Setup cannot answer is always asked fresh: the per-ticket overrides of question 3,
the port probe of question 7, the expected stops, and the AGENT.md pool prose. Those pin
one pool and no Setup carries them.

Eight questions follow Q0, each with your recommendation attached:

1. Which skill or skills drive each ticket, and whether that differs per ticket
2. The default harness and model. If `~/.issue-runner` already exists, read it, confirm it, and
   skip this question. If it does not, ask once and write it: two lines, `harness=..` and
   `model=..`
3. Whether any ticket should run on a different harness or model than the default, and which
4. The subagent roster, and a model for each
5. Whether a reviewer exists, and what authority it has
6. What counts as a checkpoint on this job specifically
7. Which port the pool should pin. Probe 8787 at setup time; recommend it when it is free,
   otherwise the next free port, or the pool's current pin on a re-interview. A concrete answer
   becomes the `port` key in `console.json`; `auto` (or next free) writes no key.
8. Whether attempts run terminal-backed, so every spawn site opens its own named herdr tab in
   the attempt's worktree instead of running headless (ADR-0014, ADR-0015). Recommend yes when
   detection found the binary and a live socket: it is what makes the Console's open-in-herdr
   surface do anything, and it costs nothing when the daemon is absent, since the engine falls
   back to headless with a visible warning. A yes becomes `"terminal": "herdr"`; a no writes no
   key.

On a Seeded Pool, question 3 has nothing to override yet: write an empty `assign` and add entries
by hand as Spawned tickets arrive. The pool re-reads that slice at every super-step boundary
(ADR-0018), so the edit lands with no restart.

Recommend the orchestrator's own model for every subagent unless there is a reason to go smaller.
Delegating a skill to a cheaper model moves the substance of a ticket onto that model, which is
the thing the runner exists to avoid.

If a reviewer is wanted, recommend it check acceptance criteria only and never code quality, and
that a failure buy the orchestrator one fix attempt before the ticket becomes a checkpoint carrying
the disagreement in its brief. That bounds a weaker model's power to strand good work.

The merge resolver is config, not a question. Recommend the default harness for it, say
that an explicit `none` opts out so every conflict comes straight to the human, and write whatever
is agreed as the `resolver` key. A model name belongs to one harness: if the resolver runs on a
harness other than the default, it must carry its own model, written as the object form
`{ "harness": "claude", "model": "..." }`, or it inherits the default harness's model and fails at
spawn.

## 3. Check the drivers

For each skill named in answer 1, read its frontmatter. A skill carrying
`disable-model-invocation: true` can only be reached from the prompt, which is the one slot that
counts as the human typing, so **at most one such skill per ticket and it must be first**. Two is a
clash: name both, say which is blocked, and ask again.

In your own library `implement`, `triage`, `to-tickets`, `wayfinder` and
`thermo-nuclear-code-quality-review` all carry it. `tdd`, `code-review`, `diagnosing-bugs`,
`research`, `prototype`, `fits-the-codebase` and `resolving-merge-conflicts` do not.

Later skills in a chain run as subagents told to invoke them. That path is designed but unproven,
so put the weight of a ticket on the first driver rather than the tail of a chain.

Then check reachability per harness. The first driver goes in the prompt, so it must resolve as a
command on whatever harness the ticket is assigned:

- `claude` reaches every linked skill. Nothing to check.
- `opencode` only sees the stubs in `~/.config/opencode/command/`. If the driver's stub is
  missing, run `~/.claude/commands/scripts/link-opencode-commands.sh` — the skills repo's linker,
  the right tool because the drivers (`implement`, `triage`, etc.) live in the skills repo —
  before generating.
- `cursor` only sees real copies in `~/.cursor/skills/`. If the driver's copy is missing, run
  `~/.claude/commands/scripts/link-skills.sh` — also the skills repo's linker, for the same
  drivers that live there — before generating.

Every harness named in the config must also be on PATH, from the detection brief. The engine fails
fast on an unknown harness at run start; getting it right here means the first super-step does not
stop for it.

## 4. Generate

On a Seeded Pool, create `issues/` and `conversations/` in the pool directory first. The
`conversations/` directory is the opt-in the engine reads, and an empty one counts: it is what
tells the Console that an empty `issues/` is intended rather than a pool whose tickets were never
written (ADR-0024). `issues/` is where an enlisted ticket, and every Spawned ticket, is written.

Write `console.json` into the pool directory. All eight answers land here as data:

```json
{
  "defaults": { "harness": "opencode", "model": "kimi-for-coding-oauth/k3", "drivers": "implement" },
  "assign": {
    "04": { "harness": "claude", "model": "claude-opus-4-1", "drivers": "implement code-review" }
  },
  "roster": "- deepseek (DeepSeek V4 Flash via opencode go): general-purpose subagent...",
  "agents": "{\"deepseek\": {\"description\": \"general-purpose subagent\", \"model\": \"...\"}}",
  "resolver": "opencode",
  "port": 8787,
  "terminal": "herdr",
  "reviewer": "a reviewer checks acceptance criteria only; a failure buys one fix attempt",
  "checkpoint": "a device, an external write, an undecided decision, or a material guess"
}
```

- `defaults` holds answer 2 and the common case of answer 1. `drivers` is a space-separated chain:
  the first name is the driver, the rest run as the chain behind it.
- `assign` holds one entry per ticket that differs from the defaults, from answers 1 and 3. Omit
  tickets that use the defaults.
- `roster` is the roster as plain words for the prompt, from answer 4. `agents` is the same roster
  as a JSON string for claude's `--agents` flag. Keep the two in step.
- `resolver` is the merge resolver harness, or `none`, or `{ "harness": .., "model": .. }` when
  the resolver's harness differs from the default and so needs a model of its own. The engine
  falls back to the `~/.issue-runner` default when the key is absent, but write it explicitly so
  the pool's config says what it does.
- `port` records the port answer when it is a concrete number. Omit it for `auto`. What each
  does at launch is in step 6.
- `terminal` records answer 8, and its only legal value is `"herdr"`. Omit the key for a
  headless pool; the engine rejects any other value when it loads the config.
- `reviewer` and `checkpoint` record answers 5 and 6. The engine does not read them; the agents
  do, through `AGENT.md`. Write both places from the one answer.

Then copy [`AGENT.template.md`](AGENT.template.md) into the pool directory as `AGENT.md`. Fill in
only what is below the CONFIG marker. The engine above the marker is the same in every runner and
that sameness is the point: leave it exactly as it is.

Below the marker:

- context files: the files detection found beside `issues/`, one bullet each, saying what each is
  for
- commit prefix: the one detection found
- this job's constraints: the reviewer authority and the checkpoint definition as rules, plus any
  environment quirks detection surfaced
- which tickets are expected to stop: from the checkpoint definition, so a checkpoint on those
  reads as correct rather than as a failure

`AGENT.md` reaches one surface: a ticket the engine launched itself. A Conversation is taught by
its own opening Turn and never sees this file, and an enlisted pane of either kind keeps the
context it already had and is taught the protocol with a Turn. So on a Seeded Pool nobody the human
Enlists ever reads `AGENT.md`. Write it for the tickets those Conversations Spawn, which do read
it, and say so when you ask for the pool prose, so the human writes for the right audience.

Then write the pool's `verify` skill beside `AGENT.md`: copy
[`verify.template.md`](verify.template.md) into the pool directory as `verify.md`, verbatim,
nothing to fill in. It seeds the grading instructions a grader agent follows when a ticket opts
into verification: does the work match the ticket, do the outputs match the agent's claims, are
there error signals in the log, with terminal output trusted over the agent's self-assessment.
When the pool has a Jev key this file serves the fallback grader only: the engine grades the
Attempts itself, and `verify.md` is left unused for that round.

No question is asked about any of this. Activation is the per-ticket `verify: N` key, set on that
ticket's entry under `assign` in `console.json`: N parallel attempts and N grader tickets, then
selection. Absent the key a ticket runs exactly as it does today, so writing the skill is harmless
for pools that never set it. The interview never asks for the key; set it by editing `console.json`
when a ticket is wanted verified. An enlisted ticket is the exception: its agent is already running
in a pane the human opened, so there is nothing to run N of, and the engine ignores `verify: N` on
one and logs that once at enlist (ADR-0021). If `verify.md` already sits beside `AGENT.md`, name it
and leave it alone: a re-interview must not clobber criteria tuned by hand.

## 5. Save the Setup

The config just written holds two slices. The behavioural slice (harness, model, drivers,
roster, agents, resolver, reviewer, checkpoint) barely changes from pool to pool; the
pool-specific slice (`port`, `assign`, the AGENT.md prose) is regenerated every time. A **Setup**
is the behavioural slice, saved as one JSON file so the next pool can start from it. Call it a
Setup, never a profile or a template.

Ask one question: "Save this Setup as...?", with no recommendation either way. A decline or an
empty name writes nothing and the skill moves on to launch as before. A name is slugified
(lowercase, spaces and underscores to hyphens, anything outside `[a-z0-9-]` stripped) and the
Setup is written to `~/.agent-graphs/setups/<slug>.json`, creating the directory if it is
missing. The file holds the seven behavioural keys, copied verbatim from the
`console.json` just written:

```json
{
  "defaults": { "harness": "opencode", "model": "kimi-for-coding-oauth/k3", "drivers": "implement" },
  "roster": "- deepseek (DeepSeek V4 Flash via opencode go): general-purpose subagent...",
  "agents": "{\"deepseek\": {\"description\": \"general-purpose subagent\", \"model\": \"...\"}}",
  "resolver": "opencode",
  "terminal": "herdr",
  "reviewer": "a reviewer checks acceptance criteria only; a failure buys one fix attempt",
  "checkpoint": "a device, an external write, an undecided decision, or a material guess"
}
```

`terminal` belongs in a Setup because herdr is a property of the machine rather than of one
pool: if the daemon is there it is there for every pool. Omit it when the pool went headless.
Never `port`, never `assign`: those pin one pool and would clobber the next. `roster` and
`agents` are copied together from the one interview answer, so the pair stays in step in the
saved file exactly as it does in the pool config. If `<slug>.json` already exists, name the
existing Setup and ask for confirmation before replacing it; a decline leaves the file
untouched and saves nothing.

## 6. Launch

One action, in order:

1. Build the Console if the build is missing **or stale**. Read the engine repo path from the
   `engine=` line in `~/.console-runner`. Rebuild when `$ENGINE/ui/dist/` is absent, and also
   when it is older than the last commit touching `$ENGINE/ui/src`: the server serves `dist`,
   so a fetch that brings new UI work leaves the Console silently running the old surface —
   the assignment badges and the herdr pane both went missing this way. Compare
   `git -C "$ENGINE" log -1 --format=%ct -- ui/src` against the mtime of
   `$ENGINE/ui/dist/index.html`, and on either condition run `bun install` and `bun run build`
   in `$ENGINE/ui/`. A rebuild needs no restart: the server reads `dist` from disk per request,
   so a browser reload is enough.
2. Start the server detached so it outlives this session, from `$ENGINE`. The engine
   resolves the port itself: the `--port` flag wins, then the `console.json` pin, then
   8787-or-next-free. A pinned port must bind exactly at launch or the engine refuses loudly
   naming the port. Do not write `runs/server.pid`; that file is the engine's pool lock.
   Run the launch as one command so the boot verdict is readable before the shell returns:

   ```
   mkdir -p "<pool>/runs"
   : > "<pool>/runs/server.log"
   nohup bun run engine/server.ts --pool "<pool>" \
     >> "<pool>/runs/server.log" 2>&1 &
   spawned=$!
   port=""
   for _ in $(seq 1 40); do
     if ! kill -0 "$spawned" 2>/dev/null; then
       echo "The engine refused or failed at boot; its message:"
       tail -n 5 "<pool>/runs/server.log"
       exit 1
     fi
     port=$(sed -n 's/.*pool server on http:\/\/localhost:\([0-9]*\).*/\1/p' \
       "<pool>/runs/server.log" | tail -n 1)
     [ -n "$port" ] && break
     sleep 0.25
   done
   ```

   The log is truncated first so a boot line is always fresh: a relaunch reads only this boot's
   line.

   A live pool is refused at boot with a message naming the live pid, its fleet-registry port
   when known, and the pool directory. Surface that message verbatim and stop: open the running
   console or kill the pid it names. One pool, one server, and the engine's lock is the truth.
   An empty `$port` after the loop means the server is up but the pool is slow to boot; read
   `runs/server.log` and report what it says.
3. Probe `http://localhost:$port/api/state` until it answers with a snapshot. Then open the
   browser with the platform's opener:

   ```
   if [ "$(uname)" = "Darwin" ]; then
     open "http://localhost:$port"
   else
     xdg-open "http://localhost:$port"
   fi
   ```

Report the URL and the log path, and name the absent spend cap: an unattended run spends until
the pool stops. To stop the server later, send SIGTERM to the pid in `runs/server.pid` (a plain
`kill`); the engine writes that file when it claims the pool. The server stops every headless
attempt it spawned before it exits and removes the pid file itself (ADR-0017). Never `kill -9` a
pool server with attempts in flight: that skips the stop, and the attempts run on as orphans
until the next boot finds and stops them.

Then stop. The run from here is the human's: tickets spawn real harnesses, checkpoints arrive as
interrupts, and the first launch of a pool is theirs to watch.

## What the engine already handles

Leave these alone rather than rediscovering them:

- The pool lock: one server per pool, enforced at boot. `runs/server.pid` is the engine's file;
  it claims it and clears it on a failed bind. The skill never reads or writes it.
- The spawn kernel is ported from `run.sh`: non-interactive invocation with stdin closed, the
  fullest auto-approve permission mode per harness, the prompt glued from driver skill, AGENT.md,
  chain and roster. opencode gets the driver through `--command`; cursor's launch line comes from
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
  the directory and never deletes the branch. The one thing it changes is the branch, and only for
  a pane sitting on the merge target: that one gets `pool/<pool>/<id>` created at its HEAD and
  checked out in place, which carries the uncommitted work with it. Enlisted ids live in the
  reserved `enlist-N` namespace. The Console drives all of this from its own surface, so the skill
  only makes sure herdr is there for it.
- Per-ticket logs land in the pool's `runs/` directory, same as my-issue-runner writes them.
- The pool config's assignment slice (`defaults`, `assign`, `resolver`) re-reads at every
  super-step boundary (ADR-0018): an edit lands on any ticket with no Attempt in flight — a
  fresh Spawn, a checkpoint resume, a ticket Review sent back, one that has never run — at its
  next boundary, no restart needed. `roster`, `agents`, `selection`, `terminal`, and `port` stay
  exactly as they were at boot; an edit to any of those, `terminal: herdr` included, only takes
  effect on a restart. A restart is otherwise cheap: markers and the checkpoint are the truth,
  so ticket state and a pending interrupt both survive it. What does not survive is a headless
  attempt in flight: stopping the server stops its harness (and everything the harness forked),
  and the engine schedules a fresh attempt at boot, which reuses the parked worktree and so
  reads whatever the stopped one had done. If a server died without stopping its attempts
  (`kill -9`, a crash), the next boot finds any attempt still running in its worktree, stops
  it, and only then schedules (ADR-0017). A terminal-backed attempt is the exception: its pane
  outlives the server and the boot re-adopts it (ADR-0014). Never restart a pool that is
  `running` without saying so first.

---

The human-facing guide is [`GUIDE.md`](GUIDE.md): what you get, how to start, how it stops,
what it does not do.
