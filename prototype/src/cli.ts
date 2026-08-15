import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { compileGraph } from "./graph.ts";
import { startServer } from "./server.ts";

const DEFAULT_TOPIC =
  "LangGraph.js vs a hand-rolled runtime for this course";

const { values: flags } = parseArgs({
  options: {
    topic: { type: "string", default: DEFAULT_TOPIC },
    thread: { type: "string", default: "demo" },
    port: { type: "string", default: "8787" },
    "stub-grill": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const threadId = flags.thread;
const port = Number(flags.port);
const topic = flags.topic;
const stubGrill = flags["stub-grill"];
const config = {
  configurable: { thread_id: threadId },
  durability: "sync" as const,
  recursionLimit: 50,
};

const graph = compileGraph();
const server = startServer({ graph, threadId, port });
const url = `http://127.0.0.1:${port}`;
console.log(`ui ${url}`);
if (!flags["no-open"]) openBrowser(url);

const rl = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;
const pendingLines: string[] = [];
let stdinBuffer = "";
let stdinWaiter: ((line: string) => void) | undefined;
if (!rl) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string | Buffer) => {
    stdinBuffer += String(chunk);
    const parts = stdinBuffer.split("\n");
    stdinBuffer = parts.pop() ?? "";
    for (const part of parts) pendingLines.push(part);
    flushWaiter();
  });
  process.stdin.on("end", () => {
    if (stdinBuffer) pendingLines.push(stdinBuffer);
    stdinBuffer = "";
    flushWaiter();
  });
}
const snap = await graph.getState(config);
let input: unknown;

if (hasInterrupt(snap)) {
  input = new Command({ resume: await promptResume(snap) });
} else if ((snap.next?.length ?? 0) > 0) {
  input = null;
  console.log(`resuming thread ${threadId} → ${snap.next.join(", ")}`);
} else {
  input = { topic, stubGrill };
  console.log(
    `starting thread ${threadId}${stubGrill ? " (stub grill)" : ""}`,
  );
}

try {
  while (true) {
    const result = await graph.invoke(
      input as Parameters<typeof graph.invoke>[0],
      config,
    );
    if (!isInterrupted(result)) {
      console.log("\ndone.");
      const final = await graph.getState(config);
      console.log(`tickets: ${summarizeTickets(final.values)}`);
      if (process.stdin.isTTY) {
        console.log(`ui still at ${url} — Ctrl-C to quit`);
        await new Promise(() => undefined);
      } else {
        server.close();
      }
      break;
    }
    const payload = result[INTERRUPT][0]?.value;
    console.log("\n--- interrupt ---");
    console.log(JSON.stringify(payload, null, 2));
    input = new Command({ resume: await ask(payload) });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  server.close();
} finally {
  rl?.close();
}

function hasInterrupt(snap: { tasks: { interrupts: unknown[] }[] }) {
  return snap.tasks.some((task) => task.interrupts.length > 0);
}

async function promptResume(snap: {
  tasks: { interrupts: { value?: unknown }[] }[];
}) {
  const payload = snap.tasks.flatMap((task) => task.interrupts)[0]?.value;
  console.log("\n--- interrupt (from checkpoint) ---");
  console.log(JSON.stringify(payload, null, 2));
  return ask(payload);
}

function flushWaiter() {
  if (!stdinWaiter || pendingLines.length === 0) return;
  const next = pendingLines.shift();
  const waiter = stdinWaiter;
  stdinWaiter = undefined;
  waiter(next ?? "");
}

async function readLine(prompt: string): Promise<string> {
  if (rl) return (await rl.question(prompt)).trim();
  process.stdout.write(prompt);
  if (pendingLines.length > 0) return (pendingLines.shift() ?? "").trim();
  return new Promise((resolve) => {
    stdinWaiter = (line) => resolve(line.trim());
  });
}

async function ask(payload: unknown): Promise<unknown> {
  const kind =
    payload && typeof payload === "object" && "kind" in payload
      ? String((payload as { kind: unknown }).kind)
      : "";
  if (kind === "grill-failed") {
    const line = (await readLine("resume or reset? ")).toLowerCase();
    return { action: line.startsWith("reset") ? "reset" : "resume" };
  }
  if (kind === "approve-spec") {
    const line = (await readLine("approve or reject? ")).toLowerCase();
    return { action: line.startsWith("reject") ? "reject" : "approve" };
  }
  if (kind === "review") {
    const line = await readLine("approve / retry T2 / replan? ");
    const lower = line.toLowerCase();
    if (lower.startsWith("replan")) return { action: "replan" };
    if (lower.startsWith("retry")) {
      const ids = line
        .slice(5)
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      return { action: "retry", ids: ids.length ? ids : ["T2"] };
    }
    return { action: "approve" };
  }
  const line = await readLine("resume value (json or text): ");
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return line;
  }
}

function summarizeTickets(values: { tickets?: { id: string; status: string }[] }) {
  return (values.tickets ?? [])
    .map((ticket) => `${ticket.id}:${ticket.status}`)
    .join(" ") || "(none)";
}

function openBrowser(href: string) {
  spawn("xdg-open", [href], { stdio: "ignore", detached: true }).unref();
}
