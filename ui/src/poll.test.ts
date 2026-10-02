/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { RequestLimiter, TargetPoller } from "./poll";

// The polls are injected promises a test settles by hand, so "in flight"
// means exactly what the test says it does.

interface Gate {
  resolve: () => void;
  reject: (err: Error) => void;
}

function gatedPoller(gapMs: number): { poller: TargetPoller; started: string[]; gates: Gate[] } {
  const started: string[] = [];
  const gates: Gate[] = [];
  const poller = new TargetPoller({
    run: (id) =>
      new Promise<void>((resolve, reject) => {
        started.push(id);
        gates.push({ resolve, reject });
      }),
    gapMs,
  });
  return { poller, started, gates };
}

async function flush(): Promise<void> {
  await Bun.sleep(0);
}

describe("TargetPoller", () => {
  it("never starts a second poll for a target whose first is still out", async () => {
    const h = gatedPoller(0);
    h.poller.poll("01");
    h.poller.poll("01");
    h.poller.poll("01");
    expect(h.started).toEqual(["01"]);
    h.gates[0]!.resolve();
    await flush();
    h.poller.poll("01");
    expect(h.started).toEqual(["01", "01"]);
    h.gates[1]!.resolve();
  });

  it("a slow target never holds up another", () => {
    const h = gatedPoller(0);
    h.poller.poll("01");
    h.poller.poll("02");
    expect(h.started).toEqual(["01", "02"]);
  });

  it("a burst of snapshot polls while one is out owes exactly one more", async () => {
    const h = gatedPoller(0);
    h.poller.pollSoon("01");
    for (let i = 0; i < 10; i++) h.poller.pollSoon("01");
    expect(h.started).toEqual(["01"]);
    h.gates[0]!.resolve();
    await flush();
    expect(h.started).toEqual(["01", "01"]);
    h.gates[1]!.resolve();
    await flush();
    expect(h.started).toEqual(["01", "01"]);
  });

  it("a snapshot poll inside the gap waits for the gap, once", async () => {
    const h = gatedPoller(30);
    h.poller.poll("01");
    h.gates[0]!.resolve();
    await flush();
    h.poller.pollSoon("01");
    h.poller.pollSoon("01");
    expect(h.started).toEqual(["01"]);
    await Bun.sleep(45);
    expect(h.started).toEqual(["01", "01"]);
    h.gates[1]!.resolve();
  });

  it("the cadence's poll serves a snapshot poll owed to the same target", async () => {
    const h = gatedPoller(30);
    h.poller.poll("01");
    h.gates[0]!.resolve();
    await flush();
    h.poller.pollSoon("01");
    h.poller.poll("01");
    expect(h.started).toEqual(["01", "01"]);
    h.gates[1]!.resolve();
    await Bun.sleep(45);
    expect(h.started).toEqual(["01", "01"]);
  });

  it("a forgotten target is owed nothing", async () => {
    const h = gatedPoller(30);
    h.poller.poll("01");
    h.gates[0]!.resolve();
    await flush();
    h.poller.pollSoon("01");
    h.poller.forget("01");
    await Bun.sleep(45);
    expect(h.started).toEqual(["01"]);
  });

  it("a failed poll frees the target for the next one", async () => {
    const h = gatedPoller(0);
    h.poller.poll("01");
    h.gates[0]!.reject(new Error("down"));
    await flush();
    h.poller.poll("01");
    expect(h.started).toEqual(["01", "01"]);
    h.gates[1]!.resolve();
  });
});

describe("RequestLimiter", () => {
  it("keeps at most max tasks out and starts the rest in order as they land", async () => {
    const limiter = new RequestLimiter(2);
    const started: number[] = [];
    const gates: (() => void)[] = [];
    const answers = [1, 2, 3, 4].map((n) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(n);
            gates.push(() => resolve(n * 10));
          }),
      ),
    );
    expect(started).toEqual([1, 2]);
    gates[1]!();
    await flush();
    expect(started).toEqual([1, 2, 3]);
    gates[0]!();
    gates[2]!();
    await flush();
    expect(started).toEqual([1, 2, 3, 4]);
    gates[3]!();
    expect(await Promise.all(answers)).toEqual([10, 20, 30, 40]);
  });

  it("passes a failure through and frees its place", async () => {
    const limiter = new RequestLimiter(1);
    const failed = limiter.run(() => Promise.reject(new Error("refused")));
    const next = limiter.run(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("refused");
    expect(await next).toBe("ok");
  });
});
