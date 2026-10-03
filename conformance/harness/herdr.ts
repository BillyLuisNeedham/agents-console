/**
 * The fake herdr a case runs beside its server: the executing fake as its
 * own process (conformance/fixtures/herdr-process.ts), so the server reaches
 * it over HERDR_SOCKET_PATH exactly as it reaches a live daemon. Every call
 * the server makes on that socket is streamed back here as it lands, which
 * makes "the calls on the herdr socket" something a case can observe.
 */

import { join } from "node:path";
import type { ExecutingFakeHerdrOptions } from "../fixtures/herdr-executing-fake.ts";

const PROCESS = join(import.meta.dir, "..", "fixtures", "herdr-process.ts");

/** One call the server made on the herdr socket. */
export interface HerdrCall {
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrProcess {
  socketPath: string;
  /** Every call the server has made so far, in arrival order. */
  calls: HerdrCall[];
  /** The first call at or after index `from` that matches, waiting up to `ms`. */
  waitForCall(match: (call: HerdrCall) => boolean, options?: { from?: number; ms?: number }): Promise<HerdrCall>;
  /**
   * Drive one of the fake's controls (herdr-process.ts lists them):
   * `setPaneContent`, `endPane`, `workspaceIds` and the rest.
   */
  control<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
  stop(): Promise<void>;
}

/** The fake's options a process can be handed: everything but the callback. */
export type HerdrOptions = Omit<ExecutingFakeHerdrOptions, "onRequest">;

export async function startHerdr(env: Record<string, string>, options: HerdrOptions = {}): Promise<HerdrProcess> {
  const proc = Bun.spawn([process.execPath, "run", PROCESS, "--options", JSON.stringify(options)], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls: HerdrCall[] = [];
  const replies = new Map<number, (reply: { ok: boolean; value?: unknown; error?: string }) => void>();
  const waiters = new Set<() => void>();
  let socketPath: string | null = null;
  let onReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });

  const read = (line: string): void => {
    if (line.startsWith("READY ")) {
      socketPath = line.slice("READY ".length);
      onReady();
    } else if (line.startsWith("REQUEST ")) {
      calls.push(JSON.parse(line.slice("REQUEST ".length)) as HerdrCall);
      for (const look of [...waiters]) look();
    } else if (line.startsWith("REPLY ")) {
      const space = line.indexOf(" ", "REPLY ".length);
      const id = JSON.parse(line.slice("REPLY ".length, space)) as number;
      replies.get(id)?.(JSON.parse(line.slice(space + 1)));
      replies.delete(id);
    }
  };
  void (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        read(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
  })();

  const started = await Promise.race([
    ready.then(() => true),
    proc.exited.then(() => false),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!started || socketPath === null) {
    proc.kill("SIGKILL");
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`the fake herdr did not come up:\n${stderr}`);
  }

  let nextId = 0;
  return {
    socketPath,
    calls,
    waitForCall(match, options = {}) {
      const from = options.from ?? 0;
      return new Promise((resolve, reject) => {
        const look = (): boolean => {
          const found = calls.slice(from).find(match);
          if (!found) return false;
          waiters.delete(look);
          clearTimeout(timer);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(look);
          reject(new Error(`no matching herdr call in ${options.ms ?? 10_000} ms`));
        }, options.ms ?? 10_000);
        if (!look()) waiters.add(look);
      });
    },
    control(name, ...args) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        replies.set(id, (reply) => (reply.ok ? resolve(reply.value as never) : reject(new Error(reply.error))));
        proc.stdin.write(`${JSON.stringify({ id, call: name, args })}\n`);
        proc.stdin.flush();
      });
    },
    async stop() {
      try {
        proc.stdin.end();
      } catch {
        // Already closed: the process is on its way out.
      }
      const stopped = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
      if (!stopped) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    },
  };
}
