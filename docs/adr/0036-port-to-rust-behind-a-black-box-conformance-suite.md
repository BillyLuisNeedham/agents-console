# Port the Console to Rust behind a black-box conformance suite

Rust is the end state for the Console's server (issue #157). The port is issue #162 (https://github.com/BillyLuisNeedham/agents-console/issues/162). PR #160 showed the lag came from design, not the language, so speed alone does not justify the port. What does is one binary with nothing to install, near-instant start, and steady memory over a long pool run. The port must match or beat the TypeScript server on every speed gate.

Two facts shaped the plan. First, only about 230 of the engine's roughly 1,290 test cases go through HTTP or the socket; about 1,000 import engine internals (`engine.test.ts` alone has 320), so they cannot test a Rust server. Second, Bun runs more than the server: Boot, the Steward and fleet CLIs, and the UI build all use it.

We decided that **the whole Console moves to Rust in one go, proved by a black-box conformance suite written in TypeScript first, and the TypeScript engine is deleted when Rust takes over**. It works like this:

- **Scope.** One `agent-console` binary with `boot`, `server`, `steward` and `fleet` subcommands. The release binary embeds the built UI. Bun stays only as a development tool: it builds the UI with Vite and runs the UI tests, the conformance suite and the bench. The shim runs `cargo build --release` when the binary is stale. Prebuilt binaries and CI wait until someone other than the operator uses the Console.
- **The bar is the conformance suite.** It lives in a top-level `conformance/` folder that survives the flip, with the test fakes (fake herdr, Jev fake, pool fixtures) moved into `conformance/fixtures`. It starts a real server process, Bun or Rust, chosen by `bun run conformance --server bun|rust`, and asserts only through HTTP, the socket and files on disk. It passes against Bun first. A sort of the internal tests (`docs/research/rust-port/test-inventory.md`) turns each behaviour visible from outside into a conformance case. Each hidden behaviour becomes a Rust unit test that the matching port ticket must include. After the port it stays as the server's permanent black-box suite, and every engine change lands with conformance cases for what it changes that can be seen from outside.
- **Same contract.** Every contract stays the same: the #161 socket protocol (ADR-0032), the HTTP routes, and every on-disk format. Files that people and agents read stay byte-identical: Ticket and Conversation markdown, the state line, `spawn-ledger.md` and `AGENT.md`. JSON, JSONL, checkpoint state and socket frames only need to be equal once parsed. A conformance case runs one pool across Bun, then Rust, then Bun again, so existing pools resume on Rust and a git revert leaves them resumable on Bun. `protocol.ts` stays the source of the shared types until the flip. A Rust test checks that the TypeScript it generates matches `protocol.ts`, and at the flip the generated file replaces it.
- **New internals.** The internals are redesigned, not translated. A pure decision core sits in the middle and I/O sits at the edges, and one tokio task owns pool state and takes messages, so nothing needs locks. Jev calls TypeSafe's HTTP API directly, since its SDK is TypeScript only.
- **Order.**
  - M0 (TypeScript): the conformance harness and cases.
  - M1: the workspace, the disk formats and the protocol types.
  - M2: git, herdr, harness launch and panes.
  - M3: the core engine.
  - M4: the HTTP and socket server and the subcommands.
  - M5: the bench gates, the render-survival harness, real pools and the flip.
  - Each milestone ends by merging main into the branch and porting whatever engine behaviour landed on main in the meantime.
- **Unattended.** The run happens while the operator is away. Port tickets run at effort max with no verify, because the conformance pass share in each ticket's acceptance is the bar. The Conversation that planned the port proposes each wave from the results of the last. The Steward answers Interrupts with this ADR and #162 as its authority.
- **The flip.** All work lands on `feature/162-rust-migration`, and the run ends there fully switched: Rust is the engine and the TypeScript engine is deleted. Before handing over, the conformance suite, all 9 bench gates and the render-survival harness pass on Linux, and 2 real throwaway pools have run end to end. The operator then runs the gates and one pool on the Mac, reviews the one PR, and merges it. The merge is the flip, and git is the rollback. No engine setting chooses between Bun and Rust.

**Considered options**:
- **Porting piece by piece (strangler).** Rejected. The server and the pool run share one process and call each other directly, so there is no seam to swap halves across.
- **Porting the tests into Rust as the code moves.** Rejected. It would check the port against the port, and the internal tests are tied to the TypeScript structure the redesign replaces.
- **Switching pool by pool behind a setting, with side-by-side running and per-milestone review.** Dropped once the operator chose to review only the finished port. Git is the rollback.
- **Keeping Boot or a Bun helper for Jev.** Rejected. Bun would still be needed at runtime, which loses the point of one binary.
