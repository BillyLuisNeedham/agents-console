// Folder trust for claude (issue #127, ADR-0025): the engine vouches for the
// directories it makes, so an interactive claude never meets its workspace
// trust dialog in a pool worktree.
//
// claude keeps a per-directory record of the operator having accepted that
// dialog, `projects[<absolute path>].hasTrustDialogAccepted` in
// `~/.claude.json`, and skips the dialog when it is true. Every pool
// worktree is a directory claude has never seen, so without a seed every
// terminal-backed claude Attempt starts on the dialog, inside the readiness
// wait's budget. Seeding removes the dialog rather than racing it; claude's
// own error text names this file and key as the way to trust a folder
// without sitting at the dialog, and Anthropic's self-hosted runner seeds
// the same key for its sessions' checkouts.
//
// The write is add-only and mirrors claude's own: the whole file re-read,
// the one entry set, the result written to a sibling temp file and renamed
// over the original (claude writes `.claude.json.tmp.<pid>.<hex>` the same
// way). Two-space indent and no trailing newline match claude's output so a
// diff of the file shows only the entry. Every claude session on the machine
// rewrites the file from its own copy, so a seed can in principle be lost to
// a session that read the file before the seed and wrote after; the pane's
// dialog handler (pane-session.ts) remains behind the seed for that case.
// Nothing is ever removed: claude does not prune the map itself, a stale
// entry for a directory that no longer exists is inert, and deleting from
// another tool's config is a larger act than adding to it.

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Where claude keeps its per-machine state, the file the seed lands in:
 * `.claude.json` under CLAUDE_CONFIG_DIR when that is set, as claude itself
 * resolves it (confirmed on 2.1.276), else under the home directory.
 */
export function defaultClaudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir ? configDir : homedir(), ".claude.json");
}

export type FolderTrustSeed =
  /** The entry was written for these paths (the path and, when it differs, its realpath). */
  | { outcome: "seeded"; paths: string[] }
  /** claude already trusted the directory; the file was not touched. */
  | { outcome: "already" }
  /** The file could not be seeded; `reason` says why, for the pool log. */
  | { outcome: "skipped"; reason: string };

// claude's own default entry for a directory it has just seen (read from
// the 2.1.276 binary); the seed adds the trust flag to it so a fresh entry
// looks the way claude would have written it.
function freshProjectEntry(): Record<string, unknown> {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

/**
 * Mark `cwd` as trusted in claude's config so an interactive claude started
 * there skips its workspace trust dialog. claude keys the map by its
 * process's cwd, which the kernel has already resolved, so when the path
 * and its realpath differ both are seeded. A missing file (claude has never
 * run on this machine) or one that does not parse is left alone: a seed is
 * never worth corrupting the operator's config, and the dialog handler
 * covers the launch.
 */
export function seedClaudeFolderTrust(
  cwd: string,
  configPath: string = defaultClaudeConfigPath(),
): FolderTrustSeed {
  if (!existsSync(configPath)) {
    return { outcome: "skipped", reason: `${configPath} does not exist` };
  }
  // A dotfile-managed config is often a symlink; the rename below must land
  // on the file it points at, not replace the link with a plain file.
  try {
    configPath = realpathSync(configPath);
  } catch {
    // Unreadable link target: the write below reports it.
  }
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { outcome: "skipped", reason: `${configPath} is not a JSON object` };
    }
    config = parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "skipped", reason: `${configPath} did not parse: ${message}` };
  }
  const projects =
    config.projects !== null && typeof config.projects === "object" && !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : {};
  const paths = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) paths.push(real);
  } catch {
    // The directory is not there yet: seed the path as given.
  }
  const untrusted = paths.filter((path) => !isTrusted(projects[path]));
  if (untrusted.length === 0) return { outcome: "already" };
  for (const path of untrusted) {
    const existing = projects[path];
    projects[path] =
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>), hasTrustDialogAccepted: true }
        : freshProjectEntry();
  }
  config.projects = projects;
  const tempPath = `${configPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tempPath, JSON.stringify(config, null, 2));
    renameSync(tempPath, configPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Never written, or already gone.
    }
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "skipped", reason: `${configPath} could not be written: ${message}` };
  }
  return { outcome: "seeded", paths: untrusted };
}

function isTrusted(entry: unknown): boolean {
  return (
    entry !== null &&
    typeof entry === "object" &&
    (entry as Record<string, unknown>).hasTrustDialogAccepted === true
  );
}
