# LangGraph.js API research — for the Grill → Spec → Tickets → Review prototype

Researched 2026-08-15 against official docs (docs.langchain.com), the LangGraph.js
API reference (reference.langchain.com), npm registry metadata, and the
langgraphjs source on GitHub. All versions are the latest stable on npm at
research time.

## 1. Packages

Install command (from the official overview):

```bash
npm install @langchain/langgraph @langchain/core
```

| Package | Latest stable | Purpose |
| --- | --- | --- |
| `@langchain/langgraph` | 1.4.10 | Graph runtime: `StateSchema`, `StateGraph`, `Send`, `Command`, `interrupt`, `START`, `END`, `MemorySaver`, `MemoryStore` |
| `@langchain/core` | 1.2.8 | Peer dep: `RunnableConfig`, message classes, `GraphRecursionError` types. Requires Node >= 20 |
| `@langchain/langgraph-checkpoint-sqlite` | 1.0.3 | `SqliteSaver` — file-based checkpointer (better-sqlite3, WAL mode). Install separately |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.4 | `PostgresSaver` — prod checkpointer, needs `await checkpointer.setup()` |
| `zod` | 4.4.3 | Field schemas for `StateSchema` (`import { z } from "zod/v4"`) |
| `@langchain/react` (frontend, optional) | 1.0.30 | v1 frontend SDK: `useStream()`; peer deps React ^18/^19, `@langchain/core` ^1.1.48 |
| `@langchain/langgraph-sdk` | 1.9.29 | SDK client (dependency of `@langchain/react`; older React entry `@langchain/langgraph-sdk/react`) |

Notes:

- `@langchain/langgraph-checkpoint` (1.1.3, base `BaseCheckpointSaver` interface) ships *with* `@langchain/langgraph` — no separate install.
- `MemorySaver` is exported directly from `@langchain/langgraph`.
- Sources: https://www.npmjs.com/package/@langchain/langgraph,
  https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite,
  https://docs.langchain.com/oss/javascript/langgraph/overview (install section),
  https://docs.langchain.com/oss/javascript/langgraph/checkpointers (checkpointer libraries list).

## 2. State definition — use `StateSchema` (2026 recommended)

The docs comparison table is unambiguous:

| Approach | Recommended |
| --- | --- |
| `StateSchema` | **Yes** |
| Channels API (`LastValue`, `BinaryOperatorAggregate`, `Topic`) | Advanced cases |
| `Annotation.Root` | **Legacy** |
| Zod v3 + `.langgraph` plugin | **Legacy** |
| Zod v4 + registry (`@langchain/langgraph/zod`) | **Legacy** |

Minimal example (from the graph-api doc, lightly trimmed — overwrite channel +
accumulate-array channel):

```typescript
import { StateSchema, ReducedValue, MessagesValue } from "@langchain/langgraph";
import { z } from "zod/v4";

const State = new StateSchema({
  // Simple Zod fields = "last value" channel: every update OVERWRITES
  status: z.enum(["grilling", "spec", "tickets", "review"]),
  // Custom reducer channel: updates ACCUMULATE
  ticketIds: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.array(z.string()),
    reducer: (current, update) => [...current, ...update],
  }),
});
```

- No reducer specified ⇒ default reducer = last-write-wins (`reducer(current, update) => update`).
- `ReducedValue` wraps a Zod schema + `reducer` (+ optional `inputSchema` for the update shape).
- `MessagesValue` is a prebuilt message-list channel; `UntrackedValue` is state that is never checkpointed.
- Types: `typeof State.State` (full state), `typeof State.Update` (partial update); type nodes with
  `GraphNode<typeof State>` or the shorthand `typeof State.Node`; conditional-edge routers with
  `ConditionalEdgeRouter<{ InputSchema: typeof State; Nodes: "a" | "b" }>`.
- Distinct input/output schemas: `new StateGraph({ state: OverallState, input: InputState, output: OutputState })`.
- Sources: https://docs.langchain.com/oss/javascript/langgraph/graph-api (State / Reducers / Alternative state definitions),
  https://docs.langchain.com/oss/javascript/langgraph/use-graph-api (Define state).

## 3. Graph construction

```typescript
import { StateGraph, StateSchema, START, END } from "@langchain/langgraph";

const graph = new StateGraph(State)
  .addNode("grill", grillNode)
  .addNode("spec", specNode)
  .addEdge(START, "grill")
  // Conditional edge: router returns a node name, list of names, or END
  .addConditionalEdges("grill", (state) => state.status === "unclear" ? "grill" : "spec")
  .addEdge("spec", END)
  .compile({ checkpointer });   // checkpointer required for interrupts/persistence
```

- Nodes are `(state, config) => partialUpdate` functions; must return updates, never mutate state.
- `.addEdge(START, "x")` sets the entry point; multiple outgoing edges ⇒ parallel superstep.
- `.addConditionalEdges(node, router, pathMap?)` — router sees full state.
- `compile()` does structure checks; you MUST compile before use.
- Runtime config: `{ configurable: { thread_id: "..." } }`; `recursionLimit` is a *top-level* config key,
  not inside `configurable`.
- `Command` lets a node combine `update` + `goto` routing (declare `ends: [...]` in `addNode` for it).
- Sources: https://docs.langchain.com/oss/javascript/langgraph/graph-api (Compiling, Nodes, Edges),
  https://docs.langchain.com/oss/javascript/langgraph/use-graph-api (Create a sequence of steps).

## 4. Fan-out / map-reduce with `Send`

- `new Send(nodeName, payload)` — returned as an array from a conditional edge. Each Send becomes one
  task: the **payload becomes the node's input state** for that invocation (confirmed in source:
  `input: packet.args` in `libs/langgraph-core/src/pregel/algo.ts`), and the node's returned updates
  are merged into the overall graph state through the normal reducers.
- Only-send-ready pattern (blockedBy filter): the router function is pure over state, so filter there:

```typescript
const route: ConditionalEdgeRouter<{ InputSchema: typeof State; Nodes: "implementTicket" }> = (state) =>
  state.tickets
    .filter((t) =>
      t.blockedBy.every((id) => state.ticketResults.some((r) => r.ticketId === id)) &&
      !state.ticketResults.some((r) => r.ticketId === t.id)
    )
    .map((t) => new Send("implementTicket", { ticketId: t.id, spec: state.spec }));
```

- Auto-starting newly-ready tickets: loop the scheduler. Give `implementTicket` a (conditional) edge
  back to the scheduler node; the scheduler's conditional edge re-fires each pass and Sends only
  tickets that are unblocked *and not already run*, returning `END` when nothing remains. This is the
  documented "loops + Send" composition; the filter above is what prevents already-run tickets from
  being re-Sent on later passes.
- Merging results: use a `ReducedValue` (concat) channel so all N parallel results accumulate.
- Pitfalls (documented):
  - **Parallel writes to the same channel are unordered.** "updates from a parallel superstep may not
    be ordered consistently. If you need a consistent, predetermined ordering ... write the outputs to
    a separate field ... together with a value with which to order them."
  - A superstep is **transactional**: if any parallel node throws, none of that superstep's updates
    apply (with a checkpointer, successful nodes' writes are saved as pending writes and not re-run on resume).
  - Cap parallelism with `{ configurable: { max_concurrency: 10 } }`.
  - Don't mix static edges and `Command`/Send routing out of the same node — both fire.
- Sources: https://docs.langchain.com/oss/javascript/langgraph/use-graph-api (Map-Reduce and the send API, Create branches, Create and control loops),
  https://docs.langchain.com/oss/javascript/langgraph/graph-api (Send).

## 5. Interrupts

- Modern API: call `interrupt(payload)` inside a node (payload must be JSON-serializable). Requires a
  checkpointer + `thread_id`.
- The caller sees the pause as `result.__interrupt__` — an array of `{ id, value }` entries; helpers
  `isInterrupted(result)` and the `INTERRUPT` constant exist. With `streamEvents` v3, use
  `stream.interrupted` (boolean) and `stream.interrupts`.
- Resume with a payload — the value becomes the return value of the `interrupt()` call in the node:

```typescript
await graph.invoke(new Command({ resume: { action: "approve" } }), { configurable: { thread_id: "t1" } });
// reject / retry-ids / replan: any JSON-serializable value works
await graph.invoke(new Command({ resume: { action: "retry", ticketIds: ["T3"] } }), config);
```

- Multiple simultaneous interrupts (parallel fan-out): resume with a map `{ [interruptId]: value }`.
- `graph.updateState(config, values, asNode?)` edits state directly; it creates a *new* checkpoint
  (`metadata.source === "update"`) and updates pass through reducers — useful for "reviewer edits spec"
  and for replan (write back a new ticket list before continuing).
- Routing after approval/rejection: the node returns `new Command({ goto: "proceed" | "replan" | "tickets" })`
  based on the resume value, or you use a conditional edge after the interrupt node.
- Rules of interrupts (all documented):
  - Do not wrap `interrupt()` in try/catch — it pauses by throwing a special exception.
  - Interrupt call order within a node is matched **index-based** on resume; don't conditionally skip or loop them.
  - The whole node **restarts from the beginning** on resume — side effects before `interrupt()` must be idempotent (put them after the interrupt or in another node instead).
  - For validation loops, call `interrupt()` exactly once per node invocation and loop via a conditional edge (never `while` + `interrupt()`).
  - Static breakpoints (`interruptBefore`/`interruptAfter` at compile or runtime) exist for debugging, not HITL.
- Sources: https://docs.langchain.com/oss/javascript/langgraph/interrupts,
  https://docs.langchain.com/oss/javascript/langgraph/checkpointers (Get and update state),
  https://docs.langchain.com/oss/javascript/langgraph/graph-api (Command).

## 6. Checkpointer (disk, Ctrl-C + resume)

- **SqliteSaver** (file-based, survives process exit):

```typescript
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
const checkpointer = SqliteSaver.fromConnString("path/to/checkpoints.sqlite");
// fromConnString(connStringOrLocalPath: string): SqliteSaver  (better-sqlite3 Database, WAL, tables auto-created)
const graph = builder.compile({ checkpointer });
```

  Source confirms `fromConnString` just does `new SqliteSaver(new Database(connStringOrLocalPath))`.
- PostgresSaver (prod): `PostgresSaver.fromConnString("postgresql://...", { schema })` and you MUST
  `await checkpointer.setup()` once; `thread_id` column is length-limited (keep < 255 chars).
- MemorySaver: RAM only, lost on restart — use only for tests.
- Threads: always pass `{ configurable: { thread_id } }`; optional `checkpoint_id` selects a specific
  checkpoint (time travel). Reusing a thread_id resumes the same thread; a new one starts fresh.
- Inspect state: `await graph.getState(config)` → `StateSnapshot` with `values`, `next` (empty array =
  complete), `config`, `metadata` (`source`, `step`, `writes`), `createdAt`, `parentConfig`, `tasks`
  (each task has `name`, `interrupts`). `graph.getStateHistory(config)` is an async iterable of the
  same snapshots (newest first); find an interrupt with
  `s.tasks.some((t) => t.interrupts.length > 0)`.
- **Durability modes** (for Ctrl-C safety): default is `"async"` (checkpoint written asynchronously
  while the next step runs). Pass `{ durability: "sync" }` to write every checkpoint synchronously
  before the next step — the safe choice for a CLI you might Ctrl-C mid-run. `"exit"` persists only at
  graph exit. `checkpointDuring` is deprecated in favor of `durability`.
- Sources: https://docs.langchain.com/oss/javascript/langgraph/checkpointers,
  https://docs.langchain.com/oss/javascript/langgraph/persistence,
  https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite,
  https://reference.langchain.com/javascript/langchain-langgraph-checkpoint-sqlite/SqliteSaver/fromConnString,
  source `libs/langgraph-core/src/pregel/types.ts` (durability JSDoc: default `"async"`).

## 7. Streaming / observing

- **Recommended API**: `graph.streamEvents(input, { version: "v3" })` returns typed projections:
  - `stream.values` — full state snapshot after each super-step (print this in the CLI).
  - `stream` — raw `ProtocolEvent`s, each with `method` ("values", "updates", ...), `params.namespace`,
    `params.node` (which node emitted it).
  - `stream.interrupted` / `stream.interrupts` — pause detection (loop: run → if interrupted, prompt →
    resume with `Command({ resume })` → repeat until `!stream.interrupted`).
  - `stream.output` — final state; `stream.messages`, `stream.subgraphs` — chat tokens / nested graphs.
- Raw modes: `graph.stream(input, { streamMode: "updates" })` → per-node deltas `{ nodeName: update }`
  (perfect for "which node ran"); `streamMode: "values"` → full snapshots; multiple modes as an array
  yield `[mode, chunk]` tuples; `streamMode: "debug"` streams everything.
- Custom progress: `config.writer({ ... })` inside a node/tool, consumed with `streamMode: "custom"`.
- For a tiny local webpage: `@langchain/react`'s `useStream({ apiUrl, assistantId, streamMode })`
  renders `stream.values`, per-node status, subgraphs, and interrupts — but it talks to a LangGraph
  Server/API endpoint (the SDK is client/server), not an in-process graph. Without a server, a simpler
  local page can poll `graph.getState` / `graph.getStateHistory` (and expose them via a tiny HTTP
  endpoint from the CLI) and render `StateSnapshot.values` + `next`.
- Sources: https://docs.langchain.com/oss/javascript/langgraph/event-streaming,
  https://docs.langchain.com/oss/javascript/langgraph/streaming,
  https://docs.langchain.com/oss/javascript/langgraph/checkpointers (Get state),
  https://docs.langchain.com/oss/javascript/langgraph/frontend/overview.

## 8. Gotchas for a senior TS engineer new to LangGraph

1. **recursionLimit**: default 25 super-steps; set as a *top-level* config key
   (`{ recursionLimit: 100 }`), never inside `configurable`. Exceeding it throws `GraphRecursionError`
   (importable, catch it). Inside a node, `config.metadata?.langgraph_step` is the step counter.
   A Grill loop with a bounded exit condition is fine, but a loop bug = hard recursion error.
2. **Node names**: string keys for edges; unnamed nodes default to the function name. For threads that
   are *currently interrupted*, you cannot rename/remove nodes (the thread may be about to enter them).
   Finished threads tolerate full topology changes.
3. **Reducer last-write-wins**: any plain field is overwritten by each update — parallel fan-out writes
   to a plain channel lose data / race. Use `ReducedValue` for anything written by >1 node in a step,
   and include an order key if order matters.
4. **`interrupt()` determinism**: it suspends by throwing; never try/catch it; keep its calls fixed in
   count and order per node invocation (resume matching is index-based); no loops over it; node re-runs
   from the top on resume, so code before `interrupt()` re-executes (make it idempotent).
5. **Checkpoint granularity**: checkpoints are per super-step, not mid-node — a crashed node re-runs
   from its start on resume. Side effects belong after the interrupt or in a separate node.
6. **Must pass checkpointer + `thread_id` together** for interrupts/persistence; `MemorySaver` is not
   durable across restarts — for the disk-resume requirement use `SqliteSaver`.
7. **Routing exclusivity**: a node should use EITHER static `addEdge` OR `Command`/Send dynamic routing
   — not both (both fire, surprising parallel execution).
8. **`Command({ resume })` is the only Command intended as input to `invoke`/`stream`** — don't pass
   `Command({ update })` alone to continue a conversation; it resumes from the latest checkpoint and
   appears stuck.
9. **Use the current API**: `StateSchema` (not `Annotation.Root`, not raw Zod plugins). Import Zod as
   `zod/v4` in current docs. `CheckpointDuring` is deprecated → `durability`.
10. **`UntrackedValue` is not checkpointed** — anything needed across an interrupt/resume must be a
    normal channel or `ReducedValue`.
11. Supersteps are transactional — one failing parallel node fails the whole superstep; with a
    checkpointer the successful writes are saved and skipped on resume.

## Key URLs

- https://docs.langchain.com/oss/javascript/langgraph/overview
- https://docs.langchain.com/oss/javascript/langgraph/graph-api
- https://docs.langchain.com/oss/javascript/langgraph/use-graph-api
- https://docs.langchain.com/oss/javascript/langgraph/persistence
- https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- https://docs.langchain.com/oss/javascript/langgraph/interrupts
- https://docs.langchain.com/oss/javascript/langgraph/streaming
- https://docs.langchain.com/oss/javascript/langgraph/event-streaming
- https://docs.langchain.com/oss/javascript/langgraph/frontend/overview
- https://reference.langchain.com/javascript/langchain-langgraph (API reference)
- https://www.npmjs.com/package/@langchain/langgraph (+ `-checkpoint`, `-checkpoint-sqlite`, `-checkpoint-postgres`)
- Source: https://github.com/langchain-ai/langgraphjs (`libs/langgraph-core/src/pregel/*`, `libs/checkpoint-sqlite/src/index.ts`)
