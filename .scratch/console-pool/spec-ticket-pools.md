# Spec: Console runs on ticket pools

Status: agreed in grill session, written locally (no tracker). Apply `ready-for-agent` if published later.

## Problem Statement

The Console renders threads of the LangGraph learning prototype: cards for fixed machinery nodes (writeSpec, schedule, implementTicket) executing a static pool of mock tickets. That made it a good lesson artifact and a bad tool. Billy's real work runs on pools of tickets — directories of Issue files with line-1 state markers, executed today by `my-issue-runner`'s `run.sh`, which is strictly sequential, halts the whole queue at any checkpoint, and is driven entirely from the terminal. He wants the Console to drive those real pools: tickets as cards, blocked-by edges as edges, parallel super-steps, state passing between tickets, and every stop-for-a-human answered inline in the card that raised it.

## Solution

A new personal skill (working name `my-console-runner`, a sibling of `my-issue-runner`) is pointed at an existing pool. It interviews exactly like my-issue-runner (drivers per ticket, default harness/model, per-ticket overrides, subagent roster, reviewer authority, checkpoint definition), writes its answers as data into the pool directory (`console.json` + `AGENT.md`), then starts the Console server bound to that pool and opens the browser.

The server is a bespoke pool engine built with graph vocabulary — State, Channels with Reducers, Super-steps, Checkpoints, Interrupts — but only the semantics a pool needs. It fans out every ticket whose blockers are done as one super-step, each ticket in its own git worktree, spawning the ticket's assigned harness CLI. Tickets return partial state updates; reducers merge them; the engine checkpoints after each super-step. Anything needing a human becomes an Interrupt on that ticket's card, answered inline or from the card's Detail; answering resumes the pool automatically. One pool per server process.

The LangGraph dev server, the prototype graph, and the thread-driving UI are left behind: the Console's canvas, cards, Detail, and styles are kept; its client and projection are rewritten against the pool engine's API.

## User Stories

Skill and launch:

1. As Billy, I want to point a skill at an existing ticket pool, so that my Console session starts from work already specified, not from tickets the tool invented.
2. As Billy, I want the skill to refuse an empty or markerless pool, so that I fix the pool instead of discovering the problem mid-run.
3. As Billy, I want the skill to ask me the same six questions my-issue-runner asks, so that the mental model and my answers transfer between the two executors.
4. As Billy, I want my answers stored as data in the pool directory, so that the engine stays one versioned copy and regenerating a pool's config never means copying engine code.
5. As Billy, I want the skill to start the server and open the browser for me, so that launching a pool is one action.
6. As Billy, I want one server process bound to one pool, so that what I'm looking at is unambiguous.

Canvas and cards:

7. As Billy, I want each ticket rendered as a card with edges drawn from its blocked-by list, so that the pool's dependency structure is visible at a glance.
8. As Billy, I want card status to reflect the line-1 state marker (ready, in-progress, done, checkpoint), so that what I see is the same truth `run.sh` would read.
9. As Billy, I want the graph's fixed machinery (start, final Review) shown as small utility cards at the ends, so that the run's overall position is visible without pretending machinery is work.
10. As Billy, I want to keep the existing canvas interactions — pan, zoom, drag, edge-routing toggle, persisted positions — because they are already paid for and proven.

Parallel execution:

11. As Billy, I want every ticket whose blockers are done to run in the same super-step, so that independent work finishes in parallel instead of queueing behind a serial runner.
12. As Billy, I want parallel tickets in a super-step to see the same starting snapshot, so that no ticket observes half-merged sibling state.
13. As Billy, I want each running ticket to work in its own git worktree branched from current HEAD, so that parallel harnesses never edit the same checkout.
14. As Billy, I want ticket work merged back in completion order, so that the pool's working branch accumulates finished work deterministically.
15. As Billy, I want a running ticket to never be rebased, so that an agent mid-task never has its ground shifted.

State passing:

16. As Billy, I want each finished ticket to record an outcome — summary and commit sha — in a global channel, so that the run accumulates what happened, not just that it happened.
17. As Billy, I want a ticket's prompt to include its blockers' outcomes, so that downstream agents build on what upstream agents actually did rather than rediscovering it.
18. As Billy, I want a log channel that appends across the whole run, so that I can read the run's narrative in one place.

Interrupts:

19. As Billy, I want the pool to run until something needs me and then wait, so that unattended progress is the default and my attention is the exception.
20. As Billy, I want an interrupt on one ticket to stall only that ticket's downstream, so that ready siblings keep running while I think.
21. As Billy, I want answering an interrupt to resume the pool immediately with no separate continue step, so that one answer is one action.
22. As Billy, I want a ticket's checkpoint to render its Brief as an interrupt on its card and in its Detail, so that I can read what the agent needs at full size and answer where I'm already looking.
23. As Billy, I want to attach an optional note when resuming from a checkpoint, appended to the Issue file, so that my answer is durable and visible to any executor that picks the pool up later.
24. As Billy, I want a merge conflict to be handed to a resolver agent automatically, so that mechanical conflict resolution doesn't burn my attention.
25. As Billy, I want the resolver agent's resolution shown to me as an approval interrupt before the merge commits, so that merge authority stays with me.
26. As Billy, I want rejecting a resolution to hand me the conflicted state with the agent's attempt noted, so that I fix it myself without losing what the agent tried.
27. As Billy, I want a harness crash — a ticket that ends with no status set — surfaced as an interrupt carrying the log path, so that silent failures can't strand a pool.
28. As Billy, I want deadlock — a ticket whose blockers can never complete — surfaced as an interrupt, so that a broken pool asks for help instead of hanging.
29. As Billy, I want one final Review interrupt when every ticket is done, so that finished work gets my judgment before the run is called complete.
30. As Billy, I want rejecting at Review to send named tickets back to ready with my note appended and the run to continue, so that review feedback loops through the graph instead of becoming terminal chores.

Durability and interop:

31. As Billy, I want state checkpointed after every super-step, so that a server restart loses nothing.
32. As Billy, I want the line-1 markers dual-written alongside checkpoints and treated as the truth on conflict, so that the pool on disk is always inspectable and both executors agree.
33. As Billy, I want a pool driven by the Console to remain drivable by `run.sh`, so that I can drop to the terminal executor whenever I want.
34. As Billy, I want per-ticket logs written to the pool's runs directory like my-issue-runner writes them, so that log-reading habits and tooling carry over.

## Implementation Decisions

- **New skill** `my-console-runner` lives beside my-issue-runner. Detection phase reuses my-issue-runner's eight facts; interview is the same six questions; output is `console.json` (drivers, per-ticket harness/model assignments, roster, reviewer authority, checkpoint definition, optional `resolver=` harness for conflict resolution falling back to the `~/.issue-runner` default) plus `AGENT.md`. It then launches the server bound to the pool and opens the browser. It never writes tickets.
- **Bespoke pool engine**, one versioned copy in the prototype, replacing any per-pool engine. Graph vocabulary, pool semantics only.
- **Graph shape is fixed**: schedule → fan-out implement → deadlock/terminal handling → Review. Grill and Spec stay outside; the pool is specified before the skill runs.
- **Channels**: `tickets` (id → status map, last-write merge), `log` (append), `outcomes` (id → summary + commit sha, keyed merge), `config` (static, the console.json contents). Upstream outcomes are injected into downstream tickets' prompts at spawn time.
- **Scheduling**: ready = every blocker done. The ready set runs as one super-step against a shared starting snapshot; reducers apply at the join.
- **Worktrees**: one git worktree per running ticket, branched from HEAD at super-step start; merges land in completion order; running tickets are never rebased.
- **Merge conflicts**: engine spawns the resolver agent automatically; its resolution is presented as an approval interrupt; approve commits the merge, reject converts to a manual-resolution interrupt carrying the agent's attempt.
- **Harness execution**: port run.sh's proven spawn kernel — non-interactive invocation with stdin closed, glued prompt (driver skill + AGENT.md + chain + roster), per-ticket harness/model from console.json, line-1 marker read-back after exit, per-ticket logs in the pool's runs directory. Crash = exit with no status set.
- **Interrupt kinds** (six, one form shape with a kind-specific body): ticket checkpoint, merge-conflict approval, resolver-failure/manual merge, harness crash, deadlock, final Review.
- **Interrupt semantics**: an interrupt blocks only its own subtree; ready siblings keep running; answering an interrupt resumes the pool automatically. The pool is quiescent only when nothing is running and interrupts are pending. Review approve ends the run; reject returns named tickets to ready with the note appended.
- **Durability**: checkpoint to sqlite in the pool directory after each super-step; line-1 markers dual-written and authoritative on conflict; server restart rehydrates from markers + checkpoint.
- **Server**: one Bun process per pool, serving the built SPA, a small JSON API (get state, start, resume-with-answer, note), and SSE pushing a full state snapshot on every change — pools are small enough that delta protocols are not worth it.
- **UI**: ticket-as-card with blocked-by edges; fixed machinery as small end cards; interrupts answered inline on the card or in its Detail, both live. Keep the existing canvas, card, Detail, and style work; discard the LangGraph client and projection and write a pool projection against the new API. The thread-driving UI leaves the Console's main path; the LangGraph prototype stays untouched as a learning artifact.

## Testing Decisions

- One seam, at the top: the pool engine's public interface. Given a temp pool directory and a console.json, start a run and assert on the state snapshots the engine emits (the same snapshots the SSE API serves) and on the files it writes (markers, checkpoints, merges).
- Harness CLIs are faked with stub scripts that set markers and exit codes — so scheduling, channels, interrupts, resume, and crash handling are all exercised through the seam without spawning real agents.
- Worktree, merge, and resolver-agent behavior is tested through the same seam using real git in temp directories: conflicted merges are constructed by having stub tickets make clashing edits.
- Only external behavior is tested — snapshots, files, merges — never engine internals or private state.
- The UI projection stays pure-function tests over snapshot fixtures, following the prior art of the existing projection tests.
- The Bun HTTP/SSE layer is a thin adapter: smoke-tested at most, no behavioral suite.

## Out of Scope

- Changing the ticket file format, or writing tickets — an empty pool stops the skill, it does not invent work.
- Parallelism controls, spend caps, or harness changes beyond what my-issue-runner already supports.
- Multi-pool servers or a pool-switching rail.
- Editing tickets, reassigning harnesses, or any config mutation from the UI.
- The LangGraph dev server, the prototype graph, and the thread-driving UI (left untouched or removed, not extended).
- Push, pull requests, or any publishing of merged work — same line my-issue-runner draws.

## Further Notes

- The `resolver=` key is the only addition to the interview's output relative to my-issue-runner's answers; it is config, not a new question.
- Deliberately deferred: mid-ticket rebasing, delta-based SSE, fan-out throttling. Each has an agreed default (never rebase, full snapshots, unthrottled super-steps) and can be revisited when a real pool hurts.
- This spec supersedes the thread-driven direction for the Console; the earlier detail-panel spec remains the authority for the canvas/Detail interactions this spec keeps.
