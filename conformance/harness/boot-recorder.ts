/**
 * A stand-in for Boot, for the cases that make a server restart itself. A
 * Restart stops the server and hands the pool to Boot, `bun` running the
 * boot command for Bun's server and `agent-console boot` for Rust's; a real
 * Boot would start a server the case does not own. The recorder puts both
 * names first on the server's PATH, each only writing down its argv and
 * working directory, so the hand-off is something a case can read back.
 *
 *   const recorder = bootRecorder(world);
 *   const server = await t.start(world, { env: recorder.env });
 *   ...
 *   const [call] = await recorder.handOffs(1);
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "./pool-files.ts";
import type { World } from "./world.ts";

/** One hand-off to Boot: the argv after the binary's name, and the directory it ran in. */
export interface BootHandOff {
  argv: string[];
  cwd: string;
}

export interface BootRecorder {
  /** For `t.start`'s `env`: the world's PATH with the recorder first. */
  env: Record<string, string>;
  /** Every hand-off so far. */
  calls(): BootHandOff[];
  /** Wait for `n` hand-offs, then half a second more for a stray one, and hand back all of them. */
  handOffs(n: number): Promise<BootHandOff[]>;
}

export function bootRecorder(world: World): BootRecorder {
  const bin = join(world.root, "boot-bin");
  const record = join(world.root, "boot-calls");
  mkdirSync(bin, { recursive: true });
  mkdirSync(record, { recursive: true });
  const script =
    "#!/usr/bin/env bash\n" +
    `d=${JSON.stringify(record)}\n` +
    'f="$d/$$"\n' +
    'printf \'%s\' "$PWD" > "$f.cwd"\n' +
    'printf \'%s\\0\' "$@" > "$f.tmp"\n' +
    'mv "$f.tmp" "$f.argv"\n' +
    'echo "boot recorder: $*"\n';
  for (const name of ["bun", "agent-console"]) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  const calls = (): BootHandOff[] =>
    readdirSync(record)
      .filter((name) => name.endsWith(".argv"))
      .map((name) => {
        const stem = name.slice(0, -".argv".length);
        return {
          argv: readFileSync(join(record, name), "utf8").split("\0").slice(0, -1),
          cwd: readFileSync(join(record, `${stem}.cwd`), "utf8"),
        };
      });
  return {
    env: { PATH: `${bin}:${world.env("").PATH}` },
    calls,
    async handOffs(n) {
      await until(() => calls().length, (got) => got >= n, { what: `${n} Boot hand-off(s)`, ms: 20_000 });
      await Bun.sleep(500);
      return calls();
    },
  };
}
