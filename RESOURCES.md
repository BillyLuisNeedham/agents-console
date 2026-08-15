# Agent Graph Resources

## Knowledge

- [Article: "Building effective agents" — Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
  Primary architectural guidance distinguishing predefined workflows from model-directed agents. Use for: simplicity-first decisions, workflow patterns, and when agentic complexity is warranted.
- [Docs: LangGraph.js overview — LangChain](https://docs.langchain.com/oss/javascript/langgraph/overview)
  Official JavaScript/TypeScript overview of LangGraph as a low-level orchestration runtime. Use for: durable execution, persistence, streaming, human-in-the-loop, and mixing deterministic code with model-driven steps.
- [Docs: LangGraph.js Graph API — LangChain](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
  Official reference for state, nodes, edges, reducers, conditional routing, `Send`, `Command`, super-steps, recursion limits, and graph compilation. Use for: precise TypeScript semantics.
- [Docs: LangGraph.js persistence — LangChain](https://docs.langchain.com/oss/javascript/langgraph/persistence)
  Official guide to checkpointers and stores. Use for: thread-scoped checkpoints, long-term cross-thread memory, resumability, and fault tolerance.
- [Paper: "ReAct: Synergizing Reasoning and Acting in Language Models"](https://arxiv.org/abs/2210.03629)
  Primary source for the baseline agent loop that alternates model reasoning and tool action. Use for: understanding what explicit graphs generalize or constrain.
- [Paper: "Pregel: A System for Large-Scale Graph Processing" — Google Research](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/)
  Primary source for super-steps, message passing, and vote-to-halt computation. Use for: the execution model LangGraph says inspired it.
- [Repository: `karpathy/autoresearch` — Andrej Karpathy](https://github.com/karpathy/autoresearch)
  Primary example of an autonomous research loop with verifiable metrics, reversible edits, and persistent experiment state. Use for: connecting graph thinking to bounded autonomous engineering loops and clarifying what Karpathy actually demonstrated.
- [Talk: "From Vibe Coding to Agentic Engineering" — Sequoia AI Ascent](https://www.youtube.com/watch?v=96jN2OCOfLs)
  Primary talk on agentic engineering discipline. Use for: context on evals, guardrails, and engineering loops; not a primary source for graph terminology.

## Wisdom (Communities)

- [LangChain Forum](https://forum.langchain.com/)
  Official LangChain/LangGraph Discourse community. Use for: searchable architecture questions, LangGraph.js behavior, state design, checkpointing, interrupts, and subgraphs.
- [LangChain Discord](https://discord.gg/langchain)
  Official real-time LangChain community. Use for: quick implementation questions and seeing how practitioners structure agent graphs.
- [Mastra Discord](https://discord.gg/mastra-ai)
  Official community for the TypeScript-native Mastra agent framework. Use for: comparing TypeScript-first workflow and agent abstractions.
- [Vercel Community: AI SDK](https://community.vercel.com/c/ai-sdk/62)
  Official Vercel AI SDK community. Use for: provider-agnostic TypeScript agent architecture, tool loops, structured output, streaming, and UI integration.

Community participation is optional. Treat communities as places to validate designs and get unstuck, not as substitutes for primary documentation.

## Gaps

- No trusted source has yet been curated for a direct comparison between LangGraph.js, Mastra workflows, and a hand-rolled narrow-context agent pipeline.
- No trusted source has yet been curated for graph-based agent testing and evaluation beyond general observability guidance.
