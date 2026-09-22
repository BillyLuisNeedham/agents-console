/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  bulkFieldsFrom,
  draftFrom,
  ENLISTED_HARNESS_ONLY,
  ReassignStore,
  resultLine,
  ticketFieldsFrom,
  validateBulkDraft,
  validateVerify,
  type BulkDraft,
  type ReassignSeed,
} from "./reassign";
import { commit } from "./morph";
import { useDom } from "./test-dom";
import type {
  EnrichedSnapshot,
  ReassignRequest,
  ReassignResponse,
  ReassignTicketRow,
  SettingsResponse,
} from "./project";

useDom();

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

const SNAPSHOT = {
  seq: 1,
  phase: "running",
  poolName: "repo/pool",
  poolDir: "/tmp/pool",
  state: {
    tickets: [],
    conversations: [],
    log: [],
    outcomes: {},
    interrupts: [],
    queuedAnswers: [],
    config: {},
  },
} as EnrichedSnapshot;

function settings(): SettingsResponse {
  return {
    pool: {
      path: "/tmp/pool/console.json",
      config: {},
      bootOnly: [],
      effective: { port: 4300, terminal: null, stale: [] },
    },
    machine: { path: "/home/me/defaults.json", defaults: {}, own: {} },
    harnesses: ["claude", "opencode"],
  };
}

function row(
  id: string,
  overrides: Partial<ReassignTicketRow> = {},
): ReassignTicketRow {
  return {
    id,
    title: `ticket ${id}`,
    status: "ready",
    assignment: { harness: "claude", model: "opus", drivers: "implement" },
    sources: { harness: "default", model: "pinned", drivers: "default" },
    verify: null,
    enlisted: false,
    reason: null,
    ...overrides,
  };
}

function answer(overrides: Partial<ReassignResponse> = {}): ReassignResponse {
  return { applied: [], skipped: [], snapshot: SNAPSHOT, ...overrides };
}

/** A store wired to hand-settled deferreds, so a test pins the write's
 *  dispatch before any answer lands (the settings.test.ts pattern). */
function harness() {
  const reads: Deferred<SettingsResponse>[] = [];
  const writes: { request: ReassignRequest; deferred: Deferred<ReassignResponse> }[] = [];
  let changes = 0;
  const store = new ReassignStore({
    onGetSettings: () => {
      const d = deferred<SettingsResponse>();
      reads.push(d);
      return d.promise;
    },
    onReassign: (request) => {
      const d = deferred<ReassignResponse>();
      writes.push({ request, deferred: d });
      return d.promise;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return { store, reads, writes, changes: () => changes };
}

const SEED: ReassignSeed = {
  assignment: { harness: "claude", model: "opus", drivers: "implement" },
  verify: null,
};

const LEAVE: BulkDraft = {
  harness: { mode: "leave", value: "" },
  model: { mode: "leave", value: "" },
  drivers: { mode: "leave", value: "" },
  verify: { mode: "leave", value: "" },
};

describe("draftFrom", () => {
  it("prefills every field with the value in force, pinned or not", () => {
    expect(draftFrom({ ...SEED, verify: 3 })).toEqual({
      harness: "claude",
      model: "opus",
      drivers: "implement",
      verify: "3",
    });
  });

  it("shows an unassigned field and an absent verify as empty", () => {
    expect(
      draftFrom({
        assignment: { harness: null, model: null, drivers: "implement" },
        verify: null,
      }),
    ).toEqual({ harness: "", model: "", drivers: "implement", verify: "" });
  });
});

describe("ticketFieldsFrom", () => {
  it("leaves every untouched field out, so showing a value never pins it", () => {
    expect(ticketFieldsFrom(draftFrom(SEED), SEED)).toEqual({});
  });

  it("sends an edited field as its value", () => {
    const draft = { ...draftFrom(SEED), model: " sonnet " };
    expect(ticketFieldsFrom(draft, SEED)).toEqual({ model: "sonnet" });
  });

  it("sends an emptied field as null, which is how a ticket stops being pinned", () => {
    const draft = { ...draftFrom(SEED), model: "" };
    expect(ticketFieldsFrom(draft, SEED)).toEqual({ model: null });
  });

  it("sends verify as a number and an emptied verify as null", () => {
    const seed = { ...SEED, verify: 2 };
    expect(ticketFieldsFrom({ ...draftFrom(seed), verify: "4" }, seed)).toEqual({
      verify: 4,
    });
    expect(ticketFieldsFrom({ ...draftFrom(seed), verify: "" }, seed)).toEqual({
      verify: null,
    });
  });

  it("sends only the fields that moved", () => {
    const draft = { ...draftFrom(SEED), harness: "opencode", verify: "2" };
    expect(ticketFieldsFrom(draft, SEED)).toEqual({ harness: "opencode", verify: 2 });
  });
});

describe("ticketFieldsFrom on an enlisted ticket", () => {
  const ENLISTED: ReassignSeed = { ...SEED, harnessOnly: true };

  it("still sends the harness", () => {
    const draft = { ...draftFrom(ENLISTED), harness: "opencode" };
    expect(ticketFieldsFrom(draft, ENLISTED)).toEqual({ harness: "opencode" });
  });

  it("never sends the three fields the engine fixes, however the draft moved", () => {
    const draft = {
      harness: "claude",
      model: "sonnet",
      drivers: "tdd",
      verify: "3",
    };
    expect(ticketFieldsFrom(draft, ENLISTED)).toEqual({});
  });
});

describe("validateVerify", () => {
  it("accepts a blank verify as no verify count of its own", () => {
    expect(validateVerify(" ")).toBeNull();
  });

  it("refuses anything that is not a whole number of 1 or more", () => {
    expect(validateVerify("0")).toMatch(/whole number/);
    expect(validateVerify("2.5")).toMatch(/whole number/);
    expect(validateVerify("two")).toMatch(/whole number/);
    expect(validateVerify("3")).toBeNull();
  });
});

describe("bulkFieldsFrom", () => {
  it("keeps a left field out of the body entirely", () => {
    expect(bulkFieldsFrom(LEAVE)).toEqual({});
  });

  it("sends a cleared field as null and a set field as its value", () => {
    const draft: BulkDraft = {
      ...LEAVE,
      harness: { mode: "set", value: " opencode " },
      model: { mode: "clear", value: "" },
    };
    expect(bulkFieldsFrom(draft)).toEqual({ harness: "opencode", model: null });
  });

  it("sends a set verify as a number and a cleared one as null", () => {
    expect(
      bulkFieldsFrom({ ...LEAVE, verify: { mode: "set", value: "3" } }),
    ).toEqual({ verify: 3 });
    expect(
      bulkFieldsFrom({ ...LEAVE, verify: { mode: "clear", value: "" } }),
    ).toEqual({ verify: null });
  });
});

describe("validateBulkDraft", () => {
  it("refuses a form that would write nothing", () => {
    expect(validateBulkDraft(LEAVE)).toMatch(/nothing to change/);
  });

  it("refuses a set with no value rather than asking the engine to unassign", () => {
    expect(
      validateBulkDraft({ ...LEAVE, model: { mode: "set", value: "  " } }),
    ).toBe("model is set but has no value");
  });

  it("refuses a verify that is not a whole number", () => {
    expect(
      validateBulkDraft({ ...LEAVE, verify: { mode: "set", value: "0" } }),
    ).toMatch(/whole number/);
  });

  it("accepts a clear on its own", () => {
    expect(
      validateBulkDraft({ ...LEAVE, harness: { mode: "clear", value: "" } }),
    ).toBeNull();
  });
});

describe("resultLine", () => {
  it("counts what landed", () => {
    expect(resultLine({ applied: 3, skipped: [] })).toBe("applied 3");
  });

  it("names every ticket the engine skipped and why", () => {
    expect(
      resultLine({
        applied: 2,
        skipped: [{ id: "T-9", reason: "an Attempt started" }],
      }),
    ).toBe("applied 2, skipped 1 (T-9: an Attempt started)");
  });
});

describe("ReassignStore: one ticket", () => {
  it("holds no draft and nothing dirty until a field moves", () => {
    const rig = harness();
    expect(rig.store.isDirty("A", SEED)).toBe(false);
    expect(rig.store.saveState("A")).toBe("idle");
  });

  it("goes dirty on an edit and back to clean when the edit is undone", () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    expect(rig.store.isDirty("A", SEED)).toBe(true);
    rig.store.setField("A", "model", "opus", SEED);
    expect(rig.store.isDirty("A", SEED)).toBe(false);
  });

  it("sends only the edited field and drops the draft once the write lands", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    expect(rig.store.saveState("A")).toBe("saving");
    expect(rig.writes[0]!.request).toEqual({
      tickets: ["A"],
      fields: { model: "sonnet" },
    });
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A"] }));
    await save;
    expect(rig.store.saveState("A")).toBe("saved");
    // The fresh snapshot is the new baseline, so the draft goes with the save.
    expect(rig.store.field("A", "model", SEED)).toBe("opus");
  });

  it("clears a field by emptying it, which travels as null", async () => {
    const rig = harness();
    rig.store.clearField("A", "model", SEED);
    expect(rig.store.field("A", "model", SEED)).toBe("");
    const save = rig.store.save("A", SEED);
    expect(rig.writes[0]!.request.fields).toEqual({ model: null });
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A"] }));
    await save;
  });

  it("refuses a bad verify on the spot, sending nothing", async () => {
    const rig = harness();
    rig.store.setField("A", "verify", "0", SEED);
    await rig.store.save("A", SEED);
    expect(rig.writes).toHaveLength(0);
    expect(rig.store.saveFailure("A")).toMatch(/whole number/);
  });

  it("keeps the draft and shows the reason when the engine refuses", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    rig.writes[0]!.deferred.reject(new Error("A would end up unassigned"));
    await save;
    expect(rig.store.saveFailure("A")).toBe("A would end up unassigned");
    expect(rig.store.saveState("A")).toBe("idle");
    expect(rig.store.field("A", "model", SEED)).toBe("sonnet");
    expect(rig.store.isDirty("A", SEED)).toBe(true);
  });

  it("treats a skipped ticket as a refusal, not a save", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    rig.writes[0]!.deferred.resolve(
      answer({ skipped: [{ id: "A", reason: "an Attempt started" }] }),
    );
    await save;
    expect(rig.store.saveState("A")).toBe("idle");
    expect(rig.store.saveFailure("A")).toBe("an Attempt started");
    expect(rig.store.field("A", "model", SEED)).toBe("sonnet");
  });

  it("retires a saved verdict as soon as the draft moves again", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A"] }));
    await save;
    expect(rig.store.saveState("A")).toBe("saved");
    rig.store.setField("A", "model", "haiku", SEED);
    expect(rig.store.saveState("A")).toBe("idle");
  });

  it("keeps keystrokes typed while the write was in flight", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    // The operator keeps typing while the answer is out.
    rig.store.setField("A", "model", "sonnet-4", SEED);
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A"] }));
    await save;
    expect(rig.store.field("A", "model", SEED)).toBe("sonnet-4");
    expect(rig.store.isDirty("A", SEED)).toBe(true);
  });

  it("holds the saving state through a prune while the write is out", async () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    const save = rig.store.save("A", SEED);
    // A snapshot lands making A ineligible (its Attempt started) while the
    // write is still out: the render prunes, but the save is still the one
    // that settles it.
    rig.store.pruneDrafts(new Set(["B"]));
    expect(rig.store.saveState("A")).toBe("saving");
    expect(rig.store.field("A", "model", SEED)).toBe("sonnet");
    rig.writes[0]!.deferred.resolve(
      answer({ skipped: [{ id: "A", reason: "an Attempt started" }] }),
    );
    await save;
    expect(rig.store.saveFailure("A")).toBe("an Attempt started");
    // And the next prune, with nothing in flight, clears it.
    rig.store.pruneDrafts(new Set(["B"]));
    expect(rig.store.saveFailure("A")).toBeNull();
  });

  it("drops a draft whose ticket stopped being reassignable", () => {
    const rig = harness();
    rig.store.setField("A", "model", "sonnet", SEED);
    rig.store.pruneDrafts(new Set(["B"]));
    expect(rig.store.field("A", "model", SEED)).toBe("opus");
  });

  it("reads the harness list once, however many surfaces ask", async () => {
    const rig = harness();
    rig.store.ensureHarnesses();
    rig.store.ensureHarnesses();
    expect(rig.reads).toHaveLength(1);
    rig.reads[0]!.resolve(settings());
    await rig.reads[0]!.promise;
    await Promise.resolve();
    expect(rig.store.harnesses).toEqual(["claude", "opencode"]);
  });
});

describe("ReassignStore: the bulk dialog", () => {
  const ROWS = [row("A"), row("B"), row("C")];

  it("opens closed and ticks every listed ticket when it opens", () => {
    const rig = harness();
    expect(rig.store.isDialogOpen).toBe(false);
    rig.store.openDialog();
    expect(rig.store.isDialogOpen).toBe(true);
    expect(rig.store.tickedIds(ROWS)).toEqual(["A", "B", "C"]);
  });

  it("unticks and reticks one row, and toggles all of them at once", () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.toggleTicked("B");
    expect(rig.store.tickedIds(ROWS)).toEqual(["A", "C"]);
    rig.store.setAllTicked(ROWS, false);
    expect(rig.store.tickedIds(ROWS)).toEqual([]);
    rig.store.setAllTicked(ROWS, true);
    expect(rig.store.tickedIds(ROWS)).toEqual(["A", "B", "C"]);
  });

  it("builds the tri-state body for the ticked ids only", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.toggleTicked("C");
    rig.store.setBulkValue("model", "sonnet");
    rig.store.setBulkMode("drivers", "clear");
    const apply = rig.store.apply(ROWS);
    expect(rig.writes[0]!.request).toEqual({
      tickets: ["A", "B"],
      fields: { model: "sonnet", drivers: null },
    });
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A", "B"] }));
    await apply;
  });

  it("shows applying… while the write is out, then the counts", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setBulkValue("harness", "opencode");
    const apply = rig.store.apply(ROWS);
    expect(rig.store.isApplying).toBe(true);
    rig.writes[0]!.deferred.resolve(
      answer({
        applied: ["A", "B"],
        skipped: [{ id: "C", reason: "an Attempt started" }],
      }),
    );
    await apply;
    expect(rig.store.isApplying).toBe(false);
    expect(rig.store.result).toEqual({
      applied: 2,
      skipped: [{ id: "C", reason: "an Attempt started" }],
    });
  });

  it("keeps the draft and the ticks when the engine refuses the whole write", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.toggleTicked("C");
    rig.store.setBulkValue("harness", "kimi");
    const apply = rig.store.apply(ROWS);
    rig.writes[0]!.deferred.reject(new Error("unknown harness kimi"));
    await apply;
    expect(rig.store.failure).toBe("unknown harness kimi");
    expect(rig.store.result).toBeNull();
    expect(rig.store.bulkField("harness")).toEqual({ mode: "set", value: "kimi" });
    expect(rig.store.tickedIds(ROWS)).toEqual(["A", "B"]);
    expect(rig.store.isDialogOpen).toBe(true);
  });

  it("refuses a form that would write nothing, sending nothing", async () => {
    const rig = harness();
    rig.store.openDialog();
    await rig.store.apply(ROWS);
    expect(rig.writes).toHaveLength(0);
    expect(rig.store.failure).toMatch(/nothing to change/);
  });

  it("refuses an apply with no ticket ticked", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setAllTicked(ROWS, false);
    rig.store.setBulkValue("model", "sonnet");
    await rig.store.apply(ROWS);
    expect(rig.writes).toHaveLength(0);
    expect(rig.store.failure).toBe("no tickets ticked");
  });

  it("keeps enlisted tickets in a harness-only write", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setBulkValue("harness", "opencode");
    const rows = [row("A"), row("B", { enlisted: true })];
    const apply = rig.store.apply(rows);
    expect(rig.writes[0]!.request).toEqual({
      tickets: ["A", "B"],
      fields: { harness: "opencode" },
    });
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A", "B"] }));
    await apply;
    expect(rig.store.result).toEqual({ applied: 2, skipped: [] });
  });

  it("leaves enlisted tickets out when the form touches a field the engine fixes", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setBulkValue("model", "sonnet");
    const rows = [row("A"), row("B", { enlisted: true }), row("C")];
    const apply = rig.store.apply(rows);
    expect(rig.writes[0]!.request).toEqual({
      tickets: ["A", "C"],
      fields: { model: "sonnet" },
    });
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A", "C"] }));
    await apply;
    expect(rig.store.result).toEqual({
      applied: 2,
      skipped: [{ id: "B", reason: ENLISTED_HARNESS_ONLY }],
    });
  });

  it("sends nothing when every ticked ticket is enlisted and the form is not", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setBulkMode("verify", "clear");
    const rows = [row("A", { enlisted: true })];
    await rig.store.apply(rows);
    expect(rig.writes).toHaveLength(0);
    expect(resultLine(rig.store.result!)).toBe(
      `applied 0, skipped 1 (A: ${ENLISTED_HARNESS_ONLY})`,
    );
  });

  it("retires the last apply's counts as soon as the form moves again", async () => {
    const rig = harness();
    rig.store.openDialog();
    rig.store.setBulkValue("model", "sonnet");
    const apply = rig.store.apply(ROWS);
    rig.writes[0]!.deferred.resolve(answer({ applied: ["A", "B", "C"] }));
    await apply;
    expect(rig.store.result).not.toBeNull();
    rig.store.toggleTicked("A");
    expect(rig.store.result).toBeNull();
  });
});

/**
 * The dialog on a real DOM, committed the way the composition root commits
 * it: build the tree and morph the one already on the page. The dialog is
 * keyed, so a tick the operator made survives a snapshot tick (ADR-0025).
 */
describe("ReassignStore.render", () => {
  function mount(store: ReassignStore, rows: ReassignTicketRow[]) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.className = "shell";
        const pane = store.render(rows);
        if (pane) shell.appendChild(pane);
        return shell;
      });
    return { root, paint };
  }

  const ROWS = [
    row("A"),
    row("B", { verify: 2, reason: "enlisted: the write waits for the engine" }),
  ];

  it("renders nothing while the dialog is closed", () => {
    const rig = harness();
    const { root, paint } = mount(rig.store, ROWS);
    paint();
    expect(root.querySelector(".reassign-dialog")).toBeNull();
  });

  it("lists every eligible ticket with its per-field source pills", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, ROWS);
    paint();
    expect(root.querySelectorAll(".reassign-row")).toHaveLength(2);
    const first = root.querySelector('[data-key="A"]');
    expect(first?.querySelector(".reassign-source-pinned")?.textContent).toBe("pinned");
    expect(first?.textContent).toContain("claude");
    // The enlisted caveat rides along on the row it belongs to.
    expect(root.querySelector('[data-key="B"]')?.textContent).toContain(
      "the write waits for the engine",
    );
  });

  it("ticks every row by default and survives a re-render with the tick kept", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, ROWS);
    paint();
    const dialog = root.querySelector(".reassign-dialog");
    const tick = root.querySelector<HTMLInputElement>('[data-key="A-tick"]');
    expect(tick?.checked).toBe(true);
    rig.store.toggleTicked("A");
    paint();
    expect(root.querySelector(".reassign-dialog")).toBe(dialog);
    expect(root.querySelector<HTMLInputElement>('[data-key="A-tick"]')).toBe(tick);
    expect(tick!.checked).toBe(false);
    // And an unrelated re-render leaves it untouched.
    paint();
    expect(root.querySelector<HTMLInputElement>('[data-key="A-tick"]')!.checked).toBe(
      false,
    );
  });

  it("tags an enlisted row as harness only", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, [row("A"), row("B", { enlisted: true })]);
    paint();
    expect(
      root.querySelector('[data-key="A"] .reassign-harness-only'),
    ).toBeNull();
    expect(
      root.querySelector('[data-key="B"] .reassign-harness-only')?.textContent,
    ).toBe("harness only");
  });

  it("gives the row list its own scroll region, keyed so the scroll survives", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, ROWS);
    paint();
    const rows = root.querySelector('[data-key="reassign-rows"]');
    expect(rows).not.toBeNull();
    paint();
    expect(root.querySelector('[data-key="reassign-rows"]')).toBe(rows);
  });

  it("shows a value input only for a field set to set, and keeps it across a tick", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, ROWS);
    paint();
    expect(root.querySelector('[data-key="reassign-bulk-model"]')).toBeNull();
    rig.store.setBulkMode("model", "set");
    paint();
    const input = root.querySelector<HTMLInputElement>('[data-key="reassign-bulk-model"]');
    expect(input).not.toBeNull();
    rig.store.setBulkValue("model", "sonnet");
    paint();
    expect(
      root.querySelector<HTMLInputElement>('[data-key="reassign-bulk-model"]'),
    ).toBe(input);
    expect(input!.value).toBe("sonnet");
  });

  it("says so plainly when nothing can be reassigned", () => {
    const rig = harness();
    rig.store.openDialog();
    const { root, paint } = mount(rig.store, []);
    paint();
    expect(root.querySelector(".reassign-empty")?.textContent).toBe(
      "no ticket can be reassigned right now",
    );
  });
});
