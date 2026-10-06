// Loaded before every conformance file (bunfig.toml beside it), and before
// every test the root's `bun test` runs (the root bunfig.toml). The servers
// and fakes a case starts get an environment built from nothing
// (harness/world.ts), so this only fences the test process itself: anything
// it ever runs with the inherited environment reaches a scratch claude
// config and no herdr daemon, and never sees the two variables the server's
// CLI reads.

import { tmpdir } from "node:os";
import { join } from "node:path";

// Paths nothing creates: a stray write lands in a scratch directory of its
// own, and a stray connect finds no socket at all.
process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `conformance-claude-config-${process.pid}`);
process.env.HERDR_SOCKET_PATH = join(tmpdir(), `conformance-herdr-none-${process.pid}`, "herdr.sock");
delete process.env.HERDR_WORKSPACE_ID;
delete process.env.TYPESAFE_API_KEY;
