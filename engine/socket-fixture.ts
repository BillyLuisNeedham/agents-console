/**
 * A test's end of the Console's socket (issue #161): Bun's own WebSocket
 * client with every frame decoded and kept in order, the snapshot the
 * snapshot and delta frames build, and the waits a test needs on top. Lives
 * in its own module beside pool-fixture.ts for the same reason that one
 * does: the suites that drive /api/ws share one client, and importing it
 * never drags another suite's cases into the importer's run.
 */

import {
  WS_PATH,
  applyDelta,
  decodeServerMessage,
  encodeMessage,
  type CardSubscription,
  type ClientMessage,
  type PushedSnapshot,
  type Reply,
  type RequestKind,
  type RequestPayload,
  type ServerMessage,
} from "./protocol.ts";

export interface SocketClient {
  /** Every frame so far, in arrival order. */
  frames: ServerMessage[];
  /** When each frame arrived (Date.now()), beside `frames`. */
  times: number[];
  /** The snapshot the frames so far build; null before the pool started. */
  pushed: PushedSnapshot | null;
  /** The revision the frames so far build. */
  rev: number;
  /** The snapshot's `seq` after each snapshot or delta frame. */
  seqs: number[];
  send(message: ClientMessage): void;
  /** A request under the next id, and its reply. */
  request<K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<Reply<K>>;
  /** A round trip: every frame the server sent ahead of it is in hand. */
  sync(): Promise<void>;
  /** The first frame at or after `from` (default 0) that matches. */
  waitFor<T extends ServerMessage = ServerMessage>(
    match: (frame: ServerMessage) => boolean,
    options?: { from?: number; ms?: number; what?: string },
  ): Promise<T>;
  /** How the server closed the socket. */
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

/** Opens a socket on a pool server, once it is open. With `hello`, the
 *  client's hello goes first, as the Console's does. `headers` go on the
 *  upgrade request (Bun's client sends no Origin unless given one). */
export async function openSocket(
  base: string,
  hello?: { visible: boolean; cards?: CardSubscription[] },
  headers?: Record<string, string>,
): Promise<SocketClient> {
  const url = `${base.replace(/^http/, "ws")}${WS_PATH}`;
  // Bun's client takes `{headers}` where a browser's takes protocols; the
  // DOM's constructor type is the one in scope here.
  const ws = headers
    ? new WebSocket(url, { headers } as unknown as string[])
    : new WebSocket(url);
  const waiters = new Set<() => void>();
  let nextId = 0;
  let resolveClosed: (value: { code: number; reason: string }) => void = () => {};
  const client: SocketClient = {
    frames: [],
    times: [],
    pushed: null,
    rev: 0,
    seqs: [],
    send: (message) => ws.send(encodeMessage(message)),
    async request(kind, payload) {
      const id = ++nextId;
      const from = client.frames.length;
      client.send({ type: "request", id, kind, payload } as ClientMessage);
      return client.waitFor(
        (frame) => frame.type === "reply" && frame.id === id,
        { from, what: `the reply to ${kind}` },
      );
    },
    async sync() {
      await client.request("poolLog.read", { before: 0 });
    },
    waitFor(match, options = {}) {
      const from = options.from ?? 0;
      const ms = options.ms ?? 10_000;
      return new Promise((resolve, reject) => {
        const look = (): boolean => {
          for (let i = from; i < client.frames.length; i++) {
            if (match(client.frames[i]!)) {
              waiters.delete(look);
              clearTimeout(timer);
              resolve(client.frames[i] as never);
              return true;
            }
          }
          return false;
        };
        const timer = setTimeout(() => {
          waiters.delete(look);
          reject(new Error(`timed out waiting for ${options.what ?? "a frame"}`));
        }, ms);
        if (!look()) waiters.add(look);
      });
    },
    closed: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
    close: () => ws.close(),
  };
  ws.onmessage = (event) => {
    const frame = decodeServerMessage(String(event.data));
    if (frame.type === "snapshot") {
      client.pushed =
        frame.snapshot === null
          ? null
          : { rev: frame.rev, logTotal: frame.logTotal, snapshot: frame.snapshot };
      client.rev = frame.rev;
      if (frame.snapshot !== null) client.seqs.push(frame.snapshot.seq);
    } else if (frame.type === "delta") {
      client.pushed = applyDelta(client.pushed!, frame.delta);
      client.rev = frame.delta.rev;
      client.seqs.push(client.pushed.snapshot.seq);
    }
    client.frames.push(frame);
    client.times.push(Date.now());
    for (const look of [...waiters]) look();
  };
  ws.onclose = (event) => resolveClosed({ code: event.code, reason: event.reason });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`socket to ${base} failed to open`));
  });
  if (hello) client.send({ type: "hello", protocol: 1, visible: hello.visible, cards: hello.cards ?? [] });
  return client;
}

/** The frames of one type, typed. */
export function framesOf<T extends ServerMessage["type"]>(
  client: SocketClient,
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return client.frames.filter((frame) => frame.type === type) as Extract<ServerMessage, { type: T }>[];
}
