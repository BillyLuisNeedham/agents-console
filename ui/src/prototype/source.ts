import type { PoolClient } from "../client";
import type { PoolSnapshot, TicketActivityResponse } from "../project";
import type { TicketActivity } from "./activity";

export interface ActivitySource {
  activity: ReadonlyMap<string, TicketActivity>;
  update(snapshot: PoolSnapshot | null): void;
  dispose(): void;
}

const REAL_INTERVAL_MS = 2000;
const DEMO_INTERVAL_MS = 1500;

const DEMO_FILES = [
  "engine/engine.ts",
  "engine/server.ts",
  "ui/src/canvas.ts",
  "ui/src/main.ts",
  "ui/src/styles.css",
  "docs/CONTEXT.md",
];

interface DemoFile {
  added: number;
  removed: number;
}

interface DemoTicketState {
  files: Map<string, DemoFile>;
  logSize: number;
  idleTicks: number;
}

function toTicketActivity(res: TicketActivityResponse): TicketActivity {
  return {
    ticketId: res.ticketId,
    running: res.running,
    lastEventAt: res.lastEventAt,
    log: res.log,
    diff: res.diff,
  };
}

export function createActivitySource(opts: {
  client: PoolClient;
  demo: boolean;
  onTick: () => void;
}): ActivitySource {
  const activity = new Map<string, TicketActivity>();
  const demoState = new Map<string, DemoTicketState>();
  let snapshot: PoolSnapshot | null = null;

  function targets(): string[] {
    if (!snapshot) return [];
    const inProgress = snapshot.state.tickets
      .filter((t) => t.status === "in-progress")
      .map((t) => t.id);
    if (!opts.demo) return inProgress;
    if (inProgress.length > 0) return inProgress;
    return snapshot.state.tickets.slice(0, 3).map((t) => t.id);
  }

  function prune(): void {
    const ids = new Set(snapshot?.state.tickets.map((t) => t.id) ?? []);
    for (const key of [...activity.keys()]) {
      if (!ids.has(key)) activity.delete(key);
    }
    for (const key of [...demoState.keys()]) {
      if (!ids.has(key)) demoState.delete(key);
    }
  }

  function realTick(): void {
    for (const id of targets()) {
      opts.client
        .getActivity(id)
        .then((res) => {
          activity.set(id, toTicketActivity(res));
          opts.onTick();
        })
        .catch(() => {});
    }
  }

  function demoTick(): void {
    const now = new Date().toISOString();
    for (const id of targets()) {
      const st =
        demoState.get(id) ??
        { files: new Map<string, DemoFile>(), logSize: 2048, idleTicks: 0 };
      demoState.set(id, st);
      if (st.idleTicks > 0) {
        st.idleTicks -= 1;
        continue;
      }
      const edits = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < edits; i++) {
        const path =
          DEMO_FILES[Math.floor(Math.random() * DEMO_FILES.length)];
        const file = st.files.get(path) ?? { added: 0, removed: 0 };
        file.added += Math.floor(Math.random() * 24);
        file.removed += Math.floor(Math.random() * 8);
        st.files.set(path, file);
      }
      st.logSize += Math.floor(Math.random() * 4096);
      if (Math.random() < 0.2) {
        st.idleTicks = 1 + Math.floor(Math.random() * 3);
      }
      const files = [...st.files.entries()];
      activity.set(id, {
        ticketId: id,
        running: true,
        lastEventAt: now,
        log: { size: st.logSize, mtime: now },
        diff: {
          added: files.reduce((sum, [, f]) => sum + f.added, 0),
          removed: files.reduce((sum, [, f]) => sum + f.removed, 0),
          files: files.map(([path]) => path),
        },
      });
    }
  }

  function tick(): void {
    if (opts.demo) demoTick();
    else realTick();
    opts.onTick();
  }

  const timer = setInterval(
    tick,
    opts.demo ? DEMO_INTERVAL_MS : REAL_INTERVAL_MS,
  );

  return {
    activity,
    update(next) {
      snapshot = next;
      prune();
      if (!opts.demo) realTick();
    },
    dispose() {
      clearInterval(timer);
    },
  };
}
