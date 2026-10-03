import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnlistedAttempts, type EnlistedHost } from "./enlisted.ts";
import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
} from "../conformance/fixtures/herdr-executing-fake.ts";
import { createPaneReadRegister } from "./pane-reads.ts";

// The enlisted-attempts module on its own (engine/enlisted.ts), against the
// executing fake daemon with an operator-opened pane seeded on it, the way
// the enlist picker finds one. Registration with `teaching: null` (a boot
// re-adoption's shape) is the claim with no Turn to type, so every read the
// fake sees is the module's own Turn-state read and nothing else's.

const OPENCODE_WAITING = "opencode\nctrl+p commands";
const OPENCODE_WORKING = "opencode\nworking on it";

const silentHost: EnlistedHost = {
  publish: () => {},
  ended: () => {},
  trailingExit: () => {},
};

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("enlisted attempts read the viewport and record it (issue #122)", () => {
  const fakes: ExecutingFakeHerdr[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    while (fakes.length > 0) await fakes.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function fakeWithPane(rendered: string): Promise<ExecutingFakeHerdr> {
    const fake = await startExecutingFakeHerdr();
    fakes.push(fake);
    fake.seedAgent({ paneId: "pane-op", agent: "opencode", rendered, cwd: "/tmp" });
    return fake;
  }

  function outcomePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "enlisted-test-"));
    dirs.push(dir);
    return join(dir, "outcome.json");
  }

  const registration = (teaching: string | null) => ({
    id: "enlist-1",
    paneId: "pane-op",
    tabId: null,
    harness: "opencode",
    title: "Do the thing",
    branch: "feature/x",
    directory: "/tmp",
    outcomePath: outcomePath(),
    teaching,
  });

  it("every Turn-state read is of the viewport only, and the register holds the latest one until release", async () => {
    const fake = await fakeWithPane(OPENCODE_WAITING);
    const paneReads = createPaneReadRegister();
    const enlisted = createEnlistedAttempts(
      { herdrSocket: fake.socketPath, paneReads, pollMs: 20 },
      silentHost,
    );

    expect(await enlisted.register(registration(null))).toEqual({ ok: true });
    // The claim's settling reads already recorded what the pane shows.
    expect(paneReads.latest("pane-op")).toEqual({
      text: OPENCODE_WAITING,
      at: expect.any(String),
    });

    // The tick keeps the entry current.
    fake.setPaneContent("pane-op", "opencode\nstill here\nctrl+p commands");
    await waitFor(
      () => paneReads.latest("pane-op")?.text.includes("still here") ?? false,
      "the tick to record the new frame",
    );

    // Not one read reached into scrollback: the operator sits in this pane,
    // and a `recent` read moves their viewport. `visible` takes no line
    // count, so none is sent.
    const reads = fake.requests.filter((r) => r.method === "pane.read");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.params).toEqual({
        pane_id: "pane-op",
        source: "visible",
        format: "text",
        strip_ansi: true,
      });
    }

    // Release stops the tick, and the entry goes with it: nothing watches
    // the pane now, so nothing may serve a viewport frozen at the last tick.
    enlisted.release("enlist-1");
    expect(paneReads.latest("pane-op")).toBeNull();
  });

  it("a refused claim leaves no entry behind, though its settling reads recorded", async () => {
    // A pane still working past the teaching bound: the claim is refused
    // (spec, "Failed enlist leaves nothing") and no tick follows, so the
    // reads it made must not be served either.
    const fake = await fakeWithPane(OPENCODE_WORKING);
    const paneReads = createPaneReadRegister();
    const enlisted = createEnlistedAttempts(
      { herdrSocket: fake.socketPath, paneReads, pollMs: 10, teachingWaitMs: 40 },
      silentHost,
    );

    const result = await enlisted.register(registration("teach me"));
    expect(result.ok).toBe(false);
    expect(fake.requests.some((r) => r.method === "pane.read")).toBe(true);
    expect(paneReads.latest("pane-op")).toBeNull();
  });

  it("a pane the daemon refuses to read is refused without an entry, and dispose forgets a live one", async () => {
    const fake = await fakeWithPane(OPENCODE_WAITING);
    const paneReads = createPaneReadRegister();
    const enlisted = createEnlistedAttempts(
      { herdrSocket: fake.socketPath, paneReads, pollMs: 20 },
      silentHost,
    );

    fake.fail.add("pane.read");
    const refused = await enlisted.register(registration(null));
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("could not be read");
    expect(paneReads.latest("pane-op")).toBeNull();

    fake.fail.clear();
    expect(await enlisted.register(registration(null))).toEqual({ ok: true });
    expect(paneReads.latest("pane-op")).not.toBeNull();
    // The engine's shutdown: every tick stops, every entry goes.
    enlisted.dispose();
    expect(paneReads.latest("pane-op")).toBeNull();
  });
});
