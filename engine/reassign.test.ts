/// <reference types="bun" />

/**
 * Reassign (issue #126). Two halves, both without a server: what the Console
 * may offer for each ticket, and what a save actually puts in console.json.
 * The second half is mostly about what a write leaves alone, for the same
 * reason the Settings pane's cases are: this is a second way to edit the
 * pool's own file, never a second copy of it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "./engine.ts";
import { defaultHarnesses, type HarnessCommand } from "./spawn.ts";
import type { AssignmentView } from "./assignment.ts";
import type { TicketMarker, TicketStatus } from "./pool.ts";
import {
  ConfigUnreadableError,
  reassignViews,
  writeReassign,
  type ReassignContext,
} from "./reassign.ts";
import { makeTempDir } from "./tmp.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const harnesses: Record<string, HarnessCommand> = {
  stub: () => ["stub"],
  claude: () => ["claude"],
};

function marker(id: string, extra: Partial<TicketMarker> = {}): TicketMarker {
  return {
    id,
    file: `${id}.md`,
    blockedBy: [],
    status: "ready",
    title: id,
    spec: "",
    ...extra,
  };
}

interface Options {
  live?: string[];
  statuses?: Record<string, TicketStatus>;
  configError?: string | null;
  /** The engine's own resolved records, for the frozen seed. */
  engine?: Record<string, AssignmentView>;
}

function views(
  markers: TicketMarker[],
  config: PoolConfig | null,
  options: Options = {},
) {
  return reassignViews({
    markers,
    config,
    configError: options.configError ?? null,
    harnesses,
    liveAttempts: new Set(options.live ?? []),
    statuses: options.statuses ?? {},
    engineAssignments: options.engine ?? {},
  });
}

/** A pool directory holding the given console.json (none when omitted). */
function pool(config?: Record<string, unknown>): string {
  const dir = makeTempDir("reassign-");
  dirs.push(dir);
  if (config) {
    writeFileSync(join(dir, "console.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

function onDisk(poolDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(poolDir, "console.json"), "utf8"));
}

function context(markers: TicketMarker[], options: Options = {}): ReassignContext {
  return {
    markers,
    harnesses,
    liveAttempts: new Set(options.live ?? []),
    statuses: options.statuses ?? {},
    engineAssignments: options.engine ?? {},
  };
}

const DEFAULTS = { harness: "stub", model: "m" };

describe("reassignViews: who may be reassigned", () => {
  it("offers an ordinary ticket with nothing running, and resolves it from the file", () => {
    const rows = views([marker("01")], {
      defaults: DEFAULTS,
      assign: { "01": { model: "opus" } },
    });

    const row = rows.get("01")!;
    expect(row.reassign.eligible).toBe(true);
    expect(row.reassign.reason).toBeNull();
    expect(row.assignment).toEqual({ harness: "stub", model: "opus", drivers: "implement" });
  });

  // Provenance comes from the resolver's own layer ordering, never from
  // comparing values: `model` here equals the default and is still pinned.
  it("names the layer each field came from, not the value it happens to match", () => {
    const rows = views([marker("01")], {
      defaults: DEFAULTS,
      assign: { "01": { model: "m" } },
    });

    expect(rows.get("01")!.reassign.sources).toEqual({
      harness: "default",
      model: "pinned",
      effort: "unset",
      drivers: "default",
    });
  });

  it("names the parent as the source of a spawned ticket's inherited fields", () => {
    const rows = views(
      [marker("01"), marker("01-spawn-1", { spawnedBy: "01" })],
      {
        defaults: DEFAULTS,
        assign: { "01": { harness: "claude", model: "opus" } },
      },
    );

    // Drivers too: the parent resolved to a real value, so the spawn takes
    // it from the parent rather than reaching past it to the defaults.
    expect(rows.get("01-spawn-1")!.reassign.sources).toEqual({
      harness: "inherited",
      model: "inherited",
      effort: "unset",
      drivers: "inherited",
    });
    expect(rows.get("01-spawn-1")!.assignment).toEqual({
      harness: "claude",
      model: "opus",
      drivers: "implement",
    });
  });

  it("reads an unassigned field as unset, with no defaults to fall back on", () => {
    const rows = views([marker("01")], {});
    expect(rows.get("01")!.reassign.sources).toEqual({
      harness: "unset",
      model: "unset",
      effort: "unset",
      drivers: "default",
    });
  });

  it("marks an effort not applied where the pool's launch mode cannot take it", () => {
    const rowsIn = (terminal: "herdr" | undefined) =>
      reassignViews({
        markers: [marker("01"), marker("02")],
        config: {
          ...(terminal ? { terminal } : {}),
          defaults: { harness: "claude", model: "m", effort: "high" },
          assign: { "02": { harness: "opencode" } },
        },
        configError: null,
        harnesses: defaultHarnesses,
        liveAttempts: new Set(),
        statuses: {},
        engineAssignments: {},
      });
    const headless = rowsIn(undefined);
    expect(headless.get("01")!.assignment).toMatchObject({ effort: "high", effortApplied: true });
    expect(headless.get("02")!.assignment).toMatchObject({ effort: "high", effortApplied: true });
    expect(headless.get("02")!.reassign.sources.effort).toBe("default");
    // opencode's TUI has no effort flag; claude's does.
    const backed = rowsIn("herdr");
    expect(backed.get("01")!.assignment).toMatchObject({ effort: "high", effortApplied: true });
    expect(backed.get("02")!.assignment).toMatchObject({ effort: "high", effortApplied: false });
  });

  it("carries the ticket's own verify, and nothing when the file has none", () => {
    const rows = views([marker("01"), marker("02")], {
      defaults: DEFAULTS,
      assign: { "01": { verify: 3 } },
    });
    expect(rows.get("01")!.reassign.verify).toBe(3);
    expect(rows.get("02")!.reassign.verify).toBeNull();
  });

  it("refuses the engine's own grader and head-to-head tickets", () => {
    const rows = views(
      [marker("01"), marker("01-grader-1"), marker("01-head-to-head")],
      { defaults: DEFAULTS },
    );

    for (const id of ["01-grader-1", "01-head-to-head"]) {
      expect(rows.get(id)!.reassign.eligible).toBe(false);
      expect(rows.get(id)!.reassign.reason).toBe(
        "the engine runs this one and assigns it from its build ticket",
      );
      expect(rows.get(id)!.assignment).toBeNull();
    }
  });

  it("refuses a ticket with an Attempt in flight, and keeps the engine's record", () => {
    const rows = views([marker("01")], { defaults: DEFAULTS }, { live: ["01"] });
    expect(rows.get("01")!.reassign.eligible).toBe(false);
    expect(rows.get("01")!.reassign.reason).toBe("an Attempt is running");
    // Null, so the server serves the engine's frozen record instead.
    expect(rows.get("01")!.assignment).toBeNull();
  });

  it("refuses a done ticket", () => {
    const rows = views([marker("01")], { defaults: DEFAULTS }, {
      statuses: { "01": "done" },
    });
    expect(rows.get("01")!.reassign.eligible).toBe(false);
    expect(rows.get("01")!.reassign.reason).toBe("done");
  });

  // Enlisted is a caveat, not a refusal: the save lands in the file and the
  // engine takes it up when it lets go of the pane.
  it("offers an enlisted ticket with a note rather than refusing it", () => {
    const rows = views([marker("e1", { enlistedFrom: "%3" })], { defaults: DEFAULTS });
    expect(rows.get("e1")!.reassign.eligible).toBe(true);
    expect(rows.get("e1")!.reassign.reason).toBe(
      "enlisted: only the harness can change, and it waits until the engine releases it",
    );
    expect(rows.get("e1")!.reassign.sources).toEqual({
      harness: "default",
      model: "unset",
      effort: "unset",
      drivers: "default",
    });
  });

  // The engine strips an enlisted ticket's verify whatever the file says, so
  // the Detail must not show one and offer to edit it.
  it("reports no verify on an enlisted ticket even when the file carries one", () => {
    const rows = views([marker("e1", { enlistedFrom: "%3" })], {
      defaults: DEFAULTS,
      assign: { e1: { verify: 3 } },
    });
    expect(rows.get("e1")!.reassign.verify).toBeNull();
  });

  // The engine's reload seeds every frozen ticket before resolving the rest
  // (ADR-0018), so a child of an in-flight parent inherits the frozen value,
  // not whatever the file's defaults now say.
  it("inherits an in-flight parent's frozen Assignment, not the file's new default", () => {
    const rows = views(
      [marker("01"), marker("01-spawn-1", { spawnedBy: "01" })],
      { defaults: { harness: "stub", model: "model-b" } },
      {
        live: ["01"],
        engine: {
          "01": { harness: "stub", model: "model-a", drivers: "implement" },
        },
      },
    );

    expect(rows.get("01-spawn-1")!.assignment).toEqual({
      harness: "stub",
      model: "model-a",
      drivers: "implement",
    });
    expect(rows.get("01-spawn-1")!.reassign.sources).toEqual({
      harness: "inherited",
      model: "inherited",
      effort: "unset",
      drivers: "inherited",
    });
  });

  // A seeded ticket is left exactly as the engine holds it, so an enlisted
  // ticket's card does not jump ahead of the engine letting it go.
  it("keeps an enlisted ticket's frozen record rather than re-resolving it", () => {
    const rows = views(
      [marker("e1", { enlistedFrom: "%3" })],
      { defaults: DEFAULTS, assign: { e1: { harness: "claude" } } },
      { engine: { e1: { harness: "stub", model: null, drivers: "implement" } } },
    );

    expect(rows.get("e1")!.assignment).toEqual({
      harness: "stub",
      model: null,
      drivers: "implement",
    });
  });

  // One ticket the file does not resolve is that ticket's trouble alone
  // (issue #159): the rest stay offered, and its reason names the cause.
  it("refuses only the ticket the config does not resolve, saying why", () => {
    const rows = views([marker("01"), marker("02")], {
      defaults: DEFAULTS,
      assign: { "02": { harness: "gemini" } },
    });

    expect(rows.get("01")!.reassign.eligible).toBe(true);
    expect(rows.get("01")!.reassign.reason).toBeNull();
    expect(rows.get("02")!.reassign.eligible).toBe(false);
    expect(rows.get("02")!.reassign.reason).toContain("the pool config does not resolve");
    expect(rows.get("02")!.reassign.reason).toContain("unknown harness 'gemini'");
  });

  it("refuses only a ticket whose parent has no Assignment, naming the parent", () => {
    // conv-3 is a Conversation the engine holds no Assignment for: nothing
    // seeds it, so its spawn cannot resolve, and that is the only casualty.
    const rows = views(
      [
        marker("01"),
        marker("conv-3-spawn-1", { spawnedBy: "conv-3" }),
        marker("conv-3-spawn-1-spawn-1", { spawnedBy: "conv-3-spawn-1" }),
      ],
      { defaults: DEFAULTS },
    );

    expect(rows.get("01")!.reassign.eligible).toBe(true);
    const orphan = rows.get("conv-3-spawn-1")!.reassign;
    expect(orphan.eligible).toBe(false);
    expect(orphan.reason).toContain("parent conv-3 has no Assignment");
    expect(orphan.reason).not.toContain("cycle");
    expect(rows.get("conv-3-spawn-1")!.assignment).toBeNull();
    // Its own child fails too, and says it is the parent, not a cycle.
    const grandchild = rows.get("conv-3-spawn-1-spawn-1")!.reassign;
    expect(grandchild.eligible).toBe(false);
    expect(grandchild.reason).toContain("parent conv-3-spawn-1 did not resolve");
  });

  it("still reports a real spawned-by cycle as a cycle", () => {
    const rows = views(
      [marker("01"), marker("a", { spawnedBy: "b" }), marker("b", { spawnedBy: "a" })],
      { defaults: DEFAULTS },
    );

    expect(rows.get("01")!.reassign.eligible).toBe(true);
    expect(rows.get("a")!.reassign.reason).toContain("spawned-by cycle: a -> b -> a");
    expect(rows.get("b")!.reassign.reason).toContain("spawned-by cycle: b -> a -> b");
  });

  it("refuses every ticket while the config will not parse", () => {
    const rows = views([marker("01")], null, { configError: "console.json: bad JSON" });
    expect(rows.get("01")!.reassign.eligible).toBe(false);
    expect(rows.get("01")!.reassign.reason).toBe(
      "the pool config does not resolve: console.json: bad JSON",
    );
  });
});

// A ticket's spawned-by may name a Conversation (issue #156). The engine
// seeds every Conversation's Assignment before it resolves the tickets, and
// carries them on the snapshot under their own ids; Reassign has to seed them
// the same way or every one of their descendants looks unresolvable.
const CONVERSATION: Record<string, AssignmentView> = {
  "conv-9": { harness: "claude", model: "opus", effort: "high", drivers: "implement tdd" },
};

function conversationTickets(): TicketMarker[] {
  return [
    marker("01"),
    marker("conv-9-spawn-1", { spawnedBy: "conv-9" }),
    marker("conv-9-spawn-1-spawn-1", { spawnedBy: "conv-9-spawn-1" }),
  ];
}

const ALL_INHERITED = {
  harness: "inherited",
  model: "inherited",
  effort: "inherited",
  drivers: "inherited",
} as const;

describe("Reassign on a ticket spawned by a Conversation", () => {
  it("offers the child and grandchild, inheriting the Conversation's Assignment", () => {
    const rows = views(conversationTickets(), { defaults: DEFAULTS }, { engine: CONVERSATION });

    for (const id of ["01", "conv-9-spawn-1", "conv-9-spawn-1-spawn-1"]) {
      expect(rows.get(id)!.reassign.eligible).toBe(true);
      expect(rows.get(id)!.reassign.reason).toBeNull();
    }
    for (const id of ["conv-9-spawn-1", "conv-9-spawn-1-spawn-1"]) {
      expect(rows.get(id)!.reassign.sources).toEqual(ALL_INHERITED);
      expect(rows.get(id)!.assignment).toMatchObject({
        harness: "claude",
        model: "opus",
        effort: "high",
        drivers: "implement tdd",
      });
    }
    // The Conversation itself is not a ticket and gets no row.
    expect(rows.has("conv-9")).toBe(false);
  });

  it("writes the child's assign entry, and the dry run resolves the grandchild from it", () => {
    const dir = pool({ defaults: DEFAULTS });
    const markers = conversationTickets();

    const result = writeReassign(
      dir,
      { tickets: ["conv-9-spawn-1"], fields: { model: "sonnet", effort: "low" } },
      context(markers, { engine: CONVERSATION }),
    );

    expect(result).toEqual({ applied: ["conv-9-spawn-1"], skipped: [] });
    expect(onDisk(dir).assign).toEqual({
      "conv-9-spawn-1": { model: "sonnet", effort: "low" },
    });

    // Read back as the Console will: the child pins what it was given and
    // inherits the rest; the grandchild inherits all of it from the child.
    const rows = views(
      markers,
      onDisk(dir) as PoolConfig,
      { engine: CONVERSATION },
    );
    expect(rows.get("conv-9-spawn-1")!.reassign.sources).toEqual({
      harness: "inherited",
      model: "pinned",
      effort: "pinned",
      drivers: "inherited",
    });
    expect(rows.get("conv-9-spawn-1-spawn-1")!.reassign.eligible).toBe(true);
    expect(rows.get("conv-9-spawn-1-spawn-1")!.reassign.sources).toEqual(ALL_INHERITED);
    expect(rows.get("conv-9-spawn-1-spawn-1")!.assignment).toMatchObject({
      model: "sonnet",
      effort: "low",
    });
  });

  it("writes the grandchild's assign entry too", () => {
    const dir = pool({ defaults: DEFAULTS });

    const result = writeReassign(
      dir,
      { tickets: ["conv-9-spawn-1-spawn-1"], fields: { harness: "stub" } },
      context(conversationTickets(), { engine: CONVERSATION }),
    );

    expect(result.applied).toEqual(["conv-9-spawn-1-spawn-1"]);
    expect(onDisk(dir).assign).toEqual({ "conv-9-spawn-1-spawn-1": { harness: "stub" } });
  });

  // A file the engine already refuses for one ticket does not hold every
  // other write hostage to it (issue #159); only a failure the write itself
  // brings is refused.
  it("applies a write beside a ticket the file already fails to resolve", () => {
    const dir = pool({ defaults: DEFAULTS, assign: { "02": { harness: "gemini" } } });

    const result = writeReassign(
      dir,
      { tickets: ["01"], fields: { model: "opus" } },
      context([marker("01"), marker("02")]),
    );

    expect(result).toEqual({ applied: ["01"], skipped: [] });
    expect(onDisk(dir).assign).toEqual({
      "01": { model: "opus" },
      "02": { harness: "gemini" },
    });
  });
});

describe("writeReassign: what lands in console.json", () => {
  it("sets the named tickets' fields and leaves every other entry and key alone", () => {
    const dir = pool({
      defaults: DEFAULTS,
      port: 8787,
      assign: { "01": { verify: 2 }, "02": { model: "keep-me" } },
      somethingElse: { kept: true },
    });

    const result = writeReassign(
      dir,
      { tickets: ["01"], fields: { harness: "claude", model: "opus" } },
      context([marker("01"), marker("02")]),
    );

    expect(result).toEqual({ applied: ["01"], skipped: [] });
    expect(onDisk(dir)).toEqual({
      defaults: DEFAULTS,
      port: 8787,
      assign: {
        "01": { verify: 2, harness: "claude", model: "opus" },
        "02": { model: "keep-me" },
      },
      somethingElse: { kept: true },
    });
  });

  it("leaves a field the request never names, and clears one it names null", () => {
    const dir = pool({
      defaults: DEFAULTS,
      assign: { "01": { harness: "claude", model: "opus", drivers: "fix" } },
    });

    writeReassign(
      dir,
      { tickets: ["01"], fields: { model: null } },
      context([marker("01")]),
    );

    expect(onDisk(dir).assign).toEqual({ "01": { harness: "claude", drivers: "fix" } });
  });

  it("sets, leaves and clears effort tri-state, like model", () => {
    const dir = pool({ defaults: DEFAULTS, assign: { "01": { model: "opus" } } });
    const markers = [marker("01"), marker("02")];

    writeReassign(dir, { tickets: ["01", "02"], fields: { effort: " high " } }, context(markers));
    expect(onDisk(dir).assign).toEqual({
      "01": { model: "opus", effort: "high" },
      "02": { effort: "high" },
    });
    // Absent leaves it alone.
    writeReassign(dir, { tickets: ["01"], fields: { model: "sonnet" } }, context(markers));
    expect(onDisk(dir).assign).toEqual({
      "01": { model: "sonnet", effort: "high" },
      "02": { effort: "high" },
    });
    // Null clears it, so the ticket follows the defaults again; a cleared
    // effort is never a refusal, since unset is the harness's own default.
    writeReassign(dir, { tickets: ["01", "02"], fields: { effort: null } }, context(markers));
    expect(onDisk(dir).assign).toEqual({ "01": { model: "sonnet" } });
  });

  it("treats an empty string as a clear, the way an empty Pool setting is", () => {
    const dir = pool({ defaults: DEFAULTS, assign: { "01": { drivers: "fix" } } });
    writeReassign(dir, { tickets: ["01"], fields: { drivers: "  " } }, context([marker("01")]));
    expect(onDisk(dir).assign).toBeUndefined();
  });

  it("removes an entry that is left with no fields, and the assign map with it", () => {
    const dir = pool({ defaults: DEFAULTS, assign: { "01": { model: "opus" } } });

    writeReassign(
      dir,
      { tickets: ["01"], fields: { model: null, verify: null } },
      context([marker("01")]),
    );

    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  it("writes a verify, and clears one with null", () => {
    const dir = pool({ defaults: DEFAULTS });
    writeReassign(dir, { tickets: ["01"], fields: { verify: 3 } }, context([marker("01")]));
    expect(onDisk(dir).assign).toEqual({ "01": { verify: 3 } });

    writeReassign(dir, { tickets: ["01"], fields: { verify: null } }, context([marker("01")]));
    expect(onDisk(dir).assign).toBeUndefined();
  });

  it("creates console.json for a pool that has none", () => {
    const dir = pool();
    writeReassign(
      dir,
      { tickets: ["01"], fields: { harness: "stub", model: "m" } },
      context([marker("01")]),
    );
    expect(onDisk(dir)).toEqual({ assign: { "01": { harness: "stub", model: "m" } } });
  });

  it("applies one write to several named tickets", () => {
    const dir = pool({ defaults: DEFAULTS });
    const result = writeReassign(
      dir,
      { tickets: ["01", "02"], fields: { model: "opus" } },
      context([marker("01"), marker("02")]),
    );

    expect(result.applied).toEqual(["01", "02"]);
    expect(onDisk(dir).assign).toEqual({ "01": { model: "opus" }, "02": { model: "opus" } });
  });
});

describe("writeReassign: refusals and skips", () => {
  it("refuses an id the pool does not own, naming it, and writes nothing", () => {
    const dir = pool({ defaults: DEFAULTS });
    expect(() =>
      writeReassign(
        dir,
        { tickets: ["01", "99"], fields: { model: "opus" } },
        context([marker("01")]),
      ),
    ).toThrow("reassign: unknown ticket '99'");
    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  it("refuses a harness this pool does not know, listing the ones it does", () => {
    const dir = pool({ defaults: DEFAULTS });
    expect(() =>
      writeReassign(dir, { tickets: ["01"], fields: { harness: "gemini" } }, context([marker("01")])),
    ).toThrow(/reassign: harness names unknown harness 'gemini'\. Known: claude, stub/);
    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  it("refuses a verify that is not an integer of at least one", () => {
    const dir = pool({ defaults: DEFAULTS });
    const ctx = context([marker("01")]);
    for (const verify of [0, -1, 1.5] as number[]) {
      expect(() =>
        writeReassign(dir, { tickets: ["01"], fields: { verify } }, ctx),
      ).toThrow(/verify must be an integer >= 1 or null/);
    }
    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  // The engine rejects a Config reload whole when a ticket will not resolve
  // (ADR-0018), so this refusal saves the whole pool's reassignability.
  it("refuses a clear that would leave the ticket with no harness, naming it", () => {
    const dir = pool({ assign: { "01": { harness: "stub", model: "m" } } });

    expect(() =>
      writeReassign(dir, { tickets: ["01"], fields: { harness: null } }, context([marker("01")])),
    ).toThrow("reassign: ticket '01' would be left with no harness");
    expect(onDisk(dir)).toEqual({ assign: { "01": { harness: "stub", model: "m" } } });
  });

  it("refuses a clear that would leave the ticket with no model, naming it", () => {
    const dir = pool({ assign: { "01": { harness: "stub", model: "m" } } });

    expect(() =>
      writeReassign(dir, { tickets: ["01"], fields: { model: null } }, context([marker("01")])),
    ).toThrow("reassign: ticket '01' would be left with no model");
  });

  // An enlisted ticket's model is empty by the as-found rule (issue #101),
  // so an empty model there is not evidence that this write broke anything.
  it("lets an enlisted ticket take a new harness, and keep its empty model", () => {
    const dir = pool({ defaults: DEFAULTS });
    const markers = [marker("e1", { enlistedFrom: "%3" })];

    const result = writeReassign(
      dir,
      { tickets: ["e1"], fields: { harness: "claude" } },
      context(markers),
    );

    expect(result.applied).toEqual(["e1"]);
    expect(onDisk(dir).assign).toEqual({ e1: { harness: "claude" } });
  });

  // The engine forces an enlisted ticket's model, drivers and verify itself,
  // so a write of any of them would look applied in the file and change
  // nothing at all.
  it("refuses a model, effort, drivers or verify on an enlisted ticket, naming it", () => {
    const dir = pool({ defaults: DEFAULTS });
    const markers = [marker("e1", { enlistedFrom: "%3" }), marker("01")];

    for (const fields of [{ model: "opus" }, { effort: "high" }, { drivers: "fix" }, { verify: 2 }]) {
      expect(() => writeReassign(dir, { tickets: ["e1"], fields }, context(markers))).toThrow(
        "reassign: ticket 'e1' is enlisted: only harness can be reassigned",
      );
    }
    // A bulk write that happens to include it is refused whole, rather than
    // landing on the others and silently dropping this one.
    expect(() =>
      writeReassign(dir, { tickets: ["01", "e1"], fields: { model: "opus" } }, context(markers)),
    ).toThrow("reassign: ticket 'e1' is enlisted");
    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  // Not a refusal: the operator lost nothing, the Attempt simply started
  // between the listing and the save.
  it("skips a ticket that went in flight since the listing, and applies the rest", () => {
    const dir = pool({ defaults: DEFAULTS });

    const result = writeReassign(
      dir,
      { tickets: ["01", "02"], fields: { model: "opus" } },
      context([marker("01"), marker("02")], { live: ["02"] }),
    );

    expect(result.applied).toEqual(["01"]);
    expect(result.skipped).toEqual([{ id: "02", reason: "an Attempt is running" }]);
    expect(onDisk(dir).assign).toEqual({ "01": { model: "opus" } });
  });

  it("writes nothing when every named ticket was skipped", () => {
    const dir = pool({ defaults: DEFAULTS });
    const result = writeReassign(
      dir,
      { tickets: ["01"], fields: { model: "opus" } },
      context([marker("01")], { live: ["01"] }),
    );

    expect(result).toEqual({ applied: [], skipped: [{ id: "01", reason: "an Attempt is running" }] });
    expect(onDisk(dir)).toEqual({ defaults: DEFAULTS });
  });

  it("refuses an empty or malformed request", () => {
    const dir = pool({ defaults: DEFAULTS });
    const ctx = context([marker("01")]);
    expect(() => writeReassign(dir, { tickets: [], fields: {} }, ctx)).toThrow(
      "reassign: name at least one ticket",
    );
    expect(() =>
      writeReassign(dir, { tickets: "01" as unknown as string[], fields: {} }, ctx),
    ).toThrow("reassign: tickets must be an array of ticket ids");
    expect(() =>
      writeReassign(dir, { tickets: ["01"], fields: null as unknown as never }, ctx),
    ).toThrow("reassign: fields must be an object");
  });

  it("reports a console.json it cannot read as the server's failure, not the request's", () => {
    const dir = pool();
    writeFileSync(join(dir, "console.json"), "{ not json");

    expect(() =>
      writeReassign(dir, { tickets: ["01"], fields: { model: "opus" } }, context([marker("01")])),
    ).toThrow(ConfigUnreadableError);
  });
});
