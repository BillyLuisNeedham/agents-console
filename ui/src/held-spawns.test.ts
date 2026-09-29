/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { HeldSpawnsStore } from "./held-spawns";
import { commit } from "./morph";
import { useDom } from "./test-dom";
import type {
  HeldSpawnResponse,
  HeldSpawnRow,
  PendingSpawnResponse,
  PendingSpawnRow,
  SpawnLineView,
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

function row(overrides: Partial<HeldSpawnRow> = {}): HeldSpawnRow {
  return {
    id: "held-1",
    title: "Fix the flaky login test",
    kind: "ticket",
    parent: "from 03",
    reason: "per-run cap",
    waited: "12m ago",
    at: "2026-09-29T10:00:00Z",
    blockedBy: null,
    blocks: "blocks every ticket not yet started",
    overlaps: null,
    body: "The login test fails one run in five.",
    adopting: false,
    adoptError: null,
    ...overrides,
  };
}

function pendingRow(overrides: Partial<PendingSpawnRow> = {}): PendingSpawnRow {
  return {
    id: "proposal-3",
    title: "Write the migration guide",
    kind: "ticket",
    parent: "from 04",
    waited: "1m ago",
    at: "2026-09-29T10:10:00Z",
    blockedBy: null,
    blocks: null,
    overlaps: null,
    body: "Document every renamed flag.",
    ...overrides,
  };
}

const LINE: SpawnLineView = { text: "Spawns 20/20 this run · 5 per attempt · 1 held", warn: true };

/** A store wired to hand-settled deferreds, so a test sees the request in
 *  flight before it answers (the enlist.test.ts pattern). The optional
 *  `onChange` stands in for the composition's re-render. */
function harness(onChange: () => void = () => {}) {
  const adopts: { id: string; deferred: Deferred<HeldSpawnResponse> }[] = [];
  const discards: { id: string; deferred: Deferred<HeldSpawnResponse> }[] = [];
  const holds: { id: string; deferred: Deferred<PendingSpawnResponse> }[] = [];
  const pendingDiscards: { id: string; deferred: Deferred<PendingSpawnResponse> }[] = [];
  const store = new HeldSpawnsStore({
    onAdopt: (id) => {
      const d = deferred<HeldSpawnResponse>();
      adopts.push({ id, deferred: d });
      return d.promise;
    },
    onDiscard: (id) => {
      const d = deferred<HeldSpawnResponse>();
      discards.push({ id, deferred: d });
      return d.promise;
    },
    onHold: (id) => {
      const d = deferred<PendingSpawnResponse>();
      holds.push({ id, deferred: d });
      return d.promise;
    },
    onDiscardPending: (id) => {
      const d = deferred<PendingSpawnResponse>();
      pendingDiscards.push({ id, deferred: d });
      return d.promise;
    },
    onChange,
  });
  return { store, adopts, discards, holds, pendingDiscards };
}

function mount(
  store: HeldSpawnsStore,
  rows: () => HeldSpawnRow[],
  pending: () => PendingSpawnRow[] = () => [],
) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const paint = () =>
    commit(root, () => {
      const shell = document.createElement("div");
      const pane = store.render(pending(), rows(), LINE);
      if (pane) shell.appendChild(pane);
      return shell;
    });
  return { root, paint };
}

function button(root: HTMLElement, id: string, cls: string): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-key="held-spawn-${id}"] .${cls}`);
}

describe("HeldSpawnsStore", () => {
  it("renders nothing until the header line opens it, and toggles closed", () => {
    const { store } = harness();
    expect(store.render([], [row()], LINE)).toBeNull();
    store.toggle();
    expect(store.isOpen).toBe(true);
    store.toggle();
    expect(store.isOpen).toBe(false);
  });

  it("adopts by id, holding both buttons off while the request is out", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [row()]);
    paint = mounted.paint;
    rig.store.open();
    button(mounted.root, "held-1", "held-spawn-adopt")!.click();
    expect(rig.adopts.map((a) => a.id)).toEqual(["held-1"]);
    expect(button(mounted.root, "held-1", "held-spawn-adopt")!.disabled).toBe(true);
    expect(button(mounted.root, "held-1", "held-spawn-discard")!.disabled).toBe(true);
    // A second click while the first is out sends nothing.
    void rig.store.adopt("held-1");
    expect(rig.adopts).toHaveLength(1);
    rig.adopts[0]!.deferred.resolve({ id: "held-1" });
    await rig.adopts[0]!.deferred.promise;
    await Promise.resolve();
    expect(button(mounted.root, "held-1", "held-spawn-adopt")!.disabled).toBe(false);
  });

  it("holds the buttons off while the engine says an Adopt is on its way", () => {
    const rig = harness();
    const { root, paint } = mount(rig.store, () => [row({ adopting: true })]);
    rig.store.open();
    paint();
    expect(button(root, "held-1", "held-spawn-adopt")!.disabled).toBe(true);
    expect(button(root, "held-1", "held-spawn-adopt")!.textContent).toBe("adopting…");
    expect(button(root, "held-1", "held-spawn-discard")!.disabled).toBe(true);
  });

  it("shows a refusal's reason beside that spawn's buttons, and clears it on the next try", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [row(), row({ id: "held-2" })]);
    paint = mounted.paint;
    rig.store.open();
    const adopt = rig.store.adopt("held-1");
    rig.adopts[0]!.deferred.reject(new Error("held spawn held-1 cannot be adopted: 09 is gone"));
    await adopt;
    const failure = (id: string) =>
      mounted.root.querySelector(`[data-key="held-spawn-${id}"] .held-spawn-failure`);
    expect(failure("held-1")?.textContent).toBe(
      "held spawn held-1 cannot be adopted: 09 is gone",
    );
    expect(failure("held-2")).toBeNull();
    void rig.store.adopt("held-1");
    expect(failure("held-1")).toBeNull();
  });

  it("shows why the boundary refused the last Adopt until this tab's own answer", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [row({ adoptError: "blocker 09 is gone" })]);
    paint = mounted.paint;
    rig.store.open();
    const failure = () => mounted.root.querySelector(".held-spawn-failure")?.textContent;
    expect(failure()).toBe("last Adopt refused: blocker 09 is gone");
    const adopt = rig.store.adopt("held-1");
    rig.adopts[0]!.deferred.reject(new Error("no held spawn held-1"));
    await adopt;
    expect(failure()).toBe("no held spawn held-1");
  });

  it("asks before a Discard, and Cancel sends nothing", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [row()]);
    paint = mounted.paint;
    rig.store.open();
    button(mounted.root, "held-1", "held-spawn-discard")!.click();
    expect(rig.discards).toHaveLength(0);
    expect(
      mounted.root.querySelector('[data-key="held-spawn-held-1"] .held-spawn-prompt')?.textContent,
    ).toBe("Discard for good?");
    button(mounted.root, "held-1", "held-spawn-cancel")!.click();
    expect(rig.discards).toHaveLength(0);
    expect(mounted.root.querySelector(".held-spawn-prompt")).toBeNull();

    button(mounted.root, "held-1", "held-spawn-discard")!.click();
    button(mounted.root, "held-1", "held-spawn-confirm")!.click();
    expect(rig.discards.map((d) => d.id)).toEqual(["held-1"]);
    expect(button(mounted.root, "held-1", "held-spawn-confirm")!.disabled).toBe(true);
    rig.discards[0]!.deferred.resolve({ id: "held-1" });
    await rig.discards[0]!.deferred.promise;
  });

  it("keeps a refused Discard's spawn with its reason and drops the confirmation", async () => {
    const rig = harness();
    rig.store.open();
    rig.store.armDiscard("held-1");
    const discard = rig.store.confirmDiscard("held-1");
    rig.discards[0]!.deferred.reject(new Error("held spawn held-1 is already being adopted"));
    await discard;
    const { root, paint } = mount(rig.store, () => [row()]);
    paint();
    expect(root.querySelector(".held-spawn-prompt")).toBeNull();
    expect(root.querySelector(".held-spawn-failure")?.textContent).toBe(
      "held spawn held-1 is already being adopted",
    );
  });

  it("shows each spawn's parent, cap, wait and edges, the body only once expanded", () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [row({ blockedBy: "waits on 01" })]);
    paint = mounted.paint;
    rig.store.open();
    const meta = mounted.root.querySelector(".held-spawn-meta")?.textContent ?? "";
    for (const words of ["from 03", "per-run cap", "12m ago", "waits on 01", "blocks every"]) {
      expect(meta).toContain(words);
    }
    expect(mounted.root.querySelector(".held-spawn-body")).toBeNull();
    button(mounted.root, "held-1", "held-spawn-toggle")!.click();
    expect(mounted.root.querySelector(".held-spawn-body")?.textContent).toBe(
      "The login test fails one run in five.",
    );
  });

  it("says so when nothing is pending or held, and heads the list with the caps line", () => {
    const rig = harness();
    const { root, paint } = mount(rig.store, () => []);
    rig.store.open();
    paint();
    expect([...root.querySelectorAll(".held-spawns-empty")].map((el) => el.textContent)).toEqual([
      "no pending spawns",
      "no held spawns",
    ]);
    expect(root.querySelector(".held-spawns-line")?.textContent).toBe(LINE.text);
  });

  // Issue #150: the Pending spawns come first, each with Hold and Discard.
  it("lists the Pending spawns first, each with Hold and a confirmed Discard", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(
      rig.store,
      () => [row()],
      () => [pendingRow({ overlaps: "overlaps 02" })],
    );
    paint = mounted.paint;
    rig.store.open();
    const root = mounted.root;
    expect([...root.querySelectorAll(".held-spawns-section-head")].map((el) => el.textContent))
      .toEqual(["pending · 1", "held · 1"]);
    const pending = root.querySelector('[data-key="pending-spawn-proposal-3"]')!;
    expect(pending.querySelector(".held-spawn-meta")?.textContent).toContain("overlaps 02");
    expect(pending.querySelector(".held-spawn-adopt")).toBeNull();

    pending.querySelector<HTMLButtonElement>(".held-spawn-hold")!.click();
    expect(rig.holds.map((h) => h.id)).toEqual(["proposal-3"]);
    expect(
      root.querySelector<HTMLButtonElement>('[data-key="pending-spawn-proposal-3"] .held-spawn-hold')!
        .textContent,
    ).toBe("holding…");
    rig.holds[0]!.deferred.resolve({ id: "proposal-3" });
    await Promise.resolve();
    await Promise.resolve();

    root.querySelector<HTMLButtonElement>('[data-key="pending-spawn-proposal-3"] .held-spawn-discard')!.click();
    root.querySelector<HTMLButtonElement>('[data-key="pending-spawn-proposal-3"] .held-spawn-confirm')!.click();
    expect(rig.pendingDiscards.map((d) => d.id)).toEqual(["proposal-3"]);
    expect(rig.discards).toEqual([]);
  });

  it("shows a refused Hold beside that pending spawn", async () => {
    let paint = () => {};
    const rig = harness(() => paint());
    const mounted = mount(rig.store, () => [], () => [pendingRow()]);
    paint = mounted.paint;
    rig.store.open();
    const hold = rig.store.hold("proposal-3");
    rig.holds[0]!.deferred.reject(new Error("no pending spawn proposal-3: it has landed or been discarded"));
    await hold;
    expect(
      mounted.root.querySelector('[data-key="pending-spawn-proposal-3"] .held-spawn-failure')?.textContent,
    ).toBe("no pending spawn proposal-3: it has landed or been discarded");
  });

  // The Detail of a faded card offers the list's own decisions.
  it("says why the boundary could not land a spawn it held for that", () => {
    const rig = harness();
    const { root, paint } = mount(rig.store, () => [
      row({ reason: "refused at landing", adoptError: "blocks names done tickets: 02" }),
    ]);
    rig.store.open();
    paint();
    expect(root.querySelector(".held-spawn-failure")?.textContent).toBe(
      "the boundary could not land it: blocks names done tickets: 02",
    );
  });

  it("draws one spawn's decisions for the Detail, sharing the list's state", () => {
    const rig = harness();
    void rig.store.hold("proposal-3");
    const decision = rig.store.renderDecision(pendingRow(), "pending");
    expect(decision.querySelector<HTMLButtonElement>(".held-spawn-hold")!.disabled).toBe(true);
    const held = rig.store.renderDecision(row(), "held");
    expect(held.querySelector(".held-spawn-adopt")?.textContent).toBe("Adopt");
  });

  it("forgets the state of a spawn no longer held", async () => {
    const rig = harness();
    rig.store.open();
    rig.store.toggleBody("held-1");
    rig.store.armDiscard("held-1");
    rig.store.prune(new Set());
    const { root, paint } = mount(rig.store, () => [row()]);
    paint();
    expect(root.querySelector(".held-spawn-body")).toBeNull();
    expect(root.querySelector(".held-spawn-prompt")).toBeNull();
  });
});
