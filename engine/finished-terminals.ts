/**
 * Finished terminals (issue #139, CONTEXT.md "Finished terminal"): herdr tabs
 * this pool opened that are still open over an Attempt or a Conversation that
 * has ended. The engine closes a tab only when its role ends by rule (a
 * merge, a grade landing, a selection's losers; ADR-0014's amendment), so a
 * crashed attempt's tab, a checkpointed one answered some other way, a tab
 * whose ticket was reset by hand and a done ticket's tab awaiting its merge
 * all stay open. They pile up in the operator's tab bar, and the operator
 * closes them in one go from the pool header; the engine never closes one on
 * its own.
 *
 * The set is derived, never recorded: the tabs every `spawned` event names
 * (a ticket's attempts, its resolvers, graders, the head-to-head judge, a
 * Conversation's launch), less the ones herdr no longer lists, less every tab
 * whose pane is still in use. What counts as in use is the engine's own
 * registries, handed in: a Live attempt's pane, a Held pane, a live
 * Conversation's pane. An enlisted pane is never the pool's to close
 * (ADR-0021), so its owner is left out before its events are read.
 */

import { readEvents } from "./events.ts";
import type { PaneListing } from "./pane-survey.ts";

/** One tab a `spawned` event says the engine opened. */
export interface OpenedTab {
  /** The Ticket or Conversation id whose events name it. */
  owner: string;
  tabId: string;
  /** The pane the attempt ran in: the tab's root pane. */
  paneId: string | null;
}

/**
 * Every tab the owners' `spawned` events name, once each. A Continued attempt
 * names the tab of the attempt it continues, so a tab can be named twice; the
 * later spawn's pane is kept.
 */
export function openedTabs(runsDir: string, owners: Iterable<string>): OpenedTab[] {
  const tabs = new Map<string, OpenedTab>();
  for (const owner of owners) {
    for (const event of readEvents(runsDir, owner)) {
      if (event.kind !== "spawned" || typeof event.payload.tab_id !== "string") continue;
      tabs.set(event.payload.tab_id, {
        owner,
        tabId: event.payload.tab_id,
        paneId: typeof event.payload.pane_id === "string" ? event.payload.pane_id : null,
      });
    }
  }
  return [...tabs.values()];
}

/**
 * The opened tabs that are Finished terminals: still listed by herdr (by tab,
 * or by the root pane when the daemon reports no tab ids), with neither the
 * root pane nor any other listed pane of the tab in use.
 */
export function finishedTerminals(
  opened: OpenedTab[],
  listing: PaneListing,
  busyPanes: ReadonlySet<string>,
): OpenedTab[] {
  const busyTabs = new Set<string>();
  for (const [paneId, tabId] of listing.panes) {
    if (tabId !== null && busyPanes.has(paneId)) busyTabs.add(tabId);
  }
  return opened.filter((tab) => {
    const open =
      listing.tabs.has(tab.tabId) ||
      (tab.paneId !== null && listing.panes.has(tab.paneId));
    if (!open) return false;
    if (tab.paneId !== null && busyPanes.has(tab.paneId)) return false;
    return !busyTabs.has(tab.tabId);
  });
}
