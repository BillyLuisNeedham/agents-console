/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { ConversationsTray } from "./conversations";
import type { ConversationView, StartConversationRequest } from "./project";

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

const CONVERSATION: ConversationView = {
  id: "conv-1",
  title: "plan the migration",
  status: "live",
  spawnedBy: null,
  assignment: { harness: null, model: null, drivers: "implement" },
  paneId: "pane-9",
  branch: null,
  turn: { state: "waiting", lastLine: "", idleSince: null },
  children: [],
  enlisted: false,
  ending: false,
};

/** A tray wired to hand-settled deferreds, so a test pins the dispatch order
 *  before any outcome lands (the needs-input.test.ts pattern). */
function trayHarness() {
  const startCalls: StartConversationRequest[] = [];
  const startDeferreds: Deferred<ConversationView>[] = [];
  const endCalls: { id: string; closing?: string }[] = [];
  const endDeferreds = new Map<string, Deferred<void>>();
  let changes = 0;
  const tray = new ConversationsTray({
    onStart: (request) => {
      startCalls.push(request);
      const d = deferred<ConversationView>();
      startDeferreds.push(d);
      return d.promise;
    },
    onEnd: (id, closing) => {
      endCalls.push({ id, closing });
      const d = deferred<void>();
      endDeferreds.set(id, d);
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { tray, startCalls, startDeferreds, endCalls, endDeferreds, changes: () => changes };
}

describe("ConversationsTray New Conversation form: drafts survive re-render", () => {
  it("holds every field's draft, the way a snapshot re-render reads it back", () => {
    const { tray } = trayHarness();
    tray.setField("title", "talk about the roadmap");
    tray.setField("opening", "what's next?");
    tray.setField("harness", "claude");
    tray.setField("model", "opus");
    tray.setField("drivers", "implement review");
    // A snapshot re-render rebuilds the form's inputs from these same
    // getters (`field()`), so the draft outliving repeated reads is exactly
    // what "survives re-render" means for a value with no DOM of its own.
    expect(tray.field("title")).toBe("talk about the roadmap");
    expect(tray.field("opening")).toBe("what's next?");
    expect(tray.field("harness")).toBe("claude");
    expect(tray.field("model")).toBe("opus");
    expect(tray.field("drivers")).toBe("implement review");
  });

  it("starts every field empty", () => {
    const { tray } = trayHarness();
    expect(tray.field("title")).toBe("");
    expect(tray.field("opening")).toBe("");
  });

  it("opens and closes on toggle, without losing the draft", () => {
    const { tray } = trayHarness();
    expect(tray.isFormOpen).toBe(false);
    tray.setField("title", "keep me");
    tray.openForm();
    expect(tray.isFormOpen).toBe(true);
    tray.closeForm();
    expect(tray.isFormOpen).toBe(false);
    expect(tray.field("title")).toBe("keep me");
  });
});

describe("ConversationsTray submit", () => {
  it("disables submit while the start request is in flight", async () => {
    const { tray, startDeferreds } = trayHarness();
    tray.setField("title", "plan the migration");
    const submitted = tray.submit();
    expect(tray.isSubmitting).toBe(true);
    startDeferreds[0]!.resolve(CONVERSATION);
    await submitted;
    expect(tray.isSubmitting).toBe(false);
  });

  it("refuses an empty title client-side, without calling onStart", async () => {
    const { tray, startCalls } = trayHarness();
    await tray.submit();
    expect(startCalls).toEqual([]);
    expect(tray.failure).toBe("title is required");
  });

  it("sends only the Assignment fields the operator actually filled in", async () => {
    const { tray, startCalls, startDeferreds } = trayHarness();
    tray.setField("title", "plan the migration");
    tray.setField("opening", "let's start");
    tray.setField("harness", "claude");
    const submitted = tray.submit();
    startDeferreds[0]!.resolve(CONVERSATION);
    await submitted;
    expect(startCalls).toEqual([
      {
        title: "plan the migration",
        opening: "let's start",
        assign: { harness: "claude" },
      },
    ]);
  });

  it("clears the draft and closes the form on success", async () => {
    const { tray, startDeferreds } = trayHarness();
    tray.setField("title", "plan the migration");
    tray.openForm();
    const submitted = tray.submit();
    startDeferreds[0]!.resolve(CONVERSATION);
    await submitted;
    expect(tray.field("title")).toBe("");
    expect(tray.isFormOpen).toBe(false);
  });

  it("shows a 409 reason inline and leaves the draft in place for a retry", async () => {
    const { tray, startDeferreds } = trayHarness();
    tray.openForm();
    tray.setField("title", "plan the migration");
    const submitted = tray.submit();
    startDeferreds[0]!.reject(new Error("pool is not terminal-backed"));
    await submitted;
    expect(tray.failure).toBe("pool is not terminal-backed");
    expect(tray.field("title")).toBe("plan the migration");
    expect(tray.isFormOpen).toBe(true);
  });

  it("a second submit while one is in flight is a no-op", async () => {
    const { tray, startCalls, startDeferreds } = trayHarness();
    tray.setField("title", "plan the migration");
    const first = tray.submit();
    const second = tray.submit();
    expect(startCalls).toHaveLength(1);
    startDeferreds[0]!.resolve(CONVERSATION);
    await Promise.all([first, second]);
  });
});

describe("ConversationsTray End", () => {
  it("disables while the End request is in flight, for either surface's button", async () => {
    const { tray, endDeferreds } = trayHarness();
    expect(tray.endView("conv-1")).toEqual({ ending: false, failure: null });
    const ended = tray.endConversation("conv-1", "wrapping up");
    expect(tray.endView("conv-1")).toEqual({ ending: true, failure: null });
    endDeferreds.get("conv-1")!.resolve();
    await ended;
    expect(tray.endView("conv-1")).toEqual({ ending: false, failure: null });
  });

  it("passes the optional closing line through to onEnd", async () => {
    const { tray, endCalls, endDeferreds } = trayHarness();
    const ended = tray.endConversation("conv-1", "wrapping up");
    endDeferreds.get("conv-1")!.resolve();
    await ended;
    expect(endCalls).toEqual([{ id: "conv-1", closing: "wrapping up" }]);
  });

  it("marks a failed End inline, keyed by conversation id", async () => {
    const { tray, endDeferreds } = trayHarness();
    const ended = tray.endConversation("conv-1");
    endDeferreds.get("conv-1")!.reject(new Error("pool resume failed: 500"));
    await ended;
    expect(tray.endView("conv-1")).toEqual({
      ending: false,
      failure: "pool resume failed: 500",
    });
  });

  it("a second End for the same id while one is in flight is a no-op", async () => {
    const { tray, endCalls, endDeferreds } = trayHarness();
    const first = tray.endConversation("conv-1");
    const second = tray.endConversation("conv-1");
    expect(endCalls).toHaveLength(1);
    endDeferreds.get("conv-1")!.resolve();
    await Promise.all([first, second]);
  });

  it("tracks End state per conversation id independently", async () => {
    const { tray, endDeferreds } = trayHarness();
    const a = tray.endConversation("conv-1");
    const b = tray.endConversation("conv-2");
    expect(tray.endView("conv-1").ending).toBe(true);
    expect(tray.endView("conv-2").ending).toBe(true);
    endDeferreds.get("conv-1")!.reject(new Error("boom"));
    endDeferreds.get("conv-2")!.resolve();
    await Promise.all([a, b]);
    expect(tray.endView("conv-1")).toEqual({ ending: false, failure: "boom" });
    expect(tray.endView("conv-2")).toEqual({ ending: false, failure: null });
  });

  it("prunes a failure mark once the conversation is no longer live", async () => {
    const { tray, endDeferreds } = trayHarness();
    const ended = tray.endConversation("conv-1");
    endDeferreds.get("conv-1")!.reject(new Error("boom"));
    await ended;
    expect(tray.endView("conv-1").failure).toBe("boom");
    tray.pruneEndFailures(new Set());
    expect(tray.endView("conv-1")).toEqual({ ending: false, failure: null });
  });

  it("keeps a failure mark while the conversation is still listed live", async () => {
    const { tray, endDeferreds } = trayHarness();
    const ended = tray.endConversation("conv-1");
    endDeferreds.get("conv-1")!.reject(new Error("boom"));
    await ended;
    tray.pruneEndFailures(new Set(["conv-1"]));
    expect(tray.endView("conv-1").failure).toBe("boom");
  });

  it("reports the store's End state as a map, for the pool projection", async () => {
    const { tray, endDeferreds } = trayHarness();
    const ended = tray.endConversation("conv-1");
    expect(tray.endState()).toEqual({ "conv-1": { ending: true, failure: null } });
    endDeferreds.get("conv-1")!.resolve();
    await ended;
    expect(tray.endState()).toEqual({});
  });
});

describe("ConversationsTray onChange", () => {
  it("notifies on every state transition the UI must repaint for", async () => {
    const { tray, startDeferreds, changes } = trayHarness();
    tray.openForm();
    expect(changes()).toBe(1);
    tray.setField("title", "x");
    const submitted = tray.submit();
    expect(changes()).toBe(2); // submit start
    startDeferreds[0]!.resolve(CONVERSATION);
    await submitted;
    expect(changes()).toBe(3); // submit settle
  });
});
