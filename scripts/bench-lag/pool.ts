/**
 * The throwaway pool the lag bench drives: a git project in a temp dir with
 * the pool where the operator keeps one (`.scratch/<name>`), its Tickets
 * shaped so a few seconds of real engine work leave it in the state the
 * Console is usually looked at in:
 *
 * - 12 Tickets that finish fast. Eight commit a file of their own and merge
 *   cleanly; four all rewrite the same line of `shared.txt`, so the first to
 *   exit merges and the other three stop on merge-conflict interrupts with no
 *   resolver to take them. Those three stand in the Merge hold, which keeps
 *   the hold's re-derivation (git per done Ticket) running for the whole
 *   measurement, the way an operator's merge queue does.
 * - 4 Tickets that stay in progress: their harness keeps editing a tracked
 *   file and dropping untracked ones in its worktree, and printing to its log,
 *   until the bench ends, so activity, peek and log reads all have live work.
 * - 4 Tickets blocked behind those, waiting.
 *
 * Nothing here is the engine's: the engine makes the worktrees, branches,
 * events and logs itself, from the harness script below, so the files the
 * server reads are the ones a real run writes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BenchPool {
  /** The git project the pool lives in. */
  repoDir: string;
  poolDir: string;
  /** The harness script every Ticket attempt runs (`bash <script> ...`). */
  harnessScript: string;
  /** Created to let every live harness loop finish. */
  releaseFile: string;
  /** Ticket ids by the role they play. */
  quick: string[];
  conflicting: string[];
  live: string[];
  blocked: string[];
}

const QUICK = 8;
const CONFLICTING = 4;
const LIVE = 4;
const BLOCKED = 4;
/** Source files in the project, so git's status and diff walk a real tree. */
const SOURCE_FILES = 400;

function git(cwd: string, args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  }
}

/** A paragraph of prose, so issue bodies and source files have real size. */
function prose(seed: number, lines: number): string {
  const words = [
    "pool", "ticket", "merge", "attempt", "canvas", "render", "snapshot", "stream",
    "worktree", "branch", "operator", "detail", "card", "engine", "herdr", "pane",
  ];
  return Array.from({ length: lines }, (_, i) =>
    Array.from({ length: 12 }, (_, j) => words[(seed * 7 + i * 3 + j * 5) % words.length]).join(" "),
  ).join("\n");
}

function issue(id: string, blockedBy: string[], title: string, seed: number): string {
  const marker = `<!-- state: id=${id} blocked-by=${blockedBy.length ? blockedBy.join(",") : "none"} status=ready -->`;
  return [
    marker,
    "",
    `# ${title}`,
    "",
    "## What to build",
    "",
    prose(seed, 25),
    "",
    "## Acceptance criteria",
    "",
    ...Array.from({ length: 6 }, (_, i) => `- [ ] criterion ${i + 1}: ${prose(seed + i, 1)}`),
    "",
  ].join("\n");
}

/**
 * The harness every Ticket runs, by mode. `quick` and `conflict` commit and
 * report done at once; `live` works until the release file appears. Output
 * lines stand in for an agent's transcript so the attempt log has size.
 */
const HARNESS = `#!/usr/bin/env bash
set -uo pipefail
mode="$1"; id="$2"; outcome="$3"; release="$4"
talk() { for i in $(seq 1 "$1"); do echo "[$id] step $i: reading files, editing, running the suite"; done; }
case "$mode" in
  quick)
    talk 150
    mkdir -p src/tickets
    seq 1 200 | sed "s/^/$id line /" > "src/tickets/$id.txt"
    git add -A && git commit -qm "$id: the work"
    printf '{"status":"done","summary":"%s finished","commitSha":"%s"}' "$id" "$(git rev-parse HEAD)" > "$outcome"
    ;;
  conflict)
    talk 150
    printf '%s owns this line now\\n' "$id" > shared.txt
    git add -A && git commit -qm "$id: rewrite shared"
    printf '{"status":"done","summary":"%s finished","commitSha":"%s"}' "$id" "$(git rev-parse HEAD)" > "$outcome"
    ;;
  live)
    mkdir -p src/live
    n=0
    # The bench removes its whole root when it ends, release file and all,
    # so a vanished root releases too.
    while [ ! -e "$release" ] && [ -d "$(dirname "$release")" ]; do
      n=$((n + 1))
      # A tracked file that keeps changing, and untracked notes piling up:
      # what git status and diff --numstat see in a working agent's tree.
      seq 1 $((n * 3)) | sed "s/^/$id edit /" >> "src/module-$((n % 5)).ts"
      [ "$n" -le 12 ] && echo "note $n" > "src/live/$id-note-$n.md"
      talk 5
      sleep 1.5
    done
    printf '{"status":"done","summary":"%s released","commitSha":null}' "$id" > "$outcome"
    ;;
esac
exit 0
`;

export function buildPool(root: string): BenchPool {
  const repoDir = join(root, "project");
  const poolDir = join(repoDir, ".scratch", "bench");
  mkdirSync(join(poolDir, "issues"), { recursive: true });

  // The project: a source tree of some size, and the line the conflicting
  // Tickets fight over.
  for (let i = 0; i < SOURCE_FILES; i++) {
    const dir = join(repoDir, "src", `pkg-${i % 20}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${i}.ts`), `// file ${i}\n${prose(i, 60)}\n`);
  }
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(repoDir, "src", `module-${i}.ts`), `export const m${i} = ${i};\n`);
  }
  writeFileSync(join(repoDir, "shared.txt"), "nobody owns this line yet\n");
  writeFileSync(join(repoDir, ".gitignore"), ".scratch/\n");

  const pad = (n: number) => String(n).padStart(2, "0");
  const quick = Array.from({ length: QUICK }, (_, i) => pad(i + 1));
  const conflicting = Array.from({ length: CONFLICTING }, (_, i) => pad(QUICK + i + 1));
  const live = Array.from({ length: LIVE }, (_, i) => pad(QUICK + CONFLICTING + i + 1));
  const blocked = Array.from({ length: BLOCKED }, (_, i) => pad(QUICK + CONFLICTING + LIVE + i + 1));
  const write = (id: string, blockedBy: string[], title: string, seed: number) =>
    writeFileSync(join(poolDir, "issues", `${id}-ticket.md`), issue(id, blockedBy, title, seed));
  quick.forEach((id, i) => write(id, [], `Quick change ${id}`, i));
  conflicting.forEach((id, i) => write(id, [], `Rewrite the shared line ${id}`, 20 + i));
  live.forEach((id, i) => write(id, [], `Long running work ${id}`, 40 + i));
  blocked.forEach((id, i) => write(id, [live[i % live.length]!], `Follow-up to ${live[i % live.length]}`, 60 + i));

  const harnessScript = join(poolDir, "bench-harness.sh");
  writeFileSync(harnessScript, HARNESS, { mode: 0o755 });
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify(
      {
        defaults: { harness: "bench", model: "m" },
        // No resolver: a conflicted merge stops on an interrupt and stays held.
        resolver: "none",
        terminal: "herdr",
        title: "lag bench",
      },
      null,
      2,
    ),
  );

  git(repoDir, ["init", "-q", "-b", "main"]);
  git(repoDir, ["config", "user.email", "bench@lag"]);
  git(repoDir, ["config", "user.name", "bench"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-qm", "init"]);

  return {
    repoDir,
    poolDir,
    harnessScript,
    releaseFile: join(root, "release"),
    quick,
    conflicting,
    live,
    blocked,
  };
}

/** The mode a Ticket's harness runs in. */
export function modeFor(pool: BenchPool, id: string): "quick" | "conflict" | "live" {
  if (pool.conflicting.includes(id)) return "conflict";
  if (pool.live.includes(id)) return "live";
  return "quick";
}
