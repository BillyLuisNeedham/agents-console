/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { DEFAULT_PORT, resolvePort, validPort } from "./ports.ts";

describe("port resolution order", () => {
  it("the --port flag wins over the console.json pin", () => {
    expect(resolvePort(9001, 8788)).toEqual({ port: 9001, pinned: true });
  });

  it("the console.json pin wins over the default", () => {
    expect(resolvePort(undefined, 8788)).toEqual({ port: 8788, pinned: true });
  });

  it("neither pin falls to the default, unpinned", () => {
    expect(resolvePort(undefined, undefined)).toEqual({
      port: DEFAULT_PORT,
      pinned: false,
    });
    expect(DEFAULT_PORT).toBe(8787);
  });

  it("an explicit default overrides 8787 for the unpinned hunt", () => {
    expect(resolvePort(undefined, undefined, 9000)).toEqual({
      port: 9000,
      pinned: false,
    });
  });

  it("port 0 means any free port and is never a pin", () => {
    expect(resolvePort(0, undefined)).toEqual({ port: 0, pinned: false });
    expect(resolvePort(undefined, 0)).toEqual({ port: 0, pinned: false });
  });

  it("the flag wins over the config pin even when the flag is 0", () => {
    expect(resolvePort(0, 8788)).toEqual({ port: 0, pinned: false });
  });

  it("a pinned port stays pinned even at the default value", () => {
    expect(resolvePort(8787, undefined)).toEqual({ port: 8787, pinned: true });
  });
});

describe("port validation", () => {
  it("accepts an integer in 0-65535", () => {
    expect(validPort(0, "x")).toBe(0);
    expect(validPort(65535, "x")).toBe(65535);
  });

  it("rejects non-integers and out-of-range values", () => {
    for (const bad of [-1, 65536, 1.5, NaN, Infinity]) {
      expect(() => validPort(bad, "x")).toThrow(/0-65535/);
    }
  });
});