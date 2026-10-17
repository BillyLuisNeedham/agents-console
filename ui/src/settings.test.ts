/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  machineDefaultsFrom,
  poolDraftFrom,
  poolPatchFrom,
  SettingsStore,
  validatePoolDraft,
  type PoolDraft,
} from "./settings";
import { commit } from "./morph";
import { useDom } from "./test-dom";
import type { RestartView, StopView } from "./view";
import {
  projectRestartBadges,
  type MachineDefaults,
  type PoolConfigPatch,
  type SettingsResponse,
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

function settings(overrides: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    pool: {
      path: "/tmp/pool/console.json",
      config: {
        defaults: { harness: "claude", model: "opus", drivers: "implement" },
        resolver: "claude",
        port: 4300,
        selection: "auto",
        reviewer: "two engineers",
      },
      bootOnly: ["selection", "terminal", "port"],
      effective: { port: 4300, terminal: null, stale: [] },
      ...overrides.pool,
    },
    machine: {
      path: "/home/me/.agent-graphs/defaults.json",
      defaults: { harness: "claude", engine: "/repo/engine" },
      own: { harness: "claude" },
      ...overrides.machine,
    },
    harnesses: overrides.harnesses ?? ["claude", "opencode"],
  };
}

/** A store wired to hand-settled deferreds, so a test pins the read's
 *  dispatch before any answer lands (the enlist.test.ts pattern). The
 *  optional `onChange` stands in for the composition's re-render. */
function harness(onChange: () => void = () => {}) {
  const reads: Deferred<SettingsResponse>[] = [];
  const poolSaves: { config: PoolConfigPatch; deferred: Deferred<SettingsResponse> }[] = [];
  const machineSaves: {
    defaults: MachineDefaults;
    deferred: Deferred<SettingsResponse>;
  }[] = [];
  let changes = 0;
  let opens = 0;
  const store = new SettingsStore({
    onGetSettings: () => {
      const d = deferred<SettingsResponse>();
      reads.push(d);
      return d.promise;
    },
    onSavePool: (config) => {
      const d = deferred<SettingsResponse>();
      poolSaves.push({ config, deferred: d });
      return d.promise;
    },
    onSaveMachine: (defaults) => {
      const d = deferred<SettingsResponse>();
      machineSaves.push({ defaults, deferred: d });
      return d.promise;
    },
    onOpenReassign: () => {
      opens += 1;
    },
    onChange: () => {
      changes += 1;
      onChange();
    },
  });
  return {
    store,
    reads,
    poolSaves,
    machineSaves,
    changes: () => changes,
    opens: () => opens,
  };
}

/** An opened store already holding an answer. */
async function opened(
  response: SettingsResponse = settings(),
  onChange?: () => void,
) {
  const rig = harness(onChange);
  const open = rig.store.open();
  rig.reads[0]!.resolve(response);
  await open;
  return rig;
}

const EMPTY: PoolDraft = poolDraftFrom({});

/** The footer's Stop as a connected tab sees it before any press (ADR-0039). */
const IDLE_STOP: StopView = {
  offered: true,
  state: "idle",
  prompt: "Really stop?",
  failure: null,
  stoppedFromHere: false,
  relaunch: null,
};

const FOOT_HANDLERS = {
  onArmRestart: () => {},
  onCancelRestart: () => {},
  onConfirmRestart: () => {},
  onArmStop: () => {},
  onCancelStop: () => {},
  onConfirmStop: () => {},
};

describe("poolDraftFrom", () => {
  it("seeds every field from the config, absent keys as empty", () => {
    const draft = poolDraftFrom(settings().pool.config);
    expect(draft.harness).toBe("claude");
    expect(draft.model).toBe("opus");
    expect(draft.drivers).toBe("implement");
    expect(draft.resolverHarness).toBe("claude");
    expect(draft.resolverModel).toBe("");
    expect(draft.port).toBe("4300");
    expect(draft.selection).toBe("auto");
    expect(draft.terminal).toBe(false);
    expect(draft.checkpoint).toBe("");
  });

  it("splits the resolver's object form across its fields", () => {
    const draft = poolDraftFrom({ resolver: { harness: "opencode", model: "sonnet", effort: "max" } });
    expect(draft.resolverHarness).toBe("opencode");
    expect(draft.resolverModel).toBe("sonnet");
    expect(draft.resolverEffort).toBe("max");
  });

  it("seeds the defaults' effort, and none as an empty field", () => {
    expect(poolDraftFrom({ defaults: { effort: "high" } }).effort).toBe("high");
    expect(EMPTY.effort).toBe("");
  });

  it("reads a terminal-backed pool's checkbox as ticked", () => {
    expect(poolDraftFrom({ terminal: "herdr" }).terminal).toBe(true);
  });

  it("seeds the Pool title, and an untitled pool as an empty field (issue #100)", () => {
    expect(poolDraftFrom({ title: "Jev as the grader" }).title).toBe("Jev as the grader");
    expect(EMPTY.title).toBe("");
  });

  it("seeds the Spawn caps the file sets, and an unset one as an empty field (issue #149)", () => {
    const draft = poolDraftFrom({ spawnCaps: { perRun: 40 } });
    expect(draft.spawnsPerRun).toBe("40");
    expect(draft.spawnsPerAttempt).toBe("");
    expect(EMPTY.spawnsPerRun).toBe("");
  });
});

describe("poolPatchFrom", () => {
  it("sends an emptied field as null so the engine removes the key", () => {
    const patch = poolPatchFrom(EMPTY);
    expect(patch.port).toBeNull();
    expect(patch.terminal).toBeNull();
    expect(patch.selection).toBeNull();
    expect(patch.reviewer).toBeNull();
    expect(patch.resolver).toBeNull();
    expect(patch.defaults).toEqual({ harness: "", model: "", effort: "", drivers: "" });
  });

  it("sends the port as a number and the terminal as herdr", () => {
    const patch = poolPatchFrom({ ...EMPTY, port: " 4400 ", terminal: true });
    expect(patch.port).toBe(4400);
    expect(patch.terminal).toBe("herdr");
  });

  it("collapses a resolver with no model to the bare harness name", () => {
    expect(poolPatchFrom({ ...EMPTY, resolverHarness: "claude" }).resolver).toBe("claude");
  });

  it("keeps the pair when the resolver carries a model", () => {
    const patch = poolPatchFrom({
      ...EMPTY,
      resolverHarness: "claude",
      resolverModel: "opus",
    });
    expect(patch.resolver).toEqual({ harness: "claude", model: "opus" });
  });

  it("sends the defaults' effort trimmed, and keeps the object for a resolver effort", () => {
    expect(poolPatchFrom({ ...EMPTY, effort: " xhigh " }).defaults?.effort).toBe("xhigh");
    expect(
      poolPatchFrom({ ...EMPTY, resolverHarness: "claude", resolverEffort: " max " }).resolver,
    ).toEqual({ harness: "claude", effort: "max" });
    expect(poolPatchFrom({ ...EMPTY, resolverEffort: "low" }).resolver).toEqual({ effort: "low" });
  });

  it("passes `none` through as the opt-out string", () => {
    expect(poolPatchFrom({ ...EMPTY, resolverHarness: "none" }).resolver).toBe("none");
  });

  it("sends the Pool title trimmed, and an emptied one as null (issue #100)", () => {
    expect(poolPatchFrom({ ...EMPTY, title: "  Jev as the grader " }).title).toBe(
      "Jev as the grader",
    );
    expect(poolPatchFrom(EMPTY).title).toBeNull();
  });

  it("sends the Spawn caps whole, as numbers, an emptied one as null (issue #149)", () => {
    expect(
      poolPatchFrom({ ...EMPTY, spawnsPerAttempt: " 8 ", spawnsPerRun: "" }).spawnCaps,
    ).toEqual({ perAttempt: 8, perRun: null });
    expect(poolPatchFrom(EMPTY).spawnCaps).toEqual({ perAttempt: null, perRun: null });
  });

  it("drops a selection that is neither auto nor human", () => {
    expect(poolPatchFrom({ ...EMPTY, selection: "sometimes" }).selection).toBeNull();
  });
});

describe("validatePoolDraft", () => {
  it("accepts an empty port as auto", () => {
    expect(validatePoolDraft(EMPTY)).toBeNull();
  });

  it("refuses a port that is not a port", () => {
    expect(validatePoolDraft({ ...EMPTY, port: "80.5" })).toMatch(/port must be/);
    expect(validatePoolDraft({ ...EMPTY, port: "0" })).toMatch(/port must be/);
    expect(validatePoolDraft({ ...EMPTY, port: "99999" })).toMatch(/port must be/);
  });

  it("refuses a Spawn cap that is not a whole number of 0 or more (issue #149, #150)", () => {
    for (const bad of ["2.5", "-1", "lots"]) {
      expect(validatePoolDraft({ ...EMPTY, spawnsPerAttempt: bad })).toMatch(
        /spawns per attempt must be/,
      );
      expect(validatePoolDraft({ ...EMPTY, spawnsPerRun: bad })).toMatch(
        /spawns per run must be/,
      );
    }
    expect(validatePoolDraft({ ...EMPTY, spawnsPerAttempt: " 3 ", spawnsPerRun: "40" })).toBeNull();
    // A cap of 0 holds every proposal for the operator (issue #150).
    expect(validatePoolDraft({ ...EMPTY, spawnsPerAttempt: "0", spawnsPerRun: "0" })).toBeNull();
    expect(poolPatchFrom({ ...EMPTY, spawnsPerAttempt: "0", spawnsPerRun: "" }).spawnCaps).toEqual({
      perAttempt: 0,
      perRun: null,
    });
  });
});

describe("machineDefaultsFrom", () => {
  it("leaves every emptied field out rather than writing a blank", () => {
    expect(
      machineDefaultsFrom({
        harness: "",
        model: "",
        effort: "",
        drivers: "",
        terminal: false,
        engine: "",
      }),
    ).toEqual({});
  });

  it("writes only what the operator filled in", () => {
    expect(
      machineDefaultsFrom({
        harness: "claude",
        model: "",
        effort: " high ",
        drivers: " implement ",
        terminal: true,
        engine: "/repo/engine",
      }),
    ).toEqual({
      harness: "claude",
      effort: "high",
      drivers: "implement",
      engine: "/repo/engine",
      terminal: "herdr",
    });
  });
});

describe("projectRestartBadges", () => {
  it("badges nothing when the engine reports nothing stale", () => {
    expect([...projectRestartBadges([])]).toEqual([]);
  });

  it("badges every boot-only key the engine names", () => {
    expect([...projectRestartBadges(["port", "selection"])].sort()).toEqual([
      "port",
      "selection",
    ]);
  });

  it("drops a key outside the badge vocabulary rather than trusting the wire", () => {
    // `stale` is a list of plain strings; a key the pane has no field for
    // would badge nothing anyway, so it never reaches the lookup.
    expect([...projectRestartBadges(["port", "assign", "defaults", "roster"])]).toEqual(["port"]);
  });
});

describe("SettingsStore", () => {
  it("opens closed and reads nothing until it is opened", () => {
    const rig = harness();
    expect(rig.store.isOpen).toBe(false);
    expect(rig.reads).toHaveLength(0);
  });

  it("shows the pane while the read is out and seeds both drafts from the answer", async () => {
    const rig = harness();
    const open = rig.store.open();
    expect(rig.store.isOpen).toBe(true);
    expect(rig.store.isLoading).toBe(true);
    rig.reads[0]!.resolve(settings());
    await open;
    expect(rig.store.isLoading).toBe(false);
    expect(rig.store.poolField("harness")).toBe("claude");
    expect(rig.store.machineField("harness")).toBe("claude");
    expect(rig.store.machineField("engine")).toBe("");
  });

  it("holds a failed read's reason and offers no settings", async () => {
    const rig = harness();
    const open = rig.store.open();
    rig.reads[0]!.reject(new Error("settings failed: 500"));
    await open;
    expect(rig.store.failure).toBe("settings failed: 500");
    expect(rig.store.settings).toBeNull();
  });

  it("ignores an answer to a pane that has since closed", async () => {
    const rig = harness();
    const open = rig.store.open();
    rig.store.close();
    rig.reads[0]!.resolve(settings());
    await open;
    expect(rig.store.settings).toBeNull();
    expect(rig.store.isOpen).toBe(false);
  });

  it("reads afresh on a reopen and no-ops on a second open", async () => {
    const rig = await opened();
    expect(rig.reads).toHaveLength(1);
    void rig.store.open();
    expect(rig.reads).toHaveLength(1);
    rig.store.close();
    void rig.store.open();
    expect(rig.reads).toHaveLength(2);
  });

  it("toggles closed from the header button", async () => {
    const rig = await opened();
    rig.store.toggle();
    expect(rig.store.isOpen).toBe(false);
    rig.store.toggle();
    expect(rig.store.isOpen).toBe(true);
  });

  it("tracks each form's dirty flag on its own", async () => {
    const rig = await opened();
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.machineDirty).toBe(false);
    rig.store.setPoolField("model", "sonnet");
    expect(rig.store.poolDirty).toBe(true);
    expect(rig.store.machineDirty).toBe(false);
  });

  it("re-renders on every text edit, so Save sees the draft (issue #142)", async () => {
    const rig = await opened();
    const before = rig.changes();
    rig.store.setPoolField("model", "sonnet");
    expect(rig.changes()).toBe(before + 1);
    rig.store.setMachineField("model", "sonnet");
    expect(rig.changes()).toBe(before + 2);
    // Setting what is already there changes nothing, so nothing re-renders.
    rig.store.setPoolField("model", "sonnet");
    expect(rig.changes()).toBe(before + 2);
  });

  it("counts a whitespace-only edit as clean, since the save would trim it", async () => {
    const rig = await opened();
    rig.store.setPoolField("model", " opus  ");
    expect(rig.store.poolDirty).toBe(false);
    rig.store.setPoolField("reviewer", "two engineers ");
    expect(rig.store.poolDirty).toBe(false);
    rig.store.setMachineField("harness", "claude ");
    expect(rig.store.machineDirty).toBe(false);
    rig.store.setPoolField("title", "   ");
    expect(rig.store.poolDirty).toBe(false);
    rig.store.setPoolField("model", "opus 2");
    expect(rig.store.poolDirty).toBe(true);
  });

  it("sends the edited draft as a patch and re-seeds from the answer", async () => {
    const rig = await opened();
    rig.store.setPoolField("model", "sonnet");
    const save = rig.store.savePool();
    expect(rig.store.poolSaveState).toBe("saving");
    expect(rig.poolSaves[0]!.config.defaults).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "",
      drivers: "implement",
    });
    const saved = settings();
    saved.pool.config.defaults = { harness: "claude", model: "sonnet", drivers: "implement" };
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolSaveState).toBe("saved");
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.poolField("model")).toBe("sonnet");
  });

  it("refuses an invalid draft on the spot, sending nothing", async () => {
    const rig = await opened();
    rig.store.setPoolField("port", "nope");
    await rig.store.savePool();
    expect(rig.poolSaves).toHaveLength(0);
    expect(rig.store.poolFailure).toMatch(/port must be/);
  });

  it("keeps the draft and shows the reason when the engine refuses a save", async () => {
    const rig = await opened();
    rig.store.setPoolField("model", "sonnet");
    const save = rig.store.savePool();
    rig.poolSaves[0]!.deferred.reject(new Error("console.json is not writable"));
    await save;
    expect(rig.store.poolFailure).toBe("console.json is not writable");
    expect(rig.store.poolSaveState).toBe("idle");
    expect(rig.store.poolField("model")).toBe("sonnet");
    expect(rig.store.poolDirty).toBe(true);
  });

  it("retires a saved verdict as soon as the draft moves again", async () => {
    const rig = await opened();
    rig.store.setPoolField("model", "sonnet");
    const save = rig.store.savePool();
    const saved = settings();
    saved.pool.config.defaults = { harness: "claude", model: "sonnet", drivers: "implement" };
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolSaveState).toBe("saved");
    rig.store.setPoolField("model", "haiku");
    expect(rig.store.poolSaveState).toBe("idle");
  });

  it("saves the machine defaults separately, leaving a pool edit alone", async () => {
    const rig = await opened();
    rig.store.setPoolField("model", "sonnet");
    rig.store.setMachineField("engine", "/repo/engine");
    const save = rig.store.saveMachine();
    expect(rig.machineSaves[0]!.defaults).toEqual({
      harness: "claude",
      engine: "/repo/engine",
    });
    rig.machineSaves[0]!.deferred.reject(new Error("defaults file is not writable"));
    await save;
    expect(rig.store.machineFailure).toBe("defaults file is not writable");
    expect(rig.store.poolField("model")).toBe("sonnet");
  });

  it("badges what the engine reports stale after a save", async () => {
    const rig = await opened();
    expect([...rig.store.badges()]).toEqual([]);
    rig.store.setPoolField("selection", "human");
    const save = rig.store.savePool();
    const saved = settings();
    saved.pool.config.selection = "human";
    saved.pool.effective.stale = ["selection"];
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.badges().has("selection")).toBe(true);
  });

  it("badges a key a save never touched, so a hand edit or another tab shows", async () => {
    // The engine derives `stale` from the file against what it booted with,
    // so a pool whose config was edited outside this page badges on the very
    // first read, with no save in this session to have noticed it.
    const edited = settings();
    edited.pool.effective.stale = ["selection", "terminal"];
    const rig = await opened(edited);
    expect([...rig.store.badges()].sort()).toEqual(["selection", "terminal"]);
  });

  it("clears a badge when a save puts the value back", async () => {
    const stale = settings();
    stale.pool.effective.stale = ["port"];
    const rig = await opened(stale);
    expect(rig.store.badges().has("port")).toBe(true);
    rig.store.setPoolField("port", "4300");
    const save = rig.store.savePool();
    rig.poolSaves[0]!.deferred.resolve(settings());
    await save;
    expect(rig.store.badges().has("port")).toBe(false);
  });

  it("badges nothing before the first read", () => {
    const rig = harness();
    expect([...rig.store.badges()]).toEqual([]);
  });
});

/**
 * The pane on a real DOM, committed the way the composition root commits it:
 * build the tree and morph the one already on the page. Every input is keyed,
 * so the morph keeps the node and with it the focus, the caret and the value
 * the operator is part way through typing (ADR-0025).
 */
describe("SettingsStore.render", () => {
  const RESTART: RestartView = {
    offered: true,
    state: "idle",
    failure: null,
    waiting: false,
  };

  function mount(store: SettingsStore): { root: HTMLElement; paint(): void } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const pane = store.render(RESTART, IDLE_STOP, FOOT_HANDLERS);
        const shell = document.createElement("div");
        shell.className = "shell";
        if (pane) shell.appendChild(pane);
        return shell;
      });
    return { root, paint };
  }

  it("renders nothing while the pane is closed", () => {
    const rig = harness();
    const { root, paint } = mount(rig.store);
    paint();
    expect(root.querySelector(".settings-pane")).toBeNull();
  });

  it("keys every input, so a morph keeps the node the operator is typing into", async () => {
    const rig = await opened();
    const { root, paint } = mount(rig.store);
    paint();
    const model = root.querySelector<HTMLInputElement>('[data-key="pool-model-input"]');
    expect(model).not.toBeNull();
    model!.value = "half-typed";
    rig.store.setPoolField("model", "half-typed");
    paint();
    expect(
      root.querySelector<HTMLInputElement>('[data-key="pool-model-input"]'),
    ).toBe(model);
    expect(model!.value).toBe("half-typed");
  });

  /** Types into a keyed input the way the browser does: value, then event. */
  function type(root: HTMLElement, key: string, value: string): void {
    const input = root.querySelector<HTMLInputElement>(`[data-key="${key}"]`);
    expect(input).not.toBeNull();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function saveButton(root: HTMLElement, which: "pool" | "machine"): HTMLButtonElement {
    const button = root.querySelector<HTMLButtonElement>(
      `[data-key="settings-save-${which}"] .settings-save`,
    );
    expect(button).not.toBeNull();
    return button!;
  }

  it("enables Save as the operator types, and disables it on a revert (issue #142)", async () => {
    // The pane re-renders only when the store says so, as in the app: no
    // hand-painted frame between the keystroke and the assertion.
    let paint = () => {};
    const rig = await opened(settings(), () => paint());
    const mounted = mount(rig.store);
    paint = mounted.paint;
    paint();
    const { root } = mounted;

    for (const [which, key, value, saved] of [
      ["pool", "pool-model-input", "sonnet", "opus"],
      ["pool", "pool-title-input", "Release train", ""],
      ["pool", "pool-port-input", "4301", "4300"],
      ["pool", "pool-spawnsPerRun-input", "40", ""],
      ["machine", "machine-model-input", "sonnet", ""],
      ["machine", "machine-engine-input", "/other/engine", ""],
    ] as const) {
      expect(saveButton(root, which).disabled).toBe(true);
      type(root, key, value);
      expect(saveButton(root, which).disabled).toBe(false);
      type(root, key, saved);
      expect(saveButton(root, which).disabled).toBe(true);
    }
  });

  it("offers the Pool title first, the directory name as its placeholder (issue #100)", async () => {
    const rig = await opened();
    const { root, paint } = mount(rig.store);
    paint();
    const inputs = [...root.querySelectorAll<HTMLInputElement>(".settings-input")];
    expect(inputs[0]?.getAttribute("data-key")).toBe("pool-title-input");
    expect(inputs[0]?.getAttribute("placeholder")).toBe("pool");
    // Display-only and live: never badged for a Restart.
    const field = root.querySelector('[data-key="pool-title"]');
    expect(field?.querySelector(".settings-badge")).toBeNull();
  });

  it("offers both Spawn caps with their defaults as placeholders and no Restart badge (issue #149)", async () => {
    const rig = await opened(
      settings({
        pool: {
          ...settings().pool,
          config: { spawnCaps: { perAttempt: 3 } },
          effective: { port: 4300, terminal: null, stale: ["spawnCaps"] },
        },
      }),
    );
    const { root, paint } = mount(rig.store);
    paint();
    const perAttempt = root.querySelector<HTMLInputElement>(
      '[data-key="pool-spawnsPerAttempt-input"]',
    );
    const perRun = root.querySelector<HTMLInputElement>('[data-key="pool-spawnsPerRun-input"]');
    expect(perAttempt?.value).toBe("3");
    expect(perAttempt?.getAttribute("placeholder")).toBe("5 (default)");
    expect(perRun?.value).toBe("");
    expect(perRun?.getAttribute("placeholder")).toBe("20 (default)");
    expect(root.querySelector('[data-key="pool-spawnsPerRun"]')?.textContent).toContain(
      "since this Console boot",
    );
    // They reload at the next boundary: never badged for a Restart.
    expect(root.querySelector('[data-key="pool-spawnsPerAttempt"] .settings-badge')).toBeNull();
    expect(root.querySelector('[data-key="pool-spawnsPerRun"] .settings-badge')).toBeNull();
  });

  it("gives the body its own scroll region, keyed so the scroll survives", async () => {
    const rig = await opened();
    const { root, paint } = mount(rig.store);
    paint();
    const body = root.querySelector('[data-key="settings-body"]');
    expect(body).not.toBeNull();
    paint();
    expect(root.querySelector('[data-key="settings-body"]')).toBe(body);
  });

  it("selects the config's harness against the options the read brought", async () => {
    const rig = await opened();
    const { root, paint } = mount(rig.store);
    paint();
    const select = root.querySelector<HTMLSelectElement>(".settings-select");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("claude");
  });

  it("keeps a harness the engine no longer knows rather than silently repicking", async () => {
    const config = settings();
    config.pool.config.defaults = { harness: "retired-harness" };
    const rig = await opened(config);
    const { root, paint } = mount(rig.store);
    paint();
    const select = root.querySelector<HTMLSelectElement>(".settings-select");
    expect(select!.value).toBe("retired-harness");
  });

  it("badges a boot-only field in the form itself", async () => {
    const moved = settings();
    moved.pool.config.port = 4400;
    moved.pool.effective.stale = ["port"];
    const rig = await opened(moved);
    const { root, paint } = mount(rig.store);
    paint();
    const field = root.querySelector('[data-key="pool-port"]');
    expect(field?.querySelector(".settings-badge")?.textContent).toBe(
      "restart to apply",
    );
  });

  it("offers the Restart control in the footer, armed inline like Stop", async () => {
    const rig = await opened();
    const { root, paint } = mount(rig.store);
    paint();
    expect(root.querySelector(".settings-restart-server")?.textContent).toBe(
      "Restart server",
    );
    const armed = root.querySelector(".settings-foot");
    expect(armed?.textContent).not.toContain("Really restart?");
  });
});

describe("the footer's Stop control (ADR-0039)", () => {
  const RESTART: RestartView = { offered: true, state: "idle", failure: null, waiting: false };

  async function mountStop(stop: Partial<StopView>) {
    const rig = await opened();
    const intents: string[] = [];
    const root = document.createElement("div");
    document.body.appendChild(root);
    commit(root, () => {
      const shell = document.createElement("div");
      shell.appendChild(
        rig.store.render(
          RESTART,
          { ...IDLE_STOP, ...stop },
          {
            ...FOOT_HANDLERS,
            onArmStop: () => intents.push("arm"),
            onCancelStop: () => intents.push("cancel"),
            onConfirmStop: () => intents.push("confirm"),
          },
        )!,
      );
      return shell;
    });
    return { foot: root.querySelector<HTMLElement>(".settings-foot")!, intents };
  }

  it("sits first in the footer, ahead of Restart, and arms on a click", async () => {
    const { foot, intents } = await mountStop({});
    const [stop, restart] = [...foot.children];
    expect(stop?.getAttribute("data-key")).toBe("settings-stop");
    expect(restart?.getAttribute("data-key")).toBe("settings-restart");
    const button = foot.querySelector<HTMLButtonElement>(".settings-stop-server")!;
    expect(button.textContent).toBe("Stop server");
    button.click();
    expect(intents).toEqual(["arm"]);
  });

  it("asks the session's prompt inline, then confirms or cancels", async () => {
    const prompt =
      "Stop server? 3 Tickets and 1 Conversation keep running in herdr; relaunching picks them up.";
    const { foot, intents } = await mountStop({ state: "armed", prompt });
    expect(foot.querySelector(".settings-stop-prompt")?.textContent).toBe(prompt);
    const [confirm, cancel] = [...foot.querySelectorAll<HTMLButtonElement>(".settings-stop button")];
    expect(confirm!.textContent).toBe("Stop");
    confirm!.click();
    cancel!.click();
    expect(intents).toEqual(["confirm", "cancel"]);
  });

  it("disables itself while the request is out, and shows a refusal beside the button", async () => {
    const requesting = await mountStop({ state: "requesting" });
    const button = requesting.foot.querySelector<HTMLButtonElement>(".settings-stop button")!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("stopping...");
    const refused = await mountStop({ failure: "socket closed" });
    expect(refused.foot.querySelector(".settings-stop-failure")?.textContent).toBe("socket closed");
  });

  it("is hidden while not offered, leaving the footer to Restart", async () => {
    const { foot } = await mountStop({ offered: false });
    expect(foot.querySelector(".settings-stop")).toBeNull();
    expect(foot.querySelector(".settings-restart-server")).not.toBeNull();
  });
});

describe("the Steward entry (ADR-0030)", () => {
  it("seeds the budget and the Assignment from the file, absent as empty", () => {
    const draft = poolDraftFrom({
      steward: { budget: 3, assign: { harness: "claude", model: "opus", effort: "high" } },
    });
    expect(draft.stewardBudget).toBe("3");
    expect(draft.stewardHarness).toBe("claude");
    expect(draft.stewardModel).toBe("opus");
    expect(draft.stewardEffort).toBe("high");
    expect(draft.stewardDrivers).toBe("");
    expect(EMPTY.stewardBudget).toBe("");
    expect(EMPTY.stewardHarness).toBe("");
  });

  it("sends the entry whole, the budget as a number and an emptied one as null", () => {
    expect(
      poolPatchFrom({ ...EMPTY, stewardBudget: " 7 ", stewardModel: " opus " }).steward,
    ).toEqual({
      budget: 7,
      assign: { harness: "", model: "opus", effort: "", drivers: "" },
    });
    expect(poolPatchFrom(EMPTY).steward).toEqual({
      budget: null,
      assign: { harness: "", model: "", effort: "", drivers: "" },
    });
  });

  it("refuses a budget that is not a whole number of 1 or more, and takes empty as the default", () => {
    for (const budget of ["0", "-1", "2.5", "lots"]) {
      expect(validatePoolDraft({ ...EMPTY, stewardBudget: budget })).toMatch(
        /Steward budget must be a whole number of 1 or more/,
      );
    }
    expect(validatePoolDraft({ ...EMPTY, stewardBudget: "" })).toBeNull();
    expect(validatePoolDraft({ ...EMPTY, stewardBudget: "5" })).toBeNull();
  });

  it("saves through the pool form: dirty on an edit, re-seeded from the answer", async () => {
    const rig = await opened();
    rig.store.setPoolField("stewardBudget", "3");
    rig.store.setPoolField("stewardHarness", "opencode");
    expect(rig.store.poolDirty).toBe(true);
    const save = rig.store.savePool();
    expect(rig.poolSaves[0]!.config.steward).toEqual({
      budget: 3,
      assign: { harness: "opencode", model: "", effort: "", drivers: "" },
    });
    const saved = settings();
    saved.pool.config.steward = { budget: 3, assign: { harness: "opencode" } };
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.poolField("stewardBudget")).toBe("3");
  });

  it("refuses a bad budget on the spot, sending nothing", async () => {
    const rig = await opened();
    rig.store.setPoolField("stewardBudget", "0");
    await rig.store.savePool();
    expect(rig.poolSaves).toHaveLength(0);
    expect(rig.store.poolFailure).toMatch(/Steward budget/);
  });

  it("draws the budget and the Assignment, keyed, with the defaults they fall to", async () => {
    const rig = await opened();
    const root = document.createElement("div");
    document.body.appendChild(root);
    commit(root, () => {
      const shell = document.createElement("div");
      shell.appendChild(
        rig.store.render(
          { offered: true, state: "idle", failure: null, waiting: false },
          IDLE_STOP,
          FOOT_HANDLERS,
        )!,
      );
      return shell;
    });
    const budget = root.querySelector<HTMLInputElement>('[data-key="pool-stewardBudget-input"]');
    expect(budget?.placeholder).toBe("5 (default)");
    expect(root.querySelector('[data-key="pool-stewardModel"]')).not.toBeNull();
    expect(root.querySelector('[data-key="pool-steward-effort"]')).not.toBeNull();
    expect(root.querySelector('[data-key="pool-stewardDrivers"]')).not.toBeNull();
    expect(root.querySelector('[data-key="pool-steward"] select')).not.toBeNull();
  });
});

describe("Steward may Close checkpoints (issue #154)", () => {
  it("seeds the toggle from the file, off when absent", () => {
    expect(poolDraftFrom({ steward: { mayClose: true } }).stewardMayClose).toBe(true);
    expect(poolDraftFrom({ steward: { budget: 3 } }).stewardMayClose).toBe(false);
    expect(EMPTY.stewardMayClose).toBe(false);
  });

  it("sends mayClose inside the whole steward entry when on, and leaves it out when off", () => {
    expect(poolPatchFrom({ ...EMPTY, stewardBudget: "3", stewardMayClose: true }).steward).toEqual({
      budget: 3,
      assign: { harness: "", model: "", effort: "", drivers: "" },
      mayClose: true,
    });
    expect(poolPatchFrom(EMPTY).steward).not.toHaveProperty("mayClose");
  });

  it("dirties the pool form, saves, and re-seeds from the answer", async () => {
    const rig = await opened();
    const before = rig.changes();
    rig.store.setStewardMayClose(true);
    expect(rig.changes()).toBe(before + 1);
    expect(rig.store.poolDirty).toBe(true);
    const save = rig.store.savePool();
    expect(rig.poolSaves[0]!.config.steward?.mayClose).toBe(true);
    const saved = settings();
    saved.pool.config.steward = { mayClose: true };
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.stewardMayClose).toBe(true);
    rig.store.setStewardMayClose(false);
    expect(rig.store.poolDirty).toBe(true);
  });

  it("draws the toggle beside the Steward fields and flips it from the checkbox", async () => {
    const rig = await opened();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.appendChild(
          rig.store.render(
            { offered: true, state: "idle", failure: null, waiting: false },
            IDLE_STOP,
            FOOT_HANDLERS,
          )!,
        );
        return shell;
      });
    paint();
    const box = root.querySelector<HTMLInputElement>('[data-key="pool-stewardMayClose-input"]')!;
    expect(box.checked).toBe(false);
    expect(box.closest('[data-key="pool-stewardMayClose"]')?.textContent).toContain(
      "Steward may Close checkpoints",
    );
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    paint();
    expect(rig.store.stewardMayClose).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-key="pool-stewardMayClose-input"]')).toBe(box);
    expect(box.checked).toBe(true);
  });
});

describe("Steward may adopt Line spawns (#187, ADR-0037)", () => {
  it("seeds the toggle from the file, off when absent", () => {
    expect(poolDraftFrom({ steward: { mayAdoptLineSpawns: true } }).stewardMayAdoptLineSpawns).toBe(true);
    expect(poolDraftFrom({ steward: { mayClose: true } }).stewardMayAdoptLineSpawns).toBe(false);
    expect(EMPTY.stewardMayAdoptLineSpawns).toBe(false);
  });

  it("sends mayAdoptLineSpawns inside the whole steward entry when on, and leaves it out when off", () => {
    expect(
      poolPatchFrom({ ...EMPTY, stewardBudget: "3", stewardMayAdoptLineSpawns: true }).steward,
    ).toEqual({
      budget: 3,
      assign: { harness: "", model: "", effort: "", drivers: "" },
      mayAdoptLineSpawns: true,
    });
    expect(poolPatchFrom(EMPTY).steward).not.toHaveProperty("mayAdoptLineSpawns");
  });

  it("dirties the pool form, saves, and re-seeds from the answer", async () => {
    const rig = await opened();
    const before = rig.changes();
    rig.store.setStewardMayAdoptLineSpawns(true);
    expect(rig.changes()).toBe(before + 1);
    expect(rig.store.poolDirty).toBe(true);
    const save = rig.store.savePool();
    expect(rig.poolSaves[0]!.config.steward?.mayAdoptLineSpawns).toBe(true);
    expect(rig.poolSaves[0]!.config.steward).not.toHaveProperty("mayClose");
    const saved = settings();
    saved.pool.config.steward = { mayAdoptLineSpawns: true };
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.stewardMayAdoptLineSpawns).toBe(true);
    rig.store.setStewardMayAdoptLineSpawns(false);
    expect(rig.store.poolDirty).toBe(true);
  });

  it("draws the toggle under Steward may Close checkpoints and flips it from the checkbox", async () => {
    const rig = await opened();
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.appendChild(
          rig.store.render(
            { offered: true, state: "idle", failure: null, waiting: false },
            IDLE_STOP,
            FOOT_HANDLERS,
          )!,
        );
        return shell;
      });
    paint();
    const field = root.querySelector('[data-key="pool-stewardMayAdoptLineSpawns"]')!;
    expect(field.previousElementSibling?.getAttribute("data-key")).toBe("pool-stewardMayClose");
    expect(field.textContent).toContain("Steward may adopt Line spawns");
    expect(field.querySelector(".settings-hint")?.textContent).toContain(
      "Held spawn proposed from inside the Line",
    );
    const box = root.querySelector<HTMLInputElement>(
      '[data-key="pool-stewardMayAdoptLineSpawns-input"]',
    )!;
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    paint();
    expect(rig.store.stewardMayAdoptLineSpawns).toBe(true);
    expect(rig.store.stewardMayClose).toBe(false);
    expect(
      root.querySelector<HTMLInputElement>('[data-key="pool-stewardMayAdoptLineSpawns-input"]'),
    ).toBe(box);
    expect(box.checked).toBe(true);
  });
});

describe("the Factory settings (issue #187)", () => {
  function withFactory(): SettingsResponse {
    const response = settings();
    response.pool.config.factory = { stations: { review: { enabled: false } }, limits: { extraRounds: 0 } };
    response.machine.own = { harness: "claude", factory: { stations: { implement: { assign: { model: "sonnet" } } }, finish: "draft-pr" } };
    response.machine.defaults = { ...response.machine.defaults, factory: response.machine.own.factory };
    return response;
  }

  function painted(rig: Awaited<ReturnType<typeof opened>>): HTMLElement {
    const root = document.createElement("div");
    document.body.appendChild(root);
    commit(root, () => {
      const shell = document.createElement("div");
      shell.appendChild(
        rig.store.render(
          { offered: true, state: "idle", failure: null, waiting: false },
          IDLE_STOP,
          FOOT_HANDLERS,
        )!,
      );
      return shell;
    });
    return root;
  }

  it("seeds each form's layer from its own file", async () => {
    const rig = await opened(withFactory());
    expect(rig.store.factoryField("pool", "review.enabled")).toBe("off");
    expect(rig.store.factoryField("pool", "extraRounds")).toBe("0");
    expect(rig.store.factoryField("pool", "implement.model")).toBe("");
    expect(rig.store.factoryField("machine", "implement.model")).toBe("sonnet");
    expect(rig.store.factoryField("machine", "finish")).toBe("draft-pr");
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.machineDirty).toBe(false);
  });

  it("saves the pool's layer whole with the pool form, null once emptied", async () => {
    const rig = await opened(withFactory());
    rig.store.setFactoryField("pool", "prove.drivers", "my-verify --cli");
    expect(rig.store.poolDirty).toBe(true);
    expect(rig.store.machineDirty).toBe(false);
    const save = rig.store.savePool();
    expect(rig.poolSaves[0]!.config.factory).toEqual({
      stations: { prove: { drivers: "my-verify --cli" }, review: { enabled: false } },
      limits: { extraRounds: 0 },
    });
    const saved = withFactory();
    saved.pool.config.factory = rig.poolSaves[0]!.config.factory!;
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.poolDirty).toBe(false);
    expect(rig.store.factoryField("pool", "prove.drivers")).toBe("my-verify --cli");

    rig.store.setFactoryField("pool", "prove.drivers", "");
    rig.store.setFactoryField("pool", "review.enabled", "");
    rig.store.setFactoryField("pool", "extraRounds", "");
    void rig.store.savePool();
    expect(rig.poolSaves[1]!.config.factory).toBeNull();
  });

  it("saves the machine's layer with the machine defaults, left out when empty", async () => {
    const rig = await opened(withFactory());
    rig.store.setFactoryField("machine", "decide.note", "write the report in plain words");
    expect(rig.store.machineDirty).toBe(true);
    void rig.store.saveMachine();
    expect(rig.machineSaves[0]!.defaults).toEqual({
      harness: "claude",
      factory: {
        stations: {
          implement: { assign: { model: "sonnet" } },
          decide: { note: "write the report in plain words" },
        },
        finish: "draft-pr",
      },
    });
    const bare = await opened(settings());
    void bare.store.saveMachine();
    expect(bare.machineSaves[0]!.defaults).toEqual({ harness: "claude" });
  });

  it("refuses a limit that is not a whole number on the spot, sending nothing", async () => {
    const rig = await opened(withFactory());
    rig.store.setFactoryField("pool", "proveFailsPerRound", "two");
    await rig.store.savePool();
    expect(rig.poolSaves).toHaveLength(0);
    expect(rig.store.poolFailure).toMatch(/Prove fails per Round/);
    rig.store.setFactoryField("machine", "extraRounds", "-1");
    await rig.store.saveMachine();
    expect(rig.machineSaves).toHaveLength(0);
    expect(rig.store.machineFailure).toMatch(/extra Rounds/);
  });

  it("draws every Station keyed in both forms, the pool's placeholders inheriting the machine's layer", async () => {
    const rig = await opened(withFactory());
    const root = painted(rig);
    for (const form of ["pool", "machine"]) {
      for (const station of ["implement", "prove", "review", "decide", "grill"]) {
        expect(root.querySelector(`[data-key="${form}-factory-${station}.drivers"]`)).not.toBeNull();
        expect(root.querySelector(`[data-key="${form}-factory-${station}.note"]`)).not.toBeNull();
      }
      // Only Prove and Review can be switched off.
      expect(root.querySelector(`[data-key="${form}-factory-prove.enabled"]`)).not.toBeNull();
      expect(root.querySelector(`[data-key="${form}-factory-review.enabled"]`)).not.toBeNull();
      expect(root.querySelector(`[data-key="${form}-factory-implement.enabled"]`)).toBeNull();
    }
    const placeholder = (key: string) =>
      root.querySelector<HTMLInputElement>(`[data-key="${key}"]`)?.getAttribute("placeholder");
    expect(placeholder("pool-factory-implement.model")).toBe("model (sonnet)");
    expect(placeholder("machine-factory-implement.model")).toBe("model (opus)");
    expect(placeholder("pool-factory-finish-input")).toBe("draft-pr");
    expect(placeholder("machine-factory-finish-input")).toBe("none");
    expect(placeholder("pool-factory-extraRounds-input")).toBe("1 (inherited)");
    expect(root.querySelector<HTMLSelectElement>('[data-key="pool-factory-review.enabled"]')?.value).toBe("off");
  });

  it("enables Save as the operator types a factory field, and disables it on a revert (issue #142)", async () => {
    let paint = () => {};
    const rig = await opened(withFactory(), () => paint());
    const root = document.createElement("div");
    document.body.appendChild(root);
    paint = () =>
      commit(root, () => {
        const shell = document.createElement("div");
        shell.appendChild(
          rig.store.render(
            { offered: true, state: "idle", failure: null, waiting: false },
            IDLE_STOP,
            FOOT_HANDLERS,
          )!,
        );
        return shell;
      });
    paint();
    const button = (which: string) =>
      root.querySelector<HTMLButtonElement>(`[data-key="settings-save-${which}"] .settings-save`)!;
    for (const [which, key, value, saved] of [
      ["pool", "pool-factory-implement.drivers", "tdd", ""],
      ["pool", "pool-factory-extraRounds-input", "2", "0"],
      ["machine", "machine-factory-decide.note", "short", ""],
      ["machine", "machine-factory-finish-input", "pr", "draft-pr"],
    ] as const) {
      expect(button(which).disabled).toBe(true);
      const input = root.querySelector<HTMLInputElement>(`[data-key="${key}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(button(which).disabled).toBe(false);
      const again = root.querySelector<HTMLInputElement>(`[data-key="${key}"]`)!;
      again.value = saved;
      again.dispatchEvent(new Event("input", { bubbles: true }));
      expect(button(which).disabled).toBe(true);
    }
  });
});
