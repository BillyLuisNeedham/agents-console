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

export interface PaneListing {
  /** Every listed pane, with the tab it sits in (null when not reported). */
  panes: ReadonlyMap<string, string | null>;
  /** Every tab a listed pane sits in. */
  tabs: ReadonlySet<string>;
}

export interface PaneSurvey {
  /** The last listing the daemon answered, or null before the first. */
  latest(): PaneListing | null;
  /** List now; concurrent calls share the one listing in flight. */
  refresh(): Promise<void>;
  /** Stop the cadence for good: the engine is shutting down. */
  stop(): void;
}

export function createPaneSurvey(options: {
  list: () => Promise<{ paneId: string; tabId: string | null }[]>;
  /** A listing landed; the engine decides whether it changed anything. */
  onListing: () => void;
  intervalMs?: number;
}): PaneSurvey {
  let last: PaneListing | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let listed: { paneId: string; tabId: string | null }[];
      try {
        listed = await options.list();
      } catch {
        return;
      }
      if (stopped) return;
      const panes = new Map(listed.map((pane) => [pane.paneId, pane.tabId]));
      const tabs = new Set(
        listed.flatMap((pane) => (pane.tabId === null ? [] : [pane.tabId])),
      );
      last = { panes, tabs };
      options.onListing();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
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
