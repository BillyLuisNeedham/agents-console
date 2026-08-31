<!-- state: id=05 blocked-by=none status=done -->

# 05 — ADR-0005 and the Outcome glossary entry

Spec: `docs/specs/2026-08-30-engine-owns-final-status.md`

## What to build

The protocol change is recorded where a future reader will find it. ADR-0005 ("the engine owns the final status write") captures the decision, the alternatives weighed (worktree read-back fallback, prompt-only wording, symlinking the canonical Issue into worktrees), and why the structural fix was chosen: the false-crash class is deleted, not patched, at the cost of a state-protocol change and a one-crash cutover for in-flight attempts. CONTEXT.md gains a glossary entry for **Outcome** — the JSON an attempt writes to signal its result — in the established glossary format and free of implementation detail.

## Acceptance criteria

- [x] ADR-0005 exists in the established ADR format and records the decision, the alternatives, and the trade-off
- [x] CONTEXT.md defines Outcome in the glossary's format, with no implementation detail
- [x] Both docs use the project's ubiquitous language and cross-reference issue #18 and the spec
