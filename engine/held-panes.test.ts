/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { TicketEvent } from "./events.ts";
import { heldPaneOf, lastCheckpointAttempt } from "./held-panes.ts";

const AT = "2026-09-25T10:00:00.000Z";

function event(attempt: number, kind: TicketEvent["kind"], payload: Record<string, unknown> = {}): TicketEvent {
  return { at: AT, attempt, kind, payload };
}

const numberedCwd = (n: number) => `/pool/.git/pool-worktrees/01-attempt-${n}`;

describe("held panes", () => {
  it("reads a checkpointed attempt's pane, place and Assignment off its spawned event", () => {
    const events = [
      event(1, "spawned", {
        argv: ["bash", "-c", "claude"],
        cwd: "/pool/.git/pool-worktrees/01",
        branch: "pool/p/01",
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        terminal_id: "term_65b1",
        harness: "claude",
        model: "opus",
      }),
      event(1, "exited", { code: 0, status: "checkpoint" }),
      event(1, "checkpoint"),
    ];
    expect(heldPaneOf(events, 1, numberedCwd)).toEqual({
      attempt: 1,
      paneId: "w1:p1",
      tabId: "w1:t1",
      terminalId: "term_65b1",
      cwd: "/pool/.git/pool-worktrees/01",
      branch: "pool/p/01",
      harness: "claude",
      model: "opus",
      workAttempt: 1,
      numbered: false,
      stream: null,
      spawnedAt: AT,
      wrapped: true,
    });
  });

  it("knows a verify candidate by the attempt worktree it ran in", () => {
    const events = [
      event(3, "spawned", { cwd: numberedCwd(3), branch: "pool/p/01-attempt-3", pane_id: "w1:p3", tab_id: "w1:t3" }),
    ];
    expect(heldPaneOf(events, 3, numberedCwd)).toMatchObject({ numbered: true, workAttempt: 3, harness: "", model: "" });
  });

  it("follows a Continued attempt back to the attempt whose worktree and Stream file it uses", () => {
    const events = [
      event(2, "spawned", { cwd: numberedCwd(2), pane_id: "w1:p2", tab_id: "w1:t2" }),
      event(3, "spawned", {
        cwd: numberedCwd(2),
        pane_id: "w1:p2",
        tab_id: "w1:t2",
        continued: true,
        continues: 2,
        work_attempt: 2,
        numbered: true,
        stream: "/pool/runs/01.attempt-2.stream.jsonl",
      }),
    ];
    expect(heldPaneOf(events, 3, numberedCwd)).toMatchObject({
      attempt: 3,
      paneId: "w1:p2",
      workAttempt: 2,
      numbered: true,
      stream: "/pool/runs/01.attempt-2.stream.jsonl",
    });
  });

  it("holds nothing for a headless attempt, a fallback, a resolver or an attempt never spawned", () => {
    expect(heldPaneOf([event(1, "spawned", { cwd: "/pool", pid: 42 })], 1, numberedCwd)).toBeNull();
    expect(
      heldPaneOf([event(1, "spawned", { cwd: "/pool", pane_id: null, terminal_error: "x" })], 1, numberedCwd),
    ).toBeNull();
    expect(
      heldPaneOf(
        [event(2, "resolver"), event(2, "spawned", { cwd: "/pool", pane_id: "w1:p2", tab_id: "w1:t2" })],
        2,
        numberedCwd,
      ),
    ).toBeNull();
    expect(heldPaneOf([], 1, numberedCwd)).toBeNull();
  });

  it("reads back the attempt the latest checkpoint was raised for", () => {
    expect(lastCheckpointAttempt([event(1, "checkpoint"), event(2, "spawned"), event(3, "checkpoint")])).toBe(3);
    expect(lastCheckpointAttempt([event(1, "spawned")])).toBeNull();
  });
});
