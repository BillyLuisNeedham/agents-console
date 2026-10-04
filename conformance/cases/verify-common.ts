/**
 * What the verify cases (C21 of the Rust port's inventory) share: the pool
 * they start from, and readers for the git facts a fan-out leaves behind.
 * Every Attempt and judge runs as the claude stub on PATH; no case sets
 * TYPESAFE_API_KEY, so grading goes through grader Tickets.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig, TicketEvent } from "../../engine/wire.ts";
import type { TicketSeed, World } from "../harness/world.ts";
import { readEvents } from "../harness/pool-files.ts";

/** The pool's defaults: every launch is the claude stub. */
export const DEFAULTS: PoolConfig = { defaults: { harness: "claude", model: "m" } };

/** console.json with `verify` on Ticket 01, and anything else given. */
export function verifyConfig(n: number, extra: PoolConfig = {}): PoolConfig {
  return { ...DEFAULTS, ...extra, assign: { "01": { verify: n }, ...(extra.assign ?? {}) } };
}

/** A ready Ticket, `<id>-t.md`. */
export function ready(id: string, blockedBy = "none"): TicketSeed {
  return { file: `${id}-t.md`, marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->` };
}

/** Whether a branch exists in the world's repository. */
export function branchExists(world: World, branch: string): boolean {
  try {
    world.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Every pool attempt branch in the repository, sorted. */
export function attemptBranches(world: World): string[] {
  return world
    .git(["for-each-ref", "--format=%(refname:short)", "refs/heads/pool/"])
    .split("\n")
    .filter((line) => line !== "")
    .sort();
}

/**
 * The branch an attempt ran on, as its spawned event records it: the
 * worktree key is the server's to compute, so a case reads it back rather
 * than restating the hash.
 */
export function attemptBranch(world: World, id: string, attempt: number): string {
  const spawned = readEvents(world.pool, id).find((e) => e.kind === "spawned" && e.attempt === attempt);
  const branch = spawned?.payload.branch;
  if (typeof branch !== "string") throw new Error(`${id} attempt ${attempt} has no spawned event naming a branch`);
  return branch;
}

/** The worktree an attempt ran in, as its spawned event records it. */
export function attemptCwd(world: World, id: string, attempt: number): string {
  const spawned = readEvents(world.pool, id).find((e) => e.kind === "spawned" && e.attempt === attempt);
  const cwd = spawned?.payload.cwd;
  if (typeof cwd !== "string") throw new Error(`${id} attempt ${attempt} has no spawned event naming a cwd`);
  return cwd;
}

/** A Ticket's event kinds for one attempt, in order. */
export function kindsOf(events: TicketEvent[], attempt: number): string[] {
  return events.filter((e) => e.attempt === attempt).map((e) => e.kind);
}

/** Whether a file is in the checkout, merged work say. */
export function inCheckout(world: World, file: string): boolean {
  return existsSync(join(world.repo, file));
}

/** A pool file's text, by path relative to the pool. */
export function poolText(world: World, path: string): string {
  return readFileSync(join(world.pool, path), "utf8");
}

/** The prompt a stub launch carried: the argv entry naming its outcome file. */
export function promptOf(argv: string[]): string {
  const prompt = argv.find((arg) => arg.includes("outcome as JSON at "));
  if (prompt === undefined) throw new Error(`no prompt in argv ${JSON.stringify(argv).slice(0, 300)}`);
  return prompt;
}
