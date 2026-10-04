/**
 * The contract areas a conformance case is tagged with, which the runner's
 * report counts the pass share of. One list, so a typo cannot open a new
 * area: the internal-test inventory (docs/research/rust-port/test-inventory.md)
 * names the areas the remaining cases fall into, and each joins here with
 * its first case.
 */
export const AREAS = {
  http: "the HTTP routes: status codes and JSON bodies",
  socket: "the WebSocket at /api/ws: hello, snapshot, delta, card, live and reply frames",
  disk: "the files in the pool directory: Ticket markers, events JSONL, console.json, console.db",
  attempts: "Attempts and harness launch: argv, env, cwd, the ticket prompt, spawned and exited facts, fallbacks",
  conversations: "Conversations: storage, start and launch, ending, spawn.json adoption, the teaching Turn, Seeded Pools",
} as const;

export type Area = keyof typeof AREAS;
