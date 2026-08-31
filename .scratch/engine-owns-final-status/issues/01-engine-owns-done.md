<!-- state: id=01 blocked-by=none status=done -->

# 01 — Engine owns the final status write for done

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

The engine, not the ticket agent, writes a ticket's final status. At attempt exit the engine reads the attempt's outcome JSON; on exit code 0 with a valid `status=done` it writes `done` to the canonical Issue's line-1 marker itself. The outcome schema becomes `{"status": "done" | "checkpoint", "summary": string, "commitSha": string | null, "brief": string}` with `status` required. Anything else — non-zero exit, missing outcome file, unparseable outcome, invalid status value — is recorded as a crash whose event payload carries the exit code and a distinct reason, so the ticket log distinguishes "harness died" from "agent never wrote its outcome". Marker statuses written by agents are no longer honored anywhere: the clean break. The fake harness CLIs in the engine test suite switch from sed-ing the Issue marker to writing the outcome JSON, mirroring the new agent contract. Timing is unchanged: the outcome is read at attempt exit, exactly where read-back ran, and crash interrupts are still raised at the super-step boundary with a snapshot emitted at exit.

## Acceptance criteria

- [x] At attempt exit, exit code 0 plus a valid outcome with `status=done` results in the engine writing `done` to the canonical Issue marker
- [x] An attempt that exits without a readable outcome or a valid status is recorded as a crash, with the exit code and a distinct reason in the crash event payload
- [x] A valid done outcome with a non-zero exit code is a crash, not a done
- [x] A marker status written by the agent directly is ignored (clean break: no read-back of agent-written endings)
- [x] Fake harness CLIs in the test suite write the outcome JSON rather than sed-ing the Issue marker
- [x] Existing done/crash/resume tests pass under the new contract, updated only where the protocol itself changed
- [x] New contract tests assert externally visible behavior only (markers on disk, ticket-log events, interrupt timing), never engine internals

## Notes

- `readBack` is gone. `runTicket` decides the ending from the outcome JSON alone: exit code first (non-zero is always a crash, even with a valid done outcome), then the outcome's validity. On a crash the marker is corrected to in-progress on disk at exit, so the exit-time snapshot still agrees with the markers.
- Crash reasons, all asserted in the new "outcome contract" describe: `harness exited N`, `no outcome written`, `outcome is not parseable JSON`, `outcome's status is not done or checkpoint`, plus `outcome has no summary string` for a valid-status outcome with no summary.
- A valid checkpoint outcome already makes the engine write the checkpoint marker (the status machine is one change); the Brief append and its placeholder are ticket 02's. Until then a checkpoint interrupt body comes from whatever Brief the Issue already holds, as before.
- Deliberate clean break: a pre-cutover outcome file (`{summary, commitSha}`, no `status`) is no longer recovered on rehydration, so a ticket done before the cutover keeps its done marker but loses its summary from the Review body. The spec's cutover story covers in-flight attempts; this is the same break applied to on-disk outcomes.
- Test suite changes beyond the fake switch: the crash-event payload gained `reason`; "records a crash and its answer" needed per-attempt exit codes (`exitCodes: [3, 0]`) because a resumed attempt exiting non-zero with a valid done outcome is now a crash; the outcome-channel assertions gained `status: "done"`. The legacy run.sh-continuation fake still seds the marker on purpose: run.sh is the old-protocol runner, out of scope per the spec.
- Checkpoint outcomes landed in `state.outcomes` carry `brief` through, but nothing reads it yet (ticket 02).
