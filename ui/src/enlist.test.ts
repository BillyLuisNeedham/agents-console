/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { EnlistStore } from "./enlist";
import type { PanesResponse } from "./project";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PANES: PanesResponse = {
  panes: [
    {
      paneId: "pane-work",
      harness: "opencode",
      status: "working",
      title: "OC | doing work",
      directory: "/repo/worktree",
      branch: "feature/x",
      eligible: true,
      reason: null,
    },
    {
      paneId: "pane-out",
      harness: "claude",
      status: "idle",
      title: "✳ Claude Code",
      directory: "/other",
      branch: null,
      eligible: false,
      reason: "not a checkout of this pool's repository",
    },
    {
      paneId: "pane-gemini",
      harness: "gemini",
      status: "idle",
      title: "gemini",
      directory: "/repo",
      branch: "main",
      eligible: false,
      reason: "no harness the engine knows",
    },
  ],
};

/** A store wired to hand-settled deferreds, so a test pins the read's dispatch
 *  before any answer lands (the conversations.test.ts pattern). */
function harness() {
  const reads: Deferred<PanesResponse>[] = [];
  let changes = 0;
  const store = new EnlistStore({
    onListPanes: () => {
      const d = deferred<PanesResponse>();
      reads.push(d);
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { store, reads, changes: () => changes };
}

describe("EnlistStore picker", () => {
  it("reads herdr when the picker opens, never on construction", async () => {
    const { store, reads } = harness();
    expect(store.isOpen).toBe(false);
    expect(reads).toHaveLength(0);

    const opened = store.openPicker();
    expect(store.isOpen).toBe(true);
    expect(store.isLoading).toBe(true);
    expect(reads).toHaveLength(1);

    reads[0]!.resolve(PANES);
    await opened;
    expect(store.isLoading).toBe(false);
    expect(store.rows()).toHaveLength(3);
  });

  it("keeps ineligible panes as rows, with their reason", async () => {
    const { store, reads } = harness();
    const opened = store.openPicker();
    reads[0]!.resolve(PANES);
    await opened;

    const rows = store.rows();
    expect(rows[0]!.paneId).toBe("pane-work");
    expect(rows.slice(1).every((row) => !row.eligible)).toBe(true);
    expect(rows.find((row) => row.paneId === "pane-gemini")!.reason).toBe(
      "no harness the engine knows",
    );
    expect(rows.find((row) => row.paneId === "pane-out")!.reason).toBe(
      "not a checkout of this pool's repository",
    );
  });

  it("surfaces a refused read as the picker's failure", async () => {
    const { store, reads } = harness();
    const opened = store.openPicker();
    reads[0]!.reject(new Error("enlist requires a terminal-backed pool"));
    await opened;

    expect(store.failure).toBe("enlist requires a terminal-backed pool");
    expect(store.isLoading).toBe(false);
    expect(store.rows()).toEqual([]);
  });

  it("picking an eligible pane closes the picker and records the pane", async () => {
    const { store, reads } = harness();
    const opened = store.openPicker();
    reads[0]!.resolve(PANES);
    await opened;

    store.pick("pane-work");
    expect(store.isOpen).toBe(false);
    expect(store.pickedPaneId).toBe("pane-work");
  });

  it("refuses to pick an ineligible pane", async () => {
    const { store, reads } = harness();
    const opened = store.openPicker();
    reads[0]!.resolve(PANES);
    await opened;

    store.pick("pane-gemini");
    expect(store.isOpen).toBe(true);
    expect(store.pickedPaneId).toBeNull();
  });

  it("a second open while the picker is showing reads nothing more", async () => {
    const { store, reads } = harness();
    const first = store.openPicker();
    await store.openPicker();
    expect(reads).toHaveLength(1);
    reads[0]!.resolve(PANES);
    await first;
  });

  it("discards an answer that lands after the picker closes", async () => {
    const { store, reads } = harness();
    const opened = store.openPicker();
    store.closePicker();
    reads[0]!.resolve(PANES);
    await opened;

    expect(store.isOpen).toBe(false);
    expect(store.rows()).toEqual([]);
  });

  it("notifies on the open and on the settle", async () => {
    const { store, reads, changes } = harness();
    const opened = store.openPicker();
    expect(changes()).toBe(1);
    reads[0]!.resolve(PANES);
    await opened;
    expect(changes()).toBe(2);
  });
});
