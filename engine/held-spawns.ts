/**
 * Held spawns (ADR-0029, CONTEXT.md: Held spawn): the Spawn proposals the
 * caps had no room for, kept for the operator instead of dropped. Each waits
 * until the operator adopts it (past the caps, at the next boundary or at
 * once on an idle pool) or discards it, and survives a restart meanwhile.
 *
 * The record of them is one file, `runs/held-spawns.json`, replaced whole
 * through a rename so a crash never leaves half of it. It carries the held
 * proposals, the counter their ids come from (never reused, so a discarded
 * `held-1` cannot come back as the name of another proposal), and the keys
 * of the pre-ADR truncations boot has already recovered, so a recovery and
 * the holds it made land in the same write and it never runs twice.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnProposal } from "./engine.ts";

/** Which cap had no room: the attempt's (or a spawn.json's) own, or the run's. */
export type HeldSpawnReason = "per-attempt" | "per-run";

export interface HeldSpawn {
  id: string;
  /** The Ticket or Conversation whose proposal this is. */
  parentId: string;
  /** Whether the proposal came from a Ticket's Outcome or a Conversation's
   *  spawn.json: an adopted Ticket-origin one counts toward the run. */
  origin: "ticket" | "conversation";
  proposal: SpawnProposal;
  reason: HeldSpawnReason;
  /** When it was held (for a recovered one, when the cap truncated it). */
  at: string;
}

/** One held spawn as the Console shows it (wire.ts re-exports this). */
export interface HeldSpawnView {
  id: string;
  parentId: string;
  origin: "ticket" | "conversation";
  /** What adopting it starts: a Ticket, or a Conversation. */
  kind: "ticket" | "conversation";
  title: string;
  body: string;
  blockedBy: string[];
  /** The tickets it would block once adopted, "all" for every ticket not yet
   *  started at that moment, or null when it blocks none. */
  blocks: string[] | "all" | null;
  reason: HeldSpawnReason;
  at: string;
  /** An Adopt is on its way to the boundary: the spawn is still held until
   *  the engine writes it, so a restart before then loses nothing. */
  adopting: boolean;
}

interface HeldSpawnsFile {
  seq: number;
  held: HeldSpawn[];
  recovered: string[];
}

export interface HeldSpawns {
  list(): HeldSpawn[];
  get(id: string): HeldSpawn | undefined;
  /** Hold proposals under fresh ids, written before this returns. */
  hold(entries: Omit<HeldSpawn, "id">[]): HeldSpawn[];
  /** Drop one (adopted or discarded), written before this returns. */
  remove(id: string): HeldSpawn | null;
  /** Whether boot has already recovered the truncation under this key. */
  wasRecovered(key: string): boolean;
  /** Hold a recovery's proposals and mark its key, in one write. */
  recover(key: string, entries: Omit<HeldSpawn, "id">[]): HeldSpawn[];
  /** The ids an Adopt has queued for the boundary. In memory only: after a
   *  restart the spawn is simply held again. */
  adopting: Set<string>;
  views(): HeldSpawnView[];
}

export function heldSpawnsPath(runsDir: string): string {
  return join(runsDir, "held-spawns.json");
}

/**
 * The pool's held spawns as the file has them. An absent file is none held.
 * A file that does not parse throws with its path: holding over it would
 * lose whatever it held, and saying so beats that.
 */
export function loadHeldSpawns(runsDir: string): HeldSpawns {
  const path = heldSpawnsPath(runsDir);
  let file: HeldSpawnsFile = { seq: 0, held: [], recovered: [] };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HeldSpawnsFile>;
      file = {
        seq: typeof parsed.seq === "number" ? parsed.seq : 0,
        held: Array.isArray(parsed.held) ? parsed.held : [],
        recovered: Array.isArray(parsed.recovered) ? parsed.recovered : [],
      };
    } catch (err) {
      throw new Error(
        `held spawns: ${path} cannot be read (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  const write = (): void => {
    mkdirSync(runsDir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, path);
  };
  const withIds = (entries: Omit<HeldSpawn, "id">[]): HeldSpawn[] =>
    entries.map((entry) => ({ id: `held-${++file.seq}`, ...entry }));

  const adopting = new Set<string>();
  return {
    list: () => [...file.held],
    get: (id) => file.held.find((held) => held.id === id),
    hold: (entries) => {
      const held = withIds(entries);
      file.held.push(...held);
      write();
      return held;
    },
    remove: (id) => {
      const found = file.held.find((held) => held.id === id);
      if (!found) return null;
      file.held = file.held.filter((held) => held.id !== id);
      adopting.delete(id);
      write();
      return found;
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
    views: () =>
      file.held.map((held) => ({
        id: held.id,
        parentId: held.parentId,
        origin: held.origin,
        kind: held.proposal.kind ?? "ticket",
        title: held.proposal.title,
        body: held.proposal.body,
        blockedBy: held.proposal.blockedBy ?? [],
        blocks: held.proposal.blocks ?? null,
        reason: held.reason,
        at: held.at,
        adopting: adopting.has(held.id),
      })),
  };
}
