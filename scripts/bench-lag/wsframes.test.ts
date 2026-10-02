import { describe, expect, test } from "bun:test";
import { FrameReader, headEnd } from "./wsframes.ts";

/** A text frame as a client (masked) or a server (not) writes it. */
function frame(text: string, options: { mask?: boolean; fin?: boolean; opcode?: number } = {}): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const head: number[] = [(options.fin === false ? 0 : 0x80) | (options.opcode ?? 0x1)];
  const maskBit = options.mask ? 0x80 : 0;
  if (payload.length < 126) head.push(maskBit | payload.length);
  else if (payload.length < 65_536) head.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
  else {
    head.push(maskBit | 127);
    const len = new Uint8Array(8);
    new DataView(len.buffer).setBigUint64(0, BigInt(payload.length));
    head.push(...len);
  }
  const key = [0x12, 0x34, 0x56, 0x78];
  const body = options.mask ? payload.map((b, i) => b ^ key[i % 4]!) : payload;
  return new Uint8Array([...head, ...(options.mask ? key : []), ...body]);
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("FrameReader", () => {
  test("reads a server's frames and a client's masked ones", () => {
    expect(new FrameReader().push(frame('{"type":"reply","id":1}'))).toEqual(['{"type":"reply","id":1}']);
    expect(new FrameReader().push(frame('{"type":"request","id":2}', { mask: true }))).toEqual([
      '{"type":"request","id":2}',
    ]);
  });

  test("a frame split across chunks comes out once it is whole, and packed ones all come out", () => {
    const reader = new FrameReader();
    const whole = concat(frame("first"), frame("x".repeat(70_000)), frame("third"));
    const out: string[] = [];
    for (let at = 0; at < whole.length; at += 1_000) out.push(...reader.push(whole.subarray(at, at + 1_000)));
    expect(out.map((t) => t.length)).toEqual([5, 70_000, 5]);
    expect(reader.push(concat(frame("a".repeat(300)), frame("b")))).toEqual(["a".repeat(300), "b"]);
  });

  test("a message in continuation frames is one text; control frames are skipped", () => {
    const reader = new FrameReader();
    const ping = new Uint8Array([0x89, 0x00]);
    const parts = concat(frame("hel", { fin: false }), ping, frame("lo", { opcode: 0x0 }));
    expect(reader.push(parts)).toEqual(["hello"]);
  });
});

describe("headEnd", () => {
  test("finds the end of an HTTP head, or says it has not come", () => {
    const head = new TextEncoder().encode("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
    expect(headEnd(concat(head, frame("x")))).toBe(head.length);
    expect(headEnd(head.subarray(0, head.length - 1))).toBe(-1);
  });
});
