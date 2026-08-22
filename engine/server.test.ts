/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPoolServer,
  type PoolServer,
} from "./server.ts";
import { REVIEW_TICKET_ID, type HarnessCommand, type PoolConfig } from "./engine.ts";

const servers: PoolServer[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    void server.close();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makePool(tickets: { file: string; marker: string }[]): string {
  const poolDir = mkdtempSync(join(tmpdir(), "pool-server-"));
  tempDirs.push(poolDir);
  mkdirSync(join(poolDir, "issues"), { recursive: true });
  for (const ticket of tickets) {
    writeFileSync(join(poolDir, "issues", ticket.file), `${ticket.marker}\n\n# body\n`);
  }
  writeFileSync(
    join(poolDir, "console.json"),
    JSON.stringify({ defaults: { harness: "stub", model: "m" } } satisfies PoolConfig, null, 2),
  );
  return poolDir;
}

function stubHarness(behaviour: Record<string, ("done" | "checkpoint")[]>): Record<string, HarnessCommand> {
  const poolLocal = tempDirs[tempDirs.length - 1];
  const stubPath = join(poolLocal, "stub-harness.sh");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      'issue="$1"; status="$2"',
      'sed -i "1s/status=[a-z-]*/status=$status/" "$issue"',
      'printf \'{"summary":"smoke","commitSha":null}\' > "$3"',
      "exit 0",
      "",
    ].join("\n"),
  );
  const counts: Record<string, number> = {};
  const harness: HarnessCommand = (ctx) => {
    const statuses = behaviour[ctx.id] ?? ["done"];
    const n = counts[ctx.id] ?? 0;
    counts[ctx.id] = n + 1;
    const status = statuses[Math.min(n, statuses.length - 1)];
    return ["bash", stubPath, ctx.issuePath, status, ctx.outcomePath];
  };
  return { stub: harness };
}

async function startServer(poolDir: string, harnesses: Record<string, HarnessCommand>): Promise<PoolServer> {
  const server = createPoolServer({ poolDir, port: 0, harnesses, distDir: "/nonexistent" });
  servers.push(server);
  return server;
}

describe("pool server", () => {
  it("drives a pool to the review gate and serves the enriched state", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    const snapshot = await server.start();
    expect(snapshot.phase).toBe("quiescent");
    expect(snapshot.state.interrupts.map((i) => i.kind)).toEqual(["review"]);
    const statuses = Object.fromEntries(snapshot.state.tickets.map((t) => [t.id, t.status]));
    expect(statuses).toEqual({ "01": "done", "02": "done" });
    expect(snapshot.state.tickets.map((t) => t.blockedBy)).toEqual([[], ["01"]]);
    expect(snapshot.state.tickets.map((t) => t.title)).toEqual(["body", "body"]);

    // Approving the review ends the run; the server stays up with the final
    // state inspectable.
    const approved = await server.answer(REVIEW_TICKET_ID, "approve");
    expect(approved.phase).toBe("done");
    expect(approved.state.interrupts).toEqual([]);
    expect(server.latest?.phase).toBe("done");
  });

  it("serves get state, start, and resume over HTTP", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));

    const first = await server.start();
    expect(first.phase).toBe("quiescent");
    expect(first.state.interrupts[0]?.kind).toBe("checkpoint");
    expect(first.state.tickets[0]?.status).toBe("checkpoint");

    const stateRes = await fetch(`${server.url}/api/state`);
    const stateBody = (await stateRes.json()) as { snapshot: typeof first };
    expect(stateBody.snapshot.phase).toBe("quiescent");

    const resumeRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: "01", action: "resume", note: "go on" }),
    });
    const resumeBody = (await resumeRes.json()) as { snapshot: typeof first };
    expect(resumeBody.snapshot.phase).toBe("quiescent");
    expect(resumeBody.snapshot.state.tickets[0]?.status).toBe("done");
    expect(resumeBody.snapshot.state.interrupts[0]?.kind).toBe("review");

    const approveRes = await fetch(`${server.url}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId: REVIEW_TICKET_ID, action: "approve" }),
    });
    const approveBody = (await approveRes.json()) as { snapshot: typeof first };
    expect(approveBody.snapshot.phase).toBe("done");
  });

  it("streams the latest snapshot to an SSE client on connect", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.answer(REVIEW_TICKET_ID, "approve");

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let data = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !data.includes('"phase"')) {
      const { value, done } = await reader!.read();
      if (done) break;
      data += decoder.decode(value, { stream: true });
    }
    expect(data).toContain("event: snapshot");
    expect(data).toContain('"phase":"done"');
    reader!.cancel();
  });

  it("keeps the stream open through more than ten seconds of a quiet pool", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({ "01": ["checkpoint", "done"] }));
    await server.start();
    // The pool now waits at the checkpoint interrupt: the stream goes silent.

    const res = await fetch(`${server.url}/api/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let data = "";
    while (!data.includes('"phase"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed before the replayed snapshot");
      data += decoder.decode(value, { stream: true });
    }

    // A dropped stream rejects the pending read rather than ending cleanly.
    let closed = false;
    const nextFrame = reader.read().then(
      ({ done }) => {
        if (done) closed = true;
      },
      () => {
        closed = true;
      },
    );
    // The default ten-second timeout's close reaches the client a couple of
    // seconds late, so wait well past both.
    await Bun.sleep(14_000);
    expect(closed).toBe(false);

    // The same connection still delivers the next broadcast after the silence.
    await server.answer("01", "resume");
    const arrived = await Promise.race([
      nextFrame.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    expect(arrived).toBe(true);
    expect(closed).toBe(false);
    reader.cancel();
  }, 25_000);
});

describe("ticket events endpoint", () => {
  const marker = "<!-- state: id=01 blocked-by=none status=ready -->";

  it("serves a ticket's parsed events after a run", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();
    await server.answer(REVIEW_TICKET_ID, "approve");

    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { at: string; attempt: number; kind: string; payload: Record<string, unknown> }[];
      attempts: unknown[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(false);
    expect(body.attempts).toEqual([]);
    expect(body.events.map((e) => e.kind)).toEqual([
      "scheduled",
      "spawned",
      "exited",
    ]);
    expect(body.events[0].attempt).toBe(1);
    expect(typeof body.events[0].at).toBe("string");
    const exited = body.events.find((e) => e.kind === "exited");
    expect(exited?.payload).toEqual({ code: 0, status: "done" });
  });

  it("backfills reconstructed attempt rows for a ticket with no events file", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const runsDir = join(poolDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, "01.log"), "first attempt output\n");
    writeFileSync(join(runsDir, "01.attempt-2.log"), "second attempt output\n");
    // Distinct modification times, so the reconstruction orders the attempts
    // the way they happened.
    const now = Date.now();
    utimesSync(join(runsDir, "01.log"), new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(join(runsDir, "01.attempt-2.log"), new Date(now), new Date(now));

    const server = await startServer(poolDir, stubHarness({}));
    const res = await fetch(`${server.url}/api/events?ticket=01`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      attempts: { attempt: number; logFile: string; modifiedAt: string }[];
      reconstructed: boolean;
    };
    expect(body.reconstructed).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.attempts).toEqual([
      {
        attempt: 1,
        logFile: "01.log",
        modifiedAt: new Date(now - 60_000).toISOString(),
      },
      {
        attempt: 2,
        logFile: "01.attempt-2.log",
        modifiedAt: new Date(now).toISOString(),
      },
    ]);
  });

  it("rejects a ticket id the pool does not own", async () => {
    const poolDir = makePool([{ file: "01-a.md", marker }]);
    const server = await startServer(poolDir, stubHarness({}));

    const res = await fetch(`${server.url}/api/events?ticket=zzz`);
    expect(res.status).toBe(404);
  });
});
