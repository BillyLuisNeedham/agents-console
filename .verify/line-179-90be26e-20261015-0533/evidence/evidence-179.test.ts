/**
 * Verifier's evidence copy (NOT part of the repo change). Re-runs the shape of
 * cases (a) and (d) from issue #179 and prints the events.jsonl lines and the
 * herdr call timestamps, so the gap between tab.create calls is on record.
 */
import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const C = "/home/billy/.herdr/worktrees/agent-console/feature-software-factory/.scratch/lines/179/conformance";
const { conformance } = await import(`${C}/harness/case.ts`);
const { untilTicketStatus } = await import(`${C}/harness/herdr-tui.ts`);
const { readEvents, until } = await import(`${C}/harness/pool-files.ts`);
const { callsOf } = await import(`${C}/harness/herdr.ts`);
const S = await import(`${C}/cases/attempts-terminal-support.ts`);

function dump(label: string, world: any, id: string, herdr: any) {
  const file = join(world.pool, "runs", `${id}.events.jsonl`);
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "(no events file)";
  const calls = herdr.calls
    .filter((c: any) => ["tab.create", "tab.close", "pane.close"].includes(c.method))
    .map((c: any) => ({ method: c.method, params: c.params, at: c.at, iso: new Date(c.at).toISOString() }));
  const retried = readEvents(world.pool, id).find((e: any) => e.kind === "launch-retried");
  const creates = callsOf(herdr, "tab.create");
  const gap = retried && creates[1] ? creates[1].at - Date.parse(retried.at) : null;
  console.log(`\n===== ${label} =====\n--- ${file}\n${raw}--- herdr tab/pane calls\n${JSON.stringify(calls, null, 1)}`);
  console.log(`--- gap second tab.create - launch-retried.at = ${gap} ms`);
  if (creates.length >= 2) console.log(`--- gap between tab.create calls = ${creates[1].at - creates[0].at} ms`);
}

conformance(
  "attempts",
  "EVIDENCE ticket exit 127 retried after backoff",
  async (t: any) => {
    const world = t.world({ tickets: [S.ticket("01", "Not found once")], config: S.terminalConfig() });
    const restore = S.shimClaude(world, "exit 127");
    const herdr = await t.herdr(world, { rendered: S.READY.claude });
    await t.start(world, { herdr });
    await S.untilEvent(world, "01", "launch-retried");
    restore();
    await untilTicketStatus(world, "01", "done", 60_000);
    await herdr.waitForCall((call: any) => call.method === "tab.close");
    await herdr.settle();
    dump("C1/C2 Ticket", world, "01", herdr);
    expect(readEvents(world.pool, "01").map((e: any) => e.kind)).toEqual(["scheduled", "launch-retried", "spawned", "exited"]);
  },
  { slow: true },
);

conformance(
  "conversations",
  "EVIDENCE conversation exit 127 retried after backoff",
  async (t: any) => {
    const world = t.world({
      tickets: [{ file: "01.md", marker: "<!-- state: id=01 blocked-by=none status=done -->" }],
      config: { defaults: { harness: "claude", model: "m" }, terminal: "herdr" },
    });
    for (const key of ["_claude", "_opencode", "_agent"]) world.stubs.script(key, { hold: 150 });
    const restore = S.shimClaude(world, "exit 127");
    const herdr = await t.herdr(world, { rendered: "Claude Code v · Ask anything\n❯ " });
    const server = await t.start(world, { herdr });
    const answer = server.http.post("/api/conversations", { title: "Found later", opening: "hello" });
    await until(
      () => readEvents(world.pool, "conv-1"),
      (read: any[]) => read.some((e) => e.kind === "launch-retried"),
      { what: "conv-1's launch-retried event" },
    );
    restore();
    const started = await answer;
    console.log(`\n--- POST /api/conversations -> ${started.status}\n${started.text}`);
    const view = started.json().conversation;
    const branchList = world.git(["branch", "--list", "--format=%(refname:short)"]);
    console.log(`--- branches:\n${branchList}`);
    if (view.branch) {
      const wt = join(world.repo, ".git", "pool-worktrees", view.branch.split("/")[1], view.branch.split("/")[2]);
      console.log(`--- worktree ${wt} exists=${existsSync(wt)}`);
    }
    await herdr.settle();
    dump("C3 Conversation", world, "conv-1", herdr);
    expect(view.status).toBe("live");
  },
  { slow: true },
);
