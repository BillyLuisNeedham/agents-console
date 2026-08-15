# Mission: Agent Graphs for Software Systems

## Why
Billy wants to judge whether graph-based orchestration is a useful addition to his existing multi-agent workflow, rather than adopting it because the term is fashionable. He wants durable architectural understanding: what graphs are, what they make explicit, and when they are better than the handoff pipeline he already uses.

## Success looks like
- Explain agent graphs using nodes, edges, state, reducers, checkpoints, interrupts, and super-steps without hiding behind framework jargon.
- Decide when an explicit graph is justified and when a simple function pipeline or agent loop is the better tool.
- Map the current grill → spec → tickets → implement workflow onto graph concepts and identify what a graph runtime would add or remove.
- Build a small TypeScript graph prototype that demonstrates explicit state, conditional routing, persistence, and human approval.

## Constraints
- Assume senior software engineering experience and substantial AI-agent usage.
- Prefer TypeScript examples; do not make Python the learning path.
- Keep lessons short, conceptual first, then add small hands-on exercises.
- Stay framework-neutral conceptually, while using LangGraph.js as the main concrete reference when useful.
- Relate lessons back to narrow-context handoffs between specialized agents.

## Out of scope
- Graph neural networks, graph databases, and academic graph theory except where directly useful.
- Python implementations.
- Production deployment, observability platforms, and provider-specific infrastructure until the core mental model is established.
- Broad LangChain API coverage that is not needed to understand graph orchestration.
