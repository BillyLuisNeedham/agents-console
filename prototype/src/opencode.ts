import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { packetPath, repoRoot } from "./paths.ts";

export type GrillRun = {
  ok: boolean;
  sessionId: string;
  packet: string;
  error: string;
};

export async function runGrill(opts: {
  topic: string;
  threadId: string;
  sessionId?: string;
  reset?: boolean;
}): Promise<GrillRun> {
  const dest = packetPath(opts.threadId);
  const title = `graph-grill-${opts.threadId}`;
  const prompt = [
    `Grill me about: ${opts.topic}`,
    "",
    "When we have a shared understanding, write a Packet to this exact file:",
    dest,
    "",
    "The Packet is markdown for the next node (Spec). Include the decisions and any extra context Spec needs. Suggested skills if useful.",
    "Do not run the /handoff skill. Write the file yourself, then tell me it is written so I can exit.",
  ].join("\n");

  const args = [
    "run",
    prompt,
    "--command",
    "my-grill-me",
    "--agent",
    "deepseek",
    "-i",
    "--dir",
    repoRoot,
    "--title",
    title,
  ];
  if (opts.sessionId && !opts.reset) {
    args.push("-s", opts.sessionId);
  }

  console.error("\n--- grill: launching opencode (deepseek + my-grill-me) ---\n");
  const code = await spawnInherit("opencode", args);
  const sessionId = opts.reset
    ? await findSessionId(title)
    : (opts.sessionId ?? (await findSessionId(title)));

  if (code !== 0) {
    return {
      ok: false,
      sessionId,
      packet: "",
      error: `opencode exited ${code}`,
    };
  }
  if (!existsSync(dest)) {
    return {
      ok: false,
      sessionId,
      packet: "",
      error: `no packet at ${dest} — resume the same session or reset`,
    };
  }
  return {
    ok: true,
    sessionId,
    packet: readFileSync(dest, "utf8"),
    error: "",
  };
}

function spawnInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function findSessionId(title: string): Promise<string> {
  const raw = await new Promise<string>((resolve) => {
    const child = spawn(
      "opencode",
      ["session", "list", "--format", "json", "-n", "30"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("close", () => resolve(out));
  });
  try {
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          "sessions" in parsed &&
          Array.isArray((parsed as { sessions: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions
        : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const rowTitle = String(rec.title ?? rec.Title ?? "");
      const id = String(rec.id ?? rec.ID ?? rec.sessionID ?? rec.sessionId ?? "");
      if (id && rowTitle.includes(title)) return id;
    }
    const first = rows[0];
    if (first && typeof first === "object") {
      const rec = first as Record<string, unknown>;
      return String(rec.id ?? rec.ID ?? rec.sessionID ?? rec.sessionId ?? "");
    }
  } catch {
    return "";
  }
  return "";
}
