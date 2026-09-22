/**
 * Boot's detection pass (issue #121): everything the script can read rather
 * than ask. The skill's step 1 asked the operator to confirm a ten item
 * brief; a script has no reason to, so detection here only feeds the
 * prefills and the printed summary.
 *
 * The parsing is kept apart from the lookups so the interesting part, which
 * is the commit prefix, is testable without a repository.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { countTickets } from "./boot-pool.ts";
import { DEFAULT_PORT } from "./ports.ts";

/** The harnesses the engine has spawn descriptors for (engine/spawn.ts). */
export const KNOWN_HARNESSES = ["claude", "opencode", "cursor"] as const;

export interface Detection {
  /** Ticket files in `issues/`. */
  tickets: number;
  /** A `conversations/` directory, the Seeded Pool opt-in (ADR-0024). */
  conversations: boolean;
  /** Markdown beside `issues/` that is pool context rather than engine prose. */
  contextFiles: string[];
  /** The commit prefix this repository writes, when it writes one. */
  commitPrefix: string | null;
  /** Which of the known harnesses answer on PATH. */
  harnesses: string[];
  /** herdr's binary and its daemon socket, which Enlist and tabs both need. */
  herdr: { binary: boolean; socket: boolean };
  /** Whether 8787 is free, which decides what the port question recommends. */
  defaultPortFree: boolean;
  /** The agent-console checkout the server runs from. */
  engineDir: string;
}

/** The two prose files the template owns, which are never pool context. */
const ENGINE_FILES = new Set(["AGENT.md", "verify.md"]);

/** Markdown sitting in the pool directory itself, which agents read as context. */
export function contextFilesIn(poolDir: string): string[] {
  if (!existsSync(poolDir)) return [];
  let names: string[];
  try {
    names = readdirSync(poolDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && !ENGINE_FILES.has(name))
    .filter((name) => {
      try {
        return statSync(join(poolDir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The commit prefix a repository writes, read off its recent subjects. A
 * prefix only counts when it is the shape `word:` at the head of the
 * subject, and the most common one wins outright: a repository that writes
 * no prefixes, or a different one every time, answers null and the template
 * keeps its placeholder rather than inventing a convention.
 */
export function commonCommitPrefix(subjects: string[]): string | null {
  const counts = new Map<string, number>();
  for (const subject of subjects) {
    const match = /^([a-z][a-z0-9-]*)(\([^)]*\))?!?:\s/.exec(subject.trim());
    if (!match) continue;
    const prefix = match[1] as string;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix;
      bestCount = count;
    }
  }
  return best;
}

/** Whether a command answers on PATH, asked the way a shell would. */
export function onPath(command: string): boolean {
  const probe = Bun.spawnSync({
    cmd: ["sh", "-c", `command -v ${command}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

/** Whether a TCP port can be bound right now on the loopback interface. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

export interface DetectOptions {
  poolDir: string;
  /** The checkout the pool's Attempts branch from, for the commit prefix. */
  repoDir: string;
  /** The agent-console checkout, already resolved by the caller. */
  engineDir: string;
  home?: string;
}

export async function detect(options: DetectOptions): Promise<Detection> {
  const home = options.home ?? homedir();
  return {
    tickets: countTickets(options.poolDir),
    conversations: existsSync(join(options.poolDir, "conversations")),
    contextFiles: contextFilesIn(options.poolDir),
    commitPrefix: commonCommitPrefix(recentSubjects(options.repoDir)),
    harnesses: KNOWN_HARNESSES.filter((name) => onPath(name)),
    herdr: {
      binary: onPath("herdr"),
      socket: existsSync(join(home, ".config", "herdr", "herdr.sock")),
    },
    defaultPortFree: await portIsFree(DEFAULT_PORT),
    engineDir: options.engineDir,
  };
}

/** The last twenty commit subjects, or nothing when this is not a checkout. */
function recentSubjects(repoDir: string): string[] {
  if (!existsSync(repoDir)) return [];
  const probe = Bun.spawnSync({
    cmd: ["git", "-C", repoDir, "log", "-20", "--format=%s"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (probe.exitCode !== 0) return [];
  return probe.stdout.toString().split("\n").filter((line) => line.trim() !== "");
}
