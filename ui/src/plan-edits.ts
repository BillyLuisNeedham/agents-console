import type { PlanEditFile, PlanFile, PlanNodeKind } from "../../protocol/wire.ts";
import type { Point } from "./geometry";
import type { PlanSelection } from "./plan-canvas";
import type { PlanChange, PlanMeta } from "./plan-inspector";
import { edgeKeyText } from "./plan-projection";

/**
 * A batch of gestures and inspector changes as the typed edits core applies,
 * each node, meta and cap change built from the Plan as the batch leaves it,
 * so two changes to one node in a batch both land.
 */
export function materialize(doc: PlanFile, batch: readonly PlanChange[]): PlanEditFile[] {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const caps = new Map(doc.edges.map((edge) => [edgeKeyText(edge), edge.cap]));
  let meta: PlanMeta = {
    name: doc.name,
    author: doc.author,
    source: doc.source,
    note: doc.note,
    stewardEdits: doc.stewardEdits,
  };
  const edits: PlanEditFile[] = [];
  for (const change of batch) {
    if (change.kind === "edit") {
      if (change.edit.edit === "removeNode") nodes.delete(change.edit.id);
      edits.push(change.edit);
    } else if (change.kind === "node") {
      const node = nodes.get(change.id);
      if (!node) continue;
      const next = change.change(node);
      nodes.set(change.id, next);
      edits.push({ edit: "setNode", node: next });
    } else if (change.kind === "meta") {
      meta = change.change(meta);
      edits.push({ edit: "setMeta", ...meta });
    } else {
      const key = edgeKeyText(change.key);
      if (!caps.has(key)) continue;
      const cap = change.change(caps.get(key));
      caps.set(key, cap);
      edits.push(cap ? { edit: "setCap", ...change.key, cap } : { edit: "setCap", ...change.key });
    }
  }
  return edits;
}

/** Delete or Backspace on the canvas: the selected node goes, or the selected link. */
export const removal = (selection: Exclude<PlanSelection, null>): PlanChange =>
  selection.kind === "node"
    ? { kind: "edit", edit: { edit: "removeNode", id: selection.id } }
    : { kind: "edit", edit: { edit: "unlink", ...selection.key } };

export const addition = (kind: PlanNodeKind, at: Point): PlanChange => ({
  kind: "edit",
  edit: { edit: "addNode", kind, x: Math.round(at.x), y: Math.round(at.y) },
});

/** The selection, unless the Plan no longer has what it names. */
export function kept(selection: PlanSelection, plan: PlanFile): PlanSelection {
  if (selection?.kind === "node") return plan.nodes.some((n) => n.id === selection.id) ? selection : null;
  if (selection?.kind === "edge") {
    return plan.edges.some((edge) => edgeKeyText(edge) === edgeKeyText(selection.key)) ? selection : null;
  }
  return selection;
}

type Field ={ kind: "typed"; text: string } | { kind: "committed"; text: string; by: PlanChange };

/**
 * Changes to a Plan that core has not answered yet: the queue, the one batch
 * out, and what the screen holds until that batch lands, a dropped card at
 * its drop place and a field's text as typed or committed.
 */
export class PendingEdits {
  private queued: PlanChange[] = [];
  private inFlight: PlanChange[] | null = null;
  private readonly moved = new Map<string, { at: Point; by: PlanChange }>();
  private readonly fields = new Map<string, Field>();

  get busy(): boolean {
    return this.inFlight !== null || this.queued.length > 0;
  }

  push(change: PlanChange): void {
    this.queued.push(change);
  }

  move(id: string, at: Point): void {
    const change: PlanChange = { kind: "edit", edit: { edit: "move", id, x: Math.round(at.x), y: Math.round(at.y) } };
    this.moved.set(id, { at, by: change });
    this.queued.push(change);
  }

  drops(): Map<string, Point> {
    return new Map([...this.moved].map(([id, held]) => [id, held.at]));
  }

  type(key: string, text: string): void {
    this.fields.set(key, { kind: "typed", text });
  }

  commit(key: string, text: string, change: PlanChange): void {
    this.fields.set(key, { kind: "committed", text, by: change });
    this.queued.push(change);
  }

  forget(key: string): void {
    this.fields.delete(key);
  }

  /** A field left without a commit shows the Plan's text again; true when it held typed text. */
  blur(key: string): boolean {
    if (this.fields.get(key)?.kind !== "typed") return false;
    this.fields.delete(key);
    return true;
  }

  textOf(key: string, fromDoc: string): string {
    return this.fields.get(key)?.text ?? fromDoc;
  }

  /** The queued changes as the next batch to send, unless a batch is out or nothing is queued. */
  take(): PlanChange[] | null {
    if (this.inFlight || this.queued.length === 0) return null;
    this.inFlight = this.queued.splice(0);
    return this.inFlight;
  }

  /** The batch out landed, or was refused: stop holding what it carried. */
  land(): void {
    const landed = new Set(this.inFlight);
    for (const [id, held] of this.moved) if (landed.has(held.by)) this.moved.delete(id);
    for (const [key, held] of this.fields) if (held.kind === "committed" && landed.has(held.by)) this.fields.delete(key);
    this.inFlight = null;
  }
}
