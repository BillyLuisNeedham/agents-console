<!-- state: id=10 blocked-by=05 status=ready -->

# 10 — Extract the log-pane module

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The ticket log pane stops being scattered across four modules. One deep UI module owns the whole concept: the byte-window state machine (open, live-tail, prepend-earlier), the attempt-stay and stale-selection guards, and the scroll pin. Its interface is small — open a ticket/attempt, follow the timeline, load earlier — and its fetches are injected at construction, so the guards that today live in untestable module-scope closures get direct unit tests with fake fetches. The bootstrap module drives it and stops doing offset arithmetic; the view renders its view model; the client's paging protocol stops leaking to callers. Visible behavior is unchanged: tailing, attempt switching, scroll restore, and earlier-chunk prepend all work as before.

## Acceptance criteria

- [ ] One module owns the log-pane state machine; the bootstrap module holds no offset arithmetic
- [ ] Fetches are injected; unit tests pin the stale-selection guard (a slow fetch never clobbers a newer selection) and the attempt-stay behavior
- [ ] The scroll pin and prepend anchor move with the module; view code only renders
- [ ] Existing projection tests pass; new log-pane tests sit beside them in style
- [ ] `bun test`, `tsc --noEmit`, and `bun run build` pass in `ui/`

## Blocked by

05 — Trim the dead exports (touches the same UI projection module)
