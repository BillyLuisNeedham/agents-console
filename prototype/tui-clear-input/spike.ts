// Throwaway spike: paste long multi-line text into a live opencode or cursor
// TUI running in a real herdr pane, then try candidate input-clear key
// sequences. See FINDINGS.md for what it learned. Not production code.
//
//   bun prototype/tui-clear-input/spike.ts <opencode|cursor>
//
// Requires a running herdr daemon on the default socket and the harness CLI
// on PATH. One fresh unfocused tab per candidate. claude is out of scope.

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTab, herdrRpc, paneSendInput } from "../../engine/herdr.ts";

const SOCKET = `${process.env.HOME}/.config/herdr/herdr.sock`;
const TOKEN = "SPIKECLEARMARKER";
const FIRST = `${TOKEN}-FIRST`;
const LAST = `${TOKEN}-LAST`;
const CURSOR_TUI = "agent --force --trust --model auto";

const harness = process.argv[2] ?? "opencode";
if (harness !== "opencode" && harness !== "cursor") {
  throw new Error("harness must be opencode or cursor (claude is out of scope)");
}

type Candidate = { name: string; keys: string[] };

const CANDIDATES: Candidate[] = [
  { name: "ctrl+u", keys: ["ctrl+u"] },
  { name: "esc", keys: ["esc"] },
  // herdr 0.8.2 rejects the name "delete" (observed: invalid_key). The
  // select-all+delete candidate is therefore ctrl+a then backspace, which
  // is the same chord a TUI would receive for select-all then delete.
  { name: "select-all+delete", keys: ["ctrl+a", "backspace"] },
  { name: "ctrl+a+ctrl+k", keys: ["ctrl+a", "ctrl+k"] },
  { name: "ctrl+c", keys: ["ctrl+c"] },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fixturePaste(): string {
  // Long enough to be multi-line (so a one-line kill is a partial, not a
  // pass) and short enough that the last few lines stay in the input
  // viewport. OpenCode's input box only shows about three lines; FIRST may
  // still scroll out, so classification also counts TOKEN occurrences.
  const lines: string[] = [FIRST];
  for (let i = 1; i <= 8; i++) {
    lines.push(
      `${TOKEN}-L${String(i).padStart(2, "0")} unique paste line ${i} for the clear-key probe`,
    );
  }
  lines.push(LAST);
  return lines.join("\n");
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

async function dump(tag: string, paneId: string, tail = 900): Promise<string> {
  const text = await readPane(paneId, 200);
  console.log(`--- ${tag} (${text.length} chars) ---`);
  console.log(text.slice(-tail));
  return text;
}

function placeholderOf(h: string): string {
  return h === "cursor" ? "Plan, search, build anything" : "Ask anything";
}

function chromeOf(h: string): string {
  return h === "cursor" ? "Cursor Agent" : "OpenCode";
}

function tokenCount(text: string): number {
  return text.split(TOKEN).length - 1;
}

function classify(h: string, afterPaste: string, afterClear: string): string {
  const placeholder = placeholderOf(h);
  const chrome = chromeOf(h);
  const pasteTokens = tokenCount(afterPaste);
  const clearTokens = tokenCount(afterClear);
  const pasteHadEcho = pasteTokens > 0 || afterPaste.includes("Pasted text");
  const lastRemains = afterClear.includes(LAST);
  const collapseRemains = afterClear.includes("Pasted text");
  const placeholderBack = afterClear.includes(placeholder);
  const chromeGone =
    !afterClear.includes(chrome) &&
    (h === "opencode"
      ? !afterClear.includes("tab agents")
      : !afterClear.includes("Run Everything"));

  console.log(
    `classify pasteTokens=${pasteTokens} clearTokens=${clearTokens} last=${lastRemains} collapse=${collapseRemains} placeholder=${placeholderBack} chromeGone=${chromeGone}`,
  );

  if (chromeGone) return "exited";
  if (!pasteHadEcho) return "unknown (paste never echoed)";
  if (collapseRemains) return "uncleared (collapse marker remains)";
  if (clearTokens === 0 && !collapseRemains) {
    return placeholderBack ? "cleared" : "cleared (placeholder not back)";
  }
  if (clearTokens < pasteTokens && !lastRemains) {
    return "partial (last line only)";
  }
  if (clearTokens < pasteTokens) return "partial";
  if (placeholderBack && clearTokens > 0) return "submitted";
  return "uncleared";
}

async function waitReady(paneId: string): Promise<boolean> {
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const text = await readPane(paneId, 200);
    const match =
      harness === "cursor"
        ? text.includes("Cursor Agent") &&
          text.includes("Run Everything") &&
          text.length > 400
        : text.includes("Ask anything") &&
          text.includes("tab agents") &&
          text.length > 400;
    if (match) {
      stable++;
      if (stable >= 3) return true;
    } else {
      stable = 0;
    }
  }
  return false;
}

async function openPane(label: string, cwd: string): Promise<{
  tabId: string;
  paneId: string;
}> {
  const created = await herdrRpc(SOCKET, "tab.create", {
    label,
    focus: false,
    cwd,
  });
  const tabId = (created as { tab?: { tab_id?: string } }).tab?.tab_id as string;
  const list = (await herdrRpc(SOCKET, "pane.list", {})) as {
    panes?: { tab_id?: string; pane_id?: string }[];
  };
  const paneId = list.panes?.find((p) => p.tab_id === tabId)?.pane_id as string;
  return { tabId, paneId };
}

const work = join(tmpdir(), "spike-clear-work");
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "README.md"), "# Spike clear-input work\n");
const paste = fixturePaste();
const launch =
  harness === "cursor" ? CURSOR_TUI : "opencode";

const probesOnly = process.argv[3] === "probes";

console.log(
  `harness=${harness} paste=${paste.length} chars / ${paste.split("\n").length} lines probesOnly=${probesOnly}`,
);

if (!probesOnly) {
for (const candidate of CANDIDATES) {
  const label = `clr-${harness}-${candidate.name.replace(/[^a-z0-9]+/g, "").slice(0, 12)}`;
  const { tabId, paneId } = await openPane(label, work);
  console.log(`\n==== ${candidate.name} tab=${tabId} pane=${paneId} ====`);
  try {
    await sleep(1200);
    await paneSendInput(SOCKET, paneId, {
      text: `script -qfc '${launch}' ${join(tmpdir(), `spike-clear-${harness}-${candidate.name.replace(/[^a-z0-9]+/g, "")}.typescript`)}`,
    });
    await paneSendInput(SOCKET, paneId, { keys: ["enter"] });
    const ready = await waitReady(paneId);
    if (!ready) {
      await dump("READY TIMEOUT", paneId, 900);
      console.log(`VERDICT harness=${harness} candidate=${candidate.name} result=ready-timeout`);
      continue;
    }
    console.log("ready");
    await dump("ready frame", paneId, 500);
    await paneSendInput(SOCKET, paneId, { text: paste });
    await sleep(1500);
    const afterPaste = await dump("after paste", paneId, 700);
    try {
      await paneSendInput(SOCKET, paneId, { keys: candidate.keys });
    } catch (err) {
      console.log(`VERDICT harness=${harness} candidate=${candidate.name} keys=${JSON.stringify(candidate.keys)} result=invalid-key (${String(err)})`);
      continue;
    }
    await sleep(1200);
    const afterClear = await dump(`after ${candidate.name}`, paneId, 900);
    const result = classify(harness, afterPaste, afterClear);
    console.log(
      `VERDICT harness=${harness} candidate=${candidate.name} keys=${JSON.stringify(candidate.keys)} result=${result}`,
    );
  } finally {
    await closeTab(SOCKET, tabId).catch(() => {});
  }
}
}

async function runTrial(
  name: string,
  afterReady: (paneId: string) => Promise<void>,
): Promise<void> {
  const label = `clr-${harness}-${name.replace(/[^a-z0-9]+/g, "").slice(0, 12)}`;
  const { tabId, paneId } = await openPane(label, work);
  console.log(`\n==== ${name} tab=${tabId} pane=${paneId} ====`);
  try {
    await sleep(1200);
    await paneSendInput(SOCKET, paneId, {
      text: `script -qfc '${launch}' ${join(tmpdir(), `spike-clear-${harness}-${name.replace(/[^a-z0-9]+/g, "")}.typescript`)}`,
    });
    await paneSendInput(SOCKET, paneId, { keys: ["enter"] });
    const ready = await waitReady(paneId);
    if (!ready) {
      await dump("READY TIMEOUT", paneId, 900);
      console.log(`VERDICT harness=${harness} candidate=${name} result=ready-timeout`);
      return;
    }
    console.log("ready");
    await dump("ready frame", paneId, 500);
    await afterReady(paneId);
  } finally {
    await closeTab(SOCKET, tabId).catch(() => {});
  }
}

await runTrial("empty-ctrl-c", async (paneId) => {
  await paneSendInput(SOCKET, paneId, { keys: ["ctrl+c"] });
  await sleep(1200);
  const after = await dump("empty then ctrl+c", paneId, 900);
  const placeholderBack = after.includes(placeholderOf(harness));
  const chromeGone =
    harness === "opencode"
      ? !after.includes("tab agents")
      : !after.includes("Run Everything") && !after.includes("Cursor Agent");
  const exitHint = after.includes("Press Ctrl+C again");
  console.log(
    `VERDICT harness=${harness} candidate=empty-ctrl-c result=${chromeGone ? "exited" : "still-in-tui"} placeholder=${placeholderBack} exitHint=${exitHint} tokens=${tokenCount(after)}`,
  );
});

await runTrial("clear-then-repaste", async (paneId) => {
  await paneSendInput(SOCKET, paneId, { text: paste });
  await sleep(1500);
  await dump("first paste", paneId, 700);
  await paneSendInput(SOCKET, paneId, { keys: ["ctrl+c"] });
  await sleep(1200);
  const afterClear = await dump("after ctrl+c", paneId, 700);
  await paneSendInput(SOCKET, paneId, { text: paste });
  await sleep(1500);
  const afterRepaste = await dump("second paste after clear", paneId, 700);
  const chromeGone =
    harness === "opencode"
      ? !afterRepaste.includes("tab agents")
      : !afterRepaste.includes("Run Everything") &&
        !afterRepaste.includes("Cursor Agent");
  const secondLanded =
    afterRepaste.includes(LAST) || afterRepaste.includes("Pasted text");
  console.log(
    `VERDICT harness=${harness} candidate=clear-then-repaste result=${chromeGone ? "exited" : secondLanded ? "repaste-landed" : "repaste-lost"} clearTokens=${tokenCount(afterClear)} repasteTokens=${tokenCount(afterRepaste)} exitHint=${afterClear.includes("Press Ctrl+C again")}`,
  );
});

console.log("done");
