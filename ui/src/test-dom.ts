/**
 * A real DOM for the tests that need one. bun's tests run without a
 * document, and most of the UI suite is happier that way (stores and pure
 * projections against hand-built fakes), so the DOM is opt-in per file:
 * `useDom()` installs happy-dom's globals before the file's tests and takes
 * them down again after. Per-file rather than a bunfig preload because the
 * root `bun test` runs the engine suite in the same process, and happy-dom
 * replaces `fetch` and the timers when it registers.
 */

import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function useDom(): void {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  });
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });
}
