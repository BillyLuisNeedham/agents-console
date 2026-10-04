/**
 * The lag bench page's Vite config: a root of its own whose `@console`
 * alias points at the checkout under test, so one page measures this
 * checkout or any other. `ui-bench.ts` runs the target checkout's own Vite
 * with this config and sets BENCH_REPO and BENCH_OUT. A plain object rather
 * than `defineConfig`: this file sits outside every node_modules tree that
 * holds vite, so importing it would not resolve.
 *
 * `@bench/page` is the page itself: bench.ts, which drives the Console
 * through createConsole over a fake socket, for a checkout that speaks the
 * push protocol (it has ui/src/console.ts, issue #161), and bench-sse.ts,
 * which fakes the old fetch and stream seams, for one from before it.
 * `@engine` is the checkout's engine, whose protocol types the fake socket
 * builds its frames to, and `@protocol` the protocol code it builds them
 * with: ui/src/protocol.ts, or engine/protocol.ts in a checkout from before
 * that code left the engine (issue #162). Either way the frames are the ones
 * that checkout's Console reads.
 *
 * `@bench/frame` and `@bench/poll` are the checkout's render loop and
 * background request cap (issue #157) when it has them, and the unbatched
 * wiring of the checkouts before them when it does not (unbatched.ts); only
 * bench-sse.ts imports them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = process.env.BENCH_REPO ?? join(here, "../../..");
const own = (file: string) =>
  existsSync(join(repo, "ui/src", file)) ? join(repo, "ui/src", file) : join(here, "unbatched.ts");
const pushProtocol = existsSync(join(repo, "ui/src/console.ts"));
const protocolCode = existsSync(join(repo, "ui/src/protocol.ts"))
  ? join(repo, "ui/src/protocol.ts")
  : join(repo, "engine/protocol.ts");

export default {
  root: here,
  base: "./",
  logLevel: "warn",
  resolve: {
    alias: {
      "@console": join(repo, "ui/src"),
      "@engine": join(repo, "engine"),
      "@protocol": protocolCode,
      "@bench/page": join(here, pushProtocol ? "bench.ts" : "bench-sse.ts"),
      "@bench/frame": own("frame.ts"),
      "@bench/poll": own("poll.ts"),
    },
  },
  build: {
    outDir: process.env.BENCH_OUT ?? join(here, "dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
};
