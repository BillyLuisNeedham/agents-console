/**
 * The CLI boundary rule, made a test (issue #105, ADR-0020): the engine
 * reads the environment only at its CLI entry, and the browser never sees
 * the judgement SDK. Static, over the source itself, so a new read cannot
 * slip in behind a comment.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ENGINE_DIR = import.meta.dir;
const UI_SRC = join(ENGINE_DIR, "..", "ui", "src");

/** The engine files that may read `process.env`, and why. */
const ENV_READERS = new Set([
  // The CLI boundary: HERDR_WORKSPACE_ID and TYPESAFE_API_KEY become options here.
  "server.ts",
  // The child harness environment is the parent's, plus PWD; and the spawn
  // event records the delta against it.
  "spawn.ts",
  // claude's config file is found the way claude's own process finds it,
  // from CLAUDE_CONFIG_DIR: the variable is claude's, not the engine's, and
  // resolving it where the seed lands is what lets the test preload fence
  // every suite off the operator's real file (issue #127, ADR-0025).
  "claude-trust.ts",
  // The daemon's socket follows HERDR_SOCKET_PATH, herdr's own variable,
  // for the same reason: it is what lets the test preload keep every suite
  // out of the operator's live herdr.
  "herdr.ts",
  // The test preload sets both variables for every test run.
  "test-preload.ts",
]);

/** The engine files that may import the judgement SDK: the port and its wire fake. */
const SDK_IMPORTERS = new Set(["jev.ts", "jev-fake.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "dist") out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The file with comment lines dropped, so prose about the rule is not a hit. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

describe("the CLI boundary", () => {
  it("is the only place below which process.env is read", () => {
    const offenders = sourceFiles(ENGINE_DIR)
      .filter((path) => !ENV_READERS.has(path.slice(ENGINE_DIR.length + 1)))
      .filter((path) => /process\.env\b/.test(codeOf(path)))
      .map((path) => path.slice(ENGINE_DIR.length + 1));
    expect(offenders).toEqual([]);
  });

  it("is the only place the API key is named", () => {
    const offenders = sourceFiles(ENGINE_DIR)
      .filter((path) => /TYPESAFE_API_KEY/.test(codeOf(path)))
      .map((path) => path.slice(ENGINE_DIR.length + 1))
      .filter((name) => name !== "server.ts" && name !== "jev.ts");
    expect(offenders).toEqual([]);
  });
});

describe("the judgement SDK", () => {
  it("is imported only by the Jev port and its wire fake", () => {
    const offenders = sourceFiles(ENGINE_DIR)
      .filter((path) => /@typesafe-ai\/sdk/.test(codeOf(path)))
      .map((path) => path.slice(ENGINE_DIR.length + 1))
      .filter((name) => !SDK_IMPORTERS.has(name));
    expect(offenders).toEqual([]);
  });

  it("never reaches the browser", () => {
    const offenders = sourceFiles(UI_SRC).filter((path) =>
      /@typesafe-ai\/sdk|TYPESAFE_API_KEY/.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
