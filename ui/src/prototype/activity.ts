export interface ActivityFile {
  path: string;
  added: number;
  removed: number;
}

export interface TicketActivity {
  ticketId: string;
  running: boolean;
  lastEventAt: string | null;
  log: { size: number; mtime: string | null } | null;
  worktree: string | null;
  diff: { added: number; removed: number; files: ActivityFile[] } | null;
}
