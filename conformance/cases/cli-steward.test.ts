/**
 * The Steward's command (the inventory's `cli` rows from steward.test.ts's
 * "the Steward's command"), run as a process against a recording HTTP
 * endpoint in place of the Console: the command's contract is the request
 * each verb line sends, where it looks for the Console, and what it prints
 * and exits with for the answer it gets. What a real Console answers is the
 * `steward` area's, through its routes.
 */

import { expect } from "bun:test";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld } from "../harness/cli.ts";
import { freePort } from "../harness/server.ts";

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Endpoint {
  url: string;
  port: number;
  requests: Recorded[];
  /** What every request is answered with from now on. */
  answer(status: number, body: unknown): void;
  stop(): void;
}

/** A recording HTTP endpoint: every request kept, every one given the same answer. */
function endpoint(state: unknown): Endpoint {
  const requests: Recorded[] = [];
  let reply: { status: number; body: unknown } | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const path = `${url.pathname}${url.search}`;
      requests.push({ method: request.method, path, body: text === "" ? null : JSON.parse(text) });
      if (reply) return Response.json(reply.body, { status: reply.status });
      if (url.pathname === "/api/steward/state") return Response.json(state);
      return Response.json({ ok: true, message: `done ${url.pathname}` }, { status: 202 });
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port!,
    requests,
    answer(status, body) {
      reply = { status, body };
    },
    stop: () => server.stop(true),
  };
}

const STATE = {
  steward: "conv-1",
  budget: 5,
  mayClose: false,
  phase: "running",
  interrupts: [
    {
      ticketId: "01",
      title: "First",
      kind: "checkpoint",
      answerable: true,
      keepTalking: true,
      queued: false,
      note: "waiting on the operator",
      used: 1,
      remaining: 4,
    },
    {
      ticketId: "02",
      title: null,
      kind: "review",
      answerable: false,
      keepTalking: false,
      queued: true,
      note: null,
      used: 0,
      remaining: 5,
    },
  ],
  mergeQueue: [{ ticketId: "03", state: "merging" }],
  pendingSpawns: [{ id: "proposal-1", parentId: "01", title: "Follow up" }],
  heldSpawns: [{ id: "proposal-2", parentId: "02", title: "Held one", reason: "cap" }],
  ledger: "/p/runs/spawn-ledger.md",
};

const STATE_TEXT = [
  "Steward conv-1; budget 5 per Ticket; Close off (the operator's); pool running.",
  "Interrupts:",
  '  01 "First": checkpoint (pane alive, budget 4 of 5 left)',
  "    your note: waiting on the operator",
  "  02: review (not yours, answer queued)",
  "Merge queue: 03 merging.",
  'Pending spawns: proposal-1 (01) "Follow up".',
  'Held spawns: proposal-2 (02, cap) "Held one".',
  "Spawn ledger: /p/runs/spawn-ledger.md",
  "",
].join("\n");

/** The verb lines of the usage. Its first line names the command, which is the build's. */
const USAGE_VERBS = [
  "  answer <ticket> resume|approve|reject [note]",
  "  close <ticket> <note>   (only while the pool lets the Steward Close)",
  "  keep-talking <ticket> <message>",
  "  leave <ticket> <note>",
  "  held adopt|discard <proposal-id>",
  "  reassign <ticket> field=value...   (harness, model, effort, drivers, verify; field= clears)",
  "  state",
  "  end [closing line]",
  'A note, message or closing line of "-" is read from standard input.',
];

function expectUsage(stderr: string): void {
  const lines = stderr.trimEnd().split("\n");
  const at = lines.findIndex((line) => line.startsWith("usage: "));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(lines.slice(at + 1)).toEqual(USAGE_VERBS);
}

conformance("cli", "the steward command maps each verb onto its route, options anywhere and a note from stdin", async (t) => {
  const w = cliWorld(t);
  const console_ = endpoint(STATE);
  t.defer(() => console_.stop());
  const on = ["--pool", w.dir("pool"), "--url", console_.url, "--as", "conv-1"];
  const post = (path: string, body: Record<string, unknown>) => ({
    method: "POST",
    path,
    body: { conversation: "conv-1", ...body },
  });

  const good: { argv: string[]; stdin?: string; sent: Recorded; out: string }[] = [
    {
      argv: [...on, "answer", "01", "resume", "use", "plan", "B"],
      sent: post("/api/steward/answer", { ticketId: "01", action: "resume", note: "use plan B" }),
      out: "done /api/steward/answer\n",
    },
    {
      argv: [...on, "close", "01", "superseded", "by", "02"],
      sent: post("/api/steward/answer", { ticketId: "01", action: "close", note: "superseded by 02" }),
      out: "done /api/steward/answer\n",
    },
    {
      argv: [...on, "keep-talking", "01", "try", "again"],
      sent: post("/api/steward/keep-talking", { ticketId: "01", message: "try again" }),
      out: "done /api/steward/keep-talking\n",
    },
    {
      argv: [...on, "leave", "01", "-"],
      stdin: "  from stdin \n",
      sent: post("/api/steward/leave", { ticketId: "01", note: "from stdin" }),
      out: "done /api/steward/leave\n",
    },
    {
      argv: [...on, "held", "adopt", "proposal-2"],
      sent: post("/api/steward/held", { action: "adopt", id: "proposal-2" }),
      out: "done /api/steward/held\n",
    },
    {
      argv: [...on, "reassign", "01", "model=big", "effort=", "verify=2"],
      sent: post("/api/steward/reassign", { tickets: ["01"], fields: { model: "big", effort: null, verify: 2 } }),
      out: "done /api/steward/reassign\n",
    },
    {
      argv: [...on, "state"],
      sent: { method: "GET", path: "/api/steward/state?conversation=conv-1", body: null },
      out: STATE_TEXT,
    },
    {
      argv: [...on, "end", "all", "done"],
      sent: post("/api/steward/end", { closing: "all done" }),
      out: "done /api/steward/end\n",
    },
    {
      // Options anywhere on the line, the verb's words between them.
      argv: ["--url", console_.url, "answer", "01", "approve", "--as", "conv-1", "looks", "right"],
      sent: post("/api/steward/answer", { ticketId: "01", action: "approve", note: "looks right" }),
      out: "done /api/steward/answer\n",
    },
  ];
  for (const line of good) {
    const before = console_.requests.length;
    const run = await w.run("steward", line.argv, line.stdin !== undefined ? { stdin: line.stdin } : {});
    expect({ argv: line.argv, code: run.code, stdout: run.stdout, stderr: run.stderr }).toEqual({
      argv: line.argv,
      code: 0,
      stdout: line.out,
      stderr: "",
    });
    expect(console_.requests.slice(before)).toEqual([line.sent]);
  }

  const bad: [string[], string][] = [
    [["reassign", "01", "verify=abc"], "steward: reassign: verify=abc is not a whole number"],
    [["answer", "01", "adopt", "2"], "steward: answer <ticket> resume|approve|reject [note]"],
    [["close", "01"], "steward: close <ticket> <note>"],
    [["answer", "01", "close", "x"], "steward: answer <ticket> resume|approve|reject [note]"],
    [["answer", "01", "maybe"], "steward: answer <ticket> resume|approve|reject [note]"],
    [["dance"], "steward: unknown verb 'dance'"],
  ];
  const sent = console_.requests.length;
  for (const [words, message] of bad) {
    const run = await w.run("steward", [...on, ...words]);
    expect({ words, code: run.code, first: run.stderr.split("\n")[0] }).toEqual({ words, code: 2, first: message });
    expectUsage(run.stderr);
  }
  expect(console_.requests).toHaveLength(sent);
});

conformance("cli", "the steward command finds the Console by pool directory when nothing answers at --url", async (t) => {
  const w = cliWorld(t);
  const console_ = endpoint(STATE);
  t.defer(() => console_.stop());
  const pool = w.dir("pool");
  w.write(
    join("home", ".agent-graphs", "pools.json"),
    JSON.stringify([{ poolDir: pool, port: console_.port, pid: w.liveProcess().pid, startedAt: "2026-10-03T00:00:00.000Z" }]),
  );
  const dead = `http://localhost:${await freePort()}`;

  console_.answer(202, { ok: true, message: "answered 01: resume" });
  const found = await w.run("steward", ["--pool", pool, "--url", dead, "--as", "conv-1", "answer", "01", "resume"]);
  expect(found.code).toBe(0);
  expect(found.stdout).toBe("answered 01: resume\n");
  expect(console_.requests).toEqual([
    {
      method: "POST",
      path: "/api/steward/answer",
      body: { conversation: "conv-1", ticketId: "01", action: "resume" },
    },
  ]);

  console_.answer(409, { reason: "steward: the Steward budget on ticket 01 is spent" });
  const spent = await w.run("steward", ["--url", console_.url, "--as", "conv-1", "answer", "01", "resume"]);
  expect(spent.code).toBe(1);
  expect(spent.stdout).toBe("");
  expect(spent.stderr).toBe("steward: the Steward budget on ticket 01 is spent\n");
});

// A gap the inventory lists for `cli` (Visible behaviour no test covers yet).

conformance("cli", "the steward command refuses a line it cannot send, and says when no Console answers", async (t) => {
  const w = cliWorld(t);
  const pool = w.dir("pool");
  const quiet = await freePort();

  const noAs = await w.run("steward", ["--pool", pool, "state"]);
  expect(noAs.code).toBe(2);
  expect(noAs.stderr.startsWith("usage: ")).toBe(true);
  expectUsage(noAs.stderr);

  const held = await w.run("steward", ["--pool", pool, "--as", "conv-1", "held", "keep", "x"]);
  expect(held.code).toBe(2);
  expect(held.stderr.split("\n")[0]).toBe("steward: held adopt|discard <proposal-id>");
  expectUsage(held.stderr);

  const reassign = await w.run("steward", ["--pool", pool, "--as", "conv-1", "reassign", "01", "model"]);
  expect(reassign.code).toBe(2);
  expect(reassign.stderr.split("\n")[0]).toBe("steward: reassign: 'model' is not field=value");
  expectUsage(reassign.stderr);

  const unregistered = await w.run("steward", ["--pool", pool, "--as", "conv-1", "state"]);
  expect(unregistered.code).toBe(1);
  expect(unregistered.stderr).toBe(`steward: no live Console found for pool ${pool}\n`);

  const silent = await w.run("steward", ["--url", `http://localhost:${quiet}/`, "--as", "conv-1", "state"]);
  expect(silent.code).toBe(1);
  expect(silent.stderr.startsWith(`steward: the Console did not answer (http://localhost:${quiet}: `)).toBe(true);
});
