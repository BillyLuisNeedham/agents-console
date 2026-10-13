/**
 * The Spawn ledger and the spawn proposals file (the inventory's ticket C01,
 * area `formats`): `runs/spawn-ledger.md`, which agents read and which is
 * pinned byte for byte (ADR-0036), and `runs/held-spawns.json`, the Pending
 * and Held spawns' record, equal once parsed. The ledger's template below is
 * the TypeScript server's (engine/spawn-ledger.ts), copied, so a case
 * compares the whole file.
 *
 * Each case names the inventory rows it covers (docs/research/rust-port/
 * test-inventory.md, area `formats`) as `file:line` of the engine test it
 * came from, or `gap` with the source line for behaviour no test covered.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolConfig } from "../../protocol/wire.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual, expectSameFile } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";
import type { World } from "../harness/world.ts";
import { refusedStart, snapshot, ticket, untilReview } from "./formats-helpers.ts";

const DEFAULTS = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;
const AT = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The ledger's template, as engine/spawn-ledger.ts renders it.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  title: string;
}
interface PendingRow {
  id: string;
  parent: string;
  kind?: string;
  title: string;
  body: string;
}
interface HeldRow extends PendingRow {
  reason: string;
}

function cell(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function summary(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return cell(flat.length > 160 ? `${flat.slice(0, 159)}…` : flat);
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_(none)_"];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function ledger(input: { tickets?: Row[]; conversations?: Row[]; pending?: PendingRow[]; held?: HeldRow[] }): string {
  const title = (id: string, text: string) => (text.startsWith(`${id}: `) ? text.slice(id.length + 2) : text);
  return [
    "# Spawn ledger",
    "",
    "The work this pool has and the work on its way, rewritten by the engine whenever it changes. Read it " +
      "before you propose a Spawn. Do not propose work listed here again. If a proposal still overlaps " +
      'something listed, name those ids in its "overlaps" and the operator decides whether it lands. Never ' +
      "edit this file.",
    "",
    "## Tickets",
    "",
    ...table(["id", "status", "title"], (input.tickets ?? []).map((t) => [cell(t.id), t.status, cell(title(t.id, t.title))])),
    "",
    "## Conversations",
    "",
    ...table(["id", "status", "title"], (input.conversations ?? []).map((c) => [cell(c.id), c.status, cell(c.title)])),
    "",
    "## Pending spawns",
    "",
    "Proposals that land at the next super-step boundary.",
    "",
    ...table(
      ["id", "parent", "kind", "title", "summary"],
      (input.pending ?? []).map((p) => [p.id, cell(p.parent), p.kind ?? "ticket", cell(p.title), summary(p.body)]),
    ),
    "",
    "## Held spawns",
    "",
    "Proposals waiting for the operator to adopt or discard them.",
    "",
    ...table(
      ["id", "parent", "kind", "reason", "title", "summary"],
      (input.held ?? []).map((h) => [h.id, cell(h.parent), h.kind ?? "ticket", cell(h.reason), cell(h.title), summary(h.body)]),
    ),
    "",
  ].join("\n");
}

function ledgerPath(world: World): string {
  return join(world.pool, "runs", "spawn-ledger.md");
}

/** Wait for the ledger to read `expected` whole, then compare it byte for byte. */
async function expectLedger(world: World, expected: string, what = "the Spawn ledger"): Promise<void> {
  await until(
    () => (existsSync(ledgerPath(world)) ? readFileSync(ledgerPath(world), "utf8") : ""),
    (text) => text === expected,
    { ms: 30_000, what },
  ).catch(() => undefined);
  expectSameFile(ledgerPath(world), expected);
}

/** A held entry of runs/held-spawns.json. */
function held(id: string, reason: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    parentId: "07",
    origin: "ticket",
    proposal: { title, body: `The body of ${title}, long enough to land.`, ...((extra.proposal as object) ?? {}) },
    reason,
    at: AT,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "proposal")),
  };
}

function proposalsFile(file: Record<string, unknown>): string {
  return `${JSON.stringify({ seq: 0, proposalFrom: 0, pending: [], held: [], recovered: [], ...file }, null, 2)}\n`;
}

function readProposals(world: World): Record<string, unknown> & { held: { id: string }[]; pending: { id: string }[] } {
  return JSON.parse(readFileSync(join(world.pool, "runs", "held-spawns.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

// spawn-ledger.test.ts:9 the Spawn ledger (issue #150) › lists every section, saying none rather than leaving one out
conformance("formats", "a Seeded Pool's ledger has all four sections, each saying none", async (t) => {
  const world = t.world({ config: DEFAULTS });
  mkdirSync(join(world.pool, "conversations"), { recursive: true });
  await t.start(world);
  const expected = ledger({});
  expect(expected.split("_(none)_").length - 1).toBe(4);
  expect(expected).toContain("Never edit this file.");
  await expectLedger(world, expected);
});

// engine.test.ts:9720 pending spawns (issue #150) › writes the Spawn ledger with every ticket, pending and held spawn
conformance("formats", "the ledger lists every Ticket and a held proposal, escaped, written through a rename", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { ...DEFAULTS, spawnCaps: { perAttempt: 1 } } });
  const lands = "The first proposal, which the cap has room for.";
  const piped = "The second proposal, past the per-attempt cap.";
  world.stubs.script("01", {
    spawn: [
      { title: "Lands", body: lands },
      { title: "A | B", body: piped },
    ],
  });
  const server = await t.start(world);
  await untilReview(server.http);
  const approve = await server.http.post("/api/resume", { ticketId: "REVIEW", action: "approve" });
  expect(approve.status, approve.text).toBe(202);
  await expectLedger(
    world,
    ledger({
      // In Ticket file name order: 01-spawn-1.md sorts before 01-t.md.
      tickets: [
        { id: "01-spawn-1", status: "done", title: "01-spawn-1: Lands" },
        { id: "01", status: "done", title: "T01" },
      ],
      held: [{ id: "proposal-2", parent: "01", reason: "per-attempt cap", title: "A | B", body: piped }],
    }),
  );
  expect(readdirSync(join(world.pool, "runs")).filter((f: string) => f.includes(".tmp-"))).toEqual([]);
});

// spawn-ledger.test.ts:18 the Spawn ledger (issue #150) › names each piece of work by the id an overlaps mark would use
// spawn-ledger.test.ts:62 the Spawn ledger (issue #150) › words each hold reason the way the Console does
conformance("formats", "the ledger leads each row with its id, drops a title's id prefix and words every hold reason", async (t) => {
  const world = t.world({
    tickets: [
      ticket("07", { status: "checkpoint" }),
      {
        file: "07-spawn-1.md",
        marker: "<!-- state: id=07-spawn-1 blocked-by=none status=checkpoint spawned-by=07 -->",
        body: "# 07-spawn-1: Fix the lexer",
      },
    ],
    config: DEFAULTS,
    poolFiles: {
      "conversations/conv-1.md":
        "<!-- conversation: id=conv-1 status=ended spawned-by=none harness=claude model=m drivers=implement -->\n\n" +
        "# Plan | then build\n\nhello\n",
      "runs/held-spawns.json": proposalsFile({
        seq: 9,
        held: [
          held("proposal-3", "per-attempt", "Cap one"),
          held("proposal-4", "overlaps", "Overlapping", { proposal: { overlaps: ["07", "proposal-3"] } }),
          held("proposal-5", "per-run", "Cap two"),
          held("proposal-6", "overlaps", "Stale mark", { proposal: { overlaps: ["07", "99"] }, unknownOverlaps: ["99"] }),
          held("proposal-7", "operator", "Held back"),
          held("proposal-8", "refused", "Refused", { adoptError: "blocked-by names 42, which is not in the pool" }),
        ],
      }),
    },
  });
  await t.start(world);
  const body = (title: string) => `The body of ${title}, long enough to land.`;
  const row = (id: string, reason: string, title: string): HeldRow => ({ id, parent: "07", reason, title, body: body(title) });
  await expectLedger(
    world,
    ledger({
      tickets: [
        { id: "07-spawn-1", status: "checkpoint", title: "07-spawn-1: Fix the lexer" },
        { id: "07", status: "checkpoint", title: "T07" },
      ],
      conversations: [{ id: "conv-1", status: "ended", title: "Plan | then build" }],
      held: [
        row("proposal-3", "per-attempt cap", "Cap one"),
        row("proposal-4", "overlaps 07, proposal-3", "Overlapping"),
        row("proposal-5", "per-run cap", "Cap two"),
        row("proposal-6", "overlaps 07, 99 (99 not in the pool)", "Stale mark"),
        row("proposal-7", "held by operator", "Held back"),
        row("proposal-8", "refused at landing: blocked-by names 42, which is not in the pool", "Refused"),
      ],
    }),
  );
  const text = readFileSync(ledgerPath(world), "utf8");
  expect(text).toContain("| 07-spawn-1 | checkpoint | Fix the lexer |");
  expect(text).toContain("| conv-1 | ended | Plan \\| then build |");
});

// spawn-ledger.test.ts:48 the Spawn ledger (issue #150) › keeps a proposal's summary to one short line
conformance("formats", "a Pending spawn's row shows its body on one line, cut to 159 characters and an ellipsis", async (t) => {
  const world = t.world({ tickets: [ticket("07"), ticket("08")], config: DEFAULTS });
  const gate = join(world.root, "gate");
  // 07 runs until the case opens the gate, so 08's proposals wait for the
  // next super-step boundary as Pending spawns.
  world.stubs.script("07", { waitFor: gate });
  const long = `First line\nsecond line\n${"x".repeat(300)}`;
  const overlapping = "Overlaps the Ticket that is still running.";
  world.stubs.script("08", {
    spawn: [
      { title: "Long one", body: long },
      { title: "Second", body: overlapping, overlaps: ["07"] },
    ],
  });
  await t.start(world);
  try {
    await expectLedger(
      world,
      ledger({
        tickets: [
          { id: "07", status: "in-progress", title: "T07" },
          { id: "08", status: "done", title: "T08" },
        ],
        pending: [{ id: "proposal-1", parent: "08", title: "Long one", body: long }],
        held: [{ id: "proposal-2", parent: "08", reason: "overlaps 07", title: "Second", body: overlapping }],
      }),
    );
    const flat = `First line second line ${"x".repeat(300)}`.slice(0, 159);
    const pendingRow = readFileSync(ledgerPath(world), "utf8").split("\n").find((l: string) => l.startsWith("| proposal-1 "))!;
    expect(pendingRow.endsWith(`| First line second line ${"x".repeat(136)}… |`)).toBe(true);
    expect(pendingRow).toContain(`${flat}…`);
    expect(pendingRow.length).toBeLessThan(220);
  } finally {
    writeFileSync(gate, "");
  }
});

// gap: engine/spawn-ledger.ts:33-43 (a held row's body flattened and cut)
conformance("formats", "a held proposal's summary is cut the same way", async (t) => {
  const long = `First line\nsecond line\n${"x".repeat(300)}`;
  const world = t.world({ tickets: [ticket("01")], config: { ...DEFAULTS, spawnCaps: { perAttempt: 0 } } });
  world.stubs.script("01", { spawn: [{ title: "Long one", body: long }] });
  const server = await t.start(world);
  await untilReview(server.http);
  await expectLedger(
    world,
    ledger({
      tickets: [{ id: "01", status: "done", title: "T01" }],
      held: [{ id: "proposal-1", parent: "01", reason: "per-attempt cap", title: "Long one", body: long }],
    }),
  );
  const heldRow = readFileSync(ledgerPath(world), "utf8").split("\n").find((l: string) => l.startsWith("| proposal-1 "))!;
  expect(heldRow.endsWith(`| First line second line ${"x".repeat(136)}… |`)).toBe(true);
});

// ---------------------------------------------------------------------------
// runs/held-spawns.json.
// ---------------------------------------------------------------------------

// spawn-proposals.test.ts:93 held spawns in the spawn proposals › writes through a rename, leaving no temporary file behind
conformance("formats", "a held proposal is written to held-spawns.json, with no temporary file left beside it", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: { ...DEFAULTS, spawnCaps: { perAttempt: 0 } } });
  const body = "Held because the per-attempt cap is zero.";
  world.stubs.script("01", { spawn: [{ title: "Held one", body }] });
  const server = await t.start(world);
  await untilReview(server.http);
  expectParsedEqual(
    readProposals(world),
    {
      seq: 1,
      proposalFrom: 0,
      pending: [],
      held: [
        {
          id: "proposal-1",
          parentId: "01",
          origin: "ticket",
          proposal: { title: "Held one", body },
          reason: "per-attempt",
          at: expect.any(String),
        },
      ],
      recovered: [],
    },
    "runs/held-spawns.json",
  );
  expect(readdirSync(join(world.pool, "runs")).filter((f: string) => f.startsWith("held-spawns.json.") || f.includes(".tmp"))).toEqual([]);
});

// spawn-proposals.test.ts:102 held spawns in the spawn proposals › refuses a file it cannot read rather than holding over it
conformance("formats", "a torn held-spawns.json stops the server, naming the file, and is left as it was", async (t) => {
  const world = t.world({ tickets: [ticket("01")], config: DEFAULTS, poolFiles: { "runs/held-spawns.json": "{torn" } });
  const refused = await refusedStart(world);
  expect(refused.code, refused.output).not.toBeNull();
  expect(refused.code).not.toBe(0);
  expect(refused.output).toContain(join(world.pool, "runs", "held-spawns.json"));
  expect(refused.output).toContain("cannot be read");
  expectSameFile(join(world.pool, "runs", "held-spawns.json"), "{torn");
});

// spawn-proposals.test.ts:243 pending spawns in the spawn proposals › tells the held-N ids issued before issue #150 from the proposal-N ids after
// spawn-proposals.test.ts:283 pending spawns in the spawn proposals › reads a held-spawns file from before pending spawns existed
conformance("formats", "a held-spawns.json from before issue #150 keeps its held-N ids and issues proposal-N after them", async (t) => {
  const old = {
    seq: 2,
    held: [
      {
        id: "held-2",
        parentId: "00",
        origin: "ticket",
        proposal: { title: "Old held", body: "Held before pending spawns existed." },
        reason: "per-attempt",
        at: AT,
      },
    ],
  };
  const world = t.world({
    tickets: [ticket("00", { status: "done" }), ticket("01")],
    config: DEFAULTS,
    poolFiles: { "runs/held-spawns.json": `${JSON.stringify(old, null, 2)}\n` },
  });
  const body = "A new proposal, held for what it overlaps.";
  world.stubs.script("01", {
    spawn: [{ title: "New one", body, overlaps: ["held-1", "held-3", "proposal-2"] }],
  });
  const server = await t.start(world);
  const first = await snapshot(server.http);
  expect(first.pendingSpawns).toEqual([]);
  expect(first.heldSpawns.map((h) => h.id)).toEqual(["held-2"]);

  await until(
    () => readProposals(world),
    (file) => file.held.length === 2,
    { ms: 30_000, what: "the new proposal to be held" },
  );
  const file = readProposals(world);
  expect(file.seq).toBe(3);
  expect(file.proposalFrom).toBe(2);
  expect(file.pending).toEqual([]);
  expect(file.held[1]).toMatchObject({
    id: "proposal-3",
    parentId: "01",
    reason: "overlaps",
    unknownOverlaps: ["held-3", "proposal-2"],
    proposal: { title: "New one", body, overlaps: ["held-1", "held-3", "proposal-2"] },
  });
});

