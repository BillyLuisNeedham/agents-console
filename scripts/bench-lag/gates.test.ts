import { describe, expect, test } from "bun:test";
import { evaluateGates, formatGates, frameBudget, type GateInputs } from "./gates.ts";

/** Frame times at a steady 60 Hz, `n` of them. */
const steady = (n: number, from = 1_000) => Array.from({ length: n }, (_, i) => from + i * (1000 / 60));

/** Inputs that meet every gate at the given RTT. */
function passing(rttMs = 0): GateInputs {
  return {
    rttMs,
    feedbackFrames: [1, 1, 1],
    shellFrames: [1, 1],
    coldDataMs: [rttMs + 12, rttMs + 15],
    hoverDataFrames: [1, 1],
    focusAnsweredMs: [rttMs + 2.5],
    frames: [frameBudget(steady(600)), frameBudget(steady(600))],
    idle: [
      { ms: 15_000, resources: 0, fetches: 0, socketFramesSent: 0 },
      { ms: 15_000, resources: 0, fetches: 0, socketFramesSent: 0 },
    ],
    usableMs: [140, 150],
  };
}

const gate = (inputs: GateInputs, name: string) => {
  const found = evaluateGates(inputs).find((g) => g.name === name);
  if (!found) throw new Error(`no gate ${name}`);
  return found;
};

describe("frameBudget", () => {
  test("a steady 60 Hz run has no frame over budget and measures its interval", () => {
    const budget = frameBudget(steady(300));
    expect(budget.over).toBe(0);
    expect(budget.intervalMs).toBeCloseTo(16.67, 1);
    expect(budget.frames).toBe(300);
  });

  test("one dropped frame is one over budget", () => {
    const times = steady(100);
    // Frame 50 never came: the gap before frame 51 is two intervals.
    times.splice(50, 1);
    const budget = frameBudget(times);
    expect(budget.over).toBe(1);
    expect(budget.longestGapMs).toBeCloseTo(33.3, 0);
  });

  test("vsync jitter is not a dropped frame", () => {
    const times = [0];
    for (let i = 1; i < 200; i++) times.push(times[i - 1]! + (i % 2 ? 16.6 : 16.8));
    expect(frameBudget(times).over).toBe(0);
  });

  test("a gap of 1.5 intervals already counts, so nothing that dropped a frame slips through", () => {
    const times = steady(50);
    times.push(times.at(-1)! + 25);
    expect(frameBudget(times).over).toBe(1);
  });

  test("a page that drops every other frame is not taken at its own pace", () => {
    // Mostly 33 ms gaps with some on time: the median would call 33 ms the
    // display's interval, the 10th percentile does not.
    const times = [0];
    for (let i = 1; i < 100; i++) times.push(times[i - 1]! + (i % 5 === 0 ? 1000 / 60 : 2000 / 60));
    const budget = frameBudget(times);
    expect(budget.intervalMs).toBeCloseTo(16.67, 1);
    expect(budget.over).toBeGreaterThan(70);
  });

  test("fewer than two frames measure nothing", () => {
    expect(frameBudget([5]).intervalMs).toBeNull();
    expect(frameBudget([]).intervalMs).toBeNull();
  });
});

describe("evaluateGates", () => {
  test("inputs on target pass every gate, in the issue's order", () => {
    const results = evaluateGates(passing());
    expect(results.map((r) => r.name)).toEqual([
      "Press feedback",
      "Click -> Detail",
      "Click -> card data (cold)",
      "Click -> card data (hovered)",
      "Open in herdr answered",
      "Frames over budget",
      "Background polling",
      "Start -> usable",
    ]);
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(evaluateGates(passing(40)).filter((r) => !r.pass)).toEqual([]);
  });

  test("a gate with no samples fails, never passing for want of evidence", () => {
    const inputs = passing();
    for (const key of ["feedbackFrames", "shellFrames", "coldDataMs", "hoverDataFrames", "focusAnsweredMs", "usableMs"] as const) {
      inputs[key] = [];
    }
    inputs.frames = [];
    inputs.idle = [];
    const results = evaluateGates(inputs);
    expect(results.filter((r) => r.pass)).toEqual([]);
    expect(results[0]!.measured).toContain("n=0");
  });

  test("a sample that never filled fails its gate", () => {
    const inputs = passing();
    inputs.shellFrames = [1, null, 1];
    const shell = gate(inputs, "Click -> Detail");
    expect(shell.pass).toBe(false);
    expect(shell.measured).toContain("1 never measured");
  });

  test("feedback, the shell and hovered data must land in the first frame", () => {
    for (const name of ["Press feedback", "Click -> Detail", "Click -> card data (hovered)"]) {
      const inputs = passing();
      inputs.feedbackFrames = name === "Press feedback" ? [1, 2] : inputs.feedbackFrames;
      inputs.shellFrames = name === "Click -> Detail" ? [1, 2] : inputs.shellFrames;
      inputs.hoverDataFrames = name === "Click -> card data (hovered)" ? [2] : inputs.hoverDataFrames;
      expect(gate(inputs, name).pass).toBe(false);
    }
  });

  test("cold data is under 20 ms at RTT 0, and at most RTT + 20 ms otherwise", () => {
    const at0 = passing(0);
    at0.coldDataMs = [19.9];
    expect(gate(at0, "Click -> card data (cold)").pass).toBe(true);
    at0.coldDataMs = [20];
    expect(gate(at0, "Click -> card data (cold)").pass).toBe(false);

    const at40 = passing(40);
    at40.coldDataMs = [60];
    expect(gate(at40, "Click -> card data (cold)").pass).toBe(true);
    at40.coldDataMs = [12, 60.1];
    const cold = gate(at40, "Click -> card data (cold)");
    expect(cold.pass).toBe(false);
    expect(cold.target).toContain("60 ms");
    expect(cold.measured).toContain("1 over");
  });

  test("Open in herdr is answered under 5 ms, plus the RTT when there is one", () => {
    const at0 = passing(0);
    at0.focusAnsweredMs = [5];
    expect(gate(at0, "Open in herdr answered").pass).toBe(false);
    const at40 = passing(40);
    at40.focusAnsweredMs = [44.9];
    expect(gate(at40, "Open in herdr answered").pass).toBe(true);
    at40.focusAnsweredMs = [45];
    expect(gate(at40, "Open in herdr answered").pass).toBe(false);
  });

  test("one frame over budget in any tab fails, and so does a tab with no frames", () => {
    const dropped = steady(100);
    dropped.splice(40, 1);
    const inputs = passing();
    inputs.frames = [frameBudget(steady(100)), frameBudget(dropped)];
    expect(gate(inputs, "Frames over budget").pass).toBe(false);
    inputs.frames = [frameBudget(steady(100)), frameBudget([])];
    expect(gate(inputs, "Frames over budget").pass).toBe(false);
  });

  test("background polling: any request or sent frame, or a window under 10 s, fails", () => {
    const quiet = { ms: 15_000, resources: 0, fetches: 0, socketFramesSent: 0 };
    for (const tab of [
      { ...quiet, resources: 1 },
      { ...quiet, fetches: 1 },
      { ...quiet, socketFramesSent: 1 },
      { ...quiet, ms: 9_999 },
    ]) {
      const inputs = passing();
      inputs.idle = [quiet, tab];
      expect(gate(inputs, "Background polling").pass).toBe(false);
    }
  });

  test("start to usable is under 300 ms in every tab", () => {
    const inputs = passing();
    inputs.usableMs = [120, 300];
    expect(gate(inputs, "Start -> usable").pass).toBe(false);
    inputs.usableMs = [120, null];
    expect(gate(inputs, "Start -> usable").pass).toBe(false);
  });
});

describe("formatGates", () => {
  test("a row per gate with its verdict, and a last line that says how many failed", () => {
    const inputs = passing();
    inputs.usableMs = [400];
    const lines = formatGates(evaluateGates(inputs));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^gate\s+target\s+measured/);
    expect(lines.find((l) => l.startsWith("Start -> usable"))).toMatch(/FAIL$/);
    expect(lines.find((l) => l.startsWith("Press feedback"))).toMatch(/PASS$/);
    expect(lines.at(-1)).toBe("1 of 8 gates FAIL");
  });
});
