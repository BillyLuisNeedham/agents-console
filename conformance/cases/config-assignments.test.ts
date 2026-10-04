/**
 * Assignments (ADR-0013), seen from outside the server (ADR-0036): what each
 * Ticket of a pool resolves to from console.json's defaults, its assign
 * entries and the parent a spawn inherits from, as the snapshot serves it
 * and as the harness argv carries it; effort, verify and the pool-load
 * refusals of a config that will not resolve.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../engine/wire.ts";
import { conformance } from "../harness/case.ts";
import { readConsoleJson, readEvents } from "../harness/pool-files.ts";
import {
  approveReview,
  conversationRecord,
  doneTicket,
  flagValue,
  hasTicketFile,
  holdFile,
  launchesOf,
  rawConfig,
  refusedAtLoad,
  release,
  snapshotOf,
  ticket,
  ticketOf,
  untilLaunched,
  untilSnapshot,
} from "./config-support.ts";

const KNOWN = "Known: claude, cursor, opencode";

conformance("config", "an ordinary Ticket takes its assign entry over the defaults, field by field, and nothing when neither says", async (t) => {
  const assigned = t.world({
    tickets: [doneTicket("01"), doneTicket("02")],
    config: {
      defaults: { harness: "claude", model: "opus", drivers: "implement" },
      assign: { "01": { model: "haiku" } },
    },
  });
  const bare = t.world({ tickets: [doneTicket("01")] });
  const one = await snapshotOf(await t.start(assigned));
  const two = await snapshotOf(await t.start(bare));

  expect(ticketOf(one, "01").assignment).toEqual({ harness: "claude", model: "haiku", drivers: "implement" });
  expect(ticketOf(one, "02").assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
  expect(ticketOf(two, "01").assignment).toEqual({ harness: null, model: null, drivers: "implement" });
});

conformance("config", "a spawned Ticket takes its own entry over its parent, and its parent over the defaults", async (t) => {
  const world = t.world({
    tickets: [
      doneTicket("01"),
      doneTicket("01-spawn-1", { spawnedBy: "01" }),
      doneTicket("01-spawn-2", { spawnedBy: "01" }),
      doneTicket("conv-1-spawn-1", { spawnedBy: "conv-1" }),
    ],
    config: {
      defaults: { harness: "claude", model: "opus" },
      assign: {
        "01": { harness: "opencode", model: "o3", drivers: "implement review" },
        "01-spawn-2": { harness: "claude", drivers: "fix" },
      },
    },
    // An enlisted Conversation names its harness and no model.
    poolFiles: conversationRecord("conv-1", { harness: "opencode", model: "" }),
  });
  const noDefaults = t.world({
    tickets: [doneTicket("conv-1-spawn-1", { spawnedBy: "conv-1" })],
    poolFiles: conversationRecord("conv-1", { harness: "opencode", model: "" }),
  });
  const snapshot = await snapshotOf(await t.start(world));
  const bare = await snapshotOf(await t.start(noDefaults));

  expect(ticketOf(snapshot, "01-spawn-1").assignment).toEqual({
    harness: "opencode",
    model: "o3",
    drivers: "implement review",
  });
  expect(ticketOf(snapshot, "01-spawn-2").assignment).toEqual({ harness: "claude", model: "o3", drivers: "fix" });
  // The field the Conversation leaves empty falls through to the defaults.
  expect(ticketOf(snapshot, "conv-1-spawn-1").assignment).toEqual({
    harness: "opencode",
    model: "opus",
    drivers: "implement",
  });
  expect(ticketOf(bare, "conv-1-spawn-1").assignment).toEqual({ harness: "opencode", model: null, drivers: "implement" });
});

conformance("config", "a grader takes its entry's harness and model over the build's, keeps the build's drivers and ignores its verify", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: {
      assign: {
        "01": { harness: "opencode", model: "o3", drivers: "implement review", verify: 1 },
        "01-grader-1": { model: "haiku", drivers: "fix", verify: 3 },
      },
    },
  });
  const server = await t.start(world);
  const [grader] = await untilLaunched(world, "01-grader-1");
  const snapshot = await untilSnapshot(
    server,
    (s) => s.state.tickets.some((ticket) => ticket.id === "01-grader-1"),
    "the grader Ticket on the snapshot",
  );

  expect(ticketOf(snapshot, "01-grader-1").assignment).toEqual({
    harness: "opencode",
    model: "haiku",
    drivers: "implement review",
  });
  expect(grader!.harness).toBe("opencode");
  expect(flagValue(grader!.argv, "--model")).toBe("haiku");
  await approveReview(server);
  expect(launchesOf(world, "01-grader-1")).toHaveLength(1);
  expect(hasTicketFile(world, "01-grader-2.md")).toBe(false);
});

conformance("config", "effort layers like model: an entry, then the parent, then the defaults, into each harness argv", async (t) => {
  const world = t.world({
    tickets: [
      ticket("01"),
      ticket("02"),
      ticket("03"),
      ticket("03-spawn-1", { spawnedBy: "03", blockedBy: ["03"] }),
      ticket("04"),
      ticket("04-spawn-1", { spawnedBy: "04", blockedBy: ["04"] }),
    ],
    config: {
      defaults: { harness: "claude", model: "opus", effort: "high" },
      assign: {
        "02": { effort: "max" },
        "03": { effort: "low", verify: 1 },
        "03-grader-1": { effort: "xhigh" },
      },
    },
  });
  const server = await t.start(world);
  await approveReview(server);
  const snapshot = await snapshotOf(server);

  const effortOf = (key: string) => flagValue(launchesOf(world, key)[0]!.argv, "--effort");
  // 03 runs as its one verify Attempt, keyed by the attempt.
  const expected: [string, string, string][] = [
    ["01", "01", "high"],
    ["02", "02", "max"],
    ["03", "03.attempt-1", "low"],
    ["03-spawn-1", "03-spawn-1", "low"],
    ["04-spawn-1", "04-spawn-1", "high"],
    ["03-grader-1", "03-grader-1", "xhigh"],
  ];
  for (const [id, key, effort] of expected) {
    expect([id, effortOf(key)]).toEqual([id, effort]);
    expect([id, ticketOf(snapshot, id).assignment.effort]).toEqual([id, effort]);
  }
});

conformance("config", "an effort is passed to the harness as written, trimmed and untranslated", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: { defaults: { harness: "claude", model: "opus" }, assign: { "01": { effort: "  minimal " } } },
  });
  const server = await t.start(world);
  const [launch] = await untilLaunched(world, "01");
  const snapshot = await snapshotOf(server);

  expect(flagValue(launch!.argv, "--effort")).toBe("minimal");
  expect(ticketOf(snapshot, "01").assignment).toEqual({
    harness: "claude",
    model: "opus",
    effort: "minimal",
    effortApplied: true,
    drivers: "implement",
  });
});

conformance("config", "the snapshot names the layer an effort came from: pinned, inherited, default or unset", async (t) => {
  const world = t.world({
    tickets: [
      doneTicket("01"),
      doneTicket("02"),
      doneTicket("02-spawn-1", { spawnedBy: "02" }),
      doneTicket("conv-1-spawn-1", { spawnedBy: "conv-1" }),
    ],
    config: {
      defaults: { harness: "claude", model: "opus", effort: "high" },
      assign: { "01": { effort: "max" }, "02": { effort: "low" } },
    },
    // A parent with no effort of its own hands the field to the defaults.
    poolFiles: conversationRecord("conv-1", { harness: "claude", model: "opus" }),
  });
  const bare = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "opus" } } });
  const snapshot = await snapshotOf(await t.start(world));
  const none = await snapshotOf(await t.start(bare));

  expect(ticketOf(snapshot, "01").reassign.sources.effort).toBe("pinned");
  expect(ticketOf(snapshot, "02-spawn-1").reassign.sources.effort).toBe("inherited");
  expect(ticketOf(snapshot, "conv-1-spawn-1").reassign.sources.effort).toBe("default");
  expect(ticketOf(none, "01").reassign.sources.effort).toBe("unset");
});

conformance("config", "a Ticket of any kind naming an unknown harness stops the pool at load, naming it and the known ones", async (t) => {
  const worlds = {
    "01": t.world({ tickets: [ticket("01")], config: { assign: { "01": { harness: "gemini", model: "m" } } } }),
    "01-spawn-1": t.world({
      tickets: [doneTicket("01"), ticket("01-spawn-1", { spawnedBy: "01" })],
      config: {
        defaults: { harness: "claude", model: "m" },
        assign: { "01-spawn-1": { harness: "gemini" } },
      },
    }),
    // A grader is engine-written; one already on disk resolves at load too.
    "01-grader-1": t.world({
      tickets: [doneTicket("01"), ticket("01-grader-1", { blockedBy: ["01"] })],
      config: {
        defaults: { harness: "claude", model: "m" },
        assign: { "01-grader-1": { harness: "gemini" } },
      },
    }),
  };
  for (const [id, world] of Object.entries(worlds)) {
    const { code, output } = await refusedAtLoad(world);
    expect([id, code === 0]).toEqual([id, false]);
    expect(output).toContain(`pool config: ticket ${id} names unknown harness 'gemini'. ${KNOWN}`);
  }
  // A Conversation's start is refused the same way, with a 409.
  const terminal = t.world({
    tickets: [doneTicket("01")],
    config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
  });
  const server = await t.start(terminal, { herdr: await t.herdr(terminal) });
  const answer = await server.http.post("/api/conversations", { title: "Talk", assign: { harness: "gemini" } });
  expect(answer.status).toBe(409);
  expect(answer.json<unknown>()).toEqual({ reason: `conversation start: names unknown harness 'gemini'. ${KNOWN}` });
  expect(terminal.stubs.calls()).toEqual([]);
});

conformance("config", "an empty harness in an assign entry is not a load error: the Ticket waits on a Config Interrupt", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { assign: { "01": { harness: "" } } } });
  const server = await t.start(world);
  const snapshot = await untilSnapshot(
    server,
    (s) => s.state.interrupts.some((i) => i.ticketId === "01"),
    "01's Interrupt",
  );

  expect(ticketOf(snapshot, "01").assignment).toEqual({ harness: null, model: null, drivers: "implement" });
  expect(snapshot.state.interrupts.find((i) => i.ticketId === "01")!.kind).toBe("config");
  expect(launchesOf(world, "01")).toEqual([]);
});

conformance("config", "verify is honoured as a whole number of 1 or more, null is absent, and a grader's verify is never checked", async (t) => {
  const three = t.world({ tickets: [ticket("01")], config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: 3 } } } });
  const nothing = t.world({ tickets: [ticket("01")], config: rawConfig({ defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: null } } }) });
  const graderBad = t.world({
    tickets: [ticket("01")],
    config: rawConfig({
      defaults: { harness: "claude", model: "m" },
      assign: { "01": { verify: 1 }, "01-grader-1": { verify: "bad" } },
    }),
  });

  const threeServer = await t.start(three);
  await untilLaunched(three, "01.attempt-3");
  expect(ticketOf(await snapshotOf(threeServer), "01").reassign.verify).toBe(3);

  const nothingServer = await t.start(nothing);
  await approveReview(nothingServer);
  expect(launchesOf(nothing, "01")).toHaveLength(1);
  expect(hasTicketFile(nothing, "01-grader-1.md")).toBe(false);

  const graderServer = await t.start(graderBad);
  await approveReview(graderServer);
  expect(graderBad.stubs.calls().map((call) => call.key)).toEqual(["01.attempt-1", "01-grader-1"]);
});

conformance("config", "the snapshot renders an empty harness and model as null and drivers as written", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01"), doneTicket("02")],
    config: { assign: { "02": { harness: "claude", model: "opus", drivers: "fix" } } },
  });
  const snapshot = await snapshotOf(await t.start(world));

  expect(ticketOf(snapshot, "01").assignment).toEqual({ harness: null, model: null, drivers: "implement" });
  expect(ticketOf(snapshot, "02").assignment).toEqual({ harness: "claude", model: "opus", drivers: "fix" });
});

conformance("config", "an effort is served with whether its harness can take it, and a Ticket with none carries neither key", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01"), doneTicket("02"), doneTicket("03")],
    config: {
      assign: {
        "01": { harness: "cursor", model: "gpt-5", effort: "high" },
        "02": { harness: "claude", model: "opus", effort: "high" },
        "03": { harness: "claude", model: "opus" },
      },
    },
  });
  const snapshot = await snapshotOf(await t.start(world));

  expect(ticketOf(snapshot, "01").assignment).toEqual({
    harness: "cursor",
    model: "gpt-5",
    effort: "high",
    effortApplied: false,
    drivers: "implement",
  });
  expect(ticketOf(snapshot, "02").assignment).toEqual({
    harness: "claude",
    model: "opus",
    effort: "high",
    effortApplied: true,
    drivers: "implement",
  });
  expect(ticketOf(snapshot, "03").assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
});

conformance("config", "a Ticket spawned by an enlisted Conversation runs on the defaults' model, which the Conversation never had", async (t) => {
  const world = t.world({
    tickets: [ticket("conv-1-spawn-1", { spawnedBy: "conv-1" })],
    config: { defaults: { harness: "claude", model: "default-model" } },
    poolFiles: conversationRecord("conv-1", { harness: "claude", model: "" }),
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  const launches = world.stubs.calls();
  expect(launches.map((call) => [call.key, call.harness, flagValue(call.argv, "--model")])).toEqual([
    ["conv-1-spawn-1", "claude", "default-model"],
  ]);
  expect(done.state.interrupts.filter((i) => i.kind === "config")).toEqual([]);
  expect(ticketOf(done, "conv-1-spawn-1").assignment).toEqual({
    harness: "claude",
    model: "default-model",
    drivers: "implement",
  });
});

conformance("config", "effort comes from the defaults, a Ticket's own entry or a spawn's Conversation, and the spawned event records it", async (t) => {
  const world = t.world({
    tickets: [ticket("01"), ticket("02"), ticket("conv-1-spawn-1", { spawnedBy: "conv-1" })],
    config: {
      defaults: { harness: "claude", model: "m", effort: "high" },
      assign: { "02": { effort: "max" } },
    },
    poolFiles: conversationRecord("conv-1", { harness: "claude", model: "m", effort: "low" }),
  });
  const server = await t.start(world);
  const done = await approveReview(server);

  const effortOf = (key: string) => flagValue(launchesOf(world, key)[0]!.argv, "--effort");
  expect([effortOf("01"), effortOf("02"), effortOf("conv-1-spawn-1")]).toEqual(["high", "max", "low"]);
  expect(ticketOf(done, "02").assignment).toEqual({
    harness: "claude",
    model: "m",
    effort: "max",
    effortApplied: true,
    drivers: "implement",
  });
  const spawned = readEvents(world.pool, "02").find((event) => event.kind === "spawned")!;
  expect(spawned.payload).toMatchObject({ effort: "max", effort_applied: true });
});

conformance("config", "with no effort anywhere a Ticket launches without one and never waits on a Config Interrupt", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);
  const done = await approveReview(server);

  expect(done.state.interrupts.filter((i) => i.kind === "config")).toEqual([]);
  expect(launchesOf(world, "01")[0]!.argv).not.toContain("--effort");
  expect(ticketOf(done, "01").assignment).not.toHaveProperty("effort");
  expect(ticketOf(done, "01").assignment).not.toHaveProperty("effortApplied");
  const spawned = readEvents(world.pool, "01").find((event) => event.kind === "spawned")!;
  expect(spawned.payload).not.toHaveProperty("effort");
});

conformance("config", "verify 1 and verify 3 fan a Ticket out into that many Attempts, each with a grader Ticket", async (t) => {
  for (const n of [1, 3]) {
    const world = t.world({
      tickets: [ticket("01")],
      config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: n } } },
    });
    const server = await t.start(world);
    const graders = Array.from({ length: n }, (_, i) => `01-grader-${i + 1}`);
    for (const grader of graders) await untilLaunched(world, grader);

    expect([n, ticketOf(await snapshotOf(server), "01").reassign.verify]).toEqual([n, n]);
    const attempts = world.stubs
      .calls()
      .filter((call) => call.key === "01" || call.key.startsWith("01.attempt-"))
      .map((call) => call.key)
      .sort();
    expect([n, attempts]).toEqual([n, graders.map((_, i) => `01.attempt-${i + 1}`)]);
    for (const grader of graders) expect([grader, hasTicketFile(world, `${grader}.md`)]).toEqual([grader, true]);
    await server.stop();
  }
});

conformance("config", "an assign entry without verify resolves to none: one Attempt and no grader", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { defaults: { harness: "claude", model: "m" }, assign: { "01": { model: "m" } } } });
  const server = await t.start(world);
  expect(ticketOf(await snapshotOf(server), "01").reassign.verify).toBeNull();
  await approveReview(server);

  expect(launchesOf(world, "01")).toHaveLength(1);
  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01"]);
  expect(hasTicketFile(world, "01-grader-1.md")).toBe(false);
});

conformance("config", "an invalid verify stops the pool at load, naming the Ticket and the value", async (t) => {
  for (const verify of [0, -1, 2.5, "3", true, {}]) {
    const world = t.world({
      tickets: [ticket("01")],
      config: rawConfig({ defaults: { harness: "claude", model: "m" }, assign: { "01": { verify } } }),
    });
    const { code, output } = await refusedAtLoad(world);
    expect([verify, code === 0]).toEqual([verify, false]);
    expect(output).toContain(`pool config: ticket 01 has invalid verify ${JSON.stringify(verify)} (must be an integer >= 1)`);
    expect(launchesOf(world, "01")).toEqual([]);
  }
});

conformance("config", "verify null reads as absent, like the other assign keys", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: rawConfig({ defaults: { harness: "claude", model: "m" }, assign: { "01": { verify: null } } }) });
  const server = await t.start(world);
  expect(ticketOf(await snapshotOf(server), "01").reassign.verify).toBeNull();
  await approveReview(server);

  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01"]);
  expect(hasTicketFile(world, "01-grader-1.md")).toBe(false);
});

conformance("config", "verify under the defaults is ignored: verify is per Ticket", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: rawConfig({ defaults: { harness: "claude", model: "m", verify: 3 } }),
  });
  const server = await t.start(world);
  expect(ticketOf(await snapshotOf(server), "01").reassign.verify).toBeNull();
  await approveReview(server);

  expect(world.stubs.calls().map((call) => call.key)).toEqual(["01"]);
  expect(hasTicketFile(world, "01-grader-1.md")).toBe(false);
});

conformance("config", "unknown assign keys are ignored, beside a verify or without one", async (t) => {
  const plain = t.world({
    tickets: [ticket("01")],
    config: rawConfig({ defaults: { harness: "claude", model: "m" }, assign: { "01": { mystery: "x" } } }),
  });
  const withVerify = t.world({
    tickets: [ticket("01")],
    config: rawConfig({ defaults: { harness: "claude", model: "m" }, assign: { "01": { mystery: "x", verify: 2 } } }),
  });
  await approveReview(await t.start(plain));
  expect(plain.stubs.calls().map((call) => call.key)).toEqual(["01"]);

  const server = await t.start(withVerify);
  // The two attempts launch side by side, so wait for each rather than read one after the other.
  await untilLaunched(withVerify, "01.attempt-2");
  expect(ticketOf(await snapshotOf(server), "01").reassign.verify).toBe(2);
  expect(await untilLaunched(withVerify, "01.attempt-1")).toHaveLength(1);
});

conformance("config", "a selection other than auto or human stops the pool at load", async (t) => {
  const world = t.world({
    tickets: [ticket("01")],
    config: rawConfig({ defaults: { harness: "claude", model: "m" }, selection: "maybe" }),
  });
  const { code, output } = await refusedAtLoad(world);

  expect(code).not.toBe(0);
  expect(output).toContain('pool config: selection must be "auto" or "human"');
  expect(world.stubs.calls()).toEqual([]);
});

conformance("config", "effort applies in a headless pool's batch launch and not in a terminal-backed pool's TUI, for opencode", async (t) => {
  const config: PoolConfig = { defaults: { harness: "opencode", model: "m", effort: "high" } };
  const headless = t.world({ tickets: [doneTicket("01")], config });
  const terminal = t.world({ tickets: [doneTicket("01")], config: { ...config, terminal: "herdr" } });
  const herdr = await t.herdr(terminal);
  const batch = await snapshotOf(await t.start(headless));
  const tui = await snapshotOf(await t.start(terminal, { herdr }));

  expect(ticketOf(batch, "01").assignment.effortApplied).toBe(true);
  expect(ticketOf(tui, "01").assignment.effortApplied).toBe(false);
});

/** What a terminal-backed pool's live pane shows: every harness's ready frame. */
const READY_FRAME = "Claude Code v\nAsk anything\nctrl+p commands\nCursor Agent\n";

conformance("config", "a Conversation takes its request, then its parent Conversation, then the defaults", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01")],
    config: { defaults: { harness: "claude", model: "opus" }, terminal: "herdr" },
  });
  // The parent stays live while its pane holds: the stub waits, the pane
  // shows opencode's ready frame and outlives the stub.
  world.stubs.script("_opencode", { waitFor: holdFile(world, "_opencode") });
  const herdr = await t.herdr(world, { rendered: READY_FRAME, holdPane: true });
  const server = await t.start(world, { herdr });
  const parent = await server.http.post("/api/conversations", {
    title: "Parent",
    assign: { harness: "opencode", model: "o3", drivers: "implement review" },
  });
  expect(parent.status).toBe(201);
  const parentId = parent.json<{ conversation: { id: string; status: string } }>().conversation.id;
  writeFileSync(
    join(world.pool, "runs", `${parentId}.spawn.json`),
    JSON.stringify({
      spawn: [{ kind: "conversation", title: "Child", body: "Talk the child's question through.", assign: { model: "sonnet" } }],
    }),
  );
  const withChild = await untilSnapshot(
    server,
    (s) => s.state.conversations.some((c) => c.spawnedBy === parentId),
    "the child Conversation",
  );
  const child = withChild.state.conversations.find((c) => c.spawnedBy === parentId)!;
  const fresh = await server.http.post("/api/conversations", { title: "Fresh" });
  release(world, "_opencode");

  expect(child.assignment).toEqual({ harness: "opencode", model: "sonnet", drivers: "implement review" });
  expect(launchesOf(world, "_opencode").map((call) => flagValue(call.argv, "--model"))).toEqual(["o3", "sonnet"]);
  expect(fresh.status).toBe(201);
  expect(fresh.json<{ conversation: { assignment: unknown } }>().conversation.assignment).toEqual({
    harness: "claude",
    model: "opus",
    drivers: "implement",
  });
}, { timeoutMs: 90_000 });

conformance("config", "a Conversation with no effort anywhere starts without one, and an empty effort is no refusal", async (t) => {
  const world = t.world({
    tickets: [doneTicket("01")],
    config: { defaults: { harness: "claude", model: "opus" }, terminal: "herdr" },
  });
  const server = await t.start(world, { herdr: await t.herdr(world) });
  const plain = await server.http.post("/api/conversations", { title: "Plain" });
  const empty = await server.http.post("/api/conversations", { title: "Empty", assign: { effort: "" } });

  for (const answer of [plain, empty]) {
    expect(answer.status).toBe(201);
    const { assignment } = answer.json<{ conversation: { assignment: Record<string, unknown> } }>().conversation;
    expect(assignment).toEqual({ harness: "claude", model: "opus", drivers: "implement" });
  }
  const launches = launchesOf(world, "_claude");
  expect(launches).toHaveLength(2);
  for (const launch of launches) expect(launch.argv).not.toContain("--effort");
}, { timeoutMs: 90_000 });

conformance("config", "a Conversation start is refused for no harness, then an unknown harness, then no model, in that order", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: { terminal: "herdr" } });
  const server = await t.start(world, { herdr: await t.herdr(world) });
  const reasonOf = async (assign?: Record<string, string>) => {
    const answer = await server.http.post("/api/conversations", { title: "Talk", ...(assign ? { assign } : {}) });
    expect(answer.status).toBe(409);
    return answer.json<{ reason: string }>().reason;
  };

  expect(await reasonOf()).toBe(
    "conversation start: no harness resolved (set assign.harness, inherit " +
      "from the parent Conversation, or console.json defaults.harness)",
  );
  expect(await reasonOf({ harness: "claude" })).toBe(
    "conversation start: no model resolved (set assign.model, inherit " +
      "from the parent Conversation, or console.json defaults.model)",
  );
  expect(await reasonOf({ harness: "gemini" })).toBe(`conversation start: names unknown harness 'gemini'. ${KNOWN}`);
  expect(world.stubs.calls()).toEqual([]);
});

conformance("config", "the Steward entry is a Pool setting: replaced whole, its budget typed as text, its harness checked", async (t) => {
  const world = t.world({ tickets: [doneTicket("01")], config: { defaults: { harness: "claude", model: "m" } } });
  const server = await t.start(world);
  const put = (steward: unknown) => server.http.put("/api/settings/pool", { config: { steward } });

  const saved = await put({ budget: " 3 ", assign: { model: " judge ", harness: "", effort: "high" } });
  expect(saved.status).toBe(200);
  expect(readConsoleJson(world.pool)!.steward).toEqual({ budget: 3, assign: { model: "judge", effort: "high" } });

  const zero = await put({ budget: "0" });
  expect(zero.status).toBe(400);
  expect(zero.json<{ error: string }>().error).toContain("steward.budget must be a whole number, 1 or more");
  const unknown = await put({ assign: { harness: "nope" } });
  expect(unknown.status).toBe(400);
  expect(unknown.json<{ error: string }>().error).toContain("steward.assign.harness names unknown harness 'nope'");
  expect(readConsoleJson(world.pool)!.steward).toEqual({ budget: 3, assign: { model: "judge", effort: "high" } });

  // Everything emptied goes back to the defaults: the key is removed.
  expect((await put({ budget: "", assign: {} })).status).toBe(200);
  const after = readConsoleJson(world.pool)!;
  expect(after).not.toHaveProperty("steward");
  expect(after.defaults).toEqual({ harness: "claude", model: "m" });
});
