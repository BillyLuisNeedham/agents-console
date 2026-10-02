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
 */

import type { Socket } from "bun";

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

  /** A chunk read on the other side, written half a round trip from now. */
  push(chunk: Uint8Array): void {
    const copy = new Uint8Array(chunk);
    if (halfTripMs > 0) setTimeout(() => this.write(copy), halfTripMs);
    else this.write(copy);
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
}

const server = Bun.listen<Link>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(browser) {
      const link: Link = { up: new Pipe(), down: new Pipe() };
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
            link.down.push(chunk);
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

process.stdout.write(`READY http://127.0.0.1:${server.port}\n`);
