<!-- state: id=07 blocked-by=06 status=ready -->

# 07 — One parser per file format

Spec: `.scratch/arch-review/spec-arch-cleanup.md`

## What to build

Two file formats stop being parsed in multiple places. First: the pool's `console.json` is loaded once by the engine through a single config loader, and the server consumes that parsed config — including the port — instead of re-reading and re-validating the file behind the engine's back. The engine's config type either reads `port` genuinely or drops it; no dead field remains. Second: the issue file's heading grammar (title, spec body) is parsed by the engine side beside the marker loading it already does, and exposed as ticket metadata; the server's independent heading parsers are deleted and the events endpoint serves the engine's metadata. A heading-format change now breaks exactly one parser.

## Acceptance criteria

- [ ] One config loader parses `console.json`; the server consumes the parsed config and never opens the file itself
- [ ] The `port` field is either genuinely read from the engine's parsed config or removed from the type
- [ ] Ticket title and spec reach the server as engine-parsed metadata; the server's heading-parsing helpers are deleted
- [ ] Server tests still pin the served title/spec/shape over HTTP
- [ ] `bun test` and `tsc --noEmit` pass at the root

## Blocked by

06 — One owner for attempt-log names (same engine/server modules)
