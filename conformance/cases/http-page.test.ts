/**
 * The served page and the static files, seen from outside the server
 * (ADR-0036): the boot snapshot embedded in the page, a hostile Ticket title
 * included, the build's own scripts and stylesheets with the types a browser
 * loads them by, and what a path outside the build or no route at all is
 * answered with. The first case is engine/protocol.test.ts:306 (since moved
 * to ui/src/protocol.test.ts:308), which embedded a made-up snapshot in a
 * made-up page; the rest are the inventory's gaps beside engine/server.ts.
 */

import { expect } from "bun:test";
import { connect } from "node:net";
import type { CaseServer } from "../harness/case.ts";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { doneTicket, snapshotOf } from "./config-support.ts";
import { CLAUDE, REVIEW, interruptFor, servedPage } from "./protocol-support.ts";

const HOSTILE = "</script><script>alert(1)</script>";

/**
 * A GET written on a raw connection, its path sent exactly as given: a
 * fetch resolves `..` segments before the request leaves, so only this
 * shows what the server makes of them. Answers the status and the body.
 */
function rawGet(server: CaseServer, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "localhost");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${server.port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? NaN);
      resolve({ status, body: text.slice(text.indexOf("\r\n\r\n") + 4) });
    });
  });
}

// engine/protocol.test.ts:306
conformance(
  "http",
  "the embedded boot snapshot › reads back what was embedded, a hostile title included",
  async (t) => {
    const world = t.world({
      tickets: [{ file: "01-a.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: `# ${HOSTILE}` }],
      config: CLAUDE,
    });
    const server = await t.start(world);
    await interruptFor(server, REVIEW);

    const page = await servedPage(server);
    // Every `<` in the element's JSON is escaped, so the title closes nothing:
    // the element runs whole to its own end, right before </head>.
    expect(page.bootText).not.toContain("<");
    expect(page.bootText).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
    expect(page.html).toContain(`${page.bootText}</script></head>`);
    // And it parses back to the snapshot, the title intact.
    expect(page.boot.snapshot?.state.tickets.map((ticket) => ticket.title)).toEqual([HOSTILE]);
    expectParsedEqual(page.boot.snapshot, await snapshotOf(server), "the embedded snapshot");
  },
  { timeoutMs: 120_000 },
);

// The gap at engine/server.ts:396
conformance(
  "http",
  "the served page › serves the build's scripts and stylesheets by their types, and nothing from outside the build",
  async (t) => {
    const server = await t.start(t.world({ tickets: [doneTicket("01")], config: CLAUDE }));
    await interruptFor(server, REVIEW);

    const { html } = await servedPage(server);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
    const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);
    // A module script served under any other type does not load.
    for (const [paths, type] of [
      [scripts, "text/javascript"],
      [styles, "text/css"],
    ] as const) {
      for (const path of paths) {
        const res = await server.http.get(path);
        const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        expect([path, res.status, mediaType, res.text.length > 0]).toEqual([path, 200, type, true]);
      }
    }

    // Paths that climb out of the build reach nothing outside it: not the
    // system's files, nor the UI package's own manifest beside the build.
    for (const path of ["/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2f..%2f..%2fetc%2fpasswd"]) {
      const res = await server.http.get(path);
      expect([path, res.status >= 400, res.text.includes("root:")]).toEqual([path, true, false]);
    }
    for (const path of ["/../../../../etc/passwd", "/../package.json", "/assets/../../package.json"]) {
      const res = await rawGet(server, path);
      expect([path, res.status >= 400, res.body.includes("root:"), res.body.includes('"devDependencies"')]).toEqual([
        path,
        true,
        false,
        false,
      ]);
    }
  },
  { timeoutMs: 120_000 },
);

// The gap at engine/server.ts:395
conformance("http", "unknown paths › an unknown route, a GET of a POST route and a missing asset answer 500, and the server stays up", async (t) => {
  const server = await t.start(t.world({ tickets: [doneTicket("01")], config: CLAUDE }));
  await interruptFor(server, REVIEW);

  // An unknown /api/ route, a GET on a POST-only route, an asset the build
  // does not have: the Bun server answers each 500 (see NOT-PORTED.md).
  for (const path of ["/api/no-such-route", "/api/resume", "/assets/missing.js"]) {
    const res = await server.http.get(path);
    expect([path, res.status]).toEqual([path, 500]);
  }
  expect((await server.http.get("/api/state")).status).toBe(200);
  expect(server.exited()).toBe(false);
});
