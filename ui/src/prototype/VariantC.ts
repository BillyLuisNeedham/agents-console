// PROTOTYPE — throwaway. Variant C "Phase hero" for issue #11 (see ticket details).
/**
 * Adaptive phase hero: the Detail's whole shape shifts with the ticket's
 * lifecycle phase, derived from detail.status plus any pending interrupt.
 *
 *   BEFORE  (ready, no interrupt) — "Read the work": the ticket body IS the
 *           hero, so the work is understood before it starts.
 *   DURING  (in-progress / checkpoint / interrupt) — "What's happening now":
 *           the latest timeline event and attempt count as headline stats,
 *           and any pending interrupt rendered inside the hero behind a red
 *           left border so the required action is unmissable.
 *   AFTER   (done) — "What shipped": the outcome summary and a dim commit
 *           chip.
 *
 * A compact facts grid (blocked by, timeline) always follows the hero.
 */

import { h, renderInterrupt, renderTimelineSection, statusLabel } from "../view";
import type { TicketDetailView, TimelineEventView, TimelineView } from "../project";

export interface VariantProps {
  detail: TicketDetailView;
  body: string | null;
  timeline: TimelineView | null;
  onAnswer: (ticketId: string, action: string, note?: string) => void;
}

export const variantName = "Phase hero";

type Phase = "before" | "during" | "after";

const HERO_TITLE: Record<Phase, string> = {
  before: "Read the work",
  during: "What's happening now",
  after: "What shipped",
};

function phaseOf(detail: TicketDetailView): Phase {
  if (detail.status === "done") return "after";
  if (
    detail.status === "in-progress" ||
    detail.status === "checkpoint" ||
    detail.interrupt
  ) {
    return "during";
  }
  return "before";
}

// ---------------------------------------------------------------------------
// One shared <style> block, injected once (module-level guard). Tokens match
// styles.css; every class is prefixed proto-c- so this sheet can never collide
// with the app's own. styles.css is owned by another agent and stays untouched.
// ---------------------------------------------------------------------------

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.proto-c-root {
  background: #0b0e14;
  color: #d4dae4;
  font: 13px/1.55 ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  padding: 12px 14px 18px;
}
.proto-c-hero {
  background: #12161f;
  border: 1px solid #232a3b;
  border-top-width: 2px;
  border-radius: 6px;
  padding: 12px 14px 14px;
}
.proto-c-hero-before { border-top-color: #4cc2ff; }
.proto-c-hero-during { border-top-color: #d29922; }
.proto-c-hero-during-alert { border-top-color: #f85149; }
.proto-c-hero-after { border-top-color: #3fb950; }
.proto-c-kicker {
  color: #7d8597;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
}
.proto-c-hero-title {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.proto-c-hero-title-before { color: #4cc2ff; }
.proto-c-hero-title-during { color: #d29922; }
.proto-c-hero-title-during-alert { color: #f85149; }
.proto-c-hero-title-after { color: #3fb950; }
.proto-c-hero-body {
  margin: 0;
  padding: 10px 12px;
  background: #1a2030;
  border: 1px solid #232a3b;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow: auto;
}
.proto-c-dim { color: #7d8597; }
.proto-c-stats {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.proto-c-stat {
  flex: 1;
  min-width: 0;
  background: #1a2030;
  border: 1px solid #232a3b;
  border-radius: 4px;
  padding: 7px 10px;
}
.proto-c-stat-label {
  color: #7d8597;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.proto-c-stat-value {
  margin-top: 2px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proto-c-interrupt {
  border-left: 3px solid #f85149;
  margin-top: 12px;
  padding-left: 10px;
}
.proto-c-facts {
  margin-top: 10px;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 12px;
  align-items: start;
}
.proto-c-fact-label {
  color: #7d8597;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-top: 2px;
}
.proto-c-fact-value { min-width: 0; }
.proto-c-fact-full { grid-column: 1 / -1; }
.proto-c-commit {
  display: inline-block;
  color: #7d8597;
  background: #1a2030;
  border: 1px solid #232a3b;
  border-radius: 3px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 18px;
}
.proto-c-details {
  border: 1px solid #232a3b;
  border-radius: 4px;
  background: #12161f;
}
.proto-c-details summary {
  cursor: pointer;
  color: #d4dae4;
  padding: 6px 10px;
  user-select: none;
}
.proto-c-details summary:hover { color: #ffffff; }
.proto-c-details[open] summary { border-bottom: 1px solid #232a3b; }
.proto-c-details .timeline { margin-top: 6px; padding: 0 10px 10px; }
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------

/** Drop a leading line-1 `<!-- ... -->` marker from the raw ticket body. */
function stripBodyMarker(body: string): string {
  return body.trimStart().replace(/^<!--[\s\S]*?-->\s*/, "").trim();
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

/** The last event of the last attempt: the freshest thing the ticket did. */
function latestEvent(timeline: TimelineView | null): TimelineEventView | null {
  if (!timeline || timeline.attempts.length === 0) return null;
  const last = timeline.attempts[timeline.attempts.length - 1];
  return last.events.length > 0 ? last.events[last.events.length - 1] : null;
}

// ---------------------------------------------------------------------------
// Per-phase hero content
// ---------------------------------------------------------------------------

/** BEFORE: the ticket body IS the hero. */
function renderBeforeBody(body: string | null): Node {
  if (body == null) {
    return h("div", { class: "proto-c-dim" }, "loading ticket body…");
  }
  const stripped = stripBodyMarker(body);
  return stripped.length > 0
    ? h("pre", { class: "proto-c-hero-body" }, stripped)
    : h("div", { class: "proto-c-dim" }, "(no ticket body)");
}

/** DURING: latest event + attempt count as headline stats. */
function renderDuringStats(timeline: TimelineView | null): HTMLElement {
  const event = latestEvent(timeline);
  const attempts = timeline ? timeline.attempts.length : 0;
  return h(
    "div",
    { class: "proto-c-stats" },
    h(
      "div",
      { class: "proto-c-stat" },
      h("div", { class: "proto-c-stat-label" }, "latest event"),
      event
        ? h("div", { class: "proto-c-stat-value" }, `${event.kind} · ${formatEventTime(event.at)}`)
        : h("div", { class: "proto-c-stat-value proto-c-dim" }, "no events yet"),
    ),
    h(
      "div",
      { class: "proto-c-stat" },
      h("div", { class: "proto-c-stat-label" }, "attempts"),
      attempts > 0
        ? h("div", { class: "proto-c-stat-value" }, String(attempts))
        : h("div", { class: "proto-c-stat-value proto-c-dim" }, "none yet"),
    ),
  );
}

/** AFTER: the outcome summary and a dim commit chip. */
function renderAfterBody(detail: TicketDetailView): HTMLElement {
  const summary = detail.outcome?.summary;
  const sha = detail.outcome?.commitSha;
  return h(
    "div",
    {},
    summary
      ? h("pre", { class: "proto-c-hero-body" }, summary)
      : h("div", { class: "proto-c-dim" }, "no outcome recorded"),
    h(
      "div",
      { style: "margin-top:8px" },
      sha
        ? h("span", { class: "proto-c-commit" }, `commit ${sha}`)
        : h("span", { class: "proto-c-dim" }, "no commit recorded"),
    ),
  );
}

// ---------------------------------------------------------------------------
// Compact facts grid below the hero
// ---------------------------------------------------------------------------

function renderFacts(props: VariantProps): HTMLElement {
  const { detail, timeline } = props;
  const phase = phaseOf(detail);
  const facts = h("div", { class: "proto-c-facts" });

  facts.append(
    h("div", { class: "proto-c-fact-label" }, "blocked by"),
    h(
      "div",
      { class: "proto-c-fact-value" },
      detail.blockedBy.length > 0 ? detail.blockedBy.join(", ") : "none",
    ),
  );

  if (timeline && timeline.attempts.length > 0) {
    if (phase === "after") {
      // Collapsed by default: the outcome is the story, the timeline is detail.
      facts.append(
        h(
          "div",
          { class: "proto-c-fact-full" },
          h(
            "details",
            { class: "proto-c-details" },
            h("summary", {}, "timeline"),
            renderTimelineSection(timeline),
          ),
        ),
      );
    } else {
      facts.append(h("div", { class: "proto-c-fact-full" }, renderTimelineSection(timeline)));
    }
  } else if (phase === "before") {
    facts.append(
      h("div", { class: "proto-c-fact-label" }, "timeline"),
      h(
        "div",
        { class: "proto-c-fact-value proto-c-dim" },
        "no timeline yet — appears once the work starts",
      ),
    );
  } else {
    facts.append(
      h("div", { class: "proto-c-fact-label" }, "timeline"),
      h(
        "div",
        { class: "proto-c-fact-value proto-c-dim" },
        timeline && timeline.attempts.length === 0 ? "no attempts yet" : "no timeline yet",
      ),
    );
  }

  return facts;
}

// ---------------------------------------------------------------------------

export function VariantC(props: VariantProps): HTMLElement {
  ensureStyle();
  const phase = phaseOf(props.detail);
  const alert = phase === "during" && props.detail.interrupt != null;
  const heroMod = alert ? "proto-c-hero-during-alert" : `proto-c-hero-${phase}`;
  const titleMod = alert
    ? "proto-c-hero-title-during-alert"
    : `proto-c-hero-title-${phase}`;

  const hero = h(
    "div",
    { class: `proto-c-hero ${heroMod}` },
    h(
      "div",
      { class: "proto-c-kicker" },
      `${props.detail.ticketId} · ${statusLabel(props.detail.status)}`,
    ),
    h("h2", { class: `proto-c-hero-title ${titleMod}` }, HERO_TITLE[phase]),
  );

  if (phase === "before") {
    hero.append(renderBeforeBody(props.body));
  } else if (phase === "during") {
    hero.append(renderDuringStats(props.timeline));
    if (props.detail.interrupt) {
      // renderInterrupt wants view.Handlers (action: InterruptAction); the
      // prototype's looser string action is compatible, so the targeted `as
      // any` cast keeps tsc quiet — sanctioned for prototypes.
      hero.append(
        h(
          "div",
          { class: "proto-c-interrupt" },
          renderInterrupt(props.detail.interrupt, { onAnswer: props.onAnswer } as any),
        ),
      );
    }
  } else {
    hero.append(renderAfterBody(props.detail));
  }

  return h("div", { class: "proto-c-root" }, hero, renderFacts(props));
}
