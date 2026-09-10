# Conversations implementation plan (working doc, deleted before PR)

Spec: docs/specs/2026-09-10-conversations.md. ADR: docs/adr/0017-conversations-beside-tickets.md.

## Shared contracts (build against these first)

```ts
// engine/conversations.ts (A owns; B/C import)
export type ConversationStatus = "live" | "ended" | "crashed";
export type TurnState = "working" | "waiting";
export interface ConversationRecord {            // conversations/<id>.md, marker line
  id: string; file: string; title: string; opening: string;
  status: ConversationStatus; spawnedBy?: string;
  harness: string; model: string; drivers: string;
}
export interface ConversationView {              // on the snapshot
  id: string; title: string; status: ConversationStatus; spawnedBy: string | null;
  assignment: AssignmentView; paneId: string | null; branch: string | null;
  turn: { state: TurnState; lastLine: string; idleSince: string | null };
  children: string[];                            // spawned ticket + conversation ids
}
export interface StartConversationRequest { title: string; opening?: string;
  assign?: { harness?: string; model?: string; drivers?: string }; spawnedBy?: string }
export function loadConversations(dir: string): ConversationRecord[];
export function writeConversation(dir: string, rec: ConversationRecord): void;
export function writeConversationStatus(file: string, s: ConversationStatus): void;
export function nextConversationId(existing: ConversationRecord[]): string;   // conv-N
export function startConversation(session: Session, req: StartConversationRequest): Promise<ConversationView>; // throws when config.terminal !== "herdr"
export function endConversation(session: Session, id: string, closing?: string): Promise<void>;
export function conversationViews(session: Session): ConversationView[];

// engine/pane-session.ts (A extracts from engine.ts; B reuses)
export function sendWrapperToPane(socket, paneId, argv, ctx: WrapperContext): Promise<string|undefined>;
export function waitForReadiness(socket, paneId, harness, readyPattern, exitCodePath): Promise<Readiness>;
export function typeVerified(socket, paneId, text, echoTargets: string[], clearKeys: string[]): Promise<boolean>;
export function viewportShows(text, target): boolean;

// engine/turn-state.ts (B owns; pure)
export function deriveTurnState(prev: {text: string; state: TurnState; stableReads: number} | null,
  text: string, idlePattern: string): { state: TurnState; lastLine: string; changed: boolean };

// engine/notices.ts (B owns)
export interface Notice { to: string; from: string; kind: "ticket-ended" | "conversation-ended"; text: string }
export function enqueueNotice(session: Session, n: Notice): void;

// engine.ts additions (A wires, everyone reads)
Session.conversations: Map<string, ConversationRuntime>;   // paneId, tabId, worktree, exitCodePath, turn, notices: Notice[], ending: boolean, release: AbortController
PoolSnapshot.conversations: ConversationView[];
PoolRun.startConversation / endConversation (same signatures as above minus session);
SpawnProposal += { kind?: "ticket" | "conversation"; assign?: {...} };
PendingSpawn += { origin: "ticket" | "conversation" };
```

Events kinds to add (events.ts:21): `"notice"`, `"notice-dropped"`, `"ended"`. Conversation runtime facts (`pane_id`, `tab_id`, branch) ride a `spawned` event on `runs/<conv-id>.events.jsonl`, so `resolveTerminalPane`, `spawnedPaneAllowlist`, `closeAttemptTabs` work unchanged.

## Pointers (from planning)

- Pool state: `startPool` (engine/engine.ts:584) builds `Session` from `issues/` via `loadPoolMarkers` (engine/pool.ts:112), `runs/` for events/logs, `console.json` via `readConfig` (engine.ts:6142). Markers are line-1 `<!-- state: ... -->` (pool.ts:30). `loadPoolMarkers` throws on an empty `issues/` (pool.ts:117) and requires `spawned-by` to name a ticket in the pool (pool.ts:141) — a Ticket spawned by a Conversation fails this today.
- Terminal spawn path: `openAttemptTerminal` (engine.ts:4489) → `openAttemptTab`/`attemptTabLabel` (herdr.ts:156,136) → `spawnWithTerminal` (5432) → `sendWrapperToPane` (5391, writes `interactiveWrapper` 5355 + Enter) → `awaitInteractiveSpawn` (5470): `startPaneStreamTail` (5891), `deliverPromptInner` (5525: `waitForReadiness` 5621, typed paste + `paneShows` 5695 echo, `clearKeys` retry, file fallback), then `awaitOutcomeOrPaneEnd` (5749) racing the Outcome poll against `waitForAttemptEnding` (attempt-ending.ts:107). Reusable as-is: `openAttemptTab`, `attemptTabLabel`, `interactiveWrapper`, `waitForAttemptEnding`, `peekPane`, `paneSendInput`, `closeTab`, `startPaneStreamTail` (needs export). Must be extracted from engine.ts and parameterised: `sendWrapperToPane`, `waitForReadiness`, `paneShows`/`viewportShows`, and the typed-paste+echo loop (5567-5579) as a free-text `typeVerified`.
- Worktrees: `prepareWorktree` (worktrees.ts:175) with `branchFor`/`worktreePathFor` (70,122); merge via `mergeBranch` (223), conflict path `handleMergeConflict` (engine.ts:2152) → `runResolver` (2205) → `approvalInterrupt` (2318); answers land in `approveMerge`/`rejectMerge` (2339/2397) dispatched from `processAnswer` (1909), which looks the id up in `session.markers`. `mergeWithIssueAside` (2001) renames `marker.file`; `closeAttemptTabs` (4588) closes tabs from `spawned` events.
- Spawn adoption: `validateSpawnProposals` (4694), `adoptSpawnProposals` (4829: blockedBy membership, caps `SPAWN_MAX_PER_ATTEMPT`/`SPAWN_MAX_PER_RUN` 122-123, `writeSpawnTicket` 4784, `spawnCounters` 4809, reload + `resolveUnseenAssignments` 2567). Runs only at the drive-loop boundary (851). Outcome file convention: `runs/<id>.outcome.json` (`outcomeFileName` 149), path handed to the agent in the prompt (prompt.ts:228).
- Readiness: `readyPattern` per harness (spawn.ts:163,189,217), confirmed on 3 consecutive `peekPane` reads (engine.ts:5292). Hazard: claude's `"Claude Code v"` is a header, visible while working, so readyPattern alone cannot separate working from waiting → add `idlePattern` per harness.
- Endings/notices: ticket done/merge processed in the drive loop (963-1042), merged at 1016-1033, `resumeMerge`/`approveMerge` (2018/2339). Events kinds are a closed list (events.ts:21-39, validated on read 199). `paneSendInput` (herdr.ts:252) types text; Enter is a separate `keys` call.
- Server: routes in `createPoolServer` (server.ts:1120): `/api/state`, `/api/resume` 1330, `/api/events`, `/api/terminal/peek` 1424, `/api/terminal/focus` 1455; pane translation `resolveTerminalRequest` (1274) keyed on `ticketIds` + `resolveTerminalPane` (777) + `spawnedPaneAllowlist` (798). Snapshot shape `EnrichedSnapshot` (127), built in `enrich` (224) on `onSnapshot`.
- Crash: `waitForAttemptEnding` returns `pane-end|exit-code|pane-gone`; `exitCrashReason` (5818).
- UI: cards projected in `projectPool` (project.ts:938), laid out by `layoutPool` (779, `LAYOUT` 751), edges `projectPoolEdges` (807); `Canvas.render`/`renderTicketCard`/`renderCanvasHeader` (canvas.ts:256/410/543); Detail `projectDetail` (project.ts:1075) + `Detail.render` (detail.ts:184); tray `projectNeedsInput` (1126) + `NeedsInputTray` (needs-input.ts:62); peek store `TerminalSurface` (terminal.ts:43) keyed by ticket id; client `PoolClient` (client.ts:92); composition `ConsoleView` (view.ts:81), `AppModel` (32), bootstrap `model()`/`render()` (main.ts:259/328). Tests are pure-projection tests (project.test.ts) and class tests with injected fetch seams (needs-input.test.ts:57, terminal.test.ts:17).

## Workstream A — storage, launch, ending, crash

Files: new `engine/conversations.ts`, `engine/pane-session.ts`, `engine/conversations.test.ts`; modify `engine/engine.ts` (extract 5391-5737 into pane-session.ts and re-import; add `Session.conversations`, `PoolRun` methods in `makeHandle` 661, `PoolSnapshot.conversations` in `emitSnapshot` 815, a Conversation branch at the top of `processAnswer` 1909 for merge-approval/merge-conflict answers), `engine/events.ts` (kinds).

Storage: `<pool>/conversations/<id>.md`, line 1 `<!-- conversation: id=conv-1 status=live spawned-by=none harness=claude model=... drivers=... -->`, then `# title` and the opening Turn as body; same parser style as pool.ts:32-87. Ids `conv-N` for operator-started, `<parent>-spawn-N` for spawned (B assigns).

Launch (`startConversation`): refuse unless `config.terminal === "herdr"`; resolve assignment via `resolveAssignment`-like defaults (engine.ts:6102) or inherit parent; `prepareWorktree(session.cwd, id)`; `openAttemptTab(attemptTabLabel(id, title), cwd)`; build a `WrapperContext` with `streamPath = runs/<id>.stream.jsonl`, `logPath = runs/<id>.log`, `exitCodePath = attemptExitCodeName(id,null,false)`; `sendWrapperToPane` with `interactiveHarnessCommand(...)`; `appendEvent spawned` (payload with `pane_id/tab_id`); `startPaneStreamTail`; `waitForReadiness`; if `opening`, `typeVerified(opening)` — echo target: `descriptor.echoPattern` or the opening's last line; then start B's poller and a background `waitForAttemptEnding(socket, paneId, exitCodePath, runtime.release.signal)`.

Ending: `endConversation` sets `ending=true`, `closeTab(tabId)`; the ending wait resolves; then: `git rev-list --count <mergeTarget>..<branch>` — zero → `removeWorktree`, status `ended`; nonzero → chain on `session.mergeChain`, `mergeBranch`; ok → `merged` event, `removeWorktree`; conflict → synthesize a `TicketMarker`-shaped record and call `handleMergeConflict` (2152). `approveMerge`/`rejectMerge` reached via the `processAnswer` hook; for a Conversation, reject leaves the branch parked and the status `ended`. Record `ended` event `{closing, by:"operator"}`; call B's `notifyParent`. Wait resolving with `ending=false` → status `crashed`, `crash` event with `exitCrashReason(code, exitCodePath, "conversation", paneId)`, branch kept, worktree left, Notices dropped (B). Never touch `session.markers`, `readySet`, or the merge hold.

Tests (conversations.test.ts, reuse `startExecutingFakeHerdr` pattern engine.test.ts:219 and `harnessStub` 5498): marker round-trip; refusal on headless pool; start opens tab named like attempts and types the opening with echo; End with no commits → ended, tab closed; End with commits → merged event; conflict → merge-approval interrupt named by conv id; pane closed without End → crashed, branch exists.

## Workstream B — spawn, notices, turn state

Files: new `engine/turn-state.ts`, `engine/notices.ts`, tests; modify `engine/engine.ts` 104-131 (`SpawnProposal.kind/assign`, `PendingSpawn.origin`), 4694-4745 (validate `kind`, `assign`), 4829-4925 (skip `SPAWN_MAX_PER_RUN` when `origin==="conversation"`; drop `blockedBy` entries naming a Conversation with a `spawn-rejected` event; `kind:"conversation"` → `startConversation` with `spawnedBy`, never a ticket file), `engine/pool.ts:141` (accept `spawned-by` naming an id in a `knownParents` set: `loadPoolMarkers(issuesDir, knownParents?)`), `engine/prompt.ts` (a `buildConversationTeaching(spawnPath)` paragraph appended to the opening), `engine/spawn.ts` (add `idlePattern?: string` to `HarnessDescriptor`, defaulting to `readyPattern`).

Proposals: agent writes `runs/<conv-id>.spawn.json` (mirrors `outcomeFileName`) as `{ "spawn": [...] }`; the poller (same 2s tick as turn state) reads, `rmSync`s, validates with `validateSpawnProposals`, pushes `{parentId, proposals, origin:"conversation"}` to `session.pendingSpawns`, then calls exported `adoptSpawnProposals(session)` immediately followed by `kickProcessing` (1860) when idle. Resolve assignment: `assign` present → `resolveSpawnedTicketAssignment`-style with parent = the Conversation's assignment (add conversation ids to the `assignments` map so `resolveUnseenAssignments` 2595 finds the parent).

Turn state: poller per live Conversation, `peekPane(..., INTERACTIVE_PANE_READ_LINES)`; `deriveTurnState`: text changed → `working`, reset idle; unchanged for 2 reads and `idlePattern` present → `waiting`, `idleSince` set once; `lastLine` = last non-empty line above the input box after stripping `VIEWPORT_WRAP_CHROME`. On change call `emitSnapshot(session, session.settledPhase ?? "running")`.

Notices: hook where a ticket's ending is final — after `merged` at engine.ts:1016-1033 and `resumeMerge`/`approveMerge`, and at checkpoint raise (997) — `if (marker.spawnedBy in session.conversations) enqueueNotice(...)` with text `id, title, outcome, branch, git diff --stat`. Delivery: when the parent's poller reads `waiting`, drain the queue with `typeVerified(text, [firstLine], clearKeys)` + Enter; `notice` event on both files. Parent ended/crashed or queue non-empty at End → `notice-dropped` event on the child's file.

Tests: run cap bypass; `blockedBy: ["conv-1"]` dropped and logged; `kind:"conversation"` starts a child with inherited assignment; `deriveTurnState` table; notice typed only after `waiting`; dropped notice logged on child.

## Workstream C — server routes and snapshot

Files: `engine/server.ts`, `engine/server.test.ts`.

- `EnrichedSnapshot.state.conversations: ConversationView[]` passed through from `PoolSnapshot.conversations` in `enrich` (224).
- `GET /api/conversations` → `{ conversations }` from `latest`.
- `POST /api/conversations` body `StartConversationRequest` → `currentRun.startConversation` → 201 `{ conversation }`; 409 with the engine's reason when not terminal-backed; 400 on missing title.
- `POST /api/conversations/end` body `{ id, closing? }` → 202 `{ snapshot }`.
- `resolveTerminalRequest` (1274): accept ids from a `conversationIds` set refreshed in `refreshMeta` via `loadConversations`; `spawnedPaneAllowlist` and `currentAttemptPaneIds` iterate conversation ids too, so peek/focus work with `?ticket=<conv-id>` unchanged.
- `/api/events?ticket=<conv-id>` allowed.
- `PoolServer` gains `startConversation`/`endConversation` for tests.

Tests: mirror "terminal endpoints" (server.test.ts:2473) with the pane-text fake; create/list/end round trip; 409 on headless.

## Workstream D — UI

Files: `ui/src/project.ts` (types `PoolConversationState`, `ConversationCardView`, `projectConversations`, lane layout above `LAYOUT.startY` — shift tickets down by one `rowH` when conversations exist, edges `conversation:<id>` → children, `projectConversationsTray` sorted waiting-first then idle-age desc, `projectNeedsInput` gains waiting rows with `interrupt: null` variant), new `ui/src/conversations.ts` (tray class + "New Conversation" form with drafts/failures like `NeedsInputTray`), `ui/src/canvas.ts` (`renderConversationCard`: turn state badge, last line, idle age, End button, reuse `renderTerminalSurface`; header button "New Conversation"), `ui/src/detail.ts` (`renderConversationDetail`: peek, timeline via `/api/events`, End + closing-line textarea), `ui/src/terminal.ts` (candidate set includes conversation paneIds keyed by conv id), `ui/src/client.ts` (`listConversations`, `startConversation`, `endConversation`), `ui/src/view.ts`/`main.ts` (`AppModel.conversations`, `conversationsTray`, handlers), `ui/src/styles.css`.

Tests: `project.test.ts` additions (lane y-offset, edges, tray order, Needs-input includes waiting), `conversations.test.ts` (form drafts survive rerender, End disables while in flight, failure mark), `terminal.test.ts` (polls conversation panes), `client.test.ts` (route shapes).

## Sequencing

A lands `pane-session.ts` extraction + the `Session`/`PoolSnapshot`/`PoolRun` type stubs first; B, C, D then work on separate files against the contracts above. Only engine.ts is touched by A and B; keep B's edits to the spawn block and the three notice hooks.
