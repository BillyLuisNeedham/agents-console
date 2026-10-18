# A Pending spawn lands before anyone can act on it, so it has no operator verbs

Amends ADR-0029's issue #150 addendum (`docs/adr/0029-spawn-caps-are-pool-settings-and-hold-what-they-cannot-take.md`). Under super-steps a Pending spawn waited for the boundary, often for minutes, and the operator could Hold or Discard it in that window. Under the rolling scheduler (ADR-0040) the exit that takes a proposal also wakes the drive, and the next Tick lands it before any request from the Console can reach it. Hold and Discard of a Pending spawn could no longer win that race, and no conformance case could reach them either. The operator's Steward chose to retire them rather than make Pending wait.

**Pending spawns have no verbs and no Console surface.** The routes `POST /api/spawns/pending/hold` and `/discard` and their socket requests are gone, and they answer as any unknown request does. The Console drops the Pending section of the Spawns list, the header's Pending count, the faded "lands next Tick" cards and the Pending Detail. Held spawns keep everything ADR-0029 gave them: Adopt, Discard, the reason and the faded card.

**Pending stays as the engine's write-ahead record.** A proposal is still taken into `runs/held-spawns.json` before anything else happens, so a restart between taking and landing loses nothing, and it still lands at the first Tick after the restart. The Spawn ledger and the Steward's state read still list Pending spawns, and the snapshot still carries them. They cost nothing, and they stay true in the one case where a Pending spawn lasts, which is across a restart. A Held spawn the operator held before this change keeps the reason "held by the operator". Nothing new is held that way.

**The operator's lever is the Spawn caps.** An operator who wants to see every follow-up before it runs sets a cap to 0. Every proposal is then a Held spawn waiting for Adopt or Discard, which is the review Pending's Hold used to offer, without a race.

**Considered Options**: Making a Pending spawn wait for something the operator can see was rejected. A wait until the pool is idle, or a review window of some seconds, would put a delay back into every Spawn. That cuts against ADR-0040's reason for rolling, that Tickets run as fast as they can, and a cap of 0 already holds everything for the operator.

**Consequences**:
- The engine-written header of a Spawn ticket no longer promises the operator can edit or kill it before it schedules. An unblocked Spawn schedules at the Tick that lands it.
