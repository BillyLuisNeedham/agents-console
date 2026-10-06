/**
 * A gate in front of one of the world's stub binaries, for a launch a case
 * must keep running as long as it likes: a terminal-backed Attempt whose
 * pane stays live, a Ticket held mid-run while the case acts on the pool.
 * The stub's own `waitFor` gives up after ten seconds; this holds until the
 * case releases it or the world is deleted.
 *
 *   const held = holdLaunches(world, { "02": { hold: true } });
 *   ...
 *   held.release("02");
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "./world.ts";

/** What the gate does with one key's launches. */
export interface HoldRule {
  /** Hold each launch until `release(key)`. */
  hold?: boolean;
  /** Write this JSON to `path` as the launch starts: an Outcome a TUI writes. */
  outcome?: { path: string; json: unknown };
}

/** Bounds a held launch, at 50 ms a poll: two minutes, so a case that fails before it releases leaves nothing running. */
const HOLD_POLLS = 2400;

/**
 * Put the gate in front of `binary` (claude by default). Each launch is
 * keyed by the base name of its working directory: a Ticket's worktree is
 * named for its id, a lone Ticket runs in the checkout (`repo`), and `any`
 * matches every launch no other rule names. A launch whose key has no rule
 * goes straight to the stub.
 */
export function holdLaunches(
  world: World,
  rules: Record<string, HoldRule>,
  binary = "claude",
): { release(key: string): void } {
  const held = join(world.root, "held");
  mkdirSync(held, { recursive: true });
  for (const [key, rule] of Object.entries(rules)) {
    writeFileSync(join(held, `${key}.rule`), "");
    if (rule.hold) writeFileSync(join(held, `${key}.hold`), "");
    if (rule.outcome) {
      writeFileSync(join(held, `${key}.outcome`), JSON.stringify(rule.outcome.json));
      writeFileSync(join(held, `${key}.outcome-path`), rule.outcome.path);
    }
  }
  const wrapper = join(world.stubs.bin, binary);
  const exec = readFileSync(wrapper, "utf8")
    .split("\n")
    .find((line) => line.startsWith("exec "));
  if (!exec) throw new Error(`no exec line in ${wrapper}`);
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `held=${JSON.stringify(held)}`,
      'key="$(basename "$PWD")"',
      '[ -f "$held/$key.rule" ] || key=any',
      'if [ -f "$held/$key.outcome-path" ]; then',
      '  cat "$held/$key.outcome" > "$(cat "$held/$key.outcome-path")"',
      "fi",
      'if [ -f "$held/$key.hold" ]; then',
      `  for _ in $(seq 1 ${HOLD_POLLS}); do`,
      '    [ -e "$held/$key.release" ] && break',
      '    [ -d "$held" ] || exit 0',
      "    sleep 0.05",
      "  done",
      "fi",
      exec,
      "",
    ].join("\n"),
  );
  return { release: (key) => writeFileSync(join(held, `${key}.release`), "") };
}
