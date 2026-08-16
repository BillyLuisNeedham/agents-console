import { END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { mkdirSync } from "node:fs";
import {
  approveSpec,
  deadlockGate,
  implementTicket,
  review,
  routeAfterSpec,
  routeReady,
  schedule,
  writeSpec,
} from "./nodes.ts";
import { dbPath, runRoot } from "./paths.ts";
import { GraphState } from "./state.ts";

export function buildGraph() {
  mkdirSync(runRoot, { recursive: true });
  const checkpointer = SqliteSaver.fromConnString(dbPath);
  const graph = new StateGraph(GraphState)
    .addNode("writeSpec", writeSpec)
    .addNode("approveSpec", approveSpec)
    .addNode("schedule", schedule)
    .addNode("deadlockGate", deadlockGate, { ends: ["schedule", END] })
    .addNode("implementTicket", implementTicket)
    .addNode("review", review, { ends: ["schedule", "writeSpec", END] })
    .addEdge(START, "writeSpec")
    .addEdge("writeSpec", "approveSpec")
    .addConditionalEdges("approveSpec", routeAfterSpec)
    .addConditionalEdges("schedule", routeReady)
    .addEdge("implementTicket", "schedule")
    .compile({ checkpointer });
  return { graph, checkpointer };
}

export const graph = buildGraph().graph;
