/**
 * Boot (issue #121, ADR-0026): starting a Console for a Pool without an
 * agent. `agent-console` from a project checkout finds or creates the Pool,
 * reads everything it can rather than asking, interviews only for what is
 * still missing, writes the Pool's config and its prose files, builds the
 * Console when the build is stale, and starts the server.
 *
 * The interview used to be the `my-console-runner` skill's step 2, eight
 * questions an agent asked and answered into files. Almost all of it was
 * bookkeeping a script does better and cheaper, so the skill now runs this
 * and keeps the one part a script cannot do, which is writing the pool's own
 * prose. A Restart hands off here too: the Console stops its server and
 * re-execs this with `--yes --relaunch`, which is why every question has a
 * prefill good enough to take unattended.
 *
 * The readline layer is one injected `ask` function and the process work is
 * behind the small functions in `boot-launch.ts`, so the decisions above
 * both are testable without a terminal.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  defaultMachineDefaultsPath,
  defaultMachineDefaultsPaths,
  readMachineDefaults,
  writeMachineDefaults,
} from "./machine-defaults.ts";
import { validPort } from "./ports.ts";
import {
  createPool,
  ensureScratchExcluded,
  gitDirOf,
  gitLine,
  nearestExisting,
  poolName,
  realRepoProbe,
  resolvePool,
  slugify,
} from "./boot-pool.ts";
import { KNOWN_HARNESSES, detect, type Detection } from "./boot-detect.ts";
import {
  fillAgentTemplate,
  listSetups,
  mergeConsoleConfig,
  mergePrefill,
  prefillFromConfig,
  prefillFromDetection,
  prefillFromMachineDefaults,
  prefillFromSetup,
  readConsoleConfig,
  readSetup,
  setupFromConfig,
  setupPath,
  writeConsoleConfig,
  writeSetup,
  type BootAnswers,
  type Prefill,
  type ResolverValue,
} from "./boot-config.ts";
import {
  distMtime,
  needsRebuild,
  openBrowser,
  pidWaitDeps,
  startServer,
  uiSourceCommitMs,
  waitForBoot,
  waitForPidRelease,
  waitForState,
} from "./boot-launch.ts";

export const USAGE =
  "usage: agent-console [pool-dir] [--yes] [--relaunch] [--port <n>] " +
  "[--setup <name>] [--no-open]";

export interface BootArgs {
  poolDir?: string | undefined;
  yes: boolean;
  relaunch: boolean;
  port?: number | undefined;
  setup?: string | undefined;
  open: boolean;
}

export type ArgParse =
  | { ok: true; args: BootArgs }
  | { ok: false; message: string; help?: boolean };

/**
 * The flags, kept deliberately few. `--pool` is the positional's long form
 * because the Console's Restart handoff builds a command line rather than a
 * shell invocation and naming the flag reads better there.
 */
export function parseBootArgs(argv: string[]): ArgParse {
  const args: BootArgs = { yes: false, relaunch: false, open: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--relaunch") args.relaunch = true;
    else if (arg === "--no-open") args.open = false;
    else if (arg === "--help" || arg === "-h") return { ok: false, message: USAGE, help: true };
    else if (arg === "--pool" || arg === "--port" || arg === "--setup") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `${arg} needs a value\n${USAGE}` };
      }
      i += 1;
      if (arg === "--pool") args.poolDir = value;
      else if (arg === "--setup") args.setup = value;
      else {
        const port = Number(value);
        if (!Number.isInteger(port)) {
          return { ok: false, message: `--port must be a number, got ${value}` };
        }
        try {
          args.port = validPort(port, "--port");
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      }
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `unknown flag ${arg}\n${USAGE}` };
    } else if (args.poolDir === undefined) {
      args.poolDir = arg;
    } else {
      return { ok: false, message: `too many arguments\n${USAGE}` };
    }
  }
  return { ok: true, args };
}

/** One prompt, one line. The default is what pressing Enter gives you. */
export type Ask = (question: string, fallback: string) => Promise<string>;

export interface BootIo {
  ask: Ask;
  log(line: string): void;
  warn(line: string): void;
}

/**
 * The terminal's ask, which is the only place readline appears. It reads
 * lines from one long-lived stream rather than asking readline for a line
 * per question: answers piped in arrive as a block, and a per-question read
 * drops everything after the first line and then waits forever for input
 * that has already been delivered. Input ending is not a failure either, so
 * from that point every remaining question takes its default, exactly as
 * `--yes` would.
 */
export async function terminalIo(): Promise<BootIo & { close(): void }> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin });
  const ready: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else ready.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const waiter of waiting.splice(0)) waiter(null);
  });
  const nextLine = (): Promise<string | null> =>
    new Promise((resolve) => {
      const buffered = ready.shift();
      if (buffered !== undefined) resolve(buffered);
      else if (ended) resolve(null);
      else waiting.push(resolve);
    });
  return {
    ask: async (question, fallback) => {
      const suffix = fallback === "" ? "" : ` [${fallback}]`;
      process.stdout.write(`${question}${suffix}: `);
      const line = await nextLine();
      if (line === null) {
        process.stdout.write("\n");
        return fallback;
      }
      const answer = line.trim();
      return answer === "" ? fallback : answer;
    },
    log: (line) => console.log(line),
    warn: (line) => console.error(line),
    close: () => rl.close(),
  };
}

/** The ask that refuses to ask, for `--yes` and for the Restart handoff. */
export function silentAsk(): Ask {
  return async (_question, fallback) => fallback;
}

/** Where the engine lives: the machine default when set, else this checkout. */
export function engineCheckout(configured: string | undefined): string {
  if (configured && existsSync(configured)) return configured;
  return dirname(import.meta.dir);
}

/**
 * Which Pool, and say why. The interactive branches are the only reason
 * this is not simply `resolvePool`: several pools under one `.scratch/` is a
 * choice, and no pool at all is a name.
 */
async function choosePool(
  args: BootArgs,
  io: BootIo,
): Promise<{ dir: string; created: boolean } | { error: string }> {
  const repo = realRepoProbe();
  const resolution = resolvePool({
    explicit: args.poolDir ? resolve(args.poolDir) : undefined,
    cwd: process.cwd(),
    repo,
  });
  if (resolution.kind === "no-repo") {
    return {
      error:
        `${resolution.cwd} is not a pool and not inside a git checkout. ` +
        "A pool lives beside the checkout its attempts branch from, so run " +
        "this from a project or name the pool directory.",
    };
  }
  if (resolution.kind === "found") {
    io.log(`pool: ${resolution.dir} (${resolution.why})`);
    // A pool found or named under a project's `.scratch/` gets the same
    // exclude line a created one does. The directory is this machine's
    // working material either way, and the line is missing exactly when the
    // first pool was made by hand rather than by Boot.
    excludeScratch(resolution.dir, io);
    return { dir: resolution.dir, created: false };
  }
  if (resolution.kind === "several") {
    if (args.yes) {
      return {
        error:
          `several pools under ${resolution.scratch}; name the one you want:\n` +
          resolution.candidates.map((dir) => `  ${dir}`).join("\n"),
      };
    }
    io.log(`pools under ${resolution.scratch}:`);
    resolution.candidates.forEach((dir, index) => {
      io.log(`  ${index + 1}. ${poolName(dir)}`);
    });
    const picked = await io.ask("which pool", "1");
    const index = Number(picked) - 1;
    const dir = resolution.candidates[index];
    if (!dir) return { error: `no pool numbered ${picked}` };
    io.log(`pool: ${dir} (chosen)`);
    return { dir, created: false };
  }
  const name = args.yes
    ? resolution.suggested
    : await io.ask("name for the new pool", resolution.suggested);
  const slug = slugify(name) || resolution.suggested;
  const top = dirname(resolution.scratch);
  const { dir, excluded } = createPool(resolution.scratch, slug, gitDirOf(top));
  io.log(`pool: ${dir} (created, ${resolution.why})`);
  if (excluded === "added") io.log(`added .scratch/ to ${top}/.git/info/exclude`);
  else if (excluded === "unavailable") {
    io.warn(`could not write ${top}/.git/info/exclude; add .scratch/ to it yourself`);
  }
  return { dir, created: true };
}

/**
 * Keep `.scratch/` out of the project's history when the pool lives there.
 * A pool somewhere else is the operator's own arrangement and is left alone.
 */
function excludeScratch(poolDir: string, io: BootIo): void {
  const scratch = dirname(poolDir);
  if (basename(scratch) !== ".scratch") return;
  const top = gitLine(nearestExisting(poolDir), ["rev-parse", "--show-toplevel"]);
  if (!top || dirname(scratch) !== top) return;
  if (ensureScratchExcluded(gitDirOf(top)) === "added") {
    io.log(`added .scratch/ to ${top}'s git exclude file`);
  }
}

/** What detection found, in one short brief, because Boot asks nothing about it. */
function reportDetection(io: BootIo, detection: Detection): void {
  io.log(
    `detected: ${detection.tickets} ticket(s)` +
      `, conversations/ ${detection.conversations ? "present" : "absent"}` +
      `, context files ${detection.contextFiles.join(", ") || "none"}` +
      `, commit prefix ${detection.commitPrefix ?? "none"}`,
  );
  io.log(
    `detected: harnesses ${detection.harnesses.join(", ") || "none on PATH"}` +
      `, herdr ${detection.herdr.binary ? "installed" : "absent"}` +
      `/${detection.herdr.socket ? "socket live" : "no socket"}` +
      `, port 8787 ${detection.defaultPortFree ? "free" : "busy"}` +
      `, engine ${detection.engineDir}`,
  );
}

interface InterviewInput {
  io: BootIo;
  /** Every source merged, which is what each question offers as its default. */
  prefill: Prefill;
  /** Config, Setup and Machine defaults only: a settled field is not asked. */
  settled: Prefill;
  detection: Detection;
  /** Take every default without asking. */
  unattended: boolean;
}

export interface InterviewResult {
  answers: BootAnswers;
  seeded: boolean;
  /** Whether any question was actually put to the operator. */
  asked: boolean;
  /** A field the unattended path could not fill, which is fatal. */
  missing: string[];
}

/** The example the skill recommended, kept as this question's default. */
const CHECKPOINT_EXAMPLE =
  "a device, an external write, an undecided decision, or a material guess";

export async function interview(input: InterviewInput): Promise<InterviewResult> {
  const { io, prefill, settled, detection } = input;
  const answers: BootAnswers = {};
  let asked = false;

  const put = async (question: string, fallback: string): Promise<string> => {
    if (input.unattended) return fallback;
    asked = true;
    return io.ask(question, fallback);
  };

  // The pool kind, and only when the disk cannot say. A directory holding
  // tickets is a ticket pool and a directory holding conversations/ is a
  // Seeded Pool; an empty one means opposite things on the two paths and
  // only the operator knows which (ADR-0024).
  let seeded = prefill.seeded ?? true;
  if (detection.tickets === 0 && !detection.conversations) {
    const answer = await put("pool kind, ticket or seeded", "seeded");
    seeded = !answer.toLowerCase().startsWith("t");
  }

  // A field a prefill settled is not asked, but it is still written: the
  // Pool carries its own config as data, so a default that came from the
  // machine or from a Setup has to land in this pool's file rather than
  // being looked up again at every boot.
  for (const key of ["harness", "model", "drivers", "reviewer", "checkpoint", "roster", "agents"] as const) {
    const value = settled[key];
    if (value !== undefined) answers[key] = value;
  }
  if (settled.resolver !== undefined) answers.resolver = settled.resolver;

  if (settled.harness === undefined) {
    for (;;) {
      const harness = await put(
        `default harness (${KNOWN_HARNESSES.join("/")})`,
        prefill.harness ?? detection.harnesses[0] ?? "",
      );
      if (harness === "") break;
      if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
        io.warn(`the engine has no descriptor for ${harness}; pick one of ${KNOWN_HARNESSES.join(", ")}`);
        if (input.unattended) break;
        continue;
      }
      if (!detection.harnesses.includes(harness)) {
        io.warn(`${harness} is not on PATH; the first attempt will fail until it is`);
      }
      answers.harness = harness;
      break;
    }
  }
  if (settled.model === undefined) {
    const model = await put("default model", prefill.model ?? "");
    if (model !== "") answers.model = model;
  }
  if (settled.drivers === undefined) {
    const drivers = await put("drivers (space separated chain)", prefill.drivers ?? "implement");
    if (drivers !== "") answers.drivers = drivers;
  }
  if (settled.resolver === undefined) {
    const fallback = resolverText(prefill.resolver) || answers.harness || prefill.harness || "none";
    const resolver = await put("merge resolver harness (or none)", fallback);
    if (resolver !== "") answers.resolver = resolver;
  }
  if (settled.reviewer === undefined) {
    const reviewer = await put("reviewer and its authority (blank for none)", prefill.reviewer ?? "");
    if (reviewer !== "") answers.reviewer = reviewer;
  }
  if (settled.checkpoint === undefined) {
    const checkpoint = await put(
      "what counts as a checkpoint here",
      prefill.checkpoint ?? CHECKPOINT_EXAMPLE,
    );
    if (checkpoint !== "") answers.checkpoint = checkpoint;
  }
  if (settled.roster === undefined) {
    const roster = await put("subagent roster (blank for none)", prefill.roster ?? "");
    if (roster !== "") answers.roster = roster;
  }
  if (settled.agents === undefined) {
    for (;;) {
      const agents = await put("agents JSON for claude's --agents (blank for none)", prefill.agents ?? "");
      if (agents === "") break;
      if (!parsesAsObject(agents)) {
        io.warn("that is not a JSON object; agents must parse as one");
        if (input.unattended) break;
        continue;
      }
      answers.agents = agents;
      break;
    }
  }
  if (settled.port === undefined) {
    for (;;) {
      const port = await put("port to pin (auto for 8787 or next free)", portText(prefill.port));
      if (port === "" || port.toLowerCase() === "auto") {
        // Only an explicit answer clears an existing pin; leaving the
        // question alone on a pool that had none is not a change.
        if (prefill.port !== undefined) answers.port = "auto";
        break;
      }
      const parsed = Number(port);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        io.warn("a port is an integer 0-65535, or auto");
        if (input.unattended) break;
        continue;
      }
      answers.port = parsed;
      break;
    }
  } else if (prefill.port !== undefined) {
    answers.port = prefill.port;
  }
  if (settled.terminal === undefined) {
    const backed = await put(
      "terminal-backed attempts in herdr tabs (yes/no)",
      prefill.terminal === "herdr" ? "yes" : "no",
    );
    answers.terminal = backed.toLowerCase().startsWith("y") ? "herdr" : "none";
  } else {
    answers.terminal = "herdr";
  }

  const harness = answers.harness ?? settled.harness ?? prefill.harness;
  const model = answers.model ?? settled.model ?? prefill.model;
  const missing: string[] = [];
  if (!harness) missing.push("harness");
  if (!model) missing.push("model");
  return { answers, seeded, asked, missing };
}

/** The pool's prose files, written once and never overwritten afterwards. */
function writeProseFiles(
  poolDir: string,
  engineDir: string,
  io: BootIo,
  fill: { detection: Detection; reviewer?: string | undefined; checkpoint?: string | undefined },
): void {
  const templates = join(engineDir, "skills", "my-console-runner");
  const agentPath = join(poolDir, "AGENT.md");
  if (existsSync(agentPath)) {
    io.log("AGENT.md is already there; left as it is");
  } else {
    const template = join(templates, "AGENT.template.md");
    if (existsSync(template)) {
      writeFileSync(
        agentPath,
        fillAgentTemplate(readFileSync(template, "utf8"), {
          contextFiles: fill.detection.contextFiles,
          commitPrefix: fill.detection.commitPrefix,
          reviewer: fill.reviewer,
          checkpoint: fill.checkpoint,
        }),
      );
      io.log("wrote AGENT.md from the template");
    } else io.warn(`no AGENT.template.md under ${templates}; wrote no AGENT.md`);
  }
  const verifyPath = join(poolDir, "verify.md");
  if (existsSync(verifyPath)) {
    io.log("verify.md is already there; left as it is");
  } else {
    const template = join(templates, "verify.template.md");
    if (existsSync(template)) {
      copyFileSync(template, verifyPath);
      io.log("wrote verify.md from the template");
    }
  }
}

/** Offer to keep this pool's behavioural slice for the next pool. */
async function offerSetup(
  io: BootIo,
  config: Record<string, unknown>,
  home: string,
): Promise<void> {
  const name = await io.ask("save this Setup as (blank to skip)", "");
  if (name === "") return;
  const slug = slugify(name);
  if (slug === "") {
    io.warn("that name slugifies to nothing; saved no Setup");
    return;
  }
  const path = setupPath(slug, home);
  if (existsSync(path)) {
    const confirm = await io.ask(`${slug} already exists; replace it (yes/no)`, "no");
    if (!confirm.toLowerCase().startsWith("y")) {
      io.log("left the existing Setup alone");
      return;
    }
  }
  io.log(`saved Setup ${slug} to ${writeSetup(slug, setupFromConfig(config), home)}`);
}

export interface RunOptions {
  argv: string[];
  io: BootIo;
  home?: string;
}

/** The whole of Boot, returning the exit code rather than taking it. */
export async function runBoot(options: RunOptions): Promise<number> {
  const { io } = options;
  const home = options.home ?? homedir();
  const parsed = parseBootArgs(options.argv);
  if (!parsed.ok) {
    if (parsed.help) {
      io.log(parsed.message);
      return 0;
    }
    io.warn(parsed.message);
    return 1;
  }
  const args = parsed.args;
  const machine = readMachineDefaults(defaultMachineDefaultsPaths(home));
  const engineDir = engineCheckout(machine.engine);

  const chosen = await choosePool(args, io);
  if ("error" in chosen) {
    io.warn(chosen.error);
    return 1;
  }
  const poolDir = chosen.dir;

  let existingConfig: Record<string, unknown>;
  try {
    existingConfig = readConsoleConfig(poolDir);
  } catch (err) {
    io.warn(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const hadConfig = existsSync(join(poolDir, "console.json"));

  // A pool named on the command line may not exist yet, so the checkout
  // question is asked at the nearest directory that does.
  const repoDir =
    gitLine(nearestExisting(poolDir), ["rev-parse", "--show-toplevel"]) ??
    gitLine(process.cwd(), ["rev-parse", "--show-toplevel"]) ??
    poolDir;
  const detection = await detect({ poolDir, repoDir, engineDir, home });
  reportDetection(io, detection);

  // The Setup, chosen or named. Only a pool with no config of its own is
  // offered one: a configured pool already answered these questions.
  let setup: Record<string, unknown> | null = null;
  if (args.setup) {
    setup = readSetup(args.setup, home);
    if (!setup) {
      io.warn(`no Setup named ${args.setup} under ~/.agent-graphs/setups/`);
      return 1;
    }
    io.log(`starting from Setup ${args.setup}`);
  } else if (!hadConfig && !args.yes && !args.relaunch) {
    const names = listSetups(home);
    if (names.length > 0) {
      io.log(`Setups: ${names.join(", ")}`);
      const picked = await io.ask("start from which Setup (none to skip)", "none");
      if (picked.toLowerCase() !== "none") {
        setup = readSetup(picked, home);
        if (!setup) io.warn(`no Setup named ${picked}; carrying on un-prefilled`);
      }
    }
  }

  const settled = mergePrefill([
    prefillFromConfig(existingConfig),
    ...(setup ? [prefillFromSetup(setup)] : []),
    prefillFromMachineDefaults(machine),
  ]);
  const prefill = mergePrefill([settled, prefillFromDetection(detection)]);

  const unattended = args.yes || args.relaunch;
  const result = await interview({ io, prefill, settled, detection, unattended });
  if (unattended && result.missing.length > 0 && !args.relaunch) {
    io.warn(
      `nothing prefilled the ${result.missing.join(" and ")}; ` +
        "set it in ~/.agent-graphs/defaults.json, pass --setup, or boot without --yes",
    );
    return 1;
  }

  if (!args.relaunch) {
    mkdirSync(join(poolDir, "issues"), { recursive: true });
    if (result.seeded) mkdirSync(join(poolDir, "conversations"), { recursive: true });
    const merged = mergeConsoleConfig(existingConfig, result.answers);
    // A relaunch whose answers all came from the file itself has nothing to
    // write; saying "wrote" then would read as a change the operator did
    // not make.
    if (JSON.stringify(merged) !== JSON.stringify(existingConfig)) {
      writeConsoleConfig(poolDir, merged);
      io.log(`wrote ${join(poolDir, "console.json")}`);
    }
    if (result.asked || !hadConfig) {
      writeProseFiles(poolDir, engineDir, io, {
        detection,
        reviewer: (merged.reviewer as string | undefined) ?? undefined,
        checkpoint: (merged.checkpoint as string | undefined) ?? undefined,
      });
    }
    if (!args.yes) await offerSetup(io, merged, home);
    writeMachineDefaultsOnce(io, home, {
      harness: (merged.defaults as Record<string, string> | undefined)?.harness,
      model: (merged.defaults as Record<string, string> | undefined)?.model,
      drivers: (merged.defaults as Record<string, string> | undefined)?.drivers,
      terminal: merged.terminal === "herdr" ? "herdr" : undefined,
      engine: engineDir,
    });
  }

  if (needsRebuild(distMtime(engineDir), uiSourceCommitMs(engineDir))) {
    io.log("the Console build is missing or stale; rebuilding");
    if (!buildConsole(engineDir)) {
      io.warn("the Console build failed; fix it and boot again");
      return 1;
    }
  }

  if (args.relaunch) {
    const release = await waitForPidRelease(pidWaitDeps(poolDir));
    if (!release.released) {
      io.warn(
        `the previous server (pid ${release.pid}) still holds ${join(poolDir, "runs", "server.pid")}; ` +
          "it did not release the pool in 15s",
      );
      return 1;
    }
  }

  return startAndReport(poolDir, engineDir, args, io);
}

async function startAndReport(
  poolDir: string,
  engineDir: string,
  args: BootArgs,
  io: BootIo,
): Promise<number> {
  const runs = join(poolDir, "runs");
  mkdirSync(runs, { recursive: true });
  const logPath = join(runs, "server.log");
  // Truncated so the boot line the poll reads is always this boot's.
  writeFileSync(logPath, "");
  const server = startServer({ engineDir, poolDir, port: args.port, logPath });
  const verdict = await waitForBoot(logPath, server);
  if (verdict.kind !== "up") {
    io.warn(
      verdict.kind === "exited"
        ? "the engine refused or failed at boot; its message:"
        : "the server has not printed its boot line; the log so far:",
    );
    io.warn(verdict.tail || "(the log is empty)");
    return 1;
  }
  const url = `http://localhost:${verdict.port}`;
  if (!(await waitForState(url))) {
    io.warn(`${url} is up but /api/state has not answered; see ${logPath}`);
  }
  if (args.open) openBrowser(url);
  io.log(`Console on ${url}`);
  io.log(`log: ${logPath}`);
  io.log(`to stop: kill $(cat ${join(runs, "server.pid")})`);
  return 0;
}

/**
 * Machine defaults are written once, by the first Boot on a machine that
 * has none, and never again from here. After that the Console's Settings
 * pane owns the file, and a Boot that rewrote it would quietly promote one
 * pool's choices over what the operator set.
 */
function writeMachineDefaultsOnce(
  io: BootIo,
  home: string,
  values: {
    harness?: string | undefined;
    model?: string | undefined;
    drivers?: string | undefined;
    terminal?: "herdr" | undefined;
    engine: string;
  },
): void {
  const file = defaultMachineDefaultsPath(home);
  if (existsSync(file)) return;
  try {
    writeMachineDefaults(
      {
        ...(values.harness ? { harness: values.harness } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.drivers ? { drivers: values.drivers } : {}),
        ...(values.terminal ? { terminal: values.terminal } : {}),
        engine: values.engine,
      },
      file,
    );
    io.log(`wrote machine defaults to ${file}; the Console's Settings own it from now on`);
  } catch (err) {
    io.warn(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `bun install` then `bun run build` in the engine's `ui/`, output and all. */
function buildConsole(engineDir: string): boolean {
  const ui = join(engineDir, "ui");
  for (const args of [["install"], ["run", "build"]]) {
    const run = Bun.spawnSync({
      cmd: ["bun", ...args],
      cwd: ui,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (run.exitCode !== 0) return false;
  }
  return true;
}

function resolverText(value: ResolverValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return value.harness ?? "";
}

function portText(port: number | undefined): string {
  return port === undefined ? "auto" : String(port);
}

function parsesAsObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const unattended = argv.includes("--yes") || argv.includes("-y") || argv.includes("--relaunch");
  const io = unattended
    ? {
        ask: silentAsk(),
        log: (line: string) => console.log(line),
        warn: (line: string) => console.error(line),
        close: () => {},
      }
    : await terminalIo();
  let code = 1;
  try {
    code = await runBoot({ argv, io });
  } catch (err) {
    io.warn(err instanceof Error ? err.message : String(err));
  } finally {
    io.close();
  }
  process.exit(code);
}
