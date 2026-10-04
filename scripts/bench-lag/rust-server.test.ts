import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootLinePort,
  cpuSecondsFromPs,
  cpuTicksFromStat,
  defaultRustBin,
  installHarnesses,
  modesFile,
  parseServerKind,
  pingPathOf,
  sampleProcess,
  startRustServer,
} from "./rust-server.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bench-rust-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the server choice", () => {
  test("names bun or rust and nothing else", () => {
    expect(parseServerKind("bun")).toBe("bun");
    expect(parseServerKind("rust")).toBe("rust");
    expect(parseServerKind("node")).toBeNull();
    expect(parseServerKind("")).toBeNull();
  });

  test("the Rust binary defaults to the checkout's release build", () => {
    expect(defaultRustBin("/work/agent-console")).toBe("/work/agent-console/target/release/agent-console");
  });
});

describe("the process table", () => {
  test("reads utime and stime past a command name that holds spaces and parentheses", () => {
    const stat = "4242 (agent (console)) S 1 4242 4242 0 -1 4194560 100 0 0 0 150 30 0 0 20 0 8 0 100 1000 200";
    expect(cpuTicksFromStat(stat)).toBe(180);
  });

  test("a line that does not parse has no ticks", () => {
    expect(cpuTicksFromStat("garbage")).toBeNull();
  });

  test("reads ps's cputime in each of its shapes", () => {
    expect(cpuSecondsFromPs("00:05")).toBe(5);
    expect(cpuSecondsFromPs("  1:02.50 ")).toBe(62.5);
    expect(cpuSecondsFromPs("01:02:03")).toBe(3723);
    expect(cpuSecondsFromPs("2-01:00:00")).toBe(2 * 86_400 + 3_600);
    expect(cpuSecondsFromPs("nonsense")).toBeNull();
  });

  test("samples a live process and not a gone one", () => {
    const sample = sampleProcess(process.pid);
    expect(sample).not.toBeNull();
    expect(sample!.rssBytes).toBeGreaterThan(1_000_000);
    expect(sample!.cpuSeconds).toBeGreaterThan(0);
    expect(sampleProcess(2 ** 22 + 12345)).toBeNull();
  });
});

describe("what the server prints and serves", () => {
  test("finds the port in the last boot line", () => {
    expect(bootLinePort("noise\npool server on http://localhost:4100 (/p)\n")).toBe(4100);
    expect(bootLinePort("pool server on http://localhost:1 (/a)\npool server on http://localhost:2 (/b)\n")).toBe(2);
    expect(bootLinePort("starting\n")).toBeNull();
  });

  test("pings the first stylesheet of the page, else its first script", () => {
    const both = `<head><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="/assets/index-def.css"></head>`;
    expect(pingPathOf(both)).toBe("/assets/index-def.css");
    expect(pingPathOf(`<script type="module" src="/assets/index-abc.js"></script>`)).toBe("/assets/index-abc.js");
    expect(pingPathOf(`<script type="application/json">{}</script>`)).toBeNull();
    expect(pingPathOf("<p>nothing</p>")).toBeNull();
  });
});

describe("the harness the pool's Tickets run", () => {
  test("lists a mode per Ticket, one line each", () => {
    expect(modesFile({ "01": "quick", "09": "conflict" })).toBe("01 quick\n09 conflict\n");
  });

  /** A pool harness script that records what it was run with. */
  function recordingHarness(root: string): string {
    const script = join(root, "harness.sh");
    writeFileSync(script, '#!/usr/bin/env bash\nprintf "%s " "$@" > "$(dirname "$0")/ran.txt"\n');
    chmodSync(script, 0o755);
    return script;
  }

  async function run(bin: string, name: string, args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn([join(bin, name), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: await proc.exited, err: await new Response(proc.stderr).text() };
  }

  test("a batch launch runs the pool's script in the Ticket's mode on the outcome the prompt names", async () => {
    const root = tempRoot();
    const harness = recordingHarness(root);
    const bin = installHarnesses(root, harness, join(root, "release"), { "05": "conflict", "06": "live" });
    const prompt = `Do the work.\nWhen you finish, record your outcome as JSON at ${root}/runs/05.outcome.json: {"status": "done"}`;
    const { code, err } = await run(bin, "claude", ["-p", prompt]);
    expect([code, err]).toEqual([0, ""]);
    expect(readFileSync(join(root, "ran.txt"), "utf8")).toBe(`conflict 05 ${root}/runs/05.outcome.json ${root}/release `);
  });

  test("a Ticket missing from the modes file plays quick", async () => {
    const root = tempRoot();
    const harness = recordingHarness(root);
    const bin = installHarnesses(root, harness, join(root, "release"), {});
    const prompt = `outcome as JSON at ${root}/runs/77.outcome.json: {}`;
    await run(bin, "opencode", ["run", prompt]);
    expect(readFileSync(join(root, "ran.txt"), "utf8")).toStartWith("quick 77 ");
  });

  test("a terminal-backed launch reads the prompt typed into its pane", async () => {
    const root = tempRoot();
    const harness = recordingHarness(root);
    const bin = installHarnesses(root, harness, join(root, "release"), { "03": "live" });
    const input = join(root, "pane-input");
    const pending = run(bin, "agent", [], { FAKE_HERDR_PANE_INPUT: input });
    await Bun.sleep(300);
    writeFileSync(input, `outcome as JSON at ${root}/runs/03.outcome.json: {}`);
    expect((await pending).code).toBe(0);
    expect(readFileSync(join(root, "ran.txt"), "utf8")).toStartWith("live 03 ");
  });

  test("a launch that names no outcome file holds until the release file appears", async () => {
    const root = tempRoot();
    const release = join(root, "release");
    const bin = installHarnesses(root, recordingHarness(root), release, {});
    const proc = Bun.spawn([join(bin, "claude")], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const early = await Promise.race([proc.exited, Bun.sleep(1_500).then(() => "held")]);
    expect(early).toBe("held");
    writeFileSync(release, "");
    expect(await proc.exited).toBe(0);
    expect(existsSync(join(root, "ran.txt"))).toBe(false);
  });
});

describe("starting the Rust server", () => {
  /** A stand-in for the binary: `<it> server --pool <dir> --port <n>` serves what the real one does that the bench reads. */
  function fakeBinary(root: string, behaviour: "serves" | "dies"): string {
    const path = join(root, "agent-console");
    const body =
      behaviour === "dies"
        ? 'console.log("boom: no such pool"); process.exit(3);'
        : `const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
Bun.serve({
  port,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/state") return Response.json({ snapshot: {} });
    if (pathname === "/") return new Response('<link rel="stylesheet" href="/assets/app.css">', { headers: { "content-type": "text/html" } });
    return new Response("body{}");
  },
});
console.log("pool server on http://localhost:" + port + " (" + process.argv[process.argv.indexOf("--pool") + 1] + ")");`;
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("is ready at its boot line, pings a static asset and answers the parent's asks from the process table", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "pool"));
    const server = await startRustServer({
      bin: fakeBinary(root, "serves"),
      cwd: root,
      poolDir: join(root, "pool"),
      logPath: join(root, "server.log"),
      env: { PATH: process.env.PATH ?? "" },
    });
    try {
      expect(server.ready).toMatch(/^http:\/\/localhost:\d+$/);
      expect(server.pingPath).toBe("/assets/app.css");
      expect((await fetch(`${server.ready}${server.pingPath}`)).status).toBe(200);

      const begun = await server.ask("begin", "begun");
      expect(begun.kind).toBe("begun");
      expect(begun.rssBytes).toBeGreaterThan(1_000_000);
      await Bun.sleep(100);
      const report = await server.ask("report", "report");
      expect(report.kind).toBe("report");
      expect(report.rssBytes).toBeGreaterThan(1_000_000);
      expect(report.cpuPercent).toBeGreaterThanOrEqual(0);
      // What reads Bun internals has no Rust counterpart: null, never zero.
      expect([report.loopLagMs, report.syncSpawn, report.asyncSpawns]).toEqual([null, null, null]);
      expect(await server.ask("timeline", "timeline")).toEqual({ kind: "timeline", marks: [] });
    } finally {
      server.proc.kill("SIGKILL");
    }
  });

  test("fails with the log's tail when the binary exits before its boot line", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "pool"));
    await expect(
      startRustServer({
        bin: fakeBinary(root, "dies"),
        cwd: root,
        poolDir: join(root, "pool"),
        logPath: join(root, "server.log"),
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).rejects.toThrow(/exited 3 before its boot line:\nboom: no such pool/);
  });
});
