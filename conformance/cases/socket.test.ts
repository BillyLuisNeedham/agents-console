/**
 * The WebSocket at /api/ws (issue #161, ADR-0032), seen from outside the
 * server (ADR-0036): frames equal once parsed.
 */

import { expect } from "bun:test";
import { conformance } from "../harness/case.ts";
import { expectParsedEqual } from "../harness/equal.ts";
import { until } from "../harness/pool-files.ts";

conformance("socket", "a socket opens with the server's hello, then the whole snapshot", async (t) => {
  const world = t.world({
    tickets: [
      { file: "01-first.md", marker: "<!-- state: id=01 blocked-by=none status=done -->", body: "# First\n\nDone already." },
      { file: "02-second.md", marker: "<!-- state: id=02 blocked-by=01 status=done -->", body: "# Second\n\nDone too." },
    ],
    config: { defaults: { harness: "claude", model: "m" } },
  });
  const server = await t.start(world);
  // Settled before the socket opens, so its first snapshot is the last one.
  const state = await until(
    () => server.http.get("/api/state"),
    (got) => got.json<{ snapshot: { phase: string } | null }>().snapshot?.phase === "quiescent",
    { what: "the pool to settle" },
  );

  const socket = await t.socket(server, { visible: true });
  // A round trip: every frame the server sent ahead of the reply is in hand.
  await socket.sync();

  expectParsedEqual(
    socket.frames[0],
    { type: "hello", protocol: 1, epoch: expect.any(String), heartbeatMs: 20_000 },
    "the first frame",
  );
  expectParsedEqual(
    socket.frames[1],
    { type: "snapshot", rev: 1, logTotal: 3, snapshot: state.json<{ snapshot: unknown }>().snapshot },
    "the second frame",
  );
  // Nothing moved, so no delta came between the snapshot and the reply, and
  // the reply names the snapshot's revision.
  expectParsedEqual(
    socket.frames[2],
    {
      type: "reply",
      id: 1,
      kind: "poolLog.read",
      rev: 1,
      ok: true,
      result: { start: 0, lines: [], total: 3 },
    },
    "the reply",
  );
});
