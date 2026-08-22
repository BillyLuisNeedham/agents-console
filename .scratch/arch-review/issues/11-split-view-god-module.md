<!-- state: id=11 blocked-by=10 status=ready -->

# 11 — Split the view god module

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The 1,305-line view module is split along its existing responsibility clusters: a canvas module owning pan/zoom/drag, edge geometry, and persisted node positions; a detail module owning the Detail panel render, width drag, fullscreen, interrupt forms, and note drafts; and a drawers module. The ~15 module-scope mutable variables are hoisted into a per-session view-state object created by the composition root, so renderers become functions of state + model + handlers rather than readers of hidden module state. The view module that remains is the thin layer its header already promises. Behavior is preserving: no visual or interaction change.

## Acceptance criteria

- [ ] Canvas, detail, and drawers each live in their own module owning their own state
- [ ] No renderer reads module-scope mutable state; state flows in as a parameter
- [ ] The remaining view module is composition only
- [ ] `bun test`, `tsc --noEmit`, and `bun run build` pass in `ui/`
- [ ] Manual smoke (documented in the issue notes): canvas pan/zoom/drag, card click opens Detail, Detail resize/fullscreen, interrupt answer inline, drawers toggle — all behave as before

## Blocked by

10 — Extract the log-pane module (touches the same view module)
