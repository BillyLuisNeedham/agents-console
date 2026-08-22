<!-- state: id=12 blocked-by=03,09,11 status=ready -->

# 12 — Final review

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

A review pass over the whole `arch/cleanup` branch against this spec, driven by the `code-review` skill — one reviewer checks the branch against the spec's implementation decisions, another against the repo's documented standards (CONTEXT.md vocabulary, ADRs 0001–0003). This ticket changes no code. If the review finds problems, it ends as a checkpoint and the brief carries the disagreement for Billy; a clean review ends it as done and the branch is ready for Billy to merge.

## Acceptance criteria

- [ ] The review covers every spec implementation decision against the branch tip
- [ ] The review confirms no dead reference to the deleted pipeline remains (excluding git history and this pool's own files)
- [ ] The review confirms ADR-0003 exists and the naming ownership it records is real in the code
- [ ] Findings, if any, are written into this issue's brief; a clean result is recorded as done

## Blocked by

03 — Rewrite the docs for the Console; 09 — Structured harness fields; 11 — Split the view god module (all work must have landed)
