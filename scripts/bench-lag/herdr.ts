/**
 * The lag bench's herdr process: the executing fake daemon of the checkout
 * under test (a real unix socket, the real wire shape, and panes that really
 * run the attempt's wrapper), in its own process so its work never lands on
 * the server's event loop or the load generator's.
 *
 *   bun run scripts/bench-lag/herdr.ts --repo <checkout>
 *
 * Prints `READY <socket>`. The parent then sends the live pane ids over IPC
 * (`{ panes: [{ paneId, kind }] }`), and from then on every pane's rendered
 * text moves every ~2 s, the way a working agent's TUI does: a Ticket pane is
 * what the card's Peek reads, and a Conversation pane's last line is its Turn
 * state, so each change the engine's 2 s Turn read sees is a snapshot emit.
 */

import { join } from "node:path";

type FakeModule = typeof import("../../engine/herdr-executing-fake.ts");

const i = process.argv.indexOf("--repo");
const repo = i >= 0 ? process.argv[i + 1] : undefined;
if (!repo) throw new Error("herdr.ts: --repo is required");

const { startExecutingFakeHerdr } = (await import(
  join(repo, "engine/herdr-executing-fake.ts")
)) as FakeModule;

const fake = await startExecutingFakeHerdr({ rendered: "agent starting\n> " });
process.stdout.write(`READY ${fake.socketPath}\n`);

interface Pane {
  paneId: string;
  kind: "ticket" | "conversation";
}
let panes: Pane[] = [];
let tick = 0;

/** A screenful of agent transcript whose tail moves every tick. */
function screen(pane: Pane, n: number): string {
  const rows = Array.from(
    { length: 30 },
    (_, r) => `${pane.paneId} ${pane.kind} row ${r}: tool call ${n - 30 + r} read src/pkg/file.ts`,
  );
  rows.push(`working on step ${n}`);
  return rows.join("\n");
}

setInterval(() => {
  tick++;
  panes.forEach((pane, k) => {
    // A Conversation goes quiet one tick in three (its Turn settles toward
    // waiting) and moves the rest, so the engine sees Turn changes at about
    // the rate a few working Conversations produce them.
    if (pane.kind === "conversation" && (tick + k) % 3 === 0) return;
    fake.setPaneContent(pane.paneId, screen(pane, tick));
  });
}, 2_000);

process.on("message", (msg: unknown) => {
  const m = msg as { panes?: Pane[]; requests?: boolean };
  if (m.panes) panes = m.panes;
  if (m.requests) {
    const counts: Record<string, number> = {};
    for (const r of fake.requests) counts[r.method] = (counts[r.method] ?? 0) + 1;
    process.send?.({ kind: "requests", counts });
  }
});
