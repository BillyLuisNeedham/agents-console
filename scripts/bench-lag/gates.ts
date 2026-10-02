/**
 * The lag bench's gates (issue #161, ADR-0032): the speed targets the push
 * protocol was built to meet, each one a pass or a fail over what the
 * end-to-end run measured, so `bench-lag.ts --e2e` can fail a build.
 *
 * Everything here is pure: measurements in, verdicts out. Each gate takes
 * its raw samples, one per press or one per tab, and a gate holds only when
 * it has samples and every one of them meets the target. A gate with no
 * samples fails, and so does one with a sample that never filled (a press
 * that landed elsewhere or could not be made, a change that never showed):
 * nothing passes for want of evidence.
 *
 * A frame count is "frames from the press": the frame the change was
 * painted in, numbered from the last frame that had begun before the press
 * was released. 1 is the first frame after the press. Times are ms from the
 * release to the end of the rendering step of the frame that painted the
 * change (ui/probe.ts).
 */

/** A tab's frames against its display, from its rAF times. */
export interface FrameBudget {
  frames: number;
  /** The display interval measured from the gaps; null with fewer than two frames. */
  intervalMs: number | null;
  /** Frames that came at least one display interval late (see frameBudget). */
  over: number;
  /** When each of those came, on the times' own clock: where to look. */
  overAt: number[];
  longestGapMs: number;
}

/**
 * A tab's rAF times against its display. A frame is over budget when at
 * least one display refresh passed without one: the gap before it is 1.5
 * display intervals or more. rAF times are the frames' vsync times, so the
 * gaps sit at whole intervals (16.7 ms at 60 Hz, 33.3 ms after one dropped
 * frame), and half an interval is the midpoint between "on time" and "one
 * dropped"; any looser threshold would let a dropped frame through.
 *
 * The display interval is measured, not assumed: the 10th percentile of the
 * gaps, which is the refresh period as long as one frame in ten is on time.
 * The median would hide a page that drops every other frame, by taking its
 * doubled gap for the display's.
 */
export function frameBudget(times: readonly number[]): FrameBudget {
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  if (gaps.length === 0) return { frames: times.length, intervalMs: null, over: 0, overAt: [], longestGapMs: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const intervalMs = sorted[Math.floor(sorted.length * 0.1)]!;
  const overAt = gaps.flatMap((gap, i) => (gap >= 1.5 * intervalMs ? [times[i + 1]!] : []));
  return {
    frames: times.length,
    intervalMs: Math.round(intervalMs * 100) / 100,
    over: overAt.length,
    overAt,
    longestGapMs: Math.round(sorted.at(-1)! * 10) / 10,
  };
}

/** What a tab did over the idle window, its input stopped. */
export interface IdleTab {
  /** How long the window ran. */
  ms: number;
  /** HTTP resources the page started in it (Resource Timing). */
  resources: number;
  /** fetch() calls the page made in it, counted as they start. */
  fetches: number;
  /** Socket frames the page sent in it. The server's heartbeats come the other way. */
  socketFramesSent: number;
}

export interface GateInputs {
  rttMs: number;
  /** Every press, card clicks and Open in herdrs: frames to its first visible change. */
  feedbackFrames: (number | null)[];
  /** Every card click: frames to the Detail naming the card. */
  shellFrames: (number | null)[];
  /** Every cold card click on a tab with fetched content: ms to that content painted. */
  coldDataMs: (number | null)[];
  /** Every hover-prefetched card click on a tab with fetched content: frames to that content painted. */
  hoverDataFrames: (number | null)[];
  /** Every Open in herdr: ms from the press to the server's answer reaching
   *  the browser (at the network: a page's own clock sees it a frame late). */
  focusAnsweredMs: (number | null)[];
  /** Each tab, from the start of the window to the end of the idle window. */
  frames: FrameBudget[];
  /** Each tab over the idle window. */
  idle: IdleTab[];
  /** Each tab: navigation start to the first frame that painted every Ticket's card. */
  usableMs: (number | null)[];
}

export interface GateResult {
  name: string;
  target: string;
  measured: string;
  pass: boolean;
}

/** The shortest idle window the polling gate accepts. */
export const IDLE_MIN_MS = 10_000;

const round = (x: number) => Math.round(x * 10) / 10;

/** Samples against a predicate: none, or any unfilled or failing, is a fail. */
function samples(
  name: string,
  target: string,
  values: (number | null)[],
  ok: (v: number) => boolean,
  unit: "ms" | "frames",
): GateResult {
  const filled = values.filter((v): v is number => v !== null);
  const unfilled = values.length - filled.length;
  const failing = filled.filter((v) => !ok(v)).length;
  let measured: string;
  if (values.length === 0) {
    measured = "n=0: nothing measured";
  } else {
    const worst = filled.length ? Math.max(...filled) : null;
    const show = (v: number) => (unit === "ms" ? `${round(v)} ms` : `${v} frame${v === 1 ? "" : "s"}`);
    measured = [
      worst === null ? "no value" : `worst ${show(worst)}`,
      `n=${values.length}`,
      failing ? `${failing} over` : "",
      unfilled ? `${unfilled} never measured` : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  return { name, target, measured, pass: values.length > 0 && unfilled === 0 && failing === 0 };
}

/** Every gate, in the issue's order. */
export function evaluateGates(inputs: GateInputs): GateResult[] {
  const rtt = inputs.rttMs;
  const inFirstFrame = (v: number) => v <= 1;
  const coldLimit = rtt === 0 ? "< 20 ms" : `<= RTT + 20 = ${rtt + 20} ms`;
  const coldOk = (v: number) => (rtt === 0 ? v < 20 : v <= rtt + 20);
  const focusLimit = rtt === 0 ? "< 5 ms" : `< RTT + 5 = ${rtt + 5} ms`;

  const frames = (() => {
    const name = "Frames over budget";
    const target = "0 (a gap of >= 1.5 display intervals)";
    if (inputs.frames.length === 0) return { name, target, measured: "no tab measured", pass: false };
    const blind = inputs.frames.filter((f) => f.intervalMs === null).length;
    const over = inputs.frames.reduce((n, f) => n + f.over, 0);
    const count = inputs.frames.reduce((n, f) => n + f.frames, 0);
    const intervals = inputs.frames.map((f) => (f.intervalMs === null ? "none" : `${f.intervalMs}`)).join("/");
    const longest = Math.max(...inputs.frames.map((f) => f.longestGapMs));
    return {
      name,
      target,
      measured: `${over} of ${count} frames over, longest gap ${longest} ms, interval ${intervals} ms` +
        (blind ? `, ${blind} tab(s) with no frames` : ""),
      pass: blind === 0 && over === 0,
    };
  })();

  const polling = (() => {
    const name = "Background polling";
    const target = `0 HTTP, 0 sent frames over >= ${IDLE_MIN_MS / 1000} s idle`;
    if (inputs.idle.length === 0) return { name, target, measured: "no tab measured", pass: false };
    const shortest = Math.min(...inputs.idle.map((t) => t.ms));
    const resources = inputs.idle.reduce((n, t) => n + t.resources, 0);
    const fetches = inputs.idle.reduce((n, t) => n + t.fetches, 0);
    const sent = inputs.idle.reduce((n, t) => n + t.socketFramesSent, 0);
    return {
      name,
      target,
      measured: `${resources} resources, ${fetches} fetches, ${sent} frames sent over ${round(shortest / 1000)} s x ${inputs.idle.length} tabs`,
      pass: shortest >= IDLE_MIN_MS && resources === 0 && fetches === 0 && sent === 0,
    };
  })();

  return [
    samples("Press feedback", "visible change in frame 1", inputs.feedbackFrames, inFirstFrame, "frames"),
    samples("Click -> Detail", "shell painted in frame 1", inputs.shellFrames, inFirstFrame, "frames"),
    samples("Click -> card data (cold)", coldLimit, inputs.coldDataMs, coldOk, "ms"),
    samples("Click -> card data (hovered)", "painted in frame 1", inputs.hoverDataFrames, inFirstFrame, "frames"),
    samples("Open in herdr answered", focusLimit, inputs.focusAnsweredMs, (v) => v < rtt + 5, "ms"),
    frames,
    polling,
    samples("Start -> usable", "< 300 ms", inputs.usableMs, (v) => v < 300, "ms"),
  ];
}

/** The gate table, one line per gate, headed. */
export function formatGates(results: GateResult[]): string[] {
  const head: [string, string, string, string] = ["gate", "target", "measured", ""];
  const rows = results.map((r) => [r.name, r.target, r.measured, r.pass ? "PASS" : "FAIL"] as const);
  const widths = [0, 1, 2].map((i) => Math.max(head[i]!.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => (i < 3 ? c.padEnd(widths[i]!) : c)).join("  ").trimEnd();
  const failed = results.filter((r) => !r.pass).length;
  return [
    line(head),
    ...rows.map(line),
    failed === 0 ? `all ${results.length} gates pass` : `${failed} of ${results.length} gates FAIL`,
  ];
}
