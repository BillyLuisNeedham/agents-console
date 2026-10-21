/**
 * A claude dialog that comes up mid-run in a Ticket's pane, seen from outside
 * the server (ADR-0036): the engine never answers it, and its dialog watch
 * raises a dialog Interrupt naming it while it holds the pane, clears it when
 * the pane reads clean again or the attempt ends, and is not fooled by a
 * dialog's heading in the agent's own output above its prompt box. Answering
 * the Interrupt only dismisses it.
 */

import { expect } from "bun:test";
import { conformance, type Case, type CaseServer } from "../harness/case.ts";
import type { HerdrProcess } from "../harness/herdr.ts";
import { awaitPrompt, tuiStandIn } from "../harness/herdr-tui.ts";
import { readEvents, readMarkers, until } from "../harness/pool-files.ts";
import {
  AUTO_MODE_DIALOG,
  CLAUDE_READY,
  interruptsOf,
  poolLogLines,
  sends,
  terminalConfig,
  ticket,
} from "./attempts-terminal-support.ts";

const HEADING = "Teach auto mode about your environment?";

/** The agent grepping a log that recorded the dialog, its prompt box below. */
const HEADING_IN_OUTPUT = [
  "● Bash(grep -n -A6 'Teach auto' runs/01.log)",
  `  ⎿ 412: ${HEADING}`,
  "       418: Enter to confirm · Esc to cancel",
  "╭──────────────────────────────────────╮",
  "│ >                                    │",
  "╰──────────────────────────────────────╯",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
  "",
].join("\n");

async function dialogsOn(server: CaseServer, id: string) {
  return (await interruptsOf(server)).filter((i) => i.ticketId === id && i.kind === "dialog");
}

async function untilDialogs(server: CaseServer, id: string, count: number) {
  return until(() => dialogsOn(server, id), (dialogs) => dialogs.length === count, {
    ms: 15_000,
    what: `${count} dialog Interrupt(s) on ${id}`,
  });
}

/** Wait until the server has read the pane's viewport `count` more times after call `from`: that many watch periods passed. */
async function untilViewportReads(herdr: HerdrProcess, paneId: string, from: number, count: number) {
  await until(
    () =>
      herdr.calls
        .slice(from)
        .filter((call) => call.method === "pane.read" && call.params.pane_id === paneId && call.params.source === "visible").length,
    (reads) => reads >= count,
    { ms: 20_000, what: `${count} viewport reads of ${paneId}` },
  );
}

/** One claude Ticket, its prompt typed into a held TUI stand-in. */
async function seeded(t: Case) {
  const world = t.world({ tickets: [ticket("01", "Dialog mid-run")], config: terminalConfig() });
  const tui = tuiStandIn(world, "claude");
  const herdr = await t.herdr(world, { rendered: CLAUDE_READY });
  const server = await t.start(world, { herdr });
  const typed = await awaitPrompt(herdr, "01");
  return { world, tui, herdr, server, paneId: typed.paneId };
}

conformance(
  "interrupts",
  "a claude dialog up in a Ticket's pane after the seed raises one dialog Interrupt naming it, sends no key, and clears when the pane reads ready again",
  async (t) => {
    const { world, herdr, server, paneId } = await seeded(t);
    const sent = sends(herdr).length;
    await herdr.control("setPaneContent", paneId, AUTO_MODE_DIALOG);

    const [raised] = await untilDialogs(server, "01", 1);
    expect(raised!.body).toContain("auto-mode setup dialog");
    expect(raised!.body).toContain(`"${HEADING}"`);
    expect(raised!.body).toContain(paneId);
    // Still up a few watch periods on: still one Interrupt, and the engine typed nothing at it.
    await untilViewportReads(herdr, paneId, herdr.calls.length, 2);
    expect(await dialogsOn(server, "01")).toHaveLength(1);
    expect(sends(herdr)).toHaveLength(sent);
    expect(readMarkers(world.pool)["01"]!.status).toBe("in-progress");

    await herdr.control("setPaneContent", paneId, CLAUDE_READY);
    await untilDialogs(server, "01", 0);
    expect(await poolLogLines(server)).toContain("interrupt cleared for 01 (dialog): the dialog left its pane");
    expect(sends(herdr)).toHaveLength(sent);
  },
);

conformance("interrupts", "answering a dialog Interrupt only dismisses it: the attempt runs on and the watch raises it again", async (t) => {
  const { world, herdr, server, paneId } = await seeded(t);
  await herdr.control("setPaneContent", paneId, AUTO_MODE_DIALOG);
  await untilDialogs(server, "01", 1);
  const sent = sends(herdr).length;

  expect((await server.http.post("/api/resume", { ticketId: "01" })).status).toBe(202);
  await until(() => poolLogLines(server), (log) => log.some((line) => line.startsWith("interrupt answered for 01 (dialog)")), {
    what: "the dialog answer in the pool log",
  });
  expect(readMarkers(world.pool)["01"]!.status).toBe("in-progress");
  expect(readEvents(world.pool, "01").map((event) => event.kind)).toEqual(["scheduled", "spawned", "answered"]);
  // The dialog is still up, so the next watch period raises it again.
  await untilDialogs(server, "01", 1);
  expect(sends(herdr)).toHaveLength(sent);
});

conformance("interrupts", "a dialog's heading in the agent's output above its prompt box raises no dialog Interrupt", async (t) => {
  const { herdr, server, paneId } = await seeded(t);
  await herdr.control("setPaneContent", paneId, HEADING_IN_OUTPUT);
  await untilViewportReads(herdr, paneId, herdr.calls.length, 3);

  expect(await dialogsOn(server, "01")).toEqual([]);
});

conformance(
  "interrupts",
  "an attempt that ends while a dialog holds its pane leaves no dialog Interrupt behind, and its crash is raised",
  async (t) => {
    const { tui, herdr, server, paneId } = await seeded(t);
    await herdr.control("setPaneContent", paneId, AUTO_MODE_DIALOG);
    await untilDialogs(server, "01", 1);

    // claude quits with the dialog still painted and no Outcome written.
    tui.release(1, 1);
    await until(() => interruptsOf(server), (interrupts) => interrupts.some((i) => i.ticketId === "01" && i.kind === "crash"), {
      ms: 30_000,
      what: "01's crash Interrupt",
    });
    expect(await dialogsOn(server, "01")).toEqual([]);
    // The pane still shows the dialog, but no attempt runs in it, so two watch periods on nothing raised it again.
    await Bun.sleep(5_000);
    expect((await interruptsOf(server)).filter((i) => i.ticketId === "01").map((i) => i.kind)).toEqual(["crash"]);
  },
);
