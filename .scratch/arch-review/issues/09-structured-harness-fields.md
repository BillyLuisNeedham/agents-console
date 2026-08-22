<!-- state: id=09 blocked-by=08 status=ready -->

# 09 — Structured fields for the harness adapters

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

The prompt's first line stops being a wire format. Today the prompt builder renders `/driver issueRef …` as line one and the opencode adapter strips that line back apart to recover the driver and issue reference for its own argv — a coupling a prompt-format change would silently break for opencode while claude keeps working. After this ticket, each harness resolver receives structured fields (driver, issue reference, prompt body) and builds its own invocation; the line-stripping helper is deleted. The engine test that pinned the reverse-parsing is replaced by direct per-adapter unit tests pinning each harness's argv shape (opencode and claude at minimum).

## Acceptance criteria

- [ ] Harness resolvers receive driver, issue reference, and body as structured fields
- [ ] The first-line stripping helper is deleted; no adapter parses the rendered prompt
- [ ] Direct unit tests pin the opencode and claude argv shapes at the spawn seam
- [ ] The old reverse-parsing test is gone; no test depends on the prompt's first line as a format
- [ ] `bun test` and `tsc --noEmit` pass at the root

## Blocked by

08 — Server imports the engine's domain types (same engine test file)
