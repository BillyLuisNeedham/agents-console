/**
 * Pane-session primitives (ADR-0014, ADR-0015, ADR-0016): the parts of a
 * terminal-backed spawn that talk to one herdr pane and know nothing about
 * tickets, attempts, or outcomes — sending a wrapper command, waiting for a
 * TUI's ready frame, and typing text with echo verification. Ticket attempts
 * (engine.ts's runTicket/runResolver path) and Conversations
 * (conversations.ts) both drive a herdr pane through exactly this surface,
 * so the mechanics live once, here, parameterised over plain strings rather
 * than either caller's own context shape.
 */

import { existsSync, rmSync } from "node:fs";
import {
  closePane,
  paneSendInput,
  peekPane,
  waitForPaneEnd,
  type PaneReadSource,
} from "./herdr.ts";

/**
 * The launch half's cadences (issue #102): how the engine waits for a fresh
 * pane's shell before sending the wrapper, and how long it gives `script` to
 * prove the wrapper ran. Overridable so a test can drive a botched launch in
 * milliseconds; engine callers pass none.
 */
export interface LaunchCadence {
  /** Between shell-settle reads. */
  settlePollMs: number;
  /** Identical non-empty reads before the shell counts as settled. */
  settleConfirmations: number;
  /** After this, the wrapper is sent whether or not the shell settled. */
  settleTimeoutMs: number;
  /** How long the Stream file has to appear before the launch is botched. */
  landedTimeoutMs: number;
  /** Between Stream-file probes. */
  landedPollMs: number;
}

export const DEFAULT_LAUNCH_CADENCE: LaunchCadence = {
  settlePollMs: 200,
  settleConfirmations: 3,
  settleTimeoutMs: 10_000,
  landedTimeoutMs: 10_000,
  landedPollMs: 50,
};

// The pane-read line count for readiness and echo polling: a freshly spawned
// pane renders mostly blank rows above its prompt, so a small read returns
// empty (prototype finding); 200 lines covers the TUI's input area and the
// recent transcript whatever the pane's height. These launch-time reads keep
// herdr's `recent` source deliberately (issue #122): the tab is one the
// engine opened and nobody is sitting in yet, so reaching into scrollback
// moves no operator's viewport, where the steady-state loops that watch a
// pane an operator may be typing in read only the viewport (herdr.ts's
// PaneReadSource).
export const INTERACTIVE_PANE_READ_LINES = 200;
const LAUNCH_READ: PaneReadSource = { source: "recent", lines: INTERACTIVE_PANE_READ_LINES };
// Readiness requires the ready pattern on this many consecutive reads, ~this
// far apart: a single match can be a boot flicker, and empty reads are not
// ready (prototype finding).
const READINESS_CONFIRMATIONS = 3;
const READINESS_POLL_MS = 500;
// A TUI that cannot reach its ready frame within this bound is botched: the
// caller closes the pane and the spawn surfaces as a failure, never a
// silently idle tab.
// Exported because an enlist (issue #101) gives a working pane the same bound
// to reach waiting so the teaching Turn can be typed; `stillWorkingReason` is
// the refusal both enlist arms answer with when it expires.
export const READINESS_TIMEOUT_MS = 60_000;

export function stillWorkingReason(waitMs: number): string {
  const bound = waitMs >= 1000 ? `${Math.round(waitMs / 1000)} s` : `${waitMs} ms`;
  return (
    `the pane was still working after ${bound}, so the teaching Turn could ` +
    "not be typed; enlist it once its agent is waiting on you"
  );
}
// claude's first-run trust dialog marks a directory claude has not seen; the
// "No, exit" button label names it, and answering it needs pacing — a key
// sent too early is dropped (prototype finding).
const TRUST_DIALOG_PATTERN = "No, exit";
const TRUST_DIALOG_SETTLE_MS = 1_500;
const TRUST_DIALOG_KEY_GAP_MS = 500;
// How many times a typed paste is retried (with a clear in between) before
// the caller gives up, and how long echo verification may wait per attempt.
const PROMPT_TYPED_ATTEMPTS = 3;
const PROMPT_ECHO_POLL_MS = 250;
const PROMPT_ECHO_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

// The free variables a wrapper send needs out of a spawn's context: where the
// session records and where the wrapper's exit code lands. engine.ts's
// SpawnContext (tickets) and conversations.ts's own launch context are both
// structurally assignable here, so neither caller has to build a bespoke
// shape just to send a wrapper.
export interface WrapperContext {
  logPath: string;
  streamPath?: string | null;
  exitCodePath: string;
}

// One POSIX-safe single-quote: the quoted text cannot touch the surrounding
// shell, whatever the harness argv carries.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ADR-0016 wrapper shell a pane runs, as one line of bash: the
 * interactive argv under `script`, which allocates the PTY the TUI requires,
 * passes the session through to the pane live, and records both directions to
 * the Stream file (the typescript the derived log comes from). `-e` makes
 * script's own exit status the child's, so the trailing exit-code write
 * carries the harness's code, not script's unconditional 0; `-q` drops
 * script's own start and end banners. The recording form is the platform's,
 * because the two `script`s disagree on how the command arrives (issue #58):
 * util-linux's takes it as one string after `-c` and flushes on `-f`, so
 * Linux runs `script -eqfc '<argv>' <stream-file>`; BSD's, which macOS ships,
 * has no `-c` — the command's words follow the file — and flushes on `-F`, so
 * darwin runs `script -eqF <stream-file> <argv words>`, each word quoted so
 * bash hands script exactly the argv. `-e` and `-q` are common to both. The
 * trailing exit-code write stays, firing whenever the session eventually
 * exits, for crash forensics; there is no `exit`, so a ticket's pane stays
 * open after the attempt completes and a Conversation's pane stays open for
 * as long as the operator talks. Exported for the per-platform shape test in
 * engine.test.ts: neither form fails until it reaches a real pane.
 */
export function interactiveWrapper(
  argv: string[],
  ctx: WrapperContext,
  platform: NodeJS.Platform = process.platform,
): string {
  const command = argv.map(shellQuote).join(" ");
  // Terminal-backed sessions always carry a Stream path (the typescript);
  // the log path is the defensive fallback for a malformed context.
  const file = shellQuote(ctx.streamPath ?? ctx.logPath);
  const record =
    platform === "darwin"
      ? `script -eqF ${file} ${command}`
      : `script -eqfc ${shellQuote(command)} ${file}`;
  return `${record}; echo $? > ${shellQuote(ctx.exitCodePath)}`;
}

/**
 * Wait for a fresh pane's shell to settle before anything is typed into it
 * (issue #96, issue #102): a tab is not ready the instant `tab.create`
 * returns, and text that lands while the shell is still starting is
 * swallowed in part — the shell submits the fragment that survived and the
 * rest sits unsubmitted at the next prompt, so `script` never runs
 * (reproduced live against herdr 0.8.2 on both zsh and bash). The gate is
 * prompt-agnostic: it waits for the pane to show something and for that
 * something to stop changing across consecutive reads, which is the shell
 * having drawn its prompt, whatever the prompt looks like. Empty reads never
 * count (a fresh pane renders blank for its first moments). Resolves
 * "settled" or, past the timeout, "timed-out"; the caller sends either way,
 * because the wrapper-landed check behind it catches a swallowed send and a
 * shell with no prompt at all must not be a launch that never happens.
 */
export async function waitForShellSettled(
  socketPath: string,
  paneId: string,
  cadence: LaunchCadence = DEFAULT_LAUNCH_CADENCE,
): Promise<"settled" | "timed-out"> {
  const deadline = Date.now() + cadence.settleTimeoutMs;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const text = (
      await peekPane(socketPath, paneId, LAUNCH_READ).catch(() => "")
    ).trim();
    if (text !== "" && text === last) {
      stable += 1;
      if (stable >= cadence.settleConfirmations) return "settled";
    } else {
      stable = text === "" ? 0 : 1;
      last = text;
    }
    await sleep(cadence.settlePollMs);
  }
  return "timed-out";
}

/**
 * Whether the wrapper actually ran: `script` creates its Stream file the
 * instant it starts, so the file's absence a moment after the send is proof
 * the launch command never executed — the shell-startup race swallowed it
 * (issue #96, issue #102) — and the launch is botched long before the
 * readiness wait would time out. The exit-code file counts too: a harness
 * that died at once still had its wrapper run, and that is the fail-fast
 * path (ADR-0016's amendment), not this one. Resolves `true` once either
 * file exists, `false` past the timeout.
 */
export async function waitForWrapperLanded(
  streamPath: string,
  exitCodePath: string,
  cadence: LaunchCadence = DEFAULT_LAUNCH_CADENCE,
): Promise<boolean> {
  const deadline = Date.now() + cadence.landedTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(streamPath) || existsSync(exitCodePath)) return true;
    await sleep(cadence.landedPollMs);
  }
  return existsSync(streamPath) || existsSync(exitCodePath);
}

/**
 * Send the session's wrapper to its pane (ADR-0014), the send half of a
 * terminal-backed spawn. Text and Enter travel in one `pane.send_input`
 * call, which herdr applies in order, text then keys (verified live on
 * 0.8.2; it is what the CLI's atomic `pane run` does): sent as two calls
 * they raced each other into a shell still starting up (issue #96), and a
 * literal newline in text is pasted data, not a submit (verified), so the
 * Enter must ride as a key. Resolves with
 * `undefined` once the pane carries the wrapper. On failure — the daemon died
 * after the tab opened, or rejected the input — closes whatever half-started
 * pane remains (best-effort: it kills a wrapper that false-alarm Enter loss
 * may actually have started) and resolves with the error message, so the
 * caller can record the failure and fall back or fail the launch as its own
 * contract requires: one pane's terminal trouble must never take the drive
 * down with it.
 */
export async function sendWrapperToPane(
  socketPath: string,
  paneId: string,
  argv: string[],
  ctx: WrapperContext,
): Promise<string | undefined> {
  // The exit-code file must not carry a previous run's code, and the tailer
  // must not read a stale Stream file's bytes before script creates it fresh.
  rmSync(ctx.exitCodePath, { force: true });
  if (ctx.streamPath) rmSync(ctx.streamPath, { force: true });
  try {
    await paneSendInput(socketPath, paneId, {
      text: interactiveWrapper(argv, ctx),
      keys: ["enter"],
    });
    return undefined;
  } catch (err) {
    void closePane(socketPath, paneId).catch(() => {});
    return err instanceof Error ? err.message : String(err);
  }
}

// How the readiness wait ended: the ready frame confirmed, the wrapper's
// exit-code file appeared (the harness exited first), the pane ended with no
// file behind it, or the timeout.
export type Readiness = "ready" | "exited" | "pane-ended" | "timed-out";

/**
 * Wait for the harness's ready frame on the pane's rendered content: the
 * ready pattern on READINESS_CONFIRMATIONS consecutive reads, with empty
 * reads not ready (a fresh pane renders mostly blank) and a single match
 * discounted as a boot flicker (prototype findings). claude's first-run trust
 * dialog is answered inside the wait, paced so the keys land. A pane that
 * ends before the TUI comes up is a botched spawn, failed fast rather than
 * polled to the timeout, and so is a wrapper that finishes before it: the
 * exit-code file appearing means `script` has already returned — the harness
 * died on launch — and the pane is sitting at its shell prompt, which never
 * ends on its own, so without the file watch the wait ran to its timeout and
 * reported a TUI that "never became ready" over a harness that had exited
 * with a code of its own. The file is fresh: the wrapper send removed any
 * earlier run's. A pane end is checked against the file too, since the two
 * can land together (a shell that exits with the wrapper, an operator closing
 * a dead tab) and the harness's own code is the truer ending of the two
 * (ADR-0014: neither observation trusted alone). A lost pane-end subscription
 * (an old daemon, or a restart) just stops the watch and keeps polling the
 * content.
 */
export async function waitForReadiness(
  socketPath: string,
  paneId: string,
  harness: string,
  readyPattern: string,
  exitCodePath: string,
): Promise<Readiness> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let stable = 0;
  let lost = false;
  const controller = new AbortController();
  const paneEnd = waitForPaneEnd(socketPath, paneId, controller.signal);
  try {
    while (Date.now() < deadline) {
      if (existsSync(exitCodePath)) return "exited";
      let text: string;
      if (lost) {
        text = await peekPane(socketPath, paneId, LAUNCH_READ).catch(
          () => "",
        );
      } else {
        const settled = await Promise.race([
          peekPane(socketPath, paneId, LAUNCH_READ).then(
            (t) => ({ text: t }) as const,
            () => ({ text: "" }) as const,
          ),
          paneEnd.then((end) => ({ end }) as const),
        ]);
        if ("end" in settled) {
          if (settled.end === "lost") {
            lost = true;
            continue;
          }
          return existsSync(exitCodePath) ? "exited" : "pane-ended";
        }
        text = settled.text;
      }
      if (harness === "claude" && text.includes(TRUST_DIALOG_PATTERN)) {
        await answerTrustDialog(socketPath, paneId);
        stable = 0;
      } else {
        stable = text.includes(readyPattern) ? stable + 1 : 0;
      }
      if (stable >= READINESS_CONFIRMATIONS) return "ready";
      await sleep(READINESS_POLL_MS);
    }
    return "timed-out";
  } finally {
    controller.abort();
  }
}

/**
 * Answer claude's first-run trust dialog (prototype finding): settle so the
 * dialog's controls render, move the selection to "Yes, I trust this folder"
 * with down, and confirm with enter. Sending a key before the dialog settles
 * is dropped, so the steps are paced.
 */
async function answerTrustDialog(
  socketPath: string,
  paneId: string,
): Promise<void> {
  await sleep(TRUST_DIALOG_SETTLE_MS);
  await paneSendInput(socketPath, paneId, { keys: ["down"] }).catch(() => {});
  await sleep(TRUST_DIALOG_KEY_GAP_MS);
  await paneSendInput(socketPath, paneId, { keys: ["enter"] }).catch(() => {});
}

/**
 * Whether the pane's rendered content shows any of the targets within the
 * echo timeout: the paste-echo verification. A pane read that fails (a
 * daemon blip mid-poll) is treated as not shown, so the caller's retry loop
 * runs again instead of throwing the drive down.
 */
async function paneShows(
  socketPath: string,
  paneId: string,
  targets: string[],
): Promise<boolean> {
  const deadline = Date.now() + PROMPT_ECHO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await peekPane(socketPath, paneId, LAUNCH_READ).catch(
      () => "",
    );
    if (targets.some((target) => viewportShows(text, target))) return true;
    await sleep(PROMPT_ECHO_POLL_MS);
  }
  return false;
}

// What a row break inside a TUI's input box puts between the two halves of a
// wrapped line: the newline, the padding on both rows, and the box-drawing or
// block glyphs of the box border (U+2500-U+259F). Exported for turn-state.ts
// (Workstream B): the same chrome that can split a wrapped echo target also
// pads a rendered line around its real content, so the last-line extraction
// for turn state strips it the same way rather than defining a second regex
// that could drift from this one.
export const VIEWPORT_WRAP_CHROME = /[\s─-▟]+/g;

/**
 * Whether one rendered viewport shows the target, tolerating the TUI's soft
 * wrap. A TUI draws its input area as a box narrower than the pane and breaks
 * a long line inside it at a hyphen, a slash, or a space, so a long echo
 * target — an issue path, a Conversation's opening line — can land split
 * across two bordered rows, and a plain substring match never sees a paste
 * that did land (issue #56). claude and cursor collapse a long paste to their
 * `Pasted text` marker, which fits on one row, but cursor hard-wraps a
 * fallback command's path the same way (verified live), so the tolerance
 * covers every harness's typed text. Dropping everything a row break can
 * insert from both the viewport and the target reassembles a wrapped line,
 * while a target that was never typed still cannot appear: the characters
 * must all be there, in order, with nothing but chrome between them.
 */
export function viewportShows(text: string, target: string): boolean {
  if (text.includes(target)) return true;
  const wanted = target.replace(VIEWPORT_WRAP_CHROME, "");
  return wanted !== "" && text.replace(VIEWPORT_WRAP_CHROME, "").includes(wanted);
}

/**
 * Type `text` into the pane and verify it landed via `echoTargets`, retrying
 * with `clearKeys` between attempts (ADR-0016's typed-paste+echo loop,
 * generalised to free text so any caller — a ticket's driver prompt, a
 * Conversation's opening Turn, or a Notice typed into a waiting Conversation
 * — can verify a paste the same way). Sends Enter and resolves `true` the
 * moment the echo confirms; resolves `false` once every attempt is spent.
 * With no clear keys there is exactly one attempt: a false-negative echo
 * cannot safely retry into a TUI it might concatenate onto (see clearKeys on
 * HarnessDescriptor, spawn.ts).
 */
export async function typeVerified(
  socketPath: string,
  paneId: string,
  text: string,
  echoTargets: string[],
  clearKeys: string[],
): Promise<boolean> {
  const attempts = clearKeys.length > 0 ? PROMPT_TYPED_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await paneSendInput(socketPath, paneId, { keys: clearKeys });
    }
    await paneSendInput(socketPath, paneId, { text });
    if (await paneShows(socketPath, paneId, echoTargets)) {
      await paneSendInput(socketPath, paneId, { keys: ["enter"] });
      return true;
    }
  }
  return false;
}
