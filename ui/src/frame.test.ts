/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import { RenderLoop } from "./frame";

// The frame is injected, so a test decides when "the next frame" comes.
function manualFrames(): { frame: (cb: () => void) => void; run: () => void; waiting: () => number } {
  let queue: (() => void)[] = [];
  return {
    frame: (cb) => {
      queue.push(cb);
    },
    run: () => {
      const due = queue;
      queue = [];
      for (const cb of due) cb();
    },
    waiting: () => queue.length,
  };
}

describe("RenderLoop", () => {
  it("folds every ask before the frame into one render", () => {
    const frames = manualFrames();
    let renders = 0;
    const loop = new RenderLoop(() => {
      renders += 1;
    }, frames.frame);
    for (let i = 0; i < 25; i++) loop.request();
    expect(renders).toBe(0);
    expect(frames.waiting()).toBe(1);
    frames.run();
    expect(renders).toBe(1);
  });

  it("asks again after a frame render a frame later", () => {
    const frames = manualFrames();
    let renders = 0;
    const loop = new RenderLoop(() => {
      renders += 1;
    }, frames.frame);
    loop.request();
    frames.run();
    loop.request();
    loop.request();
    frames.run();
    expect(renders).toBe(2);
  });

  it("flushes a waiting render at once, and the frame then has nothing to do", () => {
    const frames = manualFrames();
    let renders = 0;
    const loop = new RenderLoop(() => {
      renders += 1;
    }, frames.frame);
    loop.flush();
    expect(renders).toBe(0);
    loop.request();
    loop.flush();
    expect(renders).toBe(1);
    frames.run();
    expect(renders).toBe(1);
  });

  it("an ask made during a render lands in the next frame", () => {
    const frames = manualFrames();
    let renders = 0;
    const loop: RenderLoop = new RenderLoop(() => {
      renders += 1;
      if (renders === 1) loop.request();
    }, frames.frame);
    loop.request();
    frames.run();
    expect(renders).toBe(1);
    frames.run();
    expect(renders).toBe(2);
  });

  it("a render that throws does not wedge the loop", () => {
    const frames = manualFrames();
    let renders = 0;
    const loop = new RenderLoop(() => {
      renders += 1;
      if (renders === 1) throw new Error("boom");
    }, frames.frame);
    loop.request();
    expect(() => frames.run()).toThrow("boom");
    loop.request();
    frames.run();
    expect(renders).toBe(2);
  });
});
