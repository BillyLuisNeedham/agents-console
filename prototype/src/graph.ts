import { END, START, StateGraph } from "@langchain/langgraph";
import { mkdirSync } from "node:fs";
import { BunSqliteSaver } from "./bun-sqlite-saver.ts";
import {
  approveSpec,
  grill,
  implementTicket,
  review,
  routeAfterGrill,
  routeAfterSpec,
  routeReady,
  schedule,
  writeSpec,
} from "./nodes.ts";
import { dbPath, runRoot } from "./paths.ts";
import { GraphState } from "./state.ts";

export function compileGraph() {
  mkdirSync(runRoot, { recursive: true });
  const checkpointer = new BunSqliteSaver(dbPath);
  return new StateGraph(GraphState)
    .addNode("grill", grill)
    .addNode("writeSpec", writeSpec)
    .addNode("approveSpec", approveSpec)
    .addNode("schedule", schedule)
    .addNode("implementTicket", implementTicket)
    .addNode("review", review, { ends: ["schedule", "writeSpec", END] })
    .addEdge(START, "grill")
    .addConditionalEdges("grill", routeAfterGrill)
    .addEdge("writeSpec", "approveSpec")
    .addConditionalEdges("approveSpec", routeAfterSpec)
    .addConditionalEdges("schedule", routeReady)
    .addEdge("implementTicket", "schedule")
    .compile({ checkpointer });
}
