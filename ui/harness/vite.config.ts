import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// The render-survival harness: a second Vite root beside the app's, so the
// page can import the real view modules from ../src without touching the
// app's own build. `bun harness/run.ts` builds it into harness/dist.
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  logLevel: "warn",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    // PROTOTYPE (throwaway): the Stop button prototype's page beside the
    // render-survival one; `bun harness/prototype-stop.ts` serves it.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        "prototype-stop": fileURLToPath(new URL("./prototype-stop.html", import.meta.url)),
      },
    },
  },
});
