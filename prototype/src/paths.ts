import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const protoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = join(protoRoot, "..");
export const runRoot = join(protoRoot, ".run");
export const dbPath = join(runRoot, "checkpoints.sqlite");

export function threadDir(threadId: string): string {
  const dir = join(runRoot, threadId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function packetPath(threadId: string): string {
  return join(threadDir(threadId), "packet.md");
}
