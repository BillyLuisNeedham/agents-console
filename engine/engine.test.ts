import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  PERSISTENCE_TICKET_ID,
  REVIEW_TICKET_ID,
  engineSpawnSet,
  interactiveWrapper,
  resolveAssignment,
  runPool,
  startPool,
  validateOutcome,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
} from "./engine.ts";
import { SqliteCheckpointStore, type CheckpointStore } from "./checkpoints.ts";
import { appendEvent } from "./events.ts";
import {
  loadPoolMarkers,
  type TicketMarker,
  type TicketStatus,
} from "./pool.ts";
import { branchFor, worktreePathFor } from "./worktrees.ts";
import { QueuedAnswerStore } from "./queued-answers.ts";
import { processIsLive } from "./children.ts";
import {
  defaultHarnessDescriptors,
  type SpawnContext,
} from "./spawn.ts";

const tempDirs: string[] = [];

// The `script` invocation ADR-0016's wrapper opens with, in the form the
// host's script(1) accepts (issue #58): util-linux's `-c` string form on
// Linux, BSD's file-then-words form on macOS. The fake herdr runs the
// wrapper under the host's real script, so the suite runs on both.
const SCRIPT_RECORD_PREFIX =
  process.platform === "darwin" ? "script -eqF " : "script -eqfc ";

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface PoolSpec {
  tickets: { file: string; marker: string; body?: string }[];
  config?: PoolConfig;
  agentMd?: string;
}

function makePool(spec: PoolSpec): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of spec.tickets) {
    writeFileSync(
      join(poolDir, "issues", ticket.file),
      `${ticket.marker}\n\n${ticket.body ?? "# body"}\n`,
    );
  }
  if (spec.config) {
    writeFileSync(
      join(poolDir, "console.json"),
      JSON.stringify(spec.config, null, 2),
    );
  }
  if (spec.agentMd) {
    writeFileSync(join(poolDir, "AGENT.md"), spec.agentMd);
  }
  return poolDir;
}

// The fake agent contract (ADR-0005): the stub signals its ending through the
// outcome JSON it writes, never by editing the Issue marker. "done" and
// "checkpoint" land in the outcome's status field; "keep" writes no outcome
// (crash material); "ready" and "marker-done" sed the marker without writing
// an outcome, the old protocol's misbehaviours the clean break must ignore.
interface StubBehaviour {
  status?: "done" | "checkpoint" | "ready" | "keep" | "marker-done";
  statuses?: ("done" | "checkpoint" | "ready" | "keep" | "marker-done")[];
  outcome?: { summary: string; commitSha: string | null } | null;
  outcomeRaw?: string;
  brief?: string;
  spawn?: unknown;
  grade?: { score: number; verdict: "pass" | "flag"; reasons: string };
  winner?: number | string;
  exitCode?: number;
  exitCodes?: number[];
}

interface StubRig {
  harnesses: Record<string, HarnessCommand>;
  spawned: Record<string, SpawnContext>;
  spawnOrder: string[];
  // Every spawn context in spawn order, attempts included: a verify fan-out
  // spawns one ticket id several times, which the keyed map cannot hold.
  spawnList: SpawnContext[];
}

function stubHarness(behaviour: Record<string, StubBehaviour>): StubRig {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"; outcome_path="$3"; outcome_json="$4"; exit_code="$5"',
      'if [ "$status" = "ready" ] || [ "$status" = "marker-done" ]; then',
      '  sed -i "1s/status=[a-z-]*/status=${status#marker-}/" "$issue"',
      "fi",
      'if [ -n "$outcome_json" ]; then',
      '  printf \'%s\' "$outcome_json" > "$outcome_path"',
      "fi",
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  const spawned: Record<string, SpawnContext> = {};
  const spawnOrder: string[] = [];
  const spawnList: SpawnContext[] = [];
  const spawnCounts: Record<string, number> = {};
  const stub: HarnessCommand = (ctx) => {
    spawned[ctx.id] = ctx;
    spawnOrder.push(ctx.id);
    spawnList.push(ctx);
    const n = spawnCounts[ctx.id] ?? 0;
    spawnCounts[ctx.id] = n + 1;
    // A grader id the engine wrote gets a default passing grade, so tests
    // that do not care about grading still flow through it.
    const b = behaviour[ctx.id] ??
      (/-grader-\d+$/.test(ctx.id)
        ? { grade: { score: 8, verdict: "pass", reasons: "default grade" } }
        : {});
    const status = b.statuses
      ? b.statuses[Math.min(n, b.statuses.length - 1)]
      : (b.status ?? "done");
    const outcome =
      b.outcomeRaw !== undefined
        ? b.outcomeRaw
        : b.outcome === null || status === "keep" || status === "ready" || status === "marker-done"
          ? ""
          : JSON.stringify({
              status,
              ...(b.outcome ?? {
                summary: `summary-${ctx.id}`,
                commitSha: `sha-${ctx.id}`,
              }),
              ...(b.brief !== undefined ? { brief: b.brief } : {}),
              ...(b.spawn !== undefined ? { spawn: b.spawn } : {}),
              ...(b.grade !== undefined ? { grade: b.grade } : {}),
              ...(b.winner !== undefined ? { winner: b.winner } : {}),
            });
    const exitCode = b.exitCodes
      ? b.exitCodes[Math.min(n, b.exitCodes.length - 1)]
      : (b.exitCode ?? 0);
    return [
      "bash",
      stubPath,
      ctx.issuePath,
      status,
      ctx.outcomePath,
      outcome,
      String(exitCode),
    ];
  };
  return { harnesses: { stub }, spawned, spawnOrder, spawnList };
}

interface FakeHerdrRequest {
  method: string;
  params: Record<string, unknown>;
}

// The fake herdr daemon speaks the real wire shape (newline-delimited
// JSON-RPC, one request per connection) and actually RUNS what a pane is
// sent: the engine's wrapper shell executes under bash in the pane's cwd,
// so the typescript Stream file, the exit-code file, and the harness's
// outcome are all real, exactly as a live herdr would produce them. Pane
// ends are pushed to the engine's events.subscribe connections, the way
// herdr pushes subscribed events. `breakSubscriptions` simulates a daemon
// that cannot keep a subscription (restart mid-wait), for the exit-code
// file fallback. Test-only controls simulate the interactive surface:
// `rendered` supplies the pane.read text every new pane shows (a test sets
// it to a harness's ready frame so the engine's readiness poll passes),
// `setPaneContent` overrides a single pane's rendered text, and
  // `dropPaneInput` drops the next typed inputs after the wrapper (a lost
  // paste) so the engine's echo verification has a failure to retry on.
  // After the wrapper boots, the pane has an input area: paste appends,
  // clear keys empty it, Enter submits it (`submitted` records each
  // submit). `hideInputs` conceals that many pastes from pane.read so a
  // false-negative echo is testable — the text still occupies the input.
  // `wrapWidth` renders the input area the way a real TUI draws it: a
  // bordered box narrower than the pane, every input line hard-wrapped at
  // that width with a border glyph and padding on each row, so a long echo
  // target (an issue path) lands split across rows (the opencode viewport
  // that issue #56 found).
  // The fake executes only the pane's FIRST Enter as bash — the wrapper — and
  // treats every later Enter as the TUI consuming input, matching how a real
  // pane hands control to the harness. By default the pane ends when the
  // wrapper's bash exits, the shorthand the ending tests rely on; a real
  // herdr pane holds a shell, so a wrapper that exits leaves the pane alive
  // at its prompt and no pane end ever fires. `holdPane` models that, for
  // the harness-died-on-launch case (issue #58). Test-only controls
  // simulate the orphans boot reconciliation must handle: a pane with no
  // process behind it, and its later end.
  async function startExecutingFakeHerdr(options?: {
    breakSubscriptions?: boolean;
    rendered?: string;
    dropInputs?: number;
    hideInputs?: number;
    wrapWidth?: number;
    holdPane?: boolean;
  }): Promise<{
    socketPath: string;
    requests: FakeHerdrRequest[];
    submitted: string[];
    close: () => Promise<void>;
    injectPane: (paneId: string) => void;
    endPane: (paneId: string) => void;
    setPaneContent: (paneId: string, text: string) => void;
    dropPaneInput: (paneId: string, count: number) => void;
  }> {
    const breakSubscriptions = options?.breakSubscriptions === true;
    const defaultRendered = options?.rendered ?? "";
    const defaultDropInputs = options?.dropInputs ?? 0;
    const defaultHideInputs = options?.hideInputs ?? 0;
    const wrapWidth = options?.wrapWidth;
    const holdPane = options?.holdPane === true;
    // The input area as pane.read shows it: verbatim, or drawn as a bordered
    // box that wraps each line at `wrapWidth` columns.
    const renderInput = (inputArea: string): string => {
      if (wrapWidth === undefined) return inputArea;
      const rows: string[] = [];
      for (const line of inputArea.split("\n")) {
        for (let i = 0; i < Math.max(line.length, 1); i += wrapWidth) {
          const chunk = line.slice(i, i + wrapWidth);
          rows.push(`  ┃  ${chunk.padEnd(wrapWidth)}  ┃`);
        }
      }
      return `\n${rows.join("\n")}\n`;
    };
    const requests: FakeHerdrRequest[] = [];
    const submitted: string[] = [];
  let minted = 0;
  const panes = new Map<
    string,
    {
      tabId: string;
      cwd: string;
      alive: boolean;
      buffer: string;
      rendered: string;
      booted: boolean;
      dropInputs: number;
      hideInputs: number;
      inputArea: string;
      hideEcho: boolean;
      proc?: ReturnType<typeof Bun.spawn>;
    }
  >();
  const subscribers: Socket[] = [];
  const connections = new Set<Socket>();
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  const firePaneEnd = (
    paneId: string,
    event: "pane_exited" | "pane_closed",
  ): void => {
    const pane = panes.get(paneId);
    if (pane) {
      pane.alive = false;
      pane.proc?.kill();
    }
    broadcast(event, { pane_id: paneId, workspace_id: "w1" });
  };
  // herdr pushes every event to every subscriber; the engine filters. A
  // subscriber whose wait already settled has closed its end, so prune
  // before broadcasting.
  const broadcast = (event: string, data: Record<string, unknown>): void => {
    for (const sub of [...subscribers]) {
      if (sub.destroyed || !sub.writable) {
        subscribers.splice(subscribers.indexOf(sub), 1);
        continue;
      }
      sub.write(JSON.stringify({ event, data: { type: event, ...data } }) + "\n");
    }
  };
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      const msg = JSON.parse(buf.slice(0, buf.indexOf("\n"))) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      requests.push({ method: msg.method, params: msg.params });
      const respond = (result: unknown): void => {
        socket.end(JSON.stringify({ id: msg.id, result }) + "\n");
      };
      if (msg.method === "tab.create") {
        minted += 1;
        const tabId = `tab-${minted}`;
        const paneId = `pane-${minted}`;
        panes.set(paneId, {
          tabId,
          cwd: String(msg.params.cwd ?? "/"),
          alive: true,
          buffer: "",
          rendered: defaultRendered,
          booted: false,
          dropInputs: defaultDropInputs,
          hideInputs: defaultHideInputs,
          inputArea: "",
          hideEcho: false,
        });
        respond({ tab: { tab_id: tabId } });
      } else if (msg.method === "pane.list") {
        respond({
          panes: [...panes.entries()]
            .filter(([, pane]) => pane.alive)
            .map(([paneId, pane]) => ({ tab_id: pane.tabId, pane_id: paneId })),
        });
      } else if (msg.method === "pane.read") {
        const pane = panes.get(String(msg.params.pane_id));
        const visible = pane
          ? pane.booted
            ? pane.hideEcho
              ? pane.rendered
              : `${pane.rendered}${renderInput(pane.inputArea)}`
            : `${pane.rendered}${pane.buffer}`
          : "";
        respond({
          read: {
            text: visible,
            revision: 0,
            truncated: false,
          },
        });
      } else if (msg.method === "pane.send_input") {
        const pane = panes.get(String(msg.params.pane_id));
        if (pane) {
          if (typeof msg.params.text === "string") {
            if (!pane.booted) {
              pane.buffer += msg.params.text;
            } else if (pane.dropInputs > 0) {
              // A lost paste: the text vanishes from the pane, the way a
              // paste sent before the TUI is truly ready can.
              pane.dropInputs -= 1;
            } else {
              pane.inputArea += msg.params.text;
              pane.hideEcho = pane.hideInputs > 0;
              if (pane.hideInputs > 0) pane.hideInputs -= 1;
            }
          }
          if (Array.isArray(msg.params.keys)) {
            if (msg.params.keys.includes("enter")) {
              if (pane.booted) {
                submitted.push(pane.inputArea);
                pane.inputArea = "";
                pane.hideEcho = false;
                respond({});
                return;
              }
              const command = pane.buffer;
              pane.buffer = "";
              pane.booted = true;
              const proc = Bun.spawn(["bash", "-c", command], {
                cwd: pane.cwd,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              });
              pane.proc = proc;
              procs.push(proc);
              void proc.exited.then(() => {
                if (!holdPane) {
                  firePaneEnd(String(msg.params.pane_id), "pane_exited");
                }
              });
            } else if (pane.booted) {
              pane.inputArea = "";
              pane.hideEcho = false;
            }
          }
        }
        respond({});
      } else if (msg.method === "events.subscribe") {
        if (breakSubscriptions) {
          // The daemon drops the subscription before acking: the engine's
          // wait degrades to the exit-code file.
          socket.destroy();
          return;
        }
        // The ack answers this request; the connection then stays open and
        // receives pushed events until close() destroys it or the
        // subscriber's own end closes it (an exited wait releases its
        // socket, and firePaneEnd prunes closed subscribers).
        subscribers.push(socket);
        socket.on("close", () => {
          const at = subscribers.indexOf(socket);
          if (at !== -1) subscribers.splice(at, 1);
        });
        socket.write(
          JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n",
        );
      } else if (msg.method === "pane.close") {
        const paneId = String(msg.params.pane_id ?? "");
        respond({ type: "ok" });
        firePaneEnd(paneId, "pane_closed");
      } else if (msg.method === "tab.close") {
        // A closed tab takes its panes silently (verified herdr 0.8.2,
        // issue #61): they leave the listing and one `tab_closed` goes out,
        // with no `pane_closed` for any of them.
        const tabId = String(msg.params.tab_id ?? "");
        for (const pane of panes.values()) {
          if (pane.tabId !== tabId) continue;
          pane.alive = false;
          pane.proc?.kill();
        }
        respond({ type: "ok" });
        broadcast("tab_closed", { tab_id: tabId, workspace_id: "w1" });
      } else {
        respond({});
      }
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "herdr-fake-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
    submitted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const proc of procs) proc.kill();
        for (const sub of subscribers) sub.destroy();
        // bun's server.close() waits for every connection to drain, and a
        // request/response connection whose client already destroyed its
        // end can linger in a half-closed state that outlives the test.
        // Teardown destroys what is left instead of waiting on it.
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
      }),
    injectPane: (paneId) => {
      panes.set(paneId, {
        tabId: "tab-ghost",
        cwd: "/tmp",
        alive: true,
        buffer: "",
        rendered: defaultRendered,
        booted: true,
        dropInputs: 0,
        hideInputs: 0,
        inputArea: "",
        hideEcho: false,
      });
    },
    endPane: (paneId) => firePaneEnd(paneId, "pane_exited"),
    setPaneContent: (paneId, text) => {
      const pane = panes.get(paneId);
      if (pane) pane.rendered = text;
    },
    dropPaneInput: (paneId, count) => {
      const pane = panes.get(paneId);
      if (pane) pane.dropInputs += count;
    },
  };
}

const stubConfig: PoolConfig = {
  defaults: { harness: "stub", model: "stub-model" },
};

// The manual merge-conflict path without a resolver: explicit resolver="none"
// means no resolver harness, so a conflict takes the manual path directly.
const noResolverConfig: PoolConfig = {
  ...stubConfig,
  resolver: "none",
};

// Every fully-done pool stops at the final Review interrupt; a test that
// wants a finished run approves it through the same answer path the UI uses.
async function approveReview(run: PoolRun): Promise<PoolRun> {
  const review = run.interrupts.find((i) => i.kind === "review");
  expect(review).toBeTruthy();
  return run.approve(review!.ticketId);
}

// The merge hold's pause (ADR-0014) keeps the drive alive and never settles
// a held pool, so a test that observes the held state starts the pool
// without awaiting its settle and waits for the hold's log line, the same
// line the Console shows. The returned handle's answers drive the rest.
async function heldRun(options: Parameters<typeof startPool>[0]): Promise<PoolRun> {
  const run = startPool(options);
  await waitFor(() =>
    run.snapshots.some((s) =>
      s.state.log.some((line) => line.startsWith("merge hold (ADR-0014)")),
    ),
  );
  return run;
}

interface ResolverBehaviour {
  resolved?: boolean;
  note?: string;
  exitCode?: number;
  conflictFile?: string;
  resolution?: string;
  recordDir?: string;
}

function resolverStub(
  poolDir: string,
  behaviour: Record<string, ResolverBehaviour>,
): {
  harnesses: Record<string, HarnessCommand>;
  spawned: Record<string, SpawnContext>;
  spawnOrder: string[];
} {
  const stubPath = join(poolDir, "resolver-stub.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'outcome="$1"; plan="$2"; worktree="$3"',
      'source "$plan"',
      ': "${CONFLICT_FILE:=}" "${RESOLUTION:=}" "${RECORD_DIR:=}"',
      'git -C "$worktree" merge "$WORKING_BRANCH" >/dev/null 2>&1 || true',
      'if [ "$RESOLVED" = "1" ]; then',
      '  if [ -n "$CONFLICT_FILE" ]; then',
      '    printf \'%s\\n\' "$RESOLUTION" > "$worktree/$CONFLICT_FILE"',
      '    git -C "$worktree" add "$CONFLICT_FILE"',
      "  fi",
      '  printf \'{"resolved": true, "note": "%s"}\' "$NOTE" > "$outcome"',
      "else",
      '  printf \'{"resolved": false, "note": "%s"}\' "$NOTE" > "$outcome"',
      "fi",
      'if [ -n "$RECORD_DIR" ]; then',
      '  mkdir -p "$RECORD_DIR"',
      '  git -C "$worktree" branch --show-current > "$RECORD_DIR/branch"',
      '  git -C "$worktree" rev-parse --verify MERGE_HEAD > "$RECORD_DIR/mergehead" 2>/dev/null || true',
      "fi",
      'exit "$EXIT"',
      "",
    ].join("\n"),
  );
  const spawned: Record<string, SpawnContext> = {};
  const spawnOrder: string[] = [];
  const stub: HarnessCommand = (ctx) => {
    spawned[ctx.id] = ctx;
    spawnOrder.push(ctx.id);
    const b = behaviour[ctx.id] ?? { resolved: false, note: "no behaviour" };
    const planPath = join(poolDir, `resolver-plan-${ctx.id}.sh`);
    const quote = (value: string) => JSON.stringify(value);
    const lines = [
      "WORKING_BRANCH=main",
      `RESOLVED=${b.resolved ? "1" : ""}`,
      `NOTE=${quote(b.note ?? "")}`,
      `EXIT=${b.exitCode ?? 0}`,
    ];
    if (b.conflictFile) lines.push(`CONFLICT_FILE=${quote(b.conflictFile)}`);
    if (b.resolution) lines.push(`RESOLUTION=${quote(b.resolution)}`);
    if (b.recordDir) lines.push(`RECORD_DIR=${quote(b.recordDir)}`);
    writeFileSync(planPath, lines.join("\n") + "\n");
    return ["bash", stubPath, ctx.outcomePath, planPath, ctx.cwd];
  };
  return {
    harnesses: { "resolver-stub": stub },
    spawned,
    spawnOrder,
  };
}

const resolverConfig: PoolConfig = {
  ...stubConfig,
  resolver: "resolver-stub",
};

interface GitStubBehaviour {
  status?: "done" | "checkpoint" | "keep";
  outcome?: { summary: string; commitSha: string | null } | null;
  outcomeRaw?: string;
  spawn?: unknown;
  grade?: { score: number; verdict: "pass" | "flag"; reasons: string };
  winner?: number | string;
  exitCode?: number;
  workFile?: string;
  workLine?: string;
  overwrite?: boolean;
  commitMsg?: string;
  leaveFile?: string;
  touch?: string;
  waitFor?: string;
  waitMerged?: string;
  recordDir?: string;
  expectFile?: string;
  noiseFile?: string;
}

interface GitPool {
  poolDir: string;
  head: string;
  git: (args: string[]) => { exitCode: number; stdout: Buffer; stderr: Buffer };
}

function makeGitPool(spec: PoolSpec, seed: Record<string, string> = {}): GitPool {
  const poolDir = makePool(spec);
  for (const [path, content] of Object.entries(seed)) {
    writeFileSync(join(poolDir, path), content);
  }
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: poolDir,
      stdout: "pipe",
      stderr: "pipe",
    });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pool@test"]);
  git(["config", "user.name", "pool"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const head = git(["rev-parse", "HEAD"]).stdout.toString().trim();
  return { poolDir, head, git };
}

function gitStubHarness(
  poolDir: string,
  behaviour: Record<string, GitStubBehaviour | GitStubBehaviour[]>,
): StubRig {
  const stubPath = join(poolDir, "git-stub.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"; outcome_path="$3"; outcome_json="$4"; exit_code="$5"; plan="$6"',
      'WORK_FILE=""; WORK_LINE=""; OVERWRITE=""; COMMIT_MSG=""',
      'LEAVE_FILE=""; TOUCH=""; WAIT_FOR=""; WAIT_MERGED=""; MAIN_REPO=""; RECORD_DIR=""; EXPECT_FILE=""; NOISE_FILE=""',
      'source "$plan"',
      'if [ -n "$TOUCH" ]; then touch "$TOUCH"; fi',
      'if [ -n "$WAIT_FOR" ]; then',
      "  for _ in $(seq 1 100); do",
      '    [ -e "$WAIT_FOR" ] && break',
      "    sleep 0.05",
      "  done",
      '  [ -e "$WAIT_FOR" ] || exit 42',
      "fi",
      'if [ -n "$WAIT_MERGED" ]; then',
      "  for _ in $(seq 1 100); do",
      '    log="$(git -C "$MAIN_REPO" log --format=%s 2>/dev/null)"',
      '    case "$log" in *"$WAIT_MERGED"*) break;; esac',
      "    sleep 0.05",
      "  done",
      '  log="$(git -C "$MAIN_REPO" log --format=%s 2>/dev/null)"',
      '  case "$log" in *"$WAIT_MERGED"*) ;; *) exit 42;; esac',
      "fi",
      'if [ -n "$EXPECT_FILE" ] && [ ! -e "$EXPECT_FILE" ]; then exit 43; fi',
      'if [ -n "$NOISE_FILE" ]; then cat "$NOISE_FILE"; fi',
      'if [ -n "$RECORD_DIR" ]; then',
      '  mkdir -p "$RECORD_DIR"',
      '  git rev-parse HEAD > "$RECORD_DIR/head"',
      '  git branch --show-current > "$RECORD_DIR/branch"',
      '  pwd > "$RECORD_DIR/cwd"',
      "fi",
      "staged=0",
      'if [ -n "$WORK_FILE" ]; then',
      '  mkdir -p "$(dirname "$WORK_FILE")"',
      '  if [ -n "$OVERWRITE" ]; then printf \'%s\\n\' "${WORK_LINE:-work}" > "$WORK_FILE"',
      '  else printf \'%s\\n\' "${WORK_LINE:-work}" >> "$WORK_FILE"; fi',
      '  git add "$WORK_FILE"; staged=1',
      "fi",
      'if [ -n "$LEAVE_FILE" ]; then printf "partial\\n" > "$LEAVE_FILE"; fi',
      'if [ "$staged" = "1" ]; then git commit -qm "${COMMIT_MSG:-ticket}"; fi',
      // The outcome JSON is the ending signal (ADR-0005): the stub writes
      // it to the outcome path the engine handed over, and the engine
      // writes the canonical Issue's marker itself.
      'if [ -n "$outcome_json" ]; then printf \'%s\' "$outcome_json" > "$outcome_path"; fi',
      'exit "$exit_code"',
      "",
    ].join("\n"),
  );
  const spawned: Record<string, SpawnContext> = {};
  const spawnOrder: string[] = [];
  const spawnList: SpawnContext[] = [];
  const spawnCounts: Record<string, number> = {};
  const stub: HarnessCommand = (ctx) => {
    spawned[ctx.id] = ctx;
    spawnOrder.push(ctx.id);
    spawnList.push(ctx);
    const n = spawnCounts[ctx.id] ?? 0;
    spawnCounts[ctx.id] = n + 1;
    const entry = behaviour[ctx.id] ??
      // A grader id the engine wrote gets a default passing grade, so tests
      // that do not care about grading still flow through it.
      (/-grader-\d+$/.test(ctx.id)
        ? { grade: { score: 8, verdict: "pass", reasons: "default grade" } }
        : {});
    const b = Array.isArray(entry)
      ? entry[Math.min(n, entry.length - 1)]
      : entry;
    const status = b.status ?? "done";
    const outcome =
      b.outcomeRaw !== undefined
        ? b.outcomeRaw
        : b.outcome === null || status === "keep"
          ? ""
          : JSON.stringify({
              status,
              ...(b.outcome ?? {
                summary: `summary-${ctx.id}`,
                commitSha: `sha-${ctx.id}`,
              }),
              ...(b.spawn !== undefined ? { spawn: b.spawn } : {}),
              ...(b.grade !== undefined ? { grade: b.grade } : {}),
              ...(b.winner !== undefined ? { winner: b.winner } : {}),
            });
    const planPath = join(poolDir, `plan-${ctx.id}-${n}.sh`);
    const quote = (value: string) => JSON.stringify(value);
    const lines = [`MAIN_REPO=${quote(poolDir)}`];
    if (b.workFile) lines.push(`WORK_FILE=${quote(b.workFile)}`);
    if (b.workLine) lines.push(`WORK_LINE=${quote(b.workLine)}`);
    if (b.overwrite) lines.push('OVERWRITE="1"');
    if (b.commitMsg) lines.push(`COMMIT_MSG=${quote(b.commitMsg)}`);
    if (b.leaveFile) lines.push(`LEAVE_FILE=${quote(b.leaveFile)}`);
    if (b.touch) lines.push(`TOUCH=${quote(b.touch)}`);
    if (b.waitFor) lines.push(`WAIT_FOR=${quote(b.waitFor)}`);
    if (b.waitMerged) lines.push(`WAIT_MERGED=${quote(b.waitMerged)}`);
    if (b.recordDir) lines.push(`RECORD_DIR=${quote(b.recordDir)}`);
    if (b.expectFile) lines.push(`EXPECT_FILE=${quote(b.expectFile)}`);
    if (b.noiseFile) lines.push(`NOISE_FILE=${quote(b.noiseFile)}`);
    writeFileSync(planPath, lines.join("\n") + "\n");
    return [
      "bash",
      stubPath,
      ctx.issuePath,
      status,
      ctx.outcomePath,
      outcome,
      String(b.exitCode ?? 0),
      planPath,
    ];
  };
  return { harnesses: { stub }, spawned, spawnOrder, spawnList };
}

const readyTicket = (id: string, blockedBy = "none") => ({
  file: `${id}-t.md`,
  marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
});

function readEventLines(poolDir: string, id: string) {
  return readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      at: string;
      attempt: number;
      kind: string;
      payload: Record<string, unknown>;
    });
}

describe("pool loading", () => {
  it("rejects a pool with a missing line-1 marker", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-no-marker.md", marker: "# no marker here" }],
      config: stubConfig,
    });
    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/line-1 state marker/);
  });

  it("rejects a pool with no Issue files", async () => {
    const poolDir = makePool({ tickets: [], config: stubConfig });
    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/no Issue files/);
  });

  it("renders an unresolvable-harness ticket unassigned on the snapshot, and dies naming the fix when it schedules", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
    });
    // Resolution is total (the unassigned record rides the snapshot with
    // nulls), so the pool starts and the pool config error fires when the
    // ticket schedules, at the spawn that cannot run.
    const run = startPool({ poolDir, harnesses: stubHarness({}).harnesses });
    await expect(run.settled).rejects.toThrow(
      /pool config: ticket 01 has no harness/,
    );
    const last = run.snapshots[run.snapshots.length - 1]!;
    expect(last.phase).toBe("dead");
    expect(last.assignments["01"]).toEqual({
      harness: null,
      model: null,
      drivers: "implement",
    });
    expect(run.final.log).toContain(
      "pool dead: pool config: ticket 01 has no harness (set one in console.json assign or defaults)",
    );
  });
});

describe("verify assignment", () => {
  const ready01 = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("resolves verify: 1 and verify: 3 onto the ticket's assignment", () => {
    for (const n of [1, 3]) {
      const config: PoolConfig = {
        ...stubConfig,
        assign: { "01": { verify: n } },
      };
      const poolDir = makePool({
        tickets: [{ file: "01-a.md", marker: ready01 }],
        config,
      });
      const [marker] = loadPoolMarkers(join(poolDir, "issues"));
      const assignment = resolveAssignment(
        marker,
        config,
        stubHarness({}).harnesses,
      );
      expect(assignment.verify).toBe(n);
    }
  });

  it("resolves no verify when the assign block omits the key", () => {
    const config: PoolConfig = { ...stubConfig };
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready01 }],
      config,
    });
    const [marker] = loadPoolMarkers(join(poolDir, "issues"));
    const assignment = resolveAssignment(
      marker,
      config,
      stubHarness({}).harnesses,
    );
    expect(assignment.verify).toBeUndefined();
  });

  it("runs a pool with no verify key exactly as today", async () => {
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready01 }],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done" });
    expect(Object.keys(rig.spawned)).toEqual(["01"]);
  });

  it("rejects invalid verify values at pool load, naming the ticket", async () => {
    for (const verify of [0, -1, 2.5, "3", true, {}]) {
      const config = JSON.parse(
        JSON.stringify({ ...stubConfig, assign: { "01": { verify } } }),
      ) as PoolConfig;
      const poolDir = makePool({
        tickets: [{ file: "01-a.md", marker: ready01 }],
        config,
      });
      await expect(
        runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
      ).rejects.toThrow(/pool config: ticket 01 has invalid verify/);
    }
  });

  it("treats verify: null as absent, like the other assign keys", () => {
    const config = JSON.parse(
      JSON.stringify({ ...stubConfig, assign: { "01": { verify: null } } }),
    ) as PoolConfig;
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready01 }],
      config,
    });
    const [marker] = loadPoolMarkers(join(poolDir, "issues"));
    const assignment = resolveAssignment(
      marker,
      config,
      stubHarness({}).harnesses,
    );
    expect(assignment.verify).toBeUndefined();
  });

  it("ignores verify in pool-level defaults, activation is per ticket", () => {
    const config = JSON.parse(
      JSON.stringify({
        ...stubConfig,
        defaults: { ...stubConfig.defaults, verify: 3 },
      }),
    ) as PoolConfig;
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready01 }],
      config,
    });
    const [marker] = loadPoolMarkers(join(poolDir, "issues"));
    const assignment = resolveAssignment(
      marker,
      config,
      stubHarness({}).harnesses,
    );
    expect(assignment.verify).toBeUndefined();
  });

  it("ignores unknown assign keys, with and without verify", async () => {
    const withMystery = {
      ...stubConfig,
      assign: { "01": { mystery: "x" } },
    } as PoolConfig;
    const poolDir = makePool({
      tickets: [{ file: "01-a.md", marker: ready01 }],
      config: withMystery,
    });
    const [marker] = loadPoolMarkers(join(poolDir, "issues"));
    const rig = stubHarness({});

    expect(
      resolveAssignment(marker, withMystery, rig.harnesses).verify,
    ).toBeUndefined();

    const withBoth = {
      ...stubConfig,
      assign: { "01": { mystery: "x", verify: 2 } },
    } as PoolConfig;
    expect(resolveAssignment(marker, withBoth, rig.harnesses).verify).toBe(2);

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );
    expect(run.phase).toBe("done");
    expect(Object.keys(rig.spawned)).toEqual(["01"]);
  });
});

describe("verify fan-out", () => {
  const verifyConfig = (n: number): PoolConfig => ({
    ...stubConfig,
    assign: { "01": { verify: n } },
  });

  it("fans a verify: 3 ticket out to three same-round attempts, each on its own branch", async () => {
    const { poolDir, head, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      // A three-way rendezvous: each attempt waits for the next one to
      // start, so a serial engine times the wait out and crashes instead
      // of passing.
      "01": [
        {
          workFile: "cand-1.txt",
          commitMsg: "cand-1",
          touch: join(poolDir, "started-1"),
          waitFor: join(poolDir, "started-3"),
          recordDir: join(poolDir, "rec-1"),
        },
        {
          workFile: "cand-2.txt",
          commitMsg: "cand-2",
          touch: join(poolDir, "started-2"),
          waitFor: join(poolDir, "started-1"),
          recordDir: join(poolDir, "rec-2"),
        },
        {
          workFile: "cand-3.txt",
          commitMsg: "cand-3",
          touch: join(poolDir, "started-3"),
          waitFor: join(poolDir, "started-2"),
          recordDir: join(poolDir, "rec-3"),
        },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Grading (ticket 03) runs after the fan-out, and selection (ticket 04)
    // then closes the ticket out: the default grades tie at 8, the
    // head-to-head gives no pick, so the earlier attempt wins on the
    // deterministic order and merges, and the pool waits on Review.
    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-grader-3": "done",
      "01-head-to-head": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(run.final.log.some((line) =>
      line.startsWith("ticket 01: verify fan-out complete: 3 attempts exited " +
        "(3 done, 0 checkpoint, 0 crash)"),
    )).toBe(true);

    // Three attempts spawned in one scheduling round, each on its own
    // attempt branch cut from the same HEAD, then one grader per attempt.
    expect(rig.spawnOrder).toEqual([
      "01",
      "01",
      "01",
      "01-grader-1",
      "01-grader-2",
      "01-grader-3",
      "01-head-to-head",
    ]);
    expect(rig.spawnList.map((c) => c.outcomePath)).toEqual([
      ...[1, 2, 3].map((i) =>
        join(poolDir, "runs", `01.attempt-${i}.outcome.json`),
      ),
      ...[1, 2, 3].map((i) =>
        join(poolDir, "runs", `01-grader-${i}.outcome.json`),
      ),
      join(poolDir, "runs", "01-head-to-head.outcome.json"),
    ]);
    for (let i = 1; i <= 3; i++) {
      const rec = join(poolDir, `rec-${i}`);
      expect(readFileSync(join(rec, "branch"), "utf8").trim()).toBe(
        branchFor(poolDir, "01", i),
      );
      expect(readFileSync(join(rec, "head"), "utf8").trim()).toBe(head);
      expect(readFileSync(join(rec, "cwd"), "utf8").trim()).toBe(
        worktreePathFor(poolDir, "01", i),
      );
      expect(rig.spawnList[i - 1].cwd).toBe(
        worktreePathFor(poolDir, "01", i),
      );
    }

    // Each attempt wrote its own Outcome. Selection then merged attempt 1
    // (the tie's earlier attempt) and discarded the losers.
    for (let i = 1; i <= 3; i++) {
      const outcome = JSON.parse(
        readFileSync(
          join(poolDir, "runs", `01.attempt-${i}.outcome.json`),
          "utf8",
        ),
      );
      expect(outcome.status).toBe("done");
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .not.toBe(0);
      expect(existsSync(join(poolDir, `cand-${i}.txt`))).toBe(i === 1);
    }
    expect(Object.keys(run.final.outcomes).sort()).toEqual([
      "01",
      "01-grader-1",
      "01-grader-2",
      "01-grader-3",
    ]);

    // The ticket log records each attempt as a distinct attempt, and the
    // engine lands each grader's grade on its attempt. Exits append in
    // completion order, so the contract is per attempt: each attempt reads
    // scheduled, spawned, exited, graded in order (the winner's record
    // continues with selected and merged), and every attempt was scheduled
    // before the first spawn (one scheduling round).
    const events = readEventLines(poolDir, "01");
    expect(events.map((e) => e.attempt).sort()).toEqual([
      1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    ]);
    for (const attempt of [1, 2, 3]) {
      expect(
        events.filter((e) => e.attempt === attempt).map((e) => e.kind),
      ).toEqual(
        attempt === 1
          ? ["scheduled", "spawned", "exited", "graded", "selected", "merged"]
          : ["scheduled", "spawned", "exited", "graded"],
      );
    }
    const firstSpawn = events.findIndex((e) => e.kind === "spawned");
    expect(
      Math.max(
        ...events.map((e, i) => (e.kind === "scheduled" ? i : -1)),
      ),
    ).toBeLessThan(firstSpawn);

    // No partial progress: an attempt's exit is visible in the log while
    // the ticket is still in-progress. Later snapshots carry selection
    // (ticket 04) and show the ticket done.
    const exitedEarly = run.snapshots.filter((s) =>
      s.state.log.some((line) => line.includes("attempt 1 exited")),
    );
    expect(exitedEarly.length).toBeGreaterThan(0);
    expect(exitedEarly[0].state.tickets["01"]).toBe("in-progress");
  }, 15000);

  it("marks a verify: 1 ticket done on a passing grade, merging its attempt branch", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "cand.txt", commitMsg: "cand" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The lone attempt passed grading: the ticket is done exactly as an
    // unverified ticket is today, through the existing merge path, with
    // the engine writing the status and the attempt's outcome downstream.
    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "01-grader-1": "done" });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(rig.spawnOrder).toEqual(["01", "01-grader-1"]);
    expect(existsSync(join(poolDir, "cand.txt"))).toBe(true);
    expect(run.final.outcomes["01"]?.summary).toBe("summary-01");
    expect(readEventLines(poolDir, "01").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "graded",
      "merged",
    ]);
    // The merged attempt branch is cleaned up like any merged branch.
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .not.toBe(0);
  }, 15000);

  it("runs a ticket without verify exactly one attempt, as today, beside a fan-out", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
        { workFile: "cand-3.txt", commitMsg: "cand-3" },
      ],
      "02": { workFile: "plain.txt", commitMsg: "plain" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Ticket 02 has no verify key: one attempt, merged, done.
    expect(run.final.tickets["02"]).toBe("done");
    expect(markerLine(poolDir, "02-t.md")).toContain("status=done");
    expect(rig.spawnOrder.filter((id) => id === "02")).toHaveLength(1);
    expect(existsSync(join(poolDir, "plain.txt"))).toBe(true);
    expect(
      readEventLines(poolDir, "02").map((e) => e.kind),
    ).toEqual(["scheduled", "spawned", "exited", "merged"]);

    // Ticket 01 fanned out, graded, and selection (ticket 04) merged its
    // tied-at-8 winner, the earlier attempt, discarding the other branches.
    expect(run.final.tickets["01"]).toBe("done");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(rig.spawnOrder.filter((id) => id === "01")).toHaveLength(3);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    for (let i = 1; i <= 3; i++) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .not.toBe(0);
    }
    expect(run.phase).toBe("quiescent");
  }, 15000);

  it("keeps a crashed attempt's siblings running and records today's crash semantics", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      // Attempt 1 touches its crash marker, then blocks until a sibling
      // has actually started before exiting non-zero with no outcome: a
      // serial engine times the wait out (exit 42) and fails the code-3
      // assertion below.
      "01": [
        {
          touch: join(poolDir, "crashed-1"),
          waitFor: join(poolDir, "started-2"),
          status: "keep",
          exitCode: 3,
        },
        {
          touch: join(poolDir, "started-2"),
          workFile: "cand-2.txt",
          commitMsg: "cand-2",
        },
        {
          // Attempt 3 does no work until the crash marker exists, so an
          // engine that stops the round at the crash fails the done
          // assertions below.
          waitFor: join(poolDir, "crashed-1"),
          workFile: "cand-3.txt",
          commitMsg: "cand-3",
        },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Today's crash semantics: one crash interrupt for the ticket, its
    // body quoting the crashed attempt's log path, the outcome fact, and
    // (empty here) the log tail (ADR-0012).
    expect(run.phase).toBe("quiescent");
    const crashes = run.interrupts.filter((i) => i.kind === "crash");
    expect(crashes).toHaveLength(1);
    expect(crashes[0].ticketId).toBe("01");
    expect(crashes[0].body).toBe(
      join(poolDir, "runs", "01.attempt-1.log") +
        "\n\n" +
        "outcome file: " +
        join(poolDir, "runs", "01.attempt-1.outcome.json") +
        " (missing)\n",
    );

    const events = readEventLines(poolDir, "01");
    const crashEvent = events.find((e) => e.kind === "crash");
    expect(crashEvent?.attempt).toBe(1);
    expect(crashEvent?.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
      logTail: [],
      outcomeExists: false,
    });

    // The siblings survived the crash and sit on their branches as
    // candidates, outcomes written; the ticket wrote no status anywhere.
    for (const i of [2, 3]) {
      const exit = events.find((e) => e.kind === "exited" && e.attempt === i);
      expect(exit?.payload).toEqual({
        code: 0,
        status: "done",
        logTail: [],
        outcomeExists: true,
      });
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .toBe(0);
      expect(existsSync(join(poolDir, `cand-${i}.txt`))).toBe(false);
      expect(
        JSON.parse(
          readFileSync(
            join(poolDir, "runs", `01.attempt-${i}.outcome.json`),
            "utf8",
          ),
        ).status,
      ).toBe("done");
    }
    expect(run.final.tickets).toEqual({
      "01": "in-progress",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-grader-3": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=in-progress");
  }, 15000);

  it("records a checkpoint outcome from one candidate without proceeding", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { status: "checkpoint", outcome: { summary: "paused-1", commitSha: null } },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The candidate's ending is recorded, but the fan-out gate holds: no
    // checkpoint interrupt, no Brief landing, no status write. How a
    // partial checkpoint interacts with the grade is ticket 05's to settle;
    // this pins the gate through grading.
    expect(run.phase).toBe("stalled");
    expect(run.interrupts).toEqual([]);
    expect(run.final.tickets).toEqual({
      "01": "in-progress",
      "01-grader-1": "done",
      "01-grader-2": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).not.toContain("Brief");
    const events = readEventLines(poolDir, "01");
    const exit1 = events.find((e) => e.kind === "exited" && e.attempt === 1);
    expect(exit1?.payload).toEqual({
      code: 0,
      status: "checkpoint",
      logTail: [],
      outcomeExists: true,
    });
    expect(
      JSON.parse(
        readFileSync(
          join(poolDir, "runs", "01.attempt-1.outcome.json"),
          "utf8",
        ),
      ).status,
    ).toBe("checkpoint");
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .toBe(0);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
  }, 15000);

  it("rotates a pre-verify solo attempt's well-known log before the fan-out", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    // A well-known log left behind by a solo attempt of a pre-verify era.
    mkdirSync(join(poolDir, "runs"), { recursive: true });
    writeFileSync(join(poolDir, "runs", "01.log"), "solo era\n");
    const rig = gitStubHarness(poolDir, { "01": [{}, {}] });

    await runPool({ poolDir, harnesses: rig.harnesses });

    // The old log rotated to its attempt name; the fan-out's attempts
    // wrote their own numbered logs and never touched the well-known one.
    expect(readFileSync(join(poolDir, "runs", "01.attempt-0.log"), "utf8"))
      .toBe("solo era\n");
    expect(existsSync(join(poolDir, "runs", "01.log"))).toBe(false);
    for (const i of [1, 2]) {
      expect(existsSync(join(poolDir, "runs", `01.attempt-${i}.log`))).toBe(
        true,
      );
    }
  }, 15000);

  it("re-fans-out with continued attempt numbers after a crash resume", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: verifyConfig(2),
    });
    const rig = stubHarness({
      "01": { statuses: ["keep", "done"], exitCodes: [7, 0] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");

    // The existing resume path resets the ticket to ready; the next
    // scheduling round fans out again, numbering on from the first round.
    // The grader cards are round-stable: the same ids are rewritten and
    // rebound to the round's new attempts, not accumulated per attempt.
    const resumed = await run.resume("01");
    // The re-round's attempts both exited done and graded, so selection
    // (ticket 04) picks the re-round's earlier attempt and closes the
    // ticket; without git there is no branch to merge, so no merged event.
    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(resumed.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-head-to-head": "done",
    });

    const events = readEventLines(poolDir, "01");
    for (const attempt of [1, 2, 3, 4]) {
      expect(
        events.filter((e) => e.attempt === attempt).map((e) => e.kind),
      ).toEqual(
        attempt === 1
          ? ["scheduled", "spawned", "exited", "crash", "graded"]
          : attempt === 2
            ? // The resume's answered event carries the latest attempt.
              ["scheduled", "spawned", "exited", "graded", "answered"]
            : attempt === 3
              ? ["scheduled", "spawned", "exited", "graded", "selected"]
              : ["scheduled", "spawned", "exited", "graded"],
      );
    }
    // Each grader card ran once per round: two spawns, its own attempt
    // counter numbering on across the rewrite.
    for (const gid of ["01-grader-1", "01-grader-2"]) {
      expect(
        readEventLines(poolDir, gid).map((e) => e.attempt),
      ).toEqual([1, 1, 1, 2, 2, 2]);
    }
    expect(existsSync(join(poolDir, "runs", "01.attempt-1.outcome.json")))
      .toBe(false);
    for (const i of [2, 3, 4]) {
      expect(
        JSON.parse(
          readFileSync(
            join(poolDir, "runs", `01.attempt-${i}.outcome.json`),
            "utf8",
          ),
        ).status,
      ).toBe("done");
    }
  }, 15000);
});

describe("verify grading", () => {
  const verifyConfig = (n: number): PoolConfig => ({
    ...stubConfig,
    assign: { "01": { verify: n } },
  });

  it("writes one grader ticket per attempt with the build ticket as its blocker", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // One grader ticket file per attempt, on disk with the ordinary
    // blocking edge, run to done by the engine.
    expect(existsSync(join(poolDir, "issues", "01-grader-1.md"))).toBe(true);
    expect(existsSync(join(poolDir, "issues", "01-grader-2.md"))).toBe(true);
    expect(markerLine(poolDir, "01-grader-1.md")).toContain(
      "id=01-grader-1 blocked-by=01 status=done",
    );
    expect(markerLine(poolDir, "01-grader-2.md")).toContain(
      "id=01-grader-2 blocked-by=01 status=done",
    );
    expect(
      readFileSync(join(poolDir, "issues", "01-grader-1.md"), "utf8"),
    ).toContain("attempt 1 of ticket 01");

    // Without a pool verify skill the grader prompt says so and grades on
    // the engine's own instructions instead.
    expect(
      rig.spawnList.find((c) => c.id === "01-grader-1")!.body,
    ).toContain("(the pool has no verify skill");

    // The graders never entered a super-step, and selection (ticket 04)
    // then merged the tied-at-8 winner, the earlier attempt, after the
    // head-to-head gave no pick.
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-head-to-head": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
    expect(
      run.final.log.filter((line) => line.startsWith("super-step")),
    ).toEqual(["super-step 1: 01"]);
    expect(run.final.log).toContain(
      "ticket 01: grading 2 attempts with grader tickets " +
        "01-grader-1, 01-grader-2",
    );
    expect(
      readEventLines(poolDir, "01-grader-1").map((e) => e.kind),
    ).toEqual(["scheduled", "spawned", "exited"]);
  }, 15000);

  it("binds each grader to its own attempt's artifacts and parameterizes the pool's verify skill", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    writeFileSync(
      join(poolDir, "verify.md"),
      "# verify: grade one attempt\n\n" +
        "POOL-SKILL-MARKER: grade on the three criteria only.\n",
    );
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });

    await runPool({ poolDir, harnesses: rig.harnesses });

    const grader1 = rig.spawnList.find((c) => c.id === "01-grader-1")!;
    const grader2 = rig.spawnList.find((c) => c.id === "01-grader-2")!;

    // The pool's verify skill travels in the prompt verbatim, and the
    // engine's glue names the bound attempt's four artifact paths.
    for (const ctx of [grader1, grader2]) {
      expect(ctx.body).toContain(
        "POOL-SKILL-MARKER: grade on the three criteria only.",
      );
      expect(ctx.body).toContain(
        "Trust terminal output over the agent's self-assessment.",
      );
      expect(ctx.body).toContain(join(poolDir, "issues", "01-t.md"));
      expect(ctx.cwd).toBe(poolDir);
    }
    expect(grader1.body).toContain("attempt 1 of ticket 01");
    expect(grader1.body).toContain(
      join(poolDir, "runs", "01.attempt-1.outcome.json"),
    );
    expect(grader1.body).not.toContain(
      join(poolDir, "runs", "01.attempt-2.outcome.json"),
    );
    expect(grader1.body).toContain("01-grader-1.diff.patch");
    expect(grader1.body).toContain("01-grader-1.trim.log");
    expect(grader2.body).toContain("attempt 2 of ticket 01");
    expect(grader2.body).toContain(
      join(poolDir, "runs", "01.attempt-2.outcome.json"),
    );

    // The grader writes its own outcome to the path the engine handed it.
    expect(grader1.outcomePath).toBe(
      join(poolDir, "runs", "01-grader-1.outcome.json"),
    );
    expect(grader1.issuePath).toBe(join(poolDir, "issues", "01-grader-1.md"));

    // The diff file holds exactly the bound attempt's work: attempt 1's
    // diff knows cand-1 and not cand-2, and the other way round.
    const diff1 = readFileSync(
      join(poolDir, "runs", "01-grader-1.diff.patch"),
      "utf8",
    );
    expect(diff1).toContain("cand-1");
    expect(diff1).not.toContain("cand-2");
    const diff2 = readFileSync(
      join(poolDir, "runs", "01-grader-2.diff.patch"),
      "utf8",
    );
    expect(diff2).toContain("cand-2");
    expect(diff2).not.toContain("cand-1");
  }, 15000);

  it("lands each grade in the graded attempt's record", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
        { workFile: "cand-3.txt", commitMsg: "cand-3" },
      ],
      "01-grader-1": {
        grade: { score: 9, verdict: "pass", reasons: "solid work" },
      },
      "01-grader-2": {
        grade: { score: 3, verdict: "flag", reasons: "tests missing" },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // A graded event per attempt on the build ticket's file, carrying
    // score, verdict, and reasons (events land in grader completion order,
    // so the comparison sorts by attempt).
    const graded = readEventLines(poolDir, "01")
      .filter((e) => e.kind === "graded")
      .sort((a, b) => a.attempt - b.attempt);
    expect(graded.map((e) => [e.attempt, e.payload])).toEqual([
      [1, { score: 9, verdict: "pass", reasons: "solid work" }],
      [2, { score: 3, verdict: "flag", reasons: "tests missing" }],
      [3, { score: 8, verdict: "pass", reasons: "default grade" }],
    ]);
    expect(run.final.log).toContain(
      "ticket 01: attempt 1 graded: score 9, verdict pass (grader 01-grader-1)",
    );
    expect(run.final.log).toContain(
      "ticket 01: attempt 2 graded: score 3, verdict flag (grader 01-grader-2)",
    );
    expect(markerLine(poolDir, "01-grader-2.md")).toContain("status=done");
    // Selection (ticket 04) then took attempt 1: margin 1 over attempt 3 is
    // below the outright bound, so the deterministic order decided.
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(
      readEventLines(poolDir, "01").find((e) => e.kind === "selected")?.payload,
    ).toEqual({ score: 9, margin: 1, rule: "fallback" });
  }, 15000);

  it("resolves a grader's harness and model through assign, overridable per grader", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "stub", model: "stub-model" },
        assign: {
          "01": { verify: 2, harness: "stub", model: "build-model" },
          // Harness-only override: the model still comes from the build.
          "01-grader-2": { harness: "other" },
        },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });
    const others: SpawnContext[] = [];
    const otherScript = join(poolDir, "other-harness.sh");
    writeFileSync(
      otherScript,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'issue="$1"; outcome_path="$2"',
        'printf \'%s\' \'{"status":"done","summary":"other-grader",' +
          '"commitSha":null,"grade":{"score":6,"verdict":"pass",' +
          '"reasons":"ok"}}\' > "$outcome_path"',
        "",
      ].join("\n"),
    );
    const other: HarnessCommand = (ctx) => {
      others.push(ctx);
      return ["bash", otherScript, ctx.issuePath, ctx.outcomePath];
    };

    await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, other },
    });

    // What the grader's assign entry does not override comes from the build
    // ticket, not the pool defaults.
    const grader1 = rig.spawnList.find((c) => c.id === "01-grader-1")!;
    expect(grader1.harness).toBe("stub");
    expect(grader1.model).toBe("build-model");
    expect(others[0].id).toBe("01-grader-2");
    expect(others[0].harness).toBe("other");
    expect(others[0].model).toBe("build-model");
    // The override ran and its grade landed.
    expect(markerLine(poolDir, "01-grader-2.md")).toContain("status=done");
    expect(
      readEventLines(poolDir, "01").find((e) => e.kind === "graded" && e.attempt === 2)
        ?.payload,
    ).toEqual({ score: 6, verdict: "pass", reasons: "ok" });
  }, 15000);

  it("serves grader tickets the Assignment inherited from their build ticket on the snapshot", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "stub", model: "pool-default-model" },
        assign: {
          "01": {
            verify: 2,
            harness: "stub",
            model: "build-model",
            drivers: "implement code-review",
          },
          "01-grader-2": { harness: "other" },
        },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });
    const otherScript = join(poolDir, "other-harness.sh");
    writeFileSync(
      otherScript,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'issue="$1"; outcome_path="$2"',
        'printf \'%s\' \'{"status":"done","summary":"other-grader",' +
          '"commitSha":null,"grade":{"score":6,"verdict":"pass",' +
          '"reasons":"ok"}}\' > "$outcome_path"',
        "",
      ].join("\n"),
    );
    const other: HarnessCommand = (ctx) => [
      "bash",
      otherScript,
      ctx.issuePath,
      ctx.outcomePath,
    ];

    const run = await runPool({
      poolDir,
      harnesses: { ...rig.harnesses, other },
    });

    // The records on the served snapshot come from the engine's resolution:
    // the graders inherit their build ticket's model and drivers, not the
    // pool defaults (whose model name appears on no record).
    const last = run.snapshots[run.snapshots.length - 1]!;
    expect(last.assignments["01"]).toEqual({
      harness: "stub",
      model: "build-model",
      drivers: "implement code-review",
    });
    expect(last.assignments["01-grader-1"]).toEqual({
      harness: "stub",
      model: "build-model",
      drivers: "implement code-review",
    });
    expect(last.assignments["01-grader-2"]).toEqual({
      harness: "other",
      model: "build-model",
      drivers: "implement code-review",
    });
  }, 15000);

  it("re-spawns a grader that produced no usable grade and lands the eventual grade", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      // Grader 1 dies on its first run, then grades on the re-spawn.
      "01-grader-1": [
        { exitCode: 9 },
        { grade: { score: 7, verdict: "pass", reasons: "second try" } },
      ],
      // Grader 2 writes a usable outcome with no grade object on its first
      // run, then grades: an unparseable grade is a crash, never a grade.
      "01-grader-2": [
        { outcomeRaw: '{"status":"done","summary":"no grade","commitSha":null}' },
        { grade: { score: 4, verdict: "flag", reasons: "weak work" } },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Both graders ended done after one re-spawn each, and both grades
    // landed on their attempts; selection (ticket 04) then took attempt 1
    // (7 against 4, a 3-point margin) outright and the pool waits on
    // Review.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
    const graded = readEventLines(poolDir, "01").filter(
      (e) => e.kind === "graded",
    );
    expect(graded.find((e) => e.attempt === 1)?.payload).toEqual({
      score: 7,
      verdict: "pass",
      reasons: "second try",
    });
    expect(graded.find((e) => e.attempt === 2)?.payload).toEqual({
      score: 4,
      verdict: "flag",
      reasons: "weak work",
    });

    // Each grader ran twice: the crashed run and the re-spawn. The sibling
    // of a crashing grader is unaffected: grader 2's grade landed even
    // though grader 1 died first.
    expect(rig.spawnList.filter((c) => c.id === "01-grader-1")).toHaveLength(2);
    expect(rig.spawnList.filter((c) => c.id === "01-grader-2")).toHaveLength(2);

    // The grader's ticket log shows the crash and the re-spawn: the crash
    // closes attempt 1, the grader-respawn event opens attempt 2, and the
    // re-spawn names why it happened.
    const g1 = readEventLines(poolDir, "01-grader-1");
    expect(
      g1.filter((e) => e.attempt === 1).map((e) => e.kind),
    ).toEqual(["scheduled", "spawned", "exited", "crash"]);
    expect(
      g1.filter((e) => e.attempt === 2).map((e) => e.kind),
    ).toEqual(["grader-respawn", "scheduled", "spawned", "exited"]);
    expect(g1.find((e) => e.kind === "grader-respawn")?.payload).toEqual({
      build: "01",
      gradedAttempt: 1,
      reason: "harness exited 9",
      respawn: 1,
    });
    const g2 = readEventLines(poolDir, "01-grader-2");
    expect(
      g2.filter((e) => e.attempt === 1).map((e) => e.kind),
    ).toEqual(["scheduled", "spawned", "exited", "crash"]);
    expect(
      g2.find((e) => e.kind === "crash")?.payload,
    ).toEqual({
      code: 0,
      reason: "outcome carries no grade object",
      logTail: [],
      outcomeExists: true,
    });

    // The pool log narrates each re-spawn.
    expect(run.final.log).toContain(
      "ticket 01: re-spawning grader 01-grader-1 for attempt 1 " +
        "(respawn 1 of 2)",
    );
    expect(run.final.log).toContain(
      "ticket 01: re-spawning grader 01-grader-2 for attempt 2 " +
        "(respawn 1 of 2)",
    );
  }, 15000);

  it("treats a grader's checkpoint outcome as an unusable grade and logs the crash", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "cand.txt", commitMsg: "cand" },
      // A grader that pauses instead of grading; even with a grade in the
      // outcome, a checkpoint is not a usable grade.
      "01-grader-1": {
        status: "checkpoint",
        grade: { score: 10, verdict: "pass", reasons: "perfect" },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(
      readEventLines(poolDir, "01").filter((e) => e.kind === "graded"),
    ).toEqual([]);
    expect(
      readEventLines(poolDir, "01-grader-1").find((e) => e.kind === "crash")
        ?.payload,
    ).toEqual({
      code: 0,
      reason: "grader outcome is a checkpoint, not a grade",
      logTail: [],
      outcomeExists: true,
    });
    expect(run.final.log).toContain(
      "ticket 01: grader 01-grader-1 produced no usable grade for " +
        "attempt 1: grader outcome is a checkpoint, not a grade",
    );
  }, 15000);

  it("bounds grader re-spawns and raises a crash interrupt on the build ticket", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "cand.txt", commitMsg: "cand" },
      // A systematically broken grader: every run exits non-zero.
      "01-grader-1": { exitCode: 9 },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The original run plus the bound of two re-spawns, then the engine
    // stops retrying and hands the broken grader to the human as a crash
    // interrupt on the build ticket.
    expect(rig.spawnList.filter((c) => c.id === "01-grader-1")).toHaveLength(3);
    expect(run.phase).toBe("quiescent");
    const crashes = run.interrupts.filter((i) => i.kind === "crash");
    expect(crashes).toHaveLength(1);
    expect(crashes[0].ticketId).toBe("01");
    expect(crashes[0].body).toContain("01-grader-1");
    expect(crashes[0].body).toContain("harness exited 9");
    expect(crashes[0].body).toContain(join(poolDir, "runs", "01-grader-1.log"));

    // The build ticket never passed or failed on a grader's bad day: no
    // grade anywhere, no status write, and the grader is still open.
    expect(
      readEventLines(poolDir, "01").filter((e) => e.kind === "graded"),
    ).toEqual([]);
    expect(markerLine(poolDir, "01-t.md")).toContain("status=in-progress");
    expect(markerLine(poolDir, "01-grader-1.md")).toContain(
      "status=in-progress",
    );

    // The grader's ticket log shows all three runs, each ending in a crash,
    // with a grader-respawn event before the second and third.
    expect(readEventLines(poolDir, "01-grader-1").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "grader-respawn",
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "grader-respawn",
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
  }, 15000);

  it("grades the re-fan-out after a grader-exhaustion crash resume", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: verifyConfig(1),
    });
    const rig = stubHarness({
      // Runs 1-3 crash the grader; run 4, after the human resumed the build
      // ticket and the engine re-fanned-out, grades.
      "01-grader-1": {
        exitCodes: [9, 9, 9, 0],
        grade: { score: 6, verdict: "pass", reasons: "recovered" },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);

    // The existing resume path resets the build ticket to ready; the next
    // scheduling round fans out again and the grader card runs afresh. The
    // recovered grade passes, so the lone attempt resolves to done (ticket
    // 05) and the pool waits on Review.
    const resumed = await run.resume("01");
    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(resumed.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
    });
    const graded = readEventLines(poolDir, "01").filter(
      (e) => e.kind === "graded",
    );
    expect(graded.map((e) => e.attempt)).toEqual([2]);
    expect(graded[0].payload).toEqual({
      score: 6,
      verdict: "pass",
      reasons: "recovered",
    });
    // The grader ran four times: three crashes in round one, one grade in
    // round two. The fresh round's run carries no grader-respawn event:
    // the human's resume, not a crash, started it.
    expect(rig.spawnList.filter((c) => c.id === "01-grader-1")).toHaveLength(4);
    expect(readEventLines(poolDir, "01-grader-1").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "grader-respawn",
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "grader-respawn",
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "scheduled",
      "spawned",
      "exited",
    ]);
  }, 15000);

  it("does not honor a grader's own status write", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: verifyConfig(1),
    });
    // The grader seds its own marker to done and writes no grade: the
    // engine owns the write and records a crash instead. Also pins grading
    // in a pool that does not run in git.
    const rig = stubHarness({
      "01-grader-1": { status: "marker-done" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(markerLine(poolDir, "01-grader-1.md")).toContain(
      "status=in-progress",
    );
    expect(
      readEventLines(poolDir, "01-grader-1").find((e) => e.kind === "crash")
        ?.payload,
    ).toEqual({
      code: 0,
      reason: "no outcome written",
      logTail: [],
      outcomeExists: false,
    });
    expect(
      readEventLines(poolDir, "01").filter((e) => e.kind === "graded"),
    ).toEqual([]);
    expect(run.final.tickets).toEqual({
      "01": "in-progress",
      "01-grader-1": "in-progress",
    });
  }, 15000);

  it("trims a huge attempt log to its tail and says so", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const noise = join(poolDir, "noise.txt");
    const lines: string[] = [];
    for (let i = 0; i < 9000; i++) lines.push(`noise line ${i} padding padding`);
    writeFileSync(noise, lines.join("\n") + "\nTAILMARKER-end\n");
    const rig = gitStubHarness(poolDir, {
      "01": [
        { noiseFile: noise, workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
    });

    await runPool({ poolDir, harnesses: rig.harnesses });

    const rawLog = readFileSync(
      join(poolDir, "runs", "01.attempt-1.log"),
      "utf8",
    );
    expect(rawLog.length).toBeGreaterThan(80_000);
    const trim1 = readFileSync(
      join(poolDir, "runs", "01-grader-1.trim.log"),
      "utf8",
    );
    expect(trim1.startsWith("[log trimmed to the last ~20k tokens;")).toBe(
      true,
    );
    expect(trim1.length).toBeLessThan(80_200);
    expect(trim1.trimEnd().endsWith("TAILMARKER-end")).toBe(true);
    // A log within the budget passes through whole, no trim notice.
    expect(
      readFileSync(join(poolDir, "runs", "01-grader-2.trim.log"), "utf8"),
    ).toBe("");
    // The grader's prompt names the trimmed copy.
    expect(
      rig.spawnList.find((c) => c.id === "01-grader-1")!.body,
    ).toContain("01-grader-1.trim.log");
  }, 15000);

  it("resolves a stale grader ticket from its build ticket's assignment at pool start", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      // No pool defaults: the build ticket carries its own assignment.
      config: {
        assign: { "01": { verify: 2, harness: "stub", model: "build-model" } },
      },
    });
    // A grader ticket file left on disk by a previous run.
    writeFileSync(
      join(poolDir, "issues", "01-grader-1.md"),
      "<!-- state: id=01-grader-1 blocked-by=01 status=ready -->\n\n# 01-grader-1\n",
    );
    const rig = gitStubHarness(poolDir, { "01": [{}, {}] });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Pool start resolved the stale grader from its build ticket, the
    // round's fan-out rewrote and ran both graders to done, and selection
    // (ticket 04) then merged the tied-at-8 winner, the earlier attempt,
    // after the head-to-head gave no pick.
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-head-to-head": "done",
    });
    const grader1 = rig.spawnList.find((c) => c.id === "01-grader-1")!;
    expect(grader1.harness).toBe("stub");
    expect(grader1.model).toBe("build-model");
  }, 15000);
});

describe("lone attempt resolution", () => {
  const verifyConfig = (n: number): PoolConfig => ({
    ...stubConfig,
    assign: { "01": { verify: n } },
  });

  it("raises a checkpoint interrupt carrying the grader's complaint on a flag verdict", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "cand.txt", commitMsg: "cand" },
      "01-grader-1": {
        grade: {
          score: 3,
          verdict: "flag",
          reasons: "the claimed tests do not exist",
        },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The bad done-claim is caught at the ticket: the interrupt's Brief is
    // the grade's verdict and reasons, not the agent's summary.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    expect(run.interrupts[0]?.ticketId).toBe("01");
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("score 3/10");
    expect(run.interrupts[0]?.body).toContain("verdict flag");
    expect(run.interrupts[0]?.body).toContain(
      "the claimed tests do not exist",
    );
    expect(run.interrupts[0]?.body).not.toContain("summary-01");

    // The engine wrote the checkpoint status; the attempt's work is parked
    // on its branch and nothing merged.
    expect(markerLine(poolDir, "01-t.md")).toContain("status=checkpoint");
    const issueText = readFileSync(join(poolDir, "issues", "01-t.md"), "utf8");
    expect(issueText).toContain("## Brief");
    expect(issueText).toContain("the claimed tests do not exist");
    expect(existsSync(join(poolDir, "cand.txt"))).toBe(false);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .toBe(0);

    // The grader's grade landed before the resolution, and the grader card
    // itself is done: the engine writes every status.
    expect(readEventLines(poolDir, "01").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "graded",
      "checkpoint",
    ]);
    expect(markerLine(poolDir, "01-grader-1.md")).toContain("status=done");
  }, 15000);

  it("re-raises the complaint Brief from the Issue after a restart", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const first = await runPool({
      poolDir,
      harnesses: gitStubHarness(poolDir, {
        "01-grader-1": {
          grade: { score: 2, verdict: "flag", reasons: "work is incomplete" },
        },
      }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // Killed before the boundary persist: the marker and the Brief the
    // engine landed are on disk, so rehydration re-raises the interrupt
    // from the Issue unchanged, like any checkpoint Brief.
    rmSync(join(poolDir, "console.db"), { force: true });
    const rig = gitStubHarness(poolDir, {});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(second.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(second.interrupts).toHaveLength(1);
    expect(second.interrupts[0]?.kind).toBe("checkpoint");
    expect(second.interrupts[0]?.body).toContain("work is incomplete");
  }, 15000);

  it("resumes a flagged lone attempt to ready and runs it to done on the next round", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": [
        { grade: { score: 2, verdict: "flag", reasons: "wrong file" } },
        { grade: { score: 9, verdict: "pass", reasons: "solid" } },
      ],
    });

    const first = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(first.phase).toBe("quiescent");
    expect(first.interrupts[0]?.kind).toBe("checkpoint");

    // The existing checkpoint-resume path: the note lands on the Issue and
    // the ticket re-fans-out with continued attempt numbers.
    const resumed = await first.resume("01", "write the right file");
    const done = await approveReview(resumed);
    expect(done.phase).toBe("done");
    expect(done.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(
      readFileSync(join(poolDir, "issues", "01-t.md"), "utf8"),
    ).toContain("## Resume note");
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(false);

    const events = readEventLines(poolDir, "01");
    expect(events.map((e) => [e.attempt, e.kind])).toEqual([
      [1, "scheduled"],
      [1, "spawned"],
      [1, "exited"],
      [1, "graded"],
      [1, "checkpoint"],
      [1, "answered"],
      [2, "scheduled"],
      [2, "spawned"],
      [2, "exited"],
      [2, "graded"],
      [2, "merged"],
    ]);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .not.toBe(0);
  }, 15000);

  it("resolves nothing for a crashed lone attempt, even with a passing grade", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = stubHarness({
      "01": { status: "keep", exitCode: 4 },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The crash interrupt is up and the grade of the debris decides
    // nothing: the ticket stays in-progress for the crash-resume path.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(run.final.tickets).toEqual({
      "01": "in-progress",
      "01-grader-1": "done",
    });
    expect(markerLine(poolDir, "01-t.md")).toContain("status=in-progress");
  }, 15000);

  it("lets an attempt's own checkpoint win over its grade", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: verifyConfig(1),
    });
    const rig = stubHarness({
      "01": { status: "checkpoint", brief: "waiting on the API name" },
      "01-grader-1": {
        grade: { score: 0, verdict: "flag", reasons: "incomplete" },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // A pause made no done-claim for the grade to verify: the agent's own
    // brief travels and the grade lands as context only.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "waiting on the API name" },
    ]);
    expect(markerLine(poolDir, "01-t.md")).toContain("status=checkpoint");
    expect(
      readEventLines(poolDir, "01").find((e) => e.kind === "graded")?.payload,
    ).toEqual({ score: 0, verdict: "flag", reasons: "incomplete" });
    expect(run.final.outcomes["01"]?.summary).toBe("summary-01");
  }, 15000);

  it("raises a checkpoint with the conflict in the Brief when the passing merge conflicts", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: {
        defaults: { harness: "stub", model: "stub-model" },
        assign: { "01": { verify: 1 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "cand.txt",
        workLine: "attempt",
        overwrite: true,
        commitMsg: "attempt",
      },
      "02": {
        workFile: "cand.txt",
        workLine: "plain",
        overwrite: true,
        commitMsg: "plain",
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The ticket-02 merge moved the working branch while the attempt was
    // in flight, so the passing attempt's merge conflicts. The conflict
    // machinery re-attempts the solo branch on resume and a lone attempt
    // has none, so the checkpoint's Brief carries the conflict instead.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("cand.txt");
    expect(run.interrupts[0]?.body).toContain(branchFor(poolDir, "01", 1));
    expect(markerLine(poolDir, "01-t.md")).toContain("status=checkpoint");
    expect(readFileSync(join(poolDir, "cand.txt"), "utf8")).toBe("plain\n");
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .toBe(0);
  }, 15000);
});

describe("verify selection", () => {
  const verifyConfig = (n: number): PoolConfig => ({
    ...stubConfig,
    assign: { "01": { verify: n } },
  });
  const grade = (score: number) => ({
    grade: { score, verdict: "pass" as const, reasons: `scored ${score}` },
  });
  const attemptWork = (n: number) => ({
    workFile: `cand-${n}.txt`,
    commitMsg: `cand-${n}`,
  });

  it("takes an outright winner: highest score merges, losers' branches go, artifacts stay", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2), attemptWork(3)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(5),
      "01-grader-3": grade(7),
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The top two grades spread by exactly 2: the winner is taken outright,
    // with no further judgment invoked. No head-to-head or human interrupt
    // exists to invoke, and the pool runs clean through Review to done.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(1);
    expect(selected?.payload).toEqual({ score: 9, margin: 2, rule: "outright" });
    expect(rig.spawned["01-head-to-head"]).toBeUndefined();
    expect(existsSync(join(poolDir, "issues", "01-head-to-head.md"))).toBe(
      false,
    );

    // Only the winner's branch merged, through the existing merge path.
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([1]);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
    expect(existsSync(join(poolDir, "cand-3.txt"))).toBe(false);

    // Every attempt branch is gone: the winner's after its merge, the
    // losers' discarded unmerged.
    for (const i of [1, 2, 3]) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .not.toBe(0);
      expect(
        existsSync(worktreePathFor(poolDir, "01", i)),
      ).toBe(false);
    }

    // The losers' artifacts survive the discard: attempt logs and outcomes
    // on disk, grades still readable from the ticket log.
    for (const i of [2, 3]) {
      expect(existsSync(join(poolDir, "runs", `01.attempt-${i}.log`))).toBe(
        true,
      );
      expect(
        JSON.parse(
          readFileSync(
            join(poolDir, "runs", `01.attempt-${i}.outcome.json`),
            "utf8",
          ),
        ).status,
      ).toBe("done");
    }
    // The graders run in parallel, so the graded events land in completion
    // order; the pairs are compared sorted by attempt.
    expect(
      events
        .filter((e) => e.kind === "graded")
        .sort((a, b) => a.attempt - b.attempt)
        .map((e) => [e.attempt, e.payload.score]),
    ).toEqual([
      [1, 9],
      [2, 5],
      [3, 7],
    ]);

    // The engine wrote the done status; the winner's outcome became the
    // ticket's, and the pool closed out through Review.
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-grader-3": "done",
    });
    expect(run.final.outcomes["01"]?.summary).toBe("summary-01");
  }, 15000);

  it("resolves an exact tie to the earlier attempt", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(7),
      "01-grader-2": grade(7),
      "01-head-to-head": { winner: "tie" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // An exact tie sits inside the outright band, so the head-to-head runs;
    // it too cannot separate them, and the deterministic order sends the
    // earlier attempt through.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(1);
    expect(selected?.payload).toEqual({ score: 7, margin: 0, rule: "fallback" });
    expect(rig.spawned["01-head-to-head"]).toBeDefined();
    expect(
      rig.spawnList.filter((c) => c.id === "01-head-to-head"),
    ).toHaveLength(1);
    expect(markerLine(poolDir, "01-head-to-head.md")).toContain(
      "id=01-head-to-head blocked-by=01 status=done",
    );
    expect(
      readEventLines(poolDir, "01-head-to-head").map((e) => e.kind),
    ).toEqual(["scheduled", "spawned", "exited"]);
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([1]);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .not.toBe(0);
    expect(run.final.log).toContain(
      "ticket 01: head-to-head 01-head-to-head tied",
    );
    expect(run.phase).toBe("quiescent");
  }, 15000);

  it("falls back when the head-to-head gives no usable pick", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
      // The judge writes no winner at all: an unusable pick decides
      // nothing, and the deterministic order owns the ticket.
      "01-head-to-head": { exitCode: 0 },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // A margin of 1 is below the outright bound; the head-to-head ran but
    // named no winner among the two attempts, so exactly one winner merges
    // by the deterministic order.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(1);
    expect(selected?.payload).toEqual({ score: 9, margin: 1, rule: "fallback" });
    expect(rig.spawned["01-head-to-head"]).toBeDefined();
    // The card still closes: the judge's lifecycle is over once its
    // outcome has been consumed, and an open card would hold Review shut.
    expect(markerLine(poolDir, "01-head-to-head.md")).toContain("status=done");
    expect(
      readEventLines(poolDir, "01-head-to-head").find(
        (e) => e.kind === "crash",
      )?.payload,
    ).toEqual({
      code: 0,
      reason: "outcome names no winner among the two attempts",
      logTail: [],
      outcomeExists: true,
    });
    expect(run.final.log).toContain(
      "ticket 01: head-to-head 01-head-to-head gave no usable pick: " +
        "outcome names no winner among the two attempts",
    );
    expect(events.filter((e) => e.kind === "merged")).toHaveLength(1);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .not.toBe(0);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .not.toBe(0);
    expect(run.phase).toBe("quiescent");
  }, 15000);

  it("decides nothing while a round holds a paused candidate", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { status: "checkpoint", outcome: { summary: "paused-1", commitSha: null } },
        attemptWork(2),
      ],
      "01-grader-2": grade(9),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Attempt 1 paused, so its round is not all done and selection never
    // runs, no matter how good the surviving candidate's grade is: the
    // ticket stays in-progress and its branch stays a candidate.
    const events = readEventLines(poolDir, "01");
    expect(events.some((e) => e.kind === "selected")).toBe(false);
    expect(events.some((e) => e.kind === "merged")).toBe(false);
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=in-progress");
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .toBe(0);
    expect(run.phase).toBe("stalled");
  }, 15000);

  it("spawns one head-to-head for a tight spread and merges its pick", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(3),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2), attemptWork(3)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
      "01-grader-3": grade(5),
      // The pairwise call disagrees with the raw scores: the runner-up
      // wins the head-to-head.
      "01-head-to-head": { winner: 2 },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The top two grades sit one point apart: exactly one head-to-head
    // ticket, an ordinary ticket on disk with the build ticket as its
    // blocker, and nothing else was spawned for the compare.
    expect(
      rig.spawnList.filter((c) => c.id === "01-head-to-head"),
    ).toHaveLength(1);
    expect(markerLine(poolDir, "01-head-to-head.md")).toContain(
      "id=01-head-to-head blocked-by=01 status=done",
    );

    // The judge saw both top attempts side by side: each side's outcome,
    // diff and trimmed log, and never the third attempt's artifacts.
    const h2h = rig.spawned["01-head-to-head"];
    expect(h2h.body).toContain("attempt 1");
    expect(h2h.body).toContain("attempt 2");
    expect(h2h.body).toContain(
      join(poolDir, "runs", "01.attempt-1.outcome.json"),
    );
    expect(h2h.body).toContain(
      join(poolDir, "runs", "01.attempt-2.outcome.json"),
    );
    expect(h2h.body).not.toContain(
      join(poolDir, "runs", "01.attempt-3.outcome.json"),
    );
    expect(h2h.body).toContain("01-head-to-head.attempt-1.diff.patch");
    expect(h2h.body).toContain("01-head-to-head.attempt-2.diff.patch");
    expect(h2h.outcomePath).toBe(
      join(poolDir, "runs", "01-head-to-head.outcome.json"),
    );
    // Each bound diff holds exactly its side's work.
    const diff1 = readFileSync(
      join(poolDir, "runs", "01-head-to-head.attempt-1.diff.patch"),
      "utf8",
    );
    expect(diff1).toContain("cand-1");
    expect(diff1).not.toContain("cand-2");
    const diff2 = readFileSync(
      join(poolDir, "runs", "01-head-to-head.attempt-2.diff.patch"),
      "utf8",
    );
    expect(diff2).toContain("cand-2");
    expect(diff2).not.toContain("cand-1");

    // The pick decides: the selected event records the head-to-head rule,
    // and attempt 2's branch merges through the existing merge path while
    // every loser's branch goes.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(2);
    expect(selected?.payload).toEqual({
      score: 8,
      margin: 1,
      rule: "head-to-head",
    });
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([2]);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(false);
    expect(existsSync(join(poolDir, "cand-3.txt"))).toBe(false);
    for (const i of [1, 2, 3]) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .not.toBe(0);
    }

    // The pool log narrates the spawn and the pick, the judge's outcome
    // landed, and the pool closed out through Review.
    expect(run.final.log).toContain(
      "ticket 01: margin 1 is below the outright band; spawning head-to-head " +
        "01-head-to-head between attempts 1 and 2",
    );
    expect(run.final.log).toContain(
      "ticket 01: head-to-head 01-head-to-head picked attempt 2",
    );
    expect(run.final.outcomes["01-head-to-head"]?.summary).toBe(
      "summary-01-head-to-head",
    );
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-grader-1": "done",
      "01-grader-2": "done",
      "01-grader-3": "done",
      "01-head-to-head": "done",
    });
    // The judge is an ordinary assignment: with no assign entry of its own
    // it inherits the build ticket's model.
    expect(h2h.model).toBe("stub-model");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
  }, 15000);

  it("resolves the head-to-head through the ordinary assign machinery", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "stub", model: "stub-model" },
        assign: {
          "01": { verify: 2, harness: "stub", model: "build-model" },
          // Model-only override: the harness still comes from the build.
          "01-head-to-head": { model: "h2h-model" },
        },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
      "01-head-to-head": { winner: 1 },
    });

    await runPool({ poolDir, harnesses: rig.harnesses });

    const h2h = rig.spawned["01-head-to-head"];
    expect(h2h.model).toBe("h2h-model");
    expect(h2h.harness).toBe("stub");
  }, 15000);

  it("serves the head-to-head the Assignment inherited from its build ticket on the snapshot", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "stub", model: "pool-default-model" },
        assign: {
          "01": { verify: 2, harness: "stub", model: "build-model" },
          // Model-only override: the harness still comes from the build.
          "01-head-to-head": { model: "h2h-model" },
        },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
      "01-head-to-head": { winner: 1 },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The judge's record carries the field-wise override over the build
    // ticket's assignment, not the pool defaults.
    const last = run.snapshots[run.snapshots.length - 1]!;
    expect(last.assignments["01-head-to-head"]).toEqual({
      harness: "stub",
      model: "h2h-model",
      drivers: "implement",
    });
  }, 15000);

  it("falls back to the higher raw score when the head-to-head ties", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(8),
      "01-grader-2": grade(9),
      "01-head-to-head": { winner: "tie" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The earlier attempt holds the lower score, so the tie's fallback
    // exercises the higher-raw-score clause, not the earlier-attempt one.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(2);
    expect(selected?.payload).toEqual({ score: 9, margin: 1, rule: "fallback" });
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([2]);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .not.toBe(0);
    expect(run.phase).toBe("quiescent");
  }, 15000);

  it("closes a superseded head-to-head card left ready by an earlier round", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: verifyConfig(2),
    });
    // A head-to-head card a previous round left behind, reset to ready by a
    // review reject of its build ticket; this round's grades decide
    // outright, so nothing rewrites it and the engine closes it instead.
    writeFileSync(
      join(poolDir, "issues", "01-head-to-head.md"),
      "<!-- state: id=01-head-to-head blocked-by=01 status=ready -->\n\n" +
        "# 01-head-to-head\n",
    );
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(5),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The stale card never ran and never entered a super-step, but the
    // selection closed it done: an open engine card would hold Review's
    // all-done check shut forever.
    expect(rig.spawned["01-head-to-head"]).toBeUndefined();
    expect(markerLine(poolDir, "01-head-to-head.md")).toContain("status=done");
    expect(run.final.tickets["01-head-to-head"]).toBe("done");
    expect(run.final.log).toContain(
      "ticket 01: closed superseded head-to-head card 01-head-to-head " +
        "(this round's selection did not need it)",
    );
    expect(run.phase).toBe("quiescent");
  }, 15000);
});

describe("verify human selection", () => {
  const humanConfig = (n: number): PoolConfig => ({
    ...stubConfig,
    selection: "human",
    assign: { "01": { verify: n } },
  });
  const grade = (score: number, reasons = `scored ${score}`) => ({
    grade: { score, verdict: "pass" as const, reasons },
  });
  const attemptWork = (n: number) => ({
    workFile: `cand-${n}.txt`,
    commitMsg: `cand-${n}`,
  });

  it("keeps the absent key automatic: selection without any interrupt", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, assign: { "01": { verify: 2 } } },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The engine selects on its own: the winner merges in the same
    // super-step and the only interrupt the pool ever raises is Review.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const events = readEventLines(poolDir, "01");
    expect(events.find((e) => e.kind === "selected")?.attempt).toBe(1);
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([1]);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 1)]).exitCode)
      .not.toBe(0);
  }, 15000);

  it("raises the selection interrupt with every grade when selection is human", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: humanConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9, "crisp edges and honest tests"),
      "01-grader-2": grade(8, "works but the tests are thin"),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The interrupt carries both candidates' grades and the grader's
    // reasons; nothing has merged and the ticket waits, in-progress, for
    // the human.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    expect(run.interrupts[0]?.kind).toBe("selection");
    expect(run.interrupts[0]?.body).toContain("attempt 1: score 9/10");
    expect(run.interrupts[0]?.body).toContain("attempt 2: score 8/10");
    expect(run.interrupts[0]?.body).toContain("crisp edges and honest tests");
    expect(run.interrupts[0]?.body).toContain("works but the tests are thin");
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=in-progress");
    const events = readEventLines(poolDir, "01");
    expect(events.some((e) => e.kind === "selected")).toBe(false);
    expect(events.some((e) => e.kind === "merged")).toBe(false);
    for (const i of [1, 2]) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .toBe(0);
    }
  }, 15000);

  it("merges the attempt the answer names and discards the rest", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: humanConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    const finished = await approveReview(await run.resume("01", "attempt 2"));

    // The human's pick, not the top score: the selected event records the
    // rule, the named attempt's branch merged, the other is gone.
    const events = readEventLines(poolDir, "01");
    const selected = events.find((e) => e.kind === "selected");
    expect(selected?.attempt).toBe(2);
    expect(selected?.payload).toEqual({ score: null, margin: null, rule: "human" });
    expect(
      events.filter((e) => e.kind === "merged").map((e) => e.attempt),
    ).toEqual([2]);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(false);
    for (const i of [1, 2]) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .not.toBe(0);
    }
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(finished.phase).toBe("done");
    expect(finished.final.outcomes["01"]?.summary).toBe("summary-01");
  }, 15000);

  it("rejects an answer naming no candidate with a clear error, merging nothing", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: humanConfig(2),
    });
    const rig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // An unknown attempt, then a note with no number at all: both fail with
    // the valid attempts named, and neither leaves a mark.
    await expect(run.resume("01", "9")).rejects.toThrow(
      /candidate attempts \(1, 2\); got "9"/,
    );
    await expect(run.resume("01", "you pick")).rejects.toThrow(
      /candidate attempts \(1, 2\); got "you pick"/,
    );
    expect(readEventLines(poolDir, "01").some((e) => e.kind === "merged"))
      .toBe(false);
    for (const i of [1, 2]) {
      expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", i)]).exitCode)
        .toBe(0);
    }
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["selection"]);

    // A valid answer after the rejections goes straight through.
    const finished = await approveReview(await run.resume("01", "attempt 1"));
    expect(finished.phase).toBe("done");
    expect(
      readEventLines(poolDir, "01")
        .filter((e) => e.kind === "merged")
        .map((e) => e.attempt),
    ).toEqual([1]);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01", 2)]).exitCode)
      .not.toBe(0);
  }, 15000);

  it("keeps the selection interrupt pending and answerable across a restart", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: humanConfig(2),
    });
    const firstRig = gitStubHarness(poolDir, {
      "01": [attemptWork(1), attemptWork(2)],
      "01-grader-1": grade(9),
      "01-grader-2": grade(8),
    });
    const first = await runPool({ poolDir, harnesses: firstRig.harnesses });
    expect(first.phase).toBe("quiescent");
    expect(first.interrupts.map((i) => i.kind)).toEqual(["selection"]);
    const body = first.interrupts[0]?.body;
    first.close();

    // A restart brings the interrupt back exactly as it was, spawns
    // nothing, and the answer still merges.
    const rig = gitStubHarness(poolDir, {});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(second.phase).toBe("quiescent");
    expect(second.interrupts).toHaveLength(1);
    expect(second.interrupts[0]?.kind).toBe("selection");
    expect(second.interrupts[0]?.body).toBe(body);
    expect(rig.spawnOrder).toEqual([]);

    const finished = await approveReview(await second.resume("01", "1"));
    expect(finished.phase).toBe("done");
    expect(
      readEventLines(poolDir, "01")
        .filter((e) => e.kind === "merged")
        .map((e) => e.attempt),
    ).toEqual([1]);
    expect(existsSync(join(poolDir, "cand-1.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "cand-2.txt"))).toBe(false);
  }, 15000);

  it("leaves a verify: 1 ticket's grade-decides path alone under selection: human", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: humanConfig(1),
    });
    const rig = gitStubHarness(poolDir, {
      "01": attemptWork(1),
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // One candidate is no selection: the pass verdict completes the ticket
    // the way ticket 05 built it, with no interrupt and no selected event.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const events = readEventLines(poolDir, "01");
    expect(events.some((e) => e.kind === "selected")).toBe(false);
    expect(events.some((e) => e.kind === "merged")).toEqual(true);
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
  }, 15000);

  it("rejects an invalid selection value at pool load", async () => {
    const config = JSON.parse(
      JSON.stringify({ ...stubConfig, selection: "maybe" }),
    ) as PoolConfig;
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config,
    });
    await expect(
      runPool({ poolDir, harnesses: gitStubHarness(poolDir, {}).harnesses }),
    ).rejects.toThrow(/selection must be "auto" or "human"/);
  });
});

describe("super-steps", () => {
  it("runs independent ready tickets as one super-step and terminates done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(Object.keys(rig.spawned).sort()).toEqual(["01", "02"]);
    expect(
      run.final.log.some((line) => line === "super-step 1: 01, 02"),
    ).toBe(true);
    expect(run.final.log.at(-1)).toBe("pool done: every ticket reached done");

    const markers = ["01-a.md", "02-b.md"].map(
      (file) =>
        Bun.file(join(poolDir, "issues", file))
          .text()
          .then((text) => text.split("\n")[0]),
    );
    for (const marker of await Promise.all(markers)) {
      expect(marker).toContain("status=done");
    }
  });

  it("keeps a ticket waiting until every blocker is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.log).toContain("super-step 1: 01");
    expect(run.final.log).toContain("super-step 2: 02");
    expect(
      run.snapshots.some(
        (snapshot) =>
          snapshot.state.tickets["01"] === "in-progress" &&
          snapshot.state.tickets["02"] === "ready",
      ),
    ).toBe(true);
  });

  it("runs the ready set against one shared starting snapshot", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.log).toContain("super-step 2: 02, 03");
    expect(rig.spawned["02"].body).toContain("summary-01");
    expect(rig.spawned["03"].body).toContain("summary-01");
    expect(rig.spawned["02"].body).not.toContain("summary-03");
    expect(rig.spawned["03"].body).not.toContain("summary-02");
    expect(Object.keys(run.final.outcomes).sort()).toEqual([
      "01",
      "02",
      "03",
    ]);
  });
});

// The spawn pump grace: a harness child that exits while a grandchild still
// holds its stdout pipe would park the drive forever on an EOF that never
// comes. The teardown bound turns the parked wait into a bounded drain, and
// the drive proceeds to the next super-step.
describe("spawn pump teardown", () => {
  it("returns from a child whose grandchild holds its stdout pipe and runs the next super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const holderPath = join(poolDir, "pipe-holder.sh");
    writeFileSync(
      holderPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome_path="$1"',
        // The grandchild inherits the harness's stdout, writes one line
        // inside the grace window, then outlives the run on purpose: an
        // unbounded pump would park on its open pipe and blow the time
        // bound below.
        "bash -c 'sleep 0.3; echo late-output-from-grandchild; sleep 30' &",
        'printf \'%s\' \'{"status":"done","summary":"held the pipe","commitSha":"sha-01"}\' > "$outcome_path"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const rig = stubHarness({});
    const harnesses: Record<string, HarnessCommand> = {
      stub: (ctx) =>
        ctx.id === "01"
          ? ["bash", holderPath, ctx.outcomePath]
          : rig.harnesses.stub(ctx),
    };

    const started = Date.now();
    const first = await runPool({ poolDir, harnesses });
    // The bounded grace, not the grandchild's patience, returns the spawn:
    // an unbounded pump would sit on the still-open pipe for the 30s the
    // grandchild lives.
    expect(Date.now() - started).toBeLessThan(10_000);

    const run = await approveReview(first);

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.final.log).toContain("super-step 2: 02");
    // The grandchild's line landed inside the grace window, so the attempt
    // log still captured it.
    expect(readFileSync(join(poolDir, "runs", "01.log"), "utf8")).toContain(
      "late-output-from-grandchild",
    );
  }, 15000);
});

describe("ticket events", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  it("records a checkpoint and resume in order, numbering attempts per ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    const resumed = await run.resume("01", "the name is Foo");
    const done = await approveReview(resumed);
    expect(done.phase).toBe("done");

    const events = readEventsFile(poolDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(events.filter((e) => e.attempt === 1).map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
    ]);
    expect(events.filter((e) => e.attempt === 2).map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    // The exited event carries the exit code, the status from the attempt's
    // outcome JSON, and the exit facts (ADR-0012).
    const exited = events.filter((e) => e.kind === "exited");
    expect(exited[0].payload).toEqual({
      code: 0,
      status: "checkpoint",
      logTail: [],
      outcomeExists: true,
    });
    expect(exited[1].payload).toEqual({
      code: 0,
      status: "done",
      logTail: [],
      outcomeExists: true,
    });

    // The blocked ticket ran once, cleanly.
    const events02 = readEventsFile(poolDir, "02");
    expect(events02.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(events02.map((e) => e.attempt)).toEqual([1, 1, 1]);
  });

  it("records a crash and its answer, carrying the exit code", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["keep", "done"], exitCodes: [3, 0] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");

    const crash = readEventsFile(poolDir, "01");
    expect(crash.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(crash.at(-1)?.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
      logTail: [],
      outcomeExists: false,
    });

    const resumed = await run.resume("01");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const answered = readEventsFile(poolDir, "01");
    expect(answered.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
      "answered",
      "scheduled",
      "spawned",
      "exited",
    ]);
  });

  it("records a deadlock raise and clear for a blocked cycle", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual([
      "deadlock",
      "deadlock",
    ]);

    const deadlock01 = readEventsFile(poolDir, "01");
    expect(deadlock01.map((e) => e.kind)).toEqual(["deadlock"]);
    expect(deadlock01[0].attempt).toBe(0);
    expect(deadlock01[0].payload).toEqual({ blockers: ["02"] });

    writeFileSync(
      join(poolDir, "issues", "02-b.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n",
    );
    await run.resume("02", "broke the cycle");

    // 01 stays deadlocked until it can complete; once 02 is done and 01 runs,
    // the cleared deadlock lands in the record.
    const cleared01 = readEventsFile(poolDir, "01");
    expect(cleared01.map((e) => e.kind)).toEqual([
      "deadlock",
      "scheduled",
      "spawned",
      "exited",
      "deadlock-cleared",
    ]);
  });

  it("records a review-reject reset against the rejected ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const rejected = await run.reject(REVIEW_TICKET_ID, "redo 01");
    expect(rejected.phase).toBe("quiescent");

    const events = readEventsFile(poolDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "review-reject",
      "scheduled",
      "spawned",
      "exited",
    ]);
  });
});

describe("attempt log rotation", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(
      join(poolDir, "runs", `${id}.events.jsonl`),
      "utf8",
    );
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  it("rotates the raw log to its attempt-numbered name before a re-run writes", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    // A harness that stamps each spawn into the log so the rotated file and
    // the well-known path hold distinguishable content.
    const script = join(poolDir, "stamp-stub.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'status="$1"; stamp="$2"; outcome_path="$3"',
        'echo "attempt-output-$stamp"',
        'printf \'{"status":"%s","summary":"s","commitSha":null}\' "$status" > "$outcome_path"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    let spawn = 0;
    const harness: HarnessCommand = (ctx) => {
      spawn += 1;
      const status = spawn === 1 ? "checkpoint" : "done";
      return ["bash", script, status, String(spawn), ctx.outcomePath];
    };

    const run = await runPool({ poolDir, harnesses: { stub: harness } });
    const resumed = await run.resume("01", "go on");
    const done = await approveReview(resumed);
    expect(done.phase).toBe("done");

    // Attempt 1's output rotated away, attempt 2's at the long-standing path.
    const rotated = readFileSync(join(poolDir, "runs", "01.attempt-1.log"), "utf8");
    expect(rotated).toContain("attempt-output-1");
    const live = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(live).toContain("attempt-output-2");
    // The events file records both attempts, agreeing with the rotated names.
    const events = readEventsFile(poolDir, "01");
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 1)).toBe(true);
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 2)).toBe(true);
  });
});

describe("channels", () => {
  it("lands outcomes in the channel and injects them into downstream prompts", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { outcome: { summary: "built the schema", commitSha: "abc123" } },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.outcomes["01"]).toEqual({
      status: "done",
      summary: "built the schema",
      commitSha: "abc123",
    });
    expect(rig.spawned["02"].body).toContain("01: built the schema");
    expect(rig.spawned["02"].body).toContain("abc123");
  });

  it("appends to the log channel across super-steps", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    const superSteps = run.final.log.filter((line) =>
      line.startsWith("super-step"),
    );
    expect(superSteps).toEqual(["super-step 1: 01", "super-step 2: 02"]);
  });

  it("exposes console.json as the static config channel", async () => {
    const config: PoolConfig = {
      defaults: { harness: "stub", model: "stub-model" },
      roster: "- deepseek: general-purpose subagent",
    };
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.config).toEqual(config);
  });
});

describe("glued prompt", () => {
  it("glues AGENT.md, chain, and roster in run.sh's shape, without a driver line", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: {
        defaults: { harness: "stub", model: "stub-model" },
        assign: { "01": { drivers: "implement code-review" } },
        roster: "- deepseek: general-purpose subagent",
      },
      agentMd: "# Runner agent instructions\n\nDo the thing.",
    });
    const rig = stubHarness({});

    await runPool({ poolDir, harnesses: rig.harnesses });

    const body = rig.spawned["01"].body;
    expect(body).toContain("Standing instructions for this job:");
    expect(body).toContain("Do the thing.");
    expect(body).toContain("dispatch these subagents in this order");
    expect(body).toContain("code-review");
    expect(body).toContain("The subagent roster for this job");
    expect(body).toContain("deepseek: general-purpose subagent");
    expect(body).toContain("outcome.json");
    // The outcome instruction teaches the new contract: a required status,
    // and the engine, not the agent, owning the Issue's status write.
    expect(body).toContain('"status": "done" or "checkpoint"');
    expect(body).toContain("Never edit the Issue's line-1 status marker");
    // The driver invocation line belongs to the adapters now; the body the
    // engine passes carries it nowhere, so a prompt change cannot break a
    // harness that assembles its own invocation.
    expect(body).not.toContain("/implement");
  });

  it("re-reads AGENT.md at every spawn, so a mid-run edit reaches the next attempt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
      agentMd: "version one instructions",
    });
    const rig = stubHarness({});
    const harnesses = {
      stub: (ctx: SpawnContext) => {
        // 01's prompt is already built when its argv is assembled, so this
        // edit can only reach 02's spawn if AGENT.md is read fresh then.
        if (ctx.id === "01") {
          writeFileSync(join(poolDir, "AGENT.md"), "version two instructions");
        }
        return rig.harnesses.stub(ctx);
      },
    };

    await runPool({ poolDir, harnesses });

    expect(rig.spawned["01"].body).toContain("version one instructions");
    expect(rig.spawned["02"].body).toContain("version two instructions");
    expect(rig.spawned["02"].body).not.toContain("version one instructions");
  });

  it("spawns with stdin closed and writes a per-ticket log to runs/", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    await runPool({ poolDir, harnesses: rig.harnesses });

    const logText = await Bun.file(join(poolDir, "runs", "01.log")).text();
    expect(typeof logText).toBe("string");
  });
});

describe("harness CLIs", () => {
  // Fake CLI binaries on PATH exercise the real default harnesses: the
  // engine resolves the console.json harness name to a binary and launches
  // it in the shape run.sh proved. Each fake records its argv one argument
  // per file (argv.0, argv.1, ...) so assertions see exact strings, newline-
  // carrying prompts included. The fake learns where to write its outcome
  // JSON from an env var, never by parsing the prompt, so no test depends on
  // the prompt's format.

  interface FakeCli {
    binDir: string;
    recordDir: string;
  }

  function fakeCli(
    poolDir: string,
    binary: string,
    opts: { writeOutcome?: boolean; exitCode?: number } = {},
  ): FakeCli {
    const binDir = join(poolDir, "bin");
    const recordDir = join(poolDir, "record");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(binDir, binary),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'out="$FAKE_RECORD_DIR"',
        "i=0",
        'for a in "$@"; do printf \'%s\' "$a" > "$out/argv.$i"; i=$((i+1)); done',
        // Distinguish a closed stdin (instant EOF, what the engine sets up)
        // from an open one (the read would block until the timeout).
        "start=$SECONDS",
        "if read -t 2 _line; then stdin=data",
        "elif [ $((SECONDS - start)) -ge 2 ]; then stdin=open",
        "else stdin=eof; fi",
        'printf \'%s\' "$stdin" > "$out/stdin"',
        ...(opts.writeOutcome ?? true
          ? [
              'printf \'{"status":"done","summary":"fake","commitSha":null}\' > "$FAKE_OUTCOME_REL"',
            ]
          : []),
        `echo "fake ${binary} ran"`,
        `exit ${opts.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, binary), 0o755);
    return { binDir, recordDir };
  }

  function recordedArgs(recordDir: string): string[] {
    const args: string[] = [];
    for (let i = 0; ; i++) {
      const path = join(recordDir, `argv.${i}`);
      if (!existsSync(path)) break;
      args.push(readFileSync(path, "utf8"));
    }
    return args;
  }

  async function withFakePath(
    fake: FakeCli,
    fn: () => Promise<void>,
  ): Promise<void> {
    const originalPath = process.env.PATH;
    const originalRecord = process.env.FAKE_RECORD_DIR;
    const originalOutcome = process.env.FAKE_OUTCOME_REL;
    process.env.PATH = `${fake.binDir}:${originalPath}`;
    process.env.FAKE_RECORD_DIR = fake.recordDir;
    process.env.FAKE_OUTCOME_REL = "runs/01.outcome.json";
    try {
      await fn();
    } finally {
      process.env.PATH = originalPath;
      if (originalRecord === undefined) delete process.env.FAKE_RECORD_DIR;
      else process.env.FAKE_RECORD_DIR = originalRecord;
      if (originalOutcome === undefined) delete process.env.FAKE_OUTCOME_REL;
      else process.env.FAKE_OUTCOME_REL = originalOutcome;
    }
  }

  function oneTicketPool(
    harness: string,
    model: string,
    extra?: Partial<PoolConfig>,
  ): string {
    return makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: { defaults: { harness, model }, ...extra },
      agentMd: "# Runner agent instructions\n\nDo the thing.",
    });
  }

  // A fake stream-json CLI: the same argv recording as fakeCli, plus a
  // caller-written stdout script, so a test can stream canned JSONL
  // progressively, hold the pipe open, or die mid-run.
  function streamingFakeCli(
    poolDir: string,
    scriptBody: string[],
  ): FakeCli {
    const binDir = join(poolDir, "bin");
    const recordDir = join(poolDir, "record");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'out="$FAKE_RECORD_DIR"',
        "i=0",
        'for a in "$@"; do printf \'%s\' "$a" > "$out/argv.$i"; i=$((i+1)); done',
        ...scriptBody,
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "claude"), 0o755);
    return { binDir, recordDir };
  }

  const streamAssistantLine = (text: string): string =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
  const streamToolLine = (
    name: string,
    input: Record<string, unknown>,
  ): string =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input }] },
    });

  function readAttemptFile(poolDir: string, name: string): string {
    return readFileSync(join(poolDir, "runs", name), "utf8");
  }

  it("streams a claude attempt: tees the raw stream verbatim and derives the log live", async () => {
    const systemLine = '{"type":"system","subtype":"init"}';
    const poolDir = oneTicketPool("claude", "claude-test");
    const fake = streamingFakeCli(poolDir, [
      `echo '${systemLine}'`,
      `echo '${streamAssistantLine("Reading the ticket.")}'`,
      `echo '${streamToolLine("Bash", { command: "bun test engine/" })}'`,
      "echo 'this is not json at all'",
      'touch "$out/first-burst"',
      // Hold the pipe open so the test reads the log mid-run, then finish.
      'while [ ! -f "$out/release" ]; do sleep 0.02; done',
      `echo '${streamAssistantLine("All done.")}'`,
      'printf \'{"status":"done","summary":"fake","commitSha":null}\' > "$FAKE_OUTCOME_REL"',
    ]);

    let run: Awaited<ReturnType<typeof runPool>> | undefined;
    await withFakePath(fake, async () => {
      const pending = runPool({ poolDir });
      await waitFor(() => existsSync(join(fake.recordDir, "first-burst")));
      // The fake is still running, blocked on the release file: the derived
      // log already shows the first burst, in arrival order, live.
      await waitFor(() => {
        if (!existsSync(join(poolDir, "runs", "01.log"))) return false;
        const text = readAttemptFile(poolDir, "01.log");
        return (
          text.includes("Reading the ticket.") &&
          text.includes("[tool] Bash: bun test engine/") &&
          text.includes("this is not json at all")
        );
      });
      writeFileSync(join(fake.recordDir, "release"), "go");
      run = await approveReview(await pending);
    });

    expect(run!.phase).toBe("done");
    // The derived log: unparseable lines pass through, recognized
    // nothing-to-say events (the system init) leave no line, assistant text
    // is verbatim, the tool call is one [tool] line.
    expect(readAttemptFile(poolDir, "01.log")).toBe(
      [
        "Reading the ticket.",
        "[tool] Bash: bun test engine/",
        "this is not json at all",
        "All done.",
        "",
      ].join("\n"),
    );
    // The Stream file holds the raw stream bytes verbatim.
    expect(readAttemptFile(poolDir, "01.stream.jsonl")).toBe(
      [
        systemLine,
        streamAssistantLine("Reading the ticket."),
        streamToolLine("Bash", { command: "bun test engine/" }),
        "this is not json at all",
        streamAssistantLine("All done."),
        "",
      ].join("\n"),
    );
  });

  it("keeps a killed attempt's log and stream file up to the kill", async () => {
    const poolDir = oneTicketPool("claude", "claude-test");
    const fake = streamingFakeCli(poolDir, [
      `echo '${streamAssistantLine("before the kill")}'`,
      `echo '${streamToolLine("Bash", { command: "sleep 100" })}'`,
      'touch "$out/kill-burst"',
      // Hold the pipe so the test proves mid-run readability, then die hard,
      // the way a kill or an OOM takes an attempt down.
      'while [ ! -f "$out/kill-release" ]; do sleep 0.02; done',
      "kill -9 $$",
    ]);

    let run: Awaited<ReturnType<typeof runPool>> | undefined;
    await withFakePath(fake, async () => {
      const pending = runPool({ poolDir });
      await waitFor(() => existsSync(join(fake.recordDir, "kill-burst")));
      await waitFor(() => {
        if (!existsSync(join(poolDir, "runs", "01.log"))) return false;
        return readAttemptFile(poolDir, "01.log").includes(
          "[tool] Bash: sleep 100",
        );
      });
      // The fake is still alive here: the log was readable mid-run. Now the
      // kill, and everything emitted before it survives in arrival order.
      writeFileSync(join(fake.recordDir, "kill-release"), "go");
      run = await pending;
    });

    expect(run!.phase).toBe("quiescent");
    expect(run!.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(readAttemptFile(poolDir, "01.log")).toBe(
      ["before the kill", "[tool] Bash: sleep 100", ""].join("\n"),
    );
    expect(readAttemptFile(poolDir, "01.stream.jsonl")).toBe(
      [
        streamAssistantLine("before the kill"),
        streamToolLine("Bash", { command: "sleep 100" }),
        "",
      ].join("\n"),
    );
    const events = readEventLines(poolDir, "01");
    expect(events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(events.find((e) => e.kind === "exited")?.payload.code).toBe(137);
  });

  it("rotates both the log and the stream file on a re-run", async () => {
    const poolDir = oneTicketPool("claude", "claude-test");
    const fake = streamingFakeCli(poolDir, [
      'if [ -f "$out/ran-once" ]; then',
      `  echo '${streamAssistantLine("second run text")}'`,
      '  printf \'{"status":"done","summary":"fake","commitSha":null}\' > "$FAKE_OUTCOME_REL"',
      "else",
      '  touch "$out/ran-once"',
      `  echo '${streamAssistantLine("first run text")}'`,
      "  exit 1",
      "fi",
    ]);

    let run: Awaited<ReturnType<typeof runPool>> | undefined;
    await withFakePath(fake, async () => {
      const crashed = await runPool({ poolDir });
      expect(crashed.phase).toBe("quiescent");
      const resumed = await crashed.resume("01", "go again");
      run = await approveReview(resumed);
    });
    expect(run!.phase).toBe("done");

    // Attempt 1's log and Stream file rotated away together; attempt 2's
    // sit at the well-known paths.
    expect(readAttemptFile(poolDir, "01.attempt-1.log")).toBe(
      "first run text\n",
    );
    expect(readAttemptFile(poolDir, "01.attempt-1.stream.jsonl")).toBe(
      `${streamAssistantLine("first run text")}\n`,
    );
    expect(readAttemptFile(poolDir, "01.log")).toBe("second run text\n");
    expect(readAttemptFile(poolDir, "01.stream.jsonl")).toBe(
      `${streamAssistantLine("second run text")}\n`,
    );
    const events = readEventLines(poolDir, "01");
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 1)).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "spawned" && e.attempt === 2)).toBe(
      true,
    );
  });

  it("spawns the console.json-assigned claude CLI with stdin closed and the unattended permission mode", async () => {
    const agents =
      '{"deepseek":{"description":"General-purpose subagent","prompt":"Do the reading.","model":"deepseek"}}';
    const poolDir = oneTicketPool("claude", "claude-test", { agents });
    const fake = fakeCli(poolDir, "claude");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(
      argv[1].startsWith(
        `/implement ${join(poolDir, "issues", "01-a.md")}\n`,
      ),
    ).toBe(true);
    expect(argv[1]).toContain("Standing instructions for this job:");
    expect(argv.slice(2)).toEqual([
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
      "--agents",
      agents,
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
    const logText = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(logText).toContain("fake claude ran");
  });

  it("drives opencode through --command with the bare driver name and the issue path leading the message", async () => {
    const poolDir = oneTicketPool("opencode", "opencode-test");
    const fake = fakeCli(poolDir, "opencode");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("run");
    expect(argv[1]).toBe("--command");
    expect(argv[2]).toBe("implement");
    expect(
      argv[3].startsWith(`${join(poolDir, "issues", "01-a.md")}\n`),
    ).toBe(true);
    expect(argv[3]).toContain("Standing instructions for this job:");
    expect(argv[3]).not.toContain("/implement");
    expect(argv.slice(4)).toEqual(["--model", "opencode-test", "--auto"]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
  });

  it("launches cursor's agent CLI with the documented flags (run against the real Cursor Agent CLI)", async () => {
    const poolDir = oneTicketPool("cursor", "cursor-test");
    const fake = fakeCli(poolDir, "agent");

    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(fake, async () => {
      run = await approveReview(await runPool({ poolDir }));
    });

    expect(run!.phase).toBe("done");
    const argv = recordedArgs(fake.recordDir);
    expect(argv[0]).toBe("-p");
    expect(
      argv[1].startsWith(
        `/implement ${join(poolDir, "issues", "01-a.md")}\n`,
      ),
    ).toBe(true);
    expect(argv.slice(2)).toEqual([
      "--model",
      "cursor-test",
      "--force",
      "--trust",
      "--output-format",
      "stream-json",
    ]);
    expect(readFileSync(join(fake.recordDir, "stdin"), "utf8")).toBe("eof");
  });

  it("records the real adapter's spawn facts on the spawned event", async () => {
    const poolDir = oneTicketPool("claude", "claude-test");
    const fake = fakeCli(poolDir, "claude");

    await withFakePath(fake, async () => {
      await runPool({ poolDir });
    });

    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    expect(spawned.payload.cwd).toBe(poolDir);
    expect(spawned.payload.branch).toBeNull();
    expect(spawned.payload.commitSha).toBeNull();
    expect(spawned.payload.env).toEqual({ PWD: poolDir });
    // The real claude adapter's argv, with the prompt body elided: the
    // driver line and the issue reference stay, the prompt becomes the
    // placeholder.
    expect(spawned.payload.argv).toEqual([
      "claude",
      "-p",
      `/implement ${join(poolDir, "issues", "01-a.md")}\n\n<prompt>`,
      "--model",
      "claude-test",
      "--permission-mode",
      "auto",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("drives status from the outcome JSON a spawned CLI writes, done or absent alike", async () => {
    const doneDir = oneTicketPool("claude", "claude-test");
    const doneFake = fakeCli(doneDir, "claude");
    let run: Awaited<ReturnType<typeof runPool>>;
    await withFakePath(doneFake, async () => {
      run = await approveReview(await runPool({ poolDir: doneDir }));
    });
    expect(run!.phase).toBe("done");
    expect(run!.final.tickets["01"]).toBe("done");
    // The fake never touched the Issue: the engine wrote the done marker
    // itself from the outcome.
    expect(markerLine(doneDir, "01-a.md")).toContain("status=done");

    const crashDir = oneTicketPool("claude", "claude-test");
    const crashFake = fakeCli(crashDir, "claude", {
      writeOutcome: false,
      exitCode: 1,
    });
    await withFakePath(crashFake, async () => {
      run = await runPool({ poolDir: crashDir });
    });
    expect(run!.phase).toBe("quiescent");
    expect(run!.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body:
          join(crashDir, "runs", "01.log") +
          "\n\n" +
          "fake claude ran\n\n" +
          "outcome file: " +
          join(crashDir, "runs", "01.outcome.json") +
          " (missing)\n",
      },
    ]);
    expect(markerLine(crashDir, "01-a.md")).toContain("status=in-progress");
  });
});

describe("streamed logs at every spawn site", () => {
  // A stub harness registered under the streamed name "claude", so every
  // spawn site that resolves it exercises the stream pump. The script emits
  // one recognizable assistant text event, one tool call, and one
  // unparseable line, then writes its outcome: the same three-way derivation
  // at every site, with the site's own file names.
  const DERIVED_LOG = [
    "stub text",
    "[tool] Bash: ls -la",
    "stub raw line",
    "",
  ].join("\n");
  const RAW_STREAM = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"stub text"}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}',
    "stub raw line",
    "",
  ].join("\n");

  function streamedStub(
    behaviour: Record<string, { outcome?: unknown; exitCode?: number }> = {},
  ): { harnesses: Record<string, HarnessCommand>; spawned: Record<string, SpawnContext> } {
    const poolLocal = tempDirs[tempDirs.length - 1];
    const stubPath = join(poolLocal, "streamed-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome_path="$1"; outcome_json="$2"; exit_code="$3"',
        'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"stub text"}]}}\'',
        'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}\'',
        "echo 'stub raw line'",
        'if [ -n "$outcome_json" ]; then printf \'%s\' "$outcome_json" > "$outcome_path"; fi',
        'exit "$exit_code"',
        "",
      ].join("\n"),
    );
    const spawned: Record<string, SpawnContext> = {};
    const harness: HarnessCommand = (ctx) => {
      spawned[ctx.id] = ctx;
      const b = behaviour[ctx.id] ?? {};
      return [
        "bash",
        stubPath,
        ctx.outcomePath,
        b.outcome !== undefined ? JSON.stringify(b.outcome) : "",
        String(b.exitCode ?? 0),
      ];
    };
    return { harnesses: { claude: harness }, spawned };
  }

  it("streams an implement attempt on the well-known paths", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { defaults: { harness: "claude", model: "claude-model" } },
    });
    const rig = streamedStub({
      "01": { outcome: { status: "done", summary: "built", commitSha: "sha" } },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(readFileSync(join(poolDir, "runs", "01.log"), "utf8")).toBe(
      DERIVED_LOG,
    );
    expect(
      readFileSync(join(poolDir, "runs", "01.stream.jsonl"), "utf8"),
    ).toBe(RAW_STREAM);
  });

  it("streams the resolver run beside its resolver log", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: { ...stubConfig, resolver: "claude" },
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = streamedStub({
      "02": { outcome: { resolved: true, note: "kept both lines" } },
    });

    // 02's merge conflicts and the resolver runs, so the pool pauses on the
    // merge hold (ADR-0014) with the approval interrupt pending: it never
    // settles until the merge is answered, so observe the held state instead
    // of awaiting a settle.
    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    // The resolver's streamed run sits beside the resolver log, under the
    // resolver naming variants.
    expect(
      readFileSync(join(poolDir, "runs", "02.resolver.stream.jsonl"), "utf8"),
    ).toBe(RAW_STREAM);
    expect(
      readFileSync(join(poolDir, "runs", "02.resolver.log"), "utf8"),
    ).toBe(DERIVED_LOG);
  }, 15000);

  it("streams grader runs and keeps the grader artifacts working", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "claude", model: "claude-model" },
        assign: { "01": { verify: 1 } },
      },
    });
    const rig = streamedStub({
      "01": { outcome: { status: "done", summary: "built", commitSha: "sha" } },
      "01-grader-1": {
        outcome: {
          status: "done",
          summary: "graded",
          commitSha: null,
          grade: { score: 8, verdict: "pass", reasons: "good work" },
        },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.tickets["01"]).toBe("done");
    // The verify attempt's log and Stream file are attempt-numbered.
    expect(
      readFileSync(join(poolDir, "runs", "01.attempt-1.log"), "utf8"),
    ).toBe(DERIVED_LOG);
    expect(
      readFileSync(join(poolDir, "runs", "01.attempt-1.stream.jsonl"), "utf8"),
    ).toBe(RAW_STREAM);
    // The grader's own run is streamed on the grader id's paths.
    expect(
      readFileSync(join(poolDir, "runs", "01-grader-1.log"), "utf8"),
    ).toBe(DERIVED_LOG);
    expect(
      readFileSync(join(poolDir, "runs", "01-grader-1.stream.jsonl"), "utf8"),
    ).toBe(RAW_STREAM);
    // The trimmed log artifact still exists and carries the derived text.
    const trim = readFileSync(
      join(poolDir, "runs", "01-grader-1.trim.log"),
      "utf8",
    );
    expect(trim).toContain("stub text");
    expect(trim).toContain("[tool] Bash: ls -la");
  });

  it("streams the head-to-head judge run and keeps its side artifacts working", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "claude", model: "claude-model" },
        assign: { "01": { verify: 2 } },
      },
    });
    const grade = (score: number) => ({
      status: "done",
      summary: "graded",
      commitSha: null,
      grade: { score, verdict: "pass", reasons: "fine" },
    });
    const rig = streamedStub({
      "01": { outcome: { status: "done", summary: "one", commitSha: "sha-1" } },
      "01-grader-1": { outcome: grade(8) },
      "01-grader-2": { outcome: grade(7) },
      "01-head-to-head": {
        outcome: { status: "done", summary: "picked", commitSha: null, winner: 1 },
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.tickets["01"]).toBe("done");
    // The one-point margin called the head-to-head ticket, and its run is
    // streamed on the head-to-head id's paths.
    expect(
      readFileSync(join(poolDir, "runs", "01-head-to-head.log"), "utf8"),
    ).toBe(DERIVED_LOG);
    expect(
      readFileSync(join(poolDir, "runs", "01-head-to-head.stream.jsonl"), "utf8"),
    ).toBe(RAW_STREAM);
    // The per-side trimmed logs still exist.
    expect(
      existsSync(join(poolDir, "runs", "01-head-to-head.attempt-1.trim.log")),
    ).toBe(true);
    expect(
      existsSync(join(poolDir, "runs", "01-head-to-head.attempt-2.trim.log")),
    ).toBe(true);
  });

  it("keeps a raw harness's log passthrough with no Stream file", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { outcome: { summary: "raw work", commitSha: "sha" } },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(existsSync(join(poolDir, "runs", "01.stream.jsonl"))).toBe(false);
  });
});

describe("spawn and exit facts", () => {
  // ADR-0012: the spawned event records the invocation (argv with the prompt
  // body elided, cwd, branch, the commit the spawn cwd was at, the env the
  // engine set), the exited and crash events record the attempt log's tail
  // and the outcome file's existence, and the crash interrupt body quotes
  // the log path, the tail and the outcome fact.

  it("records a main-checkout implement attempt's spawn facts against the commit it ran at", async () => {
    const { poolDir, head } = makeGitPool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "a.txt", commitMsg: "work" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.final.tickets["01"]).toBe("done");

    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    // A lone ready ticket runs in the main checkout: no worktree branch,
    // the commit resolved at spawn time (before the stub's own commit).
    expect(spawned.payload.cwd).toBe(poolDir);
    expect(spawned.payload.branch).toBeNull();
    expect(spawned.payload.commitSha).toBe(head);
    expect(spawned.payload.env).toEqual({ PWD: poolDir });
    expect(spawned.payload.argv).toEqual([
      "bash",
      join(poolDir, "git-stub.sh"),
      join(poolDir, "issues", "01-t.md"),
      "done",
      join(poolDir, "runs", "01.outcome.json"),
      expect.any(String),
      "0",
      join(poolDir, "plan-01-0.sh"),
    ]);
  }, 15000);

  it("records an attempt worktree's spawn facts at the commit it was cut from", async () => {
    const { poolDir, head } = makeGitPool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, assign: { "01": { verify: 2 } } },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": { grade: { score: 9, verdict: "pass", reasons: "first" } },
      "01-grader-2": { grade: { score: 4, verdict: "flag", reasons: "second" } },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.final.tickets["01"]).toBe("done");

    const events = readEventLines(poolDir, "01");
    for (const attempt of [1, 2]) {
      const spawned = events.find(
        (e) => e.kind === "spawned" && e.attempt === attempt,
      )!;
      expect(spawned.payload.cwd).toBe(worktreePathFor(poolDir, "01", attempt));
      expect(spawned.payload.branch).toBe(branchFor(poolDir, "01", attempt));
      expect(spawned.payload.commitSha).toBe(head);
      expect(spawned.payload.env).toEqual({ PWD: spawned.payload.cwd });
    }
  }, 15000);

  it("records a null commit SHA and the engine env where git is unavailable", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({});

    await runPool({ poolDir, harnesses: rig.harnesses });

    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    expect(spawned.payload.commitSha).toBeNull();
    expect(spawned.payload.env).toEqual({ PWD: poolDir });
  });

  it("elides the prompt body to the placeholder in the spawned event's argv", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { defaults: { harness: "echo", model: "m" } },
    });
    // A harness whose argv carries the prompt body as its own element, the
    // shape the real claude and cursor adapters build.
    const echo: HarnessCommand = (ctx) => [
      "bash",
      "-c",
      `printf '%s' '{"status":"done","summary":"s","commitSha":null}' > '${ctx.outcomePath}'`,
      ctx.body,
      "--model",
      ctx.model,
    ];

    const run = await runPool({ poolDir, harnesses: { echo } });
    expect(run.final.tickets["01"]).toBe("done");

    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    const argv = spawned.payload.argv as string[];
    // The body element is exactly the placeholder; the invocation shape
    // around it is untouched.
    expect(argv[3]).toBe("<prompt>");
    expect(argv.join(" ")).not.toContain("Standing instructions");
    expect(argv.slice(0, 3)).toEqual([
      "bash",
      "-c",
      expect.stringContaining("01.outcome.json"),
    ]);
    expect(argv.slice(4)).toEqual(["--model", "m"]);
  });

  it("carries the log tail and outcome fact on the exited and crash events, and quotes both in the crash body", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { defaults: { harness: "noisy", model: "m" } },
    });
    let calls = 0;
    const noisy: HarnessCommand = (ctx) => {
      calls += 1;
      if (calls === 1) {
        // First attempt: prints two log lines, writes no outcome, dies.
        return ["bash", "-c", "echo first-out-line; echo second-out-line; exit 7"];
      }
      // Retry: prints one line and writes an unparseable outcome.
      return [
        "bash",
        "-c",
        `echo retry-line; printf 'not json' > '${ctx.outcomePath}'`,
      ];
    };

    const run = await runPool({ poolDir, harnesses: { noisy } });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");

    const events = readEventLines(poolDir, "01");
    const exit1 = events.find((e) => e.kind === "exited" && e.attempt === 1)!;
    expect(exit1.payload).toEqual({
      code: 7,
      status: "in-progress",
      logTail: ["first-out-line", "second-out-line"],
      outcomeExists: false,
    });
    const crash1 = events.find((e) => e.kind === "crash")!;
    expect(crash1.payload).toEqual({
      code: 7,
      reason: "harness exited 7",
      logTail: ["first-out-line", "second-out-line"],
      outcomeExists: false,
    });
    expect(run.interrupts[0]?.body).toBe(
      join(poolDir, "runs", "01.log") +
        "\n\n" +
        "first-out-line\nsecond-out-line\n\n" +
        "outcome file: " +
        join(poolDir, "runs", "01.outcome.json") +
        " (missing)\n",
    );

    // The retry crashes the other way: the outcome file exists but is
    // invalid, exactly the distinction the outcome fact exists for.
    await run.resume("01");
    const later = readEventLines(poolDir, "01");
    const exit2 = later.filter((e) => e.kind === "exited").at(-1)!;
    expect(exit2.attempt).toBe(2);
    expect(exit2.payload).toEqual({
      code: 0,
      status: "in-progress",
      logTail: ["retry-line"],
      outcomeExists: true,
    });
    const crash2 = later.filter((e) => e.kind === "crash").at(-1)!;
    expect(crash2.attempt).toBe(2);
    expect(crash2.payload).toEqual({
      code: 0,
      reason: "outcome is not parseable JSON",
      logTail: ["retry-line"],
      outcomeExists: true,
    });
  });

  it("carries the spawn and exit facts on the engine-run judge sites", async () => {
    const { poolDir, head } = makeGitPool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, assign: { "01": { verify: 2 } } },
    });
    const noise = join(poolDir, "grader-noise.txt");
    writeFileSync(noise, "grader noise line\n");
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": [
        { exitCode: 9, noiseFile: noise, outcome: null },
        { grade: { score: 9, verdict: "pass", reasons: "recovered" }, noiseFile: noise },
      ],
      "01-grader-2": [
        { grade: { score: 8, verdict: "pass", reasons: "fine" }, noiseFile: noise },
      ],
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.final.tickets["01"]).toBe("done");

    // The grader's spawn facts, on both of its runs.
    const graderEvents = readEventLines(poolDir, "01-grader-1");
    for (const attempt of [1, 2]) {
      const spawned = graderEvents.find(
        (e) => e.kind === "spawned" && e.attempt === attempt,
      )!;
      expect(spawned.payload.cwd).toBe(poolDir);
      expect(spawned.payload.branch).toBeNull();
      expect(spawned.payload.commitSha).toBe(head);
      expect(spawned.payload.env).toEqual({ PWD: poolDir });
    }
    // The grader's first run died: the exit facts ride its exited and crash
    // events, and the re-spawn's grading exit carries the same tail with a
    // written outcome.
    const graderExit1 = graderEvents.find(
      (e) => e.kind === "exited" && e.attempt === 1,
    )!;
    expect(graderExit1.payload).toEqual({
      code: 9,
      status: "in-progress",
      logTail: ["grader noise line"],
      outcomeExists: false,
    });
    const graderCrash1 = graderEvents.find((e) => e.kind === "crash")!;
    expect(graderCrash1.payload).toEqual({
      code: 9,
      reason: "harness exited 9",
      logTail: ["grader noise line"],
      outcomeExists: false,
    });
    const graderExit2 = graderEvents.find(
      (e) => e.kind === "exited" && e.attempt === 2,
    )!;
    expect(graderExit2.payload).toEqual({
      code: 0,
      status: "done",
      logTail: ["grader noise line"],
      outcomeExists: true,
    });

    // The 9-8 spread calls the head-to-head judge; its unusable pick rides
    // the deterministic fallback, with the same spawn and exit facts.
    const h2hEvents = readEventLines(poolDir, "01-head-to-head");
    const h2hSpawned = h2hEvents.find((e) => e.kind === "spawned")!;
    expect(h2hSpawned.payload.cwd).toBe(poolDir);
    expect(h2hSpawned.payload.branch).toBeNull();
    expect(h2hSpawned.payload.commitSha).toBe(head);
    expect(h2hSpawned.payload.env).toEqual({ PWD: poolDir });
    const h2hExit = h2hEvents.find((e) => e.kind === "exited")!;
    expect(h2hExit.payload).toEqual({
      code: 0,
      status: "in-progress",
      logTail: [],
      outcomeExists: true,
    });
    const h2hCrash = h2hEvents.find((e) => e.kind === "crash")!;
    expect(h2hCrash.payload).toEqual({
      code: 0,
      reason: "outcome names no winner among the two attempts",
      logTail: [],
      outcomeExists: true,
    });
  }, 15000);
});

describe("terminal-backed attempts (named herdr tabs)", () => {
  // ADR-0014 + ADR-0015: on a `terminal: "herdr"` pool every attempt opens
  // its own named herdr tab before the spawn is recorded — unfocused, in the
  // attempt's cwd, labeled `<ticket-id> · <ticket-title>` — and the spawned
  // event carries the root pane id recovered from pane.list, because
  // tab.create returns none (verified herdr behaviour). The fake daemon
  // speaks the real wire shape and actually executes the wrapper a pane is
  // sent, so the harness genuinely runs in the pane.
  async function startFakeHerdr(): ReturnType<typeof startExecutingFakeHerdr> {
    return startExecutingFakeHerdr();
  }

  it("opens a named unfocused tab in the attempt cwd and records the recovered pane id", async () => {
    const poolDir = makePool({
      tickets: [
        { ...readyTicket("01"), body: "# Named herdr tabs\n\nticket body" },
      ],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    // Boot reconciliation's liveness pane.list comes first, then the
    // attempt's tab.create and its pane.list recovery.
    expect(fake.requests.map((r) => r.method).slice(1, 3)).toEqual([
      "tab.create",
      "pane.list",
    ]);
    expect(fake.requests[1].params).toEqual({
      label: "01 · Named herdr tabs",
      focus: false,
      cwd: poolDir,
    });
    // The harness ran inside the pane: the wrapper line was sent as text,
    // Enter as a key, and the pane's end was awaited on an events.subscribe
    // stream matching pane_exited, pane_closed and tab_closed (the last
    // because a closed tab takes its panes without a pane event, issue #61).
    const sends = fake.requests.filter((r) => r.method === "pane.send_input");
    expect(sends).toHaveLength(2);
    expect(typeof sends[0].params.text).toBe("string");
    expect(sends[1].params.keys).toEqual(["enter"]);
    const subscriptions = fake.requests.filter(
      (r) => r.method === "events.subscribe",
    );
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].params.subscriptions).toEqual([
      { type: "pane.exited" },
      { type: "pane.closed" },
      { type: "tab.closed" },
    ]);
    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    expect(spawned.payload.pane_id).toBe("pane-1");
    expect(spawned.payload.tab_id).toBe("tab-1");
    expect(spawned.payload.terminal_error).toBeUndefined();
  }, 15000);

  it("truncates a long ticket title to the tab label cap", async () => {
    const longTitle = "Named herdr tabs ".repeat(3).trimEnd();
    const poolDir = makePool({
      tickets: [{ ...readyTicket("01"), body: `# ${longTitle}\n\nticket body` }],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();

    await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    // The cap itself is unit-tested in herdr.test.ts; here the wiring from
    // the ticket file's heading to the socket's label params. Request 0 is
    // boot reconciliation's liveness pane.list; the tab.create follows.
    expect(fake.requests[1].params.label).toBe(
      `01 · ${longTitle.slice(0, 35)}`,
    );
  }, 15000);

  it("opens a tab for every attempt of a verify fan-out, graders included", async () => {
    const { poolDir } = makeGitPool({
      tickets: [
        { ...readyTicket("01"), body: "# Pick a winner\n\nticket body" },
      ],
      config: {
        ...stubConfig,
        terminal: "herdr",
        assign: { "01": { verify: 2 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": {
        grade: { score: 9, verdict: "pass", reasons: "first" },
      },
      "01-grader-2": {
        grade: { score: 4, verdict: "flag", reasons: "second" },
      },
    });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    // Two attempt tabs and two grader tabs; pane.list is also boot
    // reconciliation's liveness check and the exit-wait backstop (one per
    // pane end), whose exact count and interleaving are timing-dependent
    // and pinned in the mechanics tests below.
    const creates = fake.requests.filter((r) => r.method === "tab.create");
    expect(creates).toHaveLength(4);
    // Every attempt tab is named for its ticket, unfocused. The build
    // attempts label from the ticket title; the grader tickets carry the
    // engine-written "grade attempt" title, capped at the label length.
    for (const created of creates) {
      expect(created.params.focus).toBe(false);
      expect(String(created.params.label).length).toBeLessThanOrEqual(40);
    }
    const buildTabs = creates.filter((r) =>
      String(r.params.label).startsWith("01 · "),
    );
    expect(buildTabs).toHaveLength(2);
    for (const tab of buildTabs) {
      expect(tab.params.label).toBe("01 · Pick a winner");
      expect(String(tab.params.cwd)).toContain(
        join(".git", "pool-worktrees"),
      );
    }
    // The attempt worktrees differ per candidate: the two tabs never share.
    expect(buildTabs[0].params.cwd).not.toBe(buildTabs[1].params.cwd);
    // Graders run in the main checkout and record their pane ids on their
    // own spawned events.
    const graderTabs = creates.filter((r) =>
      String(r.params.label).startsWith("01-grader-"),
    );
    expect(graderTabs).toHaveLength(2);
    for (const tab of graderTabs) {
      expect(tab.params.cwd).toBe(poolDir);
    }
    for (const gid of ["01-grader-1", "01-grader-2"]) {
      const spawned = readEventLines(poolDir, gid).find(
        (e) => e.kind === "spawned",
      )!;
      expect(String(spawned.payload.pane_id)).toMatch(/^pane-/);
    }
  }, 15000);

  async function untilTabCloses(
    fake: { requests: FakeHerdrRequest[] },
    tabIds: string[],
  ): Promise<void> {
    const closed = () =>
      new Set(
        fake.requests
          .filter((r) => r.method === "tab.close")
          .map((r) => String(r.params.tab_id)),
      );
    const deadline = Date.now() + 5000;
    while (!tabIds.every((id) => closed().has(id))) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for tab.close of ${tabIds.join(", ")}; ` +
            `closed so far: ${[...closed()].join(", ") || "(none)"}`,
        );
      }
      await Bun.sleep(10);
    }
  }

  function spawnedTabIds(poolDir: string, ids: string[]): string[] {
    return ids.flatMap((id) =>
      readEventLines(poolDir, id)
        .filter(
          (e) => e.kind === "spawned" && typeof e.payload.tab_id === "string",
        )
        .map((e) => e.payload.tab_id as string),
    );
  }

  it("closes grader tabs when the verdict lands and loser tabs when selection completes", async () => {
    const { poolDir } = makeGitPool({
      tickets: [
        { ...readyTicket("01"), body: "# Pick a winner\n\nticket body" },
      ],
      config: {
        ...stubConfig,
        terminal: "herdr",
        assign: { "01": { verify: 2 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": {
        grade: { score: 9, verdict: "pass", reasons: "first" },
      },
      "01-grader-2": {
        grade: { score: 4, verdict: "flag", reasons: "second" },
      },
    });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });

    // Grader tabs never merge, so their close is the verdict-landed one; the
    // loser's tab closes with the discard; the winner's at its merge. Every
    // close is best-effort fire-and-forget, so wait for the requests to land.
    const tabIds = spawnedTabIds(poolDir, [
      "01",
      "01-grader-1",
      "01-grader-2",
    ]);
    expect(tabIds).toHaveLength(4);
    await untilTabCloses(fake, tabIds);
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    const closes = fake.requests.filter((r) => r.method === "tab.close");
    const closed = closes.map((r) => String(r.params.tab_id));
    expect(closed.sort()).toEqual([...tabIds].sort());
    // Every tab closes exactly once: a permutation (the discard closing the
    // winner's tab, the merge closing the loser's) would still satisfy the
    // set equality above.
    for (const tabId of tabIds) {
      expect(closed.filter((id) => id === tabId)).toHaveLength(1);
    }
    // ... and each close fires at its own trigger: the graders' verdicts
    // land before selection, the winner's merge close precedes the discard.
    const closeIndexOf = (tabId: string) =>
      closes.findIndex((r) => String(r.params.tab_id) === tabId);
    const spawned = readEventLines(poolDir, "01").filter(
      (e) => e.kind === "spawned",
    );
    const winnerTab = spawned.find((e) => e.attempt === 1)!.payload
      .tab_id as string;
    const loserTab = spawned.find((e) => e.attempt === 2)!.payload
      .tab_id as string;
    for (const gid of ["01-grader-1", "01-grader-2"]) {
      const graderTab = readEventLines(poolDir, gid).find(
        (e) => e.kind === "spawned",
      )!.payload.tab_id as string;
      expect(closeIndexOf(graderTab)).toBeLessThan(closeIndexOf(winnerTab));
    }
    expect(closeIndexOf(winnerTab)).toBeLessThan(closeIndexOf(loserTab));
  }, 15000);

  it("closes the head-to-head tab when the judge's verdict lands", async () => {
    const { poolDir } = makeGitPool({
      tickets: [
        { ...readyTicket("01"), body: "# Pick a winner\n\nticket body" },
      ],
      config: {
        ...stubConfig,
        terminal: "herdr",
        assign: { "01": { verify: 2 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { workFile: "cand-1.txt", commitMsg: "cand-1" },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": {
        grade: { score: 9, verdict: "pass", reasons: "first" },
      },
      "01-grader-2": {
        grade: { score: 8, verdict: "pass", reasons: "second" },
      },
      // The margin of 1 is below the outright band, so the judge runs and
      // its pick decides the selection.
      "01-head-to-head": { winner: 2 },
    });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });

    const tabIds = spawnedTabIds(poolDir, [
      "01",
      "01-grader-1",
      "01-grader-2",
      "01-head-to-head",
    ]);
    expect(tabIds).toHaveLength(5);
    await untilTabCloses(fake, tabIds);
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    const closed = fake.requests
      .filter((r) => r.method === "tab.close")
      .map((r) => String(r.params.tab_id));
    expect(closed.sort()).toEqual([...tabIds].sort());
    for (const tabId of tabIds) {
      expect(closed.filter((id) => id === tabId)).toHaveLength(1);
    }
  }, 15000);

  it("closes a crashed grader's tab on the failure path", async () => {
    const { poolDir } = makeGitPool({
      tickets: [
        { ...readyTicket("01"), body: "# Pick a winner\n\nticket body" },
      ],
      config: {
        ...stubConfig,
        terminal: "herdr",
        assign: { "01": { verify: 1 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [{ workFile: "cand-1.txt", commitMsg: "cand-1" }],
      // A grader that always crashes drives the re-spawn rounds to their
      // bound; every failed round's tab is dead weight once its crash lands.
      "01-grader-1": { exitCode: 1 },
    });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });

    // One tab per re-spawn round: the initial spawn plus GRADER_RESPAWN_LIMIT
    // (2) re-spawns, each closed when its crash lands.
    const graderTabIds = spawnedTabIds(poolDir, ["01-grader-1"]);
    expect(graderTabIds).toHaveLength(3);
    await untilTabCloses(fake, graderTabIds);
    await fake.close();

    // The grading exhausted its re-spawn bound: the build ticket sits with
    // its crash interrupt, its own attempt tab untouched.
    const attemptTabIds = spawnedTabIds(poolDir, ["01"]);
    expect(run.final.tickets["01"]).not.toBe("done");
    const closed = fake.requests
      .filter((r) => r.method === "tab.close")
      .map((r) => String(r.params.tab_id));
    for (const tabId of graderTabIds) {
      expect(closed).toContain(tabId);
      expect(closed.filter((id) => id === tabId)).toHaveLength(1);
    }
    for (const tabId of attemptTabIds) expect(closed).not.toContain(tabId);
  }, 15000);

  it("falls back to headless with the error on the spawned event when the daemon is absent", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({});

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: join(poolDir, "no-daemon.sock"),
    });

    expect(run.final.tickets["01"]).toBe("done");
    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    expect(spawned.payload.pane_id).toBeNull();
    expect(typeof spawned.payload.terminal_error).toBe("string");
  }, 15000);

  it("records no pane facts on a headless pool", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      // Pointing at nothing: a headless pool must never touch the socket.
      herdrSocket: join(poolDir, "no-daemon.sock"),
    });

    expect(run.final.tickets["01"]).toBe("done");
    const spawned = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawned",
    )!;
    expect(spawned.payload.pane_id).toBeUndefined();
    expect(spawned.payload.terminal_error).toBeUndefined();
  }, 15000);
});

describe("terminal-backed engine mechanics (ADR-0014)", () => {
  // The fake daemon actually executes the wrapper shell a pane is sent, so
  // these tests observe the real files a pane run produces: the tee'd log,
  // the derived log from a streamed harness, the wrapper's exit-code file,
  // and the tab close a merge triggers.

  async function startFakeHerdr(options?: {
    breakSubscriptions?: boolean;
  }): ReturnType<typeof startExecutingFakeHerdr> {
    return startExecutingFakeHerdr(options);
  }

  // A settled run's `settled` getter resolves immediately (there is no next
  // settle to wait for), so post-settle state changes the engine's own
  // bookkeeping drives (an adopted attempt's finalize) are polled here.
  async function until(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(10);
    }
  }

  it("wraps the harness in the script wrapper shell and reads the exit code from the file", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    const wrapper = fake.requests.find(
      (r) => r.method === "pane.send_input" && typeof r.params.text === "string",
    )!.params.text as string;
    // ADR-0016's wrapper: the interactive command wrapped in `script` (the
    // PTY that supplies the session and the typescript the log derives
    // from; `-e` makes script's exit the harness's) in the host platform's
    // form, the trailing exit-code write for crash forensics, and no `exit`
    // — the pane stays open after the attempt completes. The terminal-backed
    // path streams to the attempt's Stream file whatever the harness's
    // stream mode.
    expect(wrapper).toContain(SCRIPT_RECORD_PREFIX);
    expect(wrapper).toContain(".stream.jsonl'");
    expect(wrapper).toMatch(/; echo \$\? > .*\.exitcode'$/);
    expect(wrapper).not.toContain("2>&1 | tee");
    expect(wrapper).not.toContain("PIPESTATUS");
    // The wrapper's promise, on the pane: the exit-code file the wrapper
    // wrote and the harness outcome it ran.
    expect(readFileSync(join(poolDir, "runs", "01.exitcode"), "utf8").trim()).toBe("0");
    expect(existsSync(join(poolDir, "runs", "01.log"))).toBe(true);
    const exited = readEventLines(poolDir, "01").find((e) => e.kind === "exited")!;
    expect(exited.payload.code).toBe(0);
  }, 15000);

  it("hands each platform's script(1) the argv it expects once the pane's shell has parsed the wrapper (issue #58)", () => {
    // Neither form of the wrapper fails until it reaches a real pane: GNU
    // script's `-c '<cmd>'` form is what BSD script (macOS) rejected at
    // once with `illegal option -- f`, leaving the tab at an idle prompt.
    // So the shape is pinned as script itself sees it: a stand-in script(1)
    // on PATH records its argv, and the wrapper runs under a shell exactly
    // as the pane would run it (bash here; the line is POSIX quoting and
    // `$?`, which the operator's login shell — zsh on a Mac, ADR-0014 —
    // reads the same way).
    const dir = mkdtempSync(join(tmpdir(), "wrapper-"));
    tempDirs.push(dir);
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const recorder = join(binDir, "script");
    writeFileSync(
      recorder,
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$@" > "$RECORDED_ARGV"',
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(recorder, 0o755);
    const streamPath = join(dir, "28.stream.jsonl");
    const ctx = {
      streamPath,
      logPath: join(dir, "28.log"),
      exitCodePath: join(dir, "28.exitcode"),
    } as SpawnContext;
    // Words with a space and a quote, so the quoting is exercised too.
    const argv = ["agent", "--model", "grok 4.6", "it's"];
    const scriptArgv = (platform: NodeJS.Platform): string[] => {
      const recorded = join(dir, `${platform}.argv`);
      rmSync(ctx.exitCodePath, { force: true });
      const result = Bun.spawnSync(
        ["bash", "-c", interactiveWrapper(argv, ctx, platform)],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            RECORDED_ARGV: recorded,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      // The trailing write carried script's own status (the harness's,
      // under `-e`), on both platforms.
      expect(readFileSync(ctx.exitCodePath, "utf8").trim()).toBe("3");
      return readFileSync(recorded, "utf8").split("\n").slice(0, -1);
    };
    // BSD script (macOS): the file, then the command's words, verbatim.
    expect(scriptArgv("darwin")).toEqual(["-eqF", streamPath, ...argv]);
    // util-linux script: the command as one shell string after -c, then
    // the file.
    expect(scriptArgv("linux")).toEqual([
      "-eqfc",
      "'agent' '--model' 'grok 4.6' 'it'\\''s'",
      streamPath,
    ]);
    // The default is the host's own form.
    expect(interactiveWrapper(argv, ctx)).toBe(
      interactiveWrapper(argv, ctx, process.platform),
    );
  });

  it("captures the session in the script typescript Stream file and derives the ANSI-stripped log from it", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: {
        defaults: { harness: "transcript", model: "stub-model" },
        terminal: "herdr",
      },
    });
    // A harness whose output carries ANSI, the way a real TUI paints. The
    // wrapper runs it under script, so the Stream file is the raw typescript
    // (both directions, ANSI included) and the follow-file tailer must strip
    // the ANSI out for the log.
    const script = join(poolDir, "transcript-stub.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        "printf 'hello from the pane\\n'",
        "printf '\\033[32mgreen text\\033[0m\\n'",
        `printf '%s' '{"status":"done","summary":"transcript","commitSha":null}' > "$1"`,
        "exit 0",
        "",
      ].join("\n"),
    );
    const harnesses: Record<string, HarnessCommand> = {
      transcript: (ctx: SpawnContext) => ["bash", script, ctx.outcomePath],
    };
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    // The Stream file is the script typescript: the session's raw bytes,
    // including the ANSI the TUI painted and the CR a PTY line ending
    // carries.
    const stream = readFileSync(
      join(poolDir, "runs", "01.stream.jsonl"),
      "utf8",
    );
    expect(stream).toContain("hello from the pane");
    expect(stream).toContain("\u001b[32m");
    // The log is the ANSI-stripped transcript, not the raw bytes.
    const log = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(log).toContain("hello from the pane");
    expect(log).toContain("green text");
    expect(log).not.toContain("\u001b[");
    expect(log).not.toContain("hello from the pane\r");
  }, 15000);

  it("a non-zero pane exit is the attempt's crash, with the wrapper's code", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({ "01": { outcome: null, exitCode: 3 } });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(readFileSync(join(poolDir, "runs", "01.exitcode"), "utf8").trim()).toBe("3");
    const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
    expect(crash.payload.code).toBe(3);
    expect(crash.payload.reason).toBe("harness exited 3");
  }, 15000);

  it("waits on the exit-code file when the event subscription cannot be kept", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = stubHarness({});
    // A daemon that drops every subscription (a restart mid-wait, or one
    // too old for events.subscribe): the wrapper's exit-code file is the
    // only end signal, and the attempt must still complete.
    const fake = await startFakeHerdr({ breakSubscriptions: true });

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    expect(
      fake.requests.filter((r) => r.method === "events.subscribe").length,
    ).toBeGreaterThan(0);
    const exited = readEventLines(poolDir, "01").find((e) => e.kind === "exited")!;
    expect(exited.payload.code).toBe(0);
  }, 15000);

  it("closes the attempt's tab when the ticket merges", async () => {
    // Two independent tickets land in one super-step, so each attempt gets
    // its own worktree and a real merge to close its tab by.
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: { ...stubConfig, terminal: "herdr" },
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "work-1.txt", commitMsg: "attempt 1 work" },
      "02": { workFile: "work-2.txt", commitMsg: "attempt 2 work" },
    });
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await until(
      () => fake.requests.some((r) => r.method === "tab.close"),
      "tab close requests",
    );
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    expect(run.final.tickets["02"]).toBe("done");
    // Every merged attempt's tab closed, by the tab id its spawned event
    // recorded.
    const tabIds = ["01", "02"].map(
      (id) =>
        readEventLines(poolDir, id).find((e) => e.kind === "spawned")!.payload
          .tab_id,
    );
    const closed = fake.requests
      .filter((r) => r.method === "tab.close")
      .map((r) => r.params.tab_id);
    expect(closed.sort()).toEqual(tabIds.sort());
    for (const id of ["01", "02"]) {
      expect(
        readEventLines(poolDir, id).some((e) => e.kind === "merged"),
      ).toBe(true);
    }
  }, 15000);

  it("boot reconciliation crashes an orphan attempt whose pane is gone and re-runs the ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=in-progress -->",
        },
      ],
      config: { ...stubConfig, terminal: "herdr" },
    });
    // The died run's record: attempt 1 scheduled and spawned into a pane
    // this pool's daemon no longer holds, and never exited.
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:00Z",
      attempt: 1,
      kind: "scheduled",
      payload: {},
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:01Z",
      attempt: 1,
      kind: "spawned",
      payload: { pane_id: "pane-orphan", tab_id: "tab-orphan" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    // The orphan crashed on the record; the ticket re-ran as a fresh
    // attempt in a new tab and finished.
    expect(run.final.tickets["01"]).toBe("done");
    const events = readEventLines(poolDir, "01");
    const crash = events.find((e) => e.kind === "crash" && e.attempt === 1)!;
    expect(crash.payload.reason).toBe(
      "attempt pane gone at boot reconciliation",
    );
    expect(events.filter((e) => e.kind === "spawned")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "exited")).toHaveLength(1);
    expect(events.find((e) => e.kind === "spawned")!.payload.pane_id).toBe(
      "pane-orphan",
    );
    expect(events.filter((e) => e.kind === "spawned")[1].payload.pane_id).toBe(
      "pane-1",
    );
  }, 15000);

  it("boot reconciliation re-adopts an orphan attempt whose pane is live, and its exit lands later", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=in-progress -->",
        },
      ],
      config: { ...stubConfig, terminal: "herdr" },
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:00Z",
      attempt: 1,
      kind: "scheduled",
      payload: {},
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:01Z",
      attempt: 1,
      kind: "spawned",
      payload: { pane_id: "pane-ghost", tab_id: "tab-ghost" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();
    fake.injectPane("pane-ghost");

    const run = startPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await run.settled;

    // Adopted, not duplicated: no fresh tab, the marker kept in-progress,
    // and the interrupt names the wait.
    expect(run.final.tickets["01"]).toBe("in-progress");
    expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(0);
    const issue = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issue.split("\n")[0]).toContain("status=in-progress");
    expect(issue).not.toContain("back to ready");
    const adoption = run.interrupts.find((i) => i.ticketId === "01")!;
    expect(adoption.kind).toBe("checkpoint");
    expect(adoption.body).toContain("re-adopted");

    // The pane's wrapper finished while the engine was down: its exit-code
    // and outcome files are on disk, then the pane ends.
    writeFileSync(join(poolDir, "runs", "01.exitcode"), "0");
    writeFileSync(
      join(poolDir, "runs", "01.outcome.json"),
      JSON.stringify({ status: "done", summary: "adopted", commitSha: null }),
    );
    fake.endPane("pane-ghost");
    await until(() => run.final.tickets["01"] === "done", "adopted attempt recorded");

    expect(run.final.tickets["01"]).toBe("done");
    const events = readEventLines(poolDir, "01");
    const exited = events.find((e) => e.kind === "exited" && e.attempt === 1)!;
    expect(exited.payload.code).toBe(0);
    expect(exited.payload.status).toBe("done");
    // One spawn on the record, no crash, and the adoption interrupt made
    // way for the closing gate's Review.
    expect(events.filter((e) => e.kind === "spawned")).toHaveLength(1);
    expect(events.some((e) => e.kind === "crash")).toBe(false);
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    await fake.close();
  }, 15000);

  it("answering the adoption interrupt abandons the pane and re-runs the ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=in-progress -->",
        },
      ],
      config: { ...stubConfig, terminal: "herdr" },
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:00Z",
      attempt: 1,
      kind: "scheduled",
      payload: {},
    });
    appendEvent(join(poolDir, "runs"), "01", {
      at: "2026-09-05T00:00:01Z",
      attempt: 1,
      kind: "spawned",
      payload: { pane_id: "pane-ghost", tab_id: "tab-ghost" },
    });
    const rig = stubHarness({});
    const fake = await startFakeHerdr();
    fake.injectPane("pane-ghost");

    const run = startPool({
      poolDir,
      harnesses: rig.harnesses,
      herdrSocket: fake.socketPath,
    });
    await run.settled;
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);

    const answered = await run.resume("01");

    // The adopted pane was closed, the finalize recorded nothing for
    // attempt 1, and the ticket re-ran as attempt 2 to done.
    expect(answered.final.tickets["01"]).toBe("done");
    const closes = fake.requests.filter((r) => r.method === "pane.close");
    expect(closes.map((r) => r.params.pane_id)).toEqual(["pane-ghost"]);
    const events = readEventLines(poolDir, "01");
    expect(events.filter((e) => e.kind === "spawned")).toHaveLength(2);
    expect(events.some((e) => e.kind === "exited" && e.attempt === 1)).toBe(false);
    expect(answered.interrupts.map((i) => i.kind)).toEqual(["review"]);
    await fake.close();
  }, 15000);
});

describe("interactive terminal-backed attempts (ADR-0016)", () => {
  // The interactive tests drive the engine against the fake herdr seam with a
  // KNOWN harness name whose command the test replaces with a bash script, so
  // the engine's descriptor-driven readiness and prompt delivery run (the
  // descriptor survives the command override) while the pane actually
  // executes the stub. The fake fabricates the TUI's rendered content
  // (`rendered` carries the ready frame) and can drop typed pastes to
  // exercise the retry and fallback.
  //
  // The same seam contract runs for every known harness — claude, opencode,
  // cursor — with all per-harness behavior (ready frame, typed prompt shape,
  // echo target) coming from the descriptor table alone, so these tests pin
  // that the interactive machinery is harness-agnostic (pool ticket 04).

  const knownHarnesses = ["claude", "opencode", "cursor"] as const;

  const poolFor = (harness: string): PoolSpec => ({
    tickets: [readyTicket("01")],
    config: {
      defaults: { harness, model: "stub-model" },
      terminal: "herdr",
    },
  });

  // The ready frame each harness's TUI renders, from the descriptor's
  // prototype-validated ready pattern (the bare prompt glyph is not a ready
  // signal: the pane's own bash prompt collides with it).
  const readyFrame = (harness: string): string =>
    `${defaultHarnessDescriptors[harness].readyPattern}\n❯ `;

  // The typed prompt's leading shape, straight from the descriptor's
  // interactive shaping: claude and opencode expand a leading /driver slash
  // command, cursor takes a plain message (spawn.test.ts pins each shape).
  // The engine holds no per-harness prompt code, only the descriptor table.
  // Body is a sentinel so the trailing issue-path echo line is not part of
  // the prefix a real (non-empty) prompt must start with.
  const promptPrefix = (harness: string, issuePath: string): string => {
    const shaped = defaultHarnessDescriptors[harness].promptShaping.interactive({
      driver: "implement",
      issuePath,
      body: "\0",
    });
    return shaped.slice(0, shaped.indexOf("\0"));
  };

  // The command stub, harness-agnostic: optionally waits for a trigger file,
  // prints an output line, writes the outcome, then optionally holds the pane
  // open the way a real TUI stays alive after the agent declares done, and
  // exits with `exitCode` (0 unless the test wants a harness that dies).
  function harnessStub(
    poolDir: string,
    opts: {
      outcome?: string;
      hold?: boolean;
      waitFor?: string;
      output?: string;
      exitCode?: number;
    } = {},
  ): { stubPath: string; command: HarnessCommand } {
    const stubPath = join(poolDir, "tui-stub.sh");
    const waitFor = opts.waitFor ?? "";
    const output = opts.output ?? "";
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome="$1"; wait_for="$2"; output="$3"',
        'if [ -n "$wait_for" ]; then',
        "  for _ in $(seq 1 200); do",
        '    [ -e "$wait_for" ] && break',
        "    sleep 0.05",
        "  done",
        "fi",
        ...(output !== "" ? [`printf '%s\\n' "$output"`] : []),
        ...(opts.outcome !== undefined
          ? [`printf '%s' '${opts.outcome}' > "$outcome"`]
          : []),
        ...(opts.hold ? ["sleep 30"] : []),
        `exit ${opts.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    return {
      stubPath,
      command: (ctx: SpawnContext) => [
        "bash",
        stubPath,
        ctx.outcomePath,
        waitFor,
        output,
      ],
    };
  }

  const doneOutcome = JSON.stringify({
    status: "done",
    summary: "interactive",
    commitSha: null,
  });

  async function startFakeHerdr(options?: {
    rendered?: string;
    dropInputs?: number;
    hideInputs?: number;
    wrapWidth?: number;
    holdPane?: boolean;
  }): ReturnType<typeof startExecutingFakeHerdr> {
    return startExecutingFakeHerdr(options);
  }

  async function until(
    cond: () => boolean,
    what: string,
    timeout = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(10);
    }
  }

  for (const harness of knownHarnesses) {
    describe(harness, () => {
      it("waits for readiness, types the descriptor's interactive prompt, and completes on the Outcome", async () => {
        const poolDir = makePool(poolFor(harness));
        // The stub writes its Outcome and holds the pane open, so the pane
        // does not die mid-readiness the way a script that exits would.
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The fake's rendered content is the harness's ready frame; the
        // stub's outcome needs no trigger, so it is written directly.
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // The send sequence: wrapper text + enter, then the typed driver
        // prompt text + enter. Nothing else is sent.
        expect(sends).toHaveLength(4);
        expect(sends[0].params.text as string).toContain(SCRIPT_RECORD_PREFIX);
        expect(sends[1].params.keys).toEqual(["enter"]);
        const prompt = sends[2].params.text as string;
        const issuePath = join(poolDir, "issues", "01-t.md");
        expect(prompt.startsWith(promptPrefix(harness, issuePath))).toBe(true);
        // The issue reference rides the prompt, so it is the harness-agnostic
        // echo target the verification matched. It is also the final line, so
        // a long paste cannot scroll it out of the peeked tail.
        expect(prompt).toContain(issuePath);
        expect(prompt.split("\n").at(-1)).toBe(issuePath);
        expect(sends[3].params.keys).toEqual(["enter"]);
        // The readiness poll read the pane before the prompt was typed.
        expect(
          fake.requests
            .slice(0, fake.requests.indexOf(sends[2]))
            .some((r) => r.method === "pane.read"),
        ).toBe(true);
        // The spawned event records the argv the pane actually ran — the
        // interactive command (the stub), not the batch line.
        const spawned = readEventLines(poolDir, "01").find(
          (e) => e.kind === "spawned",
        )!;
        const argv = spawned.payload.argv as string[];
        expect(argv[0]).toBe("bash");
        expect(argv).toContain(join(poolDir, "tui-stub.sh"));
        expect(argv).not.toContain("-p");
        expect(argv).not.toContain("--output-format");
      }, 20000);

      it("completes on a valid Outcome without pane exit, leaving the pane open", async () => {
        const poolDir = makePool(poolFor(harness));
        const trigger = join(poolDir, "hold-trigger");
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
          waitFor: trigger,
        });
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const run = startPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        // Let the attempt spawn and reach its completion wait, then write the
        // trigger so the stub declares done while the pane stays open.
        await until(
          () => fake.requests.some((r) => r.method === "events.subscribe"),
          "the completion wait's pane-end subscription",
        );
        writeFileSync(trigger, "");
        await run.settled;

        expect(run.final.tickets["01"]).toBe("done");
        // The pane never closed and the wrapper never finished: the exit-code
        // file the wrapper writes when the TUI eventually exits is absent, so
        // the TUI is still alive after the attempt completed.
        expect(fake.requests.filter((r) => r.method === "pane.close")).toHaveLength(0);
        expect(existsSync(join(poolDir, "runs", "01.exitcode"))).toBe(false);
        const exited = readEventLines(poolDir, "01").find((e) => e.kind === "exited")!;
        expect(exited.payload.code).toBe(0);
        await fake.close();
      }, 20000);

      it("treats pane loss without an Outcome as a crash", async () => {
        const poolDir = makePool(poolFor(harness));
        // The stub holds without writing any outcome: the attempt stays in
        // flight until the pane is lost.
        const { command } = harnessStub(poolDir, { hold: true });
        const fake = await startFakeHerdr({ rendered: readyFrame(harness) });

        const run = startPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        // Wait until the prompt has been delivered (four send_input calls:
        // the wrapper pair and the prompt pair) so the completion wait is
        // live, then lose the pane with no outcome on disk.
        await until(
          () =>
            fake.requests.filter((r) => r.method === "pane.send_input").length >= 4,
          "the typed prompt's send",
        );
        fake.endPane("pane-1");
        await run.settled;

        expect(run.final.tickets["01"]).toBe("in-progress");
        expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
        const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
        // The pane ended with the wrapper's exit-code file never written
        // (the killed pane took the wrapper down with it): the crash names
        // the unreadable file rather than inventing an exit status.
        expect(crash.payload.reason).toContain("exit code unreadable");
        await fake.close();
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("retries a lost paste, then falls back to the file-referencing command", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The first three full-prompt pastes are lost (the prototype's
        // false-ready paste loss): the echo verification fails each time, the
        // engine retries, then falls back to `/implement <promptfile>`.
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // Wrapper pair, three lost full-prompt pastes with a clear before
        // each retry and before the fallback, then the fallback and Enter.
        expect(sends).toHaveLength(10);
        expect(sends[0].params.text as string).toContain(SCRIPT_RECORD_PREFIX);
        expect(sends[1].params.keys).toEqual(["enter"]);
        const issuePath = join(poolDir, "issues", "01-t.md");
        expect(
          (sends[2].params.text as string).startsWith(promptPrefix(harness, issuePath)),
        ).toBe(true);
        expect(sends[3].params.keys).toEqual(clearKeys);
        expect(
          (sends[4].params.text as string).startsWith(promptPrefix(harness, issuePath)),
        ).toBe(true);
        expect(sends[5].params.keys).toEqual(clearKeys);
        expect(
          (sends[6].params.text as string).startsWith(promptPrefix(harness, issuePath)),
        ).toBe(true);
        expect(sends[7].params.keys).toEqual(clearKeys);
        const promptFile = join(poolDir, "runs", "01.outcome.prompt.txt");
        expect(sends[8].params.text as string).toBe(`/implement ${promptFile}`);
        expect(sends[9].params.keys).toEqual(["enter"]);
        expect(existsSync(promptFile)).toBe(true);
        const promptFileText = readFileSync(promptFile, "utf8");
        expect(
          promptFileText.startsWith(`${issuePath}\n\n`),
        ).toBe(true);
        expect(promptFileText).toContain("Standing instructions");
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("falls back to the attempt's own driver, not a hardcoded one", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        // A pool whose ticket driver is not "implement" (grader, resolver,
        // and head-to-head spawn sites pass their own drivers) must fall
        // back to that driver's slash command, or a lost paste would invoke
        // the wrong skill.
        const pool = poolFor(harness);
        pool.config = {
          ...pool.config,
          defaults: { ...pool.config?.defaults, drivers: "verify" },
        };
        const poolDir = makePool(pool);
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(poolDir, "runs", "01.outcome.prompt.txt");
        expect(sends[7].params.keys).toEqual(clearKeys);
        expect(sends[8].params.text as string).toBe(`/verify ${promptFile}`);
        expect(sends[9].params.keys).toEqual(["enter"]);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("clears the input before pasting the file-reference fallback", async () => {
        const clearKeys = defaultHarnessDescriptors[harness].clearKeys;
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(poolDir, "runs", "01.outcome.prompt.txt");
        expect(sends[7].params.keys).toEqual(clearKeys);
        expect(sends[8].params.text as string).toBe(`/implement ${promptFile}`);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("fails the spawn when the fallback echo misses", async () => {
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 4,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("in-progress");
        expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
        const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
        expect(crash.payload.reason).toBe("prompt never landed");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends.at(-1)?.params.text as string | undefined).toContain(
          "/implement ",
        );
        const promptEnters = sends.filter(
          (s, i) =>
            i > 1 &&
            Array.isArray(s.params.keys) &&
            (s.params.keys as string[]).includes("enter"),
        );
        expect(promptEnters).toHaveLength(0);
      }, 20000);

      it("verifies the echo when the viewport wraps the issue path across bordered rows", async () => {
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        // The TUI draws its input as a box narrower than the pane and wraps
        // long lines inside it (issue #56: opencode split the 82-character
        // issue path at a hyphen across two bordered rows, so a substring
        // match on the viewport never saw it and the paste counted as lost).
        // The width is well under the pool's issue path, so the echo target
        // is guaranteed to wrap.
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          wrapWidth: 24,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        expect(run.interrupts.map((i) => i.kind)).not.toContain("crash");
        // The wrapped viewport never held the issue path contiguously.
        const issuePath = join(poolDir, "issues", "01-t.md");
        expect(issuePath.length).toBeGreaterThan(24);
        // One paste, verified first time: no clear, no retry, no fallback.
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends).toHaveLength(4);
        expect(sends[2].params.text as string).toContain(issuePath);
        expect(sends[3].params.keys).toEqual(["enter"]);
        expect(fake.submitted).toHaveLength(1);
        expect(fake.submitted[0].split("\n").at(-1)).toBe(issuePath);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("verifies the fallback's echo when the viewport wraps the prompt-file path", async () => {
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        // Three lost pastes force the file-referencing fallback, whose echo
        // target is the prompt file's path: longer than the box, so it wraps
        // too (issue #56: the 73-character path in a 72-column box).
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 3,
          wrapWidth: 24,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        const promptFile = join(poolDir, "runs", "01.outcome.prompt.txt");
        expect(sends).toHaveLength(10);
        expect(sends[8].params.text as string).toBe(`/implement ${promptFile}`);
        expect(sends[9].params.keys).toEqual(["enter"]);
        expect(fake.submitted).toEqual([`/implement ${promptFile}`]);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length === 0)("submits one clean prompt when a landed paste's echo is unseen", async () => {
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          hideInputs: 1,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("done");
        expect(fake.submitted).toHaveLength(1);
        const submitted = fake.submitted[0];
        const issuePath = join(poolDir, "issues", "01-t.md");
        expect(submitted.startsWith(promptPrefix(harness, issuePath))).toBe(true);
        expect(submitted.split("\n").at(-1)).toBe(issuePath);
        // One leading reference and one trailing echo line. A concatenated
        // retry would carry four.
        expect(submitted.split(issuePath).length - 1).toBe(2);
      }, 20000);

      it.skipIf(defaultHarnessDescriptors[harness].clearKeys.length > 0)("fails the spawn on the first echo miss when it has no clear keys", async () => {
        const poolDir = makePool(poolFor(harness));
        const { command } = harnessStub(poolDir, {
          outcome: doneOutcome,
          hold: true,
        });
        const fake = await startFakeHerdr({
          rendered: readyFrame(harness),
          dropInputs: 1,
        });

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await fake.close();

        expect(run.final.tickets["01"]).toBe("in-progress");
        expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
        const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
        expect(crash.payload.reason).toBe("prompt never landed");
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        // Wrapper pair and one paste. No retry, no fallback, no Enter on the prompt.
        expect(sends).toHaveLength(3);
        expect(sends[2].params.text as string).toContain(
          join(poolDir, "issues", "01-t.md"),
        );
        expect(fake.submitted).toEqual([]);
      }, 20000);

      it("surfaces a botched spawn (TUI never ready) as a failure, not an idle tab", async () => {
        const poolDir = makePool(poolFor(harness));
        // The stub holds the pane the way a TUI that never paints its ready
        // frame does, and the fake never renders one; the pane then ends
        // during the readiness wait (the operator closed the tab), with no
        // exit code behind it.
        const { command } = harnessStub(poolDir, { hold: true });
        const fake = await startFakeHerdr();

        const running = runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        await until(
          () => fake.requests.filter((r) => r.method === "pane.read").length >= 2,
          "the readiness poll",
        );
        fake.endPane("pane-1");
        const run = await running;

        expect(run.final.tickets["01"]).toBe("in-progress");
        expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
        const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
        expect(crash.payload.reason).toBe("TUI never became ready");
        // The pane was closed so the operator is not left a silently idle
        // tab; the close is fire-and-forget, so wait for the request to land.
        await until(
          () => fake.requests.some((r) => r.method === "pane.close"),
          "the botched spawn's pane close",
        );
        const closes = fake.requests.filter((r) => r.method === "pane.close");
        expect(closes.length).toBeGreaterThan(0);
        await fake.close();
      }, 20000);

      it("fails fast with the harness's own exit code when it dies before its TUI comes up (issue #58)", async () => {
        const poolDir = makePool(poolFor(harness));
        // The harness dies on launch with a code of its own — a wrapper the
        // platform's script rejects, a binary the pane cannot find — and the
        // pane keeps its shell afterwards, the way a real herdr pane does:
        // no pane end, no ready frame, nothing for the readiness wait to see
        // but the exit-code file the wrapper wrote.
        const { command } = harnessStub(poolDir, { exitCode: 3 });
        const fake = await startFakeHerdr({ holdPane: true });
        const started = Date.now();

        const run = await runPool({
          poolDir,
          harnesses: { [harness]: command },
          herdrSocket: fake.socketPath,
        });
        const elapsed = Date.now() - started;
        await fake.close();

        expect(run.final.tickets["01"]).toBe("in-progress");
        expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
        const crash = readEventLines(poolDir, "01").find((e) => e.kind === "crash")!;
        // The harness's code, not the engine's "never became ready", and
        // at once rather than after the readiness timeout (60s).
        expect(crash.payload.code).toBe(3);
        expect(crash.payload.reason).toBe("harness exited 3");
        expect(elapsed).toBeLessThan(10_000);
        // Nothing was typed into the shell the wrapper left behind: the
        // wrapper pair and no more.
        const sends = fake.requests.filter((r) => r.method === "pane.send_input");
        expect(sends).toHaveLength(2);
        expect(fake.submitted).toEqual([]);
        // The pane stays open: it is a crashed attempt's tab (ADR-0014) and
        // holds the only record of why the harness died.
        expect(fake.requests.some((r) => r.method === "pane.close")).toBe(false);
      }, 20000);
    });
  }

  it("gives opencode a Stream file in terminal-backed mode and derives a readable log from it", async () => {
    // opencode is a raw harness headless (no structured stream), so this pins
    // the ADR-0016 rule that a terminal-backed attempt always gets a Stream
    // file — the script typescript — whatever its stream mode, and that the
    // derived log is the ANSI-stripped transcript (spec user story 15).
    const poolDir = makePool(poolFor("opencode"));
    const { command } = harnessStub(poolDir, {
      outcome: doneOutcome,
      hold: true,
      output: "opencode agent working",
    });
    const fake = await startFakeHerdr({ rendered: readyFrame("opencode") });

    const run = await runPool({
      poolDir,
      harnesses: { opencode: command },
      herdrSocket: fake.socketPath,
    });
    await fake.close();

    expect(run.final.tickets["01"]).toBe("done");
    // The Stream file is the script typescript: the session's raw bytes.
    const stream = readFileSync(join(poolDir, "runs", "01.stream.jsonl"), "utf8");
    expect(stream).toContain("opencode agent working");
    // The log is the readable transcript derived from it.
    const log = readFileSync(join(poolDir, "runs", "01.log"), "utf8");
    expect(log).toContain("opencode agent working");
  }, 20000);
});

describe("checkpoints", () => {
  it("writes a sqlite checkpoint to the pool directory after every super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq")
      .all() as { state: string }[];
    db.close();

    // Two super-step joins, the review gate, the quiescent final, the
    // approval's own persist (a processed answer persists its state change),
    // and the approval's done final.
    expect(rows.length).toBe(6);
    const first = JSON.parse(rows[0].state);
    const second = JSON.parse(rows[1].state);
    const approved = JSON.parse(rows[4].state);
    const terminal = JSON.parse(rows[5].state);
    expect(first.tickets).toEqual({ "01": "done", "02": "ready" });
    expect(second.tickets).toEqual({ "01": "done", "02": "done" });
    expect(second.outcomes["01"].summary).toBe("summary-01");
    expect(approved.interrupts).toEqual([]);
    expect(approved.reviewApproved).toBe(true);
    expect(terminal.log.at(-1)).toBe("pool done: every ticket reached done");
    expect(terminal.reviewApproved).toBe(true);
    expect(run.snapshots.at(-1)?.phase).toBe("done");
  });
});

describe("persist failures", () => {
  // The substitutable-store seam: a real sqlite store wrapped in one whose
  // write fails on demand. The wrapper counts every write attempt (failed or
  // not) and every close, so a test can see the retries and prove a persist
  // failure never closed the store.
  class FlakyStore implements CheckpointStore {
    writeAttempts = 0;
    closeCalls = 0;
    private inner: CheckpointStore;
    constructor(
      poolDir: string,
      public failWritesLeft: number,
    ) {
      this.inner = new SqliteCheckpointStore(poolDir);
    }
    write(state: unknown): void {
      this.writeAttempts += 1;
      if (this.failWritesLeft > 0) {
        this.failWritesLeft -= 1;
        throw new Error("db is down");
      }
      this.inner.write(state);
    }
    latest(): unknown | null {
      return this.inner.latest();
    }
    close(): void {
      this.closeCalls += 1;
      this.inner.close();
    }
  }

  function checkpointRows(poolDir: string): { state: string }[] {
    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq")
      .all() as { state: string }[];
    db.close();
    return rows;
  }

  it("retries a failed boundary persist and recovers: the next ticket is scheduled and the row lands", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    // The first write attempt throws; the retry lands the row and the run
    // carries on as if nothing happened.
    const store = new FlakyStore(poolDir, 1);

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses, store }),
    );

    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(run.phase).toBe("done");
    // Six healthy persists in a run to done: the failed boundary's retry,
    // the second boundary, the review gate, the first drive's final, the
    // answered-review drain persist, and the finished run's final. Plus the
    // one failed boundary attempt that the retry recovered.
    expect(store.writeAttempts).toBe(7);
    const rows = checkpointRows(poolDir);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].state).tickets).toEqual({
      "01": "done",
      "02": "ready",
    });
  });

  it("raises the persistence interrupt when the store keeps failing, and the store remains open", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    const store = new FlakyStore(poolDir, Infinity);

    const run = await runPool({ poolDir, harnesses: rig.harnesses, store });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toHaveLength(1);
    expect(run.interrupts[0].ticketId).toBe(PERSISTENCE_TICKET_ID);
    expect(run.interrupts[0].kind).toBe("persistence");
    expect(run.interrupts[0].body).toContain("persistence is failing");
    expect(run.interrupts[0].body).toContain("db is down");
    // Ticket 01 ran; the failing boundary stopped any further scheduling.
    expect(rig.spawnOrder).toEqual(["01"]);
    // Bounded retries, not a forever loop: the boundary persist and the
    // final settle each make four write attempts (1 + 3 backoff retries).
    expect(store.writeAttempts).toBe(8);
    // A persist failure never closes the checkpoint store.
    expect(store.closeCalls).toBe(0);
    expect(checkpointRows(poolDir)).toHaveLength(0);

    // Once the store is healthy again, answering the interrupt continues
    // the run: the next boundary write lands and the pool reaches Review.
    store.failWritesLeft = 0;
    const resumed = await run.resume(PERSISTENCE_TICKET_ID);
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(checkpointRows(poolDir).length).toBeGreaterThan(0);
  });

  it("resumes cleanly from disk after a restart when the store kept failing", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    const store = new FlakyStore(poolDir, Infinity);

    const first = await runPool({ poolDir, harnesses: rig.harnesses, store });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The markers were written before the store write failed, so disk says
    // 01 done: restart-from-disk is the escape hatch, and 01 never re-runs.
    expect(markerStatuses(poolDir, ["01-a.md", "02-b.md"])).toEqual({
      "01": "done",
      "02": "ready",
    });
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect((await approveReview(second)).phase).toBe("done");
  });

  it("never reports dead for a persist failure the retry seam handles", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});
    const store = new FlakyStore(poolDir, Infinity);

    const run = await runPool({ poolDir, harnesses: rig.harnesses, store });

    // The persistence interrupt is the outcome, exactly as ticket 01 left it:
    // the run settles quiescent and no dead phase, dead error log, or pool
    // dead line may appear.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.some((i) => i.kind === "persistence")).toBe(true);
    expect(run.snapshots.map((s) => s.phase)).not.toContain("dead");
    expect(run.final.log.some((line) => line.startsWith("pool dead"))).toBe(
      false,
    );
    expect(existsSync(join(poolDir, "runs", "errors.jsonl"))).toBe(false);
  });
});

describe("dead drives report themselves", () => {
  // A harness command naming a binary that does not exist: Bun.spawn throws
  // "Executable not found in $PATH" from inside the super-step, which is a
  // genuine drive-killing error no catch along the way handles. The pool's
  // config points its default harness ("stub") at it.
  const killingHarnesses: Record<string, HarnessCommand> = {
    stub: () => ["definitely-not-a-real-harness-binary"],
  };

  it("reports a drive-killing error through the shared mechanism: durable error log, pool log, and the terminal dead phase", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = startPool({ poolDir, harnesses: killingHarnesses });
    // Registered synchronously, before the spawn's rejection can settle the
    // drive: nextSettle only reports a past error through its waiters.
    const settled = run.settled;

    await expect(settled).rejects.toThrow(/Executable not found/);

    // The terminal dead phase, emitted before the waiters were settled.
    expect(run.phase).toBe("dead");
    const phases = run.snapshots.map((s) => s.phase);
    expect(phases.at(-1)).toBe("dead");
    // Everything before the death is an ordinary running snapshot; the dead
    // phase is the only terminal one the run ever emitted.
    expect(phases.slice(0, -1).every((p) => p === "running")).toBe(true);

    // The durable JSONL error log in the pool's runs directory: one line,
    // naming the error, with a timestamp.
    const errorsPath = join(poolDir, "runs", "errors.jsonl");
    expect(existsSync(errorsPath)).toBe(true);
    const lines = readFileSync(errorsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as { at: string; error: string };
    expect(typeof entry.at).toBe("string");
    expect(entry.error).toContain("definitely-not-a-real-harness-binary");

    // The same error in the pool log, the Console log drawer's channel.
    expect(run.final.log.at(-1)).toContain("pool dead:");
    expect(run.final.log.at(-1)).toContain(
      "definitely-not-a-real-harness-binary",
    );
  });

  it("leaves restart-from-disk working after a dead drive", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const dead = startPool({ poolDir, harnesses: killingHarnesses });
    await expect(dead.settled).rejects.toThrow(/Executable not found/);

    // The escape hatch still works: a fresh run on the same pool directory
    // rehydrates from the markers on disk (the dead attempt had marked the
    // ticket in-progress, so restart resets it to ready) and runs to done.
    const rig = stubHarness({});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(rig.spawnOrder).toEqual(["01"]);
    expect((await approveReview(second)).phase).toBe("done");
    // The dead drive's error log survives the restart.
    expect(existsSync(join(poolDir, "runs", "errors.jsonl"))).toBe(true);
  });
});

describe("interrupts", () => {
  it("raises a checkpoint interrupt carrying the Issue's Brief", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body:
            "# 01\n\n## Brief\n\n1. did the first half\n" +
            "2. human must pick a name\n\n## Notes\n\nunrelated",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": {
        status: "checkpoint",
        brief: "1. did the first half\n2. human must pick a name",
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "checkpoint",
        body: "1. did the first half\n2. human must pick a name",
      },
    ]);
    expect(run.final.tickets["01"]).toBe("checkpoint");
    expect(run.final.tickets["02"]).toBe("ready");
    expect(run.snapshots.at(-1)?.phase).toBe("quiescent");
    expect(run.snapshots.at(-1)?.state.interrupts).toHaveLength(1);
  });

  it("raises a crash interrupt carrying the log path when the attempt writes no outcome", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "keep", exitCode: 1 } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body:
          join(poolDir, "runs", "01.log") +
          "\n\n" +
          "outcome file: " +
          join(poolDir, "runs", "01.outcome.json") +
          " (missing)\n",
      },
    ]);
    expect(run.final.log.some((line) => line.includes("exited 1"))).toBe(true);
  });

  it("treats a marker rewritten to ready as a crash, not a respawn", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    // The harness exits having set its own marker back to ready and written
    // no outcome: a crash with extra steps. The agent-written marker is
    // ignored (the clean break), so this re-spawns nothing and reaches a
    // human.
    const rig = stubHarness({ "01": { status: "ready", exitCode: 0 } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "crash",
        body:
          join(poolDir, "runs", "01.log") +
          "\n\n" +
          "outcome file: " +
          join(poolDir, "runs", "01.outcome.json") +
          " (missing)\n",
      },
    ]);
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("raises deadlock interrupts for a blocked-by cycle without spawning", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "deadlock",
        body: "blockers can never complete: 02",
      },
      {
        ticketId: "02",
        kind: "deadlock",
        body: "blockers can never complete: 01",
      },
    ]);
  });

  it("keeps ready siblings running while a ticket is interrupted", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.final.log).toContain("super-step 1: 01, 02");
    expect(run.final.log).toContain("super-step 2: 03");
    expect(run.final.tickets).toEqual({
      "01": "checkpoint",
      "02": "done",
      "03": "done",
    });
    expect(run.interrupts).toHaveLength(1);
    expect(run.phase).toBe("quiescent");
  });

  it("resume-with-answer restarts the ticket and continues the pool", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "done"] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    const snapshotsBefore = run.snapshots.length;

    const resumed = await run.resume("01", "carry on with option two");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(rig.spawnOrder).toEqual(["01", "01", "02"]);
    expect(done.snapshots.length).toBeGreaterThan(snapshotsBefore);
    expect(done.final.log).toContain(
      "interrupt answered for 01 (checkpoint): resumed",
    );
    const markerLines = ["01-a.md", "02-b.md"].map(
      (file) =>
        readFileSync(join(poolDir, "issues", file), "utf8").split("\n")[0],
    );
    for (const line of markerLines) {
      expect(line).toContain("status=done");
    }
  });

  it("holds a dependent behind a checkpointed blocker without a deadlock, then schedules it after resume", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "done"], brief: "need a decision" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // Only done satisfies the edge: 02 never spawns while 01 sits at
    // checkpoint, and a human-resumable pause is not a deadlock.
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(run.final.tickets).toEqual({ "01": "checkpoint", "02": "ready" });
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "need a decision" },
    ]);
    expect(run.phase).toBe("quiescent");

    const resumed = await run.resume("01", "carry on");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(rig.spawnOrder).toEqual(["01", "01", "02"]);
  });

  it("appends the resume note to the Issue file", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    await run.resume("01", "picked the name Foo");

    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("picked the name Foo");
  });

  it("rejects resuming a ticket with no pending interrupt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    await expect(run.resume("02")).rejects.toThrow(/no pending interrupt/);
  });

  it("resumes a deadlock after the pool files are fixed", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=02 status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual([
      "deadlock",
      "deadlock",
    ]);

    writeFileSync(
      join(poolDir, "issues", "02-b.md"),
      "<!-- state: id=02 blocked-by=none status=ready -->\n\n# 02\n",
    );
    const resumed = await run.resume("02", "broke the cycle");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["02", "01"]);
  });

  it("distinguishes quiescent from done in emitted state", async () => {
    const stuckDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const stuck = await runPool({
      poolDir: stuckDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });

    const cleanDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const clean = await runPool({
      poolDir: cleanDir,
      harnesses: stubHarness({}).harnesses,
    });

    expect(stuck.phase).toBe("quiescent");
    expect(stuck.interrupts).toHaveLength(1);
    expect(stuck.snapshots.at(-1)?.phase).toBe("quiescent");
    // A clean run stops at the final Review interrupt; approving ends it.
    expect(clean.phase).toBe("quiescent");
    expect(clean.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const done = await approveReview(clean);
    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.snapshots.at(-1)?.phase).toBe("done");
  });

  it("raises a deadlock interrupt for a blocker id that does not exist", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=99 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "deadlock",
        body: "blockers can never complete: 99",
      },
    ]);
  });

  it("keeps a crashed ticket's interrupt pending across rehydration", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["keep", "done"] } });

    const first = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(first.interrupts[0]?.kind).toBe("crash");
    first.close();

    // The marker still reads in-progress, but the pending crash interrupt
    // means a human has not looked yet: rehydration must not silently
    // re-run the ticket.
    const second = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(second.phase).toBe("quiescent");
    expect(second.interrupts[0]?.kind).toBe("crash");
    expect(rig.spawnOrder).toEqual(["01"]);
    const resumed = await second.resume("01");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
  });

  it("resumes a crash interrupt by re-running the ticket", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["keep", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts[0]?.kind).toBe("crash");

    const resumed = await run.resume("01");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(done.final.log).toContain(
      "interrupt answered for 01 (crash): resumed",
    );
  });
});

describe("outcome contract", () => {
  // The agent's only result channel is the outcome JSON (ADR-0005); the
  // engine owns the marker. These tests assert externally visible behavior
  // only: the marker on disk, the ticket-log events, and the interrupt.

  const oneTicket = (): string =>
    makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

  function readEvents(poolDir: string, id: string) {
    return readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
  }

  it("writes the done marker itself when the outcome says done", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The stub never touched the Issue; the done on disk is the engine's
    // write from the outcome JSON.
    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
  });

  it("records a crash when the agent writes no outcome", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "keep" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "no outcome written",
      logTail: [],
      outcomeExists: false,
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("never honors a stale outcome a previous attempt left behind", async () => {
    const poolDir = oneTicket();
    // Attempt 1 checkpoints with a valid outcome; the resume re-runs the
    // ticket and attempt 2 exits 0 writing nothing. The spawn-side delete
    // means the stale checkpoint file is gone, so this is a crash, not a
    // re-raised checkpoint carrying the old brief.
    const rig = stubHarness({
      "01": { statuses: ["checkpoint", "keep"], brief: "pick a name" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts[0]?.kind).toBe("checkpoint");

    const resumed = await run.resume("01", "go with the first");

    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "no outcome written",
      logTail: [],
      outcomeExists: false,
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("records a crash when the outcome is not parseable", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { outcomeRaw: "not json" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "outcome is not parseable JSON",
      logTail: [],
      outcomeExists: true,
    });
  });

  it("records a crash when the outcome's status is invalid", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({
      "01": { outcomeRaw: '{"status":"dnoe","summary":"x","commitSha":null}' },
    });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 0,
      reason: "outcome's status is not done or checkpoint",
      logTail: [],
      outcomeExists: true,
    });
  });

  it("records a crash for a valid done outcome with a non-zero exit", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "done", exitCode: 1 } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(readEvents(poolDir, "01").at(-1)?.payload).toEqual({
      code: 1,
      reason: "harness exited 1",
      logTail: [],
      outcomeExists: true,
    });
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("ignores a done marker the agent wrote directly and never re-spawns", async () => {
    const poolDir = oneTicket();
    // The old protocol's slip: the agent seds the marker to done but writes
    // no outcome. The clean break ignores the marker, records the crash, and
    // corrects the marker back to in-progress.
    const rig = stubHarness({ "01": { status: "marker-done" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts[0]?.kind).toBe("crash");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(markerLine(poolDir, "01-a.md")).toContain("status=in-progress");
  });

  it("writes the checkpoint marker itself when the outcome says checkpoint", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({
      "01": { status: "checkpoint", brief: "pick a name" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The stub never touched the Issue; the checkpoint on disk is the
    // engine's write from the outcome JSON, and the interrupt was raised.
    expect(run.phase).toBe("quiescent");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=checkpoint");
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    const kinds = readEvents(poolDir, "01").map((e) => e.kind);
    expect(kinds).toEqual(["scheduled", "spawned", "exited", "checkpoint"]);
    expect(readEvents(poolDir, "01")[2]?.payload).toEqual({
      code: 0,
      status: "checkpoint",
      logTail: [],
      outcomeExists: true,
    });
  });

  it("appends the outcome's brief as the Issue's Brief section, replacing a stale one", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nstale brief from an earlier attempt",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { status: "checkpoint", brief: "fresh brief" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The interrupt's body comes from the section the engine just landed,
    // never from a Brief an earlier attempt left behind.
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "fresh brief" },
    ]);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief\n\nfresh brief");
    expect(issueText).not.toContain("stale brief from an earlier attempt");
    expect(
      issueText.split("\n").filter((line) => line.startsWith("## Brief")),
    ).toHaveLength(1);
  });

  it("lands a placeholder Brief section when a checkpoint outcome has no brief", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The pause was signalled, so it is not a crash: the interrupt stands
    // and its body is the engine's placeholder.
    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("wrote no brief");
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief, written by the engine");
  });

  it("replaces a stale Brief with the placeholder when a later checkpoint has no brief", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nstale brief from an earlier attempt",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The Brief section always mirrors the latest attempt: a stale brief
    // never masquerades as the current one.
    expect(run.interrupts[0]?.kind).toBe("checkpoint");
    expect(run.interrupts[0]?.body).toContain("wrote no brief");
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).not.toContain("stale brief from an earlier attempt");
    expect(
      issueText.split("\n").filter((line) => line.startsWith("## Brief")),
    ).toHaveLength(1);
  });

  it("re-raises the checkpoint interrupt from the engine-written Brief after a restart", async () => {
    const poolDir = oneTicket();
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({
        "01": { status: "checkpoint", brief: "pick a name" },
      }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // Killed before the boundary persist: no stored checkpoint survives,
    // but the marker and the Brief the engine landed are on disk, so
    // rehydration re-raises the interrupt from the Issue unchanged.
    rmSync(join(poolDir, "console.db"), { force: true });
    const rig = stubHarness({});
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(second.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(second.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
  });
});

describe("outcome spawn schema", () => {
  // ADR-0010: an Outcome may carry an optional spawn array of follow-up
  // ticket proposals. Validation is per proposal, never per attempt: a
  // malformed entry is rejected with a reason while the attempt's own
  // done/checkpoint stands, so the schema tests go through the exported
  // validateOutcome and the behaviour tests through the stub harness.

  const oneTicket = (): string =>
    makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

  const goodBody = "A body long enough to stand as a ticket.";

  function okOutcome(result: ReturnType<typeof validateOutcome>) {
    if (!result.ok) {
      throw new Error(`expected a valid outcome, got: ${result.reason}`);
    }
    return result;
  }

  it("accepts a spawn array and preserves each proposal's shape", () => {
    const spawn = [
      {
        title: "Follow up",
        body: goodBody,
        blockedBy: ["02"],
      },
      {
        title: "No blockers",
        body: goodBody,
        blockedBy: [],
      },
      {
        title: "Blockers omitted",
        body: goodBody,
      },
    ];

    const result = okOutcome(
      validateOutcome({ status: "done", summary: "s", commitSha: "abc", spawn }),
    );

    expect(result.outcome.spawn).toEqual(spawn);
    expect(result.spawnRejections).toBeUndefined();
    const [, , omitted] = result.outcome.spawn ?? [];
    expect(Object.keys(omitted ?? {})).toEqual(["title", "body"]);
  });

  it("keeps an empty spawn array without rejections", () => {
    const result = okOutcome(
      validateOutcome({ status: "done", summary: "s", commitSha: null, spawn: [] }),
    );

    expect(result.outcome.spawn).toEqual([]);
    expect(result.spawnRejections).toBeUndefined();
  });

  it("rejects a spawn key that is not an array", () => {
    const result = okOutcome(
      validateOutcome({ status: "done", summary: "s", commitSha: null, spawn: "yes" }),
    );

    expect(result.outcome.spawn).toEqual([]);
    expect(result.spawnRejections).toEqual([{ reason: "spawn is not an array" }]);
  });

  it("rejects a malformed spawn entry per proposal with a clear reason", () => {
    const cases: { entry: unknown; reason: string }[] = [
      {
        entry: { body: goodBody },
        reason: "proposal has no title",
      },
      {
        entry: { title: "   ", body: goodBody },
        reason: "proposal has no title",
      },
      {
        entry: { title: "No body" },
        reason: "proposal body is missing or thin (needs 20+ characters)",
      },
      {
        entry: { title: "No body", body: "   " },
        reason: "proposal body is missing or thin (needs 20+ characters)",
      },
      {
        entry: { title: "Thin", body: "too thin" },
        reason: "proposal body is missing or thin (needs 20+ characters)",
      },
      {
        entry: { title: "T", body: goodBody, blockedBy: "02" },
        reason: "proposal's blockedBy is not a list of strings",
      },
      {
        entry: { title: "T", body: goodBody, blockedBy: [1] },
        reason: "proposal's blockedBy is not a list of strings",
      },
      {
        entry: { title: "T", body: goodBody, blockedBy: ["  "] },
        reason: "proposal's blockedBy is not a list of strings",
      },
      {
        entry: { title: "T", body: goodBody, blockedBy: null },
        reason: "proposal's blockedBy is not a list of strings",
      },
      {
        entry: 42,
        reason: "spawn entry is not an object",
      },
      {
        entry: null,
        reason: "spawn entry is not an object",
      },
      {
        entry: ["x"],
        reason: "spawn entry is not an object",
      },
    ];

    for (const { entry, reason } of cases) {
      const result = okOutcome(
        validateOutcome({ status: "done", summary: "s", commitSha: null, spawn: [entry] }),
      );

      expect(result.outcome.spawn).toEqual([]);
      expect(result.spawnRejections).toEqual([{ index: 0, reason }]);
    }
  });

  it("keeps the well-formed entries around a malformed one, naming the bad index", () => {
    const good = { title: "Follow up", body: goodBody };

    const result = okOutcome(
      validateOutcome({
        status: "done",
        summary: "s",
        commitSha: null,
        spawn: [good, { title: "Thin" }, good],
      }),
    );

    expect(result.outcome.spawn).toEqual([good, good]);
    expect(result.spawnRejections).toEqual([
      { index: 1, reason: "proposal body is missing or thin (needs 20+ characters)" },
    ]);
  });

  it("passes an outcome with no spawn key byte-for-byte as today", () => {
    const done = okOutcome(
      validateOutcome({ status: "done", summary: "s", commitSha: null }),
    );

    expect(done.outcome).toEqual({ status: "done", summary: "s", commitSha: null });
    expect("spawn" in done.outcome).toBe(false);
    expect(done.spawnRejections).toBeUndefined();

    const checkpoint = okOutcome(
      validateOutcome({ status: "checkpoint", summary: "s", brief: "b" }),
    );

    expect(checkpoint.outcome).toEqual({
      status: "checkpoint",
      summary: "s",
      commitSha: null,
      brief: "b",
    });
    expect("spawn" in checkpoint.outcome).toBe(false);
  });

  it("carries a valid spawn array through a done attempt untouched", async () => {
    const poolDir = oneTicket();
    const spawn = [
      { title: "Follow up", body: goodBody, blockedBy: ["02"] },
    ];
    const rig = stubHarness({ "01": { spawn } });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
    expect(run.final.outcomes["01"]).toEqual({
      status: "done",
      summary: "summary-01",
      commitSha: "sha-01",
      spawn,
    });
  });

  it("keeps a done attempt's result when one spawn entry is malformed", async () => {
    const poolDir = oneTicket();
    const good = { title: "Follow up", body: goodBody };
    const rig = stubHarness({ "01": { spawn: [good, { title: "Thin" }] } });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-a.md")).toContain("status=done");
    const exited = readEventLines(poolDir, "01").find((e) => e.kind === "exited");
    expect(exited?.payload).toEqual({
      code: 0,
      status: "done",
      logTail: [],
      outcomeExists: true,
    });
    expect(run.final.outcomes["01"]?.spawn).toEqual([good]);
  });

  it("raises the checkpoint interrupt unchanged when a checkpoint outcome carries spawn", async () => {
    const poolDir = oneTicket();
    const rig = stubHarness({
      "01": {
        status: "checkpoint",
        brief: "pick a name",
        spawn: [{ title: "Follow up", body: goodBody }],
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    expect(markerLine(poolDir, "01-a.md")).toContain("status=checkpoint");
  });
});

describe("spawn adoption", () => {
  // ADR-0010: the engine writes accepted proposals into the pool at the
  // super-step boundary as ordinary tickets, reloads markers and resolves
  // assignments, and the drive loop schedules them like any other ticket.
  // The behaviour is observable: ticket files on disk, events on the
  // proposing ticket's log, and the scheduled set.

  const goodBody = "A body long enough to stand as a ticket.";
  const proposal = (title: string, blockedBy?: string[]) => ({
    title,
    body: goodBody,
    ...(blockedBy ? { blockedBy } : {}),
  });

  it("writes valid proposals as ordinary tickets and schedules them once their blockers finish", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01"), readyTicket("02", "01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [proposal("After two", ["02"]), proposal("Anytime")] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(true);
    expect(existsSync(join(poolDir, "issues", "01-spawn-2.md"))).toBe(true);
    // The engine assigned the ids and the markers: the ordinary blocking
    // edge, engine-owned ready status, and the spawned-by provenance.
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain(
      "id=01-spawn-1 blocked-by=02",
    );
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("spawned-by=01");
    expect(markerLine(poolDir, "01-spawn-2.md")).toContain(
      "id=01-spawn-2 blocked-by=none",
    );
    expect(readFileSync(join(poolDir, "issues", "01-spawn-1.md"), "utf8"))
      .toContain("# 01-spawn-1: After two");
    // Both ran as ordinary tickets: scheduled, spawned, exited, done.
    expect(readEventLines(poolDir, "01-spawn-1").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(readEventLines(poolDir, "01-spawn-2").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(run.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "01-spawn-1": "done",
      "01-spawn-2": "done",
    });
  });

  it("holds a proposal blocked by an in-flight ticket until the blocker finishes", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01"), readyTicket("02", "01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [proposal("After two", ["02"])] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // The adopted ticket was ready in the snapshots while its blocker ran,
    // scheduled in its own super-step only after that blocker finished.
    expect(
      run.snapshots.some((s) => s.state.tickets["01-spawn-1"] === "ready"),
    ).toBe(true);
    expect(run.final.log).toContain("super-step 1: 01");
    expect(run.final.log).toContain("super-step 2: 02");
    expect(run.final.log).toContain("super-step 3: 01-spawn-1");
  });

  it("drops a proposal whose blockedBy names an unknown ticket, with the reason on the ticket log", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [proposal("Ghost", ["99"])] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The attempt's own done stands; the proposal is gone with its reason.
    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(false);
    const rejected = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawn-rejected",
    );
    expect(rejected?.payload).toMatchObject({
      title: "Ghost",
      reason: "blockedBy names tickets outside the pool: 99",
    });
    expect(run.final.log).toContain(
      "ticket 01: spawn proposal 'Ghost' rejected: " +
        "blockedBy names tickets outside the pool: 99",
    );
  });

  it("drops a thin-body proposal with the reason on the ticket log", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [{ title: "Thin", body: "too thin" }] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=done");
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(false);
    const rejected = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawn-rejected",
    );
    expect(rejected?.payload).toMatchObject({
      index: 0,
      reason: "proposal body is missing or thin (needs 20+ characters)",
    });
  });

  it("honors the per-attempt cap of five and logs the truncation", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": {
        spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`Number ${n}`)),
      },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    for (const n of [1, 2, 3, 4, 5]) {
      expect(existsSync(join(poolDir, "issues", `01-spawn-${n}.md`))).toBe(
        true,
      );
    }
    expect(existsSync(join(poolDir, "issues", "01-spawn-6.md"))).toBe(false);
    expect(existsSync(join(poolDir, "issues", "01-spawn-7.md"))).toBe(false);
    const adopted = readEventLines(poolDir, "01").find(
      (e) => e.kind === "spawn-adopted",
    );
    expect(adopted?.payload).toEqual({
      adopted: [
        "01-spawn-1",
        "01-spawn-2",
        "01-spawn-3",
        "01-spawn-4",
        "01-spawn-5",
      ],
      truncated: 2,
    });
    expect(
      run.final.log.some(
        (line) =>
          line.startsWith("ticket 01: adopted spawn tickets") &&
          line.includes("2 proposals truncated at the caps"),
      ),
    ).toBe(true);
  }, 15000);

  it("honors the per-run cap of twenty across attempts and logs the truncation", async () => {
    const poolDir = makePool({
      tickets: [
        readyTicket("01"),
        readyTicket("02"),
        readyTicket("03"),
        readyTicket("04"),
        readyTicket("05"),
      ],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) },
      "02": { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) },
      "03": { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) },
      "04": { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) },
      "05": { spawn: [1, 2, 3, 4, 5, 6, 7].map((n) => proposal(`N${n}`)) },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // Twenty files land, five per parent for whichever four parents reached
    // the boundary first; the fifth finds no room left in the run cap.
    const spawnFiles = Array.from({ length: 25 }, (_, i) => {
      const parent = `0${(i % 5) + 1}`;
      const n = Math.floor(i / 5) + 1;
      return `issues/${parent}-spawn-${n}.md`;
    }).filter((file) => existsSync(join(poolDir, file)));
    expect(spawnFiles).toHaveLength(20);
    // The attempts run in parallel, so which parent truncated is racy; that
    // exactly one did, with all seven proposals dropped, is not.
    const adoptEvents = ["01", "02", "03", "04", "05"].flatMap((id) =>
      readEventLines(poolDir, id)
        .filter((e) => e.kind === "spawn-adopted")
        .map((e) => e.payload as { adopted: string[]; truncated: number }),
    );
    expect(adoptEvents).toHaveLength(5);
    expect(adoptEvents.filter((p) => p.adopted.length === 5)).toHaveLength(4);
    expect(adoptEvents.filter((p) => p.adopted.length === 0)).toEqual([
      { adopted: [], truncated: 7 },
    ]);
    expect(
      run.final.log.some((line) => line.includes("truncated at the caps")),
    ).toBe(true);
  }, 15000);

  it("lets a spawned ticket's own attempt spawn further tickets", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { spawn: [proposal("Child")] },
      "01-spawn-1": { spawn: [proposal("Grandchild")] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(true);
    expect(existsSync(join(poolDir, "issues", "01-spawn-1-spawn-1.md"))).toBe(
      true,
    );
    expect(markerLine(poolDir, "01-spawn-1-spawn-1.md")).toContain(
      "id=01-spawn-1-spawn-1 blocked-by=none",
    );
    expect(markerLine(poolDir, "01-spawn-1-spawn-1.md")).toContain(
      "spawned-by=01-spawn-1",
    );
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-spawn-1": "done",
      "01-spawn-1-spawn-1": "done",
    });
  });

  it("ignores a grader's spawn and adopts the passing attempt's own proposals", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, assign: { "01": { verify: 1 } } },
    });
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "cand-1.txt",
        commitMsg: "cand-1",
        spawn: [proposal("From the attempt")],
      },
      "01-grader-1": {
        grade: { score: 9, verdict: "pass", reasons: "fine" },
        spawn: [proposal("From the grader")],
      },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // Grader outcomes are engine-consumed: a spawn key from one is ignored.
    expect(existsSync(join(poolDir, "issues", "01-grader-1-spawn-1.md"))).toBe(
      false,
    );
    // The attempt's outcome became the ticket's, and its proposal adopted.
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(true);
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("spawned-by=01");
    expect(run.final.tickets["01-spawn-1"]).toBe("done");
  }, 15000);

  it("ignores a spawn key on the head-to-head outcome", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: { ...stubConfig, assign: { "01": { verify: 2 } } },
    });
    const grade = (score: number) => ({
      grade: { score, verdict: "pass" as const, reasons: `scored ${score}` },
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        {
          workFile: "cand-1.txt",
          commitMsg: "cand-1",
          spawn: [proposal("From the winner")],
        },
        { workFile: "cand-2.txt", commitMsg: "cand-2" },
      ],
      "01-grader-1": grade(8),
      "01-grader-2": grade(7),
      "01-head-to-head": { winner: 1, spawn: [proposal("From the judge")] },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    const selected = readEventLines(poolDir, "01").find(
      (e) => e.kind === "selected",
    );
    expect(selected?.attempt).toBe(1);
    expect(existsSync(join(poolDir, "issues", "01-head-to-head-spawn-1.md")))
      .toBe(false);
    expect(run.final.tickets["01"]).toBe("done");
    // The winner's outcome became the ticket's, and its proposal adopted.
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(true);
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("spawned-by=01");
  }, 15000);

  it("does not adopt a crashed attempt's proposals", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": { exitCode: 3, spawn: [proposal("From a crash")] },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    // The crash owns the ticket; proposals from work that never landed die
    // with it, and a resume re-runs the attempt instead.
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(false);
  });

  it("does not report done while a freshly spawned ready ticket still runs", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { spawn: [proposal("The real end")] } });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // A premature done would have stopped the drive before the adopted
    // ticket ever scheduled; its own full lifecycle is the proof it did not.
    expect(run.phase).toBe("done");
    expect(run.final.log).toContain("super-step 1: 01");
    expect(run.final.log).toContain("super-step 2: 01-spawn-1");
    expect(readEventLines(poolDir, "01-spawn-1").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("status=done");
  });

  it("rejects a hand-written ticket in the reserved namespace at pool start", async () => {
    const poolDir = makePool({
      tickets: [
        readyTicket("01"),
        {
          file: "01-spawn-9.md",
          marker: "<!-- state: id=01-spawn-9 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    await expect(
      runPool({ poolDir, harnesses: stubHarness({}).harnesses }),
    ).rejects.toThrow(/reserved/);
  });

  it("restarts over adopted tickets, inheriting the parent's assignment", async () => {
    const poolDir = makePool({
      tickets: [
        readyTicket("01"),
        {
          file: "01-spawn-1.md",
          marker:
            "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->",
          body: "# 01-spawn-1: Adopted earlier\n\nAlready on disk.\n",
        },
      ],
      // No defaults: the spawned id resolves only through its parent.
      config: { assign: { "01": { harness: "stub", model: "stub-model" } } },
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(rig.spawned["01-spawn-1"]).toBeDefined();
    expect(run.final.tickets).toEqual({
      "01": "done",
      "01-spawn-1": "done",
    });
  });

  it("serves spawned tickets the Assignment inherited from their parent on the snapshot", async () => {
    const poolDir = makePool({
      tickets: [
        readyTicket("01"),
        {
          file: "01-spawn-1.md",
          marker:
            "<!-- state: id=01-spawn-1 blocked-by=none status=ready spawned-by=01 -->",
          body: "# 01-spawn-1: Adopted earlier\n\nAlready on disk.\n",
        },
      ],
      // No defaults: the spawned id resolves only through its parent, so the
      // record can only come from inheritance. The spawned id's own assign
      // entry overrides field-wise: drivers here, harness and model inherited.
      config: {
        assign: {
          "01": { harness: "stub", model: "parent-model" },
          "01-spawn-1": { drivers: "implement code-review" },
        },
      },
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    const last = run.snapshots[run.snapshots.length - 1]!;
    expect(last.assignments["01"]).toEqual({
      harness: "stub",
      model: "parent-model",
      drivers: "implement",
    });
    expect(last.assignments["01-spawn-1"]).toEqual({
      harness: "stub",
      model: "parent-model",
      drivers: "implement code-review",
    });
  });

  it("adopts a checkpoint attempt's proposals while the run pauses on the interrupt", async () => {
    const poolDir = makePool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = stubHarness({
      "01": {
        status: "checkpoint",
        brief: "pick a name",
        spawn: [proposal("While paused")],
      },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
    // The proposal was adopted and ran to done; the parent still holds the
    // run at its checkpoint.
    expect(existsSync(join(poolDir, "issues", "01-spawn-1.md"))).toBe(true);
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("status=done");
    expect(markerLine(poolDir, "01-t.md")).toContain("status=checkpoint");
  });

  it("grades a spawned ticket whose assign sets verify", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01")],
      config: {
        ...stubConfig,
        assign: { "01-spawn-1": { verify: 1 } },
      },
    });
    const rig = gitStubHarness(poolDir, {
      "01": { spawn: [proposal("Graded child")] },
      "01-spawn-1": { workFile: "child.txt", commitMsg: "child" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // The spawned ticket ran as a verify fan-out: one grader ticket, written
    // and engine-run like any other, then the lone-attempt pass completed it.
    expect(existsSync(join(poolDir, "issues", "01-spawn-1-grader-1.md"))).toBe(
      true,
    );
    expect(markerLine(poolDir, "01-spawn-1-grader-1.md")).toContain(
      "status=done",
    );
    expect(markerLine(poolDir, "01-spawn-1.md")).toContain("status=done");
    expect(
      readEventLines(poolDir, "01-spawn-1").some((e) => e.kind === "graded"),
    ).toBe(true);
  }, 15000);
});

describe("final review", () => {
  it("raises exactly one Review interrupt when every ticket is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts).toHaveLength(1);
    const review = run.interrupts[0];
    expect(review.ticketId).toBe(REVIEW_TICKET_ID);
    expect(review.kind).toBe("review");
    expect(review.body).toContain("every ticket is done");
    expect(review.body).toContain("- 01: summary-01");
    expect(review.body).toContain("- 02: summary-02");
    expect(run.final.log.at(-1)).toBe(
      "pool quiescent: interrupts pending for REVIEW",
    );
  });

  it("approve ends the run, and a restart comes up done without re-asking", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });
    const done = await run.approve(REVIEW_TICKET_ID, "looks right");

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(done.final.log).toContain(
      "review approved: the run is complete (looks right)",
    );
    expect(done.final.log.at(-1)).toBe("pool done: every ticket reached done");

    const rig = stubHarness({});
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(restarted.phase).toBe("done");
    expect(restarted.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual([]);
  });

  it("reject sends the named tickets and their downstream back to ready, and the run re-reviews", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
        {
          file: "04-d.md",
          marker: "<!-- state: id=04 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    const rejected = await run.reject(
      REVIEW_TICKET_ID,
      "redo 02: the parser is wrong",
    );

    // 02 went back to ready with the note on its Issue; its downstream 03
    // was invalidated with it (no note); 01 and 04 were left alone. The pool
    // re-ran both and stopped at a fresh Review.
    expect(rig.spawnOrder).toEqual(["01", "04", "02", "03", "02", "03"]);
    expect(rejected.phase).toBe("quiescent");
    expect(rejected.interrupts).toHaveLength(1);
    expect(rejected.interrupts[0].kind).toBe("review");
    expect(rejected.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
      "04": "done",
    });
    expect(rejected.final.log).toContain(
      "review rejected: 02 back to ready; downstream 03 also reset",
    );
    const issue02 = readFileSync(join(poolDir, "issues", "02-b.md"), "utf8");
    expect(issue02).toContain("## Review note");
    expect(issue02).toContain("redo 02: the parser is wrong");
    const issue03 = readFileSync(join(poolDir, "issues", "03-c.md"), "utf8");
    expect(issue03).not.toContain("## Review note");

    const done = await approveReview(rejected);
    expect(done.phase).toBe("done");
  });

  it("reject without a named ticket throws and keeps the gate up", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });

    await expect(
      run.reject(REVIEW_TICKET_ID, "this is not good enough"),
    ).rejects.toThrow(/name at least one ticket/);
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    // The reject failed at acceptance, so nothing was recorded: no answered
    // event in the log and no queued-answer record on disk. Before the
    // acceptance-time check both were written and the failure surfaced only
    // at processing, where no waiter was listening.
    const reviewEvents = join(poolDir, "runs", `${REVIEW_TICKET_ID}.events.jsonl`);
    if (existsSync(reviewEvents)) {
      const kinds = readFileSync(reviewEvents, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { kind: string }).kind);
      expect(kinds).not.toContain("answered");
    }
    expect(existsSync(join(poolDir, "runs", "queued-answers.json"))).toBe(false);

    const done = await approveReview(run);
    expect(done.phase).toBe("done");
  });

  it("refuses a plain resume on the review gate", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });

    const run = await runPool({
      poolDir,
      harnesses: stubHarness({}).harnesses,
    });

    await expect(run.resume(REVIEW_TICKET_ID)).rejects.toThrow(
      /use approve\(\) or reject\(\)/,
    );
  });

  it("an approve over a marker a human reset on disk continues to a fresh review", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    // run.sh reset the ticket behind the engine's back; the marker is the
    // truth, so the approval cannot close the run over work now unfinished.
    setMarker(poolDir, "01-a.md", "ready");
    const continued = await run.approve(REVIEW_TICKET_ID);

    expect(continued.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01", "01"]);
    expect(continued.final.log).toContain(
      "review approved, but markers on disk are not all done: the run " +
        "continues to a fresh review",
    );
    expect(continued.interrupts.map((i) => i.kind)).toEqual(["review"]);

    const done = await approveReview(continued);
    expect(done.phase).toBe("done");
  });

  it("holds the gate while another interrupt is pending", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);

    const resumed = await run.resume("01");
    expect(resumed.phase).toBe("quiescent");
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
  });
});

function markerLine(poolDir: string, file: string): string {
  return readFileSync(join(poolDir, "issues", file), "utf8").split("\n")[0];
}

function markerStatuses(poolDir: string, files: string[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [
      file.slice(0, 2),
      /status=([a-z-]+)/.exec(markerLine(poolDir, file))?.[1] ?? "",
    ]),
  );
}

function setMarker(poolDir: string, file: string, status: string): void {
  const path = join(poolDir, "issues", file);
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  lines[0] = lines[0].replace(/status=[a-z-]+/, `status=${status}`);
  writeFileSync(path, lines.join("\n"));
}

async function waitFor(cond: () => boolean, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await Bun.sleep(50);
  }
  throw new Error("waitFor: timed out");
}

describe("durability", () => {
  it("keeps the line-1 markers in agreement with every emitted snapshot", async () => {
    const files = ["01-a.md", "02-b.md"];
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { status: "checkpoint" } });
    const disagreements: string[] = [];

    const run = await runPool({
      poolDir,
      harnesses: rig.harnesses,
      onSnapshot: (snapshot) => {
        const markers = markerStatuses(poolDir, files);
        for (const [id, status] of Object.entries(snapshot.state.tickets)) {
          if (markers[id] !== status) {
            disagreements.push(
              `seq ${snapshot.seq}: state says ${id}=${status}, marker says ${markers[id]}`,
            );
          }
        }
      },
    });

    expect(disagreements).toEqual([]);
    expect(run.phase).toBe("quiescent");
    const db = new Database(join(poolDir, "console.db"), { readonly: true });
    const row = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .get() as { state: string };
    db.close();
    expect(JSON.parse(row.state).tickets).toEqual(
      markerStatuses(poolDir, files),
    );
    run.close();
  });

  it("re-runs a ticket whose marker was reset to ready after the checkpoint said done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await approveReview(
      await runPool({
        poolDir,
        harnesses: stubHarness({}).harnesses,
      }),
    );
    expect(first.phase).toBe("done");

    // run.sh reset 02: the marker on disk is the truth, the checkpoint's
    // done is stale, and the earlier review approval lapses with it.
    setMarker(poolDir, "02-b.md", "ready");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02"]);
  });

  it("clears a stored interrupt whose ticket the marker says is done", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The human finished 01 by hand. The marker wins over the stored
    // checkpoint interrupt.
    setMarker(poolDir, "01-a.md", "done");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(second.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["02"]);
    expect(second.final.log).toContain(
      "interrupt cleared for 01 (checkpoint): marker says done",
    );
  });

  it("resets an in-progress marker to ready: the agent holding it died with the process", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=in-progress -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(
      run.final.log.some((line) =>
        line.includes("back to ready"),
      ),
    ).toBe(true);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Brief, written by the engine");
    expect(issueText).toContain("back to ready");
  });

  it("clears a stored interrupt whose marker a human reset to ready", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\nneed a decision",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // run.sh reset 01: the human answered on disk. The stored interrupt
    // must not linger into the next engine run.
    setMarker(poolDir, "01-a.md", "ready");
    const rig = stubHarness({});
    const second = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(second.phase).toBe("done");
    expect(second.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(second.final.log).toContain(
      "interrupt cleared for 01 (checkpoint): marker says ready",
    );
  });

  it("restores a pending interrupt across a restart and keeps it answerable", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({
        "01": { status: "checkpoint", brief: "pick a name" },
      }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    expect(first.final.tickets["03"]).toBe("done");
    first.close();

    const rig = stubHarness({ "01": { status: "done" } });
    const second = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(second.phase).toBe("quiescent");
    expect(second.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    expect(rig.spawnOrder).toEqual([]);

    const resumed = await second.resume("01", "the name is Foo");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
  });

  it("resumes a killed engine mid-super-step without re-running done tickets", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=none status=ready -->",
        },
      ],
      config: stubConfig,
    });
    writeFileSync(
      join(poolDir, "agent.sh"),
      [
        "#!/usr/bin/env bash",
        'issue="$1"; id="$2"; outcome_path="$3"',
        'if [ "$id" = "01" ]; then',
        '  printf \'%s\' \'{"status":"done","summary":"recovered-01","commitSha":"sha-01"}\' > "$outcome_path"',
        "  exit 0",
        "fi",
        "sleep 60",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(poolDir, "fixture.ts"),
      [
        "const [enginePath, poolDir] = process.argv.slice(2);",
        "const { runPool } = await import(enginePath);",
        "const harnesses = {",
        "  stub: (ctx: { issuePath: string; id: string; outcomePath: string }) => [",
        '    "bash",',
        "    `${poolDir}/agent.sh`,",
        "    ctx.issuePath,",
        "    ctx.id,",
        "    ctx.outcomePath,",
        "  ],",
        "};",
        "await runPool({ poolDir, harnesses });",
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      ["bun", join(poolDir, "fixture.ts"), join(import.meta.dir, "engine.ts"), poolDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitFor(
        () =>
          markerLine(poolDir, "01-a.md").includes("status=done") &&
          markerLine(poolDir, "02-b.md").includes("status=in-progress"),
      );
    } finally {
      proc.kill();
      await proc.exited;
    }

    const rig = stubHarness({});
    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02"]);
    expect(
      run.final.log.some(
        (line) => line.includes("02") && line.includes("back to ready"),
      ),
    ).toBe(true);
    // 01 finished before the kill but no checkpoint landed; its outcome
    // file on disk still wins over the (absent) checkpoint.
    expect(run.final.outcomes["01"]).toEqual({
      status: "done",
      summary: "recovered-01",
      commitSha: "sha-01",
    });
  });

  it("picks up a pool run.sh halted: a checkpoint marker becomes an answerable interrupt", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=done -->",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=checkpoint -->",
          body: "# 02\n\n## Brief\n\nrun.sh stopped here",
        },
        {
          file: "03-c.md",
          marker: "<!-- state: id=03 blocked-by=02 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const first = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(first.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual([]);
    expect(first.interrupts).toEqual([
      { ticketId: "02", kind: "checkpoint", body: "run.sh stopped here" },
    ]);

    const resumed = await first.resume("02");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["02", "03"]);
  });

});

// Worktree tests run the same public seam against pools that are real git
// repos (the pool dir is the repo root). The git stub harness is a bash
// script driven by a per-spawn plan file, so each ticket can do real work in
// its checkout: write and commit files, wait on siblings, and record what it
// observed (HEAD, branch, cwd) for the assertions.
describe("worktrees", () => {
  it("runs a multi-ticket super-step concurrently, each in its own worktree branched from the same HEAD", async () => {
    const { poolDir, head, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "one.txt",
        commitMsg: "work-01",
        touch: join(poolDir, "started-01"),
        waitFor: join(poolDir, "started-02"),
        recordDir: join(poolDir, "rec-01"),
      },
      "02": {
        workFile: "two.txt",
        commitMsg: "work-02",
        touch: join(poolDir, "started-02"),
        waitFor: join(poolDir, "started-01"),
        recordDir: join(poolDir, "rec-02"),
      },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    // The rendezvous only passes if both tickets are alive at once; a serial
    // engine would time the wait out and crash both tickets.
    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    for (const id of ["01", "02"]) {
      const rec = join(poolDir, `rec-${id}`);
      expect(readFileSync(join(rec, "head"), "utf8").trim()).toBe(head);
      expect(readFileSync(join(rec, "branch"), "utf8").trim()).toBe(
        branchFor(poolDir, id),
      );
      expect(readFileSync(join(rec, "cwd"), "utf8").trim()).toBe(
        worktreePathFor(poolDir, id),
      );
    }
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "two.txt"))).toBe(true);
    const subjects = git(["log", "--format=%s"]).stdout.toString();
    expect(subjects).toContain("work-01");
    expect(subjects).toContain("work-02");
    // Clean merges clean up after themselves: one worktree (the main
    // checkout), no pool branches left.
    const worktrees = git(["worktree", "list", "--porcelain"])
      .stdout.toString()
      .match(/^worktree /gm);
    expect(worktrees).toHaveLength(1);
    expect(
      git(["branch", "--list", "pool/*"]).stdout.toString().trim(),
    ).toBe("");
  }, 15000);

  it("keeps two pools sharing one repo out of each other's worktrees and branches", async () => {
    // The live collision (2026-09-05): two pools on one repo share the
    // common git dir and the ref namespace, so bare ticket ids collided on
    // pool-worktrees/<id> and pool/<id>, and one engine adopted the other's
    // worktree. A linked worktree as the second pool is exactly that shape.
    const { poolDir: rootA, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const base = mkdtempSync(join(tmpdir(), "pool-b-"));
    tempDirs.push(base);
    const poolB = join(base, "checkout");
    expect(
      git(["worktree", "add", poolB, "-b", "pool-b-main", "HEAD"]).exitCode,
    ).toBe(0);
    mkdirSync(join(poolB, "issues"), { recursive: true });
    // The checkout inherited pool A's committed ticket files, so pool B's
    // markers overwrite them in place rather than sitting beside them as
    // duplicate ids.
    for (const id of ["01", "02"]) {
      writeFileSync(
        join(poolB, "issues", readyTicket(id).file),
        `${readyTicket(id).marker}\n\n# body\n`,
      );
    }
    writeFileSync(
      join(poolB, "console.json"),
      JSON.stringify(stubConfig, null, 2),
    );

    const rigA = gitStubHarness(rootA, {
      "01": {
        workFile: "one.txt",
        commitMsg: "work-01",
        recordDir: join(rootA, "rec-01"),
      },
      "02": {
        workFile: "two.txt",
        commitMsg: "work-02",
        recordDir: join(rootA, "rec-02"),
      },
    });
    const rigB = gitStubHarness(poolB, {
      "01": {
        workFile: "b-one.txt",
        commitMsg: "work-b-01",
        recordDir: join(poolB, "rec-01"),
      },
      "02": {
        workFile: "b-two.txt",
        commitMsg: "work-b-02",
        recordDir: join(poolB, "rec-02"),
      },
    });

    const doneA = await approveReview(
      await runPool({ poolDir: rootA, harnesses: rigA.harnesses }),
    );
    expect(doneA.phase).toBe("done");
    const doneB = await approveReview(
      await runPool({ poolDir: poolB, harnesses: rigB.harnesses }),
    );
    expect(doneB.phase).toBe("done");

    // Each pool ran in its own namespaced worktrees on its own branches.
    for (const id of ["01", "02"]) {
      expect(branchFor(rootA, id)).not.toBe(branchFor(poolB, id));
      expect(
        readFileSync(join(rootA, `rec-${id}`, "cwd"), "utf8").trim(),
      ).toBe(worktreePathFor(rootA, id));
      expect(
        readFileSync(join(poolB, `rec-${id}`, "cwd"), "utf8").trim(),
      ).toBe(worktreePathFor(poolB, id));
      expect(
        readFileSync(join(rootA, `rec-${id}`, "branch"), "utf8").trim(),
      ).toBe(branchFor(rootA, id));
      expect(
        readFileSync(join(poolB, `rec-${id}`, "branch"), "utf8").trim(),
      ).toBe(branchFor(poolB, id));
    }

    // And each merge landed only in its own pool's working branch: no
    // engine ever touched the other's checkout.
    const subjectsA = git(["log", "--format=%s", "main"]).stdout.toString();
    expect(subjectsA).toContain("work-01");
    expect(subjectsA).toContain("work-02");
    expect(subjectsA).not.toContain("work-b-01");
    const subjectsB = git([
      "log",
      "--format=%s",
      "pool-b-main",
    ]).stdout.toString();
    expect(subjectsB).toContain("work-b-01");
    expect(subjectsB).toContain("work-b-02");
    expect(subjectsB).not.toContain("work-01");
  }, 20000);

  // A fake opencode binary on PATH records the PWD the engine passed it.
  // The real opencode CLI is a Bun binary and bun hands the inherited
  // environment through verbatim; a shell fake would sanitize $PWD back to
  // the true cwd and hide the bug this guards against.
  function opencodePwdFake(poolDir: string): { binDir: string; recordDir: string } {
    const binDir = join(poolDir, "bin");
    const recordDir = join(poolDir, "rec");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "opencode"),
      [
        "#!/usr/bin/env bun",
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import { dirname, join, resolve } from "node:path";',
        'const commandArgs = process.argv[process.argv.indexOf("--command") + 2];',
        'const issueRef = commandArgs.split("\\n")[0];',
        'const id = issueRef.split("/").at(-1)!.split("-")[0];',
        // The prompt names the canonical Issue file by its absolute
        // main-checkout path; the outcome file sits beside it under runs/.
        'const issue = resolve(process.cwd(), issueRef);',
        'const outcome = join(dirname(dirname(issue)), "runs", `${id}.outcome.json`);',
        'const recordDir = process.env.PWD_RECORD_DIR;',
        'mkdirSync(recordDir, { recursive: true });',
        'writeFileSync(join(recordDir, `pwd.${id}`), process.env.PWD ?? "");',
        'writeFileSync(outcome, JSON.stringify({ status: "done", summary: "fake", commitSha: null }));',
        "console.log(`fake opencode ran in ${process.env.PWD}`);",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "opencode"), 0o755);
    return { binDir, recordDir };
  }

  it("spawns with PWD set to the worktree cwd so opencode roots in the worktree, not the server's checkout", async () => {
    const { poolDir } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: { defaults: { harness: "opencode", model: "opencode-test" } },
    });
    const fake = opencodePwdFake(poolDir);
    const originalPath = process.env.PATH;
    const originalRecord = process.env.PWD_RECORD_DIR;
    process.env.PATH = `${fake.binDir}:${originalPath}`;
    process.env.PWD_RECORD_DIR = fake.recordDir;

    let run: Awaited<ReturnType<typeof runPool>>;
    try {
      run = await approveReview(await runPool({ poolDir }));
    } finally {
      process.env.PATH = originalPath;
      if (originalRecord === undefined) delete process.env.PWD_RECORD_DIR;
      else process.env.PWD_RECORD_DIR = originalRecord;
    }

    expect(run!.phase).toBe("done");
    for (const id of ["01", "02"]) {
      // The tickets ran in worktrees; the child must see the worktree as
      // PWD, not the server's checkout (where the test process lives).
      expect(readFileSync(join(fake.recordDir, `pwd.${id}`), "utf8")).toBe(
        worktreePathFor(poolDir, id),
      );
      expect(readFileSync(join(fake.recordDir, `pwd.${id}`), "utf8")).not.toBe(
        process.env.PWD,
      );
    }
  }, 15000);

  it("hands the agent the canonical main-checkout Issue path and recognises its done, merging the attempt", async () => {
    // The old contract's false crash is deleted: the attempt signals done
    // through its outcome JSON and the engine writes the canonical Issue's
    // marker itself, so a worktree-relative slip by the agent can no longer
    // strand the status and skip the merge.
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "one.txt", commitMsg: "work-01" },
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts).toEqual([]);
    for (const id of ["01", "02"]) {
      // The spawn context names the canonical Issue file: the absolute
      // main-checkout path, not the worktree's context-only seed copy.
      expect(rig.spawned[id].issuePath).toBe(
        join(poolDir, "issues", `${id}-t.md`),
      );
      expect(rig.spawned[id].cwd).toBe(
        worktreePathFor(poolDir, id),
      );
      // The engine wrote the marker on exactly that file: done on disk.
      expect(markerLine(poolDir, `${id}-t.md`)).toContain("status=done");
      // And the merge was not skipped: the branch landed on the working
      // branch and the ticket log records it.
      const events = readFileSync(
        join(poolDir, "runs", `${id}.events.jsonl`),
        "utf8",
      );
      expect(events).toContain('"kind":"merged"');
    }
    const subjects = git(["log", "--format=%s"]).stdout.toString();
    expect(subjects).toContain("work-01");
    expect(subjects).toContain("work-02");
  }, 15000);

  it("merges finished branches in completion order and never rebases a running ticket", async () => {
    const { poolDir, head, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      // 01 stays alive until 02's merge has landed on the working branch.
      "01": {
        workFile: "one.txt",
        commitMsg: "work-01",
        waitMerged: "work-02",
        recordDir: join(poolDir, "rec-01"),
      },
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    // 01's branch was never rebased: it still sits on the super-step's
    // starting HEAD, observed after 02's merge had already landed.
    expect(readFileSync(join(poolDir, "rec-01", "head"), "utf8").trim()).toBe(
      head,
    );
    const commits = git(["log", "--format=%H %s"])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) }));
    const bySubject = (subject: string) =>
      commits.find((c) => c.subject === subject)!.sha;
    // Completion order: 02 finished first and fast-forwarded; 01's merge
    // commit has 02's commit as its first parent and 01's as its second.
    const merge = commits.find((c) => c.subject.startsWith("Merge branch"))!;
    const parents = git(["rev-list", "--parents", "-n", "1", merge.sha])
      .stdout.toString()
      .trim()
      .split(" ")
      .slice(1);
    expect(parents).toEqual([bySubject("work-02"), bySubject("work-01")]);
    // And 01's own commit still hangs off the shared starting snapshot.
    const baseOf01 = git(["rev-list", "--parents", "-n", "1", bySubject("work-01")])
      .stdout.toString()
      .trim()
      .split(" ")[1];
    expect(baseOf01).toBe(head);
  }, 15000);

  it("holds the pool on a clashing merge and finishes the unrelated tickets it already ran", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03")],
        config: noResolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });

    // 01, 02 and 03 all run in the same super-step; 02's merge conflicts at
    // the boundary and the hold pauses the pool there, with 01 and 03
    // already finished and merged.
    const run = await heldRun({ poolDir, harnesses: rig.harnesses });

    expect(rig.spawnOrder).toEqual(["01", "02", "03"]);
    expect(run.final.tickets).toEqual({
      "01": "done",
      "02": "done",
      "03": "done",
    });
    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.ticketId).toBe("02");
    expect(interrupt.kind).toBe("merge-conflict");
    expect(interrupt.body).toContain("shared.txt");
    expect(interrupt.body).toContain(branchFor(poolDir, "02"));
    // The working branch was left clean: no half-merged state, 01's content
    // in place, 03 merged past the conflict, 02's branch parked for a human.
    expect(
      git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).exitCode,
    ).not.toBe(0);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("from-01\n");
    expect(existsSync(join(poolDir, "three.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "02")]).exitCode).toBe(0);
    expect(
      existsSync(worktreePathFor(poolDir, "02")),
    ).toBe(true);

    // The human resolves by hand in the main checkout, then resumes; the
    // merge lands and the hold lifts.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "resolved\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02"]);

    const resumed = await run.resume("02");
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    expect(
      existsSync(worktreePathFor(poolDir, "02")),
    ).toBe(false);
  }, 15000);

  it("holds a downstream ticket until its blocker's conflicted merge lands, then passes the outcome through", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [
          readyTicket("01"),
          readyTicket("02"),
          readyTicket("03", "02"),
        ],
        config: noResolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
        outcome: { summary: "schema v2", commitSha: "sha-02" },
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });

    // 01 and 02 run in the same super-step; 02 is done but its merge
    // conflicts, so the hold pauses the pool and 03 never spawns against a
    // HEAD the merge never reached.
    const run = await heldRun({ poolDir, harnesses: rig.harnesses });

    expect(run.interrupts[0]?.kind).toBe("merge-conflict");
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done", "03": "ready" });

    // The human resolves by hand; the merge lands, the hold lifts, and 03
    // spawns in the next super-step with 02's outcome in its prompt. The
    // outcomes channel, not the merge, carries state downstream; the merge
    // decides when the downstream ticket may start.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "resolved\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02"]);

    const resumed = await run.resume("02");
    expect(rig.spawnOrder).toContain("03");
    expect(rig.spawned["03"].body).toContain("02: schema v2");
    expect(rig.spawned["03"].cwd).toBe(poolDir);
    const done = await approveReview(resumed);

    expect(done.phase).toBe("done");
    expect(done.final.tickets["03"]).toBe("done");
  }, 15000);

  it("keeps a checkpointed ticket's worktree parked and reuses it on resume", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01"), readyTicket("02")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": [
        { status: "checkpoint", workFile: "one.txt", commitMsg: "work-01", leaveFile: "partial.txt" },
        { status: "done", workFile: "one-more.txt", commitMsg: "work-01b", expectFile: "partial.txt" },
      ],
      "02": { workFile: "two.txt", commitMsg: "work-02" },
    });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts).toEqual([
      {
        ticketId: "01",
        kind: "checkpoint",
        body:
          "The agent signalled a checkpoint but wrote no brief, so what " +
          "the attempt completed is only in the ticket log. Answer the " +
          "interrupt to point the next attempt.",
      },
    ]);
    // The checkpoint parked 01's worktree with its partial work; 02 merged
    // and cleaned up.
    expect(existsSync(worktreePathFor(poolDir, "01"))).toBe(
      true,
    );
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01")]).exitCode).toBe(0);
    expect(existsSync(worktreePathFor(poolDir, "02"))).toBe(
      false,
    );

    const resumed = await run.resume("01", "carry on");
    const done = await approveReview(resumed);

    // The second spawn asserts partial.txt is present (exit 43 otherwise),
    // which only holds in the parked worktree.
    expect(done.phase).toBe("done");
    expect(rig.spawnOrder).toEqual(["01", "02", "01"]);
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(existsSync(join(poolDir, "one-more.txt"))).toBe(true);
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "01")]).exitCode).not.toBe(0);
    const issueText = readFileSync(join(poolDir, "issues", "01-t.md"), "utf8");
    expect(issueText).toContain("status=done");
    expect(issueText).toContain("carry on");
  }, 15000);

  it("runs a single-ticket super-step in the main checkout without a worktree", async () => {
    const { poolDir, git } = makeGitPool({
      tickets: [readyTicket("01")],
      config: stubConfig,
    });
    const rig = gitStubHarness(poolDir, {
      "01": { workFile: "one.txt", commitMsg: "work-01", recordDir: join(poolDir, "rec-01") },
    });

    const run = await approveReview(
      await runPool({ poolDir, harnesses: rig.harnesses }),
    );

    expect(run.phase).toBe("done");
    expect(readFileSync(join(poolDir, "rec-01", "cwd"), "utf8").trim()).toBe(
      poolDir,
    );
    expect(existsSync(join(poolDir, "one.txt"))).toBe(true);
    expect(
      git(["branch", "--list", "pool/*"]).stdout.toString().trim(),
    ).toBe("");
  }, 15000);

  describe("merge hold (ADR-0014)", () => {
    const DONE_01 = "<!-- state: id=01 blocked-by=none status=done -->";

    // Park pool/<id> with one commit the working branch does not have.
    function parkBranch(
      poolDir: string,
      git: (args: string[]) => { exitCode: number },
      id: string,
    ): void {
      git(["checkout", "-q", "-b", branchFor(poolDir, id)]);
      writeFileSync(join(poolDir, `w-${id}.txt`), `work for ${id}\n`);
      git(["add", `w-${id}.txt`]);
      git(["commit", "-qm", `work ${id}`]);
      git(["checkout", "-q", "main"]);
    }

    it("holds a pool booted with a done ticket unmerged, and a manual CLI merge lifts it with no Console action", async () => {
      // The disk state is what a killed engine leaves behind: a done marker,
      // a parked branch, a ready downstream, and no hold anywhere in the
      // checkpoint store, because there is no such field. The boot derives
      // the hold from markers and branch state alone.
      const { poolDir, git } = makeGitPool(
        {
          tickets: [
            { file: "01-t.md", marker: DONE_01 },
            readyTicket("02", "01"),
          ],
          config: stubConfig,
        },
        { "shared.txt": "base\n" },
      );
      parkBranch(poolDir, git, "01");
      const rig = gitStubHarness(poolDir, {
        "02": { workFile: "two.txt", commitMsg: "work-02" },
      });

      const run = await heldRun({ poolDir, harnesses: rig.harnesses });

      // The hold pauses the pool: the downstream ticket never spawns.
      expect(rig.spawnOrder).toEqual([]);

      // A manual CLI merge lifts the hold on the next ready-set computation,
      // with no operator action in the Console: the drive's derivation
      // simply observes the branch landed.
      git(["merge", "--no-edit", branchFor(poolDir, "01")]);
      await waitFor(() => rig.spawnOrder.includes("02"));
      const done = await approveReview(await run.settled);

      expect(done.phase).toBe("done");
      expect(done.final.tickets).toEqual({ "01": "done", "02": "done" });
    }, 15000);

    it("re-derives the hold on a restart from markers and branch state alone", async () => {
      const { poolDir } = makeGitPool(
        {
          tickets: [
            readyTicket("01"),
            readyTicket("02"),
            readyTicket("03"),
          ],
          config: resolverConfig,
        },
        { "shared.txt": "base\n" },
      );
      const rig = gitStubHarness(poolDir, {
        "01": {
          workFile: "shared.txt",
          workLine: "from-01",
          overwrite: true,
          commitMsg: "work-01",
        },
        "02": {
          waitMerged: "work-01",
          workFile: "shared.txt",
          workLine: "from-02",
          overwrite: true,
          commitMsg: "work-02",
        },
        // 03 checkpoints on its first run, so the first engine can be ended
        // by a drained answer whose persist fails on the closed store,
        // without touching the hold's facts on disk; its re-run finishes.
        "03": [{ status: "checkpoint" }, { status: "done" }],
      });
      const resolver = resolverStub(poolDir, {
        "02": {
          resolved: true,
          conflictFile: "shared.txt",
          resolution: "resolved-by-agent",
          note: "kept both lines",
        },
      });

      // Engine one: the conflict raises the approval and the hold pauses the
      // pool with 03's checkpoint interrupt up beside it.
      const first = await heldRun({
        poolDir,
        harnesses: { ...rig.harnesses, ...resolver.harnesses },
      });
      expect(
        new Set(first.interrupts.map((i) => `${i.ticketId}:${i.kind}`)),
      ).toEqual(
        new Set(["02:merge-approval", "03:checkpoint"]),
      );

      // Kill engine one: closing the store makes the next drained answer's
      // persist fail, which reports the drive dead and ends it. The answer
      // (resuming 03) still wrote its marker first, so the disk carries 03
      // ready and the hold's facts untouched: 01 and 02 done, 02's branch
      // parked and unmerged.
      first.close();
      await expect(first.resume("03")).rejects.toThrow();

      // Engine two boots into the same pool. The hold is re-derived from
      // markers and branch state alone, no persisted flag anywhere, and the
      // merge-approval interrupt comes back with it; the ready set returns
      // empty under the hold, so nothing new spawns.
      const second = await heldRun({
        poolDir,
        harnesses: { ...rig.harnesses, ...resolver.harnesses },
      });
      expect(rig.spawnOrder).toEqual(["01", "02", "03"]);
      expect(second.interrupts.map((i) => [i.ticketId, i.kind])).toEqual([
        ["02", "merge-approval"],
      ]);

      // The merge approval lifts the hold the same way it would have for
      // engine one, and the pool finishes through the ordinary path. 03
      // re-runs from the ready marker engine one's answer left.
      const done = await approveReview(await second.approve("02"));
      expect(done.phase).toBe("done");
      expect(done.final.tickets).toEqual({
        "01": "done",
        "02": "done",
        "03": "done",
      });
      expect(rig.spawnOrder).toEqual(["01", "02", "03", "03"]);
    }, 20000);

    it("withholds a verify round's graders while the hold stands, then grades and selects once it lifts", async () => {
      const { poolDir, git } = makeGitPool(
        {
          tickets: [
            { ...readyTicket("01"), body: "verify fan-out\n" },
            readyTicket("02"),
            readyTicket("03"),
          ],
          config: {
            ...noResolverConfig,
            assign: { "01": { verify: 2 } },
          },
        },
        { "shared.txt": "base\n" },
      );
      const rig = gitStubHarness(poolDir, {
        "01": { workFile: "one.txt", commitMsg: "work-01" },
        "02": {
          waitMerged: "work-03",
          workFile: "shared.txt",
          workLine: "from-02",
          overwrite: true,
          commitMsg: "work-02",
        },
        "03": {
          workFile: "shared.txt",
          workLine: "from-03",
          overwrite: true,
          commitMsg: "work-03",
        },
      });

      // Super-step one runs 01's fan-out beside 02 and 03. 02's merge
      // conflicts with 03's landed change, so the hold pauses the pool right
      // where grading would begin: the grader tickets are written but not
      // scheduled, and nothing engine-run spawns.
      const run = await heldRun({ poolDir, harnesses: rig.harnesses });
      expect(existsSync(join(poolDir, "issues", "01-grader-1.md"))).toBe(true);
      expect(existsSync(join(poolDir, "issues", "01-grader-2.md"))).toBe(true);
      expect(
        existsSync(join(poolDir, "runs", "01-grader-1.events.jsonl")),
      ).toBe(false);
      expect(rig.spawnOrder).toEqual(["01", "01", "02", "03"]);

      // The human resolves the conflicted merge; the hold lifts and the
      // grading round runs. The default grades tie at 8, below the outright
      // margin, so the selection run's judge routes through the same entry
      // point and the head-to-head spawns only now.
      git(["checkout", "--", "issues/02-t.md"]);
      expect(git(["merge", "--no-edit", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
      writeFileSync(join(poolDir, "shared.txt"), "resolved\n");
      git(["add", "shared.txt"]);
      git(["commit", "-qm", "resolve pool/02"]);

      const resumed = await run.resume("02");
      expect(rig.spawnOrder).toEqual([
        "01",
        "01",
        "02",
        "03",
        "01-grader-1",
        "01-grader-2",
        "01-head-to-head",
      ]);
      const done = await approveReview(resumed);

      expect(done.phase).toBe("done");
      expect(done.final.tickets["01"]).toBe("done");
      expect(done.final.tickets["01-head-to-head"]).toBe("done");
    }, 20000);

    it("holds on a feature-branch merge target the same as main, and lifts when the branch lands there", async () => {
      const { poolDir, git } = makeGitPool(
        {
          tickets: [
            readyTicket("01"),
            readyTicket("02"),
            readyTicket("03", "02"),
          ],
          config: noResolverConfig,
        },
        { "shared.txt": "base\n" },
      );
      const rig = gitStubHarness(poolDir, {
        "01": {
          workFile: "shared.txt",
          workLine: "from-01",
          overwrite: true,
          commitMsg: "work-01",
        },
        "02": {
          waitMerged: "work-01",
          workFile: "shared.txt",
          workLine: "from-02",
          overwrite: true,
          commitMsg: "work-02",
        },
        "03": { workFile: "three.txt", commitMsg: "work-03" },
      });

      const run = await heldRun({ poolDir, harnesses: rig.harnesses });
      expect(rig.spawnOrder).toEqual(["01", "02"]);

      // The merge target is the pool checkout's working branch. Cutting a
      // feature branch moves the target: 02's work is in neither branch, the
      // hold stands, and only landing 02 in the feature branch lifts it. If
      // the engine read main as the target instead, nothing here would ever
      // lift the hold and the test would time out waiting for 03.
      git(["checkout", "-q", "-b", "feature/x"]);
      expect(git(["merge", "--no-edit", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
      writeFileSync(join(poolDir, "shared.txt"), "resolved\n");
      git(["add", "shared.txt"]);
      git(["commit", "-qm", "resolve pool/02 onto feature/x"]);

      await waitFor(() => rig.spawnOrder.includes("03"));
      // The lift needed no Console action: 03 spawned before any answer. The
      // resume here only clears the stale manual interrupt the CLI merge
      // made moot; its re-attempt finds the merge already up to date.
      const done = await approveReview(await run.resume("02"));

      expect(done.phase).toBe("done");
      expect(done.final.tickets["03"]).toBe("done");
      expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
        "resolved\n",
      );
    }, 15000);

    // The engine-run helper's contract, pinned directly: an empty recompute
    // is the hold re-engaged, so the helper waits again and hands back the
    // set, never an empty one. The scenario this guards is a done-but-
    // unmerged marker landing between the wait's exit and the recompute;
    // nothing schedulable runs in that microtask-scale gap today, so no
    // pool-driven test can stage it. The scripted session is the only way
    // to land a hold in exactly that gap: each read of the session's state
    // hands back the next script entry, and the proxy absorbs the engine's
    // state reassignments so every read hits the script. Reads one to six
    // are: the first wait's check (hold), its log write (hold), the wait's
    // loop check (clear, so the wait exits), the recompute (hold, the
    // re-engagement), the re-wait's check (clear, early exit), and the
    // second recompute (clear, the set hands back).
    it("re-waits a hold that re-engages between the wait and the recompute, never handing back an empty set", async () => {
      const { poolDir, git } = makeGitPool(
        { tickets: [{ file: "01-t.md", marker: DONE_01 }], config: stubConfig },
        { "shared.txt": "base\n" },
      );
      parkBranch(poolDir, git, "01");
      const script = ["hold", "hold", "clear", "hold", "clear", "clear"];
      const held: Record<string, TicketStatus> = { "01": "done" };
      const spawnSession = new Proxy(
        {
          git: true,
          cwd: poolDir,
          answers: new QueuedAnswerStore(join(poolDir, "runs")),
        },
        {
          get(target, prop) {
            if (prop === "state") {
              return script.shift() === "hold"
                ? {
                    tickets: held,
                    log: [],
                    outcomes: {},
                    config: stubConfig,
                    interrupts: [],
                    reviewApproved: false,
                  }
                : {
                    tickets: {},
                    log: [],
                    outcomes: {},
                    config: stubConfig,
                    interrupts: [],
                    reviewApproved: false,
                  };
            }
            return Reflect.get(target, prop, target);
          },
          set() {
            return true;
          },
        },
      ) as unknown as Parameters<typeof engineSpawnSet>[0];
      const judge: TicketMarker = {
        id: "01-head-to-head",
        file: join(poolDir, "issues", "01-head-to-head.md"),
        blockedBy: ["01"],
        status: "ready",
        title: "head-to-head for 01",
        spec: "",
      };

      const spawnable = await engineSpawnSet(spawnSession, () => {}, [judge]);

      // The recompute at read four saw the hold standing, so a shape that
      // handed the recompute straight back would return [] here; the loop is
      // what turns the re-engagement into a re-wait and a second recompute.
      expect(spawnable).toEqual([judge]);
    });
  });

  describe("resolver agent", () => {
  it("shares attempt numbers between implement and resolver runs", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    interface EventLine {
      at: string;
      attempt: number;
      kind: string;
      payload: Record<string, unknown>;
    }
    const readEventsFile = (id: string): EventLine[] =>
      readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventLine);

    // The implement attempt conflicted, then the resolver took the next
    // attempt number for the same ticket. The hold has paused the pool here,
    // so nothing further has spawned. The resolver's spawn carries the
    // same spawned event every other site does (ADR-0012).
    const before = readEventsFile("02");
    expect(before.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "merge-conflict",
      "resolver",
      "spawned",
    ]);
    expect(before[0].attempt).toBe(1);
    expect(before.find((e) => e.kind === "resolver")?.attempt).toBe(2);

    // Both run kinds record the worktree they ran in, so a ticket maps
    // durably to its attempt's cwd/branch.
    const spawnedEvent = before.find((e) => e.kind === "spawned")!;
    expect(spawnedEvent.payload.cwd).toContain(worktreePathFor(poolDir, "02"));
    expect(spawnedEvent.payload.branch).toBe(branchFor(poolDir, "02"));
    const resolverEvent = before.find((e) => e.kind === "resolver")!;
    expect(resolverEvent.payload.cwd).toBe(spawnedEvent.payload.cwd);
    expect(resolverEvent.payload.branch).toBe(branchFor(poolDir, "02"));

    // The resolver's spawned event carries the uniform spawn facts (its own
    // attempt number, the worktree it ran in, and the commit the parked
    // worktree was at). This fake's argv takes structured fields and embeds
    // no prompt, so the elision shows as an argv that carries no prompt
    // text; the dedicated elision test below drives the placeholder itself.
    const resolverSpawn = before.at(-1)!;
    expect(resolverSpawn.kind).toBe("spawned");
    expect(resolverSpawn.attempt).toBe(2);
    expect(resolverSpawn.payload.cwd).toBe(resolverEvent.payload.cwd);
    expect(resolverSpawn.payload.branch).toBe(branchFor(poolDir, "02"));
    expect(Array.isArray(resolverSpawn.payload.argv)).toBe(true);
    expect((resolverSpawn.payload.argv as string[]).join(" ")).not.toContain(
      "Resolve the git merge conflict",
    );
    expect(resolverSpawn.payload.env).toEqual({ PWD: resolverEvent.payload.cwd });
    expect(typeof resolverSpawn.payload.commitSha).toBe("string");

    const approved = await run.approve("02");
    const done = await approveReview(approved);
    expect(done.phase).toBe("done");

    // The approval answered the interrupt and the merge landed on the
    // resolver's attempt.
    const after = readEventsFile("02");
    expect(after.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "merge-conflict",
      "resolver",
      "spawned",
      "answered",
      "merged",
    ]);
    expect(after.at(-1)?.attempt).toBe(2);
    expect(after.at(-1)?.kind).toBe("merged");
  }, 15000);

  it("tears down a resolver spawn whose grandchild holds its pipe, still capturing late output", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    // The resolver reproduces the conflict, stages a resolution, and holds
    // its stdout pipe open with a grandchild that outlives it: one line
    // lands inside the grace window, then the grandchild exits by itself.
    const holderPath = join(poolDir, "pipe-holder-resolver.sh");
    writeFileSync(
      holderPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome="$1"; worktree="$2"',
        "bash -c 'sleep 0.3; echo resolver-late-output-from-grandchild; sleep 30' &",
        'git -C "$worktree" merge main >/dev/null 2>&1 || true',
        'printf \'%s\\n\' "resolved-by-resolver" > "$worktree/shared.txt"',
        'git -C "$worktree" add shared.txt',
        'printf \'%s\' \'{"resolved": true, "note": "staged by the pipe holder"}\' > "$outcome"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const harnesses: Record<string, HarnessCommand> = {
      ...rig.harnesses,
      "resolver-stub": (ctx) => ["bash", holderPath, ctx.outcomePath, ctx.cwd],
    };

    // The comment above the ticket-spawn test's grandchild applies here too:
    // the grandchild outlives the run, so only the bounded grace gets the
    // resolver spawn back.
    const started = Date.now();
    const first = await heldRun({ poolDir, harnesses });
    expect(Date.now() - started).toBeLessThan(10_000);
    const approval = first.interrupts.find((i) => i.kind === "merge-approval");
    expect(approval).toBeTruthy();
    expect(approval!.body).toContain("staged by the pipe holder");

    const done = await approveReview(await first.approve("02"));
    expect(done.phase).toBe("done");

    // The resolver's log captured the grandchild's line that landed inside
    // the grace window, and the drive did not park on the open pipe.
    expect(
      readFileSync(join(poolDir, "runs", "02.resolver.log"), "utf8"),
    ).toContain("resolver-late-output-from-grandchild");
  }, 15000);

  it("spawns the resolver on a conflict, raises an approval interrupt, and approve commits the merge and continues", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
        recordDir: join(poolDir, "res-rec"),
      },
    });

    // The conflict pauses the pool on the merge hold: 03 is ready (its
    // blocker 02 is done) but the hold withholds it until the merge lands.
    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });

    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.ticketId).toBe("02");
    expect(interrupt.kind).toBe("merge-approval");
    expect(interrupt.body).toContain("resolver agent resolved");
    expect(interrupt.body).toContain("kept both lines");

    // The resolver ran in 02's parked worktree on branch pool/02 and left the
    // resolution staged: the resolution is not yet committed, MERGE_HEAD set.
    expect(resolver.spawnOrder).toEqual(["02"]);
    expect(resolver.spawned["02"].cwd).toBe(
      worktreePathFor(poolDir, "02"),
    );
    expect(readFileSync(join(poolDir, "res-rec", "branch"), "utf8").trim()).toBe(
      branchFor(poolDir, "02"),
    );
    expect(
      readFileSync(join(poolDir, "res-rec", "mergehead"), "utf8").trim(),
    ).toBeTruthy();

    // Approving the queued merge lifts the hold: the merge lands, the ready
    // set computes fresh, and downstream 03 spawns.
    const approved = await run.approve("02");
    expect(rig.spawnOrder).toContain("03");
    const done = await approveReview(approved);
    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "resolved-by-agent\n",
    );
    expect(done.final.tickets["03"]).toBe("done");
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    expect(
      existsSync(worktreePathFor(poolDir, "02")),
    ).toBe(false);
  }, 15000);

  it("reject reopens the ticket, lifts the hold, and the re-run's merge completes the pool", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02"), readyTicket("03", "02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
      "03": { workFile: "three.txt", commitMsg: "work-03" },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    // Rejecting reopens the ticket instead of leaving it done with a manual
    // interrupt: the marker is back to ready and the hold lifts because the
    // ticket no longer counts as done. The rejection note rides along as a
    // durable resume note. The staged resolution was discarded: the branch
    // is back to its own commits and the working branch still holds 01's
    // content. The re-run starts inside the same drive, so the reopen is
    // read from the snapshot stream (the settle waits for the whole re-run).
    run.accept("02", "the resolver dropped a field", false);
    await waitFor(() =>
      run.snapshots.some((s) =>
        s.state.log.some((l) => l.includes("ticket reopened")),
      ),
    );
    const reopened = run.snapshots.find((s) =>
      s.state.log.some((l) => l.includes("ticket reopened")),
    )!;
    expect(reopened.state.tickets["02"]).toBe("ready");
    expect(
      readFileSync(join(poolDir, "issues", "02-t.md"), "utf8"),
    ).toContain("the resolver dropped a field");
    expect(
      run.snapshots.every(
        (s) => !s.state.interrupts.some((i) => i.kind === "merge-conflict"),
      ),
    ).toBe(true);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("from-01\n");

    // The re-run reuses the parked branch, conflicts again, and the resolver
    // takes a second run; approving the second resolution finishes the pool,
    // with 03 spawned only after 02's merge landed.
    await waitFor(
      () =>
        run.interrupts.some(
          (i) => i.kind === "merge-approval" && i.ticketId === "02",
        ),
    );
    const done = await approveReview(await run.approve("02"));
    expect(done.phase).toBe("done");
    expect(done.interrupts).toEqual([]);
    expect(rig.spawnOrder).toEqual(["01", "02", "02", "03"]);
    expect(resolver.spawnOrder).toEqual(["02", "02"]);
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
      "resolved-by-agent\n",
    );
    expect(git(["rev-parse", "--verify", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    expect(
      existsSync(worktreePathFor(poolDir, "02")),
    ).toBe(false);
  }, 15000);

  it("a resolver that fails takes the manual path with the failure noted", async () => {
    const { poolDir, git } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    const resolver = resolverStub(poolDir, {
      "02": { resolved: false, note: "could not reconcile the schema" },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });

    expect(run.interrupts).toHaveLength(1);
    const interrupt = run.interrupts[0];
    expect(interrupt.kind).toBe("merge-conflict");
    expect(interrupt.body).toContain("resolver agent attempted");
    expect(interrupt.body).toContain("could not reconcile the schema");

    // Manual resolution then resume completes the merge; the merge landing
    // lifts the hold.
    git(["checkout", "--", "issues/02-t.md"]);
    expect(git(["merge", "--no-edit", branchFor(poolDir, "02")]).exitCode).not.toBe(0);
    writeFileSync(join(poolDir, "shared.txt"), "manual\n");
    git(["add", "shared.txt"]);
    git(["commit", "-qm", "resolve pool/02"]);
    const resumed = await run.resume("02");
    expect((await approveReview(resumed)).phase).toBe("done");
    expect(readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe("manual\n");
  }, 15000);

  it("falls back to the ~/.issue-runner default harness when resolver= is unset", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: stubConfig,
      },
      { "shared.txt": "base\n" },
    );
    const runnerFile = join(poolDir, "issue-runner");
    writeFileSync(runnerFile, "harness=resolver-stub\nmodel=resolver-model\n");
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "fallback-resolved",
        note: "via default",
      },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
      issueRunnerPath: runnerFile,
    });

    expect(run.interrupts[0]?.kind).toBe("merge-approval");
    expect(run.interrupts[0].body).toContain("via default");
    expect(resolver.spawnOrder).toEqual(["02"]);
    const finished = await approveReview(await run.approve("02"));
    expect(finished.phase).toBe("done");
  }, 15000);

  it("pins the resolver's own model when resolver= is the { harness, model } form", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: {
          ...stubConfig,
          resolver: { harness: "resolver-stub", model: "resolver-model" },
        },
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "pinned-resolved",
        note: "via pinned model",
      },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });

    expect(run.interrupts[0]?.kind).toBe("merge-approval");
    expect(resolver.spawnOrder).toEqual(["02"]);
    // The defaults' model ("stub-model") belongs to the stub harness; the
    // resolver runs on resolver-stub and must spawn with its own model.
    expect(resolver.spawned["02"].model).toBe("resolver-model");
    const finished = await approveReview(await run.approve("02"));
    expect(finished.phase).toBe("done");
  }, 15000);

  it("fails fast when an explicit resolver names an unknown harness", async () => {
    const { poolDir } = makeGitPool(
      {
        tickets: [readyTicket("01"), readyTicket("02")],
        config: { ...stubConfig, resolver: "does-not-exist" },
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": {
        waitMerged: "work-01",
        workFile: "shared.txt",
        workLine: "from-02",
        overwrite: true,
        commitMsg: "work-02",
      },
    });

    await expect(
      runPool({ poolDir, harnesses: rig.harnesses }),
    ).rejects.toThrow(/resolver names unknown harness 'does-not-exist'/);
  }, 15000);

  it("rotates the resolver log to its attempt-numbered name on a second resolver run", async () => {
    const { poolDir } = makeGitPool(
      {
        // 04 is an independent sibling that also rewrites shared.txt in round
        // 2: rejecting it alongside 02 leaves two tickets ready at once, and
        // 02 waits on 04's merged change before overwriting shared.txt again,
        // so the second merge conflicts and the resolver runs a second time.
        tickets: [
          readyTicket("01"),
          readyTicket("02"),
          readyTicket("03", "02"),
          readyTicket("04"),
        ],
        config: resolverConfig,
      },
      { "shared.txt": "base\n" },
    );
    const rig = gitStubHarness(poolDir, {
      "01": {
        workFile: "shared.txt",
        workLine: "from-01",
        overwrite: true,
        commitMsg: "work-01",
      },
      "02": [
        {
          waitMerged: "work-01",
          workFile: "shared.txt",
          workLine: "from-02",
          overwrite: true,
          commitMsg: "work-02",
        },
        {
          waitMerged: "work-04-again",
          workFile: "shared.txt",
          workLine: "from-02-again",
          overwrite: true,
          commitMsg: "work-02-again",
        },
      ],
      "03": { workFile: "three.txt", commitMsg: "work-03" },
      "04": [
        { workFile: "four.txt", commitMsg: "work-04" },
        {
          workFile: "shared.txt",
          workLine: "from-04-again",
          overwrite: true,
          commitMsg: "work-04-again",
        },
      ],
    });
    const resolver = resolverStub(poolDir, {
      "02": {
        resolved: true,
        conflictFile: "shared.txt",
        resolution: "resolved-by-agent",
        note: "kept both lines",
      },
    });

    const run = await heldRun({
      poolDir,
      harnesses: { ...rig.harnesses, ...resolver.harnesses },
    });
    expect(run.interrupts[0]?.kind).toBe("merge-approval");

    const approved = await run.approve("02");
    expect(approved.phase).toBe("quiescent");

    // Reject 02 and 04 together (03 resets as 02's downstream) so 02 re-runs
    // in a worktree alongside 04 and conflicts again. The re-run's second
    // conflict pauses the pool on the hold again, so the review reject is
    // accepted without awaiting a settle and the second resolver run is
    // waited for on its own event.
    run.accept(REVIEW_TICKET_ID, "redo 02 04", false);
    await waitFor(() => resolver.spawnOrder.length === 2);
    await waitFor(() =>
      run.interrupts.some((i) => i.kind === "merge-approval"),
    );

    // Approving the second resolution finishes the pool.
    const done = await approveReview(await run.approve("02"));
    expect(done.phase).toBe("done");

    // Implement attempt 1 rotated away; attempt 3 sits at the long-standing
    // path. Resolver attempt 2 rotated away; attempt 4 sits at its path.
    expect(existsSync(join(poolDir, "runs", "02.attempt-1.log"))).toBe(true);
    expect(existsSync(join(poolDir, "runs", "02.log"))).toBe(true);
    expect(existsSync(join(poolDir, "runs", "02.attempt-2.resolver.log"))).toBe(
      true,
    );
    expect(existsSync(join(poolDir, "runs", "02.resolver.log"))).toBe(true);

    // Rotated names agree with the attempt numbers in the events file. The
    // implement spawns (1 and 3) record exited events; the resolver runs
    // (2 and 4) record resolver events plus their own spawned ones, so the
    // rotated attempt numbers still interleave on the shared counter.
    const events = readFileSync(
      join(poolDir, "runs", "02.events.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { attempt: number; kind: string });
    expect(
      events.filter((e) => e.kind === "spawned").map((e) => e.attempt),
    ).toEqual([1, 2, 3, 4]);
    expect(
      events.filter((e) => e.kind === "exited").map((e) => e.attempt),
    ).toEqual([1, 3]);
    expect(
      events.filter((e) => e.kind === "resolver").map((e) => e.attempt),
    ).toEqual([2, 4]);
  }, 20000);
  });
});

describe("accept/process split", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const raw = readFileSync(join(poolDir, "runs", `${id}.events.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  interface QueuedAnswersFile {
    nextSeq: number;
    answers: {
      seq: number;
      ticketId: string;
      kind: string;
      approve?: boolean;
      note?: string;
      at: string;
      processedAt: string | null;
    }[];
  }

  function readQueuedAnswers(poolDir: string): QueuedAnswersFile {
    return JSON.parse(
      readFileSync(join(poolDir, "runs", "queued-answers.json"), "utf8"),
    ) as QueuedAnswersFile;
  }

  async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await Bun.sleep(10);
    }
  }

  // A stub harness whose blocked tickets hold their spawned script until the
  // sentinel file appears, so a test can keep a super-step in flight while it
  // answers an interrupt. Every other ticket takes the instant path. A ticket
  // can also fail: exitCode exits non-zero, and a status that is not done or
  // checkpoint writes no outcome at all. `blocks` gates per attempt (a
  // resumed ticket can hold its next super-step), and `sentinel` gives one
  // ticket its own release file.
  function blockingHarness(
    behaviour: Record<string, { statuses?: ("done" | "checkpoint" | "ready")[]; block?: boolean; blocks?: boolean[]; exitCode?: number; brief?: string; sentinel?: string }>,
    sentinel: string,
  ): StubRig {
    const poolLocal = tempDirs[tempDirs.length - 1];
    const stubPath = join(poolLocal, "blocking-stub.sh");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'issue="$1"; status="$2"; outcome_path="$3"; gate="$4"; sentinel="$5"; exit_code="$6"; outcome_json="$7"',
        'if [ "$gate" = "block" ]; then',
        '  while [ ! -f "$sentinel" ]; do sleep 0.02; done',
        "fi",
        'if [ -n "$outcome_json" ]; then',
        '  printf \'%s\' "$outcome_json" > "$outcome_path"',
        "fi",
        'exit "$exit_code"',
        "",
      ].join("\n"),
    );
    const spawned: Record<string, SpawnContext> = {};
    const spawnOrder: string[] = [];
    const spawnList: SpawnContext[] = [];
    const counts: Record<string, number> = {};
    const stub: HarnessCommand = (ctx) => {
      spawned[ctx.id] = ctx;
      spawnOrder.push(ctx.id);
      spawnList.push(ctx);
      const n = counts[ctx.id] ?? 0;
      counts[ctx.id] = n + 1;
      const b = behaviour[ctx.id] ?? {};
      const statuses = b.statuses ?? (["done"] as const);
      const status = statuses[Math.min(n, statuses.length - 1)];
      const block = b.blocks
        ? b.blocks[Math.min(n, b.blocks.length - 1)]
        : b.block;
      const outcome =
        status === "done" || status === "checkpoint"
          ? JSON.stringify({
              status,
              summary: "smoke",
              commitSha: null,
              ...(b.brief !== undefined ? { brief: b.brief } : {}),
            })
          : "";
      return [
        "bash",
        stubPath,
        ctx.issuePath,
        status,
        ctx.outcomePath,
        block ? "block" : "-",
        b.sentinel ?? sentinel,
        String(b.exitCode ?? 0),
        outcome,
      ];
    };
    return { harnesses: { stub }, spawned, spawnOrder, spawnList };
  }

  it("accepts answers mid-super-step and drains them in submission order at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
        { file: "04-d.md", marker: "<!-- state: id=04 blocked-by=03 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-04");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["checkpoint", "done"] },
        "03": { statuses: ["done"] },
        "04": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["04"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01") &&
        run.interrupts.some((i) => i.ticketId === "02"),
      "ticket 04 spawned with interrupts pending for 01 and 02",
    );

    const first = run.resume("02", "answered first");
    const second = run.resume("01", "answered second");

    // Acceptance was immediate: the answered events and the queued records
    // landed while ticket 04's attempt still held the super-step open.
    expect(readEventsFile(poolDir, "02").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "checkpoint",
      "answered",
    ]);
    expect(readEventsFile(poolDir, "02").at(-1)?.payload).toEqual({
      kind: "checkpoint",
    });
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers.map((a) => a.ticketId)).toEqual(["02", "01"]);
    expect(queue.answers.map((a) => a.kind)).toEqual(["checkpoint", "checkpoint"]);
    expect(queue.answers.every((a) => a.processedAt === null)).toBe(true);

    // The answer path never spawns: both tickets still sit at one attempt,
    // and the resume promises are still waiting on the boundary.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "spawned"),
    ).toHaveLength(1);
    expect(
      readEventsFile(poolDir, "02").filter((e) => e.kind === "spawned"),
    ).toHaveLength(1);
    let firstResolved = false;
    void first.then(() => {
      firstResolved = true;
    });
    await Bun.sleep(50);
    expect(firstResolved).toBe(false);

    writeFileSync(sentinel, "go");
    await first;
    await second;

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01", "02", "03", "04", "01", "02"]);
    const log = run.final.log;
    const answeredIdx = (id: string) =>
      log.findIndex((line) => line === `interrupt answered for ${id} (checkpoint): resumed`);
    const exited04 = log.findIndex((line) => line.startsWith("ticket 04: exited"));
    const step3 = log.findIndex((line) => line === "super-step 3: 01, 02");
    // Both answers were processed after the in-flight super-step joined, in
    // submission order, before the next super-step was scheduled.
    expect(answeredIdx("02")).toBeGreaterThan(exited04);
    expect(answeredIdx("02")).toBeLessThan(answeredIdx("01"));
    expect(answeredIdx("01")).toBeLessThan(step3);
    // The answered event precedes the attempt it unblocked in the ticket log.
    const kinds01 = readEventsFile(poolDir, "01").map((e) => e.kind);
    expect(kinds01.indexOf("answered")).toBeLessThan(kinds01.lastIndexOf("spawned"));
    expect(readQueuedAnswers(poolDir).answers.every((a) => a.processedAt !== null)).toBe(true);
  }, 15000);

  it("persists drained answers before the next super-step is scheduled", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=none status=ready -->" },
        { file: "04-d.md", marker: "<!-- state: id=04 blocked-by=03 status=ready -->" },
      ],
      config: stubConfig,
    });
    const release = join(poolDir, "release-03");
    const hold = join(poolDir, "hold-resumed");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"], blocks: [false, true], sentinel: hold },
        "02": { statuses: ["checkpoint", "done"], blocks: [false, true], sentinel: hold },
        "03": { statuses: ["done"], block: true },
        "04": { statuses: ["done"] },
      },
      release,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01") &&
        run.interrupts.some((i) => i.ticketId === "02"),
      "ticket 03 spawned with interrupts pending for 01 and 02",
    );

    const first = run.resume("02", "answered first");
    const second = run.resume("01", "answered second");

    // Release the held super-step: its boundary drains both answers and the
    // next super-step spawns the resumed tickets, which block again. While
    // that super-step is in flight, the answered state must already be on
    // disk: the drain persisted it before scheduling, so a kill here cannot
    // leave the resume in memory only.
    writeFileSync(release, "go");
    await waitFor(
      () => rig.spawnOrder.filter((id) => id === "01").length === 2,
      "resumed ticket 01 spawned into the next super-step",
    );
    const db = new Database(join(poolDir, "console.db"));
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .all() as { state: string }[];
    db.close();
    const persisted = JSON.parse(rows.at(-1)!.state) as {
      tickets: Record<string, string>;
      interrupts: { ticketId: string }[];
      log: string[];
    };
    expect(persisted.tickets["01"]).toBe("ready");
    expect(persisted.tickets["02"]).toBe("ready");
    expect(persisted.interrupts).toEqual([]);
    expect(persisted.log).toContain("interrupt answered for 02 (checkpoint): resumed");
    expect(persisted.log).toContain("interrupt answered for 01 (checkpoint): resumed");

    writeFileSync(hold, "go");
    await run.settled;
    await first;
    await second;
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02", "03", "01", "02", "04"]);
    expect(readQueuedAnswers(poolDir).answers.every((a) => a.processedAt !== null)).toBe(true);
  }, 15000);

  it("emits the queued answer on acceptance mid-flight and clears it at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-03");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "03": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 03 spawned with 01's interrupt pending",
    );

    run.accept("01", "go on");

    // Acceptance emitted a snapshot carrying the queued answer while the
    // super-step was still in flight; the interrupt is still pending on it.
    const accepted = run.snapshots.at(-1)!;
    expect(accepted.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(accepted.queuedAnswers[0]?.kind).toBe("checkpoint");
    expect(accepted.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);

    writeFileSync(sentinel, "go");
    await run.settled;

    // The boundary drain processed the answer, and the snapshots that follow
    // no longer carry it.
    const settled = run.snapshots.at(-1)!;
    expect(settled.queuedAnswers).toEqual([]);
    expect(settled.state.interrupts.some((i) => i.ticketId === "01")).toBe(false);
  }, 15000);

  it("writes the answered event and queued record at acceptance for a review approval", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({});

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);

    run.accept(REVIEW_TICKET_ID, "ship it", true);

    expect(readEventsFile(poolDir, REVIEW_TICKET_ID).map((e) => e.kind)).toEqual([
      "answered",
    ]);
    expect(readEventsFile(poolDir, REVIEW_TICKET_ID)[0]?.payload).toEqual({
      kind: "review",
    });
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]).toMatchObject({
      ticketId: REVIEW_TICKET_ID,
      kind: "review",
      approve: true,
      note: "ship it",
    });

    const done = await run.settled;
    expect(done.phase).toBe("done");
    expect(done.final.log).toContain("review approved: the run is complete (ship it)");
  });

  it("drains queued answers left behind by a killed server after rehydrate", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const first = await runPool({
      poolDir,
      harnesses: stubHarness({ "01": { status: "checkpoint" } }).harnesses,
    });
    expect(first.phase).toBe("quiescent");
    first.close();

    // The on-disk state a kill leaves behind when an answer was accepted but
    // the process died before the drain: acceptance's exact writes (the
    // answered event, then the queued record) with the interrupt still
    // pending in the checkpoint.
    appendEvent(join(poolDir, "runs"), "01", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "answered",
      payload: { kind: "checkpoint" },
    });
    new QueuedAnswerStore(join(poolDir, "runs")).enqueue({
      ticketId: "01",
      kind: "checkpoint",
      note: "the name is Foo",
      at: new Date().toISOString(),
    });

    const rig = stubHarness({ "01": { status: "done" } });
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });

    // The queued answer took effect without resubmission: 01 resumed and
    // finished, its dependent ran, and the run reached the review gate.
    expect(restarted.phase).toBe("quiescent");
    expect(restarted.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]?.processedAt).not.toBeNull();
    // The only answered event is acceptance's own, written before the kill.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
  });

  it("keeps an answered interrupt durable across a kill before the next super-step", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        {
          file: "02-b.md",
          marker: "<!-- state: id=02 blocked-by=01 status=ready -->",
        },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-01");
    // Attempt 1 of 01 checkpoints; its resume attempt holds the super-step
    // open on the sentinel, so the kill lands between the processed answer
    // and the next super-step's join. The attempt-1 log only exists once a
    // re-run rotated it, which marks the resume attempt as spawned.
    writeFileSync(
      join(poolDir, "agent.sh"),
      [
        "#!/usr/bin/env bash",
        'issue="$1"; id="$2"; outcome_path="$3"; pool="$4"; sentinel="$5"',
        'if [ "$id" = "01" ]; then',
        '  if [ ! -f "$pool/runs/01.attempt-1.log" ]; then',
        '    printf \'%s\' \'{"status":"checkpoint","summary":"need a name","commitSha":null,"brief":"pick a name"}\' > "$outcome_path"',
        "    exit 0",
        "  fi",
        '  while [ ! -f "$sentinel" ]; do sleep 0.02; done',
        "  exit 0",
        "fi",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(poolDir, "fixture.ts"),
      [
        "const [enginePath, poolDir] = process.argv.slice(2);",
        "const { runPool } = await import(enginePath);",
        "const harnesses = {",
        "  stub: (ctx: { issuePath: string; id: string; outcomePath: string }) => [",
        '    "bash",',
        "    `${poolDir}/agent.sh`,",
        "    ctx.issuePath,",
        "    ctx.id,",
        "    ctx.outcomePath,",
        "    poolDir,",
        "    `${poolDir}/release-01`,",
        "  ],",
        "};",
        "const run = await runPool({ poolDir, harnesses });",
        "await run.resume('01', 'the name is Foo');",
        "",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      ["bun", join(poolDir, "fixture.ts"), join(import.meta.dir, "engine.ts"), poolDir],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      await waitFor(
        () =>
          existsSync(join(poolDir, "runs", "01.attempt-1.log")) &&
          readQueuedAnswers(poolDir).answers[0]?.processedAt !== null,
        "answer processed and the resume attempt spawned",
      );
    } finally {
      proc.kill();
      await proc.exited;
    }
    // The killed engine's blocked attempt holds no one: release it so the
    // orphaned stub exits instead of polling a directory the test teardown
    // removes.
    writeFileSync(sentinel, "go");

    const rig = stubHarness({ "01": { status: "done" }, "02": { status: "done" } });
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });

    // The answered state was on disk before the kill: the restart rehydrates
    // it, shows the answer in the log without resubmission, and runs the
    // resumed pool through to the review gate.
    expect(restarted.phase).toBe("quiescent");
    expect(restarted.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01", "02"]);
    expect(restarted.final.log).toContain(
      "interrupt answered for 01 (checkpoint): resumed",
    );
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers).toHaveLength(1);
    expect(queue.answers[0]?.processedAt).not.toBeNull();
    const issueText = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issueText).toContain("## Resume note");
    expect(issueText).toContain("the name is Foo");
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
  }, 20000);

  it("acknowledges a duplicate answer without a second event or record, and both callers settle", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-03");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["done"] },
        "03": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["03"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 03 spawned with the checkpoint interrupt pending for 01",
    );

    // The client answered, timed out waiting, and retried the same answer
    // while the first was still queued behind the in-flight super-step.
    const first = run.resume("01", "carry on");
    const retry = run.resume("01", "carry on");

    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    expect(readQueuedAnswers(poolDir).answers).toHaveLength(1);

    writeFileSync(sentinel, "go");
    await first;
    await retry;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(run.final.tickets["01"]).toBe("done");
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  }, 15000);

  it("records a crash at attempt exit, before a slow sibling's super-step ends", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 fails fast without writing an outcome; 02 holds the super-step
        // open until the sentinel lands.
        "01": { statuses: ["ready"], exitCode: 3 },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    // Counted synchronously, before the drive's first emit: the assertion
    // below needs every emit this run produces accounted for, and counting
    // later risks observing 01's fast crash before the count lands.
    const snapshotsBefore = run.snapshots.length;
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");

    // The crash is recorded the moment 01's attempt exits: the event lands in
    // the ticket log and the marker is corrected while 02 still holds the
    // super-step open, and a snapshot pushes the crash to the Console.
    await waitFor(
      () => readEventsFile(poolDir, "01").some((e) => e.kind === "crash"),
      "crash event for ticket 01",
    );
    expect(readEventsFile(poolDir, "01").map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
      "crash",
    ]);
    expect(readEventsFile(poolDir, "01").at(-1)?.payload).toEqual({
      code: 3,
      reason: "harness exited 3",
      logTail: [],
      outcomeExists: false,
    });
    expect(
      readFileSync(join(poolDir, "issues", "01-a.md"), "utf8").split("\n")[0],
    ).toContain("status=in-progress");
    // The crash emit is one more snapshot on top of the run's opening and
    // scheduling emits; 02 still blocks, so no boundary emit can explain the
    // count. (Counting from before the drive started keeps this true however
    // late this thread observes the crash.)
    await waitFor(
      () => run.snapshots.length > snapshotsBefore + 1,
      "snapshot emitted at crash recording",
    );
    // The interrupt itself still waits for the super-step boundary.
    expect(run.interrupts).toEqual([]);

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["crash"]);
    expect(run.interrupts[0]?.ticketId).toBe("01");
    // Recorded once, at exit; the boundary raises the interrupt only.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "crash"),
    ).toHaveLength(1);
  }, 15000);

  it("joins a done result into state and emits a snapshot at attempt exit, before a slow sibling exits", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 finishes done fast; 02 holds the super-step open until the
        // sentinel lands.
        "01": { statuses: ["done"] },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");

    // 02 has not been released, so the super-step is still in flight. A
    // snapshot already shows 01 done while 02 still reads in-progress: the
    // terminal status landed in state at 01's exit.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "done" &&
            snapshot.state.tickets["02"] === "in-progress",
        ),
      "snapshot showing 01 done and 02 still in-progress",
    );
    // A plain done carries no interrupt, even while it shows green early.
    expect(run.interrupts).toEqual([]);

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    // The exited line for the fast ticket was written exactly once: the
    // boundary did not re-apply the at-exit join.
    expect(
      run.final.log.filter((line) => line === "ticket 01: exited 0, marker done"),
    ).toHaveLength(1);
  }, 15000);

  it("raises a checkpoint's interrupt at attempt exit, before a slow sibling exits", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        // 01 checkpoints fast; 02 holds the super-step open until the sentinel.
        "01": { statuses: ["checkpoint", "done"], brief: "pick a name" },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");

    // The checkpoint status and its interrupt both landed in state at exit
    // while 02 still runs: the snapshot already carries the red status word,
    // the pending interrupt, and the checkpoint event.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "checkpoint" &&
            snapshot.state.tickets["02"] === "in-progress" &&
            snapshot.state.interrupts.some(
              (i) => i.ticketId === "01" && i.kind === "checkpoint",
            ),
        ),
      "snapshot showing 01 checkpoint with its interrupt pending while 02 still runs",
    );
    expect(run.interrupts).toEqual([
      { ticketId: "01", kind: "checkpoint", body: "pick a name" },
    ]);
    // The checkpoint event is recorded at exit, once.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "checkpoint"),
    ).toHaveLength(1);
    // The sibling is untouched: still in-progress, no pause, no crash.
    expect(run.final.tickets["02"]).toBe("in-progress");

    writeFileSync(sentinel, "go");
    await run.settled;

    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
    expect(run.interrupts[0]?.body).toBe("pick a name");
    expect(run.final.tickets).toEqual({ "01": "checkpoint", "02": "done" });
    // The boundary did not raise or record the checkpoint again.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "checkpoint"),
    ).toHaveLength(1);
  }, 15000);

  it("accepts an answer during the window, queues it, and processes it at the boundary", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"], brief: "pick a name" },
        "02": { statuses: ["done"], block: true },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(
      () =>
        rig.spawned["02"] !== undefined &&
        run.interrupts.some((i) => i.ticketId === "01"),
      "ticket 02 spawned with 01's checkpoint interrupt already pending",
    );

    // 02 has not been released, so the super-step is still in flight; the
    // interrupt raised at 01's exit is answerable now. Acceptance is
    // immediate: the answered event and the queued record land while 02
    // still runs, and a snapshot pushes the waiting state to the Console.
    const resume = run.resume("01", "the name is Foo");
    const accepted = run.snapshots.at(-1)!;
    expect(accepted.queuedAnswers.map((a) => a.ticketId)).toEqual(["01"]);
    expect(accepted.queuedAnswers[0]?.kind).toBe("checkpoint");
    expect(accepted.state.interrupts.some((i) => i.ticketId === "01")).toBe(true);
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "answered"),
    ).toHaveLength(1);
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).toBeNull();
    // The answer is queued, not processed: the marker is still checkpoint and
    // the resume promise waits on the boundary.
    expect(
      readFileSync(join(poolDir, "issues", "01-a.md"), "utf8").split("\n")[0],
    ).toContain("status=checkpoint");
    let resolved = false;
    void resume.then(() => {
      resolved = true;
    });
    await Bun.sleep(50);
    expect(resolved).toBe(false);

    writeFileSync(sentinel, "go");
    await resume;

    // The boundary drained the answer (01 back to ready) and the next
    // super-step re-ran it to done; the sibling ran its own exit untouched.
    expect(run.phase).toBe("quiescent");
    expect(run.final.tickets).toEqual({ "01": "done", "02": "done" });
    expect(run.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  }, 15000);

  it("applies an at-exit terminal join exactly once and keeps the final snapshot sequence coherent", async () => {
    const poolDir = makePool({
      tickets: [
        {
          file: "01-a.md",
          marker: "<!-- state: id=01 blocked-by=none status=ready -->",
          body: "# 01\n\n## Brief\n\npick a name",
        },
        { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=none status=ready -->" },
        { file: "03-c.md", marker: "<!-- state: id=03 blocked-by=02 status=ready -->" },
      ],
      config: stubConfig,
    });
    const sentinel = join(poolDir, "release-02");
    const rig = blockingHarness(
      {
        "01": { statuses: ["checkpoint", "done"] },
        "02": { statuses: ["done"], block: true },
        "03": { statuses: ["done"] },
      },
      sentinel,
    );

    const run = startPool({ poolDir, harnesses: rig.harnesses });
    await waitFor(() => rig.spawned["02"] !== undefined, "ticket 02 spawned");
    // 03 is blocked by 02, so it is not in this super-step; the checkpoint
    // snapshot is already out while 02 still holds the super-step open.
    await waitFor(
      () =>
        run.snapshots.some(
          (snapshot) =>
            snapshot.state.tickets["01"] === "checkpoint" &&
            snapshot.state.tickets["02"] === "in-progress",
        ),
      "snapshot showing 01 checkpoint while 02 still runs",
    );

    writeFileSync(sentinel, "go");
    await run.settled;
    const settled = run.snapshots.at(-1)!;

    // The checkpoint attempt's update was joined at exit and skipped at the
    // boundary: its exited line appears once, and nothing diverged. The
    // interrupted ticket stayed checkpointed, its siblings finished, and the
    // boundary snapshot is coherent with the settled state.
    expect(
      run.final.log.filter(
        (line) => line === "ticket 01: exited 0, marker checkpoint",
      ),
    ).toHaveLength(1);
    expect(settled.state.tickets["01"]).toBe("checkpoint");
    expect(settled.state.tickets["02"]).toBe("done");
    expect(settled.state.tickets["03"]).toBe("done");
    expect(run.final.tickets).toEqual({
      "01": "checkpoint",
      "02": "done",
      "03": "done",
    });
    expect(run.phase).toBe("quiescent");
    expect(run.interrupts.map((i) => i.kind)).toEqual(["checkpoint"]);
  }, 15000);

  it("records the queued answer in its own store, separate from the PoolState checkpoints", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const rig = stubHarness({ "01": { statuses: ["checkpoint", "done"] } });

    const run = await runPool({ poolDir, harnesses: rig.harnesses });
    run.accept("01", "carry on");

    // The record lives in runs/queued-answers.json, not in the checkpoint
    // database's PoolState rows.
    const queue = readQueuedAnswers(poolDir);
    expect(queue.answers.map((a) => a.ticketId)).toEqual(["01"]);
    const db = new Database(join(poolDir, "console.db"));
    const rows = db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .all() as { state: string }[];
    db.close();
    expect(rows.at(-1)?.state ?? "").not.toContain("queued-answer");

    const resumed = await run.settled;
    expect(resumed.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(resumed.final.tickets["01"]).toBe("done");
    expect(readQueuedAnswers(poolDir).answers[0]?.processedAt).not.toBeNull();
  });
});

// Headless orphans (ADR-0017, issue #65): a headless attempt is the engine's
// child, tracked from spawn to exit; a shutdown stops it and its own children
// as one process group, and a boot that finds a previous engine's attempt
// still running in its worktree stops it before scheduling the re-run.
describe("headless orphans", () => {
  interface EventLine {
    at: string;
    attempt: number;
    kind: string;
    payload: Record<string, unknown>;
  }

  function readEventsFile(poolDir: string, id: string): EventLine[] {
    const path = join(poolDir, "runs", `${id}.events.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLine);
  }

  // A harness that never finishes on its own: it forks a sleeper (the
  // grandchild a real harness's tool calls are) and records both pids.
  function lingeringHarness(poolDir: string): Record<string, HarnessCommand> {
    const script = join(poolDir, "linger.sh");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        'sleep 60 &',
        'echo $! > "$1/grandchild.pid"',
        "wait",
        "",
      ].join("\n"),
    );
    return { stub: () => ["bash", script, poolDir] };
  }

  function grandchildPid(poolDir: string): number | null {
    const path = join(poolDir, "grandchild.pid");
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : Number(text);
  }

  it("shutdown stops a running attempt with its grandchildren, records the stop, and raises no crash interrupt", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      ],
      config: stubConfig,
    });
    const run = startPool({ poolDir, harnesses: lingeringHarness(poolDir) });
    await waitFor(
      () =>
        readEventsFile(poolDir, "01").some(
          (e) => e.kind === "spawned" && typeof e.payload.pid === "number",
        ) && grandchildPid(poolDir) !== null,
    );
    const spawned = readEventsFile(poolDir, "01").find((e) => e.kind === "spawned")!;
    const pid = spawned.payload.pid as number;
    const grandchild = grandchildPid(poolDir)!;
    expect(processIsLive(pid)).toBe(true);
    expect(processIsLive(grandchild)).toBe(true);

    await run.shutdown(1_000);

    // The group went with the harness: the sleeper it forked is gone too.
    expect(processIsLive(pid)).toBe(false);
    await waitFor(() => !processIsLive(grandchild), 2_000);
    // The stop is on the ticket log as what it was, not as a harness failure.
    const kinds = readEventsFile(poolDir, "01").map((e) => e.kind);
    expect(kinds).toEqual(["scheduled", "spawned", "exited", "crash"]);
    const crash = readEventsFile(poolDir, "01").find((e) => e.kind === "crash")!;
    expect(crash.payload.reason).toBe("harness stopped by engine shutdown (exited 143)");
    // No crash interrupt: the super-step joined under shutdown and the
    // ticket is left in-progress for the next boot to reset.
    expect(run.interrupts).toEqual([]);
    expect(run.final.log).toContain(
      "engine shutdown: super-step joined; no crash interrupts raised and nothing more scheduled",
    );
    expect(loadPoolMarkers(join(poolDir, "issues"))[0]!.status).toBe("in-progress");

    // The relaunch: nothing is alive, so the ticket resets with the plain
    // note and re-runs to the review gate.
    const rig = stubHarness({ "01": { status: "done" } });
    const restarted = await runPool({ poolDir, harnesses: rig.harnesses });
    expect(restarted.phase).toBe("quiescent");
    expect(restarted.interrupts.map((i) => i.kind)).toEqual(["review"]);
    expect(rig.spawnOrder).toEqual(["01"]);
    const issue = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issue).toContain("No agent from that process was found still running at this boot");
    expect(issue).not.toContain("was found still running in the working tree");
    // The relaunch's own spawn is not an orphan: the earlier attempt's pid
    // was recorded, then closed by its exited event.
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "crash"),
    ).toHaveLength(1);
  });

  it("boot stops a previous engine's attempt still running in its worktree, then re-runs the ticket", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=in-progress -->" },
      ],
      config: stubConfig,
    });
    mkdirSync(join(poolDir, "runs"), { recursive: true });
    const worktree = join(poolDir, "wt-01");
    mkdirSync(worktree);
    // The orphan: a process group nobody owns, working in the recorded cwd,
    // exactly what an untrapped kill of the previous server leaves behind.
    const orphan = Bun.spawn(["bash", "-c", "sleep 60 & wait"], {
      cwd: worktree,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      appendEvent(join(poolDir, "runs"), "01", {
        at: new Date().toISOString(),
        attempt: 1,
        kind: "spawned",
        payload: { argv: ["bash"], cwd: worktree, branch: null, pid: orphan.pid },
      });

      const rig = stubHarness({ "01": { status: "done" } });
      const run = await runPool({ poolDir, harnesses: rig.harnesses });

      expect(processIsLive(orphan.pid)).toBe(false);
      expect(run.phase).toBe("quiescent");
      expect(rig.spawnOrder).toEqual(["01"]);
      const events = readEventsFile(poolDir, "01");
      const crashAt = events.findIndex((e) => e.kind === "crash");
      const respawnAt = events.findIndex(
        (e, i) => i > 0 && e.kind === "spawned",
      );
      // The stop is recorded on attempt 1 before attempt 2 spawns.
      expect(crashAt).toBeGreaterThan(0);
      expect(crashAt).toBeLessThan(respawnAt);
      expect(events[crashAt]!.attempt).toBe(1);
      expect(events[crashAt]!.payload.reason).toBe(
        `orphan attempt (pid ${orphan.pid}) from a previous engine process was still running at boot; stopped by the engine`,
      );
      expect(run.final.log).toContain(
        `ticket 01: orphan attempt 1 (pid ${orphan.pid}) stopped at boot`,
      );
      const issue = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
      expect(issue).toContain(
        `attempt 1 (pid ${orphan.pid}) was found still running in the working tree`,
      );
    } finally {
      try {
        process.kill(-orphan.pid, "SIGKILL");
      } catch {
        // already stopped, which is the point
      }
    }
  });

  it("a recorded pid that is alive but working elsewhere is a reused pid, not an orphan", async () => {
    const poolDir = makePool({
      tickets: [
        { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=in-progress -->" },
      ],
      config: stubConfig,
    });
    mkdirSync(join(poolDir, "runs"), { recursive: true });
    const worktree = join(poolDir, "wt-01");
    mkdirSync(worktree);
    // This test process is alive, and its cwd is not the recorded worktree.
    appendEvent(join(poolDir, "runs"), "01", {
      at: new Date().toISOString(),
      attempt: 1,
      kind: "spawned",
      payload: { argv: ["bash"], cwd: worktree, branch: null, pid: process.pid },
    });

    const rig = stubHarness({ "01": { status: "done" } });
    const run = await runPool({ poolDir, harnesses: rig.harnesses });

    expect(run.phase).toBe("quiescent");
    expect(rig.spawnOrder).toEqual(["01"]);
    expect(
      readEventsFile(poolDir, "01").filter((e) => e.kind === "crash"),
    ).toEqual([]);
    expect(run.final.log).toContain(
      "ticket 01: marker was in-progress with no live agent; back to ready",
    );
    const issue = readFileSync(join(poolDir, "issues", "01-a.md"), "utf8");
    expect(issue).toContain("No agent from that process was found still running at this boot");
  });
});
