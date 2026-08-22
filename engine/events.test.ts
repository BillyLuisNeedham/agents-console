/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents } from "./events.ts";

const tempDirs: string[] = [];

function tempRuns(): string {
  const dir = mkdtempSync(join(tmpdir(), "events-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ticket events", () => {
  it("reads back events written through appendEvent", () => {
    const runs = tempRuns();
    appendEvent(runs, "01", {
      at: "2026-01-01T00:00:00.000Z",
      attempt: 1,
      kind: "spawned",
      payload: {},
    });
    const events = readEvents(runs, "01");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("spawned");
    expect(events[0].attempt).toBe(1);
  });

  it("skips a line whose kind is not a known event kind", () => {
    const runs = tempRuns();
    appendEvent(runs, "01", {
      at: "2026-01-01T00:00:00.000Z",
      attempt: 1,
      kind: "scheduled",
      payload: {},
    });
    writeFileSync(
      join(runs, "01.events.jsonl"),
      '{"at":"2026-01-01T00:00:01.000Z","attempt":1,"kind":"bogus","payload":{}}\n',
      { flag: "a" },
    );
    const events = readEvents(runs, "01");
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("scheduled");
  });
});