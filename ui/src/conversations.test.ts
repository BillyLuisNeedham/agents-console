/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { ConversationsTray, postStartLine } from "./conversations";
import type { ConversationView, StartConversationRequest } from "./project";
import { useDom } from "./test-dom";

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
  const lineCalls: string[] = [];
  const lineDeferreds = new Map<string, Deferred<void>>();
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
    onStartLine: (id) => {
      lineCalls.push(id);
      const d = deferred<void>();
      lineDeferreds.set(id, d);
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return {
    tray,
    startCalls,
    startDeferreds,
    endCalls,
    endDeferreds,
    lineCalls,
    lineDeferreds,
    changes: () => changes,
  };
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
    tray.setField("effort", " high ");
    const submitted = tray.submit();
    startDeferreds[0]!.resolve(CONVERSATION);
    await submitted;
    expect(startCalls).toEqual([
      {
        title: "plan the migration",
        opening: "let's start",
        assign: { harness: "claude", effort: "high" },
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

describe("ConversationsTray Start Steward (ADR-0030)", () => {
  it("starts the Steward with its standing orders as the opening and only the fields filled in", async () => {
    const { tray, startCalls, startDeferreds } = trayHarness();
    tray.openStewardForm();
    tray.setStewardField("orders", "watch the next super-step, then end yourself; you may push");
    tray.setStewardField("model", " opus ");
    const submitted = tray.submitSteward();
    expect(tray.isStewardSubmitting).toBe(true);
    expect(startCalls).toEqual([
      {
        title: "Steward",
        role: "steward",
        opening: "watch the next super-step, then end yourself; you may push",
        assign: { model: "opus" },
      },
    ]);
    startDeferreds[0].resolve({ ...CONVERSATION, id: "conv-3", role: "steward" });
    await submitted;
    expect(tray.isStewardFormOpen).toBe(false);
    expect(tray.stewardField("orders")).toBe("");
  });

  it("sends no opening and no assign when both are left blank", async () => {
    const { tray, startCalls, startDeferreds } = trayHarness();
    tray.openStewardForm();
    const submitted = tray.submitSteward();
    expect(startCalls[0]).toEqual({
      title: "Steward",
      role: "steward",
      opening: undefined,
      assign: undefined,
    });
    startDeferreds[0].resolve(CONVERSATION);
    await submitted;
  });

  it("shows the engine's refusal inline and keeps the orders for a retry", async () => {
    const { tray, startDeferreds } = trayHarness();
    tray.openStewardForm();
    tray.setStewardField("orders", "keep the merge queue moving");
    const submitted = tray.submitSteward();
    startDeferreds[0].reject(new Error("a Steward is already on duty: conv-3"));
    await submitted;
    expect(tray.stewardFailure).toBe("a Steward is already on duty: conv-3");
    expect(tray.isStewardFormOpen).toBe(true);
    expect(tray.stewardField("orders")).toBe("keep the merge queue moving");
  });

  it("shows one form at a time, each keeping its own draft", () => {
    const { tray } = trayHarness();
    tray.openForm();
    tray.setField("title", "plan the migration");
    tray.openStewardForm();
    expect(tray.isFormOpen).toBe(false);
    expect(tray.isStewardFormOpen).toBe(true);
    tray.setStewardField("orders", "answer checkpoints");
    tray.openForm();
    expect(tray.isStewardFormOpen).toBe(false);
    expect(tray.field("title")).toBe("plan the migration");
    expect(tray.stewardField("orders")).toBe("answer checkpoints");
  });

  describe("drawn", () => {
    useDom();
    const onDuty = {
      conversationId: "conv-3",
      cardId: "conversation:conv-3",
      title: "Steward",
      delivery: null,
    };
    const handlers = { onSelect: () => {}, onFocusSteward: () => {} };

    it("pins the on-duty box first, its name focusing the Steward's card", () => {
      const { tray } = trayHarness();
      const focused: string[] = [];
      const selected: string[] = [];
      const el = tray.render(
        [],
        {},
        { onSelect: (id) => selected.push(id), onFocusSteward: (id) => focused.push(id) },
        { onDuty, defaults: {} },
      );
      const box = el.firstElementChild as HTMLElement;
      expect(box.classList.contains("steward-box")).toBe(true);
      expect(box.classList.contains("steward-box-off")).toBe(false);
      expect(box.classList.contains("steward-box-warn")).toBe(false);
      expect(box.querySelector(".steward-box-label")?.textContent).toBe("steward on duty");
      expect(box.querySelector(".steward-box-warn-text")).toBeNull();
      // No second Steward can start while one is on duty, so no toggle.
      expect(box.querySelector(".conversations-steward-toggle")).toBeNull();
      const name = box.querySelector<HTMLButtonElement>(".steward-box-name")!;
      expect(name.textContent).toBe("Steward · conv-3");
      name.click();
      expect(focused).toEqual(["conversation:conv-3"]);
      expect(selected).toEqual([]);
    });

    it("turns the on-duty box amber with the warning while its Notices are not landing", () => {
      const { tray } = trayHarness();
      const delivery = { text: "Notices not reaching this pane since 02:05", lastError: "a dialog is open" };
      const el = tray.render([], {}, handlers, { onDuty: { ...onDuty, delivery }, defaults: {} });
      const box = el.querySelector<HTMLElement>(".steward-box")!;
      expect(box.classList.contains("steward-box-warn")).toBe(true);
      expect(box.querySelector(".steward-box-warn-text")?.textContent).toBe(delivery.text);
      expect(box.querySelector<HTMLElement>(".steward-box-name")!.title).toContain("a dialog is open");
    });

    it("offers start steward in a dashed box while none is on duty, the form opening under it", () => {
      const { tray } = trayHarness();
      const el = tray.render([], {}, handlers, { onDuty: null, defaults: {} });
      const box = el.firstElementChild as HTMLElement;
      expect(box.classList.contains("steward-box-off")).toBe(true);
      expect(box.querySelector(".steward-box-label")?.textContent).toBe("no steward on duty");
      const toggle = box.querySelector<HTMLButtonElement>(".conversations-steward-toggle")!;
      expect(toggle.textContent).toBe("start steward");
      toggle.click();
      const open = tray.render([], {}, handlers, { onDuty: null, defaults: {} });
      const order = [...open.children].map((c) => c.className);
      expect(order[0]).toContain("steward-box");
      expect(order[1]).toContain("steward-form");
      expect(order[2]).toBe("conversations-head");
      expect(open.querySelector(".conversations-steward-toggle")?.textContent).toBe("cancel");
    });

    it("heads the list with the count and a single + new toggle that opens the form under it", () => {
      const { tray } = trayHarness();
      const el = tray.render([], {}, handlers);
      const head = el.querySelector<HTMLElement>(".conversations-head")!;
      expect(head.querySelector(".conversations-count")?.textContent).toBe("conversations · 0");
      const toggles = head.querySelectorAll<HTMLButtonElement>("button");
      expect(toggles.length).toBe(1);
      expect(toggles[0]!.textContent).toBe("+ new");
      toggles[0]!.click();
      expect(tray.isFormOpen).toBe(true);
      const open = tray.render([], {}, handlers);
      const openHead = open.querySelector<HTMLElement>(".conversations-head")!;
      expect(openHead.querySelector("button")?.textContent).toBe("cancel");
      expect(openHead.nextElementSibling?.classList.contains("conversations-form")).toBe(true);
    });

    it("shows the Steward entry's Assignment as placeholders, and disables Start once one is on duty", () => {
      const { tray } = trayHarness();
      tray.openStewardForm();
      const defaults = { harness: "claude", model: "opus", drivers: "implement" };
      const open = tray.render([], {}, handlers, { onDuty: null, defaults });
      const placeholders = [...open.querySelectorAll<HTMLInputElement>(".steward-form input")].map(
        (input) => input.placeholder,
      );
      expect(placeholders).toEqual(["claude", "opus", "effort", "implement"]);
      expect(open.querySelector<HTMLButtonElement>(".steward-start")!.disabled).toBe(false);
      const blocked = tray.render([], {}, handlers, { onDuty, defaults });
      expect(blocked.querySelector<HTMLButtonElement>(".steward-start")!.disabled).toBe(true);
      expect(blocked.querySelector(".steward-form-blocked")?.textContent).toContain("conv-3");
    });

    it("marks the Steward's row", () => {
      const { tray } = trayHarness();
      const row = (id: string, steward: boolean) => ({
        id,
        cardId: `conversation:${id}`,
        title: id,
        status: "live" as const,
        turn: { state: "working" as const, lastLine: "", idleSince: null },
        idleAge: null,
        steward,
        grill: false,
        delivery: null,
      });
      const el = tray.render([row("conv-1", false), row("conv-3", true)], {}, handlers);
      const marked = [...el.querySelectorAll(".conversations-row")].map(
        (r) => r.querySelector(".steward-badge") !== null,
      );
      expect(marked).toEqual([false, true]);
    });
  });
});

describe("ConversationsTray: Notices not landing", () => {
  useDom();
  it("puts the warning on the row, its error on hover", () => {
    const { tray } = trayHarness();
    const delivery = { text: "Notices not reaching this pane since 02:05", lastError: "a dialog is open" };
    const el = tray.render(
      [
        {
          id: "conv-1",
          cardId: "conversation:conv-1",
          title: "conv-1",
          status: "live",
          turn: { state: "waiting", lastLine: "", idleSince: null },
          idleAge: null,
          steward: false,
          grill: false,
          delivery,
        },
      ],
      {},
      { onSelect: () => {}, onFocusSteward: () => {} },
    );
    const row = el.querySelector(".conversations-row")!;
    expect(row.classList.contains("conversations-row-blocked")).toBe(true);
    const warn = row.querySelector<HTMLElement>(".conversation-delivery-warn")!;
    expect(warn.textContent).toBe(delivery.text);
    expect(warn.title).toBe("a dialog is open");
  });
});

describe("ConversationsTray Start the Line (ADR-0037)", () => {
  it("starts the Line on the Grill's id, marked in flight until the engine answers", async () => {
    const { tray, lineCalls, lineDeferreds } = trayHarness();
    const started = tray.startLine("conv-2");
    expect(lineCalls).toEqual(["conv-2"]);
    expect(tray.lineStartView("conv-2")).toEqual({ starting: true, failure: null });
    // A second press while the first is out sends nothing.
    void tray.startLine("conv-2");
    expect(lineCalls).toHaveLength(1);
    lineDeferreds.get("conv-2")!.resolve();
    await started;
    expect(tray.lineStartView("conv-2")).toEqual({ starting: false, failure: null });
  });

  it("keeps the refusal's reason, and clears it on the next press", async () => {
    const { tray, lineDeferreds } = trayHarness();
    const refused = tray.startLine("conv-2");
    lineDeferreds.get("conv-2")!.reject(
      new Error("no Line brief: docs/specs/ in the Grill's committed branch pool/x/conv-2 holds no *.brief.json"),
    );
    await refused;
    expect(tray.lineStartView("conv-2").failure).toBe(
      "no Line brief: docs/specs/ in the Grill's committed branch pool/x/conv-2 holds no *.brief.json",
    );
    const retried = tray.startLine("conv-2");
    expect(tray.lineStartView("conv-2")).toEqual({ starting: true, failure: null });
    lineDeferreds.get("conv-2")!.resolve();
    await retried;
  });

  it("reports its state as a map and drops a refusal once the Grill is not live", async () => {
    const { tray, lineDeferreds } = trayHarness();
    const refused = tray.startLine("conv-2");
    expect(tray.lineStartState()).toEqual({ "conv-2": { starting: true, failure: null } });
    lineDeferreds.get("conv-2")!.reject(new Error("the Line has already started"));
    await refused;
    tray.pruneLineStartFailures(new Set(["conv-2"]));
    expect(tray.lineStartState()).toEqual({
      "conv-2": { starting: false, failure: "the Line has already started" },
    });
    tray.pruneLineStartFailures(new Set());
    expect(tray.lineStartState()).toEqual({});
  });
});

describe("ConversationsTray: the Grill's row (ADR-0037)", () => {
  useDom();
  it("marks the Grill's tray row", () => {
    const { tray } = trayHarness();
    const row = (id: string, grill: boolean) => ({
      id,
      cardId: `conversation:${id}`,
      title: id,
      status: "live" as const,
      turn: { state: "waiting" as const, lastLine: "", idleSince: null },
      idleAge: null,
      steward: false,
      grill,
      delivery: null,
    });
    const el = tray.render([row("conv-1", false), row("conv-2", true)], {}, {
      onSelect: () => {},
      onFocusSteward: () => {},
    });
    const marked = [...el.querySelectorAll(".conversations-row")].map(
      (r) => r.querySelector(".grill-badge")?.textContent ?? null,
    );
    expect(marked).toEqual([null, "Grill"]);
  });
});

describe("postStartLine (ADR-0037)", () => {
  function fakeFetch(status: number, body: string) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(body, { status }));
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("posts the Grill's id to /api/line/start and resolves on 202", async () => {
    const { calls, fetchFn } = fakeFetch(202, JSON.stringify({ ticketId: "r1-implement" }));
    await postStartLine("conv-2", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/line/start");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ grill: "conv-2" });
  });

  it("rejects with the refusal's reason", async () => {
    const { fetchFn } = fakeFetch(409, JSON.stringify({ reason: "the Line has already started" }));
    await expect(postStartLine("conv-2", fetchFn)).rejects.toThrow("the Line has already started");
  });

  it("rejects with the status when the refusal carries no reason", async () => {
    const { fetchFn } = fakeFetch(500, "not json");
    await expect(postStartLine("conv-2", fetchFn)).rejects.toThrow("HTTP 500");
  });
});
