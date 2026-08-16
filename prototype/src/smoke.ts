import { Command, isInterrupted } from "@langchain/langgraph";
import { buildGraph } from "./graph.ts";
import { protoRoot } from "./paths.ts";
import { demoPacket, loadTicketPool } from "./tickets.ts";

const { graph } = buildGraph();
const config = {
  configurable: {
    thread_id: `smoke-${Date.now()}`,
    ticketDir: `${protoRoot}/tickets`,
  },
  durability: "sync" as const,
  recursionLimit: 50,
};

let input: Parameters<typeof graph.invoke>[0] = {
  topic: "smoke",
  packet: demoPacket("smoke"),
  packetSource: "stub",
  tickets: loadTicketPool(`${protoRoot}/tickets`),
};

for (let i = 0; i < 8; i++) {
  const result = await graph.invoke(input, config);
  if (!isInterrupted(result)) {
    const snap = await graph.getState(config);
    console.log("ok", snap.values.tickets);
    process.exit(0);
  }
  const kind = (
    result.__interrupt__[0]?.value as { kind?: string } | undefined
  )?.kind;
  console.log("interrupt", kind);
  if (kind === "approve-spec" || kind === "review") {
    input = new Command({ resume: { action: "approve" } });
    continue;
  }
  console.error("unexpected", result.__interrupt__);
  process.exit(1);
}
console.error("too many steps");
process.exit(1);
