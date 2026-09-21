import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { INTERACTIVE_PANE_READ_LINES } from "./pane-session.ts";
import { branchExists, branchFor, worktreePathFor } from "./worktrees.ts";
import {
  cleanupPools,
  makeGitPool,
  makePool,
  registerTempDir,
  stubHarness,
} from "./pool-fixture.ts";

afterEach(async () => {
  await cleanupPools();
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await Bun.sleep(20);
  }
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
  workspaceId: string | null;
  cwd: string;
  alive: boolean;
  buffer: string;
  booted: boolean;
  inputArea: string;
  swallow: boolean;
  proc?: ReturnType<typeof Bun.spawn>;
}

// What a pane shows before its wrapper runs: the shell's prompt, so the
// engine's shell-settle gate sees a shell that has drawn it.
const FAKE_SHELL_PROMPT = "$ ";

async function startFakeHerdr(options?: {
  // The shell-startup race (issue #102): the first N tabs swallow the
  // wrapper typed into them and sit at their prompt with `script` never run.
  swallowWrapper?: number;
}): Promise<{
  socketPath: string;
  requests: { method: string; params: Record<string, unknown> }[];
  close: () => Promise<void>;
  endPane: (paneId: string) => void;
  panes: Map<string, FakePane>;
}> {
  let minted = 0;
  let swallowRemaining = options?.swallowWrapper ?? 0;
  let mintedWorkspaces = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
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
      requests.push({ method: msg.method, params: msg.params });
      const respond = (result: unknown): void => {
        socket.end(JSON.stringify({ id: msg.id, result }) + "\n");
      };
      if (msg.method === "tab.create") {
        minted += 1;
        const workspaceId =
          typeof msg.params.workspace_id === "string" ? msg.params.workspace_id : null;
        const tabId = `tab-${minted}`;
        const paneId = `pane-${minted}`;
        panes.set(paneId, {
          tabId,
          workspaceId,
          cwd: String(msg.params.cwd ?? "/"),
          alive: true,
          buffer: "",
          booted: false,
          inputArea: "",
          swallow: swallowRemaining > 0,
        });
        swallowRemaining -= 1;
        // herdr protocol 20 answers with the root pane (issue #94); the
        // engine takes the pane id straight off it.
        respond({
          type: "tab_created",
          tab: { tab_id: tabId },
          root_pane: { pane_id: paneId, tab_id: tabId },
        });
      } else if (msg.method === "workspace.get") {
        // The Pool workspace (issue #94): this fake never loses one, so a
        // workspace it was asked about is one it holds.
        respond({ workspace: { workspace_id: String(msg.params.workspace_id ?? "") } });
      } else if (msg.method === "workspace.create") {
        mintedWorkspaces += 1;
        respond({ workspace: { workspace_id: `w${mintedWorkspaces}` } });
      } else if (msg.method === "pane.list") {
        respond({
          panes: [...panes.entries()]
            .filter(([, p]) => p.alive)
            .map(([id, p]) => ({ tab_id: p.tabId, pane_id: id, workspace_id: p.workspaceId })),
        });
      } else if (msg.method === "pane.read") {
        const pane = panes.get(String(msg.params.pane_id));
        const visible = pane
          ? pane.booted
            ? pane.inputArea
            : `${FAKE_SHELL_PROMPT}${pane.buffer}`
          : "";
        respond({ read: { text: visible, revision: 0, truncated: false } });
      } else if (msg.method === "pane.send_input") {
        const pane = panes.get(String(msg.params.pane_id));
        if (pane && !pane.booted && pane.swallow) {
          // The race: the shell was still starting, the wrapper is gone,
          // and the pane sits at its prompt as if nothing was typed.
          pane.swallow = false;
          respond({});
          return;
        }
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
                // "pipe", never written to or closed, so the `cat` harness
                // blocks reading instead of exiting at once on /dev/null's
                // EOF: this fake's pane must stay alive until a test ends
                // it, as notices.test.ts's does, rather than dying inside
                // the launch's own window and winning or losing a race
                // with the crash watch.
                stdin: "pipe",
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
  registerTempDir(dir);
  const socketPath = join(dir, "herdr.sock");
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    requests,
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
    registerTempDir(dir);
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
    registerTempDir(dir);
    expect(loadConversations(join(dir, "conversations"))).toEqual([]);
  });
});

describe("Conversation launch refusal", () => {
  it("refuses to start on a pool that is not terminal-backed", async () => {
    const poolDir = makePool({ tickets: [doneTicket("01")], config: stubConfig });
    const { harnesses } = stubHarness(poolDir, {});
    const run = startPool({ poolDir, harnesses });
    await expect(run.startConversation({ title: "A talk" })).rejects.toThrow(
      /not terminal-backed/,
    );
    await run.shutdown(0);
  });
});

describe("Conversation launch", () => {
  it("opens a named herdr tab and types the opening Turn, verified by echo", async () => {
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
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
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
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

describe("Conversation Turn-state reads (issue #122)", () => {
  it("the tick reads the viewport only and records it for the Peek; End forgets it", async () => {
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: convoHarnesses,
        herdrSocket: fake.socketPath,
        conversationPollMs: 20,
      });
      const view = await run.startConversation({ title: "Peek me" });
      const paneId = view.paneId!;
      await waitFor(() => run.paneRead(paneId) !== null);

      // The tick's reads are of the viewport and carry no line count: the
      // operator may be sitting in this pane, and a scrollback read moves
      // their viewport. The launch's own reads (shell settle, echo) keep
      // their `recent` read of a tab nobody is in yet.
      const reads = fake.requests.filter(
        (r) => r.method === "pane.read" && r.params.pane_id === paneId,
      );
      const visible = reads.filter((r) => r.params.source === "visible");
      expect(visible.length).toBeGreaterThan(0);
      for (const read of visible) {
        expect(read.params).toEqual({
          pane_id: paneId,
          source: "visible",
          format: "text",
          strip_ansi: true,
        });
      }
      for (const read of reads.filter((r) => r.params.source === "recent")) {
        expect(read.params.lines).toBe(INTERACTIVE_PANE_READ_LINES);
      }
      // What the register holds is the pane as the fake renders it once
      // booted (its input area, empty here), stamped with the read's time.
      expect(run.paneRead(paneId)).toEqual({ text: "", at: expect.any(String) });

      await run.endConversation(view.id);
      expect(run.paneRead(paneId)).toBeNull();

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });
});

describe("Conversation ending", () => {
  it("ends with no commits: worktree removed, status ended, no merge event", async () => {
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
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
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
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
    const { poolDir } = makeGitPool(
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
    registerTempDir(resolverStubPath);
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

    const { poolDir } = makeGitPool(
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
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
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
    registerTempDir(poolDir);
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
    registerTempDir(poolDir);
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    expect(() => startPool({ poolDir, harnesses: {} })).toThrow(/no Issue files/);
  });
});

describe("Conversation launch failure", () => {
  it("ends the Conversation with the harness's own code when it dies before its TUI, and closes the tab", async () => {
    // harness "claude" has a real descriptor (readyPattern "Claude Code v"),
    // so the launch's readiness wait actually runs (unlike convo/stub, which
    // have none and skip it outright), overridden here to run `false`, a real
    // binary that exits at once, so the wrapper's exit-code file appears
    // within one poll tick rather than the wait running to its 60s timeout.
    // ADR-0016: the harness's own code is the ending, at once. The launch
    // itself leaves the pane alone (ADR-0014's crashed-attempt rule), and
    // the Conversation, which nothing else could ever close, closes its own
    // tab the way a later crash does.
    const { poolDir } = makeGitPool({
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
      const rec = readConversation(join(poolDir, "conversations", `${view.id}.md`));
      expect(rec.status).toBe("crashed");
      // The spawned event (recorded before the readiness wait) names the
      // pane; the crash carries the harness's code and names it too.
      const events = readEvents(join(poolDir, "runs"), view.id);
      const spawned = events.find((e) => e.kind === "spawned")!;
      expect(typeof spawned.payload.pane_id).toBe("string");
      expect(typeof spawned.payload.commitSha).toBe("string");
      const crash = events.find((e) => e.kind === "crash")!;
      expect(crash.payload).toEqual({ code: 1, reason: "harness exited 1" });
      // The launch never went live, so there is nothing on the branch to
      // keep: the worktree and branch go (issue #102, ADR-0018's amendment).
      expect(branchExists(poolDir, view.id)).toBe(false);
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(false);
      // Nothing was typed into the shell the wrapper left behind; the launch
      // closed no pane, and the Conversation closed the tab once (the close
      // is fire-and-forget, so it lands a tick after the start returns).
      expect(fake.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(1);
      expect(fake.requests.some((r) => r.method === "pane.close")).toBe(false);
      const deadline = Date.now() + 2000;
      while (!fake.requests.some((r) => r.method === "tab.close") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(fake.requests.filter((r) => r.method === "tab.close")).toHaveLength(1);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  });
});

describe("Botched Conversation launch (issue #102)", () => {
  // The launch half in milliseconds: the fake's shell prompt is there at
  // once, and a wrapper that runs creates its Stream file within a tick.
  const launchCadence = {
    settlePollMs: 10,
    settleConfirmations: 2,
    settleTimeoutMs: 1_000,
    landedTimeoutMs: 1_500,
    landedPollMs: 20,
  };

  it("retries a launch whose command never ran into a fresh tab, and goes live there", async () => {
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    // The first tab swallows the wrapper (the shell-startup race, issue
    // #96): `script` never runs and no Stream file appears.
    const fake = await startFakeHerdr({ swallowWrapper: 1 });
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: convoHarnesses,
        herdrSocket: fake.socketPath,
        launchCadence,
      });
      const view = await run.startConversation({ title: "Second time lucky", opening: "hello" });
      expect(view.status).toBe("live");
      expect(view.paneId).toBe("pane-2");

      const events = readEvents(join(poolDir, "runs"), view.id);
      expect(events.map((e) => e.kind)).toEqual(["launch-retried", "spawned"]);
      expect(events[0].payload).toMatchObject({
        try: 1,
        pane_id: "pane-1",
        tab_id: "tab-1",
        reason: "launch command never ran",
      });
      // The spawned event names the tab the launch ended up in, so the
      // Conversation's later tab close never chases the botched one, which
      // the retry closed itself.
      expect(events[1].payload.tab_id).toBe("tab-2");
      const closes = fake.requests.filter((r) => r.method === "tab.close");
      expect(closes.map((r) => r.params.tab_id)).toEqual(["tab-1"]);
      expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(2);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);

  it("crashes a Conversation botched on every try and leaves no worktree or branch behind", async () => {
    const { poolDir } = makeGitPool({ tickets: [doneTicket("01")], config: convoConfig });
    const fake = await startFakeHerdr({ swallowWrapper: 3 });
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: convoHarnesses,
        herdrSocket: fake.socketPath,
        launchCadence,
      });
      const view = await run.startConversation({ title: "Never ran" });
      expect(view.status).toBe("crashed");

      // The record stays, crashed, so the trail is kept and the id is not
      // reused; the worktree and branch do not, since nothing ever ran in
      // them (issue #102).
      const file = join(poolDir, "conversations", `${view.id}.md`);
      expect(readConversation(file).status).toBe("crashed");
      expect(branchExists(poolDir, view.id)).toBe(false);
      expect(existsSync(worktreePathFor(poolDir, view.id))).toBe(false);

      const events = readEvents(join(poolDir, "runs"), view.id);
      expect(events.map((e) => e.kind)).toEqual([
        "launch-retried",
        "launch-retried",
        "spawned",
        "crash",
      ]);
      const crash = events.find((e) => e.kind === "crash")!;
      expect(crash.payload).toEqual({ code: -5, reason: "launch command never ran" });
      expect(fake.requests.filter((r) => r.method === "tab.create")).toHaveLength(3);
      // Nothing was ever typed beyond the three wrapper sends: no opening
      // Turn into a shell.
      expect(fake.requests.filter((r) => r.method === "pane.send_input")).toHaveLength(3);
      // The two botched tabs closed by the retry; the last by the crash
      // (fire-and-forget, so wait for them to land).
      const deadline = Date.now() + 2000;
      while (
        fake.requests.filter((r) => r.method === "tab.close").length < 3 &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(
        fake.requests.filter((r) => r.method === "tab.close").map((r) => r.params.tab_id),
      ).toEqual(["tab-1", "tab-2", "tab-3"]);
      // A next Conversation takes a fresh id: the crashed record holds its own.
      const next = await run.startConversation({ title: "After it" });
      expect(next.id).not.toBe(view.id);

      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);
});

describe("Conversation boot reconciliation", () => {
  it("crashes a Conversation recorded live at boot", async () => {
    const poolDir = makePool({ tickets: [readyTicket("01")], config: stubConfig });
    const { harnesses } = stubHarness(poolDir, {});
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
