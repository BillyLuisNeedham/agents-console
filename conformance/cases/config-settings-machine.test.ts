/**
 * Machine defaults (issue #121), seen from outside the server (ADR-0036):
 * what GET /api/settings reads from the world's own HOME, the JSON file
 * `~/.agent-graphs/defaults.json` over the two legacy runner files field by
 * field, and what PUT /api/settings/machine writes there, whole. Every world
 * has a HOME of its own, so nothing here reads or writes the operator's. The
 * inventory's ticket C20, area `config`; each case names the engine test it
 * came from.
 */

import { expect } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingsResponse } from "../../protocol/wire.ts";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { World } from "../harness/world.ts";
import { doneTicket, errorOf, restedSnapshot, settingsOf } from "./config-support.ts";

/** The Machine defaults file under the world's HOME. */
function defaultsFile(world: World): string {
  return join(world.home, ".agent-graphs", "defaults.json");
}

/** A started pool at rest, its one Ticket done, its HOME holding `homeFiles`. */
async function settledPool(t: Case, homeFiles: Record<string, string> = {}): Promise<{ world: World; server: CaseServer }> {
  const world = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  for (const [name, content] of Object.entries(homeFiles)) writeFileSync(join(world.home, name), content);
  const server = await t.start(world);
  await restedSnapshot(server);
  return { world, server };
}

function putMachine(server: CaseServer, defaults: Record<string, unknown>) {
  return server.http.put("/api/settings/machine", { defaults });
}

const ISSUE_RUNNER = { ".issue-runner": "harness=opencode\nmodel=oc/flash\n" };

// engine/machine-defaults.test.ts:19 machine defaults › reads nothing from an empty home
conformance("config", "Machine defaults read nothing from an empty HOME, and name the file under it", async (t) => {
  const { world, server } = await settledPool(t);

  expect((await settingsOf(server)).machine).toEqual({ path: defaultsFile(world), defaults: {}, own: {} });
});

// engine/machine-defaults.test.ts:23 machine defaults › falls back to the legacy runner files field by field
conformance("config", "Machine defaults fall back to the legacy runner files, field by field, owning none of it", async (t) => {
  const { server } = await settledPool(t, { ...ISSUE_RUNNER, ".console-runner": "engine=/repo\n" });

  const { machine } = await settingsOf(server);
  expect(machine.defaults).toEqual({ harness: "opencode", model: "oc/flash", engine: "/repo" });
  expect(machine.own).toEqual({});
});

// engine/machine-defaults.test.ts:34 machine defaults › lets the JSON file win over the legacy files, field by field
conformance("config", "a saved Machine defaults file wins over the legacy files field by field", async (t) => {
  const { server } = await settledPool(t, ISSUE_RUNNER);

  const answer = await putMachine(server, { harness: "claude", drivers: "implement", terminal: "herdr" });
  expect(answer.status, answer.text).toBe(200);

  const { machine } = await settingsOf(server);
  expect(machine.defaults).toEqual({ harness: "claude", model: "oc/flash", drivers: "implement", terminal: "herdr" });
  expect(machine.own).toEqual({ harness: "claude", drivers: "implement", terminal: "herdr" });
});

// engine/machine-defaults.test.ts:47 machine defaults › writes a whole file, dropping empty fields, and creates the directory
conformance("config", "a Machine defaults save writes the whole file, trimmed, empty fields dropped, making its directory", async (t) => {
  const { world, server } = await settledPool(t);
  // The server registers itself in ~/.agent-graphs/pools.json at boot, so the
  // directory goes now, for the save to make it again.
  rmSync(join(world.home, ".agent-graphs"), { recursive: true, force: true });

  const answer = await putMachine(server, {
    harness: " claude ",
    model: "",
    effort: " high ",
    drivers: "implement",
    engine: "/e",
  });
  expect(answer.status, answer.text).toBe(200);

  const written = { harness: "claude", effort: "high", drivers: "implement", engine: "/e" };
  const { machine } = answer.json<SettingsResponse>();
  expect(machine.own).toEqual(written);
  expect(machine.defaults).toEqual(written);
  expect(JSON.parse(readFileSync(defaultsFile(world), "utf8"))).toEqual(written);
});

// engine/machine-defaults.test.ts:83 machine defaults › rejects an illegal terminal and a non-string field
conformance("config", "a Machine defaults save refuses a terminal other than herdr and a field that is not text, writing nothing", async (t) => {
  const { world, server } = await settledPool(t);

  const refusals: [Record<string, unknown>, string][] = [
    [{ terminal: "tmux" }, 'machine defaults: terminal must be "herdr" (got "tmux")'],
    [{ harness: 3 }, "machine defaults: harness must be a string"],
    [{ effort: 3 }, "machine defaults: effort must be a string"],
  ];
  for (const [defaults, error] of refusals) {
    const answer = await putMachine(server, defaults);
    expect([defaults, answer.status]).toEqual([defaults, 400]);
    expect(errorOf(answer)).toBe(error);
    expect(existsSync(defaultsFile(world))).toBe(false);
  }

  // An empty terminal is no terminal.
  const answer = await putMachine(server, { terminal: "", harness: "claude" });
  expect(answer.status, answer.text).toBe(200);
  expect(JSON.parse(readFileSync(defaultsFile(world), "utf8"))).toEqual({ harness: "claude" });
});
