/**
 * The stream log deriver (ADR-0012): turns a streaming harness's structured
 * JSONL output into the human-readable attempt log, live in the spawn pump.
 * Assistant text passes through verbatim; each tool call becomes one
 * `[tool] Name: summary` line, the summary being the call's salient argument
 * (the command for Bash, the file for Read/Write/Edit). Anything the deriver
 * cannot parse or recognize passes through to the log verbatim rather than
 * being dropped: the stream-json schema drifts with harness releases, and a
 * silently degrading log is worse than a raw one.
 */

// The one input field worth showing per known tool; anything else falls back
// to the first string field the call carries.
const TOOL_SUMMARY_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "pattern",
  Glob: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
};

// A summary is for scanning, not for reading whole files pasted as arguments;
// beyond this it truncates with an ellipsis.
const TOOL_SUMMARY_MAX_CHARS = 200;

// Current-schema stream events the log has no use for: system init, user
// (tool results), the final result. Recognized, nothing to say, so they
// contribute no log line; the Stream file keeps them verbatim. An event type
// outside this set and "assistant" is schema drift and passes through.
const SILENT_EVENT_TYPES = new Set(["system", "user", "result"]);

// Content blocks the log has no use for inside an assistant message:
// thinking is not the assistant's text, and the Stream file keeps it
// verbatim for forensics.
const SILENT_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Derive the log text one structured stream line contributes, or null when
 * the line is unparseable or unrecognized and must pass through verbatim. A
 * recognized event with nothing to say returns "" (the caller writes no log
 * line for it). Multi-line assistant text stays multi-line: the text is
 * verbatim.
 */
export function deriveStreamLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const event = parsed as { type?: unknown; message?: unknown };
  if (event.type !== "assistant") {
    return typeof event.type === "string" && SILENT_EVENT_TYPES.has(event.type)
      ? ""
      : null;
  }
  if (typeof event.message !== "object" || event.message === null) return null;
  const content = (event.message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  let sawKnownBlock = false;
  let sawUnknownBlock = false;
  for (const item of content) {
    if (typeof item !== "object" || item === null) return null;
    const block = item as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (block.type === "text" && typeof block.text === "string") {
      sawKnownBlock = true;
      parts.push(block.text);
    } else if (
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name.trim() !== ""
    ) {
      sawKnownBlock = true;
      const summary = toolSummary(block.name, block.input);
      parts.push(`[tool] ${block.name}${summary ? `: ${summary}` : ":"}`);
    } else if (
      typeof block.type === "string" &&
      SILENT_BLOCK_TYPES.has(block.type)
    ) {
      sawKnownBlock = true;
    } else {
      // A content block the deriver does not know is schema drift. It costs
      // the message its line only when nothing in the message is known:
      // known blocks still derive, so drift degrades the log instead of
      // replacing recognized content with a raw JSON wall.
      sawUnknownBlock = true;
    }
  }
  if (parts.length === 0 && sawUnknownBlock && !sawKnownBlock) return null;
  return parts.join("\n");
}

function toolSummary(name: string, input: unknown): string {
  let text: string | undefined;
  if (typeof input === "object" && input !== null) {
    const fields = input as Record<string, unknown>;
    const salient = fields[TOOL_SUMMARY_FIELD[name] ?? ""];
    if (typeof salient === "string") text = salient;
    else {
      for (const value of Object.values(fields)) {
        if (typeof value === "string" && value.trim() !== "") {
          text = value;
          break;
        }
      }
    }
  }
  const flat = (text ?? "").trim().replace(/\r?\n\s*/g, " ");
  if (flat.length > TOOL_SUMMARY_MAX_CHARS) {
    return `${flat.slice(0, TOOL_SUMMARY_MAX_CHARS)}...`;
  }
  return flat;
}

/**
 * The incremental line splitter the pump feeds raw stream chunks through:
 * bytes accumulate until a newline closes a line, so a line split across
 * chunks (or a multi-byte character split mid-way) derives exactly once, as
 * one line. The decoder is streaming UTF-8, so character boundaries never
 * corrupt. `\r\n` line endings lose the carriage return: the log is a derived
 * view, and the verbatim bytes live in the Stream file. `push` and `flush`
 * return the lines each call completed, in order.
 */
export class StreamLineBuffer {
  private readonly decoder = new TextDecoder();
  private pending = "";

  /** Feed one raw chunk; returns the lines it completed, in order. */
  push(chunk: Uint8Array): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let index: number;
    while ((index = this.pending.indexOf("\n")) !== -1) {
      lines.push(stripCarriageReturn(this.pending.slice(0, index)));
      this.pending = this.pending.slice(index + 1);
    }
    return lines;
  }

  /** Returns a final unterminated line, if one remains, at end of stream. */
  flush(): string[] {
    const rest = this.pending + this.decoder.decode();
    this.pending = "";
    return rest === "" ? [] : [stripCarriageReturn(rest)];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
