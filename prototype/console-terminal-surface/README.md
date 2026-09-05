# console-terminal-surface — surface B (embedded terminal) prototype

Throwaway prototype for issue #29: how an operator interacts with a running
Terminal-backed attempt's terminal from the Console UI. Compare two surfaces
via `?surface=a|b`. **Surface B** embeds an xterm.js terminal that reads and
writes a real herdr pane through a Bun bridge server.

## Run (one command)

```sh
bun prototype/console-terminal-surface/server.ts
```

Then open **http://localhost:5299/?surface=b** in a browser.

If no pane is set, click **Spawn fake agent**: the server calls `pane.split`
(`focus:false`, cwd = the worktree root), feeds a colourful fake-agent loop
into the new pane, and the embedded terminal attaches to it. Type into the
terminal (Enter submits a line, `Ctrl+C` interrupts) — the fake agent pauses
every 4th step with an `approve? (y/n)` prompt so input round-trips are easy
to demo. The spawned pane is left running for Billy to play with.

Switch surfaces with the pill at the bottom or the `surface` query param.

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET  | `/api/health` | `{ok:true}` |
| GET  | `/api/panes` | `{panes}` from `pane.list` (all panes) |
| POST | `/api/spawn-fake-agent` | `pane.split` + feed fake agent; body `{"cmd":"..."}` overrides the script; returns `{pane_id}` |
| GET  | `/api/terminal/read?pane_id=&lines=` | full-colour, unwrapped read (`recent_unwrapped`/ansi) → `{text, revision, truncated}` |
| GET  | `/api/peek?pane_id=&lines=` | read-only preview (`recent`/text/strip_ansi) → `{text, revision, truncated}` |
| POST | `/api/terminal/send` | `{pane_id, text?, keys?}` → `pane.send_input` → `{ok:true}` |
| POST | `/api/focus` | `{pane_id}` → `pane.focus` → `{ok:true}` |

**Safety:** `/api/terminal/send` and `/api/focus` refuse any pane id this
server instance did not itself spawn (403). Existing/live agent panes are
never written to — only read via `/api/panes` and `/api/peek`.
