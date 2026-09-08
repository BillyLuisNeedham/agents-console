// Throwaway spike: paste a long multi-line driver prompt into a live claude,
// opencode, or cursor TUI running in a real herdr pane, or type the
// file-referencing fallback. See FINDINGS.md for what it learned. Not
// production code.
//
//   bun prototype/tui-prompt-paste/spike.ts <claude|opencode|cursor> [paste|fallback]
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

if (harness !== "claude" && harness !== "opencode" && harness !== "cursor") {
  throw new Error("harness must be claude, opencode, or cursor");
}

// cursor's interactive TUI command, mirroring the engine's interactive spawn
// shape (engine/spawn.ts): batch flags dropped, auto-approve flags kept. The
// machine's cursor plan is free, which rejects named models, so the spike pins
// auto. --trust skips the workspace-trust prompt that --force alone leaves up.
const CURSOR_TUI = "agent --force --trust --model auto";

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
  // A realistic long driver prompt (~9.5KB / 150+ lines), the same regime the
  // claude/opencode runs recorded in FINDINGS.md used, so the cursor run is
  // comparable. Generated rather than hand-typed so the size stays stable.
  const lines: string[] = [];
  lines.push("/implement /tmp/spike-work/README.md", "");
  lines.push("Make the README's one-paragraph summary match the repo it lives in, then commit.", "");
  lines.push("# Task");
  lines.push("Update the README so its summary paragraph accurately describes the repository, then commit the change.", "");
  lines.push("");
  for (let s = 1; s <= 19; s++) {
    lines.push(`## Section ${s}`);
    lines.push(`Thoroughly inspect the codebase and record what the module under section ${s} actually does.`);
    for (let b = 1; b <= 2; b++) {
      lines.push(`- Behaviour ${b}: read the entrypoint, trace the data flow, and note the exact function and line that implements it.`);
    }
    lines.push(`- Deliverable for ${s}: one sentence capturing the module's real responsibility, quoting the key symbol.`);
    lines.push("");
  }
  lines.push("# Context");
  lines.push("- The engine entrypoint is engine/server.ts, started with bun.");
  lines.push("- A pool is a directory with a console.json assignment block and an AGENTS.md.");
  lines.push("- Terminal-backed attempts run their harness as an interactive TUI inside a herdr pane.");
  lines.push("- The prompt arrives by paste through pane.send_input, never as argv.");
  lines.push("- Readiness is a stable frame, matched on consecutive polls, not the first match.");
  lines.push("- The fallback is /implement <promptfile>.");
  lines.push("- The repository uses bun for tests (bun test) and typecheck (tsc --noEmit).");
  lines.push("- Specs live in git history, not on main; delete docs/specs files before opening a PR.");
  lines.push("");
  lines.push("# Steps");
  lines.push("1. Read the README.");
  lines.push("2. Inspect engine/server.ts to confirm the real entrypoint.");
  lines.push("3. Edit the summary so it names the real entrypoint and drops any stale references.");
  lines.push("4. Run the typecheck to confirm nothing broke.");
  lines.push("5. Commit with message: docs: correct the summary.");
  lines.push("");
  lines.push("# Acceptance criteria");
  lines.push("- The summary names the real entrypoint.");
  lines.push("- No mention of run.sh remains.");
  lines.push("- The typecheck passes unchanged.");
  lines.push("");
  lines.push("# Notes");
  lines.push("- Touch nothing outside the README.");
  lines.push("- If you find additional stale claims in the README, fix them too but keep the diff small.");
  return lines.join("\n");
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
  text: `script -qfc '${harness === "cursor" ? CURSOR_TUI : harness}' ${join(tmpdir(), `spike-${harness}.typescript`)}`,
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
  } else if (harness === "cursor") {
    if (
      text.includes("Cursor Agent") &&
      text.includes("Run Everything") &&
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