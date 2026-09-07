// Throwaway spike: paste a long multi-line driver prompt into a live claude or
// opencode TUI running in a real herdr pane, or type the file-referencing
// fallback. See FINDINGS.md for what it learned. Not production code.
//
//   bun prototype/tui-prompt-paste/spike.ts <claude|opencode> [paste|fallback]
//
// Requires a running herdr daemon on the default socket and the harness CLI on
// PATH. Opens an unfocused herdr tab (as the engine does), waits for a stable
// ready frame, delivers the prompt, and dumps the pane after each step.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeTab,
  herdrRpc,
  paneSendInput,
} from "../../engine/herdr.ts";

const SOCKET = `${process.env.HOME}/.config/herdr/herdr.sock`;
const harness = process.argv[2] ?? "claude";
const mode = process.argv[3] ?? "paste";

if (harness !== "claude" && harness !== "opencode") {
  throw new Error("harness must be claude or opencode");
}

async function readPane(paneId: string, lines = 200): Promise<string> {
  const res = await herdrRpc(SOCKET, "pane.read", {
    pane_id: paneId,
    source: "recent",
    format: "text",
    strip_ansi: true,
    lines,
  });
  const text = (res as { read?: { text?: unknown } } | null)?.read?.text ?? "";
  return typeof text === "string" ? text : "";
}

async function dump(tag: string, paneId: string, tail = 700): Promise<void> {
  const text = await readPane(paneId, 200);
  console.log(`--- ${tag} (${text.length} chars) ---`);
  console.log(text.slice(-tail));
}

function fixturePrompt(): string {
  return [
    "/implement /tmp/spike-work/README.md",
    "",
    "Make the README's one-paragraph summary match the repo it lives in, then commit.",
    "",
    "Context:",
    "- The engine entrypoint is engine/server.ts, started with bun.",
    "- A pool is a directory with a console.json assignment block and an AGENTS.md.",
    "",
    "Steps:",
    "1. Read the README.",
    "2. Edit the summary to be accurate.",
    "3. Commit with message: docs: correct the summary.",
    "",
    "Acceptance criteria:",
    "- The summary names the real entrypoint.",
    "- No mention of run.sh remains.",
    "",
    "Notes:",
    "- Touch nothing outside the README.",
  ].join("\n");
}

const work = join(tmpdir(), "spike-work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "README.md"), "# Spike work\n\nRun.sh flow.\n");
writeFileSync(join(work, "driver-prompt.txt"), fixturePrompt());
const prompt = fixturePrompt();

const created = await herdrRpc(SOCKET, "tab.create", {
  label: `spike-${harness}`,
  focus: false,
  cwd: work,
});
const tabId = (created as { tab?: { tab_id?: string } }).tab?.tab_id as string;
const list = (await herdrRpc(SOCKET, "pane.list", {})) as {
  panes?: { tab_id?: string; pane_id?: string }[];
};
const paneId = list.panes?.find((p) => p.tab_id === tabId)?.pane_id as string;
console.log(`tab=${tabId} pane=${paneId}`);
await new Promise((r) => setTimeout(r, 1200));

await paneSendInput(SOCKET, paneId, {
  text: `script -qfc '${harness}' ${join(tmpdir(), `spike-${harness}.typescript`)}`,
});
await paneSendInput(SOCKET, paneId, { keys: ["enter"] });

let stable = 0;
let ready = false;
let trustHandled = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const text = await readPane(paneId, 200);
  if (harness === "claude") {
    if (text.includes("No, exit") && !trustHandled) {
      await new Promise((r) => setTimeout(r, 1500));
      await paneSendInput(SOCKET, paneId, { keys: ["down"] });
      await new Promise((r) => setTimeout(r, 800));
      await paneSendInput(SOCKET, paneId, { keys: ["enter"] });
      await new Promise((r) => setTimeout(r, 2000));
      trustHandled = true;
      continue;
    }
    if (text.includes("Claude Code v") || text.includes("(shift+tab to cycle)")) {
      stable++;
      if (stable >= 2) {
        ready = true;
        break;
      }
    } else {
      stable = 0;
    }
  } else {
    if (
      text.includes("Ask anything") &&
      text.includes("tab agents") &&
      text.length > 400
    ) {
      stable++;
      if (stable >= 3) {
        ready = true;
        break;
      }
    } else {
      stable = 0;
    }
  }
}

if (!ready) {
  console.log("READY TIMEOUT");
  await dump("final", paneId, 900);
} else {
  console.log(`ready (trust dialog handled: ${trustHandled})`);
  await dump("ready frame", paneId, 600);

  if (mode === "fallback") {
    const cmd = `/implement ${join(work, "driver-prompt.txt")}`;
    console.log(`FALLBACK: ${cmd}`);
    await paneSendInput(SOCKET, paneId, { text: cmd });
    await new Promise((r) => setTimeout(r, 1000));
    await dump("typed fallback", paneId, 700);
    await paneSendInput(SOCKET, paneId, { keys: ["enter"] });
    await new Promise((r) => setTimeout(r, 5000));
    await dump("5s after enter", paneId, 800);
  } else {
    console.log(`PASTE ${prompt.length} chars / ${prompt.split("\n").length} lines`);
    await paneSendInput(SOCKET, paneId, { text: prompt });
    await new Promise((r) => setTimeout(r, 1500));
    await dump("1.5s after paste (input echo)", paneId, 700);
    await paneSendInput(SOCKET, paneId, { keys: ["enter"] });
    await new Promise((r) => setTimeout(r, 5000));
    await dump("5s after enter (transcript)", paneId, 800);
  }
}

await closeTab(SOCKET, tabId);
console.log("done");