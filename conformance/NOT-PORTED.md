# Not ported to conformance

Rows of the Rust port inventory (`docs/research/rust-port/test-inventory.md`) that have no passing case
under `bun run conformance --server bun`, each with the reason and the Rust unit test it implies, and
the inventory's "visible behaviour no test covers yet" entries a conformance ticket left as gaps. One
section per conformance ticket.

## `herdr`: the Pool workspace, tabs and the RPC client (C14)

Every one of the 37 visible rows has a passing case, in `cases/herdr-workspace.test.ts` and
`cases/herdr-tabs.test.ts`. Of the three rows the inventory marks with a seam:

- `engine.test.ts:6047` (a workspace closed mid-run) needs no seam: the case closes the launch workspace
  before it writes 01's outcome, which is always before 02's `tab.create`.
- `engine.test.ts:6123` (concurrent spawns both refused) uses a new fake herdr control,
  `removeWorkspaceOn(method, workspaceId)`, which closes the workspace as the next call of that method
  arrives.
- `herdr.test.ts:66` (one request per connection) uses the connection number the fake herdr now reports
  with each call, and its `openConnections` control.

Gaps from the inventory's `herdr` list:

- Taken as cases: the workspace that cannot be re-resolved after a refused tab (`engine.ts:3111`), the
  socket under `HOME/.config/herdr/herdr.sock` when `HERDR_SOCKET_PATH` is unset or blank
  (`herdr.ts:48`), the boot line `Pool workspace w1 created for this pool's tabs`, the launch and
  not-created workspaces never relabelled, and `pane.focus` never answered (a real 10 s wait, its case
  named slow).
- Partly taken: the title change for the launch and not-created workspaces is made through
  `PUT /api/settings/pool`, not by editing `console.json` by hand. The Bun server reads a hand-edited
  title only when it next enriches a snapshot (`server.ts` `titleNow`), and nothing a case can do from
  outside makes that happen within a bound. Rust unit test: *server: a Pool title read from
  console.json at any snapshot is handed to the run's relabel exactly once per change, whether it came
  from a Settings save or a hand edit.*
- Left to C15, whose rows they sit beside: the bulk close when `pane.list` fails, the bulk close itself
  and its refused `tab.close`, and Peek of a pane no Turn loop watches.
