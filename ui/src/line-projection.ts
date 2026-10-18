import type {
  ConversationView,
  EnrichedTicketState,
  LineEdgeView,
  LineGraphView,
  LineNodeView,
  PlanFile,
  PlanNodeFile,
} from "../../protocol/wire.ts";
import { edgeKeyText, edgeLabel } from "./plan-projection";

/** A copy's status, joined from its Ticket (or Conversation); one not in the snapshot yet is pending. */
export type CopyTone = "pending" | "running" | "checkpoint" | "done" | "closed";

export interface LiveCopy {
  id: string;
  /** The canvas card it opens: "ticket:<id>" or "conversation:<id>". */
  card: string;
  tone: CopyTone;
  selected: boolean;
}

export type NodeTone = "idle" | "running" | "needs" | "collecting" | "parked" | "done";

export interface LiveNode {
  state: { tone: NodeTone; text: string };
  copies: LiveCopy[];
  queued: number;
  /** "pass 2 · 2 running · 3 queued"; null with no live pass. */
  summary: string | null;
  /** The Gate's or Finish's hold, else the hold of a spent loop leaving this node. */
  hold: LiveCopy | null;
  parked: readonly string[];
  /** The Finish's list while it refuses; empty on every other node. */
  waitingFor: readonly string[];
}

export interface LiveEdge {
  label: string;
  /** A spent loop, waiting on its hold Ticket. */
  spent: boolean;
  hold: LiveCopy | null;
}

export interface LineLive {
  rev: number;
  plan: PlanFile;
  verdicts: ReadonlyMap<string, readonly string[]>;
  /** "<plan name> · <status>", the header button's label. */
  headline: string;
  waitingFor: readonly string[];
  nodes: ReadonlyMap<string, LiveNode>;
  edges: ReadonlyMap<string, LiveEdge>;
}

const TICKET_TONE: Record<EnrichedTicketState["status"], CopyTone> = {
  ready: "pending",
  "in-progress": "running",
  checkpoint: "checkpoint",
  done: "done",
  closed: "closed",
};

const isActive = (copy: LiveCopy): boolean => copy.tone === "pending" || copy.tone === "running";

type TicketStatuses = ReadonlyMap<string, EnrichedTicketState["status"]>;
type Conversations = ReadonlyMap<string, Pick<ConversationView, "status" | "turn">>;

function conversationTone(c: Pick<ConversationView, "status" | "turn"> | undefined): CopyTone {
  if (!c) return "pending";
  if (c.status === "ended") return "done";
  if (c.status === "crashed") return "closed";
  return c.turn.state === "waiting" ? "checkpoint" : "running";
}

interface Join {
  tickets: TicketStatuses;
  conversations: Conversations;
  selectedId: string | null;
}

function copyOf(join: Join, id: string, conversation: boolean): LiveCopy {
  const card = `${conversation ? "conversation" : "ticket"}:${id}`;
  const status = join.tickets.get(id);
  const tone = conversation
    ? conversationTone(join.conversations.get(id))
    : status
      ? TICKET_TONE[status]
      : "pending";
  return { id, card, tone, selected: card === join.selectedId };
}

interface NodeFacts {
  plan: PlanNodeFile;
  view: LineNodeView;
  copies: LiveCopy[];
  hold: LiveCopy | null;
  active: number;
  /** The node has a pass in flight. */
  live: boolean;
  /** How many edges the Plan draws into this node. */
  incoming: number;
  /** The hold of a spent loop leaving it. */
  loopHold: LiveCopy | null;
  lineStatus: LineGraphView["status"];
  waitingFor: readonly string[];
}

type StateRule = (f: NodeFacts) => LiveNode["state"] | null;

/** The node's state word, the first rule that holds; the order is the precedence. */
const STATE_RULES: readonly StateRule[] = [
  (f) => (f.lineStatus === "done" || f.lineStatus === "closed" ? passesDone(f) : null),
  (f) => {
    if (f.plan.kind !== "finish" || f.lineStatus !== "finishing") return null;
    if (f.hold) return { tone: "needs", text: "needs you" };
    return f.waitingFor.length > 0 ? { tone: "needs", text: `waiting for ${f.waitingFor.length}` } : null;
  },
  (f) => (f.copies.some((c) => c.tone === "checkpoint") ? { tone: "needs", text: "needs you" } : null),
  (f) => (f.hold ? { tone: "needs", text: "waiting on you" } : null),
  (f) =>
    f.plan.kind === "gate" && f.plan.join === "all" && f.view.arrived.length > 0
      ? { tone: "collecting", text: `${f.view.arrived.length} of ${f.incoming} in` }
      : null,
  (f) => {
    if (!f.live && f.view.queued === 0) return null;
    const { active } = f;
    const queued = f.view.queued;
    if (active === 0 && queued === 0) return { tone: "running", text: "wrapping up" };
    return { tone: "running", text: queued > 0 ? `${active} running · ${queued} queued` : `running ${active}` };
  },
  (f) => (f.view.parked.length > 0 ? { tone: "parked", text: "done · waiting" } : null),
  (f) => (f.loopHold ? { tone: "needs", text: "loop spent" } : null),
  (f) => (f.view.passes > 0 ? passesDone(f) : null),
  () => ({ tone: "idle", text: "not run" }),
];

function stateOf(f: NodeFacts): LiveNode["state"] {
  for (const rule of STATE_RULES) {
    const state = rule(f);
    if (state) return state;
  }
  throw new Error("the last state rule always holds");
}

function passesDone(f: NodeFacts): LiveNode["state"] {
  const n = f.view.passes;
  return n > 0 ? { tone: "done", text: `done · ${n} ${n === 1 ? "pass" : "passes"}` } : { tone: "idle", text: "not run" };
}

function summaryOf(f: NodeFacts): string | null {
  const { pass, queued } = f.view;
  if (pass === undefined) return null;
  const perItem = "copies" in f.plan && typeof f.plan.copies === "object";
  if (!perItem && queued === 0) return `pass ${pass}`;
  const parts = [`pass ${pass}`, `${f.active} running`];
  if (queued > 0) parts.push(`${queued} queued`);
  return parts.join(" · ");
}

export function projectLine(
  line: LineGraphView,
  tickets: readonly Pick<EnrichedTicketState, "id" | "status">[],
  conversations: readonly Pick<ConversationView, "id" | "status" | "turn">[],
  selectedId: string | null,
): LineLive {
  const join: Join = {
    tickets: new Map(tickets.map((t) => [t.id, t.status])),
    conversations: new Map(conversations.map((c) => [c.id, c])),
    selectedId,
  };
  const views = new Map(line.nodes.map((n) => [n.id, n]));
  const edgeViews = new Map(line.edges.map((e) => [edgeKeyText(e.edge), e]));
  const spentFrom = new Map<string, string>();
  for (const e of line.edges) if (e.hold !== undefined) spentFrom.set(e.edge.from, e.hold);

  const nodes = new Map<string, LiveNode>();
  const verdicts = new Map<string, readonly string[]>();
  for (const plan of line.plan.nodes) {
    const view = views.get(plan.id) ?? emptyView(plan.id);
    verdicts.set(plan.id, view.verdicts);
    const copies = view.tickets.map((id) => copyOf(join, id, plan.kind === "conversation"));
    const facts: NodeFacts = {
      plan,
      view,
      copies,
      hold: view.hold === undefined ? null : copyOf(join, view.hold, false),
      active: copies.filter(isActive).length,
      live: view.pass !== undefined,
      incoming: line.plan.edges.filter((e) => e.to === plan.id).length,
      loopHold: spentFrom.has(plan.id) ? copyOf(join, spentFrom.get(plan.id)!, false) : null,
      lineStatus: line.status,
      waitingFor: plan.kind === "finish" ? line.waitingFor : [],
    };
    nodes.set(plan.id, {
      state: stateOf(facts),
      copies,
      queued: view.queued,
      summary: summaryOf(facts),
      hold: facts.hold ?? facts.loopHold,
      parked: view.parked,
      waitingFor: facts.waitingFor,
    });
  }

  const edges = new Map<string, LiveEdge>();
  for (const edge of line.plan.edges) {
    const key = edgeKeyText(edge);
    const view = edgeViews.get(key);
    edges.set(key, {
      label: view ? cappedLabel(view, edge.cap?.stewardExtra === true) : edgeLabel(edge),
      spent: view?.hold !== undefined,
      hold: view?.hold === undefined ? null : copyOf(join, view.hold, false),
    });
  }

  return {
    rev: line.rev,
    plan: line.plan,
    verdicts,
    headline: `${line.plan.name} · ${line.status}`,
    waitingFor: line.waitingFor,
    nodes,
    edges,
  };
}

function cappedLabel(view: LineEdgeView, stewardExtra: boolean): string {
  return (
    `${view.edge.on} · ${view.count}/${view.max}` +
    (view.bought > 0 ? ` +${view.bought}` : "") +
    (stewardExtra ? " · S" : "")
  );
}

function emptyView(id: string): LineNodeView {
  return { id, verdicts: [], passes: 0, tickets: [], queued: 0, inbox: 0, parked: [], arrived: [] };
}
