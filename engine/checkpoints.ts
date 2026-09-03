import { Database } from "bun:sqlite";
import { join } from "node:path";

// The checkpoint store seam (spec no-silent-dead-drives): the pool takes any
// object with this shape at start, so a test can substitute a store whose
// write throws on demand. The drive treats a failed write as recoverable,
// never as a reason to close the store.
export interface CheckpointStore {
  write(state: unknown): void;
  latest(): unknown | null;
  close(): void;
}

export class SqliteCheckpointStore implements CheckpointStore {
  private db: Database;

  constructor(poolDir: string) {
    this.db = new Database(join(poolDir, "console.db"));
    this.db.run(
      "CREATE TABLE IF NOT EXISTS checkpoints (" +
        "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "at TEXT NOT NULL, " +
        "state TEXT NOT NULL" +
        ")",
    );
  }

  write(state: unknown): void {
    this.db.run("INSERT INTO checkpoints (at, state) VALUES (?, ?)", [
      new Date().toISOString(),
      JSON.stringify(state),
    ]);
  }

  latest(): unknown | null {
    const row = this.db
      .query("SELECT state FROM checkpoints ORDER BY seq DESC LIMIT 1")
      .get() as { state: string } | null;
    return row ? JSON.parse(row.state) : null;
  }

  close(): void {
    this.db.close();
  }
}
