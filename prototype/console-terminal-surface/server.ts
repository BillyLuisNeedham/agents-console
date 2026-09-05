/**
 * PROTOTYPE — throwaway, issue #29 terminal-surface exploration (surface B).
 *
 * Bridge server for surface B: an embedded xterm.js terminal in the browser
 * that reads and writes a real herdr pane through the daemon's unix socket.
 *
 * herdr speaks newline-delimited JSON-RPC over the socket, ONE REQUEST PER
 * CONNECTION: send `{"id":..,"method":..,"params":..}\n`, read exactly one
 * JSON line, then the server closes the socket. Every call therefore opens a
 * fresh node:net connection.
 *
 * Safety: live agent sessions run in real panes. This server only ever reads
 * (pane.list / pane.read) arbitrary panes; every mutating call (send / focus)
 * is refused for any pane id this process did not itself spawn (tracked in the
 * module-level `spawned` Set).
 *
 * Endpoints:
 *   GET  /api/health            → {ok:true}
 *   GET  /api/panes             → {panes}                     (pane.list)
 *   POST /api/spawn-fake-agent  → {pane_id}                   (tab.create with a per-ticket label + feed a fake agent loop; body {"cmd":"...","label":"..."} overrides)
 *   GET  /api/terminal/read?pane_id=&lines=300                → {text, revision, truncated}  (pane.read recent_unwrapped/ansi — full colour, unwrapped)
 *   GET  /api/peek?pane_id=&lines=12                          → {text, revision, truncated}  (pane.read recent/text/strip_ansi — variant A read-only preview)
 *   POST /api/terminal/send {pane_id, text?, keys?}           → {ok:true}   (pane.send_input; spawned-only)
 *   POST /api/focus         {pane_id}                         → {ok:true}   (pane.focus; spawned-only)
 *
 * Static files are served from public/ (index.html at /).
 */

import { connect } from "node:net";
import { join } from "node:path";

const HERDR_SOCKET = "/home/billy/.config/herdr/herdr.sock";
const PORT = 5299;
const PUBLIC_DIR = join(import.meta.dir, "public");
// The prototype lives at <worktree root>/prototype/console-terminal-surface/,
// so the worktree root is two levels up. Fake agents are spawned there.
const WORKTREE_ROOT = join(import.meta.dir, "..", "..");

/** Pane ids this server instance spawned. Mutating calls refuse anything else. */
const spawned = new Set<string>();

/**
 * A chatty fake "agent" that prints colourful progress and, every fourth
 * step, pauses with an "approve? (y/n)" prompt that reads a real answer from
 * the terminal — so input round-trips can be demoed. Ctrl+C in the pane kills
 * it and returns to the shell.
 */
const DEFAULT_FAKE_AGENT = String.raw`i=0
while true; do
  i=$((i+1))
  if [ $((i % 4)) -eq 0 ]; then
    printf '\033[33m[agent]\033[0m ❓ approve step %d? (y/n) ' "$i"
    if read -r -t 15 ans; then
      printf '\033[32m[agent]\033[0m approved: %s\n' "$ans"
    else
      printf '\n\033[33m[agent]\033[0m step %d timed out, continuing\n' "$i"
    fi
  else
    printf '\033[32m[agent]\033[0m working on step %d...\n' "$i"
    printf '\033[90m[agent]\033[0m   status: scanning files, applying edit, re-running checks\n' "$i"
  fi
  sleep 2
done`;

/**
 * One JSON-RPC request over a fresh unix-socket connection. Resolves with the
 * `result` object; rejects with the herdr `error` body when the call fails.
 */
function rpc(method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(HERDR_SOCKET);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`herdr rpc timed out (${method})`));
    }, 10_000);
    const finish = (err: Error | null, result?: any): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "1", method, params }) + "\n");
    });
    sock.on("data", (d) => {
      buf += d.toString();
    });
    sock.on("error", (err) => finish(err));
    sock.on("close", () => {
      try {
        const msg = JSON.parse(buf);
        if (msg.error) {
          const detail =
            typeof msg.error === "object" && msg.error !== null
              ? JSON.stringify(msg.error)
              : String(msg.error);
          finish(new Error(`${method} failed: ${detail}`));
        } else {
          finish(null, msg.result);
        }
      } catch {
        finish(new Error(`bad herdr response for ${method}: ${buf}`));
      }
    });
  });
}

async function spawnFakeAgent(
  rawCmd?: unknown,
  rawLabel?: unknown,
): Promise<{ pane_id: string }> {
  const label =
    typeof rawLabel === "string" && rawLabel.trim() !== ""
      ? rawLabel.trim()
      : "fake-agent";
  const created = await rpc("tab.create", {
    label,
    focus: false,
    cwd: WORKTREE_ROOT,
  });
  const tabId: string = created?.tab?.tab_id;
  if (typeof tabId !== "string" || tabId === "") {
    throw new Error(`tab.create returned no tab id: ${JSON.stringify(created)}`);
  }
  // tab_created has no root pane id; find the pane living in the new tab.
  const list = await rpc("pane.list", {});
  const pane = (list?.panes ?? []).find(
    (p: { tab_id?: string; pane_id?: string }) => p.tab_id === tabId,
  );
  const paneId: string = pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`no pane found for new tab ${tabId}`);
  }
  spawned.add(paneId);
  const script =
    typeof rawCmd === "string" && rawCmd.trim() !== "" ? rawCmd : DEFAULT_FAKE_AGENT;
  // Feed the script one line at a time, Enter after each. A literal "\r"
  // embedded in text is treated as pasted data by the shell and does NOT
  // submit the line (verified), so each line is sent as text + keys:["Enter"].
  for (const line of script.split("\n")) {
    await rpc("pane.send_text", { pane_id: paneId, text: line });
    await rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }
  return { pane_id: paneId };
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const resolved = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC_DIR, resolved);
  let body: Bun.Blob;
  try {
    body = Bun.file(file);
    // Bun.file().exists() returns a Promise; missing files (e.g. a browser's
    // /favicon.ico probe) must 404, not crash the bridge on the lazy read.
    if (!(await body.exists())) return null;
  } catch {
    return null;
  }
  const type = file.endsWith(".html")
    ? "text/html"
    : file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".json")
          ? "application/json"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
  return new Response(body, { headers: { "content-type": type } });
}

function readLinesParam(url: URL, fallback: number): number {
  const raw = url.searchParams.get("lines");
  const n = raw !== null && raw !== "" ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), 10_000);
}

/** Wrap a handler so a herdr failure becomes a JSON error response, not a crash. */
function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err) =>
    Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }),
  );
}

/**
 * CORS: the Console UI prototype runs on the vite dev origin (e.g.
 * http://localhost:5174), so every response must carry
 * `Access-Control-Allow-Origin: *` for the cross-origin peek/focus/spawn calls.
 * OPTIONS preflights get a bare 204.
 */
function cors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "content-type");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (req.method === "GET" && pathname === "/api/panes") {
      return handle(async () => {
        const res = await rpc("pane.list", {});
        return Response.json({ panes: res?.panes ?? [] });
      });
    }

    if (req.method === "POST" && pathname === "/api/spawn-fake-agent") {
      return handle(async () => {
        let body: { cmd?: unknown; label?: unknown } = {};
        try {
          body = (await req.json()) as { cmd?: unknown; label?: unknown };
        } catch {
          body = {};
        }
        const { pane_id } = await spawnFakeAgent(body?.cmd, body?.label);
        return Response.json({ pane_id });
      });
    }

    if (req.method === "GET" && pathname === "/api/terminal/read") {
      return handle(async () => {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "missing pane_id" }, { status: 400 });
        const res = await rpc("pane.read", {
          pane_id: paneId,
          source: "recent_unwrapped",
          format: "ansi",
          strip_ansi: false,
          lines: readLinesParam(url, 300),
        });
        const read = res?.read ?? {};
        return Response.json({
          text: read.text ?? "",
          revision: read.revision ?? 0,
          truncated: read.truncated ?? false,
        });
      });
    }

    if (req.method === "GET" && pathname === "/api/peek") {
      return handle(async () => {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return Response.json({ error: "missing pane_id" }, { status: 400 });
        const res = await rpc("pane.read", {
          pane_id: paneId,
          source: "recent",
          format: "text",
          strip_ansi: true,
          lines: readLinesParam(url, 12),
        });
        const read = res?.read ?? {};
        return Response.json({
          text: read.text ?? "",
          revision: read.revision ?? 0,
          truncated: read.truncated ?? false,
        });
      });
    }

    if (req.method === "POST" && pathname === "/api/terminal/send") {
      return handle(async () => {
        const body = (await req.json()) as {
          pane_id?: unknown;
          text?: unknown;
          keys?: unknown;
        };
        const paneId = typeof body?.pane_id === "string" ? body.pane_id : "";
        if (!paneId) return Response.json({ error: "missing pane_id" }, { status: 400 });
        if (!spawned.has(paneId)) {
          return Response.json(
            {
              error:
                `refusing to send to pane ${paneId}: only panes spawned by ` +
                "this server instance accept input (safety guard for live agent panes)",
            },
            { status: 403 },
          );
        }
        const params: Record<string, unknown> = { pane_id: paneId };
        if (typeof body?.text === "string" && body.text !== "") params.text = body.text;
        if (Array.isArray(body?.keys) && body.keys.length > 0) {
          params.keys = body.keys.filter((k): k is string => typeof k === "string");
        }
        if (typeof params.text !== "string" && !Array.isArray(params.keys)) {
          return Response.json({ error: "nothing to send (text and keys both empty)" }, { status: 400 });
        }
        await rpc("pane.send_input", params);
        return Response.json({ ok: true });
      });
    }

    if (req.method === "POST" && pathname === "/api/focus") {
      return handle(async () => {
        const body = (await req.json()) as { pane_id?: unknown };
        const paneId = typeof body?.pane_id === "string" ? body.pane_id : "";
        if (!paneId) return Response.json({ error: "missing pane_id" }, { status: 400 });
        if (!spawned.has(paneId)) {
          return Response.json(
            {
              error:
                `refusing to focus pane ${paneId}: only panes spawned by this ` +
                "server instance may be focused (safety guard for live agent panes)",
            },
            { status: 403 },
          );
        }
        await rpc("pane.focus", { pane_id: paneId });
        return Response.json({ ok: true });
      });
    }

    const staticRes = await serveStatic(pathname);
    if (staticRes) return staticRes;
    return new Response("not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    return handleRequest(req).then(cors);
  },
});

console.log(`console-terminal-surface (variant B bridge) on http://localhost:${PORT}`);
console.log(`  herdr socket: ${HERDR_SOCKET}`);
console.log(`  fake-agent cwd: ${WORKTREE_ROOT}`);
