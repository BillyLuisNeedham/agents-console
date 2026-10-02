/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { EnlistStore } from "./enlist";
import type { EnlistRequest, EnlistResponse, PanesResponse } from "./project";
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
  const enlists: { request: EnlistRequest; deferred: Deferred<EnlistResponse> }[] = [];
  let changes = 0;
  const store = new EnlistStore({
    onListPanes: () => {
      const d = deferred<PanesResponse>();
      reads.push(d);
      return d.promise;
    },
    onEnlist: (request) => {
      const d = deferred<EnlistResponse>();
      enlists.push({ request, deferred: d });
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { store, reads, enlists, changes: () => changes };
}

/** Open the picker, settle the read, and pick the one eligible pane. */
async function pickEligible() {
  const h = harness();
  const opened = h.store.openPicker();
  h.reads[0]!.resolve(PANES);
  await opened;
  h.store.pick("pane-work");
  return h;
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

describe("EnlistStore form", () => {
  it("picking an eligible pane opens the form, title prefilled from the pane", async () => {
    const { store } = await pickEligible();
    expect(store.isFormOpen).toBe(true);
    expect(store.pickedPaneId).toBe("pane-work");
    expect(store.field("title")).toBe("OC | doing work");
    expect(store.field("spec")).toBe("");
    expect(store.blocks()).toEqual([]);
  });

  it("toggling blocks records them, and untoggling removes them", async () => {
    const { store } = await pickEligible();
    store.toggleBlock("01");
    store.toggleBlock("02");
    expect(store.isTicked("01")).toBe(true);
    expect(store.blocks()).toEqual(["01", "02"]);
    store.toggleBlock("01");
    expect(store.isTicked("01")).toBe(false);
    expect(store.blocks()).toEqual(["02"]);
  });

  it("submits the ticket fields for the chosen pane and closes on success", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "  wire up enlist  ");
    store.setField("spec", "the spec body");
    store.toggleBlock("01");

    const submitting = store.submit();
    expect(store.isSubmitting).toBe(true);
    expect(enlists).toHaveLength(1);
    expect(enlists[0]!.request).toEqual({
      becomes: "ticket",
      paneId: "pane-work",
      title: "wire up enlist",
      spec: "the spec body",
      blocks: ["01"],
    });

    enlists[0]!.deferred.resolve({ ticketId: "enlist-1" });
    await submitting;
    expect(store.isFormOpen).toBe(false);
    expect(store.isSubmitting).toBe(false);
    expect(store.submitFailure).toBeNull();
  });

  it("leaves the draft open with the refusal inline when the engine refuses", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "keep me");
    store.setField("spec", "my spec");
    store.toggleBlock("01");

    const submitting = store.submit();
    enlists[0]!.deferred.reject(new Error("enlist: pane pane-work is gone"));
    await submitting;

    expect(store.isFormOpen).toBe(true);
    expect(store.submitFailure).toBe("enlist: pane pane-work is gone");
    expect(store.field("title")).toBe("keep me");
    expect(store.field("spec")).toBe("my spec");
    expect(store.blocks()).toEqual(["01"]);
  });

  it("refuses an empty title locally without calling the engine", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "   ");
    await store.submit();
    expect(enlists).toHaveLength(0);
    expect(store.submitFailure).toBe("title is required");
    expect(store.isFormOpen).toBe(true);
  });

  it("closing the form clears the draft and the refusal", async () => {
    const { store } = await pickEligible();
    store.setField("title", "x");
    store.toggleBlock("01");
    store.closeForm();
    expect(store.isFormOpen).toBe(false);
    expect(store.field("title")).toBe("");
    expect(store.blocks()).toEqual([]);
  });
});

describe("EnlistStore Becomes switch", () => {
  it("opens on Ticket, switches to Conversation and back, and keeps the draft where fields are shared", async () => {
    const { store } = await pickEligible();
    expect(store.mode).toBe("ticket");

    store.setField("title", "shared title");
    store.setField("spec", "ticket spec");

    store.setBecomes("conversation");
    expect(store.mode).toBe("conversation");
    // Title is shared; spec belongs to Ticket and opening to Conversation.
    expect(store.field("title")).toBe("shared title");
    expect(store.field("opening")).toBe("");

    store.setField("opening", "opening turn");
    store.setBecomes("ticket");
    expect(store.mode).toBe("ticket");
    expect(store.field("title")).toBe("shared title");
    expect(store.field("spec")).toBe("ticket spec");
    expect(store.field("opening")).toBe("opening turn");
  });

  it("submits only the Conversation fields, never spec or blocks", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "a talk");
    store.setField("spec", "not sent");
    store.toggleBlock("01");
    store.setBecomes("conversation");
    store.setField("opening", "hello there");

    const submitting = store.submit();
    expect(store.isSubmitting).toBe(true);
    expect(enlists).toHaveLength(1);
    expect(enlists[0]!.request).toEqual({
      becomes: "conversation",
      paneId: "pane-work",
      title: "a talk",
      opening: "hello there",
    });

    enlists[0]!.deferred.resolve({ conversationId: "conv-1" });
    await submitting;
    expect(store.isFormOpen).toBe(false);
    expect(store.isSubmitting).toBe(false);
    expect(store.submitFailure).toBeNull();
  });

  it("omits an empty opening Turn from the Conversation request", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "no opening");
    store.setBecomes("conversation");

    const submitting = store.submit();
    expect(enlists[0]!.request).toEqual({
      becomes: "conversation",
      paneId: "pane-work",
      title: "no opening",
    });
    enlists[0]!.deferred.resolve({ conversationId: "conv-1" });
    await submitting;
  });

  it("surfaces a Conversation refusal inline and keeps the draft", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("title", "keep me");
    store.setBecomes("conversation");
    store.setField("opening", "my opening");

    const submitting = store.submit();
    enlists[0]!.deferred.reject(new Error("enlist: pane pane-work is gone"));
    await submitting;

    expect(store.isFormOpen).toBe(true);
    expect(store.mode).toBe("conversation");
    expect(store.submitFailure).toBe("enlist: pane pane-work is gone");
    expect(store.field("title")).toBe("keep me");
    expect(store.field("opening")).toBe("my opening");
  });

  it("a fresh pick opens the form back on Ticket", async () => {
    const { store } = await pickEligible();
    store.setBecomes("conversation");
    store.closeForm();
    store.pick("pane-work");
    expect(store.mode).toBe("ticket");
    expect(store.field("opening")).toBe("");
  });
});


describe("EnlistStore as the Steward (ADR-0030)", () => {
  it("submits the Steward's title and standing orders, never spec, blocks or a Conversation's opening", async () => {
    const { store, enlists } = await pickEligible();
    store.setField("spec", "not sent");
    store.toggleBlock("01");
    store.setBecomes("conversation");
    store.setField("opening", "not sent either");
    store.setBecomes("steward");
    store.setField("title", "night Steward");
    store.setField("orders", "keep the merge queue moving; do not push");

    const submitting = store.submit();
    expect(enlists[0]!.request).toEqual({
      becomes: "steward",
      paneId: "pane-work",
      title: "night Steward",
      opening: "keep the merge queue moving; do not push",
    });
    enlists[0]!.deferred.resolve({ conversationId: "conv-3" });
    await submitting;
    expect(store.isFormOpen).toBe(false);
    expect(store.field("orders")).toBe("");
  });

  it("takes a blank title, which the engine names Steward", async () => {
    const { store, enlists } = await pickEligible();
    store.setBecomes("steward");
    store.setField("title", "  ");
    const submitting = store.submit();
    expect(enlists[0]!.request).toEqual({ becomes: "steward", paneId: "pane-work" });
    enlists[0]!.deferred.resolve({ conversationId: "conv-3" });
    await submitting;
  });

  it("keeps the standing orders and the refusal when a Steward is already on duty", async () => {
    const { store, enlists } = await pickEligible();
    store.setBecomes("steward");
    store.setField("orders", "answer checkpoints");
    const submitting = store.submit();
    enlists[0]!.deferred.reject(new Error("a Steward is already on duty: conv-3"));
    await submitting;
    expect(store.mode).toBe("steward");
    expect(store.submitFailure).toBe("a Steward is already on duty: conv-3");
    expect(store.field("orders")).toBe("answer checkpoints");
  });

  describe("drawn", () => {
    useDom();
    const onDuty = {
      conversationId: "conv-3",
      cardId: "conversation:conv-3",
      title: "Steward",
      delivery: null,
    };

    it("offers Steward as a third choice, disabled with the reason while one is on duty", async () => {
      const { store } = await pickEligible();
      const free = store.render([], null)!;
      expect(
        [...free.querySelectorAll(".enlist-becomes-switch button")].map((b) => b.textContent),
      ).toEqual(["ticket", "conversation", "steward"]);
      expect(free.querySelector<HTMLButtonElement>(".enlist-becomes-steward")!.disabled).toBe(false);
      const taken = store.render([], onDuty)!;
      const choice = taken.querySelector<HTMLButtonElement>(".enlist-becomes-steward")!;
      expect(choice.disabled).toBe(true);
      expect(choice.title).toContain("conv-3");
    });

    it("blocks the submit in place if a Steward came on duty while the form stood on Steward", async () => {
      const { store } = await pickEligible();
      store.setBecomes("steward");
      const el = store.render([], onDuty)!;
      expect(el.querySelector<HTMLButtonElement>(".enlist-submit")!.disabled).toBe(true);
      expect(el.querySelector(".enlist-failure")?.textContent).toContain("conv-3");
      expect(el.querySelector(".enlist-orders")).not.toBeNull();
    });
  });
});
