# Conformance

The server's black-box suite (ADR-0036). Each case starts a real server process, the Rust binary's
`server` subcommand, and checks it only through HTTP, the socket at `/api/ws`, the files in the pool
directory, the calls on the herdr socket and the harness processes it starts.

```
bun run conformance [--server rust] [--rust-bin <path>] [--legs <kind>,<kind>,...] [<bun test arguments>]
```

The binary defaults to `target/release/agent-console` (`cargo build --release`). The Bun server was
removed at the flip, so `--server bun`, or a `bun` leg, is refused with one line.

Comments under `conformance/` that cite `engine/<file>.ts:<line>` point at the TypeScript server as it
stood at the flip, commit `75ea8fe`, which deleted it. Read one with `git show 75ea8fe^:engine/<file>.ts`.

## Takeover cases and legs

A takeover case runs one pool across several server processes in turn, as a Restart does. Each server is
one leg.
Leg 1 runs the pool to the case's stop point and stops with SIGTERM. Each middle leg boots on what the
last one left, checks the stop point still holds, and stops again. The last leg boots and runs the pool to
the end.

Each leg runs the server `--legs` names in its place, or `CONFORMANCE_LEGS` when the flag is absent.
`--legs rust,rust` runs two legs. Without either, a case runs three legs of the `--server` choice. A case
needs at least two legs. If the binary is not built, every takeover case is reported as not run and the
runner exits 2, as every other case is.

Each case runs its scenario twice, in two worlds built from the same spec. The first run is
uninterrupted, on the `--server` choice. The second is taken over, leg by leg. After each takeover the
stop point must look exactly as the last server left it. At the end the two runs must match. Both checks
cover:

- the snapshot once parsed, less its revision, which every boot starts afresh, and the pool log, which
  every boot adds its own lines to;
- the Ticket and Conversation files, `spawn-ledger.md` and `AGENT.md`, byte for byte;
- every harness launch;
- the order of each events file's kinds;
- the herdr calls that change something.

Each world's own path is written as `<root>`, and its pool key as `<key>`. The key names its worktrees
and branches. The harness computes it itself rather than reading it back, so a server that keys them
differently fails. A scenario names anything a takeover changes on purpose, so every difference is
asserted, never ignored. A boot that moves the pool on, by draining Queued answers or landing Pending
spawns, says so. The next takeover is then held to where it moved.

`harness/takeover.ts` drives the legs and the comparison, and `cases/takeover.test.ts` holds the cases. A
case that needs a fake herdr gets one process per world, kept alive across every leg, as a live daemon
outlives a Restart. A stub launch that must stay open across legs is held with `world.stubs.hold(key)`
until the case releases it, since `waitFor` gives up after ten seconds.
