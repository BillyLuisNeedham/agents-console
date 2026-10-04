/**
 * Boot's flags, its interview and how it starts the server (the inventory's
 * `cli` rows from boot-cli.test.ts's "launch decisions", "flags" and
 * "interview"), run as a process: what it asks, what it refuses, how it
 * waits on a pool lock, the server it leaves running and the browser it
 * opens.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { cliWorld, consoleUrl, DONE_TICKET, MACHINE, readJson, snapshotTree } from "../harness/cli.ts";
import { bootLinePort, freePort } from "../harness/server.ts";

const BOOT = ["--yes", "--no-open", "--port", "0"];
const ASK = ["--no-open", "--port", "0"];
const DEFAULT_CHECKPOINT = "a device, an external write, an undecided decision, or a material guess";
const SAVE_SETUP = "save this Setup as (blank to skip)";

/**
 * Boot's usage line. How it names the command is the build's (the shim's
 * `agent-console`, or the binary's `agent-console boot`); the flags are not.
 */
function expectUsage(line: string | undefined): void {
  expect(line).toMatch(/^usage: agent-console( boot)? \[pool-dir\] \[--yes\] \[--relaunch\] \[--port <n>\] \[--setup <name>\] \[--no-open\]$/);
}

/** A refusal: its message line, then the usage line. */
function expectRefusal(stderr: string, message: string): void {
  const lines = stderr.split("\n");
  expect(lines[0]).toBe(message);
  expectUsage(lines[1]);
  expect(lines.slice(2)).toEqual([""]);
}

/** A configured pool directory under the world, with a done Ticket. */
function configuredPool(w: ReturnType<typeof cliWorld>, name = "pool"): string {
  const pool = w.dir(name);
  w.write(`${name}/issues/01.md`, DONE_TICKET);
  w.write(`${name}/console.json`, JSON.stringify({ defaults: MACHINE }, null, 2));
  return pool;
}

function hold(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, () => resolve(server));
  });
}

// launch decisions

conformance("cli", "Boot reports the port off the server's last boot line when 8787 is taken", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  // Held here, or already held by something else on this machine: either
  // way the server cannot have it.
  const holder = await hold(8787);
  t.defer(() => new Promise<void>((done) => (holder ? holder.close(() => done()) : done())));
  const run = await w.run("boot", [pool, "--yes", "--no-open"]);
  expect(run.code).toBe(0);
  const port = bootLinePort(readFileSync(join(pool, "runs", "server.log"), "utf8"));
  expect(port).not.toBeNull();
  expect(port).not.toBe(8787);
  expect(consoleUrl(run)).toBe(`http://localhost:${port}`);
});

conformance("cli", "Boot shows the last lines of the log when the engine refuses the pool", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  const holder = w.liveProcess();
  w.write("pool/runs/server.pid", `${holder.pid}\n`);
  const run = await w.run("boot", [pool, ...BOOT]);
  expect(run.code).toBe(1);
  const lines = run.stderr.trimEnd().split("\n");
  expect(lines[0]).toBe("the engine refused or failed at boot; its message:");
  // The engine's own refusal is the last line, naming the holder and the pool.
  expect(lines.at(-1)).toContain(String(holder.pid));
  expect(lines.at(-1)).toContain(pool);
});

conformance(
  "cli",
  "Boot --relaunch waits for the previous server to release the pool lock",
  async (t) => {
    const w = cliWorld(t);
    const pool = configuredPool(w);
    const pidFile = join(pool, "runs", "server.pid");
    const previous = w.liveProcess(["sh", "-c", `sleep 2; rm -f '${pidFile}'`]);
    w.write("pool/runs/server.pid", `${previous.pid}\n`);
    const run = await w.run("boot", [pool, "--relaunch", ...BOOT]);
    expect(run.code).toBe(0);
    expect(run.ms).toBeGreaterThanOrEqual(1_500);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).not.toBe(previous.pid);
    expect((await fetch(`${consoleUrl(run)}/api/state`)).status).toBe(200);
  },
  { slow: true },
);

conformance("cli", "Boot --relaunch treats a lock left by a dead process as released", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  const dead = w.deadPid();
  w.write("pool/runs/server.pid", `${dead}\n`);
  const run = await w.run("boot", [pool, "--relaunch", ...BOOT]);
  expect(run.code).toBe(0);
  // Well inside the 15 s it would wait on a live holder.
  expect(run.ms).toBeLessThan(10_000);
  const pid = Number(readFileSync(join(pool, "runs", "server.pid"), "utf8").trim());
  expect(pid).not.toBe(dead);
  expect(pid).toBeGreaterThan(0);
});

// Also the gap entry for a live sleep process holding the lock.
conformance(
  "cli",
  "Boot --relaunch gives up after 15 s, naming the pid, when a live process keeps the lock",
  async (t) => {
    const w = cliWorld(t);
    const pool = configuredPool(w);
    const holder = w.liveProcess();
    const pidFile = w.write("pool/runs/server.pid", `${holder.pid}\n`);
    const run = await w.run("boot", [pool, "--relaunch", ...BOOT], { timeoutMs: 40_000 });
    expect(run.code).toBe(1);
    expect(run.ms).toBeGreaterThanOrEqual(14_000);
    expect(run.stderr).toBe(
      `the previous server (pid ${holder.pid}) still holds ${pidFile}; it did not release the pool in 15s\n`,
    );
    // No server started: the lock is still the holder's and no boot line was written.
    expect(readFileSync(pidFile, "utf8").trim()).toBe(String(holder.pid));
    const logPath = join(pool, "runs", "server.log");
    expect(existsSync(logPath) ? bootLinePort(readFileSync(logPath, "utf8")) : null).toBeNull();
  },
  { slow: true, timeoutMs: 60_000 },
);

// flags

conformance("cli", "Boot takes the positional pool and every flag, asks nothing, writes nothing and opens nothing", async (t) => {
  const w = cliWorld(t, { machineDefaults: MACHINE });
  const top = w.repo("repo");
  w.write("repo/.scratch/x/issues/01.md", DONE_TICKET);
  const configPath = w.write("repo/.scratch/x/console.json", JSON.stringify({ defaults: MACHINE }));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(configPath, past, past);
  const mtime = statSync(configPath).mtimeMs;
  const port = await freePort();
  const run = await w.run("boot", [".scratch/x", "--yes", "--relaunch", "--port", String(port), "--no-open"], { cwd: top });
  expect(run.code).toBe(0);
  expect(run.prompts).toEqual([]);
  expect(statSync(configPath).mtimeMs).toBe(mtime);
  const pool = join(top, ".scratch", "x");
  expect(consoleUrl(run)).toBe(`http://localhost:${port}`);
  expect(readFileSync(join(pool, "runs", "server.log"), "utf8")).toContain(
    `pool server on http://localhost:${port} (${pool})`,
  );
  await Bun.sleep(500);
  expect(w.browserOpens()).toEqual([]);
});

conformance("cli", "Boot opens the Console it started in the browser unless told --no-open", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  const run = await w.run("boot", [pool, "--yes", "--port", "0"]);
  expect(run.code).toBe(0);
  const url = consoleUrl(run)!;
  const deadline = Date.now() + 5_000;
  while (w.browserOpens().length === 0 && Date.now() < deadline) await Bun.sleep(25);
  expect(w.browserOpens()).toEqual([url]);
});

conformance("cli", "Boot takes --pool as the positional's long form, beside --setup", async (t) => {
  const w = cliWorld(t, { setups: { "standard-build": { defaults: { harness: "claude", model: "m" } } } });
  const pool = w.dir("pool");
  w.write("pool/issues/01.md", DONE_TICKET);
  const run = await w.run("boot", ["--pool", pool, "--setup", "standard-build", ...BOOT]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`pool: ${pool} (named on the command line)\n`);
  expect(run.stdout).toContain("starting from Setup standard-build\n");
});

conformance("cli", "Boot rejects a flag with no value and a port that is not a number", async (t) => {
  const w = cliWorld(t);
  const noValue = await w.run("boot", ["--port"]);
  const unknown = await w.run("boot", ["--nope"]);
  const notNumber = await w.run("boot", ["--port", "abc"]);
  expect([noValue.code, unknown.code, notNumber.code]).toEqual([1, 1, 1]);
  expectRefusal(noValue.stderr, "--port needs a value");
  expectRefusal(unknown.stderr, "unknown flag --nope");
  expect(notNumber.stderr).toBe("--port must be a number, got abc\n");
});

// interview

conformance("cli", "Boot asks the full interview when nothing is prefilled", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude", "opencode"] });
  const pool = w.dir("empty");
  const run = await w.run("boot", [pool, ...ASK], {
    answers: [
      ["pool kind", "ticket"],
      ["default harness", "claude"],
      ["default model", "claude-opus-5"],
    ],
  });
  // Boot writes the ticket pool it was told to make, and then the engine
  // refuses to load a ticket pool with no Tickets yet.
  expect(run.code).toBe(1);
  expect(run.stderr).toStartWith("the engine refused or failed at boot; its message:\n");
  expect(run.prompts).toEqual([
    "pool kind, ticket or seeded [seeded]",
    "default harness (claude/opencode/cursor) [claude]",
    "default model",
    "drivers (space separated chain) [implement]",
    "merge resolver harness (or none) [claude]",
    "reviewer and its authority (blank for none)",
    `what counts as a checkpoint here [${DEFAULT_CHECKPOINT}]`,
    "port to pin (auto for 8787 or next free) [auto]",
    "terminal-backed attempts in herdr tabs (yes/no) [no]",
    SAVE_SETUP,
  ]);
  expect(readJson(join(pool, "console.json")).defaults).toEqual({
    harness: "claude",
    model: "claude-opus-5",
    drivers: "implement",
  });
  expect(existsSync(join(pool, "conversations"))).toBe(false);
});

conformance("cli", "Boot asks nothing for a field a prefill already settled", async (t) => {
  const w = cliWorld(t, {
    machineDefaults: { harness: "opencode", model: "m", effort: "high", drivers: "implement", terminal: "herdr" },
  });
  const pool = w.dir("pool");
  for (const n of ["01", "02", "03"]) w.write(`pool/issues/${n}.md`, DONE_TICKET.replace("id=01", `id=${n}`));
  w.write("pool/console.json", JSON.stringify({ resolver: "opencode", reviewer: "r", checkpoint: "c", port: 9001 }));
  const run = await w.run("boot", [pool, ...ASK]);
  expect(run.code).toBe(0);
  expect(run.prompts).toEqual([SAVE_SETUP]);
  expect(readJson(join(pool, "console.json")).defaults).toEqual({
    harness: "opencode",
    model: "m",
    effort: "high",
    drivers: "implement",
  });
});

conformance("cli", "Boot unattended names the fields nothing prefilled", async (t) => {
  const w = cliWorld(t);
  const top = w.repo("repo");
  const run = await w.run("boot", ["--yes", "--no-open"], { cwd: top });
  expect(run.code).toBe(1);
  expect(run.stderr).toBe(
    "nothing prefilled the harness and model; set it in ~/.agent-graphs/defaults.json, pass --setup, or boot without --yes\n",
  );
});

conformance("cli", "Boot asks the pool kind only when the disk cannot answer it", async (t) => {
  const w = cliWorld(t, { machineDefaults: { harness: "claude", model: "m", drivers: "d" } });
  const pool = w.dir("pool");
  w.dir("pool/conversations");
  w.write(
    "pool/console.json",
    JSON.stringify({ resolver: "claude", reviewer: "r", checkpoint: "c", port: 9001, terminal: "herdr" }),
  );
  const run = await w.run("boot", [pool, ...ASK]);
  expect(run.code).toBe(0);
  expect(run.prompts).toEqual([SAVE_SETUP]);
  expect(run.stdout).not.toContain("pool kind");
  expect(existsSync(join(pool, "conversations"))).toBe(true);
});

// Gaps the inventory lists for `cli` (Visible behaviour no test covers yet).

conformance("cli", "Boot --relaunch over a dead lock starts the server and writes nothing", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  const config = readFileSync(join(pool, "console.json"));
  w.write("pool/runs/server.pid", `${w.deadPid()}\n`);
  const port = await freePort();
  const run = await w.run("boot", [pool, "--yes", "--relaunch", "--port", String(port), "--no-open"]);
  expect(run.code).toBe(0);
  expect(run.stdout).toContain(`Console on http://localhost:${port}\n`);
  expect(run.stdout).not.toContain("wrote");
  expect((await fetch(`http://localhost:${port}/api/state`)).status).toBe(200);
  expect(readFileSync(join(pool, "console.json")).equals(config)).toBe(true);
  expect(existsSync(join(pool, "verify.md"))).toBe(false);
  expect(existsSync(join(w.home, ".agent-graphs", "defaults.json"))).toBe(false);
});

conformance("cli", "Boot on a pool its earlier Boot is serving fails with the engine's refusal and leaves that server up", async (t) => {
  const w = cliWorld(t);
  const pool = configuredPool(w);
  const first = await w.run("boot", [pool, ...BOOT]);
  expect(first.code).toBe(0);
  const url = consoleUrl(first)!;
  const serverPid = readFileSync(join(pool, "runs", "server.pid"), "utf8").trim();

  const second = await w.run("boot", [pool, ...BOOT]);
  expect(second.code).toBe(1);
  const lines = second.stderr.trimEnd().split("\n");
  expect(lines[0]).toBe("the engine refused or failed at boot; its message:");
  expect(lines.at(-1)).toContain(serverPid);
  expect((await fetch(`${url}/api/state`)).status).toBe(200);
  // The log was truncated for the second start, under the running server.
  expect(readFileSync(join(pool, "runs", "server.log"), "utf8")).not.toContain("pool server on");
});

conformance("cli", "Boot prints its usage on --help and refuses bad flags and arguments before writing anything", async (t) => {
  const w = cliWorld(t);
  const cwd = w.dir("nowhere");
  const before = { cwd: snapshotTree(cwd), home: snapshotTree(w.home) };
  const help = await w.run("boot", ["--help"], { cwd });
  expect(help.code).toBe(0);
  expect(help.stdout.endsWith("\n")).toBe(true);
  expect(help.stdout.split("\n")).toHaveLength(2);
  expectUsage(help.stdout.split("\n")[0]);
  const nope = await w.run("boot", ["--nope"], { cwd });
  const two = await w.run("boot", ["a", "b"], { cwd });
  const port = await w.run("boot", ["--port", "70000"], { cwd });
  const noRepo = await w.run("boot", ["--yes", "--no-open"], { cwd });
  expect([nope.code, two.code, port.code, noRepo.code]).toEqual([1, 1, 1, 1]);
  expectRefusal(nope.stderr, "unknown flag --nope");
  expectRefusal(two.stderr, "too many arguments");
  expect(port.stderr).toBe("--port: port must be an integer 0-65535, got 70000\n");
  expect(noRepo.stderr).toContain(`${cwd} is not a pool and not inside a git checkout`);
  expect({ cwd: snapshotTree(cwd), home: snapshotTree(w.home) }).toEqual(before);
});

conformance("cli", "Boot asks the harness again after one it has no descriptor for, and warns of one not on PATH", async (t) => {
  const w = cliWorld(t, { harnesses: ["claude"], machineDefaults: { model: "m" } });
  const pool = w.dir("pool");
  w.write("pool/issues/01.md", DONE_TICKET);
  const run = await w.run("boot", [pool, ...ASK], {
    answers: [
      ["default harness", "nope"],
      ["default harness", "cursor"],
    ],
  });
  expect(run.code).toBe(0);
  expect(run.prompts.filter((prompt) => prompt.startsWith("default harness"))).toHaveLength(2);
  expect(run.stderr).toContain("the engine has no descriptor for nope; pick one of claude, opencode, cursor\n");
  expect(run.stderr).toContain("cursor is not on PATH; the first attempt will fail until it is\n");
  expect((readJson(join(pool, "console.json")).defaults as Record<string, unknown>).harness).toBe("cursor");
});
