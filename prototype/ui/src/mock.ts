/**
 * MockData fallback for the Console prototype.
 *
 * Mirrors the live shape exactly (3-4 threads, tickets with statuses, one
 * pending interrupt of each kind, and the graph topology below) so variants
 * render identically when the dev server is unreachable.
 */

import type {
  InterruptProjection,
  ResumeRun,
  ShellContext,
  StreamRun,
  ThreadListItem,
  Ticket,
  Topology,
} from "./data";

// ---------------------------------------------------------------------------
// Topology (verified against src/graph.ts):
//   START → writeSpec → approveSpec → schedule →(Send fan-out)→ implementTicket
//   → schedule … → review; deadlockGate sits off schedule; review can route to
//   schedule / writeSpec / END.
// ---------------------------------------------------------------------------

const MOCK_NODES: Topology["nodes"] = [
  { id: "START" },
  { id: "writeSpec" },
  { id: "approveSpec" },
  { id: "schedule" },
  { id: "implementTicket" },
  { id: "deadlockGate" },
  { id: "review" },
  { id: "END" },
];

const MOCK_EDGES: Topology["edges"] = [
  { source: "START", target: "writeSpec" },
  { source: "writeSpec", target: "approveSpec" },
  { source: "approveSpec", target: "schedule", conditional: true },
  { source: "approveSpec", target: "writeSpec", conditional: true },
  { source: "schedule", target: "implementTicket", conditional: true },
  { source: "schedule", target: "review", conditional: true },
  { source: "schedule", target: "deadlockGate", conditional: true },
  { source: "implementTicket", target: "schedule" },
  { source: "deadlockGate", target: "schedule", conditional: true },
  { source: "deadlockGate", target: "END", conditional: true },
  { source: "review", target: "schedule", conditional: true },
  { source: "review", target: "writeSpec", conditional: true },
  { source: "review", target: "END", conditional: true },
];

const MOCK_TOPOLOGY: Topology = { nodes: MOCK_NODES, edges: MOCK_EDGES };

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const M1: Ticket = { id: "M1", title: "Scaffold exercise directories", blockedBy: [], status: "pending" };
const M2: Ticket = { id: "M2", title: "Write solution explainers", blockedBy: ["M1"], status: "pending" };
const M3: Ticket = { id: "M3", title: "Wire linting for sections", blockedBy: ["M2"], status: "pending" };
const D1: Ticket = { id: "D1", title: "Fix deadlock root cause", blockedBy: ["D2"], status: "pending" };
const D2: Ticket = { id: "D2", title: "Re-import ticket pool", blockedBy: ["D1"], status: "pending" };
const T1: Ticket = { id: "T1", title: "Demo packet + graph entry", blockedBy: [], status: "done" };
const T2: Ticket = { id: "T2", title: "Ticket pool fan-out", blockedBy: ["T1"], status: "done" };
const T3: Ticket = { id: "T3", title: "Review gate", blockedBy: ["T1", "T2"], status: "done" };

// ---------------------------------------------------------------------------
// Packet / spec fixtures
// ---------------------------------------------------------------------------

const MOCK_PACKET = [
  "# Packet",
  "",
  "Topic: mock course build",
  "",
  "## Decisions",
  "- Use an explicit graph to drive grill → spec → tickets.",
  "- Tickets fan out with blockedBy; Review is one gate at the end.",
].join("\n");

function mockSpec(tickets: Ticket[]): string {
  return [
    "# Spec",
    "",
    "Topic: mock course build",
    "",
    "## Packet",
    "",
    MOCK_PACKET,
    "",
    "## Tickets",
    ...tickets.map(
      (ticket) =>
        `- ${ticket.id}: ${ticket.title}` +
        (ticket.blockedBy.length ? ` (after ${ticket.blockedBy.join(", ")})` : ""),
    ),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Threads — one pending interrupt of each kind
// ---------------------------------------------------------------------------

const MOCK_THREADS: ThreadListItem[] = [
  {
    threadId: "run-mock-spec",
    label: "mock-spec",
    origin: "ui",
    status: "interrupted",
    createdAt: "2026-08-15T09:00:00Z",
    updatedAt: "2026-08-15T09:02:00Z",
    values: {
      spec: mockSpec([M1, M2, M3]),
      tickets: [M1, M2, M3],
      log: ["writeSpec: spec from packet + pool", "awaiting spec approval"],
      packet: MOCK_PACKET,
    },
    interrupts: [
      {
        kind: "approve-spec",
        id: "i-approve-spec",
        ns: ["graph"],
        value: { kind: "approve-spec", spec: mockSpec([M1, M2, M3]), tickets: [M1, M2, M3] },
      } satisfies InterruptProjection,
    ],
  },
  {
    threadId: "run-mock-deadlock",
    label: "mock-deadlock",
    origin: "ui",
    status: "interrupted",
    createdAt: "2026-08-15T10:00:00Z",
    updatedAt: "2026-08-15T10:03:00Z",
    values: {
      spec: mockSpec([D1, D2]),
      tickets: [D1, D2],
      log: ["schedule: no ticket ready", "deadlock: waiting on human"],
      packet: MOCK_PACKET,
    },
    interrupts: [
      {
        kind: "deadlock",
        id: "i-deadlock",
        ns: ["graph"],
        value: {
          kind: "deadlock",
          pending: ["D1", "D2"],
          hint: "no ticket can start; resume with reload to re-read the pool, or abort",
        },
      } satisfies InterruptProjection,
    ],
  },
  {
    threadId: "run-mock-review",
    label: "mock-review",
    origin: "ui",
    status: "interrupted",
    createdAt: "2026-08-15T11:00:00Z",
    updatedAt: "2026-08-15T11:05:00Z",
    values: {
      spec: mockSpec([T1, T2, T3]),
      tickets: [T1, T2, T3],
      log: ["implementTicket T1", "implementTicket T2", "implementTicket T3", "review: all tickets done"],
      packet: MOCK_PACKET,
    },
    interrupts: [
      {
        kind: "review",
        id: "i-review",
        ns: ["graph"],
        value: { kind: "review", tickets: [T1, T2, T3] },
      } satisfies InterruptProjection,
    ],
  },
  {
    threadId: "run-cli-smoke",
    label: "cli smoke run",
    origin: "cli",
    status: "idle",
    createdAt: "2026-08-14T15:00:00Z",
    updatedAt: "2026-08-14T15:04:00Z",
    values: {
      spec: mockSpec([T1, T2, T3]),
      tickets: [T1, T2, T3],
      log: [
        "writeSpec: spec from packet + pool",
        "spec approved",
        "implementTicket T1",
        "implementTicket T2",
        "implementTicket T3",
        "review: approved",
      ],
      packet: MOCK_PACKET,
    },
    interrupts: [],
  },
];

// ---------------------------------------------------------------------------
// Mock helpers — read-only stand-ins so variants never have to branch on mock
// ---------------------------------------------------------------------------

const mockStreamRun: StreamRun = async () => {
  console.warn("[console] MOCK DATA mode: streamRun is a no-op");
  return { values: [], updates: [], interrupted: null };
};

const mockResumeRun: ResumeRun = async () => {
  console.warn("[console] MOCK DATA mode: resumeRun is a no-op");
  return { values: [], updates: [], interrupted: null };
};

export function mockContext(): ShellContext {
  const threads = MOCK_THREADS.filter((t) => t.origin === "ui");
  const selected = threads[0];
  return {
    threads,
    allThreads: MOCK_THREADS,
    selectedThreadId: selected?.threadId ?? null,
    selected: selected?.values ?? null,
    interrupts: selected?.interrupts ?? [],
    topology: MOCK_TOPOLOGY,
    mock: true,
    streamRun: mockStreamRun,
    resumeRun: mockResumeRun,
  };
}
