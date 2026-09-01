/**
 * PROTOTYPE (throwaway) — fixture pool for the bulk-resume UI prototype,
 * issue #27. A post-crash pool: several tickets raised interrupts together
 * and one is already answered-and-waiting, so every bulk-resume state is on
 * screen at once. ProtoPool simulates the engine's accept-now /
 * process-at-boundary contract (ADR-0004): an accepted answer sits as a
 * queued answer, then a beat later the super-step boundary drains them all
 * together.
 */

import type { PoolSnapshot } from "../project";

function fixture(): PoolSnapshot {
  return {
    seq: 41,
    phase: "quiescent",
    poolName: "agent-console",
    state: {
      tickets: [
        { id: "14", title: "engine: drain queued answers at the super-step boundary", blockedBy: [], status: "done" },
        { id: "18", title: "engine owns the ticket status write", blockedBy: ["14"], status: "in-progress" },
        { id: "22", title: "console-runner skill ships with the console", blockedBy: ["14"], status: "checkpoint" },
        { id: "25", title: "pool stalls when a harness crashes", blockedBy: ["18"], status: "in-progress" },
        { id: "26", title: "worktree collision when resuming a crashed ticket", blockedBy: ["25"], status: "in-progress" },
        { id: "28", title: "merge resolver loops on a dirty worktree", blockedBy: ["25"], status: "in-progress" },
        { id: "27", title: "bulk resume calls", blockedBy: ["26", "28"], status: "ready" },
      ],
      log: [
        "super-step 9 · spawned #18 attempt 2",
        "super-step 9 · spawned #25 attempt 1",
        "super-step 9 · spawned #26 attempt 1",
        "#25 attempt 1 exited 1 · no outcome written",
        "#26 attempt 1 exited 1 · no outcome written",
        "pool quiescent · 4 interrupts waiting on the operator",
      ],
      outcomes: {
        "14": { summary: "drain lands at the boundary", commitSha: "6b7c542" },
      },
      interrupts: [
        { ticketId: "22", kind: "checkpoint", body: "Attempt 1 ended checkpoint: Spec needs the engine-owns-status note before #25 and #26 resume." },
        { ticketId: "25", kind: "crash", body: "Harness exited 1 on attempt 1 (spawn → immediate crash). No Outcome written." },
        { ticketId: "26", kind: "crash", body: "Harness exited 1 on attempt 1. Worktree left dirty; resume needs a clean-tree check." },
        { ticketId: "28", kind: "merge-conflict", body: "Merge resolver hit conflicts in engine/engine.ts against main." },
      ],
      // #22's resume was already accepted: it renders the answered-and-waiting
      // state every variant has to leave alone.
      queuedAnswers: [{ ticketId: "22", kind: "checkpoint" }],
      config: {},
    },
  };
}

export class ProtoPool {
  snapshot: PoolSnapshot = fixture();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe(fn: () => void): void {
    this.listeners.add(fn);
  }

  /** The /api/resume seam, stubbed: accept now, process at the boundary. */
  acceptAnswer(ticketId: string, action: string, note?: string): void {
    const interrupt = this.snapshot.state.interrupts.find(
      (i) => i.ticketId === ticketId,
    );
    if (!interrupt) return;
    const already = this.snapshot.state.queuedAnswers.some(
      (a) => a.ticketId === ticketId && a.kind === interrupt.kind,
    );
    if (already) return;
    this.snapshot.state.queuedAnswers.push({ ticketId, kind: interrupt.kind });
    this.snapshot.seq += 1;
    this.log(
      `answer accepted · ${action} · ${ticketId}${note ? ` · “${note}”` : ""} → queued, waiting for the super-step boundary`,
    );
    this.emit();
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.drainBoundary();
    }, 1400);
  }

  private drainBoundary(): void {
    const drained = [...this.snapshot.state.queuedAnswers];
    if (drained.length === 0) return;
    this.snapshot.state.queuedAnswers = [];
    for (const answer of drained) {
      this.snapshot.state.interrupts = this.snapshot.state.interrupts.filter(
        (i) => i.ticketId !== answer.ticketId,
      );
      const ticket = this.snapshot.state.tickets.find(
        (t) => t.id === answer.ticketId,
      );
      if (ticket && ticket.status !== "done") ticket.status = "ready";
      this.log(`super-step boundary · ${answer.ticketId} resumed → ready`);
    }
    this.snapshot.seq += 1;
    this.emit();
  }

  private log(line: string): void {
    this.snapshot.state.log.push(line);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
