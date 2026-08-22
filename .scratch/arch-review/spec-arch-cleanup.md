# Spec — Architecture review cleanup: delete the dead, deepen the shallow

Pool: `.scratch/arch-review/` · Branch: `arch/cleanup` · Origin: architecture review 2026-08-22 (`/tmp/architecture-review-20260822-193934.html`)

## Problem Statement

The repo carries two pipelines: the old LangGraph experiment (`src/`, `langgraph.json`, `tickets/`, `mock-tickets*/`, `.run/`, `.langgraph_api/`, the langsmith script, `.env` files with a live LangSmith key) and the live Console (`engine/` + `ui/`). Nothing live references the old one, yet `README.md` and `NOTES.md` still instruct newcomers to run it. Inside the Console itself, the UI typecheck is red (dead `ui/src/prototype/` imports names that were never exported), one engine module is an orphan (`fleet-cli.ts`, promised by ADR-0001 but launched by nothing), on-disk file formats are parsed in two or three places each (attempt-log names, `console.json`, the issue file), the server re-declares domain facts the engine already owns, module export surfaces are wider than any consumer, the opencode harness reverse-parses the prompt's first line, and the UI's most delicate behavior (the ticket log pane's live-tail state machine) is scattered across four modules and untestable, while `view.ts` has grown into a 1,305-line god module whose own header calls it a thin layer.

## Solution

Execute the architecture review's ten candidates as one pool: delete everything verified dead, wire the orphan fleet command, consolidate each file format behind one owner, make the server import the engine's domain types, trim export surfaces to what consumers actually use, hand harnesses structured fields instead of a string to reverse-parse, and deepen the UI by extracting a `log-pane` module and splitting `view.ts` along its existing responsibility clusters. One commit per ticket on `arch/cleanup`, tests and typecheck green after every commit. Rewrite `README.md` for the Console and delete `NOTES.md`. Record the attempt-log naming ownership as ADR-0003.

## User Stories

1. As a maintainer, I want the old LangGraph pipeline deleted from the repo, so that one executable system remains and the deletion test concentrates complexity instead of spreading it.
2. As a maintainer, I want the `smoke` and `studio` scripts and the `@langchain/*` + `zod` dependencies removed from the root package manifest, so that the dependency surface matches the Console.
3. As a maintainer, I want the `.env` files holding a live LangSmith key deleted, so that an unused secret stops sitting in the working tree.
4. As a newcomer, I want `README.md` to describe the Console and how to run it (pool server, UI build, fleet command), so that I don't boot the dead system by following the docs.
5. As a maintainer, I want `NOTES.md` deleted, so that a stale experiment log stops masquerading as current status.
6. As a maintainer, I want `ui/src/prototype/` deleted, so that the UI typecheck is green and 1,079 unreachable lines leave the interface surface.
7. As a maintainer, I want the fleet list command reachable via a root package script, so that ADR-0001's promised feature actually exists.
8. As a maintainer, I want attempt-log file naming owned by one function in the events module, so that the writer, the log lister, and the attempt reconstructor cannot drift apart (ADR-0002's "stable from the first write" contract becomes code).
9. As a maintainer, I want `console.json` parsed once by the engine and consumed by the server, so that the `port` field stops being a dead field parsed twice behind the engine's back.
10. As a maintainer, I want the issue-file format (heading, spec body, line-1 marker) parsed by the engine and exposed as ticket metadata, so that the server stops re-deriving a format the engine owns.
11. As a maintainer, I want the server to import ticket status, run phase, interrupt kind, and the REVIEW ticket id from the engine instead of re-declaring them, so that drift across the seam becomes a compile error.
12. As a maintainer, I want dead exports removed (`EVENT_KINDS`, the server's unused exports, the engine's self-only exports, the UI projection's importer-free exports and `isUtilityCardId`), so that each module's interface stops lying about what is load-bearing.
13. As a maintainer, I want each harness adapter to receive structured fields (driver, issue reference, body) instead of reverse-parsing the prompt's first line, so that a prompt-format change cannot silently break opencode while claude keeps working.
14. As a maintainer, I want the ticket log pane's byte-window state machine, live-tail, attempt-stay guards, and scroll pin extracted into one deep `log-pane` module with an injectable fetch seam, so that the most delicate UI behavior has one home and one interface to test.
15. As a maintainer, I want `view.ts` split into canvas, detail, and drawers modules with state hoisted into a per-session view-state object, so that each cluster owns its state and renderers become testable pure functions.
16. As a maintainer, I want every change verified by `bun test`, `tsc --noEmit` (root and `ui/`), and the UI build after each ticket, so that `arch/cleanup` is always mergeable.

## Implementation Decisions

- Work happens on branch `arch/cleanup` in worktree `.git/worktrees/arch-review`; the pool lives at `.scratch/arch-review/` inside that worktree. Main stays free for other agents.
- Execution order respects dependencies: deletions first (they shrink the surface everything else touches), then export trims, then format consolidation, then server type imports, then the two UI deepenings, then the prompt/spawn seam last (its tests pin current behavior and must be re-pinned deliberately).
- The old-pipeline deletion is total: `src/`, `langgraph.json`, `tickets/`, `mock-tickets/`, `mock-tickets-deadlock/`, `scripts/setup-langsmith.sh`, both `.env` files, `.run/`, `.langgraph_api/`, `docs/langgraph-js-api-2026.md`, `NOTES.md`; strip `smoke`/`studio` scripts and `@langchain/*` + `zod` deps from the root manifest; drop `"src"` from tsconfig include. The stale-docs rewrite lands in the same deletion wave so docs never describe a half-deleted system.
- The fleet command is wired, not deleted: a root package script runs the existing fleet CLI module, fulfilling ADR-0001. Its test keeps spawning it as a subprocess.
- Attempt-log naming moves into the events module as one exported naming function covering base, attempt-numbered, and resolver variants; the engine's rotator and both server readers call it. Recorded as ADR-0003: the events module owns all ticket-log file naming.
- The engine gains one config loader that the server consumes (port included); `port` leaves the engine's config type only if the server's consumption makes it redundant, otherwise it becomes genuinely read.
- Ticket metadata (title, spec) is exposed by the pool/engine side beside the existing marker loading; the server's heading parsers are deleted.
- Server re-declarations of engine domain types are replaced with imports. The UI's wire-type copies across the HTTP seam are inherent and stay. The REVIEW id stays one constant in the engine; the UI keeps its own wire constant.
- Export trimming is consumer-driven: unexport what nothing imports; where a test alone needs a symbol, import from the defining module or test through the public seam. Exports that serve as interface documentation are trimmed last and conservatively.
- The prompt's first line stops being a wire format: harness resolvers receive structured context and build their own invocation; `afterFirstLine` is deleted.
- The log-pane extraction is one deep module owning the byte-window state machine (open, tail, prepend-earlier, attempt-stay, scroll pin) with fetch functions injected at construction; `main.ts` drives it, `view.ts` renders its view model. The client's paging protocol stops leaking to callers.
- The `view.ts` split follows the existing clusters: canvas (pan/zoom/drag/edge routing/persisted positions), detail (render/resize/fullscreen/interrupt forms/drafts), drawers; module-scope state is hoisted into a per-session view-state object created by the composition root.
- No new runtime dependencies. Stack stays vanilla TypeScript + Vite + bun.

## Testing Decisions

- Good tests here test external behavior through the highest existing seam: the engine through its public interface with stub harnesses and temp pool directories (existing `engine.test.ts` precedent), the server over HTTP with real temp pools (existing `server.test.ts` precedent), the UI projection as pure functions over fixtures (existing `project.test.ts` precedent).
- No new test seams are introduced for the deletions and export trims; green existing suites plus typecheck are the verification.
- The attempt-log naming function gets direct unit tests pinning the ADR-0002 naming contract where it lives.
- The harness spawn seam gets direct unit tests per adapter pinning argv shapes (opencode, claude), replacing the test that pinned reverse-parsing.
- The log-pane module gets unit tests with injected fake fetches, pinning the stale-selection and attempt-stay guards that are currently unreachable.
- The `view.ts` split is behavior-preserving; verification is the existing suite plus the UI build, plus any pure helpers lifted into the projection's tested home.
- Every ticket ends green: `bun test`, `tsc --noEmit` at root and in `ui/`, `bun run build` in `ui/` when UI files changed.

## Out of Scope

- Merging `arch/cleanup` to main and any push or PR — Billy's call after the final review.
- Reopening ADR-0001 or ADR-0002 themselves; ADR-0003 is additive.
- Replacing the harness roster, changing the resolver, or touching the fleet registry format.
- Any UI redesign or feature work; the deepenings are behavior-preserving.
- Deleting `.scratch/console-pool/` or `.scratch/console/` — they are the current system's recorded history.

## Further Notes

- Dead-code claims were verified by repo-wide grep during the review (three parallel exploration agents, spot-checked by the orchestrator): `ui/src/prototype/` has zero importers and fails typecheck today; `EVENT_KINDS` is read by nothing; `fleet-cli.ts` is referenced only by its own test; the old pipeline shares zero imports with `engine/` or `ui/`.
- The two `.env` files are gitignored secrets; never print or commit their values. Deleting them is a working-tree deletion only.
- The reviewer for this pool checks acceptance criteria only, never code quality.
