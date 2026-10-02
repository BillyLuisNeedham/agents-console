/**
 * Where the lag bench finds a Chromium to drive, on Linux and on macOS: the
 * CHROMIUM environment variable when set, else the usual install places of
 * Chromium and Chrome, else the first of their names on PATH.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

const LINUX_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
];

const NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];

/** The browser's path, or null when this machine has none the bench knows. */
export function findChromium(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CHROMIUM) return env.CHROMIUM;
  const places =
    process.platform === "darwin"
      ? MAC_APPS.flatMap((app) => [join("/Applications", app), join(homedir(), "Applications", app)])
      : LINUX_PATHS;
  for (const place of places) if (existsSync(place)) return place;
  for (const name of NAMES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

/** The browser's path, or an error that says where it looked. */
export function requireChromium(): string {
  const found = findChromium();
  if (found) return found;
  throw new Error(
    "no Chromium or Chrome found: install one, or set CHROMIUM to its executable " +
      "(macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome)",
  );
}
