import { Command, END, interrupt, Send } from "@langchain/langgraph";
import { join } from "node:path";
import { protoRoot } from "./paths.ts";
import { demoPacket, loadTicketPool } from "./tickets.ts";
import { GraphState, readyTickets, type Ticket } from "./state.ts";

type State = typeof GraphState.State;
type Config = { configurable?: { thread_id?: string; ticketDir?: string } };

export type SpecDecision = { action: "approve" | "reject" };
export type ReviewDecision =
  | { action: "approve" }
  | { action: "retry"; ids: string[] }
  | { action: "replan" };
export type DeadlockDecision = { action: "reload" | "abort" };

export function writeSpec(state: State, config: Config) {
  const tickets =
    state.tickets.length > 0
      ? state.tickets
      : loadTicketPool(
          config.configurable?.ticketDir ?? join(protoRoot, "tickets"),
        );
  const hasPacket = state.packet.trim().length > 0;
  const packet = hasPacket ? state.packet : demoPacket(state.topic);
  const packetSource = hasPacket ? state.packetSource : "stub";
  const spec = [
    "# Spec",
    "",
    `Topic: ${state.topic}`,
    "",
    "## Packet",
    "",
    packet.trim() || "_(empty packet)_",
    "",
    "## Tickets",
    ...(tickets.length
      ? tickets.map(
          (ticket) =>
            `- ${ticket.id}: ${ticket.title}` +
            (ticket.blockedBy.length
              ? ` (after ${ticket.blockedBy.join(", ")})`
              : ""),
        )
      : ["_(pool empty)_"]),
  ].join("\n");
  return {
    spec,
    specApproved: false,
    ...(state.tickets.length ? {} : { tickets }),
    ...(hasPacket ? {} : { packet, packetSource }),
    log: ["writeSpec: spec from packet + pool"],
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

export function schedule(state: State) {
  const pending = state.tickets.filter((ticket) => ticket.status === "pending");
  if (pending.length === 0) return {};
  const ready = readyTickets(state.tickets);
  return {
    tickets: ready.map((ticket) => ({
      ...ticket,
      status: "running" as const,
    })),
    log: [`schedule: ${ready.map((t) => t.id).join(", ")}`],
  };
}

export function routeReady(state: State) {
  if (state.tickets.length === 0) return "review";
  if (state.tickets.every((ticket) => ticket.status === "done")) return "review";
  const ready = readyTickets(state.tickets);
  if (ready.length === 0) return "deadlockGate";
  return ready.map(
    (ticket) => new Send("implementTicket", { ticket, spec: state.spec }),
  );
}

export function deadlockGate(state: State, config: Config) {
  const pending = state.tickets
    .filter((ticket) => ticket.status !== "done")
    .map((ticket) => ticket.id);
  const decision = interrupt({
    kind: "deadlock",
    pending,
    hint: "no ticket can start; resume with reload to re-read the pool, or abort",
  }) as DeadlockDecision;

  if (decision.action === "abort") {
    return new Command({
      update: { log: ["deadlock: abort"] },
      goto: END,
    });
  }
  const ticketDir = config.configurable?.ticketDir;
  const tickets = ticketDir
    ? loadTicketPool(ticketDir)
    : state.tickets.map((ticket) => ({ ...ticket, status: "pending" as const }));
  return new Command({
    update: {
      tickets,
      log: [`deadlock: reloaded pool from ${ticketDir ?? "state"}`],
    },
    goto: "schedule",
  });
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
        tickets: state.tickets.map((ticket) => ({
          ...ticket,
          status: "pending" as const,
        })),
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
