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
  // The inventory's areas (docs/research/rust-port/test-inventory.md, "Contract areas").
  protocol: "the socket protocol: hello, the snapshot and its deltas, cards, requests and replies, push coalescing",
  server: "the server process: startup, the pool lock, ports, fleet registration, Stop, shutdown, runtime refusals",
  cli: "the boot, fleet and steward command lines",
  restart: "a server starting on an existing pool, and what a stopping server leaves for the next",
  scheduling: "the drive loop: the ready set, super-steps, the Outcome contract and status writes, final Review",
  interrupts: "Interrupts and answers: /api/resume, Close, Keep talking, Queued answers",
  merges: "worktrees, branches, merges, the Merge hold and Merge queue, the resolver",
  spawns: "spawn proposals, Pending and Held spawns, Spawn caps, the spawn routes",
  attempts: "launch, run and end of an Attempt, headless or terminal-backed",
  herdr: "the pool's herdr panes: the Pool workspace, tabs, pane reads, Held panes, the terminal routes",
  conversations: "Conversations: storage, start, launch, ending, Turn state, Notices, the conversation routes",
  steward: "the Steward role and its routes",
  enlist: "enlisting a live herdr pane as a Ticket or a Conversation, and the enlisted Ticket's lifecycle",
  config: "Assignments and settings: resolution, Reassign, Pool settings, Machine defaults, the settings routes",
  verify: "verify fan-out, grader Tickets, Jev grading, Selection, the grades endpoint",
} as const;

export type Area = keyof typeof AREAS;
