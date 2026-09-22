/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMachineDefaultsPaths,
  readMachineDefaults,
  validateMachineDefaults,
  writeMachineDefaults,
} from "./machine-defaults";

function home(): string {
  return mkdtempSync(join(tmpdir(), "machine-defaults-"));
}

describe("machine defaults", () => {
  it("reads nothing from an empty home", () => {
    expect(readMachineDefaults(defaultMachineDefaultsPaths(home()))).toEqual({});
  });

  it("falls back to the legacy runner files field by field", () => {
    const h = home();
    writeFileSync(join(h, ".issue-runner"), "harness=opencode\nmodel=oc/flash\n");
    writeFileSync(join(h, ".console-runner"), "engine=/repo\n");
    expect(readMachineDefaults(defaultMachineDefaultsPaths(h))).toEqual({
      harness: "opencode",
      model: "oc/flash",
      engine: "/repo",
    });
  });

  it("lets the JSON file win over the legacy files, field by field", () => {
    const h = home();
    const paths = defaultMachineDefaultsPaths(h);
    writeFileSync(join(h, ".issue-runner"), "harness=opencode\nmodel=oc/flash\n");
    writeMachineDefaults({ harness: "claude", drivers: "implement", terminal: "herdr" }, paths.file);
    expect(readMachineDefaults(paths)).toEqual({
      harness: "claude",
      model: "oc/flash",
      drivers: "implement",
      terminal: "herdr",
    });
  });

  it("writes a whole file, dropping empty fields, and creates the directory", () => {
    const h = home();
    const paths = defaultMachineDefaultsPaths(h);
    const written = writeMachineDefaults(
      { harness: " claude ", model: "", drivers: "implement", engine: "/e" },
      paths.file,
    );
    expect(written).toEqual({ harness: "claude", drivers: "implement", engine: "/e" });
    expect(JSON.parse(readFileSync(paths.file, "utf8"))).toEqual(written);
  });

  it("treats a malformed file as absent", () => {
    const h = home();
    const paths = defaultMachineDefaultsPaths(h);
    writeMachineDefaults({ harness: "claude" }, paths.file);
    writeFileSync(paths.file, "{ not json");
    expect(readMachineDefaults(paths)).toEqual({});
  });

  it("rejects an illegal terminal and a non-string field", () => {
    expect(() => validateMachineDefaults({ terminal: "tmux" })).toThrow(/terminal/);
    expect(() => validateMachineDefaults({ harness: 3 })).toThrow(/harness/);
    expect(validateMachineDefaults({ terminal: "", harness: "claude" })).toEqual({ harness: "claude" });
  });
});
