/**
 * The lag bench's timelines (issue #161): what the pool server and the fake
 * herdr (herdr.ts) did, each mark on the wall clock the proxy
 * (proxy.ts) shares, and the reading of them beside an answer the proxy
 * timed as slow: whether the proxy's own timers, the server's handling, the
 * fake herdr, or something holding the server's loop took the time.
 */

/** A moment of note in a process: when (wall clock, ms), what, for how long, and of what. */
export interface Mark {
  at: number;
  what: string;
  ms: number;
  detail: string;
}

/** A request or a card's subscribe as the proxy timed it. */
export interface WireTrip {
  kind: string;
  id: number | string;
  /** When the browser's frame reached the proxy (wall clock, ms). */
  at: number;
  /** From the browser's frame leaving it to the answer handed back to it. */
  ms: number;
  /** The same with exactly the simulated round trip: the proxy's timer lateness left out. */
  idealMs: number;
}

export interface SlowAnswer {
  kind: string;
  id: number | string;
  at: number;
  ms: number;
  idealMs: number;
  /** The server's handler getting the frame, to the answer sent; null when either went unmarked. */
  serverMs: number | null;
  /** Open in herdr: the server getting the request (the proxy, when the server keeps no timeline), to
   *  the fake herdr getting its pane.focus. */
  toHerdrMs: number | null;
  /** What else the server and the fake herdr did meanwhile: late wakes, long callbacks, spawns. */
  meanwhile: Mark[];
}

const isFrameMark = (m: Mark) => m.what.startsWith("got ") || m.what.startsWith("sent ") || m.what === "herdr got";

/** Every trip at or over `limitMs`, read against the two timelines. */
export function slowAnswers(trips: WireTrip[], server: Mark[], herdr: Mark[], limitMs: number): SlowAnswer[] {
  return trips
    .filter((t) => t.ms >= limitMs)
    .map((t) => {
      const asked = t.kind === "subscribe" ? "got subscribe" : `got ${t.kind}`;
      const answered = t.kind === "subscribe" ? "sent card" : "sent reply";
      const id = String(t.id);
      const got = server.find((m) => m.what === asked && m.detail === id && m.at >= t.at - 5 && m.at <= t.at + t.ms);
      const sent = got ? server.find((m) => m.what === answered && m.detail === id && m.at >= got.at) : undefined;
      // A server with no timeline (the Rust one) marks no "got": the herdr call is then timed from
      // the frame reaching the proxy, within the trip.
      const askedAt = got?.at ?? t.at;
      const focused =
        t.kind === "terminal.focus"
          ? herdr.find(
              (m) => m.what === "herdr got" && m.detail === "pane.focus" && m.at >= askedAt && (got || m.at <= t.at + t.ms),
            )
          : undefined;
      const from = (got?.at ?? t.at) - 1;
      const to = sent?.at ?? t.at + t.ms;
      const meanwhile = [...server, ...herdr]
        .filter((m) => !isFrameMark(m) && m.at < to && m.at + m.ms > from)
        .sort((a, b) => a.at - b.at);
      return {
        kind: t.kind,
        id: t.id,
        at: t.at,
        ms: round(t.ms),
        idealMs: round(t.idealMs),
        serverMs: got && sent ? round(sent.at - got.at) : null,
        toHerdrMs: focused ? round(focused.at - askedAt) : null,
        meanwhile,
      };
    });
}

const round = (x: number) => Math.round(x * 10) / 10;

/** One slow answer on a line. */
export function describeSlow(s: SlowAnswer): string {
  const parts = [
    `${s.kind} ${s.id}: ${s.ms} ms (proxy timers ${round(s.ms - s.idealMs)} ms)`,
    `server ${s.serverMs ?? "?"} ms`,
  ];
  if (s.kind === "terminal.focus") parts.push(`to herdr ${s.toHerdrMs ?? "?"} ms`);
  const meanwhile = s.meanwhile.map((m) => `${m.what} ${m.ms} ms${m.detail ? ` (${m.detail})` : ""}`);
  parts.push(meanwhile.length ? `meanwhile ${meanwhile.join(", ")}` : "nothing else marked");
  return parts.join("; ");
}
