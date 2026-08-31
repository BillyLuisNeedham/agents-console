---
name: my-console-runner
description: Point the Console at an existing ticket pool: detect, interview, write console.json and AGENT.md, launch the server.
disable-model-invocation: true
---

Issues already exist. This skill connects them to the Console.

It is the sibling of `my-issue-runner`: same detection, same interview, same pool on disk. Where
my-issue-runner writes `run.sh`, this skill writes `console.json` and `AGENT.md` into the pool
directory, then starts the Console server bound to that pool and opens the browser. **Never write
Issues here.** An empty or markerless pool is a reason to stop and say so, not a reason to invent
tickets.

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

## 0. Pointed at a configured pool

If the pool directory already holds `console.json` and `AGENT.md`, say so, show the config's
defaults and assignments, and ask one question: relaunch as-is, or re-interview. A relaunch goes
straight to step 5. A re-interview runs steps 1 to 4 and overwrites both files.

## 1. Detect

Look these up. Asking for them wastes a question:

- how many Issues sit in the pool's `issues/` directory, and whether every one carries a line 1
  state marker
- the `blocked-by` edges already written
- the repository's language and test framework
- the commit prefix in the last twenty commits
- which context files sit in the pool directory beside `issues/`, and their names
- whether the worktree is clean
- whether `~/.issue-runner` exists, and its contents if it does
- whether `~/.console-runner` exists, and the `engine=` path it names if it does
- which of `claude`, `opencode` and `agent` are on PATH

Report all nine back in one short brief and get it confirmed. If the pool has no `issues/`
directory, no Issues in it, or any Issue without a state marker, say which and stop: the human
fixes the pool, or `to-tickets` writes it again. If the worktree is dirty, recommend committing
before launch: tickets commit to the current branch, and an unattended agent can sweep unrelated
changes into a commit that says it is the work of an Issue.

## 2. Ask

Seven questions, each with your recommendation attached:

1. Which skill or skills drive each Issue, and whether that differs per Issue
2. The default harness and model. If `~/.issue-runner` already exists, read it, confirm it, and
   skip this question. If it does not, ask once and write it: two lines, `harness=..` and
   `model=..`
3. Whether any Issue should run on a different harness or model than the default, and which
4. The subagent roster, and a model for each
5. Whether a reviewer exists, and what authority it has
6. What counts as a checkpoint on this job specifically
7. Which port the pool should pin. Probe 8787 at setup time; recommend it when it is free,
   otherwise the next free port, or the pool's current pin on a re-interview. A concrete answer
   becomes the `port` key in `console.json`; `auto` (or next free) writes no key.

Recommend the orchestrator's own model for every subagent unless there is a reason to go smaller.
Delegating a skill to a cheaper model moves the substance of an Issue onto that model, which is
the thing the runner exists to avoid.

If a reviewer is wanted, recommend it check acceptance criteria only and never code quality, and
that a failure buy the orchestrator one fix attempt before the Issue becomes a checkpoint carrying
the disagreement in its brief. That bounds a weaker model's power to strand good work.

The merge resolver is config, not a question. Recommend the default harness for it, say
that an explicit `none` opts out so every conflict comes straight to the human, and write whatever
is agreed as the `resolver` key.

## 3. Check the drivers

For each skill named in answer 1, read its frontmatter. A skill carrying
`disable-model-invocation: true` can only be reached from the prompt, which is the one slot that
counts as the human typing, so **at most one such skill per Issue and it must be first**. Two is a
clash: name both, say which is blocked, and ask again.

In your own library `implement`, `triage`, `to-tickets`, `wayfinder` and
`thermo-nuclear-code-quality-review` all carry it. `tdd`, `code-review`, `diagnosing-bugs`,
`research`, `prototype`, `fits-the-codebase` and `resolving-merge-conflicts` do not.

Later skills in a chain run as subagents told to invoke them. That path is designed but unproven,
so put the weight of an Issue on the first driver rather than the tail of a chain.

Then check reachability per harness. The first driver goes in the prompt, so it must resolve as a
command on whatever harness the Issue is assigned:

- `claude` reaches every linked skill. Nothing to check.
- `opencode` only sees the stubs in `~/.config/opencode/command/`. If the driver's stub is
  missing, run `~/.claude/commands/scripts/link-opencode-commands.sh` before generating.
- `cursor` only sees real copies in `~/.cursor/skills/`. If the driver's copy is missing, run
  `~/.claude/commands/scripts/link-skills.sh` before generating.

Every harness named in the config must also be on PATH, from the detection brief. The engine fails
fast on an unknown harness at run start; getting it right here means the first super-step does not
stop for it.

## 4. Generate

Write `console.json` into the pool directory. All seven answers land here as data:

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
  "reviewer": "a reviewer checks acceptance criteria only; a failure buys one fix attempt",
  "checkpoint": "a device, an external write, an undecided decision, or a material guess"
}
```

- `defaults` holds answer 2 and the common case of answer 1. `drivers` is a space-separated chain:
  the first name is the driver, the rest run as the chain behind it.
- `assign` holds one entry per Issue that differs from the defaults, from answers 1 and 3. Omit
  Issues that use the defaults.
- `roster` is the roster as plain words for the prompt, from answer 4. `agents` is the same roster
  as a JSON string for claude's `--agents` flag. Keep the two in step.
- `resolver` is the merge resolver harness, or `none`. The engine falls back to the
  `~/.issue-runner` default when the key is absent, but write it explicitly so the pool's config
  says what it does.
- `port` records the port answer when it is a concrete number. Omit it for `auto`. What each
  does at launch is in step 5.
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
- which Issues are expected to stop: from the checkpoint definition, so a checkpoint on those
  reads as correct rather than as a failure

## 5. Launch

One action, in order:

1. Build the Console if it is not built. Read the engine repo path from the `engine=` line in
   `~/.console-runner`; `$ENGINE/ui/dist/` must exist. If it does not, run `bun install` and
   `bun run build` in `$ENGINE/ui/`.
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
the pool stops. To stop the server later, kill the pid in `runs/server.pid`; the engine writes it
when it claims the pool.

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
- A ticket that exits without an outcome status in its outcome JSON is a crash and surfaces as an
  interrupt carrying the log path.
- A merge conflict spawns the resolver agent; its resolution comes to the human as an approval
  interrupt, and rejecting hands the conflicted state over with the attempt noted.
- Line-1 markers are dual-written alongside the sqlite checkpoint and are the truth on conflict,
  so the pool on disk is always inspectable and `run.sh` agrees with the Console.
- Per-ticket logs land in the pool's `runs/` directory, same as my-issue-runner writes them.

---

The human-facing guide is [`GUIDE.md`](GUIDE.md): what you get, how to start, how it stops,
what it does not do.
