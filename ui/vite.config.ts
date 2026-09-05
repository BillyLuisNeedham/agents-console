import { defineConfig } from "vite";

// PROTOTYPE (issue #29, throwaway): the UI talks to the pool server
// same-origin (PoolClient base ""), so to point this worktree's dev server at
// the scratch pool running in another worktree (port 8794), proxy /api there.
// Revert when the prototype is thrown away.
const POOL_TARGET = "http://localhost:8794";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: POOL_TARGET,
        changeOrigin: true,
      },
    },
  },
});
