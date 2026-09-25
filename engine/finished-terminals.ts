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
 * whose pane is still in use or is anyone's enlisted pane, less every tab
 * herdr now lists differently from how the engine recorded it. What is
 * untouchable is the engine's to say and handed in: a Live attempt's pane, a
 * Held pane, any Conversation's pane, and every pane and tab any enlisted
 * Ticket or Conversation names. That last is not only the enlisted owners'
 * own tabs: an operator can enlist a finished tab's still-live agent as a new
 * Ticket, and from then on that tab is theirs (ADR-0021), whoever opened it.
 */

import { readEvents, type TicketEvent } from "./events.ts";
import { listedAsRecorded, type PaneListing } from "./pane-survey.ts";

/** One tab a `spawned` event says the engine opened. */
export interface OpenedTab {
  /** The Ticket or Conversation id whose events name it. */
  owner: string;
  tabId: string;
  /** The pane the attempt ran in: the tab's root pane. */
  paneId: string | null;
  /** Where the attempt ran, as the event recorded it. */
  cwd: string | null;
  /** herdr's never-reused terminal id, when the spawn recorded one. */
  terminalId: string | null;
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
        cwd: typeof event.payload.cwd === "string" ? event.payload.cwd : null,
        terminalId:
          typeof event.payload.terminal_id === "string" ? event.payload.terminal_id : null,
      });
    }
  }
  return [...tabs.values()];
}

/** Panes and tabs a close must never touch: in use, or someone's enlisted. */
export interface Untouchable {
  panes: ReadonlySet<string>;
  tabs: ReadonlySet<string>;
}

/**
 * The opened tabs that are Finished terminals: herdr still lists the tab's
 * root pane as the engine recorded it (listedAsRecorded: the same tab, the
 * Pool workspace, the recorded directory), and neither that pane, the tab,
 * nor any other listed pane in the tab is untouchable. A tab whose root pane
 * was never recorded cannot be checked, so it is never one.
 */
export function finishedTerminals(
  opened: OpenedTab[],
  listing: PaneListing,
  untouchable: Untouchable,
  workspaceId: string | null,
): OpenedTab[] {
  const heldTabs = new Set(untouchable.tabs);
  for (const pane of listing.panes.values()) {
    if (pane.tabId !== null && untouchable.panes.has(pane.paneId)) heldTabs.add(pane.tabId);
  }
  return opened.filter((tab) => {
    if (tab.paneId === null) return false;
    const recorded = { paneId: tab.paneId, tabId: tab.tabId, cwd: tab.cwd, terminalId: tab.terminalId };
    if (!listedAsRecorded(listing, recorded, workspaceId)) {
      return false;
    }
    if (untouchable.panes.has(tab.paneId)) return false;
    return !heldTabs.has(tab.tabId);
  });
}

/**
 * Whether the events record this tab as closed already (a `tab-closed`
 * event), so no closer asks herdr again. Matched by herdr's terminal id when
 * both the spawn and the close carry one, because the short tab id can be
 * reused by a later tab; by tab id otherwise.
 */
export function tabRecordedClosed(
  events: TicketEvent[],
  tabId: string,
  terminalId: string | null,
): boolean {
  return events.some((event) => {
    if (event.kind !== "tab-closed") return false;
    const closedTerminal = event.payload.terminal_id;
    if (terminalId !== null && typeof closedTerminal === "string") {
      return closedTerminal === terminalId;
    }
    return event.payload.tab_id === tabId;
  });
}
