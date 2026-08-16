<!-- state: id=04 blocked-by=02 status=ready -->

# 04 — Graph canvas: node cards, edges, live highlighting

## What to build

The graph-centric canvas. Topology is fetched from `client.assistants.getGraph(assistantId)` and rendered with a simple layered layout: one card per node, edges between them. Each node card shows only the state channels relevant to that node (e.g. the approveSpec card shows the spec; the deadlockGate card shows pending tickets and hint; the review card shows the ticket summary). Currently-running and next nodes are highlighted, driven by the `updates` stream. Replaces the plain list from the walking skeleton.

## Acceptance criteria

- [ ] Canvas renders the real graph topology from the dev server, not a hardcoded copy
- [ ] Each node card shows only its relevant channels
- [ ] Running and next nodes highlight live as `updates` events arrive
- [ ] The plain state list from ticket 1 is gone

## Blocked by

- 02 — Live streaming

---

## Brief, written by the runner

The agent stopped without setting its own status, last seen as 'in-progress'. It crashed, ran out of context, or was killed. It had no chance to write a brief or to commit.

- Stopped: 2026-08-16 21:14
- Log: `.scratch/console/runs/04.log`
- Working tree at the stop:

```
 M .scratch/console/issues/01-walking-skeleton.md
 M .scratch/console/issues/02-live-streaming.md
 M .scratch/console/issues/03-start-run.md
 M .scratch/console/issues/04-graph-canvas.md
 M .scratch/console/run.sh
?? .scratch/console/runs/
?? .scratch/console/verify-02.ts
?? .scratch/console/verify-03.ts
```

Last lines of the log:

```
            "conditional": true
        },
        {
            "source": "review",
            "target": "__end__",
            "conditional": true
        }
    ]
}
[0m
The live topology has expanded conditional edges (approveSpec/schedule point at everything reachable) — that's what the server reports, so the canvas renders it. Now let me check the SDK's `getGraph` types and the remaining spike files.
[0m$ [0mls prototype/ui/node_modules/@langchain/langgraph-sdk/dist/ 2>/dev/null | head; rg -n "getGraph" prototype/ui/node_modules/@langchain/langgraph-sdk/dist/client.d.ts 2>/dev/null || rg -rn "getGraph" prototype/ui/node_modules/@langchain/langgraph-sdk/ -l 2>/dev/null | head
auth
client.cjs
client.cjs.map
client.d.cts
client.d.cts.map
client.d.ts
client.d.ts.map
client.js
client.js.map
index.cjs
165:  getGraph(assistantId: string, options?: {
[0m
[91m[1mError: [0mYou've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing
```

Nothing above is confirmed. Read the log before you trust any part of this Issue.
