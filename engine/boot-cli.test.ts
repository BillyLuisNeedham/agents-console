/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPool,
  ensureScratchExcluded,
  freeSlug,
  isPoolDir,
  nearestExisting,
  poolChoiceLine,
  resolvePool,
  slugify,
  type RepoProbe,
} from "./boot-pool.ts";
import { commonCommitPrefix, contextFilesIn, type Detection } from "./boot-detect.ts";
import {
  CONFIG_MARKER,
  fillAgentTemplate,
  mergeConsoleConfig,
  mergePrefill,
  prefillFromConfig,
  prefillFromDetection,
  prefillFromMachineDefaults,
  prefillFromSetup,
  readConsoleConfig,
  readSetup,
  setupFromConfig,
  writeSetup,
} from "./boot-config.ts";
import {
  needsRebuild,
  parseBootLine,
  tailOf,
  waitForPidRelease,
} from "./boot-launch.ts";
import {
  interview,
  nameNewPool,
  parseBootArgs,
  type BootIo,
} from "./boot-cli.ts";

function temp(prefix = "boot-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function probe(top: string | null, branch: string | null = null): RepoProbe {
  return { toplevel: () => top, branch: () => branch };
}

/** A pool directory with tickets in it. */
function ticketPool(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "issues", "01-first.md"), "<!-- state: id=01 -->\n# First\n");
  return dir;
}

describe("pool resolution", () => {
  it("takes an explicit directory as given", () => {
    const resolution = resolvePool({
      explicit: "/tmp/named-pool",
      cwd: temp(),
      repo: probe(null),
    });
    expect(resolution).toMatchObject({ kind: "found", dir: "/tmp/named-pool" });
  });

  it("uses the working directory when it is itself a pool", () => {
    const root = temp();
    const pool = ticketPool(root, "here");
    const resolution = resolvePool({ cwd: pool, repo: probe(root) });
    expect(resolution).toMatchObject({ kind: "found", dir: pool });
  });

  it("counts a conversations directory as a pool, empty or not", () => {
    const root = temp();
    const pool = join(root, "seeded");
    mkdirSync(join(pool, "conversations"), { recursive: true });
    expect(isPoolDir(pool)).toBe(true);
  });

  it("picks the only pool under .scratch", () => {
    const top = temp();
    const pool = ticketPool(join(top, ".scratch"), "only");
    const resolution = resolvePool({ cwd: join(top, "src"), repo: probe(top) });
    expect(resolution).toMatchObject({ kind: "found", dir: pool });
  });

  it("offers a choice when .scratch holds several", () => {
    const top = temp();
    ticketPool(join(top, ".scratch"), "alpha");
    ticketPool(join(top, ".scratch"), "beta");
    const resolution = resolvePool({ cwd: top, repo: probe(top) });
    expect(resolution.kind).toBe("several");
    if (resolution.kind === "several") {
      expect(resolution.candidates).toHaveLength(2);
    }
  });

  it("suggests a name from the branch when there is no pool yet", () => {
    const top = temp();
    const resolution = resolvePool({ cwd: top, repo: probe(top, "feature/Add Boot Script") });
    expect(resolution).toMatchObject({
      kind: "create",
      suggested: "feature-add-boot-script",
    });
  });

  it("refuses when the working directory is not in a checkout", () => {
    const resolution = resolvePool({ cwd: temp(), repo: probe(null) });
    expect(resolution.kind).toBe("no-repo");
  });

  it("creates the pool and excludes .scratch without touching .gitignore", () => {
    const top = temp();
    Bun.spawnSync({ cmd: ["git", "init", "-q", top], stdout: "ignore", stderr: "ignore" });
    const { dir, excluded } = createPool(join(top, ".scratch"), "new-pool", join(top, ".git"));
    expect(existsSync(dir)).toBe(true);
    expect(excluded).toBe("added");
    expect(readFileSync(join(top, ".git", "info", "exclude"), "utf8")).toContain(".scratch/");
    expect(existsSync(join(top, ".gitignore"))).toBe(false);
    // Idempotent: a second boot finds the line already there.
    expect(ensureScratchExcluded(join(top, ".git"))).toBe("present");
  });

  it("falls back to the nearest existing ancestor for a pool not there yet", () => {
    const root = temp();
    expect(nearestExisting(join(root, "a", "b", "c"))).toBe(root);
    expect(nearestExisting(root)).toBe(root);
  });

  it("slugifies a name to something a directory can be called", () => {
    expect(slugify("My Pool_Name!")).toBe("my-pool-name");
    expect(slugify("feature/try-boot")).toBe("feature-try-boot");
    expect(slugify("  ")).toBe("");
  });
});

describe("Pool titles in Boot (issue #100)", () => {
  function pen(answers: Record<string, string>): BootIo & { asked: string[]; warned: string[] } {
    const asked: string[] = [];
    const warned: string[] = [];
    return {
      asked,
      warned,
      ask: async (question, fallback) => {
        asked.push(question);
        return answers[question] ?? fallback;
      },
      log: () => {},
      warn: (line) => warned.push(line),
    };
  }

  it("lists a titled pool by its title with the directory beside it", () => {
    const scratch = join(temp(), ".scratch");
    const titled = ticketPool(scratch, "jev-integration");
    writeFileSync(join(titled, "console.json"), JSON.stringify({ title: "Jev as the grader" }));
    const untitled = ticketPool(scratch, "other");
    expect(poolChoiceLine(titled)).toBe("Jev as the grader (jev-integration)");
    expect(poolChoiceLine(untitled)).toBe("other");
  });

  it("lists a pool whose config does not parse by its directory, rather than refusing the list", () => {
    const pool = ticketPool(join(temp(), ".scratch"), "broken");
    writeFileSync(join(pool, "console.json"), "{ not json");
    expect(poolChoiceLine(pool)).toBe("broken");
  });

  it("asks for the title first and derives the directory from it", async () => {
    const scratch = join(temp(), ".scratch");
    const io = pen({ "title for the new pool (blank for none)": "  Jev as the grader " });
    const named = await nameNewPool(io, { scratch, suggested: "feature-x", unattended: false });
    expect(io.asked).toEqual([
      "title for the new pool (blank for none)",
      "directory for the new pool",
    ]);
    expect(named).toEqual({ title: "Jev as the grader", slug: "jev-as-the-grader" });
  });

  it("keeps the branch's directory and no title when the title is left blank", async () => {
    const scratch = join(temp(), ".scratch");
    const named = await nameNewPool(pen({}), { scratch, suggested: "feature-x", unattended: false });
    expect(named).toEqual({ title: null, slug: "feature-x" });
  });

  it("takes a directory the operator types over the derived one", async () => {
    const scratch = join(temp(), ".scratch");
    const named = await nameNewPool(
      pen({
        "title for the new pool (blank for none)": "Jev as the grader",
        "directory for the new pool": "Jev Pool",
      }),
      { scratch, suggested: "feature-x", unattended: false },
    );
    expect(named).toEqual({ title: "Jev as the grader", slug: "jev-pool" });
  });

  it("never lands a new pool in a directory that is already there", async () => {
    const scratch = join(temp(), ".scratch");
    mkdirSync(join(scratch, "jev-as-the-grader"), { recursive: true });
    mkdirSync(join(scratch, "taken"), { recursive: true });
    expect(freeSlug(scratch, "jev-as-the-grader")).toBe("jev-as-the-grader-2");
    expect(freeSlug(scratch, "fresh")).toBe("fresh");

    const derived = await nameNewPool(
      pen({ "title for the new pool (blank for none)": "Jev as the grader" }),
      { scratch, suggested: "feature-x", unattended: false },
    );
    expect(derived.slug).toBe("jev-as-the-grader-2");

    const io = pen({ "directory for the new pool": "taken" });
    const typed = await nameNewPool(io, { scratch, suggested: "feature-x", unattended: false });
    expect(typed.slug).toBe("taken-2");
    expect(io.warned.join("\n")).toContain("using taken-2");
  });

  it("asks nothing unattended: no title, and the branch's directory", async () => {
    const scratch = join(temp(), ".scratch");
    const io = pen({});
    const named = await nameNewPool(io, { scratch, suggested: "feature-x", unattended: true });
    expect(io.asked).toEqual([]);
    expect(named).toEqual({ title: null, slug: "feature-x" });
  });

  it("writes the title into console.json beside the rest", () => {
    expect(mergeConsoleConfig({ port: 9001 }, { title: "Jev as the grader" })).toEqual({
      port: 9001,
      title: "Jev as the grader",
    });
    // A pool Boot did not create is never given a title it was not asked for.
    expect("title" in mergeConsoleConfig({ port: 9001 }, {})).toBe(false);
  });
});

describe("detection", () => {
  it("reads the commit prefix the repository actually writes", () => {
    expect(
      commonCommitPrefix(["feat: one", "fix: two", "feat: three", "no prefix here"]),
    ).toBe("feat");
  });

  it("answers null when the repository writes no prefix", () => {
    expect(commonCommitPrefix(["one", "two"])).toBeNull();
  });

  it("counts a scoped prefix as its type", () => {
    expect(commonCommitPrefix(["feat(ui): one", "feat(ui)!: two"])).toBe("feat");
  });

  it("lists pool context files and leaves the template's own out", () => {
    const pool = temp();
    for (const name of ["SPEC.md", "AGENT.md", "verify.md", "NOTES.md"]) {
      writeFileSync(join(pool, name), "x");
    }
    expect(contextFilesIn(pool)).toEqual(["NOTES.md", "SPEC.md"]);
  });
});

describe("prefill", () => {
  const detection: Detection = {
    tickets: 0,
    conversations: true,
    contextFiles: [],
    commitPrefix: null,
    harnesses: ["claude"],
    herdr: { binary: true, socket: true },
    defaultPortFree: true,
    engineDir: "/engine",
  };

  it("takes the pool config over the Setup, the Setup over machine defaults", () => {
    const merged = mergePrefill([
      prefillFromConfig({ defaults: { harness: "claude" } }),
      prefillFromSetup({ defaults: { harness: "cursor", model: "setup-model" }, resolver: "cursor" }),
      prefillFromMachineDefaults({ harness: "opencode", model: "machine-model", drivers: "implement" }),
      prefillFromDetection(detection),
    ]);
    expect(merged.harness).toBe("claude");
    expect(merged.model).toBe("setup-model");
    expect(merged.drivers).toBe("implement");
    expect(merged.resolver).toBe("cursor");
    expect(merged.terminal).toBe("herdr");
    expect(merged.seeded).toBe(true);
  });

  it("carries effort field-wise from the pool, the Setup and the machine", () => {
    const fromSetup = mergePrefill([
      prefillFromConfig({ defaults: { harness: "claude", model: "m" } }),
      prefillFromSetup({ defaults: { effort: "high" } }),
      prefillFromMachineDefaults({ effort: "low" }),
    ]);
    expect(fromSetup.effort).toBe("high");
    expect(fromSetup.model).toBe("m");
    expect(
      mergePrefill([prefillFromConfig({ defaults: { effort: "max" } }), prefillFromMachineDefaults({ effort: "low" })])
        .effort,
    ).toBe("max");
    expect(mergePrefill([prefillFromConfig({}), prefillFromMachineDefaults({ effort: "low" })]).effort).toBe(
      "low",
    );
  });

  it("never lets a Setup carry a port into the next pool", () => {
    expect(prefillFromSetup({ port: 9000 }).port).toBeUndefined();
    expect(prefillFromConfig({ port: 9000 }).port).toBe(9000);
  });
});

describe("console.json", () => {
  it("merges over the existing file and keeps assign and unknown keys", () => {
    const merged = mergeConsoleConfig(
      {
        defaults: { harness: "opencode", model: "old-model", drivers: "implement" },
        assign: { "04": { harness: "claude", verify: 2 } },
        selection: "human",
        port: 9001,
      },
      { harness: "claude", model: "new-model", terminal: "herdr" },
    );
    expect(merged.defaults).toEqual({
      harness: "claude",
      model: "new-model",
      drivers: "implement",
    });
    expect(merged.assign).toEqual({ "04": { harness: "claude", verify: 2 } });
    expect(merged.selection).toBe("human");
    // An effort the file already had survives answers that never name one.
    expect(
      mergeConsoleConfig({ defaults: { harness: "claude", effort: "high" } }, { model: "m" }).defaults,
    ).toEqual({ harness: "claude", effort: "high", model: "m" });
    expect(merged.port).toBe(9001);
    expect(merged.terminal).toBe("herdr");
  });

  it("removes the port pin on an explicit auto and the terminal key on a no", () => {
    const merged = mergeConsoleConfig(
      { port: 9001, terminal: "herdr" },
      { port: "auto", terminal: "none" },
    );
    expect("port" in merged).toBe(false);
    expect("terminal" in merged).toBe(false);
  });

  // ADR-0031: roster and agents are retired. A pool that still has them
  // boots as if it did not, and Boot's own write drops them, saying nothing.
  it("drops a retired roster and agents on write, and never prefills them", () => {
    const existing = {
      defaults: { harness: "claude", model: "m" },
      roster: "- deepseek",
      agents: '{"deepseek":{}}',
      reviewer: "r",
    };
    const merged = mergeConsoleConfig(existing, {});
    expect("roster" in merged).toBe(false);
    expect("agents" in merged).toBe(false);
    expect(merged.reviewer).toBe("r");
    const prefill = prefillFromConfig(existing) as Record<string, unknown>;
    expect(prefill.roster).toBeUndefined();
    expect(prefill.agents).toBeUndefined();
  });

  it("refuses a config that is there but does not parse", () => {
    const pool = temp();
    writeFileSync(join(pool, "console.json"), "{ not json");
    expect(() => readConsoleConfig(pool)).toThrow(/does not parse/);
  });
});

describe("AGENT.md", () => {
  const template = [
    "# Runner agent instructions",
    "",
    "The engine's half, identical in every runner.",
    "",
    CONFIG_MARKER,
    "",
    "Author everything below.",
    "",
    "## Which tickets are expected to stop",
  ].join("\n");

  it("leaves everything above the marker untouched and fills below it", () => {
    const filled = fillAgentTemplate(template, {
      contextFiles: ["SPEC.md"],
      commitPrefix: "feat",
      reviewer: "acceptance criteria only",
      checkpoint: "a device or an external write",
    });
    const head = filled.slice(0, filled.indexOf(CONFIG_MARKER));
    expect(head).toBe(template.slice(0, template.indexOf(CONFIG_MARKER)));
    expect(filled).toContain("- `SPEC.md`");
    expect(filled).toContain("feat: <what changed, in the imperative>");
    expect(filled).toContain("- reviewer: acceptance criteria only");
    expect(filled).toContain("- checkpoint: a device or an external write");
    expect(filled).toContain("## Which tickets are expected to stop");
    expect(filled).toContain("(name them, so a checkpoint on those reads as correct");
  });

  it("keeps the placeholder prefix when the repository writes none", () => {
    const filled = fillAgentTemplate(template, { contextFiles: [], commitPrefix: null });
    expect(filled).toContain("<prefix>: <what changed, in the imperative>");
    expect(filled).toContain("(none found beside `issues/`");
  });
});

describe("Setups", () => {
  it("saves the behavioural keys and never the pool-specific or retired ones", () => {
    const home = temp("setup-home-");
    const config = {
      defaults: { harness: "claude", model: "m" },
      assign: { "01": { harness: "cursor" } },
      roster: "- one",
      agents: "{}",
      resolver: "claude",
      terminal: "herdr",
      reviewer: "r",
      checkpoint: "c",
      port: 9001,
    };
    const file = writeSetup("My Build  Setup", setupFromConfig(config), home);
    expect(file).toBe(join(home, ".agent-graphs", "setups", "my-build-setup.json"));
    const saved = readSetup("my-build-setup", home);
    expect(Object.keys(saved ?? {}).sort()).toEqual([
      "checkpoint",
      "defaults",
      "resolver",
      "reviewer",
      "terminal",
    ]);
  });
});

describe("launch decisions", () => {
  it("rebuilds when there is no build and when the source is newer", () => {
    expect(needsRebuild(null, 1000)).toBe(true);
    expect(needsRebuild(1000, 2000)).toBe(true);
    expect(needsRebuild(2000, 1000)).toBe(false);
    expect(needsRebuild(2000, null)).toBe(false);
  });

  it("reads the port off the last boot line in the log", () => {
    const log = [
      "pool server on http://localhost:8787 (/pools/old)",
      "some other line",
      "pool server on http://localhost:8901 (/pools/new)",
    ].join("\n");
    expect(parseBootLine(log)).toBe(8901);
    expect(parseBootLine("nothing here")).toBeNull();
  });

  it("keeps the last lines of a log for a failed boot", () => {
    expect(tailOf("a\nb\n\nc\n", 2)).toBe("b\nc");
  });

  it("waits for the previous server to release the pool lock", async () => {
    let reads = 0;
    const release = await waitForPidRelease({
      readPid: () => (reads++ < 2 ? 4242 : null),
      isAlive: () => true,
      wait: async () => {},
      now: () => 0,
    });
    expect(release).toEqual({ released: true });
  });

  it("treats a lock left by a dead process as released", async () => {
    const release = await waitForPidRelease({
      readPid: () => 4242,
      isAlive: () => false,
      wait: async () => {},
      now: () => 0,
    });
    expect(release.released).toBe(true);
  });

  it("gives up naming the pid when a live server keeps the lock", async () => {
    let clock = 0;
    const release = await waitForPidRelease(
      {
        readPid: () => 4242,
        isAlive: () => true,
        wait: async () => {
          clock += 250;
        },
        now: () => clock,
      },
      1000,
    );
    expect(release).toEqual({ released: false, pid: 4242 });
  });
});

describe("flags", () => {
  it("accepts the positional pool and every flag", () => {
    const parsed = parseBootArgs([".scratch/x", "--yes", "--relaunch", "--port", "9001", "--no-open"]);
    expect(parsed).toEqual({
      ok: true,
      args: { poolDir: ".scratch/x", yes: true, relaunch: true, port: 9001, open: false },
    });
  });

  it("accepts --pool as the positional's long form", () => {
    const parsed = parseBootArgs(["--pool", "/pools/one", "--setup", "standard-build"]);
    expect(parsed).toMatchObject({ ok: true, args: { poolDir: "/pools/one", setup: "standard-build" } });
  });

  it("rejects a flag with no value and an unknown flag", () => {
    expect(parseBootArgs(["--port"]).ok).toBe(false);
    expect(parseBootArgs(["--nope"]).ok).toBe(false);
    expect(parseBootArgs(["--port", "abc"]).ok).toBe(false);
  });
});

describe("interview", () => {
  const detection: Detection = {
    tickets: 0,
    conversations: false,
    contextFiles: [],
    commitPrefix: null,
    harnesses: ["claude", "opencode"],
    herdr: { binary: true, socket: true },
    defaultPortFree: true,
    engineDir: "/engine",
  };

  function io(answers: Record<string, string>): BootIo & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      ask: async (question, fallback) => {
        asked.push(question);
        return answers[question] ?? fallback;
      },
      log: () => {},
      warn: () => {},
    };
  }

  it("asks the full interview when nothing is prefilled", async () => {
    const pen = io({
      "pool kind, ticket or seeded": "ticket",
      "default harness (claude/opencode/cursor)": "claude",
      "default model": "claude-opus-5",
    });
    const result = await interview({
      io: pen,
      prefill: { drivers: "implement", terminal: "herdr" },
      settled: {},
      detection,
      unattended: false,
    });
    expect(result.seeded).toBe(false);
    expect(result.asked).toBe(true);
    expect(result.answers.harness).toBe("claude");
    expect(result.answers.model).toBe("claude-opus-5");
    expect(result.answers.drivers).toBe("implement");
    expect(result.answers.terminal).toBe("herdr");
    expect(result.missing).toEqual([]);
    expect(pen.asked.some((question) => /roster|agents/.test(question))).toBe(false);
  });

  it("asks nothing for a field a prefill already settled", async () => {
    const pen = io({});
    const settled = { harness: "opencode", model: "m", effort: "high", drivers: "implement", resolver: "opencode", reviewer: "r", checkpoint: "c", port: 9001, terminal: "herdr" as const };
    const result = await interview({
      io: pen,
      prefill: { ...settled },
      settled,
      detection: { ...detection, tickets: 3 },
      unattended: false,
    });
    expect(pen.asked).toEqual([]);
    expect(result.asked).toBe(false);
    expect(result.answers.port).toBe(9001);
    // A settled field is not asked, but it is still written: the pool carries
    // its own config as data rather than looking the machine's up every boot.
    expect(mergeConsoleConfig({}, result.answers).defaults).toEqual({
      harness: "opencode",
      model: "m",
      effort: "high",
      drivers: "implement",
    });
  });

  it("names the fields it could not fill when it may not ask", async () => {
    const result = await interview({
      io: io({}),
      prefill: {},
      settled: {},
      detection: { ...detection, harnesses: [] },
      unattended: true,
    });
    expect(result.missing).toEqual(["harness", "model"]);
  });

  it("asks the pool kind only when the disk cannot answer it", async () => {
    const pen = io({});
    await interview({
      io: pen,
      prefill: { seeded: true },
      settled: { harness: "claude", model: "m", drivers: "d", resolver: "claude", reviewer: "r", checkpoint: "c", port: 1, terminal: "herdr" },
      detection: { ...detection, conversations: true },
      unattended: false,
    });
    expect(pen.asked).toEqual([]);
  });
});
