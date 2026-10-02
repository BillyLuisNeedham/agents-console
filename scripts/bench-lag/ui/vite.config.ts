/**
 * The lag bench page's Vite config: a root of its own whose `@console`
 * alias points at the checkout under test, so one page measures this
 * checkout or any other. `ui-bench.ts` runs the target checkout's own Vite
 * with this config and sets BENCH_REPO and BENCH_OUT. A plain object rather
 * than `defineConfig`: this file sits outside every node_modules tree that
 * holds vite, so importing it would not resolve.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = process.env.BENCH_REPO ?? join(here, "../../..");

export default {
  root: here,
  base: "./",
  logLevel: "warn",
  resolve: { alias: { "@console": join(repo, "ui/src") } },
  build: {
    outDir: process.env.BENCH_OUT ?? join(here, "dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
  },
};
