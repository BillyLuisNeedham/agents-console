<!-- state: id=05 blocked-by=none status=ready -->
# 05: Crash recorded at attempt exit

**What to build:** A crashed attempt stops masquerading as running work. The moment an attempt exits unsuccessfully, the crash event is appended to the ticket log and the marker is updated by the attempt-running path (per-ticket event appends are concurrency-safe), and a snapshot is emitted so the Console shows the crash within seconds — instead of the UI displaying a long-finished ticket as running until the slowest sibling's super-step ends. The crash interrupt is still raised at the super-step boundary, preserving state-join safety; only the recording and its visibility move to exit time.

**Blocked by:** None (can start immediately)

- [ ] The crash event appears in the ticket log immediately when the attempt exits, not at the end of the super-step
- [ ] A snapshot is emitted when the crash is recorded, so the Console reflects it within seconds with no polling
- [ ] The crash interrupt is raised at the super-step boundary as today, and answering it behaves as today
- [ ] An engine seam test with a fast-failing ticket and a slow sibling shows the crash recorded at exit, before the sibling finishes; existing suites pass
