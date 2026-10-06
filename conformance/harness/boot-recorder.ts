/**
 * A stand-in for Boot, for the cases that make a server restart itself. A
 * Restart stops the server and runs the shim of the checkout the server's
 * binary sits in, `<checkout>/bin/agent-console`, from that checkout; a real
 * Boot would start a server the case does not own. So the recorder lays out
 * a checkout of its own in the world: a copy of the binary under test at
 * `target/release/agent-console`, for the case to start the server from, and
 * the recorder as its `bin/agent-console`, only writing down its argv and
 * working directory and printing one line, which lands in the pool's
 * runs/boot.log. A decoy `agent-console` first on the server's PATH records
 * too, so a hand-off that went by PATH shows as one.
 *
 *   const recorder = bootRecorder(world);
 *   const server = await t.start(world, recorder.start);
 *   ...
 *   const [call] = await recorder.handOffs(1);
 */

import { chmodSync, constants, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./pool-files.ts";
import { serverChoice } from "./server.ts";
import type { World } from "./world.ts";

/** One hand-off to Boot. */
export interface BootHandOff {
  /** Which stand-in ran: the checkout's shim, or the decoy found on PATH. */
  ran: "shim" | "path";
  /** The argv after the program's name. */
  argv: string[];
  /** The directory it ran in, symlinks resolved. */
  cwd: string;
}

export interface BootRecorder {
  /** The stand-in checkout, symlinks resolved. */
  checkout: string;
  /** For `t.start`: the server run from the checkout's copy of the binary, the decoy first on its PATH. */
  start: { binary: string; env: Record<string, string> };
  /** Every hand-off so far. */
  calls(): BootHandOff[];
  /** Wait for `n` hand-offs, then half a second more for a stray one, and hand back all of them. */
  handOffs(n: number): Promise<BootHandOff[]>;
}

/** A stand-in that writes down how it was run, as `ran`, under `record`. */
function standIn(record: string, ran: BootHandOff["ran"]): string {
  return (
    "#!/usr/bin/env bash\n" +
    `d=${JSON.stringify(record)}\n` +
    'f="$d/$$"\n' +
    `printf '%s' ${ran} > "$f.ran"\n` +
    'pwd -P > "$f.cwd"\n' +
    'printf \'%s\\0\' "$@" > "$f.tmp"\n' +
    'mv "$f.tmp" "$f.argv"\n' +
    'echo "boot recorder: $*"\n'
  );
}

function writeScript(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

export function bootRecorder(world: World): BootRecorder {
  const checkout = join(world.root, "boot-checkout");
  const release = join(checkout, "target", "release");
  const decoy = join(world.root, "boot-bin");
  const record = join(world.root, "boot-calls");
  for (const dir of [join(checkout, "bin"), release, decoy, record]) mkdirSync(dir, { recursive: true });
  const binary = join(release, "agent-console");
  copyFileSync(serverChoice().rustBin, binary, constants.COPYFILE_FICLONE);
  chmodSync(binary, 0o755);
  writeScript(join(checkout, "bin", "agent-console"), standIn(record, "shim"));
  writeScript(join(decoy, "agent-console"), standIn(record, "path"));
  const calls = (): BootHandOff[] =>
    readdirSync(record)
      .filter((name) => name.endsWith(".argv"))
      .map((name) => {
        const stem = name.slice(0, -".argv".length);
        return {
          ran: readFileSync(join(record, `${stem}.ran`), "utf8") as BootHandOff["ran"],
          argv: readFileSync(join(record, name), "utf8").split("\0").slice(0, -1),
          cwd: readFileSync(join(record, `${stem}.cwd`), "utf8").trimEnd(),
        };
      });
  return {
    checkout: realpathSync(checkout),
    start: { binary, env: { PATH: `${decoy}:${world.env("").PATH}` } },
    calls,
    async handOffs(n) {
      await until(() => calls().length, (got) => got >= n, { what: `${n} Boot hand-off(s)`, ms: 20_000 });
      await Bun.sleep(500);
      return calls();
    },
  };
}
