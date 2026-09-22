// Loaded before every test file (bunfig.toml): the engine writes into
// another tool's per-machine config, claude's `~/.claude.json`
// (claude-trust.ts, ADR-0025), and a suite that launches a claude Attempt in
// a pool worktree would otherwise seed the operator's real file. claude
// itself keeps that file under CLAUDE_CONFIG_DIR when the variable is set,
// and so does the engine, so one scratch directory here keeps every test's
// writes out of the home directory. Set unconditionally: a test run is never
// the operator's session, whatever the shell had.

import { makeTempDir } from "./tmp.ts";

process.env.CLAUDE_CONFIG_DIR = makeTempDir("claude-config-");
