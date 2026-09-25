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
import type { RestartView } from "./view";
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
        roster: "two engineers",
      },
      bootOnly: ["roster", "agents", "selection", "terminal", "port"],
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
    expect(draft.agents).toBe("");
  });

  it("splits the resolver's object form across its two fields", () => {
    const draft = poolDraftFrom({ resolver: { harness: "opencode", model: "sonnet" } });
    expect(draft.resolverHarness).toBe("opencode");
    expect(draft.resolverModel).toBe("sonnet");
  });

  it("reads a terminal-backed pool's checkbox as ticked", () => {
    expect(poolDraftFrom({ terminal: "herdr" }).terminal).toBe(true);
  });

  it("seeds the Pool title, and an untitled pool as an empty field (issue #100)", () => {
    expect(poolDraftFrom({ title: "Jev as the grader" }).title).toBe("Jev as the grader");
    expect(EMPTY.title).toBe("");
  });
});

describe("poolPatchFrom", () => {
  it("sends an emptied field as null so the engine removes the key", () => {
    const patch = poolPatchFrom(EMPTY);
    expect(patch.port).toBeNull();
    expect(patch.terminal).toBeNull();
    expect(patch.selection).toBeNull();
    expect(patch.roster).toBeNull();
    expect(patch.resolver).toBeNull();
    expect(patch.defaults).toEqual({ harness: "", model: "", drivers: "" });
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

  it("passes `none` through as the opt-out string", () => {
    expect(poolPatchFrom({ ...EMPTY, resolverHarness: "none" }).resolver).toBe("none");
  });

  it("sends the Pool title trimmed, and an emptied one as null (issue #100)", () => {
    expect(poolPatchFrom({ ...EMPTY, title: "  Jev as the grader " }).title).toBe(
      "Jev as the grader",
    );
    expect(poolPatchFrom(EMPTY).title).toBeNull();
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

  it("refuses an agents roster that is not JSON", () => {
    expect(validatePoolDraft({ ...EMPTY, agents: "{oops" })).toBe(
      "agents must be valid JSON",
    );
    expect(validatePoolDraft({ ...EMPTY, agents: '{"a":1}' })).toBeNull();
  });
});

describe("machineDefaultsFrom", () => {
  it("leaves every emptied field out rather than writing a blank", () => {
    expect(
      machineDefaultsFrom({
        harness: "",
        model: "",
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
        drivers: " implement ",
        terminal: true,
        engine: "/repo/engine",
      }),
    ).toEqual({
      harness: "claude",
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
    expect([...projectRestartBadges(["port", "roster"])].sort()).toEqual([
      "port",
      "roster",
    ]);
  });

  it("drops a key outside the badge vocabulary rather than trusting the wire", () => {
    // `stale` is a list of plain strings; a key the pane has no field for
    // would badge nothing anyway, so it never reaches the lookup.
    expect([...projectRestartBadges(["port", "assign", "defaults"])]).toEqual(["port"]);
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
    rig.store.setPoolField("roster", "two engineers ");
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
    rig.store.setPoolField("roster", "three engineers");
    const save = rig.store.savePool();
    const saved = settings();
    saved.pool.config.roster = "three engineers";
    saved.pool.effective.stale = ["roster"];
    rig.poolSaves[0]!.deferred.resolve(saved);
    await save;
    expect(rig.store.badges().has("roster")).toBe(true);
  });

  it("badges a key a save never touched, so a hand edit or another tab shows", async () => {
    // The engine derives `stale` from the file against what it booted with,
    // so a pool whose config was edited outside this page badges on the very
    // first read, with no save in this session to have noticed it.
    const edited = settings();
    edited.pool.effective.stale = ["agents", "terminal"];
    const rig = await opened(edited);
    expect([...rig.store.badges()].sort()).toEqual(["agents", "terminal"]);
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
  const HANDLERS = {
    onArmRestart: () => {},
    onCancelRestart: () => {},
    onConfirmRestart: () => {},
  };

  function mount(store: SettingsStore): { root: HTMLElement; paint(): void } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const paint = () =>
      commit(root, () => {
        const pane = store.render(RESTART, HANDLERS);
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
