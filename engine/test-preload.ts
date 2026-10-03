// Loaded before every test file (bunfig.toml): the engine writes into
// another tool's per-machine config, claude's `~/.claude.json`
// (claude-trust.ts, ADR-0025), and a suite that launches a claude Attempt in
// a pool worktree would otherwise seed the operator's real file. claude
// itself keeps that file under CLAUDE_CONFIG_DIR when the variable is set,
// and so does the engine, so one scratch directory here keeps every test's
// writes out of the home directory. Set unconditionally: a test run is never
// the operator's session, whatever the shell had.

import { join } from "node:path";
import { makeTempDir } from "../conformance/fixtures/tmp.ts";

process.env.CLAUDE_CONFIG_DIR = makeTempDir("claude-config-");

// The same fence for herdr: an engine or server built without a
// `herdrSocket` falls back to the default socket, which on a machine running
// herdr is the operator's live daemon. A test that forgot its fake used to
// open a real `pool-XXXXXX` workspace there on every run, and nothing ever
// closed it. Pointed at a socket that does not exist, such a test reaches no
// daemon at all and the pool falls back to headless. Set unconditionally,
// because a suite run inside a herdr pane inherits the real path.
process.env.HERDR_SOCKET_PATH = join(makeTempDir("herdr-none-"), "herdr.sock");
