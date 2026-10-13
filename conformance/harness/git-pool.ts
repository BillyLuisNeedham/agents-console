/**
 * The git side of a world, read from outside the server: where a pool keeps
 * its Ticket worktrees and branches, what git has registered, and the waits
 * the merge cases share (the snapshot, the pool log, the Review gate).
 *
 * A pool's worktrees and branches are keyed by its checkout (ADR-0036's
 * worktree-key gap): the first eight hex characters of the sha256 of the
 * checkout root's real path, the directory `git rev-parse --show-toplevel`
 * names for the pool. Ticket 01's worktree is
 * `<git common dir>/pool-worktrees/<key>/01`, on branch `pool/<key>/01`.
 * Both servers must compute the same key, or a pool run on one and resumed
 * on the other loses its worktrees.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { EnrichedSnapshot, EnrichedTicketState } from "../../protocol/wire.ts";
import type { CaseServer } from "./case.ts";
import { until } from "./pool-files.ts";

/** A pool's worktree key, from its checkout root as spelled anywhere. */
export function poolKey(checkout: string): string {
  return createHash("sha256").update(realpathSync(checkout)).digest("hex").slice(0, 8);
}

/** Run git in `cwd`; stdout, or a throw naming the command and its stderr. */
export function gitIn(cwd: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${run.stderr.toString()}`);
  }
  return run.stdout.toString();
}

/** Run git in `cwd` and say only whether it succeeded. */
export function gitOk(cwd: string, args: string[]): boolean {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/** The repository's common git directory, absolute and real. */
export function gitCommonDir(checkout: string): string {
  const dir = gitIn(checkout, ["rev-parse", "--git-common-dir"]).trim();
  return realpathSync(isAbsolute(dir) ? dir : resolve(checkout, dir));
}

/** Where a pool keeps Ticket `id`'s worktree, and the branch on it. */
export function ticketWorktree(checkout: string, id: string): { path: string; branch: string; key: string } {
  const key = poolKey(checkout);
  return { path: join(gitCommonDir(checkout), "pool-worktrees", key, id), branch: `pool/${key}/${id}`, key };
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  head: string;
  /** The checked-out branch without `refs/heads/`, or null when detached. */
  branch: string | null;
}

export function worktreeList(checkout: string): WorktreeEntry[] {
  return gitIn(checkout, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (name: string) =>
        block.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
      const branch = field("branch");
      return {
        path: field("worktree") ?? "",
        head: field("HEAD") ?? "",
        branch: branch === null ? null : branch.replace(/^refs\/heads\//, ""),
      };
    });
}

/**
 * Every branch under `prefix`, a whole path of components (`pool` or
 * `pool/<key>`), at any depth: for-each-ref's `*` stops at a slash, so
 * `pool/*` would never reach `pool/<key>/<id>`. A trailing `/*` is read as
 * the prefix it means.
 */
export function branches(checkout: string, prefix = ""): string[] {
  const under = prefix.replace(/\/?\*$/, "");
  return gitIn(checkout, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${under}`])
    .split("\n")
    .filter((line) => line !== "");
}

/** Commit every change in `cwd` with a message; the new HEAD. */
export function commitAll(cwd: string, message: string): string {
  gitIn(cwd, ["add", "-A"]);
  gitIn(cwd, ["commit", "-qm", message]);
  return gitIn(cwd, ["rev-parse", "HEAD"]).trim();
}

/** GET /api/state's snapshot; throws while the server has none yet. */
export async function stateOf(server: CaseServer): Promise<EnrichedSnapshot> {
  const answer = await server.http.get("/api/state");
  if (answer.status !== 200) throw new Error(`GET /api/state answered ${answer.status}: ${answer.text}`);
  const snapshot = answer.json<{ snapshot: EnrichedSnapshot | null }>().snapshot;
  if (snapshot === null) throw new Error("GET /api/state has no snapshot yet");
  return snapshot;
}

/** One Ticket's card in a snapshot; throws when the snapshot has none. */
export function cardOf(snapshot: EnrichedSnapshot, id: string): EnrichedTicketState {
  const card = snapshot.state.tickets.find((ticket) => ticket.id === id);
  if (!card) throw new Error(`the snapshot has no Ticket ${id}`);
  return card;
}

/** Poll /api/state until `done` holds of it. */
export function untilState(
  server: CaseServer,
  done: (snapshot: EnrichedSnapshot) => boolean,
  options: { ms?: number; what?: string } = {},
): Promise<EnrichedSnapshot> {
  return until(() => stateOf(server), done, options);
}

/** The pool log as GET /api/pool-log serves it: its last 2,000 lines, one per entry. */
export async function poolLog(server: CaseServer): Promise<string[]> {
  const answer = await server.http.get(`/api/pool-log?before=${Number.MAX_SAFE_INTEGER}&limit=2000`);
  if (answer.status !== 200) throw new Error(`GET /api/pool-log answered ${answer.status}: ${answer.text}`);
  return answer.json<{ lines: string[] }>().lines;
}

/** Poll the pool log until a line contains `text`; every line read. */
export function untilLogged(
  server: CaseServer,
  text: string,
  options: { ms?: number } = {},
): Promise<string[]> {
  return until(() => poolLog(server), (lines) => lines.some((line) => line.includes(text)), {
    ms: options.ms ?? 10_000,
    what: `a pool log line containing ${JSON.stringify(text)}`,
  });
}

/** Wait for the final Review gate, then approve it through POST /api/resume. */
export async function approveReview(server: CaseServer, options: { ms?: number } = {}): Promise<void> {
  await untilState(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), {
    ms: options.ms ?? 20_000,
    what: "the Review gate",
  });
  const answer = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
  if (answer.status !== 202) throw new Error(`approving Review answered ${answer.status}: ${answer.text}`);
}

/** POST /api/resume for a Ticket, failing unless it is accepted. */
export async function resume(
  server: CaseServer,
  ticketId: string,
  body: { action?: string; note?: string } = {},
): Promise<void> {
  const answer = await server.http.post("/api/resume", { ticketId, ...body });
  if (answer.status !== 202) throw new Error(`resuming ${ticketId} answered ${answer.status}: ${answer.text}`);
}
