import { h } from "../dom";
import type { TicketActivity } from "./activity";
import type { PrototypeRenderContext, PrototypeVariant } from "./index";
import "./variant-c.css";

interface FileSample {
  added: number;
  removed: number;
}

interface Sample {
  files: Map<string, FileSample>;
  logSize: number;
  at: number;
}

interface FeedEntry {
  at: number;
  text: string;
  idle: boolean;
}

const samples = new Map<string, Sample>();
const feeds = new Map<string, FeedEntry[]>();

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h_ = Math.floor(m / 60);
  return `${h_}h ${m % 60}m`;
}

function fmtClock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function updateFeed(ticketId: string, activity: TicketActivity, now: number): FeedEntry[] {
  const feed = feeds.get(ticketId) ?? [];
  feeds.set(ticketId, feed);
  const files = new Map<string, FileSample>();
  for (const f of activity.diff?.files ?? []) {
    files.set(f.path, { added: f.added, removed: f.removed });
  }
  const logSize = activity.log?.size ?? 0;
  const prev = samples.get(ticketId);
  samples.set(ticketId, { files, logSize, at: now });
  if (!prev) return feed;

  let grew = false;
  let bestPath: string | null = null;
  let bestGrow = 0;
  let bestAdded = 0;
  let bestRemoved = 0;
  for (const [path, cur] of files) {
    const old = prev.files.get(path);
    const dA = cur.added - (old?.added ?? 0);
    const dR = cur.removed - (old?.removed ?? 0);
    if (dA + dR > bestGrow) {
      bestGrow = dA + dR;
      bestPath = path;
      bestAdded = dA;
      bestRemoved = dR;
    }
  }
  if (bestPath && bestGrow > 0) {
    feed.unshift({ at: now, text: `${bestPath} +${bestAdded} −${bestRemoved}`, idle: false });
    grew = true;
  }
  if (logSize > prev.logSize) {
    feed.unshift({ at: now, text: `output +${fmtKb(logSize - prev.logSize)}`, idle: false });
    grew = true;
  }
  if (!grew && now - prev.at > 60_000) {
    if (!feed[0]?.idle) {
      feed.unshift({ at: now, text: "idle", idle: true });
    }
  }
  if (feed.length > 12) feed.length = 12;
  return feed;
}

function findDetailTicketId(root: HTMLElement): string | null {
  const detail = root.querySelector(".detail.detail-open") ?? root.querySelector(".detail");
  if (!detail) return null;
  const activeTab = detail.querySelector(".detail-tab-active");
  if (activeTab && !/progress/i.test(activeTab.textContent ?? "")) return null;
  const title = detail.querySelector(".detail-title");
  const id = title?.textContent?.trim();
  return id || null;
}

function mostRecentRunning(activity: ReadonlyMap<string, TicketActivity>): TicketActivity | null {
  let best: TicketActivity | null = null;
  let bestAt = -1;
  for (const a of activity.values()) {
    if (!a.running) continue;
    const at = Math.max(
      Date.parse(a.lastEventAt ?? "") || 0,
      Date.parse(a.log?.mtime ?? "") || 0,
    );
    if (at > bestAt) {
      bestAt = at;
      best = a;
    }
  }
  return best;
}

function buildSection(
  activity: TicketActivity,
  feed: FeedEntry[],
  now: number,
  fallback: boolean,
): HTMLElement {
  const latest = Math.max(
    Date.parse(activity.lastEventAt ?? "") || 0,
    Date.parse(activity.log?.mtime ?? "") || 0,
  );
  const stale = latest > 0 && now - latest > 60_000;
  const header =
    latest > 0
      ? stale
        ? `idle ${fmtAgo(now - latest)} — no output`
        : `last change ${fmtAgo(now - latest)} ago`
      : "no activity yet";

  const section = h(
    "div",
    { class: "protoC-feed" },
    h(
      "div",
      { class: "protoC-head" },
      h("span", { class: "protoC-title" }, "Activity"),
      fallback ? h("span", { class: "protoC-ticket" }, activity.ticketId) : null,
      h("span", { class: stale ? "protoC-last protoC-stale" : "protoC-last" }, header),
    ),
  );

  const files = [...(activity.diff?.files ?? [])]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed))
    .slice(0, 8);
  const maxTotal = Math.max(1, ...files.map((f) => f.added + f.removed));
  if (files.length) {
    const list = h("div", { class: "protoC-files" });
    for (const f of files) {
      const total = f.added + f.removed;
      const width = (total / maxTotal) * 100;
      const addW = total > 0 ? (f.added / total) * width : 0;
      const remW = total > 0 ? (f.removed / total) * width : 0;
      list.append(
        h(
          "div",
          { class: "protoC-row" },
          h("span", { class: "protoC-name", title: f.path }, basename(f.path)),
          h(
            "span",
            { class: "protoC-counts" },
            h("span", { class: "protoC-add" }, `+${f.added}`),
            " ",
            h("span", { class: "protoC-rem" }, `−${f.removed}`),
          ),
          h(
            "span",
            { class: "protoC-bar" },
            h("span", { class: "protoC-bar-add", style: `width:${addW}%` }),
            h("span", { class: "protoC-bar-rem", style: `width:${remW}%` }),
          ),
        ),
      );
    }
    section.append(list);
  }

  if (feed.length) {
    const list = h("div", { class: "protoC-events" });
    for (const e of feed) {
      list.append(
        h(
          "div",
          { class: e.idle ? "protoC-event protoC-event-idle" : "protoC-event" },
          h("span", { class: "protoC-time" }, fmtClock(e.at)),
          h("span", { class: "protoC-text" }, e.text),
        ),
      );
    }
    section.append(list);
  }
  return section;
}

function render(ctx: PrototypeRenderContext): void {
  try {
    ctx.root.querySelectorAll(".protoC-feed").forEach((el) => el.remove());
    const detail = ctx.root.querySelector(".detail");
    if (!detail) return;
    const panel = detail.querySelector(".detail-panel");
    if (!(panel instanceof HTMLElement)) return;

    let ticketId = findDetailTicketId(ctx.root);
    let activity = ticketId ? ctx.activity.get(ticketId) : undefined;
    let fallback = false;
    if (!activity) {
      activity = mostRecentRunning(ctx.activity) ?? undefined;
      if (!activity) return;
      ticketId = activity.ticketId;
      fallback = true;
    }
    const feed = updateFeed(activity.ticketId, activity, ctx.now);
    const section = buildSection(activity, feed, ctx.now, fallback);
    panel.prepend(section);
  } catch {
  }
}

export const variantC: PrototypeVariant = { key: "C", name: "Work feed", render };
