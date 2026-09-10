import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import {
  startPool,
  type HarnessCommand,
  type PoolConfig,
  type PoolRun,
} from "./engine.ts";
import {
  loadConversations,
  nextConversationId,
  readConversation,
  writeConversation,
  writeConversationStatus,
  type ConversationRecord,
} from "./conversations.ts";
import { readEvents } from "./events.ts";
import { branchExists, branchFor, worktreePathFor } from "./worktrees.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await Bun.sleep(20);
  }
}

interface PoolSpec {
  tickets: { file: string; marker: string; body?: string }[];
  config?: PoolConfig;
}

function makePool(spec: PoolSpec): string {
  const poolDir = mkdtempSync(join(tmpdir(), "conv-pool-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of spec.tickets) {
    writeFileSync(
      join(poolDir, "issues", ticket.file),
      `${ticket.marker}\n\n${ticket.body ?? "# body"}\n`,
    );
  }
  if (spec.config) {
    writeFileSync(join(poolDir, "console.json"), JSON.stringify(spec.config, null, 2));
  }
  return poolDir;
}

// A git-backed pool, in the style of engine.test.ts's makeGitPool: Conversations
// require a real checkout (their own worktree and branch), so every test that
// starts one needs this instead of the headless makePool above.
function makeGitPool(spec: PoolSpec, seed: Record<string, string> = {}): string {
  const poolDir = makePool(spec);
  for (const [path, content] of Object.entries(seed)) {
    writeFileSync(join(poolDir, path), content);
  }
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: poolDir, stdout: "pipe", stderr: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "pool@test"]);
  git(["config", "user.name", "pool"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return poolDir;
}

function gitIn(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const readyTicket = (id: string) =>
  ({ file: `${id}.md`, marker: `<!-- state: id=${id} blocked-by=none status=ready -->` }) as const;

const doneTicket = (id: string) =>
  ({ file: `${id}.md`, marker: `<!-- state: id=${id} blocked-by=none status=done -->` }) as const;

const stubConfig: PoolConfig = { defaults: { harness: "stub", model: "stub-model" } };

function stubHarness(): { harnesses: Record<string, HarnessCommand> } {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    ["#!/usr/bin/env bash", 'printf \'{"status":"done","summary":"s","commitSha":null}\' > "$1"', "exit 0", ""].join(
      "\n",
    ),
  );
  const stub: HarnessCommand = (ctx) => ["bash", stubPath, ctx.outcomePath];
  return { harnesses: { stub } };
}

// A minimal herdr fake: real wire shape (newline-delimited JSON-RPC, one
// request per connection), and it actually runs what a pane is sent (the
// wrapper shell executes for real under bash), exactly as engine.test.ts's
// fake does. Simplified for Conversations' own tests: no readiness-pattern
// rendering is needed because every test here registers a harness with no
// entry in defaultHarnessDescriptors, so startConversation's readiness wait
// is skipped outright (readiness-pattern matching itself is pane-session.ts's
// concern and stays covered by engine.test.ts's existing interactive-TUI
// tests).
interface FakePane {
  tabId: string;
  cwd: string;
  alive: boolean;
  buffer: string;
  booted: boolean;
  inputArea: string;
  proc?: ReturnType<typeof Bun.spawn>;
}

async function startFakeHerdr(): Promise<{
  socketPath: string;
  close: () => Promise<void>;
  endPane: (paneId: string) => void;
  panes: Map<string, FakePane>;
}> {
  let minted = 0;
  const panes = new Map<string, FakePane>();
  const subscribers: Socket[] = [];
  const connections = new Set<Socket>();
  const procs: ReturnType<typeof Bun.spawn>[] = [];

  const broadcast = (event: string, data: Record<string, unknown>): void => {
    for (const sub of [...subscribers]) {
      if (sub.destroyed || !sub.writable) {
        subscribers.splice(subscribers.indexOf(sub), 1);
        continue;
      }
      sub.write(JSON.stringify({ event, data: { type: event, ...data } }) + "\n");
    }
  };
  const firePaneEnd = (paneId: string, event: "pane_exited" | "pane_closed"): void => {
    const pane = panes.get(paneId);
    if (pane) {
      pane.alive = false;
      pane.proc?.kill();
    }
    broadcast(event, { pane_id: paneId, workspace_id: "w1" });
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
          booted: false,
          inputArea: "",
        });
        respond({ tab: { tab_id: tabId } });
      } else if (msg.method === "pane.list") {
        respond({
          panes: [...panes.entries()]
            .filter(([, p]) => p.alive)
            .map(([id, p]) => ({ tab_id: p.tabId, pane_id: id })),
        });
      } else if (msg.method === "pane.read") {
        const pane = panes.get(String(msg.params.pane_id));
        const visible = pane ? (pane.booted ? pane.inputArea : pane.buffer) : "";
        respond({ read: { text: visible, revision: 0, truncated: false } });
      } else if (msg.method === "pane.send_input") {
        const pane = panes.get(String(msg.params.pane_id));
        if (pane) {
          if (typeof msg.params.text === "string") {
            if (!pane.booted) pane.buffer += msg.params.text;
            else pane.inputArea += msg.params.text;
          }
          if (Array.isArray(msg.params.keys) && msg.params.keys.includes("enter")) {
            if (pane.booted) {
              pane.inputArea = "";
            } else {
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
              const paneId = String(msg.params.pane_id);
              void proc.exited.then(() => {
                if (panes.get(paneId)?.alive) firePaneEnd(paneId, "pane_exited");
              });
            }
          }
        }
        respond({});
      } else if (msg.method === "events.subscribe") {
        subscribers.push(socket);
        socket.on("close", () => {
          const at = subscribers.indexOf(socket);
          if (at !== -1) subscribers.splice(at, 1);
        });
        socket.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
      } else if (msg.method === "pane.close") {
        const paneId = String(msg.params.pane_id ?? "");
        respond({ type: "ok" });
        firePaneEnd(paneId, "pane_closed");
      } else if (msg.method === "tab.close") {
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
  const dir = mkdtempSync(join(tmpdir(), "conv-herdr-fake-"));
  tempDirs.push(dir);
  const socketPath = join(dir, "herdr.sock");
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const proc of procs) proc.kill();
        for (const sub of subscribers) sub.destroy();
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
      }),
    endPane: (paneId) => firePaneEnd(paneId, "pane_exited"),
    panes,
  };
}

// A conversational "harness" with no defaultHarnessDescriptors entry: an
// ordinary interactive process (`cat`, which just holds the pane open reading
// stdin) that startConversation's readiness wait skips entirely, so these
// tests exercise the Conversation launch/end machinery without depending on
// any particular harness's ready pattern.
const convoHarnesses: Record<string, HarnessCommand> = { convo: () => ["cat"] };
const convoConfig: PoolConfig = {
  defaults: { harness: "convo", model: "stub-model" },
  terminal: "herdr",
};

describe("Conversation storage", () => {
  it("round-trips a marker through write and read, including a spawned-by id and a multi-word drivers chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-storage-"));
    tempDirs.push(dir);
    const rec: ConversationRecord = {
      id: "conv-1",
      file: join(dir, "conv-1.md"),
      title: "Plan the migration",
      opening: "Let's talk through the migration plan.",
      status: "live",
      spawnedBy: "conv-0",
      harness: "claude",
      model: "opus",
      // Multi-word, matching a ticket's driver chain (engine.ts splits on
      // /\s+/): the marker line itself is whitespace-split, so this only
      // round-trips if the field is percent-encoded.
      drivers: "implement resolving-merge-conflicts",
    };
    writeConversation(dir, rec);
    const loaded = readConversation(rec.file);
    expect(loaded).toEqual(rec);

    writeConversationStatus(rec.file, "ended");
    expect(readConversation(rec.file).status).toBe("ended");

    const all = loadConversations(dir);
    expect(all.map((r) => r.id)).toEqual(["conv-1"]);
    expect(nextConversationId(all)).toBe("conv-2");
  });

  it("loadConversations reads none from a pool with no conversations/ directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "conv-storage-empty-"));
    tempDirs.push(dir);
    expect(loadConversations(join(dir, "conversations"))).toEqual([]);
  });
});

describe("Conversation launch refusal", () => {
  it("refuses to start on a pool that is not terminal-backed", async () => {
    const poolDir = makePool({ tickets: [doneTicket("01")], config: stubConfig });
    const { harnesses } = stubHarness();
    const run = startPool({ poolDir, harnesses });
    await expect(run.startConversation({ title: "A talk" })).rejects.toThrow(
      /not terminal-backed/,
    );
    await run.shutdown(0);
  });
});

describe("Conversation launch", () => {
  it("opens a named herdr tab and types the opening Turn, verified by echo", async () => {
    const poolDir = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: convoHarnesses,
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({
        title: "Plan the rollout",
        opening: "hello agent, let's plan the rollout",
      });
      expect(view.status).toBe("live");
      expect(view.paneId).toBeTruthy();
      expect(view.branch).toBe(branchFor(poolDir, view.id));
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(true);

      const rec = readConversation(join(poolDir, "conversations", `${view.id}.md`));
      expect(rec.status).toBe("live");
      expect(rec.title).toBe("Plan the rollout");
      expect(rec.opening).toBe("hello agent, let's plan the rollout");

      const spawned = readEvents(join(poolDir, "runs"), view.id).find((e) => e.kind === "spawned");
      expect(spawned).toBeTruthy();
      expect(typeof spawned!.payload.pane_id).toBe("string");
      expect(typeof spawned!.payload.tab_id).toBe("string");

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });

  it("emits a snapshot carrying the Conversation the moment it starts, with no other pool activity to piggyback on", async () => {
    // startConversation is called directly off the PoolRun handle, never
    // through kickProcessing/the drive loop, so with no ticket work
    // running nothing else would ever tell the snapshot stream this
    // Conversation exists — the assertion below must hold synchronously
    // once startConversation resolves, not eventually.
    const poolDir = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: convoHarnesses,
        herdrSocket: fake.socketPath,
      });
      const before = run.snapshots.length;
      const view = await run.startConversation({ title: "Plan" });

      expect(run.snapshots.length).toBeGreaterThan(before);
      expect(
        run.snapshots.some((s) => s.conversations.some((c) => c.id === view.id && c.status === "live")),
      ).toBe(true);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });
});

describe("Conversation ending", () => {
  it("ends with no commits: worktree removed, status ended, no merge event", async () => {
    const poolDir = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run = startPool({ poolDir, harnesses: convoHarnesses, herdrSocket: fake.socketPath });
      const view = await run.startConversation({ title: "Idle chat" });
      await run.endConversation(view.id, "all done here");

      const rec = readConversation(join(poolDir, "conversations", `${view.id}.md`));
      expect(rec.status).toBe("ended");
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(false);
      expect(branchExists(poolDir, view.id)).toBe(false);

      const events = readEvents(join(poolDir, "runs"), view.id);
      expect(events.some((e) => e.kind === "ended")).toBe(true);
      expect(events.some((e) => e.kind === "merged")).toBe(false);
      const ended = events.find((e) => e.kind === "ended")!;
      expect(ended.payload.closing).toBe("all done here");
      expect(ended.payload.merged).toBe(false);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });

  it("emits a snapshot reflecting the ending the moment End resolves", async () => {
    // endConversation is a direct PoolRun call too (not through the drive
    // loop), so the same "nothing else would tell the stream" reasoning as
    // the start test above applies to its ending.
    const poolDir = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({ poolDir, harnesses: convoHarnesses, herdrSocket: fake.socketPath });
      const view = await run.startConversation({ title: "Idle chat" });
      const before = run.snapshots.length;
      await run.endConversation(view.id, "all done here");

      expect(run.snapshots.length).toBeGreaterThan(before);
      const last = run.snapshots.at(-1)!;
      expect(last.conversations.find((c) => c.id === view.id)?.status).toBe("ended");

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });

  it("ends with commits: merges the branch onto main and removes the worktree", async () => {
    const poolDir = makeGitPool(
      { tickets: [doneTicket("01")], config: convoConfig },
      { "shared.txt": "base\n" },
    );
    const fake = await startFakeHerdr();
    try {
      const run = startPool({ poolDir, harnesses: convoHarnesses, herdrSocket: fake.socketPath });
      const view = await run.startConversation({ title: "Ship a fix" });
      const worktree = worktreePathFor(poolDir, view.id);

      writeFileSync(join(worktree, "new-file.txt"), "written during the conversation\n");
      gitIn(worktree, ["add", "-A"]);
      const commit = gitIn(worktree, ["commit", "-qm", "conversation commit"]);
      expect(commit.exitCode).toBe(0);

      await run.endConversation(view.id);

      const rec = readConversation(join(poolDir, "conversations", `${view.id}.md`));
      expect(rec.status).toBe("ended");
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(false);
      expect(existsSync(join(poolDir, "new-file.txt"))).toBe(true);

      const events = readEvents(join(poolDir, "runs"), view.id);
      expect(events.some((e) => e.kind === "merged")).toBe(true);
      const ended = events.find((e) => e.kind === "ended")!;
      expect(ended.payload.merged).toBe(true);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });

  it("a conflicted End raises the merge-approval interrupt under the conversation id once the resolver resolves it", async () => {
    const resolverStubPath = mkdtempSync(join(tmpdir(), "conv-resolver-"));
    tempDirs.push(resolverStubPath);
    const scriptPath = join(resolverStubPath, "resolver.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'outcome="$1"; worktree="$2"',
        'git -C "$worktree" merge main >/dev/null 2>&1 || true',
        'printf \'resolved-by-resolver\\n\' > "$worktree/shared.txt"',
        'git -C "$worktree" add shared.txt',
        'printf \'{"resolved": true, "note": "resolved the conflict"}\' > "$outcome"',
        "exit 0",
        "",
      ].join("\n"),
    );
    const resolverHarness: HarnessCommand = (ctx) => ["bash", scriptPath, ctx.outcomePath, ctx.cwd];

    const poolDir = makeGitPool(
      {
        tickets: [doneTicket("01")],
        config: { ...convoConfig, resolver: "resolver-stub" },
      },
      { "shared.txt": "base\n" },
    );
    const fake = await startFakeHerdr();
    try {
      const run = startPool({
        poolDir,
        harnesses: { ...convoHarnesses, "resolver-stub": resolverHarness },
        herdrSocket: fake.socketPath,
        issueRunnerPath: join(resolverStubPath, "no-such-issue-runner"),
      });
      const view = await run.startConversation({ title: "Conflicting talk" });
      const worktree = worktreePathFor(poolDir, view.id);

      // Diverge: the conversation's branch and main both touch shared.txt.
      writeFileSync(join(worktree, "shared.txt"), "worktree-change\n");
      gitIn(worktree, ["add", "-A"]);
      expect(gitIn(worktree, ["commit", "-qm", "worktree change"]).exitCode).toBe(0);
      writeFileSync(join(poolDir, "shared.txt"), "main-change\n");
      gitIn(poolDir, ["add", "-A"]);
      expect(gitIn(poolDir, ["commit", "-qm", "main change"]).exitCode).toBe(0);

      await run.endConversation(view.id);

      const approval = run.interrupts.find((i) => i.ticketId === view.id);
      expect(approval?.kind).toBe("merge-approval");

      // The Conversation is still "live" on disk: ending is pending on the
      // operator's answer to the raised interrupt.
      expect(readConversation(join(poolDir, "conversations", `${view.id}.md`)).status).toBe(
        "live",
      );

      await run.approve(view.id);

      const rec = readConversation(join(poolDir, "conversations", `${view.id}.md`));
      expect(rec.status).toBe("ended");
      expect(existsSync(join(poolDir, "shared.txt")) && readFileSync(join(poolDir, "shared.txt"), "utf8")).toBe(
        "resolved-by-resolver\n",
      );
      expect(run.interrupts.find((i) => i.ticketId === view.id)).toBeUndefined();

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });

  it("a pane closed without End crashes the conversation and keeps its branch", async () => {
    const poolDir = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run = startPool({ poolDir, harnesses: convoHarnesses, herdrSocket: fake.socketPath });
      const view = await run.startConversation({ title: "Cut short" });
      expect(branchExists(poolDir, view.id)).toBe(true);

      fake.endPane(view.paneId!);

      const file = join(poolDir, "conversations", `${view.id}.md`);
      await waitFor(() => readConversation(file).status === "crashed");

      expect(branchExists(poolDir, view.id)).toBe(true);
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(true);
      const events = readEvents(join(poolDir, "runs"), view.id);
      expect(events.some((e) => e.kind === "crash")).toBe(true);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });
});

describe("Conversation-only pool boot", () => {
  it("boots a pool with an empty issues/ once a conversations/ directory exists, and serves a snapshot", async () => {
    const poolDir = mkdtempSync(join(tmpdir(), "conv-only-pool-"));
    tempDirs.push(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    // Status "ended": no live pane, no herdr fake required at all — this
    // test is purely about startPool tolerating zero Tickets.
    writeFileSync(
      join(poolDir, "conversations", "conv-1.md"),
      "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=stub " +
        "model=stub-model drivers=implement -->\n\n# Talk\n\n\n",
    );

    const run = startPool({ poolDir, harnesses: {} });
    await run.settled;

    expect(["done", "quiescent", "stalled"]).toContain(run.phase);
    expect(run.final.tickets).toEqual({});
    expect(run.snapshots.length).toBeGreaterThan(0);
    expect(run.snapshots.at(-1)!.state.tickets).toEqual({});

    await run.shutdown(0);
  });

  it("still refuses a genuinely empty pool (no issues/ content, no conversations/ directory) with the original error", () => {
    const poolDir = mkdtempSync(join(tmpdir(), "conv-only-pool-empty-"));
    tempDirs.push(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    expect(() => startPool({ poolDir, harnesses: {} })).toThrow(/no Issue files/);
  });
});

describe("Conversation launch failure", () => {
  it("closes the tab when the TUI never becomes ready, so nothing is left open with no runtime to close it", async () => {
    // harness "claude" has a real descriptor (readyPattern "Claude Code v"),
    // so startConversation's readiness wait actually runs (unlike convo/
    // stub, which have none and skip it outright) — overridden here to run
    // `false`, a real binary that exits immediately, so the wrapper's exit-
    // code file appears almost at once and waitForReadiness returns
    // "exited" within one poll tick rather than running to its 60s
    // timeout.
    const poolDir = makeGitPool({
      tickets: [doneTicket("01")],
      config: { defaults: { harness: "claude", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { claude: () => ["false"] },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Doomed" });
      expect(view.status).toBe("crashed");
      // No runtime was ever registered for a crash-at-launch (it never
      // reaches session.conversations.set), so the view itself carries no
      // paneId; the spawned event (written before the readiness wait) is
      // the only record of which pane this was.
      const spawned = readEvents(join(poolDir, "runs"), view.id).find((e) => e.kind === "spawned");
      const paneId = spawned!.payload.pane_id as string;
      expect(typeof paneId).toBe("string");

      await waitFor(() => fake.panes.get(paneId)?.alive === false);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });
});

describe("Conversation boot reconciliation", () => {
  it("crashes a Conversation recorded live at boot", async () => {
    const poolDir = makePool({ tickets: [readyTicket("01")], config: stubConfig });
    const { harnesses } = stubHarness();
    const dir = join(poolDir, "conversations");
    writeConversation(dir, {
      id: "conv-1",
      file: join(dir, "conv-1.md"),
      title: "Left running",
      opening: "still going when the engine died",
      status: "live",
      harness: "claude",
      model: "opus",
      drivers: "implement",
    });

    const run = startPool({ poolDir, harnesses });
    // crashStaleLiveConversationsAtBoot runs synchronously before the drive
    // starts, so the record is already updated the moment startPool returns.
    const rec = readConversation(join(dir, "conv-1.md"));
    expect(rec.status).toBe("crashed");
    const events = readEvents(join(poolDir, "runs"), "conv-1");
    expect(events.some((e) => e.kind === "crash")).toBe(true);

    await run.shutdown(0);
  });
});
