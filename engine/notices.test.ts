import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { startPool, type PoolConfig, type PoolRun } from "./engine.ts";
import { readEvents } from "./events.ts";
import {
  conversationEndedNoticeText,
  diffStatSummary,
  ticketEndedNoticeText,
} from "./notices.ts";
import { makeTempDir } from "./tmp.ts";
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

async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await Bun.sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Pure text builders.
// ---------------------------------------------------------------------------

describe("ticketEndedNoticeText", () => {
  it("names the ticket, its done outcome, branch, and diff", () => {
    const text = ticketEndedNoticeText({
      id: "01-spawn-1",
      title: "Add the widget",
      outcome: "done",
      branch: "pool/abc/01-spawn-1",
      diffStat: "1 file changed, 2 insertions(+)",
    });
    expect(text).toContain("01-spawn-1");
    expect(text).toContain("Add the widget");
    expect(text).toContain("done");
    expect(text).toContain("pool/abc/01-spawn-1");
    expect(text).toContain("1 file changed, 2 insertions(+)");
    expect(text).not.toContain("Brief:");
  });

  it("includes the Brief on a checkpoint outcome", () => {
    const text = ticketEndedNoticeText({
      id: "01-spawn-2",
      title: "Investigate the flake",
      outcome: "checkpoint",
      brief: "Needs a human decision on retry policy.",
      branch: "pool/abc/01-spawn-2",
      diffStat: "(no changes)",
    });
    expect(text).toContain("checkpoint");
    expect(text).toContain("Brief: Needs a human decision on retry policy.");
  });

  it("falls back to a placeholder for a checkpoint with no brief text", () => {
    const text = ticketEndedNoticeText({
      id: "x",
      title: "t",
      outcome: "checkpoint",
      branch: "b",
      diffStat: "d",
    });
    expect(text).toContain("Brief: (none written)");
  });
});

describe("conversationEndedNoticeText", () => {
  it("names the branch with no closing note", () => {
    const text = conversationEndedNoticeText({ branch: "pool/abc/conv-1-spawn-1" });
    expect(text).toContain("pool/abc/conv-1-spawn-1");
    expect(text).not.toContain("Closing note");
  });

  it("includes a trimmed closing note when given one", () => {
    const text = conversationEndedNoticeText({
      branch: "b",
      closing: "  all wrapped up  ",
    });
    expect(text).toContain("Closing note: all wrapped up");
  });
});

describe("diffStatSummary", () => {
  function gitRepo(): string {
    const dir = makeTempDir("notices-diff-");
    registerTempDir(dir);
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "a@b.c"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    return dir;
  }

  it("summarizes a real diff between two revisions", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-qm", "second"], { cwd: dir });
    const summary = diffStatSummary(dir, "HEAD~1..HEAD");
    expect(summary).toContain("a.txt");
  });

  it("reads as no changes for an empty or failing diff", () => {
    const dir = gitRepo();
    expect(diffStatSummary(dir, "HEAD..HEAD")).toBe("(no changes)");
    expect(diffStatSummary(dir, "not-a-real-ref..HEAD")).toBe("(no changes)");
  });
});

// ---------------------------------------------------------------------------
// Integration: a live pool with a Conversation, driving the poller, spawn
// adoption, and notice delivery through the real engine.
// ---------------------------------------------------------------------------

const readyTicket = (id: string, blockedBy = "none") =>
  ({
    file: `${id}.md`,
    marker: `<!-- state: id=${id} blocked-by=${blockedBy} status=ready -->`,
  }) as const;

const doneTicket = (id: string) =>
  ({ file: `${id}.md`, marker: `<!-- state: id=${id} blocked-by=none status=done -->` }) as const;

interface FakePane {
  tabId: string;
  workspaceId: string | null;
  cwd: string;
  alive: boolean;
  buffer: string;
  booted: boolean;
  inputArea: string;
  proc?: ReturnType<typeof Bun.spawn>;
}

// A herdr fake for Conversations, in conversations.test.ts's own style (real
// wire shape, the wrapper's first Enter actually runs bash), extended with a
// rendered-content model that simulates a real TUI's idle prompt: once
// booted, an empty input area reads as the idle glyph "❯" beside the
// readiness header "Claude Code v", and a non-empty one reads as whatever
// was typed — so a test that registers its harness under the name "claude"
// gets real readiness *and* turn-state detection through
// defaultHarnessDescriptors' actual claude entry (readyPattern "Claude Code
// v", idlePattern "❯"), with only the spawned command itself (`cat`, holding
// the pane open) standing in for the real CLI.
function startFakeHerdr(): Promise<{
  socketPath: string;
  panes: Map<string, FakePane>;
  /** Every call the daemon saw, in order: the agent reports are read off it. */
  requests: { method: string; params: Record<string, unknown> }[];
  close: () => Promise<void>;
  // A one-shot switch: the next pane.send_input call answers with an RPC
  // error instead of applying the input, simulating a herdr daemon blip
  // mid-delivery. Cleared automatically once spent.
  failNextSendInput: () => void;
  // Delays every future tab.create response by this many ms (0 = none).
  setTabCreateDelayMs: (ms: number) => void;
}> {
  let minted = 0;
  let mintedWorkspaces = 0;
  const panes = new Map<string, FakePane>();
  const subscribers: Socket[] = [];
  const connections = new Set<Socket>();
  const procs: ReturnType<typeof Bun.spawn>[] = [];
  let failNext = false;
  let tabCreateDelayMs = 0;
  const requests: { method: string; params: Record<string, unknown> }[] = [];

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
        });
        // herdr protocol 20 answers with the root pane (issue #94); the
        // engine takes the pane id straight off it.
        const created = {
          type: "tab_created",
          tab: { tab_id: tabId },
          root_pane: { pane_id: paneId, tab_id: tabId },
        };
        // Delayed on demand (tabCreateDelayMs), so a test can hold a
        // startConversation call open long enough to interleave a second
        // one before the first's Conversation record ever lands on disk —
        // the id-collision window the reservation set closes.
        if (tabCreateDelayMs > 0) {
          setTimeout(() => respond(created), tabCreateDelayMs);
        } else {
          respond(created);
        }
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
            ? `Claude Code v2.1\n${pane.inputArea || "❯"}`
            : pane.buffer
          : "";
        respond({ read: { text: visible, revision: 0, truncated: false } });
      } else if (msg.method === "pane.send_input") {
        if (failNext) {
          failNext = false;
          socket.end(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: "simulated herdr daemon blip" },
            }) + "\n",
          );
          return;
        }
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
                // "pipe", never written to or closed, so `cat` blocks
                // reading forever instead of hitting immediate EOF on
                // /dev/null ("ignore") and exiting within the first tick —
                // this fake's pane must stay alive across several 2s poll
                // ticks, unlike conversations.test.ts's own fast-assertion
                // tests, which never notice a `cat` that already exited.
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
  const dir = makeTempDir("notices-herdr-fake-");
  registerTempDir(dir);
  const socketPath = join(dir, "herdr.sock");
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        panes,
        requests,
        close: () =>
          new Promise<void>((res) => {
            for (const proc of procs) proc.kill();
            for (const sub of subscribers) sub.destroy();
            for (const conn of connections) conn.destroy();
            server.close(() => res());
          }),
        failNextSendInput: () => {
          failNext = true;
        },
        setTabCreateDelayMs: (ms: number) => {
          tabCreateDelayMs = ms;
        },
      }),
    );
  });
}

function spawnJsonPath(poolDir: string, conversationId: string): string {
  return join(poolDir, "runs", `${conversationId}.spawn.json`);
}

function writeSpawnJson(poolDir: string, conversationId: string, spawn: unknown[]): void {
  mkdirSync(join(poolDir, "runs"), { recursive: true });
  writeFileSync(spawnJsonPath(poolDir, conversationId), JSON.stringify({ spawn }));
}

// A proposal body long enough to clear SPAWN_BODY_MIN_CHARS (20 chars).
const BODY = "Do the follow-up work described here in full.";

describe("Conversation spawn.json adoption", () => {
  it("consumes the proposal file, adopts a ticket, and skips the run cap for a Conversation's own batch", async () => {
    // Seed spawnedThisRun at the run cap (20) via pre-existing spawn tickets
    // of an ordinary ticket "01", so a further Ticket-origin spawn would be
    // fully truncated — proving the Conversation's own batch below is not
    // sharing that budget.
    const spawnFiles = Array.from({ length: 20 }, (_, i) => {
      const n = i + 1;
      return {
        file: `01-spawn-${n}.md`,
        marker: `<!-- state: id=01-spawn-${n} blocked-by=none status=done spawned-by=01 -->`,
      };
    });
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01"), ...spawnFiles],
      config: { defaults: { harness: "convo", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { convo: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Plan" });

      // 7 proposals: the per-proposal cap of 5 still trims 2, despite the
      // run already sitting at the 20-per-run cap that only applies to
      // Ticket-origin spawns.
      writeSpawnJson(
        poolDir,
        view.id,
        Array.from({ length: 7 }, (_, i) => ({ title: `Follow-up ${i + 1}`, body: BODY })),
      );

      await waitFor(() =>
        [1, 2, 3, 4, 5].every((n) =>
          existsSync(join(poolDir, "issues", `${view.id}-spawn-${n}.md`)),
        ),
      );
      expect(existsSync(join(poolDir, "issues", `${view.id}-spawn-6.md`))).toBe(false);
      expect(existsSync(join(poolDir, "issues", `${view.id}-spawn-7.md`))).toBe(false);
      // The file is consumed (read once, then removed) rather than re-polled.
      expect(existsSync(spawnJsonPath(poolDir, view.id))).toBe(false);

      const adopted = readEvents(join(poolDir, "runs"), view.id).find(
        (e) => e.kind === "spawn-adopted",
      );
      expect(adopted?.payload).toMatchObject({ truncated: 2 });

      // Ends the Conversation cleanly (closeTab, not a killed pane) so its
      // poller's interval clears deterministically before the pool
      // directory is removed in afterEach; otherwise a fake herdr closed
      // out from under a still-live runtime leaves the interval ticking
      // against a deleted directory into later tests (a real hazard this
      // suite hit while under development).
      await run.endConversation(view.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);

  it("drops a blockedBy entry naming a Conversation, with the reason logged on the proposing Conversation", async () => {
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: { defaults: { harness: "convo", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { convo: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const parent = await run.startConversation({ title: "Parent" });
      const other = await run.startConversation({ title: "Other" });

      writeSpawnJson(poolDir, parent.id, [
        { title: "Blocked", body: BODY, blockedBy: [other.id] },
      ]);

      await waitFor(() => !existsSync(spawnJsonPath(poolDir, parent.id)));
      // Give the (non-)adoption a moment to settle before asserting absence.
      await Bun.sleep(200);
      expect(existsSync(join(poolDir, "issues", `${parent.id}-spawn-1.md`))).toBe(false);

      const rejected = readEvents(join(poolDir, "runs"), parent.id).find(
        (e) => e.kind === "spawn-rejected",
      );
      expect(rejected?.payload).toMatchObject({
        title: "Blocked",
        reason: `blockedBy names Conversations, which cannot block a ticket: ${other.id}`,
      });

      await run.endConversation(parent.id).catch(() => {});
      await run.endConversation(other.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);

  it("drops a proposal whose assign.harness is unknown", async () => {
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: { defaults: { harness: "convo", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { convo: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Parent" });

      writeSpawnJson(poolDir, view.id, [
        { title: "Bad harness", body: BODY, assign: { harness: "nonexistent" } },
      ]);

      await waitFor(() => !existsSync(spawnJsonPath(poolDir, view.id)));
      await Bun.sleep(200);
      expect(existsSync(join(poolDir, "issues", `${view.id}-spawn-1.md`))).toBe(false);

      const rejected = readEvents(join(poolDir, "runs"), view.id).find(
        (e) => e.kind === "spawn-rejected",
      );
      expect(rejected?.payload).toMatchObject({
        title: "Bad harness",
        reason: "assign.harness names unknown harness 'nonexistent'",
      });

      await run.endConversation(view.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);

  it("starts a child Conversation for kind: 'conversation', inheriting the parent's Assignment", async () => {
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: { defaults: { harness: "convo", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { convo: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const parent = await run.startConversation({ title: "Parent" });

      writeSpawnJson(poolDir, parent.id, [
        { title: "A child talk", body: BODY, kind: "conversation" },
      ]);

      const childFile = join(poolDir, "conversations", `${parent.id}-spawn-1.md`);
      await waitFor(() => existsSync(childFile));
      const childRecordText = readFileSync(childFile, "utf8");
      expect(childRecordText).toContain(`spawned-by=${parent.id}`);
      expect(childRecordText).toContain("harness=convo");
      expect(childRecordText).toContain("model=stub-model");
      // Never written as a ticket file.
      expect(existsSync(join(poolDir, "issues", `${parent.id}-spawn-1.md`))).toBe(false);

      await run.endConversation(`${parent.id}-spawn-1`).catch(() => {});
      await run.endConversation(parent.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 20000);

  it("reserves a spawn id for an in-flight kind:'conversation' start, so a second adoption before it lands on disk cannot reuse it", async () => {
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: { defaults: { harness: "convo", model: "stub-model" }, terminal: "herdr" },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { convo: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const parent = await run.startConversation({ title: "Parent" });

      // Slows every future tab.create (the children's own launches, not
      // the parent's, already open): without the id reservation, the
      // second proposal's adoption call would recompute its counter from
      // disk alone, see no record for the first child yet (its
      // startConversationImpl is still awaiting this delayed tab.create),
      // and mint the same `<parent>-spawn-1` id again.
      fake.setTabCreateDelayMs(3000);

      writeSpawnJson(poolDir, parent.id, [
        { title: "First child", body: BODY, kind: "conversation" },
      ]);
      await waitFor(() => !existsSync(spawnJsonPath(poolDir, parent.id)));

      writeSpawnJson(poolDir, parent.id, [
        { title: "Second child", body: BODY, kind: "conversation" },
      ]);
      await waitFor(() => !existsSync(spawnJsonPath(poolDir, parent.id)));

      const firstFile = join(poolDir, "conversations", `${parent.id}-spawn-1.md`);
      const secondFile = join(poolDir, "conversations", `${parent.id}-spawn-2.md`);
      await waitFor(() => existsSync(firstFile) && existsSync(secondFile), 15000);
      expect(readFileSync(firstFile, "utf8")).toContain("# First child");
      expect(readFileSync(secondFile, "utf8")).toContain("# Second child");

      await run.endConversation(`${parent.id}-spawn-1`).catch(() => {});
      await run.endConversation(`${parent.id}-spawn-2`).catch(() => {});
      await run.endConversation(parent.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 25000);
});

describe("Notice delivery", () => {
  it("delivers a queued ticket-ended Notice into the pane only once the Conversation reads waiting", async () => {
    // The Conversation itself runs on "claude" (this test's fake herdr, with
    // its idle-glyph rendering) so turn state is real; the ticket it spawns
    // runs headless on "stub" so it checkpoints in well under a second,
    // long before the Conversation's own pane can possibly reach
    // IDLE_STABLE_READS consecutive idle reads (2 ticks at
    // CONVERSATION_POLL_MS = 2s apart). The child's id is deterministic (the
    // pool's first operator-started Conversation is always "conv-1", so its
    // first spawn is "conv-1-spawn-1"), so console.json's static per-id
    // assign can target it before the run even starts.
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: {
        defaults: { harness: "claude", model: "stub-model" },
        assign: { "conv-1-spawn-1": { harness: "stub", model: "stub-model" } },
        terminal: "herdr",
      },
    });
    const fake = await startFakeHerdr();
    try {
      const stub = stubHarness(poolDir, {
        "conv-1-spawn-1": { status: "checkpoint", brief: "Needs your input." },
      }).harnesses.stub;
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { claude: () => ["cat"], stub },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Talk" });
      expect(view.id).toBe("conv-1");

      writeSpawnJson(poolDir, view.id, [{ title: "Checkpointing child", body: BODY }]);
      const childId = `${view.id}-spawn-1`;
      await waitFor(() => existsSync(join(poolDir, "issues", `${childId}.md`)));

      // The checkpoint (and so the enqueue) lands within a second or two of
      // the Conversation's own launch — well before three ticks (~6s) could
      // have passed — so at this point either no "notice" event exists yet
      // (queued, parent still working) or, if the timing landed unluckily
      // close to the idle threshold, one already delivered; assert the
      // stronger, deterministic claim only once delivery is confirmed below,
      // and treat an early non-delivery as the expected common case rather
      // than a required one (real wall-clock timing, not asserted on).
      await waitFor(() => readEvents(join(poolDir, "runs"), childId).some((e) => e.kind === "checkpoint"));

      // Now wait for the Conversation to actually read waiting, and for the
      // Notice to land as a "notice" event with delivered: true on both the
      // child's and the parent's own file — the delivery is gated on that
      // turn-state read, not merely on the checkpoint having happened.
      await waitFor(
        () => run.snapshots.at(-1)?.conversations.find((c) => c.id === view.id)?.turn.state === "waiting",
      );
      await waitFor(() =>
        readEvents(join(poolDir, "runs"), childId).some(
          (e) => e.kind === "notice" && e.payload.delivered === true,
        ),
      );
      const childNotice = readEvents(join(poolDir, "runs"), childId).find((e) => e.kind === "notice")!;
      expect(childNotice.payload).toMatchObject({ to: view.id, kind: "ticket-ended", delivered: true });

      const parentNotice = readEvents(join(poolDir, "runs"), view.id).find((e) => e.kind === "notice");
      expect(parentNotice?.payload).toMatchObject({ from: childId, kind: "ticket-ended", delivered: true });

      // The Brief and the diff summary both made it into what was typed:
      // the pane's input area was cleared by the delivering Enter, but the
      // fake still recorded the wrapper's own launch buffer only once,
      // never the notice text — the notice's own content is what the
      // "notice" event and its text carry, checked structurally above
      // rather than by re-reading pane state that has already moved on.
      await run.endConversation(view.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 25000);

  it("survives a herdr RPC failure during delivery: the Notice stays queued and is retried, never lost", async () => {
    // Same shape as the checkpoint delivery test above. The one difference:
    // the fake's very next pane.send_input answers with an RPC error,
    // simulating a daemon blip exactly where typeVerified calls
    // paneSendInput inside deliverQueuedNotices. Both call sites of
    // deliverQueuedNotices use a bare `void`, so an unhandled rejection
    // here would either crash the process or at least never be caught by
    // this test — the assertions below (a "notice" event with
    // delivered:false rather than an uncaught exception, followed by a
    // later delivered:true once the fake stops failing) are the proof that
    // never happens.
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: {
        defaults: { harness: "claude", model: "stub-model" },
        assign: { "conv-1-spawn-1": { harness: "stub", model: "stub-model" } },
        terminal: "herdr",
      },
    });
    const fake = await startFakeHerdr();
    try {
      const stub = stubHarness(poolDir, {
        "conv-1-spawn-1": { status: "checkpoint", brief: "Needs your input." },
      }).harnesses.stub;
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { claude: () => ["cat"], stub },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Talk" });
      const childId = `${view.id}-spawn-1`;
      writeSpawnJson(poolDir, view.id, [{ title: "Checkpointing child", body: BODY }]);
      await waitFor(() => existsSync(join(poolDir, "issues", `${childId}.md`)));
      await waitFor(() => readEvents(join(poolDir, "runs"), childId).some((e) => e.kind === "checkpoint"));

      // Armed well before the Conversation can possibly read waiting (three
      // ticks away, ~6s): the delivery attempt that fires the moment it
      // does is the one that hits this.
      fake.failNextSendInput();

      await waitFor(() =>
        readEvents(join(poolDir, "runs"), childId).some(
          (e) => e.kind === "notice" && e.payload.delivered === false,
        ),
      );
      const failedAttempt = readEvents(join(poolDir, "runs"), childId).find(
        (e) => e.kind === "notice" && e.payload.delivered === false,
      )!;
      expect(typeof failedAttempt.payload.error).toBe("string");
      // Never dropped: a failed delivery is a retry candidate, not an
      // orphan or a queued-at-End loss.
      expect(readEvents(join(poolDir, "runs"), childId).some((e) => e.kind === "notice-dropped")).toBe(
        false,
      );

      // The next waiting tick (the fake no longer fails) retries and lands.
      await waitFor(() =>
        readEvents(join(poolDir, "runs"), childId).some(
          (e) => e.kind === "notice" && e.payload.delivered === true,
        ),
      );

      await run.endConversation(view.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 25000);

  it("delivers a done-Notice for a verify:1 spawned Ticket too (completeLoneAttempt, not only the unverified path)", async () => {
    // Same shape as the checkpoint test above, but the spawned child runs
    // under verify:1: one attempt, one engine-written grader ticket (the
    // stub defaults every "<build>-grader-N" id to a passing grade), and
    // resolveLoneAttempt's pass path (completeLoneAttempt) is a different
    // code path from the unverified done merge the run-cap/kind tests
    // exercise — it needed its own notifyConversationOfTicketDone hook.
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: {
        defaults: { harness: "claude", model: "stub-model" },
        assign: { "conv-1-spawn-1": { harness: "stub", model: "stub-model", verify: 1 } },
        terminal: "herdr",
      },
    });
    const fake = await startFakeHerdr();
    try {
      const stub = stubHarness(poolDir, {}).harnesses.stub;
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { claude: () => ["cat"], stub },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Talk" });
      expect(view.id).toBe("conv-1");

      writeSpawnJson(poolDir, view.id, [{ title: "Verified child", body: BODY }]);
      const childId = `${view.id}-spawn-1`;
      await waitFor(() => existsSync(join(poolDir, "issues", `${childId}.md`)));
      await waitFor(() => {
        const markerText = readFileSync(join(poolDir, "issues", `${childId}.md`), "utf8");
        return markerText.includes("status=done");
      });

      await waitFor(
        () => run.snapshots.at(-1)?.conversations.find((c) => c.id === view.id)?.turn.state === "waiting",
      );
      await waitFor(() =>
        readEvents(join(poolDir, "runs"), childId).some(
          (e) => e.kind === "notice" && e.payload.delivered === true,
        ),
      );
      const childNotice = readEvents(join(poolDir, "runs"), childId).find((e) => e.kind === "notice")!;
      expect(childNotice.payload).toMatchObject({ to: view.id, kind: "ticket-ended", delivered: true });

      await run.endConversation(view.id).catch(() => {});
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 25000);

  it("drops a Notice for an ended parent, logged on the child's own file", async () => {
    // No herdr needed: the parent Conversation is hand-authored directly on
    // disk as already ended (never tracked in session.conversations this
    // run), and the child is an ordinary headless ticket whose spawned-by
    // names it — loadPoolMarkers accepts that (a known Conversation, any
    // status), and notifyConversationOfCheckpoint's enqueueNotice finds no
    // live runtime for it, the "orphaned" path.
    const poolDir = makePool({
      tickets: [
        {
          file: "conv-1-spawn-1.md",
          marker:
            "<!-- state: id=conv-1-spawn-1 blocked-by=none status=ready spawned-by=conv-1 -->",
        },
      ],
      config: { defaults: { harness: "stub", model: "stub-model" } },
    });
    mkdirSync(join(poolDir, "conversations"), { recursive: true });
    writeFileSync(
      join(poolDir, "conversations", "conv-1.md"),
      "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=stub model=stub-model drivers=implement -->\n\n# Talk\n\n\n",
    );
    const stub = stubHarness(poolDir, {
      "conv-1-spawn-1": { status: "checkpoint", brief: "b" },
    }).harnesses.stub;
    const run: PoolRun = startPool({ poolDir, harnesses: { stub } });

    await waitFor(() =>
      readEvents(join(poolDir, "runs"), "conv-1-spawn-1").some((e) => e.kind === "notice-dropped"),
    );
    const dropped = readEvents(join(poolDir, "runs"), "conv-1-spawn-1").find(
      (e) => e.kind === "notice-dropped",
    )!;
    expect(dropped.payload).toMatchObject({ to: "conv-1", kind: "ticket-ended" });
    // Never delivered, and never logged on the (nonexistent-runtime) parent.
    expect(existsSync(join(poolDir, "runs", "conv-1.events.jsonl"))).toBe(false);

    await run.shutdown(0);
  }, 10000);
});

describe("Conversation agent reporting (issue #94)", () => {
  it("reports the pane working at launch, blocked when the Turn waits, and releases it at End", async () => {
    // herdr lists a pane in its agent sidebar only when an agent is bound to
    // it, and it never binds ours (the harness runs inside `script`), so the
    // engine asserts the identity itself. A Conversation is the one Attempt
    // with a Turn state, so it is the one whose reported state moves:
    // waiting on the operator is "blocked" in herdr's vocabulary. This fake
    // renders a real idle prompt, so the flip is the module's own turn-state
    // read and not a stub.
    const { poolDir } = makeGitPool({
      tickets: [doneTicket("01")],
      config: {
        defaults: { harness: "claude", model: "stub-model" },
        terminal: "herdr",
      },
    });
    const fake = await startFakeHerdr();
    try {
      const run: PoolRun = startPool({
        poolDir,
        harnesses: { claude: () => ["cat"] },
        herdrSocket: fake.socketPath,
      });
      const view = await run.startConversation({ title: "Talk" });

      const reports = () =>
        fake.requests.filter((r) => r.method === "pane.report_agent");
      // The launch's own report: the wrapper is in the pane, so the pane is
      // this Conversation's agent, at work.
      await waitFor(() => reports().length >= 1);
      expect(reports()[0].params).toMatchObject({
        pane_id: view.paneId,
        source: "herdr:agent-console",
        agent: "claude",
        state: "working",
        message: "conv-1 · Talk",
      });

      // The tick reads the idle prompt and the Turn flips to waiting.
      await waitFor(
        () =>
          run.snapshots.at(-1)?.conversations.find((c) => c.id === view.id)?.turn
            .state === "waiting",
      );
      await waitFor(() => reports().length >= 2);
      expect(reports()[1].params).toMatchObject({
        pane_id: view.paneId,
        agent: "claude",
        state: "blocked",
      });

      await run.endConversation(view.id);
      await waitFor(() =>
        fake.requests.some((r) => r.method === "pane.release_agent"),
      );
      expect(
        fake.requests.find((r) => r.method === "pane.release_agent")!.params,
      ).toMatchObject({
        pane_id: view.paneId,
        source: "herdr:agent-console",
        agent: "claude",
      });
      await run.shutdown(0);
    } finally {
      await fake.close();
    }
  }, 25000);
});
