/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPoolServer,
  type PoolServer,
} from "./server.ts";
import type { HarnessCommand, PoolConfig } from "./engine.ts";

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
  it("drives a pool to done and serves the enriched state", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
      { file: "02-b.md", marker: "<!-- state: id=02 blocked-by=01 status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));

    const snapshot = await server.start();
    expect(snapshot.phase).toBe("done");
    const statuses = Object.fromEntries(snapshot.state.tickets.map((t) => [t.id, t.status]));
    expect(statuses).toEqual({ "01": "done", "02": "done" });
    expect(snapshot.state.tickets.map((t) => t.blockedBy)).toEqual([[], ["01"]]);
    expect(snapshot.state.tickets.map((t) => t.title)).toEqual(["body", "body"]);
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
    expect(resumeBody.snapshot.phase).toBe("done");
    expect(resumeBody.snapshot.state.tickets[0]?.status).toBe("done");
  });

  it("streams the latest snapshot to an SSE client on connect", async () => {
    const poolDir = makePool([
      { file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=ready -->" },
    ]);
    const server = await startServer(poolDir, stubHarness({}));
    await server.start();

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
});
