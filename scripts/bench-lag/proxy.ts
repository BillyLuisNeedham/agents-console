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
 * the browser to its reply being handed back to the browser, both on this
 * process's clock: the network's view of an answer, which the page cannot
 * have, since Chromium runs the frame that paints a press before it
 * dispatches anything that arrived after it (wsframes.ts). The parent asks
 * for the times over IPC (`{ trips: true }`).
 */

import type { Socket } from "bun";
import { FrameReader, headEnd } from "./wsframes.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`proxy.ts: --${name} is required`);
  return value;
}

const target = new URL(arg("target"));
const halfTripMs = Number(arg("rtt")) / 2;

/** One direction of a proxied connection: what is still owed to `to`. */
class Pipe {
  to: Socket<Link> | null = null;
  private backlog: Uint8Array[] = [];
  private closing = false;

  /** A chunk read on the other side, written half a round trip from now;
   *  `written` runs as it is handed to the socket. */
  push(chunk: Uint8Array, written?: () => void): void {
    const copy = new Uint8Array(chunk);
    const send = () => {
      this.write(copy);
      written?.();
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

/** A request on a socket and its reply, as the network saw them. */
interface Trip {
  link: number;
  id: number;
  kind: string;
  /** From the request frame leaving the browser to its reply handed back to it. */
  ms: number;
}
const trips: Trip[] = [];

/** A frame's envelope when it is one of `type`, else null; only small heads are looked into. */
function envelopeOf(text: string, type: "request" | "reply"): { id: number; kind: string } | null {
  if (!text.slice(0, 120).includes(`"${type}"`)) return null;
  try {
    const m = JSON.parse(text) as { type?: unknown; id?: unknown; kind?: unknown };
    return m.type === type && typeof m.id === "number" && typeof m.kind === "string" ? { id: m.id, kind: m.kind } : null;
  } catch {
    return null;
  }
}

/**
 * One connection's WebSocket traffic, once its response turned out to be a
 * 101: the requests the browser sent, by number, and each one's reply timed
 * as it is written back to the browser. A plain HTTP connection is never
 * read past its first head.
 */
class Watch {
  private socket = false;
  private upHead: Uint8Array | null = new Uint8Array(0);
  private downHead: Uint8Array | null = new Uint8Array(0);
  private readonly up = new FrameReader();
  private readonly down = new FrameReader();
  private readonly asked = new Map<number, { kind: string; at: number }>();

  constructor(private readonly link: number) {}

  fromBrowser(chunk: Uint8Array): void {
    const at = performance.now();
    const body = this.pastHead("up", chunk);
    if (!body || !this.socket) return;
    for (const text of this.up.push(body)) {
      const request = envelopeOf(text, "request");
      if (request) this.asked.set(request.id, { kind: request.kind, at });
    }
  }

  /** What to run once the chunk is written to the browser, if it carries replies. */
  fromServer(chunk: Uint8Array): (() => void) | undefined {
    const body = this.pastHead("down", chunk);
    if (!body || !this.socket) return undefined;
    const replies = this.down.push(body).flatMap((text) => envelopeOf(text, "reply") ?? []);
    if (replies.length === 0) return undefined;
    return () => {
      const at = performance.now();
      for (const reply of replies) {
        const request = this.asked.get(reply.id);
        if (!request) continue;
        this.asked.delete(reply.id);
        trips.push({ link: this.link, id: reply.id, kind: reply.kind, ms: at - request.at });
      }
    };
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
let links = 0;

const server = Bun.listen<Link>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(browser) {
      const link: Link = { up: new Pipe(), down: new Pipe(), watch: new Watch(links++) };
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
            link.down.push(chunk, link.watch.fromServer(chunk));
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
      browser.data.watch.fromBrowser(chunk);
      browser.data.up.push(chunk);
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
  if ((msg as { trips?: boolean }).trips) process.send?.({ kind: "trips", trips });
});

process.stdout.write(`READY http://127.0.0.1:${server.port}\n`);
