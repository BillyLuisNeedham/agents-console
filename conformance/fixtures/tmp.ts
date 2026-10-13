import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fresh temp directory under `tmpdir()`, named canonically.
 *
 * On macOS `tmpdir()` is itself a symlink (/var -> /private/var), so mkdtemp
 * there hands back a spelling that `git rev-parse --show-toplevel` and
 * `realpath` both disagree with, and a fixture that keeps it ends up holding
 * two names for one directory — the very thing the engine canonicalises the
 * pool dir at load to avoid (canonicalDir). Linux has no such symlink, so
 * this only brings the two platforms to the same starting spelling.
 */
export function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
