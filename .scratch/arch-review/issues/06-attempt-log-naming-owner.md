<!-- state: id=06 blocked-by=05 status=ready -->

# 06 — One owner for attempt-log names (ADR-0003)

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The attempt-log file naming contract that ADR-0002 calls "stable from the first write" becomes one function instead of three implementations. The events module (already owner of the per-ticket events file) exports a single naming function covering the base log, the attempt-numbered logs, and the resolver log. The engine's rotator writes through it; the server's log lister and attempt reconstructor read through it — the regex re-derivation and the event-derived name building are deleted. ADR-0003 is written: the events module owns all ticket-log file naming. Unit tests pin the naming contract where it lives.

## Acceptance criteria

- [ ] One exported naming function in the events module covers base, attempt-numbered, and resolver log names
- [ ] The engine rotator and both server readers call it; no other code spells the file names
- [ ] Unit tests pin the naming for all three variants
- [ ] `docs/adr/0003-ticket-log-naming.md` records the ownership decision, referencing ADR-0002
- [ ] Existing attempt logs from prior pools still resolve (the contract is unchanged, only its owner moves)
- [ ] `bun test` and `tsc --noEmit` pass at the root

## Blocked by

05 — Trim the dead exports (touches the same engine modules)
