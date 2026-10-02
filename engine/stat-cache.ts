/**
 * File reads the engine repeats on every snapshot (issue #157): the Ticket
 * and Conversation files, the events files, the git refs behind the Merge
 * hold. Each is re-derived from disk on purpose, so a file written by hand
 * or by another process is seen at the next read; what this module saves is
 * the re-read and re-parse of a file that has not changed since.
 *
 * A file's stamp is what `stat` says about it: device, inode, size, and the
 * modification and change times. Any write moves the times, and git's
 * lockfile-and-rename moves the inode as well. The one write a stamp can
 * miss is one that lands within the filesystem's timestamp granularity of
 * the read it would invalidate, with the size unchanged (git calls this the
 * racy case). So a file modified within RACY_MS of now has no stamp: its
 * readers read it afresh every time until it has been quiet that long, and
 * a stamp taken before a read can never vouch for a write that came after
 * it.
 */

import { type Stats, statSync } from "node:fs";

/** How long a file must have been quiet before its stamp is trusted. */
export const RACY_MS = 2_000;

/**
 * The file's stamp: "absent" when there is nothing at the path, null when it
 * changed too recently to vouch for (the racy case above).
 */
export function fileStamp(path: string, now: number = Date.now()): string | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return "absent";
  }
  return stampOf(stat, now);
}

/** The stamp of a file already stat'd: null in the racy case. */
export function stampOf(stat: Stats, now: number = Date.now()): string | null {
  if (stat.mtimeMs > now - RACY_MS) return null;
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/**
 * `read` behind a per-path cache keyed on the file's stamp. The stamp is
 * taken before the read, so a write racing the read leaves the entry under a
 * stamp the next call no longer matches. A read that throws is not cached:
 * the next call reads again and throws again, the way the bare read would.
 * Every caller gets its own copy, so a caller that edits what it was handed
 * never edits the cache.
 */
export function cachedByStamp<T>(read: (path: string) => T): (path: string) => T {
  const entries = new Map<string, { stamp: string; value: T }>();
  return (path) => {
    const stamp = fileStamp(path);
    const hit = entries.get(path);
    if (stamp !== null && hit?.stamp === stamp) return structuredClone(hit.value);
    const value = read(path);
    if (stamp === null || stamp === "absent") entries.delete(path);
    else entries.set(path, { stamp, value: structuredClone(value) });
    return value;
  };
}
