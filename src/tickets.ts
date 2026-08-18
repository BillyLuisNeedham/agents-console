import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "./state.ts";

export interface TicketSource {
  load(): Ticket[];
}

export class FileTicketSource implements TicketSource {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  load(): Ticket[] {
    const files = readdirSync(this.dir)
      .filter((file) => file.endsWith(".md"))
      .sort();
    return files.map((file) => parseTicketFile(join(this.dir, file)));
  }
}

export function loadTicketPool(dir: string): Ticket[] {
  return new FileTicketSource(dir).load();
}

function parseTicketFile(path: string): Ticket {
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`ticket file ${path}: expected --- front-matter`);
  const id = /^id:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  if (!id) throw new Error(`ticket file ${path}: missing id in front-matter`);
  const blockedBy =
    /^blockedBy:\s*\[(.*)\]$/m
      .exec(match[1])?.[1]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  return { id, title: match[2].trim(), blockedBy, status: "pending" };
}

export function demoPacket(topic: string): string {
  return [
    "# Packet",
    "",
    `Topic: ${topic}`,
    "",
    "## Decisions",
    "- Use LangGraph.js for this course's prototype.",
    "- Tickets fan out with blockedBy; Review is one gate at the end.",
    "",
    "## Context",
    "Demo packet so the rest of the graph can be poked without an interview.",
    "",
    "## Suggested skills",
    "- to-spec",
  ].join("\n");
}
