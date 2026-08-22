<!-- state: id=27 blocked-by=23,24 status=done -->

# 27 — my-console-runner speaks the new conventions

Spec: `.scratch/console-pool/spec-fleet-of-consoles.md`.

## What to build

The my-console-runner skill catches up with the engine's new ownership. Its interview captures a port answer (suggesting 8787 or next free at setup time) and writes it as `port` in the `console.json` it produces, so skill-configured pools get stable URLs without a manual edit. The launch phase stops writing `runs/server.pid` — the engine owns that file now — and instead relies on the engine's refusal when the pool is already live, surfacing that refusal (live pid, port, pool dir) to the user so a relaunch points them at the running console.

## Acceptance criteria

- [x] The skill's interview includes the port question and writes the answer as `port` in `console.json`
- [x] The launch phase no longer writes `runs/server.pid`
- [x] Relaunching a live pool surfaces the engine's refusal message verbatim enough that the user can find the running console
- [x] Pools configured before this change (no `port` in `console.json`) still launch, on the unpinned next-free path
- [x] Skill text reviewed for stale references to the advisory pid convention

## Blocked by

- 23 — Engine-enforced pool lock (the skill now defers to the engine's refusal)
- 24 — Pinned pool ports (the skill writes the pin)

## Notes

- The Issue cites a spec `spec-fleet-of-consoles.md` that does not exist in this pool; the pool carries `spec-ticket-pools.md` and `spec-console-flight-fixes.md`. The Issue's own text and the blocked-by outcomes (23, 24) were self-contained, so I proceeded. Inference: the spec line is a stale reference, worth fixing if the pool is ever re-archived.
- All smoke tests ran against a temp pool in `/tmp/opencode/pool27` (removed after): pinned boot extracts the port from the engine's `pool server on http://localhost:N` line, the probe answers, the engine writes `runs/server.pid` itself; a relaunch of a live pool exits with the engine's refusal in the log tail, surfaced verbatim.
- Smoke test caught a real flaw in my first launch draft: the loop read the previous server's boot line out of an appended log and mistook it for a new boot, so a relaunch never waited for the refusal. Fixed by truncating `runs/server.log` before launch (fresh log per boot) and `mkdir -p` the runs dir so a first boot's redirect does not fail.
- The refusal message names the pid and pool dir; the port appears only when the fleet registry has an entry. Nothing writes the registry yet, so in practice the message carries no port. The Issue's note says the skill does not need the registry, so the skill surfaces the message verbatim and stops. Inference: a later ticket may add the registry writer; the skill text stays correct either way.
- Unpinned path proven: a console.json without `port` booted the engine's hunt (8788 here, 8787 being taken) and the loop extracted the real port from the boot line.
- Port pin moved into console.json as the single source: the launch no longer passes `--port`, so a hand-edited pin survives a relaunch and `auto` (no key) defers to the engine's boot-time hunt.
- Skill committed in the skills repo on `main` (the skill's home, matching tickets 10 and 15). No pool-repo commit: the work product lives outside this repo and `.scratch/` is never committed.
