/**
 * What the `protocol` and `http` cases of the inventory's ticket C02 share:
 * the deltas a socket was sent from a point on, a pool log made long by a
 * restored checkpoint, the built UI the served page needs, and the boot
 * snapshot that page embeds. Everything here works from outside the server,
 * as the cases do.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddedBoot, SnapshotDelta } from "../../engine/protocol.ts";
import type { ConversationView, EnrichedSnapshot, PoolConfig } from "../../engine/wire.ts";
import type { SocketClient } from "../fixtures/socket-fixture.ts";
import type { Case, CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { until } from "../harness/pool-files.ts";
import { CHECKOUT } from "../harness/server.ts";
import type { World } from "../harness/world.ts";
import { snapshotOf, untilSnapshot } from "./config-support.ts";

/** The stub harness every case's pool runs. */
export const CLAUDE = { defaults: { harness: "claude", model: "m" } } satisfies PoolConfig;

// engine/protocol.ts EMBED_ELEMENT_ID: the page's boot snapshot element.
export const EMBED_ELEMENT_ID = "console-boot";

// engine/engine.ts REVIEW_TICKET_ID: the final Review gate's Interrupt.
export const REVIEW = "REVIEW";

/** The deltas a socket was sent from frame `from` on, in order. */
export function deltasFrom(client: SocketClient, from = 0): SnapshotDelta[] {
  return client.frames.slice(from).flatMap((frame) => (frame.type === "delta" ? [frame.delta] : []));
}

/** Wait for a quiescent pool whose Interrupts include one for `ticket`. */
export function interruptFor(server: CaseServer, ticket: string, ms = 30_000): Promise<EnrichedSnapshot> {
  return untilSnapshot(
    server,
    (snap) => snap.phase === "quiescent" && snap.state.interrupts.some((i) => i.ticketId === ticket),
    `an Interrupt for ${ticket}`,
    ms,
  );
}

/**
 * Wait for the pool to settle, then for the socket to hold the version GET
 * /api/state serves, and hand that version back. A push is coalesced and a
 * read's reply never waits for one, so a round trip alone can overtake the
 * frame carrying the settled snapshot: this waits for the frame itself.
 */
export async function settledOn(
  server: CaseServer,
  client: SocketClient,
  done: (snapshot: EnrichedSnapshot) => boolean,
  what: string,
  ms = 30_000,
): Promise<EnrichedSnapshot> {
  await untilSnapshot(server, done, what, ms);
  const held = await until(
    async () => {
      const snapshot = await snapshotOf(server);
      return client.pushed?.snapshot.seq === snapshot.seq ? snapshot : null;
    },
    (snapshot) => snapshot !== null,
    { what: "the socket to hold the settled snapshot", ms: 20_000 },
  );
  await client.sync();
  return held!;
}

/** The pool log lines a restored checkpoint carries: `restored line 1` and on. */
export function restoredLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `restored line ${i + 1}`);
}

/**
 * Give a world's pool a log `count` lines long before the server under test
 * boots on it. A first server runs the pool to rest and stops; the last
 * checkpoint it wrote to console.db then has its log replaced by
 * `restoredLines(count)`, every other key as that server wrote it. The next
 * server restores that log as it boots (rehydrate, engine/engine.ts) and goes
 * on from it, so its pool log is the restored lines and then its own.
 */
export async function restoreLongLog(t: Case, world: World, count: number): Promise<string[]> {
  const first = await t.start(world);
  await untilSnapshot(first, (snap) => snap.phase === "quiescent", "the first server's pool to rest");
  await first.stop();
  const lines = restoredLines(count);
  const db = new Database(join(world.pool, "console.db"));
  try {
    const last = db.query("SELECT seq, state FROM checkpoints ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; state: string }
      | null;
    if (last === null) throw new Error("the first server wrote no checkpoint to restore from");
    const state = JSON.parse(last.state) as Record<string, unknown>;
    db.run("UPDATE checkpoints SET state = ? WHERE seq = ?", [JSON.stringify({ ...state, log: lines }), last.seq]);
  } finally {
    db.close();
  }
  return lines;
}

/**
 * The Bun server serves the UI from the checkout's ui/dist, and the Rust
 * binary embeds it (ADR-0036); either way a case that reads the page needs a
 * built UI, so a Bun run without one builds it first, as Boot does.
 */
export function ensureBuiltUi(t: Case): void {
  if (t.kind !== "bun" || existsSync(join(CHECKOUT, "ui", "dist", "index.html"))) return;
  const build = Bun.spawnSync([process.execPath, "run", "build"], {
    cwd: join(CHECKOUT, "ui"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`the UI build failed:\n${build.stderr.toString()}`);
}

/** The served page, and the console-boot element's text as the page carries it. */
export interface ServedPage {
  html: string;
  /** The element's text, up to the first `</script>` after its opening tag. */
  bootText: string;
  boot: EmbeddedBoot;
}

/**
 * GET a page path, which must answer 200 text/html, and read the boot
 * snapshot out of it. The element is read the way a browser's parser ends
 * it, at the first `</script>`, so an escape that failed would cut it short
 * and fail its parse.
 */
export async function servedPage(server: CaseServer, path = "/"): Promise<ServedPage> {
  const res = await server.http.get(path);
  if (res.status !== 200) throw new Error(`GET ${path} answered ${res.status}: ${res.text.slice(0, 200)}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/html")) throw new Error(`GET ${path} answered ${type}, not text/html`);
  const open = `<script id="${EMBED_ELEMENT_ID}" type="application/json">`;
  const at = res.text.indexOf(open);
  if (at < 0) throw new Error(`GET ${path} carries no ${EMBED_ELEMENT_ID} element`);
  const start = at + open.length;
  const end = res.text.indexOf("</script>", start);
  if (end < 0) throw new Error(`GET ${path}'s ${EMBED_ELEMENT_ID} element is never closed`);
  const bootText = res.text.slice(start, end);
  return { html: res.text, bootText, boot: JSON.parse(bootText) as EmbeddedBoot };
}

// ---------------------------------------------------------------------------
// A terminal-backed pool for Conversations, on the fake herdr.
// ---------------------------------------------------------------------------

/**
 * What every pane the fake opens shows once its wrapper runs: claude's ready
 * pattern and its idle prompt glyph, so a Conversation's launch passes its
 * readiness wait and its Turn settles to waiting.
 */
const READY_FRAME = "Claude Code v · Ask anything\n❯ ";

/**
 * A terminal-backed git pool of one done Ticket whose stub TUIs hold their
 * panes, up on the fake herdr. A terminal-backed launch names no outcome
 * file in its argv, so each is keyed by its binary's name.
 */
export async function terminalPool(t: Case): Promise<{ world: World; herdr: HerdrProcess; server: CaseServer }> {
  const world = t.world({
    tickets: [{ file: "01-t.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
    config: { ...CLAUDE, terminal: "herdr" },
  });
  // Long enough for any case; a stub ends early once its world is gone.
  for (const key of ["_claude", "_opencode", "_agent"]) world.stubs.script(key, { hold: 150 });
  const herdr = await t.herdr(world, { rendered: READY_FRAME });
  const server = await t.start(world, { herdr });
  return { world, herdr, server };
}

/** Start a Conversation over POST /api/conversations, which must answer 201, and wait for its Turn to rest. */
export async function startConversation(server: CaseServer, title: string): Promise<ConversationView> {
  const answer = await server.http.post("/api/conversations", { title });
  if (answer.status !== 201) throw new Error(`POST /api/conversations answered ${answer.status}: ${answer.text}`);
  const { id } = answer.json<{ conversation: ConversationView }>().conversation;
  const rested = await untilSnapshot(
    server,
    (snap) => snap.state.conversations.find((c) => c.id === id)?.turn.state === "waiting",
    `${id}'s Turn to rest`,
    60_000,
  );
  return rested.state.conversations.find((c) => c.id === id)!;
}
