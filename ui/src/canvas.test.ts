/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { canvasStatusText, type CanvasModel } from "./canvas";
import type { StopView } from "./view";

// The canvas header's status line, pinned as a pure function: the bun tests
// run without a DOM, so the rendering itself is out of reach, but the one
// piece of logic in the header is not.

function stop(overrides: Partial<StopView> = {}): StopView {
  return {
    offered: false,
    state: "idle",
    failure: null,
    stoppedFromHere: false,
    relaunch: null,
    ...overrides,
  };
}

function model(overrides: Partial<CanvasModel> = {}): CanvasModel {
  return {
    cards: [],
    connected: true,
    phase: "running",
    phaseLabel: "running",
    seq: 7,
    error: null,
    stop: stop(),
    terminalBacked: false,
    ...overrides,
  };
}

describe("canvasStatusText", () => {
  it("reports the phase and the snapshot number on a live stream", () => {
    expect(canvasStatusText(model())).toBe("pool · running · snapshot 7");
  });

  it("reports connecting while the stream is down", () => {
    expect(canvasStatusText(model({ connected: false }))).toBe("pool · connecting");
  });

  it("reports a stopped server whatever the connection says (issue #97)", () => {
    // The stream drops the moment after the farewell snapshot, so waiting on
    // `connected` would replace the one true thing the page knows.
    expect(canvasStatusText(model({ phase: "stopped", phaseLabel: "stopped" }))).toBe(
      "pool · stopped",
    );
    expect(
      canvasStatusText(
        model({ phase: "stopped", phaseLabel: "stopped", connected: false }),
      ),
    ).toBe("pool · stopped");
  });

  it("names the page that asked for the stop", () => {
    expect(
      canvasStatusText(
        model({
          phase: "stopped",
          phaseLabel: "stopped",
          connected: false,
          stop: stop({ stoppedFromHere: true }),
        }),
      ),
    ).toBe("pool · stopped · from this page");
  });
});
