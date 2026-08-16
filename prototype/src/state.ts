import { ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

export const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  blockedBy: z.array(z.string()),
  status: z.enum(["pending", "running", "done"]),
});

export type Ticket = z.infer<typeof ticketSchema>;

export const GraphState = new StateSchema({
  topic: z.string().default(""),
  packetSource: z.enum(["file", "stub"]).default("stub"),
  packet: z.string().default(""),
  spec: z.string().default(""),
  specApproved: z.boolean().default(false),
  tickets: new ReducedValue(z.array(ticketSchema).default(() => []), {
    reducer: mergeTickets,
  }),
  log: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.array(z.string()),
    reducer: (current, update) => [...current, ...update],
  }),
});

export type GraphStateType = typeof GraphState.State;

function mergeTickets(current: Ticket[], update: Ticket[]): Ticket[] {
  const map = new Map(current.map((ticket) => [ticket.id, ticket]));
  for (const ticket of update) {
    map.set(ticket.id, { ...map.get(ticket.id), ...ticket });
  }
  return [...map.values()];
}

export function readyTickets(tickets: Ticket[]): Ticket[] {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return tickets.filter(
    (ticket) =>
      ticket.status !== "done" &&
      ticket.blockedBy.every((id) => byId.get(id)?.status === "done"),
  );
}
