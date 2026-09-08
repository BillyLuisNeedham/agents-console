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

/**
 * The transcript line buffer for a terminal-backed attempt (ADR-0016): the
 * Stream file is a `script` typescript, raw ANSI recording both directions
 * of the session, and the derived log is that transcript with the ANSI and
 * control noise removed. The buffer strips escape sequences incrementally —
 * a sequence split across chunks is held back until the next chunk completes
 * it — then splits on line endings exactly like `StreamLineBuffer`. What the
 * log keeps is the readable text: printable characters, `\n`, and `\t`.
 * Everything else a terminal paints with is dropped: CSI sequences (colours,
 * cursor moves), OSC sequences (title/kitty sequences), other escape
 * sequences (charset designators, screen saves), and C0 controls including
 * the `\r` of a CRLF line ending and the standalone carriage return a
 * redraw uses to overwrite a line.
 */
export class TranscriptLineBuffer {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private escape: string | null = null;

  /** Feed one raw chunk; returns the transcript lines it completed. */
  push(chunk: Uint8Array): string[] {
    this.pending += this.clean(this.decoder.decode(chunk, { stream: true }));
    return this.takeLines();
  }

  /** Returns a final unterminated line, if one remains, at end of stream. */
  flush(): string[] {
    const rest = this.pending + this.clean(this.decoder.decode());
    this.pending = "";
    return rest === "" ? [] : [rest];
  }

  private takeLines(): string[] {
    const lines: string[] = [];
    let index: number;
    while ((index = this.pending.indexOf("\n")) !== -1) {
      lines.push(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + 1);
    }
    return lines;
  }

  // Append cleaned text to the pending buffer: ANSI escapes and control
  // characters removed. A partial escape sequence at the end of the input is
  // held in `escape` until the next call completes it.
  private clean(text: string): string {
    const work = (this.escape ?? "") + text;
    this.escape = null;
    let out = "";
    let i = 0;
    const n = work.length;
    while (i < n) {
      const ch = work[i];
      if (ch !== "\x1b") {
        if (ch === "\n" || ch === "\t" || ch >= " ") out += ch;
        i++;
        continue;
      }
      const next = work[i + 1];
      if (next === undefined) {
        this.escape = work.slice(i);
        break;
      }
      if (next === "[") {
        // CSI: `ESC [` parameter/intermediate bytes then a final byte in
        // [@-~]. A sequence that runs out of input is held back.
        let j = i + 2;
        for (; j < n; j++) {
          if (work[j] >= "@" && work[j] <= "~") break;
        }
        if (j === n) {
          this.escape = work.slice(i);
          break;
        }
        i = j + 1;
      } else if (
        next === "]" ||
        next === "P" ||
        next === "_" ||
        next === "^" ||
        next === "X"
      ) {
        // OSC/DCS/APC/PM/SOS string sequences: payload until BEL or ST
        // (`ESC \`). Anything until the terminator is dropped.
        let j = i + 2;
        let end = -1;
        for (; j < n; j++) {
          if (work[j] === "\x07") {
            end = j;
            break;
          }
          if (work[j] === "\x1b" && work[j + 1] === "\\") {
            end = j + 1;
            break;
          }
        }
        if (end === -1) {
          this.escape = work.slice(i);
          break;
        }
        i = end + 1;
      } else if (
        next === "(" ||
        next === ")" ||
        next === "*" ||
        next === "+" ||
        next === "-" ||
        next === "." ||
        next === "/"
      ) {
        // Charset designator `ESC ( X`: three bytes, held back if split.
        if (work[i + 2] === undefined) {
          this.escape = work.slice(i);
          break;
        }
        i += 3;
      } else {
        // Two-byte escape (`ESC 7`, `ESC M`, ...): drop both.
        i += 2;
      }
    }
    return out;
  }
}
