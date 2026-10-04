/**
 * The command lines under test, run as processes the way an operator or a
 * Steward runs them (ADR-0036): Boot, the fleet list and the Steward's
 * command. The same --server switch as the servers picks the build:
 *
 *   bun    bun run engine/boot-cli.ts | fleet-cli.ts | steward-cli.ts
 *   rust   <binary> boot | fleet | steward
 *
 * A case observes what any caller could: the exit code, both streams, the
 * prompts Boot puts and the answers it is given, the files it writes, the
 * server it leaves running and the browser it opens.
 *
 * Its world has no pool and no repository until the case makes them, since
 * finding or creating the pool is most of what Boot does:
 *
 *   <root>/home    HOME, so no operator file is read or written
 *   <root>/bin     stub harnesses the case asks for, and a recording browser
 *                  opener (`xdg-open`, and `open` for macOS)
 *   <root>/tools   the other tools, linked by name: PATH holds these two only,
 *                  so no real harness, editor or herdr on this machine counts
 *
 * Boot's server is detached and outlives Boot, so teardown stops every
 * server whose `runs/server.pid` sits under the world, and every process the
 * case planted, before the world is deleted.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { makeTempDir } from "../fixtures/tmp.ts";
import type { Case } from "./case.ts";
import { CHECKOUT, serverChoice, type ServerChoice } from "./server.ts";

export type Command = "boot" | "fleet" | "steward";

/** The argv that runs one command line of the chosen build. */
export function commandArgv(choice: ServerChoice, command: Command, args: string[]): string[] {
  if (choice.kind === "bun") return [process.execPath, "run", join(CHECKOUT, "engine", `${command}-cli.ts`), ...args];
  return [choice.rustBin!, command, ...args];
}

/** What a command line and the server Boot starts may run, besides the stubs. */
const TOOLS = [
  "sh", "bash", "git", "env", "sleep", "cat", "rm", "mkdir", "ls", "cp", "mv", "ln", "sed", "grep", "awk",
  "head", "tail", "tr", "wc", "sort", "uniq", "cut", "dirname", "basename", "readlink", "realpath", "mktemp",
  "touch", "chmod", "date", "printf", "test", "true", "false", "kill", "ps", "id", "uname", "tee", "find",
  "xargs", "stat", "script", "nohup", "setsid", "timeout",
];

export interface CliSpec {
  /** Harness binaries stubbed on PATH, by the name detection asks for. Default none. */
  harnesses?: string[];
  /** HOME/.agent-graphs/defaults.json, written only when given. */
  machineDefaults?: Record<string, unknown>;
  /** HOME/.agent-graphs/setups/<name>.json for each entry. */
  setups?: Record<string, Record<string, unknown>>;
}

export interface RepoSpec {
  /** The branch checked out. Default main. */
  branch?: string;
  /** Commit subjects, oldest first. Default one commit, "init". */
  subjects?: string[];
  /** Files committed with the first commit, by path in the repository. */
  files?: Record<string, string>;
}

export interface RunOptions {
  /** The working directory, absolute. Default the world's root. */
  cwd?: string;
  /**
   * Boot's prompts answered in order: a prompt that starts with a pair's
   * text takes its answer, and that pair is spent. Any other prompt gets
   * Enter, its default.
   */
  answers?: [string, string][];
  /** Standard input as given, then closed; in place of answering prompts. */
  stdin?: string;
  timeoutMs?: number;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Every prompt Boot put, in order, without its trailing ": ". */
  prompts: string[];
  /** Wall time, start to exit. */
  ms: number;
}

export interface CliWorld {
  root: string;
  home: string;
  bin: string;
  /** The environment every command line here runs with, built from nothing. */
  env(): Record<string, string>;
  /** An absolute path under the root. */
  path(...parts: string[]): string;
  /** A directory under the root, made with its parents. */
  dir(path: string): string;
  /** A file under the root, its directories made. */
  write(path: string, content: string | Buffer): string;
  /** A git repository at `path` under the root, committed as the spec says. */
  repo(path: string, spec?: RepoSpec): string;
  /** Run a command line and wait for it. */
  run(command: Command, args: string[], options?: RunOptions): Promise<CliRun>;
  /** Every URL the browser opener (`xdg-open`, or `open` on macOS) was run with. */
  browserOpens(): string[];
  /** A process that stays alive until teardown, which the case may kill first. */
  liveProcess(argv?: string[]): { pid: number; kill(): Promise<void> };
  /** A pid that has exited and been reaped. */
  deadPid(): number;
  /** Stop every server whose runs/server.pid sits under the root. */
  stopServers(): Promise<void>;
}

const POLL_MS = 25;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) pidFiles(path, depth + 1, out);
    else if (name === "server.pid" && dir.endsWith("runs")) out.push(path);
  }
  return out;
}

let uiBuild: Promise<void> | null = null;

/**
 * Boot rebuilds `ui/dist` when it is missing or older than the last commit
 * to `ui/src`, with `bun` from PATH. A fresh checkout has no build, so the
 * Bun build is brought up to date once per run, the way Boot itself would
 * do it, rather than by every case's first Boot. The decision is no part of
 * the contract: the Rust binary embeds its UI.
 */
function ensureUiBuilt(): Promise<void> {
  uiBuild ??= (async () => {
    const index = join(CHECKOUT, "ui", "dist", "index.html");
    const built = existsSync(index) ? statSync(index).mtimeMs : null;
    const log = Bun.spawnSync(["git", "-C", CHECKOUT, "log", "-1", "--format=%ct", "--", "ui/src"], { stdout: "pipe" });
    const source = Number(log.stdout.toString().trim()) * 1000 || null;
    if (built !== null && (source === null || source <= built)) return;
    for (const args of [["install"], ["run", "build"]]) {
      const run = Bun.spawnSync([process.execPath, ...args], { cwd: join(CHECKOUT, "ui"), stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) {
        throw new Error(`bun ${args.join(" ")} in ui/ failed:\n${run.stdout.toString()}${run.stderr.toString()}`);
      }
    }
  })();
  return uiBuild;
}

/** The Console URL Boot printed, `Console on http://localhost:<port>`, or null. */
export function consoleUrl(run: CliRun): string | null {
  return /Console on (http:\/\/localhost:\d+)/.exec(run.stdout)?.[1] ?? null;
}

export function cliWorld(t: Case, spec: CliSpec = {}): CliWorld {
  const choice = serverChoice();
  const root = makeTempDir("cli-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const tools = join(root, "tools");
  for (const dir of [home, bin, tools]) mkdirSync(dir, { recursive: true });

  for (const tool of TOOLS) {
    const found = Bun.which(tool, { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" });
    if (found) symlinkSync(found, join(tools, tool));
  }
  // Boot starts the Bun server as `bun` from PATH.
  symlinkSync(process.execPath, join(tools, "bun"));
  for (const name of spec.harnesses ?? []) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  // The browser opener, by both platforms' names, recording rather than opening.
  const opens = join(root, "opener.calls");
  for (const opener of ["xdg-open", "open"]) {
    writeFileSync(join(bin, opener), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(opens)}\n`);
    chmodSync(join(bin, opener), 0o755);
  }

  const graphs = join(home, ".agent-graphs");
  if (spec.machineDefaults) {
    mkdirSync(graphs, { recursive: true });
    writeFileSync(join(graphs, "defaults.json"), `${JSON.stringify(spec.machineDefaults, null, 2)}\n`);
  }
  for (const [name, setup] of Object.entries(spec.setups ?? {})) {
    mkdirSync(join(graphs, "setups"), { recursive: true });
    writeFileSync(join(graphs, "setups", `${name}.json`), `${JSON.stringify(setup, null, 2)}\n`);
  }

  const env = (): Record<string, string> => {
    const out: Record<string, string> = {
      PATH: `${bin}:${tools}`,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      HERDR_SOCKET_PATH: join(root, "no-herdr.sock"),
      LANG: "C.UTF-8",
      TERM: "dumb",
    };
    for (const name of ["TMPDIR", "USER", "LOGNAME"]) {
      const value = process.env[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  };

  const planted: { pid: number; kill(): Promise<void> }[] = [];

  const stopServers = async (): Promise<void> => {
    const ours = new Set(planted.map((p) => p.pid));
    const pids: number[] = [];
    for (const file of pidFiles(root)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && !ours.has(pid) && alive(pid)) {
        process.kill(pid, "SIGTERM");
        pids.push(pid);
      }
    }
    const deadline = Date.now() + 10_000;
    while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(POLL_MS);
    for (const pid of pids.filter(alive)) process.kill(pid, "SIGKILL");
  };

  const world: CliWorld = {
    root,
    home,
    bin,
    env,
    path: (...parts) => join(root, ...parts),
    dir(path) {
      const abs = join(root, path);
      mkdirSync(abs, { recursive: true });
      return abs;
    },
    write(path, content) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    repo(path, repoSpec = {}) {
      const repo = world.dir(path);
      const git = (args: string[]): void => {
        const run = Bun.spawnSync(["git", ...args], { cwd: repo, env: env(), stdout: "pipe", stderr: "pipe" });
        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
      };
      git(["init", "-q", "-b", repoSpec.branch ?? "main"]);
      git(["config", "user.email", "conformance@test"]);
      git(["config", "user.name", "conformance"]);
      git(["config", "commit.gpgsign", "false"]);
      for (const [file, content] of Object.entries(repoSpec.files ?? {})) {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), content);
      }
      const subjects = repoSpec.subjects ?? ["init"];
      subjects.forEach((subject, index) => {
        if (index === 0) git(["add", "-A"]);
        git(["commit", "-q", "--allow-empty", "-m", subject]);
      });
      return repo;
    },
    async run(command, args, options = {}) {
      if (command === "boot" && choice.kind === "bun") await ensureUiBuilt();
      const started = Date.now();
      const proc = Bun.spawn(commandArgv(choice, command, args), {
        cwd: options.cwd ?? root,
        env: env(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (options.stdin !== undefined) {
        proc.stdin.write(options.stdin);
        await proc.stdin.end();
      }
      const pending = [...(options.answers ?? [])];
      const prompts: string[] = [];
      let stdout = "";
      // Where the last answered prompt ended. Answers are not echoed, so the
      // next prompt follows on the same line.
      let answered = 0;
      const reading = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stdout) {
          stdout += decoder.decode(chunk, { stream: true });
          if (options.stdin !== undefined) continue;
          const from = Math.max(answered, stdout.lastIndexOf("\n") + 1);
          const tail = stdout.slice(from);
          if (!tail.endsWith(": ")) continue;
          answered = stdout.length;
          const prompt = tail.slice(0, -2);
          prompts.push(prompt);
          const index = pending.findIndex(([start]) => prompt.startsWith(start));
          const answer = index >= 0 ? pending.splice(index, 1)[0]![1] : "";
          try {
            proc.stdin.write(`${answer}\n`);
            proc.stdin.flush();
          } catch {
            // It exited between the prompt and the answer.
          }
        }
      })();
      const stderr = new Response(proc.stderr).text();
      const timeoutMs = options.timeoutMs ?? 30_000;
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
      if (!exited) {
        proc.kill("SIGKILL");
        await proc.exited;
        await reading;
        throw new Error(
          `${command} ${args.join(" ")} was still running after ${timeoutMs} ms\n` +
            `stdout:\n${stdout}\nstderr:\n${await stderr}`,
        );
      }
      await reading;
      if (options.stdin === undefined) {
        try {
          await proc.stdin.end();
        } catch {
          // Already closed with the process.
        }
      }
      return { code: proc.exitCode ?? -1, stdout, stderr: await stderr, prompts, ms: Date.now() - started };
    },
    browserOpens() {
      return existsSync(opens) ? readFileSync(opens, "utf8").split("\n").filter((line) => line !== "") : [];
    },
    liveProcess(argv = ["sleep", "600"]) {
      const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: env() });
      const entry = {
        pid: proc.pid,
        async kill() {
          proc.kill("SIGKILL");
          await proc.exited;
        },
      };
      planted.push(entry);
      return entry;
    },
    deadPid() {
      const child = spawnSync("true");
      if (!child.pid) throw new Error("could not start a child for a dead pid");
      return child.pid;
    },
    stopServers,
  };

  t.defer(async () => {
    await stopServers();
    for (const entry of planted) await entry.kill();
    if (process.env.CONFORMANCE_KEEP === "1") {
      console.error(`kept the command-line world at ${root}`);
      return;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return world;
}

/**
 * A Ticket already done, which makes a directory a pool without giving the
 * server Boot starts anything to launch.
 */
export const DONE_TICKET = "<!-- state: id=01 blocked-by= status=done -->\n\n# First\n";

/** Machine defaults that settle the harness and model, so `--yes` may boot. */
export const MACHINE = { harness: "claude", model: "m" };

/** A JSON file, parsed. */
export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Every path under a directory with its bytes, to show nothing was written there. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${key}/`] = "";
        walk(join(at, entry.name), key);
      } else out[key] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}
