/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import {
  FACTORY_DEFAULTS,
  factoryDraftFrom,
  factoryFrom,
  factoryUnder,
  sameFactoryDraft,
  validateFactoryDraft,
} from "./factory-settings";

describe("the Factory settings draft (issue #187)", () => {
  it("seeds every field from a layer, absent ones empty, enabled as on, off or inherit", () => {
    const draft = factoryDraftFrom({
      stations: {
        implement: { drivers: "tdd", assign: { model: "sonnet" }, note: "small commits" },
        prove: { enabled: false },
        review: { enabled: true },
      },
      limits: { extraRounds: 0 },
      finish: "draft-pr",
    });
    expect(draft["implement.drivers"]).toBe("tdd");
    expect(draft["implement.model"]).toBe("sonnet");
    expect(draft["implement.harness"]).toBe("");
    expect(draft["implement.note"]).toBe("small commits");
    expect(draft["prove.enabled"]).toBe("off");
    expect(draft["review.enabled"]).toBe("on");
    expect(draft.extraRounds).toBe("0");
    expect(draft.proveFailsPerRound).toBe("");
    expect(draft.finish).toBe("draft-pr");
    expect(Object.values(factoryDraftFrom(undefined)).every((value) => value === "")).toBe(true);
  });

  it("writes only what the draft sets, and null when it sets nothing", () => {
    const draft = factoryDraftFrom(undefined);
    expect(factoryFrom(draft)).toBeNull();
    draft["decide.effort"] = " low ";
    draft["review.enabled"] = "off";
    draft["grill.drivers"] = "my-grill-with-docs";
    draft.proveFailsPerRound = "3";
    draft.finish = "  ";
    expect(factoryFrom(draft)).toEqual({
      stations: {
        review: { enabled: false },
        decide: { assign: { effort: "low" } },
        grill: { drivers: "my-grill-with-docs" },
      },
      limits: { proveFailsPerRound: 3 },
    });
  });

  it("round-trips a layer through the draft", () => {
    const layer = {
      stations: { prove: { enabled: true, drivers: "my-verify", assign: { harness: "opencode", effort: "high" }, note: "run the CLI" } },
      limits: { proveFailsPerRound: 0, extraRounds: 2 },
      finish: "pr",
    };
    expect(factoryFrom(factoryDraftFrom(layer))).toEqual(layer);
  });

  it("shows what an empty field inherits: the layer below where this one is empty", () => {
    const machine = factoryDraftFrom({ stations: { implement: { assign: { model: "sonnet" } } }, finish: "draft-pr" });
    const under = factoryUnder(machine, FACTORY_DEFAULTS);
    expect(under["implement.model"]).toBe("sonnet");
    expect(under["implement.effort"]).toBe("high");
    expect(under["prove.drivers"]).toBe("my-verify");
    expect(under.finish).toBe("draft-pr");
    expect(under.extraRounds).toBe("1");
  });

  it("refuses a limit that is not a whole number of 0 or more", () => {
    const draft = factoryDraftFrom(undefined);
    expect(validateFactoryDraft(draft)).toBeNull();
    for (const bad of ["-1", "1.5", "two"]) {
      expect(validateFactoryDraft({ ...draft, extraRounds: bad })).toMatch(/extra Rounds must be a whole number/);
      expect(validateFactoryDraft({ ...draft, proveFailsPerRound: bad })).toMatch(/Prove fails per Round/);
    }
    expect(validateFactoryDraft({ ...draft, extraRounds: "0" })).toBeNull();
  });

  it("compares drafts trimmed, as they would be written", () => {
    const a = factoryDraftFrom({ finish: "pr" });
    expect(sameFactoryDraft(a, { ...a, finish: " pr " })).toBe(true);
    expect(sameFactoryDraft(a, { ...a, finish: "none" })).toBe(false);
  });
});
