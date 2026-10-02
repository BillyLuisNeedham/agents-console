/**
 * The lag bench's network: a TCP proxy between the browser and the pool
 * server that holds every chunk for half a round trip in each direction,
 * the way a browser on another machine (a laptop over Tailscale, say) sees
 * the server. It works below HTTP, so nothing about the client is modelled:
 * the browser's own keep-alive connections, its six-per-origin limit, the
 * snapshot stream holding one of them, all behave as they do for real, only
 * further away.
 *
 *   bun run scripts/bench-lag/proxy.ts --target <http://host:port> --rtt <ms>
 *
 * Prints `READY <http://127.0.0.1:port>`. Chunks keep their order: each is
 * written the same fixed delay after it arrived. With --rtt 0 it forwards at
 * once, so a loopback run pays the same proxy hop as a remote one. Run in a
 * process of its own so its timers never share a loop with the server's or
 * the bench's.
 *
 * It also watches every connection that upgrades to a WebSocket (issue
 * #161) and times each request the page sends on it, from the frame leaving
 * the browser to its reply being handed back to the browser, and each
 * card's subscribe to the card's first frame, both ends on this process's
 * clock: the network's view of an answer, which the page cannot have, since
 * Chromium runs the frame that paints a press before it dispatches anything
 * that arrived after it (wsframes.ts). Each trip is also given with exactly
 * the simulated round trip (`idealMs`): this process's timers fire a few ms
 * late under load, which delays a chunk past its half trip, and that delay
 * is the bench's own, not the network's or the server's. The parent asks for
 * the times, and that lateness, over IPC (`{ trips: true }`).
 */

import type { Socket } from "bun";
import { answerOf, askOf, FrameReader, headEnd } from "./wsframes.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`proxy.ts: --${name} is required`);
  return value;
}

const target = new URL(arg("target"));
const halfTripMs = Number(arg("rtt")) / 2;


/** The wall clock, which the server's and the fake herdr's timelines share. */
const wall = () => performance.timeOrigin + performance.now();

/**
 * How late this process's timers ran the half-trip writes, by direction (ms
 * past due). A timer that fires late holds a chunk longer than the round
 * trip being simulated: the bench's own delay, which a trip's `idealMs`
 * leaves out.
 */
const lateness = { up: [] as number[], down: [] as number[] };

/** One direction of a proxied connection: what is still owed to `to`. */
class Pipe {
  to: Socket<Link> | null = null;
  private backlog: Uint8Array[] = [];
  private closing = false;

  constructor(private readonly dir: "up" | "down") {}

  /** A chunk read on the other side, written half a round trip from now;
   *  `written` runs as it is handed to the socket. */
  push(chunk: Uint8Array, written?: (at: number) => void): void {
    const copy = new Uint8Array(chunk);
    const due = performance.now() + halfTripMs;
    const send = () => {
      if (halfTripMs > 0) lateness[this.dir].push(performance.now() - due);
      this.write(copy);
      written?.(performance.now());
    };
    if (halfTripMs > 0) setTimeout(send, halfTripMs);
    else send();
  }

  /** The other side closed: close this one once what it sent has gone. */
  end(): void {
    const close = () => {
      this.closing = true;
      if (this.backlog.length === 0) this.to?.end();
    };
    if (halfTripMs > 0) setTimeout(close, halfTripMs);
    else close();
  }

  write(chunk: Uint8Array): void {
    if (!this.to) {
      this.backlog.push(chunk);
      return;
    }
    if (this.backlog.length > 0) {
      this.backlog.push(chunk);
      return;
    }
    const n = this.to.write(chunk);
    if (n < chunk.byteLength) this.backlog.push(chunk.subarray(Math.max(0, n)));
  }

  /** The socket can take more: drain what queued while it could not. */
  drain(): void {
    while (this.to && this.backlog.length > 0) {
      const chunk = this.backlog[0]!;
      const n = this.to.write(chunk);
      if (n < chunk.byteLength) {
        this.backlog[0] = chunk.subarray(Math.max(0, n));
        return;
      }
      this.backlog.shift();
    }
    if (this.closing && this.backlog.length === 0) this.to?.end();
  }
}

interface Link {
  /** Browser to server. */
  up: Pipe;
  /** Server to browser. */
  down: Pipe;
  watch: Watch;
}

/**
 * A request on a socket and its reply, or a card's subscribe and the card's
 * first frame after it, as the network saw them cross.
 */
interface Trip {
  link: number;
  /** A request's kind, or "subscribe". */
  kind: string;
  /** A request's number, or the subscribed card's id. */
  id: number | string;
  /** When the browser's frame reached the proxy (wall clock, ms). */
  at: number;
  /** From the browser's frame leaving it to the answer handed back to it. */
  ms: number;
  /**
   * The same with exactly the simulated round trip: half of it each way
   * plus the time from the frame forwarded to the server to the answer
   * coming back from it, so the proxy's own timer lateness is left out.
   */
  idealMs: number;
}
const trips: Trip[] = [];

/** When a chunk was handed on, and who waits to know. */
interface Stamp {
  at: number | null;
  then: ((at: number) => void) | null;
}
const stamp = (): Stamp => ({ at: null, then: null });
const whenWritten = (sent: Stamp, run: (at: number) => void): void => {
  if (sent.at !== null) run(sent.at);
  else sent.then = run;
};

/**
 * One connection's WebSocket traffic, once its response turned out to be a
 * 101: the requests the browser sent, by number, and the cards it
 * subscribed, each timed to its answer. A plain HTTP connection is never
 * read past its first head.
 */
class Watch {
  private socket = false;
  private upHead: Uint8Array | null = new Uint8Array(0);
  private downHead: Uint8Array | null = new Uint8Array(0);
  private readonly up = new FrameReader();
  private readonly down = new FrameReader();
  /** Each outstanding ask: when it reached the proxy (local and wall clock) and when it went on to the server. */
  private readonly requests = new Map<number, Asked>();
  private readonly subscribes = new Map<string, Asked>();

  constructor(private readonly link: number) {}

  /** A chunk from the browser, which reached the proxy `at`, handed on to the server when `sent` says. */
  fromBrowser(chunk: Uint8Array, at: number, sent: Stamp): void {
    const body = this.pastHead("up", chunk);
    if (!body || !this.socket) return;
    for (const text of this.up.push(body)) {
      const ask = askOf(text);
      if (!ask) continue;
      const asked: Asked = { kind: ask.kind, at, wallAt: wall() - (performance.now() - at), forwarded: null };
      whenWritten(sent, (forwardedAt) => (asked.forwarded = forwardedAt));
      if (ask.kind === "subscribe") {
        if (!this.subscribes.has(ask.id as string)) this.subscribes.set(ask.id as string, asked);
      } else {
        this.requests.set(ask.id as number, asked);
      }
    }
  }

  /** A chunk from the server, which reached the proxy `arrived`, handed to the browser when `sent` says. */
  fromServer(chunk: Uint8Array, arrived: number, sent: Stamp): void {
    const body = this.pastHead("down", chunk);
    if (!body || !this.socket) return;
    const answers = this.down.push(body).flatMap((text) => answerOf(text) ?? []);
    if (answers.length === 0) return;
    const matched = answers.flatMap((answer) => {
      const asks = answer.kind === "reply" ? this.requests : this.subscribes;
      const asked = (asks as Map<number | string, Asked>).get(answer.id);
      if (!asked) return [];
      (asks as Map<number | string, Asked>).delete(answer.id);
      return [{ answer, asked }];
    });
    whenWritten(sent, (handedBack) => {
      for (const { answer, asked } of matched) {
        const kind = answer.kind === "reply" ? asked.kind : "subscribe";
        const serverMs = asked.forwarded === null ? arrived - asked.at : arrived - asked.forwarded;
        trips.push({
          link: this.link,
          kind,
          id: answer.id,
          at: Math.round(asked.wallAt * 10) / 10,
          ms: handedBack - asked.at,
          idealMs: 2 * halfTripMs + serverMs,
        });
      }
    });
  }

  /** The bytes past a direction's first HTTP head, null while it is still coming. */
  private pastHead(dir: "up" | "down", chunk: Uint8Array): Uint8Array | null {
    const held = dir === "up" ? this.upHead : this.downHead;
    if (held === null) return chunk;
    const joined = new Uint8Array(held.length + chunk.length);
    joined.set(held);
    joined.set(chunk, held.length);
    const end = headEnd(joined);
    if (end === -1) {
      if (dir === "up") this.upHead = joined;
      else this.downHead = joined;
      return null;
    }
    if (dir === "up") this.upHead = null;
    else {
      this.downHead = null;
      this.socket = new TextDecoder().decode(joined.subarray(0, 12)) === "HTTP/1.1 101";
    }
    return joined.subarray(end);
  }
}

interface Asked {
  kind: string;
  /** When it reached the proxy, on this process's clock and on the wall clock. */
  at: number;
  wallAt: number;
  /** When the proxy handed it on to the server. */
  forwarded: number | null;
}
let links = 0;

// Each chunk goes on its way before it is read, so the watching never
// delays the hop it times.
const server = Bun.listen<Link>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(browser) {
      const link: Link = { up: new Pipe("up"), down: new Pipe("down"), watch: new Watch(links++) };
      browser.data = link;
      link.down.to = browser;
      link.down.drain();
      void Bun.connect<Link>({
        hostname: target.hostname,
        port: Number(target.port),
        data: link,
        socket: {
          open(upstream) {
            link.up.to = upstream;
            link.up.drain();
          },
          data(_upstream, chunk) {
            const arrived = performance.now();
            const sent = stamp();
            link.down.push(chunk, (at) => {
              sent.at = at;
              sent.then?.(at);
            });
            link.watch.fromServer(chunk, arrived, sent);
          },
          drain() {
            link.up.drain();
          },
          close() {
            link.down.end();
          },
          error() {
            link.down.end();
          },
        },
      }).catch(() => browser.end());
    },
    data(browser, chunk) {
      const arrived = performance.now();
      const sent = stamp();
      browser.data.up.push(chunk, (at) => {
        sent.at = at;
        sent.then?.(at);
      });
      browser.data.watch.fromBrowser(chunk, arrived, sent);
    },
    drain(browser) {
      browser.data.down.drain();
    },
    close(browser) {
      browser.data.up.end();
    },
    error(browser) {
      browser.data.up.end();
    },
  },
});

process.on("message", (msg: unknown) => {
  if ((msg as { trips?: boolean }).trips) process.send?.({ kind: "trips", trips, lateness });
});

process.stdout.write(`READY http://127.0.0.1:${server.port}\n`);
