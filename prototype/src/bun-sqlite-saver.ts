import {
  BaseCheckpointSaver,
  copyCheckpoint,
  maxChannelVersion,
  TASKS,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Database } from "bun:sqlite";

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: string | Uint8Array;
  metadata: string | Uint8Array;
  pending_writes: string;
};

export class BunSqliteSaver extends BaseCheckpointSaver {
  private db: Database;
  private ready = false;

  constructor(path: string) {
    super();
    this.db = new Database(path, { create: true });
  }

  private setup() {
    if (this.ready) return;
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      )`);
    this.ready = true;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.setup();
    const threadId = String(config.configurable?.thread_id ?? "");
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    const sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type,
             checkpoint, metadata,
             (
               SELECT json_group_array(json_object(
                 'task_id', pw.task_id, 'channel', pw.channel,
                 'type', pw.type, 'value', CAST(pw.value AS TEXT)
               ))
               FROM writes pw
               WHERE pw.thread_id = checkpoints.thread_id
                 AND pw.checkpoint_ns = checkpoints.checkpoint_ns
                 AND pw.checkpoint_id = checkpoints.checkpoint_id
             ) as pending_writes
      FROM checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
      ${checkpointId ? "AND checkpoint_id = ?" : "ORDER BY checkpoint_id DESC LIMIT 1"}`;
    const row = this.db
      .query<CheckpointRow, string[]>(sql)
      .get(...(checkpointId ? [threadId, checkpointNs, checkpointId] : [threadId, checkpointNs]));
    if (!row) return undefined;
    const pendingWrites = await Promise.all(
      (JSON.parse(row.pending_writes || "[]") as {
        task_id: string;
        channel: string;
        type?: string;
        value?: string;
      }[]).map(
        async (write) =>
          [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
          ] as [string, string, unknown],
      ),
    );
    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    )) as Checkpoint;
    if (checkpoint.v < 4 && row.parent_checkpoint_id != null) {
      await this.migratePendingSends(checkpoint, row.thread_id, row.parent_checkpoint_id);
    }
    return {
      checkpoint,
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpoint_id,
        },
      },
      metadata: (await this.serde.loadsTyped(
        row.type ?? "json",
        row.metadata,
      )) as CheckpointMetadata,
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: checkpointNs,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const tuple = await this.getTuple(config);
    if (tuple && !options?.before) yield tuple;
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    this.setup();
    const threadId = String(config.configurable?.thread_id ?? "");
    if (!threadId) throw new Error('Missing "thread_id"');
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const parentId = config.configurable?.checkpoint_id as string | undefined;
    const prepared = copyCheckpoint(checkpoint);
    const [[type1, serializedCheckpoint], [type2, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(prepared),
        this.serde.dumpsTyped(metadata),
      ]);
    if (type1 !== type2) throw new Error("checkpoint/metadata type mismatch");
    this.db
      .query(
        `INSERT OR REPLACE INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parentId ?? null,
        type1,
        serializedCheckpoint,
        serializedMetadata,
      );
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();
    const threadId = String(config.configurable?.thread_id ?? "");
    const checkpointNs = String(config.configurable?.checkpoint_ns ?? "");
    const checkpointId = String(config.configurable?.checkpoint_id ?? "");
    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const sql = `INSERT ${allSpecial ? "OR REPLACE" : "OR IGNORE"} INTO writes
      (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const stmt = this.db.query(sql);
    const rows = await Promise.all(
      writes.map(async (write, idx) => {
        const [type, serialized] = await this.serde.dumpsTyped(write[1]);
        return [
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          WRITES_IDX_MAP[write[0]] ?? idx,
          write[0],
          type,
          serialized,
        ] as const;
      }),
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) stmt.run(...row);
    });
    tx();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM checkpoints WHERE thread_id = ?").run(threadId);
      this.db.query("DELETE FROM writes WHERE thread_id = ?").run(threadId);
    });
    tx();
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    parentCheckpointId: string,
  ) {
    const row = this.db
      .query<{ pending_sends: string }, [string, string, string]>(
        `SELECT json_group_array(json_object(
           'type', ps.type, 'value', CAST(ps.value AS TEXT)
         )) as pending_sends
         FROM writes as ps
         WHERE ps.thread_id = ? AND ps.checkpoint_id = ? AND ps.channel = ?
         ORDER BY ps.idx`,
      )
      .get(threadId, parentCheckpointId, TASKS);
    const pending = JSON.parse(row?.pending_sends || "[]") as {
      type: string;
      value: string;
    }[];
    checkpoint.channel_values ??= {};
    checkpoint.channel_values[TASKS] = await Promise.all(
      pending.map(({ type, value }) => this.serde.loadsTyped(type, value)),
    );
    checkpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}
