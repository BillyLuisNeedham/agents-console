/**
 * The executing fake herdr as its own process (ADR-0036), so a server under
 * test reaches it the way it reaches a live daemon: over HERDR_SOCKET_PATH,
 * from another process. The conformance harness starts one per case that
 * wants herdr (conformance/harness/herdr.ts) and drives it over stdio:
 *
 *   bun run conformance/fixtures/herdr-process.ts [--options <json>]
 *
 * `--options` is the fake's ExecutingFakeHerdrOptions, less the callback.
 * Every line on stdout is one of:
 *
 *   READY <socket path>          once, when the socket listens
 *   REQUEST <json>               each call the daemon receives, in order:
 *                                {"method": ..., "params": {...}}
 *   REPLY <id> <json>            the answer to a control line:
 *                                {"ok": true, "value": ...} or
 *                                {"ok": false, "error": "..."}
 *
 * Each stdin line is a control: {"id": <n>, "call": <name>, "args": [...]},
 * naming one of the fake's controls below. The pane commands the fake runs
 * inherit this process's environment, as a live daemon's panes inherit the
 * operator's, so the harness starts it with the same PATH and fences the
 * server gets. Stdin closing, SIGTERM or SIGINT closes the fake and exits.
 */

import {
  startExecutingFakeHerdr,
  type ExecutingFakeHerdr,
  type ExecutingFakeHerdrOptions,
} from "./herdr-executing-fake.ts";

type Control = (fake: ExecutingFakeHerdr, args: unknown[]) => unknown;

/** The controls a harness may call, by name. */
const CONTROLS: Record<string, Control> = {
  setPaneContent: (fake, [paneId, text]) => fake.setPaneContent(String(paneId), String(text)),
  endPane: (fake, [paneId]) => fake.endPane(String(paneId)),
  dropPaneInput: (fake, [paneId, count]) => fake.dropPaneInput(String(paneId), Number(count)),
  injectPane: (fake, [paneId, options]) =>
    fake.injectPane(String(paneId), options as Parameters<ExecutingFakeHerdr["injectPane"]>[1]),
  seedAgent: (fake, [seed]) => fake.seedAgent(seed as Parameters<ExecutingFakeHerdr["seedAgent"]>[0]),
  removeWorkspace: (fake, [workspaceId]) => fake.removeWorkspace(String(workspaceId)),
  failNextCall: (fake, [method, times]) =>
    fake.failNextCall(String(method), times === undefined ? undefined : Number(times)),
  /** Refuse a method from now on (`on` true) or answer it again (false). */
  fail: (fake, [method, on]) => {
    if (on === false) fake.fail.delete(String(method));
    else fake.fail.add(String(method));
  },
  workspaceIds: (fake) => fake.workspaceIds(),
  workspaceLabel: (fake, [workspaceId]) => fake.workspaceLabel(String(workspaceId)),
  tabLabel: (fake, [tabId]) => fake.tabLabel(String(tabId)),
  submitted: (fake) => fake.submitted,
};

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

const raw = option("--options");
const options = (raw ? JSON.parse(raw) : {}) as Omit<ExecutingFakeHerdrOptions, "onRequest">;
const fake = await startExecutingFakeHerdr({
  ...options,
  onRequest: (method, params) => emit(`REQUEST ${JSON.stringify({ method, params })}`),
});

let closing: Promise<void> | null = null;
function shutdown(): Promise<void> {
  closing ??= fake.close().then(() => process.exit(0));
  return closing;
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

emit(`READY ${fake.socketPath}`);

function answer(line: string): void {
  let id: unknown = null;
  try {
    const control = JSON.parse(line) as { id?: unknown; call?: unknown; args?: unknown };
    id = control.id ?? null;
    const run = typeof control.call === "string" ? CONTROLS[control.call] : undefined;
    if (!run) throw new Error(`no control named ${String(control.call)}`);
    const value = run(fake, Array.isArray(control.args) ? control.args : []);
    emit(`REPLY ${JSON.stringify(id)} ${JSON.stringify({ ok: true, value: value ?? null })}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emit(`REPLY ${JSON.stringify(id)} ${JSON.stringify({ ok: false, error })}`);
  }
}

let pending = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (line !== "") answer(line);
    newline = pending.indexOf("\n");
  }
}
await shutdown();
