#!/usr/bin/env bun
/**
 * PROTOTYPE — throwaway. Build the harness and serve the Stop button
 * prototype page until Ctrl-C.
 *
 *   cd ui && ~/.bun/bin/bun harness/prototype-stop.ts     # or: bun run prototype:stop
 *
 * Env: PORT (default 5199).
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const ui = join(here, "..");
const dist = join(here, "dist");
const port = Number(process.env.PORT ?? 5199);

const build = Bun.spawnSync(
  [join(ui, "node_modules/.bin/vite"), "build", "--config", join(here, "vite.config.ts")],
  { cwd: ui, stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === "/" ? "prototype-stop.html" : path));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

const base = `http://127.0.0.1:${port}/`;
console.log(`Stop button prototype on ${base}?variant=A`);
console.log(`  ←/→ or the yellow switcher cycle A/B/C; &phase=done for the done look;`);
console.log(`  &demo=armed opens the confirm; &open=settings opens the Settings pane.  Ctrl-C to stop.`);
