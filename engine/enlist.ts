/**
 * Enlist discovery (issue #101): the engine's judgement of which live herdr
 * panes can become Pool citizens. The Console never talks to herdr; the pool
 * server reads `agent.list` through this module on request and answers with
 * the panes response declared here, the one wire shape both sides share
 * (re-exported by wire.ts). The pane list is ephemeral, so it rides no
 * snapshot and is fetched when the picker opens.
 *
 * A pane is enlistable when its harness is one the engine has a descriptor
 * for, its directory is a checkout of the pool's repository (it shares the
 * pool's git common dir, so a worktree or the main checkout both qualify),
 * and no live attempt or Conversation already holds its pane id. Ineligible
 * panes are returned with the reason, never dropped: the operator learns why
 * rather than wondering whether the list is broken.
 *
 * herdr reports a directory, not a branch, so the engine resolves the branch
 * itself with git in the pane's directory.
 */

import { realpathSync } from "node:fs";
import { git, gitCommonDir } from "./worktrees.ts";
import { listAgents, type HerdrAgent } from "./herdr.ts";
import { defaultHarnessDescriptors } from "./spawn.ts";

/** One live herdr pane, as the picker lists it. */
export interface EnlistPane {
  paneId: string;
  /** herdr's agent label: the harness, or null when none is bound. */
  harness: string | null;
  /** herdr's agent status: idle, working, blocked, done or unknown. */
  status: string;
  /** The pane's terminal title. */
  title: string;
  /** The pane's working directory, or null when herdr reports none. */
  directory: string | null;
  /** The branch checked out in `directory`, resolved by the engine; null
   *  when the directory is not a checkout. */
  branch: string | null;
  eligible: boolean;
  /** Why the pane cannot be enlisted; null when it can. */
  reason: string | null;
}

/** The panes response envelope: every pane `agent.list` reports, eligible or
 *  not, with the reason beside the ineligible ones. */
export interface PanesResponse {
  panes: EnlistPane[];
}

/**
 * The enlist request body (issue #101), declared once here so the server
 * route and the Console type-import the same shape. `becomes` is fixed at
 * enlist time, and one of the two arms is chosen from it. The engine
 * re-judges the pane at submit rather than
 * trusting a picker read that may be stale. The branch is never on the wire:
 * the engine resolves the found directory's branch with git and applies the
 * branch rule itself.
 */
export interface EnlistTicketRequest {
  becomes: "ticket";
  paneId: string;
  title: string;
  spec: string;
  /** The unfinished tickets that must wait on the enlisted one. */
  blocks?: string[];
}

export interface EnlistConversationWireRequest {
  becomes: "conversation";
  paneId: string;
  title: string;
  /** The optional first Turn, typed after the teaching Turn. */
  opening?: string;
}

export type EnlistRequest =
  | EnlistTicketRequest
  | EnlistConversationWireRequest;

/** The enlist answer: the minted id, a 201 on success. */
export type EnlistResponse =
  | { ticketId: string }
  | { conversationId: string };

/** One live pane resolved and judged for enlist: the found facts the engine
 *  records, with eligibility already decided. */
export interface FoundPane {
  paneId: string;
  tabId: string | null;
  harness: string;
  sessionId: string | null;
  title: string;
  directory: string;
  branch: string;
}

export interface FindEnlistablePaneOptions {
  socketPath: string;
  poolDir: string;
  paneId: string;
  registeredPanes: ReadonlySet<string>;
}

/**
 * Resolve one pane the operator picked and judge it again at submit time
 * (issue #101): herdr's list is read afresh because the picker's answer is
 * ephemeral. An absent pane, one already held by a live attempt or
 * Conversation, one outside the pool's repository, one with no known harness,
 * and one whose directory has no branch are all a reason, never a thrown
 * error: the route turns the reason into its 409.
 */
export async function findEnlistablePane(
  options: FindEnlistablePaneOptions,
): Promise<{ ok: true; pane: FoundPane } | { ok: false; reason: string }> {
  const agents = await listAgents(options.socketPath);
  const agent = agents.find((candidate) => candidate.paneId === options.paneId);
  if (!agent) {
    return { ok: false, reason: `pane ${options.paneId} is gone` };
  }
  const poolCommonDir = canonical(gitCommonDir(options.poolDir));
  const verdict = eligibilityOf(agent, poolCommonDir, options.registeredPanes);
  if (!verdict.eligible) {
    return { ok: false, reason: verdict.reason ?? "pane cannot be enlisted" };
  }
  if (agent.directory === null || agent.harness === null) {
    return { ok: false, reason: ENLIST_REASONS.notACheckout };
  }
  const branch = branchAt(agent.directory);
  if (branch === null) {
    return {
      ok: false,
      reason: "the pane's directory has no branch checked out",
    };
  }
  return {
    ok: true,
    pane: {
      paneId: agent.paneId,
      tabId: agent.tabId,
      harness: agent.harness,
      sessionId: agent.sessionId,
      title: agent.title,
      directory: agent.directory,
      branch,
    },
  };
}

export interface ListEnlistPanesOptions {
  socketPath: string;
  /** The pool directory: any path inside the pool's repository is enough. */
  poolDir: string;
  /** The pane ids a live attempt or a live Conversation already holds. */
  registeredPanes: ReadonlySet<string>;
}

/** The reasons a pane cannot be enlisted (issue #101). */
export const ENLIST_REASONS = {
  alreadyInPool: "already in the pool",
  notACheckout: "not a checkout of this pool's repository",
  unknownHarness: "no harness the engine knows",
} as const;

/** A path as git resolves it, so two spellings of one repo compare equal. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether `directory` is a checkout of the pool's repository: it shares the
 *  pool's git common dir. A directory that is not a checkout at all resolves
 *  its own fallback common dir and never matches. */
function sharesPoolRepository(directory: string, poolCommonDir: string): boolean {
  return canonical(gitCommonDir(directory)) === poolCommonDir;
}

/** The branch checked out in `directory`, resolved with git; null when the
 *  directory is not a checkout or HEAD is detached. */
function branchAt(directory: string): string | null {
  const probe = git(directory, ["branch", "--show-current"]);
  return probe.ok && probe.out ? probe.out : null;
}

function eligibilityOf(
  agent: HerdrAgent,
  poolCommonDir: string,
  registeredPanes: ReadonlySet<string>,
): { eligible: boolean; reason: string | null } {
  // Ownership first: a pane the engine already holds is in the pool whatever
  // else is true of it, including a harness the pool registered by hand.
  if (registeredPanes.has(agent.paneId)) {
    return { eligible: false, reason: ENLIST_REASONS.alreadyInPool };
  }
  if (
    agent.directory === null ||
    !sharesPoolRepository(agent.directory, poolCommonDir)
  ) {
    return { eligible: false, reason: ENLIST_REASONS.notACheckout };
  }
  if (
    agent.harness === null ||
    defaultHarnessDescriptors[agent.harness.toLowerCase()] === undefined
  ) {
    return { eligible: false, reason: ENLIST_REASONS.unknownHarness };
  }
  return { eligible: true, reason: null };
}

/**
 * Every pane herdr reports, with the engine's verdict beside it. The pool's
 * common dir is resolved once for the whole listing; the branch is resolved
 * per pane in its own directory.
 */
export async function listEnlistPanes(
  options: ListEnlistPanesOptions,
): Promise<PanesResponse> {
  const agents = await listAgents(options.socketPath);
  const poolCommonDir = canonical(gitCommonDir(options.poolDir));
  return {
    panes: agents.map((agent) => {
      const { eligible, reason } = eligibilityOf(
        agent,
        poolCommonDir,
        options.registeredPanes,
      );
      return {
        paneId: agent.paneId,
        harness: agent.harness,
        status: agent.status,
        title: agent.title,
        directory: agent.directory,
        branch: agent.directory === null ? null : branchAt(agent.directory),
        eligible,
        reason,
      };
    }),
  };
}
