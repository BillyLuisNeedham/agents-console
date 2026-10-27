import type {
  PlanAssign,
  PlanCopies,
  PlanEdgeFile,
  PlanFile,
  PlanNodeFile,
  PlanProblem,
} from "../../protocol/wire.ts";
import type { Point, ViewTransform } from "./geometry";

export const CARD_W = 210;
export const CARD_H = 120;
export const HEAD_H = 28;

export interface EdgeKey {
  from: string;
  on: string;
  to: string;
}

export function edgeKeyText(key: EdgeKey): string {
  return `${key.from}.${key.on}>${key.to}`;
}

export const KIND_LABEL: Record<PlanNodeFile["kind"], string> = {
  conversation: "Conversation",
  agent: "Agent",
  prove: "Prove",
  review: "Review",
  decide: "Decide",
  merger: "Merger",
  gate: "Gate",
  finish: "Finish",
};

export interface DrawnPort {
  on: string;
  linked: boolean;
  weight: number;
  at: Point;
}

export interface DrawnNode {
  node: PlanNodeFile;
  at: Point;
  ports: DrawnPort[];
  problems: string[];
  warnings: string[];
  lines: string[];
  chips: string[];
}

export interface EdgeRoute {
  d: string;
  label: Point;
  back: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const LABEL_CHAR_WIDTH = 6.2;
const LABEL_PADDING = 12;
const LABEL_HEIGHT = 18;
const LABEL_CLEARANCE = 2;

export function labelBox(text: string, at: Point): Box {
  const width = text.length * LABEL_CHAR_WIDTH + LABEL_PADDING;
  return { x: at.x - width / 2, y: at.y - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT };
}

export interface DrawnEdge {
  key: string;
  copy: number;
  edge: PlanEdgeFile;
  label: string;
  problems: string[];
  route: EdgeRoute;
}

export interface PlanDrawing {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  planProblems: string[];
  size: { w: number; h: number };
}

export interface PlanProjectionInput {
  plan: PlanFile;
  problems: readonly PlanProblem[];
  /** Non-blocking findings about a node: drawn on it, never counted against Save or Boot. */
  warnings?: readonly PlanProblem[];
  verdicts: ReadonlyMap<string, readonly string[]>;
  places: ReadonlyMap<string, Point>;
  /** A label for an edge, by its key text, where the static one would mislead (the live Line's counts). */
  edgeLabels?: ReadonlyMap<string, string>;
}

export function projectPlan(input: PlanProjectionInput): PlanDrawing {
  const { plan, problems, warnings = [], verdicts, places, edgeLabels } = input;
  const nodeProblems = new Map<string, string[]>();
  const nodeWarnings = new Map<string, string[]>();
  const edgeProblems = new Map<string, string[]>();
  const planProblems: string[] = [];
  const ids = new Set(plan.nodes.map((node) => node.id));
  const drawnEdges = new Set(
    plan.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(edgeKeyText),
  );
  for (const problem of problems) {
    const at = problem.at;
    if (at.kind === "node" && ids.has(at.id)) push(nodeProblems, at.id, problem.message);
    else if (at.kind === "edge" && drawnEdges.has(edgeKeyText(at)))
      push(edgeProblems, edgeKeyText(at), problem.message);
    else planProblems.push(problem.message);
  }
  for (const warning of warnings) {
    if (warning.at.kind === "node" && ids.has(warning.at.id)) push(nodeWarnings, warning.at.id, warning.message);
  }

  const nodes = plan.nodes.map((node): DrawnNode => {
    const at = places.get(node.id) ?? { x: node.x, y: node.y };
    const words = verdicts.get(node.id) ?? [];
    const weights = words.map((on) => on.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let before = 0;
    const ports = words.map((on, i): DrawnPort => {
      const mid = (before + weights[i]! / 2) / total;
      before += weights[i]!;
      return {
        on,
        linked: plan.edges.some((e) => e.from === node.id && e.on === on),
        weight: weights[i]!,
        at: { x: at.x + mid * CARD_W, y: at.y + CARD_H },
      };
    });
    return {
      node,
      at,
      ports,
      problems: nodeProblems.get(node.id) ?? [],
      warnings: nodeWarnings.get(node.id) ?? [],
      ...cardText(node),
    };
  });

  const byId = new Map(nodes.map((n) => [n.node.id, n]));
  const seen = new Map<string, number>();
  const edges: DrawnEdge[] = [];
  const cards = nodes.map((n): Box => ({ x: n.at.x, y: n.at.y, width: CARD_W, height: CARD_H }));
  const placed: Box[] = [];
  for (const edge of plan.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const base = edgeKeyText(edge);
    const copy = seen.get(base) ?? 0;
    seen.set(base, copy + 1);
    const port = from.ports.find((p) => p.on === edge.on)?.at ?? {
      x: from.at.x + CARD_W / 2,
      y: from.at.y + CARD_H,
    };
    const label = edgeLabels?.get(base) ?? edgeLabel(edge);
    const curve = edgeCurve(from.at, port, to.at);
    const spot = clearLabelSpot(curve, label, cards, placed) ?? curveAt(curve, 0.5);
    placed.push(labelBox(label, spot));
    edges.push({
      key: base,
      copy,
      edge,
      label,
      problems: edgeProblems.get(base) ?? [],
      route: routeOf(curve, spot),
    });
  }

  const w = Math.max(0, ...nodes.map((n) => n.at.x)) + CARD_W + 400;
  const h = Math.max(0, ...nodes.map((n) => n.at.y)) + CARD_H + 400;
  return { nodes, edges, planProblems, size: { w, h } };
}

function push(map: Map<string, string[]>, key: string, message: string): void {
  const list = map.get(key);
  if (list) list.push(message);
  else map.set(key, [message]);
}

export function edgeDomKey(edge: Pick<DrawnEdge, "key" | "copy">): string {
  return edge.copy === 0 ? edge.key : `${edge.key}#${edge.copy}`;
}

export function edgeLabel(edge: PlanEdgeFile): string {
  if (!edge.cap) return edge.on;
  return `${edge.on} · ${edge.cap.max}${edge.cap.stewardExtra ? " · S" : ""}`;
}

function cardText(node: PlanNodeFile): { lines: string[]; chips: string[] } {
  switch (node.kind) {
    case "conversation":
      return { lines: [node.skill ?? "no skill", assignText(node.assign)], chips: [] };
    case "agent":
    case "prove":
    case "review":
    case "decide": {
      const chips = [copiesText(node.copies)];
      if (node.makesItems) chips.push("makes items");
      if (node.checkpoint === "steward") chips.push("checkpoint steward");
      if (node.spawns === "land") chips.push("spawns land");
      return { lines: [node.skill ?? "no skill", assignText(node.assign)], chips };
    }
    case "merger":
      return {
        lines: [`folds the copies of ${node.of}`],
        chips: [node.conflict === "wait" ? "conflict: wait" : "conflict: resolver"],
      };
    case "gate":
      return { lines: ["runs no agent"], chips: [`opens: ${node.open ?? "operator"}`, `join ${node.join ?? "any"}`] };
    case "finish": {
      const act = node.act ?? "none";
      return {
        lines: [typeof act === "string" ? `act: ${act}` : `act: ${act.other}`],
        chips: node.assign ? [assignText(node.assign)] : [],
      };
    }
  }
}

function assignText(assign: PlanAssign | undefined): string {
  const parts = [assign?.harness, assign?.model, assign?.effort].filter(Boolean);
  return parts.length ? parts.join(" · ") : "pool defaults";
}

function copiesText(copies: PlanCopies | undefined): string {
  if (!copies || copies === "one") return "one copy";
  return copies.perItem === "all" ? "per item, all at once" : `per item, ${copies.perItem} at once`;
}

type Pair = [number, number];

interface Curve {
  points: [Pair, Pair, Pair, Pair];
  back: boolean;
}

export function edgeRoute(from: Point, port: Point, to: Point): EdgeRoute {
  const curve = edgeCurve(from, port, to);
  return routeOf(curve, curveAt(curve, 0.5));
}

function edgeCurve(from: Point, port: Point, to: Point): Curve {
  const { x: px, y: py } = port;
  const straightDown = to.y >= from.y + CARD_H && Math.abs(to.x - from.x) < CARD_W;
  const forward = to.x >= from.x + CARD_W;
  if (straightDown) {
    const tx = to.x + CARD_W / 2;
    const ty = to.y;
    const dy = Math.max(20, (ty - py) / 2);
    return { points: [[px, py], [px, py + dy], [tx, ty - dy], [tx, ty]], back: false };
  }
  if (forward) {
    const tx = to.x;
    const ty = to.y + HEAD_H / 2;
    return { points: [[px, py], [px, py + 40], [tx - 60, ty], [tx, ty]], back: false };
  }
  const tx = to.x + CARD_W / 2 + 30;
  const ty = to.y + CARD_H;
  const drop = 60 + (Math.abs(px - tx) / 1600) * 110;
  return { points: [[px, py], [px, py + drop], [tx, ty + drop], [tx, ty]], back: true };
}

function curveAt({ points: [a, b, c, d] }: Curve, t: number): Point {
  const u = 1 - t;
  const at = (i: 0 | 1) => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i];
  return { x: at(0), y: at(1) };
}

function routeOf(curve: Curve, label: Point): EdgeRoute {
  const [a, b, c, d] = curve.points;
  return {
    d: `M ${a[0]} ${a[1]} C ${b[0]} ${b[1]}, ${c[0]} ${c[1]}, ${d[0]} ${d[1]}`,
    label,
    back: curve.back,
  };
}

const LABEL_T_STEP = 0.02;
const LABEL_T_STEPS = 24;
const LABEL_NUDGE_STEP = 20;
const LABEL_NUDGE_STEPS = 3;
const outFromMiddle = (steps: number, step: number): number[] =>
  Array.from({ length: steps }, (_, i) => [-(i + 1) * step, (i + 1) * step]).flat();
const LABEL_SAMPLES = [0.5, ...outFromMiddle(LABEL_T_STEPS, LABEL_T_STEP).map((dt) => 0.5 + dt)];
const LABEL_NUDGES = [0, ...outFromMiddle(LABEL_NUDGE_STEPS, LABEL_NUDGE_STEP)];

function meets(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width + LABEL_CLEARANCE &&
    b.x < a.x + a.width + LABEL_CLEARANCE &&
    a.y < b.y + b.height + LABEL_CLEARANCE &&
    b.y < a.y + a.height + LABEL_CLEARANCE
  );
}

function clearLabelSpot(curve: Curve, text: string, cards: readonly Box[], placed: readonly Box[]): Point | null {
  for (const nudge of LABEL_NUDGES) {
    for (const t of LABEL_SAMPLES) {
      const on = curveAt(curve, t);
      const spot = { x: on.x, y: on.y + nudge };
      const box = labelBox(text, spot);
      if (!cards.some((card) => meets(box, card)) && !placed.some((other) => meets(box, other))) return spot;
    }
  }
  return null;
}

function inside(at: Point, point: Point): boolean {
  return point.x >= at.x && point.x <= at.x + CARD_W && point.y >= at.y && point.y <= at.y + CARD_H;
}

export function hitNode(nodes: readonly Pick<DrawnNode, "node" | "at">[], point: Point): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (inside(nodes[i]!.at, point)) return nodes[i]!.node.id;
  }
  return null;
}

const GAP = 40;

export function freeSpot(nodes: readonly Pick<DrawnNode, "at">[], centre: Point): Point {
  const origin = { x: Math.round(centre.x - CARD_W / 2), y: Math.round(centre.y - CARD_H / 2) };
  const clear = (p: Point) =>
    nodes.every(
      (n) =>
        p.x >= n.at.x + CARD_W + GAP / 2 ||
        n.at.x >= p.x + CARD_W + GAP / 2 ||
        p.y >= n.at.y + CARD_H + GAP / 2 ||
        n.at.y >= p.y + CARD_H + GAP / 2,
    );
  for (let ring = 0; ring <= 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = { x: origin.x + dx * (CARD_W + GAP), y: origin.y + dy * (CARD_H + GAP) };
        if (clear(p)) return p;
      }
    }
  }
  return origin;
}

const READABLE_ZOOM = 0.8;

export function fitView(nodes: readonly Pick<DrawnNode, "at">[], viewport: { w: number; h: number }): ViewTransform {
  if (nodes.length === 0 || viewport.w <= 0 || viewport.h <= 0) return { x: GAP, y: GAP, zoom: 1 };
  const minX = Math.min(...nodes.map((n) => n.at.x)) - GAP;
  const minY = Math.min(...nodes.map((n) => n.at.y)) - GAP;
  const maxX = Math.max(...nodes.map((n) => n.at.x)) + CARD_W + GAP;
  const maxY = Math.max(...nodes.map((n) => n.at.y)) + CARD_H + GAP * 3;
  const zoom = Math.max(READABLE_ZOOM, Math.min(1, viewport.w / (maxX - minX), viewport.h / (maxY - minY)));
  return {
    x: Math.round(Math.max(0, (viewport.w - (maxX - minX) * zoom) / 2) - minX * zoom),
    y: Math.round(Math.max(0, (viewport.h - (maxY - minY) * zoom) / 2) - minY * zoom),
    zoom,
  };
}
