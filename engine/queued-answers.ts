/**
 * The queued-answer store: every accepted interrupt answer, persisted in
 * submission order alongside the pool's other run artifacts
 * (`runs/queued-answers.json`). Deliberately separate from PoolState
 * (ADR-0004): the super-step join rebuilds state from a pre-flight snapshot
 * and would clobber a queued-answers channel, so the queue lives on its own
 * and survives a server restart. Acceptance enqueues; the drive's boundary
 * drain marks records processed. The file is rewritten atomically (tmp +
 * rename) on every change, so a crash mid-write never tears the queue.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InterruptKind } from "./engine.ts";

export interface QueuedAnswer {
  seq: number;
  ticketId: string;
  /** The interrupt identity: the kind of interrupt this answer addresses. */
  kind: InterruptKind;
  /** The answer payload: true approve, false reject, undefined resume. */
  approve?: boolean;
  note?: string;
  at: string;
  processedAt: string | null;
}

export class QueuedAnswerStore {
  private readonly file: string;
  private nextSeq: number;
  private answers: QueuedAnswer[];

  constructor(runsDir: string) {
    this.file = join(runsDir, "queued-answers.json");
    this.nextSeq = 1;
    this.answers = [];
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as {
        nextSeq?: unknown;
        answers?: unknown;
      };
      if (typeof parsed.nextSeq === "number" && Array.isArray(parsed.answers)) {
        this.nextSeq = parsed.nextSeq;
        this.answers = parsed.answers as QueuedAnswer[];
      }
    } catch {
      // A torn or unreadable file starts the queue empty rather than taking
      // the pool down; processed history is not load-bearing.
    }
  }

  /** Append an accepted answer, assigning its submission order. */
  enqueue(answer: Omit<QueuedAnswer, "seq" | "processedAt">): QueuedAnswer {
    const record: QueuedAnswer = {
      ...answer,
      seq: this.nextSeq,
      processedAt: null,
    };
    this.nextSeq += 1;
    this.answers.push(record);
    this.save();
    return record;
  }

  /** Unprocessed answers in submission order. */
  pending(): QueuedAnswer[] {
    return this.answers.filter((answer) => answer.processedAt === null);
  }

  markProcessed(seq: number): void {
    const record = this.answers.find((answer) => answer.seq === seq);
    if (!record || record.processedAt !== null) return;
    record.processedAt = new Date().toISOString();
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const aside = `${this.file}.tmp`;
    writeFileSync(
      aside,
      JSON.stringify({ nextSeq: this.nextSeq, answers: this.answers }, null, 2),
    );
    renameSync(aside, this.file);
  }
}
