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

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Mark } from "./timeline.ts";

type FakeModule = typeof import("../../conformance/fixtures/herdr-executing-fake.ts");

const i = process.argv.indexOf("--repo");
const repo = i >= 0 ? process.argv[i + 1] : undefined;
if (!repo) throw new Error("herdr.ts: --repo is required");

// The fake moved to conformance/fixtures (ADR-0036); a checkout from before
// the move still keeps it under engine/.
const fakePath = [
  join(repo, "conformance/fixtures/herdr-executing-fake.ts"),
  join(repo, "engine/herdr-executing-fake.ts"),
].find((path) => existsSync(path));
if (!fakePath) throw new Error(`herdr.ts: no executing fake herdr in ${repo}`);

const { startExecutingFakeHerdr } = (await import(fakePath)) as FakeModule;

// Every new pane shows claude's ready frame (conformance/harness/herdr-tui.ts
// TUI_FRAMES), which the Rust server's wrapped `claude` launches wait for
// before they type the prompt; the Bun server's stub harnesses declare no
// TUI and never read it.
const CLAUDE_READY_FRAME = "Claude Code v1\n❯ ";
const fake = await startExecutingFakeHerdr({ rendered: CLAUDE_READY_FRAME });
process.stdout.write(`READY ${fake.socketPath}\n`);

// This process's timeline (issue #161), on the wall clock the server and the
// proxy share: when each RPC reached the fake (its request log is appended
// as the call lands), and every late wake of this loop, so a slow Open in
// herdr can be told apart from a slow server.
const wall = () => performance.timeOrigin + performance.now();
const timeline: Mark[] = [];
const keep = (m: Mark) => {
  if (timeline.length < 100_000) timeline.push(m);
};
const logRequest = fake.requests.push.bind(fake.requests);
fake.requests.push = (...calls) => {
  const at = Math.round(wall() * 10) / 10;
  for (const call of calls) keep({ at, what: "herdr got", ms: 0, detail: call.method });
  return logRequest(...calls);
};
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const lag = now - lastTick - 10;
  if (lag >= 3) keep({ at: Math.round((wall() - lag) * 10) / 10, what: "herdr lag", ms: Math.round(lag * 100) / 100, detail: "" });
  lastTick = now;
}, 10);

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
  const m = msg as { panes?: Pane[]; requests?: boolean; timeline?: boolean };
  if (m.timeline) process.send?.({ kind: "timeline", marks: timeline });
  if (m.panes) panes = m.panes;
  if (m.requests) {
    const counts: Record<string, number> = {};
    for (const r of fake.requests) counts[r.method] = (counts[r.method] ?? 0) + 1;
    process.send?.({ kind: "requests", counts });
  }
});
