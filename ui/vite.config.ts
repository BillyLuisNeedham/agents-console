import { defineConfig } from "vite";

// PROTOTYPE (issue #29, throwaway): to point this dev server at a pool
// server running elsewhere (the ?termproto=1 prototype demo), run it with
// POOL_TARGET set, e.g. `POOL_TARGET=http://localhost:8794 bun run dev`.
// With the variable unset no proxy is installed; revert when the prototype
// is thrown away.
const POOL_TARGET = process.env.POOL_TARGET;

export default defineConfig({
  server: {
    port: 5173,
    proxy: POOL_TARGET
      ? {
          "/api": {
            target: POOL_TARGET,
            changeOrigin: true,
          },
        }
      : undefined,
  },
});
