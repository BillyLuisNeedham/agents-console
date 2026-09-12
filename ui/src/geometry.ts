/**
 * Canvas geometry: the pure shape math the canvas renders and the pool
 * projection's layouts speak. Points, card boxes, edge routing, the pan/zoom
 * transform, and the persisted-layout round trip. No DOM, no network:
 * numbers in, numbers out.
 */

export type Point = { x: number; y: number };

export type EdgeMode = "ortho" | "straight";

export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TopologyEdge {
  source: string;
  target: string;
  conditional?: boolean;
  data?: string;
}

// There is one pool per server, so a card's stored position is keyed by its
// own id; no thread scoping is needed.
export function layoutStorageKey(cardId: string): string {
  return cardId;
}

/**
 * The flow neighbourhood of a selected card: its one-hop inflow (the cards
 * whose edges point at it: its blockers, plus start when it is blockerless)
 * and one-hop outflow (the cards it points at: its dependents, plus review).
 * One hop only, never the transitive cone, so a chain does not light up the
 * whole canvas. A cleared selection has an empty neighbourhood.
 */
export function flowNeighbourhood(
  edges: TopologyEdge[],
  selectedId: string | null,
): { inflow: string[]; outflow: string[] } {
  if (!selectedId) return { inflow: [], outflow: [] };
  return {
    inflow: edges.filter((edge) => edge.target === selectedId).map((edge) => edge.source),
    outflow: edges.filter((edge) => edge.source === selectedId).map((edge) => edge.target),
  };
}

export function edgePath(
  source: CardBox,
  target: CardBox,
  mode: EdgeMode,
): { d: string; lx: number; ly: number } {
  const sx = source.x + source.w / 2;
  const sy = source.y + source.h / 2;
  const tx = target.x + target.w / 2;
  const ty = target.y + target.h / 2;
  const up = ty < sy;
  const outY = up ? source.y : source.y + source.h;
  const inY = up ? target.y + target.h : target.y;
  if (mode === "ortho") {
    const midY = (outY + inY) / 2;
    return {
      d: `M ${sx} ${outY} L ${sx} ${midY} L ${tx} ${midY} L ${tx} ${inY}`,
      lx: sx + 6,
      ly: midY,
    };
  }
  return {
    d: `M ${sx} ${outY} L ${tx} ${inY}`,
    lx: (sx + tx) / 2 + 6,
    ly: (outY + inY) / 2,
  };
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

export interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

export function zoomAtCursor(
  view: ViewTransform,
  cursor: Point,
  factor: number,
): ViewTransform {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  if (zoom === view.zoom) return view;
  const wx = (cursor.x - view.x) / view.zoom;
  const wy = (cursor.y - view.y) / view.zoom;
  return { x: cursor.x - wx * zoom, y: cursor.y - wy * zoom, zoom };
}

export function strokeWidthForZoom(zoom: number): number {
  return 1.5 / zoom;
}

export function mergeLayout(
  defaults: Record<string, Point>,
  stored: Record<string, Point>,
): Record<string, Point> {
  const positions: Record<string, Point> = {};
  for (const [id, pos] of Object.entries(defaults)) {
    positions[id] = stored[id] ?? pos;
  }
  return positions;
}

export function parseStoredLayout(raw: unknown): Record<string, Point> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const positions: Record<string, Point> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const x = (value as { x?: unknown }).x;
    const y = (value as { y?: unknown }).y;
    if (typeof x !== "number" || typeof y !== "number") continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    positions[id] = { x, y };
  }
  return positions;
}
