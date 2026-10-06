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
  attempts: "Attempts and harness launch, headless or terminal-backed: argv, env, cwd, the ticket prompt, spawned and exited facts, fallbacks, the Attempt's end",
  steward: "the Steward: its console.json entry, what it is told, its answers and their limits, its notes, routes and teaching",
  conversations: "Conversations: storage, start and launch, ending, Turn state, Notices, spawn.json adoption, the teaching Turn, Seeded Pools, the conversation routes",
  scheduling: "the drive loop: super-steps, the ready set, the Outcome contract and status writes, lifecycle events, blockers, the final Review, deadlock",
  spawns: "Spawns: proposals in Outcomes, adoption at the boundary, Pending and Held spawns, caps, the spawn routes",
  verify: "verify and Jev: the verify: N fan-out, grader Tickets, Jev grading (through a fake TypeSafe endpoint), Selection and head-to-head, human selection, Adopt, the grades endpoint",
  merges: "pool worktrees and branches, merges, the Merge hold and Merge queue, the resolver, Ticket file reconcile",
  cli: "the boot, fleet and steward command lines: what they print, write, exit with and launch",
  restart: "restart and takeover: a server picking up a pool another server process left on disk, and what a stopping server leaves for the next",
  config: "Assignments and settings: what console.json resolves each Ticket to, Config reload, Reassign, Pool settings, Machine defaults, the settings routes",
  herdr: "the pool's herdr panes: the RPC client, the Pool workspace, tab labels and closing, agent reporting, pane reads, Held panes, the terminal routes",
  formats: "on-disk formats: the state line, Ticket and Conversation markdown, events JSONL, log and Stream file names, the ledger and spawn files, fleet and Machine defaults files",
  protocol: "the socket protocol: hello, the snapshot and its deltas, cards, requests and replies, push coalescing",
  server: "the server process: startup, the pool lock, ports, fleet registration, Stop, shutdown, runtime refusals",
  interrupts: "Interrupts and answers: /api/resume, Close, Keep talking, Queued answers",
  enlist: "enlisting a live herdr pane as a Ticket or a Conversation, and the enlisted Ticket's lifecycle",
} as const;

export type Area = keyof typeof AREAS;
