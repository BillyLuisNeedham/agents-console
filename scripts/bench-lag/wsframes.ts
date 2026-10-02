/**
 * WebSocket frames read off a byte stream, for the lag bench's proxy
 * (proxy.ts), which carries the Console's socket as plain TCP and needs to
 * see its requests and replies at the network, where the browser cannot:
 * Chromium dispatches a frame that lands just after a press only once the
 * frame painting the press has run, so a page-side clock reads every answer
 * to a press as at least a frame late, whatever the server did.
 *
 * Text frames only, uncompressed (the pool server negotiates no extension);
 * a client's frames are masked, a server's are not, and either may arrive
 * split across or packed into TCP chunks. RFC 6455, section 5.2.
 */

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;

export class FrameReader {
  private buffer = new Uint8Array(0);
  /** A text message split over continuation frames, so far. */
  private partial: Uint8Array[] | null = null;
  private readonly decoder = new TextDecoder();

  /** The text messages this chunk completes, in order. */
  push(chunk: Uint8Array): string[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const out: string[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) return out;
      if (frame.opcode === OPCODE_TEXT) this.partial = [frame.payload];
      else if (frame.opcode === OPCODE_CONTINUATION && this.partial) this.partial.push(frame.payload);
      else continue;
      if (!frame.fin) continue;
      const parts = this.partial;
      this.partial = null;
      const total = parts.reduce((n, p) => n + p.length, 0);
      const whole = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        whole.set(p, at);
        at += p.length;
      }
      out.push(this.decoder.decode(whole));
    }
  }

  /** The next whole frame off the buffer, or null until one has arrived. */
  private next(): { fin: boolean; opcode: number; payload: Uint8Array } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let length = b[1]! & 0x7f;
    let at = 2;
    if (length === 126) {
      if (b.length < 4) return null;
      length = (b[2]! << 8) | b[3]!;
      at = 4;
    } else if (length === 127) {
      if (b.length < 10) return null;
      length = Number(new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0));
      at = 10;
    }
    const mask = masked ? b.subarray(at, at + 4) : null;
    if (masked) at += 4;
    if (b.length < at + length) return null;
    const payload = b.slice(at, at + length);
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    this.buffer = b.slice(at + length);
    return { fin, opcode, payload };
  }
}

/** The end of an HTTP head in a byte stream: the index just past "\r\n\r\n", or -1. */
export function headEnd(bytes: Uint8Array): number {
  for (let i = 3; i < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i - 1] === 13 && bytes[i - 2] === 10 && bytes[i - 3] === 13) return i + 1;
  }
  return -1;
}
