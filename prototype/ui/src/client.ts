/**
 * Thin wrapper over the LangGraph SDK client. The Console is a client of the
 * dev server's HTTP API only; this module is the single place that talks to it.
 */

import { Client, type Thread } from "@langchain/langgraph-sdk";
import type { Raw } from "./project";

export const DEV_SERVER_URL = "http://localhost:2024";

export function makeClient(): Client {
  return new Client({ apiUrl: DEV_SERVER_URL, apiKey: null });
}

export async function listThreads(client: Client): Promise<Thread<Raw>[]> {
  return client.threads.search<Raw>({
    limit: 50,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
}

export async function getThread(client: Client, threadId: string): Promise<Thread<Raw>> {
  return client.threads.get<Raw>(threadId);
}
