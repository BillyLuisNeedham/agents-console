<!-- state: id=04 blocked-by=01 status=ready -->

# 04 — Wire the fleet command

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

ADR-0001 promises a fleet list command that prints the machine's live Consoles, and the module implementing it exists — but nothing launches it. The root package manifest gains a `fleet` script that runs the existing fleet CLI module, so `bun run fleet` lists the live pools from the fleet registry. The existing subprocess test keeps passing unchanged.

## Acceptance criteria

- [ ] Root package manifest has a `fleet` script invoking the fleet CLI module
- [ ] `bun run fleet` against a registry with no live Consoles prints the no-live-Consoles message and exits 0
- [ ] `bun test` and `tsc --noEmit` pass at the root

## Blocked by

01 — Delete the old LangGraph pipeline (both edit the root package manifest)
