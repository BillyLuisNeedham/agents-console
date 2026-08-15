import { Command, END, interrupt, Send } from "@langchain/langgraph";
import { runGrill } from "./opencode.ts";
import {
  GraphState,
  readyTickets,
  scenarioTickets,
  type Ticket,
} from "./state.ts";

type State = typeof GraphState.State;

export type GrillDecision = { action: "resume" | "reset" };
export type SpecDecision = { action: "approve" | "reject" };
export type ReviewDecision =
  | { action: "approve" }
  | { action: "retry"; ids: string[] }
  | { action: "replan" };

export async function grill(
  state: State,
  config: { configurable?: { thread_id?: string } },
) {
  const threadId = config.configurable?.thread_id ?? "demo";

  if (state.stubGrill && state.grillStatus !== "done") {
    return {
      grillStatus: "done" as const,
      packet: stubPacket(state.topic),
      log: ["grill: stub packet"],
    };
  }

  let sessionId = state.opencodeSessionId;
  let reset = false;
  if (state.grillStatus === "failed") {
    const decision = interrupt({
      kind: "grill-failed",
      sessionId,
      reason: state.lastError,
    }) as GrillDecision;
    reset = decision.action === "reset";
    if (reset) sessionId = "";
  }

  const result = await runGrill({
    topic: state.topic,
    threadId,
    sessionId: sessionId || undefined,
    reset,
  });

  if (!result.ok) {
    return {
      grillStatus: "failed" as const,
      opencodeSessionId: result.sessionId,
      lastError: result.error,
      log: [`grill failed: ${result.error}`],
    };
  }

  return {
    grillStatus: "done" as const,
    opencodeSessionId: result.sessionId,
    packet: result.packet,
    lastError: "",
    log: ["grill wrote packet"],
  };
}

export function routeAfterGrill(state: State) {
  return state.grillStatus === "done" ? "writeSpec" : "grill";
}

export function writeSpec(state: State) {
  const tickets = scenarioTickets();
  const spec = [
    "# Spec (stub)",
    "",
    `Topic: ${state.topic}`,
    "",
    "## Packet",
    "",
    state.packet.trim() || "_(empty packet)_",
    "",
    "## Tickets",
    ...tickets.map(
      (ticket) =>
        `- ${ticket.id}: ${ticket.title}` +
        (ticket.blockedBy.length ? ` (after ${ticket.blockedBy.join(", ")})` : ""),
    ),
  ].join("\n");
  return {
    spec,
    specApproved: false,
    tickets,
    log: ["writeSpec: stub spec + T1 T2 T3"],
  };
}

export function approveSpec(state: State) {
  const decision = interrupt({
    kind: "approve-spec",
    spec: state.spec,
    tickets: state.tickets,
  }) as SpecDecision;
  if (decision.action === "reject") {
    return { specApproved: false, log: ["spec rejected"] };
  }
  return { specApproved: true, log: ["spec approved"] };
}

export function routeAfterSpec(state: State) {
  return state.specApproved ? "schedule" : "writeSpec";
}

export function schedule() {
  return {};
}

export function routeReady(state: State) {
  if (state.tickets.length === 0) return "review";
  if (state.tickets.every((ticket) => ticket.status === "done")) return "review";
  const ready = readyTickets(state.tickets);
  if (ready.length === 0) {
    throw new Error("ticket deadlock: pending work with no ready tickets");
  }
  return ready.map(
    (ticket) => new Send("implementTicket", { ticket, spec: state.spec }),
  );
}

export async function implementTicket(input: { ticket: Ticket; spec: string }) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    tickets: [{ ...input.ticket, status: "done" as const }],
    log: [`implementTicket ${input.ticket.id}`],
  };
}

export function review(state: State) {
  const decision = interrupt({
    kind: "review",
    tickets: state.tickets,
  }) as ReviewDecision;

  if (decision.action === "retry") {
    const tickets = state.tickets.map((ticket) =>
      decision.ids.includes(ticket.id)
        ? { ...ticket, status: "pending" as const }
        : ticket,
    );
    return new Command({
      update: { tickets, log: [`review: retry ${decision.ids.join(", ")}`] },
      goto: "schedule",
    });
  }

  if (decision.action === "replan") {
    return new Command({
      update: {
        specApproved: false,
        tickets: scenarioTickets(),
        log: ["review: replan"],
      },
      goto: "writeSpec",
    });
  }

  return new Command({
    update: { log: ["review: approved"] },
    goto: END,
  });
}

function stubPacket(topic: string): string {
  return [
    "# Packet",
    "",
    `Topic: ${topic}`,
    "",
    "## Decisions",
    "- Use LangGraph.js for this course's prototype.",
    "- Tickets fan out with blockedBy; Review is one gate at the end.",
    "",
    "## Context",
    "Stub packet so the rest of the graph can be poked without an interview.",
    "",
    "## Suggested skills",
    "- to-spec",
  ].join("\n");
}
