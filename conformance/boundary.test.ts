/**
 * The conformance boundary, made a test (ADR-0036): conformance/ imports
 * nothing from the engine but types, and those only from protocol/protocol.ts
 * and protocol/wire.ts, which the Rust types generate. The suite judges the
 * server by what it does, so it may lean on the wire's shapes and on nothing
 * that runs inside the server it tests, not even the protocol's constants,
 * which the cases restate.
 *
 * Two checks over every file. The statements: an import or re-export that
 * names a file under protocol/ must be `import type` or `export type` (an
 * inline `{ type X }` still loads the module under verbatimModuleSyntax),
 * and nothing may name a file under engine/, the TypeScript engine. And
 * Bun's own scan of what a file loads when it runs, which also sees
 * `import()` and `require`: none of it may come from either.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CONFORMANCE_DIR = import.meta.dir;
const ROOT = resolve(CONFORMANCE_DIR, "..");
const GUARDED = ["protocol", "engine"].map((dir) => join(ROOT, dir));
const TYPE_SOURCES = new Set(["protocol/protocol.ts", "protocol/wire.ts"]);
const NEITHER = "protocol/protocol.ts nor protocol/wire.ts";

/** Where a specifier lands under protocol/ or engine/, as `<dir>/<file>`, or null when it lands elsewhere. */
function guardedTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !isAbsolute(specifier)) return null;
  const target = isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier);
  if (!GUARDED.some((dir) => target.startsWith(dir + sep))) return null;
  const name = relative(ROOT, target).split(sep).join("/");
  return /\.[cm]?[jt]sx?$/.test(name) ? name : `${name}.ts`;
}

/** The file with comment lines dropped, so prose about imports is not a hit. */
function codeOf(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const STATEMENT = /^(import|export)(\s+type)?\b([^;]*?)\bfrom\s*["']([^"']+)["']/gm;
const BARE_IMPORT = /^import\s*["']([^"']+)["']/gm;
const DYNAMIC = /(\btypeof\s+)?\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Every way `source` (the text of `file`) crosses the boundary, described. */
export function boundaryViolations(file: string, source: string): string[] {
  const out: string[] = [];
  const code = codeOf(source);
  for (const match of code.matchAll(STATEMENT)) {
    const target = guardedTarget(file, match[4]!);
    if (target === null) continue;
    if (match[2] === undefined) out.push(`${match[1]} of ${target} is not type-only (write \`${match[1]} type\`)`);
    else if (!TYPE_SOURCES.has(target)) out.push(`types from ${target}, which is neither ${NEITHER}`);
  }
  for (const match of code.matchAll(BARE_IMPORT)) {
    const target = guardedTarget(file, match[1]!);
    if (target !== null) out.push(`import of ${target} for its side effects`);
  }
  for (const match of code.matchAll(DYNAMIC)) {
    const target = guardedTarget(file, match[2]!);
    if (target === null) continue;
    if (match[1] === undefined) out.push(`import() of ${target}`);
    else if (!TYPE_SOURCES.has(target)) out.push(`types from ${target}, which is neither ${NEITHER}`);
  }
  for (const match of code.matchAll(REQUIRE)) {
    const target = guardedTarget(file, match[1]!);
    if (target !== null) out.push(`require of ${target}`);
  }
  for (const loaded of transpiler.scanImports(source)) {
    const target = guardedTarget(file, loaded.path);
    if (target !== null) out.push(`loads ${target} at run time (${loaded.kind})`);
  }
  return [...new Set(out)];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("the conformance boundary", () => {
  it("holds for every file under conformance/", () => {
    // This file is left out: its samples below are the very imports it
    // looks for, and it imports nothing but Bun and Node itself.
    const offenders = sourceFiles(CONFORMANCE_DIR)
      .filter((path) => path !== import.meta.path)
      .flatMap((path) =>
        boundaryViolations(path, readFileSync(path, "utf8")).map(
          (violation) => `${relative(CONFORMANCE_DIR, path)}: ${violation}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  // The check checked: a sample file one level down, as the fixtures are.
  const sample = join(CONFORMANCE_DIR, "fixtures", "sample.ts");
  const shapes = (file: string) => `"../../protocol/${file}"`;
  const engine = (file: string) => `"../../engine/${file}"`;
  const line = (...parts: string[]) => parts.join(" ");

  it("lets through types from protocol.ts and wire.ts", () => {
    const source = [
      line("import", "type { ServerMessage }", "from", shapes("protocol.ts") + ";"),
      line("import", "type {\n  EnrichedSnapshot,\n  PoolConfig,\n}", "from", shapes("wire.ts") + ";"),
      line("export", "type { PushedSnapshot }", "from", shapes("protocol.ts") + ";"),
      line("type", "Wire = typeof", `import(${shapes("wire.ts")});`),
      line("import", "{ join }", "from", '"node:path";'),
      "// " + line("import", "{ HEARTBEAT_MS }", "from", shapes("protocol.ts")),
    ].join("\n");
    expect(boundaryViolations(sample, source)).toEqual([]);
  });

  it("catches every other way across", () => {
    const cases: [string, string][] = [
      [line("import", "{ HEARTBEAT_MS }", "from", shapes("protocol.ts") + ";"), "import of protocol/protocol.ts is not type-only"],
      [line("import", "{ type PoolConfig }", "from", shapes("wire.ts") + ";"), "import of protocol/wire.ts is not type-only"],
      [line("import", "type { PoolRun }", "from", engine("engine.ts") + ";"), "types from engine/engine.ts"],
      [line("import", "type { PoolConfig }", "from", engine("wire.ts") + ";"), "types from engine/wire.ts"],
      [line("export", "{ CLOSE_STOPPED }", "from", shapes("protocol.ts") + ";"), "export of protocol/protocol.ts is not type-only"],
      [line("export", "* from", engine("server.ts") + ";"), "export of engine/server.ts is not type-only"],
      [line("import", engine("herdr.ts") + ";"), "import of engine/herdr.ts for its side effects"],
      [line("const m = await", `import(${shapes("protocol.ts")});`), "import() of protocol/protocol.ts"],
      [line("type", "Run = typeof", `import(${engine("engine.ts")});`), "types from engine/engine.ts"],
      [line("const m =", `require(${shapes("wire.ts")});`), "require of protocol/wire.ts"],
    ];
    for (const [source, violation] of cases) {
      expect(boundaryViolations(sample, source).join("\n")).toContain(violation);
    }
  });
});
