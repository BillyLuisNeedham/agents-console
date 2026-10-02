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
 * that arrived after it (wsframes.ts). The parent asks for the times over
 * IPC (`{ trips: true }`).
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
  /** From the browser's frame leaving it to the answer handed back to it. */
  ms: number;
}
const trips: Trip[] = [];

/** What a frame from the browser asks for: a request by number, or a card by id. */
function askOf(text: string): { kind: string; id: number | string } | null {
  const head = text.slice(0, 160);
  if (!head.includes('"request"') && !head.includes('"subscribe"')) return null;
  try {
    const m = JSON.parse(text) as { type?: unknown; id?: unknown; kind?: unknown; card?: { id?: unknown } };
    if (m.type === "request" && typeof m.id === "number" && typeof m.kind === "string") return { kind: m.kind, id: m.id };
    if (m.type === "subscribe" && typeof m.card?.id === "string") return { kind: "subscribe", id: m.card.id };
  } catch {
    // Not one of the page's frames.
  }
  return null;
}

/**
 * What a frame from the server answers: a reply by its request's number, or
 * a card by its id. Only the head is read, never the whole frame, so a
 * 64 KiB log window costs the hop nothing: the server writes `type` and
 * `id` first, as JSON.stringify keeps its message literals' order.
 */
function answerOf(text: string): { kind: "reply" | "card"; id: number | string } | null {
  const head = text.slice(0, 160);
  if (head.startsWith('{"type":"reply"')) {
    const id = /"id":(\d+)/.exec(head);
    return id ? { kind: "reply", id: Number(id[1]) } : null;
  }
  if (head.startsWith('{"type":"card"')) {
    const id = /"id":"([^"]*)"/.exec(head);
    return id ? { kind: "card", id: id[1]! } : null;
  }
  return null;
}

/** When a chunk was handed to the browser, and who waits to know. */
interface Stamp {
  at: number | null;
  then: ((at: number) => void) | null;
}

/**
 * One connection's WebSocket traffic, once its response turned out to be a
 * 101: the requests the browser sent, by number, and the cards it
 * subscribed, each timed to its answer being written back to the browser. A
 * plain HTTP connection is never read past its first head.
 */
class Watch {
  private socket = false;
  private upHead: Uint8Array | null = new Uint8Array(0);
  private downHead: Uint8Array | null = new Uint8Array(0);
  private readonly up = new FrameReader();
  private readonly down = new FrameReader();
  private readonly requests = new Map<number, { kind: string; at: number }>();
  private readonly subscribes = new Map<string, number>();

  constructor(private readonly link: number) {}

  /** A chunk from the browser, which left it `at`. */
  fromBrowser(chunk: Uint8Array, at: number): void {
    const body = this.pastHead("up", chunk);
    if (!body || !this.socket) return;
    for (const text of this.up.push(body)) {
      const ask = askOf(text);
      if (!ask) continue;
      if (ask.kind === "subscribe") {
        if (!this.subscribes.has(ask.id as string)) this.subscribes.set(ask.id as string, at);
      } else {
        this.requests.set(ask.id as number, { kind: ask.kind, at });
      }
    }
  }

  /** A chunk from the server, handed to the browser when `sent` says. */
  fromServer(chunk: Uint8Array, sent: Stamp): void {
    const body = this.pastHead("down", chunk);
    if (!body || !this.socket) return;
    const answers = this.down.push(body).flatMap((text) => answerOf(text) ?? []);
    if (answers.length === 0) return;
    const settle = (at: number) => {
      for (const answer of answers) {
        if (answer.kind === "reply") {
          const request = this.requests.get(answer.id as number);
          if (!request) continue;
          this.requests.delete(answer.id as number);
          trips.push({ link: this.link, kind: request.kind, id: answer.id, ms: at - request.at });
        } else {
          const asked = this.subscribes.get(answer.id as string);
          if (asked === undefined) continue;
          this.subscribes.delete(answer.id as string);
          trips.push({ link: this.link, kind: "subscribe", id: answer.id, ms: at - asked });
        }
      }
    };
    if (sent.at !== null) settle(sent.at);
    else sent.then = settle;
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

// Each chunk goes on its way before it is read, so the watching never
// delays the hop it times.
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
            const sent: Stamp = { at: null, then: null };
            link.down.push(chunk, () => {
              sent.at = performance.now();
              sent.then?.(sent.at);
            });
            link.watch.fromServer(chunk, sent);
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
      const at = performance.now();
      browser.data.up.push(chunk);
      browser.data.watch.fromBrowser(chunk, at);
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
