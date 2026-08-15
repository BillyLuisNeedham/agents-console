import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { compileGraph } from "./graph.ts";
import { protoRoot } from "./paths.ts";

type Graph = ReturnType<typeof compileGraph>;

export function startServer(opts: {
  graph: Graph;
  threadId: string;
  port: number;
}) {
  const server = createServer((req, res) => {
    void handle(req, res, opts).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { graph: Graph; threadId: string },
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/state") {
    const snap = await opts.graph.getState({
      configurable: { thread_id: opts.threadId },
    });
    json(res, {
      threadId: opts.threadId,
      next: snap.next,
      values: snap.values,
      tasks: snap.tasks.map((task) => ({
        name: task.name,
        error: task.error,
        interrupts: task.interrupts,
      })),
      metadata: snap.metadata,
    });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    html(res, readFileSync(join(protoRoot, "ui/index.html"), "utf8"));
    return;
  }
  if (url.pathname === "/app.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(readFileSync(join(protoRoot, "ui/app.js"), "utf8"));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(body);
}
