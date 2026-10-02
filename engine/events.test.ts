/// <reference types="bun" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  attemptLogName,
  attemptStreamName,
  parseAttemptLogName,
  parseAttemptStreamName,
  readEvents,
} from "./events.ts";

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

// The reader keeps its parse per file and reads only what was appended since
// (issue #157); every case here is one the whole-file parse it replaced got
// right, so each is checked against a fresh parse of the same bytes.
describe("ticket events read again", () => {
  const line = (second: number, kind: string): string =>
    `${JSON.stringify({ at: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`, attempt: 1, kind, payload: {} })}\n`;
  const kinds = (runs: string): string[] => readEvents(runs, "01").map((e) => e.kind);
  const file = (runs: string): string => join(runs, "01.events.jsonl");

  it("picks up each append, and a torn final line once the rest of it lands", () => {
    const runs = tempRuns();
    writeFileSync(file(runs), line(0, "scheduled"));
    expect(kinds(runs)).toEqual(["scheduled"]);
    const spawned = line(1, "spawned");
    writeFileSync(file(runs), spawned.slice(0, 20), { flag: "a" });
    expect(kinds(runs)).toEqual(["scheduled"]);
    writeFileSync(file(runs), spawned.slice(20), { flag: "a" });
    expect(kinds(runs)).toEqual(["scheduled", "spawned"]);
    writeFileSync(file(runs), line(2, "exited"), { flag: "a" });
    expect(kinds(runs)).toEqual(["scheduled", "spawned", "exited"]);
  });

  it("reads a final line with no newline yet when it is whole, and never keeps it", () => {
    const runs = tempRuns();
    writeFileSync(file(runs), line(0, "scheduled") + line(1, "spawned").trimEnd());
    expect(kinds(runs)).toEqual(["scheduled", "spawned"]);
    writeFileSync(file(runs), `\n${line(2, "exited")}`, { flag: "a" });
    expect(kinds(runs)).toEqual(["scheduled", "spawned", "exited"]);
  });

  it("reads a file removed and written again as a new file, at the same size too", () => {
    const runs = tempRuns();
    writeFileSync(file(runs), line(0, "scheduled") + line(1, "spawned"));
    expect(kinds(runs)).toEqual(["scheduled", "spawned"]);
    rmSync(file(runs));
    expect(kinds(runs)).toEqual([]);
    // Same length as before, and on most filesystems the same inode.
    writeFileSync(file(runs), line(5, "spawned") + line(6, "scheduled"));
    expect(kinds(runs)).toEqual(["spawned", "scheduled"]);
  });

  it("reads a file cut shorter as a new file", () => {
    const runs = tempRuns();
    writeFileSync(file(runs), line(0, "scheduled") + line(1, "spawned"));
    expect(kinds(runs)).toEqual(["scheduled", "spawned"]);
    writeFileSync(file(runs), line(2, "exited"));
    expect(kinds(runs)).toEqual(["exited"]);
  });

  it("hands every caller its own list", () => {
    const runs = tempRuns();
    writeFileSync(file(runs), line(0, "scheduled"));
    readEvents(runs, "01").pop();
    expect(kinds(runs)).toEqual(["scheduled"]);
  });
});

describe("attempt log naming", () => {
  it("names the well-known base log and the attempt-numbered logs", () => {
    expect(attemptLogName("01", null, false)).toBe("01.log");
    expect(attemptLogName("01", 1, false)).toBe("01.attempt-1.log");
    expect(attemptLogName("01", 0, false)).toBe("01.attempt-0.log");
  });

  it("names the resolver log and its attempt-numbered variants", () => {
    expect(attemptLogName("01", null, true)).toBe("01.resolver.log");
    expect(attemptLogName("01", 2, true)).toBe("01.attempt-2.resolver.log");
  });

  it("parses back the four shapes it names", () => {
    expect(parseAttemptLogName("01", "01.log")).toEqual({
      attempt: null,
      resolver: false,
    });
    expect(parseAttemptLogName("01", "01.attempt-3.log")).toEqual({
      attempt: 3,
      resolver: false,
    });
    expect(parseAttemptLogName("01", "01.resolver.log")).toEqual({
      attempt: null,
      resolver: true,
    });
    expect(parseAttemptLogName("01", "01.attempt-4.resolver.log")).toEqual({
      attempt: 4,
      resolver: true,
    });
  });

  it("rejects names outside the contract", () => {
    expect(parseAttemptLogName("01", "02.log")).toBeNull();
    expect(parseAttemptLogName("01", "01.events.jsonl")).toBeNull();
    expect(parseAttemptLogName("01", "01.outcome.json")).toBeNull();
    expect(parseAttemptLogName("01", "01.attempt-x.log")).toBeNull();
    expect(parseAttemptLogName("01", "01.attempt-01.log")).toBeNull();
  });
});

describe("attempt stream naming", () => {
  it("names the well-known base stream and the attempt-numbered streams", () => {
    expect(attemptStreamName("01", null, false)).toBe("01.stream.jsonl");
    expect(attemptStreamName("01", 1, false)).toBe("01.attempt-1.stream.jsonl");
    expect(attemptStreamName("01", 0, false)).toBe("01.attempt-0.stream.jsonl");
  });

  it("names the resolver stream and its attempt-numbered variants", () => {
    expect(attemptStreamName("01", null, true)).toBe("01.resolver.stream.jsonl");
    expect(attemptStreamName("01", 2, true)).toBe(
      "01.attempt-2.resolver.stream.jsonl",
    );
  });

  it("parses back the four shapes it names", () => {
    expect(parseAttemptStreamName("01", "01.stream.jsonl")).toEqual({
      attempt: null,
      resolver: false,
    });
    expect(parseAttemptStreamName("01", "01.attempt-3.stream.jsonl")).toEqual({
      attempt: 3,
      resolver: false,
    });
    expect(parseAttemptStreamName("01", "01.resolver.stream.jsonl")).toEqual({
      attempt: null,
      resolver: true,
    });
    expect(
      parseAttemptStreamName("01", "01.attempt-4.resolver.stream.jsonl"),
    ).toEqual({ attempt: 4, resolver: true });
  });

  it("rejects names outside the contract", () => {
    expect(parseAttemptStreamName("01", "02.stream.jsonl")).toBeNull();
    expect(parseAttemptStreamName("01", "01.log")).toBeNull();
    expect(parseAttemptStreamName("01", "01.stream.json")).toBeNull();
    expect(parseAttemptStreamName("01", "01.attempt-x.stream.jsonl")).toBeNull();
    expect(parseAttemptStreamName("01", "01.attempt-01.stream.jsonl")).toBeNull();
  });
});
