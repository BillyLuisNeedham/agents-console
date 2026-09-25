/**
 * The pane survey (issue #139): the engine's cached answer to "which herdr
 * panes and tabs are open right now", for the two things the snapshot says
 * about panes nobody is watching. A Held pane is shown only while its pane
 * is still listed, and the Finished terminals count is the tabs the pool
 * opened that are still listed. Neither has a loop of its own reading the
 * pane (an enlisted attempt and a Conversation do, a Held pane and a finished
 * tab do not), so one listing serves both.
 *
 * The snapshot is emitted far more often than panes come and go, and a
 * listing per emit would put a herdr request on every Turn tick and log
 * line. So the survey lists on a slow cadence and on demand (a pane held, a
 * bulk close done, a Continued attempt ended) and the snapshot reads the last
 * listing. Every listing is handed to the engine, which emits when what it
 * derives from it moved, so a tab the operator closes by hand leaves the
 * count and a Held pane that went leaves its card within one cadence.
 *
 * A listing the daemon cannot answer says nothing about any pane: the last
 * good listing stands, the way the enlisted ending race skips a sweep rather
 * than read an unanswered question as every pane gone.
 */

// How often the survey lists while nothing asks for a fresher answer: slow,
// because the operator closing a tab by hand is the only change it exists to
// notice on its own; everything the engine does itself refreshes on demand.
export const PANE_SURVEY_MS = 15_000;

/** One pane as herdr lists it; a field the daemon does not report is null. */
export interface ListedPane {
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  cwd: string | null;
}

export interface PaneListing {
  /** Every listed pane, by id. */
  panes: ReadonlyMap<string, ListedPane>;
  /** Every tab a listed pane sits in. */
  tabs: ReadonlySet<string>;
}

/** A pane as the engine recorded it on a `spawned` event. */
export interface RecordedPane {
  paneId: string;
  tabId: string | null;
  cwd: string | null;
}

/**
 * Whether the listing still has the pane the engine recorded, and it is the
 * same pane (issue #139): a herdr id is only an id, and a daemon that was
 * restarted, or a pane closed and its id reused, can list a different pane
 * under a recorded one. So the listed pane must sit in the recorded tab, in
 * the Pool workspace when one is named (`workspaceId`; null for a pane that
 * is the operator's and lives wherever they put it), and in the recorded
 * directory, each checked only where the listing reports it. Anything that
 * disagrees is not ours: never closed, never held.
 */
export function listedAsRecorded(
  listing: PaneListing,
  recorded: RecordedPane,
  workspaceId: string | null,
): boolean {
  const listed = listing.panes.get(recorded.paneId);
  if (!listed) return false;
  if (recorded.tabId !== null && listed.tabId !== null && listed.tabId !== recorded.tabId) {
    return false;
  }
  if (workspaceId !== null && listed.workspaceId !== null && listed.workspaceId !== workspaceId) {
    return false;
  }
  if (recorded.cwd !== null && listed.cwd !== null && trimSlash(listed.cwd) !== trimSlash(recorded.cwd)) {
    return false;
  }
  return true;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export interface PaneSurvey {
  /** The last listing the daemon answered, or null before the first. */
  latest(): PaneListing | null;
  /**
   * A listing that began after this call: callers that just changed
   * something (a claim, a close, an ending) must not be answered by one
   * that was already in flight before it. Calls made while one listing runs
   * share the single listing queued behind it. Resolves whether that
   * listing landed; when it did not, `latest` is still the last one.
   */
  refresh(): Promise<boolean>;
  /** Stop the cadence for good: the engine is shutting down. */
  stop(): void;
}

export function createPaneSurvey(options: {
  /** One listing; a throw (daemon down, malformed answer) leaves the last one standing. */
  list: () => Promise<ListedPane[]>;
  /** A listing landed; the engine decides whether it changed anything. */
  onListing: () => void;
  intervalMs?: number;
}): PaneSurvey {
  let last: PaneListing | null = null;
  let inFlight: Promise<boolean> | null = null;
  // The listing queued behind the one in flight, shared by every caller
  // that arrives while it runs: each of them needs a listing that starts
  // after its call, and one that starts after all of them serves them all.
  let queued: Promise<boolean> | null = null;
  let stopped = false;
  const listOnce = async (): Promise<boolean> => {
    let listed: ListedPane[];
    try {
      listed = await options.list();
    } catch {
      return false;
    }
    if (stopped) return false;
    const panes = new Map(listed.map((pane) => [pane.paneId, pane]));
    const tabs = new Set(listed.flatMap((pane) => (pane.tabId === null ? [] : [pane.tabId])));
    last = { panes, tabs };
    options.onListing();
    return true;
  };
  const start = (): Promise<boolean> => {
    inFlight = listOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const refresh = (): Promise<boolean> => {
    if (!inFlight) return start();
    if (!queued) {
      queued = inFlight.then(() => {
        queued = null;
        return start();
      });
    }
    return queued;
  };
  const timer = setInterval(() => {
    void refresh();
  }, options.intervalMs ?? PANE_SURVEY_MS);
  // The cadence never holds a process open by itself: a pool whose server is
  // going away does not wait fifteen seconds on a listing nobody will read.
  timer.unref?.();
  return {
    latest: () => last,
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
