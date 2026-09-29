/**
 * The Spawn proposals the engine keeps before they land (ADR-0029, issue
 * #150; CONTEXT.md: Pending spawn, Held spawn). A proposal taken from an
 * exited attempt, or from a Conversation's spawn.json, is one of two things
 * until it lands or goes:
 *
 * - a **Pending spawn**: within the caps, waiting for the next super-step
 *   boundary to land it. The operator may Hold it or Discard it first.
 * - a **Held spawn**: one a cap had no room for, one the proposing agent
 *   marked as overlapping work already in the pool, or one the operator held
 *   back. It waits for the operator's Adopt (past the caps) or Discard.
 *
 * Both survive a restart. The record of them is one file,
 * `runs/held-spawns.json` (the name ADR-0029 gave it, kept so a pool that
 * held spawns before issue #150 reads unchanged), replaced whole through a
 * rename so a crash never leaves half of it. One file keeps a proposal's
 * move from pending to held a single write. It carries both lists, the
 * counter the proposal ids come from (never reused, so a discarded
 * `proposal-1` cannot come back as the name of another proposal, and an id
 * an agent read from the Spawn ledger keeps meaning one proposal), and the
 * keys of the pre-ADR truncations boot has already recovered, so a recovery
 * and the holds it made land in the same write and it never runs twice.
 *
 * A proposal keeps its id from the moment it is taken until it lands or is
 * discarded, whether it is pending or held. Held spawns from before issue
 * #150 keep their `held-N` ids.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnProposal } from "./engine.ts";

/**
 * Why a proposal is held: which cap had no room (the attempt's, or a
 * spawn.json's, own; or the run's), the proposing agent's own `overlaps`
 * mark (the ids ride on the proposal), or the operator's Hold of a Pending
 * spawn.
 */
export type HeldSpawnReason = "per-attempt" | "per-run" | "overlaps" | "operator";

interface SpawnProposalRecord {
  id: string;
  /** The Ticket or Conversation whose proposal this is. */
  parentId: string;
  /** Whether the proposal came from a Ticket's Outcome or a Conversation's
   *  spawn.json: a landed Ticket-origin one counts toward the run. */
  origin: "ticket" | "conversation";
  proposal: SpawnProposal;
}

export interface PendingSpawn extends SpawnProposalRecord {
  /** When it was taken from its attempt or spawn.json. */
  at: string;
  /** The id the boundary is landing it under, written before the ticket
   *  file is: a restart that finds it set checks whether that ticket
   *  landed, so a crash mid-landing never lands it twice. */
  landing?: string;
}

export interface HeldSpawn extends SpawnProposalRecord {
  reason: HeldSpawnReason;
  /** When it was held (for a recovered one, when the cap truncated it). */
  at: string;
  /** Why the boundary refused its last Adopt, until the next Adopt. */
  adoptError?: string;
}

/** A proposal as the Console shows it, pending or held. */
interface SpawnProposalViewBase {
  id: string;
  parentId: string;
  origin: "ticket" | "conversation";
  /** What landing it starts: a Ticket, or a Conversation. */
  kind: "ticket" | "conversation";
  title: string;
  body: string;
  blockedBy: string[];
  /** The tickets it would block once it lands, "all" for every ticket not
   *  yet started at that moment, or null when it blocks none. */
  blocks: string[] | "all" | null;
  /** The pool work the proposing agent said it overlaps: Tickets,
   *  Conversations, or other proposals, by id. Empty when it named none. */
  overlaps: string[];
  at: string;
}

/** One Pending spawn as the Console shows it (wire.ts re-exports this). */
export type PendingSpawnView = SpawnProposalViewBase;

/** One held spawn as the Console shows it (wire.ts re-exports this). */
export interface HeldSpawnView extends SpawnProposalViewBase {
  reason: HeldSpawnReason;
  /** An Adopt is on its way to the boundary: the spawn is still held until
   *  the engine writes it, so a restart before then loses nothing. */
  adopting: boolean;
  /** Why the boundary refused the last Adopt (a blocker gone, a blocks
   *  target finished while the Adopt waited): the spawn stayed held.
   *  Absent until a refusal, and cleared by the next Adopt. */
  adoptError?: string;
}

interface SpawnProposalsFile {
  seq: number;
  pending: PendingSpawn[];
  held: HeldSpawn[];
  recovered: string[];
}

/** One proposal as it is taken: held for the reason given, or pending. */
export interface TakenProposal {
  parentId: string;
  origin: "ticket" | "conversation";
  proposal: SpawnProposal;
  at: string;
  held?: HeldSpawnReason;
}

export interface SpawnProposals {
  pending(): PendingSpawn[];
  getPending(id: string): PendingSpawn | undefined;
  held(): HeldSpawn[];
  getHeld(id: string): HeldSpawn | undefined;
  /**
   * Take proposals under fresh ids, in the order given, each pending or
   * held as it says, all in one write before this returns.
   */
  take(entries: TakenProposal[]): { pending: PendingSpawn[]; held: HeldSpawn[] };
  /** Hold proposals under fresh ids, written before this returns. */
  hold(entries: Omit<HeldSpawn, "id">[]): HeldSpawn[];
  /** The operator's Hold of a Pending spawn: held for "operator" under the
   *  same id, in one write. Null when it is not pending (landed, discarded,
   *  or never). */
  holdPending(id: string, at: string): HeldSpawn | null;
  /** Drop a Pending spawn (discarded, or rejected at the boundary). */
  removePending(id: string): PendingSpawn | null;
  /** Record the ids the boundary is about to land these Pending spawns
   *  under, in one write before any ticket file is. */
  markLanding(landing: Map<string, string>): void;
  /** Forget a landing mark whose ticket never landed: it waits again. */
  clearLanding(id: string): void;
  /** Drop Pending spawns that landed, in one write. */
  landed(ids: string[]): void;
  /** Drop one held spawn (adopted or discarded), written before this returns. */
  removeHeld(id: string): HeldSpawn | null;
  /** Whether this id has ever named a proposal of this pool: pending, held,
   *  or since landed or discarded. An `overlaps` mark may name any of them. */
  isProposalId(id: string): boolean;
  /** Whether boot has already recovered the truncation under this key. */
  wasRecovered(key: string): boolean;
  /** Hold a recovery's proposals and mark its key, in one write. */
  recover(key: string, entries: Omit<HeldSpawn, "id">[]): HeldSpawn[];
  /** The held ids an Adopt has queued for the boundary, in the order the
   *  operator adopted them. In memory only: after a restart the spawn is
   *  simply held again. */
  adopting: Set<string>;
  /** An Adopt is queued: mark it adopting and clear any earlier refusal. */
  beginAdopt(id: string): void;
  /** The boundary refused the Adopt: still held, the reason kept on it. */
  refuseAdopt(id: string, reason: string): void;
  pendingViews(): PendingSpawnView[];
  heldViews(): HeldSpawnView[];
}

export function spawnProposalsPath(runsDir: string): string {
  return join(runsDir, "held-spawns.json");
}

const PROPOSAL_ID = /^(?:proposal|held)-(\d+)$/;

function viewBase(record: SpawnProposalRecord & { at: string }): SpawnProposalViewBase {
  return {
    id: record.id,
    parentId: record.parentId,
    origin: record.origin,
    kind: record.proposal.kind ?? "ticket",
    title: record.proposal.title,
    body: record.proposal.body,
    blockedBy: record.proposal.blockedBy ?? [],
    blocks: record.proposal.blocks ?? null,
    overlaps: record.proposal.overlaps ?? [],
    at: record.at,
  };
}

/**
 * The pool's pending and held proposals as the file has them. An absent
 * file is none; a file from before issue #150 has no pending list and
 * reads as none pending. A file that does not parse throws with its path:
 * writing over it would lose whatever it held, and saying so beats that.
 */
export function loadSpawnProposals(runsDir: string): SpawnProposals {
  const path = spawnProposalsPath(runsDir);
  let file: SpawnProposalsFile = { seq: 0, pending: [], held: [], recovered: [] };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SpawnProposalsFile>;
      file = {
        seq: typeof parsed.seq === "number" ? parsed.seq : 0,
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        held: Array.isArray(parsed.held) ? parsed.held : [],
        recovered: Array.isArray(parsed.recovered) ? parsed.recovered : [],
      };
    } catch (err) {
      throw new Error(
        `spawn proposals: ${path} cannot be read (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const write = (): void => {
    mkdirSync(runsDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, path);
  };
  const nextId = (): string => `proposal-${++file.seq}`;
  const withIds = (entries: Omit<HeldSpawn, "id">[]): HeldSpawn[] =>
    entries.map((entry) => ({ id: nextId(), ...entry }));

  const adopting = new Set<string>();
  return {
    pending: () => [...file.pending],
    getPending: (id) => file.pending.find((p) => p.id === id),
    held: () => [...file.held],
    getHeld: (id) => file.held.find((held) => held.id === id),
    take: (entries) => {
      const pending: PendingSpawn[] = [];
      const held: HeldSpawn[] = [];
      for (const { held: reason, ...entry } of entries) {
        const id = nextId();
        if (reason === undefined) pending.push({ id, ...entry });
        else held.push({ id, ...entry, reason });
      }
      file.pending.push(...pending);
      file.held.push(...held);
      write();
      return { pending, held };
    },
    hold: (entries) => {
      const held = withIds(entries);
      file.held.push(...held);
      write();
      return held;
    },
    holdPending: (id, at) => {
      const found = file.pending.find((p) => p.id === id);
      if (!found) return null;
      file.pending = file.pending.filter((p) => p.id !== id);
      const held: HeldSpawn = {
        id,
        parentId: found.parentId,
        origin: found.origin,
        proposal: found.proposal,
        reason: "operator",
        at,
      };
      file.held.push(held);
      write();
      return held;
    },
    removePending: (id) => {
      const found = file.pending.find((p) => p.id === id);
      if (!found) return null;
      file.pending = file.pending.filter((p) => p.id !== id);
      write();
      return found;
    },
    markLanding: (landing) => {
      if (landing.size === 0) return;
      for (const pending of file.pending) {
        const id = landing.get(pending.id);
        if (id !== undefined) pending.landing = id;
      }
      write();
    },
    clearLanding: (id) => {
      const found = file.pending.find((p) => p.id === id);
      if (found?.landing === undefined) return;
      delete found.landing;
      write();
    },
    landed: (ids) => {
      if (ids.length === 0) return;
      file.pending = file.pending.filter((p) => !ids.includes(p.id));
      write();
    },
    removeHeld: (id) => {
      const found = file.held.find((held) => held.id === id);
      if (!found) return null;
      file.held = file.held.filter((held) => held.id !== id);
      adopting.delete(id);
      write();
      return found;
    },
    isProposalId: (id) => {
      const match = PROPOSAL_ID.exec(id);
      return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= file.seq;
    },
    wasRecovered: (key) => file.recovered.includes(key),
    recover: (key, entries) => {
      const held = withIds(entries);
      file.held.push(...held);
      file.recovered.push(key);
      write();
      return held;
    },
    adopting,
    beginAdopt: (id) => {
      adopting.add(id);
      const held = file.held.find((h) => h.id === id);
      if (held?.adoptError === undefined) return;
      delete held.adoptError;
      write();
    },
    refuseAdopt: (id, reason) => {
      adopting.delete(id);
      const held = file.held.find((h) => h.id === id);
      if (!held) return;
      held.adoptError = reason;
      write();
    },
    pendingViews: () => file.pending.map((pending) => viewBase(pending)),
    heldViews: () =>
      file.held.map((held) => ({
        ...viewBase(held),
        reason: held.reason,
        adopting: adopting.has(held.id),
        ...(held.adoptError !== undefined ? { adoptError: held.adoptError } : {}),
      })),
  };
}
