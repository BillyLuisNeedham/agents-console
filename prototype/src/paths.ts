import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const protoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = join(protoRoot, "..");
export const runRoot = join(protoRoot, ".run");
export const dbPath = join(runRoot, "checkpoints.sqlite");
export const ticketsRoot = join(protoRoot, "tickets");
